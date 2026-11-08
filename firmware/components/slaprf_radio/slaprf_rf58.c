/**
 * 5.8 GHz band-power measurement on the ESP32-C5's 5 GHz receive chain.
 *
 * STATUS: placeholder. Returns the noise floor so the rest of the pipeline (sweeps, windows,
 * TDMA, Hub bridge, laptop ingest) can be built and tested end to end.
 *
 * The method (PHY ADC dump via librftest `adctrig`, PLL-only hops, forced gain, band power over
 * ~10 MHz with the LO 10 MHz below the pilot; 5180-5917 MHz) and the licensing constraints
 * (esp-sdr is GPL-3.0, FPVGateC5MK/RX are CC BY-NC-SA) are summarised in firmware/README.md,
 * "5.8 GHz sensing on the C5". Implement from documented facts, not by copying their code.
 *
 * Contract: tune to `center_freq_mhz`, capture, return band power calibrated to dBm, clamped to
 * int8.
 *
 * Coexistence caveat: none of the reference projects transmits while scanning; they keep Wi-Fi
 * in NULL mode, disable PLL tracking and reserve a 128 KiB SRAM bank for the capture engine.
 * Time-slicing that with ESP-NOW / the Hub's Wi-Fi bridge on one C5 is unproven.
 */
#include "slaprf_radio.h"

int8_t esp_sdr_measure_5g_channel_dbm(uint16_t center_freq_mhz) {
    (void)center_freq_mhz;
    return -95;
}
