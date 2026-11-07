/**
 * SlapRF — Seeed Studio XIAO ESP32-C5 5.8 GHz Wideband SDR Firmware
 *
 * Single-Wi-Fi Star Topology (No Laptop Dongle, Only 1 Wi-Fi Connection):
 *   - Puck #1 (ROLE_START_BRIDGE):
 *       Sits at the Start/Finish gate right near the pilot bench.
 *       1. Connects to the laptop over Wi-Fi (either creating the "SlapRF" Wi-Fi AP
 *          or joining a configured SSID).
 *       2. Sweeps the 8 pilot 5.8 GHz VTX frequencies at 50 Hz for Gate 1.
 *       3. Listens for connectionless ESP-NOW bursts from Field Pucks #2..#16 and
 *          forwards both its own Gate 1 frames and all Field Puck frames to the laptop
 *          over its single Wi-Fi UDP link.
 *   - Pucks #2..#16 (ROLE_FIELD_PUCK):
 *       Sit out on the course at Sector Gates 2, 3, 4...
 *       Never join Wi-Fi, never need DHCP or passwords — they simply sweep 5.8 GHz
 *       and burst a 16-byte ESP-NOW packet to Puck #1 in their staggered TDMA micro-slot.
 */

#include <stdint.h>
#include <string.h>

#define MAX_PILOT_SLOTS         8
#define FRAME_MAGIC_0           0xC5
#define FRAME_MAGIC_1           0x58

#define ROLE_START_BRIDGE       1   // Puck #1: Start/Finish Gate + Wi-Fi Bridge to Laptop
#define ROLE_FIELD_PUCK         2   // Pucks #2..#16: ESP-NOW -> Puck #1

#pragma pack(push, 1)
typedef struct {
    char     magic[8];                        // "SLAPRF01"
    uint8_t  version;                         // 1
    uint8_t  role;                            // 1 = Start+Wi-Fi Bridge, 2 = ESP-NOW Field Puck
    uint8_t  puck_id;                         // 1..16
    uint8_t  wifi_mode;                       // 0 = Host "SlapRF" AP, 1 = Join wifi_ssid
    uint16_t slot_freqs_mhz[MAX_PILOT_SLOTS]; // 8 pilot frequencies in MHz
    uint16_t tdma_offset_us;                  // (puck_id - 1) * 350 us
    char     wifi_ssid[33];                   // Used by Puck #1 only
    char     wifi_pass[64];                   // Used by Puck #1 only
    uint8_t  crc8;                            // XOR checksum of bytes [0..126]
} slaprf_flash_config_t;

typedef struct {
    uint8_t  magic0;                          // 0xC5
    uint8_t  magic1;                          // 0x58
    uint8_t  puck_id;                         // 1..16
    uint8_t  seq_num;                         // Rolling 0..255 frame counter
    uint16_t battery_mv;                      // Supply voltage in mV (e.g. 5000 on USB BEC)
    int8_t   noise_floor_dbm;                 // Ambient 5.8 GHz floor (e.g. -92)
    int8_t   rssi_dbm[MAX_PILOT_SLOTS];       // 8 pilot channels in dBm (-95 .. -20)
    uint8_t  crc8;                            // XOR checksum of bytes [0..14]
} puck_telemetry_frame_t;
#pragma pack(pop)

// Patched on-the-fly by the Go server (`internal/firmware/image.go`) when the
// browser requests `/api/firmware/xiao-c5.bin?puckId=N`.
__attribute__((used, section(".rodata.slaprf_cfg")))
static const volatile slaprf_flash_config_t g_flash_cfg = {
    .magic          = {'S', 'L', 'A', 'P', 'R', 'F', '0', '1'},
    .version        = 1,
    .role           = ROLE_START_BRIDGE,
    .puck_id        = 1,
    .wifi_mode      = 0,
    .slot_freqs_mhz = {5658, 5732, 5806, 5917, 5695, 5769, 5843, 5880},
    .tdma_offset_us = 0,
    .wifi_ssid      = {0},
    .wifi_pass      = {0},
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
extern void slaprf_forward_udp_to_laptop(const puck_telemetry_frame_t *frame);
extern int8_t esp_sdr_measure_5g_channel_dbm(uint16_t center_freq_mhz);
extern uint16_t xiao_c5_read_battery_mv(void);
extern void espnow_send_to_start_puck(const puck_telemetry_frame_t *frame);
extern void delay_microseconds(uint32_t us);

void app_main(void) {
    // 1. Route RF switch to the external U.FL antenna
    xiao_c5_select_ufl_antenna();

    // 2. Only Puck #1 starts the Wi-Fi link to the laptop and listens for ESP-NOW from Pucks #2..N
    if (g_flash_cfg.role == ROLE_START_BRIDGE) {
        slaprf_start_wifi_bridge(
            g_flash_cfg.wifi_mode,
            (const char *)g_flash_cfg.wifi_ssid,
            (const char *)g_flash_cfg.wifi_pass
        );
    }

    uint8_t puck_id = g_flash_cfg.puck_id;
    if (puck_id < 1 || puck_id > 16) {
        puck_id = 1;
    }

    uint8_t seq = 0;
    while (1) {
        puck_telemetry_frame_t frame;
        frame.magic0          = FRAME_MAGIC_0;
        frame.magic1          = FRAME_MAGIC_1;
        frame.puck_id         = puck_id;
        frame.seq_num         = seq++;
        frame.battery_mv      = xiao_c5_read_battery_mv();
        frame.noise_floor_dbm = -92;

        // 3. Sweep all 8 pilot 5.8 GHz frequencies via wideband IQ FFT power measurement
        for (int i = 0; i < MAX_PILOT_SLOTS; i++) {
            frame.rssi_dbm[i] = esp_sdr_measure_5g_channel_dbm(g_flash_cfg.slot_freqs_mhz[i]);
        }

        frame.crc8 = compute_crc8((const uint8_t *)&frame, sizeof(frame) - 1);

        if (g_flash_cfg.role == ROLE_START_BRIDGE) {
            // Puck #1 sends its own Gate 1 frame (plus any queued ESP-NOW frames) over Wi-Fi UDP
            slaprf_forward_udp_to_laptop(&frame);
        } else {
            // Field Pucks #2..#16 burst their 16-byte frame over connectionless ESP-NOW to Puck #1
            delay_microseconds(g_flash_cfg.tdma_offset_us);
            espnow_send_to_start_puck(&frame);
        }
    }
}
