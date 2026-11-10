export type TimerRole = "START_FINISH" | "SECTOR_GATE";

export type SectorBadge =
  | "OVERALL_BEST"
  | "PERSONAL_BEST"
  | "NORMAL"
  | "OFF_PACE";

export interface PilotSlot {
  slotIndex: number;
  callsign: string;
  enabled: boolean;
  band: number;
  channel: number;
  frequencyMhz: number;
  enterThreshold: number;
  exitThreshold: number;
  attenuationGain: number;
  color: string;
}

export interface DetectedTimer {
  timerId: number;
  timerLabel: string;
  color?: string;
  isHub: boolean;
  firmwareVersion?: string;
  /** Stable 8-hex-digit board fingerprint stamped at flash time. */
  fingerprint?: string;
  batteryMv: number;
  batteryPct: number;
  noiseFloorDbm: number;
  online: boolean;
  lastSeenAt: string;
}

export interface TrackNode {
  gateId: number;
  /** Physical XIAO timer ID placed at this track node (0 = no timer assigned). */
  assignedTimerId: number;
  /** Flashed hardware ID / name stamped onto the timer (e.g. "Hub-1", "Blue-Timer"). */
  timerLabel?: string;
  /** Running firmware release version on the assigned timer (e.g. "v0.1.4"). */
  firmwareVersion?: string;
  /** Optional display-name override configured in the Track editor. */
  name: string;
  /** Hex color originating from the Timers section in System. */
  color?: string;
  role: TimerRole;
  trackOrder: number;
  mapX: number;
  mapY: number;
  batteryMv: number;
  batteryPct: number;
  noiseFloorDbm: number;
  lastRssi: number[];
  /** Per-pilot calibrated enter threshold at this node (same order as lastRssi); 0 = pilot default. */
  enterThresholds: number[];
  /** This node's own timing-rule values; missing fields use the global rules. */
  ruleOverrides: GateRuleOverrides;
  online: boolean;
  lastSeenAt: string;
  framesRxCount: number;
}

/** Calibrates one track node for one pilot (`POST /api/thresholds`). enterDbm 0 = back to the pilot's default. */
export interface GateThresholdUpdate {
  gateId: number;
  slotIndex: number;
  enterDbm: number;
}

/**
 * Edit to one track node (`POST /api/track/update`). An empty name means "Gate N" by position.
 * trackOrder (0-based) moves the node; omit it to leave the node where it is.
 * assignedTimerId binds a physical detected timer (1..16) or 0 to unassign.
 */
export interface TrackNodeUpdate {
  gateId: number;
  name: string;
  color?: string;
  role: TimerRole;
  trackOrder?: number;
  assignedTimerId?: number;
}
export type GateUpdate = TrackNodeUpdate;

export interface TimerTelemetryFrame {
  timerId: number;
  seqNum: number;
  timestampUs: number;
  rssi: number[];
  batteryMv: number;
  noiseFloorDbm: number;
}

export interface GateCrossingEvent {
  eventId: number;
  gateId: number;
  gateName: string;
  isStartFinish: boolean;
  startedLap?: boolean;
  slotIndex: number;
  callsign: string;
  frequencyMhz: number;
  timestampUs: number;
  peakRssiDbm: number;
  laprfPeakHeight: number;
  beamwidthMs: number;
  estimatedSpeedMph: number;
  passingNumber: number;
}

export interface SectorSplit {
  sectorIndex: number;
  fromGateId: number;
  toGateId: number;
  label: string;
  splitSeconds: number;
  deltaToBestSec: number;
  exitSpeedMph: number;
  badge: SectorBadge;
}

export interface LapRecord {
  lapId: number;
  slotIndex: number;
  callsign: string;
  lapNumber: number;
  lapTimeSec: number;
  deltaToBest: number;
  sectors: SectorSplit[];
  completedAtUs: number;
  isBestLap: boolean;
}

export interface SectorBottleneckStat {
  sectorIndex: number;
  label: string;
  fromGateId: number;
  toGateId: number;
  bestSplitSec: number;
  averageSplitSec: number;
  stdDevSec: number;
  avgTimeLostSec: number;
  averageExitSpeedMph: number;
}

export interface PilotTrackSummary {
  slotIndex: number;
  callsign: string;
  color: string;
  channelLabel: string;
  lapsCompleted: number;
  lastLapSec: number;
  bestLapSec: number;
  theoreticalBestSec: number;
  potentialGainSec: number;
  currentSectorIndex: number;
  lastGateId: number;
  sectorStats: SectorBottleneckStat[];
}

/** LapRF emulator counters from the WASM engine (enabled/relay state lives in services/livetime_relay.ts). */
export interface LiveTimeStatus {
  connectedClients: number;
  detectionsSent: number;
  statusFramesSent: number;
  lastRfSetupSync: string;
  raceArmedByHost: boolean;
}

export type SimPilotStatus =
  | "FLYING"
  | "AVOIDING"
  | "LANDING"
  | "CRASHED_VTX_ON"
  | "TURTLE_RECOVERY"
  | "TURTLE_FAILED"
  | "CRASHED_WAITING_RECOVERY"
  | "WALKING_RECOVERY"
  | "PIT_SWAP"
  | "LAUNCH_HOLD"
  | "CHARGING_WAIT"
  | "PILOT_BREAK"
  | "PAUSED";

export type SimBatteryPackState = "IN_QUAD" | "READY" | "CHARGING";

export interface SimBatteryPack {
  packIndex: number;
  pct: number;
  volts: number;
  state: SimBatteryPackState;
}

export interface SimPilotState {
  slotIndex: number;
  callsign: string;
  color: string;
  channel: number;
  frequencyMhz: number;
  enabled: boolean;
  status: SimPilotStatus;
  batteryPct: number;
  batteryVolts: number;
  packs: SimBatteryPack[];
  trackProgress: number;
  speedMph: number;
  altitudeMeters: number;
  vtxActive: boolean;
  nearestGateLabel: string;
  stateRemainingSec: number;
  crashesCount: number;
  packsFlown: number;
}

export interface SimTimerState {
  timerId: number;
  timerLabel: string;
  color: string;
  isHub: boolean;
  firmwareVersion: string;
  fingerprint: string;
  poweredOn: boolean;
  online: boolean;
  assignedGateName: string;
  batteryMv: number;
  batteryPct: number;
  noiseFloorDbm: number;
}

export interface SimState {
  running: boolean;
  trackWalkerActive: boolean;
  autoPracticeEvents: boolean;
  trackWalkerSecLeft: number;
  pilots: SimPilotState[];
  timers: SimTimerState[];
}

export interface FullStateResponse {
  serverTimestampUs?: number;
  pilots: PilotSlot[];
  gates: TrackNode[];
  timers?: DetectedTimer[];
  laps: LapRecord[];
  crossings: GateCrossingEvent[];
  filtered: FilteredDetection[];
  summaries: PilotTrackSummary[];
  rules: TimingRules;
  simulatorRunning: boolean;
  simState?: SimState;
  raceArmed: boolean;
  liveTimeStatus: LiveTimeStatus;
}

/** Lightweight periodic status poll (`GET /api/status`). */
export interface StatusResponse {
  serverTimestampUs?: number;
  gates: TrackNode[];
  timers?: DetectedTimer[];
  simulatorRunning: boolean;
  simState?: SimState;
  raceArmed: boolean;
  liveTimeStatus: LiveTimeStatus;
}

/** Guardrails applied to every RF detection before it counts (see internal/domain/rules.go). */
export interface TimingRules {
  minLapSec: number;
  maxLapSec: number;
  gateCooldownSec: number;
  minSectionSec: number;
  echoWindowSec: number;
}

/** The rules a single gate can override (max lap is about the whole lap, so it stays global). */
export type GateRuleKey = "minLapSec" | "gateCooldownSec" | "minSectionSec" | "echoWindowSec";
export type GateRuleOverrides = Partial<Record<GateRuleKey, number>>;

export type FilterReason = "COOLDOWN" | "TOO_SOON" | "ECHO" | "MIN_LAP" | "LAP_TOO_LONG";

/** A detection the timing rules set aside (or a lap that was too long to count). */
export interface FilteredDetection {
  timestampUs: number;
  gateId: number;
  slotIndex: number;
  callsign: string;
  reason: FilterReason;
  detail: string;
  peakRssiDbm: number;
}

export interface StreamEnvelope {
  type: "connected" | "telemetry" | "crossing" | "filtered" | "lap" | "config";
  payload?: unknown;
}
