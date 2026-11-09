/**
 * slaprf_radio — hardware layer shared by every SlapRF firmware profile.
 *
 * Profiles (firmware/<profile>/main/main.c) own the timing design: sweep rate, window size,
 * link choice, filters. This component owns "how do I talk to the XIAO ESP32-C5 hardware":
 * 2.4 GHz Wi-Fi / ESP-NOW, the Hub's UDP bridge to the laptop, sweep pacing, and the 5.8 GHz
 * RSSI measurement.
 */
#pragma once

#include <stdbool.h>
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
 * Prepare the 5 GHz raw-capture engine (forced gain, band calibration, boot capture check).
 * Call once after slaprf_init_2g4_radio(). Returns false if the boot capture check failed.
 */
bool slaprf_rf58_init(void);

/** Leave the 2.4 GHz link for a sweep: transmitter off, radio onto the 5 GHz band. */
void slaprf_rf58_enter(void);

/**
 * Band power (dBm, ~10 MHz around the carrier) at `center_freq_mhz` (5180..5917 MHz).
 * Only valid between slaprf_rf58_enter() and slaprf_rf58_leave().
 */
int8_t esp_sdr_measure_5g_channel_dbm(uint16_t center_freq_mhz);

/** Return to the 2.4 GHz link channel and re-enable the transmitter. */
void slaprf_rf58_leave(void);

/* ---- Timing --------------------------------------------------------------------------------- */

/** Microseconds since boot. */
int64_t slaprf_now_us(void);

/** Sleep (then spin for the last ~1.5 ms) until `t_us`; returns immediately if it has passed. */
void slaprf_sleep_until_us(int64_t t_us);

/** Spoke only: boot time (us) of the last Hub sync beacon heard, or 0. */
int64_t slaprf_last_hub_beacon_us(void);

/** Block until the next sweep tick (drift-free, `interval_us` apart). */
void slaprf_wait_for_next_sweep_tick(uint32_t interval_us);

/** Busy-wait `us` microseconds (TDMA slot offsets). */
void delay_microseconds(uint32_t us);

/* ---- USB debug console (web app Debug page) ---------------------------------------------- */

/**
 * Start the USB console: answers the flasher's "SLAPRF?" with the raw config block and serves
 * the Debug page (STATUS?, LIVE, SCAN, LOG, REBOOT; see slaprf_diag.c).
 */
void slaprf_diag_start(const volatile void *cfg, size_t len, uint8_t sweep_hz);

/** Legacy name for slaprf_diag_start() with a 50 Hz sweep rate. */
void slaprf_start_config_query_service(const volatile void *cfg, size_t len);

/** Report one finished sweep (8 channel readings and its duration) for STATUS? / LIVE. */
void slaprf_diag_sweep(const int8_t *dbm, uint32_t took_us);

/** Report the profile's per-sweep time budget (us) so the Debug page can check sweep timing. */
void slaprf_diag_set_sweep_budget(uint32_t budget_us);

/** Report the TDMA slot this timer is using (1 = Hub). */
void slaprf_diag_set_slot(uint8_t slot);

/** Run a pending SCAN (call from the main loop while the timer is on its 2.4 GHz gap). */
void slaprf_diag_service(void);

/** Active frequency for channel index: the Debug page's temporary table (CHANNELS) if set, else configured. */
uint16_t slaprf_diag_channel_mhz(int index, uint16_t configured);

/** False while the Debug page has switched the 5.8 GHz receiver off (RF 0). */
bool slaprf_diag_rf_enabled(void);

/**
 * Debug page continuous scan ("SCAN LIVE"): when active, measures the next chunk of the band
 * within `budget_us` and returns true; the caller then skips its pilot channels (readings -127).
 * Returns false (and does nothing) when no live scan is running.
 */
bool slaprf_diag_scan_live_step(uint32_t budget_us);

/** 5.8 GHz boot-check results for STATUS?. */
void slaprf_rf58_info(bool *ok, int *gain, int *gain_max, float *floor_db);
#ifdef __cplusplus
}
#endif
