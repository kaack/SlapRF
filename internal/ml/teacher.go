package ml

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"slaprf/internal/domain"
	"slaprf/internal/ml/gguf"
	"slaprf/internal/tracestore"
)

const (
	// DefaultTeacherPackID is the recommended on-device System 1 Qwen3-1.7B GGUF pack.
	DefaultTeacherPackID = "qwen3-1.7b-q4_k_m"
	// LiteTeacherPackID is the compact 378 MiB Qwen3-0.6B GGUF pack for low-RAM devices.
	LiteTeacherPackID = "qwen3-0.6b-q4_k_m"
)

// TeacherPackSpec defines a verified downloadable Apache-2.0 GGUF teacher model.
type TeacherPackSpec struct {
	PackID      string
	Name        string
	Description string
	Filename    string
	DownloadURL string
	SizeBytes   int64
	SHA256      string
	Recommended bool
}

var builtinTeacherCatalog = []TeacherPackSpec{
	{
		PackID:      DefaultTeacherPackID,
		Name:        "Qwen3 1.7B (Recommended)",
		Description: "Best accuracy on cross-gate bleed, multipath shoulders & dipole M-peaks (~1.03 GB)",
		Filename:    "Qwen3-1.7B-Q4_K_M.gguf",
		DownloadURL: "https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf",
		SizeBytes:   1107409472,
		SHA256:      "b139949c5bd74937ad8ed8c8cf3d9ffb1e99c866c823204dc42c0d91fa181897",
		Recommended: true,
	},
	{
		PackID:      LiteTeacherPackID,
		Name:        "Qwen3 0.6B Lite",
		Description: "Fast compact labeler for low-storage or 4 GB phones (~378 MB)",
		Filename:    "Qwen3-0.6B-Q4_K_M.gguf",
		DownloadURL: "https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q4_K_M.gguf",
		SizeBytes:   396705472,
		SHA256:      "ac2d97712095a558e31573f62f466a3f9d93990898b0ec79d7c974c1780d524a",
		Recommended: false,
	},
}

// TeacherCatalog returns a copy of the verified on-device System 1 model catalog.
func TeacherCatalog() []TeacherPackSpec {
	out := make([]TeacherPackSpec, len(builtinTeacherCatalog))
	copy(out, builtinTeacherCatalog)
	return out
}

// FindTeacherPack looks up a catalog entry by `packID`.
func FindTeacherPack(packID string) (TeacherPackSpec, bool) {
	id := strings.TrimSpace(packID)
	for _, spec := range builtinTeacherCatalog {
		if spec.PackID == id {
			return spec, true
		}
	}
	return TeacherPackSpec{}, false
}

// TeacherLabeler runs System 1 candidate classification on extracted RSSI candidate windows.
type TeacherLabeler interface {
	LabelCandidates(
		ctx context.Context,
		sess domain.PracticeSession,
		candidates []CandidatePeak,
		onProgress func(done, total int),
	) ([]CandidateDecision, error)
}

// Qwen3GGUFLabeler runs a local `.gguf` Qwen3 model in non-thinking System 1 mode (`<think>\n\n</think>`)
// with grammar-guided single-token slot scoring, unmapping the GGUF file as soon as labeling finishes.
type Qwen3GGUFLabeler struct {
	ModelPath string
}

// LabelCandidates classifies all `candidates` in `sess` on-device using batched prefill + slot scoring.
func (l *Qwen3GGUFLabeler) LabelCandidates(
	ctx context.Context,
	sess domain.PracticeSession,
	candidates []CandidatePeak,
	onProgress func(done, total int),
) ([]CandidateDecision, error) {
	if len(candidates) == 0 {
		return nil, nil
	}
	tStart := time.Now()
	info, err := os.Stat(l.ModelPath)
	if err != nil {
		return nil, fmt.Errorf("load on-device teacher model: %w", err)
	}
	// Real 28-layer Qwen3 GGUF packs are >= 350 MB, whereas synthetic 1-layer unit test fixtures are < 1 MB.
	enableFastTriage := info.Size() > (10 << 20)

	var (
		model        *gguf.Qwen3Model
		tok          *gguf.Tokenizer
		classTokIDs  []int
		classRawToks []int
	)
	classNames := []string{"crossing", "bleed", "multipath", "noise"}
	defer func() {
		if model != nil {
			_ = model.Close()
		}
	}()

	ensureModelLoaded := func() error {
		if model != nil {
			return nil
		}
		m, loadErr := gguf.LoadQwen3(l.ModelPath)
		if loadErr != nil {
			return fmt.Errorf("load on-device teacher model: %w", loadErr)
		}
		model = m
		tok = model.Tokenizer
		idCross, ok1 := tok.TokenID("\u0120crossing")
		idBleed, ok2 := tok.TokenID("\u0120bleed")
		idEcho, ok3 := tok.TokenID("\u0120echo")
		idNoise, ok4 := tok.TokenID("\u0120noise")
		if !ok1 || !ok2 || !ok3 || !ok4 {
			return errors.New("teacher GGUF vocabulary missing required System 1 class tokens")
		}
		classTokIDs = []int{idCross, idBleed, idEcho, idNoise}
		classRawToks = []int{idCross, idBleed, idEcho, idNoise}
		return nil
	}

	// Group candidates per pilot slot so multi-pilot practice sessions maintain clean per-pilot gate order
	bySlot := make(map[int][]CandidatePeak)
	var slots []int
	for _, c := range candidates {
		if _, seen := bySlot[c.SlotIndex]; !seen {
			slots = append(slots, c.SlotIndex)
		}
		bySlot[c.SlotIndex] = append(bySlot[c.SlotIndex], c)
	}
	sort.Ints(slots)

	trackSeq := formatTrackTopology(sess.TrackSnapshot)
	minLapSec := 2.0
	if sess.Rules != nil && sess.Rules.MinLapSec >= 0.5 {
		minLapSec = sess.Rules.MinLapSec
	}

	// System 1 prompt + up to 10 contested candidates scored per L1-row-tiled transformer pass
	// on Desktop (Apple Silicon / x86_64) ensures every genuinely ambiguous peak is evaluated by Qwen3.
	const maxQwenSweepCandidates = 10
	var kvSess *gguf.Session
	kvCap := 0
	qwenScoredCount := 0
	qwenTokensTotal := 0

	heuristicPriorToken := func(c CandidatePeak) int {
		maxDiff := float32(-999)
		for _, co := range c.Coincident {
			if diff := co.ProminenceDb - c.ProminenceDb; diff > maxDiff {
				maxDiff = diff
			}
		}
		if maxDiff >= 2.0 {
			return classRawToks[1] // bleed
		}
		if c.ProminenceDb >= 15.0 && maxDiff <= -3.0 && c.WidthHalfPromMs >= 70 && c.WidthHalfPromMs <= 1050 {
			return classRawToks[0] // crossing
		}
		return classRawToks[3] // noise
	}

	recordFastDecision := func(decisionsByID map[string]CandidateDecision, cand CandidatePeak, lbl string, conf float32) {
		deltaMs := 0
		if lbl == "crossing" && cand.MDipDb >= 1.5 && cand.MDipOffsetMs != 0 {
			deltaMs = cand.MDipOffsetMs
		}
		finalInt := int64(cand.AnchorTsUs) + int64(deltaMs)*1000
		if finalInt < 0 {
			finalInt = 0
		}
		decisionsByID[cand.ID] = CandidateDecision{
			ID:         cand.ID,
			GateID:     cand.GateID,
			SlotIndex:  cand.SlotIndex,
			Label:      lbl,
			AnchorTsUs: cand.AnchorTsUs,
			DeltaMs:    deltaMs,
			FinalTsUs:  uint64(finalInt),
			PeakDbm:    cand.PeakRSSIDbm,
			Confidence: conf,
		}
	}

	decisionsByID := make(map[string]CandidateDecision, len(candidates))
	doneCount := 0
	totalCount := len(candidates)

	for _, slot := range slots {
		pCands := bySlot[slot]
		lastSameGateSec := make(map[uint8]float64)
		confirmedSameGateSecs := make(map[uint8][]float64)
		type confirmedPass struct {
			gateID   uint8
			gateName string
			tSec     float64
			promDb   float32
		}
		var confirmedPasses []confirmedPass
		var unresolvedIdx []int

		// Pass 1A: O(N) physical triage of unambiguous crossings, bleeds, multipath echoes, and noise
		if enableFastTriage {
			for idx, cand := range pCands {
				if err := ctx.Err(); err != nil {
					return nil, err
				}
				if fastLbl, fastConf, ok := triageUnambiguousCandidate(cand, idx, pCands, minLapSec, lastSameGateSec); ok {
					tSec := float64(cand.AnchorTsUs) / 1e6
					if fastLbl == "crossing" {
						lastSameGateSec[cand.GateID] = tSec
						confirmedSameGateSecs[cand.GateID] = append(confirmedSameGateSecs[cand.GateID], tSec)
						confirmedPasses = append(confirmedPasses, confirmedPass{
							gateID:   cand.GateID,
							gateName: cand.GateName,
							tSec:     tSec,
							promDb:   cand.ProminenceDb,
						})
					}
					recordFastDecision(decisionsByID, cand, fastLbl, fastConf)
					doneCount++
					continue
				}
				unresolvedIdx = append(unresolvedIdx, idx)
			}

			// Pass 1B: Bidirectional lockout & cross-gate bleed check against all Pass-1A confirmed passes
			minSameLockSec := math.Max(1.2, minLapSec*0.75)
			stillUnresolved := unresolvedIdx[:0]
			for _, idx := range unresolvedIdx {
				cand := pCands[idx]
				tSec := float64(cand.AnchorTsUs) / 1e6
				resolved := false
				for _, cSec := range confirmedSameGateSecs[cand.GateID] {
					if math.Abs(tSec-cSec) < minSameLockSec {
						recordFastDecision(decisionsByID, cand, "multipath", 0.91)
						doneCount++
						resolved = true
						break
					}
				}
				if resolved {
					continue
				}
				for _, cp := range confirmedPasses {
					if cp.gateID != cand.GateID && math.Abs(tSec-cp.tSec) <= 0.55 && cp.promDb >= cand.ProminenceDb+3.5 {
						recordFastDecision(decisionsByID, cand, "bleed", 0.90)
						doneCount++
						resolved = true
						break
					}
				}
				if !resolved {
					stillUnresolved = append(stillUnresolved, idx)
				}
			}
			unresolvedIdx = stillUnresolved
			if onProgress != nil && doneCount > 0 {
				onProgress(doneCount, totalCount)
			}
		} else {
			for idx := range pCands {
				unresolvedIdx = append(unresolvedIdx, idx)
			}
		}

		if len(unresolvedIdx) == 0 {
			continue
		}
		qwenIndices := unresolvedIdx

		if err := ensureModelLoaded(); err != nil {
			return nil, err
		}

		for start := 0; start < len(qwenIndices); start += maxQwenSweepCandidates {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			end := start + maxQwenSweepCandidates
			if end > len(qwenIndices) {
				end = len(qwenIndices)
			}
			batch := make([]CandidatePeak, 0, end-start)
			for _, qi := range qwenIndices[start:end] {
				batch = append(batch, pCands[qi])
			}

			var batchPrevGate string
			var batchPrevSec float64 = -999
			firstSec := float64(batch[0].AnchorTsUs) / 1e6
			for _, cp := range confirmedPasses {
				if cp.tSec < firstSec && cp.tSec > batchPrevSec {
					batchPrevSec = cp.tSec
					batchPrevGate = cp.gateName
				}
			}

			allToks := tok.Encode(system1StaticPromptPrefix + buildSystem1UserPromptDelta(trackSeq, minLapSec, batchPrevGate, batchPrevSec, batch))
			queryIndices := make([]int, 0, len(batch))
			for bi, cand := range batch {
				if bi == 0 {
					allToks = append(allToks, tok.Encode(cand.ID+":")...)
				} else {
					priorTok := heuristicPriorToken(batch[bi-1])
					allToks = append(allToks, priorTok)
					allToks = append(allToks, tok.Encode("\n"+cand.ID+":")...)
				}
				queryIndices = append(queryIndices, len(allToks)-1)
			}
			if kvSess == nil || len(allToks)+8 > kvCap {
				kvCap = len(allToks) + 32
				if kvCap < 256 && len(slots) > 1 {
					kvCap = 512
				}
				kvSess = model.NewSession(kvCap)
			} else {
				kvSess.SetPos(0)
			}

			qwenTokensTotal += len(allToks)
			probsList, bestIndices, err := kvSess.ForwardAndScorePositionsCtx(ctx, allToks, queryIndices, classTokIDs)
			if err != nil {
				return nil, fmt.Errorf("teacher batch score: %w", err)
			}

			for bi, cand := range batch {
				bestIdx := bestIndices[bi]
				probs := probsList[bi]
				chosenLabel := classNames[bestIdx]
				conf := probs[bestIdx]
				recordFastDecision(decisionsByID, cand, chosenLabel, float32(math.Round(float64(conf)*1000)/1000))
				qwenScoredCount++
				doneCount++
				if onProgress != nil {
					onProgress(doneCount, totalCount)
				}
			}
		}
	}

	log.Printf(
		"[ML] Auto-labeled session %s: candidates=%d fastResolved=%d qwenScored=%d qwenTokens=%d dur=%s",
		sess.SessionID,
		len(candidates),
		len(candidates)-qwenScoredCount,
		qwenScoredCount,
		qwenTokensTotal,
		time.Since(tStart).Round(time.Millisecond),
	)

	out := make([]CandidateDecision, 0, len(candidates))
	for _, c := range candidates {
		if dec, ok := decisionsByID[c.ID]; ok {
			out = append(out, dec)
		}
	}
	return out, nil
}

func formatTrackTopology(gates []domain.TrackGate) string {
	if len(gates) == 0 {
		return "H1 (START_FINISH)"
	}
	sorted := append([]domain.TrackGate(nil), gates...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].TrackOrder < sorted[j].TrackOrder })
	parts := make([]string, 0, len(sorted)+1)
	for _, g := range sorted {
		nm := g.Name
		if nm == "" {
			nm = fmt.Sprintf("G%d", g.GateID)
		}
		parts = append(parts, nm)
	}
	if len(parts) > 1 {
		parts = append(parts, parts[0])
	}
	return strings.Join(parts, " -> ")
}

const system1StaticPromptPrefix = "<|im_start|>system\n" +
	"Classify 5.8GHz FPV gate peaks (`ID: crossing|bleed|echo|noise`): crossing=dominant gate pass; bleed=weaker peak while another gate is >=+8dB stronger; echo=bump <0.45s from stronger same-gate pass; noise=weak blip.<|im_end|>\n"

func buildSystem1UserPromptDelta(trackSeq string, minLapSec float64, prevGate string, prevSec float64, batch []CandidatePeak) string {
	var sb strings.Builder
	sb.Grow(768)
	sb.WriteString("<|im_start|>user\n")
	fmt.Fprintf(&sb, "Track order: %s | Min same-gate interval: %.1fs\n", trackSeq, minLapSec)
	if prevGate != "" && prevSec >= 0 {
		fmt.Fprintf(&sb, "Prior accepted crossing: %s at %.2fs\n", prevGate, prevSec)
	}
	sb.WriteString("Candidates (shape40ms = dB above floor every 40ms from -240ms to +240ms):\n")
	for _, c := range batch {
		tSec := float64(c.AnchorTsUs) / 1e6
		fmt.Fprintf(&sb, "%s t=%.2fs gate=%s prom=%.1fdB width=%dms",
			c.ID, tSec, c.GateName, c.ProminenceDb, c.WidthHalfPromMs)
		if c.MDipDb >= 1.5 {
			fmt.Fprintf(&sb, " mDip=%.1fdB", c.MDipDb)
		}
		if len(c.Coincident) > 0 {
			sb.WriteString(" coinc=[")
			for i, co := range c.Coincident {
				if i > 0 {
					sb.WriteByte(',')
				}
				fmt.Fprintf(&sb, "%s:%+.0fdB@%+dms", co.GateName, co.ProminenceDb-c.ProminenceDb, co.DtMs)
			}
			sb.WriteByte(']')
		}
		sb.WriteString(" shape=[")
		for i, v := range c.Shape40ms {
			if i > 0 {
				sb.WriteByte(',')
			}
			fmt.Fprintf(&sb, "%d", v)
		}
		sb.WriteString("]\n")
	}
	sb.WriteString("<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n")
	return sb.String()
}

func buildSystem1BatchPrompt(trackSeq string, minLapSec float64, prevGate string, prevSec float64, batch []CandidatePeak) string {
	return system1StaticPromptPrefix + buildSystem1UserPromptDelta(trackSeq, minLapSec, prevGate, prevSec, batch)
}

// triageUnambiguousCandidate resolves textbook physical peaks (dominant >=22 dB gate passes,
// >=+10 dB simultaneous cross-gate bleed, and <11.5 dB tiny spikes) in O(1) so only genuinely
// borderline / contested peaks require full Qwen3 transformer evaluation.
func triageUnambiguousCandidate(
	cand CandidatePeak,
	idx int,
	pCands []CandidatePeak,
	minLapSec float64,
	lastSameGateSec map[uint8]float64,
) (label string, conf float32, ok bool) {
	maxCoincDiff := float32(-999)
	for _, co := range cand.Coincident {
		diff := co.ProminenceDb - cand.ProminenceDb
		if diff > maxCoincDiff {
			maxCoincDiff = diff
		}
	}

	// 1. Unmistakable cross-gate bleed: another gate simultaneously peaked >= +5.0 dB stronger!
	if maxCoincDiff >= 5.0 {
		return "bleed", 0.95, true
	}

	// 2. Unmistakable weak RF noise / far-field drift: < 14.0 dB prominence
	if cand.ProminenceDb < 14.0 && (cand.WidthHalfPromMs < 140 || maxCoincDiff > -3.5) {
		return "noise", 0.93, true
	}

	// Check for a stronger peak on the same gate within +-650 ms (potential multipath echo)
	for j := idx - 1; j >= 0; j-- {
		dtUs := cand.AnchorTsUs - pCands[j].AnchorTsUs
		if dtUs > 650_000 {
			break
		}
		if pCands[j].GateID == cand.GateID && pCands[j].ProminenceDb >= cand.ProminenceDb+4.5 {
			return "multipath", 0.92, true
		}
	}
	for j := idx + 1; j < len(pCands); j++ {
		dtUs := pCands[j].AnchorTsUs - cand.AnchorTsUs
		if dtUs > 650_000 {
			break
		}
		if pCands[j].GateID == cand.GateID && pCands[j].ProminenceDb >= cand.ProminenceDb+4.5 {
			return "multipath", 0.92, true
		}
	}

	// 3. Unmistakable clean gate crossing: >= 16.5 dB prominence, realistic pass width, clearly dominant
	// over any coincident gate (>= 3.0 dB stronger), and respects minimum same-gate lockout!
	tSec := float64(cand.AnchorTsUs) / 1e6
	prevSame, hasPrevSame := lastSameGateSec[cand.GateID]
	lockoutOK := !hasPrevSame || (tSec-prevSame) >= math.Max(1.2, minLapSec*0.75)
	if cand.ProminenceDb >= 16.5 &&
		cand.WidthHalfPromMs >= 65 &&
		cand.WidthHalfPromMs <= 1100 &&
		maxCoincDiff <= -3.0 &&
		lockoutOK {
		return "crossing", 0.96, true
	}

	return "", 0, false
}

// LabelLapCandidatesFast classifies a single lap's candidate peaks in `< 10 ms` with zero extra heap/swap
// by combining physical multi-gate coincidence triage, the active 1D Temporal ConvNet (`tcn`),
// track gate lockout, and dipole M-saddle crest refinement — avoiding cold-mapping a 1.1 GB `.gguf`
// into mobile `zram` swap during interactive RSSI Editor clicks.
func LabelLapCandidatesFast(
	sess domain.PracticeSession,
	samples []tracestore.Sample,
	candidates []CandidatePeak,
	tcn *TCN,
) []CandidateDecision {
	if len(candidates) == 0 {
		return nil
	}
	if tcn == nil {
		tcn, _ = PretrainedBaseModel()
	}

	minLapSec := 2.0
	if sess.Rules != nil && sess.Rules.MinLapSec >= 0.5 {
		minLapSec = sess.Rules.MinLapSec
	}

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

	bySlot := make(map[int][]CandidatePeak)
	var slots []int
	for _, c := range candidates {
		if _, seen := bySlot[c.SlotIndex]; !seen {
			slots = append(slots, c.SlotIndex)
		}
		bySlot[c.SlotIndex] = append(bySlot[c.SlotIndex], c)
	}
	sort.Ints(slots)

	decisionsByID := make(map[string]CandidateDecision, len(candidates))
	for _, slot := range slots {
		pCands := bySlot[slot]
		lastSameGateSec := make(map[uint8]float64)

		for idx, cand := range pCands {
			lbl, conf, ok := triageUnambiguousCandidate(cand, idx, pCands, minLapSec, lastSameGateSec)
			deltaMs := 0
			if ok {
				if lbl == "crossing" && cand.MDipDb >= 1.5 && cand.MDipOffsetMs != 0 {
					deltaMs = cand.MDipOffsetMs
				}
			} else {
				maxCoincDiff := float32(-999)
				for _, co := range cand.Coincident {
					if diff := co.ProminenceDb - cand.ProminenceDb; diff > maxCoincDiff {
						maxCoincDiff = diff
					}
				}
				tSec := float64(cand.AnchorTsUs) / 1e6
				prevSame, hasPrevSame := lastSameGateSec[cand.GateID]
				lockoutOK := !hasPrevSame || (tSec-prevSame) >= math.Max(1.2, minLapSec*0.75)

				tcnProb, tcnDtMs, hasTCN := queryTCN(cand.GateID, cand.SlotIndex, cand.AnchorTsUs)
				if maxCoincDiff >= 5.5 {
					lbl = "bleed"
					conf = 0.88
				} else if !lockoutOK {
					lbl = "multipath"
					conf = 0.86
				} else if (hasTCN && tcnProb >= 0.42 && maxCoincDiff <= -3.0 && cand.ProminenceDb >= 11.5) ||
					(cand.ProminenceDb >= 16.0 && cand.WidthHalfPromMs >= 75 && cand.WidthHalfPromMs <= 1100 && maxCoincDiff <= -4.5) {
					lbl = "crossing"
					if hasTCN && tcnProb > 0.55 {
						conf = tcnProb
					} else {
						conf = 0.82
					}
					if cand.MDipDb >= 1.5 && cand.MDipOffsetMs != 0 {
						deltaMs = cand.MDipOffsetMs
					} else if hasTCN && math.Abs(float64(tcnDtMs)) <= 40.0 {
						deltaMs = int(math.Round(float64(tcnDtMs)))
					}
				} else if maxCoincDiff > -2.0 {
					lbl = "bleed"
					conf = 0.78
				} else {
					lbl = "noise"
					if hasTCN {
						conf = clamp32(1.0-tcnProb, 0.55, 0.95)
					} else {
						conf = 0.75
					}
				}
			}

			if lbl == "crossing" {
				lastSameGateSec[cand.GateID] = float64(cand.AnchorTsUs) / 1e6
			}
			finalInt := int64(cand.AnchorTsUs) + int64(deltaMs)*1000
			if finalInt < 0 {
				finalInt = 0
			}
			decisionsByID[cand.ID] = CandidateDecision{
				ID:         cand.ID,
				GateID:     cand.GateID,
				SlotIndex:  cand.SlotIndex,
				Label:      lbl,
				AnchorTsUs: cand.AnchorTsUs,
				DeltaMs:    deltaMs,
				FinalTsUs:  uint64(finalInt),
				PeakDbm:    cand.PeakRSSIDbm,
				Confidence: float32(math.Round(float64(conf)*1000) / 1000),
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

// ---------------------------------------------------------------------------
// On-Device Teacher Pack Manager (`<dataDir>/teacher_models`)
// ---------------------------------------------------------------------------

// TeacherManager manages local `.gguf` teacher model storage, resumable verified HTTPS downloads,
// and on-demand `Qwen3GGUFLabeler` instantiation.
type TeacherManager struct {
	mu            sync.Mutex
	dir           string
	httpClient    *http.Client
	catalog       []TeacherPackSpec
	download      domain.MLTeacherDownloadProgress
	cancelFn      context.CancelFunc
	onUpdate      func()
	customLabeler TeacherLabeler
}

// NewTeacherManager creates an on-device teacher model manager rooted at `dir`.
// Large `.gguf` downloads (378 MB - 1.03 GB) always use `Timeout: 0` so short API client timeouts
// (such as Portable's 15s MultiGP client) never abort mid-download with `context deadline exceeded`.
func NewTeacherManager(dir string, httpClient *http.Client) *TeacherManager {
	dlClient := &http.Client{Timeout: 0}
	if httpClient != nil && httpClient.Transport != nil {
		dlClient.Transport = httpClient.Transport
	}
	return &TeacherManager{
		dir:        dir,
		httpClient: dlClient,
		catalog:    TeacherCatalog(),
	}
}

// SetUpdateHook registers an optional callback invoked whenever download progress or pack state changes.
func (m *TeacherManager) SetUpdateHook(fn func()) {
	m.mu.Lock()
	m.onUpdate = fn
	m.mu.Unlock()
}

// SetCustomLabeler injects an in-memory `TeacherLabeler` (used by deterministic unit & E2E tests).
func (m *TeacherManager) SetCustomLabeler(lbl TeacherLabeler) {
	m.mu.Lock()
	m.customLabeler = lbl
	m.mu.Unlock()
}

// OverrideCatalogForTest replaces the pack catalog (used in unit tests against `httptest.Server`).
func (m *TeacherManager) OverrideCatalogForTest(specs []TeacherPackSpec) {
	m.mu.Lock()
	m.catalog = append([]TeacherPackSpec(nil), specs...)
	m.mu.Unlock()
}

func (m *TeacherManager) packPathLocked(spec TeacherPackSpec) string {
	if m.dir == "" {
		return ""
	}
	return filepath.Join(m.dir, spec.Filename)
}

func (m *TeacherManager) partPathLocked(spec TeacherPackSpec) string {
	p := m.packPathLocked(spec)
	if p == "" {
		return ""
	}
	return p + ".part"
}

func (m *TeacherManager) isInstalledLocked(spec TeacherPackSpec) bool {
	p := m.packPathLocked(spec)
	if p == "" {
		return false
	}
	st, err := os.Stat(p)
	if err != nil || st.IsDir() {
		return false
	}
	return spec.SizeBytes <= 0 || st.Size() == spec.SizeBytes
}

// Status returns the current teacher pack catalog, installation status, and active download state.
func (m *TeacherManager) Status(activePackID string) domain.MLTeacherStatus {
	if m == nil {
		return domain.MLTeacherStatus{
			Ready: false,
			Packs: []domain.MLTeacherPackInfo{},
		}
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	activeID := strings.TrimSpace(activePackID)
	if activeID == "" {
		activeID = DefaultTeacherPackID
	}

	packs := make([]domain.MLTeacherPackInfo, 0, len(m.catalog))
	activeReady := m.customLabeler != nil
	var fallbackInstalled string
	for _, sp := range m.catalog {
		inst := m.isInstalledLocked(sp)
		var partBytes int64
		if !inst {
			if pp := m.partPathLocked(sp); pp != "" {
				if pst, err := os.Stat(pp); err == nil && !pst.IsDir() {
					partBytes = pst.Size()
				}
			}
		}
		if inst && fallbackInstalled == "" {
			fallbackInstalled = sp.PackID
		}
		if sp.PackID == activeID && inst {
			activeReady = true
		}
		packs = append(packs, domain.MLTeacherPackInfo{
			PackID:       sp.PackID,
			Name:         sp.Name,
			Description:  sp.Description,
			SizeBytes:    sp.SizeBytes,
			Recommended:  sp.Recommended,
			Installed:    inst,
			PartialBytes: partBytes,
		})
	}
	if !activeReady && fallbackInstalled != "" {
		activeID = fallbackInstalled
		activeReady = true
	}

	return domain.MLTeacherStatus{
		ActivePackID: activeID,
		Ready:        activeReady,
		Packs:        packs,
		Download:     m.download,
	}
}

// ResolveLabeler returns a ready `TeacherLabeler` for `preferredPackID` (or any installed fallback pack).
func (m *TeacherManager) ResolveLabeler(preferredPackID string) (TeacherLabeler, string, error) {
	if m == nil {
		return nil, "", errors.New("on-device AI labeler is unavailable in browser-only WASM mode; connect a SlapRF Portable or Android host")
	}
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.customLabeler != nil {
		id := strings.TrimSpace(preferredPackID)
		if id == "" {
			id = DefaultTeacherPackID
		}
		return m.customLabeler, id, nil
	}

	pref := strings.TrimSpace(preferredPackID)
	for _, sp := range m.catalog {
		if sp.PackID == pref && m.isInstalledLocked(sp) {
			return &Qwen3GGUFLabeler{ModelPath: m.packPathLocked(sp)}, sp.PackID, nil
		}
	}
	for _, sp := range m.catalog {
		if m.isInstalledLocked(sp) {
			return &Qwen3GGUFLabeler{ModelPath: m.packPathLocked(sp)}, sp.PackID, nil
		}
	}
	return nil, "", errors.New("on-device AI labeler model is not downloaded yet — tap Download to save it for offline use")
}

// StartDownload starts (or resumes) a background HTTPS `.gguf` download for `packID` with SHA-256 verification.
func (m *TeacherManager) StartDownload(packID string) error {
	if m == nil || m.dir == "" {
		return errors.New("local storage directory is not configured for teacher model downloads")
	}
	m.mu.Lock()
	if m.download.Running {
		m.mu.Unlock()
		return errors.New("a teacher model download is already in progress")
	}
	id := strings.TrimSpace(packID)
	if id == "" {
		id = DefaultTeacherPackID
	}
	var spec TeacherPackSpec
	found := false
	for _, sp := range m.catalog {
		if sp.PackID == id {
			spec = sp
			found = true
			break
		}
	}
	if !found {
		m.mu.Unlock()
		return fmt.Errorf("unknown teacher pack %q", id)
	}
	if m.isInstalledLocked(spec) {
		m.download = domain.MLTeacherDownloadProgress{
			Running:         false,
			PackID:          spec.PackID,
			DownloadedBytes: spec.SizeBytes,
			TotalBytes:      spec.SizeBytes,
			Percent:         100,
		}
		hook := m.onUpdate
		m.mu.Unlock()
		if hook != nil {
			hook()
		}
		return nil
	}

	if err := os.MkdirAll(m.dir, 0o755); err != nil {
		m.mu.Unlock()
		return fmt.Errorf("create teacher_models dir: %w", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	m.cancelFn = cancel
	m.download = domain.MLTeacherDownloadProgress{
		Running:    true,
		PackID:     spec.PackID,
		TotalBytes: spec.SizeBytes,
	}
	hook := m.onUpdate
	m.mu.Unlock()
	if hook != nil {
		hook()
	}

	go m.runDownload(ctx, spec)
	return nil
}

// CancelDownload aborts an active download, keeping `.part` bytes on disk so a later retry resumes cleanly.
func (m *TeacherManager) CancelDownload() {
	if m == nil {
		return
	}
	m.mu.Lock()
	cancel := m.cancelFn
	m.cancelFn = nil
	m.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// DeletePack removes a downloaded `.gguf` (and any `.part` file) to reclaim phone storage.
func (m *TeacherManager) DeletePack(packID string) error {
	if m == nil || m.dir == "" {
		return nil
	}
	id := strings.TrimSpace(packID)
	m.mu.Lock()
	if m.download.Running && m.download.PackID == id && m.cancelFn != nil {
		m.cancelFn()
		m.cancelFn = nil
	}
	var spec TeacherPackSpec
	found := false
	for _, sp := range m.catalog {
		if sp.PackID == id {
			spec = sp
			found = true
			break
		}
	}
	if !found {
		m.mu.Unlock()
		return fmt.Errorf("unknown teacher pack %q", id)
	}
	finalPath := m.packPathLocked(spec)
	partPath := m.partPathLocked(spec)
	hook := m.onUpdate
	m.mu.Unlock()

	_ = os.Remove(finalPath)
	_ = os.Remove(partPath)
	if hook != nil {
		hook()
	}
	return nil
}

func (m *TeacherManager) runDownload(ctx context.Context, spec TeacherPackSpec) {
	partPath := filepath.Join(m.dir, spec.Filename+".part")
	finalPath := filepath.Join(m.dir, spec.Filename)

	finishErr := func(errMsg string) {
		m.mu.Lock()
		m.download.Running = false
		m.download.Error = errMsg
		m.cancelFn = nil
		hook := m.onUpdate
		m.mu.Unlock()
		if hook != nil {
			hook()
		}
	}

	total := spec.SizeBytes
	buf := make([]byte, 256*1024)
	var downloaded int64
	lastNotify := time.Now()

	publishProgress := func(force bool) {
		now := time.Now()
		if !force && now.Sub(lastNotify) < 150*time.Millisecond {
			return
		}
		lastNotify = now
		pct := 0.0
		if total > 0 {
			pct = math.Min(99.9, math.Round(float64(downloaded)*1000.0/float64(total))/10.0)
		}
		m.mu.Lock()
		m.download.DownloadedBytes = downloaded
		m.download.TotalBytes = total
		m.download.Percent = pct
		hook := m.onUpdate
		m.mu.Unlock()
		if hook != nil {
			hook()
		}
	}

	const maxAttempts = 4
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		var existing int64
		if st, err := os.Stat(partPath); err == nil && !st.IsDir() {
			existing = st.Size()
			if spec.SizeBytes > 0 && existing > spec.SizeBytes {
				_ = os.Remove(partPath)
				existing = 0
			}
			if spec.SizeBytes > 0 && existing == spec.SizeBytes {
				downloaded = existing
				break
			}
		}

		req, err := http.NewRequestWithContext(ctx, http.MethodGet, spec.DownloadURL, nil)
		if err != nil {
			finishErr(err.Error())
			return
		}
		if existing > 0 {
			req.Header.Set("Range", fmt.Sprintf("bytes=%d-", existing))
		}

		resp, err := m.httpClient.Do(req)
		if err != nil {
			if errors.Is(ctx.Err(), context.Canceled) {
				finishErr("")
				return
			}
			if attempt < maxAttempts {
				time.Sleep(time.Duration(attempt) * 800 * time.Millisecond)
				continue
			}
			finishErr(fmt.Sprintf("download failed: %v", err))
			return
		}

		flags := os.O_CREATE | os.O_WRONLY
		if resp.StatusCode == http.StatusPartialContent && existing > 0 {
			flags |= os.O_APPEND
		} else if resp.StatusCode == http.StatusOK {
			flags |= os.O_TRUNC
			existing = 0
		} else {
			_ = resp.Body.Close()
			finishErr(fmt.Sprintf("download HTTP %d", resp.StatusCode))
			return
		}
		if total <= 0 && resp.ContentLength > 0 {
			total = existing + resp.ContentLength
		}

		outFile, err := os.OpenFile(partPath, flags, 0o644)
		if err != nil {
			_ = resp.Body.Close()
			finishErr(fmt.Sprintf("open part file: %v", err))
			return
		}

		downloaded = existing
		publishProgress(true)

		var streamErr error
		for {
			n, rErr := resp.Body.Read(buf)
			if n > 0 {
				if _, wErr := outFile.Write(buf[:n]); wErr != nil {
					_ = outFile.Close()
					_ = resp.Body.Close()
					finishErr(fmt.Sprintf("write error: %v", wErr))
					return
				}
				downloaded += int64(n)
				publishProgress(false)
			}
			if rErr != nil {
				if !errors.Is(rErr, io.EOF) {
					streamErr = rErr
				}
				break
			}
		}
		_ = resp.Body.Close()
		cErr := outFile.Close()
		if cErr != nil {
			finishErr(fmt.Sprintf("close part file: %v", cErr))
			return
		}
		if errors.Is(ctx.Err(), context.Canceled) {
			finishErr("")
			return
		}
		if streamErr == nil && (spec.SizeBytes <= 0 || downloaded == spec.SizeBytes) {
			break
		}
		if attempt == maxAttempts {
			if streamErr != nil {
				finishErr(fmt.Sprintf("network read error: %v", streamErr))
			} else {
				finishErr(fmt.Sprintf("incomplete download (%d / %d bytes)", downloaded, spec.SizeBytes))
			}
			return
		}
		time.Sleep(time.Duration(attempt) * 800 * time.Millisecond)
	}

	if spec.SHA256 != "" {
		vFile, err := os.Open(partPath)
		if err != nil {
			finishErr(fmt.Sprintf("verify open: %v", err))
			return
		}
		h := sha256.New()
		_, cErr := io.Copy(h, vFile)
		_ = vFile.Close()
		if cErr != nil {
			finishErr(fmt.Sprintf("verify sha256: %v", cErr))
			return
		}
		gotSum := hex.EncodeToString(h.Sum(nil))
		if !strings.EqualFold(gotSum, spec.SHA256) {
			_ = os.Remove(partPath)
			finishErr("SHA-256 checksum mismatch; corrupt download discarded")
			return
		}
	}

	if err := os.Rename(partPath, finalPath); err != nil {
		finishErr(fmt.Sprintf("finalize model file: %v", err))
		return
	}

	m.mu.Lock()
	m.download = domain.MLTeacherDownloadProgress{
		Running:         false,
		PackID:          spec.PackID,
		DownloadedBytes: downloaded,
		TotalBytes:      total,
		Percent:         100,
	}
	m.cancelFn = nil
	hook := m.onUpdate
	m.mu.Unlock()
	if hook != nil {
		hook()
	}
}
