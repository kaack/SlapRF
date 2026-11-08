/**
 * SlapRF firmware profile: Technical · Trees & obstacles
 *
 * Timers sit behind trees, under ramps, or inside structures, so the Hub link drops out for long
 * stretches. Long Range 500 kbps at +20 dBm with 6-sweep windows sent every 2 sweeps delivers each
 * sample three times (a 100 ms outage loses nothing), and a Spoke that stops hearing the Hub for
 * 2 s re-syncs and re-joins on its own.
 *
 * This directory is a complete, self-contained firmware for one situation. Other profiles live
 * next to it (firmware/<profile>/) and intentionally duplicate the shared protocol code so each
 * design can evolve independently. Anything on the wire (config block, frame layouts) must stay
 * in sync with internal/firmware/image.go and internal/ingest/wifi_udp.go.
 *
 * Identity: every board carries a random 32-bit fingerprint stamped at flash time. Spokes have no
 * fixed slot — on boot they send JOIN {fingerprint, name, profile} until the Hub replies ASSIGN
 * {fingerprint, slot}; the Hub forwards HELLO {slot, fingerprint} so the laptop maps the slot back
 * to the stable timer.
 */

#include <stdint.h>
#include <string.h>

/* ---- Profile tuning (unique to this directory) ------------------------------------------- */
#define SLAPRF_PROFILE_CODE      4
#define SWEEP_HZ                 50   // 8-channel 5.8 GHz sweeps per second
#define WINDOW_SAMPLES           6    // Sweeps per window frame
#define TX_EVERY_SWEEPS          2    // 6 / 2 = every sweep delivered three times
#define LINK_LONG_RANGE          1    // Espressif LR 500 kbps
#define TX_POWER_QDBM            80   // +20 dBm
#define TDMA_SLOT_US             3500 // LR frame (~2.1 ms) + guard
#define HUB_LOST_MS              2000 // Re-sync and re-join after this long without a Hub beacon

/* ---- Shared protocol ---------------------------------------------------------------------- */
#define MAX_PILOT_SLOTS          8
#define MAX_SPOKES               6

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

// Hardware hooks for ESP-IDF 5 GHz IQ power capture & 2.4 GHz ESP-NOW on ESP32-C5
extern void xiao_c5_select_ufl_antenna(void);
extern void slaprf_lock_wifi_band_2g4_only(void);
extern void slaprf_init_2g4_radio(uint8_t channel, uint8_t long_range, uint8_t tx_power_qdbm);
extern void slaprf_start_wifi_bridge(uint8_t wifi_mode, const char *ssid, const char *pass);
extern void slaprf_spoke_sync_to_hub_channel(void);
extern void slaprf_broadcast_hub_sync_beacon(uint8_t seq);
extern uint32_t slaprf_ms_since_hub_beacon(void);
extern void slaprf_wait_for_next_sweep_tick(uint32_t interval_us);
extern void slaprf_forward_udp_to_laptop(const void *frame, uint32_t len);
extern int8_t esp_sdr_measure_5g_channel_dbm(uint16_t center_freq_mhz);
extern uint16_t xiao_c5_read_battery_mv(void);
extern void espnow_send(const void *frame, uint32_t len);
extern int espnow_poll(void *buf, uint32_t cap);
extern void delay_microseconds(uint32_t us);

/* ---- Hub: slot table ---------------------------------------------------------------------- */

static uint32_t s_slot_fp[MAX_SPOKES]; // slot = index + 2

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
    slaprf_forward_udp_to_laptop(&h, sizeof(h));
}

/** Reuse a Spoke's slot if its fingerprint is known, else hand out the first free one. */
static void hub_handle_join(const spoke_join_frame_t *j) {
    int idx = -1;
    for (int i = 0; i < MAX_SPOKES; i++) {
        if (s_slot_fp[i] == j->fingerprint) { idx = i; break; }
    }
    for (int i = 0; idx < 0 && i < MAX_SPOKES; i++) {
        if (s_slot_fp[i] == 0) { idx = i; }
    }
    if (idx < 0) {
        return; // Course is full
    }
    s_slot_fp[idx] = j->fingerprint;
    uint8_t slot = (uint8_t)(idx + 2);

    hub_assign_frame_t a = { FRAME_MAGIC_0, FRAME_MAGIC_ASSIGN, j->fingerprint, slot, 0 };
    a.crc8 = compute_crc8((const uint8_t *)&a, sizeof(a) - 1);
    espnow_send(&a, sizeof(a));
    hub_send_hello(slot, j->role, j->fingerprint, j->profile, j->sweep_hz, j->timer_label);
}

static void hub_service_espnow(void) {
    uint8_t buf[250];
    int n;
    while ((n = espnow_poll(buf, sizeof(buf))) > 0) {
        if (n < 3 || buf[0] != FRAME_MAGIC_0 || compute_crc8(buf, (uint32_t)n - 1) != buf[n - 1]) {
            continue;
        }
        if (buf[1] == FRAME_MAGIC_JOIN && n == (int)sizeof(spoke_join_frame_t)) {
            hub_handle_join((const spoke_join_frame_t *)buf);
        } else if (buf[1] == FRAME_MAGIC_WINDOW || buf[1] == FRAME_MAGIC_SINGLE) {
            slaprf_forward_udp_to_laptop(buf, (uint32_t)n);
        }
    }
}

/* ---- Spoke: join handshake ---------------------------------------------------------------- */

static uint8_t spoke_join_hub(void) {
    spoke_join_frame_t j;
    memset(&j, 0, sizeof(j));
    j.magic0 = FRAME_MAGIC_0;
    j.magic1 = FRAME_MAGIC_JOIN;
    j.fingerprint = g_flash_cfg.fingerprint;
    j.role = ROLE_SPOKE_TIMER;
    j.profile = SLAPRF_PROFILE_CODE;
    j.sweep_hz = SWEEP_HZ;
    memcpy(j.timer_label, (const void *)g_flash_cfg.timer_label, sizeof(j.timer_label));
    j.crc8 = compute_crc8((const uint8_t *)&j, sizeof(j) - 1);

    uint8_t buf[64];
    for (;;) {
        espnow_send(&j, sizeof(j));
        for (int wait = 0; wait < 50; wait++) { // ~250 ms per attempt
            delay_microseconds(5000);
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

/* ---- Main loop ---------------------------------------------------------------------------- */

void app_main(void) {
    const uint8_t is_hub = g_flash_cfg.role == ROLE_HUB_TIMER;
    const uint32_t interval_us = 1000000UL / SWEEP_HZ;

    // 1. External U.FL antenna, 2.4 GHz-only band (never transmit on 5.8 GHz video channels).
    xiao_c5_select_ufl_antenna();
    slaprf_lock_wifi_band_2g4_only();
    slaprf_init_2g4_radio(WIFI_CHANNEL, LINK_LONG_RANGE, TX_POWER_QDBM);

    // 2. Hub brings up the laptop bridge and announces itself; Spokes find the Hub and get a slot.
    uint8_t slot = HUB_SLOT;
    if (is_hub) {
        slaprf_start_wifi_bridge(g_flash_cfg.wifi_mode, (const char *)g_flash_cfg.wifi_ssid,
                                 (const char *)g_flash_cfg.wifi_pass);
        hub_send_hello(HUB_SLOT, ROLE_HUB_TIMER, g_flash_cfg.fingerprint, SLAPRF_PROFILE_CODE, SWEEP_HZ,
                       (const char *)g_flash_cfg.timer_label);
    } else {
        slaprf_spoke_sync_to_hub_channel();
        slot = spoke_join_hub();
    }

    raw_rssi_sample_t ring[WINDOW_SAMPLES];
    memset(ring, 0, sizeof(ring));
    uint8_t filled = 0;
    uint8_t seq = 0;
    uint32_t sweeps = 0;

    while (1) {
        slaprf_wait_for_next_sweep_tick(interval_us);

        // Obstructed only: if the Hub beacon has been gone too long, re-sync and re-join.
        if (!is_hub && slaprf_ms_since_hub_beacon() > HUB_LOST_MS) {
            slaprf_spoke_sync_to_hub_channel();
            slot = spoke_join_hub();
        }

        // 3. Sweep all 8 pilot channels into the ring (oldest sample drops off the front).
        if (filled < WINDOW_SAMPLES) {
            filled++;
        } else {
            memmove(&ring[0], &ring[1], sizeof(raw_rssi_sample_t) * (WINDOW_SAMPLES - 1));
        }
        raw_rssi_sample_t *cur = &ring[filled - 1];
        cur->seq_num = seq++;
        for (int i = 0; i < MAX_PILOT_SLOTS; i++) {
            int8_t raw = esp_sdr_measure_5g_channel_dbm(g_flash_cfg.slot_freqs_mhz[i]);
            cur->rssi_dbm[i] = raw;
        }
        sweeps++;

        if (is_hub) {
            hub_service_espnow();
        }

        // 4. Every TX_EVERY_SWEEPS sweeps, send the window (WINDOW_SAMPLES / TX_EVERY_SWEEPS = overlap).
        if (sweeps % TX_EVERY_SWEEPS != 0) {
            continue;
        }

        uint8_t pkt[sizeof(timer_window_frame_t)];
        timer_window_frame_t *w = (timer_window_frame_t *)pkt;
        w->magic0 = FRAME_MAGIC_0;
        w->magic1 = FRAME_MAGIC_WINDOW;
        w->slot = slot;
        w->sample_count = filled;
        w->battery_mv = xiao_c5_read_battery_mv();
        w->noise_floor_dbm = -92;
        memcpy(w->samples, ring, sizeof(raw_rssi_sample_t) * filled);
        uint32_t len = 7 + (uint32_t)filled * sizeof(raw_rssi_sample_t);
        pkt[len] = compute_crc8(pkt, len);
        len += 1;

        if (is_hub) {
            slaprf_broadcast_hub_sync_beacon(seq);
            slaprf_forward_udp_to_laptop(pkt, len);
        } else {
            // Collision-free TDMA: each Spoke waits (slot - 2) slots after the Hub beacon.
            delay_microseconds((uint32_t)(slot - 2) * TDMA_SLOT_US);
            espnow_send(pkt, len);
        }
    }
}
