/**
 * slaprf_radio — 2.4 GHz Wi-Fi / ESP-NOW link, Hub HTTP/SSE bridge, sweep pacing, and USB config
 * readback for the XIAO ESP32-C5. Shared by every firmware profile.
 */
#include "slaprf_radio.h"

#include <errno.h>
#include <string.h>

#include "driver/usb_serial_jtag.h"
#include "esp_event.h"
#include "esp_http_server.h"
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

#define BEACON_MAGIC_0      0xC5
#define BEACON_MAGIC_1      0x5D // Hub -> Spokes sync beacon (4 bytes, or 20 bytes with 8 x uint16_t channel table)
#define CHANNELS_MAGIC_1    0x5E // Laptop/Browser -> Hub active pilot channel table (19 bytes: 0xC5, 0x5E, 8 x uint16_t LE, crc8)
#define RX_QUEUE_DEPTH      32
#define ESPNOW_MAX_FRAME    250
#define WS_QUEUE_DEPTH      16
#define WS_MAX_FRAME        104

typedef struct {
    uint8_t len;
    uint8_t data[ESPNOW_MAX_FRAME];
} rx_item_t;

typedef struct {
    uint8_t len;
    uint8_t data[WS_MAX_FRAME];
} ws_tx_item_t;

static const uint8_t BROADCAST_MAC[ESP_NOW_ETH_ALEN] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

static QueueHandle_t s_rx_queue;
static QueueHandle_t s_ws_tx_queue;
static httpd_handle_t s_httpd;
static volatile bool s_ws_work_queued;
static volatile int64_t s_last_beacon_us;
static uint8_t s_hub_beacon_mac[6];
static volatile bool s_has_hub_beacon_mac;
static esp_netif_t *s_sta_netif;
static esp_netif_t *s_ap_netif;
static uint8_t s_http_hellos[7][36];
static EventGroupHandle_t s_wifi_events;
#define WIFI_GOT_IP_BIT BIT0

static uint8_t xor8(const uint8_t *data, uint32_t len) {
    uint8_t c = 0;
    for (uint32_t i = 0; i < len; i++) {
        c ^= data[i];
    }
    return c;
}

static int hex_nibble(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    return -1;
}

static void apply_channels_packet(const uint8_t *pkt, size_t len) {
    if (len == 19 && pkt[0] == BEACON_MAGIC_0 && pkt[1] == CHANNELS_MAGIC_1 && xor8(pkt, 18) == pkt[18]) {
        uint16_t freqs[8];
        for (int i = 0; i < 8; i++) {
            freqs[i] = (uint16_t)(pkt[2 + i * 2] | ((uint16_t)pkt[3 + i * 2] << 8));
        }
        slaprf_diag_set_net_channels(freqs);
    }
}

static void set_cors_headers(httpd_req_t *req) {
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Headers", "*");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Private-Network", "true");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
}

static esp_err_t hub_options_handler(httpd_req_t *req) {
    set_cors_headers(req);
    httpd_resp_set_status(req, "204 No Content");
    return httpd_resp_send(req, NULL, 0);
}

static esp_err_t hub_info_handler(httpd_req_t *req) {
    set_cors_headers(req);
    httpd_resp_set_type(req, "application/json");
    static const char body[] = "{\"slaprfHub\":true,\"ws\":\"/ws\"}";
    return httpd_resp_send(req, body, sizeof(body) - 1);
}

static esp_err_t hub_channels_handler(httpd_req_t *req) {
    set_cors_headers(req);
    char query[96];
    if (httpd_req_get_url_query_str(req, query, sizeof(query)) == ESP_OK) {
        const char *hex = strstr(query, "hex=");
        if (hex != NULL) {
            hex += 4;
            uint8_t pkt[19];
            bool ok = true;
            for (int i = 0; i < 19; i++) {
                int hi = hex_nibble(hex[i * 2]);
                int lo = hex_nibble(hex[i * 2 + 1]);
                if (hi < 0 || lo < 0) { ok = false; break; }
                pkt[i] = (uint8_t)((hi << 4) | lo);
            }
            if (ok) {
                apply_channels_packet(pkt, sizeof(pkt));
            }
        }
    }
    httpd_resp_set_type(req, "application/json");
    static const char body[] = "{\"ok\":true}";
    return httpd_resp_send(req, body, sizeof(body) - 1);
}

static esp_err_t hub_ws_handler(httpd_req_t *req) {
    if (req->method == HTTP_GET) {
        int sockfd = httpd_req_to_sockfd(req);
        if (sockfd >= 0) {
            struct timeval tv = {.tv_sec = 0, .tv_usec = 250000};
            setsockopt(sockfd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
        }
        // Immediately replay cached HELLO frames as binary WebSocket packets so Hub & Spokes appear right away
        for (int i = 0; i < 7; i++) {
            if (s_http_hellos[i][0] == BEACON_MAGIC_0 && s_http_hellos[i][1] == 0x5A) {
                httpd_ws_frame_t hello_pkt = {
                    .final = true,
                    .fragmented = false,
                    .type = HTTPD_WS_TYPE_BINARY,
                    .payload = s_http_hellos[i],
                    .len = 36,
                };
                if (httpd_ws_send_frame(req, &hello_pkt) != ESP_OK) {
                    break;
                }
            }
        }
        return ESP_OK;
    }

    httpd_ws_frame_t ws_pkt;
    memset(&ws_pkt, 0, sizeof(ws_pkt));
    esp_err_t ret = httpd_ws_recv_frame(req, &ws_pkt, 0);
    if (ret != ESP_OK) {
        return ret;
    }
    if (ws_pkt.len > 0 && ws_pkt.len <= 64) {
        uint8_t buf[64];
        ws_pkt.payload = buf;
        ret = httpd_ws_recv_frame(req, &ws_pkt, ws_pkt.len);
        if (ret != ESP_OK) {
            return ret;
        }
        if (ws_pkt.type == HTTPD_WS_TYPE_BINARY && ws_pkt.len == 19) {
            apply_channels_packet(buf, ws_pkt.len);
        }
    }
    return ESP_OK;
}

static void ws_flush_work_fn(void *arg) {
    (void)arg;
    s_ws_work_queued = false;
    if (s_httpd == NULL || s_ws_tx_queue == NULL) {
        return;
    }
    int client_fds[8];
    size_t fds_count = 8;
    int ws_fds[8];
    size_t ws_count = 0;
    if (httpd_get_client_list(s_httpd, &fds_count, client_fds) == ESP_OK) {
        for (size_t i = 0; i < fds_count; i++) {
            if (httpd_ws_get_fd_info(s_httpd, client_fds[i]) == HTTPD_WS_CLIENT_WEBSOCKET) {
                ws_fds[ws_count++] = client_fds[i];
            }
        }
    }

    ws_tx_item_t item;
    while (xQueueReceive(s_ws_tx_queue, &item, 0) == pdTRUE) {
        if (ws_count == 0) {
            continue;
        }
        httpd_ws_frame_t ws_pkt = {
            .final = true,
            .fragmented = false,
            .type = HTTPD_WS_TYPE_BINARY,
            .payload = item.data,
            .len = item.len,
        };
        for (size_t i = 0; i < ws_count; i++) {
            if (ws_fds[i] < 0) continue;
            if (httpd_ws_send_frame_async(s_httpd, ws_fds[i], &ws_pkt) == ESP_OK) {
                httpd_sess_update_lru_counter(s_httpd, ws_fds[i]);
            } else {
                httpd_sess_trigger_close(s_httpd, ws_fds[i]);
                ws_fds[i] = -1;
            }
        }
    }
}

static void enqueue_ws_frame(const uint8_t *raw, uint32_t len) {
    if (raw == NULL || len < 4 || len > WS_MAX_FRAME) {
        return;
    }
    if (len == 36 && raw[0] == BEACON_MAGIC_0 && raw[1] == 0x5A && raw[2] >= 1 && raw[2] <= 7) {
        memcpy(s_http_hellos[raw[2] - 1], raw, 36);
    }
    if (s_httpd == NULL || s_ws_tx_queue == NULL) {
        return;
    }
    ws_tx_item_t item;
    item.len = (uint8_t)len;
    memcpy(item.data, raw, (size_t)len);
    if (xQueueSend(s_ws_tx_queue, &item, 0) != pdTRUE) {
        ws_tx_item_t dropped;
        xQueueReceive(s_ws_tx_queue, &dropped, 0);
        xQueueSend(s_ws_tx_queue, &item, 0);
    }
    if (!s_ws_work_queued) {
        s_ws_work_queued = true;
        if (httpd_queue_work(s_httpd, ws_flush_work_fn, NULL) != ESP_OK) {
            s_ws_work_queued = false;
        }
    }
}

static void start_hub_httpd(void) {
    if (s_httpd != NULL) {
        return;
    }
    if (s_ws_tx_queue == NULL) {
        s_ws_tx_queue = xQueueCreate(WS_QUEUE_DEPTH, sizeof(ws_tx_item_t));
    }
    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.max_open_sockets = 6;
    config.backlog_conn = 4;
    config.lru_purge_enable = true;
    config.enable_so_linger = true;
    config.linger_timeout = 0;
    config.stack_size = 4096;

    if (httpd_start(&s_httpd, &config) != ESP_OK) {
        ESP_LOGE(TAG, "Failed to start esp_http_server");
        return;
    }
    static const httpd_uri_t uri_info = {
        .uri = "/api/hub-info",
        .method = HTTP_GET,
        .handler = hub_info_handler,
    };
    static const httpd_uri_t uri_info_opt = {
        .uri = "/api/hub-info",
        .method = HTTP_OPTIONS,
        .handler = hub_options_handler,
    };
    static const httpd_uri_t uri_channels = {
        .uri = "/api/hub-channels",
        .method = HTTP_GET,
        .handler = hub_channels_handler,
    };
    static const httpd_uri_t uri_channels_opt = {
        .uri = "/api/hub-channels",
        .method = HTTP_OPTIONS,
        .handler = hub_options_handler,
    };
    static const httpd_uri_t uri_ws = {
        .uri = "/ws",
        .method = HTTP_GET,
        .handler = hub_ws_handler,
        .is_websocket = true,
    };
    httpd_register_uri_handler(s_httpd, &uri_info);
    httpd_register_uri_handler(s_httpd, &uri_info_opt);
    httpd_register_uri_handler(s_httpd, &uri_channels);
    httpd_register_uri_handler(s_httpd, &uri_channels_opt);
    httpd_register_uri_handler(s_httpd, &uri_ws);
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
    if (len <= 0 || len > ESPNOW_MAX_FRAME) {
        return;
    }
    if ((len == 4 || len == 20) && data[0] == BEACON_MAGIC_0 && data[1] == BEACON_MAGIC_1 &&
        xor8(data, (uint32_t)len - 1) == data[len - 1]) {
        s_last_beacon_us = esp_timer_get_time();
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

void slaprf_start_wifi_bridge(uint8_t wifi_mode, const char *ssid, const char *pass) {
    if (wifi_mode == 0) {
        // Host the "SlapRF" AP on the current channel; the laptop/browser joins it directly.
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

    start_hub_httpd();
    ESP_LOGI(TAG, "Hub bridge up (%s), HTTP/WS :80", wifi_mode == 0 ? "AP SlapRF" : ssid);
}

void slaprf_forward_udp_to_laptop(const void *frame, uint32_t len) {
    slaprf_diag_forward_hub_frame(frame, len);
    enqueue_ws_frame((const uint8_t *)frame, len);
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
    if (s_last_beacon_us == 0) {
        return UINT32_MAX;
    }
    return (uint32_t)((esp_timer_get_time() - s_last_beacon_us) / 1000);
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
