/**
 * SlapRF — Seeed Studio XIAO ESP32-C5 5.8 GHz Wideband SDR Timer Firmware
 *
 * Single-Wi-Fi Star Topology (No Laptop Dongle, Only 1 Wi-Fi Connection):
 *   - Timer #1 (ROLE_HUB_TIMER):
 *       Acts as the Hub timer (typically placed on the gate closest to the laptop).
 *       1. Connects to the laptop over Wi-Fi (either creating the "SlapRF" Wi-Fi AP
 *          or joining a configured SSID).
 *       2. Sweeps the 8 pilot 5.8 GHz VTX frequencies at 50 Hz.
 *       3. Listens for connectionless ESP-NOW bursts from Spoke Timers #2..#16 and
 *          forwards both its own frames and all Spoke Timer frames to the laptop
 *          over its single Wi-Fi UDP link.
 *   - Timers #2..#16 (ROLE_SPOKE_TIMER):
 *       Sit out on the track at any gate.
 *       Never join Wi-Fi, never need DHCP or passwords — they simply sweep 5.8 GHz
 *       and burst a 16-byte ESP-NOW packet to the Hub Timer in their staggered TDMA micro-slot.
 */

#include <stdint.h>
#include <string.h>

#define MAX_PILOT_SLOTS         8
#define FRAME_MAGIC_0           0xC5
#define FRAME_MAGIC_1           0x58

#define ROLE_HUB_TIMER          1   // Hub Timer: Wi-Fi + ESP-NOW Bridge to Laptop
#define ROLE_SPOKE_TIMER        2   // Spoke Timers #2..#16: ESP-NOW -> Hub Timer

#pragma pack(push, 1)
typedef struct {
    char     magic[8];                        // "SLAPRF01"
    uint8_t  version;                         // 1
    uint8_t  role;                            // 1 = Hub Timer (Wi-Fi + ESP-NOW), 2 = Spoke Timer (ESP-NOW)
    uint8_t  timer_id;                        // 1..16
    uint8_t  wifi_mode;                       // 0 = Host "SlapRF" AP, 1 = Join wifi_ssid
    uint16_t slot_freqs_mhz[MAX_PILOT_SLOTS]; // 8 pilot frequencies in MHz
    uint16_t tdma_offset_us;                  // (timer_id - 1) * 350 us
    char     wifi_ssid[33];                   // Used by Hub Timer only
    char     wifi_pass[40];                   // Used by Hub Timer only
    char     timer_label[24];                 // Flashed Timer ID / name
    uint8_t  crc8;                            // XOR checksum of bytes [0..126]
} slaprf_flash_config_t;

typedef struct {
    uint8_t  magic0;                          // 0xC5
    uint8_t  magic1;                          // 0x58
    uint8_t  timer_id;                        // 1..16
    uint8_t  seq_num;                         // Rolling 0..255 frame counter
    uint16_t battery_mv;                      // Supply voltage in mV (e.g. 5000 on USB BEC)
    int8_t   noise_floor_dbm;                 // Ambient 5.8 GHz floor (e.g. -92)
    int8_t   rssi_dbm[MAX_PILOT_SLOTS];       // 8 pilot channels in dBm (-95 .. -20)
    uint8_t  crc8;                            // XOR checksum of bytes [0..14]
} timer_telemetry_frame_t;
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

// Hardware hooks for ESP-IDF / ESP-SDR 5GHz IQ baseband power capture on ESP32-C5
extern void xiao_c5_select_ufl_antenna(void);
extern void slaprf_start_wifi_bridge(uint8_t wifi_mode, const char *ssid, const char *pass);
extern void slaprf_forward_udp_to_laptop(const timer_telemetry_frame_t *frame);
extern int8_t esp_sdr_measure_5g_channel_dbm(uint16_t center_freq_mhz);
extern uint16_t xiao_c5_read_battery_mv(void);
extern void espnow_send_to_hub_timer(const timer_telemetry_frame_t *frame);
extern void delay_microseconds(uint32_t us);

void app_main(void) {
    // 1. Route RF switch to the external U.FL antenna
    xiao_c5_select_ufl_antenna();

    // 2. Only the Hub Timer starts the Wi-Fi link to the laptop and listens for ESP-NOW from Spoke Timers
    if (g_flash_cfg.role == ROLE_HUB_TIMER) {
        slaprf_start_wifi_bridge(
            g_flash_cfg.wifi_mode,
            (const char *)g_flash_cfg.wifi_ssid,
            (const char *)g_flash_cfg.wifi_pass
        );
    }

    uint8_t timer_id = g_flash_cfg.timer_id;
    if (timer_id < 1 || timer_id > 16) {
        timer_id = 1;
    }

    uint8_t seq = 0;
    while (1) {
        timer_telemetry_frame_t frame;
        frame.magic0          = FRAME_MAGIC_0;
        frame.magic1          = FRAME_MAGIC_1;
        frame.timer_id        = timer_id;
        frame.seq_num         = seq++;
        frame.battery_mv      = xiao_c5_read_battery_mv();
        frame.noise_floor_dbm = -92;

        // 3. Sweep all 8 pilot 5.8 GHz frequencies via wideband IQ FFT power measurement
        for (int i = 0; i < MAX_PILOT_SLOTS; i++) {
            frame.rssi_dbm[i] = esp_sdr_measure_5g_channel_dbm(g_flash_cfg.slot_freqs_mhz[i]);
        }

        frame.crc8 = compute_crc8((const uint8_t *)&frame, sizeof(frame) - 1);

        if (g_flash_cfg.role == ROLE_HUB_TIMER) {
            // Hub Timer sends its own frame (plus any queued ESP-NOW Spoke frames) over Wi-Fi UDP
            slaprf_forward_udp_to_laptop(&frame);
        } else {
            // Spoke Timers #2..#16 burst their 16-byte frame over connectionless ESP-NOW to the Hub Timer
            delay_microseconds(g_flash_cfg.tdma_offset_us);
            espnow_send_to_hub_timer(&frame);
        }
    }
}
