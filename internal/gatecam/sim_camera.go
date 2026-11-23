package gatecam

import (
	"bytes"
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"
	"math"
	"sync"
	"time"
)

// SimCameraProvider implements `CameraProvider` for desktop development (`cmd/gatecam-dev`)
// and automated Go/E2E verification without an Android device.
type SimCameraProvider struct {
	bootTime time.Time

	mu      sync.Mutex
	cfg     CameraConfig
	biasNs  int64 // Simulated optical crossing offset relative to requested center (e.g. -3.2 ms -> RF is +3.2 ms late)
	seqPass int
}

// NewSimCameraProvider creates a simulated high-speed gate camera anchored to `CLOCK_MONOTONIC`.
func NewSimCameraProvider() *SimCameraProvider {
	return &SimCameraProvider{
		bootTime: time.Now(),
		cfg:      DefaultCameraConfig(),
		biasNs:   -3_200_000, // True drone crosses 3.2 ms before RF timestamp -> +3.2 ms positive RF bias
	}
}

// SetSimulatedOpticalOffsetNs configures the ground-truth optical offset relative to burst midpoint for tests.
func (s *SimCameraProvider) SetSimulatedOpticalOffsetNs(offsetNs int64) {
	s.mu.Lock()
	s.biasNs = offsetNs
	s.mu.Unlock()
}

func (s *SimCameraProvider) CurrentSensorClockNs() int64 {
	return time.Since(s.bootTime).Nanoseconds()
}

func (s *SimCameraProvider) Status() CameraStatus {
	s.mu.Lock()
	cfg := s.cfg
	s.mu.Unlock()
	fps := float64(cfg.TargetFPS)
	if fps <= 0 {
		fps = 120
	}
	return CameraStatus{
		Active:          true,
		Simulated:       true,
		FrameWidth:      640,
		FrameHeight:     360,
		ActualFPS:       fps,
		SupportedFPS:    []int{60, 120},
		ShutterUs:       cfg.ShutterUs,
		FocusLocked:     cfg.FocusLocked,
		RingCapacity:    168,
		RingFilled:      168,
		RingSpanMs:      round1(168000.0 / fps),
		TimestampSource: 0,
		OpenCVVersion:   "4.12.0 (sim)",
	}
}

func (s *SimCameraProvider) Configure(cfg CameraConfig) (CameraStatus, error) {
	s.mu.Lock()
	if cfg.TargetFPS != 60 && cfg.TargetFPS != 120 {
		cfg.TargetFPS = 120
	}
	if cfg.LookbackHalfMs <= 0 {
		cfg.LookbackHalfMs = 450
	}
	if cfg.MotionModel == "" {
		cfg.MotionModel = "mog2"
	}
	if cfg.Sensitivity <= 0 {
		cfg.Sensitivity = 16
	}
	s.cfg = cfg
	s.mu.Unlock()
	return s.Status(), nil
}

func (s *SimCameraProvider) TriggerFocusLock(_, _ float64) error {
	s.mu.Lock()
	s.cfg.FocusLocked = true
	s.mu.Unlock()
	return nil
}

func (s *SimCameraProvider) LatestPreviewJPEG() ([]byte, int64, error) {
	nowNs := s.CurrentSensorClockNs()
	// Gentle animated test marker oscillating slowly or stationary background with gate posts
	jpg := renderSimGateScene(640, 360, DefaultGateLine(), -999, 0.5, false)
	return jpg, nowNs, nil
}

func (s *SimCameraProvider) ExtractAndAnalyzeBurst(req LookbackRequest) ([]FrameObservation, error) {
	s.mu.Lock()
	cfg := s.cfg
	baseBiasNs := s.biasNs
	s.seqPass++
	passN := s.seqPass
	s.mu.Unlock()

	fps := cfg.TargetFPS
	if fps <= 0 {
		fps = 120
	}
	periodNs := int64(1_000_000_000 / fps)
	expNs := int64(cfg.ShutterUs) * 1000
	if expNs <= 0 {
		expNs = 500_000 // 0.5 ms
	}
	skewNs := int64(7_500_000) // Realistic 7.5 ms CMOS rolling-shutter readout skew

	midNs := (req.StartSensorNs + req.EndSensorNs) / 2
	// Deterministic small per-pass jitter (-1.4 ms .. +1.4 ms) around baseBiasNs so histograms look realistic
	jitterNs := int64(((passN*7)%9)-4) * 350_000
	trueCrossMidNs := midNs + baseBiasNs + jitterNs

	const w = 640
	const h = 360
	p1x, p1y, tx, ty, segLen, nx, ny := GateNormalPx(req.Gate, w, h)
	midGateX := p1x + 0.48*segLen*tx
	midGateY := p1y + 0.48*segLen*ty

	speedPxPerSec := 2400.0 // ~20 px/frame @ 120 fps

	var out []FrameObservation
	idx := 0
	for tStartNs := req.StartSensorNs; tStartNs <= req.EndSensorNs; tStartNs += periodNs {
		// Approximate vertical row at midGateY/h to place the drone accurately in rolling-shutter time
		rowApprox := clamp01(midGateY / h)
		frameMidNs := tStartNs + int64(rowApprox*float64(skewNs)) + expNs/2
		dtSec := float64(frameMidNs-trueCrossMidNs) / 1e9
		distPx := dtSec * speedPxPerSec

		cxPx := midGateX + distPx*nx
		cyPx := midGateY + distPx*ny

		visible := cxPx >= 12 && cxPx <= w-12 && cyPx >= 12 && cyPx <= h-12 && math.Abs(distPx) <= 135
		obs := FrameObservation{
			Index:                idx,
			SensorTimestampNs:    tStartNs,
			ExposureTimeNs:       expNs,
			RollingShutterSkewNs: skewNs,
			FrameWidth:           w,
			FrameHeight:          h,
		}
		if visible {
			obs.HasBlob = true
			obs.BlobCX = round4(cxPx / w)
			obs.BlobCY = round4(cyPx / h)
			obs.BlobBoxW = round4(28.0 / w)
			obs.BlobBoxH = round4(16.0 / h)
			obs.BlobBoxX = clamp01(obs.BlobCX - obs.BlobBoxW/2)
			obs.BlobBoxY = clamp01(obs.BlobCY - obs.BlobBoxH/2)
			obs.BlobAreaPx = 448
			stepPx := speedPxPerSec / float64(fps)
			obs.FlowVX = round2(stepPx * nx)
			obs.FlowVY = round2(stepPx * ny)
		}
		obs.JPEG = renderSimGateScene(w, h, req.Gate, cxPx, cyPx, visible)
		obs.MaskJPEG = renderSimMaskScene(w, h, cxPx, cyPx, visible)
		out = append(out, obs)
		idx++
	}
	return out, nil
}

func renderSimGateScene(w, h int, g GateLine, droneX, droneY float64, hasDrone bool) []byte {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	// Sky + turf gradient background
	horizon := int(float64(h) * 0.62)
	draw.Draw(img, image.Rect(0, 0, w, horizon), &image.Uniform{color.RGBA{19, 28, 46, 255}}, image.Point{}, draw.Src)
	draw.Draw(img, image.Rect(0, horizon, w, h), &image.Uniform{color.RGBA{20, 39, 30, 255}}, image.Point{}, draw.Src)

	// Draw physical gate post aligned with GateLine P1-P2 so user sees realistic edge-on gate arch
	gx1 := int(g.P1X * float64(w))
	gy1 := int(g.P1Y * float64(h))
	gx2 := int(g.P2X * float64(w))
	gy2 := int(g.P2Y * float64(h))
	drawThickLine(img, gx1, gy1, gx2, gy2, 3, color.RGBA{225, 232, 240, 255})

	if hasDrone {
		dx := int(math.Round(droneX))
		dy := int(math.Round(droneY))
		// Quad body + glowing VTX/LED core
		fillRect(img, dx-13, dy-4, dx+13, dy+4, color.RGBA{248, 113, 113, 255})
		fillRect(img, dx-8, dy-8, dx+8, dy+8, color.RGBA{251, 191, 36, 255})
		fillRect(img, dx-3, dy-3, dx+3, dy+3, color.RGBA{255, 255, 255, 255})
	}

	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, img, &jpeg.Options{Quality: 78})
	return buf.Bytes()
}

func renderSimMaskScene(w, h int, droneX, droneY float64, hasDrone bool) []byte {
	img := image.NewGray(image.Rect(0, 0, w, h))
	if hasDrone {
		dx := int(math.Round(droneX))
		dy := int(math.Round(droneY))
		for y := dy - 8; y <= dy+8; y++ {
			if y < 0 || y >= h {
				continue
			}
			for x := dx - 14; x <= dx+14; x++ {
				if x >= 0 && x < w {
					img.SetGray(x, y, color.Gray{Y: 255})
				}
			}
		}
	}
	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, img, &jpeg.Options{Quality: 75})
	return buf.Bytes()
}

func fillRect(img *image.RGBA, x0, y0, x1, y1 int, c color.RGBA) {
	r := image.Rect(x0, y0, x1, y1).Intersect(img.Bounds())
	if !r.Empty() {
		draw.Draw(img, r, &image.Uniform{c}, image.Point{}, draw.Src)
	}
}

func drawThickLine(img *image.RGBA, x0, y0, x1, y1, halfW int, c color.RGBA) {
	steps := int(math.Max(math.Abs(float64(x1-x0)), math.Abs(float64(y1-y0))))
	if steps < 1 {
		steps = 1
	}
	for i := 0; i <= steps; i++ {
		t := float64(i) / float64(steps)
		x := int(math.Round(float64(x0) + t*float64(x1-x0)))
		y := int(math.Round(float64(y0) + t*float64(y1-y0)))
		fillRect(img, x-halfW, y-halfW, x+halfW+1, y+halfW+1, c)
	}
}

func clamp01(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}
