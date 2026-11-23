package applog

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoggerLevelsRollingAndClear(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "slaprf.log")
	var console bytes.Buffer

	lg := New(Options{
		FilePath:     logPath,
		MaxFileBytes: 750, // Small threshold to exercise single .1 rotation across 12 lines
		RingLines:    10,
		Console:      &console,
		Level:        LevelInfo,
		HasLevel:     true,
	})
	defer lg.Close()

	lg.Infof("server started on 127.0.0.1:8090")
	lg.Debugf("hidden debug line")
	lg.Tracef("hidden trace line")
	if strings.Contains(console.String(), "hidden") {
		t.Fatalf("expected DEBUG/TRACE suppressed at INFO level, got %q", console.String())
	}

	lg.SetLevel(LevelDebug)
	lg.Tracef("still hidden trace at DEBUG")
	if strings.Contains(console.String(), "still hidden trace") {
		t.Fatalf("expected TRACE suppressed at DEBUG level")
	}

	lg.SetLevel(LevelTrace)
	for i := 0; i < 12; i++ {
		lg.Tracef("wire frame trace %02d with payload", i)
	}

	if _, err := os.Stat(logPath + ".1"); err != nil {
		t.Fatalf("expected rotated %s.1 after exceeding MaxFileBytes: %v", logPath, err)
	}

	st := lg.Status()
	if st.Level != "trace" || st.LogPath != logPath || st.SizeBytes <= 0 || st.LineCount != 10 {
		t.Fatalf("unexpected Status(): %+v", st)
	}

	tail := lg.Tail(3)
	if len(tail) != 3 || !strings.Contains(tail[2], "trace 11") {
		t.Fatalf("unexpected Tail(3): %+v", tail)
	}

	full := string(lg.ReadFullText())
	if !strings.Contains(full, "trace 00") || !strings.Contains(full, "trace 11") {
		t.Fatalf("expected ReadFullText to span .1 and active log, got len=%d:\n%s", len(full), full)
	}

	if err := lg.Clear(); err != nil {
		t.Fatalf("Clear: %v", err)
	}
	if _, err := os.Stat(logPath + ".1"); !os.IsNotExist(err) {
		t.Fatalf("expected .1 backup removed on Clear")
	}
	afterClear := lg.Tail(10)
	if len(afterClear) != 1 || !strings.Contains(afterClear[0], "Diagnostic log cleared") {
		t.Fatalf("unexpected lines after Clear: %+v", afterClear)
	}
}
