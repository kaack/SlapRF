package storage

import (
	"log"
	"sync"
	"time"

	"slaprf/internal/domain"
	"slaprf/internal/ingest"
	"slaprf/internal/tracker"
)

const (
	eventFlushInterval  = 500 * time.Millisecond
	configFlushInterval = 850 * time.Millisecond
	reconcileInterval   = 20 * time.Second
)

type datasetSubscriber struct {
	worker *PersistenceWorker
	isSim  bool
}

func (d *datasetSubscriber) OnTelemetryFrame(domain.TimerTelemetryFrame) {}

func (d *datasetSubscriber) OnGateCrossing(ev domain.GateCrossingEvent) {
	d.worker.enqueueCrossing(d.isSim, ev)
}

func (d *datasetSubscriber) OnDetectionFiltered(f domain.FilteredDetection) {
	d.worker.enqueueFiltered(d.isSim, f)
}

func (d *datasetSubscriber) OnLapCompleted(lap domain.LapRecord, _ []domain.PilotTrackSummary) {
	d.worker.enqueueLap(d.isSim, lap)
}

func (d *datasetSubscriber) OnConfigUpdated([]domain.PilotSlot, []domain.TrackGate) {
	d.worker.MarkDirty()
}

func (d *datasetSubscriber) OnRaceUpdated(domain.RaceTournamentState, domain.EventManagerState, *domain.RaceAnnouncement) {
	d.worker.MarkDirty()
}

func (d *datasetSubscriber) OnPracticeUpdated(domain.PracticeManagerState) {
	d.worker.MarkDirty()
}

func (d *datasetSubscriber) OnMLUpdated(domain.MLStatus) {
	d.worker.MarkDirty()
}

// PersistenceWorker mirrors live `realEngine`, `simEngine`, and `TrackSimulator` state into
// `BoltStore` in the background without blocking engine ingestion, and flushes synchronously on shutdown.
type PersistenceWorker struct {
	store      *BoltStore
	simEngine  *tracker.Engine
	realEngine *tracker.Engine
	simulator  *ingest.TrackSimulator
	log        *log.Logger

	mu             sync.Mutex
	realBatch      EventBatch
	simBatch       EventBatch
	realCfgDirty   bool
	simCfgDirty    bool
	needsReconcile bool

	stopCh chan struct{}
	doneCh chan struct{}
	once   sync.Once
}

// NewPersistenceWorker constructs and attaches a write-behind persistence coordinator.
// Call `Hydrate()` BEFORE `Start()` so initial defaults never overwrite saved user data.
func NewPersistenceWorker(
	store *BoltStore,
	simEngine *tracker.Engine,
	realEngine *tracker.Engine,
	simulator *ingest.TrackSimulator,
	logger *log.Logger,
) *PersistenceWorker {
	return &PersistenceWorker{
		store:      store,
		simEngine:  simEngine,
		realEngine: realEngine,
		simulator:  simulator,
		log:        logger,
		stopCh:     make(chan struct{}),
		doneCh:     make(chan struct{}),
	}
}

// Hydrate loads saved `real` and `sim` engine states from `BoltStore` into memory and returns
// the persisted `simRunning` mode (defaulting to `true` on a brand-new database).
func (w *PersistenceWorker) Hydrate() (simRunning bool) {
	simRunning = true
	var savedSimRun bool
	if ok, err := w.store.GetJSON(KeySimRunning, &savedSimRun); err == nil && ok {
		simRunning = savedSimRun
	}

	if realState, _, hasReal, err := w.store.LoadEngineState(false); err == nil && hasReal && w.realEngine != nil {
		w.realEngine.RestoreState(realState, false)
	}
	if simState, simOpts, hasSim, err := w.store.LoadEngineState(true); err == nil && hasSim && w.simEngine != nil {
		if simOpts.Model == 0 || ingest.SimStateCompatible(simOpts) {
			w.simEngine.RestoreState(simState, true)
			if w.simulator != nil && simOpts.Model != 0 {
				simOpts.Running = simRunning
				w.simulator.RestoreOptions(simOpts)
			}
		}
	}
	if w.simEngine != nil && w.realEngine != nil {
		tracker.SyncBootTimes(w.simEngine, w.realEngine)
	}
	return simRunning
}

// Start subscribes to both engines and starts the background batching goroutine.
func (w *PersistenceWorker) Start() {
	if w.realEngine != nil {
		w.realEngine.Subscribe(&datasetSubscriber{worker: w, isSim: false})
	}
	if w.simEngine != nil {
		w.simEngine.Subscribe(&datasetSubscriber{worker: w, isSim: true})
	}
	go w.loop()
}

// Stop flushes all pending events and full config/event snapshots synchronously before returning.
func (w *PersistenceWorker) Stop() {
	w.once.Do(func() {
		close(w.stopCh)
		<-w.doneCh
	})
}

func (w *PersistenceWorker) enqueueLap(isSim bool, lap domain.LapRecord) {
	w.mu.Lock()
	if isSim {
		w.simBatch.Laps = append(w.simBatch.Laps, lap)
		w.simCfgDirty = true
	} else {
		w.realBatch.Laps = append(w.realBatch.Laps, lap)
		w.realCfgDirty = true
	}
	w.needsReconcile = true
	w.mu.Unlock()
}

func (w *PersistenceWorker) enqueueCrossing(isSim bool, ev domain.GateCrossingEvent) {
	w.mu.Lock()
	if isSim {
		w.simBatch.Crossings = append(w.simBatch.Crossings, ev)
	} else {
		w.realBatch.Crossings = append(w.realBatch.Crossings, ev)
	}
	w.needsReconcile = true
	w.mu.Unlock()
}

func (w *PersistenceWorker) enqueueFiltered(isSim bool, f domain.FilteredDetection) {
	w.mu.Lock()
	if isSim {
		w.simBatch.Filtered = append(w.simBatch.Filtered, f)
	} else {
		w.realBatch.Filtered = append(w.realBatch.Filtered, f)
	}
	w.needsReconcile = true
	w.mu.Unlock()
}

// MarkDirty marks both engines' configurations dirty for the next debounced snapshot.
func (w *PersistenceWorker) MarkDirty() {
	w.mu.Lock()
	w.realCfgDirty = true
	w.simCfgDirty = true
	w.needsReconcile = true
	w.mu.Unlock()
}

// SaveMode persists `app.sim_running` immediately and marks configs dirty.
func (w *PersistenceWorker) SaveMode(simRunning bool) {
	_ = w.store.PutJSON(KeySimRunning, simRunning)
	w.MarkDirty()
}

// ReconcileAllNow atomically replaces all stored `real` and `sim` buckets from the live engines.
func (w *PersistenceWorker) ReconcileAllNow() {
	w.mu.Lock()
	w.realBatch = EventBatch{}
	w.simBatch = EventBatch{}
	w.realCfgDirty = false
	w.simCfgDirty = false
	w.needsReconcile = false
	w.mu.Unlock()

	if w.simulator != nil {
		_ = w.store.PutJSON(KeySimRunning, w.simulator.IsRunning())
	}
	if w.realEngine != nil {
		if err := w.store.ReplaceFullEngineState(false, w.realEngine.ExportState(), nil); err != nil && w.log != nil {
			w.log.Printf("[storage] reconcile real engine failed: %v", err)
		}
	}
	if w.simEngine != nil {
		var opts *ingest.SimPersistedOptions
		if w.simulator != nil {
			exp := w.simulator.ExportOptions()
			opts = &exp
		}
		if err := w.store.ReplaceFullEngineState(true, w.simEngine.ExportState(), opts); err != nil && w.log != nil {
			w.log.Printf("[storage] reconcile sim engine failed: %v", err)
		}
	}
}

// WipeAndReconcile clears `BoltStore` and writes fresh factory-default engine states.
func (w *PersistenceWorker) WipeAndReconcile() {
	keepSim := true
	if w.simulator != nil {
		keepSim = w.simulator.IsRunning()
	}
	_ = w.store.Wipe(keepSim)
	w.ReconcileAllNow()
}

func (w *PersistenceWorker) flushEvents() {
	w.mu.Lock()
	rb := w.realBatch
	sb := w.simBatch
	w.realBatch = EventBatch{}
	w.simBatch = EventBatch{}
	w.mu.Unlock()

	if err := w.store.AppendEvents(false, rb); err != nil && w.log != nil {
		w.log.Printf("[storage] append real events failed: %v", err)
	}
	if err := w.store.AppendEvents(true, sb); err != nil && w.log != nil {
		w.log.Printf("[storage] append sim events failed: %v", err)
	}
}

func (w *PersistenceWorker) flushConfigs() {
	w.mu.Lock()
	doReal := w.realCfgDirty
	doSim := w.simCfgDirty
	w.realCfgDirty = false
	w.simCfgDirty = false
	w.mu.Unlock()

	if doReal && w.realEngine != nil {
		if err := w.store.SaveConfigSnapshot(false, w.realEngine.ExportState(), nil); err != nil && w.log != nil {
			w.log.Printf("[storage] save real config failed: %v", err)
		}
	}
	if doSim && w.simEngine != nil {
		var opts *ingest.SimPersistedOptions
		if w.simulator != nil {
			exp := w.simulator.ExportOptions()
			opts = &exp
		}
		if err := w.store.SaveConfigSnapshot(true, w.simEngine.ExportState(), opts); err != nil && w.log != nil {
			w.log.Printf("[storage] save sim config failed: %v", err)
		}
	}
}

func (w *PersistenceWorker) loop() {
	defer close(w.doneCh)

	evTicker := time.NewTicker(eventFlushInterval)
	cfgTicker := time.NewTicker(configFlushInterval)
	recTicker := time.NewTicker(reconcileInterval)
	defer evTicker.Stop()
	defer cfgTicker.Stop()
	defer recTicker.Stop()

	for {
		select {
		case <-w.stopCh:
			w.ReconcileAllNow()
			return
		case <-evTicker.C:
			w.flushEvents()
		case <-cfgTicker.C:
			w.flushConfigs()
		case <-recTicker.C:
			w.mu.Lock()
			doRec := w.needsReconcile
			w.mu.Unlock()
			if doRec {
				w.ReconcileAllNow()
			}
		}
	}
}
