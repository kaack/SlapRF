//go:build android

package main

/*
#include "jni_bridge.h"
#include <stdlib.h>
*/
import "C"

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"slaprf/internal/firmware"
	"slaprf/internal/usb"
)

const jniBufSize = 4096

// jniListPorts lists Android USB serial ports (unchanged) followed by any SlapRF Bluetooth hubs
// discovered by SlapRFBleShim (le:<FP>). Bluetooth errors never hide USB ports.
func jniListPorts() ([]usb.PortInfo, error) {
	ports, err := jniListUSBPorts()
	if usb.BLEScanEnabled() {
		if ble, bleErr := jniListBLEPorts(); bleErr == nil && len(ble) > 0 {
			ports = append(ports, ble...)
			err = nil
		}
	}
	return ports, err
}

func jniListBLEPorts() ([]usb.PortInfo, error) {
	if C.slaprf_ble_available() == 0 {
		return nil, nil
	}
	cjson := C.slaprf_ble_list_ports_json()
	if cjson == nil {
		return nil, nil
	}
	defer C.free(unsafe.Pointer(cjson))
	raw := strings.TrimSpace(C.GoString(cjson))
	if raw == "" {
		return nil, nil
	}
	var ports []usb.PortInfo
	if err := json.Unmarshal([]byte(raw), &ports); err != nil {
		return nil, fmt.Errorf("parse Android Bluetooth port list: %w", err)
	}
	return ports, nil
}

func jniListUSBPorts() ([]usb.PortInfo, error) {
	cjson := C.slaprf_usb_list_ports_json()
	if cjson == nil {
		return nil, nil
	}
	defer C.free(unsafe.Pointer(cjson))
	raw := C.GoString(cjson)
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	var ports []usb.PortInfo
	if err := json.Unmarshal([]byte(raw), &ports); err != nil {
		return nil, fmt.Errorf("parse Android USB port list: %w", err)
	}
	return ports, nil
}

func jniOpenPort(portName string, baud int) (firmware.SerialPort, error) {
	portName = strings.TrimSpace(portName)
	if portName == "" {
		return nil, errors.New("missing USB serial port name")
	}
	if baud <= 0 {
		baud = 115200
	}
	isBLE := usb.IsBLEPortName(portName)

	rxBufRef := C.slaprf_jni_alloc_buf(jniBufSize)
	if rxBufRef == 0 {
		return nil, errors.New("failed to allocate JNI RX byte buffer")
	}
	txBufRef := C.slaprf_jni_alloc_buf(jniBufSize)
	if txBufRef == 0 {
		C.slaprf_jni_free_buf(rxBufRef)
		return nil, errors.New("failed to allocate JNI TX byte buffer")
	}

	cname := C.CString(portName)
	defer C.free(unsafe.Pointer(cname))
	var cerr *C.char
	var handle int
	if isBLE {
		handle = int(C.slaprf_ble_open_port(cname, C.int(baud), &cerr))
	} else {
		handle = int(C.slaprf_usb_open_port(cname, C.int(baud), &cerr))
	}
	if cerr != nil {
		defer C.free(unsafe.Pointer(cerr))
	}
	if handle <= 0 {
		C.slaprf_jni_free_buf(rxBufRef)
		C.slaprf_jni_free_buf(txBufRef)
		msg := "failed to open Android USB device"
		if isBLE {
			msg = "failed to open Android Bluetooth hub"
		}
		if cerr != nil {
			if s := strings.TrimSpace(C.GoString(cerr)); s != "" {
				msg = s
			}
		}
		return nil, errors.New(msg)
	}

	p := &jniSerialPort{
		ble:      isBLE,
		handle:   handle,
		rxBufRef: rxBufRef,
		txBufRef: txBufRef,
	}
	p.timeoutMs.Store(120)
	return p, nil
}

type jniSerialPort struct {
	// ble routes I/O to SlapRFBleShim (le:<FP> ports) instead of SlapRFUsbShim.
	ble       bool
	handle    int
	rxBufRef  C.uintptr_t
	txBufRef  C.uintptr_t
	timeoutMs atomic.Int32

	lineMu sync.Mutex
	dtr    bool
	rts    bool

	ioMu      sync.RWMutex
	closed    atomic.Bool
	closeOnce sync.Once
}

func (p *jniSerialPort) Read(b []byte) (int, error) {
	if len(b) == 0 {
		return 0, nil
	}
	if p.closed.Load() {
		return 0, io.EOF
	}
	p.ioMu.RLock()
	defer p.ioMu.RUnlock()
	if p.closed.Load() {
		return 0, io.EOF
	}

	maxLen := len(b)
	if maxLen > jniBufSize {
		maxLen = jniBufSize
	}
	tmo := int(p.timeoutMs.Load())
	if tmo <= 0 {
		tmo = 120
	}
	var n int
	if p.ble {
		n = int(C.slaprf_ble_read_port(C.int(p.handle), p.rxBufRef, unsafe.Pointer(&b[0]), C.int(maxLen), C.int(tmo)))
	} else {
		n = int(C.slaprf_usb_read_port(
			C.int(p.handle),
			p.rxBufRef,
			unsafe.Pointer(&b[0]),
			C.int(maxLen),
			C.int(tmo),
		))
	}
	if n > 0 {
		return n, nil
	}
	if n == 0 {
		// Timeout expired cleanly with 0 bytes available.
		return 0, nil
	}
	return 0, io.EOF
}

func (p *jniSerialPort) Write(b []byte) (int, error) {
	if len(b) == 0 {
		return 0, nil
	}
	if p.closed.Load() {
		return 0, io.ErrClosedPipe
	}
	p.ioMu.RLock()
	defer p.ioMu.RUnlock()
	if p.closed.Load() {
		return 0, io.ErrClosedPipe
	}

	total := 0
	for total < len(b) {
		chunk := b[total:]
		if len(chunk) > jniBufSize {
			chunk = chunk[:jniBufSize]
		}
		var w int
		if p.ble {
			w = int(C.slaprf_ble_write_port(C.int(p.handle), p.txBufRef, unsafe.Pointer(&chunk[0]), C.int(len(chunk))))
		} else {
			w = int(C.slaprf_usb_write_port(
				C.int(p.handle),
				p.txBufRef,
				unsafe.Pointer(&chunk[0]),
				C.int(len(chunk)),
			))
		}
		if w <= 0 {
			if p.ble {
				return total, errors.New("Android Bluetooth write failed")
			}
			return total, errors.New("Android USB serial write failed")
		}
		total += w
	}
	return total, nil
}

func (p *jniSerialPort) SetDTR(v bool) error {
	p.lineMu.Lock()
	p.dtr = v
	dtr, rts := p.dtr, p.rts
	p.lineMu.Unlock()
	return p.applyLines(dtr, rts)
}

func (p *jniSerialPort) SetRTS(v bool) error {
	p.lineMu.Lock()
	p.rts = v
	dtr, rts := p.dtr, p.rts
	p.lineMu.Unlock()
	return p.applyLines(dtr, rts)
}

// SetDTRRTS implements firmware.AtomicDTRRTSSetter so XIAO ESP32-C5 receives both bits in one control packet.
func (p *jniSerialPort) SetDTRRTS(dtr, rts bool) error {
	p.lineMu.Lock()
	p.dtr = dtr
	p.rts = rts
	p.lineMu.Unlock()
	return p.applyLines(dtr, rts)
}

func (p *jniSerialPort) applyLines(dtr, rts bool) error {
	if p.closed.Load() {
		return io.ErrClosedPipe
	}
	if p.ble {
		// Bluetooth links have no modem control lines.
		return nil
	}
	dInt, rInt := 0, 0
	if dtr {
		dInt = 1
	}
	if rts {
		rInt = 1
	}
	rc := int(C.slaprf_usb_set_dtr_rts(C.int(p.handle), C.int(dInt), C.int(rInt)))
	if rc < 0 {
		return errors.New("failed to set DTR/RTS on Android USB port")
	}
	return nil
}

func (p *jniSerialPort) SetReadTimeout(t time.Duration) error {
	ms := int32(t.Milliseconds())
	if ms <= 0 {
		ms = 50
	}
	p.timeoutMs.Store(ms)
	return nil
}

func (p *jniSerialPort) Close() error {
	p.closeOnce.Do(func() {
		p.closed.Store(true)
		// Unblock any active Read() in Java first by closing the underlying port handle,
		// then wait for ioMu before releasing global JNI byte[] buffers.
		if p.ble {
			C.slaprf_ble_close_port(C.int(p.handle))
		} else {
			C.slaprf_usb_close_port(C.int(p.handle))
		}
		p.ioMu.Lock()
		C.slaprf_jni_free_buf(p.rxBufRef)
		C.slaprf_jni_free_buf(p.txBufRef)
		p.rxBufRef = 0
		p.txBufRef = 0
		p.ioMu.Unlock()
	})
	return nil
}
