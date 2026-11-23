// Command build-gatecam compiles the SlapRF GateCam TypeScript SPA (`tools/gatecam/web`),
// cross-compiles `./cmd/gatecam-android` into `libgatecam.so` (16 KB ELF page-aligned),
// fetches & SHA-256-verifies the official OpenCV 4.12.0 Android AAR from Maven Central
// into `~/.cache/slaprf-gatecam/`, compiles the Java Camera2 + OpenCV shim, and packages
// a signed development verification APK (`dist/slaprf-gatecam.apk`) without Gradle.
package main

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"slaprf/internal/gatecam"
)

const (
	openCVVersion   = "4.12.0"
	openCVMavenURL  = "https://repo1.maven.org/maven2/org/opencv/opencv/4.12.0/opencv-4.12.0.aar"
	openCVAARSHA256 = "f71846a313388d9da667a59be1e921669fcf792d1ba264b3898253ca789bc3f0"
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
	javaHome   string
	javac      string
	keytool    string
	sdkRoot    string
	ndkRoot    string
	ndkBinDir  string
	androidJar string
	aapt2      string
	d8         string
	zipalign   string
	apksigner  string
}

func main() {
	outAPK := flag.String("out", filepath.Join("dist", "slaprf-gatecam.apk"), "Output signed APK file path")
	archList := flag.String("arch", "arm64", "Comma-separated target Go architectures (arm64, amd64)")
	versionFlag := flag.String("version", "", "Version name stamped into APK (default: git describe or 0.1.0)")
	versionCode := flag.Int("version-code", 1, "Integer Android versionCode")
	skipWeb := flag.Bool("skip-web", false, "Skip rebuilding cmd/gatecam-android/site if already built")
	flag.Parse()

	log.SetFlags(log.LstdFlags)

	tc, err := discoverToolchain()
	if err != nil {
		log.Fatalf("[build-gatecam] Toolchain error: %v", err)
	}

	aarPath, err := ensureOpenCVAAR()
	if err != nil {
		log.Fatalf("[build-gatecam] OpenCV AAR error: %v", err)
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
			log.Fatalf("[build-gatecam] Unsupported -arch %q (supported: arm64, amd64)", key)
		}
		targets = append(targets, t)
	}
	if len(targets) == 0 {
		log.Fatalf("[build-gatecam] At least one architecture must be specified in -arch")
	}

	// 1. Bundle tools/gatecam/web -> cmd/gatecam-android/site
	siteDir := filepath.Join("cmd", "gatecam-android", "site")
	keepPath := filepath.Join(siteDir, ".keep")
	if !*skipWeb {
		keepBytes, _ := os.ReadFile(keepPath)
		if len(keepBytes) == 0 {
			keepBytes = []byte("# Placeholder so //go:embed all:site in cmd/gatecam-android compiles on a clean checkout before cmd/build-gatecam runs.\n")
		}
		_ = os.RemoveAll(siteDir)
		if err := gatecam.BuildStaticSite(filepath.Join("tools", "gatecam", "web"), siteDir); err != nil {
			log.Fatalf("[build-gatecam] BuildStaticSite failed: %v", err)
		}
		_ = os.WriteFile(keepPath, keepBytes, 0o644)
	}

	workDir, err := os.MkdirTemp("", "slaprf-gatecam-build-*")
	if err != nil {
		log.Fatalf("[build-gatecam] MkdirTemp: %v", err)
	}
	defer os.RemoveAll(workDir)

	// 2. Extract classes.jar + native libopencv_java4.so & libc++_shared.so from OpenCV AAR
	openCVJar := filepath.Join(workDir, "opencv-classes.jar")
	soFiles := make(map[string]string)
	if err := extractOpenCVAssets(aarPath, workDir, openCVJar, targets, soFiles); err != nil {
		log.Fatalf("[build-gatecam] extractOpenCVAssets failed: %v", err)
	}

	// 3. Cross-compile ./cmd/gatecam-android -> lib/<abi>/libgatecam.so (16 KB ELF page-aligned)
	for _, t := range targets {
		cc := filepath.Join(tc.ndkBinDir, exeOrCmd(t.clangPrefix))
		soOut := filepath.Join(workDir, "jni", t.abi, "libgatecam.so")
		if err := os.MkdirAll(filepath.Dir(soOut), 0o755); err != nil {
			log.Fatalf("[build-gatecam] mkdir %s: %v", filepath.Dir(soOut), err)
		}
		log.Printf("[build-gatecam] Compiling libgatecam.so for %s (%s)...", t.abi, t.goarch)
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
			"./cmd/gatecam-android",
		)
		info, statErr := os.Stat(soOut)
		if statErr != nil || info.Size() == 0 {
			log.Fatalf("[build-gatecam] Expected non-empty %s", soOut)
		}
		soFiles["lib/"+t.abi+"/libgatecam.so"] = soOut
	}

	// 4. Compile resources & manifest via aapt2
	resZip := filepath.Join(workDir, "res.zip")
	baseAPK := filepath.Join(workDir, "base.apk")
	genJavaDir := filepath.Join(workDir, "gen")
	if err := os.MkdirAll(genJavaDir, 0o755); err != nil {
		log.Fatalf("[build-gatecam] mkdir gen: %v", err)
	}

	log.Printf("[build-gatecam] Packaging resources & manifest (v%s, code %d)...", verName, *versionCode)
	runCmd(tc.env(nil), tc.aapt2, "compile", "--dir", filepath.FromSlash("tools/gatecam/android/res"), "-o", resZip)
	runCmd(
		tc.env(nil),
		tc.aapt2, "link",
		"-o", baseAPK,
		"-I", tc.androidJar,
		"--manifest", filepath.FromSlash("tools/gatecam/android/AndroidManifest.xml"),
		"--min-sdk-version", "26",
		"--target-sdk-version", "35",
		"--version-code", strconv.Itoa(*versionCode),
		"--version-name", verName,
		"--java", genJavaDir,
		resZip,
	)

	// 5. Compile Java shim + R.java against OpenCV classes.jar and dex via d8
	classesDir := filepath.Join(workDir, "classes")
	dexDir := filepath.Join(workDir, "dex")
	for _, d := range []string{classesDir, dexDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			log.Fatalf("[build-gatecam] mkdir %s: %v", d, err)
		}
	}

	rJava := filepath.Join(genJavaDir, "app", "slaprf", "gatecam", "R.java")
	cp := tc.androidJar + string(os.PathListSeparator) + openCVJar

	log.Printf("[build-gatecam] Compiling GateCamHost, GateCamShim & HighSpeedGlPipe against OpenCV %s...", openCVVersion)
	runCmd(
		tc.env(nil),
		tc.javac,
		"--release", "11",
		"-encoding", "UTF-8",
		"-cp", cp,
		"-d", classesDir,
		filepath.FromSlash("tools/gatecam/android/java/app/slaprf/gatecam/GateCamHost.java"),
		filepath.FromSlash("tools/gatecam/android/java/app/slaprf/gatecam/GateCamShim.java"),
		filepath.FromSlash("tools/gatecam/android/java/app/slaprf/gatecam/HighSpeedGlPipe.java"),
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
		log.Fatalf("[build-gatecam] javac produced 0 .class files")
	}

	d8Args := []string{
		"--lib", tc.androidJar,
		"--min-api", "26",
		"--release",
		"--output", dexDir,
	}
	d8Args = append(d8Args, classFiles...)
	d8Args = append(d8Args, openCVJar)
	runCmd(tc.env(nil), tc.d8, d8Args...)

	// 6. Merge base APK + classes*.dex + uncompressed native .so files, 16 KB page-align, and sign
	unalignedAPK := filepath.Join(workDir, "unaligned.apk")
	alignedAPK := filepath.Join(workDir, "aligned.apk")
	if err := assembleAPK(baseAPK, dexDir, soFiles, unalignedAPK); err != nil {
		log.Fatalf("[build-gatecam] assembleAPK failed: %v", err)
	}

	runCmd(tc.env(nil), tc.zipalign, "-P", "16", "-f", "4", unalignedAPK, alignedAPK)

	ksPath, ksPass, keyAlias, keyPass, err := resolveOrCreateKeystore(tc)
	if err != nil {
		log.Fatalf("[build-gatecam] keystore error: %v", err)
	}

	if outDir := filepath.Dir(*outAPK); outDir != "." && outDir != "" {
		if err := os.MkdirAll(outDir, 0o755); err != nil {
			log.Fatalf("[build-gatecam] mkdir %s: %v", outDir, err)
		}
	}

	log.Printf("[build-gatecam] Signing APK -> %s...", *outAPK)
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
		log.Fatalf("[build-gatecam] stat %s: %v", *outAPK, err)
	}
	log.Printf("[build-gatecam] Ready: %s (%.2f MB)", *outAPK, float64(apkStat.Size())/(1024.0*1024.0))
}

func ensureOpenCVAAR() (string, error) {
	cacheDir := os.Getenv("SLAPRF_GATECAM_CACHE")
	if strings.TrimSpace(cacheDir) == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		cacheDir = filepath.Join(home, ".cache", "slaprf-gatecam")
	}
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		return "", err
	}
	aarPath := filepath.Join(cacheDir, "opencv-"+openCVVersion+".aar")
	if verifyFileSHA256(aarPath, openCVAARSHA256) == nil {
		return aarPath, nil
	}

	log.Printf("[build-gatecam] Downloading org.opencv:opencv:%s from Maven Central...", openCVVersion)
	hc := &http.Client{Timeout: 3 * time.Minute}
	resp, err := hc.Get(openCVMavenURL)
	if err != nil {
		return "", fmt.Errorf("download %s: %w", openCVMavenURL, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("download %s: HTTP %d", openCVMavenURL, resp.StatusCode)
	}
	tmpPath := aarPath + ".tmp"
	f, err := os.Create(tmpPath)
	if err != nil {
		return "", err
	}
	if _, err := io.Copy(f, resp.Body); err != nil {
		_ = f.Close()
		_ = os.Remove(tmpPath)
		return "", err
	}
	_ = f.Close()
	if err := verifyFileSHA256(tmpPath, openCVAARSHA256); err != nil {
		_ = os.Remove(tmpPath)
		return "", err
	}
	if err := os.Rename(tmpPath, aarPath); err != nil {
		return "", err
	}
	return aarPath, nil
}

func extractOpenCVAssets(aarPath, workDir, outJar string, targets []archTarget, soFiles map[string]string) error {
	zr, err := zip.OpenReader(aarPath)
	if err != nil {
		return err
	}
	defer zr.Close()

	wantABIs := make(map[string]bool, len(targets))
	for _, t := range targets {
		wantABIs[t.abi] = true
	}

	gotJar := false
	for _, f := range zr.File {
		if f.Name == "classes.jar" {
			if err := extractZipEntry(f, outJar); err != nil {
				return err
			}
			gotJar = true
			continue
		}
		for abi := range wantABIs {
			for _, libName := range []string{"libopencv_java4.so", "libc++_shared.so"} {
				if f.Name == "jni/"+abi+"/"+libName {
					dst := filepath.Join(workDir, "opencv-jni", abi, libName)
					if err := extractZipEntry(f, dst); err != nil {
						return err
					}
					soFiles["lib/"+abi+"/"+libName] = dst
				}
			}
		}
	}
	if !gotJar {
		return fmt.Errorf("classes.jar missing from %s", aarPath)
	}
	for abi := range wantABIs {
		if soFiles["lib/"+abi+"/libopencv_java4.so"] == "" {
			return fmt.Errorf("libopencv_java4.so for %s missing from %s", abi, aarPath)
		}
	}
	return nil
}

func extractZipEntry(f *zip.File, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	rc, err := f.Open()
	if err != nil {
		return err
	}
	defer rc.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, rc)
	return err
}

func assembleAPK(baseAPK string, dexDir string, soFiles map[string]string, dstAPK string) error {
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

	dexEntries, err := os.ReadDir(dexDir)
	if err != nil {
		_ = zw.Close()
		return err
	}
	var dexNames []string
	for _, e := range dexEntries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".dex") {
			dexNames = append(dexNames, e.Name())
		}
	}
	sort.Strings(dexNames)
	if len(dexNames) == 0 {
		_ = zw.Close()
		return fmt.Errorf("no .dex files found in %s", dexDir)
	}
	for _, name := range dexNames {
		if err := addFileToZip(zw, name, filepath.Join(dexDir, name), zip.Deflate); err != nil {
			_ = zw.Close()
			return err
		}
	}

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
		runCmd(
			tc.env(nil),
			tc.keytool,
			"-genkeypair", "-v",
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

func verifyFileSHA256(p string, expectedHex string) error {
	f, err := os.Open(p)
	if err != nil {
		return err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return err
	}
	got := hex.EncodeToString(h.Sum(nil))
	if !strings.EqualFold(got, expectedHex) {
		return fmt.Errorf("%s sha256 = %s, want %s", p, got, expectedHex)
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
	return "0.1.0"
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
		log.Fatalf("[build-gatecam] command failed (%s %s): %v", filepath.Base(bin), strings.Join(args, " "), err)
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
