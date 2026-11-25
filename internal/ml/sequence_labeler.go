package ml

import (
	"math"
	"sort"

	"slaprf/internal/domain"
	"slaprf/internal/tracestore"
)

// TrackOrderLabelOptions configures sequence-level auto-labeling over either a bounded RSSI Editor
// window (`WindowStartUs..WindowEndUs`) or a full multi-stint Practice session (`WindowEndUs == 0`).
type TrackOrderLabelOptions struct {
	WindowStartUs uint64
	WindowEndUs   uint64
	TeacherPriors map[string]float32 // Optional candidate ID -> [0..1] crossing probability from Qwen3
}

type dpPathState struct {
	valid        bool
	score        float64
	prevIdx      int
	stintLen     int
	lapsInStint  int
	skippedInLap int
	lapStartUs   uint64
	lastGateUs   [16]uint64 // indexed by gate order 0..K-1 (supports up to 16 gates; fallback map if K>16)
}

func clamp64(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// orderedTrackGatesFromSession returns the session's gates in sequential track order (`G_0 = Start/Finish`,
// `G_1 .. G_{K-1} = Sector Gates`), falling back to distinct candidate GateIDs if TrackSnapshot is empty.
func orderedTrackGatesFromSession(sess domain.PracticeSession, candidates []CandidatePeak) []domain.TrackGate {
	if len(sess.TrackSnapshot) > 0 {
		gates := append([]domain.TrackGate(nil), sess.TrackSnapshot...)
		sort.SliceStable(gates, func(i, j int) bool {
			if gates[i].TrackOrder != gates[j].TrackOrder {
				return gates[i].TrackOrder < gates[j].TrackOrder
			}
			return gates[i].GateID < gates[j].GateID
		})
		// Ensure Start/Finish sits at index 0 if present
		sfIdx := -1
		for i, g := range gates {
			if g.Role == domain.GateRoleStartFinish {
				sfIdx = i
				break
			}
		}
		if sfIdx > 0 {
			rotated := make([]domain.TrackGate, 0, len(gates))
			rotated = append(rotated, gates[sfIdx:]...)
			rotated = append(rotated, gates[:sfIdx]...)
			gates = rotated
		}
		return gates
	}

	seen := make(map[uint8]bool)
	var ids []uint8
	for _, c := range candidates {
		if c.GateID > 0 && !seen[c.GateID] {
			seen[c.GateID] = true
			ids = append(ids, c.GateID)
		}
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	out := make([]domain.TrackGate, len(ids))
	for i, id := range ids {
		role := domain.GateRoleSectorGate
		if i == 0 {
			role = domain.GateRoleStartFinish
		}
		out[i] = domain.TrackGate{
			GateID:     id,
			Role:       role,
			TrackOrder: i,
		}
	}
	return out
}

// computeGateReferenceProminence estimates each gate's typical full-pass prominence (dB above floor)
// for a pilot by running greedy non-maximum suppression (`>= 0.75 * minLapSec`) sorted by prominence
// descending and taking the median of the dominant peaks (or max when `<= 2` peaks, e.g. single lap).
func computeGateReferenceProminence(pCands []CandidatePeak, minLapUs uint64) map[uint8]float32 {
	byGate := make(map[uint8][]CandidatePeak)
	for _, c := range pCands {
		byGate[c.GateID] = append(byGate[c.GateID], c)
	}
	spacingUs := uint64(float64(minLapUs) * 0.75)
	if spacingUs < 1_500_000 {
		spacingUs = 1_500_000
	}

	ref := make(map[uint8]float32, len(byGate))
	for gid, list := range byGate {
		sorted := append([]CandidatePeak(nil), list...)
		sort.Slice(sorted, func(i, j int) bool {
			return sorted[i].ProminenceDb > sorted[j].ProminenceDb
		})
		var top []float64
		var acceptedTs []uint64
		for _, c := range sorted {
			tooClose := false
			for _, ts := range acceptedTs {
				var diff uint64
				if c.AnchorTsUs >= ts {
					diff = c.AnchorTsUs - ts
				} else {
					diff = ts - c.AnchorTsUs
				}
				if diff < spacingUs {
					tooClose = true
					break
				}
			}
			if !tooClose {
				acceptedTs = append(acceptedTs, c.AnchorTsUs)
				top = append(top, float64(c.ProminenceDb))
			}
		}
		var val float64
		if len(top) == 0 {
			val = 24.0
		} else if len(top) <= 2 {
			val = top[0]
		} else {
			sort.Float64s(top)
			// Use 65th percentile of spaced dominant peaks so occasional missed laps or extra flybys don't skew ceiling
			idx := int(math.Round(0.65 * float64(len(top)-1)))
			val = top[idx]
		}
		ref[gid] = float32(clamp64(val, 15.0, 45.0))
	}
	return ref
}

// estimateTypicalLapUs estimates the pilot's typical lap duration from dominant Start/Finish peaks
// so split-pacing priors scale seamlessly from 4s micro-whoop tracks to 25s outdoor tracks.
func estimateTypicalLapUs(pCands []CandidatePeak, sfGateID uint8, refProm float32, minLapUs, maxLapUs uint64, opts TrackOrderLabelOptions) uint64 {
	if opts.WindowEndUs > opts.WindowStartUs+minLapUs {
		span := opts.WindowEndUs - opts.WindowStartUs
		if span >= minLapUs && span <= 25_000_000 {
			if span > 700_000 {
				return span - 700_000
			}
			return span
		}
	}

	thresh := refProm * 0.68
	if thresh < 14.0 {
		thresh = 14.0
	}
	var sfPeaks []CandidatePeak
	for _, c := range pCands {
		if c.GateID == sfGateID && c.ProminenceDb >= thresh {
			sfPeaks = append(sfPeaks, c)
		}
	}
	// Greedy prominence NMS at minLapUs
	sort.Slice(sfPeaks, func(i, j int) bool { return sfPeaks[i].ProminenceDb > sfPeaks[j].ProminenceDb })
	var tsList []uint64
	for _, c := range sfPeaks {
		ok := true
		for _, ts := range tsList {
			var d uint64
			if c.AnchorTsUs >= ts {
				d = c.AnchorTsUs - ts
			} else {
				d = ts - c.AnchorTsUs
			}
			if d < minLapUs {
				ok = false
				break
			}
		}
		if ok {
			tsList = append(tsList, c.AnchorTsUs)
		}
	}
	sort.Slice(tsList, func(i, j int) bool { return tsList[i] < tsList[j] })
	var diffs []float64
	for i := 1; i < len(tsList); i++ {
		dt := tsList[i] - tsList[i-1]
		if dt >= minLapUs && dt <= 35_000_000 && dt <= maxLapUs {
			diffs = append(diffs, float64(dt))
		}
	}
	if len(diffs) > 0 {
		sort.Float64s(diffs)
		return uint64(diffs[len(diffs)/2])
	}
	def := minLapUs * 2
	if def < 10_000_000 {
		def = 10_000_000
	}
	return def
}

// LabelCandidatesTrackOrder solves the optimal monotonic track-ordered sequence of gate crossings
// (`G_0 -> G_1 -> ... -> G_{K-1} -> G_0`) via cyclic Viterbi dynamic programming, treating the
// target window or session as a clean blank slate independent of prior invalid/deleted state.
func LabelCandidatesTrackOrder(
	sess domain.PracticeSession,
	samples []tracestore.Sample,
	candidates []CandidatePeak,
	tcn *TCN,
	opts TrackOrderLabelOptions,
) []CandidateDecision {
	if len(candidates) == 0 {
		return nil
	}
	if tcn == nil {
		tcn, _ = PretrainedBaseModel()
	}

	rules := domain.DefaultTimingRules()
	if sess.Rules != nil {
		rules = sess.Rules.Normalized()
	}
	minLapUs := uint64(math.Round(rules.MinLapSec * 1e6))
	if minLapUs < 1_000_000 {
		minLapUs = 1_000_000
	}
	maxLapUs := uint64(math.Round(rules.MaxLapSec * 1e6))
	if maxLapUs < minLapUs+5_000_000 {
		maxLapUs = minLapUs + 5_000_000
	}

	orderedGates := orderedTrackGatesFromSession(sess, candidates)
	K := len(orderedGates)
	if K == 0 {
		return nil
	}
	if K > 16 {
		K = 16
		orderedGates = orderedGates[:16]
	}
	gateOrderMap := make(map[uint8]int, K)
	for idx, g := range orderedGates {
		gateOrderMap[g.GateID] = idx
	}
	sfGateID := orderedGates[0].GateID

	// Run batch 1D-TCN inference across present (gate, slot) waveform segments
	type gpKey struct {
		gateID    uint8
		slotIndex int
	}
	wantedKeys := make(map[gpKey]bool, len(candidates))
	for _, c := range candidates {
		wantedKeys[gpKey{gateID: c.GateID, slotIndex: c.SlotIndex}] = true
	}
	pointsByKey := make(map[gpKey][]RawPoint, len(wantedKeys))
	for _, s := range samples {
		for k, slotU8 := range s.SlotIndices {
			slotIdx := int(slotU8)
			key := gpKey{gateID: s.GateID, slotIndex: slotIdx}
			if !wantedKeys[key] || k >= len(s.RSSIDbm) || s.RSSIDbm[k] <= -120.0 {
				continue
			}
			pointsByKey[key] = append(pointsByKey[key], RawPoint{
				TimestampUs:   s.TimestampUs,
				RSSIDbm:       s.RSSIDbm[k],
				NoiseFloorDbm: s.NoiseFloorDbm,
			})
		}
	}

	type inferredSeg struct {
		startTsUs uint64
		probs     []float32
		dtMs      []float32
	}
	inferredByKey := make(map[gpKey][]inferredSeg, len(pointsByKey))
	for key, pts := range pointsByKey {
		if len(pts) < 16 {
			continue
		}
		sort.Slice(pts, func(i, j int) bool { return pts[i].TimestampUs < pts[j].TimestampUs })
		segs := ResampleSegments(pts)
		list := make([]inferredSeg, 0, len(segs))
		for _, seg := range segs {
			probs, dts, _ := tcn.InferSequence(seg.Features)
			list = append(list, inferredSeg{
				startTsUs: seg.StartTsUs,
				probs:     probs,
				dtMs:      dts,
			})
		}
		inferredByKey[key] = list
	}

	queryTCN := func(gateID uint8, slotIndex int, anchorTsUs uint64) (bestProb float32, bestDtMs float32, ok bool) {
		segs := inferredByKey[gpKey{gateID: gateID, slotIndex: slotIndex}]
		for _, seg := range segs {
			endTsUs := seg.startTsUs + uint64(len(seg.probs))*StepUs
			if anchorTsUs+160_000 < seg.startTsUs || anchorTsUs > endTsUs+160_000 {
				continue
			}
			var center int
			if anchorTsUs > seg.startTsUs {
				center = int((anchorTsUs - seg.startTsUs + StepUs/2) / StepUs)
			}
			lo := center - 6
			if lo < 0 {
				lo = 0
			}
			hi := center + 6
			if hi >= len(seg.probs) {
				hi = len(seg.probs) - 1
			}
			for t := lo; t <= hi; t++ {
				if !ok || seg.probs[t] > bestProb {
					bestProb = seg.probs[t]
					stepTsUs := seg.startTsUs + uint64(t)*StepUs
					stepShiftMs := float32(int64(stepTsUs)-int64(anchorTsUs)) / 1000.0
					bestDtMs = stepShiftMs + seg.dtMs[t]
					ok = true
				}
			}
		}
		return bestProb, bestDtMs, ok
	}

	hasWindow := opts.WindowEndUs > 0 && opts.WindowEndUs >= opts.WindowStartUs
	expectedStartUs := opts.WindowStartUs + 350_000
	expectedEndUs := opts.WindowEndUs
	if expectedEndUs > 350_000 {
		expectedEndUs -= 350_000
	}

	bySlot := make(map[int][]CandidatePeak)
	var slots []int
	for _, c := range candidates {
		if _, ok := gateOrderMap[c.GateID]; !ok {
			continue
		}
		if _, seen := bySlot[c.SlotIndex]; !seen {
			slots = append(slots, c.SlotIndex)
		}
		bySlot[c.SlotIndex] = append(bySlot[c.SlotIndex], c)
	}
	sort.Ints(slots)

	decisionsByID := make(map[string]CandidateDecision, len(candidates))

	for _, slot := range slots {
		pCands := bySlot[slot]
		sort.Slice(pCands, func(i, j int) bool {
			if pCands[i].AnchorTsUs != pCands[j].AnchorTsUs {
				return pCands[i].AnchorTsUs < pCands[j].AnchorTsUs
			}
			return gateOrderMap[pCands[i].GateID] < gateOrderMap[pCands[j].GateID]
		})
		N := len(pCands)
		if N == 0 {
			continue
		}

		// Collect pilot breaks + surrounding valid crossings outside [WindowStartUs, WindowEndUs]
		var slotBreaks []uint64
		for _, br := range sess.Breaks {
			if br.SlotIndex == slot && br.TimestampUs > 0 {
				slotBreaks = append(slotBreaks, br.TimestampUs)
			}
		}
		sort.Slice(slotBreaks, func(i, j int) bool { return slotBreaks[i] < slotBreaks[j] })
		hasBreakBetween := func(aUs, bUs uint64) bool {
			if len(slotBreaks) == 0 || bUs <= aUs {
				return false
			}
			idx := sort.Search(len(slotBreaks), func(k int) bool { return slotBreaks[k] > aUs })
			return idx < len(slotBreaks) && slotBreaks[idx] <= bUs
		}

		prevOutsideSameGateUs := make(map[uint8]uint64, K)
		nextOutsideSameGateUs := make(map[uint8]uint64, K)
		if hasWindow {
			for _, c := range sess.Crossings {
				if c.SlotIndex != slot || c.InvalidReason != "" {
					continue
				}
				if c.TimestampUs < opts.WindowStartUs {
					if c.TimestampUs > prevOutsideSameGateUs[c.GateID] {
						prevOutsideSameGateUs[c.GateID] = c.TimestampUs
					}
				} else if c.TimestampUs > opts.WindowEndUs {
					if cur, exists := nextOutsideSameGateUs[c.GateID]; !exists || c.TimestampUs < cur {
						nextOutsideSameGateUs[c.GateID] = c.TimestampUs
					}
				}
			}
		}

		refProm := computeGateReferenceProminence(pCands, minLapUs)
		typicalLapUs := estimateTypicalLapUs(pCands, sfGateID, refProm[sfGateID], minLapUs, maxLapUs, opts)
		effMinLapUs := minLapUs
		if !hasWindow {
			if paceMinUs := uint64(float64(typicalLapUs) * 0.58); paceMinUs > effMinLapUs {
				effMinLapUs = paceMinUs
			}
		}
		expectedSplitSec := float64(typicalLapUs) / (1e6 * float64(K))
		if expectedSplitSec < 0.45 {
			expectedSplitSec = 0.45
		}
		stintResetGapUs := uint64(clamp64(float64(typicalLapUs)*2.45, 24_000_000, float64(maxLapUs)))

		emitScore := make([]float64, N)
		tcnProbs := make([]float32, N)
		tcnDts := make([]float32, N)
		hasTCNs := make([]bool, N)
		rawCoincMax := make([]float32, N)
		gateOrd := make([]int, N)

		for i, c := range pCands {
			gateOrd[i] = gateOrderMap[c.GateID]
			ref := float64(refProm[c.GateID])
			if ref < 15.0 {
				ref = 15.0
			}
			prom := float64(c.ProminenceDb)
			rel := clamp64(prom/ref, 0.0, 1.22)
			rise := float64(c.LocalRiseDb)
			if rise <= 0 {
				rise = prom * 0.72
			}
			relRise := clamp64(rise/math.Max(11.0, ref*0.72), 0.0, 1.20)

			maxRawDiff := float32(-999)
			worstNormDiff := -999.0
			for _, co := range c.Coincident {
				rawDiff := co.ProminenceDb - c.ProminenceDb
				if rawDiff > maxRawDiff {
					maxRawDiff = rawDiff
				}
				coRef := float64(refProm[co.GateID])
				if coRef < 15.0 {
					coRef = ref
				}
				coRel := clamp64(float64(co.ProminenceDb)/coRef, 0.0, 1.22)
				w := 1.0 - math.Abs(float64(co.DtMs))/350.0
				if w > 0 {
					nd := w * (coRel - rel)
					if nd > worstNormDiff {
						worstNormDiff = nd
					}
				}
			}
			rawCoincMax[i] = maxRawDiff

			tp, td, okT := queryTCN(c.GateID, c.SlotIndex, c.AnchorTsUs)
			tcnProbs[i] = tp
			tcnDts[i] = td
			hasTCNs[i] = okT

			sc := -0.85 + 3.15*rel + 0.85*relRise + 0.038*clamp64(prom-10.0, -4.0, 28.0)
			if c.MDipDb >= 1.5 {
				sc += 0.30
			}
			if okT {
				sc += 1.15 * (float64(tp) - 0.32)
			}
			if opts.TeacherPriors != nil {
				if qp, okQ := opts.TeacherPriors[c.ID]; okQ {
					sc += 0.75 * (float64(qp) - 0.45)
				}
			}
			if worstNormDiff > -900 {
				if worstNormDiff > 0.10 {
					sc -= clamp64(2.8*(worstNormDiff-0.10), 0.0, 3.4)
				} else if worstNormDiff <= -0.15 {
					sc += clamp64(0.55*(-worstNormDiff), 0.0, 0.45)
				}
			}
			// Unmistakable raw cross-gate bleed (> +9 dB stronger simultaneous peak within 180 ms)
			for _, co := range c.Coincident {
				if absInt(co.DtMs) <= 180 && co.ProminenceDb-c.ProminenceDb >= 9.5 {
					sc -= 2.4
					break
				}
			}
			emitScore[i] = sc
		}

		// External boundary lockout check for single-lap windows
		violatesOutsideLockout := func(i int) bool {
			if !hasWindow {
				return false
			}
			gid := pCands[i].GateID
			ts := pCands[i].AnchorTsUs
			if prevUs, ok := prevOutsideSameGateUs[gid]; ok && prevUs > 0 && ts > prevUs {
				if !hasBreakBetween(prevUs, ts) && ts-prevUs < minLapUs {
					return true
				}
			}
			if nextUs, ok := nextOutsideSameGateUs[gid]; ok && nextUs > ts {
				if !hasBreakBetween(ts, nextUs) && nextUs-ts < minLapUs {
					return true
				}
			}
			return false
		}

		startBoundaryBonus := func(tsUs uint64) float64 {
			if !hasWindow {
				return 0.0
			}
			var dt uint64
			if tsUs >= expectedStartUs {
				dt = tsUs - expectedStartUs
			} else {
				dt = expectedStartUs - tsUs
			}
			if dt <= 850_000 {
				return 1.65 * (1.0 - float64(dt)/850_000.0)
			}
			return 0.0
		}

		endBoundaryBonus := func(tsUs uint64) float64 {
			if !hasWindow {
				return 0.0
			}
			var dt uint64
			if tsUs >= expectedEndUs {
				dt = tsUs - expectedEndUs
			} else {
				dt = expectedEndUs - tsUs
			}
			if dt <= 850_000 {
				return 1.65 * (1.0 - float64(dt)/850_000.0)
			}
			return 0.0
		}

		const minInterGateUs = uint64(280_000)
		const skipGateCost = 2.25
		noLapStintPenalty := 0.0
		if !hasWindow && N >= K+2 {
			noLapStintPenalty = 9.5
		}

		stintClosePenalty := func(st dpPathState, endIdx int) float64 {
			pen := 0.0
			if st.lapsInStint == 0 {
				pen -= noLapStintPenalty
			}
			if hasWindow {
				if gateOrd[endIdx] == 0 {
					pen += endBoundaryBonus(pCands[endIdx].AnchorTsUs)
				} else {
					pen -= 1.20
				}
			} else if gateOrd[endIdx] != 0 {
				pen -= 0.75
				if st.skippedInLap > 0 {
					// Never tack a gate-skipping pit-walk spike onto an uncompleted cooldown tail!
					pen -= 4.5 * float64(st.skippedInLap)
				}
			}
			return pen
		}

		dp := make([]dpPathState, N)
		// Track best finished-stint score strictly before candidate `i` for O(1) multi-stint resets!
		for i := 0; i < N; i++ {
			if violatesOutsideLockout(i) || emitScore[i] < -0.15 {
				continue
			}
			b := gateOrd[i]
			tsI := pCands[i].AnchorTsUs

			// Option A: Start the very first stint at candidate `i` (must be Start/Finish `b == 0`,
			// OR if `hasWindow` has zero `G_0` candidates in the entire window, allow sector start).
			if b == 0 {
				var st dpPathState
				st.valid = true
				st.score = emitScore[i] + startBoundaryBonus(tsI)
				st.prevIdx = -1
				st.stintLen = 1
				st.lapStartUs = tsI
				st.lastGateUs[0] = tsI
				dp[i] = st
			}

			// Option B: Transition from an earlier candidate `j < i`
			for j := i - 1; j >= 0; j-- {
				if !dp[j].valid {
					continue
				}
				tsJ := pCands[j].AnchorTsUs
				if tsI <= tsJ {
					continue
				}
				dtUs := tsI - tsJ
				a := gateOrd[j]

				isReset := hasBreakBetween(tsJ, tsI) || dtUs > maxLapUs || (!hasWindow && dtUs >= stintResetGapUs)
				if isReset {
					if b != 0 {
						continue
					}
					candScore := dp[j].score + stintClosePenalty(dp[j], j) + emitScore[i]
					if !dp[i].valid || candScore > dp[i].score {
						var st dpPathState
						st.valid = true
						st.score = candScore
						st.prevIdx = j
						st.stintLen = 1
						st.lapStartUs = tsI
						st.lastGateUs[0] = tsI
						dp[i] = st
					}
					continue
				}

				// Within-stint transition `a -> b`
				if dtUs < minInterGateUs {
					continue
				}
				if prevSame := dp[j].lastGateUs[b]; prevSame > 0 && tsI-prevSame < effMinLapUs {
					continue
				}
				if b == 0 && dp[j].lapStartUs > 0 && tsI-dp[j].lapStartUs < effMinLapUs {
					continue
				}

				var skipped int
				var transPen float64
				newSkippedInLap := dp[j].skippedInLap
				skipPenaltyForLap := func(prevSkip, addSkip int) float64 {
					p := 0.0
					for s := 1; s <= addSkip; s++ {
						tot := prevSkip + s
						if tot == 1 {
							p += skipGateCost
						} else {
							p += skipGateCost + 1.85*float64(tot-1)
						}
					}
					return p
				}
				if b > a {
					// Forward sector progression inside current lap (0 <= a < b <= K-1)
					skipped = b - a - 1
					if dtUs < uint64(skipped+1)*minInterGateUs {
						continue
					}
					maxStepSec := math.Max(8.5, 2.55*float64(skipped+1)*expectedSplitSec)
					if !hasWindow && float64(dtUs)/1e6 > maxStepSec {
						continue
					}
					transPen = skipPenaltyForLap(dp[j].skippedInLap, skipped)
					newSkippedInLap = dp[j].skippedInLap + skipped
				} else if b == 0 {
					// Completing current lap on Start/Finish
					if K == 1 {
						skipped = 0
						transPen = 0.0
					} else if a == 0 {
						// 0-sector G_0 -> G_0 lap skipping all K-1 sector gates
						skipped = K - 1
						transPen = math.Max(5.8, float64(K-1)*skipGateCost+2.2)
					} else {
						skipped = (K - 1) - a
						maxStepSec := math.Max(8.5, 2.55*float64(skipped+1)*expectedSplitSec)
						if !hasWindow && float64(dtUs)/1e6 > maxStepSec {
							continue
						}
						transPen = skipPenaltyForLap(dp[j].skippedInLap, skipped)
					}
					newSkippedInLap = 0
				} else {
					// Out-of-order backward/duplicate sector gate without Start/Finish -> forbidden!
					continue
				}

				// Smooth split pacing regularization
				stepsAdv := skipped + 1
				dtSec := float64(dtUs) / 1e6
				expDtSec := float64(stepsAdv) * expectedSplitSec
				ratio := dtSec / math.Max(0.40, expDtSec)
				if ratio < 0.28 {
					transPen += 1.45 * (0.28 - ratio) / 0.28
				} else if ratio > 3.6 {
					transPen += 0.35 * math.Min(4.0, ratio-3.6)
				}
				if dtUs < 480_000 && a != b {
					transPen += 0.85 * float64(480_000-dtUs) / 200_000.0
				}

				candScore := dp[j].score - transPen + emitScore[i]
				if !dp[i].valid || candScore > dp[i].score {
					st := dp[j]
					st.valid = true
					st.score = candScore
					st.prevIdx = j
					st.stintLen = dp[j].stintLen + 1
					st.skippedInLap = newSkippedInLap
					st.lastGateUs[b] = tsI
					if b == 0 {
						st.lapsInStint = dp[j].lapsInStint + 1
						st.lapStartUs = tsI
					}
					dp[i] = st
				}
			}
		}

		// Fallback for partial window with zero Start/Finish candidates (e.g. zoomed into mid-lap sectors only)
		anyValid := false
		for i := 0; i < N; i++ {
			if dp[i].valid {
				anyValid = true
				break
			}
		}
		if !anyValid && hasWindow {
			for i := 0; i < N; i++ {
				if violatesOutsideLockout(i) || emitScore[i] < 0.10 {
					continue
				}
				b := gateOrd[i]
				tsI := pCands[i].AnchorTsUs
				var st dpPathState
				st.valid = true
				st.score = emitScore[i]
				st.prevIdx = -1
				st.stintLen = 1
				st.lastGateUs[b] = tsI
				dp[i] = st
				for j := i - 1; j >= 0; j-- {
					if !dp[j].valid || gateOrd[j] >= b {
						continue
					}
					dtUs := tsI - pCands[j].AnchorTsUs
					if dtUs < minInterGateUs {
						continue
					}
					skipped := b - gateOrd[j] - 1
					candScore := dp[j].score - float64(skipped)*skipGateCost + emitScore[i]
					if candScore > dp[i].score {
						ns := dp[j]
						ns.score = candScore
						ns.prevIdx = j
						ns.stintLen = dp[j].stintLen + 1
						ns.lastGateUs[b] = tsI
						dp[i] = ns
					}
				}
			}
		}

		// Find globally optimal ending candidate
		bestEnd := -1
		bestTotal := 0.0 // Empty path has score 0.0 so pure-noise windows emit 0 crossings
		for i := 0; i < N; i++ {
			if !dp[i].valid {
				continue
			}
			tot := dp[i].score + stintClosePenalty(dp[i], i)
			if tot > bestTotal {
				bestTotal = tot
				bestEnd = i
			}
		}

		selected := make([]bool, N)
		var selectedByGate map[uint8][]uint64
		if bestEnd >= 0 {
			selectedByGate = make(map[uint8][]uint64, K)
			for cur := bestEnd; cur >= 0; cur = dp[cur].prevIdx {
				selected[cur] = true
				selectedByGate[pCands[cur].GateID] = append(selectedByGate[pCands[cur].GateID], pCands[cur].AnchorTsUs)
			}
		}

		// Emit CandidateDecisions for all candidates of this pilot
		for i, cand := range pCands {
			if selected[i] {
				deltaMs := 0
				if cand.MDipDb >= 1.5 && cand.MDipOffsetMs != 0 {
					deltaMs = cand.MDipOffsetMs
				} else if hasTCNs[i] && tcnProbs[i] >= 0.45 && math.Abs(float64(tcnDts[i])) <= 40.0 {
					deltaMs = int(math.Round(float64(tcnDts[i])))
				}
				finalInt := int64(cand.AnchorTsUs) + int64(deltaMs)*1000
				if finalInt < 0 {
					finalInt = 0
				}
				conf := float32(clamp64(0.55+0.10*emitScore[i], 0.55, 0.99))
				decisionsByID[cand.ID] = CandidateDecision{
					ID:         cand.ID,
					GateID:     cand.GateID,
					SlotIndex:  cand.SlotIndex,
					Label:      "crossing",
					AnchorTsUs: cand.AnchorTsUs,
					DeltaMs:    deltaMs,
					FinalTsUs:  uint64(finalInt),
					PeakDbm:    cand.PeakRSSIDbm,
					Confidence: float32(math.Round(float64(conf)*1000) / 1000),
				}
			} else {
				lbl := "noise"
				conf := float32(0.82)
				if rawCoincMax[i] >= 2.0 {
					lbl = "bleed"
					conf = 0.90
				} else if selectedByGate != nil {
					for _, selTs := range selectedByGate[cand.GateID] {
						var d uint64
						if cand.AnchorTsUs >= selTs {
							d = cand.AnchorTsUs - selTs
						} else {
							d = selTs - cand.AnchorTsUs
						}
						if d <= 900_000 {
							lbl = "multipath"
							conf = 0.88
							break
						}
					}
				}
				decisionsByID[cand.ID] = CandidateDecision{
					ID:         cand.ID,
					GateID:     cand.GateID,
					SlotIndex:  cand.SlotIndex,
					Label:      lbl,
					AnchorTsUs: cand.AnchorTsUs,
					DeltaMs:    0,
					FinalTsUs:  cand.AnchorTsUs,
					PeakDbm:    cand.PeakRSSIDbm,
					Confidence: conf,
				}
			}
		}
	}

	out := make([]CandidateDecision, 0, len(candidates))
	for _, c := range candidates {
		if dec, ok := decisionsByID[c.ID]; ok {
			out = append(out, dec)
		}
	}
	return out
}

func absInt(v int) int {
	if v < 0 {
		return -v
	}
	return v
}
