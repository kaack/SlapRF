package ml

import (
	"fmt"
	"math"
	"sort"

	"slaprf/internal/domain"
	"slaprf/internal/tracestore"
)

// CoincidentPeak summarizes a concurrent RSSI excursion on an adjacent gate within +-180 ms.
type CoincidentPeak struct {
	GateID       uint8   `json:"gateId"`
	GateName     string  `json:"gateName"`
	DtMs         int     `json:"dtMs"`
	PeakRSSIDbm  float32 `json:"peakRssiDbm"`
	ProminenceDb float32 `json:"prominenceDb"`
}

// CandidatePeak represents a high-recall RSSI excursion (`>= 8.0 dB` above ambient floor) extracted
// from a recorded `.rfbin` practice trace for System 1 AI classification.
type CandidatePeak struct {
	ID              string           `json:"id"`
	GateID          uint8            `json:"gateId"`
	GateName        string           `json:"gateName"`
	GateRole        string           `json:"gateRole"`
	SlotIndex       int              `json:"slotIndex"`
	Callsign        string           `json:"callsign"`
	AnchorTsUs      uint64           `json:"anchorTsUs"`
	PeakRSSIDbm     float32          `json:"peakRssiDbm"`
	FloorDbm        float32          `json:"floorDbm"`
	ProminenceDb    float32          `json:"prominenceDb"`
	WidthHalfPromMs int              `json:"widthHalfPromMs"`
	MDipDb          float32          `json:"mDipDb,omitempty"`
	MDipOffsetMs    int              `json:"mDipOffsetMs,omitempty"`
	Coincident      []CoincidentPeak `json:"coincident,omitempty"`
	Shape40ms       [13]int          `json:"shape40ms"`
}

// CandidateDecision holds the System 1 Teacher's label and timing refinement for one candidate.
type CandidateDecision struct {
	ID         string  `json:"id"`
	GateID     uint8   `json:"gateId"`
	SlotIndex  int     `json:"slotIndex"`
	Label      string  `json:"label"` // "crossing" | "bleed" | "multipath" | "noise"
	AnchorTsUs uint64  `json:"anchorTsUs"`
	DeltaMs    int     `json:"deltaMs"`
	FinalTsUs  uint64  `json:"finalTsUs"`
	PeakDbm    float32 `json:"peakRssiDbm"`
	Confidence float32 `json:"confidence"`
}

type rawSeqPeak struct {
	seqIdx  int
	stepIdx int
	tsUs    uint64
	peakDbm float32
	floor   float32
	promDb  float32
	widthMs int
	mDipDb  float32
	mOffMs  int
	shape   [13]int
}

// FlightStintSpan represents a contiguous active flight interval `[LoUs, HiUs]` for a pilot.
type FlightStintSpan struct {
	LoUs uint64
	HiUs uint64
}

// BuildPilotFlightStints merges recorded lap intervals (`[lapStart - 2.2s .. lapEnd + 2.2s]`,
// bridging gaps `<= 5.0s`) plus manual crossing edits so both candidate extraction and TCN training
// ignore pre-flight, landing/pack-swap, and post-flight bench dead-air!
func BuildPilotFlightStints(sess domain.PracticeSession) map[int][]FlightStintSpan {
	stintsBySlot := make(map[int][]FlightStintSpan)
	addSpan := func(slot int, lo, hi uint64) {
		if slot <= 0 || hi <= lo {
			return
		}
		stintsBySlot[slot] = append(stintsBySlot[slot], FlightStintSpan{LoUs: lo, HiUs: hi})
	}
	const stintPadUs = uint64(2_200_000)
	for _, l := range sess.Laps {
		if l.Invalidated || l.CompletedAtUs == 0 || l.LapTimeSec <= 0 {
			continue
		}
		durUs := uint64(math.Round(l.LapTimeSec * 1e6))
		startUs := uint64(0)
		if l.CompletedAtUs > durUs+stintPadUs {
			startUs = l.CompletedAtUs - durUs - stintPadUs
		}
		addSpan(l.SlotIndex, startUs, l.CompletedAtUs+stintPadUs)
	}
	for _, c := range sess.Crossings {
		if c.Manual && c.TimestampUs > 0 {
			lo := uint64(0)
			if c.TimestampUs > stintPadUs {
				lo = c.TimestampUs - stintPadUs
			}
			addSpan(c.SlotIndex, lo, c.TimestampUs+stintPadUs)
		}
	}
	for _, del := range sess.ManualDeletedCrossings {
		if del.TimestampUs > 0 {
			lo := uint64(0)
			if del.TimestampUs > stintPadUs {
				lo = del.TimestampUs - stintPadUs
			}
			addSpan(del.SlotIndex, lo, del.TimestampUs+stintPadUs)
		}
	}
	for slot, list := range stintsBySlot {
		sort.Slice(list, func(i, j int) bool { return list[i].LoUs < list[j].LoUs })
		merged := list[:1]
		for _, s := range list[1:] {
			last := &merged[len(merged)-1]
			if s.LoUs <= last.HiUs+5_000_000 {
				if s.HiUs > last.HiUs {
					last.HiUs = s.HiUs
				}
			} else {
				merged = append(merged, s)
			}
		}
		stintsBySlot[slot] = merged
	}
	return stintsBySlot
}

// InPilotFlightStint reports whether `tsUs` falls inside one of `slot`'s active flight stints
// (returning `true` when `slot` has no completed laps yet so raw pre-lap traces can still be labeled).
func InPilotFlightStint(stintsBySlot map[int][]FlightStintSpan, slot int, tsUs uint64) bool {
	stints := stintsBySlot[slot]
	if len(stints) == 0 {
		return true
	}
	i := sort.Search(len(stints), func(k int) bool { return stints[k].HiUs >= tsUs })
	return i < len(stints) && tsUs >= stints[i].LoUs
}

// ExtractSessionCandidates extracts all candidate RSSI peaks (`>= 8.0 dB` above floor) across all
// recorded gates and active pilots in `sess`, chopping bench dead-air outside active flight stints
// and attaching cross-gate coincidence and 13-bin 40 ms shapes.
func ExtractSessionCandidates(sess domain.PracticeSession, samples []tracestore.Sample) []CandidatePeak {
	if len(samples) < 16 {
		return nil
	}
	stintsBySlot := BuildPilotFlightStints(sess)
	type gpKey struct {
		gateID    uint8
		slotIndex int
	}
	activeSlots := make(map[int]string)
	for _, p := range sess.Pilots {
		if p.SlotIndex > 0 {
			cs := p.Callsign
			if cs == "" {
				cs = fmt.Sprintf("P%d", p.SlotIndex)
			}
			activeSlots[p.SlotIndex] = cs
		}
	}

	gateNames := make(map[uint8]string)
	gateRoles := make(map[uint8]string)
	for _, g := range sess.TrackSnapshot {
		nm := g.Name
		if nm == "" {
			nm = fmt.Sprintf("G%d", g.GateID)
		}
		gateNames[g.GateID] = nm
		gateRoles[g.GateID] = string(g.Role)
	}

	pointsByKey := make(map[gpKey][]RawPoint)
	for _, s := range samples {
		for k, slotU8 := range s.SlotIndices {
			slotIdx := int(slotU8)
			if len(activeSlots) > 0 {
				if _, ok := activeSlots[slotIdx]; !ok {
					continue
				}
			}
			if k >= len(s.RSSIDbm) || s.RSSIDbm[k] <= -120.0 {
				continue
			}
			if !InPilotFlightStint(stintsBySlot, slotIdx, s.TimestampUs) {
				continue
			}
			key := gpKey{gateID: s.GateID, slotIndex: slotIdx}
			pointsByKey[key] = append(pointsByKey[key], RawPoint{
				TimestampUs:   s.TimestampUs,
				RSSIDbm:       s.RSSIDbm[k],
				NoiseFloorDbm: s.NoiseFloorDbm,
			})
		}
	}

	var all []CandidatePeak
	for key, pts := range pointsByKey {
		if len(pts) < 16 {
			continue
		}
		sort.Slice(pts, func(i, j int) bool { return pts[i].TimestampUs < pts[j].TimestampUs })
		segs := ResampleSegments(pts)
		gName := gateNames[key.gateID]
		if gName == "" {
			gName = fmt.Sprintf("G%d", key.gateID)
		}
		gRole := gateRoles[key.gateID]
		if gRole == "" {
			gRole = "SECTOR_GATE"
		}
		cs := activeSlots[key.slotIndex]
		if cs == "" {
			cs = fmt.Sprintf("P%d", key.slotIndex)
		}

		for si, seg := range segs {
			pks := extractGridSequencePeaks(si, seg)
			for _, pk := range pks {
				all = append(all, CandidatePeak{
					GateID:          key.gateID,
					GateName:        gName,
					GateRole:        gRole,
					SlotIndex:       key.slotIndex,
					Callsign:        cs,
					AnchorTsUs:      pk.tsUs,
					PeakRSSIDbm:     float32(math.Round(float64(pk.peakDbm)*10) / 10),
					FloorDbm:        float32(math.Round(float64(pk.floor)*10) / 10),
					ProminenceDb:    float32(math.Round(float64(pk.promDb)*10) / 10),
					WidthHalfPromMs: pk.widthMs,
					MDipDb:          float32(math.Round(float64(pk.mDipDb)*10) / 10),
					MDipOffsetMs:    pk.mOffMs,
					Shape40ms:       pk.shape,
				})
			}
		}
	}

	// Sort chronologically across the entire pack and assign stable C1..CN IDs
	sort.Slice(all, func(i, j int) bool {
		if all[i].AnchorTsUs != all[j].AnchorTsUs {
			return all[i].AnchorTsUs < all[j].AnchorTsUs
		}
		if all[i].SlotIndex != all[j].SlotIndex {
			return all[i].SlotIndex < all[j].SlotIndex
		}
		return all[i].GateID < all[j].GateID
	})
	for i := range all {
		all[i].ID = fmt.Sprintf("C%d", i+1)
	}

	// Populate cross-gate coincident peaks within +-420 ms for the same pilot (capturing VTX dipole
	// sweep lead/lag as the quad banks between adjacent gates).
	const coincWindowUs = 420_000
	for i := range all {
		ci := &all[i]
		for j := range all {
			if i == j || all[j].SlotIndex != ci.SlotIndex || all[j].GateID == ci.GateID {
				continue
			}
			dtUs := int64(all[j].AnchorTsUs) - int64(ci.AnchorTsUs)
			if dtUs < -coincWindowUs || dtUs > coincWindowUs {
				continue
			}
			ci.Coincident = append(ci.Coincident, CoincidentPeak{
				GateID:       all[j].GateID,
				GateName:     all[j].GateName,
				DtMs:         int(math.Round(float64(dtUs) / 1000.0)),
				PeakRSSIDbm:  all[j].PeakRSSIDbm,
				ProminenceDb: all[j].ProminenceDb,
			})
		}
	}
	return all
}

func extractGridSequencePeaks(seqIdx int, seq GridSequence) []rawSeqPeak {
	T := len(seq.MedRSSI)
	if T < 8 {
		return nil
	}
	var raw []rawSeqPeak
	for t := 2; t < T-2; t++ {
		prom := seq.MedRSSI[t] - seq.FloorDbm[t]
		if prom < 8.0 {
			continue
		}
		// Local maximum over +-2 steps (+-40 ms) so 60..200 ms dipole M-null shoulders are both visible
		// to the M-saddle merger below before enforcing general peak spacing.
		val := seq.MedRSSI[t]
		isMax := true
		for k := t - 2; k <= t+2; k++ {
			if k >= 0 && k < T && k != t {
				if seq.MedRSSI[k] > val || (seq.MedRSSI[k] == val && k == t-1) {
					isMax = false
					break
				}
			}
		}
		if !isMax {
			continue
		}
		if len(raw) > 0 && t-raw[len(raw)-1].stepIdx < 2 {
			if val > raw[len(raw)-1].peakDbm {
				raw[len(raw)-1] = buildSeqPeak(seqIdx, seq, t)
			}
			continue
		}
		raw = append(raw, buildSeqPeak(seqIdx, seq, t))
	}

	// Merge symmetric dipole M-null double shoulders (spacing 40..220 ms = 2..11 steps, shoulder delta <= 6.5 dB,
	// valley dip 1.2..12.0 dB below lower shoulder).
	var merged []rawSeqPeak
	for i := 0; i < len(raw); i++ {
		cur := raw[i]
		if i+1 < len(raw) {
			nxt := raw[i+1]
			stepGap := nxt.stepIdx - cur.stepIdx
			shoulderDiff := float32(math.Abs(float64(cur.peakDbm - nxt.peakDbm)))
			if stepGap >= 2 && stepGap <= 11 && shoulderDiff <= 6.5 && cur.promDb >= 16.0 && nxt.promDb >= 16.0 {
				minValley := cur.peakDbm
				valleyStep := (cur.stepIdx + nxt.stepIdx) / 2
				for k := cur.stepIdx + 1; k < nxt.stepIdx; k++ {
					if seq.MedRSSI[k] < minValley {
						minValley = seq.MedRSSI[k]
						valleyStep = k
					}
				}
				lowShoulder := cur.peakDbm
				if nxt.peakDbm < lowShoulder {
					lowShoulder = nxt.peakDbm
				}
				dip := lowShoulder - minValley
				if dip >= 1.2 && dip <= 12.0 {
					// Keep higher shoulder as primary peak and record exact saddle midpoint offset!
					dom := cur
					if nxt.peakDbm > cur.peakDbm {
						dom = nxt
					}
					saddleTs := (cur.tsUs + nxt.tsUs) / 2
					if valleyStep > cur.stepIdx && valleyStep < nxt.stepIdx {
						vTs := seq.StartTsUs + uint64(valleyStep)*StepUs
						saddleTs = (saddleTs + vTs) / 2
					}
					offMs := int(math.Round(float64(int64(saddleTs)-int64(dom.tsUs)) / 1000.0))
					if offMs < -120 {
						offMs = -120
					} else if offMs > 120 {
						offMs = 120
					}
					dom.mDipDb = dip
					dom.mOffMs = offMs
					dom.widthMs = computeHalfPromWidthMs(seq, (cur.stepIdx+nxt.stepIdx)/2, dom.peakDbm, dom.floor)
					dom.shape = sampleShape40ms(seq, dom.stepIdx)
					merged = append(merged, dom)
					i++ // skip second shoulder
					continue
				}
			}
		}
		merged = append(merged, cur)
	}

	// Filter out flat-shelf quantization ripples (`< 6.0 dB` local rise above the surrounding +-1.2s
	// local trough) so compact tracks where ambient VTX sits 10..15 dB above `-91 dBm` thermal noise
	// emit ~150 real physical excursions instead of thousands of baseline wiggles!
	const localValleySteps = 60 // +-1.20 s at 50 Hz
	var prominent []rawSeqPeak
	for _, pk := range merged {
		if pk.promDb < 11.0 {
			continue
		}
		loL := pk.stepIdx - localValleySteps
		if loL < 0 {
			loL = 0
		}
		hiR := pk.stepIdx + localValleySteps
		if hiR >= T {
			hiR = T - 1
		}
		minLeft := pk.peakDbm
		for k := loL; k < pk.stepIdx; k++ {
			if seq.MedRSSI[k] < minLeft {
				minLeft = seq.MedRSSI[k]
			}
		}
		minRight := pk.peakDbm
		for k := pk.stepIdx + 1; k <= hiR; k++ {
			if seq.MedRSSI[k] < minRight {
				minRight = seq.MedRSSI[k]
			}
		}
		riseLeft := pk.peakDbm - minLeft
		riseRight := pk.peakDbm - minRight
		localRise := riseLeft
		if riseRight < localRise {
			localRise = riseRight
		}
		if localRise < 6.0 {
			continue
		}
		prominent = append(prominent, pk)
	}

	// Non-maximum suppression within +-420 ms (`21` steps) so minor quantization shoulders on the flanks
	// of a single gate bell curve collapse to the single true peak crest.
	const nmsSteps = 21
	var kept []rawSeqPeak
	for i, pk := range prominent {
		suppressed := false
		for j := i - 1; j >= 0 && pk.stepIdx-prominent[j].stepIdx <= nmsSteps; j-- {
			if prominent[j].peakDbm >= pk.peakDbm {
				suppressed = true
				break
			}
		}
		if !suppressed {
			for j := i + 1; j < len(prominent) && prominent[j].stepIdx-pk.stepIdx <= nmsSteps; j++ {
				if prominent[j].peakDbm > pk.peakDbm {
					suppressed = true
					break
				}
			}
		}
		if !suppressed {
			kept = append(kept, pk)
		}
	}
	return kept
}

func buildSeqPeak(seqIdx int, seq GridSequence, t int) rawSeqPeak {
	y0 := float64(seq.MedRSSI[t-1])
	y1 := float64(seq.MedRSSI[t])
	y2 := float64(seq.MedRSSI[t+1])
	denom := y0 - 2*y1 + y2
	subStep := 0.0
	if math.Abs(denom) > 1e-4 {
		subStep = 0.5 * (y0 - y2) / denom
		if subStep < -0.5 {
			subStep = -0.5
		} else if subStep > 0.5 {
			subStep = 0.5
		}
	}
	tsInt := int64(seq.StartTsUs) + int64(math.Round((float64(t)+subStep)*float64(StepUs)))
	if tsInt < 0 {
		tsInt = 0
	}
	pk := seq.MedRSSI[t]
	fl := seq.FloorDbm[t]
	return rawSeqPeak{
		seqIdx:  seqIdx,
		stepIdx: t,
		tsUs:    uint64(tsInt),
		peakDbm: pk,
		floor:   fl,
		promDb:  pk - fl,
		widthMs: computeHalfPromWidthMs(seq, t, pk, fl),
		shape:   sampleShape40ms(seq, t),
	}
}

func computeHalfPromWidthMs(seq GridSequence, centerStep int, peakDbm, floorDbm float32) int {
	T := len(seq.MedRSSI)
	halfLvl := floorDbm + 0.5*(peakDbm-floorDbm)
	left := centerStep
	for left > 0 && centerStep-left < 40 && seq.MedRSSI[left] >= halfLvl {
		left--
	}
	right := centerStep
	for right < T-1 && right-centerStep < 40 && seq.MedRSSI[right] >= halfLvl {
		right++
	}
	w := (right - left) * 20
	if w < 20 {
		w = 20
	}
	return w
}

func sampleShape40ms(seq GridSequence, centerStep int) [13]int {
	var out [13]int
	T := len(seq.MedRSSI)
	fl := seq.FloorDbm[centerStep]
	for k := -6; k <= 6; k++ {
		idx := centerStep + k*2
		if idx < 0 {
			idx = 0
		} else if idx >= T {
			idx = T - 1
		}
		ex := int(math.Round(float64(seq.MedRSSI[idx] - fl)))
		if ex < 0 {
			ex = 0
		}
		out[k+6] = ex
	}
	return out
}
