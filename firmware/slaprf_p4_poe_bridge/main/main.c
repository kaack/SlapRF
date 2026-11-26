/*
 * SlapRF PoE Ethernet <-> USB Host Bridge Firmware
 * Target: Waveshare ESP32-P4-POE-ETH / ESP32-P4-WIFI6-POE-ETH (ESP32-P4 + IP101GRI RMII + USB 2.0 Host)
 *
 * Architecture:
 *  - Drives GPIO54 (C6_RST) LOW at boot so any onboard ESP32-C6 co-processor remains powered off
 *    in reset (~0 mA, zero 2.4 GHz RF noise near the Seeed Studio XIAO ESP32-C5 Hub's ESP-NOW radio).
 *  - Brings up 100 Mbps RMII Ethernet (IP101GRI) with DHCP + RFC 3927 AutoIP (169.254.x.x) fallback
 *    plus optional persistent static IP configuration in NVS (`NETCFG STATIC <ip> <mask> <gw>`).
 *  - Supervises USB Type-A Host CDC-ACM (`0x303A:0x1001` XIAO ESP32-C5) with live hot-plug/replug
 *    and automatic DTR/RTS recovery if a XIAO C5 boots latched in ROM download mode.
 *  - Serves `UDP :5480` (`SLAPRF_DISCOVER?` broadcast & unicast responder) and `TCP :5480`
 *    (`TCP_NODELAY=1`, transparent <0.5 ms ring-buffer bridge preserving 100 Hz `0x1E`+`0xC5` Hub
 *    + Spoke binary telemetry frames, `SLAPRF02` readouts, and `@JSON` console commands).
 */

#include <ctype.h>
#include <errno.h>
#include <inttypes.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "driver/gpio.h"
#include "driver/uart.h"
#include "esp_err.h"
#include "esp_eth.h"
#include "esp_eth_mac_esp.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "lwip/inet.h"
#include "lwip/sockets.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "usb/cdc_acm_host.h"
#include "usb/usb_host.h"

#define BRIDGE_FW_VERSION       "0.1.0"
#define SLAPRF_NET_PORT         5480

/* Waveshare ESP32-P4-(WIFI6-)POE-ETH hardware pin map */
#define P4_C6_RST_GPIO          54
#define P4_ETH_MDC_GPIO         31
#define P4_ETH_MDIO_GPIO        52
#define P4_ETH_PHY_RST_GPIO     51
#define P4_ETH_RMII_CLK_GPIO    50
#define P4_ETH_TX_EN_GPIO       49
#define P4_ETH_TXD0_GPIO        34
#define P4_ETH_TXD1_GPIO        35
#define P4_ETH_CRS_DV_GPIO      28
#define P4_ETH_RXD0_GPIO        29
#define P4_ETH_RXD1_GPIO        30

/* Seeed Studio XIAO ESP32-C5 built-in USB-Serial-JTAG VID/PID */
#define XIAO_ESP32C5_VID        0x303A
#define XIAO_ESP32C5_PID        0x1001

#define USB_RX_RING_SIZE        65536
#define PASSIVE_LINE_MAX        1536

static const char *TAG = "slaprf_poe";

typedef struct {
    bool static_ip;
    char ip[16];
    char netmask[16];
    char gateway[16];
} net_cfg_t;

typedef struct {
    bool eth_link_up;
    int link_speed_mbps;
    bool full_duplex;
    char mac_str[18];
    char ip_str[16];
    char netmask_str[16];
    char gw_str[16];
    bool using_static_ip;

    bool usb_connected;
    uint16_t usb_vid;
    uint16_t usb_pid;
    uint64_t usb_rx_bytes;
    uint64_t usb_tx_bytes;
    uint64_t last_status_us;

    /* Cached XIAO ESP32-C5 identity parsed passively from @{"t":"status",...} */
    char timer_fp[16];
    char timer_label[32];
    char timer_fw[24];
    int timer_role;
    int timer_sweep_hz;
} bridge_state_t;

static SemaphoreHandle_t g_state_mu = NULL;
static SemaphoreHandle_t g_cdc_tx_mu = NULL;
static SemaphoreHandle_t g_usb_disc_sem = NULL;
static SemaphoreHandle_t g_ring_mu = NULL;

static bridge_state_t g_state;
static net_cfg_t g_net_cfg;
static esp_netif_t *g_eth_netif = NULL;
static cdc_acm_dev_hdl_t g_cdc_dev = NULL;

static volatile int g_tcp_client_fd = -1;
static TaskHandle_t g_tcp_tx_task = NULL;

static uint8_t g_rx_ring[USB_RX_RING_SIZE];
static size_t g_rx_head = 0;
static size_t g_rx_tail = 0;
static size_t g_rx_count = 0;

/* Passive stream parser state (skips 0x1E <len> binary frames cleanly) */
static int g_bin_skip_rem = -1; /* -1 = normal, -2 = awaiting len byte after 0x1E, >0 = payload bytes left */
static char g_line_buf[PASSIVE_LINE_MAX];
static size_t g_line_len = 0;
static volatile bool g_saw_rom_download_banner = false;

static void hold_onboard_c6_in_reset(void)
{
    gpio_config_t io_conf = {
        .pin_bit_mask = (1ULL << P4_C6_RST_GPIO),
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_ENABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    gpio_config(&io_conf);
    gpio_set_level(P4_C6_RST_GPIO, 0);
}

static void ring_push_bytes(const uint8_t *data, size_t len)
{
    if (len == 0 || g_tcp_client_fd < 0) {
        return;
    }
    xSemaphoreTake(g_ring_mu, portMAX_DELAY);
    if (len >= USB_RX_RING_SIZE) {
        data += (len - USB_RX_RING_SIZE);
        len = USB_RX_RING_SIZE;
        g_rx_head = 0;
        g_rx_tail = 0;
        g_rx_count = 0;
    }
    size_t free_space = USB_RX_RING_SIZE - g_rx_count;
    if (len > free_space) {
        size_t drop = len - free_space;
        g_rx_tail = (g_rx_tail + drop) % USB_RX_RING_SIZE;
        g_rx_count -= drop;
    }
    size_t first = USB_RX_RING_SIZE - g_rx_head;
    if (first > len) {
        first = len;
    }
    memcpy(&g_rx_ring[g_rx_head], data, first);
    if (len > first) {
        memcpy(&g_rx_ring[0], data + first, len - first);
    }
    g_rx_head = (g_rx_head + len) % USB_RX_RING_SIZE;
    g_rx_count += len;
    xSemaphoreGive(g_ring_mu);

    if (g_tcp_tx_task != NULL) {
        xTaskNotifyGive(g_tcp_tx_task);
    }
}

static size_t ring_pop_bytes(uint8_t *out, size_t max_len)
{
    xSemaphoreTake(g_ring_mu, portMAX_DELAY);
    size_t n = g_rx_count;
    if (n > max_len) {
        n = max_len;
    }
    if (n > 0) {
        size_t first = USB_RX_RING_SIZE - g_rx_tail;
        if (first > n) {
            first = n;
        }
        memcpy(out, &g_rx_ring[g_rx_tail], first);
        if (n > first) {
            memcpy(out + first, &g_rx_ring[0], n - first);
        }
        g_rx_tail = (g_rx_tail + n) % USB_RX_RING_SIZE;
        g_rx_count -= n;
    }
    xSemaphoreGive(g_ring_mu);
    return n;
}

static void ring_clear(void)
{
    xSemaphoreTake(g_ring_mu, portMAX_DELAY);
    g_rx_head = 0;
    g_rx_tail = 0;
    g_rx_count = 0;
    xSemaphoreGive(g_ring_mu);
}

static bool extract_json_string(const char *json, const char *key, char *out, size_t out_sz)
{
    char pat[40];
    snprintf(pat, sizeof(pat), "\"%s\":\"", key);
    const char *p = strstr(json, pat);
    if (!p) {
        return false;
    }
    p += strlen(pat);
    size_t i = 0;
    while (*p && *p != '"' && i + 1 < out_sz) {
        if (*p == '\\' && p[1] != '\0') {
            p++;
        }
        out[i++] = *p++;
    }
    out[i] = '\0';
    return i > 0;
}

static bool extract_json_int(const char *json, const char *key, int *out_val)
{
    char pat[40];
    snprintf(pat, sizeof(pat), "\"%s\":", key);
    const char *p = strstr(json, pat);
    if (!p) {
        return false;
    }
    p += strlen(pat);
    while (*p == ' ') {
        p++;
    }
    if (*p != '-' && !isdigit((unsigned char)*p)) {
        return false;
    }
    *out_val = atoi(p);
    return true;
}

static void update_netif_hostname_from_label(const char *label)
{
    if (!g_eth_netif || !label || !label[0]) {
        return;
    }
    char host[40] = "slaprf-";
    size_t pos = strlen(host);
    for (size_t i = 0; label[i] != '\0' && pos + 1 < sizeof(host); i++) {
        unsigned char c = (unsigned char)label[i];
        if (isalnum(c)) {
            host[pos++] = (char)tolower(c);
        } else if (c == '-' || c == '_') {
            host[pos++] = '-';
        }
    }
    host[pos] = '\0';
    if (pos > strlen("slaprf-")) {
        esp_netif_set_hostname(g_eth_netif, host);
    }
}

static void inspect_console_line(const char *line)
{
    if (strstr(line, "waiting for download") != NULL) {
        g_saw_rom_download_banner = true;
        return;
    }
    if (line[0] != '@' || line[1] != '{') {
        return;
    }
    if (strstr(line, "\"t\":\"status\"") == NULL) {
        return;
    }

    char fp[16] = {0};
    char label[32] = {0};
    char fw[24] = {0};
    int role = 0;
    int sweep_hz = 0;

    bool has_fp = extract_json_string(line, "fp", fp, sizeof(fp));
    bool has_label = extract_json_string(line, "label", label, sizeof(label));
    bool has_fw = extract_json_string(line, "fw", fw, sizeof(fw));
    bool has_role = extract_json_int(line, "role", &role);
    bool has_sweep = extract_json_int(line, "sweepHz", &sweep_hz);

    bool label_changed = false;
    bool first_status = false;
    xSemaphoreTake(g_state_mu, portMAX_DELAY);
    if (g_state.last_status_us == 0) {
        first_status = true;
    }
    g_state.last_status_us = (uint64_t)esp_timer_get_time();
    if (has_fp) {
        snprintf(g_state.timer_fp, sizeof(g_state.timer_fp), "%s", fp);
    }
    if (has_label) {
        if (strcmp(g_state.timer_label, label) != 0) {
            label_changed = true;
        }
        snprintf(g_state.timer_label, sizeof(g_state.timer_label), "%s", label);
    }
    if (has_fw) {
        snprintf(g_state.timer_fw, sizeof(g_state.timer_fw), "%s", fw);
    }
    if (has_role) {
        g_state.timer_role = role;
    }
    if (has_sweep) {
        g_state.timer_sweep_hz = sweep_hz;
    }
    xSemaphoreGive(g_state_mu);

    if (label_changed) {
        update_netif_hostname_from_label(label);
    }
    if (first_status || label_changed) {
        ESP_LOGI(TAG, "Detected SlapRF timer on USB-A: label=%s fp=%s fw=%s role=%d sweepHz=%d", label, fp, fw, role, sweep_hz);
    }
}

static void passive_parse_xiao_bytes(const uint8_t *data, size_t len)
{
    for (size_t i = 0; i < len; i++) {
        uint8_t b = data[i];
        if (g_bin_skip_rem == -2) {
            if (b > 0 && b <= 96) {
                g_bin_skip_rem = (int)b;
            } else {
                g_bin_skip_rem = -1;
            }
            continue;
        }
        if (g_bin_skip_rem > 0) {
            g_bin_skip_rem--;
            if (g_bin_skip_rem == 0) {
                g_bin_skip_rem = -1;
            }
            continue;
        }
        if (b == 0x1E) {
            g_bin_skip_rem = -2;
            continue;
        }
        if (b == '\r') {
            continue;
        }
        if (b == '\n') {
            if (g_line_len > 0) {
                g_line_buf[g_line_len] = '\0';
                inspect_console_line(g_line_buf);
                g_line_len = 0;
            }
            continue;
        }
        if (g_line_len + 1 < sizeof(g_line_buf)) {
            g_line_buf[g_line_len++] = (char)b;
        }
    }
}

static size_t format_bridge_json(char *buf, size_t buf_sz, bool as_at_line)
{
    bridge_state_t snap;
    xSemaphoreTake(g_state_mu, portMAX_DELAY);
    snap = g_state;
    xSemaphoreGive(g_state_mu);

    uint64_t up_ms = (uint64_t)(esp_timer_get_time() / 1000ULL);
    int n = snprintf(
        buf,
        buf_sz,
        "%s{\"t\":\"bridge\",\"proto\":\"slaprf-eth\",\"ver\":2,"
        "\"board\":\"ESP32-P4-POE-ETH\",\"bridgeFw\":\"%s\",\"port\":%d,\"upMs\":%" PRIu64 ","
        "\"usbConnected\":%s,\"fp\":\"%s\",\"label\":\"%s\",\"fw\":\"%s\",\"role\":%d,\"sweepHz\":%d,"
        "\"ip\":\"%s\",\"mac\":\"%s\",\"linkUp\":%s,\"linkSpeedMbps\":%d,\"fullDuplex\":%s,\"dhcp\":%s,"
        "\"eth\":{\"linkUp\":%s,\"ip\":\"%s\",\"netmask\":\"%s\",\"gateway\":\"%s\",\"mac\":\"%s\","
        "\"linkSpeedMbps\":%d,\"fullDuplex\":%s,\"dhcp\":%s,\"bridgeFw\":\"%s\",\"usbConnected\":%s},"
        "\"usb\":{\"connected\":%s,\"vid\":\"%04X\",\"pid\":\"%04X\",\"rxBytes\":%" PRIu64 ",\"txBytes\":%" PRIu64 "}}%s",
        as_at_line ? "@" : "",
        BRIDGE_FW_VERSION,
        SLAPRF_NET_PORT,
        up_ms,
        snap.usb_connected ? "true" : "false",
        snap.timer_fp,
        snap.timer_label[0] ? snap.timer_label : "H1",
        snap.timer_fw,
        snap.timer_role > 0 ? snap.timer_role : 1,
        snap.timer_sweep_hz > 0 ? snap.timer_sweep_hz : 100,
        snap.ip_str,
        snap.mac_str,
        snap.eth_link_up ? "true" : "false",
        snap.link_speed_mbps,
        snap.full_duplex ? "true" : "false",
        snap.using_static_ip ? "false" : "true",
        snap.eth_link_up ? "true" : "false",
        snap.ip_str,
        snap.netmask_str,
        snap.gw_str,
        snap.mac_str,
        snap.link_speed_mbps,
        snap.full_duplex ? "true" : "false",
        snap.using_static_ip ? "false" : "true",
        BRIDGE_FW_VERSION,
        snap.usb_connected ? "true" : "false",
        snap.usb_connected ? "true" : "false",
        snap.usb_vid,
        snap.usb_pid,
        snap.usb_rx_bytes,
        snap.usb_tx_bytes,
        as_at_line ? "\n" : ""
    );
    if (n < 0) {
        return 0;
    }
    return (size_t)n < buf_sz ? (size_t)n : (buf_sz - 1);
}

static void push_bridge_line_to_tcp(void)
{
    if (g_tcp_client_fd < 0) {
        return;
    }
    char line[768];
    size_t n = format_bridge_json(line, sizeof(line), true);
    if (n > 0) {
        ring_push_bytes((const uint8_t *)line, n);
    }
}

static esp_err_t cdc_send_bytes(const uint8_t *data, size_t len, uint32_t timeout_ms)
{
    if (len == 0) {
        return ESP_OK;
    }
    xSemaphoreTake(g_cdc_tx_mu, portMAX_DELAY);
    cdc_acm_dev_hdl_t hdl = g_cdc_dev;
    esp_err_t err = ESP_ERR_INVALID_STATE;
    if (hdl != NULL) {
        err = cdc_acm_host_data_tx_blocking(hdl, data, len, timeout_ms);
        if (err == ESP_OK) {
            xSemaphoreTake(g_state_mu, portMAX_DELAY);
            g_state.usb_tx_bytes += len;
            xSemaphoreGive(g_state_mu);
        }
    }
    xSemaphoreGive(g_cdc_tx_mu);
    return err;
}

static bool cdc_rx_callback(const uint8_t *data, size_t data_len, void *arg)
{
    (void)arg;
    if (data_len == 0) {
        return true;
    }
    xSemaphoreTake(g_state_mu, portMAX_DELAY);
    g_state.usb_rx_bytes += data_len;
    xSemaphoreGive(g_state_mu);

    ring_push_bytes(data, data_len);
    passive_parse_xiao_bytes(data, data_len);
    return true;
}

static void cdc_event_callback(const cdc_acm_host_dev_event_data_t *event, void *user_ctx)
{
    (void)user_ctx;
    if (!event) {
        return;
    }
    switch (event->type) {
    case CDC_ACM_HOST_ERROR:
        ESP_LOGW(TAG, "CDC-ACM host error=%d", event->data.error);
        break;
    case CDC_ACM_HOST_DEVICE_DISCONNECTED:
        ESP_LOGI(TAG, "USB timer disconnected from Type-A port");
        xSemaphoreTake(g_cdc_tx_mu, portMAX_DELAY);
        g_cdc_dev = NULL;
        xSemaphoreGive(g_cdc_tx_mu);

        xSemaphoreTake(g_state_mu, portMAX_DELAY);
        g_state.usb_connected = false;
        g_state.usb_vid = 0;
        g_state.usb_pid = 0;
        xSemaphoreGive(g_state_mu);

        if (event->data.cdc_hdl != NULL) {
            cdc_acm_host_close(event->data.cdc_hdl);
        }
        push_bridge_line_to_tcp();
        xSemaphoreGive(g_usb_disc_sem);
        break;
    default:
        break;
    }
}

/* Matches internal/firmware/readout.go RebootESP32C5IntoApp so a XIAO C5 latched in ROM download
 * mode (`waiting for download`) resets cleanly into normal application firmware. */
static void reboot_esp32c5_into_app(cdc_acm_dev_hdl_t hdl)
{
    ESP_LOGW(TAG, "Recovering XIAO ESP32-C5 from ROM bootloader latch via DTR/RTS pulse");
    cdc_acm_host_set_control_line_state(hdl, false, false);
    vTaskDelay(pdMS_TO_TICKS(25));
    cdc_acm_host_set_control_line_state(hdl, true, true);
    vTaskDelay(pdMS_TO_TICKS(30));
    cdc_acm_host_set_control_line_state(hdl, false, true);
    vTaskDelay(pdMS_TO_TICKS(100));
    cdc_acm_host_set_control_line_state(hdl, false, false);
    vTaskDelay(pdMS_TO_TICKS(60));
    cdc_acm_host_set_control_line_state(hdl, true, false);
}

static void usb_lib_task(void *arg)
{
    (void)arg;
    while (true) {
        uint32_t event_flags = 0;
        usb_host_lib_handle_events(portMAX_DELAY, &event_flags);
        if (event_flags & USB_HOST_LIB_EVENT_FLAGS_NO_CLIENTS) {
            usb_host_device_free_all();
        }
    }
}

static void usb_cdc_supervisor_task(void *arg)
{
    (void)arg;
    const cdc_acm_host_device_config_t dev_cfg = {
        .connection_timeout_ms = 1000,
        .out_buffer_size = 1024,
        .in_buffer_size = 1024,
        .event_cb = cdc_event_callback,
        .data_cb = cdc_rx_callback,
        .user_arg = NULL,
    };

    while (true) {
        cdc_acm_dev_hdl_t hdl = NULL;
        uint16_t opened_vid = XIAO_ESP32C5_VID;
        uint16_t opened_pid = XIAO_ESP32C5_PID;

        esp_err_t err = cdc_acm_host_open(XIAO_ESP32C5_VID, XIAO_ESP32C5_PID, 0, &dev_cfg, &hdl);
        if (err != ESP_OK) {
            cdc_acm_host_device_config_t any_cfg = dev_cfg;
            any_cfg.connection_timeout_ms = 500;
            err = cdc_acm_host_open(CDC_HOST_ANY_VID, CDC_HOST_ANY_PID, 0, &any_cfg, &hdl);
            opened_vid = 0;
            opened_pid = 0;
        }
        if (err != ESP_OK || hdl == NULL) {
            vTaskDelay(pdMS_TO_TICKS(250));
            continue;
        }

        xSemaphoreTake(g_usb_disc_sem, 0);
        g_bin_skip_rem = -1;
        g_line_len = 0;
        g_saw_rom_download_banner = false;

        cdc_acm_line_coding_t coding = {
            .dwDTERate = 115200,
            .bCharFormat = 0,
            .bParityType = 0,
            .bDataBits = 8,
        };
        cdc_acm_host_line_coding_set(hdl, &coding);
        cdc_acm_host_set_control_line_state(hdl, true, false);

        xSemaphoreTake(g_cdc_tx_mu, portMAX_DELAY);
        g_cdc_dev = hdl;
        xSemaphoreGive(g_cdc_tx_mu);

        uint64_t attach_us = (uint64_t)esp_timer_get_time();
        xSemaphoreTake(g_state_mu, portMAX_DELAY);
        g_state.usb_connected = true;
        g_state.usb_vid = opened_vid;
        g_state.usb_pid = opened_pid;
        xSemaphoreGive(g_state_mu);

        ESP_LOGI(TAG, "USB CDC timer attached on Type-A Host port (VID=%04X PID=%04X)", opened_vid, opened_pid);
        push_bridge_line_to_tcp();

        vTaskDelay(pdMS_TO_TICKS(60));
        const char *probe = "\nSTATUS?\n";
        cdc_send_bytes((const uint8_t *)probe, strlen(probe), 250);

        vTaskDelay(pdMS_TO_TICKS(650));
        bool got_status = false;
        bool still_connected = false;
        xSemaphoreTake(g_state_mu, portMAX_DELAY);
        still_connected = g_state.usb_connected;
        got_status = (g_state.last_status_us >= attach_us);
        xSemaphoreGive(g_state_mu);

        if (still_connected && (!got_status || g_saw_rom_download_banner)) {
            xSemaphoreTake(g_cdc_tx_mu, portMAX_DELAY);
            if (g_cdc_dev == hdl) {
                reboot_esp32c5_into_app(hdl);
            }
            xSemaphoreGive(g_cdc_tx_mu);
            vTaskDelay(pdMS_TO_TICKS(500));
            cdc_send_bytes((const uint8_t *)probe, strlen(probe), 250);
        }

        /* Block until CDC_ACM_HOST_DEVICE_DISCONNECTED fires, periodically refreshing cached
         * identity when no TCP host is actively polling STATUS?. */
        while (xSemaphoreTake(g_usb_disc_sem, pdMS_TO_TICKS(5000)) != pdTRUE) {
            if (g_tcp_client_fd < 0) {
                const char *bg_probe = "STATUS?\n";
                cdc_send_bytes((const uint8_t *)bg_probe, strlen(bg_probe), 200);
            }
        }
    }
}

/* ---- NVS Static IP / DHCP configuration (`NETCFG`) ------------------------------------------ */

static void load_net_cfg(void)
{
    memset(&g_net_cfg, 0, sizeof(g_net_cfg));
    nvs_handle_t h;
    if (nvs_open("slaprf_net", NVS_READONLY, &h) != ESP_OK) {
        return;
    }
    uint8_t is_static = 0;
    size_t sz = 0;
    if (nvs_get_u8(h, "static", &is_static) == ESP_OK && is_static == 1) {
        sz = sizeof(g_net_cfg.ip);
        if (nvs_get_str(h, "ip", g_net_cfg.ip, &sz) == ESP_OK) {
            sz = sizeof(g_net_cfg.netmask);
            if (nvs_get_str(h, "mask", g_net_cfg.netmask, &sz) != ESP_OK) {
                snprintf(g_net_cfg.netmask, sizeof(g_net_cfg.netmask), "255.255.255.0");
            }
            sz = sizeof(g_net_cfg.gateway);
            if (nvs_get_str(h, "gw", g_net_cfg.gateway, &sz) != ESP_OK) {
                snprintf(g_net_cfg.gateway, sizeof(g_net_cfg.gateway), "0.0.0.0");
            }
            g_net_cfg.static_ip = true;
        }
    }
    nvs_close(h);
}

static esp_err_t apply_net_cfg_to_netif(void)
{
    if (!g_eth_netif) {
        return ESP_ERR_INVALID_STATE;
    }
    if (!g_net_cfg.static_ip) {
        esp_netif_dhcpc_start(g_eth_netif);
        xSemaphoreTake(g_state_mu, portMAX_DELAY);
        g_state.using_static_ip = false;
        xSemaphoreGive(g_state_mu);
        return ESP_OK;
    }

    esp_netif_ip_info_t info;
    memset(&info, 0, sizeof(info));
    info.ip.addr = esp_ip4addr_aton(g_net_cfg.ip);
    info.netmask.addr = esp_ip4addr_aton(g_net_cfg.netmask);
    info.gw.addr = esp_ip4addr_aton(g_net_cfg.gateway);
    if (info.ip.addr == IPADDR_NONE || info.ip.addr == 0 || info.netmask.addr == IPADDR_NONE || info.netmask.addr == 0) {
        return ESP_ERR_INVALID_ARG;
    }
    esp_netif_dhcpc_stop(g_eth_netif);
    esp_err_t err = esp_netif_set_ip_info(g_eth_netif, &info);
    if (err == ESP_OK) {
        xSemaphoreTake(g_state_mu, portMAX_DELAY);
        g_state.using_static_ip = true;
        snprintf(g_state.ip_str, sizeof(g_state.ip_str), "%s", g_net_cfg.ip);
        snprintf(g_state.netmask_str, sizeof(g_state.netmask_str), "%s", g_net_cfg.netmask);
        snprintf(g_state.gw_str, sizeof(g_state.gw_str), "%s", g_net_cfg.gateway);
        xSemaphoreGive(g_state_mu);
    }
    return err;
}

static bool save_and_apply_net_cfg(bool is_static, const char *ip, const char *mask, const char *gw)
{
    if (is_static) {
        uint32_t ip_a = esp_ip4addr_aton(ip);
        uint32_t mk_a = esp_ip4addr_aton(mask);
        uint32_t gw_a = esp_ip4addr_aton(gw);
        if (ip_a == IPADDR_NONE || ip_a == 0 || mk_a == IPADDR_NONE || mk_a == 0 || gw_a == IPADDR_NONE) {
            return false;
        }
    }
    nvs_handle_t h;
    if (nvs_open("slaprf_net", NVS_READWRITE, &h) != ESP_OK) {
        return false;
    }
    nvs_set_u8(h, "static", is_static ? 1 : 0);
    if (is_static) {
        nvs_set_str(h, "ip", ip);
        nvs_set_str(h, "mask", mask);
        nvs_set_str(h, "gw", gw);
        g_net_cfg.static_ip = true;
        snprintf(g_net_cfg.ip, sizeof(g_net_cfg.ip), "%s", ip);
        snprintf(g_net_cfg.netmask, sizeof(g_net_cfg.netmask), "%s", mask);
        snprintf(g_net_cfg.gateway, sizeof(g_net_cfg.gateway), "%s", gw);
    } else {
        g_net_cfg.static_ip = false;
    }
    nvs_commit(h);
    nvs_close(h);
    return apply_net_cfg_to_netif() == ESP_OK;
}

/* Handles bridge-local commands (`BRIDGE?`, `NETCFG...`, `P4REBOOT`). Returns true if consumed
 * locally (not forwarded to XIAO C5), or false if the line belongs to the XIAO C5 console. */
static bool handle_local_bridge_cmd(const char *cmd_line, char *reply, size_t reply_sz, bool is_uart0)
{
    while (*cmd_line == ' ' || *cmd_line == '\t') {
        cmd_line++;
    }
    if (strcasecmp(cmd_line, "BRIDGE?") == 0 || (is_uart0 && strcasecmp(cmd_line, "STATUS?") == 0)) {
        format_bridge_json(reply, reply_sz, true);
        return true;
    }
    if (strcasecmp(cmd_line, "NETCFG?") == 0) {
        format_bridge_json(reply, reply_sz, true);
        return true;
    }
    if (strcasecmp(cmd_line, "NETCFG DHCP") == 0) {
        bool ok = save_and_apply_net_cfg(false, "", "", "");
        snprintf(reply, reply_sz, "@{\"t\":\"netcfg\",\"ok\":%s,\"mode\":\"dhcp\"}\n", ok ? "true" : "false");
        return true;
    }
    if (strncasecmp(cmd_line, "NETCFG STATIC ", 14) == 0) {
        char ip[20] = {0}, mask[20] = {0}, gw[20] = "0.0.0.0";
        int parts = sscanf(cmd_line + 14, "%19s %19s %19s", ip, mask, gw);
        bool ok = (parts >= 2) && save_and_apply_net_cfg(true, ip, mask, gw);
        snprintf(
            reply,
            reply_sz,
            "@{\"t\":\"netcfg\",\"ok\":%s,\"mode\":\"static\",\"ip\":\"%s\",\"netmask\":\"%s\",\"gateway\":\"%s\"}\n",
            ok ? "true" : "false",
            ip,
            mask,
            gw
        );
        return true;
    }
    if (strcasecmp(cmd_line, "P4REBOOT") == 0 || (is_uart0 && strcasecmp(cmd_line, "REBOOT") == 0)) {
        snprintf(reply, reply_sz, "@{\"t\":\"ack\",\"cmd\":\"REBOOT\"}\n");
        vTaskDelay(pdMS_TO_TICKS(50));
        esp_restart();
        return true;
    }
    return false;
}

/* ---- Ethernet Events & Initialization ------------------------------------------------------- */

static void eth_event_handler(void *arg, esp_event_base_t event_base, int32_t event_id, void *event_data)
{
    (void)arg;
    (void)event_base;
    esp_eth_handle_t eth_handle = *(esp_eth_handle_t *)event_data;
    uint8_t mac[6] = {0};
    eth_speed_t speed = ETH_SPEED_100M;
    eth_duplex_t duplex = ETH_DUPLEX_FULL;

    switch (event_id) {
    case ETHERNET_EVENT_CONNECTED:
        esp_eth_ioctl(eth_handle, ETH_CMD_G_MAC_ADDR, mac);
        esp_eth_ioctl(eth_handle, ETH_CMD_G_SPEED, &speed);
        esp_eth_ioctl(eth_handle, ETH_CMD_G_DUPLEX_MODE, &duplex);
        xSemaphoreTake(g_state_mu, portMAX_DELAY);
        g_state.eth_link_up = true;
        g_state.link_speed_mbps = (speed == ETH_SPEED_100M) ? 100 : 10;
        g_state.full_duplex = (duplex == ETH_DUPLEX_FULL);
        snprintf(
            g_state.mac_str,
            sizeof(g_state.mac_str),
            "%02X:%02X:%02X:%02X:%02X:%02X",
            mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]
        );
        xSemaphoreGive(g_state_mu);
        ESP_LOGI(
            TAG,
            "Ethernet link UP (%d Mbps %s, MAC %02X:%02X:%02X:%02X:%02X:%02X)",
            (speed == ETH_SPEED_100M) ? 100 : 10,
            (duplex == ETH_DUPLEX_FULL) ? "Full-Duplex" : "Half-Duplex",
            mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]
        );
        break;
    case ETHERNET_EVENT_DISCONNECTED:
        xSemaphoreTake(g_state_mu, portMAX_DELAY);
        g_state.eth_link_up = false;
        if (!g_state.using_static_ip) {
            g_state.ip_str[0] = '\0';
        }
        xSemaphoreGive(g_state_mu);
        ESP_LOGW(TAG, "Ethernet link DOWN");
        break;
    default:
        break;
    }
}

static void got_ip_event_handler(void *arg, esp_event_base_t event_base, int32_t event_id, void *event_data)
{
    (void)arg;
    (void)event_base;
    (void)event_id;
    const ip_event_got_ip_t *event = (const ip_event_got_ip_t *)event_data;
    xSemaphoreTake(g_state_mu, portMAX_DELAY);
    snprintf(g_state.ip_str, sizeof(g_state.ip_str), IPSTR, IP2STR(&event->ip_info.ip));
    snprintf(g_state.netmask_str, sizeof(g_state.netmask_str), IPSTR, IP2STR(&event->ip_info.netmask));
    snprintf(g_state.gw_str, sizeof(g_state.gw_str), IPSTR, IP2STR(&event->ip_info.gw));
    xSemaphoreGive(g_state_mu);
    ESP_LOGI(TAG, "Ethernet ready on %s:%d", g_state.ip_str, SLAPRF_NET_PORT);
}

static void init_ethernet(void)
{
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());

    esp_netif_config_t netif_cfg = ESP_NETIF_DEFAULT_ETH();
    g_eth_netif = esp_netif_new(&netif_cfg);
    esp_netif_set_hostname(g_eth_netif, "slaprf-poe-bridge");

    eth_mac_config_t mac_cfg = ETH_MAC_DEFAULT_CONFIG();
    eth_esp32_emac_config_t esp32_emac_cfg = ETH_ESP32_EMAC_DEFAULT_CONFIG();
    esp32_emac_cfg.smi_gpio.mdc_num = P4_ETH_MDC_GPIO;
    esp32_emac_cfg.smi_gpio.mdio_num = P4_ETH_MDIO_GPIO;
    esp32_emac_cfg.interface = EMAC_DATA_INTERFACE_RMII;
    esp32_emac_cfg.clock_config.rmii.clock_mode = EMAC_CLK_EXT_IN;
    esp32_emac_cfg.clock_config.rmii.clock_gpio = P4_ETH_RMII_CLK_GPIO;
    esp32_emac_cfg.emac_dataif_gpio.rmii.tx_en_num = P4_ETH_TX_EN_GPIO;
    esp32_emac_cfg.emac_dataif_gpio.rmii.txd0_num = P4_ETH_TXD0_GPIO;
    esp32_emac_cfg.emac_dataif_gpio.rmii.txd1_num = P4_ETH_TXD1_GPIO;
    esp32_emac_cfg.emac_dataif_gpio.rmii.crs_dv_num = P4_ETH_CRS_DV_GPIO;
    esp32_emac_cfg.emac_dataif_gpio.rmii.rxd0_num = P4_ETH_RXD0_GPIO;
    esp32_emac_cfg.emac_dataif_gpio.rmii.rxd1_num = P4_ETH_RXD1_GPIO;

    esp_eth_mac_t *mac = esp_eth_mac_new_esp32(&esp32_emac_cfg, &mac_cfg);

    eth_phy_config_t phy_cfg = ETH_PHY_DEFAULT_CONFIG();
    phy_cfg.phy_addr = ESP_ETH_PHY_ADDR_AUTO;
    phy_cfg.reset_gpio_num = P4_ETH_PHY_RST_GPIO;
    esp_eth_phy_t *phy = esp_eth_phy_new_ip101(&phy_cfg);

    esp_eth_config_t eth_cfg = ETH_DEFAULT_CONFIG(mac, phy);
    esp_eth_handle_t eth_handle = NULL;
    ESP_ERROR_CHECK(esp_eth_driver_install(&eth_cfg, &eth_handle));
    ESP_ERROR_CHECK(esp_netif_attach(g_eth_netif, esp_eth_new_netif_glue(eth_handle)));

    uint8_t mac_addr[6] = {0};
    if (esp_eth_ioctl(eth_handle, ETH_CMD_G_MAC_ADDR, mac_addr) == ESP_OK) {
        xSemaphoreTake(g_state_mu, portMAX_DELAY);
        snprintf(
            g_state.mac_str,
            sizeof(g_state.mac_str),
            "%02X:%02X:%02X:%02X:%02X:%02X",
            mac_addr[0], mac_addr[1], mac_addr[2], mac_addr[3], mac_addr[4], mac_addr[5]
        );
        xSemaphoreGive(g_state_mu);
    }

    ESP_ERROR_CHECK(esp_event_handler_register(ETH_EVENT, ESP_EVENT_ANY_ID, &eth_event_handler, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_ETH_GOT_IP, &got_ip_event_handler, NULL));

    apply_net_cfg_to_netif();
    ESP_ERROR_CHECK(esp_eth_start(eth_handle));
}

/* ---- UDP :5480 Discovery & TCP :5480 Wire Bridge ------------------------------------------- */

static void udp_discovery_task(void *arg)
{
    (void)arg;
    int sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_IP);
    if (sock < 0) {
        ESP_LOGE(TAG, "UDP discovery socket failed: errno=%d", errno);
        vTaskDelete(NULL);
        return;
    }
    int yes = 1;
    setsockopt(sock, SOL_SOCKET, SO_BROADCAST, &yes, sizeof(yes));
    setsockopt(sock, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));

    struct sockaddr_in bind_addr = {
        .sin_family = AF_INET,
        .sin_port = htons(SLAPRF_NET_PORT),
        .sin_addr.s_addr = htonl(INADDR_ANY),
    };
    if (bind(sock, (struct sockaddr *)&bind_addr, sizeof(bind_addr)) < 0) {
        ESP_LOGE(TAG, "UDP discovery bind(:%d) failed: errno=%d", SLAPRF_NET_PORT, errno);
        close(sock);
        vTaskDelete(NULL);
        return;
    }

    char rx_buf[128];
    char tx_buf[768];
    while (true) {
        struct sockaddr_in src_addr;
        socklen_t socklen = sizeof(src_addr);
        ssize_t n = recvfrom(sock, rx_buf, sizeof(rx_buf) - 1, 0, (struct sockaddr *)&src_addr, &socklen);
        if (n <= 0) {
            continue;
        }
        rx_buf[n] = '\0';
        if (strncmp(rx_buf, "SLAPRF_DISCOVER?", 16) == 0) {
            size_t len = format_bridge_json(tx_buf, sizeof(tx_buf), false);
            if (len > 0) {
                sendto(sock, tx_buf, len, 0, (struct sockaddr *)&src_addr, socklen);
            }
        }
    }
}

static void tcp_tx_pump_task(void *arg)
{
    (void)arg;
    uint8_t chunk[1460];
    while (true) {
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(20));
        while (true) {
            int fd = g_tcp_client_fd;
            if (fd < 0) {
                ring_clear();
                break;
            }
            size_t n = ring_pop_bytes(chunk, sizeof(chunk));
            if (n == 0) {
                break;
            }
            size_t sent_total = 0;
            while (sent_total < n && g_tcp_client_fd == fd) {
                ssize_t w = send(fd, chunk + sent_total, n - sent_total, 0);
                if (w < 0) {
                    if (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK) {
                        vTaskDelay(pdMS_TO_TICKS(1));
                        continue;
                    }
                    shutdown(fd, SHUT_RDWR);
                    break;
                }
                sent_total += (size_t)w;
            }
        }
    }
}

static void tcp_server_task(void *arg)
{
    (void)arg;
    int listen_fd = socket(AF_INET, SOCK_STREAM, IPPROTO_IP);
    if (listen_fd < 0) {
        ESP_LOGE(TAG, "TCP socket failed: errno=%d", errno);
        vTaskDelete(NULL);
        return;
    }
    int yes = 1;
    setsockopt(listen_fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));

    struct sockaddr_in bind_addr = {
        .sin_family = AF_INET,
        .sin_port = htons(SLAPRF_NET_PORT),
        .sin_addr.s_addr = htonl(INADDR_ANY),
    };
    if (bind(listen_fd, (struct sockaddr *)&bind_addr, sizeof(bind_addr)) < 0 || listen(listen_fd, 2) < 0) {
        ESP_LOGE(TAG, "TCP bind/listen(:%d) failed: errno=%d", SLAPRF_NET_PORT, errno);
        close(listen_fd);
        vTaskDelete(NULL);
        return;
    }

    ESP_LOGI(TAG, "Listening on TCP/UDP :%d", SLAPRF_NET_PORT);

    uint8_t rx_buf[512];
    char cmd_line[256];
    size_t cmd_len = 0;
    char reply[768];

    while (true) {
        struct sockaddr_in client_addr;
        socklen_t addr_len = sizeof(client_addr);
        int client_fd = accept(listen_fd, (struct sockaddr *)&client_addr, &addr_len);
        if (client_fd < 0) {
            vTaskDelay(pdMS_TO_TICKS(50));
            continue;
        }

        while (client_fd >= 0) {
            int nodelay = 1;
            int keepalive = 1;
            int keepidle = 5;
            int keepintvl = 2;
            int keepcnt = 3;
            setsockopt(client_fd, IPPROTO_TCP, TCP_NODELAY, &nodelay, sizeof(nodelay));
            setsockopt(client_fd, SOL_SOCKET, SO_KEEPALIVE, &keepalive, sizeof(keepalive));
            setsockopt(client_fd, IPPROTO_TCP, TCP_KEEPIDLE, &keepidle, sizeof(keepidle));
            setsockopt(client_fd, IPPROTO_TCP, TCP_KEEPINTVL, &keepintvl, sizeof(keepintvl));
            setsockopt(client_fd, IPPROTO_TCP, TCP_KEEPCNT, &keepcnt, sizeof(keepcnt));

            ring_clear();
            g_tcp_client_fd = client_fd;
            cmd_len = 0;

            char peer_ip[16] = {0};
            inet_ntoa_r(client_addr.sin_addr, peer_ip, sizeof(peer_ip) - 1);
            ESP_LOGI(TAG, "TCP client connected from %s", peer_ip);

            /* Immediately announce bridge + Ethernet status and request fresh STATUS? from XIAO C5 */
            push_bridge_line_to_tcp();
            const char *init_probe = "STATUS?\n";
            cdc_send_bytes((const uint8_t *)init_probe, strlen(init_probe), 200);

            int next_client_fd = -1;
            struct sockaddr_in next_addr;
            memset(&next_addr, 0, sizeof(next_addr));

            while (true) {
                fd_set rfds;
                FD_ZERO(&rfds);
                FD_SET(listen_fd, &rfds);
                FD_SET(client_fd, &rfds);
                int max_fd = (listen_fd > client_fd) ? listen_fd : client_fd;
                struct timeval tv = {.tv_sec = 1, .tv_usec = 0};

                int sel = select(max_fd + 1, &rfds, NULL, NULL, &tv);
                if (sel < 0) {
                    if (errno == EINTR) {
                        continue;
                    }
                    break;
                }
                if (sel == 0) {
                    continue;
                }
                if (FD_ISSET(listen_fd, &rfds)) {
                    socklen_t nlen = sizeof(next_addr);
                    int nfd = accept(listen_fd, (struct sockaddr *)&next_addr, &nlen);
                    if (nfd >= 0) {
                        ESP_LOGI(TAG, "Replacing existing TCP session with new client connection");
                        next_client_fd = nfd;
                        break;
                    }
                }
                if (!FD_ISSET(client_fd, &rfds)) {
                    continue;
                }

                ssize_t n = recv(client_fd, rx_buf, sizeof(rx_buf), 0);
                if (n < 0) {
                    if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) {
                        continue;
                    }
                    break;
                }
                if (n == 0) {
                    break;
                }

                /* Parse line-by-line so bridge-local commands (`BRIDGE?`, `NETCFG...`) are answered by
                 * the P4 while all timer commands (`STATUS?`, `SLAPRF?`, `SCAN`, `NETCHANNELS`, etc.)
                 * stream straight through to the XIAO ESP32-C5 on USB-A. */
                for (ssize_t i = 0; i < n; i++) {
                    char c = (char)rx_buf[i];
                    if (c == '\r') {
                        continue;
                    }
                    if (c == '\n') {
                        cmd_line[cmd_len] = '\0';
                        if (cmd_len == 0) {
                            const uint8_t nl = '\n';
                            cdc_send_bytes(&nl, 1, 100);
                        } else if (handle_local_bridge_cmd(cmd_line, reply, sizeof(reply), false)) {
                            ring_push_bytes((const uint8_t *)reply, strlen(reply));
                        } else {
                            bool usb_up = false;
                            xSemaphoreTake(g_state_mu, portMAX_DELAY);
                            usb_up = g_state.usb_connected;
                            xSemaphoreGive(g_state_mu);

                            if (usb_up) {
                                cmd_line[cmd_len] = '\n';
                                cdc_send_bytes((const uint8_t *)cmd_line, cmd_len + 1, 250);
                                if (strncasecmp(cmd_line, "STATUS?", 7) == 0) {
                                    push_bridge_line_to_tcp();
                                }
                            } else if (strncasecmp(cmd_line, "STATUS?", 7) == 0) {
                                push_bridge_line_to_tcp();
                            }
                        }
                        cmd_len = 0;
                    } else if (cmd_len + 2 < sizeof(cmd_line)) {
                        cmd_line[cmd_len++] = c;
                    }
                }
            }

            ESP_LOGI(TAG, "TCP client disconnected (%s)", peer_ip);
            g_tcp_client_fd = -1;
            ring_clear();
            close(client_fd);
            client_fd = next_client_fd;
            client_addr = next_addr;
        }
    }
}

/* ---- UART0 USB-C Local Console (`BRIDGE?`, `STATUS?`, `NETCFG`) ---------------------------- */

static void uart0_console_task(void *arg)
{
    (void)arg;
    uart_driver_install(UART_NUM_0, 1024, 0, 0, NULL, 0);

    uint8_t ch = 0;
    char line[256];
    size_t len = 0;
    char reply[768];

    while (true) {
        int r = uart_read_bytes(UART_NUM_0, &ch, 1, pdMS_TO_TICKS(100));
        if (r <= 0) {
            continue;
        }
        if (ch == '\r') {
            continue;
        }
        if (ch == '\n') {
            line[len] = '\0';
            if (len > 0) {
                if (handle_local_bridge_cmd(line, reply, sizeof(reply), true)) {
                    uart_write_bytes(UART_NUM_0, reply, strlen(reply));
                }
            }
            len = 0;
        } else if (len + 1 < sizeof(line)) {
            line[len++] = (char)ch;
        }
    }
}

void app_main(void)
{
    /* 1. Immediately hold any onboard ESP32-C6 co-processor powered down in reset */
    hold_onboard_c6_in_reset();

    g_state_mu = xSemaphoreCreateMutex();
    g_cdc_tx_mu = xSemaphoreCreateMutex();
    g_ring_mu = xSemaphoreCreateMutex();
    g_usb_disc_sem = xSemaphoreCreateBinary();
    memset(&g_state, 0, sizeof(g_state));
    snprintf(g_state.timer_label, sizeof(g_state.timer_label), "H1");
    g_state.timer_role = 1;
    g_state.timer_sweep_hz = 100;

    /* 2. Initialize NVS & load optional static IP configuration */
    esp_err_t nvs_err = nvs_flash_init();
    if (nvs_err == ESP_ERR_NVS_NO_FREE_PAGES || nvs_err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        nvs_err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(nvs_err);
    load_net_cfg();

    /* 3. Bring up 100 Mbps RMII Ethernet (`IP101GRI`) */
    init_ethernet();

    /* 4. Install USB 2.0 Host + CDC-ACM driver for XIAO ESP32-C5 on Type-A Host port */
    const usb_host_config_t host_cfg = {
        .skip_phy_setup = false,
        .intr_flags = ESP_INTR_FLAG_LEVEL1,
    };
    ESP_ERROR_CHECK(usb_host_install(&host_cfg));
    xTaskCreate(usb_lib_task, "usb_lib", 4096, NULL, 20, NULL);

    const cdc_acm_host_driver_config_t cdc_drv_cfg = {
        .driver_task_stack_size = 4096,
        .driver_task_priority = 19,
        .xCoreID = tskNO_AFFINITY,
        .new_dev_cb = NULL,
    };
    ESP_ERROR_CHECK(cdc_acm_host_install(&cdc_drv_cfg));

    /* 5. Launch bridge pump, discovery responder, TCP :5480 listener, USB supervisor, and UART0 console */
    xTaskCreate(tcp_tx_pump_task, "tcp_tx", 4096, NULL, 18, &g_tcp_tx_task);
    xTaskCreate(usb_cdc_supervisor_task, "usb_sup", 6144, NULL, 15, NULL);
    xTaskCreate(udp_discovery_task, "udp_disc", 4096, NULL, 12, NULL);
    xTaskCreate(tcp_server_task, "tcp_srv", 6144, NULL, 14, NULL);
    xTaskCreate(uart0_console_task, "uart0_con", 4096, NULL, 8, NULL);

    ESP_LOGI(TAG, "SlapRF PoE Ethernet Bridge v%s started (C6 held OFF on GPIO%d)", BRIDGE_FW_VERSION, P4_C6_RST_GPIO);
}
