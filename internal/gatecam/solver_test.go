package gatecam_test

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"slaprf/internal/gatecam"
	"slaprf/internal/portable"
)

func TestSolveLookbackSubFrameAndRollingShutterAccuracy(t *testing.T) {
	// Tilted gate line from (0.45, 0.15) to (0.55, 0.85), forward flight Left -> Right (+1)
	gate := gatecam.GateLine{
		P1X:               0.45,
		P1Y:               0.15,
		P2X:               0.55,
		P2Y:               0.85,
		DirSign:           1,
		BandHalfWidthNorm: 0.20,
	}
	const w = 640.0
	const h = 360.0
	p1x, p1y, tx, ty, segLen, nx, ny := gatecam.GateNormalPx(gate, w, h)
	crossX := p1x + 0.65*segLen*tx
	crossY := p1y + 0.65*segLen*ty

	// True optical crossing happens at sensor exposure-midpoint 1_000_000 us; RF reports 1_003_700 us (+3.70 ms bias)
	const trueCamUs = uint64(1_000_000)
	const rfUs = uint64(1_003_700)
	const clockOffsetUs = int64(250_000) // serverUs = sensorUs + 250_000
	const skewNs = int64(10_000_000)     // 10 ms rolling shutter
	const expNs = int64(500_000)         // 0.5 ms shutter
	const fps = 120
	const periodNs = int64(1_000_000_000 / fps)
	const speedPxPerSec = 2600.0

	trueSensorMidNs := (int64(trueCamUs) - clockOffsetUs) * 1000
	startSensorNs := trueSensorMidNs - 200_000_000
	endSensorNs := trueSensorMidNs + 200_000_000

	var obs []gatecam.FrameObservation
	for idx, tNs := 0, startSensorNs; tNs <= endSensorNs; idx, tNs = idx+1, tNs+periodNs {
		rowNorm := crossY / h
		midNs := tNs + int64(math.Round(rowNorm*float64(skewNs))) + expNs/2
		dtSec := float64(midNs-trueSensorMidNs) / 1e9
		dPx := dtSec * speedPxPerSec
		f := gatecam.FrameObservation{
			Index:                idx,
			SensorTimestampNs:    tNs,
			ExposureTimeNs:       expNs,
			RollingShutterSkewNs: skewNs,
			FrameWidth:           int(w),
			FrameHeight:          int(h),
		}
		if math.Abs(dPx) <= 95 {
			f.HasBlob = true
			f.BlobCX = (crossX + dPx*nx) / w
			f.BlobCY = (crossY + dPx*ny) / h
			f.BlobAreaPx = 420
			f.FlowVX = (speedPxPerSec / fps) * nx
			f.FlowVY = (speedPxPerSec / fps) * ny
		}
		obs = append(obs, f)
	}

	rec := &gatecam.PassRecord{
		GateID:            1,
		SlotIndex:         1,
		Callsign:          "VORTEX",
		RFTimestampUs:     rfUs,
		EstimatedSpeedMph: 60.0,
	}
	gatecam.SolveLookback(rec, obs, gate, clockOffsetUs, true)

	if rec.Status != gatecam.PassStatusAuto || rec.GateBiasMs == nil {
		t.Fatalf("expected AUTO solve, got status=%s", rec.Status)
	}
	// Expected bias is +3.70 ms; verify sub-millisecond solver accuracy (< 0.4 ms error)
	if math.Abs(*rec.GateBiasMs-3.70) > 0.40 {
		t.Fatalf("expected GateBiasMs ~ +3.70 ms, got %+.2f ms (camTs=%d want=%d)", *rec.GateBiasMs, rec.CamTimestampUs, trueCamUs)
	}

	// Verify reverse-direction blob is rejected (not falsely matched)
	reverseGate := gate
	reverseGate.DirSign = -1
	revRec := &gatecam.PassRecord{RFTimestampUs: rfUs}
	gatecam.SolveLookback(revRec, obs, reverseGate, clockOffsetUs, true)
	if revRec.Status != gatecam.PassStatusNeedsManual {
		t.Fatalf("expected reverse-direction pass to require manual review, got %s", revRec.Status)
	}
}

func TestServerLiveSlapRFIntegrationPinAndExportZIP(t *testing.T) {
	tmp := t.TempDir()
	slapSrv := portable.NewServer(portable.Config{
		Version: "0.0.16-test",
		DBPath:  filepath.Join(tmp, "slaprf.db"),
		LogPath: filepath.Join(tmp, "slaprf.log"),
	})
	slapHTTP := httptest.NewServer(slapSrv.Handler())
	defer func() {
		slapHTTP.Close()
		slapSrv.Close()
	}()

	simCam := gatecam.NewSimCameraProvider()
	simCam.SetSimulatedOpticalOffsetNs(-4_000_000) // RF is +4.0 ms after optical crossing
	gcSrv := gatecam.NewServer(gatecam.Config{
		Version:     "dev-test",
		DataDir:     filepath.Join(tmp, "gatecam"),
		DefaultLink: slapHTTP.URL,
		Camera:      simCam,
	})
	gcHTTP := httptest.NewServer(gcSrv.Handler())
	defer func() {
		gcHTTP.Close()
		gcSrv.Close()
	}()

	// Wait up to 2 s for GateCam to lock onto SlapRF's clock and open /v1/ws/stream
	deadline := time.Now().Add(2500 * time.Millisecond)
	locked := false
	for time.Now().Before(deadline) {
		resp, err := http.Get(gcHTTP.URL + "/v1/gatecam/state")
		if err == nil {
			var snap struct {
				Sync gatecam.SyncStatus `json:"sync"`
			}
			_ = json.NewDecoder(resp.Body).Decode(&snap)
			_ = resp.Body.Close()
			if snap.Sync.Connected && snap.Sync.ClockLocked {
				locked = true
				break
			}
		}
		time.Sleep(40 * time.Millisecond)
	}
	if !locked {
		t.Fatalf("GateCam did not establish clock lock + WS stream to SlapRF within timeout")
	}

	// Simulate two passes 3 seconds apart (or via dev:simulatePass) and verify bias + lap stats + pin + ZIP export
	for i := 0; i < 2; i++ {
		if i == 1 {
			// Advance simulated pass timestamp check via a real 1.6s wait so RecomputeLapsAndStats pairs them as a lap (>1.5s)
			time.Sleep(1550 * time.Millisecond)
		}
		resp, err := http.Post(gcHTTP.URL+"/v1/gatecam/dev:simulatePass", "application/json", bytes.NewReader([]byte(`{}`)))
		if err != nil || resp.StatusCode != http.StatusOK {
			t.Fatalf("dev:simulatePass #%d failed: err=%v resp=%v", i+1, err, resp)
		}
		_ = resp.Body.Close()
	}

	// Verify stats show 2 valid passes and 1 paired lap
	stResp, err := http.Get(gcHTTP.URL + "/v1/gatecam/passes")
	if err != nil {
		t.Fatalf("GET passes: %v", err)
	}
	var listOut struct {
		Passes []gatecam.PassSummary `json:"passes"`
		Stats  gatecam.SessionStats  `json:"stats"`
	}
	if err := json.NewDecoder(stResp.Body).Decode(&listOut); err != nil {
		t.Fatalf("decode passes: %v", err)
	}
	_ = stResp.Body.Close()
	if listOut.Stats.ValidPasses != 2 || listOut.Stats.LapCount != 1 {
		t.Fatalf("expected 2 valid passes and 1 paired lap, got stats=%+v", listOut.Stats)
	}

	// Test manual frame pin and restoreAuto on pass #1
	pinResp, err := http.Post(gcHTTP.URL+"/v1/gatecam/passes/1:pin", "application/json", bytes.NewReader([]byte(`{"frameIdx":20}`)))
	if err != nil || pinResp.StatusCode != http.StatusOK {
		t.Fatalf("pin pass #1 failed: err=%v resp=%v", err, pinResp)
	}
	_ = pinResp.Body.Close()

	restoreResp, err := http.Post(gcHTTP.URL+"/v1/gatecam/passes/1:restoreAuto", "application/json", bytes.NewReader([]byte(`{}`)))
	if err != nil || restoreResp.StatusCode != http.StatusOK {
		t.Fatalf("restoreAuto pass #1 failed: err=%v resp=%v", err, restoreResp)
	}
	_ = restoreResp.Body.Close()

	// Verify /v1/gatecam/export.zip contains report.json, passes.csv, and crossing JPEGs
	zipResp, err := http.Get(gcHTTP.URL + "/v1/gatecam/export.zip")
	if err != nil || zipResp.StatusCode != http.StatusOK {
		t.Fatalf("GET export.zip failed: err=%v resp=%v", err, zipResp)
	}
	zipBytes, _ := io.ReadAll(zipResp.Body)
	_ = zipResp.Body.Close()

	zr, err := zip.NewReader(bytes.NewReader(zipBytes), int64(len(zipBytes)))
	if err != nil {
		t.Fatalf("open export.zip: %v", err)
	}
	names := make(map[string]bool)
	jpgCount := 0
	for _, f := range zr.File {
		names[f.Name] = true
		if filepath.Ext(f.Name) == ".jpg" {
			jpgCount++
		}
	}
	if !names["gatecam-report.json"] || !names["gatecam-passes.csv"] || jpgCount < 2 {
		t.Fatalf("unexpected ZIP contents: names=%v jpgCount=%d", names, jpgCount)
	}
}
