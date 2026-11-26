// Command build-ios builds the embedded WASM-free SlapRF web UI (without USB flasher binaries),
// compiles ./cmd/slaprf-ios into libslaprf.a (arm64-apple-ios16.0 or iphonesimulator), compiles
// the Swift WKWebView + CoreBluetooth host shell via xcrun swiftc, and packages:
//   - an unsigned/ad-hoc signed sideloadable .ipa (default: dist/slaprf-ios-arm64.ipa),
//   - an iOS/iPadOS Simulator .app (with optional -simulator -run), or
//   - a signed physical iPad/iPhone build deployed via free Apple ID Personal Team (-device -team).
package main

import (
	"archive/zip"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
)

const defaultBundleID = "app.slaprf.timer"

func main() {
	outPath := flag.String("out", filepath.Join("dist", "slaprf-ios-arm64.ipa"), "Output .ipa (or .app for -simulator) file path")
	archFlag := flag.String("arch", "arm64", "Target Go architecture (arm64, or amd64 for Intel Simulator)")
	versionFlag := flag.String("version", "", "Short version stamped into Info.plist (default: git describe or 0.0.19)")
	buildNumberFlag := flag.String("build-number", "", "CFBundleVersion build number (default: derived from -version)")
	bundleIDFlag := flag.String("bundle-id", defaultBundleID, "CFBundleIdentifier")
	skipWeb := flag.Bool("skip-web", false, "Skip rebuilding cmd/slaprf-ios/site if already built")
	simulator := flag.Bool("simulator", false, "Build for iOS / iPadOS Simulator instead of physical arm64 device")
	simDevice := flag.String("sim-device", "", "Optional Simulator UDID or device name when -simulator -run is used")
	deviceFlag := flag.String("device", "", "Physical iPad/iPhone UDID/identifier (or 'auto') to sign and deploy via xcrun devicectl")
	teamFlag := flag.String("team", strings.TrimSpace(os.Getenv("SLAPRF_IOS_TEAM_ID")), "Apple Developer / free Personal Team ID (10-char) used with -device")
	runApp := flag.Bool("run", false, "Launch SlapRF.app with live console output after installing on Simulator or physical device")
	genAssetsOnly := flag.String("write-xcassets-icon", "", "Internal helper: render 1024x1024 AppIcon PNG to path and exit")
	flag.Parse()

	log.SetFlags(log.LstdFlags)

	if strings.TrimSpace(*genAssetsOnly) != "" {
		if err := writeIconPNG(*genAssetsOnly, 1024); err != nil {
			log.Fatalf("[build-ios] write icon %s: %v", *genAssetsOnly, err)
		}
		log.Printf("[build-ios] Wrote 1024x1024 opaque AppIcon to %s", *genAssetsOnly)
		return
	}

	if runtime.GOOS != "darwin" {
		log.Fatalf("[build-ios] Building SlapRF for iOS/iPadOS requires macOS with Xcode / Command Line Tools installed (current OS: %s)", runtime.GOOS)
	}
	if os.Getenv("DEVELOPER_DIR") == "" {
		const defaultXcodeDev = "/Applications/Xcode.app/Contents/Developer"
		if st, err := os.Stat(defaultXcodeDev); err == nil && st.IsDir() {
			_ = os.Setenv("DEVELOPER_DIR", defaultXcodeDev)
		}
	}

	goarch := strings.ToLower(strings.TrimSpace(*archFlag))
	if goarch != "arm64" && goarch != "amd64" {
		log.Fatalf("[build-ios] Unsupported -arch %q (expected arm64 or amd64)", goarch)
	}
	if !*simulator && goarch != "arm64" {
		log.Fatalf("[build-ios] Physical iOS/iPadOS devices require -arch arm64")
	}

	verName := strings.TrimPrefix(strings.TrimSpace(*versionFlag), "v")
	if verName == "" {
		verName = resolveGitVersion()
	}
	buildNum := strings.TrimSpace(*buildNumberFlag)
	if buildNum == "" {
		buildNum = deriveBuildNumber(verName)
	}
	bundleID := strings.TrimSpace(*bundleIDFlag)
	if bundleID == "" {
		bundleID = defaultBundleID
	}

	// 1. Stage WASM-free & USB-firmware-free SPA into cmd/slaprf-ios/site
	siteDir := filepath.Join("cmd", "slaprf-ios", "site")
	keepPath := filepath.Join(siteDir, ".keep")
	keepBytes, _ := os.ReadFile(keepPath)
	if len(keepBytes) == 0 {
		keepBytes = []byte("# Placeholder so //go:embed all:site in cmd/slaprf-ios compiles on a clean checkout before cmd/build-ios runs.\n")
	}
	if !*skipWeb {
		runCmd(nil, "go", "run", "./cmd/build-web", "-web", "./web", "-out", siteDir, "-skip-wasm", "-skip-docs")
	}
	// Strip WASM, Hugo docs, and USB serial .bin firmware images to keep slaprf-ios-arm64.ipa extra lean.
	_ = os.RemoveAll(filepath.Join(siteDir, "wasm"))
	_ = os.RemoveAll(filepath.Join(siteDir, "docs"))
	_ = os.RemoveAll(filepath.Join(siteDir, "firmware"))
	_ = os.MkdirAll(siteDir, 0o755)
	_ = os.WriteFile(keepPath, keepBytes, 0o644)

	sdkName := "iphoneos"
	triple := "arm64-apple-ios16.0"
	if *simulator {
		sdkName = "iphonesimulator"
		if goarch == "amd64" {
			triple = "x86_64-apple-ios16.0-simulator"
		} else {
			triple = "arm64-apple-ios16.0-simulator"
		}
	}

	sdkPath := xcrunLookup("--sdk", sdkName, "--show-sdk-path")
	clangPath := xcrunLookup("--sdk", sdkName, "--find", "clang")
	swiftcPath := xcrunLookup("--sdk", sdkName, "--find", "swiftc")

	workDir, err := os.MkdirTemp("", "slaprf-ios-build-*")
	if err != nil {
		log.Fatalf("[build-ios] MkdirTemp: %v", err)
	}
	defer os.RemoveAll(workDir)

	// 2. Compile ./cmd/slaprf-ios -> libslaprf.a
	archiveOut := filepath.Join(workDir, "libslaprf.a")
	log.Printf("[build-ios] Compiling libslaprf.a (%s, %s)...", sdkName, triple)
	cgoFlags := fmt.Sprintf("-isysroot %s -target %s", sdkPath, triple)
	goEnv := append(
		os.Environ(),
		"CGO_ENABLED=1",
		"GOOS=ios",
		"GOARCH="+goarch,
		"CC="+clangPath,
		"CGO_CFLAGS="+cgoFlags,
		"CGO_LDFLAGS="+cgoFlags,
	)
	runCmd(
		goEnv,
		"go", "build",
		"-buildmode=c-archive",
		"-trimpath",
		"-ldflags=-s -w",
		"-o", archiveOut,
		"./cmd/slaprf-ios",
	)
	if info, statErr := os.Stat(archiveOut); statErr != nil || info.Size() == 0 {
		log.Fatalf("[build-ios] Expected non-empty %s", archiveOut)
	} else {
		log.Printf("[build-ios] Built libslaprf.a (%d bytes)", info.Size())
	}

	// Physical device deploy path: sign via Xcode Personal Team & install via xcrun devicectl
	if strings.TrimSpace(*deviceFlag) != "" {
		deployToPhysicalDevice(archiveOut, strings.TrimSpace(*deviceFlag), strings.TrimSpace(*teamFlag), bundleID, verName, buildNum, *runApp)
		return
	}

	// 3. Assemble Payload/SlapRF.app bundle
	payloadDir := filepath.Join(workDir, "Payload")
	appDir := filepath.Join(payloadDir, "SlapRF.app")
	if err := os.MkdirAll(appDir, 0o755); err != nil {
		log.Fatalf("[build-ios] mkdir %s: %v", appDir, err)
	}

	appBinary := filepath.Join(appDir, "SlapRF")
	log.Printf("[build-ios] Compiling Swift host shell (SlapRFApp, SlapRFViewController, SlapRFBleShim)...")
	runCmd(
		nil,
		swiftcPath,
		"-swift-version", "5",
		"-parse-as-library",
		"-O",
		"-sdk", sdkPath,
		"-target", triple,
		"-import-objc-header", filepath.FromSlash("ios/SlapRF-Bridging-Header.h"),
		filepath.FromSlash("ios/SlapRFApp.swift"),
		filepath.FromSlash("ios/SlapRFViewController.swift"),
		filepath.FromSlash("ios/SlapRFBleShim.swift"),
		archiveOut,
		"-framework", "UIKit",
		"-framework", "WebKit",
		"-framework", "CoreBluetooth",
		"-framework", "AVFoundation",
		"-framework", "AudioToolbox",
		"-framework", "UniformTypeIdentifiers",
		"-framework", "Foundation",
		"-framework", "Security",
		"-framework", "CoreFoundation",
		"-lresolv",
		"-o", appBinary,
	)
	_ = os.Chmod(appBinary, 0o755)

	// 4. Render opaque AppIcons & Info.plist
	iconSpecs := []struct {
		name string
		size int
	}{
		{"AppIcon60x60@2x.png", 120},
		{"AppIcon60x60@3x.png", 180},
		{"AppIcon76x76@2x~ipad.png", 152},
		{"AppIcon83.5x83.5@2x~ipad.png", 167},
		{"AppIcon1024x1024.png", 1024},
	}
	for _, ic := range iconSpecs {
		if err := writeIconPNG(filepath.Join(appDir, ic.name), ic.size); err != nil {
			log.Fatalf("[build-ios] write icon %s: %v", ic.name, err)
		}
	}
	compileAssetCatalogIfAvailable(sdkName, appDir, workDir)

	plistBytes, err := os.ReadFile(filepath.FromSlash("ios/Info.plist"))
	if err != nil {
		log.Fatalf("[build-ios] read ios/Info.plist: %v", err)
	}
	renderedPlist := renderInfoPlist(string(plistBytes), bundleID, verName, buildNum)
	destPlist := filepath.Join(appDir, "Info.plist")
	if err := os.WriteFile(destPlist, []byte(renderedPlist), 0o644); err != nil {
		log.Fatalf("[build-ios] write Info.plist: %v", err)
	}
	if _, lookErr := exec.LookPath("plutil"); lookErr == nil {
		runCmd(nil, "plutil", "-lint", destPlist)
	}
	_ = os.WriteFile(filepath.Join(appDir, "PkgInfo"), []byte("APPL????"), 0o644)

	// 5. Ad-hoc sign SlapRF.app (required by iOS Simulator & valid base signature for Sideloadly/SideStore)
	runCmd(nil, "codesign", "--force", "--sign", "-", "--timestamp=none", appDir)

	if *simulator {
		simOut := *outPath
		if strings.HasSuffix(strings.ToLower(simOut), ".ipa") {
			simOut = filepath.Join("dist", "SlapRF-Simulator.app")
		}
		_ = os.RemoveAll(simOut)
		if err := copyDirRecursive(appDir, simOut); err != nil {
			log.Fatalf("[build-ios] copy simulator .app: %v", err)
		}
		runCmd(nil, "codesign", "--force", "--sign", "-", "--timestamp=none", simOut)
		log.Printf("[build-ios] Built Simulator app bundle: %s", simOut)
		if *runApp {
			bootAndRunSimulator(simOut, bundleID, strings.TrimSpace(*simDevice))
		}
		return
	}

	if err := os.MkdirAll(filepath.Dir(*outPath), 0o755); err != nil {
		log.Fatalf("[build-ios] mkdir %s: %v", filepath.Dir(*outPath), err)
	}
	if err := packageIPA(payloadDir, *outPath); err != nil {
		log.Fatalf("[build-ios] package .ipa: %v", err)
	}
	info, _ := os.Stat(*outPath)
	log.Printf("[build-ios] Packaged sideloadable IPA: %s (%d bytes, v%s build %s)", *outPath, info.Size(), verName, buildNum)
}

func renderInfoPlist(raw, bundleID, verName, buildNum string) string {
	r := strings.NewReplacer(
		"$(PRODUCT_BUNDLE_IDENTIFIER)", bundleID,
		"$(MARKETING_VERSION)", verName,
		"$(CURRENT_PROJECT_VERSION)", buildNum,
	)
	return r.Replace(raw)
}

func compileAssetCatalogIfAvailable(sdkName, appDir, workDir string) {
	xcassets := filepath.FromSlash("ios/Assets.xcassets")
	if st, err := os.Stat(xcassets); err != nil || !st.IsDir() {
		return
	}
	actoolOut, err := exec.Command("xcrun", "--sdk", sdkName, "--find", "actool").Output()
	if err != nil {
		return
	}
	actool := strings.TrimSpace(string(actoolOut))
	if actool == "" {
		return
	}
	partialPlist := filepath.Join(workDir, "assetcatalog_generated_info.plist")
	cmd := exec.Command(
		actool,
		"--output-format", "human-readable-text",
		"--notices", "--warnings",
		"--export-dependency-info", filepath.Join(workDir, "assetcatalog_dependencies"),
		"--output-partial-info-plist", partialPlist,
		"--app-icon", "AppIcon",
		"--compress-pngs",
		"--enable-on-demand-resources", "NO",
		"--target-device", "iphone",
		"--target-device", "ipad",
		"--minimum-deployment-target", "16.0",
		"--platform", sdkName,
		"--compile", appDir,
		xcassets,
	)
	if out, runErr := cmd.CombinedOutput(); runErr != nil {
		log.Printf("[build-ios] Note: actool skipped (%v): %s", runErr, strings.TrimSpace(string(out)))
	}
}

func packageIPA(payloadDir, outIPA string) error {
	_ = os.Remove(outIPA)
	outFile, err := os.Create(outIPA)
	if err != nil {
		return err
	}
	defer outFile.Close()

	zw := zip.NewWriter(outFile)
	baseParent := filepath.Dir(payloadDir)

	var entries []string
	err = filepath.Walk(payloadDir, func(p string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		entries = append(entries, p)
		return nil
	})
	if err != nil {
		_ = zw.Close()
		return err
	}
	sort.Strings(entries)

	for _, p := range entries {
		info, err := os.Lstat(p)
		if err != nil {
			_ = zw.Close()
			return err
		}
		rel, err := filepath.Rel(baseParent, p)
		if err != nil {
			_ = zw.Close()
			return err
		}
		zipName := filepath.ToSlash(rel)
		if info.IsDir() {
			if !strings.HasSuffix(zipName, "/") {
				zipName += "/"
			}
			fh := &zip.FileHeader{
				Name:   zipName,
				Method: zip.Store,
			}
			fh.SetMode(0o755 | os.ModeDir)
			if _, err := zw.CreateHeader(fh); err != nil {
				_ = zw.Close()
				return err
			}
			continue
		}

		fh, err := zip.FileInfoHeader(info)
		if err != nil {
			_ = zw.Close()
			return err
		}
		fh.Name = zipName
		fh.Method = zip.Deflate
		if zipName == "Payload/SlapRF.app/SlapRF" {
			fh.SetMode(0o755)
		} else {
			fh.SetMode(0o644)
		}
		w, err := zw.CreateHeader(fh)
		if err != nil {
			_ = zw.Close()
			return err
		}
		in, err := os.Open(p)
		if err != nil {
			_ = zw.Close()
			return err
		}
		_, copyErr := io.Copy(w, in)
		_ = in.Close()
		if copyErr != nil {
			_ = zw.Close()
			return copyErr
		}
	}

	return zw.Close()
}

func deployToPhysicalDevice(archivePath, deviceSpec, teamID, bundleID, verName, buildNum string, launch bool) {
	if teamID == "" {
		log.Fatalf("[build-ios] -team <10-CHAR-TEAM-ID> (or SLAPRF_IOS_TEAM_ID) is required to sign for a physical iPad/iPhone.\nFind your free Personal Team ID in Xcode -> Settings -> Accounts, or run:\n  security find-identity -v -p codesigning")
	}

	targetDevice := resolveConnectedDevice(deviceSpec)
	log.Printf("[build-ios] Target iOS/iPadOS device: %s", targetDevice)

	iosBuildDir := filepath.Join("ios", "build")
	if err := os.MkdirAll(iosBuildDir, 0o755); err != nil {
		log.Fatalf("[build-ios] mkdir ios/build: %v", err)
	}
	stagedArchive := filepath.Join(iosBuildDir, "libslaprf.a")
	if err := copyFile(archivePath, stagedArchive); err != nil {
		log.Fatalf("[build-ios] stage libslaprf.a: %v", err)
	}
	derivedDir := filepath.Join(iosBuildDir, "DerivedData")

	log.Printf("[build-ios] Signing SlapRF.app via xcodebuild (Team %s, Bundle ID %s)...", teamID, bundleID)
	runCmd(
		append(os.Environ(), "SLAPRF_SKIP_GO_ARCHIVE=1", "SLAPRF_PREBUILT_ARCHIVE="+mustAbs(stagedArchive)),
		"xcodebuild",
		"-project", filepath.FromSlash("ios/SlapRF.xcodeproj"),
		"-scheme", "SlapRF",
		"-configuration", "Release",
		"-destination", "generic/platform=iOS",
		"-derivedDataPath", derivedDir,
		"-allowProvisioningUpdates",
		"CODE_SIGN_STYLE=Automatic",
		"DEVELOPMENT_TEAM="+teamID,
		"PRODUCT_BUNDLE_IDENTIFIER="+bundleID,
		"MARKETING_VERSION="+verName,
		"CURRENT_PROJECT_VERSION="+buildNum,
		"build",
	)

	signedApp := filepath.Join(derivedDir, "Build", "Products", "Release-iphoneos", "SlapRF.app")
	if _, err := os.Stat(signedApp); err != nil {
		log.Fatalf("[build-ios] Expected signed app at %s: %v", signedApp, err)
	}

	log.Printf("[build-ios] Installing %s onto %s via devicectl...", signedApp, targetDevice)
	runCmd(nil, "xcrun", "devicectl", "device", "install", "app", "--device", targetDevice, signedApp)
	if launch {
		log.Printf("[build-ios] Launching %s with live console stream...", bundleID)
		runCmd(nil, "xcrun", "devicectl", "device", "process", "launch", "--console", "--terminate-existing", "--device", targetDevice, bundleID)
	}
}

func resolveConnectedDevice(spec string) string {
	if spec != "" && !strings.EqualFold(spec, "auto") {
		return spec
	}
	tmpJSON := filepath.Join(os.TempDir(), "slaprf-devicectl-devices.json")
	defer os.Remove(tmpJSON)
	cmd := exec.Command("xcrun", "devicectl", "list", "devices", "--json-output", tmpJSON)
	if out, err := cmd.CombinedOutput(); err != nil {
		log.Fatalf("[build-ios] xcrun devicectl list devices failed (%v): %s", err, strings.TrimSpace(string(out)))
	}
	raw, err := os.ReadFile(tmpJSON)
	if err != nil {
		log.Fatalf("[build-ios] read devicectl JSON: %v", err)
	}
	var parsed struct {
		Result struct {
			Devices []struct {
				Identifier           string `json:"identifier"`
				ConnectionProperties struct {
					PairingState string `json:"pairingState"`
					TunnelState  string `json:"tunnelState"`
				} `json:"connectionProperties"`
				DeviceProperties struct {
					Name string `json:"name"`
				} `json:"deviceProperties"`
			} `json:"devices"`
		} `json:"result"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		log.Fatalf("[build-ios] parse devicectl JSON: %v", err)
	}
	for _, d := range parsed.Result.Devices {
		if d.Identifier != "" && strings.EqualFold(d.ConnectionProperties.PairingState, "paired") {
			log.Printf("[build-ios] Auto-selected paired device %q (%s)", d.DeviceProperties.Name, d.Identifier)
			return d.Identifier
		}
	}
	log.Fatalf("[build-ios] No paired iPad/iPhone found in `xcrun devicectl list devices`. Connect over USB once and trust this Mac.")
	return ""
}

func bootAndRunSimulator(appPath, bundleID, simDevice string) {
	target := simDevice
	if target == "" {
		// Check if a simulator is already booted; otherwise pick the first available iPad or iPhone.
		out, err := exec.Command("xcrun", "simctl", "list", "devices", "available", "-j").Output()
		if err == nil {
			var parsed struct {
				Devices map[string][]struct {
					UDID        string `json:"udid"`
					Name        string `json:"name"`
					State       string `json:"state"`
					IsAvailable bool   `json:"isAvailable"`
				} `json:"devices"`
			}
			if json.Unmarshal(out, &parsed) == nil {
				var firstIPad, firstIPhone string
				for rt, list := range parsed.Devices {
					if !strings.Contains(strings.ToLower(rt), "ios") {
						continue
					}
					for _, d := range list {
						if !d.IsAvailable {
							continue
						}
						if strings.EqualFold(d.State, "Booted") {
							target = d.UDID
							break
						}
						if firstIPad == "" && strings.Contains(d.Name, "iPad") {
							firstIPad = d.UDID
						}
						if firstIPhone == "" && strings.Contains(d.Name, "iPhone") {
							firstIPhone = d.UDID
						}
					}
					if target != "" {
						break
					}
				}
				if target == "" {
					if firstIPad != "" {
						target = firstIPad
					} else {
						target = firstIPhone
					}
				}
			}
		}
	}
	if target == "" {
		log.Fatalf("[build-ios] No available iOS/iPadOS Simulator found in `xcrun simctl list devices available`")
	}
	_ = exec.Command("xcrun", "simctl", "boot", target).Run()
	if err := exec.Command("open", "-a", "Simulator").Run(); err != nil {
		// Xcode 27+ unified Simulator.app into DeviceHub.app under Xcode.app/Contents/Applications.
		_ = exec.Command("open", "-a", "/Applications/Xcode.app/Contents/Applications/DeviceHub.app").Run()
	}
	runCmd(nil, "xcrun", "simctl", "bootstatus", target, "-b")
	runCmd(nil, "xcrun", "simctl", "install", target, appPath)
	runCmd(nil, "xcrun", "simctl", "launch", "--console-pty", "--terminate-running-process", target, bundleID)
}

func xcrunLookup(args ...string) string {
	out, err := exec.Command("xcrun", args...).CombinedOutput()
	if err != nil {
		log.Fatalf("[build-ios] xcrun %s failed (%v): %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return strings.TrimSpace(string(out))
}

func resolveGitVersion() string {
	out, err := exec.Command("git", "describe", "--tags", "--abbrev=0").Output()
	if err == nil {
		v := strings.TrimPrefix(strings.TrimSpace(string(out)), "v")
		if v != "" {
			return v
		}
	}
	return "0.0.19"
}

func deriveBuildNumber(ver string) string {
	clean := strings.TrimPrefix(ver, "v")
	if idx := strings.IndexByte(clean, '-'); idx >= 0 {
		clean = clean[:idx]
	}
	parts := strings.Split(clean, ".")
	if len(parts) >= 3 {
		maj, e1 := strconv.Atoi(parts[0])
		min, e2 := strconv.Atoi(parts[1])
		pat, e3 := strconv.Atoi(parts[2])
		if e1 == nil && e2 == nil && e3 == nil {
			code := maj*10000 + min*100 + pat
			if code > 0 {
				return strconv.Itoa(code)
			}
		}
	}
	return "1"
}

func runCmd(env []string, name string, args ...string) {
	cmd := exec.Command(name, args...)
	if env != nil {
		cmd.Env = env
	}
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		log.Fatalf("[build-ios] %s %s failed: %v", name, strings.Join(args, " "), err)
	}
}

func mustAbs(p string) string {
	abs, err := filepath.Abs(p)
	if err != nil {
		return p
	}
	return abs
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()
	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	if st, err := in.Stat(); err == nil {
		_ = os.Chmod(dst, st.Mode())
	}
	return nil
}

func copyDirRecursive(srcDir, dstDir string) error {
	return filepath.Walk(srcDir, func(p string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(srcDir, p)
		if err != nil {
			return err
		}
		target := filepath.Join(dstDir, rel)
		if info.IsDir() {
			return os.MkdirAll(target, info.Mode())
		}
		return copyFile(p, target)
	})
}
