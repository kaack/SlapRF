package firmware

// SlapRF ships one firmware (firmware/slaprf) with one tuned configuration: every timer, Hub or
// Spoke, runs the same compiled image; only the SLAPRF02 config block differs per board.

const (
	// ImageName is the merged ESP-IDF flash image (bootloader + partition table + app) built from
	// firmware/slaprf and served to the browser flasher as web/firmware/<ImageName>.
	ImageName = "slaprf-xiao-c5.bin"

	// SweepHz is the 5.8 GHz sweep rate compiled into the firmware (SWEEP_HZ in main.c).
	SweepHz = 100

	// MaxWindowSamples bounds the sliding-window frame size the laptop ingest accepts.
	MaxWindowSamples = 6
)
