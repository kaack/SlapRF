/**
 * slaprf_ble_link: Bluetooth LE transport for the dedicated SlapRF Bluetooth Hub image.
 *
 * GATT service (see docs/ble-hub-protocol.md):
 *   service 5d1a0001-5a7e-4c0b-9e5f-534c41505246
 *   RX      5d1a0002-...  host -> hub console bytes (write / write without response)
 *   TX      5d1a0003-...  hub -> host byte stream (notify), same bytes as the USB serial port
 *
 * The link also estimates the phase of the BLE connection events against the Hub's 100 Hz sweep
 * grid, so the main loop can shift its sweeps until every connection event lands in the 2.4 GHz gap
 * between sweeps (the radio can only be on one band at a time).
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef void (*slaprf_ble_rx_cb_t)(const uint8_t *data, size_t len);
typedef void (*slaprf_ble_event_cb_t)(bool connected);

typedef struct {
    bool     connected;
    uint32_t interval_us;   // Negotiated connection interval (0 when disconnected)
    uint16_t mtu;           // Negotiated ATT MTU
    uint8_t  phy;           // 1 = LE 1M, 2 = LE 2M, 3 = Coded
    uint32_t tx_notifies;   // Notifications handed to the stack
    uint32_t tx_bytes;
    uint32_t tx_drops;      // Bytes dropped because the TX buffer was full
    uint32_t rx_writes;
    uint32_t nocp_events;   // Controller "completed packets" events seen (phase-lock samples)
    bool     sync_enabled;  // Phase lock to connection events enabled (BLESYNC 1/0)
    bool     sync_locked;   // Connection events sit in the gap between sweeps
    int32_t  phase_us;      // Measured event phase relative to the sweep start (-1 when unknown)
    uint32_t connects;
    int8_t   rssi;          // Last read connection RSSI (0 when unknown)
} slaprf_ble_stats_t;

/**
 * Start NimBLE, register the SlapRF service and begin advertising as "SlapRF <label>".
 * `on_rx` runs in a dedicated low-priority task (never in the NimBLE host task), so it may block.
 */
void slaprf_ble_link_start(const char *label, uint32_t fingerprint, uint8_t role, const uint8_t fw_version[3],
                           slaprf_ble_rx_cb_t on_rx, slaprf_ble_event_cb_t on_event);

/** True while a central is connected and has enabled TX notifications. */
bool slaprf_ble_ready(void);

/**
 * Queue bytes for the TX characteristic. Returns the number of bytes accepted (may be short when the
 * buffer is full and `timeout_ms` elapsed). Returns 0 immediately when no central is subscribed.
 */
size_t slaprf_ble_write(const void *data, size_t len, uint32_t timeout_ms);

/** Snapshot of link counters for STATUS?. */
void slaprf_ble_get_stats(slaprf_ble_stats_t *out);

/** Enable or disable the sweep phase lock (console BLESYNC 1/0). */
void slaprf_ble_set_sync_enabled(bool on);

/**
 * True while the main loop should leave the radio on 2.4 GHz (skip 5.8 GHz sweeps briefly,
 * typically 100..250 ms) so initial connect, connection-interval updates, or any stalled anchor can
 * measure clean BLE connection-event timestamps and jump into the inter-sweep gap.
 */
bool slaprf_ble_needs_radio_free(void);

/**
 * Called by the main loop once per superframe with the start time of the first sweep of the
 * superframe that just finished. Returns the number of microseconds the next superframe should be
 * shifted (positive = later) to keep connection events in the gap. `sweep_interval_us` is the sweep
 * period, `target_phase_us` is where (after a sweep start) the end of a connection event should sit.
 */
int32_t slaprf_ble_sync_adjust_us(int64_t superframe_start_us, uint32_t sweep_interval_us, uint32_t target_phase_us);

/**
 * Console side (slaprf_ble_console.c): start the BLE link with this board's label, fingerprint and
 * version from the SLAPRF02 block. Call after slaprf_diag_start() and after the Wi-Fi driver is up.
 */
void slaprf_ble_console_start_link(void);

#ifdef __cplusplus
}
#endif
