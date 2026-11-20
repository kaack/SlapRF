/**
 * SlapRF Bluetooth Hub firmware for the Seeed XIAO ESP32-C5 (dedicated BLE image).
 *
 * The Hub measures its own gate (8 pilot channels, 100 Hz) and talks to the phone or laptop over
 * Bluetooth LE instead of USB. Phase 1 is a single-gate Hub: no Spokes, no ESP-NOW traffic.
 *
 * The frames and console are byte-for-byte the same as the USB Hub's (0xC5 0x60 window frames,
 * HELLO, STATUS? ...), so the app's decoder and Debug page work unchanged. Keep the frame layouts in
 * sync with firmware/slaprf/main/main.c, internal/ingest/hub_frames.go and docs/ble-hub-protocol.md.
 *
 * One radio, time-sliced against Bluetooth:
 *   The C5 has a single radio. During a sweep it sits on 5.8 GHz with the transmitter off, so a BLE
 *   connection event that fell inside a sweep would be lost (and would disturb the sweep). The Hub
 *   asks the central for a 10 ms connection interval (or 20 / 30 ms), measures where connection
 *   events land relative to its sweeps, and shifts its sweep schedule until every event sits in the
 *   ~3 ms gap after a sweep:
 *
 *     |<--------------- 10 ms sweep interval --------------->|
 *     [ sweep: 5.8 GHz, <= SWEEP_BUDGET_US ][ gap: BLE event  ]
 *
 *   Sample timestamps stay uniform: the host rebuilds them from the 8-bit sweep sequence number, and
 *   phase corrections are at most a few hundred microseconds once locked.
 */

#include <stdint.h>
#include <string.h>

#include "esp_event.h"
#include "esp_log.h"
#include "esp_wifi.h"
#include "nvs_flash.h"
#include "soc/soc_caps.h"
#include "slaprf_ble_link.h"
#include "slaprf_radio.h"

/* ---- Tuning ------------------------------------------------------------------------------ */
#define SWEEP_HZ           100   // 8-channel 5.8 GHz sweeps per second
#define WINDOW_SAMPLES     4     // Sweeps per window frame
#define TX_EVERY_SWEEPS    2     // 4 / 2 = every sweep delivered twice
#define SWEEP_BUDGET_US    6600  // Radio away from 2.4 GHz per sweep (5 passes take ~5.4 ms; leaves 3.4 ms gap)
#define BLE_EVENT_END_US   8600  // Target end of a BLE connection event, centered in the [6.6..10.0 ms] gap

/* ---- Schedule (derived) ------------------------------------------------------------------- */
#define SWEEP_INTERVAL_US  (1000000UL / SWEEP_HZ)
#define SUPERFRAME_US      (TX_EVERY_SWEEPS * SWEEP_INTERVAL_US)

_Static_assert(WINDOW_SAMPLES >= TX_EVERY_SWEEPS, "window must cover every sweep since the last send");
_Static_assert(BLE_EVENT_END_US > SWEEP_BUDGET_US && BLE_EVENT_END_US < SWEEP_INTERVAL_US,
               "BLE events must end inside the gap after a sweep");

/* ---- Shared protocol (identical to the USB image) ----------------------------------------- */
#define MAX_PILOT_SLOTS    8
#define FRAME_MAGIC_0      0xC5
#define FRAME_MAGIC_HELLO  0x5A
#define FRAME_MAGIC_WINDOW 0x60
#define ROLE_HUB_TIMER     1
#define HUB_SLOT           1
#define WIFI_CHANNEL       1
#define HELLO_REPEAT_US    2000000

static const char *TAG = "slaprf_ble";

#pragma pack(push, 1)
/** 160-byte SLAPRF02 config block: layout mirrored in internal/firmware/image.go. */
typedef struct {
    char     magic[8];                        // "SLAPRF02"
    uint8_t  version[3];                      // major, minor, patch
    uint8_t  role;                            // Always ROLE_HUB_TIMER for this image
    uint8_t  reserved0;
    uint8_t  wifi_mode;
    uint32_t fingerprint;
    uint16_t slot_freqs_mhz[MAX_PILOT_SLOTS];
    char     wifi_ssid[33];
    char     wifi_pass[40];
    char     timer_label[24];
    uint8_t  reserved[28];
    uint8_t  crc8;
} slaprf_flash_config_t;

typedef struct {
    uint8_t seq_num;
    uint8_t rssi_half_dbm[MAX_PILOT_SLOTS]; // 0 = disabled, 1..255 => -127.5 + 0.5 * code dBm
} raw_rssi_sample_t;

typedef struct {
    uint8_t           magic0;                 // 0xC5
    uint8_t           magic1;                 // 0x60
    uint8_t           slot;                   // 1 = Hub
    uint8_t           sample_count;           // 1..WINDOW_SAMPLES (oldest -> newest)
    uint16_t          battery_mv;
    int8_t            noise_floor_dbm;
    raw_rssi_sample_t samples[WINDOW_SAMPLES];
    uint8_t           crc8_room;
} timer_window_frame_t;

typedef struct {
    uint8_t  magic0, magic1;                  // 0xC5 0x5A
    uint8_t  slot;
    uint8_t  role;
    uint32_t fingerprint;
    uint8_t  reserved0;
    uint8_t  sweep_hz;
    char     timer_label[24];
    uint8_t  reserved;
    uint8_t  crc8;
} hub_hello_frame_t;                          // 36 bytes
#pragma pack(pop)

// Patched by internal/firmware/image.go (server) or esp_flasher.ts (browser) at flash time.
__attribute__((used, section(".rodata.slaprf_cfg")))
static const volatile slaprf_flash_config_t g_flash_cfg = {
    .magic          = {'S', 'L', 'A', 'P', 'R', 'F', '0', '2'},
    .version        = {0, 1, 7},
    .role           = ROLE_HUB_TIMER,
    .wifi_mode      = 0,
    .fingerprint    = 1,
    .slot_freqs_mhz = {5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917},
};

static uint8_t compute_crc8(const uint8_t *data, uint32_t len) {
    uint8_t crc = 0;
    for (uint32_t i = 0; i < len; i++) {
        crc ^= data[i];
    }
    return crc;
}

/* ---- Sliding window of sweeps ------------------------------------------------------------- */

static raw_rssi_sample_t s_ring[WINDOW_SAMPLES];
static uint8_t s_filled;
static uint8_t s_seq;

static inline int8_t half_code_to_dbm_i8(uint8_t code) {
    if (code == 0U) return -127;
    int v = -128 + ((int)code + 1) / 2;
    if (v < -127) v = -127;
    if (v > 0) v = 0;
    return (int8_t)v;
}

/**
 * One 8-channel 5.8 GHz sweep into the ring. With `radio_free` the sweep is skipped (readings 0 =
 * no reading) so the radio stays on 2.4 GHz, used while the Hub finds the BLE connection phase.
 */
static void sweep_once(bool radio_free) {
    if (s_filled < WINDOW_SAMPLES) {
        s_filled++;
    } else {
        memmove(&s_ring[0], &s_ring[1], sizeof(raw_rssi_sample_t) * (WINDOW_SAMPLES - 1));
    }
    raw_rssi_sample_t *cur = &s_ring[s_filled - 1];
    cur->seq_num = s_seq++;

    const int64_t t0 = slaprf_now_us();
    const bool scanning = !radio_free && slaprf_diag_scan_live_step(SWEEP_BUDGET_US);
    const bool rf_on = !radio_free && !scanning && slaprf_diag_rf_enabled();
    uint16_t ch_mhz[MAX_PILOT_SLOTS];
    for (int i = 0; i < MAX_PILOT_SLOTS; i++) {
        ch_mhz[i] = rf_on ? slaprf_diag_channel_mhz(i, g_flash_cfg.slot_freqs_mhz[i]) : 0;
    }
    slaprf_rf58_sweep_channels_half_dbm(ch_mhz, cur->rssi_half_dbm, t0, SWEEP_BUDGET_US);
    int8_t diag_dbm[MAX_PILOT_SLOTS];
    for (int i = 0; i < MAX_PILOT_SLOTS; i++) {
        diag_dbm[i] = half_code_to_dbm_i8(cur->rssi_half_dbm[i]);
    }
    const int64_t took = slaprf_now_us() - t0;
    if (took > SWEEP_BUDGET_US) {
        ESP_LOGW(TAG, "sweep took %lld us (budget %d us)", (long long)took, SWEEP_BUDGET_US);
    }
    slaprf_diag_sweep(diag_dbm, (uint32_t)took);
}

static uint32_t pack_window(uint8_t *pkt) {
    timer_window_frame_t *w = (timer_window_frame_t *)pkt;
    w->magic0 = FRAME_MAGIC_0;
    w->magic1 = FRAME_MAGIC_WINDOW;
    w->slot = HUB_SLOT;
    w->sample_count = s_filled;
    w->battery_mv = xiao_c5_read_battery_mv();
    w->noise_floor_dbm = -91;
    memcpy(w->samples, s_ring, sizeof(raw_rssi_sample_t) * s_filled);
    uint32_t len = 7 + (uint32_t)s_filled * sizeof(raw_rssi_sample_t);
    pkt[len] = compute_crc8(pkt, len);
    return len + 1;
}

static hub_hello_frame_t s_hello;

static void send_hello(void) {
    if (s_hello.magic0 != FRAME_MAGIC_0) {
        memset(&s_hello, 0, sizeof(s_hello));
        s_hello.magic0 = FRAME_MAGIC_0;
        s_hello.magic1 = FRAME_MAGIC_HELLO;
        s_hello.slot = HUB_SLOT;
        s_hello.role = ROLE_HUB_TIMER;
        s_hello.fingerprint = g_flash_cfg.fingerprint;
        s_hello.sweep_hz = SWEEP_HZ;
        memcpy(s_hello.timer_label, (const void *)g_flash_cfg.timer_label, sizeof(s_hello.timer_label));
        s_hello.crc8 = compute_crc8((const uint8_t *)&s_hello, sizeof(s_hello) - 1);
    }
    slaprf_forward_to_laptop(&s_hello, sizeof(s_hello));
}

/* ---- Hub (single gate, Bluetooth) ----------------------------------------------------------- */

static void hub_ble_run(void) {
    slaprf_diag_set_slot(HUB_SLOT);
    send_hello();
    uint8_t pkt[sizeof(timer_window_frame_t)];
    int64_t t_sf = slaprf_now_us() + 10000;
    int64_t next_hello = t_sf + HELLO_REPEAT_US;

    for (;;) {
        // Leave the radio on 2.4 GHz briefly (~100..250 ms) after connect or interval updates until
        // the connection-event phase is measured and jumped into the inter-sweep gap.
        const bool radio_free = slaprf_ble_needs_radio_free();

        for (int k = 0; k < TX_EVERY_SWEEPS; k++) {
            const int64_t t_sweep = t_sf + (int64_t)k * SWEEP_INTERVAL_US;
            slaprf_sleep_until_us(t_sweep);
            sweep_once(radio_free);
            if (k == 0) {
                // Queued right after the sweep, so it goes out in this gap's connection event.
                slaprf_forward_to_laptop(pkt, pack_window(pkt));
            }
        }
        if (slaprf_ble_take_hello_due() || slaprf_now_us() >= next_hello) {
            send_hello();
            next_hello = slaprf_now_us() + HELLO_REPEAT_US;
        }
        slaprf_diag_service(); // Debug-page spectrum scan, if one was requested

        const int32_t shift = slaprf_ble_sync_adjust_us(t_sf, SWEEP_INTERVAL_US, BLE_EVENT_END_US);
        t_sf += SUPERFRAME_US + shift;
        if (slaprf_now_us() > t_sf + SWEEP_INTERVAL_US) {
            t_sf = slaprf_now_us() + 1000; // Fell behind (e.g. a one-shot SCAN): restart cleanly
        }
    }
}

/* ---- Radio bring-up --------------------------------------------------------------------------- */

/**
 * Wi-Fi driver up on 2.4 GHz channel 1 but silent (no ESP-NOW, never associates, never transmits):
 * the 5.8 GHz capture engine relies on the Wi-Fi PHY being initialised and calibrated.
 */
static void wifi_idle_init(void) {
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        nvs_flash_erase();
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_start());
    if (esp_wifi_set_ps(WIFI_PS_NONE) != ESP_OK) {
        ESP_LOGW(TAG, "Wi-Fi modem sleep could not be disabled (Bluetooth coexistence)");
    }
#if SOC_WIFI_SUPPORT_5G
    esp_wifi_set_band_mode(WIFI_BAND_MODE_2G_ONLY); // Never transmit on the FPV video band
#endif
    esp_wifi_set_channel(WIFI_CHANNEL, WIFI_SECOND_CHAN_NONE);
}

void app_main(void) {
    // Console (BLE + USB): the flasher's config readback plus the web app's Debug page.
    slaprf_diag_start(&g_flash_cfg, sizeof(g_flash_cfg), SWEEP_HZ);
    slaprf_diag_set_sweep_budget(SWEEP_BUDGET_US);

    xiao_c5_select_ufl_antenna();
    wifi_idle_init();
    slaprf_ble_console_start_link();
    // Starting BLE activates ESP-IDF software coexistence, which enables disconnected-STA modem
    // sleep and gates off the Wi-Fi baseband clock that clocks the 5.8 GHz ADC dump engine. Hold a
    // Wi-Fi force-wakeup lock so the baseband/ADC stays powered for 5.8 GHz captures while BLE uses
    // the 2.4 GHz gap between sweeps.
    ESP_ERROR_CHECK(esp_wifi_force_wakeup_acquire());
    if (!slaprf_rf58_init()) {
        ESP_LOGE(TAG, "5.8 GHz capture engine failed its boot check; readings will be the noise floor");
    }
    hub_ble_run();
}
