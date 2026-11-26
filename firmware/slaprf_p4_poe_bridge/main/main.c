/*
 * Generic PoE Ethernet <-> USB Serial/JTAG Bridge Firmware
 * Target: Waveshare ESP32-P4-POE-ETH / ESP32-P4-WIFI6-POE-ETH (ESP32-P4 + IP101GRI RMII + USB 2.0 Host)
 *
 * Design:
 *  - Pure, protocol-agnostic raw TCP <-> USB CDC-ACM / USB-Serial-JTAG bridge on TCP port 5480:
 *      * Every byte received on TCP :5480 is transmitted verbatim to the attached USB serial device.
 *      * Every byte received from the attached USB serial device is streamed verbatim to TCP :5480
 *        with TCP_NODELAY=1 (<0.5 ms latency) and zero protocol inspection or injected bytes.
 *      * Works with Seeed Studio XIAO ESP32-C5 (USB-Serial-JTAG), ESP32-S3/C6, STM32/RP2040 CDC-ACM,
 *        LapRF USB, RotorHazard USB nodes, or any bulk-endpoint USB serial adapter.
 *  - Holds GPIO54 (C6_RST) LOW at boot so any onboard ESP32-C6 co-processor stays powered off in reset.
 *  - Brings up 100 Mbps RMII Ethernet (IP101GRI) with DHCP + RFC 3927 AutoIP (169.254.x.x) fallback
 *    plus optional persistent static IP configuration via local UART0 (`NETCFG STATIC <ip> <mask> <gw>`).
 *  - Out-of-band UDP :5480 discovery responder (`DISCOVER?` / `SLAPRF_DISCOVER?`) reports IP, MAC,
 *    Ethernet link speed, and attached USB VID:PID without touching the serial byte stream.
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

#define BRIDGE_FW_VERSION       "0.2.2"
#define BRIDGE_TCP_PORT         5480
#define MAX_TCP_CLIENTS         1
#define DEFAULT_USB_BAUD        115200

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

#define USB_RX_RING_SIZE        65536

static const char *TAG = "usb_eth_bridge";

typedef struct {
    bool static_ip;
    char ip[16];
    char netmask[16];
    char gateway[16];
    uint32_t baud_rate;
} bridge_cfg_t;

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
    uint16_t last_seen_vid;
    uint16_t last_seen_pid;
    uint16_t usb_vid;
    uint16_t usb_pid;
    uint32_t usb_baud;
    bool usb_dtr;
    bool usb_rts;
    uint64_t usb_rx_bytes;
    uint64_t usb_tx_bytes;
    bool tcp_connected;
    int tcp_clients;
    char tcp_peer[96];
} bridge_state_t;

typedef struct {
    int fd;
    char peer_ip[16];
} tcp_client_slot_t;

static SemaphoreHandle_t g_state_mu = NULL;
static SemaphoreHandle_t g_cdc_tx_mu = NULL;
static SemaphoreHandle_t g_usb_disc_sem = NULL;
static SemaphoreHandle_t g_ring_mu = NULL;
static SemaphoreHandle_t g_clients_mu = NULL;

static bridge_state_t g_state;
static bridge_cfg_t g_cfg;
static esp_netif_t *g_eth_netif = NULL;
static cdc_acm_dev_hdl_t g_cdc_dev = NULL;

static tcp_client_slot_t g_tcp_clients[MAX_TCP_CLIENTS];
static volatile int g_tcp_client_count = 0;
static TaskHandle_t g_tcp_tx_task = NULL;

static uint8_t g_rx_ring[USB_RX_RING_SIZE];
static size_t g_rx_head = 0;
static size_t g_rx_tail = 0;
static size_t g_rx_count = 0;

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

/* ---- Lock-protected ring buffer: USB RX -> TCP TX ------------------------------------------ */

static void ring_push_bytes(const uint8_t *data, size_t len)
{
    if (len == 0 || g_tcp_client_count <= 0) {
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

/* ---- Out-of-band status JSON (for UDP :5480 discovery & UART0 console only) ----------------- */

static size_t format_bridge_json(char *buf, size_t buf_sz, bool as_at_line)
{
    bridge_state_t snap;
    bridge_cfg_t cfg_snap;
    xSemaphoreTake(g_state_mu, portMAX_DELAY);
    snap = g_state;
    cfg_snap = g_cfg;
    xSemaphoreGive(g_state_mu);

    uint64_t up_ms = (uint64_t)(esp_timer_get_time() / 1000ULL);
    int n = snprintf(
        buf,
        buf_sz,
        "%s{\"t\":\"bridge\",\"proto\":\"usb-serial-eth\",\"ver\":1,"
        "\"board\":\"ESP32-P4-WIFI6-POE-ETH\",\"bridgeFw\":\"%s\",\"port\":%d,\"upMs\":%" PRIu64 ","
        "\"usbConnected\":%s,\"usbVid\":\"%04X\",\"usbPid\":\"%04X\",\"baud\":%" PRIu32 ","
        "\"dtr\":%s,\"rts\":%s,"
        "\"ip\":\"%s\",\"netmask\":\"%s\",\"gateway\":\"%s\",\"mac\":\"%s\","
        "\"staticIp\":\"%s\",\"staticNetmask\":\"%s\",\"staticGateway\":\"%s\","
        "\"linkUp\":%s,\"linkSpeedMbps\":%d,\"fullDuplex\":%s,\"dhcp\":%s,"
        "\"tcpConnected\":%s,\"tcpClients\":%d,\"maxClients\":%d,\"tcpPeer\":\"%s\","
        "\"rxBytes\":%" PRIu64 ",\"txBytes\":%" PRIu64 "}%s",
        as_at_line ? "@" : "",
        BRIDGE_FW_VERSION,
        BRIDGE_TCP_PORT,
        up_ms,
        snap.usb_connected ? "true" : "false",
        snap.usb_vid,
        snap.usb_pid,
        snap.usb_baud,
        snap.usb_dtr ? "true" : "false",
        snap.usb_rts ? "true" : "false",
        snap.ip_str,
        snap.netmask_str,
        snap.gw_str,
        snap.mac_str,
        cfg_snap.ip,
        cfg_snap.netmask,
        cfg_snap.gateway,
        snap.eth_link_up ? "true" : "false",
        snap.link_speed_mbps,
        snap.full_duplex ? "true" : "false",
        snap.using_static_ip ? "false" : "true",
        snap.tcp_connected ? "true" : "false",
        snap.tcp_clients,
        MAX_TCP_CLIENTS,
        snap.tcp_peer,
        snap.usb_rx_bytes,
        snap.usb_tx_bytes,
        as_at_line ? "\n" : ""
    );
    if (n < 0) {
        return 0;
    }
    return (size_t)n < buf_sz ? (size_t)n : (buf_sz - 1);
}

/* ---- Generic USB Host CDC-ACM / USB-Serial-JTAG Pump --------------------------------------- */

static void usb_new_dev_cb(usb_device_handle_t usb_dev)
{
    const usb_device_desc_t *desc = NULL;
    if (usb_host_get_device_descriptor(usb_dev, &desc) == ESP_OK && desc != NULL) {
        xSemaphoreTake(g_state_mu, portMAX_DELAY);
        g_state.last_seen_vid = desc->idVendor;
        g_state.last_seen_pid = desc->idProduct;
        xSemaphoreGive(g_state_mu);
        ESP_LOGI(TAG, "USB device enumerated on Type-A port: VID=%04X PID=%04X", desc->idVendor, desc->idProduct);
    }
}

static esp_err_t cdc_send_bytes_raw(const uint8_t *data, size_t len)
{
    if (len == 0) {
        return ESP_OK;
    }
    xSemaphoreTake(g_cdc_tx_mu, portMAX_DELAY);
    cdc_acm_dev_hdl_t hdl = g_cdc_dev;
    esp_err_t err = ESP_ERR_INVALID_STATE;
    if (hdl != NULL) {
        size_t off = 0;
        err = ESP_OK;
        while (off < len) {
            size_t chunk = len - off;
            if (chunk > 1024) {
                chunk = 1024;
            }
            err = cdc_acm_host_data_tx_blocking(hdl, data + off, chunk, 500);
            if (err != ESP_OK) {
                break;
            }
            off += chunk;
        }
        if (off > 0) {
            xSemaphoreTake(g_state_mu, portMAX_DELAY);
            g_state.usb_tx_bytes += off;
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

    /* Forward raw USB RX bytes verbatim into the TCP TX ring buffer */
    ring_push_bytes(data, data_len);
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
        ESP_LOGW(TAG, "USB CDC error=%d", event->data.error);
        break;
    case CDC_ACM_HOST_DEVICE_DISCONNECTED:
        ESP_LOGI(TAG, "USB serial device disconnected from Type-A port");
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
        xSemaphoreGive(g_usb_disc_sem);
        break;
    default:
        break;
    }
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
        esp_err_t err = ESP_ERR_NOT_FOUND;

        /* Try interface 0 first (standard CDC-ACM & ESP32 USB-Serial-JTAG), then 1 & 2 for composite devices */
        for (uint8_t iface = 0; iface <= 2; iface++) {
            cdc_acm_host_device_config_t try_cfg = dev_cfg;
            try_cfg.connection_timeout_ms = (iface == 0) ? 1000 : 150;
            err = cdc_acm_host_open(CDC_HOST_ANY_VID, CDC_HOST_ANY_PID, iface, &try_cfg, &hdl);
            if (err == ESP_OK && hdl != NULL) {
                break;
            }
        }
        if (err != ESP_OK || hdl == NULL) {
            vTaskDelay(pdMS_TO_TICKS(250));
            continue;
        }

        xSemaphoreTake(g_usb_disc_sem, 0);

        uint32_t baud = g_cfg.baud_rate > 0 ? g_cfg.baud_rate : DEFAULT_USB_BAUD;
        cdc_acm_line_coding_t coding = {
            .dwDTERate = baud,
            .bCharFormat = 0,
            .bParityType = 0,
            .bDataBits = 8,
        };
        /* Best-effort line coding + DTR=1, RTS=0 (ignored cleanly if device does not implement PSTN control) */
        cdc_acm_host_line_coding_set(hdl, &coding);
        cdc_acm_host_set_control_line_state(hdl, true, false);

        xSemaphoreTake(g_cdc_tx_mu, portMAX_DELAY);
        g_cdc_dev = hdl;
        xSemaphoreGive(g_cdc_tx_mu);

        uint16_t vid = 0, pid = 0;
        xSemaphoreTake(g_state_mu, portMAX_DELAY);
        g_state.usb_connected = true;
        g_state.usb_vid = g_state.last_seen_vid;
        g_state.usb_pid = g_state.last_seen_pid;
        g_state.usb_baud = baud;
        g_state.usb_dtr = true;
        g_state.usb_rts = false;
        vid = g_state.usb_vid;
        pid = g_state.usb_pid;
        xSemaphoreGive(g_state_mu);

        ESP_LOGI(TAG, "Bridging USB serial device (VID=%04X PID=%04X @ %" PRIu32 " baud) <-> TCP :%d", vid, pid, baud, BRIDGE_TCP_PORT);

        /* Wait until USB device is unplugged */
        xSemaphoreTake(g_usb_disc_sem, portMAX_DELAY);
    }
}

/* ---- NVS Network / Baud Configuration (UART0 local management only) ------------------------ */

static void load_bridge_cfg(void)
{
    memset(&g_cfg, 0, sizeof(g_cfg));
    g_cfg.baud_rate = DEFAULT_USB_BAUD;

    nvs_handle_t h;
    if (nvs_open("poe_bridge", NVS_READONLY, &h) != ESP_OK) {
        return;
    }
    uint32_t baud = 0;
    if (nvs_get_u32(h, "baud", &baud) == ESP_OK && baud >= 1200 && baud <= 4000000) {
        g_cfg.baud_rate = baud;
    }
    uint8_t is_static = 0;
    size_t sz = sizeof(g_cfg.ip);
    if (nvs_get_str(h, "ip", g_cfg.ip, &sz) == ESP_OK) {
        sz = sizeof(g_cfg.netmask);
        if (nvs_get_str(h, "mask", g_cfg.netmask, &sz) != ESP_OK) {
            snprintf(g_cfg.netmask, sizeof(g_cfg.netmask), "255.255.255.0");
        }
        sz = sizeof(g_cfg.gateway);
        if (nvs_get_str(h, "gw", g_cfg.gateway, &sz) != ESP_OK) {
            snprintf(g_cfg.gateway, sizeof(g_cfg.gateway), "0.0.0.0");
        }
        if (nvs_get_u8(h, "static", &is_static) == ESP_OK && is_static == 1) {
            g_cfg.static_ip = true;
        }
    }
    nvs_close(h);
}

static esp_err_t apply_net_cfg_to_netif(void)
{
    if (!g_eth_netif) {
        return ESP_ERR_INVALID_STATE;
    }
    if (!g_cfg.static_ip) {
        esp_netif_dhcpc_start(g_eth_netif);
        xSemaphoreTake(g_state_mu, portMAX_DELAY);
        g_state.using_static_ip = false;
        xSemaphoreGive(g_state_mu);
        return ESP_OK;
    }

    esp_netif_ip_info_t info;
    memset(&info, 0, sizeof(info));
    info.ip.addr = esp_ip4addr_aton(g_cfg.ip);
    info.netmask.addr = esp_ip4addr_aton(g_cfg.netmask);
    info.gw.addr = esp_ip4addr_aton(g_cfg.gateway);
    if (info.ip.addr == IPADDR_NONE || info.ip.addr == 0 || info.netmask.addr == IPADDR_NONE || info.netmask.addr == 0) {
        return ESP_ERR_INVALID_ARG;
    }
    esp_netif_dhcpc_stop(g_eth_netif);
    esp_err_t err = esp_netif_set_ip_info(g_eth_netif, &info);
    if (err == ESP_OK) {
        xSemaphoreTake(g_state_mu, portMAX_DELAY);
        g_state.using_static_ip = true;
        snprintf(g_state.ip_str, sizeof(g_state.ip_str), "%s", g_cfg.ip);
        snprintf(g_state.netmask_str, sizeof(g_state.netmask_str), "%s", g_cfg.netmask);
        snprintf(g_state.gw_str, sizeof(g_state.gw_str), "%s", g_cfg.gateway);
        xSemaphoreGive(g_state_mu);
    }
    return err;
}

static bool validate_and_store_net_cfg(bool is_static, const char *ip, const char *mask, const char *gw)
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
    if (nvs_open("poe_bridge", NVS_READWRITE, &h) != ESP_OK) {
        return false;
    }
    nvs_set_u8(h, "static", is_static ? 1 : 0);
    xSemaphoreTake(g_state_mu, portMAX_DELAY);
    if (is_static) {
        nvs_set_str(h, "ip", ip);
        nvs_set_str(h, "mask", mask);
        nvs_set_str(h, "gw", gw);
        g_cfg.static_ip = true;
        snprintf(g_cfg.ip, sizeof(g_cfg.ip), "%s", ip);
        snprintf(g_cfg.netmask, sizeof(g_cfg.netmask), "%s", mask);
        snprintf(g_cfg.gateway, sizeof(g_cfg.gateway), "%s", gw);
    } else {
        g_cfg.static_ip = false;
    }
    xSemaphoreGive(g_state_mu);
    nvs_commit(h);
    nvs_close(h);
    return true;
}

static bool save_and_apply_net_cfg(bool is_static, const char *ip, const char *mask, const char *gw)
{
    if (!validate_and_store_net_cfg(is_static, ip, mask, gw)) {
        return false;
    }
    return apply_net_cfg_to_netif() == ESP_OK;
}

static bool save_and_apply_baud(uint32_t baud)
{
    if (baud < 1200 || baud > 4000000) {
        return false;
    }
    nvs_handle_t h;
    if (nvs_open("poe_bridge", NVS_READWRITE, &h) != ESP_OK) {
        return false;
    }
    nvs_set_u32(h, "baud", baud);
    nvs_commit(h);
    nvs_close(h);
    g_cfg.baud_rate = baud;

    xSemaphoreTake(g_cdc_tx_mu, portMAX_DELAY);
    if (g_cdc_dev != NULL) {
        cdc_acm_line_coding_t coding = {
            .dwDTERate = baud,
            .bCharFormat = 0,
            .bParityType = 0,
            .bDataBits = 8,
        };
        cdc_acm_host_line_coding_set(g_cdc_dev, &coding);
    }
    xSemaphoreGive(g_cdc_tx_mu);

    xSemaphoreTake(g_state_mu, portMAX_DELAY);
    g_state.usb_baud = baud;
    xSemaphoreGive(g_state_mu);
    return true;
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
    ESP_LOGI(TAG, "TCP serial bridge ready at %s:%d", g_state.ip_str, BRIDGE_TCP_PORT);
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

/* ---- Out-of-Band UDP :5480 Discovery & Pure Raw TCP :5480 Serial Pipe ---------------------- */

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
        .sin_port = htons(BRIDGE_TCP_PORT),
        .sin_addr.s_addr = htonl(INADDR_ANY),
    };
    if (bind(sock, (struct sockaddr *)&bind_addr, sizeof(bind_addr)) < 0) {
        ESP_LOGE(TAG, "UDP discovery bind(:%d) failed: errno=%d", BRIDGE_TCP_PORT, errno);
        close(sock);
        vTaskDelete(NULL);
        return;
    }

    char rx_buf[192];
    char tx_buf[640];
    while (true) {
        struct sockaddr_in src_addr;
        socklen_t socklen = sizeof(src_addr);
        ssize_t n = recvfrom(sock, rx_buf, sizeof(rx_buf) - 1, 0, (struct sockaddr *)&src_addr, &socklen);
        if (n <= 0) {
            continue;
        }
        rx_buf[n] = '\0';
        while (n > 0 && (rx_buf[n - 1] == '\n' || rx_buf[n - 1] == '\r' || rx_buf[n - 1] == ' ' || rx_buf[n - 1] == '\t')) {
            rx_buf[--n] = '\0';
        }
        const char *cmd = rx_buf;
        while (*cmd == ' ' || *cmd == '\t') {
            cmd++;
        }

        if (strcasecmp(cmd, "DISCOVER?") == 0 || strcasecmp(cmd, "SLAPRF_DISCOVER?") == 0 ||
            strcasecmp(cmd, "STATUS?") == 0 || strcasecmp(cmd, "BRIDGE?") == 0 || strcasecmp(cmd, "NETCFG?") == 0) {
            size_t len = format_bridge_json(tx_buf, sizeof(tx_buf), false);
            if (len > 0) {
                sendto(sock, tx_buf, len, 0, (struct sockaddr *)&src_addr, socklen);
            }
        } else if (strncasecmp(cmd, "BAUD ", 5) == 0) {
            uint32_t b = (uint32_t)strtoul(cmd + 5, NULL, 10);
            bool ok = save_and_apply_baud(b);
            int ack_n = snprintf(tx_buf, sizeof(tx_buf), "{\"ok\":%s,\"baud\":%" PRIu32 "}", ok ? "true" : "false", b);
            if (ack_n > 0) {
                sendto(sock, tx_buf, (size_t)ack_n, 0, (struct sockaddr *)&src_addr, socklen);
            }
        } else if (strncasecmp(cmd, "CTRL ", 5) == 0) {
            /* Out-of-band serial control lines (`CTRL dtr=1 rts=0 baud=115200`) so TCP :5480
             * stays 100% pure unescaped serial bytes while still supporting remote DTR/RTS/baud! */
            int dtr = -1, rts = -1;
            unsigned long baud = 0;
            const char *p_dtr = strstr(cmd + 5, "dtr=");
            const char *p_rts = strstr(cmd + 5, "rts=");
            const char *p_baud = strstr(cmd + 5, "baud=");
            if (p_dtr) {
                dtr = atoi(p_dtr + 4) ? 1 : 0;
            }
            if (p_rts) {
                rts = atoi(p_rts + 4) ? 1 : 0;
            }
            if (p_baud) {
                baud = strtoul(p_baud + 5, NULL, 10);
            }
            if (baud >= 1200 && baud <= 4000000) {
                save_and_apply_baud((uint32_t)baud);
            }
            if (dtr >= 0 || rts >= 0) {
                bool next_dtr = true;
                bool next_rts = false;
                xSemaphoreTake(g_state_mu, portMAX_DELAY);
                next_dtr = (dtr >= 0) ? (dtr != 0) : g_state.usb_dtr;
                next_rts = (rts >= 0) ? (rts != 0) : g_state.usb_rts;
                g_state.usb_dtr = next_dtr;
                g_state.usb_rts = next_rts;
                xSemaphoreGive(g_state_mu);

                xSemaphoreTake(g_cdc_tx_mu, portMAX_DELAY);
                if (g_cdc_dev != NULL) {
                    cdc_acm_host_set_control_line_state(g_cdc_dev, next_dtr, next_rts);
                }
                xSemaphoreGive(g_cdc_tx_mu);
            }
            int ack_n = snprintf(tx_buf, sizeof(tx_buf), "{\"ok\":true}");
            if (ack_n > 0) {
                sendto(sock, tx_buf, (size_t)ack_n, 0, (struct sockaddr *)&src_addr, socklen);
            }
        } else if (strcasecmp(cmd, "NETCFG DHCP") == 0) {
            bool ok = validate_and_store_net_cfg(false, "", "", "");
            int ack_n = snprintf(tx_buf, sizeof(tx_buf), "{\"ok\":%s,\"mode\":\"dhcp\"}", ok ? "true" : "false");
            if (ack_n > 0) {
                sendto(sock, tx_buf, (size_t)ack_n, 0, (struct sockaddr *)&src_addr, socklen);
            }
            if (ok) {
                vTaskDelay(pdMS_TO_TICKS(25));
                apply_net_cfg_to_netif();
            }
        } else if (strncasecmp(cmd, "NETCFG STATIC ", 14) == 0) {
            char ip[20] = {0}, mask[20] = {0}, gw[20] = "0.0.0.0";
            int parts = sscanf(cmd + 14, "%19s %19s %19s", ip, mask, gw);
            bool ok = (parts >= 2) && validate_and_store_net_cfg(true, ip, mask, gw);
            int ack_n = snprintf(
                tx_buf,
                sizeof(tx_buf),
                "{\"ok\":%s,\"mode\":\"static\",\"ip\":\"%s\",\"netmask\":\"%s\",\"gateway\":\"%s\"}",
                ok ? "true" : "false",
                ip,
                mask,
                gw
            );
            if (ack_n > 0) {
                sendto(sock, tx_buf, (size_t)ack_n, 0, (struct sockaddr *)&src_addr, socklen);
            }
            if (ok) {
                vTaskDelay(pdMS_TO_TICKS(25));
                apply_net_cfg_to_netif();
            }
        } else if (strcasecmp(cmd, "RESET_COUNTERS") == 0) {
            xSemaphoreTake(g_state_mu, portMAX_DELAY);
            g_state.usb_rx_bytes = 0;
            g_state.usb_tx_bytes = 0;
            xSemaphoreGive(g_state_mu);
            int ack_n = snprintf(tx_buf, sizeof(tx_buf), "{\"ok\":true}");
            if (ack_n > 0) {
                sendto(sock, tx_buf, (size_t)ack_n, 0, (struct sockaddr *)&src_addr, socklen);
            }
        } else if (strcasecmp(cmd, "REBOOT") == 0) {
            int ack_n = snprintf(tx_buf, sizeof(tx_buf), "{\"ok\":true,\"cmd\":\"REBOOT\"}");
            if (ack_n > 0) {
                sendto(sock, tx_buf, (size_t)ack_n, 0, (struct sockaddr *)&src_addr, socklen);
            }
            vTaskDelay(pdMS_TO_TICKS(80));
            esp_restart();
        }
    }
}

static void sync_tcp_clients_state(void)
{
    int count = 0;
    char peers[96] = {0};
    size_t pos = 0;

    xSemaphoreTake(g_clients_mu, portMAX_DELAY);
    for (int i = 0; i < MAX_TCP_CLIENTS; i++) {
        if (g_tcp_clients[i].fd >= 0) {
            count++;
            int w = snprintf(peers + pos, sizeof(peers) - pos, "%s%s", pos > 0 ? ", " : "", g_tcp_clients[i].peer_ip);
            if (w > 0) {
                size_t adv = (size_t)w;
                pos = (pos + adv < sizeof(peers)) ? (pos + adv) : (sizeof(peers) - 1);
            }
        }
    }
    g_tcp_client_count = count;
    xSemaphoreGive(g_clients_mu);

    xSemaphoreTake(g_state_mu, portMAX_DELAY);
    g_state.tcp_connected = (count > 0);
    g_state.tcp_clients = count;
    snprintf(g_state.tcp_peer, sizeof(g_state.tcp_peer), "%s", peers);
    xSemaphoreGive(g_state_mu);
}

static void tcp_tx_pump_task(void *arg)
{
    (void)arg;
    uint8_t chunk[1460];
    int fds[MAX_TCP_CLIENTS];

    while (true) {
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(20));
        while (true) {
            if (g_tcp_client_count <= 0) {
                ring_clear();
                break;
            }
            size_t n = ring_pop_bytes(chunk, sizeof(chunk));
            if (n == 0) {
                break;
            }

            xSemaphoreTake(g_clients_mu, portMAX_DELAY);
            for (int i = 0; i < MAX_TCP_CLIENTS; i++) {
                fds[i] = g_tcp_clients[i].fd;
            }
            xSemaphoreGive(g_clients_mu);

            for (int i = 0; i < MAX_TCP_CLIENTS; i++) {
                int fd = fds[i];
                if (fd < 0) {
                    continue;
                }
                size_t sent_total = 0;
                int retries = 0;
                while (sent_total < n) {
                    ssize_t w = send(fd, chunk + sent_total, n - sent_total, 0);
                    if (w < 0) {
                        if (errno == EINTR) {
                            continue;
                        }
                        if ((errno == EAGAIN || errno == EWOULDBLOCK) && retries < 2) {
                            retries++;
                            vTaskDelay(pdMS_TO_TICKS(1));
                            continue;
                        }
                        /* Stall or disconnect: shut down socket so tcp_server_task reclaims the slot */
                        shutdown(fd, SHUT_RDWR);
                        break;
                    }
                    if (w == 0) {
                        shutdown(fd, SHUT_RDWR);
                        break;
                    }
                    sent_total += (size_t)w;
                }
            }
        }
    }
}

static void configure_client_socket(int fd)
{
    int nodelay = 1;
    int keepalive = 1;
    int keepidle = 3;
    int keepintvl = 1;
    int keepcnt = 2;
    struct timeval snd_tv = {.tv_sec = 0, .tv_usec = 120000};
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &nodelay, sizeof(nodelay));
    setsockopt(fd, SOL_SOCKET, SO_KEEPALIVE, &keepalive, sizeof(keepalive));
    setsockopt(fd, IPPROTO_TCP, TCP_KEEPIDLE, &keepidle, sizeof(keepidle));
    setsockopt(fd, IPPROTO_TCP, TCP_KEEPINTVL, &keepintvl, sizeof(keepintvl));
    setsockopt(fd, IPPROTO_TCP, TCP_KEEPCNT, &keepcnt, sizeof(keepcnt));
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &snd_tv, sizeof(snd_tv));
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
        .sin_port = htons(BRIDGE_TCP_PORT),
        .sin_addr.s_addr = htonl(INADDR_ANY),
    };
    if (bind(listen_fd, (struct sockaddr *)&bind_addr, sizeof(bind_addr)) < 0 || listen(listen_fd, MAX_TCP_CLIENTS + 2) < 0) {
        ESP_LOGE(TAG, "TCP bind/listen(:%d) failed: errno=%d", BRIDGE_TCP_PORT, errno);
        close(listen_fd);
        vTaskDelete(NULL);
        return;
    }

    ESP_LOGI(TAG, "Raw TCP serial server listening on :%d (max %d concurrent clients)", BRIDGE_TCP_PORT, MAX_TCP_CLIENTS);

    uint8_t rx_buf[1024];
    while (true) {
        fd_set rfds;
        FD_ZERO(&rfds);
        FD_SET(listen_fd, &rfds);
        int max_fd = listen_fd;

        xSemaphoreTake(g_clients_mu, portMAX_DELAY);
        for (int i = 0; i < MAX_TCP_CLIENTS; i++) {
            int cfd = g_tcp_clients[i].fd;
            if (cfd >= 0) {
                FD_SET(cfd, &rfds);
                if (cfd > max_fd) {
                    max_fd = cfd;
                }
            }
        }
        xSemaphoreGive(g_clients_mu);

        struct timeval tv = {.tv_sec = 1, .tv_usec = 0};
        int sel = select(max_fd + 1, &rfds, NULL, NULL, &tv);
        if (sel < 0) {
            if (errno == EINTR) {
                continue;
            }
            vTaskDelay(pdMS_TO_TICKS(20));
            continue;
        }
        if (sel == 0) {
            continue;
        }

        if (FD_ISSET(listen_fd, &rfds)) {
            struct sockaddr_in next_addr;
            socklen_t nlen = sizeof(next_addr);
            int nfd = accept(listen_fd, (struct sockaddr *)&next_addr, &nlen);
            if (nfd >= 0) {
                char peer_ip[16] = {0};
                inet_ntoa_r(next_addr.sin_addr, peer_ip, sizeof(peer_ip) - 1);

                /* First reap any active slot whose peer already closed before rejecting a new connection */
                xSemaphoreTake(g_clients_mu, portMAX_DELAY);
                for (int i = 0; i < MAX_TCP_CLIENTS; i++) {
                    int efd = g_tcp_clients[i].fd;
                    if (efd >= 0) {
                        uint8_t peek_b = 0;
                        ssize_t pr = recv(efd, &peek_b, 1, MSG_PEEK | MSG_DONTWAIT);
                        if (pr == 0 || (pr < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR)) {
                            close(efd);
                            g_tcp_clients[i].fd = -1;
                            g_tcp_clients[i].peer_ip[0] = '\0';
                            if (g_tcp_client_count > 0) {
                                g_tcp_client_count--;
                            }
                        }
                    }
                }

                int chosen_slot = -1;
                int prev_count = g_tcp_client_count;
                char busy_owner[16] = {0};
                for (int i = 0; i < MAX_TCP_CLIENTS; i++) {
                    if (g_tcp_clients[i].fd < 0) {
                        chosen_slot = i;
                        break;
                    }
                    if (busy_owner[0] == '\0') {
                        snprintf(busy_owner, sizeof(busy_owner), "%s", g_tcp_clients[i].peer_ip);
                    }
                }
                if (chosen_slot >= 0) {
                    configure_client_socket(nfd);
                    if (prev_count == 0) {
                        ring_clear();
                    }
                    g_tcp_clients[chosen_slot].fd = nfd;
                    snprintf(g_tcp_clients[chosen_slot].peer_ip, sizeof(g_tcp_clients[chosen_slot].peer_ip), "%s", peer_ip);
                    g_tcp_client_count = prev_count + 1;
                }
                xSemaphoreGive(g_clients_mu);

                if (chosen_slot < 0) {
                    /* Send a brief BUSY notice on the rejected socket and close it without touching the active owner */
                    char busy_msg[128];
                    int bn = snprintf(
                        busy_msg,
                        sizeof(busy_msg),
                        "@{\"t\":\"err\",\"code\":\"BUSY\",\"peer\":\"%s\"}\n",
                        busy_owner[0] ? busy_owner : "another client"
                    );
                    if (bn > 0) {
                        struct timeval btv = {.tv_sec = 0, .tv_usec = 40000};
                        setsockopt(nfd, SOL_SOCKET, SO_SNDTIMEO, &btv, sizeof(btv));
                        send(nfd, busy_msg, (size_t)bn, 0);
                    }
                    ESP_LOGW(TAG, "Rejected TCP client %s: serial port already in use by %s", peer_ip, busy_owner);
                    close(nfd);
                } else {
                    sync_tcp_clients_state();
                    ESP_LOGI(TAG, "TCP client connected from %s", peer_ip);
                }
            }
        }

        for (int i = 0; i < MAX_TCP_CLIENTS; i++) {
            int cfd = -1;
            char peer_ip[16] = {0};
            xSemaphoreTake(g_clients_mu, portMAX_DELAY);
            cfd = g_tcp_clients[i].fd;
            if (cfd >= 0) {
                snprintf(peer_ip, sizeof(peer_ip), "%s", g_tcp_clients[i].peer_ip);
            }
            xSemaphoreGive(g_clients_mu);

            if (cfd < 0 || !FD_ISSET(cfd, &rfds)) {
                continue;
            }

            ssize_t n = recv(cfd, rx_buf, sizeof(rx_buf), 0);
            if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)) {
                continue;
            }
            if (n <= 0) {
                xSemaphoreTake(g_clients_mu, portMAX_DELAY);
                g_tcp_clients[i].fd = -1;
                g_tcp_clients[i].peer_ip[0] = '\0';
                xSemaphoreGive(g_clients_mu);

                close(cfd);
                sync_tcp_clients_state();
                if (g_tcp_client_count <= 0) {
                    ring_clear();
                }
                ESP_LOGI(TAG, "TCP client disconnected (%s), active=%d/%d", peer_ip, g_tcp_client_count, MAX_TCP_CLIENTS);
                continue;
            }

            /* Pure transparent passthrough: write every TCP byte verbatim to USB TX */
            cdc_send_bytes_raw(rx_buf, (size_t)n);
        }
    }
}

/* ---- UART0 USB-C Local Management Console (`STATUS?`, `BAUD <n>`, `NETCFG`) ---------------- */

static void uart0_console_task(void *arg)
{
    (void)arg;
    uart_driver_install(UART_NUM_0, 1024, 0, 0, NULL, 0);

    uint8_t ch = 0;
    char line[256];
    size_t len = 0;
    char reply[640];

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
            const char *cmd = line;
            while (*cmd == ' ' || *cmd == '\t') {
                cmd++;
            }
            if (*cmd != '\0') {
                if (strcasecmp(cmd, "STATUS?") == 0 || strcasecmp(cmd, "BRIDGE?") == 0 || strcasecmp(cmd, "NETCFG?") == 0) {
                    format_bridge_json(reply, sizeof(reply), true);
                    uart_write_bytes(UART_NUM_0, reply, strlen(reply));
                } else if (strncasecmp(cmd, "BAUD ", 5) == 0) {
                    uint32_t b = (uint32_t)strtoul(cmd + 5, NULL, 10);
                    bool ok = save_and_apply_baud(b);
                    int n = snprintf(reply, sizeof(reply), "@{\"t\":\"baud\",\"ok\":%s,\"baud\":%" PRIu32 "}\n", ok ? "true" : "false", b);
                    if (n > 0) {
                        uart_write_bytes(UART_NUM_0, reply, (size_t)n);
                    }
                } else if (strcasecmp(cmd, "NETCFG DHCP") == 0) {
                    bool ok = save_and_apply_net_cfg(false, "", "", "");
                    int n = snprintf(reply, sizeof(reply), "@{\"t\":\"netcfg\",\"ok\":%s,\"mode\":\"dhcp\"}\n", ok ? "true" : "false");
                    if (n > 0) {
                        uart_write_bytes(UART_NUM_0, reply, (size_t)n);
                    }
                } else if (strncasecmp(cmd, "NETCFG STATIC ", 14) == 0) {
                    char ip[20] = {0}, mask[20] = {0}, gw[20] = "0.0.0.0";
                    int parts = sscanf(cmd + 14, "%19s %19s %19s", ip, mask, gw);
                    bool ok = (parts >= 2) && save_and_apply_net_cfg(true, ip, mask, gw);
                    int n = snprintf(
                        reply,
                        sizeof(reply),
                        "@{\"t\":\"netcfg\",\"ok\":%s,\"mode\":\"static\",\"ip\":\"%s\",\"netmask\":\"%s\",\"gateway\":\"%s\"}\n",
                        ok ? "true" : "false",
                        ip,
                        mask,
                        gw
                    );
                    if (n > 0) {
                        uart_write_bytes(UART_NUM_0, reply, (size_t)n);
                    }
                } else if (strcasecmp(cmd, "RESET_COUNTERS") == 0) {
                    xSemaphoreTake(g_state_mu, portMAX_DELAY);
                    g_state.usb_rx_bytes = 0;
                    g_state.usb_tx_bytes = 0;
                    xSemaphoreGive(g_state_mu);
                    const char *ack = "@{\"t\":\"counters\",\"ok\":true}\n";
                    uart_write_bytes(UART_NUM_0, ack, strlen(ack));
                } else if (strcasecmp(cmd, "REBOOT") == 0) {
                    const char *ack = "@{\"t\":\"ack\",\"cmd\":\"REBOOT\"}\n";
                    uart_write_bytes(UART_NUM_0, ack, strlen(ack));
                    vTaskDelay(pdMS_TO_TICKS(50));
                    esp_restart();
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
    g_clients_mu = xSemaphoreCreateMutex();
    g_usb_disc_sem = xSemaphoreCreateBinary();
    for (int i = 0; i < MAX_TCP_CLIENTS; i++) {
        g_tcp_clients[i].fd = -1;
        g_tcp_clients[i].peer_ip[0] = '\0';
    }
    memset(&g_state, 0, sizeof(g_state));
    g_state.usb_baud = DEFAULT_USB_BAUD;
    g_state.usb_dtr = true;
    g_state.usb_rts = false;

    /* 2. Initialize NVS & load optional static IP / baud configuration */
    esp_err_t nvs_err = nvs_flash_init();
    if (nvs_err == ESP_ERR_NVS_NO_FREE_PAGES || nvs_err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        nvs_err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(nvs_err);
    load_bridge_cfg();
    g_state.usb_baud = g_cfg.baud_rate;

    /* 3. Bring up 100 Mbps RMII Ethernet (`IP101GRI`) */
    init_ethernet();

    /* 4. Install USB 2.0 Host + generic CDC-ACM / USB-Serial-JTAG driver on Type-A Host port */
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
        .new_dev_cb = usb_new_dev_cb,
    };
    ESP_ERROR_CHECK(cdc_acm_host_install(&cdc_drv_cfg));

    /* 5. Launch raw TCP <-> USB pump, out-of-band UDP discovery, and local UART0 console */
    xTaskCreate(tcp_tx_pump_task, "tcp_tx", 4096, NULL, 18, &g_tcp_tx_task);
    xTaskCreate(usb_cdc_supervisor_task, "usb_sup", 6144, NULL, 15, NULL);
    xTaskCreate(udp_discovery_task, "udp_disc", 4096, NULL, 12, NULL);
    xTaskCreate(tcp_server_task, "tcp_srv", 6144, NULL, 14, NULL);
    xTaskCreate(uart0_console_task, "uart0_con", 4096, NULL, 8, NULL);

    ESP_LOGI(TAG, "Generic USB-Serial <-> TCP Bridge v%s started on :%d", BRIDGE_FW_VERSION, BRIDGE_TCP_PORT);
}
