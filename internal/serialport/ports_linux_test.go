//go:build linux && !android && !js

package serialport

import (
	"os"
	"strings"
	"testing"
)

func TestFormatLinuxSerialOpenError(t *testing.T) {
	err := formatLinuxSerialOpenError("/dev/ttyACM0", os.ErrPermission)
	if err == nil || !strings.Contains(err.Error(), "dialout") {
		t.Fatalf("expected dialout hint in error, got %v", err)
	}
}
