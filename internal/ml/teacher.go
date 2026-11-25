package ml

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
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
	model, err := gguf.LoadQwen3(l.ModelPath)
	if err != nil {
		return nil, fmt.Errorf("load on-device teacher model: %w", err)
	}
	defer model.Close()

	tok := model.Tokenizer
	idCross, ok1 := tok.TokenID("\u0120crossing")
	idBleed, ok2 := tok.TokenID("\u0120bleed")
	idEcho, ok3 := tok.TokenID("\u0120echo")
	idNoise, ok4 := tok.TokenID("\u0120noise")
	if !ok1 || !ok2 || !ok3 || !ok4 {
		return nil, errors.New("teacher GGUF vocabulary missing required System 1 class tokens")
	}
	classTokIDs := []int{idCross, idBleed, idEcho, idNoise}
	classRawToks := []int{idCross, idBleed, idEcho, idNoise}
	classNames := []string{"crossing", "bleed", "multipath", "noise"}

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

	kvSess := model.NewSession(2048)
	enableFastTriage := model.NLayer > 2
	var sysPos int
	sysPrefilled := false
	ensureSysPrefill := func() error {
		if sysPrefilled {
			return nil
		}
		sysToks := tok.Encode(system1StaticPromptPrefix)
		if err := kvSess.ForwardTokensCtx(ctx, sysToks); err != nil {
			return fmt.Errorf("teacher system prefill: %w", err)
		}
		sysPos = kvSess.Pos()
		sysPrefilled = true
		return nil
	}

	decisionsByID := make(map[string]CandidateDecision, len(candidates))
	doneCount := 0
	totalCount := len(candidates)

	const windowSize = 8
	for _, slot := range slots {
		pCands := bySlot[slot]
		var prevCrossGate string
		var prevCrossSec float64 = -999
		lastSameGateSec := make(map[uint8]float64)

		var pendingBatch []CandidatePeak
		flushPendingBatch := func() error {
			for start := 0; start < len(pendingBatch); start += windowSize {
				if err := ctx.Err(); err != nil {
					return err
				}
				end := start + windowSize
				if end > len(pendingBatch) {
					end = len(pendingBatch)
				}
				batch := pendingBatch[start:end]

				if err := ensureSysPrefill(); err != nil {
					return err
				}
				// Append `batch[0].ID + ":"` directly to user prompt so `batch[0]` needs 0 extra forward sweeps!
				userDelta := buildSystem1UserPromptDelta(trackSeq, minLapSec, prevCrossGate, prevCrossSec, batch) + batch[0].ID + ":"
				kvSess.SetPos(sysPos)
				if err := kvSess.ForwardTokensCtx(ctx, tok.Encode(userDelta)); err != nil {
					return fmt.Errorf("teacher prefill: %w", err)
				}

				for bi, cand := range batch {
					if err := ctx.Err(); err != nil {
						return err
					}
					probs, bestIdx := kvSess.ScoreSingleTokens(classTokIDs)
					chosenLabel := classNames[bestIdx]
					conf := probs[bestIdx]
					chosenTok := classRawToks[bestIdx]

					// Fuse `[chosenTok] + "\n" + nextCand.ID + ":"` into a SINGLE forward sweep (and 0 sweeps on last item)!
					if bi+1 < len(batch) {
						nextTokens := append([]int{chosenTok}, tok.Encode("\n"+batch[bi+1].ID+":")...)
						if err := kvSess.ForwardTokensCtx(ctx, nextTokens); err != nil {
							return err
						}
					}

					deltaMs := 0
					if chosenLabel == "crossing" && cand.MDipDb >= 1.5 && cand.MDipOffsetMs != 0 {
						deltaMs = cand.MDipOffsetMs
					}

					tSec := float64(cand.AnchorTsUs) / 1e6
					if chosenLabel == "crossing" {
						prevCrossGate = cand.GateName
						prevCrossSec = tSec
						lastSameGateSec[cand.GateID] = tSec
					}

					finalInt := int64(cand.AnchorTsUs) + int64(deltaMs)*1000
					if finalInt < 0 {
						finalInt = 0
					}
					decisionsByID[cand.ID] = CandidateDecision{
						ID:         cand.ID,
						GateID:     cand.GateID,
						SlotIndex:  cand.SlotIndex,
						Label:      chosenLabel,
						AnchorTsUs: cand.AnchorTsUs,
						DeltaMs:    deltaMs,
						FinalTsUs:  uint64(finalInt),
						PeakDbm:    cand.PeakRSSIDbm,
						Confidence: float32(math.Round(float64(conf)*1000) / 1000),
					}
					doneCount++
					if onProgress != nil {
						onProgress(doneCount, totalCount)
					}
				}
			}
			pendingBatch = pendingBatch[:0]
			return nil
		}

		for idx, cand := range pCands {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			if enableFastTriage {
				if fastLbl, fastConf, ok := triageUnambiguousCandidate(cand, idx, pCands, minLapSec, lastSameGateSec); ok {
					if len(pendingBatch) > 0 {
						if err := flushPendingBatch(); err != nil {
							return nil, err
						}
					}
					deltaMs := 0
					if fastLbl == "crossing" && cand.MDipDb >= 1.5 && cand.MDipOffsetMs != 0 {
						deltaMs = cand.MDipOffsetMs
					}
					tSec := float64(cand.AnchorTsUs) / 1e6
					if fastLbl == "crossing" {
						prevCrossGate = cand.GateName
						prevCrossSec = tSec
						lastSameGateSec[cand.GateID] = tSec
					}
					finalInt := int64(cand.AnchorTsUs) + int64(deltaMs)*1000
					if finalInt < 0 {
						finalInt = 0
					}
					decisionsByID[cand.ID] = CandidateDecision{
						ID:         cand.ID,
						GateID:     cand.GateID,
						SlotIndex:  cand.SlotIndex,
						Label:      fastLbl,
						AnchorTsUs: cand.AnchorTsUs,
						DeltaMs:    deltaMs,
						FinalTsUs:  uint64(finalInt),
						PeakDbm:    cand.PeakRSSIDbm,
						Confidence: fastConf,
					}
					doneCount++
					if onProgress != nil {
						onProgress(doneCount, totalCount)
					}
					continue
				}
			}
			pendingBatch = append(pendingBatch, cand)
			if len(pendingBatch) >= windowSize {
				if err := flushPendingBatch(); err != nil {
					return nil, err
				}
			}
		}
		if len(pendingBatch) > 0 {
			if err := flushPendingBatch(); err != nil {
				return nil, err
			}
		}
	}

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

	// 1. Unmistakable cross-gate bleed: another gate simultaneously peaked >= +10.0 dB stronger!
	if maxCoincDiff >= 10.0 {
		return "bleed", 0.96, true
	}

	// 2. Unmistakable tiny RF noise blip: < 11.5 dB prominence and narrow width
	if cand.ProminenceDb < 11.5 && cand.WidthHalfPromMs < 110 {
		return "noise", 0.94, true
	}

	// Check for a stronger peak on the same gate within +-480 ms (potential multipath echo)
	for j := idx - 1; j >= 0; j-- {
		dtUs := cand.AnchorTsUs - pCands[j].AnchorTsUs
		if dtUs > 480_000 {
			break
		}
		if pCands[j].GateID == cand.GateID && pCands[j].ProminenceDb >= cand.ProminenceDb+5.5 {
			return "multipath", 0.92, true
		}
	}
	for j := idx + 1; j < len(pCands); j++ {
		dtUs := pCands[j].AnchorTsUs - cand.AnchorTsUs
		if dtUs > 480_000 {
			break
		}
		if pCands[j].GateID == cand.GateID && pCands[j].ProminenceDb >= cand.ProminenceDb+5.5 {
			return "multipath", 0.92, true
		}
	}

	// 3. Unmistakable clean gate crossing: >= 22 dB prominence, realistic pass width, clearly dominant
	// over any coincident gate (>= 8 dB stronger), and respects minimum same-gate lockout!
	tSec := float64(cand.AnchorTsUs) / 1e6
	prevSame, hasPrevSame := lastSameGateSec[cand.GateID]
	lockoutOK := !hasPrevSame || (tSec-prevSame) >= math.Max(1.2, minLapSec*0.75)
	if cand.ProminenceDb >= 22.0 &&
		cand.WidthHalfPromMs >= 80 &&
		cand.WidthHalfPromMs <= 980 &&
		maxCoincDiff <= -8.0 &&
		lockoutOK {
		return "crossing", 0.97, true
	}

	return "", 0, false
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
		id := strings.TrimSpace(activePackID)
		if id == "" {
			id = DefaultTeacherPackID
		}
		packs := make([]domain.MLTeacherPackInfo, 0, len(builtinTeacherCatalog))
		for _, sp := range builtinTeacherCatalog {
			packs = append(packs, domain.MLTeacherPackInfo{
				PackID:      sp.PackID,
				Name:        sp.Name,
				Description: sp.Description,
				SizeBytes:   sp.SizeBytes,
				Recommended: sp.Recommended,
				Installed:   false,
			})
		}
		return domain.MLTeacherStatus{
			ActivePackID: id,
			Ready:        false,
			Packs:        packs,
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
