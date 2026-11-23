// Package gatecam implements the SlapRF GateCam verification backend:
// loopback/LAN clock synchronization and stream subscription against SlapRF (:18090 / :8090),
// retrospective lookback crossing solving over OpenCV frame observations, session statistics
// (mean bias, jitter, lap-duration error, histogram, speed buckets), and the :18095 HTTP/WS API.
package gatecam

// GateLine defines the user-aligned Gate Plane segment in normalized [0..1] viewfinder coordinates.
type GateLine struct {
	P1X               float64 `json:"p1x"`
	P1Y               float64 `json:"p1y"`
	P2X               float64 `json:"p2x"`
	P2Y               float64 `json:"p2y"`
	DirSign           int     `json:"dirSign"`           // +1 or -1 normal direction for forward flight
	BandHalfWidthNorm float64 `json:"bandHalfWidthNorm"` // Normalized half-width of lookback ROI band (e.g. 0.18)
	Locked            bool    `json:"locked"`
}

// CameraConfig controls Camera2 capture parameters and OpenCV motion model settings.
type CameraConfig struct {
	TargetFPS          int     `json:"targetFps"`          // 60 or 120
	ShutterUs          int     `json:"shutterUs"`          // 0 = Auto, 1000 = 1/1000s, 500 = 1/2000s, 250 = 1/4000s
	FocusLocked        bool    `json:"focusLocked"`        // True when AF + AWB are locked on the gate
	MotionModel        string  `json:"motionModel"`        // "mog2" | "knn" | "onnx"
	Sensitivity        float64 `json:"sensitivity"`        // MOG2 varThreshold (default 16)
	LookbackHalfMs     int     `json:"lookbackHalfMs"`     // 300, 450, or 600 ms
	RollingShutterComp bool    `json:"rollingShutterComp"` // Compensate row readout skew at blob cy
}

// LinkConfig configures how GateCam connects to the SlapRF timing engine.
type LinkConfig struct {
	SlapRFURL   string `json:"slaprfUrl"`   // Default "http://127.0.0.1:18090"
	BasicAuth   string `json:"basicAuth"`   // Optional "user:pass"
	GateFilter  int    `json:"gateFilter"`  // 0 = all gates, >0 = specific GateID
	PilotFilter int    `json:"pilotFilter"` // 0 = all pilots, >0 = specific SlotIndex
	ExposeLAN   bool   `json:"exposeLan"`   // Expose GateCam UI on 0.0.0.0:18095 for laptop tripod inspection
}

// CameraStatus reports live Camera2 + ring-buffer health from the hardware (or dev simulator) shim.
type CameraStatus struct {
	Active          bool    `json:"active"`
	Simulated       bool    `json:"simulated,omitempty"`
	FrameWidth      int     `json:"frameWidth"`
	FrameHeight     int     `json:"frameHeight"`
	ActualFPS       float64 `json:"actualFps"`
	SupportedFPS    []int   `json:"supportedFps"`
	ShutterUs       int     `json:"shutterUs"`
	FocusLocked     bool    `json:"focusLocked"`
	RingCapacity    int     `json:"ringCapacity"`
	RingFilled      int     `json:"ringFilled"`
	RingSpanMs      float64 `json:"ringSpanMs"`
	TimestampSource int     `json:"timestampSource"` // 0 = CLOCK_MONOTONIC, 1 = REALTIME
	OpenCVVersion   string  `json:"opencvVersion"`
	LastError       string  `json:"lastError,omitempty"`
}

// SyncStatus reports the Cristian min-RTT clock lock between the camera sensor clock and SlapRF's serverTimestampUs.
type SyncStatus struct {
	Connected       bool     `json:"connected"`
	SlapRFURL       string   `json:"slaprfUrl"`
	ClockLocked     bool     `json:"clockLocked"`
	ClockOffsetUs   int64    `json:"clockOffsetUs"` // serverTimestampUs - sensorClockUs
	MinRTTUs        int64    `json:"minRttUs"`
	SyncErrorBoundMs float64 `json:"syncErrorBoundMs"`
	LastError       string   `json:"lastError,omitempty"`
	Pilots          []PilotChannelInfo `json:"pilots,omitempty"`
	Gates           []GateInfo         `json:"gates,omitempty"`
	LiveRSSI        []SlotRSSI         `json:"liveRssi,omitempty"`
	LanURLs         []string           `json:"lanUrls,omitempty"`
}

type PilotChannelInfo struct {
	SlotIndex    int    `json:"slotIndex"`
	Callsign     string `json:"callsign"`
	FrequencyMHz uint16 `json:"frequencyMhz"`
	Color        string `json:"color,omitempty"`
}

type GateInfo struct {
	GateID uint8  `json:"gateId"`
	Name   string `json:"name"`
	Role   string `json:"role"`
}

type SlotRSSI struct {
	SlotIndex int     `json:"slotIndex"`
	Callsign  string  `json:"callsign"`
	RSSIDbm   float32 `json:"rssiDbm"`
}

// RSSISample stores one 50 Hz RSSI sample from `/v1/ws/stream` for lookback chart alignment.
type RSSISample struct {
	TimestampUs uint64  `json:"timestampUs"`
	RelMs       float64 `json:"relMs"` // Relative to crossing.timestampUs
	RSSIDbm     float32 `json:"rssiDbm"`
}

// LookbackRequest instructs the CameraProvider to slice buffered frames in `[StartSensorNs, EndSensorNs]`
// and run OpenCV motion segmentation + optical flow inside the Gate Plane corridor.
type LookbackRequest struct {
	StartSensorNs int64    `json:"startSensorNs"`
	EndSensorNs   int64    `json:"endSensorNs"`
	Gate          GateLine `json:"gate"`
	MotionModel   string   `json:"motionModel"`
	Sensitivity   float64  `json:"sensitivity"`
}

// FrameObservation holds OpenCV's per-frame blob & optical-flow measurement plus encoded JPEGs.
type FrameObservation struct {
	Index                int     `json:"index"`
	SensorTimestampNs    int64   `json:"sensorTimestampNs"`
	ExposureTimeNs       int64   `json:"exposureTimeNs"`
	RollingShutterSkewNs int64   `json:"rollingShutterSkewNs"`
	FrameWidth           int     `json:"frameWidth"`
	FrameHeight          int     `json:"frameHeight"`
	HasBlob              bool    `json:"hasBlob"`
	OnTrack              bool    `json:"onTrack"`
	BlobCX               float64 `json:"blobCx"`   // Normalized [0..1]
	BlobCY               float64 `json:"blobCy"`   // Normalized [0..1]
	BlobBoxX             float64 `json:"blobBoxX"` // Normalized [0..1]
	BlobBoxY             float64 `json:"blobBoxY"`
	BlobBoxW             float64 `json:"blobBoxW"`
	BlobBoxH             float64 `json:"blobBoxH"`
	BlobAreaPx           int     `json:"blobAreaPx"`
	FlowVX               float64 `json:"flowVx"` // Pixels/frame
	FlowVY               float64 `json:"flowVy"`
	SignedDistPx         float64 `json:"signedDistPx"` // Computed along Gate normal (<0 before, 0 on line, >0 after)
	FrameTimestampUs     uint64  `json:"frameTimestampUs"`
	RelToRFMs            float64 `json:"relToRfMs"`
	JPEG                 []byte  `json:"-"`
	MaskJPEG             []byte  `json:"-"`
}

// PassStatus classifies how a pass's camera crossing timestamp was determined.
type PassStatus string

const (
	PassStatusAuto        PassStatus = "AUTO"
	PassStatusManual      PassStatus = "MANUAL"
	PassStatusNeedsManual PassStatus = "NEEDS_MANUAL"
	PassStatusExcluded    PassStatus = "EXCLUDED"
)

// PassRecord represents one correlated SlapRF crossing + retrospective camera analysis burst.
type PassRecord struct {
	PassID            int                `json:"passId"`
	CreatedAt         string             `json:"createdAt"`
	EventID           uint64             `json:"eventId"`
	GateID            uint8              `json:"gateId"`
	GateName          string             `json:"gateName"`
	SlotIndex         int                `json:"slotIndex"`
	Callsign          string             `json:"callsign"`
	FrequencyMHz      uint16             `json:"frequencyMhz"`
	PeakRSSIDbm       float32            `json:"peakRssiDbm"`
	HoldMs            float64            `json:"holdMs"`
	EstimatedSpeedMph float64            `json:"estimatedSpeedMph"`
	RFTimestampUs     uint64             `json:"rfTimestampUs"`

	Status            PassStatus         `json:"status"`
	AutoStatus        PassStatus         `json:"autoStatus"`
	Confidence        float64            `json:"confidence"` // 0..1
	MotionModel       string             `json:"motionModel"`
	GateSnapshot      GateLine           `json:"gateSnapshot"`

	AutoCamTimestampUs   uint64          `json:"autoCamTimestampUs,omitempty"`
	AutoCrossingFrameIdx int             `json:"autoCrossingFrameIdx"`
	AutoFractionalFrame  float64         `json:"autoFractionalFrame"`

	ManualFrameIdx       *int            `json:"manualFrameIdx,omitempty"`
	CamTimestampUs       uint64          `json:"camTimestampUs,omitempty"`
	CrossingFrameIdx     int             `json:"crossingFrameIdx"`
	RFNearestFrameIdx    int             `json:"rfNearestFrameIdx"`
	FrameCount           int             `json:"frameCount"`
	FramesPurged         bool            `json:"framesPurged,omitempty"`

	GateBiasMs        *float64           `json:"gateBiasMs,omitempty"`   // (t_RF - t_cam) in ms
	GateBiasFrames    *float64           `json:"gateBiasFrames,omitempty"`
	SpatialBiasCm     *float64           `json:"spatialBiasCm,omitempty"`
	FlowSpeedPxPerFr  float64            `json:"flowSpeedPxPerFr,omitempty"`
	BlobAreaPx        int                `json:"blobAreaPx,omitempty"`

	LapNumber         int                `json:"lapNumber,omitempty"`
	LapRFSec          *float64           `json:"lapRfSec,omitempty"`
	LapCamSec         *float64           `json:"lapCamSec,omitempty"`
	LapDeltaMs        *float64           `json:"lapDeltaMs,omitempty"` // (LapRF - LapCam) in ms

	RSSITrace         []RSSISample       `json:"rssiTrace,omitempty"`
	Frames            []FrameObservation `json:"frames,omitempty"`
	ThumbJPEG         []byte             `json:"-"`
}

// PassSummary is the lightweight item sent in list views (without the full `Frames` array).
type PassSummary struct {
	PassID            int        `json:"passId"`
	CreatedAt         string     `json:"createdAt"`
	GateID            uint8      `json:"gateId"`
	GateName          string     `json:"gateName"`
	SlotIndex         int        `json:"slotIndex"`
	Callsign          string     `json:"callsign"`
	FrequencyMHz      uint16     `json:"frequencyMhz"`
	PeakRSSIDbm       float32    `json:"peakRssiDbm"`
	HoldMs            float64    `json:"holdMs"`
	EstimatedSpeedMph float64    `json:"estimatedSpeedMph"`
	Status            PassStatus `json:"status"`
	Confidence        float64    `json:"confidence"`
	RFTimestampUs     uint64     `json:"rfTimestampUs"`
	CamTimestampUs    uint64     `json:"camTimestampUs,omitempty"`
	CrossingFrameIdx  int        `json:"crossingFrameIdx"`
	FrameCount        int        `json:"frameCount"`
	GateBiasMs        *float64   `json:"gateBiasMs,omitempty"`
	GateBiasFrames    *float64   `json:"gateBiasFrames,omitempty"`
	SpatialBiasCm     *float64   `json:"spatialBiasCm,omitempty"`
	LapNumber         int        `json:"lapNumber,omitempty"`
	LapRFSec          *float64   `json:"lapRfSec,omitempty"`
	LapCamSec         *float64   `json:"lapCamSec,omitempty"`
	LapDeltaMs        *float64   `json:"lapDeltaMs,omitempty"`
}

// HistogramBin represents one bucket in the Gate Bias distribution chart.
type HistogramBin struct {
	Label string  `json:"label"`
	MinMs float64 `json:"minMs"`
	MaxMs float64 `json:"maxMs"`
	Count int     `json:"count"`
}

// SpeedBucketStats checks whether fast passes shift RF peak bias relative to slow passes.
type SpeedBucketStats struct {
	Label      string  `json:"label"`
	Count      int     `json:"count"`
	MeanBiasMs float64 `json:"meanBiasMs"`
	StdBiasMs  float64 `json:"stdBiasMs"`
}

// SessionStats aggregates accuracy metrics across all valid (`AUTO` + `MANUAL`) passes.
type SessionStats struct {
	TotalPasses      int                `json:"totalPasses"`
	ValidPasses      int                `json:"validPasses"`
	ManualPasses     int                `json:"manualPasses"`
	NeedsManualCount int                `json:"needsManualCount"`
	ExcludedCount    int                `json:"excludedCount"`
	MeanBiasMs       float64            `json:"meanBiasMs"`
	StdBiasMs        float64            `json:"stdBiasMs"`
	P95AbsBiasMs     float64            `json:"p95AbsBiasMs"`
	MaxAbsBiasMs     float64            `json:"maxAbsBiasMs"`
	MeanBiasCm       float64            `json:"meanBiasCm"`
	LapCount         int                `json:"lapCount"`
	MeanLapDeltaMs   float64            `json:"meanLapDeltaMs"`
	StdLapDeltaMs    float64            `json:"stdLapDeltaMs"`
	P95AbsLapDeltaMs float64            `json:"p95AbsLapDeltaMs"`
	MaxAbsLapDeltaMs float64            `json:"maxAbsLapDeltaMs"`
	Histogram        []HistogramBin     `json:"histogram"`
	SpeedBuckets     []SpeedBucketStats `json:"speedBuckets"`
}

// CameraProvider abstracts the native Android Camera2 + OpenCV JNI layer (or the desktop dev simulator).
type CameraProvider interface {
	Status() CameraStatus
	Configure(cfg CameraConfig) (CameraStatus, error)
	TriggerFocusLock(normX, normY float64) error
	LatestPreviewJPEG() ([]byte, int64, error)
	CurrentSensorClockNs() int64
	ExtractAndAnalyzeBurst(req LookbackRequest) ([]FrameObservation, error)
}
