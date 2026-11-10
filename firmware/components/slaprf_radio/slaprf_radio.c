/**
 * slaprf_radio — 2.4 GHz Wi-Fi / ESP-NOW link, USB relay of Hub frames, sweep pacing, and USB
 * config readback for the XIAO ESP32-C5.
 */
#include "slaprf_radio.h"

#include <string.h>

#include "driver/usb_serial_jtag.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_now.h"
#include "esp_rom_sys.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "soc/soc_caps.h"

static const char *TAG = "slaprf_radio";

#define BEACON_MAGIC_0      0xC5
#define BEACON_MAGIC_1      0x5D // Hub -> Spokes sync beacon (4 bytes, or 20 bytes with 8 x uint16_t channel table)
#define RX_QUEUE_DEPTH      32
#define ESPNOW_MAX_FRAME    250

typedef struct {
    uint8_t len;
    uint8_t data[ESPNOW_MAX_FRAME];
} rx_item_t;

static const uint8_t BROADCAST_MAC[ESP_NOW_ETH_ALEN] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

static QueueHandle_t s_rx_queue;
static volatile int64_t s_last_beacon_us;
static uint8_t s_hub_beacon_mac[6];
static volatile bool s_has_hub_beacon_mac;
static esp_netif_t *s_sta_netif;

static uint8_t xor8(const uint8_t *data, uint32_t len) {
    uint8_t c = 0;
    for (uint32_t i = 0; i < len; i++) {
        c ^= data[i];
    }
    return c;
}

/* ---- Board ---------------------------------------------------------------------------------- */

void xiao_c5_select_ufl_antenna(void) {
    // TODO(hardware): drive the XIAO ESP32-C5 RF switch GPIO to the U.FL port once confirmed
    // against Seeed's schematic. Until then the board's default antenna path is used.
}

uint16_t xiao_c5_read_battery_mv(void) {
    // TODO(hardware): read the battery divider via ADC oneshot. 0 = unknown to the laptop.
    return 0;
}

/* ---- 2.4 GHz link --------------------------------------------------------------------------- */

/* ---- Link diagnostics: what the last ESP-NOW frames looked like on air ---------------------- */
static volatile int8_t s_rx_rssi;
static volatile uint8_t s_rx_rate;    // rx_ctrl->rate (11b rate code, or L-SIG rate field otherwise)
static volatile uint8_t s_rx_format;  // rx_ctrl->cur_bb_format (frame format: 11b / 11g / HT / HE / LR...)
static volatile uint32_t s_rx_beacons;
static volatile uint32_t s_rx_data;
static const char *s_tx_mode = "default";
static int8_t s_tx_power_qdbm;    // Active max TX power (quarter dBm)
static bool s_link_saved;         // True if rate and/or power came from saved serial-console settings

#define LINK_NVS_NAMESPACE "slaprf_link"
static const char *s_default_rate = "6m";   // Firmware defaults (from main.c), used by LINKRESET
static int8_t s_default_qdbm = 80;
void slaprf_link_settings(int8_t *tx_power_qdbm, bool *saved) {
    if (tx_power_qdbm) *tx_power_qdbm = s_tx_power_qdbm;
    if (saved) *saved = s_link_saved;
}

void slaprf_link_stats(int8_t *rssi, uint8_t *rate, uint8_t *format, uint32_t *beacons, uint32_t *data,
                       const char **tx_mode) {
    if (rssi) *rssi = s_rx_rssi;
    if (rate) *rate = s_rx_rate;
    if (format) *format = s_rx_format;
    if (beacons) *beacons = s_rx_beacons;
    if (data) *data = s_rx_data;
    if (tx_mode) *tx_mode = s_tx_mode;
}

/** Set the PHY mode/rate used for every ESP-NOW frame this board transmits (broadcast peer). */
static bool apply_link_rate(const char *mode) {
    esp_now_rate_config_t cfg = {0};
    if (strcmp(mode, "lr250") == 0) {
        cfg.phymode = WIFI_PHY_MODE_LR; cfg.rate = WIFI_PHY_RATE_LORA_250K;
    } else if (strcmp(mode, "lr500") == 0) {
        cfg.phymode = WIFI_PHY_MODE_LR; cfg.rate = WIFI_PHY_RATE_LORA_500K;
    } else if (strcmp(mode, "1m") == 0) {
        cfg.phymode = WIFI_PHY_MODE_11B; cfg.rate = WIFI_PHY_RATE_1M_L;
    } else if (strcmp(mode, "6m") == 0) {
        cfg.phymode = WIFI_PHY_MODE_11G; cfg.rate = WIFI_PHY_RATE_6M;
    } else if (strcmp(mode, "mcs0") == 0) {
        cfg.phymode = WIFI_PHY_MODE_HT20; cfg.rate = WIFI_PHY_RATE_MCS0_LGI;
    } else {
        return false;
    }
    if (esp_now_set_peer_rate_config(BROADCAST_MAC, &cfg) != ESP_OK) {
        return false;
    }
    static const char *const names[] = {"lr250", "lr500", "1m", "6m", "mcs0"};
    for (size_t i = 0; i < sizeof(names) / sizeof(names[0]); i++) {
        if (strcmp(mode, names[i]) == 0) s_tx_mode = names[i];
    }
    return true;
}

static void nvs_save_str(const char *key, const char *value) {
    nvs_handle_t h;
    if (nvs_open(LINK_NVS_NAMESPACE, NVS_READWRITE, &h) == ESP_OK) {
        nvs_set_str(h, key, value);
        nvs_commit(h);
        nvs_close(h);
    }
}

static void nvs_save_i8(const char *key, int8_t value) {
    nvs_handle_t h;
    if (nvs_open(LINK_NVS_NAMESPACE, NVS_READWRITE, &h) == ESP_OK) {
        nvs_set_i8(h, key, value);
        nvs_commit(h);
        nvs_close(h);
    }
}

bool slaprf_set_link_rate(const char *mode, bool persist) {
    if (!apply_link_rate(mode)) {
        return false;
    }
    if (persist) {
        nvs_save_str("rate", mode);
        s_link_saved = true;
    }
    return true;
}

bool slaprf_set_tx_power_dbm(int dbm, bool persist) {
    if (dbm < 2 || dbm > 20) {
        return false;
    }
    const int8_t qdbm = (int8_t)(dbm * 4);
    if (esp_wifi_set_max_tx_power(qdbm) != ESP_OK) {
        return false;
    }
    s_tx_power_qdbm = qdbm;
    if (persist) {
        nvs_save_i8("txpwr", qdbm);
        s_link_saved = true;
    }
    return true;
}

void slaprf_apply_link_settings(const char *default_rate, int8_t default_tx_power_qdbm) {
    s_default_rate = default_rate;
    s_default_qdbm = default_tx_power_qdbm;
    char rate[8] = {0};
    int8_t qdbm = default_tx_power_qdbm;
    bool saved = false;
    nvs_handle_t h;
    if (nvs_open(LINK_NVS_NAMESPACE, NVS_READONLY, &h) == ESP_OK) {
        size_t len = sizeof(rate);
        if (nvs_get_str(h, "rate", rate, &len) == ESP_OK) saved = true; else rate[0] = 0;
        if (nvs_get_i8(h, "txpwr", &qdbm) == ESP_OK) saved = true; else qdbm = default_tx_power_qdbm;
        nvs_close(h);
    }
    if (rate[0] == 0 || !apply_link_rate(rate)) {
        apply_link_rate(default_rate);
    }
    if (esp_wifi_set_max_tx_power(qdbm) == ESP_OK) {
        s_tx_power_qdbm = qdbm;
    }
    s_link_saved = saved;
    ESP_LOGI(TAG, "link: tx %s, %d qdBm (%s)", s_tx_mode, s_tx_power_qdbm, saved ? "saved settings" : "defaults");
}

void slaprf_reset_link_settings(void) {
    nvs_handle_t h;
    if (nvs_open(LINK_NVS_NAMESPACE, NVS_READWRITE, &h) == ESP_OK) {
        nvs_erase_all(h);
        nvs_commit(h);
        nvs_close(h);
    }
    slaprf_apply_link_settings(s_default_rate, s_default_qdbm);
}

static void espnow_recv_cb(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
    if (len <= 0 || len > ESPNOW_MAX_FRAME) {
        return;
    }
    if (info && info->rx_ctrl) {
        s_rx_rssi = (int8_t)info->rx_ctrl->rssi;
        s_rx_rate = (uint8_t)info->rx_ctrl->rate;
        s_rx_format = (uint8_t)info->rx_ctrl->cur_bb_format;
    }
    if ((len == 4 || len == 20) && data[0] == BEACON_MAGIC_0 && data[1] == BEACON_MAGIC_1 &&
        xor8(data, (uint32_t)len - 1) == data[len - 1]) {
        s_last_beacon_us = esp_timer_get_time();
        s_rx_beacons++;
        if (info && info->src_addr) {
            memcpy(s_hub_beacon_mac, info->src_addr, 6);
            s_has_hub_beacon_mac = true;
        }
        if (len == 20) {
            uint16_t freqs[8];
            for (int i = 0; i < 8; i++) {
                freqs[i] = (uint16_t)(data[3 + i * 2] | ((uint16_t)data[4 + i * 2] << 8));
            }
            slaprf_diag_set_net_channels(freqs);
        }
        return;
    }
    s_rx_data++;
    rx_item_t item;
    item.len = (uint8_t)len;
    memcpy(item.data, data, (size_t)len);
    xQueueSend(s_rx_queue, &item, 0);
}

void slaprf_lock_wifi_band_2g4_only(void) {
    // Applied in slaprf_init_2g4_radio() once Wi-Fi is started (the API needs a running driver).
}

void slaprf_init_2g4_radio(uint8_t channel, uint8_t long_range, uint8_t tx_power_qdbm) {
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    s_rx_queue = xQueueCreate(RX_QUEUE_DEPTH, sizeof(rx_item_t));
    s_sta_netif = esp_netif_create_default_wifi_sta();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_start());
    // Keep the PHY powered between frames: the 5.8 GHz capture engine needs it, and modem sleep
    // would break the TDMA schedule.
    ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_NONE));

#if SOC_WIFI_SUPPORT_5G
    // Never transmit on 5 GHz: that band carries the pilots' FPV video.
    ESP_ERROR_CHECK(esp_wifi_set_band_mode(WIFI_BAND_MODE_2G_ONLY));
#endif

    uint8_t protocols = WIFI_PROTOCOL_11B | WIFI_PROTOCOL_11G | WIFI_PROTOCOL_11N;
    if (long_range) {
        protocols |= WIFI_PROTOCOL_LR;
    }
    ESP_ERROR_CHECK(esp_wifi_set_protocol(WIFI_IF_STA, protocols));
    ESP_ERROR_CHECK(esp_wifi_set_channel(channel, WIFI_SECOND_CHAN_NONE));
    ESP_ERROR_CHECK(esp_wifi_set_max_tx_power((int8_t)tx_power_qdbm));

    ESP_ERROR_CHECK(esp_now_init());
    ESP_ERROR_CHECK(esp_now_register_recv_cb(espnow_recv_cb));
    esp_now_peer_info_t peer = {0};
    memcpy(peer.peer_addr, BROADCAST_MAC, ESP_NOW_ETH_ALEN);
    peer.channel = 0; // Follow the interface's current channel
    peer.ifidx = WIFI_IF_STA;
    peer.encrypt = false;
    ESP_ERROR_CHECK(esp_now_add_peer(&peer));

    ESP_LOGI(TAG, "2.4 GHz link up: ch %u, %s, %d qdBm", channel, long_range ? "LR+11bgn" : "11bgn",
             tx_power_qdbm);
}

/** Hub: relay a frame (Spoke window, HELLO) to the laptop over USB. */
void slaprf_forward_to_laptop(const void *frame, uint32_t len) {
    slaprf_diag_forward_hub_frame(frame, len);
}

void slaprf_broadcast_hub_sync_beacon(uint8_t seq) {
    uint16_t net_freqs[8];
    if (slaprf_diag_get_net_channels(net_freqs)) {
        uint8_t b[20];
        b[0] = BEACON_MAGIC_0;
        b[1] = BEACON_MAGIC_1;
        b[2] = seq;
        for (int i = 0; i < 8; i++) {
            b[3 + i * 2] = (uint8_t)(net_freqs[i] & 0xFF);
            b[4 + i * 2] = (uint8_t)((net_freqs[i] >> 8) & 0xFF);
        }
        b[19] = xor8(b, 19);
        esp_now_send(BROADCAST_MAC, b, sizeof(b));
        return;
    }
    uint8_t b[4] = {BEACON_MAGIC_0, BEACON_MAGIC_1, seq, 0};
    b[3] = xor8(b, 3);
    esp_now_send(BROADCAST_MAC, b, sizeof(b));
}

void slaprf_spoke_sync_to_hub_channel(void) {
    s_last_beacon_us = 0;
    for (;;) {
        for (uint8_t ch = 1; ch <= 13; ch++) {
            esp_wifi_set_channel(ch, WIFI_SECOND_CHAN_NONE);
            for (int tick = 0; tick < 6; tick++) { // 6 x 20 ms = 120 ms per channel; services LED & USB
                slaprf_diag_service();
                vTaskDelay(pdMS_TO_TICKS(20));
                if (s_last_beacon_us != 0) {
                    ESP_LOGI(TAG, "Hub found on 2.4 GHz channel %u", ch);
                    return;
                }
            }
        }
    }
}

uint32_t slaprf_ms_since_hub_beacon(void) {
    const int64_t last_us = s_last_beacon_us;
    if (last_us == 0) {
        return UINT32_MAX;
    }
    const int64_t diff_us = esp_timer_get_time() - last_us;
    return diff_us > 0 ? (uint32_t)(diff_us / 1000) : 0;
}

bool slaprf_hub_beacon_mac(uint8_t out_mac[6]) {
    if (!s_has_hub_beacon_mac || out_mac == NULL) {
        return false;
    }
    memcpy(out_mac, s_hub_beacon_mac, 6);
    return true;
}

void espnow_send(const void *frame, uint32_t len) {
    esp_now_send(BROADCAST_MAC, (const uint8_t *)frame, len);
}

int espnow_wait(void *buf, uint32_t cap, uint32_t timeout_ms) {
    rx_item_t item;
    if (s_rx_queue == NULL || xQueueReceive(s_rx_queue, &item, pdMS_TO_TICKS(timeout_ms)) != pdTRUE) {
        return 0;
    }
    uint32_t n = item.len < cap ? item.len : cap;
    memcpy(buf, item.data, n);
    return (int)n;
}

int espnow_poll(void *buf, uint32_t cap) {
    rx_item_t item;
    if (s_rx_queue == NULL || xQueueReceive(s_rx_queue, &item, 0) != pdTRUE) {
        return 0;
    }
    uint32_t n = item.len < cap ? item.len : cap;
    memcpy(buf, item.data, n);
    return (int)n;
}

/* ---- Timing --------------------------------------------------------------------------------- */

void slaprf_wait_for_next_sweep_tick(uint32_t interval_us) {
    static int64_t next_us = 0;
    int64_t now = esp_timer_get_time();
    if (next_us == 0 || now - next_us > (int64_t)interval_us) {
        next_us = now; // First tick, or we fell a whole interval behind: resync
    }
    next_us += interval_us;
    int64_t remaining = next_us - esp_timer_get_time();
    if (remaining > 2000) {
        vTaskDelay(pdMS_TO_TICKS((remaining - 1000) / 1000));
    }
    while (esp_timer_get_time() < next_us) {
        // Spin out the last <2 ms for an accurate tick
    }
}

void delay_microseconds(uint32_t us) {
    esp_rom_delay_us(us);
}

int64_t slaprf_now_us(void) {
    return esp_timer_get_time();
}

void slaprf_sleep_until_us(int64_t t_us) {
    if (t_us <= 0) {
        vTaskDelay(1);
        return;
    }
    // Sleep a tick at a time (1 ms at CONFIG_FREERTOS_HZ=1000) so the idle task and the Wi-Fi
    // stack get CPU, then spin out the final stretch so TDMA slots and sweeps start on time.
    while (t_us - esp_timer_get_time() > 1200) {
        vTaskDelay(1);
    }
    while (esp_timer_get_time() < t_us) {
    }
}

int64_t slaprf_last_hub_beacon_us(void) {
    return s_last_beacon_us;
}
