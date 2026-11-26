package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type altStoreSource struct {
	Name         string            `json:"name"`
	Identifier   string            `json:"identifier"`
	Subtitle     string            `json:"subtitle"`
	Description  string            `json:"description"`
	IconURL      string            `json:"iconURL"`
	Website      string            `json:"website"`
	TintColor    string            `json:"tintColor"`
	FeaturedApps []string          `json:"featuredApps"`
	Apps         []altStoreAppItem `json:"apps"`
	News         []any             `json:"news"`
}

type altStoreAppItem struct {
	Name                 string               `json:"name"`
	BundleIdentifier     string               `json:"bundleIdentifier"`
	DeveloperName        string               `json:"developerName"`
	Subtitle             string               `json:"subtitle"`
	LocalizedDescription string               `json:"localizedDescription"`
	IconURL              string               `json:"iconURL"`
	TintColor            string               `json:"tintColor"`
	Category             string               `json:"category"`
	Versions             []altStoreAppVersion `json:"versions"`
	AppPermissions       altStorePermissions  `json:"appPermissions"`
}

type altStoreAppVersion struct {
	Version              string `json:"version"`
	BuildVersion         string `json:"buildVersion"`
	Date                 string `json:"date"`
	LocalizedDescription string `json:"localizedDescription"`
	DownloadURL          string `json:"downloadURL"`
	Size                 int64  `json:"size"`
	MinOSVersion         string `json:"minOSVersion"`
}

type altStorePermissions struct {
	Entitlements []string          `json:"entitlements"`
	Privacy      map[string]string `json:"privacy"`
}

func resolveAltStoreVersionInfo() (ver string, buildVer string, dateISO string, downloadURL string, sizeBytes int64) {
	rawTag := strings.TrimSpace(os.Getenv("SLAPRF_ALTSTORE_VERSION"))
	if rawTag == "" {
		if out, err := exec.Command("git", "describe", "--tags", "--abbrev=0").Output(); err == nil {
			rawTag = strings.TrimSpace(string(out))
		}
	}
	if rawTag == "" {
		rawTag = "v0.0.19"
	}
	ver = strings.TrimPrefix(rawTag, "v")
	if idx := strings.IndexByte(ver, '-'); idx >= 0 {
		ver = ver[:idx]
	}

	buildVer = "1"
	parts := strings.Split(ver, ".")
	if len(parts) >= 3 {
		maj, e1 := strconv.Atoi(parts[0])
		min, e2 := strconv.Atoi(parts[1])
		pat, e3 := strconv.Atoi(parts[2])
		if e1 == nil && e2 == nil && e3 == nil && (maj*10000+min*100+pat) > 0 {
			buildVer = strconv.Itoa(maj*10000 + min*100 + pat)
		}
	}

	dateISO = strings.TrimSpace(os.Getenv("SLAPRF_ALTSTORE_DATE"))
	if dateISO == "" {
		if out, err := exec.Command("git", "log", "-1", "--format=%cI", rawTag).Output(); err == nil {
			if s := strings.TrimSpace(string(out)); s != "" {
				dateISO = s
			}
		}
	}
	if dateISO == "" {
		dateISO = time.Now().UTC().Format(time.RFC3339)
	}

	downloadURL = strings.TrimSpace(os.Getenv("SLAPRF_ALTSTORE_DOWNLOAD_URL"))
	if downloadURL == "" {
		downloadURL = fmt.Sprintf("https://github.com/kaack/SlapRF/releases/download/v%s/slaprf-ios-arm64.ipa", ver)
	}

	sizeBytes = 12_582_912
	if rawSize := strings.TrimSpace(os.Getenv("SLAPRF_ALTSTORE_SIZE")); rawSize != "" {
		if n, err := strconv.ParseInt(rawSize, 10, 64); err == nil && n > 0 {
			sizeBytes = n
		}
	}
	return ver, buildVer, dateISO, downloadURL, sizeBytes
}

func buildAltStoreSourceJSON(ver, buildVer, dateISO, downloadURL string, sizeBytes int64) ([]byte, error) {
	const iconURL = "https://slaprf.app/icons/app-icon-1024.png"
	doc := altStoreSource{
		Name:         "SlapRF",
		Identifier:   "app.slaprf.source",
		Subtitle:     "5.8 GHz FPV Race & Practice Timing System",
		Description:  "Open-source 5.8 GHz FPV gate timer with native CoreBluetooth Hub, ESP32-P4 PoE Bridge (:5480), spoken callouts, and MultiGP tournament sync.",
		IconURL:      iconURL,
		Website:      "https://slaprf.app",
		TintColor:    "#D4FF3A",
		FeaturedApps: []string{"app.slaprf.timer"},
		Apps: []altStoreAppItem{
			{
				Name:                 "SlapRF",
				BundleIdentifier:     "app.slaprf.timer",
				DeveloperName:        "SlapRF (@OneEyeFPV)",
				Subtitle:             "5.8 GHz FPV Gate Timer & Race Director",
				LocalizedDescription: "Native iOS and iPadOS SlapRF timing engine supporting SlapRF Bluetooth Hubs, ESP32-P4 PoE Ethernet Bridges (:5480), LapRF 8-Way (:5403), RotorHazard, offline bbolt storage, low-latency gate crossing beeps, voice callouts, and Wi-Fi LAN multi-display sharing.",
				IconURL:              iconURL,
				TintColor:            "#D4FF3A",
				Category:             "utilities",
				Versions: []altStoreAppVersion{
					{
						Version:              ver,
						BuildVersion:         buildVer,
						Date:                 dateISO,
						LocalizedDescription: fmt.Sprintf("SlapRF v%s native iOS and iPadOS release.", ver),
						DownloadURL:          downloadURL,
						Size:                 sizeBytes,
						MinOSVersion:         "16.0",
					},
				},
				AppPermissions: altStorePermissions{
					Entitlements: []string{},
					Privacy: map[string]string{
						"NSBluetoothAlwaysUsageDescription": "SlapRF uses Bluetooth LE to connect to your SlapRF Hub gate timer and stream live 5.8 GHz lap passes.",
						"NSLocalNetworkUsageDescription":    "SlapRF uses your local network to connect to SlapRF PoE Bridges, LapRF 8-Way, and RotorHazard timers, and to share live race results over Wi-Fi.",
					},
				},
			},
		},
		News: []any{},
	}
	out, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(out, '\n'), nil
}

func writeAltStoreAssets(outDir string) error {
	ver, buildVer, dateISO, downloadURL, sizeBytes := resolveAltStoreVersionInfo()
	rawJSON, err := buildAltStoreSourceJSON(ver, buildVer, dateISO, downloadURL, sizeBytes)
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(outDir, "altstore-source.json"), rawJSON, 0o644); err != nil {
		return err
	}
	iconSrc := filepath.FromSlash("ios/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png")
	if _, err := os.Stat(iconSrc); err == nil {
		if err := os.MkdirAll(filepath.Join(outDir, "icons"), 0o755); err != nil {
			return err
		}
		mustCopyFile(iconSrc, filepath.Join(outDir, "icons", "app-icon-1024.png"))
	}
	return nil
}
