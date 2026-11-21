// Command build-docs bundles the standalone Docs WebSerial Flasher (`docs-flasher.js` + `docs-flasher.css`),
// stages the compiled XIAO ESP32-C5 firmware `.bin` images into `docs-site/static/firmware/`,
// and optionally runs Hugo to emit static documentation HTML into `-out`.
package main

import (
	"flag"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"slaprf/internal/devbundle"
	"slaprf/internal/firmware"
)

func main() {
	webDir := flag.String("web", "./web", "Source web directory")
	docsDir := flag.String("docs", "./docs-site", "Hugo documentation source directory")
	outDir := flag.String("out", "", "Optional output directory for `hugo --destination` (e.g. ./_site/docs)")
	baseURL := flag.String("base-url", "/docs/", "Base URL passed to Hugo when -out is set")
	skipFirmware := flag.Bool("skip-firmware", false, "Omit duplicate firmware/*.bin inside -out when /firmware is already served at site root")
	flag.Parse()

	log.SetFlags(log.LstdFlags)

	jsDir := filepath.Join(*docsDir, "static", "js")
	fwDir := filepath.Join(*docsDir, "static", "firmware")
	if err := os.MkdirAll(jsDir, 0o755); err != nil {
		log.Fatalf("[build-docs] mkdir %s: %v", jsDir, err)
	}
	if err := os.MkdirAll(fwDir, 0o755); err != nil {
		log.Fatalf("[build-docs] mkdir %s: %v", fwDir, err)
	}

	flasherJS, err := devbundle.BundleDocsFlasher(*webDir)
	if err != nil {
		log.Fatalf("[build-docs] bundle docs_flasher.ts failed: %v", err)
	}
	jsPath := filepath.Join(jsDir, "docs-flasher.js")
	if err := os.WriteFile(jsPath, flasherJS, 0o644); err != nil {
		log.Fatalf("[build-docs] write %s: %v", jsPath, err)
	}
	log.Printf("[build-docs] Bundled %s (%d bytes)", jsPath, len(flasherJS))

	flasherCSS := buildShadowFlasherCSS(*webDir, *docsDir)
	cssPath := filepath.Join(jsDir, "docs-flasher.css")
	if err := os.WriteFile(cssPath, []byte(flasherCSS), 0o644); err != nil {
		log.Fatalf("[build-docs] write %s: %v", cssPath, err)
	}
	log.Printf("[build-docs] Built %s (%d bytes)", cssPath, len(flasherCSS))

	if !*skipFirmware {
		usbSrc := filepath.Join(*webDir, "firmware", firmware.ImageName)
		usbDst := filepath.Join(fwDir, firmware.ImageName)
		if _, err := os.Stat(usbSrc); err == nil {
			mustCopy(usbSrc, usbDst)
			log.Printf("[build-docs] Staged %s", firmware.ImageName)
		} else {
			if err := os.WriteFile(usbDst, firmware.SyntheticBase(), 0o644); err != nil {
				log.Fatalf("[build-docs] write placeholder %s: %v", usbDst, err)
			}
			log.Printf("[build-docs] Staged synthetic placeholder %s", firmware.ImageName)
		}

		bleSrc := filepath.Join(*webDir, "firmware", firmware.BLEImageName)
		if _, err := os.Stat(bleSrc); err == nil {
			mustCopy(bleSrc, filepath.Join(fwDir, firmware.BLEImageName))
			log.Printf("[build-docs] Staged %s", firmware.BLEImageName)
		}
	}

	if *outDir != "" {
		absOut, err := filepath.Abs(*outDir)
		if err != nil {
			absOut = *outDir
		}
		cmd := exec.Command("hugo", "--source", *docsDir, "--destination", absOut, "--baseURL", *baseURL)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		if err := cmd.Run(); err != nil {
			log.Fatalf("[build-docs] hugo build failed: %v", err)
		}
		if *skipFirmware {
			_ = os.RemoveAll(filepath.Join(absOut, "firmware"))
		}
		log.Printf("[build-docs] Built Hugo docs into %s", absOut)
	}
}

func buildShadowFlasherCSS(webDir, docsDir string) string {
	appStyleFiles := []string{"tokens.css", "base.css", "components.css", "layout.css", "views.css"}
	var sb strings.Builder
	for _, name := range appStyleFiles {
		raw, err := os.ReadFile(filepath.Join(webDir, "styles", name))
		if err != nil {
			log.Fatalf("[build-docs] read style %s: %v", name, err)
		}
		s := string(raw)
		s = strings.ReplaceAll(s, ":root {", ":host, .docs-flasher-theme-root {")
		s = strings.ReplaceAll(s, `html[data-theme="light"]`, `.docs-flasher-theme-root[data-theme="light"]`)
		sb.WriteString(s)
		sb.WriteString("\n")
	}

	modalCSSPath := filepath.Join(docsDir, "assets", "css", "docs-flasher-modal.css")
	modalCSS, err := os.ReadFile(modalCSSPath)
	if err != nil {
		log.Fatalf("[build-docs] read modal style %s: %v", modalCSSPath, err)
	}
	sb.Write(modalCSS)
	sb.WriteString("\n")
	return sb.String()
}

func mustCopy(src, dst string) {
	in, err := os.Open(src)
	if err != nil {
		log.Fatalf("open %s: %v", src, err)
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		log.Fatalf("create %s: %v", dst, err)
	}
	defer out.Close()
	if _, err := io.Copy(out, in); err != nil {
		log.Fatalf("copy %s -> %s: %v", src, dst, err)
	}
}
