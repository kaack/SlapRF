package ml

import (
	"math"
	"math/rand"
)

// CrossingLabel marks a verified positive crossing on a single-timer trace.
type CrossingLabel struct {
	TimestampUs uint64
	Manual      bool
	Boost       float32 // Optional sample weight boost override (0 -> default 14.0 or 24.0 if Manual)
}

// NegativeMark marks a hard-negative window (human-deleted `x` or cross-gate bleed).
type NegativeMark struct {
	TimestampUs uint64
	Weight      float32
}

// LabeledTrace represents one single-timer, single-pilot raw RSSI trace with positive & negative labels.
type LabeledTrace struct {
	SessionID   string
	GateID      uint8
	SlotIndex   int
	EnterDbm    float32
	ExitDbm     float32
	Points      []RawPoint
	Positives   []CrossingLabel
	HardNegs    []NegativeMark
}

// GenerateSyntheticTraces generates diverse physics-based 5.8 GHz FPV timing traces covering:
// - Fast, medium, and slow inverse-square gate passes (10..38 mph)
// - Power-on near Start/Finish hover shelves followed by takeoff passes
// - Compact-track elevated departure baselines (-67..-71 dBm)
// - Dipole polarization apex notches ("M-shaped" split peaks)
// - Hard negatives: rectangular Wi-Fi step bursts, return-lane weak bumps, and ambient noise
func GenerateSyntheticTraces(count int, seed int64) []LabeledTrace {
	rng := rand.New(rand.NewSource(seed))
	out := make([]LabeledTrace, 0, count)

	for idx := 0; idx < count; idx++ {
		floor := float32(-92.0 + rng.Float64()*5.0) // -92..-87 dBm
		const durSec = 48.0
		const nPts = int(durSec * 50)
		startTs := uint64(10_000_000)

		rssi := make([]float32, nPts)
		for i := range rssi {
			rssi[i] = floor + float32(rng.NormFloat64()*0.85)
		}

		// Optional compact-track ambient baseline drift on half of synthetic traces
		compactShelf := rng.Float64() < 0.55
		shelfDbm := floor + float32(16.0+rng.Float64()*6.0) // ~ -75..-67 dBm

		var positives []CrossingLabel
		var hardNegs []NegativeMark

		// 3 to 5 true passes spaced by 8..13 seconds
		tSec := 3.5 + rng.Float64()*2.0
		passNum := 0
		for tSec < durSec-4.0 {
			peakExcess := 28.0 + rng.Float64()*18.0 // +28..+46 dB above floor (-64..-44 dBm)
			halfWidthSec := 0.14 + rng.Float64()*0.32 // fast 35 mph to slower 12 mph whoop
			hasDipoleNotch := rng.Float64() < 0.28
			notchDepth := 3.0 + rng.Float64()*3.5
			takeoffHover := passNum == 0 && rng.Float64() < 0.45

			// Add inverse-square Lorentzian pass envelope: peakExcess / (1 + ((t - t0)/w)^2)
			for i := 0; i < nPts; i++ {
				ti := float64(i) * 0.02
				dt := ti - tSec
				if math.Abs(dt) > 4.5 {
					continue
				}
				u := dt / halfWidthSec
				env := peakExcess / (1.0 + u*u)
				if hasDipoleNotch && math.Abs(dt) < 0.055 {
					notch := notchDepth * math.Exp(-(dt*dt)/(2*0.022*0.022))
					env = math.Max(0, env-notch)
				}
				// Post-lull power-on hover shelf before Pass #1
				if takeoffHover && dt < -0.15 && dt > -2.6 {
					hover := peakExcess * (0.42 + 0.08*math.Sin(dt*4.0))
					if hover > env {
						env = hover
					}
				}
				// Compact-track departure shelf lingering 1.8..2.6 s after peak
				if compactShelf && dt > 0.20 && dt < 2.3 {
					linger := float64(shelfDbm-floor) * math.Exp(-math.Max(0, dt-1.4)/0.8)
					if linger > env {
						env = linger
					}
				}
				cand := floor + float32(env) + float32(rng.NormFloat64()*0.7)
				if cand > rssi[i] {
					rssi[i] = cand
				}
			}

			trueTsUs := startTs + uint64(math.Round(tSec*1e6))
			positives = append(positives, CrossingLabel{TimestampUs: trueTsUs})

			// Inject an off-gate return-lane weak bump ~3.5..5.0 s after pass (`label = 0`)
			if tSec+5.5 < durSec-3.0 && rng.Float64() < 0.7 {
				bumpSec := tSec + 3.4 + rng.Float64()*1.6
				bumpExcess := math.Min(peakExcess-13.5, 11.0+rng.Float64()*7.5) // clearly weaker cross-lane flyby
				bumpW := 0.35 + rng.Float64()*0.35
				for i := 0; i < nPts; i++ {
					ti := float64(i) * 0.02
					dt := ti - bumpSec
					if math.Abs(dt) > 2.2 {
						continue
					}
					u := dt / bumpW
					cand := floor + float32(bumpExcess/(1.0+u*u)) + float32(rng.NormFloat64()*0.7)
					if cand > rssi[i] {
						rssi[i] = cand
					}
				}
				hardNegs = append(hardNegs, NegativeMark{
					TimestampUs: startTs + uint64(math.Round(bumpSec*1e6)),
					Weight:      3.5,
				})
			}

			// Inject rectangular Wi-Fi packet step burst (`label = 0`)
			if tSec+2.3 < durSec-2.5 && rng.Float64() < 0.55 {
				wifiSec := tSec + 1.8 + rng.Float64()*0.9
				wifiDur := 0.04 + rng.Float64()*0.12 // 2..6 frames flat-top step
				wifiAmp := 16.0 + rng.Float64()*18.0
				for i := 0; i < nPts; i++ {
					ti := float64(i) * 0.02
					if ti >= wifiSec && ti <= wifiSec+wifiDur {
						cand := floor + float32(wifiAmp)
						if cand > rssi[i] {
							rssi[i] = cand
						}
					}
				}
				hardNegs = append(hardNegs, NegativeMark{
					TimestampUs: startTs + uint64(math.Round((wifiSec+0.5*wifiDur)*1e6)),
					Weight:      4.5,
				})
			}

			passNum++
			tSec += 8.2 + rng.Float64()*4.5
		}

		pts := make([]RawPoint, nPts)
		for i := 0; i < nPts; i++ {
			pts[i] = RawPoint{
				TimestampUs:   startTs + uint64(i)*StepUs,
				RSSIDbm:       rssi[i],
				NoiseFloorDbm: floor,
			}
		}
		out = append(out, LabeledTrace{
			SessionID: "synth",
			GateID:    1,
			SlotIndex: 1,
			EnterDbm:  floor + 20.0,
			ExitDbm:   floor + 12.0,
			Points:    pts,
			Positives: positives,
			HardNegs:  hardNegs,
		})
	}
	return out
}

// AugmentTrace produces a physics-augmented copy of `src` (gain scaling, speed time-stretch,
// compact-track linger shelf, dipole apex notch, and synthetic Wi-Fi step burst negatives).
func AugmentTrace(src LabeledTrace, rng *rand.Rand) LabeledTrace {
	if len(src.Points) < 16 {
		return src
	}
	gainShift := float32((rng.Float64()*2.0 - 1.0) * 6.0)        // -6..+6 dB VTX power / range shift
	floorShift := float32((rng.Float64()*2.0 - 1.0) * 2.0)       // -2..+2 dB environment shift
	timeScale := 0.90 + rng.Float64()*0.22                       // gentle 0.90x..1.12x speed warp
	injectShelf := false
	injectDipole := rng.Float64() < 0.12

	t0 := src.Points[0].TimestampUs
	scaleTs := func(ts uint64) uint64 {
		if ts <= t0 {
			return t0
		}
		return t0 + uint64(math.Round(float64(ts-t0)*timeScale))
	}

	newPos := make([]CrossingLabel, len(src.Positives))
	for i, p := range src.Positives {
		newPos[i] = CrossingLabel{
			TimestampUs: scaleTs(p.TimestampUs),
			Manual:      p.Manual,
			Boost:       p.Boost,
		}
	}
	newNegs := make([]NegativeMark, len(src.HardNegs))
	for i, n := range src.HardNegs {
		newNegs[i] = NegativeMark{
			TimestampUs: scaleTs(n.TimestampUs),
			Weight:      n.Weight,
		}
	}

	pts := make([]RawPoint, len(src.Points))
	posCursor := 0
	for i, p := range src.Points {
		ts := scaleTs(p.TimestampUs)
		fl := p.NoiseFloorDbm + floorShift
		excess := p.RSSIDbm - p.NoiseFloorDbm
		var r float32
		if excess <= 3.0 {
			r = fl + excess + float32(rng.Float64()-0.5)*0.9
		} else {
			// Scale excess smoothly so peaks shift without detaching ambient floor
			r = fl + excess + gainShift*clamp32(excess/22.0, 0.0, 1.0) + float32(rng.Float64()-0.5)*1.3
		}

		if (injectDipole || injectShelf) && len(newPos) > 0 {
			for posCursor+1 < len(newPos) && int64(ts)-int64(newPos[posCursor].TimestampUs) > 2_000_000 {
				posCursor++
			}
			for k := posCursor; k < len(newPos); k++ {
				dtUs := int64(ts) - int64(newPos[k].TimestampUs)
				if dtUs < -100_000 {
					break
				}
				dtSec := float64(dtUs) / 1e6
				if injectDipole && math.Abs(dtSec) < 0.045 {
					r -= float32(3.5 * math.Exp(-(dtSec*dtSec)/(2*0.02*0.02)))
				}
				if injectShelf && dtSec > 0.24 && dtSec < 1.9 {
					shelf := fl + 20.0
					if shelf > r {
						r = shelf
					}
				}
			}
		}

		pts[i] = RawPoint{
			TimestampUs:   ts,
			RSSIDbm:       clamp32(r, -120.0, -15.0),
			NoiseFloorDbm: clamp32(fl, -115.0, -70.0),
		}
	}

	return LabeledTrace{
		SessionID: src.SessionID,
		GateID:    src.GateID,
		SlotIndex: src.SlotIndex,
		EnterDbm:  src.EnterDbm + gainShift*0.5,
		ExitDbm:   src.ExitDbm + gainShift*0.5,
		Points:    pts,
		Positives: newPos,
		HardNegs:  newNegs,
	}
}
