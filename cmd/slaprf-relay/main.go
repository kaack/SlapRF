// Command slaprf-relay lets MultiGP LiveTime talk to the SlapRF web app (https://slaprf.app).
//
// Browsers cannot accept TCP connections, so this tiny program does it for them:
//
//	LiveTime --TCP :5403--> slaprf-relay --WebSocket 127.0.0.1:5404--> SlapRF tab (WASM LapRF emulator)
//
// The relay only copies bytes; the ImmersionRC LapRF protocol is implemented entirely inside
// the browser (internal/laprf compiled to WebAssembly). Run it on the computer that has the
// SlapRF tab open; LiveTime can run on the same computer or on another one on the LAN.
//
// Wire format on the WebSocket:
//   - BINARY messages: raw LapRF bytes, unmodified, in both directions.
//   - TEXT messages (relay -> browser only), JSON:
//     {"t":"hello","version":"v1.2.3"}                            on connect
//     {"t":"livetime","state":"connected","peer":"ip:port"}       LiveTime connected
//     {"t":"livetime","state":"disconnected"}                     LiveTime gone
//     The current LiveTime state is sent right after hello.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"strings"
	"syscall"
)

// version is set at release build time with -ldflags "-X main.version=vX.Y.Z".
var version = "dev"

type listFlag []string

func (l *listFlag) String() string { return strings.Join(*l, ",") }
func (l *listFlag) Set(v string) error {
	for _, part := range strings.Split(v, ",") {
		if part = strings.TrimSpace(part); part != "" {
			*l = append(*l, part)
		}
	}
	return nil
}

func main() {
	liveTimeAddr := flag.String("livetime-addr", ":5403", "TCP address LiveTime connects to (LapRF port; all interfaces by default so LiveTime may run on another PC)")
	wsAddr := flag.String("ws-addr", "127.0.0.1:5404", "WebSocket address for the SlapRF browser tab (keep it on loopback)")
	var extraOrigins listFlag
	flag.Var(&extraOrigins, "allow-origin", "extra browser origin allowed to connect, e.g. https://timing.example.org or http://192.168.1.20:* (repeatable or comma-separated)")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Println("slaprf-relay", version)
		return
	}

	logger := log.New(os.Stdout, "", log.Ltime)
	logger.Printf("slaprf-relay %s", version)

	ltLn, err := net.Listen("tcp", *liveTimeAddr)
	if err != nil {
		logger.Fatalf("Cannot listen for LiveTime on %s: %v (is another relay or LapRF tool already running?)", *liveTimeAddr, err)
	}
	wsLn, err := net.Listen("tcp", *wsAddr)
	if err != nil {
		logger.Fatalf("Cannot listen for the browser on %s: %v", *wsAddr, err)
	}

	logger.Printf("Waiting for LiveTime on TCP %s (add an ImmersionRC LapRF device at this computer's IP, port %s)", ltLn.Addr(), portOf(ltLn.Addr()))
	for _, ip := range lanIPs() {
		logger.Printf("  this computer's LAN address: %s", ip)
	}
	logger.Printf("Waiting for the SlapRF tab on ws://%s/ (open https://slaprf.app, Settings -> MultiGP LiveTime -> enable)", wsLn.Addr())
	logger.Printf("Press Ctrl+C to stop.")

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	r := &Relay{Version: version, Origins: NewOriginPolicy(extraOrigins), Log: logger}
	if err := r.Serve(ctx, ltLn, wsLn); err != nil {
		logger.Fatalf("Relay stopped: %v", err)
	}
	logger.Printf("Relay stopped.")
}

func portOf(a net.Addr) string {
	if ta, ok := a.(*net.TCPAddr); ok {
		return fmt.Sprint(ta.Port)
	}
	_, p, _ := net.SplitHostPort(a.String())
	return p
}

// lanIPs lists this machine's non-loopback IPv4 addresses (to type into LiveTime).
func lanIPs() []string {
	var out []string
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return nil
	}
	for _, a := range addrs {
		if ipn, ok := a.(*net.IPNet); ok && !ipn.IP.IsLoopback() && !ipn.IP.IsLinkLocalUnicast() {
			if v4 := ipn.IP.To4(); v4 != nil {
				out = append(out, v4.String())
			}
		}
	}
	return out
}
