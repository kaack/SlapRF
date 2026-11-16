package firmware

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
	"sync"
	"time"
)

const (
	// EspressifUSBVID is the USB Vendor ID for Seeed Studio XIAO ESP32-C5 USB-Serial-JTAG.
	EspressifUSBVID uint16 = 0x303A

	espFlashBegin   byte = 0x02
	espFlashData    byte = 0x03
	espSync         byte = 0x08
	espWriteReg     byte = 0x09
	espSPISetParams byte = 0x0B
	espSPIAttach    byte = 0x0D

	slipEnd    byte = 0xC0
	slipEsc    byte = 0xDB
	slipEscEnd byte = 0xDC
	slipEscEsc byte = 0xDD

	flashBlockSize = 1024 // ESP32C5ROM.FLASH_WRITE_SIZE = 0x400
	eraseRegionLen = 0x190000
)

// FlashProgress reports real-time progress during native Go ESP32-C5 firmware flashing or erasing.
type FlashProgress struct {
	Stage   string `json:"stage"`   // "connecting" | "bootloader" | "reading" | "erasing" | "writing" | "rebooting" | "done"
	Percent int    `json:"percent"` // 0..100
	Detail  string `json:"detail"`
}

// TimerReadout summarizes the `SLAPRF02` config block read from or written to a XIAO ESP32-C5.
type TimerReadout struct {
	Chip            string   `json:"chip"`
	Role            string   `json:"role"` // "hub" | "spoke"
	TimerLabel      string   `json:"timerLabel"`
	FrequenciesMHz  []uint16 `json:"frequenciesMHz"`
	FirmwareVersion string   `json:"firmwareVersion"`
	Fingerprint     string   `json:"fingerprint"`
	FingerprintKept bool     `json:"fingerprintKept,omitempty"`
}

// SerialPort abstracts an OS or mock USB serial port for ROM bootloader operations.
type SerialPort interface {
	io.ReadWriteCloser
	SetDTR(dtr bool) error
	SetRTS(rts bool) error
	SetReadTimeout(t time.Duration) error
}

// SerialOpener opens a named OS serial port (re-invoked if USB-Serial-JTAG re-enumerates after reset).
type SerialOpener func(portName string, baud int) (SerialPort, error)

// SetUSBSerialDTRRTS sets RTS before DTR so Windows `usbser.sys` caches RTS and flushes the exact
// `(dtr, rts)` pair in one USB `SET_CONTROL_LINE_STATE` packet without transient download-latch glitches.
func SetUSBSerialDTRRTS(p SerialPort, dtr, rts bool) {
	if p == nil {
		return
	}
	_ = p.SetRTS(rts)
	_ = p.SetDTR(dtr)
}

// DisarmUSBJtagLatch steps `(1,1) -> (1,0) -> (0,0)` so closing the port never traps ESP32-C5 in ROM bootloader mode.
func DisarmUSBJtagLatch(p SerialPort) {
	if p == nil {
		return
	}
	SetUSBSerialDTRRTS(p, true, false)
	SetUSBSerialDTRRTS(p, false, false)
}

// EnterUSBJtagBootloader triggers the ESP32-C5 USB-Serial-JTAG hardware reset into ROM Download Mode.
func EnterUSBJtagBootloader(p SerialPort) {
	SetUSBSerialDTRRTS(p, false, false)
	time.Sleep(100 * time.Millisecond)
	SetUSBSerialDTRRTS(p, true, false)
	time.Sleep(100 * time.Millisecond)
	SetUSBSerialDTRRTS(p, true, true)
	SetUSBSerialDTRRTS(p, false, true)
	time.Sleep(100 * time.Millisecond)
	SetUSBSerialDTRRTS(p, false, false)
	time.Sleep(120 * time.Millisecond)
}

// HardResetBoard triggers an ESP32-C5 USB-Serial-JTAG `CHIP_RST` with `IO0=1` (normal SPI flash boot).
func HardResetBoard(p SerialPort) {
	SetUSBSerialDTRRTS(p, false, false)
	time.Sleep(50 * time.Millisecond)
	SetUSBSerialDTRRTS(p, true, true)
	time.Sleep(60 * time.Millisecond)
	SetUSBSerialDTRRTS(p, false, true)
	time.Sleep(120 * time.Millisecond)
	SetUSBSerialDTRRTS(p, false, false)
	time.Sleep(150 * time.Millisecond)
}

func slipEncode(pkt []byte) []byte {
	out := make([]byte, 0, len(pkt)+16)
	out = append(out, slipEnd)
	for _, b := range pkt {
		switch b {
		case slipEnd:
			out = append(out, slipEsc, slipEscEnd)
		case slipEsc:
			out = append(out, slipEsc, slipEscEsc)
		default:
			out = append(out, b)
		}
	}
	out = append(out, slipEnd)
	return out
}

func buildRomCommand(op byte, data []byte, checksum uint32) []byte {
	pkt := make([]byte, 8+len(data))
	pkt[0] = 0x00 // direction = request
	pkt[1] = op
	binary.LittleEndian.PutUint16(pkt[2:4], uint16(len(data)))
	binary.LittleEndian.PutUint32(pkt[4:8], checksum)
	copy(pkt[8:], data)
	return slipEncode(pkt)
}

func romChecksum(data []byte) uint32 {
	chk := uint32(0xEF)
	for _, b := range data {
		chk ^= uint32(b)
	}
	return chk
}

// ParseConfigReadout scans `raw` for a valid 160-byte `SLAPRF02` block and converts it to `TimerReadout`.
func ParseConfigReadout(raw []byte) (*TimerReadout, bool) {
	idx := bytes.Index(raw, []byte(ConfigMagic))
	if idx < 0 || idx+configLen > len(raw) {
		return nil, false
	}
	cfg, err := InspectConfig(raw[idx : idx+configLen])
	if err != nil {
		return nil, false
	}
	role := "spoke"
	if cfg.Role == RoleHubTimer {
		role = "hub"
	}
	freqs := make([]uint16, len(cfg.SlotFreqsMHz))
	copy(freqs, cfg.SlotFreqsMHz[:])
	return &TimerReadout{
		Chip:            "Seeed XIAO ESP32-C5 (RISC-V 240 MHz)",
		Role:            role,
		TimerLabel:      cfg.TimerLabel,
		FrequenciesMHz:  freqs,
		FirmwareVersion: cfg.FirmwareVersion,
		Fingerprint:     FormatFingerprint(cfg.Fingerprint),
	}, true
}

type slipReaderPump struct {
	mu         sync.Mutex
	cond       *sync.Cond
	queue      [][]byte
	rawBuf     bytes.Buffer
	collectRaw bool
	closed     bool
}

func newSlipReaderPump(p SerialPort, collectRaw bool) *slipReaderPump {
	sp := &slipReaderPump{collectRaw: collectRaw}
	sp.cond = sync.NewCond(&sp.mu)
	go sp.run(p)
	return sp
}

func (sp *slipReaderPump) run(p SerialPort) {
	_ = p.SetReadTimeout(60 * time.Millisecond)
	buf := make([]byte, 4096)
	inFrame := false
	escaped := false
	var frame []byte

	for {
		sp.mu.Lock()
		done := sp.closed
		sp.mu.Unlock()
		if done {
			return
		}
		n, err := p.Read(buf)
		if n > 0 {
			chunk := buf[:n]
			sp.mu.Lock()
			if sp.collectRaw && sp.rawBuf.Len() < 131072 {
				sp.rawBuf.Write(chunk)
			}
			for _, b := range chunk {
				if b == slipEnd {
					if inFrame && len(frame) >= 8 {
						cp := make([]byte, len(frame))
						copy(cp, frame)
						sp.queue = append(sp.queue, cp)
						sp.cond.Broadcast()
					}
					inFrame = true
					escaped = false
					frame = frame[:0]
				} else if inFrame {
					if escaped {
						escaped = false
						switch b {
						case slipEscEnd:
							frame = append(frame, slipEnd)
						case slipEscEsc:
							frame = append(frame, slipEsc)
						default:
							frame = append(frame, b)
						}
					} else if b == slipEsc {
						escaped = true
					} else {
						frame = append(frame, b)
					}
				}
			}
			sp.mu.Unlock()
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				sp.stop()
				return
			}
			// Read timeout on serial port is normal; yield briefly if error is non-timeout
			sp.mu.Lock()
			closed := sp.closed
			sp.mu.Unlock()
			if closed {
				return
			}
		}
	}
}

func (sp *slipReaderPump) stop() {
	sp.mu.Lock()
	sp.closed = true
	sp.cond.Broadcast()
	sp.mu.Unlock()
}

func (sp *slipReaderPump) setCollectRaw(on bool) []byte {
	sp.mu.Lock()
	defer sp.mu.Unlock()
	sp.collectRaw = on
	cp := make([]byte, sp.rawBuf.Len())
	copy(cp, sp.rawBuf.Bytes())
	return cp
}

func (sp *slipReaderPump) clearQueue() {
	sp.mu.Lock()
	sp.queue = nil
	sp.mu.Unlock()
}

func (sp *slipReaderPump) waitAck(op byte, timeout time.Duration) (bool, error) {
	deadline := time.Now().Add(timeout)
	for {
		sp.mu.Lock()
		for i, pkt := range sp.queue {
			if pkt[0] == 0x01 && pkt[1] == op {
				sp.queue = append(sp.queue[:i], sp.queue[i+1:]...)
				sp.mu.Unlock()
				payLen := int(binary.LittleEndian.Uint16(pkt[2:4]))
				if payLen >= 2 && len(pkt) >= 10 {
					status := pkt[8]
					errCode := pkt[9]
					if status != 0 {
						return false, fmt.Errorf("ROM bootloader command 0x%02x failed (err 0x%02x)", op, errCode)
					}
				}
				return true, nil
			}
		}
		rem := time.Until(deadline)
		if rem <= 0 || sp.closed {
			sp.mu.Unlock()
			return false, nil
		}
		sp.mu.Unlock()
		time.Sleep(minDur(15*time.Millisecond, rem))
	}
}

func minDur(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}

func syncBootloaderSession(
	portName string,
	openPort SerialOpener,
	curPort SerialPort,
	curPump *slipReaderPump,
) (SerialPort, *slipReaderPump, error) {
	syncPayload := make([]byte, 36)
	copy(syncPayload[0:4], []byte{0x07, 0x07, 0x12, 0x20})
	for i := 4; i < 36; i++ {
		syncPayload[i] = 0x55
	}
	syncFrame := buildRomCommand(espSync, syncPayload, 0)

	reopen := func() error {
		if curPump != nil {
			curPump.stop()
		}
		if curPort != nil {
			_ = curPort.Close()
		}
		time.Sleep(380 * time.Millisecond)
		np, err := openPort(portName, 115200)
		if err != nil {
			return err
		}
		DisarmUSBJtagLatch(np)
		curPort = np
		curPump = newSlipReaderPump(np, false)
		return nil
	}

	trySync := func(attempts int, timeout time.Duration) (bool, error) {
		curPump.clearQueue()
		for a := 0; a < attempts; a++ {
			if _, wErr := curPort.Write(syncFrame); wErr != nil {
				if rErr := reopen(); rErr == nil {
					_, _ = curPort.Write(syncFrame)
				}
			}
			ok, err := curPump.waitAck(espSync, timeout)
			if err != nil {
				return false, err
			}
			if ok {
				time.Sleep(25 * time.Millisecond)
				curPump.clearQueue()
				return true, nil
			}
		}
		return false, nil
	}

	if ok, err := trySync(2, 80*time.Millisecond); err != nil {
		return curPort, curPump, err
	} else if ok {
		return curPort, curPump, nil
	}

	EnterUSBJtagBootloader(curPort)
	_ = reopen()
	if ok, err := trySync(8, 150*time.Millisecond); err != nil {
		return curPort, curPump, err
	} else if ok {
		return curPort, curPump, nil
	}

	time.Sleep(450 * time.Millisecond)
	EnterUSBJtagBootloader(curPort)
	_ = reopen()
	if ok, err := trySync(6, 150*time.Millisecond); err != nil {
		return curPort, curPump, err
	} else if ok {
		return curPort, curPump, nil
	}

	return curPort, curPump, errors.New("could not sync with ESP32-C5 ROM bootloader; hold BOOT while plugging in USB and try again")
}

func writeRomReg(p SerialPort, pump *slipReaderPump, addr, value, mask uint32) error {
	var payload [16]byte
	binary.LittleEndian.PutUint32(payload[0:4], addr)
	binary.LittleEndian.PutUint32(payload[4:8], value)
	binary.LittleEndian.PutUint32(payload[8:12], mask)
	binary.LittleEndian.PutUint32(payload[12:16], 0)
	if _, err := p.Write(buildRomCommand(espWriteReg, payload[:], 0)); err != nil {
		return err
	}
	ok, err := pump.waitAck(espWriteReg, time.Second)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("timed out writing ESP32-C5 register 0x%08x", addr)
	}
	return nil
}

func disableEsp32C5Watchdogs(p SerialPort, pump *slipReaderPump) error {
	if err := writeRomReg(p, pump, 0x600B1034, 0x00000000, 0x3<<29); err != nil {
		return err
	}
	if err := writeRomReg(p, pump, 0x600B1C18, 0x50D83AA1, 0xFFFFFFFF); err != nil {
		return err
	}
	if err := writeRomReg(p, pump, 0x600B1C00, 0x00000000, 0xFFFFFFFF); err != nil {
		return err
	}
	if err := writeRomReg(p, pump, 0x600B1C18, 0x00000000, 0xFFFFFFFF); err != nil {
		return err
	}
	if err := writeRomReg(p, pump, 0x600B1C20, 0x50D83AA1, 0xFFFFFFFF); err != nil {
		return err
	}
	if err := writeRomReg(p, pump, 0x600B1C1C, 1<<18, 1<<18); err != nil {
		return err
	}
	return writeRomReg(p, pump, 0x600B1C20, 0x00000000, 0xFFFFFFFF)
}

func attachSPIFlash4MB(p SerialPort, pump *slipReaderPump) error {
	if _, err := p.Write(buildRomCommand(espSPIAttach, make([]byte, 8), 0)); err != nil {
		return err
	}
	if ok, err := pump.waitAck(espSPIAttach, 1500*time.Millisecond); err != nil || !ok {
		if err != nil {
			return err
		}
		return errors.New("timed out attaching ESP32-C5 SPI flash")
	}
	var spiParams [24]byte
	binary.LittleEndian.PutUint32(spiParams[0:4], 0)
	binary.LittleEndian.PutUint32(spiParams[4:8], 4*1024*1024)
	binary.LittleEndian.PutUint32(spiParams[8:12], 64*1024)
	binary.LittleEndian.PutUint32(spiParams[12:16], 4096)
	binary.LittleEndian.PutUint32(spiParams[16:20], 256)
	binary.LittleEndian.PutUint32(spiParams[20:24], 0xFFFF)
	if _, err := p.Write(buildRomCommand(espSPISetParams, spiParams[:], 0)); err != nil {
		return err
	}
	if ok, err := pump.waitAck(espSPISetParams, 1500*time.Millisecond); err != nil || !ok {
		if err != nil {
			return err
		}
		return errors.New("timed out setting ESP32-C5 SPI flash parameters")
	}
	return nil
}

// FlashXiaoC5 flashes a patched SlapRF ESP32-C5 firmware image over native OS USB serial (`openPort`),
// optionally preserving the board's existing `SLAPRF02` fingerprint when `keepFingerprint` is true.
func FlashXiaoC5(
	portName string,
	openPort SerialOpener,
	baseImage []byte,
	cfg TimerConfig,
	keepFingerprint bool,
	onProgress func(FlashProgress),
) (*TimerReadout, error) {
	emit := func(stage string, pct int, detail string) {
		if onProgress != nil {
			onProgress(FlashProgress{Stage: stage, Percent: pct, Detail: detail})
		}
	}
	label := cfg.TimerLabel
	if label == "" {
		if cfg.Role == RoleHubTimer {
			label = "H1"
		} else {
			label = "T1"
		}
	}

	emit("connecting", 2, fmt.Sprintf("Opening %s to flash as %s…", portName, label))
	port, err := openPort(portName, 115200)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", portName, err)
	}
	DisarmUSBJtagLatch(port)
	pump := newSlipReaderPump(port, keepFingerprint)
	defer func() {
		if pump != nil {
			pump.stop()
		}
		if port != nil {
			DisarmUSBJtagLatch(port)
			_ = port.Close()
		}
	}()

	fingerprintKept := false
	_, _ = port.Write([]byte("\nRF 0\n"))
	time.Sleep(50 * time.Millisecond)
	if keepFingerprint {
		emit("reading", 4, "Checking board for an existing fingerprint…")
		_, _ = port.Write([]byte("\nLIVE 0\nSCAN STOP\nLOG 0\nSLAPRF?\n"))
		time.Sleep(260 * time.Millisecond)
		rx := pump.setCollectRaw(false)
		if existing, ok := ParseConfigReadout(rx); ok {
			fp := ParseFingerprint(existing.Fingerprint)
			if fp != 0 && fp != 1 {
				cfg.Fingerprint = fp
				fingerprintKept = true
			}
		}
	} else {
		pump.setCollectRaw(false)
	}

	built, err := PatchImage(baseImage, cfg)
	if err != nil {
		return nil, err
	}
	imageBytes := built.Bytes

	emit("bootloader", 6, "Entering ESP32-C5 ROM bootloader…")
	port, pump, err = syncBootloaderSession(portName, openPort, port, pump)
	if err != nil {
		return nil, err
	}

	if err := disableEsp32C5Watchdogs(port, pump); err != nil {
		return nil, err
	}

	emit("erasing", 10, "Attaching 4 MB SPI flash…")
	if err := attachSPIFlash4MB(port, pump); err != nil {
		return nil, err
	}

	flashOffset := uint32(0)
	if len(imageBytes) > 0x10000 && imageBytes[0] == 0xFF && imageBytes[0x2000] == espImageMagic {
		flashOffset = 0x2000
	}
	payloadBytes := imageBytes[flashOffset:]
	numBlocks := int(math.Ceil(float64(len(payloadBytes)) / float64(flashBlockSize)))

	emit("erasing", 13, fmt.Sprintf("Erasing %d KB of SPI flash…", len(payloadBytes)/1024))
	var beginPayload [20]byte
	binary.LittleEndian.PutUint32(beginPayload[0:4], uint32(len(payloadBytes)))
	binary.LittleEndian.PutUint32(beginPayload[4:8], uint32(numBlocks))
	binary.LittleEndian.PutUint32(beginPayload[8:12], flashBlockSize)
	binary.LittleEndian.PutUint32(beginPayload[12:16], flashOffset)
	binary.LittleEndian.PutUint32(beginPayload[16:20], 0)
	if _, err := port.Write(buildRomCommand(espFlashBegin, beginPayload[:], 0)); err != nil {
		return nil, err
	}
	if ok, err := pump.waitAck(espFlashBegin, 20*time.Second); err != nil || !ok {
		if err != nil {
			return nil, err
		}
		return nil, errors.New("timed out waiting for ESP32-C5 SPI flash erase")
	}

	kbTotal := (len(payloadBytes) + 1023) / 1024
	paddedBlock := make([]byte, flashBlockSize)
	dataPayload := make([]byte, 16+flashBlockSize)
	for seq := 0; seq < numBlocks; seq++ {
		for i := range paddedBlock {
			paddedBlock[i] = 0xFF
		}
		start := seq * flashBlockSize
		end := start + flashBlockSize
		if end > len(payloadBytes) {
			end = len(payloadBytes)
		}
		copy(paddedBlock, payloadBytes[start:end])

		binary.LittleEndian.PutUint32(dataPayload[0:4], flashBlockSize)
		binary.LittleEndian.PutUint32(dataPayload[4:8], uint32(seq))
		binary.LittleEndian.PutUint32(dataPayload[8:12], 0)
		binary.LittleEndian.PutUint32(dataPayload[12:16], 0)
		copy(dataPayload[16:], paddedBlock)

		pkt := buildRomCommand(espFlashData, dataPayload, romChecksum(paddedBlock))
		acked := false
		for attempt := 0; attempt < 3; attempt++ {
			if _, wErr := port.Write(pkt); wErr != nil {
				return nil, wErr
			}
			ok, ackErr := pump.waitAck(espFlashData, 3*time.Second)
			if ackErr != nil {
				return nil, ackErr
			}
			if ok {
				acked = true
				break
			}
		}
		if !acked {
			return nil, fmt.Errorf("timed out writing flash block %d / %d", seq+1, numBlocks)
		}
		if seq%4 == 0 || seq == numBlocks-1 {
			pct := 15 + ((seq+1)*81)/numBlocks
			if pct > 96 {
				pct = 96
			}
			kbDone := ((seq + 1) * flashBlockSize) / 1024
			if kbDone > kbTotal {
				kbDone = kbTotal
			}
			emit("writing", pct, fmt.Sprintf("Writing %s (%d / %d KB)…", label, kbDone, kbTotal))
		}
	}

	emit("rebooting", 98, "Verifying checksum & rebooting XIAO ESP32-C5…")
	_ = writeRomReg(port, pump, 0x600B1C18, 0x50D83AA1, 0xFFFFFFFF)
	_ = writeRomReg(port, pump, 0x600B1C00, 0x00000000, 0xFFFFFFFF)
	_ = writeRomReg(port, pump, 0x600B1C18, 0x00000000, 0xFFFFFFFF)
	time.Sleep(60 * time.Millisecond)
	HardResetBoard(port)

	emit("done", 100, fmt.Sprintf("%s flashed & ready!", label))
	readout, _ := ParseConfigReadout(imageBytes)
	if readout != nil {
		readout.FingerprintKept = fingerprintKept
	}
	return readout, nil
}

// EraseXiaoC5 wipes the SPI flash (`0x0000..0x190000`) of a connected XIAO ESP32-C5 over native OS serial.
func EraseXiaoC5(
	portName string,
	openPort SerialOpener,
	onProgress func(FlashProgress),
) error {
	emit := func(stage string, pct int, detail string) {
		if onProgress != nil {
			onProgress(FlashProgress{Stage: stage, Percent: pct, Detail: detail})
		}
	}
	emit("connecting", 5, fmt.Sprintf("Opening %s to erase flash…", portName))
	port, err := openPort(portName, 115200)
	if err != nil {
		return fmt.Errorf("open %s: %w", portName, err)
	}
	DisarmUSBJtagLatch(port)
	pump := newSlipReaderPump(port, false)
	defer func() {
		if pump != nil {
			pump.stop()
		}
		if port != nil {
			DisarmUSBJtagLatch(port)
			_ = port.Close()
		}
	}()

	emit("bootloader", 15, "Entering ESP32-C5 ROM bootloader…")
	port, pump, err = syncBootloaderSession(portName, openPort, port, pump)
	if err != nil {
		return err
	}
	if err := disableEsp32C5Watchdogs(port, pump); err != nil {
		return err
	}
	emit("erasing", 30, "Attaching 4 MB SPI flash…")
	if err := attachSPIFlash4MB(port, pump); err != nil {
		return err
	}
	emit("erasing", 45, "Erasing bootloader, NVS & application partitions…")
	var beginPayload [20]byte
	binary.LittleEndian.PutUint32(beginPayload[0:4], eraseRegionLen)
	binary.LittleEndian.PutUint32(beginPayload[4:8], 0)
	binary.LittleEndian.PutUint32(beginPayload[8:12], flashBlockSize)
	binary.LittleEndian.PutUint32(beginPayload[12:16], 0)
	binary.LittleEndian.PutUint32(beginPayload[16:20], 0)
	if _, err := port.Write(buildRomCommand(espFlashBegin, beginPayload[:], 0)); err != nil {
		return err
	}
	if ok, err := pump.waitAck(espFlashBegin, 25*time.Second); err != nil || !ok {
		if err != nil {
			return err
		}
		return errors.New("timed out erasing ESP32-C5 SPI flash")
	}
	emit("rebooting", 95, "Completing erase…")
	HardResetBoard(port)
	emit("done", 100, "Board flash erased.")
	return nil
}
