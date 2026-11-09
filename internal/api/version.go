package api

import (
	_ "embed"
	"encoding/json"
	"net/http"
	"runtime/debug"
	"strings"
	"sync"
)

//go:embed generated/version.json
var embeddedVersionJSON []byte

// VersionInfo describes the backend release tag, git commit hash, and branch name.
type VersionInfo struct {
	ReleaseTag string `json:"release_tag"`
	CommitHash string `json:"commit_hash"`
	BranchName string `json:"branch_name"`
}

var (
	versionOnce sync.Once
	cachedVer   VersionInfo
)

// GetVersionInfo returns the embedded or VCS-stamped backend version metadata.
func GetVersionInfo() VersionInfo {
	versionOnce.Do(func() {
		cachedVer = VersionInfo{
			ReleaseTag: "(devel)",
			CommitHash: "unknown",
			BranchName: "main",
		}
		_ = json.Unmarshal(embeddedVersionJSON, &cachedVer)

		if info, ok := debug.ReadBuildInfo(); ok {
			if info.Main.Version != "" && info.Main.Version != "(devel)" && !strings.HasPrefix(info.Main.Version, "v0.0.0-") {
				cachedVer.ReleaseTag = info.Main.Version
			}
			for _, s := range info.Settings {
				if s.Key == "vcs.revision" && len(s.Value) >= 7 {
					cachedVer.CommitHash = s.Value
				}
			}
		}
	})
	return cachedVer
}

func (s *Server) handleGetVersion(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	writeJSON(w, http.StatusOK, GetVersionInfo())
}
