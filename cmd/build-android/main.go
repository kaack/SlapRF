// Command build-android builds the embedded WASM-free SlapRF web UI, compiles ./cmd/slaprf-android
// into native Android shared libraries (libslaprf.so, 16KB ELF page-aligned), compiles the thin
// official Android USB/WebView Java shim, and packages a signed APK without Gradle.
package main

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
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

	"slaprf/internal/firmware"
)

const (
	usbSerialJarRel    = "android/libs/usb-serial-for-android-3.8.1.jar"
	usbSerialJarSHA256 = "5a6b278271d5ab04e273e20334c3e8579ede83323cca243d1e970eb37e656556"
)

type archTarget struct {
	goarch      string
	abi         string
	clangPrefix string
}

var supportedArches = map[string]archTarget{
	"arm64": {
		goarch:      "arm64",
		abi:         "arm64-v8a",
		clangPrefix: "aarch64-linux-android26-clang",
	},
	"amd64": {
		goarch:      "amd64",
		abi:         "x86_64",
		clangPrefix: "x86_64-linux-android26-clang",
	},
}

type androidToolchain struct {
	javaHome  string
	javac     string
	keytool   string
	sdkRoot   string
	ndkRoot   string
	ndkBinDir string
	androidJar string
	aapt2     string
	d8        string
	zipalign  string
	apksigner string
}

func main() {
	outAPK := flag.String("out", filepath.Join("dist", "slaprf-android.apk"), "Output signed APK file path")
	archList := flag.String("arch", "arm64", "Comma-separated target Go architectures (arm64, amd64)")
	versionFlag := flag.String("version", "", "Version name stamped into APK (default: git describe or 0.0.6)")
	versionCode := flag.Int("version-code", 7, "Integer Android versionCode")
	skipWeb := flag.Bool("skip-web", false, "Skip rebuilding cmd/slaprf-android/site if already built")
	bootLogDownloads := flag.Bool("boot-log-downloads", false, "Always flush startup diagnostics to Downloads/slaprf-startup-log.txt on every launch")
	flag.Parse()

	log.SetFlags(log.LstdFlags)

	tc, err := discoverToolchain()
	if err != nil {
		log.Fatalf("[build-android] Toolchain error: %v", err)
	}
	if err := verifyFileSHA256(filepath.FromSlash(usbSerialJarRel), usbSerialJarSHA256); err != nil {
		log.Fatalf("[build-android] Vendored JAR check failed: %v", err)
	}

	verName := strings.TrimPrefix(strings.TrimSpace(*versionFlag), "v")
	if verName == "" {
		verName = resolveGitVersion()
	}

	var targets []archTarget
	for _, raw := range strings.Split(*archList, ",") {
		key := strings.ToLower(strings.TrimSpace(raw))
		if key == "" {
			continue
		}
		t, ok := supportedArches[key]
		if !ok {
			log.Fatalf("[build-android] Unsupported -arch %q (supported: arm64, amd64)", key)
		}
		targets = append(targets, t)
	}
	if len(targets) == 0 {
		log.Fatalf("[build-android] At least one architecture must be specified in -arch")
	}

	// 1. Build embedded WASM-free SPA into cmd/slaprf-android/site
	siteDir := filepath.Join("cmd", "slaprf-android", "site")
	keepPath := filepath.Join(siteDir, ".keep")
	if !*skipWeb {
		keepBytes, _ := os.ReadFile(keepPath)
		if len(keepBytes) == 0 {
			keepBytes = []byte("# Placeholder so //go:embed all:site in cmd/slaprf-android compiles on a clean checkout before cmd/build-android runs.\n")
		}
		runCmd(tc.env(nil), "go", "run", "./cmd/build-web", "-web", "./web", "-out", siteDir, "-skip-wasm", "-skip-docs")
		_ = os.RemoveAll(filepath.Join(siteDir, "wasm"))
		_ = os.WriteFile(keepPath, keepBytes, 0o644)
	}
	// build-web copies every built firmware image (USB slaprf-xiao-c5.bin and, when present, the
	// Bluetooth Hub slaprf-xiao-c5-ble.bin) into site/firmware, so both are embedded in the APK.
	for _, name := range firmware.ImageNames() {
		if _, err := os.Stat(filepath.Join(siteDir, "firmware", name)); err == nil {
			log.Printf("[build-android] Embedded firmware image %s", name)
		}
	}

	workDir, err := os.MkdirTemp("", "slaprf-android-build-*")
	if err != nil {
		log.Fatalf("[build-android] MkdirTemp: %v", err)
	}
	defer os.RemoveAll(workDir)

	// 2. Cross-compile ./cmd/slaprf-android -> lib/<abi>/libslaprf.so (16KB ELF page-aligned)
	soFiles := make(map[string]string, len(targets))
	for _, t := range targets {
		cc := filepath.Join(tc.ndkBinDir, exeOrCmd(t.clangPrefix))
		soOut := filepath.Join(workDir, "jni", t.abi, "libslaprf.so")
		if err := os.MkdirAll(filepath.Dir(soOut), 0o755); err != nil {
			log.Fatalf("[build-android] mkdir %s: %v", filepath.Dir(soOut), err)
		}
		log.Printf("[build-android] Compiling libslaprf.so for %s (%s)...", t.abi, t.goarch)
		extraEnv := []string{
			"CGO_ENABLED=1",
			"GOOS=android",
			"GOARCH=" + t.goarch,
			"CC=" + cc,
		}
		runCmd(
			tc.env(extraEnv),
			"go", "build",
			"-buildmode=c-shared",
			"-trimpath",
			"-ldflags=-s -w -extldflags=-Wl,-z,max-page-size=16384",
			"-o", soOut,
			"./cmd/slaprf-android",
		)
		info, statErr := os.Stat(soOut)
		if statErr != nil || info.Size() == 0 {
			log.Fatalf("[build-android] Expected non-empty %s", soOut)
		}
		log.Printf("[build-android] Built %s (%d bytes)", t.abi+"/libslaprf.so", info.Size())
		soFiles["lib/"+t.abi+"/libslaprf.so"] = soOut
	}

	// 3. Compile Android resources & link base APK via aapt2
	resZip := filepath.Join(workDir, "res.zip")
	baseAPK := filepath.Join(workDir, "base.apk")
	genJavaDir := filepath.Join(workDir, "gen")
	if err := os.MkdirAll(genJavaDir, 0o755); err != nil {
		log.Fatalf("[build-android] mkdir gen: %v", err)
	}

	log.Printf("[build-android] Packaging resources & manifest (v%s, code %d)...", verName, *versionCode)
	runCmd(tc.env(nil), tc.aapt2, "compile", "--dir", filepath.FromSlash("android/res"), "-o", resZip)
	runCmd(
		tc.env(nil),
		tc.aapt2, "link",
		"-o", baseAPK,
		"-I", tc.androidJar,
		"--manifest", filepath.FromSlash("android/AndroidManifest.xml"),
		"--min-sdk-version", "26",
		"--target-sdk-version", "35",
		"--version-code", strconv.Itoa(*versionCode),
		"--version-name", verName,
		"--java", genJavaDir,
		resZip,
	)

	// 4. Compile Java shim + R.java via javac and convert to classes.dex via d8
	classesDir := filepath.Join(workDir, "classes")
	dexDir := filepath.Join(workDir, "dex")
	for _, d := range []string{classesDir, dexDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			log.Fatalf("[build-android] mkdir %s: %v", d, err)
		}
	}

	usbJarAbs, err := filepath.Abs(filepath.FromSlash(usbSerialJarRel))
	if err != nil {
		log.Fatalf("[build-android] abs jar: %v", err)
	}
	rJava := filepath.Join(genJavaDir, "app", "slaprf", "R.java")
	bootCfgJava := filepath.Join(genJavaDir, "app", "slaprf", "BootLogConfig.java")
	bootCfgSrc := fmt.Sprintf("package app.slaprf;\nfinal class BootLogConfig {\n    static final boolean ALWAYS_EXPORT_BOOT_LOG = %v;\n}\n", *bootLogDownloads)
	if err := os.WriteFile(bootCfgJava, []byte(bootCfgSrc), 0o644); err != nil {
		log.Fatalf("[build-android] write BootLogConfig.java: %v", err)
	}
	cp := tc.androidJar + string(os.PathListSeparator) + usbJarAbs

	log.Printf("[build-android] Compiling SlapRFApp.java, SlapRFHost.java, SlapRFUsbShim.java & SlapRFBleShim.java...")
	runCmd(
		tc.env(nil),
		tc.javac,
		"--release", "11",
		"-encoding", "UTF-8",
		"-cp", cp,
		"-d", classesDir,
		filepath.FromSlash("android/java/app/slaprf/SlapRFApp.java"),
		filepath.FromSlash("android/java/app/slaprf/SlapRFHost.java"),
		filepath.FromSlash("android/java/app/slaprf/SlapRFUsbShim.java"),
		filepath.FromSlash("android/java/app/slaprf/SlapRFBleShim.java"),
		bootCfgJava,
		rJava,
	)

	var classFiles []string
	_ = filepath.Walk(classesDir, func(p string, info os.FileInfo, walkErr error) error {
		if walkErr == nil && !info.IsDir() && strings.HasSuffix(info.Name(), ".class") {
			classFiles = append(classFiles, p)
		}
		return nil
	})
	sort.Strings(classFiles)
	if len(classFiles) == 0 {
		log.Fatalf("[build-android] javac produced 0 .class files")
	}

	d8Args := []string{
		"--lib", tc.androidJar,
		"--min-api", "26",
		"--release",
		"--output", dexDir,
	}
	d8Args = append(d8Args, classFiles...)
	d8Args = append(d8Args, usbJarAbs)
	runCmd(tc.env(nil), tc.d8, d8Args...)

	dexPath := filepath.Join(dexDir, "classes.dex")
	if _, err := os.Stat(dexPath); err != nil {
		log.Fatalf("[build-android] d8 did not produce %s: %v", dexPath, err)
	}

	// 5. Merge base APK + classes.dex + uncompressed lib/<abi>/libslaprf.so, 16KB-align, and sign
	unalignedAPK := filepath.Join(workDir, "unaligned.apk")
	alignedAPK := filepath.Join(workDir, "aligned.apk")
	if err := assembleAPK(baseAPK, dexPath, soFiles, unalignedAPK); err != nil {
		log.Fatalf("[build-android] assembleAPK failed: %v", err)
	}

	runCmd(tc.env(nil), tc.zipalign, "-P", "16", "-f", "4", unalignedAPK, alignedAPK)

	ksPath, ksPass, keyAlias, keyPass, err := resolveOrCreateKeystore(tc)
	if err != nil {
		log.Fatalf("[build-android] keystore error: %v", err)
	}

	if outDir := filepath.Dir(*outAPK); outDir != "." && outDir != "" {
		if err := os.MkdirAll(outDir, 0o755); err != nil {
			log.Fatalf("[build-android] mkdir %s: %v", outDir, err)
		}
	}

	log.Printf("[build-android] Signing APK -> %s...", *outAPK)
	runCmd(
		tc.env(nil),
		tc.apksigner, "sign",
		"--ks", ksPath,
		"--ks-pass", "pass:"+ksPass,
		"--ks-key-alias", keyAlias,
		"--key-pass", "pass:"+keyPass,
		"--out", *outAPK,
		alignedAPK,
	)
	runCmd(tc.env(nil), tc.apksigner, "verify", "--verbose", *outAPK)

	apkStat, err := os.Stat(*outAPK)
	if err != nil {
		log.Fatalf("[build-android] stat %s: %v", *outAPK, err)
	}
	log.Printf("[build-android] Ready: %s (%.2f MB)", *outAPK, float64(apkStat.Size())/(1024.0*1024.0))
}

func assembleAPK(baseAPK string, dexPath string, soFiles map[string]string, dstAPK string) error {
	zr, err := zip.OpenReader(baseAPK)
	if err != nil {
		return err
	}
	defer zr.Close()

	outF, err := os.Create(dstAPK)
	if err != nil {
		return err
	}
	defer outF.Close()

	zw := zip.NewWriter(outF)

	// Copy all compiled resource & manifest entries from aapt2's base APK preserving compression method.
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			_ = zw.Close()
			return err
		}
		hdr := f.FileHeader
		w, err := zw.CreateHeader(&hdr)
		if err != nil {
			_ = rc.Close()
			_ = zw.Close()
			return err
		}
		if _, err := io.Copy(w, rc); err != nil {
			_ = rc.Close()
			_ = zw.Close()
			return err
		}
		_ = rc.Close()
	}

	// Add classes.dex (Deflate compressed).
	if err := addFileToZip(zw, "classes.dex", dexPath, zip.Deflate); err != nil {
		_ = zw.Close()
		return err
	}

	// Add native shared libraries UNCOMPRESSED (zip.Store) so Android maps them directly from the APK
	// with 16 KB page alignment when zipalign -P 16 runs.
	var soKeys []string
	for k := range soFiles {
		soKeys = append(soKeys, k)
	}
	sort.Strings(soKeys)
	for _, zipRel := range soKeys {
		if err := addFileToZip(zw, zipRel, soFiles[zipRel], zip.Store); err != nil {
			_ = zw.Close()
			return err
		}
	}

	return zw.Close()
}

func addFileToZip(zw *zip.Writer, zipRel string, diskPath string, method uint16) error {
	in, err := os.Open(diskPath)
	if err != nil {
		return err
	}
	defer in.Close()
	st, err := in.Stat()
	if err != nil {
		return err
	}
	hdr, err := zip.FileInfoHeader(st)
	if err != nil {
		return err
	}
	hdr.Name = zipRel
	hdr.Method = method
	w, err := zw.CreateHeader(hdr)
	if err != nil {
		return err
	}
	_, err = io.Copy(w, in)
	return err
}

func resolveOrCreateKeystore(tc *androidToolchain) (ksPath, ksPass, keyAlias, keyPass string, err error) {
	if envKS := strings.TrimSpace(os.Getenv("SLAPRF_ANDROID_KEYSTORE")); envKS != "" {
		ksPass = os.Getenv("SLAPRF_ANDROID_KS_PASS")
		keyAlias = os.Getenv("SLAPRF_ANDROID_KEY_ALIAS")
		keyPass = os.Getenv("SLAPRF_ANDROID_KEY_PASS")
		if keyPass == "" {
			keyPass = ksPass
		}
		return envKS, ksPass, keyAlias, keyPass, nil
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return "", "", "", "", err
	}
	ksDir := filepath.Join(home, ".slaprf")
	if err := os.MkdirAll(ksDir, 0o700); err != nil {
		return "", "", "", "", err
	}
	ksPath = filepath.Join(ksDir, "android-debug.keystore")
	ksPass = "android"
	keyAlias = "androiddebugkey"
	keyPass = "android"

	if _, err := os.Stat(ksPath); err != nil {
		log.Printf("[build-android] Generating local debug signing keystore at %s...", ksPath)
		runCmd(
			tc.env(nil),
			tc.keytool,
			"-genkeypair",
			"-v",
			"-keystore", ksPath,
			"-storepass", ksPass,
			"-alias", keyAlias,
			"-keypass", keyPass,
			"-keyalg", "RSA",
			"-keysize", "2048",
			"-validity", "10000",
			"-dname", "CN=Android Debug,O=Android,C=US",
		)
	}
	return ksPath, ksPass, keyAlias, keyPass, nil
}

func verifyFileSHA256(path string, expectedHex string) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(b)
	got := hex.EncodeToString(sum[:])
	if !strings.EqualFold(got, expectedHex) {
		return fmt.Errorf("%s sha256 = %s, want %s", path, got, expectedHex)
	}
	return nil
}

func resolveGitVersion() string {
	out, err := exec.Command("git", "describe", "--tags", "--abbrev=0").Output()
	if err == nil {
		clean := strings.TrimPrefix(strings.TrimSpace(string(out)), "v")
		if clean != "" {
			return clean
		}
	}
	return "0.0.6"
}

func discoverToolchain() (*androidToolchain, error) {
	home, _ := os.UserHomeDir()
	localToolchainRoot := filepath.Join(home, ".slaprf", "android-toolchain")

	var javaHome string
	for _, candidate := range []string{
		os.Getenv("JAVA_HOME"),
		filepath.Join(localToolchainRoot, "jdk-17"),
	} {
		if candidate != "" && fileExists(filepath.Join(candidate, "bin", exeName("javac"))) {
			javaHome = candidate
			break
		}
	}
	javacPath := ""
	keytoolPath := ""
	if javaHome != "" {
		javacPath = filepath.Join(javaHome, "bin", exeName("javac"))
		keytoolPath = filepath.Join(javaHome, "bin", exeName("keytool"))
	} else {
		if p, err := exec.LookPath("javac"); err == nil {
			javacPath = p
			javaHome = filepath.Dir(filepath.Dir(p))
		}
		if p, err := exec.LookPath("keytool"); err == nil {
			keytoolPath = p
		}
	}
	if javacPath == "" || keytoolPath == "" {
		return nil, fmt.Errorf("JDK (javac/keytool) not found; set JAVA_HOME or install JDK 17+")
	}

	var sdkCandidates []string
	for _, envKey := range []string{"ANDROID_HOME", "ANDROID_SDK_ROOT"} {
		if v := strings.TrimSpace(os.Getenv(envKey)); v != "" {
			sdkCandidates = append(sdkCandidates, v)
		}
	}
	sdkCandidates = append(sdkCandidates, filepath.Join(localToolchainRoot, "sdk"))
	if localApp := os.Getenv("LOCALAPPDATA"); localApp != "" {
		sdkCandidates = append(sdkCandidates, filepath.Join(localApp, "Android", "Sdk"))
	}
	if home != "" {
		sdkCandidates = append(
			sdkCandidates,
			filepath.Join(home, "Library", "Android", "sdk"),
			filepath.Join(home, "Android", "Sdk"),
		)
	}

	var sdkRoot string
	for _, c := range sdkCandidates {
		if c != "" && dirExists(filepath.Join(c, "build-tools")) && dirExists(filepath.Join(c, "platforms")) {
			sdkRoot = c
			break
		}
	}
	if sdkRoot == "" {
		return nil, fmt.Errorf("Android SDK not found (checked ANDROID_HOME, ANDROID_SDK_ROOT, and %s)", filepath.Join(localToolchainRoot, "sdk"))
	}

	buildToolsDir, err := pickLatestSubdir(filepath.Join(sdkRoot, "build-tools"))
	if err != nil {
		return nil, fmt.Errorf("no Android build-tools installed under %s: %w", sdkRoot, err)
	}

	androidJar := filepath.Join(sdkRoot, "platforms", "android-35", "android.jar")
	if !fileExists(androidJar) {
		platDir, pErr := pickLatestSubdir(filepath.Join(sdkRoot, "platforms"))
		if pErr != nil {
			return nil, fmt.Errorf("no Android platforms installed under %s: %w", sdkRoot, pErr)
		}
		androidJar = filepath.Join(platDir, "android.jar")
	}
	if !fileExists(androidJar) {
		return nil, fmt.Errorf("android.jar not found at %s", androidJar)
	}

	var ndkRoot string
	for _, envKey := range []string{"ANDROID_NDK_HOME", "ANDROID_NDK_ROOT", "NDK_ROOT"} {
		if v := strings.TrimSpace(os.Getenv(envKey)); v != "" && dirExists(filepath.Join(v, "toolchains")) {
			ndkRoot = v
			break
		}
	}
	if ndkRoot == "" {
		if dirExists(filepath.Join(sdkRoot, "ndk")) {
			ndkRoot, _ = pickLatestSubdir(filepath.Join(sdkRoot, "ndk"))
		} else if dirExists(filepath.Join(sdkRoot, "ndk-bundle", "toolchains")) {
			ndkRoot = filepath.Join(sdkRoot, "ndk-bundle")
		}
	}
	if ndkRoot == "" {
		return nil, fmt.Errorf("Android NDK not found under %s/ndk (or ANDROID_NDK_HOME)", sdkRoot)
	}

	prebuiltRoot := filepath.Join(ndkRoot, "toolchains", "llvm", "prebuilt")
	hostDir, err := pickLatestSubdir(prebuiltRoot)
	if err != nil {
		return nil, fmt.Errorf("NDK llvm prebuilt host toolchain not found under %s: %w", prebuiltRoot, err)
	}

	return &androidToolchain{
		javaHome:   javaHome,
		javac:      javacPath,
		keytool:    keytoolPath,
		sdkRoot:    sdkRoot,
		ndkRoot:    ndkRoot,
		ndkBinDir:  filepath.Join(hostDir, "bin"),
		androidJar: androidJar,
		aapt2:      filepath.Join(buildToolsDir, exeName("aapt2")),
		d8:         filepath.Join(buildToolsDir, batName("d8")),
		zipalign:   filepath.Join(buildToolsDir, exeName("zipalign")),
		apksigner:  filepath.Join(buildToolsDir, batName("apksigner")),
	}, nil
}

func (tc *androidToolchain) env(extra []string) []string {
	base := os.Environ()
	var filtered []string
	var curPath string
	for _, kv := range base {
		upper := strings.ToUpper(kv)
		if strings.HasPrefix(upper, "PATH=") {
			curPath = kv[5:]
			continue
		}
		if strings.HasPrefix(upper, "JAVA_HOME=") ||
			strings.HasPrefix(upper, "ANDROID_HOME=") ||
			strings.HasPrefix(upper, "ANDROID_SDK_ROOT=") {
			continue
		}
		filtered = append(filtered, kv)
	}
	if tc.javaHome != "" {
		filtered = append(filtered, "JAVA_HOME="+tc.javaHome)
		curPath = filepath.Join(tc.javaHome, "bin") + string(os.PathListSeparator) + curPath
	}
	filtered = append(filtered, "ANDROID_HOME="+tc.sdkRoot, "ANDROID_SDK_ROOT="+tc.sdkRoot)
	filtered = append(filtered, "PATH="+curPath)
	filtered = append(filtered, extra...)
	return filtered
}

func runCmd(env []string, bin string, args ...string) {
	cmd := exec.Command(bin, args...)
	cmd.Env = env
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		log.Fatalf("[build-android] command failed (%s %s): %v", filepath.Base(bin), strings.Join(args, " "), err)
	}
}

func pickLatestSubdir(parent string) (string, error) {
	entries, err := os.ReadDir(parent)
	if err != nil {
		return "", err
	}
	var dirs []string
	for _, e := range entries {
		if e.IsDir() && !strings.HasPrefix(e.Name(), ".") {
			dirs = append(dirs, filepath.Join(parent, e.Name()))
		}
	}
	if len(dirs) == 0 {
		return "", fmt.Errorf("no subdirectories in %s", parent)
	}
	sort.Strings(dirs)
	return dirs[len(dirs)-1], nil
}

func exeName(base string) string {
	if runtime.GOOS == "windows" {
		return base + ".exe"
	}
	return base
}

func batName(base string) string {
	if runtime.GOOS == "windows" {
		return base + ".bat"
	}
	return base
}

func exeOrCmd(base string) string {
	if runtime.GOOS == "windows" {
		return base + ".cmd"
	}
	return base
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

func dirExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}
