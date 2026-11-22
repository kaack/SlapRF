//go:build linux && !android && !js

package serialport

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"

	"slaprf/internal/firmware"
)

func TestFormatLinuxSerialOpenError(t *testing.T) {
	err := formatLinuxSerialOpenError("/dev/ttyACM0", os.ErrPermission)
	if err == nil || !strings.Contains(err.Error(), "dialout") {
		t.Fatalf("expected dialout hint in error, got %v", err)
	}
}

func openTestPTY(t *testing.T) (masterFd int, slavePath string) {
	t.Helper()
	masterFd, err := unix.Open("/dev/ptmx", unix.O_RDWR|unix.O_NOCTTY|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		t.Skipf("skipping PTY test: open /dev/ptmx: %v", err)
	}
	t.Cleanup(func() { _ = unix.Close(masterFd) })

	var unlock int32 = 0
	if _, _, errno := unix.Syscall(unix.SYS_IOCTL, uintptr(masterFd), uintptr(unix.TIOCSPTLCK), uintptr(unsafe.Pointer(&unlock))); errno != 0 {
		t.Fatalf("TIOCSPTLCK: %v", errno)
	}
	var ptyNum uint32
	if _, _, errno := unix.Syscall(unix.SYS_IOCTL, uintptr(masterFd), uintptr(unix.TIOCGPTN), uintptr(unsafe.Pointer(&ptyNum))); errno != 0 {
		t.Fatalf("TIOCGPTN: %v", errno)
	}
	return masterFd, fmt.Sprintf("/dev/pts/%d", ptyNum)
}

func TestLinuxSerialPortPTYNonBlockingRawAndCloseWake(t *testing.T) {
	masterFd, slavePath := openTestPTY(t)

	port, err := openUSBSerialPort(slavePath, 115200)
	if err != nil {
		t.Fatalf("openUSBSerialPort(%s): %v", slavePath, err)
	}
	defer func() { _ = port.Close() }()

	if _, ok := port.(firmware.AtomicDTRRTSSetter); !ok {
		t.Fatalf("expected linuxSerialPort to implement firmware.AtomicDTRRTSSetter")
	}

	lp, ok := port.(*linuxSerialPort)
	if !ok {
		t.Fatalf("expected *linuxSerialPort, got %T", port)
	}

	flags, err := unix.FcntlInt(uintptr(lp.fd), unix.F_GETFL, 0)
	if err != nil {
		t.Fatalf("F_GETFL: %v", err)
	}
	if flags&unix.O_NONBLOCK == 0 {
		t.Fatalf("expected O_NONBLOCK to stay enabled on fd, flags=0x%x", flags)
	}

	termios, err := unix.IoctlGetTermios(lp.fd, unix.TCGETS)
	if err != nil {
		t.Fatalf("TCGETS: %v", err)
	}
	if termios.Cflag&unix.HUPCL != 0 {
		t.Fatalf("expected HUPCL to be cleared so close() never toggles DTR/RTS, cflag=0x%x", termios.Cflag)
	}

	// Read timeout must return (0, nil) cleanly.
	if err := port.SetReadTimeout(35 * time.Millisecond); err != nil {
		t.Fatalf("SetReadTimeout: %v", err)
	}
	buf := make([]byte, 64)
	n, err := port.Read(buf)
	if err != nil || n != 0 {
		t.Fatalf("expected (0, nil) on timeout, got (%d, %v)", n, err)
	}

	// Binary round-trip (verifies raw 8N1 without ICRNL/ONLCR/IXON/ISIG mangling).
	payload := []byte{0xC0, 0x00, 0x08, '\r', '\n', 0x03, 0x11, 0x13, 0xC5, 0xFF}
	if _, err := unix.Write(masterFd, payload); err != nil {
		t.Fatalf("master write: %v", err)
	}
	var got []byte
	deadline := time.Now().Add(500 * time.Millisecond)
	for len(got) < len(payload) && time.Now().Before(deadline) {
		rn, rErr := port.Read(buf)
		if rErr != nil {
			t.Fatalf("port.Read: %v", rErr)
		}
		if rn > 0 {
			got = append(got, buf[:rn]...)
		}
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("binary RX mismatch: got %x, want %x", got, payload)
	}

	outMsg := []byte("\nSTATUS?\nSLAPRF?\n")
	wn, err := port.Write(outMsg)
	if err != nil || wn != len(outMsg) {
		t.Fatalf("port.Write: (%d, %v)", wn, err)
	}

	// Concurrent Close() must immediately wake an indefinite blocking Read() without hanging.
	if err := port.SetReadTimeout(-1); err != nil {
		t.Fatalf("SetReadTimeout(-1): %v", err)
	}
	readErrCh := make(chan error, 1)
	go func() {
		_, rErr := port.Read(buf)
		readErrCh <- rErr
	}()
	time.Sleep(20 * time.Millisecond)

	closeStart := time.Now()
	if err := port.Close(); err != nil {
		t.Fatalf("port.Close: %v", err)
	}
	if elapsed := time.Since(closeStart); elapsed > 200*time.Millisecond {
		t.Fatalf("port.Close took too long: %s", elapsed)
	}

	select {
	case rErr := <-readErrCh:
		if !errors.Is(rErr, os.ErrClosed) {
			t.Fatalf("expected os.ErrClosed from woken Read, got %v", rErr)
		}
	case <-time.After(250 * time.Millisecond):
		t.Fatalf("blocking Read did not wake after Close()")
	}
}
