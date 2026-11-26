//go:build ios

package main

/*
#include "cbridge.h"
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
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"time"
	"unsafe"

	"slaprf/internal/applog"
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

func init() {
	// Keep Go heap footprint tidy inside iOS background jetsam limits.
	debug.SetMemoryLimit(256 << 20)
}

func goStr(cs *C.char) string {
	if cs == nil {
		return ""
	}
	return C.GoString(cs)
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

//export SlapRFStartServer
func SlapRFStartServer(cFilesDir *C.char, cVersion *C.char, cLanEnabled C.int) *C.char {
	filesDir := strings.TrimSpace(goStr(cFilesDir))
	ver := strings.TrimSpace(goStr(cVersion))
	if ver == "" {
		ver = "ios"
	}
	wantLan := cLanEnabled != 0

	srvMu.Lock()
	defer srvMu.Unlock()

	if activeSrv != nil && loopbackURL != "" {
		if wantLan && lanLn == nil {
			startLanLocked(activeSrv.Handler())
		} else if !wantLan && lanLn != nil {
			stopLanLocked()
		}
		return C.CString(loopbackURL)
	}

	siteFS, err := fs.Sub(embeddedSite, "site")
	if err != nil {
		return C.CString("")
	}

	if filesDir != "" {
		_ = os.MkdirAll(filesDir, 0o755)
	}
	dbPath := ""
	logPath := ""
	if filesDir != "" {
		dbPath = filepath.Join(filesDir, "slaprf.db")
		logPath = filepath.Join(filesDir, applog.DefaultLogFileName)
	}

	var ln net.Listener
	for _, candidate := range []string{"127.0.0.1:18090", "127.0.0.1:18091", "127.0.0.1:0"} {
		ln, err = net.Listen("tcp4", candidate)
		if err == nil {
			break
		}
	}
	if err != nil {
		return C.CString("")
	}

	pSrv := portable.NewServer(portable.Config{
		Version:         ver,
		StaticFS:        siteFS,
		DBPath:          dbPath,
		DisableTeacher:  true,
		DisableUSB:      true,
		LogPath:         logPath,
		AllowLANOrigins: true,
		BLEListPorts:    iosListBLEPorts,
		BLEOpenPort:     iosOpenBLEPort,
	})
	log.SetFlags(0)
	log.SetOutput(pSrv.AppLog().StdLogger().Writer())
	handler := pSrv.Handler()

	hSrv := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ErrorLog:          pSrv.AppLog().StdLogger(),
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
	pSrv.AppLog().Infof("[iOS] Bound loopback server %s (lan=%v lanPort=%d)", loopbackURL, lanLn != nil, lanPort)

	return C.CString(loopbackURL)
}

//export SlapRFStopServer
func SlapRFStopServer() {
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

//export SlapRFSetLanEnabled
func SlapRFSetLanEnabled(cEnabled C.int) *C.char {
	want := cEnabled != 0
	srvMu.Lock()
	defer srvMu.Unlock()

	if activeSrv != nil {
		if want && lanLn == nil {
			startLanLocked(activeSrv.Handler())
		} else if !want && lanLn != nil {
			stopLanLocked()
		}
	}
	return C.CString(buildLanStatusLocked())
}

//export SlapRFGetLanStatusJson
func SlapRFGetLanStatusJson() *C.char {
	srvMu.Lock()
	defer srvMu.Unlock()
	return C.CString(buildLanStatusLocked())
}

//export SlapRFFreeString
func SlapRFFreeString(p *C.char) {
	if p != nil {
		C.free(unsafe.Pointer(p))
	}
}

func main() {}
