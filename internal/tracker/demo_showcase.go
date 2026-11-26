//go:generate go run -tags=demo_gen ../../cmd/gen-demo-assets -out ./demo_assets

package tracker

import (
	"bytes"
	"compress/gzip"
	"embed"
	"encoding/json"
	"io"
	"sync"

	"slaprf/internal/domain"
	"slaprf/internal/tracestore"
)

//go:embed all:demo_assets
var embeddedDemoAssetsFS embed.FS

var (
	demoShowcaseOnce   sync.Once
	demoShowcaseJSON   []byte
	demoShowcaseTraces map[string][]byte
)

func gunzipEmbeddedAsset(relPath string) []byte {
	compressed, err := embeddedDemoAssetsFS.ReadFile(relPath)
	if err != nil || len(compressed) == 0 {
		return nil
	}
	gr, err := gzip.NewReader(bytes.NewReader(compressed))
	if err != nil {
		return nil
	}
	defer gr.Close()
	raw, err := io.ReadAll(gr)
	if err != nil {
		return nil
	}
	return raw
}

func ensureEmbeddedDemoAssetsLoaded() {
	demoShowcaseOnce.Do(func() {
		demoShowcaseJSON = gunzipEmbeddedAsset("demo_assets/showcase_state.json.gz")
		demoShowcaseTraces = make(map[string][]byte, 3)
		for _, sid := range []string{"session-1", "session-2", "session-3"} {
			if raw := gunzipEmbeddedAsset("demo_assets/" + sid + ".rfbin.gz"); len(raw) > 0 {
				demoShowcaseTraces[sid] = raw
			}
		}
	})
}

func showcaseDemoEngineState() PersistedEngineState {
	ensureEmbeddedDemoAssetsLoaded()
	var st PersistedEngineState
	if len(demoShowcaseJSON) > 0 {
		_ = json.Unmarshal(demoShowcaseJSON, &st)
	}
	return st
}

func isShowcaseDemoPracticeSession(sess domain.PracticeSession) bool {
	switch sess.SessionID {
	case "session-1":
		return sess.CreatedAt == "2026-11-15T18:10:00Z"
	case "session-2":
		return sess.CreatedAt == "2026-11-15T17:15:00Z"
	case "session-3":
		return sess.CreatedAt == "2026-11-15T16:20:00Z"
	default:
		return false
	}
}

// hydrateShowcasePracticeTracesLocked copies pre-generated `.rfbin` demo traces directly from
// `embeddedDemoAssetsFS` into `e.traceStore` (with zero runtime waveform generation).
func (e *Engine) hydrateShowcasePracticeTracesLocked(_ uint64) {
	if len(e.practiceState.Sessions) == 0 {
		return
	}
	hasDemo := false
	for i := range e.practiceState.Sessions {
		if isShowcaseDemoPracticeSession(e.practiceState.Sessions[i]) {
			hasDemo = true
			break
		}
	}
	if !hasDemo {
		return
	}
	ensureEmbeddedDemoAssetsLoaded()
	ts := e.ensureTraceStoreLocked()

	for i := range e.practiceState.Sessions {
		sess := &e.practiceState.Sessions[i]
		if !isShowcaseDemoPracticeSession(*sess) {
			continue
		}
		prebaked := demoShowcaseTraces[sess.SessionID]
		if len(prebaked) == 0 {
			continue
		}

		// Fast path: if raw `.rfbin` bytes are not yet present in `ts` (e.g. fresh RestoreDemoData
		// or WASM IndexedDB page reload into MemoryStore), write the pre-baked `.rfbin` bytes directly!
		existingRaw, _ := ts.ReadRawBytes(sess.SessionID)
		if len(existingRaw) == 0 {
			if sum, err := ts.WriteRawBytes(sess.SessionID, prebaked); err == nil {
				sess.TraceSampleCount = sum.SampleCount
				sess.TraceDurationSec = sum.DurationSec
			}
			continue
		}

		// Healing path for legacy workspaces that already ran live frames after `166s` before
		// pre-baked demo traces existed: prepend pre-baked samples ahead of `existing[0].TimestampUs`.
		firstCrossUs := uint64(0)
		for _, c := range sess.Crossings {
			if c.TimestampUs > 0 && (firstCrossUs == 0 || c.TimestampUs < firstCrossUs) {
				firstCrossUs = c.TimestampUs
			}
		}
		existing, _ := ts.ReadSession(sess.SessionID)
		if len(existing) > 0 && firstCrossUs > 0 && existing[0].TimestampUs > firstCrossUs {
			demoSamples, decErr := tracestore.DecodeSamples(prebaked)
			if decErr == nil && len(demoSamples) > 0 {
				cutoffUs := existing[0].TimestampUs
				_ = ts.DeleteSession(sess.SessionID)
				for _, ds := range demoSamples {
					if ds.TimestampUs < cutoffUs {
						ts.Append(sess.SessionID, ds)
					}
				}
				for _, ex := range existing {
					ts.Append(sess.SessionID, ex)
				}
				sum := ts.SealSession(sess.SessionID)
				sess.TraceSampleCount = sum.SampleCount
				sess.TraceDurationSec = sum.DurationSec
			}
		}
	}
}
