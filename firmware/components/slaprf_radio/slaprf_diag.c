/**
 * slaprf_diag — USB debug console for the web app's Debug page (WebSerial).
 *
 * Line-based commands on the native USB port (USB-Serial-JTAG), one per line:
 *   SLAPRF?        raw 160-byte SLAPRF02 config block (binary; used by the flasher)
 *   STATUS?        @{"t":"status",...}  firmware, identity, uptime, reset reason, heap, sweeps,
 *                  5.8 GHz boot check, link channel / slot, channel table
 *   LIVE 1|0       stream @{"t":"live","us":..,"dbm":[8],"pk":[8]} about 10x a second
 *   SCAN a b s     spectrum scan a..b MHz in s MHz steps (peak of 4 captures per point);
 *                  replies @{"t":"scan","start":a,"step":s,"dbm":[...]} from the main loop
 *   LOG 1|0        mirror ESP-IDF log lines onto the USB port (plain text)
 *   REBOOT         restart
 * Every reply line except SLAPRF? and log text starts with '@'.
 */
#include "slaprf_radio.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "driver/usb_serial_jtag.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#define CFG_LEN          160
#define CFG_OFF_VERSION  8
#define CFG_OFF_ROLE     11
#define CFG_OFF_PROFILE  12
#define CFG_OFF_FP       14
#define CFG_OFF_FREQS    18
#define CFG_OFF_LABEL    107
#define SCAN_MAX_POINTS  200

static const volatile uint8_t *s_cfg;
static size_t s_cfg_len;
static uint8_t s_sweep_hz = 50;
static SemaphoreHandle_t s_tx_lock;

static volatile bool s_live;
static volatile bool s_log;
static vprintf_like_t s_prev_vprintf;
static volatile uint8_t s_slot;

static volatile uint32_t s_sweeps;
static volatile uint32_t s_sweep_us_last;
static volatile uint32_t s_sweep_us_max;
static int8_t s_peak[8];

static volatile bool s_scan_pending;
static uint16_t s_scan_start, s_scan_stop, s_scan_step;

/* ---- Output ------------------------------------------------------------------------------- */

static void tx_raw(const void *data, size_t len) {
    if (s_tx_lock == NULL || xSemaphoreTake(s_tx_lock, pdMS_TO_TICKS(50)) != pdTRUE) {
        return;
    }
    usb_serial_jtag_write_bytes(data, len, pdMS_TO_TICKS(20));
    xSemaphoreGive(s_tx_lock);
}

static void tx_line(const char *s) {
    tx_raw(s, strlen(s));
}

static int log_vprintf(const char *fmt, va_list args) {
    va_list copy;
    va_copy(copy, args);
    int n = s_prev_vprintf ? s_prev_vprintf(fmt, args) : vprintf(fmt, args); // keep UART logging
    if (s_log) {
        char buf[256];
        int m = vsnprintf(buf, sizeof(buf), fmt, copy);
        if (m > 0) {
            tx_raw(buf, (size_t)(m < (int)sizeof(buf) ? m : (int)sizeof(buf) - 1));
        }
    }
    va_end(copy);
    return n;
}

/* ---- Commands ----------------------------------------------------------------------------- */

static const char *reset_reason_name(esp_reset_reason_t r) {
    switch (r) {
    case ESP_RST_POWERON: return "power-on";
    case ESP_RST_EXT: return "external";
    case ESP_RST_SW: return "software";
    case ESP_RST_PANIC: return "panic";
    case ESP_RST_INT_WDT: return "interrupt-watchdog";
    case ESP_RST_TASK_WDT: return "task-watchdog";
    case ESP_RST_WDT: return "watchdog";
    case ESP_RST_DEEPSLEEP: return "deep-sleep";
    case ESP_RST_BROWNOUT: return "brownout";
    case ESP_RST_USB: return "usb";
    case ESP_RST_JTAG: return "jtag";
    default: return "unknown";
    }
}

static uint16_t cfg_u16(size_t off) {
    return (uint16_t)(s_cfg[off] | (s_cfg[off + 1] << 8));
}

static void send_status(void) {
    char label[25] = {0};
    for (int i = 0; i < 24 && s_cfg[CFG_OFF_LABEL + i]; i++) {
        char c = (char)s_cfg[CFG_OFF_LABEL + i];
        label[i] = (c == '"' || c == '\\' || c < 0x20) ? '?' : c;
    }
    const uint32_t fp = (uint32_t)s_cfg[CFG_OFF_FP] | ((uint32_t)s_cfg[CFG_OFF_FP + 1] << 8) |
                        ((uint32_t)s_cfg[CFG_OFF_FP + 2] << 16) | ((uint32_t)s_cfg[CFG_OFF_FP + 3] << 24);
    uint8_t channel = 0;
    wifi_second_chan_t second;
    esp_wifi_get_channel(&channel, &second);
    bool rf_ok = false;
    int gain = 0, gain_max = 0;
    float floor_db = 0;
    slaprf_rf58_info(&rf_ok, &gain, &gain_max, &floor_db);

    char out[640];
    int n = snprintf(out, sizeof(out),
                     "@{\"t\":\"status\",\"fw\":\"v%u.%u.%u\",\"role\":%u,\"profile\":%u,\"fp\":\"%08lX\","
                     "\"label\":\"%s\",\"uptimeMs\":%lld,\"reset\":\"%s\",\"heapFree\":%lu,\"heapMin\":%lu,"
                     "\"sweepHz\":%u,\"sweeps\":%lu,\"sweepUs\":%lu,\"sweepUsMax\":%lu,"
                     "\"rf\":{\"ok\":%s,\"gain\":%d,\"gainMax\":%d,\"floorDb\":%.1f},"
                     "\"channel\":%u,\"slot\":%u,\"freqs\":[",
                     s_cfg[CFG_OFF_VERSION], s_cfg[CFG_OFF_VERSION + 1], s_cfg[CFG_OFF_VERSION + 2],
                     s_cfg[CFG_OFF_ROLE], s_cfg[CFG_OFF_PROFILE], (unsigned long)fp, label,
                     (long long)(esp_timer_get_time() / 1000), reset_reason_name(esp_reset_reason()),
                     (unsigned long)esp_get_free_heap_size(), (unsigned long)esp_get_minimum_free_heap_size(),
                     s_sweep_hz, (unsigned long)s_sweeps, (unsigned long)s_sweep_us_last,
                     (unsigned long)s_sweep_us_max, rf_ok ? "true" : "false", gain, gain_max, floor_db, channel,
                     s_slot);
    for (int i = 0; i < 8 && n < (int)sizeof(out) - 16; i++) {
        n += snprintf(out + n, sizeof(out) - n, "%s%u", i ? "," : "", cfg_u16(CFG_OFF_FREQS + i * 2));
    }
    snprintf(out + n, sizeof(out) - n, "]}\n");
    tx_line(out);
}

static void handle_command(char *line) {
    if (strcmp(line, "SLAPRF?") == 0) {
        uint8_t copy[CFG_LEN];
        size_t len = s_cfg_len < sizeof(copy) ? s_cfg_len : sizeof(copy);
        memcpy(copy, (const void *)s_cfg, len);
        tx_raw(copy, len);
    } else if (strcmp(line, "STATUS?") == 0) {
        send_status();
    } else if (strncmp(line, "LIVE ", 5) == 0) {
        s_live = line[5] == '1';
        tx_line(s_live ? "@{\"t\":\"ok\",\"cmd\":\"live\",\"on\":true}\n" : "@{\"t\":\"ok\",\"cmd\":\"live\",\"on\":false}\n");
    } else if (strncmp(line, "LOG ", 4) == 0) {
        s_log = line[4] == '1';
        tx_line(s_log ? "@{\"t\":\"ok\",\"cmd\":\"log\",\"on\":true}\n" : "@{\"t\":\"ok\",\"cmd\":\"log\",\"on\":false}\n");
    } else if (strncmp(line, "SCAN", 4) == 0) {
        unsigned a = 5180, b = 5917, s = 5;
        sscanf(line + 4, "%u %u %u", &a, &b, &s);
        if (a < 5180) a = 5180;
        if (b > 5917) b = 5917;
        if (s < 1) s = 1;
        if (b < a || (b - a) / s + 1 > SCAN_MAX_POINTS) {
            tx_line("@{\"t\":\"err\",\"msg\":\"scan range too large (max 200 points, 5180-5917 MHz)\"}\n");
            return;
        }
        s_scan_start = (uint16_t)a;
        s_scan_stop = (uint16_t)b;
        s_scan_step = (uint16_t)s;
        s_scan_pending = true;
    } else if (strcmp(line, "REBOOT") == 0) {
        tx_line("@{\"t\":\"ok\",\"cmd\":\"reboot\"}\n");
        vTaskDelay(pdMS_TO_TICKS(50));
        esp_restart();
    } else if (line[0]) {
        tx_line("@{\"t\":\"err\",\"msg\":\"unknown command\"}\n");
    }
}

static void console_task(void *arg) {
    (void)arg;
    char line[64];
    size_t len = 0;
    uint8_t ch;
    for (;;) {
        if (usb_serial_jtag_read_bytes(&ch, 1, portMAX_DELAY) != 1) {
            continue;
        }
        if (ch == '\r') {
            continue;
        }
        if (ch == '\n') {
            line[len] = 0;
            handle_command(line);
            len = 0;
        } else if (len < sizeof(line) - 1) {
            line[len++] = (char)ch;
        }
    }
}

/* ---- Public API --------------------------------------------------------------------------- */

void slaprf_diag_start(const volatile void *cfg, size_t len, uint8_t sweep_hz) {
    s_cfg = (const volatile uint8_t *)cfg;
    s_cfg_len = len;
    s_sweep_hz = sweep_hz ? sweep_hz : 50;
    s_tx_lock = xSemaphoreCreateMutex();
    memset(s_peak, -127, sizeof(s_peak));
    usb_serial_jtag_driver_config_t usb_cfg = {
        .tx_buffer_size = 1024,
        .rx_buffer_size = 256,
    };
    if (usb_serial_jtag_driver_install(&usb_cfg) == ESP_OK) {
        s_prev_vprintf = esp_log_set_vprintf(log_vprintf);
        xTaskCreate(console_task, "slaprf_diag", 4096, NULL, 3, NULL);
    }
}

void slaprf_start_config_query_service(const volatile void *cfg, size_t len) {
    slaprf_diag_start(cfg, len, 50);
}

void slaprf_diag_set_slot(uint8_t slot) {
    s_slot = slot;
}

void slaprf_diag_sweep(const int8_t *dbm, uint32_t took_us) {
    s_sweeps++;
    s_sweep_us_last = took_us;
    if (took_us > s_sweep_us_max) s_sweep_us_max = took_us;
    for (int i = 0; i < 8; i++) {
        if (dbm[i] > s_peak[i]) s_peak[i] = dbm[i];
    }
    const uint32_t every = s_sweep_hz >= 10 ? s_sweep_hz / 10 : 1;
    if (!s_live || s_sweeps % every != 0) {
        return;
    }
    char out[160];
    snprintf(out, sizeof(out),
             "@{\"t\":\"live\",\"us\":%lu,\"dbm\":[%d,%d,%d,%d,%d,%d,%d,%d],\"pk\":[%d,%d,%d,%d,%d,%d,%d,%d]}\n",
             (unsigned long)took_us, dbm[0], dbm[1], dbm[2], dbm[3], dbm[4], dbm[5], dbm[6], dbm[7], s_peak[0],
             s_peak[1], s_peak[2], s_peak[3], s_peak[4], s_peak[5], s_peak[6], s_peak[7]);
    for (int i = 0; i < 8; i++) s_peak[i] = -127;
    tx_line(out);
}

void slaprf_diag_service(void) {
    if (!s_scan_pending) {
        return;
    }
    s_scan_pending = false;
    static int8_t points[SCAN_MAX_POINTS];
    int count = 0;
    slaprf_rf58_enter();
    for (unsigned f = s_scan_start; f <= s_scan_stop && count < SCAN_MAX_POINTS; f += s_scan_step) {
        int8_t best = -127;
        for (int k = 0; k < 4; k++) {
            int8_t v = esp_sdr_measure_5g_channel_dbm((uint16_t)f);
            if (v > best) best = v;
        }
        points[count++] = best;
    }
    slaprf_rf58_leave();

    static char out[48 + SCAN_MAX_POINTS * 5];
    int n = snprintf(out, sizeof(out), "@{\"t\":\"scan\",\"start\":%u,\"step\":%u,\"dbm\":[", s_scan_start, s_scan_step);
    for (int i = 0; i < count; i++) {
        n += snprintf(out + n, sizeof(out) - n, "%s%d", i ? "," : "", points[i]);
    }
    snprintf(out + n, sizeof(out) - n, "]}\n");
    tx_line(out);
}
