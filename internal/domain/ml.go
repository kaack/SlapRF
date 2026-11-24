package domain

// DetectorMode selects between the classic Schmitt/centroid DSP detector and the 1D TCN neural detector.
type DetectorMode string

const (
	DetectorModeClassic DetectorMode = "classic"
	DetectorModeAI      DetectorMode = "ai"
)

// MLMetrics summarizes crossing detection accuracy on a validation or benchmark split.
type MLMetrics struct {
	TotalPasses    int     `json:"totalPasses"`
	DetectedPasses int     `json:"detectedPasses"`
	MissedPasses   int     `json:"missedPasses"`
	FalseTriggers  int     `json:"falseTriggers"`
	Precision      float64 `json:"precision"`
	Recall         float64 `json:"recall"`
	F1             float64 `json:"f1"`
	MeanJitterMs   float64 `json:"meanJitterMs"`
}

// MLModelSummary is the lightweight metadata view of a saved model snapshot exposed over REST/WS.
type MLModelSummary struct {
	ModelID         string    `json:"modelId"`
	Name            string    `json:"name"`
	Version         int       `json:"version"`
	CreatedAt       string    `json:"createdAt"`
	BuiltIn         bool      `json:"builtIn,omitempty"`
	TrainPacks      int       `json:"trainPacks"`
	ValPacks        int       `json:"valPacks"`
	TrainPasses     int       `json:"trainPasses"`
	TrainDurationMs int64     `json:"trainDurationMs"`
	FinalLoss       float64   `json:"finalLoss"`
	AIMetrics       MLMetrics `json:"aiMetrics"`
	ClassicMetrics  MLMetrics `json:"classicMetrics"`
}

// MLModelSnapshot persists a complete trained 1D TCN model (metadata + float32 weights).
type MLModelSnapshot struct {
	MLModelSummary
	Weights []float32 `json:"weights"`
}

// MLConfig holds the user's active detector selection and live per-timer fine-tuning preference.
type MLConfig struct {
	DetectorMode    DetectorMode `json:"detectorMode"`
	ActiveModelID   string       `json:"activeModelId"`
	LiveTuneEnabled bool         `json:"liveTuneEnabled"`
}

// DefaultMLConfig returns the out-of-the-box detector configuration.
func DefaultMLConfig() MLConfig {
	return MLConfig{
		DetectorMode:    DetectorModeClassic,
		ActiveModelID:   "ai-base-v0",
		LiveTuneEnabled: true,
	}
}

// MLLiveGateTune stores the 24-weight per-(gate, pilot) logistic adapter learned on the fly.
type MLLiveGateTune struct {
	GateID      uint8       `json:"gateId"`
	SlotIndex   int         `json:"slotIndex"`
	LapsUsed    int         `json:"lapsUsed"`
	PosExamples int         `json:"posExamples"`
	NegExamples int         `json:"negExamples"`
	Weights     [24]float32 `json:"weights"`
	Bias        float32     `json:"bias"`
}

// MLTrainingProgress reports live or most recent background on-device base training status.
type MLTrainingProgress struct {
	Running          bool    `json:"running"`
	Epoch            int     `json:"epoch"`
	TotalEpochs      int     `json:"totalEpochs"`
	Loss             float64 `json:"loss"`
	Message          string  `json:"message,omitempty"`
	StartedAt        string  `json:"startedAt,omitempty"`
	CompletedModelID string  `json:"completedModelId,omitempty"`
	Error            string  `json:"error,omitempty"`
}

// MLPersistedState is serialized inside PersistedEngineState (`bbolt` & IndexedDB).
type MLPersistedState struct {
	Config    MLConfig          `json:"config"`
	Models    []MLModelSnapshot `json:"models,omitempty"`
	LiveTunes []MLLiveGateTune  `json:"liveTunes,omitempty"`
}

// MLStatus is returned by `GET /v1/ml/status` and broadcast on `ml_status` stream events.
type MLStatus struct {
	Config             MLConfig           `json:"config"`
	Training           MLTrainingProgress `json:"training"`
	Models             []MLModelSummary   `json:"models"`
	VerifiedPacks      int                `json:"verifiedPacks"`
	UnverifiedPacks    int                `json:"unverifiedPacks"`
	TotalRecordedPacks int                `json:"totalRecordedPacks"`
	VerifiedPasses     int                `json:"verifiedPasses"`
	StorageBytes       int64              `json:"storageBytes"`
	LiveTunes          []MLLiveGateTune   `json:"liveTunes,omitempty"`
}
