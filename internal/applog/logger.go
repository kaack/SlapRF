package applog

import (
	"bytes"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Level represents standard SLF4J / Log4j2 / slog severity levels ordered from most detailed to highest severity.
type Level int32

const (
	LevelTrace Level = -2
	LevelDebug Level = -1
	LevelInfo  Level = 0
	LevelWarn  Level = 1
	LevelError Level = 2
)

// AllLevels lists the supported log levels in ascending severity order.
var AllLevels = []string{"trace", "debug", "info", "warn", "error"}

// String returns the canonical lowercase level name (`trace`, `debug`, `info`, `warn`, `error`).
func (l Level) String() string {
	switch l {
	case LevelTrace:
		return "trace"
	case LevelDebug:
		return "debug"
	case LevelWarn:
		return "warn"
	case LevelError:
		return "error"
	default:
		return "info"
	}
}

// Tag returns the fixed uppercase log badge (`TRACE`, `DEBUG`, `INFO`, `WARN`, `ERROR`).
func (l Level) Tag() string {
	switch l {
	case LevelTrace:
		return "TRACE"
	case LevelDebug:
		return "DEBUG"
	case LevelWarn:
		return "WARN"
	case LevelError:
		return "ERROR"
	default:
		return "INFO"
	}
}

// ParseLevel parses a case-insensitive severity level name (`trace`, `debug`, `info`, `warn`, `error`).
func ParseLevel(raw string) (Level, bool) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "trace", "all", "verbose":
		return LevelTrace, true
	case "debug":
		return LevelDebug, true
	case "info":
		return LevelInfo, true
	case "warn", "warning":
		return LevelWarn, true
	case "error", "err":
		return LevelError, true
	default:
		return LevelInfo, false
	}
}

const (
	DefaultLogFileName  = "slaprf.log"
	DefaultMaxFileBytes = 4 * 1024 * 1024 // 4 MB active + 4 MB .1 backup = 8 MB max footprint
	DefaultRingLines    = 500
)

// Options configures a rolling multi-sink application logger.
type Options struct {
	FilePath     string
	MaxFileBytes int64
	RingLines    int
	Console      io.Writer
	Level        Level
	HasLevel     bool
}

// Status summarizes the live diagnostic logger configuration and on-disk (or in-memory) footprint.
type Status struct {
	LogPath   string   `json:"logPath"`
	SizeBytes int64    `json:"sizeBytes"`
	Level     string   `json:"level"`
	Levels    []string `json:"levels"`
	LineCount int      `json:"lineCount"`
	MaxLines  int      `json:"maxLines,omitempty"`
}

// Logger writes timestamped log lines to a size-bounded side-by-side `slaprf.log` file,
// an optional console writer (or native Android `logcat` under tag `SlapRFGo`), and an in-memory
// ring buffer for `/v1/logs` inspection.
type Logger struct {
	minLevel atomic.Int32

	mu       sync.Mutex
	filePath string
	maxBytes int64
	file     *os.File
	fileSize int64
	console  io.Writer
	closed   bool

	ring    []string
	ringCap int
	ringPos int
	ringLen int
}

// EnvLevel inspects `SLAPRF_LOG_LEVEL` (`trace`, `debug`, `info`, `warn`, `error`).
func EnvLevel() (lvl Level, set bool) {
	raw, ok := os.LookupEnv("SLAPRF_LOG_LEVEL")
	if !ok || strings.TrimSpace(raw) == "" {
		return LevelInfo, false
	}
	parsed, valid := ParseLevel(raw)
	if !valid {
		return LevelInfo, false
	}
	return parsed, true
}

// ResolveDefaultLogPath returns the side-by-side `slaprf.log` path next to `dbPath` unless
// overridden by `explicitFlag` or `SLAPRF_LOG_FILE`. Ephemeral unit-test databases (`slaprf-portable-*`)
// return `""` so unit tests stay purely in-memory unless explicitly configured.
func ResolveDefaultLogPath(dbPath string, explicitFlag string) string {
	if runtime.GOOS == "js" {
		return ""
	}
	if clean := strings.TrimSpace(explicitFlag); clean != "" {
		if abs, err := filepath.Abs(clean); err == nil {
			return abs
		}
		return clean
	}
	if envPath := strings.TrimSpace(os.Getenv("SLAPRF_LOG_FILE")); envPath != "" {
		if abs, err := filepath.Abs(envPath); err == nil {
			return abs
		}
		return envPath
	}
	cleanDB := strings.TrimSpace(dbPath)
	if cleanDB == "" || strings.Contains(filepath.Base(cleanDB), "slaprf-portable-") {
		return ""
	}
	if absDB, err := filepath.Abs(cleanDB); err == nil {
		cleanDB = absDB
	}
	return filepath.Join(filepath.Dir(cleanDB), DefaultLogFileName)
}

// New opens (or creates) a rolling `Logger`. If `opts.FilePath` cannot be opened, logging degrades
// gracefully to console/logcat + the in-memory ring buffer without failing startup.
func New(opts Options) *Logger {
	maxB := opts.MaxFileBytes
	if maxB <= 0 {
		maxB = DefaultMaxFileBytes
	}
	ringCap := opts.RingLines
	if ringCap <= 0 {
		ringCap = DefaultRingLines
	}
	initLevel := LevelInfo
	if opts.HasLevel {
		initLevel = opts.Level
	}
	l := &Logger{
		filePath: strings.TrimSpace(opts.FilePath),
		maxBytes: maxB,
		console:  opts.Console,
		ring:     make([]string, ringCap),
		ringCap:  ringCap,
	}
	l.minLevel.Store(int32(initLevel))

	if l.filePath != "" {
		if abs, err := filepath.Abs(l.filePath); err == nil {
			l.filePath = abs
		}
		_ = os.MkdirAll(filepath.Dir(l.filePath), 0o755)
		l.seedRingFromDiskLocked()
		l.openLogFileLocked()
	}
	return l
}

func (l *Logger) seedRingFromDiskLocked() {
	raw, err := os.ReadFile(l.filePath)
	if err != nil || len(raw) == 0 {
		return
	}
	if len(raw) > 128*1024 {
		raw = raw[len(raw)-128*1024:]
		if nl := bytes.IndexByte(raw, '\n'); nl >= 0 && nl+1 < len(raw) {
			raw = raw[nl+1:]
		}
	}
	for _, line := range strings.Split(strings.TrimRight(string(raw), "\r\n"), "\n") {
		if line != "" {
			l.appendRingLocked(line)
		}
	}
}

func (l *Logger) openLogFileLocked() {
	if l.filePath == "" {
		return
	}
	f, err := os.OpenFile(l.filePath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	var sz int64
	if st, sErr := f.Stat(); sErr == nil {
		sz = st.Size()
	}
	l.file = f
	l.fileSize = sz
}

func (l *Logger) rotateIfNeededLocked(incoming int64) {
	if l.file == nil || l.maxBytes <= 0 || l.fileSize+incoming <= l.maxBytes {
		return
	}
	_ = l.file.Close()
	l.file = nil
	l.fileSize = 0

	bak := l.filePath + ".1"
	_ = os.Remove(bak)
	_ = os.Rename(l.filePath, bak)
	l.openLogFileLocked()
}

func (l *Logger) appendRingLocked(line string) {
	if l.ringCap <= 0 {
		return
	}
	if l.ringLen < l.ringCap {
		idx := (l.ringPos + l.ringLen) % l.ringCap
		l.ring[idx] = line
		l.ringLen++
		return
	}
	l.ring[l.ringPos] = line
	l.ringPos = (l.ringPos + 1) % l.ringCap
}

// Level returns the active minimum log severity threshold.
func (l *Logger) Level() Level {
	if l == nil {
		return LevelInfo
	}
	return Level(l.minLevel.Load())
}

// Enabled reports whether `level` meets or exceeds the active minimum threshold.
func (l *Logger) Enabled(level Level) bool {
	if l == nil {
		return false
	}
	return int32(level) >= l.minLevel.Load()
}

// SetLevel updates the active minimum log severity threshold at runtime.
func (l *Logger) SetLevel(level Level) {
	if l == nil {
		return
	}
	prev := Level(l.minLevel.Swap(int32(level)))
	if prev != level {
		// Always record level transitions in the log file regardless of threshold so audit trail is clear.
		l.emitUnconditional(LevelInfo, "[Log] Log level changed from %s to %s", prev.Tag(), level.Tag())
	}
}

func inferLevel(msg string, fallback Level) Level {
	upper := strings.ToUpper(msg)
	switch {
	case strings.Contains(upper, "[TRACE]"):
		return LevelTrace
	case strings.Contains(upper, "[DEBUG]"):
		return LevelDebug
	case strings.Contains(upper, "ERROR") || strings.Contains(upper, "FATAL") || strings.Contains(upper, "PANIC"):
		return LevelError
	case strings.Contains(upper, "WARN"):
		return LevelWarn
	default:
		return fallback
	}
}

func (l *Logger) emit(level Level, format string, args ...any) {
	if l == nil || int32(level) < l.minLevel.Load() {
		return
	}
	l.emitUnconditional(level, format, args...)
}

func (l *Logger) emitUnconditional(level Level, format string, args ...any) {
	if l == nil {
		return
	}
	msg := format
	if len(args) > 0 {
		msg = fmt.Sprintf(format, args...)
	}
	msg = strings.TrimRight(msg, "\r\n")
	if msg == "" {
		return
	}

	ts := time.Now().Format("2006-01-02T15:04:05.000Z07:00")
	formatted := fmt.Sprintf("%s [%s] %s", ts, level.Tag(), msg)
	wireLine := formatted + "\n"

	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		return
	}
	l.appendRingLocked(formatted)
	if l.file != nil {
		l.rotateIfNeededLocked(int64(len(wireLine)))
		if l.file != nil {
			if n, err := l.file.WriteString(wireLine); err == nil {
				l.fileSize += int64(n)
			}
		}
	}
	console := l.console
	l.mu.Unlock()

	if console != nil {
		_, _ = io.WriteString(console, wireLine)
	}
	if platformUsesNativeSink {
		writePlatformSink(level, msg)
	}
}

// Tracef logs wire-level / protocol-level trace messages (`TRACE`).
func (l *Logger) Tracef(format string, args ...any) {
	l.emit(LevelTrace, format, args...)
}

// Debugf logs detailed operational diagnostics (`DEBUG`).
func (l *Logger) Debugf(format string, args ...any) {
	l.emit(LevelDebug, format, args...)
}

// Infof logs standard operational lifecycle events (`INFO`).
func (l *Logger) Infof(format string, args ...any) {
	l.emit(LevelInfo, format, args...)
}

// Warnf logs recoverable anomalies or warnings (`WARN`).
func (l *Logger) Warnf(format string, args ...any) {
	l.emit(LevelWarn, format, args...)
}

// Errorf logs errors requiring attention (`ERROR`).
func (l *Logger) Errorf(format string, args ...any) {
	l.emit(LevelError, format, args...)
}

type stdLogBridge struct {
	l *Logger
}

func (b stdLogBridge) Write(p []byte) (int, error) {
	s := strings.TrimRight(string(p), "\r\n")
	if s != "" {
		b.l.emit(inferLevel(s, LevelInfo), "%s", s)
	}
	return len(p), nil
}

// StdLogger returns a `*log.Logger` backed by this `Logger` (with flags=0 so timestamps are not duplicated).
func (l *Logger) StdLogger() *log.Logger {
	if l == nil {
		return log.New(io.Discard, "", 0)
	}
	return log.New(stdLogBridge{l: l}, "", 0)
}

// Path returns the configured on-disk log file path (or `""` if memory-only).
func (l *Logger) Path() string {
	if l == nil {
		return ""
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.filePath
}

// RingCap returns the configured capacity of the in-memory ring buffer.
func (l *Logger) RingCap() int {
	if l == nil {
		return DefaultRingLines
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.ringCap <= 0 {
		return DefaultRingLines
	}
	return l.ringCap
}

// Status returns the current file path, total on-disk (or in-memory) bytes, active level, and buffered line count.
func (l *Logger) Status() Status {
	if l == nil {
		return Status{Level: LevelInfo.String(), Levels: AllLevels}
	}
	l.mu.Lock()
	p := l.filePath
	sz := l.fileSize
	cnt := l.ringLen
	rCap := l.ringCap
	if p == "" {
		sz = 0
		for i := 0; i < l.ringLen; i++ {
			idx := (l.ringPos + i) % l.ringCap
			sz += int64(len(l.ring[idx]) + 1)
		}
	}
	l.mu.Unlock()

	if p != "" {
		var total int64
		if st, err := os.Stat(p); err == nil {
			total += st.Size()
		}
		if st1, err := os.Stat(p + ".1"); err == nil {
			total += st1.Size()
		}
		if total > 0 {
			sz = total
		}
	}
	maxLines := 0
	if p == "" {
		maxLines = rCap
	}
	return Status{
		LogPath:   p,
		SizeBytes: sz,
		Level:     l.Level().String(),
		Levels:    AllLevels,
		LineCount: cnt,
		MaxLines:  maxLines,
	}
}

// Tail returns up to `maxLines` most recent log lines in chronological order.
func (l *Logger) Tail(maxLines int) []string {
	if l == nil {
		return []string{}
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if maxLines <= 0 || maxLines > l.ringLen {
		maxLines = l.ringLen
	}
	if maxLines == 0 {
		return []string{}
	}
	start := l.ringLen - maxLines
	out := make([]string, maxLines)
	for i := 0; i < maxLines; i++ {
		idx := (l.ringPos + start + i) % l.ringCap
		out[i] = l.ring[idx]
	}
	return out
}

// ReadFullText returns the complete chronological log text (`slaprf.log.1` + `slaprf.log` when
// backed by disk, or the buffered ring lines when in-memory).
func (l *Logger) ReadFullText() []byte {
	if l == nil {
		return nil
	}
	l.mu.Lock()
	p := l.filePath
	if l.file != nil {
		_ = l.file.Sync()
	}
	l.mu.Unlock()

	if p != "" {
		var buf bytes.Buffer
		if b1, err := os.ReadFile(p + ".1"); err == nil && len(b1) > 0 {
			buf.Write(b1)
		}
		if b0, err := os.ReadFile(p); err == nil && len(b0) > 0 {
			buf.Write(b0)
		}
		if buf.Len() > 0 {
			return buf.Bytes()
		}
	}
	lines := l.Tail(l.RingCap())
	if len(lines) == 0 {
		return nil
	}
	return []byte(strings.Join(lines, "\n") + "\n")
}

// Clear truncates `slaprf.log`, removes any `.1` rotated file, and resets the ring buffer.
func (l *Logger) Clear() error {
	if l == nil {
		return nil
	}
	l.mu.Lock()
	if l.file != nil {
		_ = l.file.Close()
		l.file = nil
	}
	l.fileSize = 0
	l.ringPos = 0
	l.ringLen = 0
	if l.filePath != "" {
		_ = os.Remove(l.filePath + ".1")
		_ = os.Remove(l.filePath)
		l.openLogFileLocked()
	}
	l.mu.Unlock()

	l.emitUnconditional(LevelInfo, "[Log] Diagnostic log cleared")
	return nil
}

// Close flushes and closes the underlying log file.
func (l *Logger) Close() error {
	if l == nil {
		return nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return nil
	}
	l.closed = true
	if l.file != nil {
		err := l.file.Close()
		l.file = nil
		return err
	}
	return nil
}
