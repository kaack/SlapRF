//go:build !js

package storage

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	_ "modernc.org/sqlite"

	"slaprf/internal/domain"
	"slaprf/internal/tracker"
)

// SQLiteStore persists the Go backend's real-world timing state (settings, pilots, track gates,
// hardware timers, laps, crossings, and filtered detections) in a local SQLite database.
type SQLiteStore struct {
	mu sync.Mutex
	db *sql.DB
}

// NewSQLiteStore opens (or creates) the SQLite database at `dbPath` and initializes its schema.
func NewSQLiteStore(dbPath string) (*SQLiteStore, error) {
	if dbPath == "" {
		dbPath = "slaprf.db"
	}
	if dbPath != ":memory:" {
		if dir := filepath.Dir(dbPath); dir != "" && dir != "." {
			if err := os.MkdirAll(dir, 0o755); err != nil {
				return nil, fmt.Errorf("create db dir: %w", err)
			}
		}
	}

	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, fmt.Errorf("open sqlite %s: %w", dbPath, err)
	}
	db.SetMaxOpenConns(1)

	s := &SQLiteStore{db: db}
	if err := s.initSchema(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}

func (s *SQLiteStore) initSchema() error {
	schema := `
	PRAGMA journal_mode = WAL;
	PRAGMA synchronous = NORMAL;
	PRAGMA busy_timeout = 5000;

	CREATE TABLE IF NOT EXISTS app_settings (
		key        TEXT PRIMARY KEY,
		value_json TEXT NOT NULL,
		updated_at TEXT NOT NULL
	);

	CREATE TABLE IF NOT EXISTS engine_meta (
		id         INTEGER PRIMARY KEY CHECK (id = 1),
		elapsed_us INTEGER NOT NULL,
		race_armed INTEGER NOT NULL,
		rules_json TEXT NOT NULL,
		updated_at TEXT NOT NULL
	);

	CREATE TABLE IF NOT EXISTS pilots (
		slot_index       INTEGER PRIMARY KEY,
		callsign         TEXT NOT NULL,
		enabled          INTEGER NOT NULL,
		band             INTEGER NOT NULL,
		channel          INTEGER NOT NULL,
		frequency_mhz    INTEGER NOT NULL,
		enter_threshold  REAL NOT NULL,
		exit_threshold   REAL NOT NULL,
		attenuation_gain INTEGER NOT NULL,
		color            TEXT NOT NULL
	);

	CREATE TABLE IF NOT EXISTS gates (
		gate_id               INTEGER PRIMARY KEY,
		assigned_timer_id     INTEGER NOT NULL,
		timer_label           TEXT NOT NULL,
		name                  TEXT NOT NULL,
		color                 TEXT NOT NULL,
		role                  TEXT NOT NULL,
		track_order           INTEGER NOT NULL,
		map_x                 REAL NOT NULL,
		map_y                 REAL NOT NULL,
		battery_mv            INTEGER NOT NULL,
		battery_pct           INTEGER NOT NULL,
		noise_floor_dbm       REAL NOT NULL,
		firmware_version      TEXT NOT NULL,
		frames_rx_count       INTEGER NOT NULL,
		enter_thresholds_json TEXT NOT NULL,
		rule_overrides_json   TEXT NOT NULL
	);

	CREATE TABLE IF NOT EXISTS timers (
		timer_id         INTEGER PRIMARY KEY,
		timer_label      TEXT NOT NULL,
		color            TEXT NOT NULL,
		is_hub           INTEGER NOT NULL,
		firmware_version TEXT NOT NULL,
		firmware_profile TEXT NOT NULL,
		fingerprint      TEXT NOT NULL,
		battery_mv       INTEGER NOT NULL,
		battery_pct      INTEGER NOT NULL,
		noise_floor_dbm  REAL NOT NULL
	);

	CREATE TABLE IF NOT EXISTS laps (
		lap_id          INTEGER PRIMARY KEY,
		slot_index      INTEGER NOT NULL,
		callsign        TEXT NOT NULL,
		lap_number      INTEGER NOT NULL,
		lap_time_sec    REAL NOT NULL,
		delta_to_best   REAL NOT NULL,
		completed_at_us INTEGER NOT NULL,
		is_best_lap     INTEGER NOT NULL,
		sectors_json    TEXT NOT NULL
	);

	CREATE TABLE IF NOT EXISTS crossings (
		event_id            INTEGER PRIMARY KEY,
		gate_id             INTEGER NOT NULL,
		gate_name           TEXT NOT NULL,
		is_start_finish     INTEGER NOT NULL,
		started_lap         INTEGER NOT NULL,
		passing_number      INTEGER NOT NULL,
		slot_index          INTEGER NOT NULL,
		callsign            TEXT NOT NULL,
		frequency_mhz       INTEGER NOT NULL,
		timestamp_us        INTEGER NOT NULL,
		peak_rssi_dbm       REAL NOT NULL,
		laprf_peak_height   REAL NOT NULL,
		beamwidth_ms        REAL NOT NULL,
		estimated_speed_mph REAL NOT NULL
	);

	CREATE TABLE IF NOT EXISTS filtered_detections (
		seq           INTEGER PRIMARY KEY,
		timestamp_us  INTEGER NOT NULL,
		gate_id       INTEGER NOT NULL,
		slot_index    INTEGER NOT NULL,
		callsign      TEXT NOT NULL,
		reason        TEXT NOT NULL,
		detail        TEXT NOT NULL,
		peak_rssi_dbm REAL NOT NULL
	);
	`
	_, err := s.db.Exec(schema)
	return err
}

// Close closes the underlying SQLite connection.
func (s *SQLiteStore) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.db == nil {
		return nil
	}
	return s.db.Close()
}

// Load reads the persisted RealBackendState from SQLite. Returns `found=false` when the database is empty.
func (s *SQLiteStore) Load() (*RealBackendState, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	var count int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM engine_meta WHERE id = 1`).Scan(&count); err != nil {
		return nil, false, err
	}
	if count == 0 {
		return nil, false, nil
	}

	eng, err := s.loadEngine()
	if err != nil {
		return nil, false, err
	}

	var liveTimeEnabled bool
	var ltRaw string
	if err := s.db.QueryRow(`SELECT value_json FROM app_settings WHERE key = 'livetime_enabled'`).Scan(&ltRaw); err == nil {
		_ = json.Unmarshal([]byte(ltRaw), &liveTimeEnabled)
	}

	return &RealBackendState{
		Engine:          eng,
		LiveTimeEnabled: liveTimeEnabled,
	}, true, nil
}

func (s *SQLiteStore) loadEngine() (tracker.PersistedEngineState, error) {
	out := tracker.PersistedEngineState{
		RaceArmed: true,
		Rules:     domain.DefaultTimingRules(),
		Gates:     []domain.TrackGate{},
		Timers:    []domain.DetectedTimer{},
		Laps:      []domain.LapRecord{},
		Crossings: []domain.GateCrossingEvent{},
		Filtered:  []domain.FilteredDetection{},
	}

	var elapsedUs int64
	var armedInt int
	var rulesJSON string
	err := s.db.QueryRow(`SELECT elapsed_us, race_armed, rules_json FROM engine_meta WHERE id = 1`).
		Scan(&elapsedUs, &armedInt, &rulesJSON)
	if err == sql.ErrNoRows {
		return out, nil
	}
	if err != nil {
		return out, err
	}
	out.ElapsedUs = uint64(elapsedUs)
	out.RaceArmed = armedInt != 0
	if rulesJSON != "" {
		_ = json.Unmarshal([]byte(rulesJSON), &out.Rules)
	}

	// Pilots
	pRows, err := s.db.Query(`
		SELECT slot_index, callsign, enabled, band, channel, frequency_mhz,
		       enter_threshold, exit_threshold, attenuation_gain, color
		FROM pilots ORDER BY slot_index ASC`)
	if err != nil {
		return out, err
	}
	defer pRows.Close()
	for pRows.Next() {
		var p domain.PilotSlot
		var enInt, bandInt, chInt, freqInt, gainInt int
		var enterThr, exitThr float64
		if err := pRows.Scan(
			&p.SlotIndex, &p.Callsign, &enInt, &bandInt, &chInt, &freqInt,
			&enterThr, &exitThr, &gainInt, &p.Color,
		); err != nil {
			return out, err
		}
		p.Enabled = enInt != 0
		p.Band = domain.Band(bandInt)
		p.Channel = uint8(chInt)
		p.FrequencyMHz = uint16(freqInt)
		p.EnterThreshold = float32(enterThr)
		p.ExitThreshold = float32(exitThr)
		p.AttenuationGain = uint16(gainInt)
		out.Pilots = append(out.Pilots, p)
	}

	// Gates
	gRows, err := s.db.Query(`
		SELECT gate_id, assigned_timer_id, timer_label, name, color, role, track_order,
		       map_x, map_y, battery_mv, battery_pct, noise_floor_dbm, firmware_version,
		       frames_rx_count, enter_thresholds_json, rule_overrides_json
		FROM gates ORDER BY track_order ASC, gate_id ASC`)
	if err != nil {
		return out, err
	}
	defer gRows.Close()
	for gRows.Next() {
		var g domain.TrackGate
		var gateID, assignedID, battMv, battPct int
		var rxCount int64
		var roleStr, thrJSON, rulesOvrJSON string
		var noiseDbm float64
		if err := gRows.Scan(
			&gateID, &assignedID, &g.TimerLabel, &g.Name, &g.Color, &roleStr, &g.TrackOrder,
			&g.MapX, &g.MapY, &battMv, &battPct, &noiseDbm, &g.FirmwareVersion,
			&rxCount, &thrJSON, &rulesOvrJSON,
		); err != nil {
			return out, err
		}
		g.GateID = uint8(gateID)
		g.AssignedTimerID = uint8(assignedID)
		g.Role = domain.GateRole(roleStr)
		g.BatteryMv = uint16(battMv)
		g.BatteryPct = uint8(battPct)
		g.NoiseFloorDbm = float32(noiseDbm)
		g.FramesRxCount = uint64(rxCount)
		if thrJSON != "" {
			_ = json.Unmarshal([]byte(thrJSON), &g.EnterThresholds)
		}
		if rulesOvrJSON != "" {
			_ = json.Unmarshal([]byte(rulesOvrJSON), &g.RuleOverrides)
		}
		out.Gates = append(out.Gates, g)
	}

	// Timers
	tRows, err := s.db.Query(`
		SELECT timer_id, timer_label, color, is_hub, firmware_version, firmware_profile,
		       fingerprint, battery_mv, battery_pct, noise_floor_dbm
		FROM timers ORDER BY timer_id ASC`)
	if err != nil {
		return out, err
	}
	defer tRows.Close()
	for tRows.Next() {
		var d domain.DetectedTimer
		var tID, isHubInt, battMv, battPct int
		var noiseDbm float64
		if err := tRows.Scan(
			&tID, &d.TimerLabel, &d.Color, &isHubInt, &d.FirmwareVersion, &d.FirmwareProfile,
			&d.Fingerprint, &battMv, &battPct, &noiseDbm,
		); err != nil {
			return out, err
		}
		d.TimerID = uint8(tID)
		d.IsHub = isHubInt != 0
		d.BatteryMv = uint16(battMv)
		d.BatteryPct = uint8(battPct)
		d.NoiseFloorDbm = float32(noiseDbm)
		out.Timers = append(out.Timers, d)
	}

	// Laps
	lRows, err := s.db.Query(`
		SELECT lap_id, slot_index, callsign, lap_number, lap_time_sec, delta_to_best,
		       completed_at_us, is_best_lap, sectors_json
		FROM laps ORDER BY lap_id ASC`)
	if err != nil {
		return out, err
	}
	defer lRows.Close()
	for lRows.Next() {
		var l domain.LapRecord
		var lapID, compUs int64
		var isBestInt int
		var sectorsJSON string
		if err := lRows.Scan(
			&lapID, &l.SlotIndex, &l.Callsign, &l.LapNumber, &l.LapTimeSec, &l.DeltaToBest,
			&compUs, &isBestInt, &sectorsJSON,
		); err != nil {
			return out, err
		}
		l.LapID = uint64(lapID)
		l.CompletedAtUs = uint64(compUs)
		l.IsBestLap = isBestInt != 0
		if sectorsJSON != "" {
			_ = json.Unmarshal([]byte(sectorsJSON), &l.Sectors)
		}
		out.Laps = append(out.Laps, l)
	}

	// Crossings
	cRows, err := s.db.Query(`
		SELECT event_id, gate_id, gate_name, is_start_finish, started_lap, passing_number,
		       slot_index, callsign, frequency_mhz, timestamp_us, peak_rssi_dbm,
		       laprf_peak_height, beamwidth_ms, estimated_speed_mph
		FROM crossings ORDER BY event_id ASC`)
	if err != nil {
		return out, err
	}
	defer cRows.Close()
	for cRows.Next() {
		var ev domain.GateCrossingEvent
		var evID, tsUs int64
		var gateID, isSFInt, startedInt, passNum, freqInt int
		var peakDbm, peakH, bwMs float64
		if err := cRows.Scan(
			&evID, &gateID, &ev.GateName, &isSFInt, &startedInt, &passNum,
			&ev.SlotIndex, &ev.Callsign, &freqInt, &tsUs, &peakDbm,
			&peakH, &bwMs, &ev.EstimatedSpeedMph,
		); err != nil {
			return out, err
		}
		ev.EventID = uint64(evID)
		ev.GateID = uint8(gateID)
		ev.IsStartFinish = isSFInt != 0
		ev.StartedLap = startedInt != 0
		ev.PassingNumber = uint32(passNum)
		ev.FrequencyMHz = uint16(freqInt)
		ev.TimestampUs = uint64(tsUs)
		ev.PeakRSSIDbm = float32(peakDbm)
		ev.LapRFPeakHeight = float32(peakH)
		ev.BeamwidthMs = bwMs
		out.Crossings = append(out.Crossings, ev)
	}

	// Filtered detections
	fRows, err := s.db.Query(`
		SELECT timestamp_us, gate_id, slot_index, callsign, reason, detail, peak_rssi_dbm
		FROM filtered_detections ORDER BY seq ASC`)
	if err != nil {
		return out, err
	}
	defer fRows.Close()
	for fRows.Next() {
		var f domain.FilteredDetection
		var tsUs int64
		var gateID int
		var reasonStr string
		var peakDbm float64
		if err := fRows.Scan(&tsUs, &gateID, &f.SlotIndex, &f.Callsign, &reasonStr, &f.Detail, &peakDbm); err != nil {
			return out, err
		}
		f.TimestampUs = uint64(tsUs)
		f.GateID = uint8(gateID)
		f.Reason = domain.FilterReason(reasonStr)
		f.PeakRSSIDbm = float32(peakDbm)
		out.Filtered = append(out.Filtered, f)
	}

	return out, nil
}

// Save atomically writes the RealBackendState into the SQLite database inside a transaction.
func (s *SQLiteStore) Save(state RealBackendState) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	nowStr := time.Now().UTC().Format(time.RFC3339Nano)

	ltBytes, _ := json.Marshal(state.LiveTimeEnabled)
	if _, err := tx.Exec(`
		INSERT INTO app_settings (key, value_json, updated_at) VALUES ('livetime_enabled', ?, ?)
		ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
		string(ltBytes), nowStr,
	); err != nil {
		return err
	}

	eng := state.Engine
	rulesBytes, _ := json.Marshal(eng.Rules)
	armedInt := 0
	if eng.RaceArmed {
		armedInt = 1
	}
	if _, err := tx.Exec(`
		INSERT INTO engine_meta (id, elapsed_us, race_armed, rules_json, updated_at)
		VALUES (1, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			elapsed_us = excluded.elapsed_us,
			race_armed = excluded.race_armed,
			rules_json = excluded.rules_json,
			updated_at = excluded.updated_at`,
		int64(eng.ElapsedUs), armedInt, string(rulesBytes), nowStr,
	); err != nil {
		return err
	}

	if _, err := tx.Exec(`DELETE FROM pilots`); err != nil {
		return err
	}
	for _, p := range eng.Pilots {
		enInt := 0
		if p.Enabled {
			enInt = 1
		}
		if _, err := tx.Exec(`
			INSERT INTO pilots (
				slot_index, callsign, enabled, band, channel, frequency_mhz,
				enter_threshold, exit_threshold, attenuation_gain, color
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			p.SlotIndex, p.Callsign, enInt, int(p.Band), int(p.Channel), int(p.FrequencyMHz),
			float64(p.EnterThreshold), float64(p.ExitThreshold), int(p.AttenuationGain), p.Color,
		); err != nil {
			return err
		}
	}

	if _, err := tx.Exec(`DELETE FROM gates`); err != nil {
		return err
	}
	for _, g := range eng.Gates {
		thrBytes, _ := json.Marshal(g.EnterThresholds)
		ovrBytes, _ := json.Marshal(g.RuleOverrides)
		if _, err := tx.Exec(`
			INSERT INTO gates (
				gate_id, assigned_timer_id, timer_label, name, color, role, track_order,
				map_x, map_y, battery_mv, battery_pct, noise_floor_dbm, firmware_version,
				frames_rx_count, enter_thresholds_json, rule_overrides_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			int(g.GateID), int(g.AssignedTimerID), g.TimerLabel, g.Name, g.Color, string(g.Role), g.TrackOrder,
			g.MapX, g.MapY, int(g.BatteryMv), int(g.BatteryPct), float64(g.NoiseFloorDbm), g.FirmwareVersion,
			int64(g.FramesRxCount), string(thrBytes), string(ovrBytes),
		); err != nil {
			return err
		}
	}

	if _, err := tx.Exec(`DELETE FROM timers`); err != nil {
		return err
	}
	for _, d := range eng.Timers {
		isHubInt := 0
		if d.IsHub {
			isHubInt = 1
		}
		if _, err := tx.Exec(`
			INSERT INTO timers (
				timer_id, timer_label, color, is_hub, firmware_version, firmware_profile,
				fingerprint, battery_mv, battery_pct, noise_floor_dbm
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			int(d.TimerID), d.TimerLabel, d.Color, isHubInt, d.FirmwareVersion, d.FirmwareProfile,
			d.Fingerprint, int(d.BatteryMv), int(d.BatteryPct), float64(d.NoiseFloorDbm),
		); err != nil {
			return err
		}
	}

	if _, err := tx.Exec(`DELETE FROM laps`); err != nil {
		return err
	}
	for _, l := range eng.Laps {
		isBestInt := 0
		if l.IsBestLap {
			isBestInt = 1
		}
		secBytes, _ := json.Marshal(l.Sectors)
		if _, err := tx.Exec(`
			INSERT INTO laps (
				lap_id, slot_index, callsign, lap_number, lap_time_sec, delta_to_best,
				completed_at_us, is_best_lap, sectors_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			int64(l.LapID), l.SlotIndex, l.Callsign, l.LapNumber, l.LapTimeSec, l.DeltaToBest,
			int64(l.CompletedAtUs), isBestInt, string(secBytes),
		); err != nil {
			return err
		}
	}

	if _, err := tx.Exec(`DELETE FROM crossings`); err != nil {
		return err
	}
	for _, ev := range eng.Crossings {
		isSFInt := 0
		if ev.IsStartFinish {
			isSFInt = 1
		}
		startedInt := 0
		if ev.StartedLap {
			startedInt = 1
		}
		if _, err := tx.Exec(`
			INSERT INTO crossings (
				event_id, gate_id, gate_name, is_start_finish, started_lap, passing_number,
				slot_index, callsign, frequency_mhz, timestamp_us, peak_rssi_dbm,
				laprf_peak_height, beamwidth_ms, estimated_speed_mph
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			int64(ev.EventID), int(ev.GateID), ev.GateName, isSFInt, startedInt, int(ev.PassingNumber),
			ev.SlotIndex, ev.Callsign, int(ev.FrequencyMHz), int64(ev.TimestampUs), float64(ev.PeakRSSIDbm),
			float64(ev.LapRFPeakHeight), float64(ev.BeamwidthMs), ev.EstimatedSpeedMph,
		); err != nil {
			return err
		}
	}

	if _, err := tx.Exec(`DELETE FROM filtered_detections`); err != nil {
		return err
	}
	for idx, f := range eng.Filtered {
		if _, err := tx.Exec(`
			INSERT INTO filtered_detections (
				seq, timestamp_us, gate_id, slot_index, callsign, reason, detail, peak_rssi_dbm
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			idx+1, int64(f.TimestampUs), int(f.GateID), f.SlotIndex, f.Callsign, string(f.Reason), f.Detail, float64(f.PeakRSSIDbm),
		); err != nil {
			return err
		}
	}

	return tx.Commit()
}
