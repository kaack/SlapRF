package rotorhazard

import (
	"encoding/json"
	"math"
	"strings"
	"sync"

	"slaprf/internal/domain"
)

// SimNodeState models an individual RX5808 + Arduino node (`0..NodeCount-1`) inside one RotorHazard device,
// faithfully mirroring `Node.py` and `BaseHardwareInterface.py` (`enter_at_level`, `exit_at_level`,
// `crossing_flag`, `pass_peak_rssi`, `pass_nadir_rssi`, peak timestamping, and clear-to-crossing hysteresis).
type SimNodeState struct {
	FrequencyMHz  uint16
	Band          string
	Channel       int
	CurrentRSSI   float32
	EnterAtLevel  uint8
	ExitAtLevel   uint8
	NodePeakRSSI  float32
	NodeNadirRSSI float32
	PassPeakRSSI  float32
	PassNadirRSSI float32

	// Hardware state machine (`Clear` <-> `Crossing`)
	CrossingFlag  bool
	PeakRSSI      float32
	PeakEpochMs   float64
	LastPassEpoch float64
}

// SimServerConfig configures one simulated RotorHazard Raspberry Pi timing server (`RH1`, `RH2`, ...).
type SimServerConfig struct {
	Hostname      string
	ReleaseVer    string
	NodeCount     int // 1..8 (typically 4 or 8 RX5808 modules)
	AdminUsername string
	AdminPassword string
	EpochMsFn     func() float64
}

type simSession struct {
	id      string
	authOK  bool
	sendSIO func(frame string)
}

// SimServer is a reference-faithful RotorHazard v4.5/v4.6 server state machine supporting:
//   - HTTP Basic Auth admin enforcement (`AdminAuth.py` `@requires_socketio_auth`)
//   - Split-timer cluster join (`join_cluster_ex` -> `join_cluster_response` + `secondary_race_format`)
//   - Clock synchronization (`check_secondary_query` -> `check_secondary_response` + `get_pi_time`)
//   - Per-node RX5808 tuning & dual hysteresis (`set_frequency`, `set_enter_at_level`, `set_exit_at_level`)
//   - Race staging & stopping (`stage_race`, `stop_race`, `discard_laps`, `race_status`)
//   - Continuous ~10 Hz `heartbeat` streaming (`0..255` RSSI) and Crossing->Peak->Exit `pass_record` + `SendAckQueue`
//
// It can run purely in-memory (inside `slaprf.wasm` for multi-device Simulation mode) OR over real
// Engine.IO v4 HTTP Polling + WebSockets via `sim_server_http.go`!
type SimServer struct {
	mu            sync.Mutex
	hostname      string
	releaseVer    string
	nodeCount     int
	adminUser     string
	adminPass     string
	epochMsFn     func() float64
	secondaryMode string
	raceStatus    int
	nodes         [domain.MaxPilotSlots]SimNodeState
	sessions      map[string]*simSession
	unackedPasses int
	ackedPasses   int
	hbTicks       uint64
}

// NewSimServer creates a new simulated RotorHazard server.
func NewSimServer(cfg SimServerConfig) *SimServer {
	nc := cfg.NodeCount
	if nc < 1 {
		nc = domain.MaxPilotSlots
	} else if nc > domain.MaxPilotSlots {
		nc = domain.MaxPilotSlots
	}
	ver := strings.TrimSpace(cfg.ReleaseVer)
	if ver == "" {
		ver = "4.5.1"
	}
	host := strings.TrimSpace(cfg.Hostname)
	if host == "" {
		host = "rotorhazard-sim"
	}
	s := &SimServer{
		hostname:   host,
		releaseVer: ver,
		nodeCount:  nc,
		adminUser:  cfg.AdminUsername,
		adminPass:  cfg.AdminPassword,
		epochMsFn:  cfg.EpochMsFn,
		raceStatus: RHRaceStatusReady,
		sessions:   make(map[string]*simSession),
	}
	defaultFreqs := domain.RacebandFrequenciesMHz
	for i := 0; i < domain.MaxPilotSlots; i++ {
		s.nodes[i] = SimNodeState{
			FrequencyMHz:  defaultFreqs[i],
			Band:          "R",
			Channel:       i + 1,
			CurrentRSSI:   24,
			EnterAtLevel:  95,
			ExitAtLevel:   70,
			NodePeakRSSI:  210,
			NodeNadirRSSI: 22,
			PassPeakRSSI:  0,
			PassNadirRSSI: 24,
		}
	}
	return s
}

// SetConfig updates node count and admin credentials on a live simulated RotorHazard device.
func (s *SimServer) SetConfig(hostname string, nodeCount int, adminUser, adminPass string) {
	s.mu.Lock()
	if strings.TrimSpace(hostname) != "" {
		s.hostname = strings.TrimSpace(hostname)
	}
	if nodeCount >= 1 && nodeCount <= domain.MaxPilotSlots {
		s.nodeCount = nodeCount
	}
	s.adminUser = adminUser
	s.adminPass = adminPass
	s.mu.Unlock()
}

// CheckCredentials evaluates RotorHazard's `AdminAuth.py` Basic Auth policy:
// if both `adminUser` and `adminPass` are empty, admin auth is open (Debug/first-run mode);
// otherwise username and password must match.
func (s *SimServer) CheckCredentials(user, pass string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.checkCredentialsLocked(user, pass)
}

func (s *SimServer) checkCredentialsLocked(user, pass string) bool {
	if s.adminUser == "" && s.adminPass == "" {
		return true
	}
	return user == s.adminUser && pass == s.adminPass
}

func (s *SimServer) nowEpochMsLocked() float64 {
	if s.epochMsFn != nil {
		return s.epochMsFn()
	}
	return 1_700_000_000_000.0
}

// AttachSession registers a connected Socket.IO client session (either in-memory or HTTP/WS).
func (s *SimServer) AttachSession(sid string, user, pass string, sendSIO func(frame string)) bool {
	s.mu.Lock()
	authOK := s.checkCredentialsLocked(user, pass)
	s.sessions[sid] = &simSession{
		id:      sid,
		authOK:  authOK,
		sendSIO: sendSIO,
	}
	s.mu.Unlock()
	return authOK
}

// DetachSession removes a disconnected Socket.IO client session.
func (s *SimServer) DetachSession(sid string) {
	s.mu.Lock()
	delete(s.sessions, sid)
	s.mu.Unlock()
}

// UpgradeSessionAuth updates a polling session's cached `socketio_admin_auth` if valid Basic Auth was presented.
func (s *SimServer) UpgradeSessionAuth(sid string, user, pass string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[sid]
	if !ok {
		return false
	}
	if s.checkCredentialsLocked(user, pass) {
		sess.authOK = true
	}
	return sess.authOK
}

// HandleClientFrame processes an inbound Socket.IO event (`42[...]`) from session `sid`.
func (s *SimServer) HandleClientFrame(sid string, frame string) {
	ev, err := DecodeSIOEvent(frame)
	if err != nil {
		return
	}

	type targetedMsg struct {
		to   func(string)
		pkt  string
	}
	var replies []targetedMsg

	s.mu.Lock()
	sess := s.sessions[sid]
	if sess == nil {
		s.mu.Unlock()
		return
	}

	replySelf := func(name string, payload any) {
		if pkt, e := EncodeSIOEvent(name, payload, true); e == nil {
			replies = append(replies, targetedMsg{to: sess.sendSIO, pkt: pkt})
		}
	}
	broadcast := func(name string, payload any) {
		pkt, e := EncodeSIOEvent(name, payload, true)
		if e != nil {
			return
		}
		for _, peer := range s.sessions {
			replies = append(replies, targetedMsg{to: peer.sendSIO, pkt: pkt})
		}
	}

	switch ev.Name {
	case "join_cluster_ex", "join_cluster":
		mode := "split"
		if ev.HasArg {
			var body struct {
				Mode string `json:"mode"`
			}
			if json.Unmarshal(ev.RawArg, &body) == nil && body.Mode != "" {
				mode = body.Mode
			}
		}
		s.secondaryMode = mode
		infoBytes, _ := json.Marshal(map[string]any{
			"api_version":     50,
			"release_version": s.releaseVer,
			"hostname":        s.hostname,
			"node_count":      s.nodeCount,
		})
		replySelf("race_status", s.raceStatusPayloadLocked())
		replySelf("join_cluster_response", map[string]any{
			"server_info": string(infoBytes),
			"auth_ok":     sess.authOK,
		})

	case "check_secondary_query":
		replySelf("check_secondary_response", map[string]any{
			"timestamp": s.nowEpochMsLocked(),
		})

	case "get_pi_time":
		replySelf("pi_time", map[string]any{
			"pi_time_s": s.nowEpochMsLocked() / 1000.0,
		})

	case "load_data":
		var body struct {
			LoadTypes []any `json:"load_types"`
		}
		if ev.HasArg && json.Unmarshal(ev.RawArg, &body) == nil {
			for _, raw := range body.LoadTypes {
				lt, ok := raw.(string)
				if !ok {
					continue
				}
				switch lt {
				case "frequency_data":
					replySelf("frequency_data", s.frequencyDataPayloadLocked())
				case "node_data":
					replySelf("node_data", s.nodeDataPayloadLocked())
				case "enter_and_exit_at_levels":
					replySelf("enter_and_exit_at_levels", s.enterExitPayloadLocked())
				case "race_status":
					replySelf("race_status", s.raceStatusPayloadLocked())
				case "environmental_data":
					replySelf("environmental_data", s.envDataPayloadLocked())
				}
			}
		}

	case "set_frequency":
		if !sess.authOK {
			break
		}
		var body struct {
			Node      int    `json:"node"`
			Frequency int    `json:"frequency"`
			Band      string `json:"band"`
			Channel   int    `json:"channel"`
		}
		if ev.HasArg && json.Unmarshal(ev.RawArg, &body) == nil && body.Node >= 0 && body.Node < s.nodeCount {
			if body.Frequency <= 0 {
				s.nodes[body.Node].FrequencyMHz = 0
				s.nodes[body.Node].CrossingFlag = false
			} else if body.Frequency <= 65535 {
				s.nodes[body.Node].FrequencyMHz = uint16(body.Frequency)
			}
			s.nodes[body.Node].Band = body.Band
			s.nodes[body.Node].Channel = body.Channel
			broadcast("frequency_set", map[string]any{
				"node":      body.Node,
				"frequency": int(s.nodes[body.Node].FrequencyMHz),
			})
			broadcast("frequency_data", s.frequencyDataPayloadLocked())
		}

	case "set_enter_at_level":
		if !sess.authOK {
			break
		}
		var body struct {
			Node         int `json:"node"`
			EnterAtLevel int `json:"enter_at_level"`
		}
		if ev.HasArg && json.Unmarshal(ev.RawArg, &body) == nil && body.Node >= 0 && body.Node < s.nodeCount {
			lvl := clampUint8(body.EnterAtLevel, 10, 250)
			s.nodes[body.Node].EnterAtLevel = lvl
			if s.nodes[body.Node].ExitAtLevel >= lvl {
				s.nodes[body.Node].ExitAtLevel = clampUint8(int(lvl)-8, 5, 240)
			}
			broadcast("node_enter_at_level", map[string]any{
				"node":  body.Node,
				"level": int(lvl),
			})
		}

	case "set_exit_at_level":
		if !sess.authOK {
			break
		}
		var body struct {
			Node        int `json:"node"`
			ExitAtLevel int `json:"exit_at_level"`
		}
		if ev.HasArg && json.Unmarshal(ev.RawArg, &body) == nil && body.Node >= 0 && body.Node < s.nodeCount {
			maxExit := int(s.nodes[body.Node].EnterAtLevel) - 4
			if maxExit < 5 {
				maxExit = 5
			}
			lvl := clampUint8(body.ExitAtLevel, 5, maxExit)
			s.nodes[body.Node].ExitAtLevel = lvl
			broadcast("node_exit_at_level", map[string]any{
				"node":  body.Node,
				"level": int(lvl),
			})
		}

	case "stage_race":
		if !sess.authOK {
			break
		}
		if s.raceStatus == RHRaceStatusReady {
			for i := 0; i < s.nodeCount; i++ {
				s.nodes[i].CrossingFlag = false
			}
			// In secondary_race_format (`start_delay == 0`), RH transitions directly into RACING!
			s.raceStatus = RHRaceStatusRacing
			broadcast("race_status", s.raceStatusPayloadLocked())
		}

	case "stop_race":
		if !sess.authOK {
			break
		}
		if s.raceStatus == RHRaceStatusRacing || s.raceStatus == RHRaceStatusStaging {
			s.raceStatus = RHRaceStatusDone
			for i := 0; i < s.nodeCount; i++ {
				s.nodes[i].CrossingFlag = false
			}
			broadcast("race_status", s.raceStatusPayloadLocked())
		}

	case "discard_laps":
		if !sess.authOK {
			break
		}
		// Ensure zero-arg handler compliance: upstream RH rejects positional args on `on_discard_laps(**kwargs)`
		if !ev.HasArg {
			if s.raceStatus == RHRaceStatusDone {
				s.raceStatus = RHRaceStatusReady
			}
			broadcast("race_status", s.raceStatusPayloadLocked())
		}

	case "cluster_message_ack":
		s.ackedPasses++
		if s.unackedPasses > 0 {
			s.unackedPasses--
		}
	}
	s.mu.Unlock()

	for _, r := range replies {
		if r.to != nil {
			r.to(r.pkt)
		}
	}
}

// StepRSSI advances the simulated RX5808 nodes by one sample at `epochMs` using RotorHazard's
// exact dual-threshold Crossing -> Peak -> ExitAt state machine (`BaseHardwareInterface.py`),
// optionally emitting a ~10 Hz `heartbeat` and any completed `node_data` + `pass_record` frames
// (only when `raceStatus == RHRaceStatusRacing`, matching `RHRace.py` line 881!).
func (s *SimServer) StepRSSI(
	epochMs float64,
	nodeRSSI [domain.MaxPilotSlots]float32,
	emitHeartbeat bool,
) {
	var outbound []string
	var peers []func(string)

	s.mu.Lock()
	for _, sess := range s.sessions {
		if sess.sendSIO != nil {
			peers = append(peers, sess.sendSIO)
		}
	}

	type completedPass struct {
		node      int
		freq      uint16
		peakEpoch float64
	}
	var passes []completedPass

	for i := 0; i < s.nodeCount; i++ {
		nd := &s.nodes[i]
		val := nodeRSSI[i]
		if val < 0 {
			val = 0
		} else if val > 255 {
			val = 255
		}
		// Disabled node (`frequency == 0`) reads quiet noise floor and never crosses
		if nd.FrequencyMHz == 0 {
			nd.CurrentRSSI = float32(math.Min(30, float64(val)))
			nd.CrossingFlag = false
			continue
		}
		nd.CurrentRSSI = float32(math.Round(float64(val)))
		if nd.CurrentRSSI > nd.NodePeakRSSI {
			nd.NodePeakRSSI = nd.CurrentRSSI
		}
		if nd.NodeNadirRSSI == 0 || (nd.CurrentRSSI > 0 && nd.CurrentRSSI < nd.NodeNadirRSSI) {
			nd.NodeNadirRSSI = nd.CurrentRSSI
		}

		enter := float32(nd.EnterAtLevel)
		exit := float32(nd.ExitAtLevel)
		if exit >= enter {
			exit = enter - 4
		}

		if !nd.CrossingFlag {
			if nd.CurrentRSSI >= enter && (nd.LastPassEpoch == 0 || epochMs-nd.LastPassEpoch >= 500.0) {
				nd.CrossingFlag = true
				nd.PeakRSSI = nd.CurrentRSSI
				nd.PeakEpochMs = epochMs
			}
		} else {
			if nd.CurrentRSSI > nd.PeakRSSI {
				nd.PeakRSSI = nd.CurrentRSSI
				nd.PeakEpochMs = epochMs
			}
			if nd.CurrentRSSI <= exit {
				nd.CrossingFlag = false
				nd.PassPeakRSSI = nd.PeakRSSI
				nd.PassNadirRSSI = nd.CurrentRSSI
				nd.LastPassEpoch = nd.PeakEpochMs
				// Upstream RotorHazard RHRace.py only emits pass_record when race_status == RACING!
				if s.raceStatus == RHRaceStatusRacing {
					passes = append(passes, completedPass{
						node:      i,
						freq:      nd.FrequencyMHz,
						peakEpoch: nd.PeakEpochMs,
					})
					s.unackedPasses++
				}
			}
		}
	}

	if len(passes) > 0 && len(peers) > 0 {
		if ndPkt, err := EncodeSIOEvent("node_data", s.nodeDataPayloadLocked(), true); err == nil {
			outbound = append(outbound, ndPkt)
		}
		for _, p := range passes {
			if passPkt, err := EncodeSIOEvent("pass_record", map[string]any{
				"node":      p.node,
				"frequency": int(p.freq),
				"timestamp": p.peakEpoch,
			}, true); err == nil {
				outbound = append(outbound, passPkt)
			}
		}
	}
	if emitHeartbeat {
		s.hbTicks++
		if len(peers) > 0 {
			if hbPkt, err := EncodeSIOEvent("heartbeat", s.heartbeatPayloadLocked(), true); err == nil {
				outbound = append(outbound, hbPkt)
			}
			if s.hbTicks == 1 || s.hbTicks%20 == 0 {
				if envPkt, err := EncodeSIOEvent("environmental_data", s.envDataPayloadLocked(), true); err == nil {
					outbound = append(outbound, envPkt)
				}
			}
		}
	}
	s.mu.Unlock()

	for _, send := range peers {
		for _, pkt := range outbound {
			send(pkt)
		}
	}
}

// AckedPasses returns the count of `cluster_message_ack` acknowledgements received by this server.
func (s *SimServer) AckedPasses() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ackedPasses
}

// RaceStatus returns the server's current `RHRaceStatus*` value.
func (s *SimServer) RaceStatus() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.raceStatus
}

// NodeCount returns the configured number of RX5808 nodes on this RotorHazard device.
func (s *SimServer) NodeCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.nodeCount
}

// NodeSnapshot returns a copy of the internal RX5808 node array.
func (s *SimServer) NodeSnapshot() ([]SimNodeState, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]SimNodeState, s.nodeCount)
	copy(out, s.nodes[:s.nodeCount])
	return out, s.raceStatus
}

func (s *SimServer) heartbeatPayloadLocked() map[string]any {
	rssi := make([]float32, s.nodeCount)
	freqs := make([]int, s.nodeCount)
	crossing := make([]bool, s.nodeCount)
	loops := make([]int, s.nodeCount)
	for i := 0; i < s.nodeCount; i++ {
		rssi[i] = s.nodes[i].CurrentRSSI
		freqs[i] = int(s.nodes[i].FrequencyMHz)
		crossing[i] = s.nodes[i].CrossingFlag
		loops[i] = 950
	}
	return map[string]any{
		"current_rssi":  rssi,
		"frequency":     freqs,
		"crossing_flag": crossing,
		"loop_time":     loops,
	}
}

func (s *SimServer) nodeDataPayloadLocked() map[string]any {
	np := make([]float32, s.nodeCount)
	nn := make([]float32, s.nodeCount)
	pp := make([]float32, s.nodeCount)
	pn := make([]float32, s.nodeCount)
	for i := 0; i < s.nodeCount; i++ {
		np[i] = s.nodes[i].NodePeakRSSI
		nn[i] = s.nodes[i].NodeNadirRSSI
		pp[i] = s.nodes[i].PassPeakRSSI
		pn[i] = s.nodes[i].PassNadirRSSI
	}
	return map[string]any{
		"node_peak_rssi":  np,
		"node_nadir_rssi": nn,
		"pass_peak_rssi":  pp,
		"pass_nadir_rssi": pn,
	}
}

func (s *SimServer) enterExitPayloadLocked() map[string]any {
	en := make([]int, s.nodeCount)
	ex := make([]int, s.nodeCount)
	for i := 0; i < s.nodeCount; i++ {
		en[i] = int(s.nodes[i].EnterAtLevel)
		ex[i] = int(s.nodes[i].ExitAtLevel)
	}
	return map[string]any{
		"enter_at_levels": en,
		"exit_at_levels":  ex,
	}
}

func (s *SimServer) frequencyDataPayloadLocked() map[string]any {
	type fitem struct {
		Band    string `json:"band"`
		Channel int    `json:"channel"`
		Freq    int    `json:"freq"`
	}
	fdata := make([]fitem, s.nodeCount)
	for i := 0; i < s.nodeCount; i++ {
		fdata[i] = fitem{
			Band:    s.nodes[i].Band,
			Channel: s.nodes[i].Channel,
			Freq:    int(s.nodes[i].FrequencyMHz),
		}
	}
	return map[string]any{"fdata": fdata}
}

func (s *SimServer) raceStatusPayloadLocked() map[string]any {
	return map[string]any{
		"race_status":    s.raceStatus,
		"race_mode":      0,
		"unlimited_time": true,
	}
}

func (s *SimServer) envDataPayloadLocked() []map[string]any {
	tempC := math.Round((47.6+1.8*math.Sin(float64(s.hbTicks)*0.08))*10.0) / 10.0
	return []map[string]any{
		{
			"name":        "Raspberry Pi CPU",
			"temperature": tempC,
		},
	}
}

func clampUint8(v, lo, hi int) uint8 {
	if v < lo {
		return uint8(lo)
	}
	if v > hi {
		return uint8(hi)
	}
	return uint8(v)
}
