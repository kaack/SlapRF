package storage

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	bolt "go.etcd.io/bbolt"

	"slaprf/internal/domain"
	"slaprf/internal/ingest"
	"slaprf/internal/tracker"
)

const (
	DefaultDBFileName = "slaprf.db"
	SchemaVersion     = 1

	maxPersistedCrossings = 1000
	maxPersistedFiltered  = 1000
	maxPersistedLaps      = 10000
)

var (
	bucketKV            = []byte("kv")
	bucketLapsReal      = []byte("laps_real")
	bucketCrossingsReal = []byte("crossings_real")
	bucketFilteredReal  = []byte("filtered_real")
	bucketLapsSim       = []byte("laps_sim")
	bucketCrossingsSim  = []byte("crossings_sim")
	bucketFilteredSim   = []byte("filtered_sim")

	allBuckets = [][]byte{
		bucketKV,
		bucketLapsReal,
		bucketCrossingsReal,
		bucketFilteredReal,
		bucketLapsSim,
		bucketCrossingsSim,
		bucketFilteredSim,
	}
)

const (
	KeyMeta          = "app.meta"
	KeySimRunning    = "app.sim_running"
	KeyRealConfig    = "real.config"
	KeySimConfig     = "sim.config"
	KeySimOptions    = "sim.options"
	KeyUSBTargets       = "hw.usb_targets"
	KeyBLEHostKey       = "hw.ble_host_key"
	KeyLogLevel         = "app.log_level"
	KeyKnownTimers      = "hw.known_timers"
	KeyLapRFTargets     = "hw.laprf_targets"
	KeyRHTargets        = "hw.rh_targets"
	KeyLapRFEmulatorCfg = "hw.laprf_emulator_config"
	KeyMultiGPConfig    = "hw.multigp_config"
)

// MetaRecord tracks metadata inside the `kv` bucket.
type MetaRecord struct {
	Schema         int   `json:"schema"`
	CreatedAtMs    int64 `json:"createdAtMs"`
	SavedAtMs      int64 `json:"savedAtMs"`
	LastBackupAtMs int64 `json:"lastBackupAtMs,omitempty"`
}

// Status describes the live `bbolt` database state returned by `GET /v1/storage/status`.
type Status struct {
	Backend        string `json:"backend"`
	DBPath         string `json:"dbPath"`
	SizeBytes      int64  `json:"sizeBytes"`
	SavedAtMs      int64  `json:"savedAtMs"`
	LastBackupAtMs int64  `json:"lastBackupAtMs,omitempty"`
	RealLapsCount  int    `json:"realLapsCount"`
	SimLapsCount   int    `json:"simLapsCount"`
}

// EventBatch holds incremental events queued since the previous flush for one dataset ("real" or "sim").
type EventBatch struct {
	Laps      []domain.LapRecord
	Crossings []domain.GateCrossingEvent
	Filtered  []domain.FilteredDetection
}

// BoltStore is a pure-Go single-file embedded Key-Value / Object-Store database (`go.etcd.io/bbolt`)
// modeled directly on IndexedDB's named object stores and ordered numeric cursors.
type BoltStore struct {
	db      *bolt.DB
	path    string
	filtSeq atomic.Uint64
	mu      sync.RWMutex
	closed  bool
}

// ResolveDefaultDBPath picks a portable single-file path for `slaprf.db`:
//  1. Next to the compiled `slaprf` executable if writable (and not a temporary `go-build` dir).
//  2. Current working directory when running via `go run`.
//  3. Fallback to `<UserConfigDir>/SlapRF/slaprf.db` if the executable directory is read-only.
func ResolveDefaultDBPath() string {
	if exe, err := os.Executable(); err == nil && exe != "" {
		exeDir := filepath.Dir(exe)
		lower := strings.ToLower(exeDir)
		if !strings.Contains(lower, "go-build") && !strings.Contains(lower, filepath.ToSlash(os.TempDir())) {
			candidate := filepath.Join(exeDir, DefaultDBFileName)
			if isDirWritable(exeDir) {
				return candidate
			}
		} else {
			if wd, wdErr := os.Getwd(); wdErr == nil && isDirWritable(wd) {
				return filepath.Join(wd, DefaultDBFileName)
			}
		}
	}
	if cfgDir, err := os.UserConfigDir(); err == nil && cfgDir != "" {
		appDir := filepath.Join(cfgDir, "SlapRF")
		if err := os.MkdirAll(appDir, 0o755); err == nil {
			return filepath.Join(appDir, DefaultDBFileName)
		}
	}
	return DefaultDBFileName
}

func isInvalidBoltFileError(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "invalid database") ||
		strings.Contains(msg, "file size too small") ||
		strings.Contains(msg, "checksum error") ||
		strings.Contains(msg, "version mismatch")
}

func isDirWritable(dir string) bool {
	probe, err := os.CreateTemp(dir, ".slaprf-write-check-*")
	if err != nil {
		return false
	}
	name := probe.Name()
	_ = probe.Close()
	_ = os.Remove(name)
	return true
}

// OpenBoltStore opens (or creates) a `bbolt` single-file database at `dbPath`.
func OpenBoltStore(dbPath string) (*BoltStore, error) {
	if strings.TrimSpace(dbPath) == "" {
		dbPath = ResolveDefaultDBPath()
	}
	absPath, err := filepath.Abs(dbPath)
	if err == nil {
		dbPath = absPath
	}
	if dir := filepath.Dir(dbPath); dir != "" && dir != "." {
		if mkErr := os.MkdirAll(dir, 0o755); mkErr != nil {
			return nil, fmt.Errorf("create db dir %s: %w", dir, mkErr)
		}
	}

	boltOpts := &bolt.Options{
		Timeout:      3 * time.Second,
		NoGrowSync:   false,
		FreelistType: bolt.FreelistMapType,
	}
	db, err := bolt.Open(dbPath, 0o600, boltOpts)
	if err != nil && isInvalidBoltFileError(err) {
		bakPath := dbPath + ".bak"
		_ = os.Remove(bakPath)
		if renErr := os.Rename(dbPath, bakPath); renErr == nil {
			db, err = bolt.Open(dbPath, 0o600, boltOpts)
		}
	}
	if err != nil {
		return nil, fmt.Errorf("open bbolt db %s: %w", dbPath, err)
	}

	nowMs := time.Now().UnixMilli()
	err = db.Update(func(tx *bolt.Tx) error {
		for _, bName := range allBuckets {
			if _, bErr := tx.CreateBucketIfNotExists(bName); bErr != nil {
				return bErr
			}
		}
		kv := tx.Bucket(bucketKV)
		if kv.Get([]byte(KeyMeta)) == nil {
			meta := MetaRecord{
				Schema:      SchemaVersion,
				CreatedAtMs: nowMs,
				SavedAtMs:   nowMs,
			}
			raw, _ := json.Marshal(meta)
			if pErr := kv.Put([]byte(KeyMeta), raw); pErr != nil {
				return pErr
			}
		}
		return nil
	})
	if err != nil {
		_ = db.Close()
		return nil, err
	}

	s := &BoltStore{
		db:   db,
		path: dbPath,
	}
	s.filtSeq.Store(uint64(time.Now().UnixNano()))
	return s, nil
}

// Path returns the filesystem path of the underlying `slaprf.db` file.
func (s *BoltStore) Path() string {
	return s.path
}

// Close flushes and closes the underlying `bbolt` file.
func (s *BoltStore) Close() error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	s.mu.Unlock()
	return s.db.Close()
}

func u64Key(v uint64) []byte {
	var b [8]byte
	binary.BigEndian.PutUint64(b[:], v)
	return b[:]
}

func filteredKey(tsUs uint64, seq uint64) []byte {
	var b [16]byte
	binary.BigEndian.PutUint64(b[0:8], tsUs)
	binary.BigEndian.PutUint64(b[8:16], seq)
	return b[:]
}

func touchMetaTx(tx *bolt.Tx, savedAtMs int64) error {
	kv := tx.Bucket(bucketKV)
	if kv == nil {
		return nil
	}
	var meta MetaRecord
	if raw := kv.Get([]byte(KeyMeta)); len(raw) > 0 {
		_ = json.Unmarshal(raw, &meta)
	}
	if meta.Schema == 0 {
		meta.Schema = SchemaVersion
	}
	if meta.CreatedAtMs == 0 {
		meta.CreatedAtMs = savedAtMs
	}
	meta.SavedAtMs = savedAtMs
	enc, err := json.Marshal(meta)
	if err != nil {
		return err
	}
	return kv.Put([]byte(KeyMeta), enc)
}

// RecordBackupTimestamp updates `LastBackupAtMs` in `app.meta`.
func (s *BoltStore) RecordBackupTimestamp(tsMs int64) error {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.closed {
		return errors.New("store closed")
	}
	return s.db.Update(func(tx *bolt.Tx) error {
		kv := tx.Bucket(bucketKV)
		var meta MetaRecord
		if raw := kv.Get([]byte(KeyMeta)); len(raw) > 0 {
			_ = json.Unmarshal(raw, &meta)
		}
		if meta.Schema == 0 {
			meta.Schema = SchemaVersion
		}
		if meta.CreatedAtMs == 0 {
			meta.CreatedAtMs = tsMs
		}
		meta.LastBackupAtMs = tsMs
		enc, err := json.Marshal(meta)
		if err != nil {
			return err
		}
		return kv.Put([]byte(KeyMeta), enc)
	})
}

// PutJSON stores any JSON-serializable document under `key` in the `kv` bucket.
func (s *BoltStore) PutJSON(key string, val any) error {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.closed {
		return errors.New("store closed")
	}
	raw, err := json.Marshal(val)
	if err != nil {
		return err
	}
	nowMs := time.Now().UnixMilli()
	return s.db.Update(func(tx *bolt.Tx) error {
		kv := tx.Bucket(bucketKV)
		if err := kv.Put([]byte(key), raw); err != nil {
			return err
		}
		return touchMetaTx(tx, nowMs)
	})
}

// GetJSON reads and unmarshals `key` from the `kv` bucket. Returns `(false, nil)` when absent.
func (s *BoltStore) GetJSON(key string, dst any) (bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.closed {
		return false, errors.New("store closed")
	}
	var found bool
	err := s.db.View(func(tx *bolt.Tx) error {
		kv := tx.Bucket(bucketKV)
		if kv == nil {
			return nil
		}
		raw := kv.Get([]byte(key))
		if len(raw) == 0 {
			return nil
		}
		found = true
		return json.Unmarshal(raw, dst)
	})
	return found, err
}

func bucketsForDataset(isSim bool) (cfgKey string, lapsB, crossB, filtB []byte) {
	if isSim {
		return KeySimConfig, bucketLapsSim, bucketCrossingsSim, bucketFilteredSim
	}
	return KeyRealConfig, bucketLapsReal, bucketCrossingsReal, bucketFilteredReal
}

func trimBucketOldest(b *bolt.Bucket, maxItems int) error {
	if b == nil || maxItems <= 0 {
		return nil
	}
	n := b.Stats().KeyN
	if n <= maxItems {
		return nil
	}
	toDelete := n - maxItems
	c := b.Cursor()
	for k, _ := c.First(); k != nil && toDelete > 0; k, _ = c.Next() {
		if err := c.Delete(); err != nil {
			return err
		}
		toDelete--
	}
	return nil
}

// AppendEvents writes incremental laps, crossings, and filtered detections for `real` or `sim`
// in a single atomic transaction.
func (s *BoltStore) AppendEvents(isSim bool, batch EventBatch) error {
	if len(batch.Laps) == 0 && len(batch.Crossings) == 0 && len(batch.Filtered) == 0 {
		return nil
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.closed {
		return errors.New("store closed")
	}
	_, lapsName, crossName, filtName := bucketsForDataset(isSim)
	nowMs := time.Now().UnixMilli()
	return s.db.Update(func(tx *bolt.Tx) error {
		if len(batch.Laps) > 0 {
			lb := tx.Bucket(lapsName)
			for i := range batch.Laps {
				rec := &batch.Laps[i]
				if rec.LapID == 0 {
					continue
				}
				raw, err := json.Marshal(rec)
				if err != nil {
					return err
				}
				if err := lb.Put(u64Key(rec.LapID), raw); err != nil {
					return err
				}
			}
			if err := trimBucketOldest(lb, maxPersistedLaps); err != nil {
				return err
			}
		}
		if len(batch.Crossings) > 0 {
			cb := tx.Bucket(crossName)
			for i := range batch.Crossings {
				rec := &batch.Crossings[i]
				if rec.EventID == 0 {
					continue
				}
				raw, err := json.Marshal(rec)
				if err != nil {
					return err
				}
				if err := cb.Put(u64Key(rec.EventID), raw); err != nil {
					return err
				}
			}
			if err := trimBucketOldest(cb, maxPersistedCrossings); err != nil {
				return err
			}
		}
		if len(batch.Filtered) > 0 {
			fb := tx.Bucket(filtName)
			for i := range batch.Filtered {
				rec := &batch.Filtered[i]
				raw, err := json.Marshal(rec)
				if err != nil {
					return err
				}
				seq := s.filtSeq.Add(1)
				if err := fb.Put(filteredKey(rec.TimestampUs, seq), raw); err != nil {
					return err
				}
			}
			if err := trimBucketOldest(fb, maxPersistedFiltered); err != nil {
				return err
			}
		}
		return touchMetaTx(tx, nowMs)
	})
}

// SaveConfigSnapshot writes the non-event engine configuration (`pilots`, `gates`, `timers`,
// `rules`, `raceState`, `eventState`, `practiceState`, etc.) without rewriting event buckets.
func (s *BoltStore) SaveConfigSnapshot(isSim bool, state tracker.PersistedEngineState, simOpts *ingest.SimPersistedOptions) error {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.closed {
		return errors.New("store closed")
	}
	cfgKey, _, _, _ := bucketsForDataset(isSim)
	cfgOnly := state
	cfgOnly.Laps = nil
	cfgOnly.Crossings = nil
	cfgOnly.Filtered = nil
	cfgBytes, err := json.Marshal(cfgOnly)
	if err != nil {
		return err
	}
	var optsBytes []byte
	if isSim && simOpts != nil {
		optsBytes, err = json.Marshal(simOpts)
		if err != nil {
			return err
		}
	}
	nowMs := time.Now().UnixMilli()
	return s.db.Update(func(tx *bolt.Tx) error {
		kv := tx.Bucket(bucketKV)
		if err := kv.Put([]byte(cfgKey), cfgBytes); err != nil {
			return err
		}
		if len(optsBytes) > 0 {
			if err := kv.Put([]byte(KeySimOptions), optsBytes); err != nil {
				return err
			}
		}
		return touchMetaTx(tx, nowMs)
	})
}

// ReplaceFullEngineState atomically replaces both the config document and all event buckets
// (`laps_*`, `crossings_*`, `filtered_*`) for `real` or `sim` inside a single `bbolt` transaction.
func (s *BoltStore) ReplaceFullEngineState(isSim bool, state tracker.PersistedEngineState, simOpts *ingest.SimPersistedOptions) error {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.closed {
		return errors.New("store closed")
	}
	cfgKey, lapsName, crossName, filtName := bucketsForDataset(isSim)
	cfgOnly := state
	cfgOnly.Laps = nil
	cfgOnly.Crossings = nil
	cfgOnly.Filtered = nil
	cfgBytes, err := json.Marshal(cfgOnly)
	if err != nil {
		return err
	}
	var optsBytes []byte
	if isSim && simOpts != nil {
		optsBytes, err = json.Marshal(simOpts)
		if err != nil {
			return err
		}
	}
	nowMs := time.Now().UnixMilli()

	return s.db.Update(func(tx *bolt.Tx) error {
		for _, bName := range [][]byte{lapsName, crossName, filtName} {
			if tx.Bucket(bName) != nil {
				if err := tx.DeleteBucket(bName); err != nil && !errors.Is(err, bolt.ErrBucketNotFound) {
					return err
				}
			}
			if _, err := tx.CreateBucket(bName); err != nil {
				return err
			}
		}

		lb := tx.Bucket(lapsName)
		for i := range state.Laps {
			rec := &state.Laps[i]
			if rec.LapID == 0 {
				continue
			}
			raw, err := json.Marshal(rec)
			if err != nil {
				return err
			}
			if err := lb.Put(u64Key(rec.LapID), raw); err != nil {
				return err
			}
		}
		if err := trimBucketOldest(lb, maxPersistedLaps); err != nil {
			return err
		}

		cb := tx.Bucket(crossName)
		for i := range state.Crossings {
			rec := &state.Crossings[i]
			if rec.EventID == 0 {
				continue
			}
			raw, err := json.Marshal(rec)
			if err != nil {
				return err
			}
			if err := cb.Put(u64Key(rec.EventID), raw); err != nil {
				return err
			}
		}
		if err := trimBucketOldest(cb, maxPersistedCrossings); err != nil {
			return err
		}

		fb := tx.Bucket(filtName)
		for i := range state.Filtered {
			rec := &state.Filtered[i]
			raw, err := json.Marshal(rec)
			if err != nil {
				return err
			}
			seq := s.filtSeq.Add(1)
			if err := fb.Put(filteredKey(rec.TimestampUs, seq), raw); err != nil {
				return err
			}
		}
		if err := trimBucketOldest(fb, maxPersistedFiltered); err != nil {
			return err
		}

		kv := tx.Bucket(bucketKV)
		if err := kv.Put([]byte(cfgKey), cfgBytes); err != nil {
			return err
		}
		if len(optsBytes) > 0 {
			if err := kv.Put([]byte(KeySimOptions), optsBytes); err != nil {
				return err
			}
		}
		return touchMetaTx(tx, nowMs)
	})
}

// LoadEngineState reassembles a `tracker.PersistedEngineState` (and `SimPersistedOptions` when `isSim`)
// from the `kv` config document and the ordered `laps_*`, `crossings_*`, and `filtered_*` buckets.
func (s *BoltStore) LoadEngineState(isSim bool) (tracker.PersistedEngineState, ingest.SimPersistedOptions, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var state tracker.PersistedEngineState
	var opts ingest.SimPersistedOptions
	if s.closed {
		return state, opts, false, errors.New("store closed")
	}
	cfgKey, lapsName, crossName, filtName := bucketsForDataset(isSim)
	hasAny := false

	err := s.db.View(func(tx *bolt.Tx) error {
		kv := tx.Bucket(bucketKV)
		if kv != nil {
			if rawCfg := kv.Get([]byte(cfgKey)); len(rawCfg) > 0 {
				if err := json.Unmarshal(rawCfg, &state); err != nil {
					return err
				}
				hasAny = true
			}
			if isSim {
				if rawOpts := kv.Get([]byte(KeySimOptions)); len(rawOpts) > 0 {
					if err := json.Unmarshal(rawOpts, &opts); err != nil {
						return err
					}
				}
			}
		}

		if lb := tx.Bucket(lapsName); lb != nil {
			c := lb.Cursor()
			for k, v := c.First(); k != nil; k, v = c.Next() {
				var rec domain.LapRecord
				if err := json.Unmarshal(v, &rec); err == nil {
					state.Laps = append(state.Laps, rec)
					hasAny = true
				}
			}
		}
		if cb := tx.Bucket(crossName); cb != nil {
			c := cb.Cursor()
			for k, v := c.First(); k != nil; k, v = c.Next() {
				var rec domain.GateCrossingEvent
				if err := json.Unmarshal(v, &rec); err == nil {
					state.Crossings = append(state.Crossings, rec)
					hasAny = true
				}
			}
		}
		if fb := tx.Bucket(filtName); fb != nil {
			c := fb.Cursor()
			for k, v := c.First(); k != nil; k, v = c.Next() {
				var rec domain.FilteredDetection
				if err := json.Unmarshal(v, &rec); err == nil {
					state.Filtered = append(state.Filtered, rec)
					hasAny = true
				}
			}
		}
		return nil
	})
	if err == nil && hasAny {
		syncActivePracticeSessionEvents(&state)
	}
	return state, opts, hasAny, err
}

func syncActivePracticeSessionEvents(state *tracker.PersistedEngineState) {
	if state == nil || state.PracticeState == nil || state.PracticeState.ActiveSessionID == "" {
		return
	}
	if state.RaceState != nil && state.RaceState.Mode == domain.ModeRace {
		return
	}
	for i := range state.PracticeState.Sessions {
		sess := &state.PracticeState.Sessions[i]
		if sess.SessionID != state.PracticeState.ActiveSessionID {
			continue
		}
		if len(state.Laps) > 0 {
			byID := make(map[uint64]domain.LapRecord, len(sess.Laps)+len(state.Laps))
			for _, l := range sess.Laps {
				byID[l.LapID] = l
			}
			for _, l := range state.Laps {
				byID[l.LapID] = l
			}
			merged := make([]domain.LapRecord, 0, len(byID))
			for _, l := range byID {
				merged = append(merged, l)
			}
			sort.Slice(merged, func(i, j int) bool { return merged[i].LapID < merged[j].LapID })
			sess.Laps = merged
		}
		if len(state.Crossings) > 0 {
			byID := make(map[uint64]domain.GateCrossingEvent, len(sess.Crossings)+len(state.Crossings))
			for _, c := range sess.Crossings {
				byID[c.EventID] = c
			}
			for _, c := range state.Crossings {
				byID[c.EventID] = c
			}
			merged := make([]domain.GateCrossingEvent, 0, len(byID))
			for _, c := range byID {
				merged = append(merged, c)
			}
			sort.Slice(merged, func(i, j int) bool { return merged[i].EventID < merged[j].EventID })
			sess.Crossings = merged
		}
		if len(state.Filtered) > len(sess.Filtered) {
			sess.Filtered = append([]domain.FilteredDetection(nil), state.Filtered...)
		}
		break
	}
}

// Wipe clears all engine & hardware state buckets while preserving `app.meta` creation timestamp,
// `sim.running`, and `hw.ble_host_key` (so wiping session/lap data never orphans paired BLE Hubs).
func (s *BoltStore) Wipe(keepSimRunning bool) error {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.closed {
		return errors.New("store closed")
	}
	nowMs := time.Now().UnixMilli()
	return s.db.Update(func(tx *bolt.Tx) error {
		var createdAt int64
		var preservedHostKey []byte
		var preservedLogLevel []byte
		if kv := tx.Bucket(bucketKV); kv != nil {
			var meta MetaRecord
			if raw := kv.Get([]byte(KeyMeta)); len(raw) > 0 {
				_ = json.Unmarshal(raw, &meta)
				createdAt = meta.CreatedAtMs
			}
			if rawKey := kv.Get([]byte(KeyBLEHostKey)); len(rawKey) > 0 {
				preservedHostKey = append([]byte(nil), rawKey...)
			}
			if rawLvl := kv.Get([]byte(KeyLogLevel)); len(rawLvl) > 0 {
				preservedLogLevel = append([]byte(nil), rawLvl...)
			}
		}
		for _, bName := range allBuckets {
			if tx.Bucket(bName) != nil {
				if err := tx.DeleteBucket(bName); err != nil && !errors.Is(err, bolt.ErrBucketNotFound) {
					return err
				}
			}
			if _, err := tx.CreateBucket(bName); err != nil {
				return err
			}
		}
		kv := tx.Bucket(bucketKV)
		meta := MetaRecord{
			Schema:      SchemaVersion,
			CreatedAtMs: createdAt,
			SavedAtMs:   nowMs,
		}
		if meta.CreatedAtMs == 0 {
			meta.CreatedAtMs = nowMs
		}
		rawMeta, _ := json.Marshal(meta)
		if err := kv.Put([]byte(KeyMeta), rawMeta); err != nil {
			return err
		}
		if len(preservedHostKey) > 0 {
			if err := kv.Put([]byte(KeyBLEHostKey), preservedHostKey); err != nil {
				return err
			}
		}
		if len(preservedLogLevel) > 0 {
			if err := kv.Put([]byte(KeyLogLevel), preservedLogLevel); err != nil {
				return err
			}
		}
		rawRun, _ := json.Marshal(keepSimRunning)
		return kv.Put([]byte(KeySimRunning), rawRun)
	})
}

// Status returns on-disk size, record counts, and timestamps for `#/setup` Storage & Backup UI.
func (s *BoltStore) Status() Status {
	s.mu.RLock()
	defer s.mu.RUnlock()
	st := Status{
		Backend: "bbolt",
		DBPath:  s.path,
	}
	if info, err := os.Stat(s.path); err == nil {
		st.SizeBytes = info.Size()
	}
	if s.closed {
		return st
	}
	_ = s.db.View(func(tx *bolt.Tx) error {
		if kv := tx.Bucket(bucketKV); kv != nil {
			var meta MetaRecord
			if raw := kv.Get([]byte(KeyMeta)); len(raw) > 0 {
				if json.Unmarshal(raw, &meta) == nil {
					st.SavedAtMs = meta.SavedAtMs
					st.LastBackupAtMs = meta.LastBackupAtMs
				}
			}
		}
		if lb := tx.Bucket(bucketLapsReal); lb != nil {
			st.RealLapsCount = lb.Stats().KeyN
		}
		if lb := tx.Bucket(bucketLapsSim); lb != nil {
			st.SimLapsCount = lb.Stats().KeyN
		}
		return nil
	})
	return st
}
