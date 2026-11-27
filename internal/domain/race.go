package domain

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
)

// SeatChannelList is a []uint8 slice of 1-based Raceband seat channels (1..8) that
// marshals to JSON as a numeric array (e.g. [1,3,5,8]) instead of Go's default base64
// string for []byte, while unmarshaling from either a numeric JSON array or legacy base64.
type SeatChannelList []uint8

func (s SeatChannelList) MarshalJSON() ([]byte, error) {
	if s == nil {
		return []byte("[]"), nil
	}
	nums := make([]int, len(s))
	for i, v := range s {
		nums[i] = int(v)
	}
	return json.Marshal(nums)
}

func (s *SeatChannelList) UnmarshalJSON(data []byte) error {
	trimmed := strings.TrimSpace(string(data))
	if trimmed == "" || trimmed == "null" {
		*s = nil
		return nil
	}
	if strings.HasPrefix(trimmed, "\"") {
		var b64 string
		if err := json.Unmarshal(data, &b64); err != nil {
			return err
		}
		decoded, err := base64.StdEncoding.DecodeString(b64)
		if err != nil {
			return err
		}
		*s = SeatChannelList(decoded)
		return nil
	}
	var nums []int
	if err := json.Unmarshal(data, &nums); err != nil {
		return err
	}
	out := make(SeatChannelList, 0, len(nums))
	for _, n := range nums {
		if n >= 0 && n <= 255 {
			out = append(out, uint8(n))
		}
	}
	*s = out
	return nil
}

// OperatingMode selects whether SlapRF is running open Practice timing or organized Race Mode heats.
type OperatingMode string

const (
	ModePractice OperatingMode = "practice"
	ModeRace     OperatingMode = "race"
)

// MaxRaceStages is the maximum number of composable stages allowed in a single Race DAG.
const MaxRaceStages = 5

// TournamentStructure selects either a direct 1-stage tournament or a 2-stage Qualifying -> Mains event.
type TournamentStructure string

const (
	StructureSingleStage TournamentStructure = "single_stage"
	StructureTwoStage    TournamentStructure = "two_stage"
)

// StageFormat defines how rounds/heats are generated and scored within a stage.
type StageFormat string

const (
	FormatQualifying        StageFormat = "qualifying"
	FormatOpenQualifier     StageFormat = "open_qualifier"
	FormatDoubleElimination StageFormat = "double_elimination"
	FormatSingleElimination StageFormat = "single_elimination"
	FormatChaseTheAce       StageFormat = "chase_the_ace"
	FormatPointsMains       StageFormat = "points_mains"
	FormatCustom            StageFormat = "custom"
)

// StageStatus tracks the dependency and execution state of one stage in a multi-stage Race DAG.
type StageStatus string

const (
	StageStatusPending   StageStatus = "pending"   // Waiting for upstream prerequisite stage(s) to complete
	StageStatusReady     StageStatus = "ready"     // Prerequisites met, ready to run
	StageStatusActive    StageStatus = "active"    // Currently active live stage (at most 1 stage active at a time)
	StageStatusPaused    StageStatus = "paused"    // Paused by organizer so another ready stage can run (or paused mid-stage)
	StageStatusCompleted StageStatus = "completed" // All heats confirmed / stage champion decided (or completed early)
)

// QualifyingMetric determines how pilots are ranked during Qualifying rounds.
type QualifyingMetric string

const (
	QualMetricConsecutive3 QualifyingMetric = "consecutive_3" // Fastest 3 consecutive laps (MultiGP standard)
	QualMetricConsecutive2 QualifyingMetric = "consecutive_2" // Fastest 2 consecutive laps (MultiGP standard)
	QualMetricBestLap      QualifyingMetric = "best_lap"      // Fastest single lap
	QualMetricLapsInTime   QualifyingMetric = "laps_in_time"  // Most laps in shortest time
	QualMetricPoints       QualifyingMetric = "points"        // Cumulative heat finishing points
)

// Canonical Round IDs for Stage Seeding Handoff & Checked-In Pilots portal nodes.
const (
	Stage1HandoffOutID = "stage1-seeding-out"
	Stage2HandoffInID  = "stage2-seeds-in"
	Stage1PilotsInID   = "stage1-pilots-in"
)

// StageHandoffOutID returns the canonical outgoing seeding portal RoundID for `stageIndex` (1..5).
func StageHandoffOutID(stageIndex int) string {
	if stageIndex <= 1 {
		return Stage1HandoffOutID
	}
	return fmt.Sprintf("stage%d-seeding-out", stageIndex)
}

// StageHandoffInID returns the canonical incoming seeds portal RoundID for `stageIndex` (1..5).
func StageHandoffInID(stageIndex int) string {
	if stageIndex == 2 {
		return Stage2HandoffInID
	}
	if stageIndex < 1 {
		stageIndex = 1
	}
	return fmt.Sprintf("stage%d-seeds-in", stageIndex)
}

// StagePilotsInID returns the canonical Checked-In Pilots source portal RoundID for root `stageIndex` (1..5).
func StagePilotsInID(stageIndex int) string {
	if stageIndex <= 1 {
		return Stage1PilotsInID
	}
	return fmt.Sprintf("stage%d-pilots-in", stageIndex)
}

// OpenQualRoundID returns the canonical dynamic Flight-Line round ID for an Open Qualifier stage (1..5).
func OpenQualRoundID(stageIndex int) string {
	if stageIndex <= 1 {
		return "stage1-open-qual"
	}
	return fmt.Sprintf("stage%d-open-qual", stageIndex)
}

// IsOpenQualRoundID reports whether `id` is an Open Qualifier Flight-Line round.
func IsOpenQualRoundID(id string) bool {
	return id == "stage1-open-qual" || (strings.HasPrefix(id, "stage") && strings.HasSuffix(id, "-open-qual"))
}

// IsStageHandoffOutID reports whether `id` is an outgoing stage seeding portal round.
func IsStageHandoffOutID(id string) bool {
	return id == Stage1HandoffOutID || (strings.HasPrefix(id, "stage") && strings.HasSuffix(id, "-seeding-out"))
}

// IsStageHandoffInID reports whether `id` is an incoming stage seeds portal round.
func IsStageHandoffInID(id string) bool {
	return id == Stage2HandoffInID || (strings.HasPrefix(id, "stage") && strings.HasSuffix(id, "-seeds-in"))
}

// IsStagePilotsInID reports whether `id` is a root Checked-In Pilots source node on the round canvas.
func IsStagePilotsInID(id string) bool {
	return id == Stage1PilotsInID || (strings.HasPrefix(id, "stage") && strings.HasSuffix(id, "-pilots-in"))
}

// IsStagePortalRoundID reports whether `id` is a stage portal round (pilots source, incoming seeds, or outgoing seeding).
func IsStagePortalRoundID(id string) bool {
	return IsStageHandoffOutID(id) || IsStageHandoffInID(id) || IsStagePilotsInID(id)
}

// SeedingMethod determines how pilots are ordered into Stage 1 when no Qualifying stage precedes it.
type SeedingMethod string

const (
	SeedRosterOrder SeedingMethod = "roster_order"
	SeedRandom      SeedingMethod = "random"
)

// StartMode controls whether pilot race clocks start on the start horn (heads-up) or individual gate pass (staggered).
type StartMode string

const (
	StartModeHeadsUp   StartMode = "heads_up"
	StartModeStaggered StartMode = "staggered"
)

// FinalsFormat selects how an elimination bracket crowns the overall winner once down to the Final group.
type FinalsFormat string

const (
	FinalsChaseTheAce FinalsFormat = "chase_the_ace"
	FinalsSingle      FinalsFormat = "single_final"
	FinalsPoints      FinalsFormat = "points_final"
)

// HeatState tracks the lifecycle of a single race heat.
type HeatState string

const (
	HeatWaiting   HeatState = "waiting"   // Waiting for feeder heats to determine pilot lineup
	HeatReady     HeatState = "ready"     // Lineup known, ready to stage onto hardware slots
	HeatStaged    HeatState = "staged"    // Loaded onto active RF slots, ready to start countdown
	HeatCountdown HeatState = "countdown" // Pre-start countdown running
	HeatRunning   HeatState = "running"   // Clock running, actively scoring gate crossings
	HeatPaused    HeatState = "paused"    // Clock frozen, crossings ignored until resumed
	HeatFinished  HeatState = "finished"  // Provisional results awaiting Race Director confirmation
	HeatConfirmed HeatState = "confirmed" // Results locked and propagated to bracket / standings
	HeatAborted   HeatState = "aborted"   // Emergency stopped; can be reset & re-run
)

// PilotHeatStatus tracks an individual pilot's status inside a heat.
type PilotHeatStatus string

const (
	PilotHeatStaged   PilotHeatStatus = "staged"
	PilotHeatRacing   PilotHeatStatus = "racing"
	PilotHeatFinished PilotHeatStatus = "finished"
	PilotHeatDNF      PilotHeatStatus = "dnf" // Crashed out / Did Not Finish
	PilotHeatDNS      PilotHeatStatus = "dns" // Did Not Start / Scratched (away or left event)
	PilotHeatDQ       PilotHeatStatus = "dq"  // Disqualified
)

// QualifyingLineupMode controls whether multi-round Qualifying keeps fixed heat groups & VTX channels
// across rounds ("fixed", RotorHazard club style) or rotates opponents ("balanced").
type QualifyingLineupMode string

const (
	QualLineupBalanced QualifyingLineupMode = "balanced"
	QualLineupFixed    QualifyingLineupMode = "fixed"
)

// RaceSetupConfig stores all user-configurable tournament parameters.
type RaceSetupConfig struct {
	EventName              string               `json:"eventName"`
	Structure              TournamentStructure  `json:"structure"`
	QualifyingRounds       int                  `json:"qualifyingRounds"`
	QualifyingMetric       QualifyingMetric     `json:"qualifyingMetric"`
	QualifyingLineupMode   QualifyingLineupMode `json:"qualifyingLineupMode,omitempty"`
	QualifyingTimeLimitSec int                  `json:"qualifyingTimeLimitSec"`
	QualifyingTargetLaps   int                 `json:"qualifyingTargetLaps"`
	MaxPacksPerPilot       int                 `json:"maxPacksPerPilot,omitempty"` // 0 = Unlimited packs (Open Qualifier), 1..50 = per-pilot cap
	Stage2MaxSeeds         int                 `json:"stage2MaxSeeds,omitempty"`   // 0 = All qualified pilots; >0 = Top N seeds advance to Stage 2
	MainFormat             StageFormat         `json:"mainFormat"`
	FinalsFormat           FinalsFormat        `json:"finalsFormat"`
	AceWinsRequired        int                 `json:"aceWinsRequired"`
	WinnersAdvantageAce    bool                `json:"winnersAdvantageAce"`
	PointsRounds           int                 `json:"pointsRounds"`
	PilotsPerHeat          int                 `json:"pilotsPerHeat"`
	SeatChannels           SeatChannelList     `json:"seatChannels"` // 1-based Raceband channels per seat (e.g. [1,3,5,8])
	TargetLaps             int                 `json:"targetLaps"`
	TimeLimitSec           int                 `json:"timeLimitSec"`
	CountdownSec           int                 `json:"countdownSec"`
	OvertimeGraceSec       int                 `json:"overtimeGraceSec"`
	Seeding                SeedingMethod       `json:"seeding"`
}

// DefaultSeatChannels returns clean, interference-spaced Raceband channels for `n` seats (1..8).
func DefaultSeatChannels(n int) []uint8 {
	switch {
	case n <= 1:
		return []uint8{1}
	case n == 2:
		return []uint8{1, 8}
	case n == 3:
		return []uint8{1, 4, 8}
	case n == 4:
		return []uint8{1, 3, 5, 8} // Standard MultiGP 4-up spacing
	case n == 5:
		return []uint8{1, 3, 5, 7, 8}
	case n == 6:
		return []uint8{1, 2, 4, 5, 7, 8}
	case n == 7:
		return []uint8{1, 2, 3, 4, 6, 7, 8}
	default:
		return []uint8{1, 2, 3, 4, 5, 6, 7, 8}
	}
}

// NormalizeSeatChannelCodes validates and deduplicates encoded seat channel codes (both Raceband 1..8
// and multi-band codes such as 24 = F4, 41 = A1, 62 = B2), ensuring exact length `pilotsPerHeat` and
// preventing two seats from sharing the same RF center frequency.
func NormalizeSeatChannelCodes(raw []uint8, pilotsPerHeat int, fallback []uint8) []uint8 {
	usedCode := make(map[uint8]bool, pilotsPerHeat)
	usedFreq := make(map[uint16]bool, pilotsPerHeat)
	cleaned := make([]uint8, 0, pilotsPerHeat)

	tryAdd := func(code uint8) {
		if len(cleaned) >= pilotsPerHeat {
			return
		}
		band, ch, freq, ok := DecodeBandChannel(code)
		if !ok || freq == 0 {
			return
		}
		canon := EncodeBandChannel(band, ch)
		if canon == 0 || usedCode[canon] || usedFreq[freq] {
			return
		}
		usedCode[canon] = true
		usedFreq[freq] = true
		cleaned = append(cleaned, canon)
	}

	for _, code := range raw {
		tryAdd(code)
	}
	if len(cleaned) < pilotsPerHeat {
		for _, code := range fallback {
			tryAdd(code)
		}
	}
	if len(cleaned) < pilotsPerHeat {
		for _, code := range DefaultSeatChannels(pilotsPerHeat) {
			tryAdd(code)
		}
	}
	for ch := uint8(1); ch <= MaxPilotSlots && len(cleaned) < pilotsPerHeat; ch++ {
		tryAdd(ch)
	}
	return cleaned
}

// DefaultRaceSetupConfig returns sensible MultiGP / FPVTrackside defaults.
func DefaultRaceSetupConfig() RaceSetupConfig {
	return RaceSetupConfig{
		EventName:              "Club Race",
		Structure:              StructureSingleStage,
		QualifyingRounds:       2,
		QualifyingMetric:       QualMetricConsecutive3,
		QualifyingTimeLimitSec: 120,
		QualifyingTargetLaps:   0, // Unlimited laps within QualifyingTimeLimitSec
		MainFormat:             FormatDoubleElimination,
		FinalsFormat:           FinalsChaseTheAce,
		AceWinsRequired:        2,
		WinnersAdvantageAce:    false,
		PointsRounds:           3,
		PilotsPerHeat:          4,
		SeatChannels:           DefaultSeatChannels(4),
		TargetLaps:             3,
		TimeLimitSec:           120,
		CountdownSec:           5,
		OvertimeGraceSec:       15,
		Seeding:                SeedRosterOrder,
	}
}

// Normalized clamps out-of-range fields and fills missing seat channels.
func (c RaceSetupConfig) Normalized() RaceSetupConfig {
	def := DefaultRaceSetupConfig()
	if c.EventName == "" {
		c.EventName = def.EventName
	}
	if c.Structure != StructureSingleStage && c.Structure != StructureTwoStage {
		c.Structure = def.Structure
	}
	if c.QualifyingRounds < 1 {
		c.QualifyingRounds = def.QualifyingRounds
	} else if c.QualifyingRounds > 20 {
		c.QualifyingRounds = 20
	}
	switch c.QualifyingMetric {
	case QualMetricConsecutive3, QualMetricConsecutive2, QualMetricBestLap, QualMetricLapsInTime, QualMetricPoints:
	default:
		c.QualifyingMetric = def.QualifyingMetric
	}
	switch c.QualifyingLineupMode {
	case QualLineupFixed, QualLineupBalanced:
	default:
		c.QualifyingLineupMode = ""
	}
	if c.Stage2MaxSeeds < 0 {
		c.Stage2MaxSeeds = 0
	} else if c.Stage2MaxSeeds == 1 {
		c.Stage2MaxSeeds = 2
	} else if c.Stage2MaxSeeds > 64 {
		c.Stage2MaxSeeds = 64
	}
	if c.QualifyingTimeLimitSec < 15 {
		c.QualifyingTimeLimitSec = def.QualifyingTimeLimitSec
	} else if c.QualifyingTimeLimitSec > 1800 {
		c.QualifyingTimeLimitSec = 1800
	}
	if c.QualifyingTargetLaps < 0 {
		c.QualifyingTargetLaps = 0
	} else if c.QualifyingTargetLaps > 50 {
		c.QualifyingTargetLaps = 50
	}
	if c.MaxPacksPerPilot < 0 {
		c.MaxPacksPerPilot = 0
	} else if c.MaxPacksPerPilot > 50 {
		c.MaxPacksPerPilot = 50
	}
	switch c.MainFormat {
	case FormatDoubleElimination, FormatSingleElimination, FormatChaseTheAce, FormatPointsMains, FormatQualifying, FormatOpenQualifier, FormatCustom:
	default:
		c.MainFormat = def.MainFormat
	}
	if c.FinalsFormat != FinalsChaseTheAce && c.FinalsFormat != FinalsSingle && c.FinalsFormat != FinalsPoints {
		c.FinalsFormat = def.FinalsFormat
	}
	if c.AceWinsRequired < 2 {
		c.AceWinsRequired = 2
	} else if c.AceWinsRequired > 5 {
		c.AceWinsRequired = 5
	}
	if c.PointsRounds < 1 {
		c.PointsRounds = def.PointsRounds
	} else if c.PointsRounds > 12 {
		c.PointsRounds = 12
	}
	if c.PilotsPerHeat < 2 {
		c.PilotsPerHeat = 2
	} else if c.PilotsPerHeat > MaxPilotSlots {
		c.PilotsPerHeat = MaxPilotSlots
	}
	// Clean & deduplicate seat channels (supporting encoded multi-band codes), ensuring length == PilotsPerHeat
	c.SeatChannels = NormalizeSeatChannelCodes(c.SeatChannels, c.PilotsPerHeat, DefaultSeatChannels(c.PilotsPerHeat))

	if c.TargetLaps < 1 {
		c.TargetLaps = def.TargetLaps
	} else if c.TargetLaps > 50 {
		c.TargetLaps = 50
	}
	if c.TimeLimitSec < 15 {
		c.TimeLimitSec = def.TimeLimitSec
	} else if c.TimeLimitSec > 1800 {
		c.TimeLimitSec = 1800
	}
	if c.CountdownSec < 0 {
		c.CountdownSec = 0
	} else if c.CountdownSec > 15 {
		c.CountdownSec = 15
	}
	if c.OvertimeGraceSec < 0 {
		c.OvertimeGraceSec = 0
	} else if c.OvertimeGraceSec > 60 {
		c.OvertimeGraceSec = 60
	}
	if c.Seeding != SeedRosterOrder && c.Seeding != SeedRandom {
		c.Seeding = def.Seeding
	}
	return c
}

// HeatCrossing records an accepted or manual start/finish pass within a heat so invalidating/restoring
// a pass cleanly recomputes all lap times and consecutive-lap windows (just like FPVTrackside).
type HeatCrossing struct {
	CrossingID  uint64        `json:"crossingId"`
	TimestampUs uint64        `json:"timestampUs"`
	Invalidated bool          `json:"invalidated"`
	Manual      bool          `json:"manual"`
	PeakRSSIDbm float32       `json:"peakRssiDbm,omitempty"`
	Sectors     []SectorSplit `json:"sectors,omitempty"`
}

// HeatLap is a derived lap or holeshot entry displayed in Race Control.
type HeatLap struct {
	CrossingID     uint64        `json:"crossingId"`
	LapNumber      int           `json:"lapNumber"`      // 0 = Holeshot, 1..N = counted lap
	SplitTimeSec   float64       `json:"splitTimeSec"`   // Duration of this lap (or reaction/holeshot time for Lap 0)
	RaceElapsedSec float64       `json:"raceElapsedSec"` // Time since heat/pilot clock start
	Invalidated    bool          `json:"invalidated"`
	Manual         bool          `json:"manual"`
	Sectors        []SectorSplit `json:"sectors,omitempty"`
}

// SeatFeeder describes how an unfilled seat will be populated automatically from an earlier heat or round standings.
type SeatFeeder struct {
	FromHeatID        string           `json:"fromHeatId,omitempty"`
	FromRank          int              `json:"fromRank,omitempty"`          // 1-based finishing rank in FromHeatID
	FromRoundID       string           `json:"fromRoundId,omitempty"`       // Upstream round ID whose connected qualifier/points chain produces FromStandingsRank
	FromRoundColumn   int              `json:"fromRoundColumn,omitempty"`   // If > 0 and FromHeatID == "", feeds from cumulative standings up through this column
	FromStandingsRank int              `json:"fromStandingsRank,omitempty"` // 1-based overall rank in cumulative standings up through FromRoundID / FromRoundColumn
	RankingMetric     QualifyingMetric `json:"rankingMetric,omitempty"`     // Optional metric override for FromStandingsRank
	FromStageSeed     int              `json:"fromStageSeed,omitempty"`     // 1-based Seed # from Stage 1 Qualifying (legacy, migrated to FromRoundID)
	IsBye             bool             `json:"isBye,omitempty"`
}

// RaceRound describes one logical/visual round node on the Round Graph.
type RaceRound struct {
	ID                  string           `json:"id"`
	StageIndex          int              `json:"stageIndex"`
	Round               int              `json:"round"`
	Column              int              `json:"column"`
	BracketLane         string           `json:"bracketLane"` // "qualifying" | "winners" | "losers" | "mains" | "finals" | "handoff_out" | "handoff_in"
	Title               string           `json:"title"`
	StageFormat         StageFormat      `json:"stageFormat"`
	StartMode           StartMode        `json:"startMode,omitempty"`
	TargetLaps          int              `json:"targetLaps"`
	TimeLimitSec        int              `json:"timeLimitSec"`
	TargetHeats         int              `json:"targetHeats,omitempty"`         // Explicit desired heat count on non-Finals rounds
	MaxPacksPerPilot    int              `json:"maxPacksPerPilot,omitempty"`    // For Open Qualifier / ZippyQ rounds (0 = unlimited)
	QualifyingMetric    QualifyingMetric `json:"qualifyingMetric,omitempty"`    // For Qualifying / Open Qualifier rounds
	FinalsFormat        FinalsFormat     `json:"finalsFormat,omitempty"`        // For BracketLane=="finals": "single_final" | "chase_the_ace" | "points_final"
	AceWinsRequired     int              `json:"aceWinsRequired,omitempty"`     // For "chase_the_ace" Finals (default 2)
	WinnersAdvantageAce bool             `json:"winnersAdvantageAce,omitempty"` // For "chase_the_ace" Finals (+1 starting Ace for Winners #1)
	FinalsHeats         int              `json:"finalsHeats,omitempty"`         // For "points_final" Finals (default 3)
	SeedSource          string           `json:"seedSource,omitempty"`          // "all_active_pilots" | "empty"
	SeedDistribution    string           `json:"seedDistribution,omitempty"`    // For "all_active_pilots": "roster" (default) | "snake" | "sequential" | "random"
	RandomSeed          int64            `json:"randomSeed,omitempty"`          // Deterministic shuffle seed updated on 1-tap Reshuffle
	SeedToPort          string           `json:"seedToPort,omitempty"`          // Input port on round for Checked-In Pilots wire: "left" (default) | "top" | "bottom"
	LinkSummary         string           `json:"linkSummary,omitempty"`
	HasPos              bool             `json:"hasPos,omitempty"`
	PosX                float64          `json:"posX,omitempty"`
	PosY                float64          `json:"posY,omitempty"`
}

// RoundConnection represents a directed advancement wire between two Round nodes on the Round Graph.
type RoundConnection struct {
	ID            string           `json:"id"`
	StageIndex    int              `json:"stageIndex,omitempty"`
	FromRoundID   string           `json:"fromRoundId"`
	ToRoundID     string           `json:"toRoundId"`
	FromPort      string           `json:"fromPort,omitempty"`      // "right" | "bottom"
	ToPort        string           `json:"toPort,omitempty"`        // "left" | "top" | "bottom"
	Mode          string           `json:"mode"`                    // "top_per_heat" | "bottom_per_heat" | "standings_top" | "all_pilots" | "all_pilots_ranked" | "stage_seeds" | "qual_feed"
	Count         int              `json:"count"`                   // e.g. 2 for Top 2 / Bottom 2 per heat, or 8 for Top 8
	CustomCount   bool             `json:"customCount,omitempty"`   // True when Count was explicitly chosen by the user rather than auto-inferred
	SeedStart     int              `json:"seedStart,omitempty"`     // For "standings_top" / "stage_seeds": 1-based start rank (default 1)
	SeedEnd       int              `json:"seedEnd,omitempty"`       // For "standings_top" / "stage_seeds": 1-based inclusive end rank (0 = all / Count)
	Distribution  string           `json:"distribution,omitempty"`  // For "standings_top" / "stage_seeds": "snake" | "sequential"
	RankingMetric QualifyingMetric `json:"rankingMetric,omitempty"` // For "standings_top": metric used to rank upstream qualifier chain
	SeededEarly   bool             `json:"seededEarly,omitempty"`   // True when organizer triggered Seed Now to cut qualifying early
	Invalid       bool             `json:"invalid,omitempty"`       // True when this wire forms a cycle or violates round/portal constraints
	InvalidReason string           `json:"invalidReason,omitempty"` // Human-readable explanation shown on click and in error toast
}

// HeatRssiSample stores one downsampled Start/Finish gate RSSI point (~10 Hz, peak-preserving)
// relative to the heat's StartToneUs (negative = pre-horn countdown lead-in).
type HeatRssiSample struct {
	OffsetMs int32 `json:"t"`
	Dbm      int16 `json:"r"`
}

// HeatSeat represents one channel seat in a RaceHeat.
type HeatSeat struct {
	SeatIndex           int             `json:"seatIndex"`      // 1..PilotsPerHeat
	PilotSlotIndex      int             `json:"pilotSlotIndex"` // 1-based PilotSlot.SlotIndex in roster, or 0 if waiting
	Callsign            string          `json:"callsign"`
	PhoneticName        string          `json:"phoneticName,omitempty"`
	Color               string          `json:"color"`
	Seed                int             `json:"seed,omitempty"`
	SourceLabel         string          `json:"sourceLabel"` // e.g. "Seed #1", "1st · W1-1"
	Feeder              *SeatFeeder     `json:"feeder,omitempty"`
	ManualLock          bool            `json:"manualLock,omitempty"` // True when director manually placed/cleared this seat
	Band                Band            `json:"band"`
	Channel             uint8           `json:"channel"`
	FrequencyMHz        uint16          `json:"frequencyMhz"`
	ChannelChanged      bool            `json:"channelChanged"` // True if pilot switched channel from their previous heat
	PrevChannel         uint8           `json:"prevChannel,omitempty"`
	Status              PilotHeatStatus `json:"status"`
	PreOverrideStatus   PilotHeatStatus `json:"preOverrideStatus,omitempty"`
	StatusOverridden    bool            `json:"statusOverridden,omitempty"`
	HoleshotSec         float64         `json:"holeshotSec"`
	HoleshotWinner      bool            `json:"holeshotWinner,omitempty"`
	LapsCompleted       int             `json:"lapsCompleted"`
	TotalTimeSec        float64         `json:"totalTimeSec"`
	BestLapSec          float64         `json:"bestLapSec"`
	BestConsecutive2Sec float64         `json:"bestConsecutive2Sec,omitempty"`
	BestConsecutive3Sec float64         `json:"bestConsecutive3Sec"`
	LastLapSec          float64         `json:"lastLapSec"`
	PenaltySec          float64         `json:"penaltySec"`
	EnterRssiDbm        float32         `json:"enterRssiDbm,omitempty"`
	ExitRssiDbm         float32         `json:"exitRssiDbm,omitempty"`
	RssiTrace           []HeatRssiSample `json:"rssiTrace,omitempty"`
	Crossings           []HeatCrossing  `json:"crossings,omitempty"`
	Laps                []HeatLap       `json:"laps"`
	Position            int             `json:"position"`       // 1..N computed rank
	ManualPosition      int             `json:"manualPosition"` // 0 = auto, 1..N = director override
	RosterDQ            bool            `json:"rosterDq,omitempty"` // True when DQ came from race-level Pilots Roster toggle
	Points              int             `json:"points"`
	AceWinsBefore       int             `json:"aceWinsBefore,omitempty"`
	AceWinsAfter        int             `json:"aceWinsAfter,omitempty"`
	Advances            bool            `json:"advances"`
}

// BracketEdge describes how finishing ranks flow from one heat to another in the bracket diagram.
type BracketEdge struct {
	FromHeatID string `json:"fromHeatId"`
	ToHeatID   string `json:"toHeatId"`
	Ranks      []int  `json:"ranks"`
	IsDrop     bool   `json:"isDrop"`
}

// RaceHeat represents a single scheduled, live, or completed heat.
type RaceHeat struct {
	ID                    string      `json:"id"` // e.g. "Q1-1", "W1-1", "L1-1", "GF-1", "CTA-1"
	RoundID               string      `json:"roundId,omitempty"`
	StageIndex            int         `json:"stageIndex"`
	StageName             string      `json:"stageName"`
	StageFormat           StageFormat `json:"stageFormat"`
	Round                 int         `json:"round"`
	Column                int         `json:"column"` // Visual diagram column (1..C)
	Order                 int         `json:"order"`  // Running sequence number (1..M)
	BracketLane           string      `json:"bracketLane"` // "qualifying" | "winners" | "losers" | "finals" | "mains"
	Division              string      `json:"division,omitempty"` // e.g. "A", "B", "C" for Mains
	Title                 string      `json:"title"`
	ShortLabel            string      `json:"shortLabel"`
	StartMode             StartMode   `json:"startMode"`
	TargetLaps            int         `json:"targetLaps"` // 0 = timed only
	TimeLimitSec          int         `json:"timeLimitSec"`
	ExpectedWinners       int         `json:"expectedWinners"`
	State                 HeatState          `json:"state"`
	HardwareMode          TimingHardwareMode `json:"hardwareMode,omitempty"`
	Note                  string             `json:"note,omitempty"`
	Seats                 []HeatSeat  `json:"seats"`
	ElapsedSec               float64     `json:"elapsedSec"`
	CountdownRemainingSec    float64     `json:"countdownRemainingSec"`
	CountdownArmRemainingSec float64     `json:"countdownArmRemainingSec,omitempty"`
	CountdownDurationSec     int         `json:"countdownDurationSec,omitempty"`
	CountdownBeeped          bool        `json:"countdownBeeped,omitempty"`
	CountdownBeepAtSec       float64     `json:"countdownBeepAtSec"`
	InOvertime               bool        `json:"inOvertime"`
	CanUnlock                bool        `json:"canUnlock"`
	ExecutedAtMs             int64       `json:"executedAtMs,omitempty"` // Wall-clock ms when heat last executed/finished
	// Internal engine timing anchors (persisted so reload mid-heat works cleanly)
	StartToneUs         uint64 `json:"startToneUs,omitempty"`
	CountdownPromptUs   uint64 `json:"countdownPromptUs,omitempty"`
	CountdownPrompted   bool   `json:"countdownPrompted,omitempty"`
	CountdownStartUs    uint64 `json:"countdownStartUs,omitempty"`
	CountdownEndUs      uint64 `json:"countdownEndUs,omitempty"`
	PausedAtUs          uint64 `json:"pausedAtUs,omitempty"`
	AccumulatedPauseUs  uint64 `json:"accumulatedPauseUs,omitempty"`
	OvertimeStartedAtUs uint64 `json:"overtimeStartedAtUs,omitempty"`
}

// TournamentStanding summarizes one pilot's overall tournament standing.
type TournamentStanding struct {
	Rank                int     `json:"rank"`
	PilotSlotIndex      int     `json:"pilotSlotIndex"`
	Callsign            string  `json:"callsign"`
	PhoneticName        string  `json:"phoneticName,omitempty"`
	Color               string  `json:"color"`
	Seed                int     `json:"seed"`
	BracketStatus       string  `json:"bracketStatus"` // e.g. "Champion", "Winners", "Losers", "Eliminated", "Qualifying"
	HeatsFlown          int     `json:"heatsFlown"`
	Wins                int     `json:"wins"`
	AceWins             int     `json:"aceWins"`
	Losses              int     `json:"losses"`
	Points              int     `json:"points"`
	TotalLaps           int     `json:"totalLaps"`
	BestLapSec          float64 `json:"bestLapSec"`
	BestConsecutive2Sec float64 `json:"bestConsecutive2Sec,omitempty"`
	BestConsecutive3Sec float64 `json:"bestConsecutive3Sec"`
}

// RaceAnnouncement is emitted over the real-time stream so the browser Voice Announcer can play
// start horns, countdown cues, finish callouts, and emergency warnings.
type RaceAnnouncement struct {
	Kind         string `json:"kind"` // "countdown_start" | "countdown_prompt" | "countdown_cancel" | "start_horn" | "holeshot" | "pilot_finished" | "pilot_dnf" | "overtime" | "heat_finished" | "emergency_stop" | "champion"
	HeatID       string `json:"heatId,omitempty"`
	SlotIndex    int    `json:"slotIndex,omitempty"`
	Callsign     string `json:"callsign,omitempty"`
	Position     int    `json:"position,omitempty"`
	CountdownSec int    `json:"countdownSec,omitempty"`
	Text         string `json:"text,omitempty"`
	Competitive        bool   `json:"competitive,omitempty"`
	TimedOut           bool   `json:"timedOut,omitempty"`
	HornAlreadySounded bool   `json:"hornAlreadySounded,omitempty"`
}

// PracticeSnapshot preserves Practice Mode's pilot enabled/channel state and recorded session
// while the user is running heats in Race Mode.
type PracticeSnapshot struct {
	Saved      bool                `json:"saved"`
	RaceArmed  bool                `json:"raceArmed"`
	Pilots     []PilotSlot         `json:"pilots,omitempty"`
	Laps       []LapRecord         `json:"laps,omitempty"`
	Crossings  []GateCrossingEvent `json:"crossings,omitempty"`
	Filtered   []FilteredDetection `json:"filtered,omitempty"`
}

// StageSettings stores per-stage racing parameters (separate from global RaceSetupConfig settings
// such as EventName, CountdownSec, OvertimeGraceSec, and Seeding).
type StageSettings struct {
	PilotsPerHeat        int                  `json:"pilotsPerHeat"`
	SeatChannels         SeatChannelList      `json:"seatChannels"`
	TargetLaps           int                  `json:"targetLaps"` // 0 allowed for Qualifying timed rounds
	TimeLimitSec         int                  `json:"timeLimitSec"`
	QualifyingRounds     int                  `json:"qualifyingRounds"`
	QualifyingMetric     QualifyingMetric     `json:"qualifyingMetric"`
	QualifyingLineupMode QualifyingLineupMode `json:"qualifyingLineupMode,omitempty"`
	MaxPacksPerPilot     int                  `json:"maxPacksPerPilot,omitempty"` // 0 = Unlimited packs (Open Qualifier), 1..50 = per-pilot cap
	PointsRounds        int              `json:"pointsRounds"`
	FinalsFormat        FinalsFormat     `json:"finalsFormat"`
	AceWinsRequired     int              `json:"aceWinsRequired"`
	WinnersAdvantageAce bool             `json:"winnersAdvantageAce"`
}

// DefaultStageSettingsFromConfig constructs initial per-stage settings from `cfg` for `format`.
func DefaultStageSettingsFromConfig(cfg RaceSetupConfig, format StageFormat) StageSettings {
	cfg = cfg.Normalized()
	laps := cfg.TargetLaps
	tSec := cfg.TimeLimitSec
	if format == FormatQualifying || format == FormatOpenQualifier {
		laps = cfg.QualifyingTargetLaps
		tSec = cfg.QualifyingTimeLimitSec
	}
	return StageSettings{
		PilotsPerHeat:       cfg.PilotsPerHeat,
		SeatChannels:        append([]uint8(nil), cfg.SeatChannels...),
		TargetLaps:          laps,
		TimeLimitSec:        tSec,
		QualifyingRounds:     cfg.QualifyingRounds,
		QualifyingMetric:     cfg.QualifyingMetric,
		QualifyingLineupMode: cfg.QualifyingLineupMode,
		MaxPacksPerPilot:     cfg.MaxPacksPerPilot,
		PointsRounds:        cfg.PointsRounds,
		FinalsFormat:        cfg.FinalsFormat,
		AceWinsRequired:     cfg.AceWinsRequired,
		WinnersAdvantageAce: cfg.WinnersAdvantageAce,
	}
}

// Normalized clamps out-of-range fields and fills missing seat channels on StageSettings.
func (s StageSettings) Normalized(fallback RaceSetupConfig, format StageFormat) StageSettings {
	def := DefaultStageSettingsFromConfig(fallback, format)
	if s.PilotsPerHeat < 2 {
		s.PilotsPerHeat = def.PilotsPerHeat
	} else if s.PilotsPerHeat > MaxPilotSlots {
		s.PilotsPerHeat = MaxPilotSlots
	}
	s.SeatChannels = NormalizeSeatChannelCodes(s.SeatChannels, s.PilotsPerHeat, def.SeatChannels)

	if format == FormatQualifying || format == FormatOpenQualifier {
		if s.TargetLaps < 0 {
			s.TargetLaps = 0
		} else if s.TargetLaps > 50 {
			s.TargetLaps = 50
		}
	} else {
		if s.TargetLaps < 1 {
			s.TargetLaps = def.TargetLaps
			if s.TargetLaps < 1 {
				s.TargetLaps = 3
			}
		} else if s.TargetLaps > 50 {
			s.TargetLaps = 50
		}
	}
	if s.TimeLimitSec < 15 {
		s.TimeLimitSec = def.TimeLimitSec
	} else if s.TimeLimitSec > 1800 {
		s.TimeLimitSec = 1800
	}
	if s.QualifyingRounds < 1 {
		s.QualifyingRounds = def.QualifyingRounds
	} else if s.QualifyingRounds > 20 {
		s.QualifyingRounds = 20
	}
	if s.MaxPacksPerPilot < 0 {
		s.MaxPacksPerPilot = 0
	} else if s.MaxPacksPerPilot > 50 {
		s.MaxPacksPerPilot = 50
	}
	switch s.QualifyingMetric {
	case QualMetricConsecutive3, QualMetricConsecutive2, QualMetricBestLap, QualMetricLapsInTime, QualMetricPoints:
	default:
		s.QualifyingMetric = def.QualifyingMetric
	}
	switch s.QualifyingLineupMode {
	case QualLineupFixed, QualLineupBalanced:
	default:
		s.QualifyingLineupMode = def.QualifyingLineupMode
	}
	if s.PointsRounds < 1 {
		s.PointsRounds = def.PointsRounds
	} else if s.PointsRounds > 12 {
		s.PointsRounds = 12
	}
	if s.FinalsFormat != FinalsChaseTheAce && s.FinalsFormat != FinalsSingle && s.FinalsFormat != FinalsPoints {
		s.FinalsFormat = def.FinalsFormat
	}
	if s.AceWinsRequired < 2 {
		s.AceWinsRequired = 2
	} else if s.AceWinsRequired > 5 {
		s.AceWinsRequired = 5
	}
	return s
}

// ToRaceSetupConfig merges per-stage settings onto `base` for stage heat generation.
func (s StageSettings) ToRaceSetupConfig(base RaceSetupConfig, format StageFormat) RaceSetupConfig {
	norm := s.Normalized(base, format)
	out := base.Normalized()
	out.Structure = StructureSingleStage
	out.MainFormat = format
	out.PilotsPerHeat = norm.PilotsPerHeat
	out.SeatChannels = append([]uint8(nil), norm.SeatChannels...)
	out.QualifyingRounds = norm.QualifyingRounds
	out.QualifyingMetric = norm.QualifyingMetric
	out.MaxPacksPerPilot = norm.MaxPacksPerPilot
	out.PointsRounds = norm.PointsRounds
	out.FinalsFormat = norm.FinalsFormat
	out.AceWinsRequired = norm.AceWinsRequired
	out.WinnersAdvantageAce = norm.WinnersAdvantageAce
	if format == FormatQualifying || format == FormatOpenQualifier {
		out.QualifyingTargetLaps = norm.TargetLaps
		out.QualifyingTimeLimitSec = norm.TimeLimitSec
		out.TimeLimitSec = norm.TimeLimitSec
	} else {
		out.TargetLaps = norm.TargetLaps
		out.TimeLimitSec = norm.TimeLimitSec
	}
	return out
}

// RaceStage represents one stage block (1..5) in the high-level Format DAG.
type RaceStage struct {
	ID                  string               `json:"id"`
	Index               int                  `json:"index"` // 1..MaxRaceStages
	Title               string               `json:"title"`
	Format              StageFormat          `json:"format"`
	Customized          bool                 `json:"customized,omitempty"`
	Status              StageStatus          `json:"status"`
	PausedByUser        bool                 `json:"pausedByUser,omitempty"`
	CompletedEarly      bool                 `json:"completedEarly,omitempty"`
	PrerequisitesMet    bool                 `json:"prerequisitesMet"`
	WaitingOnStageNames []string             `json:"waitingOnStageNames,omitempty"`
	Dangling            bool                 `json:"dangling,omitempty"`
	DanglingReason      string               `json:"danglingReason,omitempty"`
	ChampionSlotIndex   int                  `json:"championSlotIndex,omitempty"`
	ChampionCallsign    string               `json:"championCallsign,omitempty"`
	Standings           []TournamentStanding `json:"standings,omitempty"`
	Settings            StageSettings        `json:"settings"`
	HasPos              bool                 `json:"hasPos,omitempty"`
	PosX                float64              `json:"posX,omitempty"`
	PosY                float64              `json:"posY,omitempty"`
	PilotsNodeHasPos    bool                 `json:"pilotsNodeHasPos,omitempty"`
	PilotsNodePosX      float64              `json:"pilotsNodePosX,omitempty"`
	PilotsNodePosY      float64              `json:"pilotsNodePosY,omitempty"`
}

// StageConnection represents a directed advancement wire between two Stage blocks on the Format DAG.
type StageConnection struct {
	ID             string           `json:"id"`
	FromStageID    string           `json:"fromStageId"`
	ToStageID      string           `json:"toStageId"`
	FromStageIndex int              `json:"fromStageIndex"`
	ToStageIndex   int              `json:"toStageIndex"`
	FromPort       string           `json:"fromPort,omitempty"` // "left" | "top" | "right" | "bottom"
	ToPort         string           `json:"toPort,omitempty"`   // "left" | "top" | "right" | "bottom"
	Mode           string           `json:"mode"`               // "all_pilots" | "top_n" | "seed_range"
	Count          int              `json:"count,omitempty"`    // For "top_n"
	SeedStart      int              `json:"seedStart,omitempty"`
	SeedEnd        int              `json:"seedEnd,omitempty"`
	RankingMetric  QualifyingMetric `json:"rankingMetric,omitempty"`
	Invalid        bool             `json:"invalid,omitempty"`
	InvalidReason  string           `json:"invalidReason,omitempty"`
}

// MultiGPRaceLink tracks synchronization metadata when a SlapRF Race is linked to a MultiGP race.
type MultiGPRaceLink struct {
	RaceID           int               `json:"raceId"`
	RaceName         string            `json:"raceName"`
	ChapterID        int               `json:"chapterId,omitempty"`
	ChapterName      string            `json:"chapterName,omitempty"`
	ScoringFormat    int               `json:"scoringFormat"`
	ScoringDisabled  bool              `json:"scoringDisabled,omitempty"`
	IsZippyQ         bool              `json:"isZippyQ,omitempty"`
	ImportMode       string            `json:"importMode,omitempty"` // "schedule" | "zippyq" | "bracket"
	SyncedCycleCount int               `json:"syncedCycleCount,omitempty"`
	SyncedHeatAt     map[string]string `json:"syncedHeatAt,omitempty"`  // heatID -> ISO timestamp of last MultiGP push
	UnsyncedHeats    map[string]bool   `json:"unsyncedHeats,omitempty"` // heatID -> true when edited/committed since last push
	OverallSyncedAt  string            `json:"overallSyncedAt,omitempty"`
	LastSyncedAt     string            `json:"lastSyncedAt,omitempty"`
}

// RaceTournamentState is the complete Race Mode state returned to the UI and persisted to storage.
type RaceTournamentState struct {
	RaceID              string               `json:"raceId,omitempty"`
	MGPLink             *MultiGPRaceLink     `json:"mgpLink,omitempty"`
	Tags                []string             `json:"tags,omitempty"`
	TemplateID          string               `json:"templateId,omitempty"` // "" = empty, "custom", "double_elimination", "qual_double_elim", "single_elimination", "qual_mains", "chase_the_ace", "round_robin"
	Lifecycle           RaceLifecycle        `json:"lifecycle,omitempty"`
	EmergencyStopped    bool                 `json:"emergencyStopped,omitempty"`
	StatusReason        string               `json:"statusReason,omitempty"`
	CreatedAt           string               `json:"createdAt,omitempty"`
	UpdatedAt           string               `json:"updatedAt,omitempty"`
	Mode                OperatingMode        `json:"mode"`
	Config              RaceSetupConfig      `json:"config"`
	TrackInitialized    bool                 `json:"trackInitialized,omitempty"`
	TrackSnapshot       []TrackGate          `json:"trackSnapshot,omitempty"`
	Rules               *TimingRules         `json:"rules,omitempty"`
	Roster              []EventPilot         `json:"roster,omitempty"` // Per-race pilot check-in & Active/Away/Forfeit attendance
	Stages              []RaceStage          `json:"stages,omitempty"`
	StageConnections    []StageConnection    `json:"stageConnections,omitempty"`
	FormatInvalidReason string               `json:"formatInvalidReason,omitempty"`
	Rounds              []RaceRound          `json:"rounds,omitempty"`
	Connections         []RoundConnection    `json:"connections,omitempty"`
	Generated           bool                 `json:"generated"`
	ActiveStageIndex    int                  `json:"activeStageIndex"` // 1..MaxRaceStages
	TotalStages         int                  `json:"totalStages"`      // 1..MaxRaceStages
	QualifyingComplete  bool                 `json:"qualifyingComplete"`
	CanStartStage2      bool                 `json:"canStartStage2"`
	Stage2SeededEarly   bool                 `json:"stage2SeededEarly,omitempty"`
	ActiveHeatID        string               `json:"activeHeatId"`
	NextReadyHeatID     string               `json:"nextReadyHeatId"`
	ChampionSlotIndex   int                  `json:"championSlotIndex,omitempty"`
	ChampionCallsign    string               `json:"championCallsign,omitempty"`
	IsComplete          bool                 `json:"isComplete"`
	Heats               []RaceHeat           `json:"heats"`
	Edges               []BracketEdge        `json:"edges"`
	Standings           []TournamentStanding `json:"standings"`
	QualStandings       []TournamentStanding `json:"qualStandings,omitempty"`
}
