/**
 * slaprf_radio — 2.4 GHz Wi-Fi / ESP-NOW link, Hub UDP bridge, sweep pacing, and USB config
 * readback for the XIAO ESP32-C5. Shared by every firmware profile.
 */
#include "slaprf_radio.h"

#include <errno.h>
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
#define BEACON_MAGIC_1      0x5D // Hub -> Spokes sync beacon (4 bytes, or 20 bytes with 8 x uint16_t channel table)
#define CHANNELS_MAGIC_1    0x5E // Laptop -> Hub active pilot channel table (19 bytes: 0xC5, 0x5E, 8 x uint16_t LE, crc8)
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
static esp_netif_t *s_ap_netif;
static int s_udp_sock = -1;
static int s_sse_clients[4] = {-1, -1, -1, -1};
static uint8_t s_http_hellos[7][36];
static portMUX_TYPE s_sse_mux = portMUX_INITIALIZER_UNLOCKED;
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

static int format_sse_frame(char *dst, size_t cap, const uint8_t *raw, uint32_t len) {
    static const char hex_lut[16] = {'0','1','2','3','4','5','6','7','8','9','A','B','C','D','E','F'};
    if (len == 0 || len > 180 || cap < (size_t)(6 + len * 2 + 3)) return 0;
    int n = 0;
    memcpy(dst, "data: ", 6);
    n += 6;
    for (uint32_t i = 0; i < len; i++) {
        dst[n++] = hex_lut[(raw[i] >> 4) & 0x0F];
        dst[n++] = hex_lut[raw[i] & 0x0F];
    }
    dst[n++] = '\n';
    dst[n++] = '\n';
    dst[n] = 0;
    return n;
}

static void broadcast_sse_frame(const uint8_t *raw, uint32_t len) {
    if (raw == NULL || len < 4 || len > 180) return;
    if (len == 36 && raw[0] == BEACON_MAGIC_0 && raw[1] == 0x5A && raw[2] >= 1 && raw[2] <= 7) {
        memcpy(s_http_hellos[raw[2] - 1], raw, 36);
    }
    int fds[4];
    portENTER_CRITICAL(&s_sse_mux);
    for (int i = 0; i < 4; i++) fds[i] = s_sse_clients[i];
    portEXIT_CRITICAL(&s_sse_mux);

    bool any = false;
    for (int i = 0; i < 4; i++) {
        if (fds[i] >= 0) { any = true; break; }
    }
    if (!any) return;

    char line[384];
    int line_len = format_sse_frame(line, sizeof(line), raw, len);
    if (line_len <= 0) return;

    for (int i = 0; i < 4; i++) {
        if (fds[i] < 0) continue;
        int sent = send(fds[i], line, (size_t)line_len, MSG_DONTWAIT);
        if (sent < 0 && errno != EAGAIN && errno != EWOULDBLOCK) {
            portENTER_CRITICAL(&s_sse_mux);
            if (s_sse_clients[i] == fds[i]) {
                s_sse_clients[i] = -1;
            }
            portEXIT_CRITICAL(&s_sse_mux);
            close(fds[i]);
        }
    }
}

static void hub_http_server_task(void *arg) {
    (void)arg;
    int listen_fd = socket(AF_INET, SOCK_STREAM, IPPROTO_IP);
    if (listen_fd < 0) {
        vTaskDelete(NULL);
        return;
    }
    int yes = 1;
    setsockopt(listen_fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));
    struct sockaddr_in addr = {0};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(80);
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    if (bind(listen_fd, (struct sockaddr *)&addr, sizeof(addr)) < 0 || listen(listen_fd, 4) < 0) {
        close(listen_fd);
        vTaskDelete(NULL);
        return;
    }

    char req[512];
    for (;;) {
        struct sockaddr_in client_addr;
        socklen_t client_len = sizeof(client_addr);
        int fd = accept(listen_fd, (struct sockaddr *)&client_addr, &client_len);
        if (fd < 0) {
            vTaskDelay(pdMS_TO_TICKS(20));
            continue;
        }
        struct timeval tv = {.tv_sec = 1, .tv_usec = 0};
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
        int n = recv(fd, req, sizeof(req) - 1, 0);
        if (n <= 0) {
            close(fd);
            continue;
        }
        req[n] = 0;

        if (strncmp(req, "OPTIONS ", 8) == 0) {
            static const char resp[] =
                "HTTP/1.1 204 No Content\r\n"
                "Access-Control-Allow-Origin: *\r\n"
                "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
                "Access-Control-Allow-Headers: *\r\n"
                "Access-Control-Allow-Private-Network: true\r\n"
                "Connection: close\r\n\r\n";
            send(fd, resp, sizeof(resp) - 1, 0);
            close(fd);
            continue;
        }

        if (strncmp(req, "GET /api/hub-info", 17) == 0) {
            static const char resp[] =
                "HTTP/1.1 200 OK\r\n"
                "Content-Type: application/json\r\n"
                "Access-Control-Allow-Origin: *\r\n"
                "Access-Control-Allow-Private-Network: true\r\n"
                "Cache-Control: no-store\r\n"
                "Connection: close\r\n\r\n"
                "{\"slaprfHub\":true}";
            send(fd, resp, sizeof(resp) - 1, 0);
            close(fd);
            continue;
        }

        if (strncmp(req, "GET /api/hub-channels?hex=", 26) == 0) {
            const char *hex = req + 26;
            uint8_t pkt[19];
            bool ok = true;
            for (int i = 0; i < 19; i++) {
                int hi = hex_nibble(hex[i * 2]);
                int lo = hex_nibble(hex[i * 2 + 1]);
                if (hi < 0 || lo < 0) { ok = false; break; }
                pkt[i] = (uint8_t)((hi << 4) | lo);
            }
            if (ok && pkt[0] == BEACON_MAGIC_0 && pkt[1] == CHANNELS_MAGIC_1 && xor8(pkt, 18) == pkt[18]) {
                uint16_t freqs[8];
                for (int i = 0; i < 8; i++) {
                    freqs[i] = (uint16_t)(pkt[2 + i * 2] | ((uint16_t)pkt[3 + i * 2] << 8));
                }
                slaprf_diag_set_net_channels(freqs);
            }
            static const char resp[] =
                "HTTP/1.1 200 OK\r\n"
                "Content-Type: application/json\r\n"
                "Access-Control-Allow-Origin: *\r\n"
                "Access-Control-Allow-Private-Network: true\r\n"
                "Connection: close\r\n\r\n"
                "{\"ok\":true}";
            send(fd, resp, sizeof(resp) - 1, 0);
            close(fd);
            continue;
        }

        if (strncmp(req, "GET /api/hub-stream", 19) == 0) {
            static const char hdr[] =
                "HTTP/1.1 200 OK\r\n"
                "Content-Type: text/event-stream\r\n"
                "Cache-Control: no-cache\r\n"
                "Connection: keep-alive\r\n"
                "Access-Control-Allow-Origin: *\r\n"
                "Access-Control-Allow-Private-Network: true\r\n\r\n";
            if (send(fd, hdr, sizeof(hdr) - 1, 0) < 0) {
                close(fd);
                continue;
            }
            // Replay cached HELLO frames immediately so the browser discovers Hub & Spokes right away
            char line[128];
            for (int i = 0; i < 7; i++) {
                if (s_http_hellos[i][0] == BEACON_MAGIC_0 && s_http_hellos[i][1] == 0x5A) {
                    int ll = format_sse_frame(line, sizeof(line), s_http_hellos[i], 36);
                    if (ll > 0) send(fd, line, (size_t)ll, MSG_DONTWAIT);
                }
            }
            int evicted = -1;
            portENTER_CRITICAL(&s_sse_mux);
            int slot_idx = -1;
            for (int i = 0; i < 4; i++) {
                if (s_sse_clients[i] < 0) { slot_idx = i; break; }
            }
            if (slot_idx < 0) {
                evicted = s_sse_clients[0];
                slot_idx = 0;
            }
            s_sse_clients[slot_idx] = fd;
            portEXIT_CRITICAL(&s_sse_mux);
            if (evicted >= 0) close(evicted);
            continue;
        }

        static const char not_found[] =
            "HTTP/1.1 404 Not Found\r\n"
            "Access-Control-Allow-Origin: *\r\n"
            "Access-Control-Allow-Private-Network: true\r\n"
            "Connection: close\r\n\r\n";
        send(fd, not_found, sizeof(not_found) - 1, 0);
        close(fd);
    }
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
    setsockopt(s_udp_sock, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));
    struct sockaddr_in bind_addr = {0};
    bind_addr.sin_family = AF_INET;
    bind_addr.sin_port = htons(LAPTOP_UDP_PORT);
    bind_addr.sin_addr.s_addr = htonl(INADDR_ANY);
    bind(s_udp_sock, (struct sockaddr *)&bind_addr, sizeof(bind_addr));
    xTaskCreate(hub_http_server_task, "slaprf_http", 4096, NULL, 2, NULL);
    ESP_LOGI(TAG, "Laptop bridge up (%s), UDP broadcast :%d + HTTP/SSE :80", wifi_mode == 0 ? "AP SlapRF" : ssid,
             LAPTOP_UDP_PORT);
}

static void poll_laptop_udp(void) {
    if (s_udp_sock < 0) {
        return;
    }
    uint8_t buf[64];
    for (int iter = 0; iter < 8; iter++) {
        int n = recvfrom(s_udp_sock, buf, sizeof(buf), MSG_DONTWAIT, NULL, NULL);
        if (n <= 0) {
            break;
        }
        if (n == 19 && buf[0] == BEACON_MAGIC_0 && buf[1] == CHANNELS_MAGIC_1 && xor8(buf, 18) == buf[18]) {
            uint16_t freqs[8];
            for (int i = 0; i < 8; i++) {
                freqs[i] = (uint16_t)(buf[2 + i * 2] | ((uint16_t)buf[3 + i * 2] << 8));
            }
            slaprf_diag_set_net_channels(freqs);
        }
    }
}

void slaprf_forward_udp_to_laptop(const void *frame, uint32_t len) {
    slaprf_diag_forward_hub_frame(frame, len);
    broadcast_sse_frame((const uint8_t *)frame, len);
    if (s_udp_sock < 0) {
        return;
    }
    poll_laptop_udp();
    struct sockaddr_in dst = {0};
    dst.sin_family = AF_INET;
    dst.sin_port = htons(LAPTOP_UDP_PORT);
    dst.sin_addr.s_addr = htonl(INADDR_BROADCAST);
    sendto(s_udp_sock, frame, len, 0, (struct sockaddr *)&dst, sizeof(dst));
}

void slaprf_broadcast_hub_sync_beacon(uint8_t seq) {
    poll_laptop_udp();
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
