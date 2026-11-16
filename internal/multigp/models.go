package multigp

// MultiGP ScoringFormat constants (MultiGP WebService v1.0.4).
const (
	ScoringAggregateLaps       = 0 // Aggregate Laps / Points
	ScoringFastestLap          = 1 // Fastest Single Lap
	ScoringFastest3Consecutive = 2 // Fastest 3 Consecutive Laps
	ScoringFastest2Consecutive = 6 // Fastest 2 Consecutive Laps
)

// FindChapterResponse is returned by POST /chapter/findChapterFromApiKey.
type FindChapterResponse struct {
	Status            bool   `json:"status"`
	StatusDescription string `json:"statusDescription,omitempty"`
	ChapterID         int    `json:"chapterId,omitempty"`
	ChapterName       string `json:"chapterName,omitempty"`
}

// RaceSummary is one row in POST /race/listForChapter.
type RaceSummary struct {
	ID                        string `json:"id"`
	Name                      string `json:"name"`
	StartDate                 string `json:"startDate,omitempty"`
	ChapterID                 string `json:"chapterId,omitempty"`
	ChapterName               string `json:"chapterName,omitempty"`
	ScoringFormat             int    `json:"scoringFormat"`
	DisableSlotAutoPopulation int    `json:"disableSlotAutoPopulation"`
	PilotCount                int    `json:"pilotCount"`
	CycleCount                int    `json:"cycleCount"`
}

// ListForChapterResponse is returned by POST /race/listForChapter.
type ListForChapterResponse struct {
	Status            bool          `json:"status"`
	StatusDescription string        `json:"statusDescription,omitempty"`
	Data              []RaceSummary `json:"data"`
}

// RaceEntry represents a pilot registered in a MultiGP race (`data.entries[]`).
type RaceEntry struct {
	PilotID     int    `json:"pilotId"`
	UserName    string `json:"userName"`
	FirstName   string `json:"firstName,omitempty"`
	LastName    string `json:"lastName,omitempty"`
	DisplayName string `json:"displayName,omitempty"`
	Phonetic    string `json:"phonetic,omitempty"`
	Band        string `json:"band,omitempty"`
	Channel     string `json:"channel,omitempty"`
	Frequency   int    `json:"frequency,omitempty"`
}

// HeatEntry represents one pilot slot in a scheduled MultiGP heat (`rounds[].heats[].entries[]`),
// including any synced `assignSlot` timing results.
type HeatEntry struct {
	Slot                        int     `json:"slot"` // 1..8
	PilotID                     int     `json:"pilotId"`
	UserName                    string  `json:"userName,omitempty"`
	Band                        string  `json:"band,omitempty"`
	Channel                     string  `json:"channel,omitempty"`
	Frequency                   int     `json:"frequency,omitempty"`
	Score                       float64 `json:"score,omitempty"`
	TotalLaps                   int     `json:"totalLaps,omitempty"`
	TotalTime                   float64 `json:"totalTime,omitempty"`
	FastestLapTime              float64 `json:"fastestLapTime,omitempty"`
	Fastest2ConsecutiveLapsTime float64 `json:"fastest2ConsecutiveLapsTime,omitempty"`
	Fastest3ConsecutiveLapsTime float64 `json:"fastest3ConsecutiveLapsTime,omitempty"`
	SyncedAt                    string  `json:"syncedAt,omitempty"`
}

// ScheduleHeat represents one heat inside a MultiGP round.
type ScheduleHeat struct {
	HeatNumber int         `json:"heatNumber"` // 1..H
	Name       string      `json:"name"`
	Entries    []HeatEntry `json:"entries"`
}

// ScheduleRound represents one round (`cycle`) inside a MultiGP race schedule.
type ScheduleRound struct {
	RoundNumber int            `json:"roundNumber"` // 1..R
	Name        string         `json:"name"`
	IsZippyQ    bool           `json:"isZippyQ,omitempty"`
	Heats       []ScheduleHeat `json:"heats"`
}

// RaceSchedule wraps `rounds` inside `RaceViewData`.
type RaceSchedule struct {
	Rounds []ScheduleRound `json:"rounds"`
}

// OverallResultEntry represents one podium/final placement pushed via `captureOverallRaceResult`.
type OverallResultEntry struct {
	OrderNumber int    `json:"orderNumber"` // 1 = 1st place
	PilotID     int    `json:"pilotId"`
	UserName    string `json:"userName,omitempty"`
}

// RaceViewData is the full race payload returned by POST /race/view?id={raceId}.
type RaceViewData struct {
	ID                        int                  `json:"id"`
	Name                      string               `json:"name"`
	StartDate                 string               `json:"startDate,omitempty"`
	ChapterID                 int                  `json:"chapterId"`
	ChapterName               string               `json:"chapterName"`
	RaceType                  int                  `json:"raceType"`
	ScoringFormat             int                  `json:"scoringFormat"`
	ScoringDisabled           int                  `json:"scoringDisabled"`
	DisableSlotAutoPopulation int                  `json:"disableSlotAutoPopulation"` // 0 = Controlled, 1 = ZippyQ
	AutoQueueZippyQ           bool                 `json:"autoQueueZippyQ,omitempty"`
	CycleCount                int                  `json:"cycleCount"`
	MaxLaps                   int                  `json:"maxLaps"`
	RaceTimeSec               int                  `json:"raceTimeSec"`
	Entries                   []RaceEntry          `json:"entries"`
	Schedule                  RaceSchedule         `json:"schedule"`
	OverallResults            []OverallResultEntry `json:"overallResults,omitempty"`
	OverallSyncedAt           string               `json:"overallSyncedAt,omitempty"`
}

// RaceViewResponse is returned by POST /race/view.
type RaceViewResponse struct {
	Status            bool         `json:"status"`
	StatusDescription string       `json:"statusDescription,omitempty"`
	Data              RaceViewData `json:"data"`
}

// AdditionalRoundsResponse is returned by POST /race/getAdditionalRounds.
type AdditionalRoundsResponse struct {
	Status            bool         `json:"status"`
	StatusDescription string       `json:"statusDescription,omitempty"`
	CycleCount        int          `json:"cycleCount"`
	Data              RaceSchedule `json:"data"`
}

// AssignSlotData is the inner `data` object sent to POST /race/assignSlot.
type AssignSlotData struct {
	PilotID                     int     `json:"pilotId"`
	PilotCallsign               string  `json:"pilotCallsign,omitempty"`
	Score                       float64 `json:"score"`
	TotalLaps                   int     `json:"totalLaps"`
	TotalTime                   float64 `json:"totalTime"`
	FastestLapTime              float64 `json:"fastestLapTime"`
	Fastest2ConsecutiveLapsTime float64 `json:"fastest2ConsecutiveLapsTime"`
	Fastest3ConsecutiveLapsTime float64 `json:"fastest3ConsecutiveLapsTime"`
}

// AssignSlotRequest is the request body for POST /race/assignSlot?id=&cycle=&heat=&slot=.
type AssignSlotRequest struct {
	APIKey string         `json:"apiKey"`
	Data   AssignSlotData `json:"data"`
}

// CaptureOverallData is the inner `data` object sent to POST /race/captureOverallRaceResult.
type CaptureOverallData struct {
	RaceID         int                  `json:"raceId"`
	BracketResults []OverallResultEntry `json:"bracketResults"`
}

// CaptureOverallRequest is the request body for POST /race/captureOverallRaceResult?id={raceId}.
type CaptureOverallRequest struct {
	APIKey string             `json:"apiKey"`
	Data   CaptureOverallData `json:"data"`
}

// GenericStatusResponse is the standard MultiGP status envelope.
type GenericStatusResponse struct {
	Status            bool   `json:"status"`
	StatusDescription string `json:"statusDescription,omitempty"`
}
