package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestBuildAltStoreSourceJSONValidSchema(t *testing.T) {
	raw, err := buildAltStoreSourceJSON(
		"0.0.20",
		"20",
		"2026-11-26T12:00:00Z",
		"https://github.com/kaack/SlapRF/releases/download/v0.0.20/slaprf-ios-arm64.ipa",
		14000000,
	)
	if err != nil {
		t.Fatalf("buildAltStoreSourceJSON: %v", err)
	}
	var parsed altStoreSource
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatalf("json.Unmarshal: %v", err)
	}
	if parsed.Identifier != "app.slaprf.source" || len(parsed.Apps) != 1 {
		t.Fatalf("unexpected source root: %+v", parsed)
	}
	app := parsed.Apps[0]
	if app.BundleIdentifier != "app.slaprf.timer" || len(app.Versions) != 1 {
		t.Fatalf("unexpected app entry: %+v", app)
	}
	v := app.Versions[0]
	if v.Version != "0.0.20" || v.BuildVersion != "20" || v.MinOSVersion != "16.0" || !strings.HasSuffix(v.DownloadURL, "/slaprf-ios-arm64.ipa") {
		t.Fatalf("unexpected version entry: %+v", v)
	}
}
