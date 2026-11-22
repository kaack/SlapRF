//go:build linux && !android && !nobluetooth

package bluetooth

import (
	"errors"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/godbus/dbus/v5"
	"golang.org/x/sys/unix"
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

// acquireBLENotifySocket uses BlueZ's org.bluez.GattCharacteristic1.AcquireNotify to obtain a
// direct kernel SOCK_SEQPACKET file descriptor for GATT notifications, bypassing D-Bus
// PropertiesChanged("Value") coalescing and godbus unbuffered-channel goroutine reordering.
func acquireBLENotifySocket(adapterID, addrStr, charUUID string, stop <-chan struct{}, onData func([]byte)) (func(), bool) {
	if strings.TrimSpace(addrStr) == "" || strings.TrimSpace(charUUID) == "" || onData == nil {
		return nil, false
	}
	bus, err := dbus.SystemBus()
	if err != nil {
		return nil, false
	}
	devPrefix := string(bluezDeviceObjectPath(adapterID, addrStr)) + "/service"
	var objects map[dbus.ObjectPath]map[string]map[string]dbus.Variant
	if err := bus.Object("org.bluez", dbus.ObjectPath("/")).
		Call("org.freedesktop.DBus.ObjectManager.GetManagedObjects", 0).
		Store(&objects); err != nil {
		return nil, false
	}
	var charPath dbus.ObjectPath
	for path, ifaces := range objects {
		if !strings.HasPrefix(string(path), devPrefix) {
			continue
		}
		props, ok := ifaces["org.bluez.GattCharacteristic1"]
		if !ok {
			continue
		}
		u, _ := props["UUID"].Value().(string)
		if strings.EqualFold(strings.TrimSpace(u), strings.TrimSpace(charUUID)) {
			charPath = path
			break
		}
	}
	if charPath == "" {
		return nil, false
	}

	var unixFD dbus.UnixFD
	var mtu uint16
	opts := map[string]dbus.Variant{}
	charObj := bus.Object("org.bluez", charPath)
	_ = charObj.Call("org.bluez.GattCharacteristic1.StopNotify", 0).Err
	if err := charObj.
		Call("org.bluez.GattCharacteristic1.AcquireNotify", 0, opts).
		Store(&unixFD, &mtu); err != nil {
		return nil, false
	}
	fd := int(unixFD)
	if fd < 0 {
		return nil, false
	}
	_ = unix.SetNonblock(fd, true)

	var pipeFds [2]int
	if err := unix.Pipe2(pipeFds[:], unix.O_NONBLOCK|unix.O_CLOEXEC); err != nil {
		_ = unix.Close(fd)
		return nil, false
	}
	wakeR, wakeW := pipeFds[0], pipeFds[1]

	var closeOnce sync.Once
	closedCh := make(chan struct{})
	closeFn := func() {
		closeOnce.Do(func() {
			close(closedCh)
			_, _ = unix.Write(wakeW, []byte{1})
			_ = unix.Close(fd)
			_ = unix.Close(wakeR)
			_ = unix.Close(wakeW)
		})
	}

	go func() {
		select {
		case <-stop:
			closeFn()
		case <-closedCh:
		}
	}()

	go func() {
		defer closeFn()
		buf := make([]byte, 2048)
		pollFds := []unix.PollFd{
			{Fd: int32(fd), Events: unix.POLLIN},
			{Fd: int32(wakeR), Events: unix.POLLIN},
		}
		for {
			select {
			case <-closedCh:
				return
			default:
			}
			pollFds[0].Revents = 0
			pollFds[1].Revents = 0
			nReady, pErr := unix.Poll(pollFds, -1)
			if errors.Is(pErr, unix.EINTR) {
				continue
			}
			if pErr != nil || pollFds[1].Revents != 0 {
				return
			}
			if nReady == 0 {
				continue
			}
			for {
				n, rErr := unix.Read(fd, buf)
				if n > 0 {
					chunk := make([]byte, n)
					copy(chunk, buf[:n])
					onData(chunk)
				}
				if errors.Is(rErr, unix.EINTR) {
					continue
				}
				if errors.Is(rErr, unix.EAGAIN) || errors.Is(rErr, unix.EWOULDBLOCK) {
					break
				}
				if rErr != nil || n == 0 {
					return
				}
			}
		}
	}()

	return closeFn, true
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
