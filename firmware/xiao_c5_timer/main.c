/**
 * SlapRF — Seeed Studio XIAO ESP32-C5 5.8 GHz Wideband SDR Timer Firmware
 *
 * Ground-Interference Resilient Hub / Spoke Architecture:
 *   - Spokes (#2..#6, ROLE_SPOKE_TIMER) are pure 5.8 GHz recording devices:
 *       * Zero on-board peak detection or lap math — all DSP runs on the laptop.
 *       * Every 20 ms (50 Hz), the Spoke sweeps the 8 pilot 5.8 GHz frequencies and
 *         pushes the raw 8-channel RSSI slice into a 4-sample circular ring buffer.
 *       * Every 40 ms (25 Hz), in its collision-free TDMA slot, the Spoke bursts the
 *         last 4 raw samples (80 ms sliding window = 2x overlap FEC) to the Hub over
 *         Espressif Long Range 2.4 GHz (WIFI_PROTOCOL_LR / WIFI_PHY_RATE_LORA_500K at
 *         +20 dBm max TX power on Channel 1 / 2412 MHz).
 *       * Even if 50% of packets are lost to wet grass absorption, Fresnel grazing, or
 *         2.4 GHz ELRS transmitter bursts, the next packet 40 ms later automatically
 *         delivers the missing 20 ms samples with zero gaps.
 *   - Hub (#1, ROLE_HUB_TIMER):
 *       * Runs hybrid 802.11b/g/n + WIFI_PROTOCOL_LR on 2.4 GHz Channel 1 at +20 dBm.
 *       * Broadcasts a 25 Hz timing sync beacon so all Spokes align their 5.8 GHz sweep
 *         windows and staggered 3.5 ms LR TDMA transmit slots while the Hub is parked
 *         on 2.4 GHz listening.
 *       * Forwards its own 50 Hz sweeps and all received Spoke sliding-window frames to
 *         the laptop over Wi-Fi UDP (:5404).
 */

#include <stdint.h>
#include <string.h>

#define MAX_PILOT_SLOTS          8
#define MAX_TIMERS               6
#define SLIDING_WINDOW_SAMPLES   4    // 4 x 20ms = 80ms window sent every 40ms (2x overlap FEC)
#define SAMPLE_INTERVAL_MS       20   // 50 Hz 5.8 GHz channel sweep period

#define FRAME_MAGIC_0            0xC5
#define FRAME_MAGIC_SINGLE       0x58 // Single 50 Hz sample frame (16 bytes)
#define FRAME_MAGIC_WINDOW       0x59 // 4-sample sliding-window LR recorder frame (44 bytes)

#define ROLE_HUB_TIMER           1    // Hub Timer: Wi-Fi + ESP-NOW LR Bridge to Laptop
#define ROLE_SPOKE_TIMER         2    // Spoke Timers #2..#6: Pure Recorder -> ESP-NOW LR -> Hub

#define WIFI_CHANNEL_LR          1    // 2412 MHz: lowest ground absorption & below upper 2.4GHz clutter
#define MAX_TX_POWER_QDBM        80   // +20.0 dBm (80 x 0.25 dBm) maximum PA output for ground links
#define LR_TDMA_SLOT_SPACING_US  3500 // 3.5 ms per Spoke slot (fits 2.1 ms LR 500K frame + guard time)

#pragma pack(push, 1)
typedef struct {
    char     magic[8];                        // "SLAPRF01"
    uint8_t  version;                         // 1
    uint8_t  role;                            // 1 = Hub Timer (Wi-Fi + ESP-NOW LR), 2 = Spoke Timer (ESP-NOW LR)
    uint8_t  timer_id;                        // 1..6
    uint8_t  wifi_mode;                       // 0 = Host "SlapRF" AP, 1 = Join wifi_ssid
    uint16_t slot_freqs_mhz[MAX_PILOT_SLOTS]; // 8 pilot frequencies in MHz
    uint16_t tdma_offset_us;                  // (timer_id - 1) * 3500 us collision-free LR slot
    char     wifi_ssid[33];                   // Used by Hub Timer only
    char     wifi_pass[40];                   // Used by Hub Timer only
    char     timer_label[24];                 // Flashed Timer ID / name
    uint8_t  crc8;                            // XOR checksum of bytes [0..126]
} slaprf_flash_config_t;

typedef struct {
    uint8_t  magic0;                          // 0xC5
    uint8_t  magic1;                          // 0x58
    uint8_t  timer_id;                        // 1..6
    uint8_t  seq_num;                         // Rolling 0..255 frame counter
    uint16_t battery_mv;                      // Supply voltage in mV (e.g. 5000 on USB BEC)
    int8_t   noise_floor_dbm;                 // Ambient 5.8 GHz floor (e.g. -92)
    int8_t   rssi_dbm[MAX_PILOT_SLOTS];       // 8 pilot channels in dBm (-95 .. -20)
    uint8_t  crc8;                            // XOR checksum of bytes [0..14]
} timer_telemetry_frame_t;

/** Single 20 ms 8-channel 5.8 GHz sweep stored in the Spoke's circular recording buffer. */
typedef struct {
    uint8_t  seq_num;                         // Monotonic 0..255 sweep sequence number
    int8_t   rssi_dbm[MAX_PILOT_SLOTS];       // Raw 8-channel 5.8 GHz RSSI in dBm
} raw_rssi_sample_t;

/**
 * 44-byte Sliding-Window Recorder Frame (Magic 0xC5 0x59):
 * Carries the last 4 consecutive 20 ms sweeps (oldest -> newest) in a single ESP-NOW LR burst.
 * Transmitted every 2 sweeps (40 ms) so every 20 ms sweep is delivered twice across consecutive bursts.
 */
typedef struct {
    uint8_t           magic0;                 // 0xC5
    uint8_t           magic1;                 // 0x59 (FRAME_MAGIC_WINDOW)
    uint8_t           timer_id;               // 1..6
    uint8_t           sample_count;           // 1..4 valid samples in `samples` (oldest to newest)
    uint16_t          battery_mv;             // Supply voltage in mV
    int8_t            noise_floor_dbm;        // Ambient 5.8 GHz noise floor in dBm
    raw_rssi_sample_t samples[SLIDING_WINDOW_SAMPLES]; // 4 x 9 bytes = 36 bytes
    uint8_t           crc8;                   // XOR checksum of bytes [0..42]
} timer_window_frame_t;
#pragma pack(pop)

// Patched on-the-fly by the Go server (`internal/firmware/image.go`) when the
// browser requests `/api/firmware/xiao-c5.bin?role=hub|spoke&label=...`.
__attribute__((used, section(".rodata.slaprf_cfg")))
static const volatile slaprf_flash_config_t g_flash_cfg = {
    .magic          = {'S', 'L', 'A', 'P', 'R', 'F', '0', '1'},
    .version        = 1,
    .role           = ROLE_HUB_TIMER,
    .timer_id       = 1,
    .wifi_mode      = 0,
    .slot_freqs_mhz = {5658, 5732, 5806, 5917, 5695, 5769, 5843, 5880},
    .tdma_offset_us = 0,
    .wifi_ssid      = {0},
    .wifi_pass      = {0},
    .timer_label    = {0},
    .crc8           = 0,
};

static uint8_t compute_crc8(const uint8_t *data, uint32_t len) {
    uint8_t crc = 0;
    for (uint32_t i = 0; i < len; i++) {
        crc ^= data[i];
    }
    return crc;
}

// Hardware hooks for ESP-IDF 5GHz IQ power capture & 2.4GHz WIFI_PROTOCOL_LR on ESP32-C5
extern void xiao_c5_select_ufl_antenna(void);
extern void slaprf_lock_wifi_band_2g4_only(void);
extern void slaprf_init_2g4_lr_radio(uint8_t channel, int8_t max_tx_power_qdbm);
extern void slaprf_start_wifi_bridge(uint8_t wifi_mode, const char *ssid, const char *pass);
extern void slaprf_spoke_sync_to_hub_channel(void);
extern void slaprf_broadcast_hub_sync_beacon(uint8_t seq);
extern void slaprf_wait_for_next_sweep_tick(uint32_t interval_ms);
extern void slaprf_forward_window_udp_to_laptop(const timer_window_frame_t *frame);
extern int8_t esp_sdr_measure_5g_channel_dbm(uint16_t center_freq_mhz);
extern uint16_t xiao_c5_read_battery_mv(void);
extern void espnow_lr_send_window_to_hub(const timer_window_frame_t *frame);
extern void delay_microseconds(uint32_t us);

void app_main(void) {
    // 1. Route RF switch to the external U.FL antenna, force 2.4 GHz-only Wi-Fi band mode
    //    (WIFI_BAND_MODE_2G_ONLY so the Hub never transmits on 5.8 GHz FPV video channels),
    //    and configure 2.4 GHz LR PHY (+20 dBm, default Ch 1).
    xiao_c5_select_ufl_antenna();
    slaprf_lock_wifi_band_2g4_only();
    slaprf_init_2g4_lr_radio(WIFI_CHANNEL_LR, MAX_TX_POWER_QDBM);

    // 2. Hub Timer starts hybrid 802.11n + LR Wi-Fi bridge to laptop:
    //      - wifi_mode == 0 (empty SSID): Hub hosts "SlapRF" 2.4 GHz AP on Channel 1.
    //      - wifi_mode == 1 (SSID set):   Hub joins the 2.4 GHz BSSID of the hotspot/router.
    //    Spoke Timers scan & lock onto the Hub's active 2.4 GHz channel via the Hub sync beacon.
    if (g_flash_cfg.role == ROLE_HUB_TIMER) {
        slaprf_start_wifi_bridge(
            g_flash_cfg.wifi_mode,
            (const char *)g_flash_cfg.wifi_ssid,
            (const char *)g_flash_cfg.wifi_pass
        );
    } else {
        slaprf_spoke_sync_to_hub_channel();
    }

    uint8_t timer_id = g_flash_cfg.timer_id;
    if (timer_id < 1 || timer_id > MAX_TIMERS) {
        timer_id = 1;
    }

    raw_rssi_sample_t ring[SLIDING_WINDOW_SAMPLES];
    memset(ring, 0, sizeof(ring));
    uint8_t filled = 0;
    uint8_t seq = 0;

    while (1) {
        slaprf_wait_for_next_sweep_tick(SAMPLE_INTERVAL_MS);

        // 3. Pure Recorder Sweep: sample all 8 pilot 5.8 GHz channels and shift into 4-sample ring
        if (filled < SLIDING_WINDOW_SAMPLES) {
            filled++;
        } else {
            for (int k = 0; k < SLIDING_WINDOW_SAMPLES - 1; k++) {
                ring[k] = ring[k + 1];
            }
        }
        raw_rssi_sample_t *cur = &ring[filled - 1];
        cur->seq_num = seq;
        for (int i = 0; i < MAX_PILOT_SLOTS; i++) {
            cur->rssi_dbm[i] = esp_sdr_measure_5g_channel_dbm(g_flash_cfg.slot_freqs_mhz[i]);
        }
        seq++;

        // 4. Every 2 sweeps (40 ms / 25 Hz), pack the 4-sample sliding window (2 new + 2 overlap)
        if ((seq & 1U) != 0 && filled > 1) {
            continue;
        }

        timer_window_frame_t wframe;
        memset(&wframe, 0, sizeof(wframe));
        wframe.magic0          = FRAME_MAGIC_0;
        wframe.magic1          = FRAME_MAGIC_WINDOW;
        wframe.timer_id        = timer_id;
        wframe.sample_count    = filled;
        wframe.battery_mv      = xiao_c5_read_battery_mv();
        wframe.noise_floor_dbm = -92;
        for (uint8_t k = 0; k < filled; k++) {
            wframe.samples[k] = ring[k];
        }
        wframe.crc8 = compute_crc8((const uint8_t *)&wframe, sizeof(wframe) - 1);

        if (g_flash_cfg.role == ROLE_HUB_TIMER) {
            // Broadcast sync beacon so Spokes align their TDMA slots while Hub listens on 2.4 GHz LR
            slaprf_broadcast_hub_sync_beacon(seq);
            slaprf_forward_window_udp_to_laptop(&wframe);
        } else {
            // Spoke waits for its deterministic LR TDMA slot ((timer_id - 1) * 3500 us) and bursts
            delay_microseconds(g_flash_cfg.tdma_offset_us);
            espnow_lr_send_window_to_hub(&wframe);
        }
    }
}
