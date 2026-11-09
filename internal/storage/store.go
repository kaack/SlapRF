package storage

import (
	"slaprf/internal/tracker"
)

// RealBackendState is the persisted state of the native Go backend (`realEngine` + settings).
// Simulation state is never stored in the Go backend; simulation persistence lives in browser WebStorage.
type RealBackendState struct {
	Engine          tracker.PersistedEngineState `json:"engine"`
	LiveTimeEnabled bool                         `json:"liveTimeEnabled"`
}

// Store persists and rehydrates the real-world timing engine state on the Go backend.
type Store interface {
	Load() (*RealBackendState, bool, error)
	Save(state RealBackendState) error
	Close() error
}
