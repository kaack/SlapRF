package ml

import (
	"math"

	"slaprf/internal/domain"
	"slaprf/internal/dsp"
)

const (
	ringWinSize      = 29 // [-14..+14] around center index 14 (280 ms lookahead)
	maxLiveEmbedHist = 9000 // 3 minutes at 50 Hz per active (gate, pilot)
)

type evalSlot struct {
	tsUs     uint64
	prob     float32
	dtMs     float32
	medRssi  float32
	floorDbm float32
}

// StreamDetector runs causal 50 Hz (20 ms) 1D TCN crossing detection in real time (`< 15 us`/step)
// with a 280 ms post-peak lookahead, optional live 24-weight per-gate fine-tuning head, and a
// rolling L3 embedding history buffer for `< 5 ms` post-lap online adaptation.
type StreamDetector struct {
	gateID    uint8
	slotIndex int
	model     *TCN

	norm         FeatureNormalizer
	smoothedRSSI float32
	hasSmoothed  bool
	prevRawTsUs  uint64

	nextGridUs uint64
	binHasSample bool
	binMaxRssi   float32
	binFloor     float32
	lastRssi     float32
	lastFloor    float32

	featRing  [ringWinSize][InputChannels]float32
	medRing   [ringWinSize]float32
	floorRing [ringWinSize]float32
	tsRing    [ringWinSize]uint64
	ringCount int

	// 7-step sliding probability history for symmetric +-3 step (+-60 ms) causal NMS
	probHist  [7]evalSlot
	probCount int

	hasCrossed     bool
	lastCrossingUs uint64
	prevCrossed    bool
	prevCrossingUs uint64

	embedHistory []EmbeddedStep
}

// NewStreamDetector creates a real-time 1D TCN detector for `(gateID, slotIndex)`.
func NewStreamDetector(gateID uint8, slotIndex int, model *TCN) *StreamDetector {
	if model == nil {
		model, _ = PretrainedBaseModel()
	}
	return &StreamDetector{
		gateID:       gateID,
		slotIndex:    slotIndex,
		model:        model,
		smoothedRSSI: -95.0,
	}
}

// SetModel hot-swaps the underlying TCN weights without losing lockout state.
func (d *StreamDetector) SetModel(model *TCN) {
	if model != nil {
		d.model = model
	}
}

// SmoothedRSSI returns the display-smoothed RSSI matching `ChannelDetector.SmoothedRSSI()`.
func (d *StreamDetector) SmoothedRSSI() float32 {
	return d.smoothedRSSI
}

// RollbackRejectedSpike restores the prior crossing lockout when `crossing_rules` rejects a blip.
func (d *StreamDetector) RollbackRejectedSpike() {
	d.hasCrossed = d.prevCrossed
	d.lastCrossingUs = d.prevCrossingUs
}

// ResetSession clears session state and cached L3 embeddings when starting a new session/pack.
func (d *StreamDetector) ResetSession() {
	d.norm.Reset()
	d.hasSmoothed = false
	d.prevRawTsUs = 0
	d.nextGridUs = 0
	d.binHasSample = false
	d.ringCount = 0
	d.probCount = 0
	d.hasCrossed = false
	d.lastCrossingUs = 0
	d.prevCrossed = false
	d.prevCrossingUs = 0
	d.embedHistory = d.embedHistory[:0]
}

// Embeddings returns the rolling session L3 embeddings for live 2-lap adaptation.
func (d *StreamDetector) Embeddings() []EmbeddedStep {
	return d.embedHistory
}

// ProcessSample ingests one raw hardware telemetry sample and returns a `*dsp.CrossingCandidate`
// if a crossing crest was just confirmed `280 ms` behind the live sample edge.
func (d *StreamDetector) ProcessSample(
	rawRSSIDbm float32,
	noiseFloorDbm float32,
	timestampUs uint64,
	enterThresholdDbm float32,
	exitThresholdDbm float32,
	minLockoutUs uint64,
	liveTune *domain.MLLiveGateTune,
) *dsp.CrossingCandidate {
	if rawRSSIDbm <= -120.0 {
		d.smoothedRSSI = rawRSSIDbm
		d.hasSmoothed = false
		return nil
	}
	if noiseFloorDbm > -65.0 || noiseFloorDbm < -115.0 {
		noiseFloorDbm = -91.0
	}

	// Maintain clean display EMA for live Signals chart curve
	if !d.hasSmoothed || timestampUs < d.prevRawTsUs || timestampUs-d.prevRawTsUs > 1_500_000 {
		d.norm.Reset()
		d.smoothedRSSI = rawRSSIDbm
		d.hasSmoothed = true
		d.prevRawTsUs = timestampUs
		d.nextGridUs = timestampUs + StepUs
		d.binHasSample = false
		d.lastRssi = rawRSSIDbm
		d.lastFloor = noiseFloorDbm
		d.ringCount = 0
		d.probCount = 0
		return d.pushGridStep(timestampUs, rawRSSIDbm, noiseFloorDbm, enterThresholdDbm, exitThresholdDbm, minLockoutUs, liveTune)
	}

	dtUs := timestampUs - d.prevRawTsUs
	d.prevRawTsUs = timestampUs
	alpha := float32(1.0 - math.Exp(-float64(dtUs)/38_000.0))
	d.smoothedRSSI += alpha * (rawRSSIDbm - d.smoothedRSSI)

	// Accumulate max RSSI inside current 20 ms bin (so 100 Hz Spokes preserve full peak height)
	if !d.binHasSample || rawRSSIDbm > d.binMaxRssi {
		d.binMaxRssi = rawRSSIDbm
		d.binFloor = noiseFloorDbm
		d.binHasSample = true
	}

	var emitted *dsp.CrossingCandidate
	stepsGuard := 0
	for timestampUs >= d.nextGridUs && stepsGuard < 32 {
		stepsGuard++
		var stepRssi, stepFloor float32
		if d.binHasSample {
			stepRssi = d.binMaxRssi
			stepFloor = d.binFloor
			d.binHasSample = false
		} else {
			stepRssi = d.lastRssi
			stepFloor = d.lastFloor
		}
		d.lastRssi = stepRssi
		d.lastFloor = stepFloor
		gridTs := d.nextGridUs
		d.nextGridUs += StepUs
		if cand := d.pushGridStep(gridTs, stepRssi, stepFloor, enterThresholdDbm, exitThresholdDbm, minLockoutUs, liveTune); cand != nil {
			emitted = cand
		}
	}
	return emitted
}

func (d *StreamDetector) pushGridStep(
	gridTsUs uint64,
	rssiDbm float32,
	floorDbm float32,
	enterDbm float32,
	exitDbm float32,
	minLockoutUs uint64,
	liveTune *domain.MLLiveGateTune,
) *dsp.CrossingCandidate {
	feat, med, fl := d.norm.Step(rssiDbm, floorDbm)

	if d.ringCount < ringWinSize {
		idx := d.ringCount
		d.featRing[idx] = feat
		d.medRing[idx] = med
		d.floorRing[idx] = fl
		d.tsRing[idx] = gridTsUs
		d.ringCount++
		if d.ringCount < ringWinSize {
			return nil
		}
	} else {
		copy(d.featRing[:], d.featRing[1:])
		copy(d.medRing[:], d.medRing[1:])
		copy(d.floorRing[:], d.floorRing[1:])
		copy(d.tsRing[:], d.tsRing[1:])
		d.featRing[ringWinSize-1] = feat
		d.medRing[ringWinSize-1] = med
		d.floorRing[ringWinSize-1] = fl
		d.tsRing[ringWinSize-1] = gridTsUs
	}

	// Center index 14 is `gridTsUs - 14*20ms = gridTsUs - 280ms`!
	var customW *[HiddenDim]float32
	var customB float32
	useCustom := false
	if liveTune != nil {
		customW = &liveTune.Weights
		customB = liveTune.Bias
		useCustom = true
	}
	prob, dtMs, emb := d.model.EvalWindow29(&d.featRing, customW, customB, useCustom)
	centerTs := d.tsRing[LookaheadSteps]
	centerMed := d.medRing[LookaheadSteps]
	centerFloor := d.floorRing[LookaheadSteps]

	// Append embedding to rolling history for live 2-lap fine-tuning
	if len(d.embedHistory) >= maxLiveEmbedHist {
		drop := maxLiveEmbedHist / 4
		copy(d.embedHistory, d.embedHistory[drop:])
		d.embedHistory = d.embedHistory[:len(d.embedHistory)-drop]
	}
	d.embedHistory = append(d.embedHistory, EmbeddedStep{
		TimestampUs: centerTs,
		MedRSSIDbm:  centerMed,
		FloorDbm:    centerFloor,
		Embed:       emb,
	})

	slot := evalSlot{
		tsUs:     centerTs,
		prob:     prob,
		dtMs:     dtMs,
		medRssi:  centerMed,
		floorDbm: centerFloor,
	}
	if d.probCount < 7 {
		d.probHist[d.probCount] = slot
		d.probCount++
		if d.probCount < 7 {
			return nil
		}
	} else {
		copy(d.probHist[:], d.probHist[1:])
		d.probHist[6] = slot
	}

	// Evaluate center of 7-step NMS buffer (index 3 -> +-60 ms local maximum check)
	cand := d.probHist[3]
	if cand.prob < DetectProbThreshold {
		return nil
	}
	for k := 0; k < 7; k++ {
		if k == 3 {
			continue
		}
		if d.probHist[k].prob > cand.prob || (k < 3 && d.probHist[k].prob == cand.prob) {
			return nil
		}
	}

	// Compute physical peak RSSI & beamwidth from the 29-step window (`[-280ms..+280ms]`)
	peakRssi := cand.medRssi
	for i := 6; i <= 22; i++ {
		if d.medRing[i] > peakRssi {
			peakRssi = d.medRing[i]
		}
	}
	if peakRssi < cand.floorDbm+7.5 {
		return nil
	}

	refinedInt := int64(cand.tsUs) + int64(math.Round(float64(cand.dtMs)*1000.0))
	if refinedInt < 0 {
		refinedInt = 0
	}
	refinedTs := uint64(refinedInt)
	if d.hasCrossed && refinedTs <= d.lastCrossingUs+minLockoutUs {
		return nil
	}

	d.prevCrossed = d.hasCrossed
	d.prevCrossingUs = d.lastCrossingUs
	d.hasCrossed = true
	d.lastCrossingUs = refinedTs

	// Compute pass shape descriptors so downstream `crossing_rules` & analytics work seamlessly
	refEnter := enterDbm
	if refEnter >= 0 || refEnter > peakRssi-2.0 {
		refEnter = peakRssi - 8.0
	}
	refExit := exitDbm
	if refExit >= 0 || refExit > refEnter-2.0 {
		refExit = refEnter - 6.0
	}
	var above6Steps, aboveEnterSteps, aboveExitSteps int
	var aboveEnterArea, passArea float64
	for i := 0; i < ringWinSize; i++ {
		v := d.medRing[i]
		if v >= peakRssi-6.0 {
			above6Steps++
		}
		if v >= refEnter {
			aboveEnterSteps++
			aboveEnterArea += float64(v-refEnter) * 0.02
		}
		if v >= refExit {
			aboveExitSteps++
			passArea += float64(v-refExit) * 0.02
		}
	}
	beamwidthMs := math.Max(120.0, float64(above6Steps)*20.0)
	speedMph := math.Max(8.0, math.Min(65.0, 8000.0/beamwidthMs))
	holdMs := math.Max(beamwidthMs, float64(aboveExitSteps)*20.0)
	aboveEnterMs := math.Max(140.0, float64(aboveEnterSteps)*20.0)
	if aboveEnterArea < 1.5 {
		aboveEnterArea = math.Max(1.5, float64(peakRssi-cand.floorDbm)*0.08)
	}
	if passArea < aboveEnterArea {
		passArea = aboveEnterArea * 1.6
	}
	laprfHeight := float32(math.Max(400, math.Min(3900, float64(peakRssi+95.0)*46.0)))

	return &dsp.CrossingCandidate{
		GateID:              d.gateID,
		SlotIndex:           d.slotIndex,
		TimestampUs:         refinedTs,
		PeakRSSIDbm:         peakRssi,
		LapRFPeakHeight:     laprfHeight,
		BeamwidthMs:         beamwidthMs,
		EstimatedSpeedMph:   math.Round(speedMph*10) / 10,
		HoldMs:              holdMs,
		AboveEnterMs:        aboveEnterMs,
		AboveEnterAreaDbSec: math.Round(aboveEnterArea*100) / 100,
		PassAreaDbSec:       math.Round(passArea*100) / 100,
		IsStepBurst:         false,
	}
}
