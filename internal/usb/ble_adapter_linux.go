//go:build linux && !android && !nobluetooth

package usb

import (
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/godbus/dbus/v5"
	"tinygo.org/x/bluetooth"
)

type bluezAdapterCandidate struct {
	name    string
	powered bool
}

// selectBLEAdapter resolves the BlueZ adapter to use on Linux along with its adapter ID (e.g. "hci0").
// tinygo.org/x/bluetooth's DefaultAdapter hardcodes "hci0", which fails on hosts whose
// active controller enumerated as hci1+ (for example after USB BT re-enumeration or when
// an external dongle is active). Selection order:
//  1. SLAPRF_BLE_ADAPTER env var (e.g. "hci1") when explicitly set.
//  2. First powered org.bluez.Adapter1 reported by BlueZ over D-Bus (sorted hci0, hci1, ...).
//  3. First existing org.bluez.Adapter1 reported by BlueZ over D-Bus.
//  4. First hci* entry under /sys/class/bluetooth.
//  5. bluetooth.DefaultAdapter ("hci0").
func selectBLEAdapter() (*bluetooth.Adapter, string) {
	if env := strings.TrimSpace(os.Getenv("SLAPRF_BLE_ADAPTER")); env != "" {
		id := strings.TrimPrefix(env, "/org/bluez/")
		return bluetooth.NewAdapter(id), id
	}
	if name := pickBlueZAdapterName(listBlueZAdaptersDBus()); name != "" {
		return bluetooth.NewAdapter(name), name
	}
	if name := pickBlueZAdapterName(listBlueZAdaptersSysfs("/sys/class/bluetooth")); name != "" {
		return bluetooth.NewAdapter(name), name
	}
	return bluetooth.DefaultAdapter, "hci0"
}

// ensureBLEAdapterPowered powers on the selected BlueZ adapter over D-Bus when it starts in
// `Powered: false` (the default on fresh Raspberry Pi OS Lite installations). Standard BlueZ
// D-Bus policies allow unprivileged local users to set `org.bluez.Adapter1.Powered` without sudo.
func ensureBLEAdapterPowered(adapterID string) error {
	adapterID = strings.TrimSpace(strings.TrimPrefix(adapterID, "/org/bluez/"))
	if adapterID == "" {
		return nil
	}
	bus, err := dbus.SystemBus()
	if err != nil {
		return nil
	}
	obj := bus.Object("org.bluez", dbus.ObjectPath("/org/bluez/"+adapterID))
	prop, err := obj.GetProperty("org.bluez.Adapter1.Powered")
	if err != nil {
		// Let adapter.Enable() report missing-adapter errors with its standard formatting.
		return nil
	}
	if powered, ok := prop.Value().(bool); ok && powered {
		return nil
	}
	call := obj.Call("org.freedesktop.DBus.Properties.Set", 0, "org.bluez.Adapter1", "Powered", dbus.MakeVariant(true))
	if call.Err != nil {
		if dErr, ok := call.Err.(dbus.Error); ok && strings.Contains(strings.ToLower(dErr.Name+" "+dErr.Error()), "blocked") {
			return fmt.Errorf("Bluetooth adapter %s is blocked by rfkill (run: sudo rfkill unblock bluetooth)", adapterID)
		}
		return fmt.Errorf("could not power on Bluetooth adapter %s: %w", adapterID, call.Err)
	}
	deadline := time.Now().Add(1500 * time.Millisecond)
	for time.Now().Before(deadline) {
		if p, pErr := obj.GetProperty("org.bluez.Adapter1.Powered"); pErr == nil {
			if on, ok := p.Value().(bool); ok && on {
				// BlueZ 5.68+ exposes PowerState ("off-enabling" -> "on"); wait until fully "on"
				// so immediate SetDiscoveryFilter / StartDiscovery calls do not get NotReady.
				if ps, psErr := obj.GetProperty("org.bluez.Adapter1.PowerState"); psErr == nil {
					if stateStr, ok := ps.Value().(string); ok && stateStr != "" && stateStr != "on" {
						time.Sleep(25 * time.Millisecond)
						continue
					}
				}
				break
			}
		}
		time.Sleep(25 * time.Millisecond)
	}
	time.Sleep(200 * time.Millisecond)
	return nil
}

// ensureBLEDiscoveryStopped clears any lingering org.bluez.Adapter1 discovery session owned by
// this process's D-Bus connection. tinygo.org/x/bluetooth calls StartDiscovery asynchronously
// (`adapter.Go`), so stopping a scan shortly after it starts can race: Scan's StopDiscovery runs
// before StartDiscovery completes on bluetoothd, leaving Discovering=true permanently and causing
// subsequent Connect calls to fail with `le-connection-abort-by-local`.
func ensureBLEDiscoveryStopped(adapterID string) bool {
	adapterID = strings.TrimSpace(strings.TrimPrefix(adapterID, "/org/bluez/"))
	if adapterID == "" {
		return false
	}
	bus, err := dbus.SystemBus()
	if err != nil {
		return false
	}
	obj := bus.Object("org.bluez", dbus.ObjectPath("/org/bluez/"+adapterID))
	stoppedAny := false
	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		prop, pErr := obj.GetProperty("org.bluez.Adapter1.Discovering")
		if pErr != nil {
			break
		}
		disc, _ := prop.Value().(bool)
		if !disc {
			return stoppedAny
		}
		call := obj.Call("org.bluez.Adapter1.StopDiscovery", 0)
		if call.Err == nil {
			stoppedAny = true
		} else if dErr, ok := call.Err.(dbus.Error); ok {
			if strings.Contains(dErr.Name, "NotReady") || strings.Contains(dErr.Name, "NotAuthorized") {
				break
			}
		}
		time.Sleep(40 * time.Millisecond)
	}
	return stoppedAny
}

func bluezDeviceObjectPath(adapterID, addrStr string) dbus.ObjectPath {
	adapterID = strings.TrimSpace(strings.TrimPrefix(adapterID, "/org/bluez/"))
	if adapterID == "" {
		adapterID = "hci0"
	}
	devPart := strings.ReplaceAll(strings.ToUpper(strings.TrimSpace(addrStr)), ":", "_")
	return dbus.ObjectPath("/org/bluez/" + adapterID + "/dev_" + devPart)
}

func isBLEDeviceStillConnected(adapterID, addrStr string) bool {
	if strings.TrimSpace(addrStr) == "" {
		return true
	}
	bus, err := dbus.SystemBus()
	if err != nil {
		return true
	}
	prop, err := bus.Object("org.bluez", bluezDeviceObjectPath(adapterID, addrStr)).
		GetProperty("org.bluez.Device1.Connected")
	if err != nil {
		return false
	}
	conn, ok := prop.Value().(bool)
	return ok && conn
}

func cancelBLEPendingConnect(adapterID, addrStr string) {
	if strings.TrimSpace(addrStr) == "" {
		return
	}
	bus, err := dbus.SystemBus()
	if err != nil {
		return
	}
	_ = bus.Object("org.bluez", bluezDeviceObjectPath(adapterID, addrStr)).
		Call("org.bluez.Device1.Disconnect", 0).Err
}

// watchBLEDeviceDisconnect monitors org.bluez.Device1.Connected on Linux because
// tinygo.org/x/bluetooth only hooks D-Bus connection state signals in peripheral mode.
func watchBLEDeviceDisconnect(adapterID, addrStr string, stop <-chan struct{}, onLost func(error)) {
	if strings.TrimSpace(addrStr) == "" || onLost == nil {
		return
	}
	go func() {
		ticker := time.NewTicker(750 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				if !isBLEDeviceStillConnected(adapterID, addrStr) {
					onLost(fmt.Errorf("Bluetooth hub disconnected"))
					return
				}
			}
		}
	}()
}

func listBlueZAdaptersDBus() []bluezAdapterCandidate {
	bus, err := dbus.SystemBus()
	if err != nil {
		return nil
	}
	var objects map[dbus.ObjectPath]map[string]map[string]dbus.Variant
	if err := bus.Object("org.bluez", dbus.ObjectPath("/")).
		Call("org.freedesktop.DBus.ObjectManager.GetManagedObjects", 0).
		Store(&objects); err != nil {
		return nil
	}
	var out []bluezAdapterCandidate
	for path, ifaces := range objects {
		props, ok := ifaces["org.bluez.Adapter1"]
		if !ok {
			continue
		}
		name := strings.TrimPrefix(string(path), "/org/bluez/")
		if name == "" || strings.Contains(name, "/") {
			continue
		}
		powered, _ := props["Powered"].Value().(bool)
		out = append(out, bluezAdapterCandidate{name: name, powered: powered})
	}
	return out
}

func listBlueZAdaptersSysfs(dir string) []bluezAdapterCandidate {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []bluezAdapterCandidate
	for _, e := range entries {
		name := e.Name()
		if strings.HasPrefix(name, "hci") {
			out = append(out, bluezAdapterCandidate{name: name})
		}
	}
	return out
}

func pickBlueZAdapterName(candidates []bluezAdapterCandidate) string {
	if len(candidates) == 0 {
		return ""
	}
	sorted := append([]bluezAdapterCandidate(nil), candidates...)
	sort.Slice(sorted, func(i, j int) bool {
		return compareHCIAdapterName(sorted[i].name, sorted[j].name)
	})
	for _, c := range sorted {
		if c.powered {
			return c.name
		}
	}
	return sorted[0].name
}

func compareHCIAdapterName(a, b string) bool {
	na, oka := parseHCIIndex(a)
	nb, okb := parseHCIIndex(b)
	if oka && okb && na != nb {
		return na < nb
	}
	return a < b
}

func parseHCIIndex(name string) (int, bool) {
	if !strings.HasPrefix(name, "hci") {
		return 0, false
	}
	n, err := strconv.Atoi(name[3:])
	if err != nil || n < 0 {
		return 0, false
	}
	return n, true
}
