package ingest

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
	"sync/atomic"

	"slaprf/internal/domain"
	"slaprf/internal/rotorhazard"
	"slaprf/internal/tracker"
)

type pendingRHHeartbeat struct {
	timerID  uint8
	label    string
	slotRSSI [domain.MaxPilotSlots]float32
}

type pendingRHCrossing struct {
	timerID   uint8
	hwSlotIdx int
	peakTsUs  uint64
	peakRSSI  float32
	passNum   uint32
}

type simRHSweepEmitter struct {
	freqMHz      float64
	aboveFloor   float64
	halfWidthMHz float64
}

type simRHUnitState struct {
	domain.SimRotorHazardUnit
	simNowUs          atomic.Uint64
	server            *rotorhazard.SimServer
	client            *rotorhazard.Client
	usbNode           *rotorhazard.SimSerialNode
	usbClient         *rotorhazard.SerialClient
	usbSess           *rotorhazard.SerialSession
	sessionAttached   bool
	clockSyncTicks    uint32
	sweepEmitters     []simRHSweepEmitter
	pendingHeartbeats []pendingRHHeartbeat
	pendingCrossings  []pendingRHCrossing
}

// SimRotorHazardActionRequest mutates simulated RotorHazard timing devices in Simulation Mode.
type SimRotorHazardActionRequest struct {
	Action    string `json:"action"` // "toggle-power" | "toggle-connect" | "connect-host" | "connect-port" | "disconnect" | "update" | "add" | "delete" | "reset"
	TimerID   uint8  `json:"timerId,omitempty"`
	Label     string `json:"label,omitempty"`
	Transport string `json:"transport,omitempty"`
	PortName  string `json:"portName,omitempty"`
	BaudRate  int    `json:"baudRate,omitempty"`
	Host      string `json:"host,omitempty"`
	Port      int    `json:"port,omitempty"`
	NodeCount int    `json:"nodeCount,omitempty"`
	AdminUser string `json:"adminUser,omitempty"`
	AdminPass string `json:"adminPass,omitempty"`
}

func normalizeSimRHLabel(label string, timerID uint8) string {
	unitNum := int(timerID) - 1
	if unitNum < 1 {
		unitNum = 1
	}
	clean := strings.TrimSpace(label)
	lower := strings.ToLower(clean)
	if clean == "" || strings.HasPrefix(lower, "rotorhazard #") || strings.HasPrefix(lower, "rh (") {
		return fmt.Sprintf("R%d", unitNum)
	}
	if len(lower) >= 3 && strings.HasPrefix(lower, "rh") {
		allDigits := true
		for i := 2; i < len(lower); i++ {
			if lower[i] < '0' || lower[i] > '9' {
				allDigits = false
				break
			}
		}
		if allDigits {
			return "R" + clean[2:]
		}
	}
	return clean
}

func normalizeSimRHNodeCount(n int) int {
	if n == 4 {
		return 4
	}
	return 8
}

func (u *simRHUnitState) isUSB() bool {
	return strings.EqualFold(u.Transport, "usb")
}

func (u *simRHUnitState) initProtocolObjectsLocked() {
	if u.NodeCount != 4 && u.NodeCount != 8 {
		u.NodeCount = 8
	}
	if u.Color == "" {
		u.Color = domain.DefaultGateColors[(int(u.TimerID)-2+len(domain.DefaultGateColors))%len(domain.DefaultGateColors)]
	}

	if u.isUSB() {
		if u.PortName == "" {
			unitNum := int(u.TimerID) - 1
			if unitNum < 1 {
				unitNum = 1
			}
			u.PortName = fmt.Sprintf("SIM-RH-USB%d", unitNum)
		}
		if u.BaudRate <= 0 {
			u.BaudRate = 115200
		}
		if u.APILevel < 21 {
			u.APILevel = int(rotorhazard.DefaultRHSerialAPI)
		}
		if u.ServerVersion == "" {
			u.ServerVersion = fmt.Sprintf("FPVGateC5 1.2 (API %d)", u.APILevel)
		}
		if u.usbNode == nil {
			u.usbNode = rotorhazard.NewSimSerialNode(rotorhazard.SimSerialNodeConfig{
				SeatCount: u.NodeCount,
				APILevel:  uint8(u.APILevel),
				FwVersion: "FPVGateC5 1.2",
				ProcType:  "ESP32-C5",
				NowUs:     u.simNowUs.Load,
			})
		} else {
			u.usbNode.SetSeatCount(u.NodeCount)
		}
		if u.usbClient == nil {
			u.usbClient = rotorhazard.NewSerialClient(rotorhazard.SerialClientConfig{
				PortName:        u.PortName,
				BaudRate:        u.BaudRate,
				NoRxSettleDelay: true,
				BootTimeout:     100,
				ReadTimeout:     50,
				SweepFeed: func(freqs []uint16) {
					now := u.simNowUs.Load()
					tSec := float64(now) / 1e6
					for seat, freq := range freqs {
						if seat >= u.NodeCount || u.usbNode == nil {
							break
						}
						f := float64(freq)
						ripple := math.Sin(f*0.17+tSec*3.1)*1.9 + math.Cos(f*0.09-tSec*1.7)*1.4
						val := 23.0 + ripple
						for _, em := range u.sweepEmitters {
							df := f - em.freqMHz
							hw := em.halfWidthMHz
							if hw <= 1 {
								hw = 8.5
							}
							contrib := em.aboveFloor * math.Exp(-(df*df)/(hw*hw))
							if contrib > 0.5 {
								val += contrib
							}
						}
						// Intermittent 5 GHz Wi-Fi UNII-3 channel 149 (5745 MHz) & 157 (5785 MHz) activity
						wifiPhase := math.Sin(tSec*4.3 + f*0.03)
						if wifiPhase > 0.35 {
							df149 := f - 5745.0
							val += 46.0 * (wifiPhase - 0.35) * math.Exp(-(df149*df149)/(11.0*11.0))
						}
						wifiPhase2 := math.Cos(tSec*3.7 - f*0.02)
						if wifiPhase2 > 0.55 {
							df157 := f - 5785.0
							val += 38.0 * (wifiPhase2 - 0.55) * math.Exp(-(df157*df157)/(11.0*11.0))
						}
						if val < 14 {
							val = 14
						} else if val > 248 {
							val = 248
						}
						u.usbNode.FeedSeatRSSI(seat, float32(math.Round(val)), now)
					}
				},
				Hooks: rotorhazard.ClientHooks{
					NowUs: u.simNowUs.Load,
					OnHeartbeat: func(ev rotorhazard.ClientHeartbeatEvent) {
						u.SlotRSSI = ev.SlotRSSI
						u.CrossingFlag = ev.CrossingFlag
						u.pendingHeartbeats = append(u.pendingHeartbeats, pendingRHHeartbeat{
							timerID:  u.TimerID,
							label:    u.Label,
							slotRSSI: ev.SlotRSSI,
						})
					},
					OnPass: func(ev rotorhazard.ClientPassEvent) {
						u.pendingCrossings = append(u.pendingCrossings, pendingRHCrossing{
							timerID:   u.TimerID,
							hwSlotIdx: ev.SlotIndex,
							peakTsUs:  ev.HostTimeUs,
							peakRSSI:  ev.PeakRSSI,
							passNum:   ev.PassingNumber,
						})
					},
				},
			})
		}
		return
	}

	if u.Transport == "" {
		u.Transport = "network"
	}
	if u.Port <= 0 {
		u.Port = 5000
	}
	if u.ServerVersion == "" {
		u.ServerVersion = "4.5.1"
	}
	if u.server == nil {
		u.server = rotorhazard.NewSimServer(rotorhazard.SimServerConfig{
			Hostname:      strings.ToLower(u.Label) + "-pi",
			ReleaseVer:    u.ServerVersion,
			NodeCount:     u.NodeCount,
			AdminUsername: u.AdminUser,
			AdminPassword: u.AdminPass,
			EpochMsFn: func() float64 {
				return 1_700_000_000_000.0 + float64(u.simNowUs.Load())/1000.0
			},
		})
	} else {
		u.server.SetConfig(strings.ToLower(u.Label)+"-pi", u.NodeCount, u.AdminUser, u.AdminPass)
	}
	if u.client == nil {
		u.client = rotorhazard.NewClient(rotorhazard.ClientHooks{
			NowUs: func() uint64 {
				return u.simNowUs.Load()
			},
			SendSIO: func(frame string) {
				if u.server != nil && u.sessionAttached {
					u.server.HandleClientFrame("sim-rh-link", frame)
				}
			},
			OnHeartbeat: func(ev rotorhazard.ClientHeartbeatEvent) {
				u.SlotRSSI = ev.SlotRSSI
				u.CrossingFlag = ev.CrossingFlag
				u.pendingHeartbeats = append(u.pendingHeartbeats, pendingRHHeartbeat{
					timerID:  u.TimerID,
					label:    u.Label,
					slotRSSI: ev.SlotRSSI,
				})
			},
			OnPass: func(ev rotorhazard.ClientPassEvent) {
				u.pendingCrossings = append(u.pendingCrossings, pendingRHCrossing{
					timerID:   u.TimerID,
					hwSlotIdx: ev.SlotIndex,
					peakTsUs:  ev.HostTimeUs,
					peakRSSI:  ev.PeakRSSI,
					passNum:   ev.PassingNumber,
				})
			},
		})
	}
}

func (u *simRHUnitState) syncLinkStateLocked(nowUs uint64, loginUser, loginPass string, useExplicitCreds bool) bool {
	u.simNowUs.Store(nowUs)
	u.initProtocolObjectsLocked()

	shouldAttach := u.PoweredOn && u.Connected
	if u.isUSB() {
		if !shouldAttach {
			if u.sessionAttached && u.usbSess != nil {
				_ = u.usbSess.Close()
				u.usbSess = nil
				u.sessionAttached = false
			}
			u.Online = false
			u.GateArmed = false
			return true
		}
		if !u.sessionAttached || u.usbSess == nil {
			sess, err := u.usbClient.ConnectPort(context.Background(), rotorhazard.NewSyncLoopbackPort(u.usbNode), u.BaudRate)
			if err == nil {
				u.usbSess = sess
				u.sessionAttached = true
			}
		}
		st := u.usbClient.Snapshot()
		u.AuthOK = true
		u.GateArmed = st.GateArmed
		u.ClockDeltaMs = st.ClockOffsetMs
		u.APILevel = st.APILevel
		u.BaudRate = st.BaudRate
		u.Online = u.PoweredOn && u.Connected && u.sessionAttached
		return true
	}

	if !shouldAttach {
		if u.sessionAttached {
			u.server.DetachSession("sim-rh-link")
			u.client.OnDisconnected()
			u.sessionAttached = false
		}
		u.Online = false
		u.GateArmed = false
		return true
	}

	user := u.AdminUser
	pass := u.AdminPass
	if useExplicitCreds {
		user = loginUser
		pass = loginPass
	}
	if !u.sessionAttached {
		u.sessionAttached = true
		authOK := u.server.AttachSession("sim-rh-link", user, pass, func(frame string) {
			u.client.FeedSIOFrame(frame)
		})
		u.AuthOK = authOK
		u.client.OnConnected()
	} else if useExplicitCreds {
		u.AuthOK = u.server.UpgradeSessionAuth("sim-rh-link", user, pass)
	}
	st := u.client.Snapshot()
	u.AuthOK = st.AuthOK
	u.GateArmed = st.GateArmed
	u.ClockDeltaMs = st.ClockOffsetMs
	u.Online = u.PoweredOn && u.Connected
	return u.AuthOK
}

func defaultSimRHUnits() []*simRHUnitState {
	baseRSSI := [domain.MaxPilotSlots]float32{24, 25, 23, 26, 24, 25, 22, 24}
	units := []*simRHUnitState{
		{
			SimRotorHazardUnit: domain.SimRotorHazardUnit{
				TimerID:       2,
				Label:         "R1",
				Transport:     "network",
				Host:          "192.168.1.101",
				Port:          5000,
				NodeCount:     8,
				AdminUser:     "admin",
				AdminPass:     "rotorhazard",
				ServerVersion: "4.5.1",
				Color:         domain.DefaultGateColors[0],
				PoweredOn:     true,
				Connected:     true,
				Online:        true,
				AuthOK:        true,
				GateArmed:     true,
				SlotRSSI:      baseRSSI,
			},
		},
		{
			SimRotorHazardUnit: domain.SimRotorHazardUnit{
				TimerID:       3,
				Label:         "R2",
				Transport:     "network",
				Host:          "192.168.1.102",
				Port:          5000,
				NodeCount:     8,
				AdminUser:     "admin",
				AdminPass:     "rotorhazard",
				ServerVersion: "4.5.1",
				Color:         domain.DefaultGateColors[1],
				PoweredOn:     true,
				Connected:     false,
				Online:        false,
				AuthOK:        false,
				GateArmed:     false,
				SlotRSSI:      baseRSSI,
			},
		},
	}
	for _, u := range units {
		u.syncLinkStateLocked(1_000_000, "", "", false)
		u.pendingHeartbeats = nil
		u.pendingCrossings = nil
	}
	return units
}

func defaultSimRHUSBUnits() []*simRHUnitState {
	baseRSSI := [domain.MaxPilotSlots]float32{24, 25, 23, 26, 24, 25, 22, 24}
	units := []*simRHUnitState{
		{
			SimRotorHazardUnit: domain.SimRotorHazardUnit{
				TimerID:        2,
				Label:          "R1",
				Transport:      "usb",
				PortName:       "SIM-RH-USB1",
				BaudRate:       115200,
				APILevel:       36,
				NodeCount:      8,
				ServerVersion:  "FPVGateC5 1.2 (API 36)",
				ServerHostname: "SIM-RH-USB1",
				Color:          domain.DefaultGateColors[0],
				PoweredOn:      true,
				Connected:      true,
				Online:         true,
				AuthOK:         true,
				GateArmed:      true,
				SlotRSSI:       baseRSSI,
			},
		},
		{
			SimRotorHazardUnit: domain.SimRotorHazardUnit{
				TimerID:        3,
				Label:          "R2",
				Transport:      "usb",
				PortName:       "SIM-RH-USB2",
				BaudRate:       115200,
				APILevel:       36,
				NodeCount:      8,
				ServerVersion:  "FPVGateC5 1.2 (API 36)",
				ServerHostname: "SIM-RH-USB2",
				Color:          domain.DefaultGateColors[1],
				PoweredOn:      true,
				Connected:      false,
				Online:         false,
				AuthOK:         true,
				GateArmed:      false,
				SlotRSSI:       baseRSSI,
			},
		},
	}
	for _, u := range units {
		u.syncLinkStateLocked(1_000_000, "", "", false)
		u.pendingHeartbeats = nil
		u.pendingCrossings = nil
	}
	return units
}

func defaultSimRHUnitsForMode(mode domain.TimingHardwareMode) []*simRHUnitState {
	if domain.NormalizeTimingHardwareMode(mode) == domain.HardwareModeRotorHazardUSB {
		return defaultSimRHUSBUnits()
	}
	return defaultSimRHUnits()
}

func (s *TrackSimulator) ensureRHUnitsLocked() {
	if len(s.rhUnits) == 0 {
		s.rhUnits = defaultSimRHUnits()
	}
}

func (s *TrackSimulator) ensureRHUnitsForModeLocked(mode domain.TimingHardwareMode) {
	wantUSB := domain.NormalizeTimingHardwareMode(mode) == domain.HardwareModeRotorHazardUSB
	if len(s.rhUnits) == 0 || s.rhUnits[0].isUSB() != wantUSB {
		if wantUSB {
			s.rhUnits = defaultSimRHUSBUnits()
		} else {
			s.rhUnits = defaultSimRHUnits()
		}
	}
}

func (s *TrackSimulator) snapshotRHUnitsLocked(gateByTimer map[uint8]string) []domain.SimRotorHazardUnit {
	s.ensureRHUnitsLocked()
	out := make([]domain.SimRotorHazardUnit, len(s.rhUnits))
	for i, u := range s.rhUnits {
		u.initProtocolObjectsLocked()
		cp := u.SimRotorHazardUnit
		if u.isUSB() {
			if u.sessionAttached && u.usbClient != nil {
				st := u.usbClient.Snapshot()
				cp.AuthOK = true
				cp.GateArmed = st.GateArmed
				cp.ClockDeltaMs = st.ClockOffsetMs
				cp.HeartbeatsRx = st.HeartbeatsRx
				cp.PassesRx = st.PassesRx
				cp.SlotRSSI = st.SlotRSSI
				cp.CrossingFlag = st.CrossingFlag
				cp.NodeEnterLevels = st.NodeEnterLevels
				cp.NodeExitLevels = st.NodeExitLevels
				cp.NodeFreqsMHz = st.NodeFreqsMHz
				cp.EnvSummary = st.EnvSummary
				cp.ScanLive = st.ScanLive
				cp.LastScan = st.LastScan
				if st.APILevel > 0 {
					cp.APILevel = st.APILevel
				}
				if st.BaudRate > 0 {
					cp.BaudRate = st.BaudRate
				}
				if st.ServerVersion != "" {
					cp.ServerVersion = st.ServerVersion
				}
				if st.ServerHostname != "" {
					cp.ServerHostname = st.ServerHostname
				}
			} else if u.usbNode != nil {
				cp.NodeFreqsMHz, cp.NodeEnterLevels, cp.NodeExitLevels = u.usbNode.SeatSnapshot()
			}
		} else if u.sessionAttached && u.client != nil {
			st := u.client.Snapshot()
			cp.AuthOK = st.AuthOK
			cp.GateArmed = st.GateArmed
			cp.ClockDeltaMs = st.ClockOffsetMs
			cp.HeartbeatsRx = st.HeartbeatsRx
			cp.PassesRx = st.PassesRx
			cp.SlotRSSI = st.SlotRSSI
			cp.CrossingFlag = st.CrossingFlag
			cp.NodeEnterLevels = st.NodeEnterLevels
			cp.NodeExitLevels = st.NodeExitLevels
			cp.NodeFreqsMHz = st.NodeFreqsMHz
			cp.CpuTempC = st.CpuTempC
			cp.EnvSummary = st.EnvSummary
			if st.ServerVersion != "" {
				cp.ServerVersion = st.ServerVersion
			}
			if st.ServerHostname != "" {
				cp.ServerHostname = st.ServerHostname
			}
		} else if u.server != nil {
			nodes, _ := u.server.NodeSnapshot()
			for idx := 0; idx < len(nodes) && idx < domain.MaxPilotSlots; idx++ {
				cp.NodeFreqsMHz[idx] = nodes[idx].FrequencyMHz
				cp.NodeEnterLevels[idx] = nodes[idx].EnterAtLevel
				cp.NodeExitLevels[idx] = nodes[idx].ExitAtLevel
			}
		}
		cp.Online = cp.PoweredOn && cp.Connected
		cp.AssignedGateName = gateByTimer[cp.TimerID]
		if !cp.PoweredOn {
			cp.SlotRSSI = [domain.MaxPilotSlots]float32{}
			cp.CrossingFlag = [domain.MaxPilotSlots]bool{}
			cp.GateArmed = false
		}
		out[i] = cp
	}
	return out
}

// DiscoverSimRotorHazardUnits returns powered-on simulated RotorHazard devices (LAN servers in Network mode,
// or virtual USB serial ports in USB mode).
func (s *TrackSimulator) DiscoverSimRotorHazardUnits() []domain.SimRotorHazardUnit {
	hwMode := s.engine.TimingHardwareMode()
	_, gates, _, _, _ := s.engine.StateSnapshot()
	gateByTimer := make(map[uint8]string, len(gates))
	for idx, g := range gates {
		if g.AssignedTimerID > 0 {
			gateByTimer[g.AssignedTimerID] = fmt.Sprintf("#%d", idx+1)
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensureRHUnitsForModeLocked(hwMode)
	var found []domain.SimRotorHazardUnit
	for _, u := range s.rhUnits {
		if !u.PoweredOn {
			continue
		}
		cp := u.SimRotorHazardUnit
		cp.AssignedGateName = gateByTimer[cp.TimerID]
		found = append(found, cp)
	}
	return found
}

// ApplyRotorHazardAction mutates simulated RotorHazard timing devices and syncs the engine's detected list.
func (s *TrackSimulator) ApplyRotorHazardAction(req SimRotorHazardActionRequest) ([]domain.SimRotorHazardUnit, error) {
	act := strings.ToLower(strings.TrimSpace(req.Action))
	nowUs := s.engine.NowUs()
	hwMode := s.engine.TimingHardwareMode()
	isUSBMode := domain.NormalizeTimingHardwareMode(hwMode) == domain.HardwareModeRotorHazardUSB

	s.mu.Lock()
	s.ensureRHUnitsForModeLocked(hwMode)

	findIdx := func(id uint8) int {
		for i := range s.rhUnits {
			if s.rhUnits[i].TimerID == id {
				return i
			}
		}
		return -1
	}

	switch act {
	case "reset":
		s.rhUnits = defaultSimRHUnitsForMode(hwMode)
		unitsCopy := make([]domain.SimRotorHazardUnit, len(s.rhUnits))
		for i := range s.rhUnits {
			unitsCopy[i] = s.rhUnits[i].SimRotorHazardUnit
		}
		s.mu.Unlock()
		if domain.IsRotorHazardMode(hwMode) {
			s.engine.ResetTrackToDefault(true)
			for idx, u := range unitsCopy {
				s.engine.EnsureRHTimerRegistered(u.TimerID, u.Label, idx == 0)
				s.engine.SetDetectedTimerOnline(u.TimerID, u.PoweredOn && u.Connected)
			}
		}
		return s.Snapshot().RotorHazardUnits, nil

	case "toggle-power":
		idx := findIdx(req.TimerID)
		if idx < 0 {
			s.mu.Unlock()
			return nil, tracker.ErrInvalidTimerID
		}
		s.rhUnits[idx].PoweredOn = !s.rhUnits[idx].PoweredOn
		s.rhUnits[idx].syncLinkStateLocked(nowUs, "", "", false)
		u := s.rhUnits[idx].SimRotorHazardUnit
		s.mu.Unlock()
		if domain.IsRotorHazardMode(hwMode) {
			s.engine.SetDetectedTimerOnline(u.TimerID, u.PoweredOn && u.Connected)
		}
		return s.Snapshot().RotorHazardUnits, nil

	case "connect":
		idx := findIdx(req.TimerID)
		if idx < 0 {
			s.mu.Unlock()
			return nil, tracker.ErrInvalidTimerID
		}
		if !s.rhUnits[idx].PoweredOn {
			s.mu.Unlock()
			return nil, fmt.Errorf("simulated RotorHazard device #%d is powered off", req.TimerID)
		}
		if req.BaudRate > 0 && s.rhUnits[idx].isUSB() {
			s.rhUnits[idx].BaudRate = req.BaudRate
		}
		s.rhUnits[idx].Connected = true
		useCreds := req.AdminUser != "" || req.AdminPass != ""
		s.rhUnits[idx].syncLinkStateLocked(nowUs, req.AdminUser, req.AdminPass, useCreds)
		u := s.rhUnits[idx].SimRotorHazardUnit
		s.mu.Unlock()
		if domain.IsRotorHazardMode(hwMode) {
			s.engine.EnsureRHTimerRegistered(u.TimerID, u.Label, true)
			s.engine.SetDetectedTimerOnline(u.TimerID, u.PoweredOn && u.Connected)
		}
		s.SyncRHNodesNow()
		return s.Snapshot().RotorHazardUnits, nil

	case "toggle-connect":
		idx := findIdx(req.TimerID)
		if idx < 0 {
			s.mu.Unlock()
			return nil, tracker.ErrInvalidTimerID
		}
		s.rhUnits[idx].Connected = !s.rhUnits[idx].Connected
		s.rhUnits[idx].syncLinkStateLocked(nowUs, "", "", false)
		u := s.rhUnits[idx].SimRotorHazardUnit
		s.mu.Unlock()
		if domain.IsRotorHazardMode(hwMode) {
			if u.Connected {
				s.engine.EnsureRHTimerRegistered(u.TimerID, u.Label, true)
			}
			s.engine.SetDetectedTimerOnline(u.TimerID, u.PoweredOn && u.Connected)
		}
		if u.Connected {
			s.SyncRHNodesNow()
		}
		return s.Snapshot().RotorHazardUnits, nil

	case "disconnect":
		idx := findIdx(req.TimerID)
		if idx < 0 {
			s.mu.Unlock()
			return nil, tracker.ErrInvalidTimerID
		}
		s.rhUnits[idx].Connected = false
		s.rhUnits[idx].syncLinkStateLocked(nowUs, "", "", false)
		u := s.rhUnits[idx].SimRotorHazardUnit
		s.mu.Unlock()
		if domain.IsRotorHazardMode(hwMode) {
			s.engine.SetDetectedTimerOnline(u.TimerID, false)
		}
		return s.Snapshot().RotorHazardUnits, nil

	case "connect-port":
		portName := strings.TrimSpace(req.PortName)
		if portName == "" {
			portName = "SIM-RH-USB1"
		}
		targetIdx := -1
		for i := range s.rhUnits {
			if strings.EqualFold(s.rhUnits[i].PortName, portName) {
				targetIdx = i
				break
			}
		}
		if targetIdx < 0 {
			s.mu.Unlock()
			return nil, fmt.Errorf("no simulated RotorHazard USB node on port %s (check Simulated RotorHazard USB Devices in #/sim)", portName)
		}
		if !s.rhUnits[targetIdx].PoweredOn {
			s.mu.Unlock()
			return nil, fmt.Errorf("simulated RotorHazard USB node on %s is unplugged / powered off", portName)
		}
		if req.BaudRate > 0 {
			s.rhUnits[targetIdx].BaudRate = req.BaudRate
		}
		s.rhUnits[targetIdx].Connected = true
		s.rhUnits[targetIdx].syncLinkStateLocked(nowUs, "", "", false)
		u := s.rhUnits[targetIdx].SimRotorHazardUnit
		s.mu.Unlock()
		if domain.IsRotorHazardMode(hwMode) {
			s.engine.EnsureRHTimerRegistered(u.TimerID, u.Label, true)
			s.engine.SetDetectedTimerOnline(u.TimerID, true)
		}
		s.SyncRHNodesNow()
		return s.Snapshot().RotorHazardUnits, nil

	case "connect-host":
		if isUSBMode && strings.TrimSpace(req.PortName) != "" {
			s.mu.Unlock()
			req.Action = "connect-port"
			return s.ApplyRotorHazardAction(req)
		}
		host := strings.TrimSpace(req.Host)
		if host == "" {
			host = "192.168.1.101"
		}
		port := req.Port
		if port <= 0 {
			port = 5000
		}
		targetIdx := -1
		for i := range s.rhUnits {
			if strings.EqualFold(s.rhUnits[i].Host, host) && s.rhUnits[i].Port == port {
				targetIdx = i
				break
			}
		}
		if targetIdx < 0 {
			s.mu.Unlock()
			return nil, fmt.Errorf("no simulated RotorHazard device listening on %s:%d (check Simulated RotorHazard Devices in #/sim)", host, port)
		}
		if !s.rhUnits[targetIdx].PoweredOn {
			s.mu.Unlock()
			return nil, fmt.Errorf("simulated RotorHazard device at %s:%d is powered off", host, port)
		}
		s.rhUnits[targetIdx].initProtocolObjectsLocked()
		if !s.rhUnits[targetIdx].server.CheckCredentials(req.AdminUser, req.AdminPass) {
			s.mu.Unlock()
			return nil, fmt.Errorf("RotorHazard authentication rejected on %s:%d (check Admin Username & Password)", host, port)
		}
		s.rhUnits[targetIdx].Connected = true
		s.rhUnits[targetIdx].syncLinkStateLocked(nowUs, req.AdminUser, req.AdminPass, true)
		u := s.rhUnits[targetIdx].SimRotorHazardUnit
		s.mu.Unlock()
		if domain.IsRotorHazardMode(hwMode) {
			s.engine.EnsureRHTimerRegistered(u.TimerID, u.Label, true)
			s.engine.SetDetectedTimerOnline(u.TimerID, true)
		}
		s.SyncRHNodesNow()
		return s.Snapshot().RotorHazardUnits, nil

	case "update":
		idx := findIdx(req.TimerID)
		if idx < 0 {
			s.mu.Unlock()
			return nil, tracker.ErrInvalidTimerID
		}
		if lbl := strings.TrimSpace(req.Label); lbl != "" {
			s.rhUnits[idx].Label = lbl
		}
		if pName := strings.TrimSpace(req.PortName); pName != "" {
			s.rhUnits[idx].PortName = pName
			s.rhUnits[idx].ServerHostname = pName
		}
		if req.BaudRate > 0 {
			s.rhUnits[idx].BaudRate = req.BaudRate
		}
		if host := strings.TrimSpace(req.Host); host != "" {
			s.rhUnits[idx].Host = host
		}
		if req.Port > 0 && req.Port <= 65535 {
			s.rhUnits[idx].Port = req.Port
		}
		if req.NodeCount == 4 || req.NodeCount == 8 {
			s.rhUnits[idx].NodeCount = req.NodeCount
		}
		if req.AdminUser != "" || req.AdminPass != "" {
			s.rhUnits[idx].AdminUser = strings.TrimSpace(req.AdminUser)
			s.rhUnits[idx].AdminPass = req.AdminPass
		}
		s.rhUnits[idx].initProtocolObjectsLocked()
		if !s.rhUnits[idx].isUSB() && s.rhUnits[idx].sessionAttached && s.rhUnits[idx].server != nil {
			s.rhUnits[idx].server.UpgradeSessionAuth("sim-rh-link", s.rhUnits[idx].AdminUser, s.rhUnits[idx].AdminPass)
		}
		u := s.rhUnits[idx].SimRotorHazardUnit
		s.mu.Unlock()
		if domain.IsRotorHazardMode(hwMode) {
			s.engine.EnsureRHTimerRegistered(u.TimerID, u.Label, false)
			s.engine.SetDetectedTimerOnline(u.TimerID, u.PoweredOn && u.Connected)
		}
		return s.Snapshot().RotorHazardUnits, nil

	case "add":
		used := make(map[uint8]bool, len(s.rhUnits))
		for _, u := range s.rhUnits {
			used[u.TimerID] = true
		}
		var nextID uint8
		for id := uint8(2); id <= 7; id++ {
			if !used[id] {
				nextID = id
				break
			}
		}
		if nextID == 0 {
			s.mu.Unlock()
			return nil, errors.New("maximum of 6 simulated RotorHazard devices reached")
		}
		lbl := normalizeSimRHLabel(req.Label, nextID)
		nc := normalizeSimRHNodeCount(req.NodeCount)
		var nu *simRHUnitState
		if isUSBMode {
			portName := strings.TrimSpace(req.PortName)
			if portName == "" {
				portName = fmt.Sprintf("SIM-RH-USB%d", int(nextID-1))
			}
			baud := req.BaudRate
			if baud <= 0 {
				baud = 115200
			}
			nu = &simRHUnitState{
				SimRotorHazardUnit: domain.SimRotorHazardUnit{
					TimerID:        nextID,
					Label:          lbl,
					Transport:      "usb",
					PortName:       portName,
					BaudRate:       baud,
					APILevel:       36,
					NodeCount:      nc,
					ServerVersion:  "FPVGateC5 1.2 (API 36)",
					ServerHostname: portName,
					Color:          domain.DefaultGateColors[int(nextID-2)%len(domain.DefaultGateColors)],
					PoweredOn:      true,
					Connected:      true,
					Online:         true,
					AuthOK:         true,
					GateArmed:      true,
					SlotRSSI:       [domain.MaxPilotSlots]float32{24, 24, 24, 24, 24, 24, 24, 24},
				},
			}
			nu.syncLinkStateLocked(nowUs, "", "", false)
		} else {
			host := strings.TrimSpace(req.Host)
			if host == "" {
				host = fmt.Sprintf("192.168.1.%d", 100+int(nextID-1))
			}
			port := req.Port
			if port <= 0 {
				port = 5000
			}
			adminUser := strings.TrimSpace(req.AdminUser)
			adminPass := req.AdminPass
			if adminUser == "" && adminPass == "" {
				adminUser = "admin"
				adminPass = "rotorhazard"
			}
			nu = &simRHUnitState{
				SimRotorHazardUnit: domain.SimRotorHazardUnit{
					TimerID:       nextID,
					Label:         lbl,
					Transport:     "network",
					Host:          host,
					Port:          port,
					NodeCount:     nc,
					AdminUser:     adminUser,
					AdminPass:     adminPass,
					ServerVersion: "4.5.1",
					Color:         domain.DefaultGateColors[int(nextID-2)%len(domain.DefaultGateColors)],
					PoweredOn:     true,
					Connected:     true,
					Online:        true,
					AuthOK:        true,
					GateArmed:     true,
					SlotRSSI:      [domain.MaxPilotSlots]float32{24, 24, 24, 24, 24, 24, 24, 24},
				},
			}
			nu.syncLinkStateLocked(nowUs, adminUser, adminPass, true)
		}
		nu.pendingHeartbeats = nil
		nu.pendingCrossings = nil
		s.rhUnits = append(s.rhUnits, nu)
		s.mu.Unlock()
		if domain.IsRotorHazardMode(hwMode) {
			s.engine.EnsureRHTimerRegistered(nextID, lbl, true)
			s.engine.SetDetectedTimerOnline(nextID, true)
		}
		s.SyncRHNodesNow()
		return s.Snapshot().RotorHazardUnits, nil

	case "delete":
		idx := findIdx(req.TimerID)
		if idx < 0 {
			s.mu.Unlock()
			return nil, tracker.ErrInvalidTimerID
		}
		delID := s.rhUnits[idx].TimerID
		if s.rhUnits[idx].usbSess != nil {
			_ = s.rhUnits[idx].usbSess.Close()
		}
		s.rhUnits = append(s.rhUnits[:idx], s.rhUnits[idx+1:]...)
		s.mu.Unlock()
		if domain.IsRotorHazardMode(hwMode) {
			_ = s.engine.DeleteDetectedTimer(delID)
		}
		return s.Snapshot().RotorHazardUnits, nil

	default:
		s.mu.Unlock()
		return nil, fmt.Errorf("unknown RotorHazard sim action %q", req.Action)
	}
}

// SyncRHNodesNow immediately pushes the engine's current ActiveRHNodeSpecs into all connected
// simulated RotorHazard devices (and emits an immediate heartbeat) so `#/debug` Stream toggles
// update node frequencies and RSSI snapshots without waiting for the next background tick.
func (s *TrackSimulator) SyncRHNodesNow() {
	hwMode := s.engine.TimingHardwareMode()
	if !domain.IsRotorHazardMode(hwMode) {
		return
	}
	nowUs := s.engine.NowUs()
	isArmed := s.engine.IsRaceArmed()

	s.mu.Lock()
	s.ensureRHUnitsForModeLocked(hwMode)
	timerIDs := make([]uint8, 0, len(s.rhUnits))
	for _, u := range s.rhUnits {
		timerIDs = append(timerIDs, u.TimerID)
	}
	s.mu.Unlock()

	specsByTimer := make(map[uint8][domain.MaxPilotSlots]tracker.RHNodeHardwareSpec, len(timerIDs))
	for _, tid := range timerIDs {
		specsByTimer[tid] = s.engine.ActiveRHNodeSpecs(tid)
	}

	var heartbeats []pendingRHHeartbeat
	epochMs := 1_700_000_000_000.0 + float64(nowUs)/1000.0

	s.mu.Lock()
	for _, u := range s.rhUnits {
		if !u.PoweredOn || !u.Connected {
			continue
		}
		u.syncLinkStateLocked(nowUs, "", "", false)
		var cfg [domain.MaxPilotSlots]rotorhazard.NodeConfig
		if specs, ok := specsByTimer[u.TimerID]; ok {
			for i := 0; i < domain.MaxPilotSlots; i++ {
				cfg[i] = rotorhazard.NodeConfig{
					Enabled:      specs[i].Enabled && i < u.NodeCount,
					Band:         specs[i].Band,
					Channel:      specs[i].Channel,
					FrequencyMHz: specs[i].FrequencyMHz,
					EnterAtLevel: specs[i].EnterAtLevel,
					ExitAtLevel:  specs[i].ExitAtLevel,
				}
			}
		}
		var nodeRSSI [domain.MaxPilotSlots]float32
		for ch := 0; ch < domain.MaxPilotSlots; ch++ {
			val := u.SlotRSSI[ch]
			if val <= 0 {
				val = 24
			}
			nodeRSSI[ch] = val
		}
		if u.isUSB() {
			u.usbClient.SyncNodesAndArm(cfg, isArmed)
			for ch := 0; ch < u.NodeCount && ch < domain.MaxPilotSlots; ch++ {
				u.usbNode.FeedSeatRSSI(ch, nodeRSSI[ch], nowUs)
			}
			if u.usbSess != nil {
				_ = u.usbSess.Step(context.Background(), true)
			}
		} else {
			u.client.SyncNodesAndArm(cfg, isArmed)
			u.server.StepRSSI(epochMs, nodeRSSI, true)
		}
		if len(u.pendingHeartbeats) > 0 {
			heartbeats = append(heartbeats, u.pendingHeartbeats...)
			u.pendingHeartbeats = u.pendingHeartbeats[:0]
		}
		u.pendingCrossings = u.pendingCrossings[:0]
	}
	s.mu.Unlock()

	for _, hb := range heartbeats {
		s.engine.IngestExternalRHHeartbeat(hb.timerID, hb.label, hb.slotRSSI)
	}
}

// stepRotorHazardLocked advances simulated RotorHazard RX5808 nodes (0..255 RSSI) and runs each
// connected device's reference protocol pipeline (`SimServer <-> Client` for Network mode, or
// `SimSerialNode <-> SerialClient` over binary serial bytes for USB mode).
func (s *TrackSimulator) stepRotorHazardLocked(
	nowUs uint64,
	pilots []domain.PilotSlot,
	gates []domain.TrackGate,
	sectorLen float64,
	specsByTimer map[uint8][domain.MaxPilotSlots]tracker.RHNodeHardwareSpec,
	isArmed bool,
) ([]pendingRHHeartbeat, []pendingRHCrossing) {
	s.ensureRHUnitsLocked()

	_, slotToPilot := tracker.ComputeActivePilotChannels(pilots)
	gateIdxByTimer := make(map[uint8]int, len(gates))
	for idx := range gates {
		tid := gates[idx].AssignedTimerID
		if tid > 0 {
			gateIdxByTimer[tid] = idx
		}
	}

	var heartbeats []pendingRHHeartbeat
	var crossings []pendingRHCrossing
	pollTick := s.seqCounter%5 == 0
	emitHeartbeat := !s.prewarming && pollTick
	epochMs := 1_700_000_000_000.0 + float64(nowUs)/1000.0

	for _, u := range s.rhUnits {
		if !u.PoweredOn || !u.Connected {
			u.syncLinkStateLocked(nowUs, "", "", false)
			continue
		}
		u.syncLinkStateLocked(nowUs, "", "", false)

		var cfg [domain.MaxPilotSlots]rotorhazard.NodeConfig
		hasSpecs := false
		if specs, ok := specsByTimer[u.TimerID]; ok {
			hasSpecs = true
			for i := 0; i < domain.MaxPilotSlots; i++ {
				cfg[i] = rotorhazard.NodeConfig{
					Enabled:      specs[i].Enabled && i < u.NodeCount,
					Band:         specs[i].Band,
					Channel:      specs[i].Channel,
					FrequencyMHz: specs[i].FrequencyMHz,
					EnterAtLevel: specs[i].EnterAtLevel,
					ExitAtLevel:  specs[i].ExitAtLevel,
				}
			}
		}

		gatePosMeters := 0.0
		if gIdx, ok := gateIdxByTimer[u.TimerID]; ok {
			gatePosMeters = float64(gIdx) * sectorLen
		}

		var nodeRSSI [domain.MaxPilotSlots]float32
		for ch := 0; ch < domain.MaxPilotSlots; ch++ {
			noise := (s.rng.Float64() - 0.5) * 3.6
			val := 24.0 + noise
			pIdx := slotToPilot[ch]

			if ch < u.NodeCount && pIdx >= 0 && pIdx < len(pilots) && pIdx < len(s.pilotStates) {
				p := pilots[pIdx]
				ps := s.pilotStates[pIdx]
				vtxOn := p.Enabled && p.Channel > 0 &&
					(ps.status == domain.SimStatusFlying ||
						ps.status == domain.SimStatusAvoiding ||
						ps.status == domain.SimStatusCrashedVtxOn ||
						ps.status == domain.SimStatusTurtleRecovery)

				if vtxOn {
					dx := math.Abs(ps.trackPosMeters - gatePosMeters)
					if dx > s.trackLengthMeters/2.0 {
						dx = s.trackLengthMeters - dx
					}
					alt := ps.altitudeMeters
					if alt < 0.8 {
						alt = 0.8
					}
					dist3D := math.Sqrt(dx*dx + alt*alt)
					multipathRipple := math.Sin(dx*2.7)*1.8 + math.Cos(dx*1.3)*1.2
					sigDbm := -24.5 - 23.5*math.Log10(dist3D) + multipathRipple
					aboveFloor := (sigDbm + 92.0) * 2.88
					if aboveFloor > 0 {
						val = 24.0 + aboveFloor + noise
					}
				}
			}

			if val < 14 {
				val = 14
			} else if val > 248 {
				val = 248
			}
			nodeRSSI[ch] = float32(math.Round(val))
		}

		if u.isUSB() {
			if hasSpecs {
				u.usbClient.SyncNodesAndArm(cfg, isArmed)
			}
			u.sweepEmitters = s.buildRHUSBSweepEmittersLocked(pilots, gatePosMeters)
			if u.usbClient.IsScanLive() {
				scanTick := !s.prewarming && s.seqCounter%10 == 0
				if scanTick && u.usbSess != nil {
					_ = u.usbSess.Step(context.Background(), false)
				}
			} else {
				// Sample 5.8 GHz RF physics on the simulated hardware node at 50 Hz;
				// poll over the RotorHazard binary USB serial link at 10 Hz (`pollTick`).
				for ch := 0; ch < u.NodeCount && ch < domain.MaxPilotSlots; ch++ {
					u.usbNode.FeedSeatRSSI(ch, nodeRSSI[ch], nowUs)
				}
				if pollTick && u.usbSess != nil {
					_ = u.usbSess.Step(context.Background(), emitHeartbeat)
				}
			}
		} else {
			if hasSpecs {
				u.client.SyncNodesAndArm(cfg, isArmed)
			}
			u.clockSyncTicks++
			if u.clockSyncTicks == 1 || u.clockSyncTicks%250 == 0 {
				u.client.RequestClockSync()
			}
			u.server.StepRSSI(epochMs, nodeRSSI, emitHeartbeat)
		}

		if len(u.pendingHeartbeats) > 0 {
			heartbeats = append(heartbeats, u.pendingHeartbeats...)
			u.pendingHeartbeats = u.pendingHeartbeats[:0]
		}
		if len(u.pendingCrossings) > 0 {
			crossings = append(crossings, u.pendingCrossings...)
			u.pendingCrossings = u.pendingCrossings[:0]
		}
	}

	return heartbeats, crossings
}

func (s *TrackSimulator) buildRHUSBSweepEmittersLocked(pilots []domain.PilotSlot, gatePosMeters float64) []simRHSweepEmitter {
	var out []simRHSweepEmitter
	for i := 0; i < len(pilots); i++ {
		p := pilots[i]
		if !p.Enabled || p.Channel == 0 {
			continue
		}
		freq := p.FrequencyMHz
		if freq == 0 {
			freq = domain.FrequencyForBandChannel(p.Band, p.Channel)
		}
		if freq == 0 {
			continue
		}
		above := 92.0
		if i < len(s.pilotStates) {
			ps := s.pilotStates[i]
			vtxOn := ps.status == domain.SimStatusFlying ||
				ps.status == domain.SimStatusAvoiding ||
				ps.status == domain.SimStatusCrashedVtxOn ||
				ps.status == domain.SimStatusTurtleRecovery
			if !vtxOn {
				continue
			}
			dx := math.Abs(ps.trackPosMeters - gatePosMeters)
			if s.trackLengthMeters > 0 && dx > s.trackLengthMeters/2.0 {
				dx = s.trackLengthMeters - dx
			}
			alt := ps.altitudeMeters
			if alt < 0.8 {
				alt = 0.8
			}
			dist3D := math.Sqrt(dx*dx + alt*alt)
			sigDbm := -24.5 - 23.5*math.Log10(dist3D)
			above = (sigDbm + 92.0) * 2.88
		}
		if above > 2.0 {
			out = append(out, simRHSweepEmitter{
				freqMHz:      float64(freq),
				aboveFloor:   above,
				halfWidthMHz: 8.5,
			})
		}
	}
	return out
}

func (s *TrackSimulator) findConnectedRHUSBUnitLocked(timerID uint8) (*simRHUnitState, error) {
	s.ensureRHUnitsForModeLocked(s.engine.TimingHardwareMode())
	if timerID > 0 {
		for _, u := range s.rhUnits {
			if u.TimerID == timerID && u.isUSB() {
				if !u.PoweredOn || !u.Connected {
					return nil, fmt.Errorf("simulated RotorHazard USB device %s is offline", u.Label)
				}
				return u, nil
			}
		}
	}
	for _, u := range s.rhUnits {
		if u.isUSB() && u.PoweredOn && u.Connected {
			return u, nil
		}
	}
	return nil, errors.New("no connected simulated RotorHazard USB device")
}

// RunRHUSBScanOnce performs one synchronous 0..255 RSSI spectrum sweep on a simulated RotorHazard USB device
// and restores its configured timing frequencies immediately afterwards.
func (s *TrackSimulator) RunRHUSBScanOnce(timerID uint8, startMHz, stopMHz, stepMHz int) (domain.RHScanPass, error) {
	pilots, gates, _, _, _ := s.engine.StateSnapshot()
	nowUs := s.engine.NowUs()
	isArmed := s.engine.IsRaceArmed()

	s.mu.Lock()
	u, err := s.findConnectedRHUSBUnitLocked(timerID)
	if err != nil {
		s.mu.Unlock()
		return domain.RHScanPass{}, err
	}
	targetTid := u.TimerID
	s.mu.Unlock()

	specs := s.engine.ActiveRHNodeSpecs(targetTid)

	s.mu.Lock()
	defer s.mu.Unlock()
	u, err = s.findConnectedRHUSBUnitLocked(targetTid)
	if err != nil {
		return domain.RHScanPass{}, err
	}
	u.syncLinkStateLocked(nowUs, "", "", false)
	if u.usbSess == nil {
		return domain.RHScanPass{}, errors.New("simulated RotorHazard USB serial session is not attached")
	}

	var cfg [domain.MaxPilotSlots]rotorhazard.NodeConfig
	for i := 0; i < domain.MaxPilotSlots; i++ {
		cfg[i] = rotorhazard.NodeConfig{
			Enabled:      specs[i].Enabled && i < u.NodeCount,
			Band:         specs[i].Band,
			Channel:      specs[i].Channel,
			FrequencyMHz: specs[i].FrequencyMHz,
			EnterAtLevel: specs[i].EnterAtLevel,
			ExitAtLevel:  specs[i].ExitAtLevel,
		}
	}
	u.usbClient.SyncNodesAndArm(cfg, isArmed)

	gatePosMeters := 0.0
	if len(gates) > 0 && s.trackLengthMeters > 0 {
		sectorLen := s.trackLengthMeters / float64(len(gates))
		for idx := range gates {
			if gates[idx].AssignedTimerID == u.TimerID {
				gatePosMeters = float64(idx) * sectorLen
				break
			}
		}
	}
	u.sweepEmitters = s.buildRHUSBSweepEmittersLocked(pilots, gatePosMeters)
	pass, sErr := u.usbSess.SweepOnce(context.Background(), startMHz, stopMHz, stepMHz)
	if sErr == nil && pass.PassMs < 95 {
		pass.PassMs = 120
	}
	return pass, sErr
}

// SetRHUSBScanLive starts or stops continuous 0..255 RSSI spectrum sweeping on a simulated RotorHazard USB device.
func (s *TrackSimulator) SetRHUSBScanLive(timerID uint8, active bool, startMHz, stopMHz, stepMHz int) error {
	pilots, gates, _, _, _ := s.engine.StateSnapshot()
	nowUs := s.engine.NowUs()
	isArmed := s.engine.IsRaceArmed()

	s.mu.Lock()
	if !active && timerID == 0 {
		for _, u := range s.rhUnits {
			if u.isUSB() && u.usbClient != nil {
				u.usbClient.SetScanLive(false, startMHz, stopMHz, stepMHz)
			}
		}
		s.mu.Unlock()
		s.SyncRHNodesNow()
		return nil
	}

	u, err := s.findConnectedRHUSBUnitLocked(timerID)
	if err != nil {
		s.mu.Unlock()
		if !active {
			return nil
		}
		return err
	}
	targetTid := u.TimerID
	s.mu.Unlock()

	specs := s.engine.ActiveRHNodeSpecs(targetTid)

	s.mu.Lock()
	u, err = s.findConnectedRHUSBUnitLocked(targetTid)
	if err != nil {
		s.mu.Unlock()
		if !active {
			return nil
		}
		return err
	}
	u.syncLinkStateLocked(nowUs, "", "", false)
	var cfg [domain.MaxPilotSlots]rotorhazard.NodeConfig
	for i := 0; i < domain.MaxPilotSlots; i++ {
		cfg[i] = rotorhazard.NodeConfig{
			Enabled:      specs[i].Enabled && i < u.NodeCount,
			Band:         specs[i].Band,
			Channel:      specs[i].Channel,
			FrequencyMHz: specs[i].FrequencyMHz,
			EnterAtLevel: specs[i].EnterAtLevel,
			ExitAtLevel:  specs[i].ExitAtLevel,
		}
	}
	u.usbClient.SyncNodesAndArm(cfg, isArmed)
	u.usbClient.SetScanLive(active, startMHz, stopMHz, stepMHz)
	if active && u.usbSess != nil {
		gatePosMeters := 0.0
		if len(gates) > 0 && s.trackLengthMeters > 0 {
			sectorLen := s.trackLengthMeters / float64(len(gates))
			for idx := range gates {
				if gates[idx].AssignedTimerID == u.TimerID {
					gatePosMeters = float64(idx) * sectorLen
					break
				}
			}
		}
		u.sweepEmitters = s.buildRHUSBSweepEmittersLocked(pilots, gatePosMeters)
		_ = u.usbSess.Step(context.Background(), false)
	}
	s.mu.Unlock()

	if !active {
		s.SyncRHNodesNow()
	}
	return nil
}
