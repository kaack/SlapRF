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
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unsafe"

	"slaprf/internal/portable"
)

//go:embed all:site
var embeddedSite embed.FS

type lanStatusPayload struct {
	Enabled bool     `json:"enabled"`
	Port    int      `json:"port"`
	URLs    []string `json:"urls"`
	Error   string   `json:"error,omitempty"`
}

var (
	srvMu       sync.Mutex
	activeSrv   *portable.Server
	loopbackLn  net.Listener
	loopbackSrv *http.Server
	loopbackURL string

	lanLn      net.Listener
	lanHttpSrv *http.Server
	lanPort    int
	lanErrMsg  string
)

func goStringFromJString(env *C.JNIEnv, js C.jstring) string {
	cstr := C.slaprf_jstr_get(env, js)
	if cstr == nil {
		return ""
	}
	defer C.slaprf_jstr_rel(env, js, cstr)
	return C.GoString(cstr)
}

func jstringFromGoString(env *C.JNIEnv, s string) C.jstring {
	cs := C.CString(s)
	defer C.free(unsafe.Pointer(cs))
	return C.slaprf_jstr_new(env, cs)
}

func startLanLocked(handler http.Handler) {
	if lanLn != nil || handler == nil {
		return
	}
	lanErrMsg = ""
	var ln net.Listener
	var err error
	for _, candidate := range []string{"0.0.0.0:8090", "0.0.0.0:8091", "0.0.0.0:0"} {
		ln, err = net.Listen("tcp4", candidate)
		if err == nil {
			break
		}
	}
	if err != nil {
		lanErrMsg = err.Error()
		return
	}
	_, portStr, _ := net.SplitHostPort(ln.Addr().String())
	p, _ := strconv.Atoi(portStr)
	lanLn = ln
	lanPort = p
	srv := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}
	lanHttpSrv = srv
	go func() {
		_ = srv.Serve(ln)
	}()
}

func stopLanLocked() {
	if lanHttpSrv != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
		_ = lanHttpSrv.Shutdown(ctx)
		cancel()
		lanHttpSrv = nil
	}
	if lanLn != nil {
		_ = lanLn.Close()
		lanLn = nil
	}
	lanPort = 0
	lanErrMsg = ""
}

func buildLanStatusLocked() string {
	st := lanStatusPayload{
		Enabled: lanLn != nil,
		Port:    lanPort,
		URLs:    []string{},
		Error:   lanErrMsg,
	}
	if st.Enabled && st.Port > 0 {
		pStr := strconv.Itoa(st.Port)
		for _, ip := range portable.LanIPs() {
			st.URLs = append(st.URLs, "http://"+net.JoinHostPort(ip, pStr))
		}
	}
	b, _ := json.Marshal(st)
	return string(b)
}

//export Java_app_slaprf_SlapRFHost_nativeStartServer
func Java_app_slaprf_SlapRFHost_nativeStartServer(env *C.JNIEnv, clazz C.jclass, jFilesDir C.jstring, jVersion C.jstring, jLanEnabled C.jboolean) C.jstring {
	_ = clazz
	filesDir := strings.TrimSpace(goStringFromJString(env, jFilesDir))
	ver := strings.TrimSpace(goStringFromJString(env, jVersion))
	if ver == "" {
		ver = "android"
	}
	wantLan := jLanEnabled != C.JNI_FALSE

	srvMu.Lock()
	defer srvMu.Unlock()

	if activeSrv != nil && loopbackURL != "" {
		if wantLan && lanLn == nil {
			startLanLocked(activeSrv.Handler())
		} else if !wantLan && lanLn != nil {
			stopLanLocked()
		}
		return jstringFromGoString(env, loopbackURL)
	}

	siteFS, err := fs.Sub(embeddedSite, "site")
	if err != nil {
		return jstringFromGoString(env, "")
	}

	if filesDir != "" {
		_ = os.MkdirAll(filesDir, 0o755)
	}
	dbPath := ""
	if filesDir != "" {
		dbPath = filepath.Join(filesDir, "slaprf.db")
	}

	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return jstringFromGoString(env, "")
	}

	logger := log.New(os.Stdout, "[SlapRF-Android] ", log.LstdFlags)
	pSrv := portable.NewServer(portable.Config{
		Version:         ver,
		StaticFS:        siteFS,
		DBPath:          dbPath,
		AllowLANOrigins: true,
		Log:             logger,
		USBListPorts:    jniListPorts,
		USBOpenPort:     jniOpenPort,
	})
	handler := pSrv.Handler()

	hSrv := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		_ = hSrv.Serve(ln)
	}()

	activeSrv = pSrv
	loopbackLn = ln
	loopbackSrv = hSrv
	loopbackURL = "http://" + ln.Addr().String()

	if wantLan {
		startLanLocked(handler)
	}

	return jstringFromGoString(env, loopbackURL)
}

//export Java_app_slaprf_SlapRFHost_nativeStopServer
func Java_app_slaprf_SlapRFHost_nativeStopServer(env *C.JNIEnv, clazz C.jclass) {
	_, _ = env, clazz
	srvMu.Lock()
	defer srvMu.Unlock()

	stopLanLocked()
	if loopbackSrv != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
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

//export Java_app_slaprf_SlapRFHost_nativeSetLanEnabled
func Java_app_slaprf_SlapRFHost_nativeSetLanEnabled(env *C.JNIEnv, clazz C.jclass, jEnabled C.jboolean) C.jstring {
	_ = clazz
	want := jEnabled != C.JNI_FALSE
	srvMu.Lock()
	defer srvMu.Unlock()

	if activeSrv != nil {
		if want && lanLn == nil {
			startLanLocked(activeSrv.Handler())
		} else if !want && lanLn != nil {
			stopLanLocked()
		}
	}
	return jstringFromGoString(env, buildLanStatusLocked())
}

//export Java_app_slaprf_SlapRFHost_nativeGetLanStatusJson
func Java_app_slaprf_SlapRFHost_nativeGetLanStatusJson(env *C.JNIEnv, clazz C.jclass) C.jstring {
	_ = clazz
	srvMu.Lock()
	defer srvMu.Unlock()
	return jstringFromGoString(env, buildLanStatusLocked())
}

func main() {}
