package firmware

import (
	"encoding/json"
	"io/fs"
	"sort"
	"strings"

	firmwaresrc "slaprf/firmware"
)

// Profile is one firmware design. Each lives in its own directory (firmware/<id>/) with its own
// main.c, tuned for a track type and for where the timers sit on the gates. Every profile is
// rebuilt on each release, so the flasher only ever offers the current build of each design.
type Profile struct {
	ID      string `json:"id"`
	Code    uint8  `json:"code"`    // Stamped into the config block; must match SLAPRF_PROFILE_CODE in main.c
	Name    string `json:"name"`    // Dropdown label
	Track   string `json:"track"`   // Track type this design suits
	Mount   string `json:"mount"`   // Where the timer sits on the gate
	Link    string `json:"link"`    // 2.4 GHz link summary (rate · TX power)
	SweepHz uint8  `json:"sweepHz"` // 5.8 GHz sweep rate
	Summary string `json:"summary"` // One-line explanation shown in the flasher
}

// MaxWindowSamples bounds the sliding-window frame size across all profiles.
const MaxWindowSamples = 6

// DefaultProfileID is used when no profile is requested.
const DefaultProfileID = "open-ground"

// Profiles lists every firmware design found under firmware/, ordered by code.
var Profiles = loadProfiles()

func loadProfiles() []Profile {
	paths, err := fs.Glob(firmwaresrc.Manifests, "*/profile.json")
	if err != nil {
		panic(err)
	}
	out := make([]Profile, 0, len(paths))
	for _, path := range paths {
		raw, err := firmwaresrc.Manifests.ReadFile(path)
		if err != nil {
			panic(err)
		}
		var p Profile
		if err := json.Unmarshal(raw, &p); err != nil {
			panic("firmware manifest " + path + ": " + err.Error())
		}
		if dir := strings.Split(path, "/")[0]; p.ID != dir {
			panic("firmware manifest " + path + ": id " + p.ID + " does not match its directory")
		}
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Code < out[j].Code })
	return out
}

// ProfilesJSON returns the profile list as JSON (injected into the web bundle).
func ProfilesJSON() string {
	b, _ := json.Marshal(Profiles)
	return string(b)
}

// ProfileByID returns the profile with the given ID, or the default profile.
func ProfileByID(id string) Profile {
	id = strings.TrimSpace(strings.ToLower(id))
	if id == "" {
		id = DefaultProfileID
	}
	for _, p := range Profiles {
		if p.ID == id {
			return p
		}
	}
	for _, p := range Profiles {
		if p.ID == DefaultProfileID {
			return p
		}
	}
	return Profiles[0]
}

// ProfileByCode returns the profile with the given config-block code, or the default profile.
func ProfileByCode(code uint8) Profile {
	for _, p := range Profiles {
		if p.Code == code {
			return p
		}
	}
	return ProfileByID(DefaultProfileID)
}
