package domain

// SectorBadge classifies a sector split against the track record and the pilot's own best
// for that same stretch of track (identified by its gate pair).
type SectorBadge string

const (
	BadgeOverallBest  SectorBadge = "OVERALL_BEST"  // Fastest anyone has flown this stretch
	BadgePersonalBest SectorBadge = "PERSONAL_BEST" // Pilot's own fastest on this stretch
	BadgeNormal       SectorBadge = "NORMAL"        // Within 10% of the pilot's own best
	BadgeOffPace      SectorBadge = "OFF_PACE"      // More than 10% slower than the pilot's own best
)

// SectorSplit represents the elapsed time between two consecutive Track Gates on the course.
type SectorSplit struct {
	SectorIndex    int         `json:"sectorIndex"`    // 1-based sector number (1..N)
	FromGateID     uint8       `json:"fromGateId"`     // Entry gate ID
	ToGateID       uint8       `json:"toGateId"`       // Exit gate ID
	Label          string      `json:"label"`          // e.g. "S1 (G1 → G2)"
	SplitSeconds   float64     `json:"splitSeconds"`   // Sector duration in seconds
	DeltaToBestSec float64     `json:"deltaToBestSec"` // Difference from personal best in this sector (+0.18s)
	ExitSpeedMph   float64     `json:"exitSpeedMph"`   // Estimated gate exit speed in mph
	Badge          SectorBadge `json:"badge"`          // OVERALL_BEST, PERSONAL_BEST, NORMAL, or SLOW_SECTION
}

// LapRecord represents a full lap (Start/Finish Gate -> Intermediate Gates -> Start/Finish Gate)
// with all intermediate sector splits attached.
type LapRecord struct {
	LapID         uint64        `json:"lapId"`         // Unique lap ID
	SlotIndex     int           `json:"slotIndex"`     // 1-based pilot slot
	Callsign      string        `json:"callsign"`      // Pilot callsign
	LapNumber     int           `json:"lapNumber"`     // 1-based lap number for this pilot
	LapTimeSec    float64       `json:"lapTimeSec"`    // Total lap time in seconds (matches LiveTime official lap)
	DeltaToBest   float64       `json:"deltaToBest"`   // Delta to pilot's personal best lap
	Sectors       []SectorSplit `json:"sectors"`       // Individual gate-to-gate sector splits
	CompletedAtUs uint64        `json:"completedAtUs"` // Microsecond timestamp at finish gate
	IsBestLap     bool          `json:"isBestLap"`     // True if this was the pilot's personal best at completion
}

// SectorBottleneckStat summarizes a pilot's history on one stretch of track (gate pair).
type SectorBottleneckStat struct {
	SectorIndex         int     `json:"sectorIndex"` // 1-based position around the track
	Label               string  `json:"label"`
	FromGateID          uint8   `json:"fromGateId"`
	ToGateID            uint8   `json:"toGateId"`
	BestSplitSec        float64 `json:"bestSplitSec"`
	AverageSplitSec     float64 `json:"averageSplitSec"`
	StdDevSec           float64 `json:"stdDevSec"`
	AvgTimeLostSec      float64 `json:"avgTimeLostSec"` // Average − own best on this stretch
	AverageExitSpeedMph float64 `json:"averageExitSpeedMph"`
}

// PilotTrackSummary aggregates a pilot's laps, theoretical best lap, and slow-section diagnostics.
type PilotTrackSummary struct {
	SlotIndex          int                    `json:"slotIndex"`
	Callsign           string                 `json:"callsign"`
	Color              string                 `json:"color"`
	ChannelLabel       string                 `json:"channelLabel"`
	LapsCompleted      int                    `json:"lapsCompleted"`
	LastLapSec         float64                `json:"lastLapSec"`
	BestLapSec         float64                `json:"bestLapSec"`
	TheoreticalBestSec float64                `json:"theoreticalBestSec"` // Sum of best individual sector splits
	PotentialGainSec   float64                `json:"potentialGainSec"`   // BestLapSec - TheoreticalBestSec
	CurrentSectorIndex int                    `json:"currentSectorIndex"` // Which sector the drone is currently flying through
	LastGateID         uint8                  `json:"lastGateId"`         // Last gate cleared
	SectorStats        []SectorBottleneckStat `json:"sectorStats"`        // Per-sector consistency & bottleneck breakdown
}
