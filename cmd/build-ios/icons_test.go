package main

import (
	"archive/zip"
	"bytes"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRenderSlapRFIconOpaqueAndNonBlank(t *testing.T) {
	img := renderSlapRFIcon(180)
	if img.Bounds().Dx() != 180 || img.Bounds().Dy() != 180 {
		t.Fatalf("unexpected bounds: %v", img.Bounds())
	}
	hasLime := false
	hasDialWhite := false
	for y := 0; y < 180; y++ {
		for x := 0; x < 180; x++ {
			c := img.RGBAAt(x, y)
			if c.A != 255 {
				t.Fatalf("expected opaque pixel at (%d,%d), got alpha=%d", x, y, c.A)
			}
			if c.G > 230 && c.R > 180 && c.B < 100 {
				hasLime = true
			}
			if c.R > 220 && c.G > 220 && c.B > 220 {
				hasDialWhite = true
			}
		}
	}
	if !hasLime || !hasDialWhite {
		t.Fatalf("expected rendered SlapRF icon to contain lime RF wave (%v) and white gauge (%v)", hasLime, hasDialWhite)
	}
}

func TestRenderInfoPlistAndZipIPAPermissions(t *testing.T) {
	tmpl, err := os.ReadFile(filepath.Join("..", "..", "ios", "Info.plist"))
	if err != nil {
		t.Fatalf("read ios/Info.plist: %v", err)
	}
	rendered := renderInfoPlist(string(tmpl), "app.slaprf.timer", "0.0.20", "20")
	for _, want := range []string{
		"<string>app.slaprf.timer</string>",
		"<string>0.0.20</string>",
		"<string>20</string>",
		"<string>bluetooth-central</string>",
		"<string>audio</string>",
		"NSBluetoothAlwaysUsageDescription",
		"NSLocalNetworkUsageDescription",
	} {
		if !strings.Contains(rendered, want) {
			t.Fatalf("rendered Info.plist missing %q", want)
		}
	}
	if strings.Contains(rendered, "$(PRODUCT_BUNDLE_IDENTIFIER)") {
		t.Fatalf("expected $(PRODUCT_BUNDLE_IDENTIFIER) placeholder to be replaced")
	}

	tmpDir := t.TempDir()
	appDir := filepath.Join(tmpDir, "Payload", "SlapRF.app")
	if err := os.MkdirAll(appDir, 0o755); err != nil {
		t.Fatal(err)
	}
	exePath := filepath.Join(appDir, "SlapRF")
	if err := os.WriteFile(exePath, []byte("mach-o-binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(appDir, "Info.plist"), []byte(rendered), 0o644); err != nil {
		t.Fatal(err)
	}

	ipaPath := filepath.Join(tmpDir, "slaprf-ios-arm64.ipa")
	if err := packageIPA(filepath.Join(tmpDir, "Payload"), ipaPath); err != nil {
		t.Fatalf("packageIPA: %v", err)
	}

	raw, err := os.ReadFile(ipaPath)
	if err != nil {
		t.Fatal(err)
	}
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		t.Fatal(err)
	}
	foundExe := false
	for _, f := range zr.File {
		if f.Name == "Payload/SlapRF.app/SlapRF" {
			foundExe = true
			if f.Mode()&0o111 == 0 {
				t.Fatalf("expected executable bit on Payload/SlapRF.app/SlapRF, mode=%v", f.Mode())
			}
			rc, err := f.Open()
			if err != nil {
				t.Fatal(err)
			}
			b, _ := io.ReadAll(rc)
			rc.Close()
			if string(b) != "mach-o-binary" {
				t.Fatalf("unexpected binary payload: %q", string(b))
			}
		}
	}
	if !foundExe {
		t.Fatalf("Payload/SlapRF.app/SlapRF missing from .ipa")
	}
}
