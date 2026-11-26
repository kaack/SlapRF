package main

import (
	"image"
	"image/color"
	"image/png"
	"math"
	"os"
	"path/filepath"
)

// renderSlapRFIcon renders an opaque square iOS AppIcon (4x supersampled) matching web/icons/icon.svg.
// Apple requires iOS app icons to contain zero alpha transparency (alpha = 255 everywhere).
func renderSlapRFIcon(size int) *image.RGBA {
	if size <= 0 {
		size = 1024
	}
	const ss = 4
	img := image.NewRGBA(image.Rect(0, 0, size, size))

	for py := 0; py < size; py++ {
		for px := 0; px < size; px++ {
			var rSum, gSum, bSum float64
			for sy := 0; sy < ss; sy++ {
				for sx := 0; sx < ss; sx++ {
					u := (float64(px) + (float64(sx)+0.5)/float64(ss)) / float64(size) * 512.0
					v := (float64(py) + (float64(sy)+0.5)/float64(ss)) / float64(size) * 512.0
					cr, cg, cb := sampleIcon512(u, v)
					rSum += cr
					gSum += cg
					bSum += cb
				}
			}
			inv := 1.0 / float64(ss*ss)
			img.SetRGBA(px, py, color.RGBA{
				R: clampByte(rSum * inv),
				G: clampByte(gSum * inv),
				B: clampByte(bSum * inv),
				A: 255,
			})
		}
	}
	return img
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

func blendRGB(br, bg, bb, fr, fg, fb, alpha float64) (float64, float64, float64) {
	if alpha <= 0 {
		return br, bg, bb
	}
	if alpha >= 1 {
		return fr, fg, fb
	}
	inv := 1.0 - alpha
	return br*inv + fr*alpha, bg*inv + fg*alpha, bb*inv + fb*alpha
}

func distPointToSegment(px, py, ax, ay, bx, by float64) float64 {
	vx, vy := bx-ax, by-ay
	wx, wy := px-ax, py-ay
	c1 := wx*vx + wy*vy
	if c1 <= 0 {
		return math.Hypot(px-ax, py-ay)
	}
	c2 := vx*vx + vy*vy
	if c2 <= c1 {
		return math.Hypot(px-bx, py-by)
	}
	t := c1 / c2
	projX := ax + t*vx
	projY := ay + t*vy
	return math.Hypot(px-projX, py-projY)
}

// distToArcDeg returns the shortest distance from (px, py) to a circular arc centered at (cx, cy)
// with radius rad sweeping clockwise from startDeg to endDeg (0 deg = +X right, 90 deg = +Y down).
func distToArcDeg(px, py, cx, cy, rad, startDeg, endDeg float64) float64 {
	dx, dy := px-cx, py-cy
	ang := math.Atan2(dy, dx) * 180.0 / math.Pi
	if ang < 0 {
		ang += 360.0
	}
	span := endDeg - startDeg
	if span < 0 {
		span += 360.0
	}
	rel := ang - startDeg
	if rel < 0 {
		rel += 360.0
	}
	for rel >= 360.0 {
		rel -= 360.0
	}
	if rel <= span {
		return math.Abs(math.Hypot(dx, dy) - rad)
	}
	sRad := startDeg * math.Pi / 180.0
	eRad := endDeg * math.Pi / 180.0
	sx, sy := cx+rad*math.Cos(sRad), cy+rad*math.Sin(sRad)
	ex, ey := cx+rad*math.Cos(eRad), cy+rad*math.Sin(eRad)
	return math.Min(math.Hypot(px-sx, py-sy), math.Hypot(px-ex, py-ey))
}

func sampleIcon512(x, y float64) (float64, float64, float64) {
	// Base dark obsidian canvas (#0B0C0F)
	r, g, b := 11.0, 12.0, 15.0

	// Drop shadow circle (cx=256, cy=260, r=238, #07090e @ 0.88)
	if math.Hypot(x-256.0, y-260.0) <= 238.0 {
		r, g, b = blendRGB(r, g, b, 7.0, 9.0, 14.0, 0.88)
	}

	// Outer metallic bezel (cx=256, cy=256, r=234, #263042)
	dCenter := math.Hypot(x-256.0, y-256.0)
	if dCenter <= 234.0 {
		r, g, b = 38.0, 48.0, 66.0
	}

	// Top highlight rim arc (#475878, stroke-width 10, ~211.7 deg to 328.3 deg)
	if dTopArc := distToArcDeg(x, y, 256.0, 256.0, 234.0, 211.7, 328.3); dTopArc <= 5.0 {
		r, g, b = 71.0, 88.0, 120.0
	}

	// Inner dial face (r=217, #10141d)
	if dCenter <= 217.0 {
		r, g, b = 16.0, 20.0, 29.0
	}

	// Subtle inner ring (r=209, stroke-width 5.5, #1e2636)
	if math.Abs(dCenter-209.0) <= 2.75 {
		r, g, b = 30.0, 38.0, 54.0
	}

	// Gauge & RF waves in SVG local space: translate(92, 76) scale(13.7)
	gx := (x - 92.0) / 13.7
	gy := (y - 76.0) / 13.7
	halfStroke := 2.35 * 0.5

	// White gauge arc: center (10.5, 13.5), r=8.2, from 20 deg to 290 deg (#eef2f7)
	if distToArcDeg(gx, gy, 10.5, 13.5, 8.2, 20.0, 290.0) <= halfStroke {
		r, g, b = 238.0, 242.0, 247.0
	}

	// Center pivot dot (cx=10.5, cy=13.5, r=1.95) & needle to (15.2, 9.8) (#eef2f7)
	if math.Hypot(gx-10.5, gy-13.5) <= 1.95 || distPointToSegment(gx, gy, 10.5, 13.5, 15.2, 9.8) <= halfStroke {
		r, g, b = 238.0, 242.0, 247.0
	}

	// Inner RF wave: center (10.5, 13.5), r=8.2, from 310 deg to 360 deg (#d4ff3a)
	if distToArcDeg(gx, gy, 10.5, 13.5, 8.2, 310.0, 360.0) <= halfStroke {
		r, g, b = 212.0, 255.0, 58.0
	}

	// Outer RF wave: center (10.5, 13.5), r=11.6, from 308 deg to 2 deg (#d4ff3a @ 0.78)
	if distToArcDeg(gx, gy, 10.5, 13.5, 11.6, 308.0, 362.0) <= halfStroke {
		r, g, b = blendRGB(r, g, b, 212.0, 255.0, 58.0, 0.78)
	}

	return r, g, b
}

func writeIconPNG(path string, size int) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	img := renderSlapRFIcon(size)
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return png.Encode(f, img)
}
