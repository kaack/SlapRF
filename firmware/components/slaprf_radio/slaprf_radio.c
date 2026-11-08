/**
 * slaprf_radio — 2.4 GHz Wi-Fi / ESP-NOW link, Hub UDP bridge, sweep pacing, and USB config
 * readback for the XIAO ESP32-C5. Shared by every firmware profile.
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
#include "freertos/event_groups.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "lwip/sockets.h"
#include "nvs_flash.h"
#include "soc/soc_caps.h"

static const char *TAG = "slaprf_radio";

#define LAPTOP_UDP_PORT     5404
#define BEACON_MAGIC_0      0xC5
#define BEACON_MAGIC_1      0x5D // Hub -> Spokes sync beacon (4 bytes: magic0, magic1, seq, crc8)
#define RX_QUEUE_DEPTH      32
#define ESPNOW_MAX_FRAME    250

typedef struct {
    uint8_t len;
    uint8_t data[ESPNOW_MAX_FRAME];
} rx_item_t;

static const uint8_t BROADCAST_MAC[ESP_NOW_ETH_ALEN] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

static QueueHandle_t s_rx_queue;
static volatile int64_t s_last_beacon_us;
static esp_netif_t *s_sta_netif;
static esp_netif_t *s_ap_netif;
static int s_udp_sock = -1;
static EventGroupHandle_t s_wifi_events;
#define WIFI_GOT_IP_BIT BIT0

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

static void espnow_recv_cb(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
    (void)info;
    if (len <= 0 || len > ESPNOW_MAX_FRAME) {
        return;
    }
    if (len == 4 && data[0] == BEACON_MAGIC_0 && data[1] == BEACON_MAGIC_1 && xor8(data, 3) == data[3]) {
        s_last_beacon_us = esp_timer_get_time();
        return;
    }
    rx_item_t item;
    item.len = (uint8_t)len;
    memcpy(item.data, data, (size_t)len);
    xQueueSend(s_rx_queue, &item, 0);
}

static void wifi_event_handler(void *arg, esp_event_base_t base, int32_t id, void *data) {
    (void)arg;
    (void)data;
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        xEventGroupClearBits(s_wifi_events, WIFI_GOT_IP_BIT);
        esp_wifi_connect();
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        xEventGroupSetBits(s_wifi_events, WIFI_GOT_IP_BIT);
    }
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
    s_wifi_events = xEventGroupCreate();
    s_rx_queue = xQueueCreate(RX_QUEUE_DEPTH, sizeof(rx_item_t));
    s_sta_netif = esp_netif_create_default_wifi_sta();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event_handler, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event_handler, NULL));
    ESP_ERROR_CHECK(esp_wifi_start());

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

void slaprf_start_wifi_bridge(uint8_t wifi_mode, const char *ssid, const char *pass) {
    if (wifi_mode == 0) {
        // Host the "SlapRF" AP on the current channel; the laptop joins it directly.
        s_ap_netif = esp_netif_create_default_wifi_ap();
        ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_APSTA));
        wifi_config_t ap = {0};
        strlcpy((char *)ap.ap.ssid, "SlapRF", sizeof(ap.ap.ssid));
        ap.ap.ssid_len = strlen("SlapRF");
        ap.ap.max_connection = 4;
        uint8_t primary = 1;
        wifi_second_chan_t second;
        esp_wifi_get_channel(&primary, &second);
        ap.ap.channel = primary;
        size_t pass_len = pass ? strnlen(pass, 40) : 0;
        if (pass_len >= 8) {
            strlcpy((char *)ap.ap.password, pass, sizeof(ap.ap.password));
            ap.ap.authmode = WIFI_AUTH_WPA2_PSK;
        } else {
            ap.ap.authmode = WIFI_AUTH_OPEN;
        }
        ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_AP, &ap));
        esp_netif_set_default_netif(s_ap_netif);
    } else {
        // Join the field router / phone hotspot. ESP-NOW follows the router's channel.
        wifi_config_t sta = {0};
        strlcpy((char *)sta.sta.ssid, ssid, sizeof(sta.sta.ssid));
        strlcpy((char *)sta.sta.password, pass ? pass : "", sizeof(sta.sta.password));
        ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &sta));
        esp_wifi_connect();
        xEventGroupWaitBits(s_wifi_events, WIFI_GOT_IP_BIT, pdFALSE, pdTRUE, pdMS_TO_TICKS(15000));
    }

    s_udp_sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_IP);
    int yes = 1;
    setsockopt(s_udp_sock, SOL_SOCKET, SO_BROADCAST, &yes, sizeof(yes));
    ESP_LOGI(TAG, "Laptop bridge up (%s), UDP broadcast :%d", wifi_mode == 0 ? "AP SlapRF" : ssid,
             LAPTOP_UDP_PORT);
}

void slaprf_forward_udp_to_laptop(const void *frame, uint32_t len) {
    if (s_udp_sock < 0) {
        return;
    }
    struct sockaddr_in dst = {0};
    dst.sin_family = AF_INET;
    dst.sin_port = htons(LAPTOP_UDP_PORT);
    dst.sin_addr.s_addr = htonl(INADDR_BROADCAST);
    sendto(s_udp_sock, frame, len, 0, (struct sockaddr *)&dst, sizeof(dst));
}

void slaprf_broadcast_hub_sync_beacon(uint8_t seq) {
    uint8_t b[4] = {BEACON_MAGIC_0, BEACON_MAGIC_1, seq, 0};
    b[3] = xor8(b, 3);
    esp_now_send(BROADCAST_MAC, b, sizeof(b));
}

void slaprf_spoke_sync_to_hub_channel(void) {
    s_last_beacon_us = 0;
    for (;;) {
        for (uint8_t ch = 1; ch <= 13; ch++) {
            esp_wifi_set_channel(ch, WIFI_SECOND_CHAN_NONE);
            vTaskDelay(pdMS_TO_TICKS(120)); // Beacons arrive every 20-40 ms
            if (s_last_beacon_us != 0) {
                ESP_LOGI(TAG, "Hub found on 2.4 GHz channel %u", ch);
                return;
            }
        }
    }
}

uint32_t slaprf_ms_since_hub_beacon(void) {
    if (s_last_beacon_us == 0) {
        return UINT32_MAX;
    }
    return (uint32_t)((esp_timer_get_time() - s_last_beacon_us) / 1000);
}

void espnow_send(const void *frame, uint32_t len) {
    esp_now_send(BROADCAST_MAC, (const uint8_t *)frame, len);
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

/* ---- USB config readback -------------------------------------------------------------------- */

static const volatile void *s_cfg;
static size_t s_cfg_len;

static void config_query_task(void *arg) {
    (void)arg;
    static const char QUERY[] = "SLAPRF?\n";
    size_t matched = 0;
    uint8_t ch;
    for (;;) {
        if (usb_serial_jtag_read_bytes(&ch, 1, portMAX_DELAY) != 1) {
            continue;
        }
        matched = (ch == (uint8_t)QUERY[matched]) ? matched + 1 : (ch == (uint8_t)QUERY[0] ? 1 : 0);
        if (matched == sizeof(QUERY) - 1) {
            matched = 0;
            uint8_t copy[256];
            size_t n = s_cfg_len < sizeof(copy) ? s_cfg_len : sizeof(copy);
            memcpy(copy, (const void *)s_cfg, n);
            usb_serial_jtag_write_bytes(copy, n, pdMS_TO_TICKS(100));
        }
    }
}

void slaprf_start_config_query_service(const volatile void *cfg, size_t len) {
    s_cfg = cfg;
    s_cfg_len = len;
    usb_serial_jtag_driver_config_t usb_cfg = {
        .tx_buffer_size = 512,
        .rx_buffer_size = 256,
    };
    if (usb_serial_jtag_driver_install(&usb_cfg) == ESP_OK) {
        xTaskCreate(config_query_task, "slaprf_cfgq", 3072, NULL, 3, NULL);
    }
}
