//go:build linux && !android && !js

package serialport

import (
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/sys/unix"

	"slaprf/internal/firmware"
)

const linuxWriteTimeout = 1500 * time.Millisecond

var linuxBaudMap = map[int]uint32{
	50:      unix.B50,
	75:      unix.B75,
	110:     unix.B110,
	134:     unix.B134,
	150:     unix.B150,
	200:     unix.B200,
	300:     unix.B300,
	600:     unix.B600,
	1200:    unix.B1200,
	1800:    unix.B1800,
	2400:    unix.B2400,
	4800:    unix.B4800,
	9600:    unix.B9600,
	19200:   unix.B19200,
	38400:   unix.B38400,
	57600:   unix.B57600,
	115200:  unix.B115200,
	230400:  unix.B230400,
	460800:  unix.B460800,
	500000:  unix.B500000,
	576000:  unix.B576000,
	921600:  unix.B921600,
	1000000: unix.B1000000,
	1152000: unix.B1152000,
	1500000: unix.B1500000,
	2000000: unix.B2000000,
	2500000: unix.B2500000,
	3000000: unix.B3000000,
	3500000: unix.B3500000,
	4000000: unix.B4000000,
}

// linuxSerialPort implements firmware.SerialPort and firmware.AtomicDTRRTSSetter directly on top of
// non-blocking Linux termios/tty syscalls so:
//  1. DTR and RTS updates execute in a single atomic TIOCMSET ioctl (one USB SET_CONTROL_LINE_STATE
//     packet on cdc_acm, eliminating intermediate (0,1)->(1,1) edges that re-latch ESP32-C5 into
//     ROM download mode during app reboot).
//  2. HUPCL is cleared so close() never drops DTR/RTS or resets the board.
//  3. O_NONBLOCK stays set + TCIOFLUSH runs before close() so close() and Write() never hang for
//     30 seconds in kernel tty_wait_until_sent if a rebooting chip temporarily NAKs USB bulk OUT.
type linuxSerialPort struct {
	fd          int
	wakeR       int
	wakeW       int
	mu          sync.RWMutex
	readTimeout atomic.Int64 // nanoseconds; <= 0 means block until data or Close()
	closed      atomic.Bool
}

func openUSBSerialPort(portName string, baud int) (firmware.SerialPort, error) {
	portName = strings.TrimSpace(portName)
	if portName == "" {
		return nil, fmt.Errorf("missing serial port name")
	}
	if baud <= 0 {
		baud = 115200
	}

	fd, err := unix.Open(portName, unix.O_RDWR|unix.O_NOCTTY|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		if errors.Is(err, unix.EBUSY) {
			return nil, fmt.Errorf("serial port %s is busy", portName)
		}
		return nil, formatLinuxSerialOpenError(portName, err)
	}

	var pipeFds [2]int
	if pErr := unix.Pipe2(pipeFds[:], unix.O_NONBLOCK|unix.O_CLOEXEC); pErr != nil {
		_ = unix.Close(fd)
		return nil, fmt.Errorf("create serial wake pipe: %w", pErr)
	}

	if cfgErr := configureLinuxRawTermios(fd, baud); cfgErr != nil {
		_ = unix.Close(pipeFds[0])
		_ = unix.Close(pipeFds[1])
		_ = unix.Close(fd)
		return nil, fmt.Errorf("configure serial port %s: %w", portName, cfgErr)
	}

	_ = unix.IoctlSetInt(fd, unix.TIOCEXCL, 0)

	return &linuxSerialPort{
		fd:    fd,
		wakeR: pipeFds[0],
		wakeW: pipeFds[1],
	}, nil
}

func configureLinuxRawTermios(fd int, baud int) error {
	t, err := unix.IoctlGetTermios(fd, unix.TCGETS)
	if err != nil {
		return err
	}

	// Raw 8N1 with HUPCL explicitly cleared so closing the fd never toggles DTR/RTS.
	t.Cflag &^= unix.PARENB | unix.PARODD | unix.CMSPAR | unix.CSTOPB | unix.CSIZE | unix.CRTSCTS | unix.HUPCL
	t.Cflag |= unix.CLOCAL | unix.CREAD | unix.CS8

	t.Lflag &^= unix.ICANON | unix.ECHO | unix.ECHOE | unix.ECHOK | unix.ECHONL |
		unix.ECHOCTL | unix.ECHOPRT | unix.ECHOKE | unix.ISIG | unix.IEXTEN

	t.Iflag &^= unix.IXON | unix.IXOFF | unix.IXANY | unix.INPCK | unix.IGNPAR |
		unix.PARMRK | unix.ISTRIP | unix.IGNBRK | unix.BRKINT | unix.INLCR | unix.IGNCR |
		unix.ICRNL | unix.IUCLC

	t.Oflag &^= unix.OPOST
	t.Cc[unix.VMIN] = 0
	t.Cc[unix.VTIME] = 0

	if cbaud, ok := linuxBaudMap[baud]; ok {
		t.Cflag &^= unix.CBAUD | unix.CBAUDEX
		t.Cflag |= cbaud
		t.Ispeed = cbaud
		t.Ospeed = cbaud
		return unix.IoctlSetTermios(fd, unix.TCSETS, t)
	}

	if err := unix.IoctlSetTermios(fd, unix.TCSETS, t); err != nil {
		return err
	}
	t2, err := unix.IoctlGetTermios(fd, unix.TCGETS2)
	if err != nil {
		return err
	}
	t2.Cflag &^= unix.CBAUD
	t2.Cflag |= unix.BOTHER
	t2.Ispeed = uint32(baud)
	t2.Ospeed = uint32(baud)
	return unix.IoctlSetTermios(fd, unix.TCSETS2, t2)
}

func (p *linuxSerialPort) SetReadTimeout(d time.Duration) error {
	if d < 0 {
		p.readTimeout.Store(-1)
	} else {
		p.readTimeout.Store(int64(d))
	}
	return nil
}

func (p *linuxSerialPort) Read(b []byte) (int, error) {
	if len(b) == 0 {
		return 0, nil
	}
	p.mu.RLock()
	defer p.mu.RUnlock()
	if p.closed.Load() {
		return 0, os.ErrClosed
	}

	timeoutNs := p.readTimeout.Load()
	hasDeadline := timeoutNs > 0
	var deadline time.Time
	if hasDeadline {
		deadline = time.Now().Add(time.Duration(timeoutNs))
	}

	pollFds := []unix.PollFd{
		{Fd: int32(p.fd), Events: unix.POLLIN},
		{Fd: int32(p.wakeR), Events: unix.POLLIN},
	}

	for {
		if p.closed.Load() {
			return 0, os.ErrClosed
		}

		waitMs := -1
		if timeoutNs == 0 {
			waitMs = 0
		} else if hasDeadline {
			rem := time.Until(deadline)
			if rem <= 0 {
				return 0, nil
			}
			waitMs = int((rem + time.Millisecond - 1) / time.Millisecond)
		}

		pollFds[0].Revents = 0
		pollFds[1].Revents = 0
		nReady, pErr := unix.Poll(pollFds, waitMs)
		if errors.Is(pErr, unix.EINTR) {
			continue
		}
		if pErr != nil {
			return 0, pErr
		}
		if pollFds[1].Revents != 0 || p.closed.Load() {
			return 0, os.ErrClosed
		}
		if nReady == 0 {
			return 0, nil
		}

		if pollFds[0].Revents&(unix.POLLERR|unix.POLLHUP|unix.POLLNVAL) != 0 && pollFds[0].Revents&unix.POLLIN == 0 {
			return 0, io.EOF
		}

		n, rErr := unix.Read(p.fd, b)
		if errors.Is(rErr, unix.EINTR) {
			continue
		}
		if errors.Is(rErr, unix.EAGAIN) || errors.Is(rErr, unix.EWOULDBLOCK) {
			if timeoutNs == 0 {
				return 0, nil
			}
			continue
		}
		if rErr != nil {
			return 0, rErr
		}
		if n == 0 {
			// On Linux cdc_acm, POLLIN returning 0 bytes indicates the USB device disconnected.
			return 0, io.EOF
		}
		return n, nil
	}
}

func (p *linuxSerialPort) Write(b []byte) (int, error) {
	if len(b) == 0 {
		return 0, nil
	}
	p.mu.RLock()
	defer p.mu.RUnlock()
	if p.closed.Load() {
		return 0, os.ErrClosed
	}

	deadline := time.Now().Add(linuxWriteTimeout)
	pollFds := []unix.PollFd{
		{Fd: int32(p.fd), Events: unix.POLLOUT},
		{Fd: int32(p.wakeR), Events: unix.POLLIN},
	}

	written := 0
	for written < len(b) {
		if p.closed.Load() {
			return written, os.ErrClosed
		}
		n, wErr := unix.Write(p.fd, b[written:])
		if n > 0 {
			written += n
			if written == len(b) {
				return written, nil
			}
		}
		if wErr == nil {
			continue
		}
		if errors.Is(wErr, unix.EINTR) {
			continue
		}
		if !errors.Is(wErr, unix.EAGAIN) && !errors.Is(wErr, unix.EWOULDBLOCK) {
			return written, wErr
		}

		rem := time.Until(deadline)
		if rem <= 0 {
			return written, fmt.Errorf("serial write timed out after %s", linuxWriteTimeout)
		}
		pollFds[0].Revents = 0
		pollFds[1].Revents = 0
		_, pErr := unix.Poll(pollFds, int((rem+time.Millisecond-1)/time.Millisecond))
		if errors.Is(pErr, unix.EINTR) {
			continue
		}
		if pErr != nil {
			return written, pErr
		}
		if pollFds[1].Revents != 0 || p.closed.Load() {
			return written, os.ErrClosed
		}
		if pollFds[0].Revents&(unix.POLLERR|unix.POLLHUP|unix.POLLNVAL) != 0 {
			return written, io.ErrClosedPipe
		}
	}
	return written, nil
}

func (p *linuxSerialPort) SetDTR(v bool) error {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if p.closed.Load() {
		return os.ErrClosed
	}
	status, err := unix.IoctlGetInt(p.fd, unix.TIOCMGET)
	if err != nil {
		return err
	}
	if v {
		status |= unix.TIOCM_DTR
	} else {
		status &^= unix.TIOCM_DTR
	}
	return unix.IoctlSetPointerInt(p.fd, unix.TIOCMSET, status)
}

func (p *linuxSerialPort) SetRTS(v bool) error {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if p.closed.Load() {
		return os.ErrClosed
	}
	status, err := unix.IoctlGetInt(p.fd, unix.TIOCMGET)
	if err != nil {
		return err
	}
	if v {
		status |= unix.TIOCM_RTS
	} else {
		status &^= unix.TIOCM_RTS
	}
	return unix.IoctlSetPointerInt(p.fd, unix.TIOCMSET, status)
}

// SetDTRRTS updates both DTR and RTS in a single TIOCMSET ioctl so Linux cdc_acm emits one atomic
// USB SET_CONTROL_LINE_STATE packet without glitching intermediate line states.
func (p *linuxSerialPort) SetDTRRTS(dtr, rts bool) error {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if p.closed.Load() {
		return os.ErrClosed
	}
	status, err := unix.IoctlGetInt(p.fd, unix.TIOCMGET)
	if err != nil {
		return err
	}
	if dtr {
		status |= unix.TIOCM_DTR
	} else {
		status &^= unix.TIOCM_DTR
	}
	if rts {
		status |= unix.TIOCM_RTS
	} else {
		status &^= unix.TIOCM_RTS
	}
	return unix.IoctlSetPointerInt(p.fd, unix.TIOCMSET, status)
}

func (p *linuxSerialPort) ResetInputBuffer() error {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if p.closed.Load() {
		return os.ErrClosed
	}
	return unix.IoctlSetInt(p.fd, unix.TCFLSH, unix.TCIFLUSH)
}

func (p *linuxSerialPort) ResetOutputBuffer() error {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if p.closed.Load() {
		return os.ErrClosed
	}
	return unix.IoctlSetInt(p.fd, unix.TCFLSH, unix.TCOFLUSH)
}

func (p *linuxSerialPort) Close() error {
	if !p.closed.CompareAndSwap(false, true) {
		return nil
	}
	// Wake any in-flight Poll immediately before acquiring the exclusive lock.
	_, _ = unix.Write(p.wakeW, []byte{1})

	p.mu.Lock()
	defer p.mu.Unlock()

	// Discard any undrained TX/RX bytes so kernel tty close never blocks.
	_ = unix.IoctlSetInt(p.fd, unix.TCFLSH, unix.TCIOFLUSH)
	_ = unix.IoctlSetInt(p.fd, unix.TIOCNXCL, 0)
	closeErr := unix.Close(p.fd)
	_ = unix.Close(p.wakeR)
	_ = unix.Close(p.wakeW)
	return closeErr
}

func formatLinuxSerialOpenError(portName string, err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, os.ErrPermission) || errors.Is(err, unix.EACCES) || errors.Is(err, unix.EPERM) ||
		strings.Contains(strings.ToLower(err.Error()), "permission denied") {
		return fmt.Errorf("permission denied opening %s (run: sudo usermod -aG dialout $USER, then log out and back in)", portName)
	}
	return err
}
