export type TimerRole = "START_FINISH" | "SECTOR_GATE";
export type TimingHardwareMode =
  | "slaprf"
  | "slaprf_ble"
  | "slaprf_net"
  | "laprf"
  | "laprf_usb"
  | "rotorhazard"
  | "rotorhazard_usb";

export function isSlapRFMode(mode?: TimingHardwareMode | string | null): boolean {
  return !mode || mode === "slaprf" || mode === "slaprf_ble" || mode === "slaprf_net";
}

export function isLapRFMode(mode?: TimingHardwareMode | string | null): boolean {
  return mode === "laprf" || mode === "laprf_usb";
}

export function isRotorHazardMode(mode?: TimingHardwareMode | string | null): boolean {
  return mode === "rotorhazard" || mode === "rotorhazard_usb";
}

export function normalizeTimingHardwareMode(mode?: string | null): TimingHardwareMode {
  if (mode === "slaprf_ble") return "slaprf_ble";
  if (mode === "slaprf_net") return "slaprf_net";
  if (mode === "laprf") return "laprf";
  if (mode === "laprf_usb") return "laprf_usb";
  if (mode === "rotorhazard") return "rotorhazard";
  if (mode === "rotorhazard_usb") return "rotorhazard_usb";
  return "slaprf";
}

export type SectorBadge =
  | "OVERALL_BEST"
  | "PERSONAL_BEST"
  | "NORMAL"
  | "OFF_PACE";

export interface PilotSlot {
  slotIndex: number;
  callsign: string;
  phoneticName?: string;
  enabled: boolean;
  band: number;
  channel: number;
  frequencyMhz: number;
  enterThreshold: number;
  exitThreshold: number;
  laprfThreshold?: number;
  rhEnterThreshold?: number;
  rhExitThreshold?: number;
  attenuationGain: number;
  color: string;
  mgpPilotId?: number;
  mgpUserName?: string;
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
  lastRssi?: number[];
  framesRxCount?: number;
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
  /** Per-pilot calibrated exit threshold at this node (same order as lastRssi); 0 = pilot default / derived gap. */
  exitThresholds?: number[];
  /** Per-pilot calibrated LapRF threshold at this node (300..3500); 0 = pilot default. */
  laprfThresholds?: number[];
  /** Per-pilot calibrated RotorHazard EnterAt / ExitAt thresholds at this node (10..250); 0 = pilot default. */
  rhEnterThresholds?: number[];
  rhExitThresholds?: number[];
  /** This node's own timing-rule values across all pilots; missing fields use the global rules. */
  ruleOverrides: GateRuleOverrides;
  /** Per-pilot timing-rule overrides at this node (keyed by 1-based PilotSlot.slotIndex). */
  pilotRuleOverrides?: Record<number, GateRuleOverrides>;
  online: boolean;
  lastSeenAt: string;
  framesRxCount: number;
}

/** Calibrates one track node for one pilot (`PUT /v1/track/thresholds`). enterDbm 0 = back to the pilot's default. */
export interface GateThresholdUpdate {
  gateId: number;
  slotIndex: number;
  enterDbm: number;
  exitDbm?: number;
  laprfThreshold?: number;
  rhEnterThreshold?: number;
  rhExitThreshold?: number;
  /** True when set by Auto-calibrate so background 30 s auto-calibration continues adapting. */
  auto?: boolean;
}

/**
 * Edit to one track node (`PUT /v1/track/gates/{gateId}`). An empty name means "Gate N" by position.
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
  holdMs?: number;
  aboveEnterMs?: number;
  aboveEnterAreaDbSec?: number;
  passAreaDbSec?: number;
  isStepBurst?: boolean;
  passingNumber: number;
  manual?: boolean;
  invalidReason?: FilterReason;
  invalidDetail?: string;
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
  completedAtMs?: number;
  isBestLap: boolean;
  invalidated?: boolean;
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

/** LapRF 8-Way emulator counters from the timing engine (enabled/relay state lives in services/laprf_emulator_relay.ts). */
export interface LapRFEmulatorStatus {
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
  band?: number;
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
  unflashed?: boolean;
  firmwareVersion: string;
  fingerprint: string;
  poweredOn: boolean;
  online: boolean;
  assignedGateName: string;
  batteryMv: number;
  batteryPct: number;
  noiseFloorDbm: number;
  lastRssi?: number[];
}

export interface SimLapRFUnit {
  timerId: number;
  label: string;
  transport?: "ethernet" | "usb";
  portName?: string;
  host: string;
  port: number;
  color: string;
  poweredOn: boolean;
  connected: boolean;
  online: boolean;
  assignedGateName: string;
  voltageMv: number;
  gateArmed: boolean;
  rtcDeltaMs: number;
  slotRssi: number[];
  slotFreqsMhz?: number[];
  slotThresholds?: number[];
}

export interface RHScanPass {
  seq: number;
  start: number;
  stop: number;
  step: number;
  passMs: number;
  live: boolean;
  values: number[];
}

export interface SimRotorHazardUnit {
  timerId: number;
  label: string;
  transport?: "network" | "usb" | string;
  portName?: string;
  baudRate?: number;
  apiLevel?: number;
  host: string;
  port: number;
  nodeCount: number;
  adminUser?: string;
  adminPass?: string;
  serverVersion?: string;
  serverHostname?: string;
  color: string;
  poweredOn: boolean;
  connected: boolean;
  online: boolean;
  authOk: boolean;
  assignedGateName: string;
  gateArmed: boolean;
  clockDeltaMs: number;
  heartbeatsRx?: number;
  passesRx?: number;
  slotRssi: number[];
  crossingFlag?: boolean[];
  nodeEnterLevels?: number[];
  nodeExitLevels?: number[];
  nodeFreqsMhz?: number[];
  cpuTempC?: number;
  envSummary?: string;
  scanLive?: boolean;
  lastScan?: RHScanPass;
}

export interface SimState {
  running: boolean;
  speedMultiplier?: number;
  trackWalkerActive: boolean;
  autoPracticeEvents: boolean;
  trackWalkerSecLeft: number;
  pilots: SimPilotState[];
  timers: SimTimerState[];
  laprfUnits?: SimLapRFUnit[];
  rotorhazardUnits?: SimRotorHazardUnit[];
}

export type OperatingMode = "practice" | "race";
export type TournamentStructure = "single_stage" | "two_stage";
export type StageFormat =
  | "qualifying"
  | "open_qualifier"
  | "double_elimination"
  | "single_elimination"
  | "chase_the_ace"
  | "points_mains"
  | "custom";
export type StageStatus = "pending" | "ready" | "active" | "paused" | "completed";
export type StageControlAction =
  | "activate_stage"
  | "pause_stage"
  | "resume_stage"
  | "complete_stage_early"
  | "reopen_stage_early";
export type QualifyingMetric =
  | "consecutive_3"
  | "consecutive_2"
  | "best_lap"
  | "laps_in_time"
  | "points";
export type QualifyingLineupMode = "balanced" | "fixed";
export type SeedingMethod = "roster_order" | "random";
export type StartMode = "heads_up" | "staggered";
export type FinalsFormat = "chase_the_ace" | "single_final" | "points_final";
export type HeatState =
  | "waiting"
  | "ready"
  | "staged"
  | "countdown"
  | "running"
  | "paused"
  | "finished"
  | "confirmed"
  | "aborted";
export type PilotHeatStatus = "staged" | "racing" | "finished" | "dnf" | "dq" | "dns";
export type RaceLifecycle = "draft" | "active" | "paused" | "completed" | "scrapped";
export type PilotAttendance = "active" | "away" | "dq" | "dnc" | "forfeit";

export interface RaceSetupConfig {
  eventName: string;
  structure: TournamentStructure;
  hasQualifying?: boolean;
  qualifyingRounds: number;
  qualifyingMetric: QualifyingMetric;
  qualifyingLineupMode?: QualifyingLineupMode;
  qualifyingTimeLimitSec: number;
  qualifyingTargetLaps: number;
  maxPacksPerPilot?: number;
  stage2MaxSeeds?: number;
  mainFormat: StageFormat;
  finalsFormat: FinalsFormat;
  aceWinsRequired: number;
  winnersAdvantageAce: boolean;
  pointsRounds: number;
  pilotsPerHeat: number;
  seatChannels: number[];
  targetLaps: number;
  timeLimitSec: number;
  countdownSec: number;
  overtimeGraceSec: number;
  seeding: SeedingMethod;
}

export interface HeatLap {
  crossingId: number;
  lapNumber: number; // 0 = Holeshot, 1..N = counted lap
  splitTimeSec: number;
  raceElapsedSec: number;
  invalidated: boolean;
  manual: boolean;
  sectors?: SectorSplit[];
}

export interface SeatFeeder {
  fromHeatId?: string;
  fromRank?: number;
  fromRoundColumn?: number;
  fromRoundId?: string;
  fromStandingsRank?: number;
  fromStageSeed?: number;
  rankingMetric?: QualifyingMetric;
  isBye?: boolean;
}

export interface HeatCrossing {
  crossingId: number;
  timestampUs: number;
  peakRssiDbm?: number;
  estimatedSpeedMph?: number;
  sectors?: SectorSplit[];
  invalidated?: boolean;
  manual?: boolean;
}

export interface HeatRssiSample {
  /** Milliseconds relative to StartToneUs (negative = pre-horn countdown) */
  t: number;
  /** Smoothed RSSI in dBm */
  r: number;
}

export interface HeatSeat {
  seatIndex: number;
  pilotSlotIndex: number;
  callsign: string;
  phoneticName?: string;
  color: string;
  seed?: number;
  sourceLabel: string;
  feeder?: SeatFeeder;
  manualLock?: boolean;
  band: number;
  channel: number;
  frequencyMhz: number;
  channelChanged: boolean;
  prevChannel?: number;
  status: PilotHeatStatus;
  preOverrideStatus?: PilotHeatStatus;
  statusOverridden?: boolean;
  rosterDq?: boolean;
  holeshotSec: number;
  holeshotWinner?: boolean;
  lapsCompleted: number;
  totalTimeSec: number;
  bestLapSec: number;
  bestConsecutive2Sec?: number;
  bestConsecutive3Sec: number;
  lastLapSec: number;
  penaltySec: number;
  enterRssiDbm?: number;
  exitRssiDbm?: number;
  rssiTrace?: HeatRssiSample[];
  crossings?: HeatCrossing[];
  laps: HeatLap[];
  position: number;
  manualPosition: number;
  points: number;
  aceWinsBefore?: number;
  aceWinsAfter?: number;
  advances: boolean;
}

export interface BracketEdge {
  fromHeatId: string;
  toHeatId: string;
  ranks: number[];
  isDrop: boolean;
}

export interface RaceHeat {
  id: string;
  roundId?: string;
  stageIndex: number;
  stageName: string;
  stageFormat: StageFormat;
  round: number;
  column: number;
  order: number;
  bracketLane: "qualifying" | "winners" | "losers" | "finals" | "mains" | string;
  division?: string;
  title: string;
  shortLabel: string;
  startMode: StartMode;
  targetLaps: number;
  timeLimitSec: number;
  expectedWinners: number;
  state: HeatState;
  hardwareMode?: TimingHardwareMode;
  note?: string;
  seats: HeatSeat[];
  elapsedSec: number;
  countdownRemainingSec: number;
  countdownArmRemainingSec?: number;
  countdownDurationSec?: number;
  countdownBeeped?: boolean;
  countdownBeepAtSec?: number;
  inOvertime: boolean;
  canUnlock: boolean;
  executedAtMs?: number;
  startToneUs?: number;
  countdownPromptUs?: number;
  countdownPrompted?: boolean;
  countdownStartUs?: number;
  countdownEndUs?: number;
}

export interface TournamentStanding {
  rank: number;
  pilotSlotIndex: number;
  callsign: string;
  phoneticName?: string;
  color: string;
  seed: number;
  bracketStatus: string;
  heatsFlown: number;
  wins: number;
  aceWins: number;
  losses: number;
  points: number;
  totalLaps: number;
  bestLapSec: number;
  bestConsecutive2Sec?: number;
  bestConsecutive3Sec: number;
}

export interface RaceAnnouncement {
  kind:
    | "countdown_start"
    | "countdown_prompt"
    | "countdown_cancel"
    | "start_horn"
    | "holeshot"
    | "pilot_last_lap"
    | "pilot_finished"
    | "pilot_dnf"
    | "overtime"
    | "heat_finished"
    | "emergency_stop"
    | "champion"
    | string;
  heatId?: string;
  slotIndex?: number;
  callsign?: string;
  position?: number;
  countdownSec?: number;
  text?: string;
  competitive?: boolean;
  timedOut?: boolean;
  hornAlreadySounded?: boolean;
}

export interface RaceRound {
  id: string;
  stageIndex: number;
  round: number;
  column: number;
  bracketLane: string;
  title: string;
  stageFormat: StageFormat;
  startMode?: StartMode;
  targetHeats?: number;
  finalsFormat?: FinalsFormat;
  aceWinsRequired?: number;
  winnersAdvantageAce?: boolean;
  finalsHeats?: number;
  targetLaps: number;
  timeLimitSec: number;
  maxPacksPerPilot?: number;
  qualifyingMetric?: QualifyingMetric;
  seedSource?: string;
  seedDistribution?: string;
  randomSeed?: number;
  seedToPort?: "left" | "top" | "bottom" | string;
  linkSummary?: string;
  hasPos?: boolean;
  posX?: number;
  posY?: number;
}

export type RoundConnectionMode =
  | "pilots_in"
  | "top_per_heat"
  | "bottom_per_heat"
  | "standings_top"
  | "all_pilots"
  | "all_pilots_ranked"
  | "stage_seeds"
  | "qual_feed";

export interface RoundConnection {
  id: string;
  stageIndex?: number;
  fromRoundId: string;
  toRoundId: string;
  fromPort?: "right" | "bottom" | string;
  toPort?: "left" | "top" | "bottom" | string;
  mode: RoundConnectionMode | string;
  count: number;
  customCount?: boolean;
  seedStart?: number;
  seedEnd?: number;
  distribution?: "snake" | "sequential" | string;
  rankingMetric?: QualifyingMetric;
  seededEarly?: boolean;
  invalid?: boolean;
  invalidReason?: string;
}

export interface StageSettings {
  pilotsPerHeat: number;
  seatChannels: number[];
  targetLaps: number;
  timeLimitSec: number;
  qualifyingRounds?: number;
  qualifyingMetric?: QualifyingMetric;
  qualifyingLineupMode?: QualifyingLineupMode;
  maxPacksPerPilot?: number;
  pointsRounds?: number;
  finalsFormat?: FinalsFormat;
  aceWinsRequired?: number;
  winnersAdvantageAce?: boolean;
}

export interface RaceStage {
  id: string;
  index: number;
  title: string;
  format: StageFormat;
  customized?: boolean;
  status: StageStatus;
  pausedByUser?: boolean;
  completedEarly?: boolean;
  prerequisitesMet: boolean;
  waitingOnStageNames?: string[];
  dangling?: boolean;
  danglingReason?: string;
  settings: StageSettings;
  hasPos?: boolean;
  posX?: number;
  posY?: number;
  pilotsNodeHasPos?: boolean;
  pilotsNodePosX?: number;
  pilotsNodePosY?: number;
  championSlotIndex?: number;
  championCallsign?: string;
}

export type StageConnectionMode = "all_pilots" | "top_n" | "seed_range";

export interface StageConnection {
  id: string;
  fromStageId: string;
  toStageId: string;
  fromStageIndex: number;
  toStageIndex: number;
  fromPort?: "left" | "top" | "right" | "bottom" | string;
  toPort?: "left" | "top" | "right" | "bottom" | string;
  mode: StageConnectionMode | string;
  count?: number;
  seedStart?: number;
  seedEnd?: number;
  rankingMetric?: QualifyingMetric;
  invalid?: boolean;
  invalidReason?: string;
}

export interface StagePositionUpdate {
  stageId: string;
  posX: number;
  posY: number;
}

export interface MultiGPRaceLink {
  raceId: number;
  raceName: string;
  chapterId?: number;
  chapterName?: string;
  scoringFormat: number;
  scoringDisabled?: boolean;
  isZippyQ?: boolean;
  importMode?: "schedule" | "zippyq" | "bracket" | string;
  syncedCycleCount?: number;
  syncedHeatAt?: Record<string, string>;
  unsyncedHeats?: Record<string, boolean>;
  overallSyncedAt?: string;
  lastSyncedAt?: string;
}

export interface TrackScope {
  kind: "practice" | "race";
  id: string;
}

export interface RaceTournamentState {
  raceId?: string;
  mgpLink?: MultiGPRaceLink;
  tags?: string[];
  templateId?: string;
  lifecycle?: RaceLifecycle;
  emergencyStopped?: boolean;
  statusReason?: string;
  createdAt?: string;
  updatedAt?: string;
  mode: OperatingMode;
  config: RaceSetupConfig;
  trackInitialized?: boolean;
  trackSnapshot?: TrackNode[];
  rules?: TimingRules;
  roster?: EventPilot[];
  stages?: RaceStage[];
  stageConnections?: StageConnection[];
  formatInvalidReason?: string;
  rounds?: RaceRound[];
  connections?: RoundConnection[];
  generated: boolean;
  activeStageIndex: number;
  totalStages: number;
  qualifyingComplete: boolean;
  canStartStage2: boolean;
  stage2SeededEarly?: boolean;
  activeHeatId: string;
  nextReadyHeatId: string;
  championSlotIndex?: number;
  championCallsign?: string;
  isComplete: boolean;
  heats: RaceHeat[];
  edges: BracketEdge[];
  standings: TournamentStanding[];
  qualStandings?: TournamentStanding[];
}

export interface EventPilot {
  slotIndex: number;
  callsign: string;
  phoneticName?: string;
  color: string;
  checkedIn: boolean;
  attendance: PilotAttendance;
  note?: string;
  mgpPilotId?: number;
}

export interface PracticeSessionPilot {
  slotIndex: number;
  callsign: string;
  phoneticName?: string;
  color: string;
  band: number;
  channel: number;
  frequencyMhz: number;
}

export interface ManualDeletedCrossing {
  gateId: number;
  slotIndex: number;
  timestampUs: number;
  peakRssiDbm?: number;
}

export interface PracticeBreakMark {
  breakId: number;
  slotIndex: number;
  timestampUs: number;
}

export interface TeacherNegativeMark {
  gateId: number;
  slotIndex: number;
  timestampUs: number;
  label: string;
  confidence: number;
  peakRssiDbm?: number;
}

export interface PracticeSession {
  sessionId: string;
  name: string;
  tags?: string[];
  active: boolean;
  paused?: boolean;
  createdAt: string;
  updatedAt?: string;
  pilots: PracticeSessionPilot[];
  trackInitialized?: boolean;
  trackSnapshot?: TrackNode[];
  rules?: TimingRules;
  laps: LapRecord[];
  crossings: GateCrossingEvent[];
  breaks?: PracticeBreakMark[];
  filtered: FilteredDetection[];
  summaries: PilotTrackSummary[];
  trainingVerified?: boolean;
  teacherLabeledAt?: string;
  teacherPackId?: string;
  teacherHardNegs?: TeacherNegativeMark[];
  manualDeletedCrossings?: ManualDeletedCrossing[];
  traceSampleCount?: number;
  traceDurationSec?: number;
}

export interface PracticeManagerState {
  initialized?: boolean;
  activeSessionId: string;
  selectedSessionId: string;
  packLoopEnabled?: boolean;
  packLoopQuietSec?: number;
  packLoopQuietElapsed?: number;
  packLoopState?: string;
  lastSealedSessionId?: string;
  lastSealedLapCount?: number;
  sessions: PracticeSession[];
}

export interface PracticeActionPayload {
  action:
    | "create_session"
    | "select_session"
    | "rename_session"
    | "set_session_tags"
    | "delete_session"
    | "start_session"
    | "pause_session"
    | "resume_session"
    | "stop_session"
    | "add_session_pilot"
    | "remove_session_pilot"
    | "set_session_pilot_channel"
    | "clear_session_laps"
    | "clear_pilot_laps"
    | "toggle_session_lap"
    | "delete_session_lap"
    | "set_pack_loop"
    | "seal_and_split_pack"
    | "set_training_verified";
  sessionId?: string;
  name?: string;
  tags?: string[];
  dontSelect?: boolean;
  slotIndex?: number;
  callsign?: string;
  phoneticName?: string;
  band?: number;
  channel?: number;
  preemptOngoing?: boolean;
  lapId?: number;
  packLoopEnabled?: boolean;
  packLoopQuietSec?: number;
  trainingVerified?: boolean;
}

export type DetectorMode = "classic" | "ai";

export interface MLMetrics {
  totalPasses: number;
  detectedPasses: number;
  missedPasses: number;
  falseTriggers: number;
  precision: number;
  recall: number;
  f1: number;
  meanJitterMs: number;
}

export interface MLModelSummary {
  modelId: string;
  name: string;
  version: number;
  createdAt: string;
  builtIn?: boolean;
  ready?: boolean;
  epochsTrained?: number;
  sourceSessionIds?: string[];
  trainPacks: number;
  valPacks: number;
  trainPasses: number;
  trainDurationMs: number;
  finalLoss: number;
  aiMetrics: MLMetrics;
  classicMetrics: MLMetrics;
}

export interface MLConfig {
  detectorMode: DetectorMode;
  activeModelId: string;
  liveTuneEnabled: boolean;
  teacherPackId?: string;
  autoLabelOnTrain?: boolean;
}

export interface MLTeacherPackInfo {
  packId: string;
  name: string;
  description: string;
  sizeBytes: number;
  recommended?: boolean;
  installed: boolean;
  partialBytes?: number;
}

export interface MLTeacherDownloadProgress {
  running: boolean;
  packId?: string;
  downloadedBytes: number;
  totalBytes: number;
  percent: number;
  error?: string;
}

export interface MLTeacherStatus {
  activePackId: string;
  ready: boolean;
  packs: MLTeacherPackInfo[];
  download: MLTeacherDownloadProgress;
}

export interface MLCandidateDecision {
  id: string;
  gateId: number;
  slotIndex: number;
  label: "crossing" | "bleed" | "multipath" | "noise" | string;
  anchorTsUs: number;
  deltaMs: number;
  finalTsUs: number;
  peakRssiDbm: number;
  confidence: number;
}

export interface MLSessionLabelResponse {
  sessionId: string;
  packId: string;
  dryRun: boolean;
  candidateCount: number;
  crossingsCount: number;
  hardNegsCount: number;
  decisions: MLCandidateDecision[];
  practice?: PracticeManagerState;
  mlStatus: MLStatus;
}

export interface MLLiveGateTune {
  gateId: number;
  slotIndex: number;
  lapsUsed: number;
  posExamples: number;
  negExamples: number;
  weights: number[];
  bias: number;
}

export interface MLTrainingProgress {
  running: boolean;
  epoch: number;
  totalEpochs: number;
  loss: number;
  message?: string;
  startedAt?: string;
  completedModelId?: string;
  error?: string;
}

export interface MLStatus {
  config: MLConfig;
  training: MLTrainingProgress;
  teacher?: MLTeacherStatus;
  models: MLModelSummary[];
  verifiedPacks: number;
  unverifiedPacks: number;
  totalRecordedPacks: number;
  verifiedPasses: number;
  storageBytes: number;
  liveTunes?: MLLiveGateTune[];
}

export interface SessionTraceResponse {
  sessionId: string;
  sampleCount: number;
  rssiCount: number;
  batchesB64: string[];
}

export interface EventManagerState {
  initialized?: boolean;
  activeRaceId: string;
  races: RaceTournamentState[];
}

export interface EventActionPayload {
  action:
    | "create_race"
    | "select_race"
    | "set_race_tags"
    | "rename_race"
    | "delete_race"
    | "update_attendance"
    | "check_in_all"
    | "add_event_pilot"
    | "add_race_pilot"
    | "race_lifecycle"
    | "stage_control";
  name?: string;
  tags?: string[];
  slotIndex?: number;
  checkedIn?: boolean;
  attendance?: PilotAttendance;
  pilotNote?: string;
  callsign?: string;
  phoneticName?: string;
  raceId?: string;
  copyConfig?: boolean;
  dontSelect?: boolean;
  lifecycleAction?: "start_race" | "pause_race" | "resume_race" | "emergency_stop" | "complete_race" | "scrap_race" | "reopen_race";
  stageAction?: StageControlAction;
  stageId?: string;
  stageIndex?: number;
  reason?: string;
  preemptOngoing?: boolean;
}

export interface RoundPositionUpdate {
  roundId: string;
  posX: number;
  posY: number;
}

export interface BracketEditPayload {
  action:
    | "apply_template"
    | "start_custom"
    | "add_stage"
    | "remove_stage"
    | "rename_stage"
    | "update_stage_settings"
    | "move_stages"
    | "reset_stage_layout"
    | "connect_stages"
    | "update_stage_connection"
    | "reconnect_stage_connection"
    | "disconnect_stages"
    | "enable_stage2"
    | "remove_stage2"
    | "update_stage_handoff"
    | "seed_stage2_early"
    | "unlock_stage2_seeding"
    | "seed_connection_now"
    | "reopen_connection_seed"
    | "reshuffle_round"
    | "assign_seat_stage_seed"
    | "add_round"
    | "move_rounds"
    | "reset_round_layout"
    | "duplicate_round"
    | "delete_rounds"
    | "connect_rounds"
    | "reconnect_connection"
    | "update_connection"
    | "disconnect_rounds"
    | "set_round_seed"
    | "update_round"
    | "delete_round"
    | "link_round"
    | "set_seat_feeder"
    | "regenerate_upcoming"
    | "move_or_swap_seat"
    | "assign_pilot_seat"
    | "clear_seat"
    | "unlock_seat"
    | "set_seat_channel"
    | "auto_seat_pilot"
    | "add_heat"
    | "delete_heat"
    | "add_qualifying_round"
    | "set_finals_structure"
    | "open_qual_enqueue"
    | "open_qual_dequeue"
    | "open_qual_enqueue_all";
  templateId?: string;
  raceId?: string;
  stageId?: string;
  stageIndex?: number;
  fromStageId?: string;
  toStageId?: string;
  fromStageIndex?: number;
  toStageIndex?: number;
  stagePositions?: StagePositionUpdate[];
  seatChannels?: number[];
  applyToExisting?: boolean;
  roundId?: string;
  roundIds?: string[];
  fromRoundId?: string;
  toRoundId?: string;
  fromPort?: "left" | "top" | "right" | "bottom";
  toPort?: "left" | "top" | "right" | "bottom";
  connectionId?: string;
  title?: string;
  stageFormat?: StageFormat;
  startMode?: StartMode;
  heatCount?: number;
  targetLaps?: number;
  timeLimitSec?: number;
  qualifyingRounds?: number;
  qualifyingMetric?: QualifyingMetric;
  qualifyingLineupMode?: QualifyingLineupMode;
  maxPacksPerPilot?: number;
  forceImmediate?: boolean;
  stage2MaxSeeds?: number;
  seedStart?: number;
  seedEnd?: number;
  distribution?: "snake" | "sequential" | "roster" | "random" | string;
  fromStageSeed?: number;
  pointsRounds?: number;
  pilotsPerHeat?: number;
  aceWinsRequired?: number;
  winnersAdvantageAce?: boolean;
  finalsHeats?: number;
  finalsFormat?: FinalsFormat;
  linkMode?:
    | "all"
    | "top_n"
    | "seed_range"
    | "all_active_pilots"
    | "top_per_heat"
    | "bottom_per_heat"
    | "standings_top"
    | "all_pilots"
    | "all_pilots_ranked"
    | "pilots_in"
    | "stage_seeds"
    | "qual_feed"
    | "none"
    | "clear_links"
    | "empty";
  sourceColumn?: number;
  sourceLane?: string;
  advanceCount?: number;
  column?: number;
  hasPos?: boolean;
  posX?: number;
  posY?: number;
  positions?: RoundPositionUpdate[];
  heatId?: string;
  seatIndex?: number;
  fromHeatId?: string;
  fromSeatIndex?: number;
  fromRank?: number;
  fromRoundColumn?: number;
  fromStandingsRank?: number;
  toHeatId?: string;
  toSeatIndex?: number;
  pilotSlotIndex?: number;
  band?: number;
  channel?: number;
  bracketLane?: string;
  round?: number;
}

export interface RaceMarshalPayload {
  raceId?: string;
  heatId: string;
  pilotSlotIndex: number;
  action:
    | "toggle_dnf"
    | "toggle_dq"
    | "toggle_dns"
    | "set_dns"
    | "set_dnf"
    | "set_dq"
    | "set_finished"
    | "set_racing"
    | "add_lap"
    | "toggle_lap"
    | "add_crossing"
    | "move_crossing"
    | "delete_crossing"
    | "move_up"
    | "move_down"
    | "reorder_seats"
    | "set_penalty"
    | "clear_override";
  crossingId?: number;
  offsetMs?: number;
  penaltySec?: number;
  orderedSlotIndices?: number[];
}

export interface MultiGPRaceSummary {
  id: string;
  name: string;
  startDate?: string;
  chapterId?: string;
  chapterName?: string;
  scoringFormat: number;
  disableSlotAutoPopulation: number;
  pilotCount: number;
  cycleCount: number;
}

export interface MultiGPRaceEntry {
  pilotId: number;
  userName: string;
  firstName?: string;
  lastName?: string;
  displayName?: string;
  phonetic?: string;
  band?: string;
  channel?: string;
  frequency?: number;
}

export interface MultiGPHeatEntry {
  slot: number;
  pilotId: number;
  userName?: string;
  band?: string;
  channel?: string;
  frequency?: number;
  score?: number;
  totalLaps?: number;
  totalTime?: number;
  fastestLapTime?: number;
  fastest2ConsecutiveLapsTime?: number;
  fastest3ConsecutiveLapsTime?: number;
  syncedAt?: string;
}

export interface MultiGPScheduleHeat {
  heatNumber: number;
  name: string;
  entries: MultiGPHeatEntry[];
}

export interface MultiGPScheduleRound {
  roundNumber: number;
  name: string;
  isZippyQ?: boolean;
  heats: MultiGPScheduleHeat[];
}

export interface MultiGPRaceSchedule {
  rounds: MultiGPScheduleRound[];
}

export interface MultiGPOverallResultEntry {
  orderNumber: number;
  pilotId: number;
  userName?: string;
}

export interface MultiGPRaceViewData {
  id: number;
  name: string;
  startDate?: string;
  chapterId: number;
  chapterName: string;
  raceType: number;
  scoringFormat: number;
  scoringDisabled: number;
  disableSlotAutoPopulation: number;
  autoQueueZippyQ?: boolean;
  cycleCount: number;
  maxLaps: number;
  raceTimeSec: number;
  entries: MultiGPRaceEntry[];
  schedule: MultiGPRaceSchedule;
  overallResults?: MultiGPOverallResultEntry[];
  overallSyncedAt?: string;
}

export interface SimMultiGPState {
  chapterId: number;
  chapterName: string;
  apiKey: string;
  nextRaceId: number;
  pilotPool: MultiGPRaceEntry[];
  races: MultiGPRaceViewData[];
}

export interface SimMultiGPAdminAction {
  action:
    | "set-chapter"
    | "regen-key"
    | "add-race"
    | "delete-race"
    | "queue-zippyq"
    | "set-auto-zippyq"
    | "sim-zippyq-checkin"
    | "sim-zippyq-lineup"
    | "toggle-pilot"
    | "set-all-pilots"
    | "add-pool-pilot"
    | "rebuild-schedule"
    | "add-round"
    | "delete-round"
    | "add-heat"
    | "delete-heat"
    | "add-seat"
    | "delete-seat"
    | "set-seat-channel"
    | "assign-seat"
    | "move-seat"
    | "clear-uploads"
    | "set-mode"
    | "set-scoring"
    | "reset";
  chapterName?: string;
  raceId?: number;
  name?: string;
  isZippyQ?: boolean;
  enabled?: boolean;
  scoringFormat?: number;
  roundCount?: number;
  pilotId?: number;
  roundNumber?: number;
  heatNumber?: number;
  seatIndex?: number;
  slot?: number;
  fromRound?: number;
  fromHeat?: number;
  fromSeatIndex?: number;
}

export interface MultiGPAssignSlotData {
  pilotId: number;
  score: number;
  totalLaps: number;
  totalTime: number;
  fastestLapTime: number;
  fastest2ConsecutiveLapsTime: number;
  fastest3ConsecutiveLapsTime: number;
}

export interface MultiGPSlotSyncOperation {
  heatId: string;
  heatTitle: string;
  cycle: number;
  heat: number;
  slot: number;
  callsign: string;
  data: MultiGPAssignSlotData;
}

export interface MultiGPSyncPlan {
  raceId: string;
  mgpRaceId: number;
  mgpRaceName: string;
  importMode: string;
  operations: MultiGPSlotSyncOperation[];
  overallResults?: MultiGPOverallResultEntry[];
}

export interface PilotCSVImportSummary {
  added: number;
  updated: number;
  total: number;
}

export interface FullStateResponse {
  serverTimestampUs?: number;
  timingHardwareMode?: TimingHardwareMode;
  pilots: PilotSlot[];
  gates: TrackNode[];
  timers?: DetectedTimer[];
  laps: LapRecord[];
  crossings: GateCrossingEvent[];
  breaks?: PracticeBreakMark[];
  filtered: FilteredDetection[];
  summaries: PilotTrackSummary[];
  rules: TimingRules;
  simulatorRunning: boolean;
  simState?: SimState;
  simMultiGP?: SimMultiGPState;
  raceArmed: boolean;
  laprfEmulatorStatus: LapRFEmulatorStatus;
  raceState?: RaceTournamentState;
  eventState?: EventManagerState;
  practiceState?: PracticeManagerState;
  mlStatus?: MLStatus;
  importSummary?: PilotCSVImportSummary;
}

/** Lightweight periodic status poll (`GET /v1/status`). */
export interface StatusResponse {
  serverTimestampUs?: number;
  timingHardwareMode?: TimingHardwareMode;
  gates: TrackNode[];
  timers?: DetectedTimer[];
  simulatorRunning: boolean;
  simState?: SimState;
  simMultiGP?: SimMultiGPState;
  raceArmed: boolean;
  laprfEmulatorStatus: LapRFEmulatorStatus;
  raceState?: RaceTournamentState;
  eventState?: EventManagerState;
  practiceState?: PracticeManagerState;
}

/** Crossing tone trigger mode: off, beep on enter threshold, beep at signal peak over the gate, or beep on exit threshold. */
export type CrossingBeepMode = "off" | "enter" | "peak" | "exit";

/** Guardrails applied to every RF detection before it counts (see internal/domain/rules.go). */
export interface TimingRules {
  minLapSec: number;
  maxLapSec: number;
  minCrossingSec: number;
  beepOnCross?: boolean;
  beepMode?: CrossingBeepMode;
}

/** Numeric detection/timing rules overridable per gate or per (gate, pilot). */
export type NumericGateRuleKey = "minLapSec" | "maxLapSec" | "minCrossingSec";

/** Every detection/timing rule can be overridden per gate or per (gate, pilot). */
export type GateRuleKey = NumericGateRuleKey;
export type GateRuleOverrides = Partial<Record<NumericGateRuleKey, number>> & {
  beepOnCross?: boolean;
  beepMode?: CrossingBeepMode;
};

export type FilterReason = "SPIKE" | "MIN_LAP" | "LAP_TOO_LONG" | "OUT_OF_ORDER";

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
  type: "connected" | "telemetry" | "crossing" | "filtered" | "lap" | "config" | "race" | "practice" | "ml_status";
  payload?: unknown;
}
