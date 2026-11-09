/**
 * slaprf_diag — USB debug console for the web app's Debug page (WebSerial).
 *
 * Line-based commands on the native USB port (USB-Serial-JTAG), one per line:
 *   SLAPRF?          raw 160-byte SLAPRF02 config block (binary; used by the flasher)
 *   STATUS?          @{"t":"status",...}  identity, chip, uptime, reset reason, boot count, heap,
 *                    sweeps, 5.8 GHz boot check, receiver on/off, 2.4 GHz network, channel table
 *   LIVE 1|0         stream @{"t":"live","us","dbm":[8],"pk":[8],"hits":[8]} about 10x a second
 *   SCAN a b s       spectrum scan a..b MHz in s MHz steps (peak of 4 captures per point);
 *                    replies @{"t":"scan","start","step","dbm":[...]} from the main loop
 *   SCAN LIVE a b s  continuous scan: each sweep slot measures the next chunk of a..b instead of
 *                    the pilot channels (lap timing pauses, Wi-Fi unaffected); streams
 *                    @{"t":"scan","live":true,"passMs",...} per completed pass. SCAN STOP ends it.
 *   LOG 1|0          mirror ESP-IDF log lines onto the USB port (plain text)
 *   BOOTLOG?         @{"t":"bootlog","which":"current",...,"text":"..."}  log since this boot
 *   LASTLOG?         @{"t":"bootlog","which":"last",...}  log of the previous boot, kept across
 *                    software resets, crashes and watchdog resets (not across power-off)
 *   CHANNELS a,..,h  temporary channel table (8 x 5180-5917 MHz) until reboot; CHANNELS RESET
 *   RF 1|0           5.8 GHz receiver on/off (off: sweeps skip the radio, readings -127)
 *   REBOOT           restart
 * Every reply line except SLAPRF? and mirrored log text starts with '@'.
 */
#include "slaprf_radio.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "driver/usb_serial_jtag.h"
#include "esp_attr.h"
#include "esp_chip_info.h"
#include "esp_flash.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_mac.h"
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
#define LOG_RING_BYTES   3072
#define LOG_RING_MAGIC   0x534C4F47U // "SLOG"
#define RF_MIN_MHZ       5180
#define RF_MAX_MHZ       5917

static const volatile uint8_t *s_cfg;
static size_t s_cfg_len;
static uint8_t s_sweep_hz = 50;
static uint32_t s_sweep_budget_us;
static SemaphoreHandle_t s_tx_lock;

static volatile bool s_live;
static volatile bool s_log;
static volatile bool s_rf_enabled = true;
static vprintf_like_t s_prev_vprintf;
static volatile uint8_t s_slot;

static volatile uint32_t s_sweeps;
static volatile uint32_t s_sweep_us_last;
static volatile uint32_t s_sweep_us_max;
static int8_t s_peak[8];
static int16_t s_floor_q4[8]; // Slow-tracking noise floor per channel, dBm * 16
static uint8_t s_hits[8];     // Sweeps > floor + 6 dB since the last LIVE line

static volatile bool s_chan_override;
static uint16_t s_chan_mhz[8];

static volatile bool s_scan_pending;
static uint16_t s_scan_start, s_scan_stop, s_scan_step;

/* Continuous scan ("SCAN LIVE"): replaces the pilot channels in each sweep slot, so the band is
 * swept a chunk per superframe while the 2.4 GHz link keeps its time. Lap timing pauses. */
static volatile bool s_scan_live;
static uint16_t s_ls_start, s_ls_step, s_ls_count, s_ls_idx;
static int8_t s_ls_points[SCAN_MAX_POINTS];
static int8_t s_ls_out[SCAN_MAX_POINTS];
static volatile bool s_ls_ready;
static uint32_t s_ls_point_us = 800; // Measured cost of one point (PLL hop + capture)
static int64_t s_ls_pass_t0;
static uint32_t s_ls_pass_ms;

/* ---- Boot log ring (RTC memory: survives software resets, panics and watchdogs) ------------ */

typedef struct {
    uint32_t magic;
    uint32_t head;
    uint32_t len;
    uint32_t boots;
    char data[LOG_RING_BYTES];
} log_ring_t;

static RTC_NOINIT_ATTR log_ring_t s_ring;
static char s_last_log[LOG_RING_BYTES]; // Previous boot's log, copied out at startup
static size_t s_last_len;
static uint32_t s_boots;
static portMUX_TYPE s_ring_mux = portMUX_INITIALIZER_UNLOCKED;

static void ring_copy_out(char *dst, size_t *out_len) {
    const size_t len = s_ring.len;
    const size_t start = (s_ring.head + LOG_RING_BYTES - len) % LOG_RING_BYTES;
    for (size_t i = 0; i < len; i++) {
        dst[i] = s_ring.data[(start + i) % LOG_RING_BYTES];
    }
    *out_len = len;
}

static void ring_append(const char *s, size_t n) {
    portENTER_CRITICAL_SAFE(&s_ring_mux);
    for (size_t i = 0; i < n; i++) {
        s_ring.data[s_ring.head] = s[i];
        s_ring.head = (s_ring.head + 1) % LOG_RING_BYTES;
        if (s_ring.len < LOG_RING_BYTES) s_ring.len++;
    }
    portEXIT_CRITICAL_SAFE(&s_ring_mux);
}

/* ---- Output ------------------------------------------------------------------------------- */

static void tx_raw(const void *data, size_t len) {
    if (s_tx_lock == NULL || xSemaphoreTake(s_tx_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return;
    }
    // The driver's TX ring buffer rejects any single write larger than itself, so large replies
    // (boot logs, scans) go out in chunks, each with time for the host to drain the buffer.
    const uint8_t *p = (const uint8_t *)data;
    while (len > 0) {
        const size_t chunk = len > 512 ? 512 : len;
        if (usb_serial_jtag_write_bytes(p, chunk, pdMS_TO_TICKS(100)) <= 0) {
            break; // Host not reading (port closed): drop the rest
        }
        p += chunk;
        len -= chunk;
    }
    xSemaphoreGive(s_tx_lock);
}

static void tx_line(const char *s) {
    tx_raw(s, strlen(s));
}

static int log_vprintf(const char *fmt, va_list args) {
    char buf[256];
    va_list copy;
    va_copy(copy, args);
    int m = vsnprintf(buf, sizeof(buf), fmt, copy);
    va_end(copy);
    if (m > 0) {
        const size_t n = (size_t)(m < (int)sizeof(buf) ? m : (int)sizeof(buf) - 1);
        ring_append(buf, n);
        if (s_log) {
            tx_raw(buf, n);
        }
    }
    return s_prev_vprintf ? s_prev_vprintf(fmt, args) : vprintf(fmt, args); // UART keeps logging
}

/** Runs before app_main(): start recording the log as early as the app can. */
__attribute__((constructor)) static void diag_early_init(void) {
    if (s_ring.magic == LOG_RING_MAGIC && s_ring.len <= LOG_RING_BYTES && s_ring.head < LOG_RING_BYTES) {
        ring_copy_out(s_last_log, &s_last_len);
        s_boots = s_ring.boots + 1;
    } else {
        s_last_len = 0;
        s_boots = 1; // Power-on (RTC memory was not retained)
    }
    s_ring.magic = LOG_RING_MAGIC;
    s_ring.head = 0;
    s_ring.len = 0;
    s_ring.boots = s_boots;
    s_prev_vprintf = esp_log_set_vprintf(log_vprintf);
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

uint16_t slaprf_diag_channel_mhz(int index, uint16_t configured) {
    return (s_chan_override && index >= 0 && index < 8) ? s_chan_mhz[index] : configured;
}

bool slaprf_diag_rf_enabled(void) {
    return s_rf_enabled;
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
    wifi_mode_t mode = WIFI_MODE_NULL;
    esp_wifi_get_mode(&mode);
    wifi_sta_list_t stas = {0};
    if (mode == WIFI_MODE_AP || mode == WIFI_MODE_APSTA) {
        esp_wifi_ap_get_sta_list(&stas);
    }
    const char *mode_name = mode == WIFI_MODE_APSTA ? "ap+sta" : mode == WIFI_MODE_AP ? "ap" : mode == WIFI_MODE_STA ? "sta" : "off";

    bool rf_ok = false;
    int gain = 0, gain_max = 0;
    float floor_db = 0;
    slaprf_rf58_info(&rf_ok, &gain, &gain_max, &floor_db);

    esp_chip_info_t chip;
    esp_chip_info(&chip);
    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    uint32_t flash_bytes = 0;
    // Physical (JEDEC-detected) size; esp_flash_get_size() reports the size the image was built for.
    if (esp_flash_get_physical_size(NULL, &flash_bytes) != ESP_OK) {
        esp_flash_get_size(NULL, &flash_bytes);
    }

    char out[900];
    int n = snprintf(out, sizeof(out),
                     "@{\"t\":\"status\",\"fw\":\"v%u.%u.%u\",\"role\":%u,\"profile\":%u,\"fp\":\"%08lX\","
                     "\"label\":\"%s\",\"uptimeMs\":%lld,\"reset\":\"%s\",\"boots\":%lu,\"heapFree\":%lu,\"heapMin\":%lu,"
                     "\"sweepHz\":%u,\"sweeps\":%lu,\"sweepUs\":%lu,\"sweepUsMax\":%lu,\"sweepBudgetUs\":%lu,"
                     "\"rf\":{\"ok\":%s,\"enabled\":%s,\"gain\":%d,\"gainMax\":%d,\"floorDb\":%.1f},"
                     "\"chip\":{\"model\":\"%s\",\"rev\":\"v%d.%d\",\"mac\":\"%02X:%02X:%02X:%02X:%02X:%02X\",\"flashMB\":%lu},"
                     "\"net\":{\"mode\":\"%s\",\"stations\":%d},"
                     "\"channel\":%u,\"slot\":%u,\"scanLive\":%s,\"freqsTemporary\":%s,\"freqs\":[",
                     s_cfg[CFG_OFF_VERSION], s_cfg[CFG_OFF_VERSION + 1], s_cfg[CFG_OFF_VERSION + 2],
                     s_cfg[CFG_OFF_ROLE], s_cfg[CFG_OFF_PROFILE], (unsigned long)fp, label,
                     (long long)(esp_timer_get_time() / 1000), reset_reason_name(esp_reset_reason()),
                     (unsigned long)s_boots, (unsigned long)esp_get_free_heap_size(),
                     (unsigned long)esp_get_minimum_free_heap_size(), s_sweep_hz, (unsigned long)s_sweeps,
                     (unsigned long)s_sweep_us_last, (unsigned long)s_sweep_us_max, (unsigned long)s_sweep_budget_us,
                     rf_ok ? "true" : "false",
                     s_rf_enabled ? "true" : "false", gain, gain_max, floor_db,
                     chip.model == CHIP_ESP32C5 ? "ESP32-C5" : "ESP32", chip.revision / 100, chip.revision % 100,
                     mac[0], mac[1], mac[2], mac[3], mac[4], mac[5], (unsigned long)(flash_bytes / (1024 * 1024)),
                     mode_name, stas.num, channel, s_slot, s_scan_live ? "true" : "false",
                     s_chan_override ? "true" : "false");
    for (int i = 0; i < 8 && n < (int)sizeof(out) - 16; i++) {
        n += snprintf(out + n, sizeof(out) - n, "%s%u", i ? "," : "",
                      slaprf_diag_channel_mhz(i, cfg_u16(CFG_OFF_FREQS + i * 2)));
    }
    snprintf(out + n, sizeof(out) - n, "]}\n");
    tx_line(out);
}

/** Send a log buffer as one JSON line (escaped). */
static void send_log(const char *which, const char *text, size_t len) {
    static char out[64 + LOG_RING_BYTES * 2 + 96];
    int n = snprintf(out, sizeof(out), "@{\"t\":\"bootlog\",\"which\":\"%s\",\"boots\":%lu,\"reset\":\"%s\",\"text\":\"",
                     which, (unsigned long)s_boots, reset_reason_name(esp_reset_reason()));
    for (size_t i = 0; i < len && n < (int)sizeof(out) - 8; i++) {
        const char c = text[i];
        if (c == '"' || c == '\\') {
            out[n++] = '\\';
            out[n++] = c;
        } else if (c == '\n') {
            out[n++] = '\\';
            out[n++] = 'n';
        } else if ((unsigned char)c < 0x20 || (unsigned char)c > 0x7E) {
            // Drop ANSI colour escapes and other control / non-ASCII bytes
        } else {
            out[n++] = c;
        }
    }
    n += snprintf(out + n, sizeof(out) - n, "\"}\n");
    tx_raw(out, (size_t)n);
}

static void handle_channels(const char *args) {
    while (*args == ' ') args++;
    if (strncmp(args, "RESET", 5) == 0) {
        s_chan_override = false;
        tx_line("@{\"t\":\"ok\",\"cmd\":\"channels\",\"temporary\":false}\n");
        return;
    }
    uint16_t f[8];
    int count = 0;
    const char *p = args;
    while (*p && count < 8) {
        char *end;
        long v = strtol(p, &end, 10);
        if (end == p) break;
        if (v < RF_MIN_MHZ || v > RF_MAX_MHZ) {
            tx_line("@{\"t\":\"err\",\"msg\":\"channels must be 5180-5917 MHz\"}\n");
            return;
        }
        f[count++] = (uint16_t)v;
        p = end;
        while (*p == ',' || *p == ' ') p++;
    }
    if (count != 8) {
        tx_line("@{\"t\":\"err\",\"msg\":\"CHANNELS needs 8 frequencies, e.g. CHANNELS 5658,5695,5732,5769,5806,5843,5880,5917\"}\n");
        return;
    }
    memcpy(s_chan_mhz, f, sizeof(f));
    s_chan_override = true;
    tx_line("@{\"t\":\"ok\",\"cmd\":\"channels\",\"temporary\":true}\n");
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
        if (s_live) memset(s_hits, 0, sizeof(s_hits)); // Don't report hits counted while paused
        tx_line(s_live ? "@{\"t\":\"ok\",\"cmd\":\"live\",\"on\":true}\n" : "@{\"t\":\"ok\",\"cmd\":\"live\",\"on\":false}\n");
    } else if (strncmp(line, "LOG ", 4) == 0) {
        s_log = line[4] == '1';
        tx_line(s_log ? "@{\"t\":\"ok\",\"cmd\":\"log\",\"on\":true}\n" : "@{\"t\":\"ok\",\"cmd\":\"log\",\"on\":false}\n");
    } else if (strcmp(line, "BOOTLOG?") == 0) {
        static char cur[LOG_RING_BYTES];
        size_t len = 0;
        portENTER_CRITICAL(&s_ring_mux);
        ring_copy_out(cur, &len);
        portEXIT_CRITICAL(&s_ring_mux);
        send_log("current", cur, len);
    } else if (strcmp(line, "LASTLOG?") == 0) {
        send_log("last", s_last_log, s_last_len);
    } else if (strncmp(line, "CHANNELS", 8) == 0) {
        handle_channels(line + 8);
    } else if (strncmp(line, "RF ", 3) == 0) {
        s_rf_enabled = line[3] == '1';
        tx_line(s_rf_enabled ? "@{\"t\":\"ok\",\"cmd\":\"rf\",\"on\":true}\n" : "@{\"t\":\"ok\",\"cmd\":\"rf\",\"on\":false}\n");
    } else if (strncmp(line, "SCAN STOP", 9) == 0) {
        s_scan_live = false;
        tx_line("@{\"t\":\"ok\",\"cmd\":\"scan\",\"live\":false}\n");
    } else if (strncmp(line, "SCAN", 4) == 0) {
        const bool live = strncmp(line + 4, " LIVE", 5) == 0;
        unsigned a = RF_MIN_MHZ, b = RF_MAX_MHZ, s = 5;
        sscanf(line + (live ? 9 : 4), "%u %u %u", &a, &b, &s);
        if (a < RF_MIN_MHZ) a = RF_MIN_MHZ;
        if (b > RF_MAX_MHZ) b = RF_MAX_MHZ;
        if (s < 1) s = 1;
        if (b < a || (b - a) / s + 1 > SCAN_MAX_POINTS) {
            tx_line("@{\"t\":\"err\",\"msg\":\"scan range too large (max 200 points, 5180-5917 MHz)\"}\n");
            return;
        }
        if (!s_rf_enabled) {
            tx_line("@{\"t\":\"err\",\"msg\":\"5.8 GHz receiver is off (RF 1 to enable)\"}\n");
            return;
        }
        if (live) {
            s_scan_live = false; // Sweep task sees a consistent setup when it flips back on
            s_ls_start = (uint16_t)a;
            s_ls_step = (uint16_t)s;
            s_ls_count = (uint16_t)((b - a) / s + 1);
            s_ls_idx = 0;
            s_ls_ready = false;
            s_ls_pass_t0 = esp_timer_get_time();
            s_scan_live = true;
            tx_line("@{\"t\":\"ok\",\"cmd\":\"scan\",\"live\":true}\n");
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
    char line[96];
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
    for (int i = 0; i < 8; i++) s_floor_q4[i] = -95 * 16;
    usb_serial_jtag_driver_config_t usb_cfg = {
        .tx_buffer_size = 2048,
        .rx_buffer_size = 256,
    };
    if (usb_serial_jtag_driver_install(&usb_cfg) == ESP_OK) {
        xTaskCreate(console_task, "slaprf_diag", 4096, NULL, 3, NULL);
    }
}

void slaprf_start_config_query_service(const volatile void *cfg, size_t len) {
    slaprf_diag_start(cfg, len, 50);
}

void slaprf_diag_set_sweep_budget(uint32_t budget_us) {
    s_sweep_budget_us = budget_us;
}

void slaprf_diag_set_slot(uint8_t slot) {
    s_slot = slot;
}

void slaprf_diag_sweep(const int8_t *dbm, uint32_t took_us) {
    s_sweeps++;
    s_sweep_us_last = took_us;
    if (took_us > s_sweep_us_max) s_sweep_us_max = took_us;
    for (int i = 0; i < 8; i++) {
        if (dbm[i] <= -127) continue; // Receiver off or slot used by a live scan: no reading
        const int16_t v = (int16_t)(dbm[i] * 16);
        if (dbm[i] > s_peak[i]) s_peak[i] = dbm[i];
        // Floor: follow drops at once, rises very slowly (a VTX parked on the channel won't lift it fast).
        if (v < s_floor_q4[i]) s_floor_q4[i] = v;
        else s_floor_q4[i] += (v - s_floor_q4[i]) / 256;
        if (v > s_floor_q4[i] + 6 * 16 && s_hits[i] < 255) s_hits[i]++;
    }
    const uint32_t every = s_sweep_hz >= 10 ? s_sweep_hz / 10 : 1;
    if (!s_live || s_sweeps % every != 0) {
        return;
    }
    char out[200];
    snprintf(out, sizeof(out),
             "@{\"t\":\"live\",\"us\":%lu,\"dbm\":[%d,%d,%d,%d,%d,%d,%d,%d],\"pk\":[%d,%d,%d,%d,%d,%d,%d,%d],"
             "\"hits\":[%u,%u,%u,%u,%u,%u,%u,%u]}\n",
             (unsigned long)took_us, dbm[0], dbm[1], dbm[2], dbm[3], dbm[4], dbm[5], dbm[6], dbm[7], s_peak[0],
             s_peak[1], s_peak[2], s_peak[3], s_peak[4], s_peak[5], s_peak[6], s_peak[7], s_hits[0], s_hits[1],
             s_hits[2], s_hits[3], s_hits[4], s_hits[5], s_hits[6], s_hits[7]);
    for (int i = 0; i < 8; i++) {
        s_peak[i] = -127;
        s_hits[i] = 0;
    }
    tx_line(out);
}

void slaprf_diag_service(void) {
    if (s_ls_ready) {
        // A live-scan pass finished in the last sweep slot; send it from here (outside the slot).
        static char live_out[96 + SCAN_MAX_POINTS * 5];
        const uint16_t count = s_ls_count;
        int n = snprintf(live_out, sizeof(live_out),
                         "@{\"t\":\"scan\",\"live\":true,\"passMs\":%lu,\"start\":%u,\"step\":%u,\"dbm\":[",
                         (unsigned long)s_ls_pass_ms, s_ls_start, s_ls_step);
        for (int i = 0; i < count; i++) {
            n += snprintf(live_out + n, sizeof(live_out) - n, "%s%d", i ? "," : "", s_ls_out[i]);
        }
        snprintf(live_out + n, sizeof(live_out) - n, "]}\n");
        s_ls_ready = false;
        tx_line(live_out);
    }
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

bool slaprf_diag_scan_live_step(uint32_t budget_us) {
    if (!s_scan_live || !s_rf_enabled || s_ls_count == 0) {
        return false;
    }
    const int64_t t0 = esp_timer_get_time();
    const int64_t margin = 300; // Leave room for leave() and slot overhead
    slaprf_rf58_enter();
    while (esp_timer_get_time() - t0 + (int64_t)s_ls_point_us + margin < (int64_t)budget_us) {
        const int64_t tp = esp_timer_get_time();
        s_ls_points[s_ls_idx] = esp_sdr_measure_5g_channel_dbm((uint16_t)(s_ls_start + s_ls_idx * s_ls_step));
        const uint32_t took = (uint32_t)(esp_timer_get_time() - tp);
        s_ls_point_us = (s_ls_point_us * 7 + took) / 8; // Track the real per-point cost
        if (++s_ls_idx >= s_ls_count) {
            const int64_t now = esp_timer_get_time();
            memcpy(s_ls_out, s_ls_points, s_ls_count);
            s_ls_pass_ms = (uint32_t)((now - s_ls_pass_t0) / 1000);
            s_ls_pass_t0 = now;
            s_ls_idx = 0;
            s_ls_ready = true;
            break; // Send this pass before starting the next
        }
    }
    slaprf_rf58_leave();
    return true;
}