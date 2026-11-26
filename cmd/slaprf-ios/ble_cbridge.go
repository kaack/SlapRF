//go:build ios

package main

/*
#include "cbridge.h"
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
	"slaprf/internal/serialport"
)

const iosBleChunkSize = 4096

func iosListBLEPorts() ([]serialport.PortInfo, error) {
	if C.slaprf_ios_ble_available() == 0 {
		return nil, nil
	}
	cjson := C.slaprf_ios_ble_list_ports_json()
	if cjson == nil {
		return nil, nil
	}
	defer C.free(unsafe.Pointer(cjson))
	raw := strings.TrimSpace(C.GoString(cjson))
	if raw == "" {
		return nil, nil
	}
	var ports []serialport.PortInfo
	if err := json.Unmarshal([]byte(raw), &ports); err != nil {
		return nil, fmt.Errorf("parse iOS Bluetooth port list: %w", err)
	}
	return ports, nil
}

func iosOpenBLEPort(portName string, baud int) (firmware.SerialPort, error) {
	portName = strings.TrimSpace(portName)
	if portName == "" {
		return nil, errors.New("missing Bluetooth port name")
	}
	if baud <= 0 {
		baud = 115200
	}
	cname := C.CString(portName)
	defer C.free(unsafe.Pointer(cname))

	var cerr *C.char
	handle := int(C.slaprf_ios_ble_open_port(cname, C.int(baud), &cerr))
	if cerr != nil {
		defer C.free(unsafe.Pointer(cerr))
	}
	if handle <= 0 {
		msg := "failed to open iOS Bluetooth hub"
		if cerr != nil {
			if s := strings.TrimSpace(C.GoString(cerr)); s != "" {
				msg = s
			}
		}
		return nil, errors.New(msg)
	}

	p := &iosBleSerialPort{
		handle: handle,
		rxBuf:  C.malloc(C.size_t(iosBleChunkSize)),
		txBuf:  C.malloc(C.size_t(iosBleChunkSize)),
	}
	if p.rxBuf == nil || p.txBuf == nil {
		C.slaprf_ios_ble_close_port(C.int(handle))
		if p.rxBuf != nil {
			C.free(p.rxBuf)
		}
		if p.txBuf != nil {
			C.free(p.txBuf)
		}
		return nil, errors.New("failed to allocate iOS BLE C I/O buffers")
	}
	p.timeoutMs.Store(120)
	return p, nil
}

type iosBleSerialPort struct {
	handle    int
	rxBuf     unsafe.Pointer
	txBuf     unsafe.Pointer
	timeoutMs atomic.Int32

	ioMu      sync.RWMutex
	closed    atomic.Bool
	closeOnce sync.Once
}

func (p *iosBleSerialPort) Read(b []byte) (int, error) {
	if len(b) == 0 {
		return 0, nil
	}
	if p.closed.Load() {
		return 0, io.EOF
	}
	p.ioMu.RLock()
	defer p.ioMu.RUnlock()
	if p.closed.Load() || p.rxBuf == nil {
		return 0, io.EOF
	}

	maxLen := len(b)
	if maxLen > iosBleChunkSize {
		maxLen = iosBleChunkSize
	}
	tmo := int(p.timeoutMs.Load())
	if tmo <= 0 {
		tmo = 120
	}
	n := int(C.slaprf_ios_ble_read_port(C.int(p.handle), p.rxBuf, C.int(maxLen), C.int(tmo)))
	if n > 0 {
		copy(b[:n], unsafe.Slice((*byte)(p.rxBuf), n))
		return n, nil
	}
	if n == 0 {
		return 0, nil
	}
	return 0, io.EOF
}

func (p *iosBleSerialPort) Write(b []byte) (int, error) {
	if len(b) == 0 {
		return 0, nil
	}
	if p.closed.Load() {
		return 0, io.ErrClosedPipe
	}
	p.ioMu.RLock()
	defer p.ioMu.RUnlock()
	if p.closed.Load() || p.txBuf == nil {
		return 0, io.ErrClosedPipe
	}

	total := 0
	for total < len(b) {
		chunk := b[total:]
		if len(chunk) > iosBleChunkSize {
			chunk = chunk[:iosBleChunkSize]
		}
		copy(unsafe.Slice((*byte)(p.txBuf), len(chunk)), chunk)
		w := int(C.slaprf_ios_ble_write_port(C.int(p.handle), p.txBuf, C.int(len(chunk))))
		if w <= 0 {
			return total, errors.New("iOS Bluetooth write failed")
		}
		total += w
	}
	return total, nil
}

func (p *iosBleSerialPort) SetDTR(bool) error { return nil }
func (p *iosBleSerialPort) SetRTS(bool) error { return nil }

func (p *iosBleSerialPort) SetReadTimeout(t time.Duration) error {
	ms := int32(t.Milliseconds())
	if ms <= 0 {
		ms = 50
	}
	p.timeoutMs.Store(ms)
	return nil
}

func (p *iosBleSerialPort) Close() error {
	p.closeOnce.Do(func() {
		p.closed.Store(true)
		C.slaprf_ios_ble_close_port(C.int(p.handle))
		p.ioMu.Lock()
		if p.rxBuf != nil {
			C.free(p.rxBuf)
			p.rxBuf = nil
		}
		if p.txBuf != nil {
			C.free(p.txBuf)
			p.txBuf = nil
		}
		p.ioMu.Unlock()
	})
	return nil
}
