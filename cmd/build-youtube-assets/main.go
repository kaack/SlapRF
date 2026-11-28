// Command build-youtube-assets renders the official SlapRF YouTube channel
// profile avatar (1024x1024 PNG from web/icons/icon.svg) and reframes the
// neon RF wave banner illustration onto a 2560x1440 PNG canvas so both wave
// crests fit cleanly inside YouTube's 1546x423 mobile and 2560x423 desktop
// safe zones.
package main

import (
	"flag"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"log"
	"math"
	"os"
	"path/filepath"

	"github.com/playwright-community/playwright-go"
)

func sampleBilinear(img image.Image, fx, fy float64) (float64, float64, float64) {
	b := img.Bounds()
	w := float64(b.Dx())
	h := float64(b.Dy())
	if fx < 0 {
		fx = 0
	}
	if fx > w-1 {
		fx = w - 1
	}
	if fy < 0 {
		fy = 0
	}
	if fy > h-1 {
		fy = h - 1
	}
	x0 := int(math.Floor(fx))
	y0 := int(math.Floor(fy))
	x1 := x0 + 1
	y1 := y0 + 1
	if x1 >= b.Dx() {
		x1 = b.Dx() - 1
	}
	if y1 >= b.Dy() {
		y1 = b.Dy() - 1
	}
	tx := fx - float64(x0)
	ty := fy - float64(y0)

	c00r, c00g, c00b, _ := img.At(b.Min.X+x0, b.Min.Y+y0).RGBA()
	c10r, c10g, c10b, _ := img.At(b.Min.X+x1, b.Min.Y+y0).RGBA()
	c01r, c01g, c01b, _ := img.At(b.Min.X+x0, b.Min.Y+y1).RGBA()
	c11r, c11g, c11b, _ := img.At(b.Min.X+x1, b.Min.Y+y1).RGBA()

	lerp := func(a, b, t float64) float64 { return a + (b-a)*t }
	r := lerp(lerp(float64(c00r), float64(c10r), tx), lerp(float64(c01r), float64(c11r), tx), ty) / 257.0
	g := lerp(lerp(float64(c00g), float64(c10g), tx), lerp(float64(c01g), float64(c11g), tx), ty) / 257.0
	bl := lerp(lerp(float64(c00b), float64(c10b), tx), lerp(float64(c01b), float64(c11b), tx), ty) / 257.0
	return r, g, bl
}

func clampByte(v float64) uint8 {
	if v <= 0 {
		return 0
	}
	if v >= 255 {
		return 255
	}
	return uint8(math.Round(v))
}

func mapXPiecewise(outX float64, srcW float64) (srcX float64, wingFade float64) {
	const leftInner = 500.0
	const rightInner = 2060.0
	const srcLeftTail = 220.0
	srcRightTail := srcW - 220.0
	innerSlope := (srcRightTail - srcLeftTail) / (rightInner - leftInner)

	if outX >= leftInner && outX <= rightInner {
		t := (outX - leftInner) / (rightInner - leftInner)
		return srcLeftTail + t*(srcRightTail-srcLeftTail), 1.0
	}
	if outX < leftInner {
		u := outX / leftInner
		m0 := 0.12 * srcLeftTail
		m1 := innerSlope * leftInner
		u2 := u * u
		u3 := u2 * u
		h01 := -2*u3 + 3*u2
		h10 := u3 - 2*u2 + u
		h11 := u3 - u2
		sx := h01*srcLeftTail + h10*m0 + h11*m1
		if sx < 0 {
			sx = 0
		}
		fade := 0.22 + 0.78*math.Sin(u*math.Pi*0.5)
		return sx, fade
	}
	u := (2560.0 - outX) / (2560.0 - rightInner)
	span := (srcW - 1.0) - srcRightTail
	m0 := 0.12 * span
	m1 := innerSlope * (2560.0 - rightInner)
	u2 := u * u
	u3 := u2 * u
	h01 := -2*u3 + 3*u2
	h10 := u3 - 2*u2 + u
	h11 := u3 - u2
	distFromRight := h01*span + h10*m0 + h11*m1
	if distFromRight < 0 {
		distFromRight = 0
	}
	fade := 0.22 + 0.78*math.Sin(u*math.Pi*0.5)
	return (srcW - 1.0) - distFromRight, fade
}

func mapYPiecewise(outY float64, srcH float64) (srcY float64, bottomFade float64) {
	const bandTop = 508.0
	const bandBot = 931.0
	const srcWaveTop = 815.0
	srcWaveBot := srcH - 12.0

	if outY < bandTop {
		t := outY / bandTop
		return t * srcWaveTop, 1.0
	}
	if outY <= bandBot {
		t := (outY - bandTop) / (bandBot - bandTop)
		return srcWaveTop + t*(srcWaveBot-srcWaveTop), 1.0
	}
	t := math.Min(1.0, (outY-bandBot)/70.0)
	fade := 0.5 * (1.0 + math.Cos(t*math.Pi))
	return srcWaveBot, fade
}

func subCrop(src *image.NRGBA, r image.Rectangle) *image.NRGBA {
	out := image.NewNRGBA(image.Rect(0, 0, r.Dx(), r.Dy()))
	for y := 0; y < r.Dy(); y++ {
		for x := 0; x < r.Dx(); x++ {
			out.SetNRGBA(x, y, src.NRGBAAt(r.Min.X+x, r.Min.Y+y))
		}
	}
	return out
}

func savePNG(path string, img image.Image) {
	f, err := os.Create(path)
	if err != nil {
		log.Fatalf("[build-youtube-assets] create %s: %v", path, err)
	}
	defer f.Close()
	enc := png.Encoder{CompressionLevel: png.BestCompression}
	if err := enc.Encode(f, img); err != nil {
		log.Fatalf("[build-youtube-assets] encode %s: %v", path, err)
	}
	st, _ := os.Stat(path)
	fmt.Printf("[build-youtube-assets] Wrote %s (%.2f KB)\n", path, float64(st.Size())/1024.0)
}

func main() {
	srcPath := flag.String("source", "./assets/youtube/banner-waves-source.jpg", "Path to source wave illustration JPEG")
	iconSVGPath := flag.String("icon", "./web/icons/icon.svg", "Path to SlapRF circular medallion SVG")
	outDir := flag.String("out", "./assets/youtube", "Output directory for YouTube channel assets")
	flag.Parse()

	if err := os.MkdirAll(*outDir, 0o755); err != nil {
		log.Fatalf("[build-youtube-assets] mkdir %s: %v", *outDir, err)
	}

	inFile, err := os.Open(*srcPath)
	if err != nil {
		log.Fatalf("[build-youtube-assets] open %s: %v", *srcPath, err)
	}
	srcImg, err := jpeg.Decode(inFile)
	inFile.Close()
	if err != nil {
		log.Fatalf("[build-youtube-assets] decode jpeg: %v", err)
	}

	b := srcImg.Bounds()
	srcW := float64(b.Dx())
	srcH := float64(b.Dy())

	const outW = 2560
	const outH = 1440
	banner := image.NewNRGBA(image.Rect(0, 0, outW, outH))

	for y := 0; y < outH; y++ {
		sy, botFade := mapYPiecewise(float64(y), srcH)
		for x := 0; x < outW; x++ {
			sx, wFade1 := mapXPiecewise(float64(x), srcW)
			sx2, wFade2 := mapXPiecewise(float64(x)+0.5, srcW)
			sy2, _ := mapYPiecewise(float64(y)+0.5, srcH)

			r1, g1, b1 := sampleBilinear(srcImg, sx, sy)
			r2, g2, b2 := sampleBilinear(srcImg, sx2, sy)
			r3, g3, b3 := sampleBilinear(srcImg, sx, sy2)
			r4, g4, b4 := sampleBilinear(srcImg, sx2, sy2)

			r := (r1 + r2 + r3 + r4) * 0.25
			g := (g1 + g2 + g3 + g4) * 0.25
			bl := (b1 + b2 + b3 + b4) * 0.25

			totalFade := botFade * ((wFade1 + wFade2) * 0.5)
			if totalFade < 1.0 {
				r = 9.0 + (r-9.0)*totalFade
				g = 11.0 + (g-11.0)*totalFade
				bl = 15.0 + (bl-15.0)*totalFade
			}

			// Deterministic triangular-PDF interleaved gradient noise (±0.85 LSB) eliminates 8-bit dark sky banding
			ignA := math.Mod(52.9829189*math.Mod(0.06711056*float64(x)+0.00583715*float64(y), 1.0), 1.0)
			ignB := math.Mod(52.9829189*math.Mod(0.06711056*float64(x+17)+0.00583715*float64(y+31), 1.0), 1.0)
			dither := (ignA - ignB) * 0.85
			r += dither
			g += dither
			bl += dither

			banner.SetNRGBA(x, y, color.NRGBA{
				R: clampByte(r),
				G: clampByte(g),
				B: clampByte(bl),
				A: 255,
			})
		}
	}

	savePNG(filepath.Join(*outDir, "slaprf-youtube-banner.png"), banner)
	savePNG(filepath.Join(*outDir, "preview-mobile-1546x423.png"), subCrop(banner, image.Rect(507, 508, 2053, 931)))
	savePNG(filepath.Join(*outDir, "preview-desktop-2560x423.png"), subCrop(banner, image.Rect(0, 508, 2560, 931)))

	svgBytes, err := os.ReadFile(*iconSVGPath)
	if err != nil {
		log.Fatalf("[build-youtube-assets] read %s: %v", *iconSVGPath, err)
	}
	pw, err := playwright.Run()
	if err != nil {
		log.Fatalf("[build-youtube-assets] playwright.Run: %v", err)
	}
	defer pw.Stop()
	br, err := pw.Chromium.Launch(playwright.BrowserTypeLaunchOptions{Headless: playwright.Bool(true)})
	if err != nil {
		log.Fatalf("[build-youtube-assets] Chromium.Launch: %v", err)
	}
	defer br.Close()
	page, err := br.NewPage(playwright.BrowserNewPageOptions{
		Viewport:          &playwright.Size{Width: 1024, Height: 1024},
		DeviceScaleFactor: playwright.Float(1),
	})
	if err != nil {
		log.Fatalf("[build-youtube-assets] NewPage: %v", err)
	}
	html := fmt.Sprintf(`<!doctype html><html><head><style>
		html, body { margin:0; padding:0; width:1024px; height:1024px; background:#0b0e14; display:flex; align-items:center; justify-content:center; overflow:hidden; }
		svg { width:1024px; height:1024px; display:block; }
	</style></head><body>%s</body></html>`, string(svgBytes))
	if err := page.SetContent(html); err != nil {
		log.Fatalf("[build-youtube-assets] SetContent: %v", err)
	}
	avatarPath := filepath.Join(*outDir, "slaprf-youtube-avatar.png")
	if _, err := page.Screenshot(playwright.PageScreenshotOptions{
		Path: playwright.String(avatarPath),
	}); err != nil {
		log.Fatalf("[build-youtube-assets] Screenshot avatar: %v", err)
	}
	st, _ := os.Stat(avatarPath)
	fmt.Printf("[build-youtube-assets] Wrote %s (%.2f KB)\n", avatarPath, float64(st.Size())/1024.0)
}
