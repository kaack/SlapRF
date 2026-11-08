// Package firmwaresrc embeds the per-profile firmware manifests.
//
// Each subdirectory of firmware/ is a complete, self-contained firmware design for one
// situation (track type × where the timer sits on the gate):
//
//	firmware/<profile-id>/main.c        the firmware source for that design
//	firmware/<profile-id>/profile.json  id, code, display name, track, mount, link, summary
//
// The manifests are the single source of truth for the flasher's firmware dropdown, the Go
// image builder (internal/firmware), and the web app (injected into the TypeScript bundle).
package firmwaresrc

import "embed"

// Manifests holds every firmware/<profile-id>/profile.json.
//
//go:embed */profile.json
var Manifests embed.FS
