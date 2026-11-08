/**
 * 5.8 GHz band-power measurement on the ESP32-C5's 5 GHz receive chain.
 *
 * STATUS: placeholder. Returns the noise floor so the rest of the pipeline (sweeps, windows,
 * TDMA, Hub bridge, laptop ingest) can be built and tested end to end.
 *
 * How it can actually be done (see firmware/README.md for sources):
 *   - The C5's Wi-Fi modem has an undocumented debug path that exposes raw baseband I/Q samples
 *     from the receiver ADC, bypassing the 802.11 MAC/PHY decoders (ESPARGOS "esp-sdr",
 *     h0m3us3r). On the C5 the synthesizer can be tuned across ~4.8-6.0 GHz, which covers every
 *     analog FPV band including Raceband R8 (5917 MHz) above the 5 GHz Wi-Fi channel plan.
 *   - FPVGateC5MK / FPVGateC5RX (Louis Hitchcock) use this to replace RX5808 modules: retune the
 *     LO to each pilot's frequency, capture a short I/Q burst, and compute band power over the
 *     ~10 MHz around the carrier. They hop 8 pilots at ~1 kHz each and hardware-timestamp every
 *     reading.
 *
 * To implement here: port the tune + I/Q capture + band-power routine from one of those
 * projects (check its license first), keeping this function's contract:
 *   - tune to `center_freq_mhz`, settle, capture N I/Q samples, return 10*log10(mean(I²+Q²))
 *     calibrated to dBm, clamped to int8.
 *
 * Coexistence caveat: the C5 has one radio. While it is parked on 5.8 GHz in debug mode it is
 * deaf on 2.4 GHz, so sweeps and 2.4 GHz TX/RX must be time-sliced (the profile's TDMA slots).
 * A Hub that must also hold a Wi-Fi association (station mode) will miss AP beacons while
 * sweeping; FPVGate sidesteps this by pairing the C5 (pure receiver) with an S3 over UART that
 * owns Wi-Fi. If time-slicing proves unreliable, the same split (C5 sensor + second MCU for
 * the laptop link) is the fallback.
 */
#include "slaprf_radio.h"

int8_t esp_sdr_measure_5g_channel_dbm(uint16_t center_freq_mhz) {
    (void)center_freq_mhz;
    return -95;
}
