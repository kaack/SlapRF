//go:build android

package main

/*
#include "jni_bridge.h"
#include <stdlib.h>
*/
import "C"

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unsafe"

	"slaprf/internal/applog"
	"slaprf/internal/gatecam"
)

//go:embed all:site
var embeddedSite embed.FS

var (
	srvMu       sync.Mutex
	activeSrv   *gatecam.Server
	loopbackLn  net.Listener
	loopbackSrv *http.Server
	loopbackURL string

	lanLn      net.Listener
	lanHttpSrv *http.Server
	lanPort    int
)

type jniCameraProvider struct{}

func (jniCameraProvider) CurrentSensorClockNs() int64 {
	v := int64(C.gatecam_current_sensor_clock_ns())
	if v > 0 {
		return v
	}
	return time.Now().UnixNano()
}

func (jniCameraProvider) Status() gatecam.CameraStatus {
	cs := C.gatecam_status_json()
	if cs == nil {
		return gatecam.CameraStatus{LastError: "JNI camera shim unavailable"}
	}
	defer C.free(unsafe.Pointer(cs))
	var st gatecam.CameraStatus
	_ = json.Unmarshal([]byte(C.GoString(cs)), &st)
	return st
}

func (jniCameraProvider) Configure(cfg gatecam.CameraConfig) (gatecam.CameraStatus, error) {
	b, _ := json.Marshal(cfg)
	cArg := C.CString(string(b))
	defer C.free(unsafe.Pointer(cArg))
	cs := C.gatecam_configure_json(cArg)
	if cs == nil {
		return gatecam.CameraStatus{}, errors.New("JNI configureJson returned null")
	}
	defer C.free(unsafe.Pointer(cs))
	var st gatecam.CameraStatus
	if err := json.Unmarshal([]byte(C.GoString(cs)), &st); err != nil {
		return gatecam.CameraStatus{}, err
	}
	return st, nil
}

func (jniCameraProvider) TriggerFocusLock(normX, normY float64) error {
	cs := C.gatecam_trigger_focus_lock(C.double(normX), C.double(normY))
	if cs == nil {
		return nil
	}
	defer C.free(unsafe.Pointer(cs))
	errTxt := strings.TrimSpace(C.GoString(cs))
	if errTxt != "" {
		return errors.New(errTxt)
	}
	return nil
}

func (jniCameraProvider) LatestPreviewJPEG() ([]byte, int64, error) {
	var n C.int
	ptr := C.gatecam_latest_preview_jpeg(&n)
	if ptr == nil || n <= 0 {
		return nil, 0, errors.New("no preview frame buffered yet")
	}
	defer C.free(unsafe.Pointer(ptr))
	out := C.GoBytes(unsafe.Pointer(ptr), n)
	return out, int64(C.gatecam_current_sensor_clock_ns()), nil
}

func (jniCameraProvider) ExtractAndAnalyzeBurst(req gatecam.LookbackRequest) ([]gatecam.FrameObservation, error) {
	b, _ := json.Marshal(req)
	cArg := C.CString(string(b))
	defer C.free(unsafe.Pointer(cArg))

	cs := C.gatecam_extract_and_analyze_json(cArg)
	if cs == nil {
		return nil, errors.New("JNI extractAndAnalyzeJson returned null")
	}
	defer C.free(unsafe.Pointer(cs))

	var resp struct {
		BurstID int                        `json:"burstId"`
		Error   string                     `json:"error,omitempty"`
		Frames  []gatecam.FrameObservation `json:"frames"`
	}
	if err := json.Unmarshal([]byte(C.GoString(cs)), &resp); err != nil {
		return nil, err
	}
	if resp.BurstID > 0 {
		defer C.gatecam_release_burst(C.int(resp.BurstID))
	}
	if resp.Error != "" && len(resp.Frames) == 0 {
		return nil, errors.New(resp.Error)
	}

	for i := range resp.Frames {
		var jpgLen C.int
		if jpgPtr := C.gatecam_get_burst_jpeg(C.int(resp.BurstID), C.int(i), 0, &jpgLen); jpgPtr != nil && jpgLen > 0 {
			resp.Frames[i].JPEG = C.GoBytes(unsafe.Pointer(jpgPtr), jpgLen)
			C.free(unsafe.Pointer(jpgPtr))
		}
		var maskLen C.int
		if maskPtr := C.gatecam_get_burst_jpeg(C.int(resp.BurstID), C.int(i), 1, &maskLen); maskPtr != nil && maskLen > 0 {
			resp.Frames[i].MaskJPEG = C.GoBytes(unsafe.Pointer(maskPtr), maskLen)
			C.free(unsafe.Pointer(maskPtr))
		}
	}
	return resp.Frames, nil
}

func goStr(env *C.JNIEnv, js C.jstring) string {
	c := C.gatecam_jstr_get(env, js)
	if c == nil {
		return ""
	}
	defer C.gatecam_jstr_rel(env, js, c)
	return C.GoString(c)
}

func jStr(env *C.JNIEnv, s string) C.jstring {
	cs := C.CString(s)
	defer C.free(unsafe.Pointer(cs))
	return C.gatecam_jstr_new(env, cs)
}

func startLanLocked(handler http.Handler) ([]string, error) {
	if lanLn != nil {
		return gatecam.LocalIPv4URLs(lanPort), nil
	}
	var ln net.Listener
	var err error
	for _, cand := range []string{"0.0.0.0:18095", "0.0.0.0:18096", "0.0.0.0:0"} {
		ln, err = net.Listen("tcp4", cand)
		if err == nil {
			break
		}
	}
	if err != nil {
		return nil, err
	}
	_, pStr, _ := net.SplitHostPort(ln.Addr().String())
	p, _ := strconv.Atoi(pStr)
	lanLn = ln
	lanPort = p
	hSrv := &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second}
	lanHttpSrv = hSrv
	go func() { _ = hSrv.Serve(ln) }()
	return gatecam.LocalIPv4URLs(lanPort), nil
}

func stopLanLocked() {
	if lanHttpSrv != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 1200*time.Millisecond)
		_ = lanHttpSrv.Shutdown(ctx)
		cancel()
		lanHttpSrv = nil
	}
	if lanLn != nil {
		_ = lanLn.Close()
		lanLn = nil
	}
	lanPort = 0
}

//export Java_app_slaprf_gatecam_GateCamHost_nativeStartServer
func Java_app_slaprf_gatecam_GateCamHost_nativeStartServer(env *C.JNIEnv, clazz C.jclass, jFilesDir C.jstring, jVersion C.jstring) C.jstring {
	_ = clazz
	filesDir := strings.TrimSpace(goStr(env, jFilesDir))
	ver := strings.TrimSpace(goStr(env, jVersion))
	if ver == "" {
		ver = "dev"
	}

	srvMu.Lock()
	defer srvMu.Unlock()

	if activeSrv != nil && loopbackURL != "" {
		return jStr(env, loopbackURL)
	}

	siteFS, err := fs.Sub(embeddedSite, "site")
	if err != nil {
		return jStr(env, "")
	}
	if filesDir != "" {
		_ = os.MkdirAll(filesDir, 0o755)
	}

	var ln net.Listener
	for _, cand := range []string{"127.0.0.1:18094", "127.0.0.1:0"} {
		ln, err = net.Listen("tcp4", cand)
		if err == nil {
			break
		}
	}
	if err != nil {
		return jStr(env, "")
	}

	logPath := ""
	if filesDir != "" {
		logPath = filepath.Join(filesDir, "gatecam.log")
	}
	appLogger := applog.New(applog.Options{FilePath: logPath, Level: applog.LevelInfo, HasLevel: true})

	var gcSrv *gatecam.Server
	gcSrv = gatecam.NewServer(gatecam.Config{
		Version:     ver,
		DataDir:     filesDir,
		StaticFS:    siteFS,
		DefaultLink: "http://127.0.0.1:18090",
		Camera:      jniCameraProvider{},
		AppLog:      appLogger,
		OnLanChanged: func(expose bool) ([]string, error) {
			srvMu.Lock()
			defer srvMu.Unlock()
			if expose {
				return startLanLocked(gcSrv.Handler())
			}
			stopLanLocked()
			return nil, nil
		},
	})
	handler := gcSrv.Handler()

	hSrv := &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = hSrv.Serve(ln) }()

	activeSrv = gcSrv
	loopbackLn = ln
	loopbackSrv = hSrv
	loopbackURL = "http://" + ln.Addr().String()

	// Remote LAN access is kept disabled by default while focusing on the on-phone app.
	stopLanLocked()
	gcSrv.SetLanURLs(nil)
	appLogger.Infof("[GateCam] Bound loopback %s", loopbackURL)
	return jStr(env, loopbackURL)
}

//export Java_app_slaprf_gatecam_GateCamHost_nativeStopServer
func Java_app_slaprf_gatecam_GateCamHost_nativeStopServer(env *C.JNIEnv, clazz C.jclass) {
	_, _ = env, clazz
	srvMu.Lock()
	defer srvMu.Unlock()
	stopLanLocked()
	if loopbackSrv != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 1200*time.Millisecond)
		_ = loopbackSrv.Shutdown(ctx)
		cancel()
		loopbackSrv = nil
	}
	if loopbackLn != nil {
		_ = loopbackLn.Close()
		loopbackLn = nil
	}
	if activeSrv != nil {
		activeSrv.Close()
		activeSrv = nil
	}
	loopbackURL = ""
}

func main() {}
