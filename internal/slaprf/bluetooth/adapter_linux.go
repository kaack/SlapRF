//go:build linux && !android && !nobluetooth

package bluetooth

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

func isBLEDeviceKnown(adapterID, addrStr string) bool {
	if strings.TrimSpace(addrStr) == "" {
		return false
	}
	bus, err := dbus.SystemBus()
	if err != nil {
		return true
	}
	prop, err := bus.Object("org.bluez", bluezDeviceObjectPath(adapterID, addrStr)).
		GetProperty("org.bluez.Device1.Address")
	if err != nil {
		return false
	}
	s, ok := prop.Value().(string)
	return ok && s != ""
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
