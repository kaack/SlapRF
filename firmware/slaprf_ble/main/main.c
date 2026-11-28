/**
 * SlapRF Bluetooth Hub firmware for ESP32-C5 boards (unified 1-to-7 gate BLE image).
 *
 * The Hub measures its own gate (8 pilot channels, 50 Hz = 20 ms superframe) AND coordinates up to
 * 6 unchanged SlapRF Spoke timers (Slots 2..7, 100 Hz = 10 ms sweeps) over 2.4 GHz ESP-NOW on
 * Channel 1, relaying all Hub + Spoke frames and console commands over Bluetooth LE.
 *
 * When 0 Spokes are powered on, the Hub runs standalone as a solo 1-gate timer with zero Track
 * setup required. When 1..6 Spokes are powered on, they lock onto the Hub's 0xC5 0x5D sync +
 * 8-pilot channel-table beacon at t_sf + 7000 us (matching the Spoke firmware's 7000 us sweep
 * budget so t_sf = beacon - 7000 us aligns both schedules to the microsecond):
 *
 *   |<------------------------------- 20.0 ms superframe ------------------------------->|
 *   [0..5.4ms Hub 5.8G][7.0ms Beacon][7.3..9.8ms S1..S3][10.0..17.0ms Quiet BLE][17.3..19.8ms S4..S6]
 *
 * Keep wire structs in sync with firmware/slaprf/main/main.c and internal/ingest/hub_frames.go.
 */

#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#include "esp_log.h"
#include "esp_wifi.h"
#include "slaprf_ble_espnow.h"
#include "slaprf_ble_link.h"
#include "slaprf_board.h"
#include "slaprf_radio.h"

/* ---- Tuning ------------------------------------------------------------------------------ */
#define SWEEP_HZ                 50      // Hub 8-channel 5.8 GHz sweeps/s (20 ms superframe)
#define SPOKE_SWEEP_HZ           100     // Unchanged Spoke firmware sweep rate (10 ms spacing)
#define WINDOW_SAMPLES           4       // 4x sliding-window redundancy: every sweep sent 4 times
#define TX_EVERY_SWEEPS          1       // 50 Hub frames/s (one frame every 20 ms)
#define SWEEP_BUDGET_US          6000    // ~5.4 ms Hub 5.8 GHz sweep; leaves ~14.6 ms on 2.4 GHz
#define SPOKE_BEACON_OFFSET_US   7000    // Spokes compute t_sf = beacon - 7000 us (their sweep budget)
#define BLE_EVENT_END_US         13500   // Center of the [10.0..17.0 ms] Spoke-silent 2.4 GHz window
#define SPOKE_MAX_POS_SHIFT_US   180     // Stay below Spoke BEACON_GRACE_US (+250 us) when Spokes are active
#define SPOKE_MAX_NEG_SHIFT_US  -350     // Stay after Spoke 6.3 ms 5.8 GHz sweep completion when Spokes are active

/* ---- Schedule (derived) ------------------------------------------------------------------- */
#define MAX_SPOKES               6
#define SWEEP_INTERVAL_US        (1000000UL / SWEEP_HZ)
#define SUPERFRAME_US            (TX_EVERY_SWEEPS * SWEEP_INTERVAL_US)

_Static_assert(WINDOW_SAMPLES >= TX_EVERY_SWEEPS, "window must cover every sweep since the last send");
_Static_assert(SPOKE_BEACON_OFFSET_US >= SWEEP_BUDGET_US && SPOKE_BEACON_OFFSET_US < SUPERFRAME_US,
               "Spoke sync beacon must sit after the Hub sweep inside the 20 ms superframe");
_Static_assert(BLE_EVENT_END_US > SPOKE_BEACON_OFFSET_US && BLE_EVENT_END_US < SUPERFRAME_US,
               "BLE events must end inside the 2.4 GHz gap after the beacon");

/* ---- Shared wire protocol (identical to firmware/slaprf/main/main.c) ---------------------- */
#define MAX_PILOT_SLOTS          8
#define FRAME_MAGIC_0            0xC5
#define FRAME_MAGIC_HELLO        0x5A    // Hub -> host: slot <-> fingerprint announcement (36 bytes)
#define FRAME_MAGIC_JOIN         0x5B    // Spoke -> Hub: request a TDMA slot (35 bytes)
#define FRAME_MAGIC_ASSIGN       0x5C    // Hub -> Spoke: TDMA slot assignment (8 bytes)
#define FRAME_MAGIC_IDENTIFY     0x5F    // Hub -> Spoke: LED identify strobe on/off (8 bytes)
#define FRAME_MAGIC_WINDOW       0x60    // 0.5 dB sliding-window recorder frame (7 + n*9 + 1 bytes)
#define FRAME_MAGIC_SINGLE       0x61    // 0.5 dB single-sample frame (16 bytes)

#define WIRE_PROTO_VER           2U      // Matches unchanged Spoke firmware
#define ROLE_HUB_TIMER           1
#define ROLE_SPOKE_TIMER         2
#define HUB_SLOT                 1
#define WIFI_CHANNEL             1       // 2412 MHz
#define TX_POWER_QDBM            80      // +20 dBm
#define HELLO_REPEAT_US          2000000LL
#define SLOT_STALE_US            10000000LL

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
    uint8_t           slot;                   // 1 = Hub, 2..7 = Spokes
    uint8_t           sample_count;           // 1..WINDOW_SAMPLES (oldest -> newest)
    uint16_t          battery_mv;
    int8_t            noise_floor_dbm;
    raw_rssi_sample_t samples[WINDOW_SAMPLES];
    uint8_t           crc8_room;
} timer_window_frame_t;

typedef struct {
    uint8_t  magic0, magic1;                  // 0xC5 0x5B
    uint32_t fingerprint;
    uint8_t  role;                            // ROLE_SPOKE_TIMER
    uint8_t  reserved0;                       // WIRE_PROTO_VER
    uint8_t  sweep_hz;                        // Spoke's SWEEP_HZ (100)
    char     timer_label[24];
    uint8_t  crc8;
} spoke_join_frame_t;                         // 34 bytes (must match firmware/slaprf/main/main.c)

typedef struct {
    uint8_t  magic0, magic1;                  // 0xC5 0x5C
    uint32_t fingerprint;
    uint8_t  slot;                            // 2..7
    uint8_t  crc8;
} hub_assign_frame_t;                         // 8 bytes

typedef struct {
    uint8_t  magic0, magic1;                  // 0xC5 0x5F
    uint32_t fingerprint;                     // Target Spoke's fingerprint
    uint8_t  on;                              // 1 = strobe, 0 = stop immediately
    uint8_t  crc8;
} hub_identify_frame_t;                       // 8 bytes

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

_Static_assert(sizeof(slaprf_flash_config_t) == 160, "SLAPRF02 config block must be 160 bytes");
_Static_assert(sizeof(timer_window_frame_t) == 44, "4-sample window frame must be 44 bytes");
_Static_assert(sizeof(spoke_join_frame_t) == 34, "spoke_join_frame_t must match 34-byte Spoke wire layout");
_Static_assert(sizeof(hub_assign_frame_t) == 8, "hub_assign_frame_t must match 8-byte Spoke wire layout");
_Static_assert(sizeof(hub_identify_frame_t) == 8, "hub_identify_frame_t must match 8-byte Spoke wire layout");
_Static_assert(sizeof(hub_hello_frame_t) == 36, "hub_hello_frame_t must match 36-byte host wire layout");

// Patched by internal/firmware/image.go (server) or esp_flasher.ts (browser) at flash time.
__attribute__((used, section(".rodata.slaprf_cfg")))
static const volatile slaprf_flash_config_t g_flash_cfg = {
    .magic          = {'S', 'L', 'A', 'P', 'R', 'F', '0', '2'},
    .version        = {0, 4, 0},
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

/* ---- Sliding window of Hub sweeps --------------------------------------------------------- */

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
 * One 8-channel 5.8 GHz sweep into the Hub's own Slot 1 ring. With `radio_free` the sweep is
 * skipped briefly right after BLE connect (< 1.5 s before CCCD subscribe) so GATT service discovery
 * runs uninterrupted on 2.4 GHz.
 */
static void sweep_once(bool radio_free) {
    if (radio_free) {
        return;
    }
    if (s_filled < WINDOW_SAMPLES) {
        s_filled++;
    } else {
        memmove(&s_ring[0], &s_ring[1], sizeof(raw_rssi_sample_t) * (WINDOW_SAMPLES - 1));
    }
    raw_rssi_sample_t *cur = &s_ring[s_filled - 1];
    cur->seq_num = s_seq++;

    const int64_t t0 = slaprf_now_us();
    const bool scanning = slaprf_diag_scan_live_step(SWEEP_BUDGET_US);
    const bool rf_on = !scanning && slaprf_diag_rf_enabled();
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
    w->battery_mv = slaprf_board_read_battery_mv();
    w->noise_floor_dbm = -91;
    memcpy(w->samples, s_ring, sizeof(raw_rssi_sample_t) * s_filled);
    uint32_t len = 7 + (uint32_t)s_filled * sizeof(raw_rssi_sample_t);
    pkt[len] = compute_crc8(pkt, len);
    return len + 1;
}

/* ---- Hub + Spoke TDMA coordinator (Slots 1..7) -------------------------------------------- */

static uint32_t s_slot_fp[MAX_SPOKES];         // Fingerprint occupying TDMA slot (index + 2), or 0
static int64_t s_slot_heard_us[MAX_SPOKES];    // Last JOIN or data frame heard in that slot
static hub_hello_frame_t s_hello[1 + MAX_SPOKES];

static bool hub_slot_stale(int idx, int64_t now_us) {
    return s_slot_fp[idx] != 0 && (now_us - s_slot_heard_us[idx]) > SLOT_STALE_US;
}

static bool hub_has_active_spokes(int64_t now_us) {
    for (int i = 0; i < MAX_SPOKES; i++) {
        if (s_slot_fp[i] != 0 && !hub_slot_stale(i, now_us)) {
            return true;
        }
    }
    return false;
}

static void hub_send_hello(uint8_t slot, uint8_t role, uint32_t fp, uint8_t sweep_hz, const char *label) {
    hub_hello_frame_t h;
    memset(&h, 0, sizeof(h));
    h.magic0 = FRAME_MAGIC_0;
    h.magic1 = FRAME_MAGIC_HELLO;
    h.slot = slot;
    h.role = role;
    h.fingerprint = fp;
    h.sweep_hz = sweep_hz;
    if (label != NULL) {
        memcpy(h.timer_label, label, sizeof(h.timer_label));
    }
    h.crc8 = compute_crc8((const uint8_t *)&h, sizeof(h) - 1);
    if (slot >= 1 && slot <= 1 + MAX_SPOKES) {
        s_hello[slot - 1] = h;
    }
    slaprf_forward_to_laptop(&h, sizeof(h));
}

static void hub_repeat_hellos(void) {
    const int64_t now = slaprf_now_us();
    for (int i = 0; i < 1 + MAX_SPOKES; i++) {
        if (i > 0 && hub_slot_stale(i - 1, now)) {
            continue;
        }
        if (s_hello[i].magic0 == FRAME_MAGIC_0) {
            slaprf_forward_to_laptop(&s_hello[i], sizeof(s_hello[i]));
        }
    }
}

static void hub_handle_join(const spoke_join_frame_t *j) {
    if (j->reserved0 != WIRE_PROTO_VER) {
        ESP_LOGW(TAG, "Spoke %08lX (%s) proto %u != %u; reflash timer",
                 (unsigned long)j->fingerprint, j->timer_label, (unsigned)j->reserved0, (unsigned)WIRE_PROTO_VER);
        return;
    }
    const int64_t now = slaprf_now_us();
    int idx = -1;
    for (int i = 0; i < MAX_SPOKES; i++) {
        if (s_slot_fp[i] == j->fingerprint) {
            idx = i;
            break;
        }
    }
    for (int i = 0; idx < 0 && i < MAX_SPOKES; i++) {
        if (s_slot_fp[i] == 0 || (s_slot_fp[i] & 0xFFFFFF00UL) == 0x53504B00UL) {
            idx = i;
            break;
        }
    }
    for (int i = 0; idx < 0 && i < MAX_SPOKES; i++) {
        if (hub_slot_stale(i, now)) {
            idx = i;
            break;
        }
    }
    if (idx < 0) {
        return; // All 6 Spoke slots active
    }
    s_slot_fp[idx] = j->fingerprint;
    s_slot_heard_us[idx] = now;
    const uint8_t slot = (uint8_t)(idx + 2);

    hub_assign_frame_t a = {FRAME_MAGIC_0, FRAME_MAGIC_ASSIGN, j->fingerprint, slot, 0};
    a.crc8 = compute_crc8((const uint8_t *)&a, sizeof(a) - 1);
    espnow_send(&a, sizeof(a));
    slaprf_diag_note_spoke(slot, j->fingerprint, j->timer_label);
    hub_send_hello(slot, j->role, j->fingerprint, j->sweep_hz ? j->sweep_hz : SPOKE_SWEEP_HZ, j->timer_label);
}

static void hub_handle_rx_frame(const uint8_t *buf, int n) {
    if (n < 3 || buf[0] != FRAME_MAGIC_0 || compute_crc8(buf, (uint32_t)n - 1) != buf[n - 1]) {
        return;
    }
    if (buf[1] == FRAME_MAGIC_JOIN && n == (int)sizeof(spoke_join_frame_t)) {
        hub_handle_join((const spoke_join_frame_t *)buf);
    } else if (buf[1] == FRAME_MAGIC_WINDOW || buf[1] == FRAME_MAGIC_SINGLE) {
        const uint8_t slot = buf[2];
        if (slot >= 2 && slot < 2 + MAX_SPOKES) {
            s_slot_heard_us[slot - 2] = slaprf_now_us();
            if (s_hello[slot - 1].magic0 != FRAME_MAGIC_0) {
                // Spoke was already running in this TDMA slot when the Hub booted: emit placeholder
                // HELLO until the Spoke's periodic 2 s JOIN supplies its real fingerprint and label.
                char fallback_label[24] = {0};
                fallback_label[0] = 'T';
                fallback_label[1] = (char)('0' + (slot - 1));
                const uint32_t fp = s_slot_fp[slot - 2] ? s_slot_fp[slot - 2] : (0x53504B00UL | slot);
                slaprf_diag_note_spoke(slot, fp, fallback_label);
                hub_send_hello(slot, ROLE_SPOKE_TIMER, fp, SPOKE_SWEEP_HZ, fallback_label);
            }
        }
        slaprf_diag_note_spoke_frame(buf, (uint32_t)n);
        slaprf_forward_to_laptop(buf, (uint32_t)n);
    }
}

static void hub_drain_rx(void) {
    uint8_t buf[64];
    for (int n = espnow_poll(buf, sizeof(buf)); n > 0; n = espnow_poll(buf, sizeof(buf))) {
        hub_handle_rx_frame(buf, n);
    }
}

static void hub_listen_until(int64_t until_us) {
    uint8_t buf[64];
    hub_drain_rx();
    for (;;) {
        const int64_t left_us = until_us - slaprf_now_us() - 1200;
        if (left_us <= 0) {
            hub_drain_rx();
            return;
        }
        int n = espnow_wait(buf, sizeof(buf), (uint32_t)(left_us / 1000 > 0 ? left_us / 1000 : 1));
        for (; n > 0; n = espnow_poll(buf, sizeof(buf))) {
            hub_handle_rx_frame(buf, n);
        }
    }
}

static void hub_ble_run(void) {
    slaprf_diag_set_slot(HUB_SLOT);
    hub_send_hello(HUB_SLOT, ROLE_HUB_TIMER, g_flash_cfg.fingerprint, SWEEP_HZ,
                   (const char *)g_flash_cfg.timer_label);

    uint8_t pkt[sizeof(timer_window_frame_t)];
    uint8_t beacon_seq = 0;
    int64_t t_sf = slaprf_now_us() + 10000;
    int64_t next_hello = t_sf + HELLO_REPEAT_US;

    for (;;) {
        const bool radio_free = slaprf_ble_needs_radio_free();

        slaprf_sleep_until_us(t_sf);
        hub_drain_rx();
        sweep_once(radio_free);
        if (s_filled > 0) {
            slaprf_forward_to_laptop(pkt, pack_window(pkt));
        }

        // Wait until t_sf + 7000 us while servicing any early Spoke JOINs, then broadcast the sync
        // beacon so 100 Hz Spokes compute exact t_sf = beacon - 7000 us.
        const int64_t t_beacon = t_sf + SPOKE_BEACON_OFFSET_US;
        hub_listen_until(t_beacon);
        slaprf_sleep_until_us(t_beacon);
        slaprf_broadcast_hub_sync_beacon(beacon_seq++);

        uint32_t id_fp;
        bool id_on;
        if (slaprf_diag_identify_next_frame(&id_fp, &id_on)) {
            hub_identify_frame_t f = {FRAME_MAGIC_0, FRAME_MAGIC_IDENTIFY, id_fp, id_on ? 1 : 0, 0};
            f.crc8 = compute_crc8((const uint8_t *)&f, sizeof(f) - 1);
            espnow_send(&f, sizeof(f));
        }

        if (slaprf_ble_take_hello_due() || slaprf_now_us() >= next_hello) {
            hub_repeat_hellos();
            next_hello = slaprf_now_us() + HELLO_REPEAT_US;
        }
        slaprf_diag_service(); // Debug-page spectrum scan, if one was requested

        // Receive Gap 0 Spokes (7.3..9.8 ms), yield cleanly during Quiet BLE window (10.0..17.0 ms),
        // and receive Gap 1 Spokes (17.3..19.8 ms).
        hub_listen_until(t_sf + SUPERFRAME_US - 400);

        int32_t shift = slaprf_ble_sync_adjust_us(t_sf, SWEEP_INTERVAL_US, BLE_EVENT_END_US);
        if (hub_has_active_spokes(slaprf_now_us())) {
            if (shift > SPOKE_MAX_POS_SHIFT_US) shift = SPOKE_MAX_POS_SHIFT_US;
            if (shift < SPOKE_MAX_NEG_SHIFT_US) shift = SPOKE_MAX_NEG_SHIFT_US;
        }
        t_sf += SUPERFRAME_US + shift;
        if (slaprf_now_us() > t_sf + SWEEP_INTERVAL_US) {
            t_sf = slaprf_now_us() + 1000; // Fell behind (e.g. one-shot SCAN): restart cleanly
        }
    }
}

/* ---- Radio bring-up ----------------------------------------------------------------------- */

void app_main(void) {
    slaprf_diag_start(&g_flash_cfg, sizeof(g_flash_cfg), SWEEP_HZ);
    slaprf_diag_set_sweep_budget(SWEEP_BUDGET_US);

    slaprf_board_select_external_antenna();
    slaprf_ble_init_2g4_espnow(WIFI_CHANNEL, TX_POWER_QDBM);
    slaprf_ble_console_start_link();
    // Starting BLE activates ESP-IDF software coexistence, which enables disconnected-STA modem
    // sleep and gates off the Wi-Fi baseband clock that clocks the 5.8 GHz ADC dump engine. Hold a
    // Wi-Fi force-wakeup lock so the baseband/ADC stays powered for 5.8 GHz captures while BLE and
    // ESP-NOW share the 2.4 GHz gap between sweeps.
    ESP_ERROR_CHECK(esp_wifi_force_wakeup_acquire());
    if (!slaprf_rf58_init()) {
        ESP_LOGE(TAG, "5.8 GHz capture engine failed its boot check; readings will be the noise floor");
    }
    hub_ble_run();
}
