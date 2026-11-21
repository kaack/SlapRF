//go:build linux && !android && !nobluetooth

package usb

import (
	"os"
	"sort"
	"strconv"
	"strings"

	"github.com/godbus/dbus/v5"
	"tinygo.org/x/bluetooth"
)

type bluezAdapterCandidate struct {
	name    string
	powered bool
}

// selectBLEAdapter resolves the BlueZ adapter to use on Linux.
// tinygo.org/x/bluetooth's DefaultAdapter hardcodes "hci0", which fails on hosts whose
// active controller enumerated as hci1+ (for example after USB BT re-enumeration or when
// an external dongle is active). Selection order:
//  1. SLAPRF_BLE_ADAPTER env var (e.g. "hci1") when explicitly set.
//  2. First powered org.bluez.Adapter1 reported by BlueZ over D-Bus (sorted hci0, hci1, ...).
//  3. First existing org.bluez.Adapter1 reported by BlueZ over D-Bus.
//  4. First hci* entry under /sys/class/bluetooth.
//  5. bluetooth.DefaultAdapter ("hci0").
func selectBLEAdapter() *bluetooth.Adapter {
	if env := strings.TrimSpace(os.Getenv("SLAPRF_BLE_ADAPTER")); env != "" {
		return bluetooth.NewAdapter(strings.TrimPrefix(env, "/org/bluez/"))
	}
	if name := pickBlueZAdapterName(listBlueZAdaptersDBus()); name != "" {
		return bluetooth.NewAdapter(name)
	}
	if name := pickBlueZAdapterName(listBlueZAdaptersSysfs("/sys/class/bluetooth")); name != "" {
		return bluetooth.NewAdapter(name)
	}
	return bluetooth.DefaultAdapter
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
