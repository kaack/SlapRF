package domain

// SimPilotStatus represents the live practice state of a simulated drone & pilot.
type SimPilotStatus string

const (
	SimStatusFlying          SimPilotStatus = "FLYING"
	SimStatusAvoiding        SimPilotStatus = "AVOIDING"
	SimStatusCrashedVtxOn    SimPilotStatus = "CRASHED_VTX_ON"
	SimStatusTurtleRecovery  SimPilotStatus = "TURTLE_RECOVERY"
	SimStatusTurtleFailed    SimPilotStatus = "TURTLE_FAILED"
	SimStatusCrashedRecovery SimPilotStatus = "CRASHED_WAITING_RECOVERY"
	SimStatusWalkingRecovery SimPilotStatus = "WALKING_RECOVERY"
	SimStatusPitSwap         SimPilotStatus = "PIT_SWAP"
	SimStatusPaused          SimPilotStatus = "PAUSED"
)

// SimPilotState describes the live physical state of a simulated pilot's quadcopter.
type SimPilotState struct {
	SlotIndex         int            `json:"slotIndex"`
	Callsign          string         `json:"callsign"`
	Color             string         `json:"color"`
	Channel           uint8          `json:"channel"`
	FrequencyMHz      uint16         `json:"frequencyMhz"`
	Enabled           bool           `json:"enabled"`
	Status            SimPilotStatus `json:"status"`
	BatteryPct        uint8          `json:"batteryPct"`
	BatteryVolts      float64        `json:"batteryVolts"`
	TrackProgress     float64        `json:"trackProgress"` // 0..1 around the loop
	SpeedMph          float64        `json:"speedMph"`
	AltitudeMeters    float64        `json:"altitudeMeters"`
	VtxActive         bool           `json:"vtxActive"`
	NearestGateLabel  string         `json:"nearestGateLabel"`
	StateRemainingSec float64        `json:"stateRemainingSec"`
	CrashesCount      int            `json:"crashesCount"`
	PacksFlown        int            `json:"packsFlown"`
}

// SimTimerState describes a simulated XIAO ESP32-C5 hardware timer in the Sim tab.
type SimTimerState struct {
	PuckID           uint8   `json:"puckId"`
	PuckLabel        string  `json:"puckLabel"`
	Color            string  `json:"color"`
	IsHub            bool    `json:"isHub"`
	FirmwareVersion  string  `json:"firmwareVersion"`
	PoweredOn        bool    `json:"poweredOn"`
	Online           bool    `json:"online"`
	AssignedGateName string  `json:"assignedGateName"`
	BatteryMv        uint16  `json:"batteryMv"`
	BatteryPct       uint8   `json:"batteryPct"`
	NoiseFloorDbm    float32 `json:"noiseFloorDbm"`
}

// SimState is the full snapshot of the practice simulator exposed to the Sim tab.
type SimState struct {
	Running            bool            `json:"running"`
	TrackWalkerActive  bool            `json:"trackWalkerActive"`
	AutoPracticeEvents bool            `json:"autoPracticeEvents"`
	TrackWalkerSecLeft float64         `json:"trackWalkerSecLeft"`
	Pilots             []SimPilotState `json:"pilots"`
	Timers             []SimTimerState `json:"timers"`
}
