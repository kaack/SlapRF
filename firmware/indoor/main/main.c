/**
 * SlapRF firmware profile: Indoor Â· Gym or warehouse
 *
 * Short distances and reflective walls: the problem is multipath, not range. Low +8 dBm TX keeps the
 * 2.4 GHz link from flooding the room, 100 Hz sweeps keep timing tight, and a median-of-3 filter on each
 * channel rejects single-sweep multipath nulls before they reach the laptop.
 *
 * This directory is a complete, self-contained firmware for one situation. Other profiles live
 * next to it (firmware/<profile>/) and intentionally duplicate the shared protocol code so each
 * design can evolve independently. Anything on the wire (config block, frame layouts) must stay
 * in sync with internal/firmware/image.go and internal/ingest/wifi_udp.go.
 *
 * Identity: every board carries a random 32-bit fingerprint stamped at flash time. Spokes have no
 * fixed slot: on boot they send JOIN {fingerprint, name, profile} until the Hub replies ASSIGN
 * {fingerprint, slot}; the Hub forwards HELLO {slot, fingerprint} so the laptop maps the slot back
 * to the stable timer.
 *
 * One radio, time-sliced (TDMA superframe):
 *   The C5 has a single radio. It is either measuring 5.8 GHz (transmitter off) or on the 2.4 GHz
 *   link, never both. Every timer on the course therefore runs the same schedule, anchored to the
 *   Hub's beacon, so all radios leave 2.4 GHz together and come back together:
 *
 *     superframe = TX_EVERY_SWEEPS sweep intervals
 *     interval k:  [ sweep: all timers on 5.8 GHz, <= SWEEP_BUDGET_US ][ gap k: everyone on 2.4 GHz ]
 *     gap 0 opens with the Hub beacon; Spoke slot j transmits in gap j / SLOTS_PER_GAP at
 *     GUARD + (j % SLOTS_PER_GAP) * TDMA_SLOT_US after the gap opens.
 *
 *   Sweeps start exactly one interval apart, so sample timestamps stay uniform for the laptop.
 *   All timers on one course must run the same profile (the schedule depends on it).
 */

#include <stdint.h>
#include <string.h>

#include "esp_log.h"
#include "slaprf_radio.h"

/* ---- Profile tuning (unique to this directory) ------------------------------------------- */
#define SLAPRF_PROFILE_CODE      3
#define SWEEP_HZ                 100  // 8-channel 5.8 GHz sweeps per second
#define WINDOW_SAMPLES           4    // Sweeps per window frame
#define TX_EVERY_SWEEPS          2    // 4 / 2 = every sweep delivered twice
#define LINK_LONG_RANGE          0    // Standard 1 Mbps ESP-NOW
#define TX_POWER_QDBM            32   // +8 dBm
#define TDMA_SLOT_US             900  // 1 Mbps frame (~0.5 ms) + guard
#define SWEEP_BUDGET_US          7000 // Radio away from 2.4 GHz per sweep (measured ~6.3 ms on chip v1.0)

/* ---- Schedule (derived) ------------------------------------------------------------------- */
#define MAX_SPOKES               6
#define SWEEP_INTERVAL_US        (1000000UL / SWEEP_HZ)
#define SUPERFRAME_US            (TX_EVERY_SWEEPS * SWEEP_INTERVAL_US)
#define SLOT_GUARD_US            300
#define GAP_US                   (SWEEP_INTERVAL_US - SWEEP_BUDGET_US)
#define SLOTS_PER_GAP            ((GAP_US - SLOT_GUARD_US) / TDMA_SLOT_US)
#define BEACON_WAIT_US           3000 // How long a Spoke waits past the predicted beacon

_Static_assert(SLOTS_PER_GAP * TX_EVERY_SWEEPS >= MAX_SPOKES,
               "schedule has fewer TDMA slots per superframe than Spokes");
_Static_assert(WINDOW_SAMPLES >= TX_EVERY_SWEEPS, "window must cover every sweep since the last send");

/* ---- Shared protocol ---------------------------------------------------------------------- */
#define MAX_PILOT_SLOTS          8

#define FRAME_MAGIC_0            0xC5
#define FRAME_MAGIC_SINGLE       0x58 // Single sample frame (16 bytes)
#define FRAME_MAGIC_WINDOW       0x59 // Sliding-window recorder frame (7 + n*9 + 1 bytes)
#define FRAME_MAGIC_HELLO        0x5A // Hub -> laptop: slot <-> fingerprint announcement (36 bytes)
#define FRAME_MAGIC_JOIN         0x5B // Spoke -> Hub: request a TDMA slot
#define FRAME_MAGIC_ASSIGN       0x5C // Hub -> Spoke: slot assignment

#define ROLE_HUB_TIMER           1
#define ROLE_SPOKE_TIMER         2
#define HUB_SLOT                 1    // Hub's own frames always use slot 1
#define WIFI_CHANNEL             1    // 2412 MHz

static const char *TAG = "slaprf";

#pragma pack(push, 1)
/** 160-byte SLAPRF02 config block — layout mirrored in internal/firmware/image.go. */
typedef struct {
    char     magic[8];                        // "SLAPRF02"
    uint8_t  version[3];                      // major, minor, patch
    uint8_t  role;                            // ROLE_HUB_TIMER / ROLE_SPOKE_TIMER
    uint8_t  profile;                         // Profile code (must equal SLAPRF_PROFILE_CODE)
    uint8_t  wifi_mode;                       // Hub: 0 = host "SlapRF" AP, 1 = join wifi_ssid
    uint32_t fingerprint;                     // Stable per-board identity, never 0
    uint16_t slot_freqs_mhz[MAX_PILOT_SLOTS]; // 8 pilot frequencies in MHz
    char     wifi_ssid[33];                   // Hub only
    char     wifi_pass[40];                   // Hub only
    char     timer_label[24];                 // Cosmetic timer name
    uint8_t  reserved[28];
    uint8_t  crc8;                            // XOR of bytes [0..158]
} slaprf_flash_config_t;

typedef struct {
    uint8_t  seq_num;
    int8_t   rssi_dbm[MAX_PILOT_SLOTS];
} raw_rssi_sample_t;

/** Sliding-window recorder frame. Only `sample_count` samples are sent, followed by crc8. */
typedef struct {
    uint8_t           magic0;                 // 0xC5
    uint8_t           magic1;                 // 0x59
    uint8_t           slot;                   // Hub-assigned TDMA slot (1 = Hub)
    uint8_t           sample_count;           // 1..WINDOW_SAMPLES (oldest -> newest)
    uint16_t          battery_mv;
    int8_t            noise_floor_dbm;
    raw_rssi_sample_t samples[WINDOW_SAMPLES];
    uint8_t           crc8_room;              // crc8 is written right after the last sample
} timer_window_frame_t;

typedef struct {
    uint8_t  magic0, magic1;                  // 0xC5 0x5B
    uint32_t fingerprint;
    uint8_t  role;
    uint8_t  profile;
    uint8_t  sweep_hz;
    char     timer_label[24];
    uint8_t  crc8;
} spoke_join_frame_t;

typedef struct {
    uint8_t  magic0, magic1;                  // 0xC5 0x5C
    uint32_t fingerprint;
    uint8_t  slot;                            // 2..7
    uint8_t  crc8;
} hub_assign_frame_t;

typedef struct {
    uint8_t  magic0, magic1;                  // 0xC5 0x5A
    uint8_t  slot;
    uint8_t  role;
    uint32_t fingerprint;
    uint8_t  profile;
    uint8_t  sweep_hz;
    char     timer_label[24];
    uint8_t  reserved;
    uint8_t  crc8;
} hub_hello_frame_t;                          // 36 bytes
#pragma pack(pop)

// Patched by `internal/firmware/image.go` (server) or `esp_flasher.ts` (browser) at flash time.
__attribute__((used, section(".rodata.slaprf_cfg")))
static const volatile slaprf_flash_config_t g_flash_cfg = {
    .magic          = {'S', 'L', 'A', 'P', 'R', 'F', '0', '2'},
    .version        = {0, 1, 4},
    .role           = ROLE_HUB_TIMER,
    .profile        = SLAPRF_PROFILE_CODE,
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

/* ---- Indoor only: median-of-3 multipath filter ------------------------------------------- */

static int8_t s_hist[2][MAX_PILOT_SLOTS] = {
    {-95, -95, -95, -95, -95, -95, -95, -95},
    {-95, -95, -95, -95, -95, -95, -95, -95},
};

static int8_t median3(int8_t a, int8_t b, int8_t c) {
    if (a > b) { int8_t t = a; a = b; b = t; }
    if (b > c) { int8_t t = b; b = c; c = t; }
    if (a > b) { int8_t t = a; a = b; b = t; }
    return b;
}

/** One 8-channel 5.8 GHz sweep into the ring. The 2.4 GHz link is off for its duration. */
static void sweep_once(void) {
    if (s_filled < WINDOW_SAMPLES) {
        s_filled++;
    } else {
        memmove(&s_ring[0], &s_ring[1], sizeof(raw_rssi_sample_t) * (WINDOW_SAMPLES - 1));
    }
    raw_rssi_sample_t *cur = &s_ring[s_filled - 1];
    cur->seq_num = s_seq++;

    const int64_t t0 = slaprf_now_us();
    // Debug page: a live spectrum scan takes over the sweep slot (lap timing pauses), and the
    // receiver can be switched off. Either way the pilot readings are -127 for this sweep.
    const bool scanning = slaprf_diag_scan_live_step(SWEEP_BUDGET_US);
    const bool rf_on = !scanning && slaprf_diag_rf_enabled();
    uint16_t ch_mhz[MAX_PILOT_SLOTS];
    bool any_ch = false;
    for (int i = 0; i < MAX_PILOT_SLOTS; i++) {
        ch_mhz[i] = rf_on ? slaprf_diag_channel_mhz(i, g_flash_cfg.slot_freqs_mhz[i]) : 0;
        if (ch_mhz[i] >= 5180) {
            any_ch = true;
        }
    }
    if (any_ch) {
        slaprf_rf58_enter();
    }
    for (int i = 0; i < MAX_PILOT_SLOTS; i++) {
        int8_t raw = ch_mhz[i] >= 5180 ? esp_sdr_measure_5g_channel_dbm(ch_mhz[i]) : -127;
        if (raw <= -127) {
            cur->rssi_dbm[i] = -127;
            s_hist[0][i] = -95;
            s_hist[1][i] = -95;
        } else {
            cur->rssi_dbm[i] = median3(raw, s_hist[0][i], s_hist[1][i]);
            s_hist[1][i] = s_hist[0][i];
            s_hist[0][i] = raw;
        }
    }
    if (any_ch) {
        slaprf_rf58_leave();
    }
    const int64_t took = slaprf_now_us() - t0;
    if (took > SWEEP_BUDGET_US) {
        ESP_LOGW(TAG, "sweep took %lld us (budget %d us)", (long long)took, SWEEP_BUDGET_US);
    }
    slaprf_diag_sweep(cur->rssi_dbm, (uint32_t)took); // Debug page: STATUS? / LIVE
}

/** Pack the current window into `pkt`; returns the frame length. */
static uint32_t pack_window(uint8_t *pkt, uint8_t slot) {
    timer_window_frame_t *w = (timer_window_frame_t *)pkt;
    w->magic0 = FRAME_MAGIC_0;
    w->magic1 = FRAME_MAGIC_WINDOW;
    w->slot = slot;
    w->sample_count = s_filled;
    w->battery_mv = xiao_c5_read_battery_mv();
    w->noise_floor_dbm = -92;
    memcpy(w->samples, s_ring, sizeof(raw_rssi_sample_t) * s_filled);
    uint32_t len = 7 + (uint32_t)s_filled * sizeof(raw_rssi_sample_t);
    pkt[len] = compute_crc8(pkt, len);
    return len + 1;
}

/* ---- Hub ---------------------------------------------------------------------------------- */

static uint32_t s_slot_fp[MAX_SPOKES]; // slot = index + 2
static hub_hello_frame_t s_hello[1 + MAX_SPOKES]; // [0] = Hub, [n] = slot n + 1; magic0 == 0 means unused
#define HELLO_REPEAT_US 2000000 // Re-announce every timer so a laptop that (re)connects late learns them

static void hub_send_hello(uint8_t slot, uint8_t role, uint32_t fp, uint8_t profile, uint8_t sweep_hz,
                           const char *label) {
    hub_hello_frame_t h;
    memset(&h, 0, sizeof(h));
    h.magic0 = FRAME_MAGIC_0;
    h.magic1 = FRAME_MAGIC_HELLO;
    h.slot = slot;
    h.role = role;
    h.fingerprint = fp;
    h.profile = profile;
    h.sweep_hz = sweep_hz;
    memcpy(h.timer_label, label, sizeof(h.timer_label));
    h.crc8 = compute_crc8((const uint8_t *)&h, sizeof(h) - 1);
    slaprf_forward_to_laptop(&h, sizeof(h));
    if (slot >= 1 && slot <= 1 + MAX_SPOKES) {
        s_hello[slot - 1] = h;
    }
}

/** Repeat every known HELLO (laptops that join or restart after boot still map slots). */
static void hub_repeat_hellos(void) {
    for (int i = 0; i < 1 + MAX_SPOKES; i++) {
        if (s_hello[i].magic0 == FRAME_MAGIC_0) {
            slaprf_forward_to_laptop(&s_hello[i], sizeof(s_hello[i]));
        }
    }
}

/** Reuse a Spoke's slot if its fingerprint is known, else hand out the first free one. */
static void hub_handle_join(const spoke_join_frame_t *j) {
    if (j->profile != SLAPRF_PROFILE_CODE) {
        ESP_LOGW(TAG, "Spoke %08lx runs profile %u, Hub runs %u: schedules won't line up",
                 (unsigned long)j->fingerprint, j->profile, SLAPRF_PROFILE_CODE);
    }
    int idx = -1;
    for (int i = 0; i < MAX_SPOKES; i++) {
        if (s_slot_fp[i] == j->fingerprint) { idx = i; break; }
    }
    for (int i = 0; idx < 0 && i < MAX_SPOKES; i++) {
        if (s_slot_fp[i] == 0 || (s_slot_fp[i] & 0xFFFFFF00UL) == 0x53504B00UL) { idx = i; }
    }
    if (idx < 0) {
        return; // Course is full
    }
    s_slot_fp[idx] = j->fingerprint;
    uint8_t slot = (uint8_t)(idx + 2);

    hub_assign_frame_t a = { FRAME_MAGIC_0, FRAME_MAGIC_ASSIGN, j->fingerprint, slot, 0 };
    a.crc8 = compute_crc8((const uint8_t *)&a, sizeof(a) - 1);
    espnow_send(&a, sizeof(a));
    slaprf_diag_note_spoke(slot, j->fingerprint, j->profile, j->timer_label);
    hub_send_hello(slot, j->role, j->fingerprint, j->profile, j->sweep_hz, j->timer_label);
}

/** Drain received ESP-NOW frames (joins, Spoke windows) until `until_us`. */
static void hub_listen_until(int64_t until_us) {
    uint8_t buf[250];
    for (;;) {
        int n;
        while ((n = espnow_poll(buf, sizeof(buf))) > 0) {
            if (n < 3 || buf[0] != FRAME_MAGIC_0 || compute_crc8(buf, (uint32_t)n - 1) != buf[n - 1]) {
                continue;
            }
            if (buf[1] == FRAME_MAGIC_JOIN && n == (int)sizeof(spoke_join_frame_t)) {
                hub_handle_join((const spoke_join_frame_t *)buf);
            } else if (buf[1] == FRAME_MAGIC_WINDOW || buf[1] == FRAME_MAGIC_SINGLE) {
                const uint8_t slot = buf[2];
                if (slot >= 2 && slot < 2 + MAX_SPOKES && s_hello[slot - 1].magic0 != FRAME_MAGIC_0) {
                    // Spoke was already running in this TDMA slot before the Hub booted:
                    // announce a fallback HELLO so the laptop ingests its frames immediately,
                    // until the Spoke's next periodic JOIN supplies its real fingerprint.
                    char fallback_label[24] = {0};
                    fallback_label[0] = 'S';
                    fallback_label[1] = (char)('0' + (slot - 1));
                    const uint32_t fp = s_slot_fp[slot - 2] ? s_slot_fp[slot - 2] : (0x53504B00UL | slot);
                    slaprf_diag_note_spoke(slot, fp, SLAPRF_PROFILE_CODE, fallback_label);
                    hub_send_hello(slot, ROLE_SPOKE_TIMER, fp, SLAPRF_PROFILE_CODE, SWEEP_HZ, fallback_label);
                }
                slaprf_diag_note_spoke_frame(buf, (uint32_t)n);
                slaprf_forward_to_laptop(buf, (uint32_t)n);
            }
        }
        if (slaprf_now_us() >= until_us) {
            return;
        }
        // Waits > 1.2 ms sleep a tick (lets the idle task and Wi-Fi run); shorter ones spin.
        const int64_t now = slaprf_now_us();
        slaprf_sleep_until_us(until_us - now > 2000 ? now + 2000 : until_us);
    }
}

static void hub_run(void) {
    slaprf_diag_set_slot(HUB_SLOT);
    hub_send_hello(HUB_SLOT, ROLE_HUB_TIMER, g_flash_cfg.fingerprint, SLAPRF_PROFILE_CODE, SWEEP_HZ,
                   (const char *)g_flash_cfg.timer_label);
    uint8_t pkt[sizeof(timer_window_frame_t)];
    uint8_t beacon_seq = 0;
    int64_t t_sf = slaprf_now_us() + 10000;
    int64_t next_hello = t_sf + HELLO_REPEAT_US;
    for (;;) {
        for (int k = 0; k < TX_EVERY_SWEEPS; k++) {
            const int64_t t_sweep = t_sf + (int64_t)k * SWEEP_INTERVAL_US;
            const int64_t t_gap = t_sweep + SWEEP_BUDGET_US;
            slaprf_sleep_until_us(t_sweep);
            sweep_once();
            slaprf_sleep_until_us(t_gap);
            if (k == 0) {
                slaprf_broadcast_hub_sync_beacon(beacon_seq++); // Anchors every Spoke's schedule
            }
            if (k == TX_EVERY_SWEEPS - 1) {
                slaprf_forward_to_laptop(pkt, pack_window(pkt, HUB_SLOT));
                if (slaprf_now_us() >= next_hello) {
                    hub_repeat_hellos();
                    next_hello += HELLO_REPEAT_US;
                }
            }
            // Stop listening a little early so queued UDP leaves before the radio goes deaf.
            hub_listen_until(t_sweep + SWEEP_INTERVAL_US - 500);
        }
        slaprf_diag_service(); // Debug-page spectrum scan, if one was requested
        t_sf += SUPERFRAME_US;
        if (slaprf_now_us() > t_sf + SWEEP_INTERVAL_US) {
            t_sf = slaprf_now_us() + 1000; // Fell behind (e.g. a slow Wi-Fi call): restart cleanly
        }
    }
}

/* ---- Spoke -------------------------------------------------------------------------------- */

static void spoke_fill_join(spoke_join_frame_t *j) {
    memset(j, 0, sizeof(*j));
    j->magic0 = FRAME_MAGIC_0;
    j->magic1 = FRAME_MAGIC_JOIN;
    j->fingerprint = g_flash_cfg.fingerprint;
    j->role = ROLE_SPOKE_TIMER;
    j->profile = SLAPRF_PROFILE_CODE;
    j->sweep_hz = SWEEP_HZ;
    memcpy(j->timer_label, (const void *)g_flash_cfg.timer_label, sizeof(j->timer_label));
    j->crc8 = compute_crc8((const uint8_t *)j, sizeof(*j) - 1);
}

static uint8_t spoke_join_hub(void) {
    spoke_join_frame_t j;
    spoke_fill_join(&j);

    uint8_t buf[64];
    for (;;) {
        espnow_send(&j, sizeof(j)); // Lands in one of the Hub's 2.4 GHz gaps sooner or later
        for (int wait = 0; wait < 50; wait++) { // ~250 ms per attempt
            slaprf_sleep_until_us(slaprf_now_us() + 5000);
            slaprf_diag_service();
            int n = espnow_poll(buf, sizeof(buf));
            if (n == (int)sizeof(hub_assign_frame_t) && buf[0] == FRAME_MAGIC_0 && buf[1] == FRAME_MAGIC_ASSIGN &&
                compute_crc8(buf, (uint32_t)n - 1) == buf[n - 1]) {
                const hub_assign_frame_t *a = (const hub_assign_frame_t *)buf;
                if (a->fingerprint == g_flash_cfg.fingerprint && a->slot >= 2) {
                    return a->slot;
                }
            }
        }
    }
}

/** Wait for a Hub beacon newer than `after_us` until `deadline_us`; returns its time or 0. */
static int64_t spoke_wait_beacon(int64_t after_us, int64_t deadline_us) {
    for (;;) {
        int64_t b = slaprf_last_hub_beacon_us();
        if (b > after_us) {
            return b;
        }
        if (slaprf_now_us() >= deadline_us) {
            return 0;
        }
        slaprf_sleep_until_us(slaprf_now_us() + 200);
    }
}

static void spoke_run(void) {
    uint8_t pkt[sizeof(timer_window_frame_t)];
    spoke_join_frame_t join_pkt;
    spoke_fill_join(&join_pkt);
    for (;;) {
        slaprf_diag_set_slot(0);
        slaprf_spoke_sync_to_hub_channel();
        uint8_t slot = spoke_join_hub();
        slaprf_diag_set_slot(slot);
        uint8_t idx = (uint8_t)(slot - 2);
        int my_gap = idx / SLOTS_PER_GAP;
        int64_t my_offset = SLOT_GUARD_US + (int64_t)(idx % SLOTS_PER_GAP) * TDMA_SLOT_US;
        ESP_LOGI(TAG, "joined as slot %u (gap %d, +%lld us)", slot, my_gap, (long long)my_offset);

        int64_t beacon = spoke_wait_beacon(slaprf_now_us(), slaprf_now_us() + 2500000LL);
        if (!beacon) {
            continue;
        }
        int64_t next_join_refresh = beacon + HELLO_REPEAT_US;
        while (slaprf_ms_since_hub_beacon() <= 2500) {
            const int64_t t_sf = beacon - SWEEP_BUDGET_US; // Superframe start implied by the beacon
            for (int k = 0; k < TX_EVERY_SWEEPS; k++) {
                const int64_t t_sweep = t_sf + (int64_t)k * SWEEP_INTERVAL_US;
                if (k > 0) {
                    slaprf_sleep_until_us(t_sweep);
                    sweep_once();
                }
                if (k == my_gap) {
                    slaprf_sleep_until_us(t_sweep + SWEEP_BUDGET_US + my_offset);
                    espnow_send(pkt, pack_window(pkt, slot));
                    if (slaprf_now_us() >= next_join_refresh) {
                        espnow_send(&join_pkt, sizeof(join_pkt));
                        next_join_refresh = slaprf_now_us() + HELLO_REPEAT_US;
                    }
                }
            }
            // Sweep 0 of the next superframe, then expect its beacon right after.
            const int64_t next_sf = t_sf + SUPERFRAME_US;
            slaprf_sleep_until_us(next_sf);
            sweep_once();
            int64_t b = spoke_wait_beacon(next_sf, next_sf + SWEEP_BUDGET_US + BEACON_WAIT_US);
            beacon = b ? b : next_sf + SWEEP_BUDGET_US; // Missed it: free-run on the prediction
            slaprf_diag_service(); // Debug-page spectrum scan, if one was requested
            if (slaprf_now_us() > beacon + SWEEP_INTERVAL_US || slaprf_ms_since_hub_beacon() > 200) {
                // Fell behind (e.g. spectrum scan) or missed >5 beacons (phase shift / Hub reset):
                // pause 5.8 GHz sweeps and listen continuously on 2.4 GHz to re-lock phase immediately.
                const int64_t wait_start = slaprf_now_us();
                int64_t relock = spoke_wait_beacon(wait_start, wait_start + 600000LL);
                if (relock) {
                    beacon = relock;
                    espnow_send(&join_pkt, sizeof(join_pkt));
                    next_join_refresh = relock + HELLO_REPEAT_US;
                } else {
                    beacon = slaprf_now_us() + SWEEP_BUDGET_US;
                }
            }
            uint8_t rx_buf[250];
            int rx_n;
            while ((rx_n = espnow_poll(rx_buf, sizeof(rx_buf))) > 0) {
                if (rx_n == (int)sizeof(hub_assign_frame_t) && rx_buf[0] == FRAME_MAGIC_0 &&
                    rx_buf[1] == FRAME_MAGIC_ASSIGN && compute_crc8(rx_buf, (uint32_t)rx_n - 1) == rx_buf[rx_n - 1]) {
                    const hub_assign_frame_t *a = (const hub_assign_frame_t *)rx_buf;
                    if (a->fingerprint == g_flash_cfg.fingerprint && a->slot >= 2 && a->slot != slot) {
                        slot = a->slot;
                        slaprf_diag_set_slot(slot);
                        idx = (uint8_t)(slot - 2);
                        my_gap = idx / SLOTS_PER_GAP;
                        my_offset = SLOT_GUARD_US + (int64_t)(idx % SLOTS_PER_GAP) * TDMA_SLOT_US;
                    }
                }
            }

        }
        ESP_LOGW(TAG, "Hub beacon lost for >2.5 s; re-syncing and re-joining Hub");
    }
}

/* ---- Entry -------------------------------------------------------------------------------- */

void app_main(void) {
    // USB console: the flasher's config readback plus the web app's Debug page.
    slaprf_diag_start(&g_flash_cfg, sizeof(g_flash_cfg), SWEEP_HZ);
    slaprf_diag_set_sweep_budget(SWEEP_BUDGET_US);

    // External U.FL antenna; 2.4 GHz link (the driver never uses 5 GHz); 5.8 GHz capture engine.
    xiao_c5_select_ufl_antenna();
    slaprf_init_2g4_radio(WIFI_CHANNEL, LINK_LONG_RANGE, TX_POWER_QDBM);
    if (!slaprf_rf58_init()) {
        ESP_LOGE(TAG, "5.8 GHz capture engine failed its boot check; readings will be the noise floor");
    }

    if (g_flash_cfg.role == ROLE_HUB_TIMER) {
        hub_run();
    } else {
        spoke_run();
    }
}
