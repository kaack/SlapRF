/**
 * slaprf_radio — hardware layer shared by every SlapRF firmware profile.
 *
 * Profiles (firmware/<profile>/main/main.c) own the timing design: sweep rate, window size,
 * link choice, filters. This component owns "how do I talk to the XIAO ESP32-C5 hardware":
 * 2.4 GHz Wi-Fi / ESP-NOW, the Hub's UDP bridge to the laptop, sweep pacing, and the 5.8 GHz
 * RSSI measurement.
 */
#pragma once

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ---- Board ---------------------------------------------------------------------------------- */

/** Route the RF switch to the external U.FL antenna (XIAO ESP32-C5). */
void xiao_c5_select_ufl_antenna(void);

/** Battery voltage in mV, or 0 if unknown (the laptop then keeps its last value). */
uint16_t xiao_c5_read_battery_mv(void);

/* ---- 2.4 GHz link --------------------------------------------------------------------------- */

/** Restrict Wi-Fi to 2.4 GHz so the timer never transmits on 5.8 GHz FPV video channels. */
void slaprf_lock_wifi_band_2g4_only(void);

/** Bring up Wi-Fi + ESP-NOW on `channel` (1..13). `long_range` enables Espressif LR 500 kbps. */
void slaprf_init_2g4_radio(uint8_t channel, uint8_t long_range, uint8_t tx_power_qdbm);

/** Hub only: host the "SlapRF" AP (wifi_mode 0) or join `ssid` (wifi_mode 1), then open UDP. */
void slaprf_start_wifi_bridge(uint8_t wifi_mode, const char *ssid, const char *pass);

/** Hub only: send a frame to the laptop (UDP broadcast to port 5404). */
void slaprf_forward_udp_to_laptop(const void *frame, uint32_t len);

/** Hub only: broadcast the sync beacon Spokes align their TDMA slots to. */
void slaprf_broadcast_hub_sync_beacon(uint8_t seq);

/** Spoke only: hop 2.4 GHz channels until the Hub's sync beacon is heard, then stay there. */
void slaprf_spoke_sync_to_hub_channel(void);

/** Spoke only: milliseconds since the last Hub sync beacon (UINT32_MAX if never heard). */
uint32_t slaprf_ms_since_hub_beacon(void);

/** Broadcast an ESP-NOW frame. */
void espnow_send(const void *frame, uint32_t len);

/** Pop one received ESP-NOW frame into `buf` (non-blocking). Returns its length, or 0. */
int espnow_poll(void *buf, uint32_t cap);

/* ---- 5.8 GHz sensing ------------------------------------------------------------------------ */

/**
 * Band power (dBm) around `center_freq_mhz` (5645..5945 MHz) from the C5's 5 GHz receive chain.
 * See slaprf_rf58.c for status.
 */
int8_t esp_sdr_measure_5g_channel_dbm(uint16_t center_freq_mhz);

/* ---- Timing --------------------------------------------------------------------------------- */

/** Block until the next sweep tick (drift-free, `interval_us` apart). */
void slaprf_wait_for_next_sweep_tick(uint32_t interval_us);

/** Busy-wait `us` microseconds (TDMA slot offsets). */
void delay_microseconds(uint32_t us);

/* ---- USB config readback -------------------------------------------------------------------- */

/**
 * Answer "SLAPRF?\n" on the USB serial console with the raw config block, so the web flasher
 * can read the board's fingerprint / role / profile before reflashing.
 */
void slaprf_start_config_query_service(const volatile void *cfg, size_t len);

#ifdef __cplusplus
}
#endif
