package domain

// SimPilotStatus represents the live practice state of a simulated drone & pilot.
type SimPilotStatus string

const (
	SimStatusFlying          SimPilotStatus = "FLYING"
	SimStatusAvoiding        SimPilotStatus = "AVOIDING"
	SimStatusLanding         SimPilotStatus = "LANDING"
	SimStatusCrashedVtxOn    SimPilotStatus = "CRASHED_VTX_ON"
	SimStatusTurtleRecovery  SimPilotStatus = "TURTLE_RECOVERY"
	SimStatusTurtleFailed    SimPilotStatus = "TURTLE_FAILED"
	SimStatusCrashedRecovery SimPilotStatus = "CRASHED_WAITING_RECOVERY"
	SimStatusWalkingRecovery SimPilotStatus = "WALKING_RECOVERY"
	SimStatusPitSwap         SimPilotStatus = "PIT_SWAP"
	SimStatusLaunchHold      SimPilotStatus = "LAUNCH_HOLD"
	SimStatusChargingWait    SimPilotStatus = "CHARGING_WAIT"
	SimStatusPilotBreak      SimPilotStatus = "PILOT_BREAK"
	SimStatusPaused          SimPilotStatus = "PAUSED"
)

// SimBatteryPackState represents the state of one of a pilot's 3 6S LiPo flight packs.
type SimBatteryPackState string

const (
	SimPackInQuad   SimBatteryPackState = "IN_QUAD"
	SimPackReady    SimBatteryPackState = "READY"
	SimPackCharging SimBatteryPackState = "CHARGING"
)

// SimBatteryPack describes one of the 3 6S LiPo batteries owned by a simulated pilot.
type SimBatteryPack struct {
	PackIndex int                 `json:"packIndex"` // 1..3
	Pct       uint8               `json:"pct"`       // 0..100%
	Volts     float64             `json:"volts"`     // 21.0..25.2 V
	State     SimBatteryPackState `json:"state"`     // "IN_QUAD", "READY", or "CHARGING"
}

// SimPilotState describes the live physical state of a simulated pilot's quadcopter.
type SimPilotState struct {
	SlotIndex         int               `json:"slotIndex"`
	Callsign          string            `json:"callsign"`
	Color             string            `json:"color"`
	Band              Band              `json:"band"`
	Channel           uint8             `json:"channel"`
	FrequencyMHz      uint16            `json:"frequencyMhz"`
	Enabled           bool              `json:"enabled"`
	Status            SimPilotStatus    `json:"status"`
	BatteryPct        uint8             `json:"batteryPct"`
	BatteryVolts      float64           `json:"batteryVolts"`
	Packs             [3]SimBatteryPack `json:"packs"`
	TrackProgress     float64           `json:"trackProgress"` // 0..1 around the loop
	SpeedMph          float64           `json:"speedMph"`
	AltitudeMeters    float64           `json:"altitudeMeters"`
	VtxActive         bool              `json:"vtxActive"`
	NearestGateLabel  string            `json:"nearestGateLabel"`
	StateRemainingSec float64           `json:"stateRemainingSec"`
	CrashesCount      int               `json:"crashesCount"`
	PacksFlown        int               `json:"packsFlown"`
}

// SimTimerState describes a simulated XIAO ESP32-C5 hardware timer in the Sim tab.
type SimTimerState struct {
	TimerID          uint8                     `json:"timerId"`
	TimerLabel       string                    `json:"timerLabel"`
	Color            string                    `json:"color"`
	IsHub            bool                      `json:"isHub"`
	Unflashed        bool                      `json:"unflashed,omitempty"`
	FirmwareVersion  string                    `json:"firmwareVersion"`
	Fingerprint      string                    `json:"fingerprint"`
	PoweredOn        bool                      `json:"poweredOn"`
	Online           bool                      `json:"online"`
	AssignedGateName string                    `json:"assignedGateName"`
	BatteryMv        uint16                    `json:"batteryMv"`
	BatteryPct       uint8                     `json:"batteryPct"`
	NoiseFloorDbm    float32                   `json:"noiseFloorDbm"`
	LastRSSI         [MaxPilotPoolSize]float32 `json:"lastRssi"`
}

// SimLapRFUnit describes a simulated ImmersionRC LapRF 8-Way timer puck in the Sim tab.
type SimLapRFUnit struct {
	TimerID          uint8                  `json:"timerId"`
	Label            string                 `json:"label"`
	Transport        string                 `json:"transport,omitempty"` // "ethernet" | "usb"
	PortName         string                 `json:"portName,omitempty"`  // e.g. "SIM-LAPRF-USB1"
	Host             string                 `json:"host"`
	Port             int                    `json:"port"`
	Color            string                 `json:"color"`
	PoweredOn        bool                   `json:"poweredOn"`
	Connected        bool                   `json:"connected"`
	Online           bool                   `json:"online"`
	AssignedGateName string                 `json:"assignedGateName"`
	VoltageMv        uint16                 `json:"voltageMv"`
	GateArmed        bool                   `json:"gateArmed"`
	RTCDeltaMs       float64                `json:"rtcDeltaMs"`
	SlotRSSI         [MaxPilotSlots]float32 `json:"slotRssi"`
	SlotFreqsMHz     [MaxPilotSlots]uint16  `json:"slotFreqsMhz,omitempty"`
	SlotThresholds   [MaxPilotSlots]float32 `json:"slotThresholds,omitempty"`
}

// RHScanPass holds one completed (or in-progress live) 0..255 RSSI spectrum sweep pass from a RotorHazard USB device.
type RHScanPass struct {
	Seq     uint64    `json:"seq"`
	Start   int       `json:"start"`
	Stop    int       `json:"stop"`
	Step    int       `json:"step"`
	PassMs  int       `json:"passMs"`
	Live    bool      `json:"live"`
	Partial bool      `json:"partial,omitempty"`
	Values  []float32 `json:"values"`
}

// SimRotorHazardUnit describes a simulated RotorHazard timing device (Raspberry Pi server on :5000
// in RotorHazard Network mode, or an 8-node USB serial node in RotorHazard USB mode) in the Sim tab.
type SimRotorHazardUnit struct {
	TimerID          uint8                  `json:"timerId"`
	Label            string                 `json:"label"`
	Transport        string                 `json:"transport,omitempty"` // "network" | "usb"
	PortName         string                 `json:"portName,omitempty"`  // e.g. "SIM-RH-USB1"
	BaudRate         int                    `json:"baudRate,omitempty"`  // e.g. 115200 or 921600
	APILevel         int                    `json:"apiLevel,omitempty"`  // e.g. 36
	Host             string                 `json:"host"`
	Port             int                    `json:"port"`
	NodeCount        int                    `json:"nodeCount"`
	AdminUser        string                 `json:"adminUser,omitempty"`
	AdminPass        string                 `json:"adminPass,omitempty"`
	ServerVersion    string                 `json:"serverVersion,omitempty"`
	ServerHostname   string                 `json:"serverHostname,omitempty"`
	Color            string                 `json:"color"`
	PoweredOn        bool                   `json:"poweredOn"`
	Connected        bool                   `json:"connected"`
	Online           bool                   `json:"online"`
	AuthOK           bool                   `json:"authOk"`
	AssignedGateName string                 `json:"assignedGateName"`
	GateArmed        bool                   `json:"gateArmed"`
	ClockDeltaMs     float64                `json:"clockDeltaMs"`
	HeartbeatsRx     uint64                 `json:"heartbeatsRx,omitempty"`
	PassesRx         uint64                 `json:"passesRx,omitempty"`
	SlotRSSI         [MaxPilotSlots]float32 `json:"slotRssi"`
	CrossingFlag     [MaxPilotSlots]bool    `json:"crossingFlag,omitempty"`
	NodeEnterLevels  [MaxPilotSlots]uint8   `json:"nodeEnterLevels,omitempty"`
	NodeExitLevels   [MaxPilotSlots]uint8   `json:"nodeExitLevels,omitempty"`
	NodeFreqsMHz     [MaxPilotSlots]uint16  `json:"nodeFreqsMhz,omitempty"`
	CpuTempC         float32                `json:"cpuTempC,omitempty"`
	EnvSummary       string                 `json:"envSummary,omitempty"`
	ScanLive         bool                   `json:"scanLive,omitempty"`
	LastScan         *RHScanPass            `json:"lastScan,omitempty"`
}

// SimState is the full snapshot of the practice simulator exposed to the Sim tab.
type SimState struct {
	Running            bool                 `json:"running"`
	SpeedMultiplier    int                  `json:"speedMultiplier"`
	TrackWalkerActive  bool                 `json:"trackWalkerActive"`
	AutoPracticeEvents bool                 `json:"autoPracticeEvents"`
	TrackWalkerSecLeft float64              `json:"trackWalkerSecLeft"`
	Pilots             []SimPilotState      `json:"pilots"`
	Timers             []SimTimerState      `json:"timers"`
	LapRFUnits         []SimLapRFUnit       `json:"laprfUnits,omitempty"`
	RotorHazardUnits   []SimRotorHazardUnit `json:"rotorhazardUnits,omitempty"`
}
