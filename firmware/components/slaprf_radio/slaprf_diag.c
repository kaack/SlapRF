/**
 * slaprf_diag — USB debug console for the web app's Debug page (WebSerial).
 *
 * Line-based commands on the native USB port (USB-Serial-JTAG), one per line:
 *   SLAPRF?          raw 160-byte SLAPRF02 config block (binary; used by the flasher)
 *   STATUS?          @{"t":"status",...}  identity, chip, uptime, reset reason, boot count, heap,
 *                    sweeps, 5.8 GHz boot check, receiver on/off, 2.4 GHz network, channel table
 *   LIVE 1|2|0       stream @{"t":"live","n","us","dbm":[8],"pk":[8],"hits":[8],"floor":[8]}:
 *                    1 = about 10x a second (pk = peak since the previous line), 2 = every sweep.
 *                    n = sweep counter (gaps = dropped lines), floor = typical noise per channel,
 *                    hits = readings > floor + 10 dB since the previous line
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
 *   EMERGENCY 1|0    enter/exit emergency rescue mode (radio & sweeps off, ambulance-siren LED fade)
 *   REBOOT           restart
 * Every reply line except SLAPRF? and mirrored log text starts with '@'.
 */
#include "slaprf_radio.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "driver/gpio.h"
#include "driver/ledc.h"
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
#define CFG_OFF_FP       14
#define CFG_OFF_FREQS    18
#define CFG_OFF_LABEL    107
#define SCAN_MAX_POINTS  200
#define LOG_RING_BYTES   3072
#define LOG_RING_MAGIC   0x534C4F48U // "SLOH" (v2 with crash_streak)
#define EMERGENCY_MAGIC  0x454D5247U // "EMRG" (explicit EMERGENCY command request)
#define MAX_CRASH_STREAK 3           // Halt in USB emergency rescue mode after 3 consecutive panics/watchdogs
#define RF_MIN_MHZ       5180
#define RF_MAX_MHZ       5917
#define HIT_MARGIN_DB    10 // A "hit" is a reading this far above the channel's typical noise
#define FLOOR_UNSET      INT16_MIN
#define XIAO_C5_LED_GPIO 27 // Seeed Studio XIAO ESP32-C5 yellow user LED (active-low: 0 = ON, 1 = OFF)

static const volatile uint8_t *s_cfg;
static size_t s_cfg_len;
static uint8_t s_sweep_hz = 50;
static uint32_t s_sweep_budget_us;
static uint32_t s_flash_bytes;
static SemaphoreHandle_t s_tx_lock;

static volatile uint8_t s_live; // 0 off, 1 ~10 lines/s with peaks, 2 every sweep
// A USB host (the browser) is listening: set by any command, cleared when writes keep failing.
// While set, status_push_task sends a status line every second so the host never has to poll.
static volatile bool s_host_attached;
static volatile bool s_log;
static volatile bool s_hub_usb_stream;
static uint8_t s_usb_hellos[7][36];
static volatile bool s_rf_enabled = true;
static volatile bool s_reboot_pending;
static volatile int64_t s_last_cmd_us;
static uint8_t s_tx_drops;
static vprintf_like_t s_prev_vprintf;
static volatile uint8_t s_slot;

/* ---- Identify (find-my-timer LED strobe), toggled from the app ----------------------------
 * Own board (USB `IDENTIFY <own fp> 1|0`): strobes until switched off.
 * Spoke over the air: the Hub re-sends IDENTIFY every ~200 ms while it is on, and the Spoke
 * strobes while refreshes keep arriving (IDENTIFY_HOLD_US), so a lost "off" frame or a Hub that
 * goes away can never leave a Spoke strobing forever. */
#define IDENTIFY_HOLD_US       1500000LL
#define IDENTIFY_REFRESH_SF    10 // Superframes between Hub refreshes (10 x 20 ms = 200 ms)
#define IDENTIFY_OFF_REPEATS   5  // Explicit "off" frames sent when switched off
static volatile bool s_identify_local;
static volatile int64_t s_identify_until_us;
static volatile uint32_t s_identify_target_fp; // Hub: Spoke being identified (0 = none)
static volatile uint32_t s_identify_off_fp;
static volatile uint8_t s_identify_off_repeats;
static uint8_t s_identify_tick;

typedef struct {
    uint32_t fp;
    char label[25];
    int64_t last_rx_us;
    uint32_t frames;
    uint8_t last_seq;
    uint16_t batt_mv;
    int8_t floor_dbm;
    int8_t dbm[8];
    bool has_dbm;
} diag_spoke_peer_t;

static diag_spoke_peer_t s_peer_spokes[6]; // index 0..5 = TDMA slot 2..7

static volatile uint32_t s_sweeps;
static volatile uint32_t s_sweep_us_last;
static volatile uint32_t s_sweep_us_max;
static int8_t s_last_dbm[8];
static volatile bool s_has_dbm;
static int8_t s_peak[8];
static int16_t s_floor_q4[8]; // Slow-tracking noise floor per channel, dBm * 16
static uint8_t s_hits[8];     // Sweeps > floor + HIT_MARGIN_DB since the last LIVE line

static volatile bool s_chan_override;
static uint16_t s_chan_mhz[8];
static volatile uint8_t s_chan_mask = 0xFF;

static volatile bool s_net_chan_valid;
static uint16_t s_net_chan_mhz[8];
static uint16_t s_net_raw_freqs[8];
static volatile uint8_t s_net_chan_mask = 0xFF;

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
    uint32_t crash_streak;
    char data[LOG_RING_BYTES];
} log_ring_t;

static RTC_NOINIT_ATTR log_ring_t s_ring;

/* ---- Panic capture (RTC memory) ----------------------------------------------------------------
 * The panic handler prints its backtrace to UART0, which the laptop can't see. We wrap
 * esp_panic_handler (linker --wrap, see CMakeLists.txt) to stash the faulting PC, return address
 * and cause in RTC memory; the next boot reports it via PANIC? so it can be mapped with addr2line.
 */
#include "esp_private/panic_internal.h"
#include "riscv/rvruntime-frames.h"
#define PANIC_REC_MAGIC 0x50414E43U // "PANC"
typedef struct {
    uint32_t magic;
    uint32_t boot;   // Boot number that crashed
    uint32_t exc;    // panic_exception_t
    uint32_t pc;     // info->addr (faulting instruction)
    uint32_t mepc;
    uint32_t ra;
    uint32_t sp;
    uint32_t mcause;
    uint32_t mtval;
} panic_rec_t;
static RTC_NOINIT_ATTR panic_rec_t s_panic_rec;
static uint32_t s_boots;
void __real_esp_panic_handler(panic_info_t *info);
void IRAM_ATTR __wrap_esp_panic_handler(panic_info_t *info) {
    if (info != NULL) {
        s_panic_rec.boot = s_boots;
        s_panic_rec.exc = (uint32_t)info->exception;
        s_panic_rec.pc = (uint32_t)info->addr;
        const RvExcFrame *fr = (const RvExcFrame *)info->frame;
        if (fr != NULL) {
            s_panic_rec.mepc = fr->mepc;
            s_panic_rec.ra = fr->ra;
            s_panic_rec.sp = fr->sp;
            s_panic_rec.mcause = fr->mcause;
            s_panic_rec.mtval = fr->mtval;
        }
        s_panic_rec.magic = PANIC_REC_MAGIC;
    }
    __real_esp_panic_handler(info);
}
static char s_last_log[LOG_RING_BYTES]; // Previous boot's log, copied out at startup
static size_t s_last_len;
static uint32_t s_crash_streak;
static volatile bool s_emergency_mode;
static bool s_booted_emergency_mode;
static bool s_ledc_initialized;
static TaskHandle_t s_siren_task;
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
    if (s_tx_lock == NULL || xSemaphoreTake(s_tx_lock, pdMS_TO_TICKS(150)) != pdTRUE) {
        return;
    }
    // Small 128-byte chunks ensure control replies (STATUS?, SLAPRF?) never stall waiting for a
    // 512-byte contiguous slot in the FreeRTOS byte ringbuffer while LIVE is active.
    const uint8_t *p = (const uint8_t *)data;
    while (len > 0) {
        const size_t chunk = len > 128 ? 128 : len;
        if (usb_serial_jtag_write_bytes(p, chunk, pdMS_TO_TICKS(120)) <= 0) {
            // Host not reading (port closed or browser refreshed): stop all background streams
            // immediately so the TX ringbuffer stops filling and the main loop never stalls.
            s_live = 0;
            s_scan_live = false;
            s_log = false;
            s_tx_drops = 0;
            break;
        }
        p += chunk;
        len -= chunk;
    }
    xSemaphoreGive(s_tx_lock);
}

static void tx_line(const char *s) {
    tx_raw(s, strlen(s));
}

/** Best-effort write for streamed data: drops the line if the port is busy or the buffer full. */
static void tx_bytes_nowait(const void *data, size_t len) {
    // Wait up to 2 ms: if the low-priority console task holds the lock mid-reply, the mutex's
    // priority inheritance lets it finish quickly instead of this streamed frame being dropped.
    if (s_tx_lock == NULL || xSemaphoreTake(s_tx_lock, pdMS_TO_TICKS(2)) != pdTRUE) {
        return;
    }
    const int written = usb_serial_jtag_write_bytes(data, len, 0);
    if (written < (int)len) {
        // If the USB host closed the port or refreshed the browser tab, stop streaming after a few
        // consecutive drops so the TX ring buffer stays clear for the next STATUS? on reconnect.
        if (++s_tx_drops >= 4) {
            s_live = 0;
            s_scan_live = false;
            s_log = false;
            s_hub_usb_stream = false;
            s_host_attached = false;
            s_tx_drops = 0;
        }
    } else {
        s_tx_drops = 0;
    }
    xSemaphoreGive(s_tx_lock);
}

static void tx_line_nowait(const char *s) {
    tx_bytes_nowait(s, strlen(s));
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
            buf[n] = 0;
            tx_line_nowait(buf);
        }
    }
    return s_prev_vprintf ? s_prev_vprintf(fmt, args) : vprintf(fmt, args); // UART keeps logging
}

static bool is_crash_reset(esp_reset_reason_t r) {
    return r == ESP_RST_PANIC || r == ESP_RST_INT_WDT || r == ESP_RST_TASK_WDT || r == ESP_RST_WDT;
}

/** Runs before app_main(): start recording the log as early as the app can. */
__attribute__((constructor)) static void diag_early_init(void) {
    const esp_reset_reason_t reason = esp_reset_reason();
    if (s_ring.magic == LOG_RING_MAGIC && s_ring.len <= LOG_RING_BYTES && s_ring.head < LOG_RING_BYTES) {
        ring_copy_out(s_last_log, &s_last_len);
        s_boots = s_ring.boots + 1;
        if (s_ring.crash_streak == EMERGENCY_MAGIC) {
            s_crash_streak = MAX_CRASH_STREAK;
        } else if (is_crash_reset(reason)) {
            s_crash_streak = s_ring.crash_streak + 1;
        } else if (s_ring.crash_streak >= MAX_CRASH_STREAK && (reason == ESP_RST_USB || reason == ESP_RST_JTAG)) {
            // Keep Emergency Mode latched across USB serial port open/close resets until explicit exit or power-cycle
            s_crash_streak = s_ring.crash_streak;
        } else {
            s_crash_streak = 0;
        }
    } else {
        s_last_len = 0;
        s_boots = 1; // Power-on (RTC memory was not retained)
        s_crash_streak = 0;
    }
    s_ring.magic = LOG_RING_MAGIC;
    s_ring.head = 0;
    s_ring.len = 0;
    s_ring.boots = s_boots;
    s_ring.crash_streak = s_crash_streak;
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

static uint16_t slot_display_mhz(int index) {
    if (index < 0 || index >= 8) {
        return 0;
    }
    if (s_chan_override && s_chan_mhz[index] >= RF_MIN_MHZ) {
        return s_chan_mhz[index];
    }
    if (s_net_chan_valid && s_net_chan_mhz[index] >= RF_MIN_MHZ) {
        return s_net_chan_mhz[index];
    }
    return s_cfg ? cfg_u16(CFG_OFF_FREQS + (size_t)index * 2) : 0;
}

static uint8_t active_chan_mask(void) {
    return s_chan_override ? s_chan_mask : s_net_chan_valid ? s_net_chan_mask : s_chan_mask;
}

uint16_t slaprf_diag_channel_mhz(int index, uint16_t configured) {
    if (index < 0 || index >= 8) {
        return 0;
    }
    const uint8_t mask = active_chan_mask();
    if (((mask >> index) & 1U) == 0) {
        return 0; // Slot disabled: skip 5.8 GHz capture on this slot
    }
    if (s_chan_override && s_chan_mhz[index] >= RF_MIN_MHZ) {
        return s_chan_mhz[index];
    }
    if (s_net_chan_valid && s_net_chan_mhz[index] >= RF_MIN_MHZ) {
        return s_net_chan_mhz[index];
    }
    return configured;
}

void slaprf_diag_set_net_channels(const uint16_t freqs[8]) {
    if (freqs == NULL) {
        return;
    }
    if (s_net_chan_valid && memcmp(s_net_raw_freqs, freqs, sizeof(s_net_raw_freqs)) == 0) {
        return;
    }
    memcpy(s_net_raw_freqs, freqs, sizeof(s_net_raw_freqs));
    uint8_t mask = 0;
    for (int i = 0; i < 8; i++) {
        if (freqs[i] >= RF_MIN_MHZ && freqs[i] <= RF_MAX_MHZ) {
            mask |= (uint8_t)(1U << i);
            if (!s_chan_override && s_net_chan_mhz[i] != freqs[i]) {
                s_floor_q4[i] = FLOOR_UNSET;
                s_peak[i] = -127;
                s_hits[i] = 0;
            }
            s_net_chan_mhz[i] = freqs[i];
        } else {
            if (s_net_chan_mhz[i] < RF_MIN_MHZ && s_cfg != NULL) {
                s_net_chan_mhz[i] = cfg_u16(CFG_OFF_FREQS + (size_t)i * 2);
            }
            if (!s_chan_override) {
                s_peak[i] = -127;
                s_hits[i] = 0;
            }
        }
    }
    s_net_chan_mask = mask;
    s_net_chan_valid = true;
}

bool slaprf_diag_get_net_channels(uint16_t out_freqs[8]) {
    if (!s_net_chan_valid || out_freqs == NULL) {
        return false;
    }
    memcpy(out_freqs, s_net_raw_freqs, sizeof(s_net_raw_freqs));
    return true;
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

    // Wi-Fi channel/mode are cached and refreshed at most every 5 s: querying the Wi-Fi driver on
    // every status line measurably cost the timing loop beacons.
    static uint8_t channel = 0;
    static wifi_mode_t mode = WIFI_MODE_NULL;
    static int64_t wifi_queried_us = 0;
    wifi_sta_list_t stas = {0};
    if (!s_emergency_mode && (wifi_queried_us == 0 || esp_timer_get_time() - wifi_queried_us > 5000000LL)) {
        wifi_second_chan_t second;
        esp_wifi_get_channel(&channel, &second);
        esp_wifi_get_mode(&mode);
        wifi_queried_us = esp_timer_get_time();
    }
    const char *mode_name = s_emergency_mode ? "emergency-mode" : mode == WIFI_MODE_APSTA ? "ap+sta" : mode == WIFI_MODE_AP ? "ap" : mode == WIFI_MODE_STA ? "sta" : "off";

    bool rf_ok = false;
    int gain = 0, gain_max = 0;
    float floor_db = 0;
    slaprf_rf58_info(&rf_ok, &gain, &gain_max, &floor_db);

    esp_chip_info_t chip;
    esp_chip_info(&chip);
    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_WIFI_STA);

    int8_t lk_rssi = 0;
    uint8_t lk_rate = 0, lk_fmt = 0;
    uint32_t lk_beacons = 0, lk_data = 0;
    const char *lk_tx = "";
    slaprf_link_stats(&lk_rssi, &lk_rate, &lk_fmt, &lk_beacons, &lk_data, &lk_tx);
    int8_t lk_qdbm = 0;
    bool lk_saved = false;
    slaprf_link_settings(&lk_qdbm, &lk_saved);
    char (*out_buf)[2048] = malloc(sizeof(*out_buf));
    if (!out_buf) return;
    #define out (*out_buf)
    int n = snprintf(out, sizeof(out),
                     "@{\"t\":\"status\",\"fw\":\"v%u.%u.%u\",\"role\":%u,\"fp\":\"%08lX\","
                     "\"label\":\"%s\",\"uptimeMs\":%lld,\"reset\":\"%s\",\"boots\":%lu,"
                     "\"emergencyMode\":%s,\"crashStreak\":%lu,\"heapFree\":%lu,\"heapMin\":%lu,"
                     "\"sweepHz\":%u,\"sweeps\":%lu,\"sweepUs\":%lu,\"sweepUsMax\":%lu,\"sweepBudgetUs\":%lu,"
                     "\"rf\":{\"ok\":%s,\"enabled\":%s,\"gain\":%d,\"gainMax\":%d,\"floorDb\":%.1f},"
                     "\"chip\":{\"model\":\"%s\",\"rev\":\"v%d.%d\",\"mac\":\"%02X:%02X:%02X:%02X:%02X:%02X\",\"flashMB\":%lu},"
                     "\"net\":{\"mode\":\"%s\",\"stations\":%d},\"link\":{\"rssi\":%d,\"rate\":%u,\"fmt\":%u,\"beacons\":%lu,\"data\":%lu,\"tx\":\"%s\",\"txPowerDbm\":%.2f,\"saved\":%s},"
                     "\"channel\":%u,\"slot\":%u,\"scanLive\":%s,\"freqsTemporary\":%s,\"chanMask\":%u,\"freqs\":[",
                     s_cfg[CFG_OFF_VERSION], s_cfg[CFG_OFF_VERSION + 1], s_cfg[CFG_OFF_VERSION + 2],
                     s_cfg[CFG_OFF_ROLE], (unsigned long)fp, label,
                     (long long)(esp_timer_get_time() / 1000), reset_reason_name(esp_reset_reason()),
                     (unsigned long)s_boots, s_emergency_mode ? "true" : "false", (unsigned long)s_crash_streak,
                     (unsigned long)esp_get_free_heap_size(),
                     (unsigned long)esp_get_minimum_free_heap_size(), s_sweep_hz, (unsigned long)s_sweeps,
                     (unsigned long)s_sweep_us_last, (unsigned long)s_sweep_us_max, (unsigned long)s_sweep_budget_us,
                     rf_ok ? "true" : "false",
                     s_rf_enabled ? "true" : "false", gain, gain_max, floor_db,
                     chip.model == CHIP_ESP32C5 ? "ESP32-C5" : "ESP32", chip.revision / 100, chip.revision % 100,
                     mac[0], mac[1], mac[2], mac[3], mac[4], mac[5], (unsigned long)(s_flash_bytes / (1024 * 1024)),
                     mode_name, stas.num, (int)lk_rssi, (unsigned)lk_rate, (unsigned)lk_fmt, (unsigned long)lk_beacons,
                     (unsigned long)lk_data, lk_tx, lk_qdbm / 4.0, lk_saved ? "true" : "false", channel, s_slot, s_scan_live ? "true" : "false",
                     s_chan_override ? "true" : "false", (unsigned)active_chan_mask());
    for (int i = 0; i < 8 && n < (int)sizeof(out) - 64; i++) {
        n += snprintf(out + n, sizeof(out) - n, "%s%u", i ? "," : "", slot_display_mhz(i));
    }
    n += snprintf(out + n, sizeof(out) - n, "]");
    if (s_has_dbm && n < (int)sizeof(out) - 96) {
        n += snprintf(out + n, sizeof(out) - n,
                      ",\"dbm\":[%d,%d,%d,%d,%d,%d,%d,%d]",
                      s_last_dbm[0], s_last_dbm[1], s_last_dbm[2], s_last_dbm[3],
                      s_last_dbm[4], s_last_dbm[5], s_last_dbm[6], s_last_dbm[7]);
    }
    if (s_cfg[CFG_OFF_ROLE] == 1) {
        n += snprintf(out + n, sizeof(out) - n, ",\"spokes\":[");
        bool first_sp = true;
        for (int i = 0; i < 6 && n < (int)sizeof(out) - 180; i++) {
            const diag_spoke_peer_t *sp = &s_peer_spokes[i];
            if (sp->fp == 0 && sp->frames == 0) continue;
            const int64_t last_rx_us = sp->last_rx_us;
            const int64_t diff_us = esp_timer_get_time() - last_rx_us;
            const uint32_t ms_ago = (last_rx_us > 0 && diff_us > 0)
                                        ? (uint32_t)(diff_us / 1000)
                                        : 0;
            n += snprintf(out + n, sizeof(out) - n,
                          "%s{\"slot\":%d,\"fp\":\"%08lX\",\"label\":\"%s\",\"msAgo\":%lu,\"frames\":%lu,\"seq\":%u",
                          first_sp ? "" : ",", i + 2, (unsigned long)sp->fp, sp->label,
                          (unsigned long)ms_ago,
                          (unsigned long)sp->frames, (unsigned)sp->last_seq);
            if (sp->has_dbm) {
                n += snprintf(out + n, sizeof(out) - n,
                              ",\"dbm\":[%d,%d,%d,%d,%d,%d,%d,%d]",
                              sp->dbm[0], sp->dbm[1], sp->dbm[2], sp->dbm[3],
                              sp->dbm[4], sp->dbm[5], sp->dbm[6], sp->dbm[7]);
            }
            n += snprintf(out + n, sizeof(out) - n, "}");
            first_sp = false;
        }
        n += snprintf(out + n, sizeof(out) - n, "]");
    } else {
        const uint32_t b_ms = slaprf_ms_since_hub_beacon();
        uint8_t hub_mac[6] = {0};
        if (b_ms != UINT32_MAX) {
            n += snprintf(out + n, sizeof(out) - n, ",\"beaconMsAgo\":%lu", (unsigned long)b_ms);
            if (slaprf_hub_beacon_mac(hub_mac)) {
                n += snprintf(out + n, sizeof(out) - n,
                              ",\"hub\":{\"linked\":%s,\"mac\":\"%02X:%02X:%02X:%02X:%02X:%02X\",\"beaconMsAgo\":%lu}",
                              (s_slot >= 2 && b_ms < 5000) ? "true" : "false",
                              hub_mac[0], hub_mac[1], hub_mac[2], hub_mac[3], hub_mac[4], hub_mac[5],
                              (unsigned long)b_ms);
            }
        }
    }
    const bool identifying = s_identify_local || esp_timer_get_time() < s_identify_until_us;
    n += snprintf(out + n, sizeof(out) - n, ",\"identify\":%s", identifying ? "true" : "false");
    if (s_identify_target_fp != 0) {
        n += snprintf(out + n, sizeof(out) - n, ",\"identifyFp\":\"%08lX\"", (unsigned long)s_identify_target_fp);
    }
    snprintf(out + n, sizeof(out) - n, "}\n");
    tx_line(out);
    #undef out
    free(out_buf);
}

static uint32_t own_fingerprint(void) {
    return (uint32_t)s_cfg[CFG_OFF_FP] | ((uint32_t)s_cfg[CFG_OFF_FP + 1] << 8) |
           ((uint32_t)s_cfg[CFG_OFF_FP + 2] << 16) | ((uint32_t)s_cfg[CFG_OFF_FP + 3] << 24);
}

/** `IDENTIFY <fp hex> 1|0`: strobe this board's LED, or (Hub) relay to the Spoke with that fp. */
static void handle_identify(const char *args) {
    while (*args == ' ') args++;
    char *end;
    const unsigned long fp = strtoul(args, &end, 16);
    while (*end == ' ') end++;
    if (end == args || fp == 0 || (*end != '0' && *end != '1')) {
        tx_line("@{\"t\":\"err\",\"msg\":\"IDENTIFY needs <fingerprint hex> 1|0\"}\n");
        return;
    }
    const bool on = *end == '1';
    if ((uint32_t)fp == own_fingerprint()) {
        s_identify_local = on;
    } else if (s_cfg[CFG_OFF_ROLE] == 1) {
        const uint32_t prev = s_identify_target_fp;
        if (on) {
            if (prev != 0 && prev != (uint32_t)fp) {
                s_identify_off_fp = prev; // Only one Spoke at a time: switch the previous one off
                s_identify_off_repeats = IDENTIFY_OFF_REPEATS;
            }
            s_identify_tick = IDENTIFY_REFRESH_SF; // Send the first refresh right away
            s_identify_target_fp = (uint32_t)fp;
        } else {
            if (prev == (uint32_t)fp) {
                s_identify_target_fp = 0;
            }
            s_identify_off_fp = (uint32_t)fp;
            s_identify_off_repeats = IDENTIFY_OFF_REPEATS;
        }
    } else {
        tx_line("@{\"t\":\"err\",\"msg\":\"IDENTIFY: not this timer (connect the Hub to identify a Spoke)\"}\n");
        return;
    }
    char reply[96];
    snprintf(reply, sizeof(reply), "@{\"t\":\"ok\",\"cmd\":\"identify\",\"fp\":\"%08lX\",\"on\":%s}\n", fp,
             on ? "true" : "false");
    tx_line(reply);
}

void slaprf_diag_identify_rx(bool on) {
    s_identify_until_us = on ? esp_timer_get_time() + IDENTIFY_HOLD_US : 0;
}

bool slaprf_diag_identify_next_frame(uint32_t *fp, bool *on) {
    if (s_identify_off_repeats > 0) {
        s_identify_off_repeats--;
        *fp = s_identify_off_fp;
        *on = false;
        return true;
    }
    const uint32_t target = s_identify_target_fp;
    if (target == 0) {
        return false;
    }
    if (++s_identify_tick < IDENTIFY_REFRESH_SF) {
        return false;
    }
    s_identify_tick = 0;
    *fp = target;
    *on = true;
    return true;
}

/** Send a log buffer as one JSON line (escaped). */
static void send_log(const char *which, const char *text, size_t len) {
    char (*out_buf)[64 + LOG_RING_BYTES * 2 + 96] = malloc(sizeof(*out_buf));
    if (!out_buf) return;
    #define out (*out_buf)
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
    #undef out
    free(out_buf);
}

static void siren_led_task(void *arg) {
    (void)arg;
    uint32_t step = 0;
    for (;;) {
        if (s_emergency_mode) {
            // Ambulance-siren smooth fade: low -> high -> low every 900 ms (60 steps x 15 ms)
            const uint32_t phase = step % 60U;
            const uint32_t tri = phase < 30U ? phase : (60U - phase);
            const uint32_t brightness = 28U + (tri * tri * 995U) / 900U; // Quadratic gamma for linear visual ramp
            const uint32_t duty = 1023U - brightness; // Active-low LED on GPIO27
            ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, duty);
            ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0);
            step++;
            vTaskDelay(pdMS_TO_TICKS(15));
        } else {
            step = 0;
            vTaskDelay(pdMS_TO_TICKS(100));
        }
    }
}

static void set_emergency_mode(bool on) {
    if (on) {
        s_live = 0;
        s_scan_live = false;
        s_rf_enabled = false;
        if (!s_ledc_initialized) {
            ledc_timer_config_t ledc_timer = {
                .speed_mode      = LEDC_LOW_SPEED_MODE,
                .duty_resolution = LEDC_TIMER_10_BIT,
                .timer_num       = LEDC_TIMER_0,
                .freq_hz         = 5000,
                .clk_cfg         = LEDC_AUTO_CLK,
            };
            ledc_timer_config(&ledc_timer);
            s_ledc_initialized = true;
        }
        ledc_channel_config_t ledc_ch = {
            .gpio_num   = XIAO_C5_LED_GPIO,
            .speed_mode = LEDC_LOW_SPEED_MODE,
            .channel    = LEDC_CHANNEL_0,
            .timer_sel  = LEDC_TIMER_0,
            .duty       = 1023,
            .hpoint     = 0,
        };
        ledc_channel_config(&ledc_ch);
        s_emergency_mode = true;
        s_ring.crash_streak = MAX_CRASH_STREAK;
        if (s_siren_task == NULL) {
            xTaskCreate(siren_led_task, "slaprf_siren", 2048, NULL, 2, &s_siren_task);
        }
    } else {
        s_ring.crash_streak = 0;
        s_crash_streak = 0;
        if (s_booted_emergency_mode) {
            s_reboot_pending = true;
            vTaskDelay(pdMS_TO_TICKS(50));
            esp_restart();
        }
        s_emergency_mode = false;
        ledc_stop(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, 1);
        gpio_reset_pin(XIAO_C5_LED_GPIO);
        gpio_config_t led_cfg = {
            .pin_bit_mask = 1ULL << XIAO_C5_LED_GPIO,
            .mode = GPIO_MODE_OUTPUT,
            .pull_up_en = GPIO_PULLUP_DISABLE,
            .pull_down_en = GPIO_PULLDOWN_DISABLE,
            .intr_type = GPIO_INTR_DISABLE,
        };
        gpio_config(&led_cfg);
        gpio_set_level(XIAO_C5_LED_GPIO, 1);
        s_rf_enabled = true;
    }
}

static void handle_channels(const char *args) {
    while (*args == ' ') args++;
    if (strncmp(args, "RESET", 5) == 0) {
        s_chan_override = false;
        s_chan_mask = 0xFF;
        for (int i = 0; i < 8; i++) s_floor_q4[i] = FLOOR_UNSET; // New frequencies: relearn the noise
        char reply[96];
        snprintf(reply, sizeof(reply), "@{\"t\":\"ok\",\"cmd\":\"channels\",\"temporary\":false,\"chanMask\":%u}\n",
                 (unsigned)active_chan_mask());
        tx_line(reply);
        return;
    }
    if (strncmp(args, "MASK", 4) == 0) {
        const char *p = args + 4;
        while (*p == ' ') p++;
        char *end;
        long v = strtol(p, &end, 0);
        if (end == p || v < 0 || v > 255) {
            tx_line("@{\"t\":\"err\",\"msg\":\"CHANNELS MASK needs 0..255 (bit i = 1 enables slot i)\"}\n");
            return;
        }
        if (!s_chan_override) {
            for (int i = 0; i < 8; i++) {
                s_chan_mhz[i] = slot_display_mhz(i);
            }
        }
        s_chan_mask = (uint8_t)v;
        s_chan_override = true;
        for (int i = 0; i < 8; i++) {
            if (((s_chan_mask >> i) & 1U) == 0) {
                s_peak[i] = -127;
                s_hits[i] = 0;
            }
        }
        char reply[96];
        snprintf(reply, sizeof(reply), "@{\"t\":\"ok\",\"cmd\":\"channels\",\"temporary\":true,\"chanMask\":%u}\n",
                 (unsigned)s_chan_mask);
        tx_line(reply);
        return;
    }
    uint16_t f[8];
    uint8_t new_mask = 0;
    int count = 0;
    const char *p = args;
    while (*p && count < 8) {
        char *end;
        long v = strtol(p, &end, 10);
        if (end == p) break;
        if (v == 0) {
            f[count] = slot_display_mhz(count);
            count++;
        } else if (v >= RF_MIN_MHZ && v <= RF_MAX_MHZ) {
            f[count] = (uint16_t)v;
            new_mask |= (uint8_t)(1U << count);
            count++;
        } else {
            tx_line("@{\"t\":\"err\",\"msg\":\"channels must be 5180-5917 MHz (or 0 to disable a slot)\"}\n");
            return;
        }
        p = end;
        while (*p == ',' || *p == ' ') p++;
    }
    if (count != 8) {
        tx_line("@{\"t\":\"err\",\"msg\":\"CHANNELS needs 8 values (5180-5917 MHz or 0), e.g. CHANNELS 5658,0,5732,0,5806,0,0,5917\"}\n");
        return;
    }
    memcpy(s_chan_mhz, f, sizeof(f));
    s_chan_mask = new_mask;
    s_chan_override = true;
    for (int i = 0; i < 8; i++) {
        s_floor_q4[i] = FLOOR_UNSET;
        s_peak[i] = -127;
        s_hits[i] = 0;
    }
    char reply[96];
    snprintf(reply, sizeof(reply), "@{\"t\":\"ok\",\"cmd\":\"channels\",\"temporary\":true,\"chanMask\":%u}\n",
             (unsigned)s_chan_mask);
    tx_line(reply);
}

static void handle_netchannels(const char *args) {
    while (*args == ' ') args++;
    uint16_t f[8] = {0};
    int count = 0;
    const char *p = args;
    while (*p && count < 8) {
        char *end;
        long v = strtol(p, &end, 10);
        if (end == p) break;
        if (v >= RF_MIN_MHZ && v <= RF_MAX_MHZ) {
            f[count++] = (uint16_t)v;
        } else {
            f[count++] = 0;
        }
        p = end;
        while (*p == ',' || *p == ' ') p++;
    }
    if (count != 8) {
        tx_line("@{\"t\":\"err\",\"msg\":\"NETCHANNELS needs 8 values\"}\n");
        return;
    }
    slaprf_diag_set_net_channels(f);
    tx_line("@{\"t\":\"ok\",\"cmd\":\"netchannels\"}\n");
}

/**
 * Streams one Hub frame to the laptop as a compact binary record on the USB serial link:
 *
 *   [0x1E][len][frame bytes...]
 *
 * 0x1E (ASCII Record Separator) never appears in the text/JSON lines, so the host parser can
 * tell records and lines apart; every frame ends with its own XOR crc8, which the host checks to
 * resync if a record is ever cut short. Costs len + 2 bytes instead of ~2.5x as hex-in-JSON.
 */
static void send_usb_pkt_line(const uint8_t *raw, uint32_t len, bool blocking) {
    if (raw == NULL || len == 0 || len > 250) return;
    uint8_t rec[2 + 250];
    rec[0] = 0x1E;
    rec[1] = (uint8_t)len;
    memcpy(rec + 2, raw, len);
    if (blocking) {
        tx_raw(rec, (size_t)len + 2);
    } else {
        tx_bytes_nowait(rec, (size_t)len + 2);
    }
}

void slaprf_diag_forward_hub_frame(const void *frame, uint32_t len) {
    const uint8_t *f = (const uint8_t *)frame;
    if (f == NULL || len < 4 || len > 180) return;
    if (len == 36 && f[0] == 0xC5 && f[1] == 0x5A && f[2] >= 1 && f[2] <= 7) {
        memcpy(s_usb_hellos[f[2] - 1], f, 36);
    }
    // Streams while a host is attached (set by any command, cleared when USB writes start failing).
    if (!s_hub_usb_stream || s_scan_live || s_emergency_mode) return;
    send_usb_pkt_line(f, len, false);
}

static void handle_command(char *line) {
    s_last_cmd_us = esp_timer_get_time();
    s_host_attached = true;
    if (s_cfg && s_cfg[CFG_OFF_ROLE] == 1) {
        s_hub_usb_stream = true;
    }
    if (strcmp(line, "SLAPRF?") == 0) {
        uint8_t copy[CFG_LEN];
        size_t len = s_cfg_len < sizeof(copy) ? s_cfg_len : sizeof(copy);
        memcpy(copy, (const void *)s_cfg, len);
        tx_raw(copy, len);
    } else if (strcmp(line, "STATUS?") == 0) {
        send_status();
        // The host only asks on connect or after pushes went quiet: replay cached HELLOs so it
        // can map every slot to its timer straight away.
        if (s_cfg && s_cfg[CFG_OFF_ROLE] == 1) {
            for (int i = 0; i < 7; i++) {
                if (s_usb_hellos[i][0] == 0xC5 && s_usb_hellos[i][1] == 0x5A) {
                    send_usb_pkt_line(s_usb_hellos[i], 36, false);
                }
            }
        }
    } else if (strncmp(line, "NETCHANNELS", 11) == 0) {
        handle_netchannels(line + 11);
    } else if (strncmp(line, "LIVE ", 5) == 0) {
        s_live = (!s_emergency_mode && line[5] == '2') ? 2 : (!s_emergency_mode && line[5] == '1') ? 1 : 0;
        if (s_live) memset(s_hits, 0, sizeof(s_hits)); // Don't report hits counted while paused
        tx_line(s_live ? "@{\"t\":\"ok\",\"cmd\":\"live\",\"on\":true}\n" : "@{\"t\":\"ok\",\"cmd\":\"live\",\"on\":false}\n");
    } else if (strncmp(line, "LOG ", 4) == 0) {
        s_log = line[4] == '1';
        tx_line(s_log ? "@{\"t\":\"ok\",\"cmd\":\"log\",\"on\":true}\n" : "@{\"t\":\"ok\",\"cmd\":\"log\",\"on\":false}\n");
    } else if (strcmp(line, "BOOTLOG?") == 0) {
        char *cur = (char *)malloc(LOG_RING_BYTES);
        if (cur) {
            size_t len = 0;
            portENTER_CRITICAL(&s_ring_mux);
            ring_copy_out(cur, &len);
            portEXIT_CRITICAL(&s_ring_mux);
            send_log("current", cur, len);
            free(cur);
        }
    } else if (strncmp(line, "LINKRATE ", 9) == 0) {
        // Serial-console tuning (not exposed in the app): ESP-NOW TX PHY, saved to flash.
        if (slaprf_set_link_rate(line + 9, true)) {
            tx_line("@{\"t\":\"ok\",\"cmd\":\"linkrate\",\"saved\":true}\n");
        } else {
            tx_line("@{\"t\":\"err\",\"msg\":\"LINKRATE needs lr250|lr500|1m|6m|mcs0\"}\n");
        }
    } else if (strncmp(line, "TXPOWER ", 8) == 0) {
        // Serial-console tuning: max TX power in dBm (2..20), saved to flash.
        if (slaprf_set_tx_power_dbm(atoi(line + 8), true)) {
            tx_line("@{\"t\":\"ok\",\"cmd\":\"txpower\",\"saved\":true}\n");
        } else {
            tx_line("@{\"t\":\"err\",\"msg\":\"TXPOWER needs 2..20 (dBm)\"}\n");
        }
    } else if (strcmp(line, "LINKRESET") == 0) {
        // Forget saved LINKRATE / TXPOWER and return to the firmware defaults.
        slaprf_reset_link_settings();
        tx_line("@{\"t\":\"ok\",\"cmd\":\"linkreset\"}\n");
    } else if (strcmp(line, "PANIC?") == 0) {
        char msg[220];
        if (s_panic_rec.magic == PANIC_REC_MAGIC) {
            snprintf(msg, sizeof(msg),
                     "@{\"t\":\"panic\",\"boot\":%lu,\"exc\":%lu,\"pc\":\"0x%08lx\",\"mepc\":\"0x%08lx\",\"ra\":\"0x%08lx\","
                     "\"sp\":\"0x%08lx\",\"mcause\":%lu,\"mtval\":\"0x%08lx\"}\n",
                     (unsigned long)s_panic_rec.boot, (unsigned long)s_panic_rec.exc, (unsigned long)s_panic_rec.pc,
                     (unsigned long)s_panic_rec.mepc, (unsigned long)s_panic_rec.ra, (unsigned long)s_panic_rec.sp,
                     (unsigned long)s_panic_rec.mcause, (unsigned long)s_panic_rec.mtval);
        } else {
            snprintf(msg, sizeof(msg), "@{\"t\":\"panic\",\"none\":true}\n");
        }
        tx_line(msg);
    } else if (strcmp(line, "LASTLOG?") == 0) {
        send_log("last", s_last_log, s_last_len);
    } else if (strncmp(line, "CHANNELS", 8) == 0) {
        handle_channels(line + 8);
    } else if (strncmp(line, "IDENTIFY", 8) == 0) {
        handle_identify(line + 8);
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
    } else if (strncmp(line, "EMERGENCY", 9) == 0) {
        const char *arg = line + 9;
        while (*arg == ' ') arg++;
        const bool on = (*arg != '0');
        if (on) {
            set_emergency_mode(true);
            tx_line("@{\"t\":\"ok\",\"cmd\":\"emergency\",\"on\":true}\n");
        } else {
            tx_line("@{\"t\":\"ok\",\"cmd\":\"emergency\",\"on\":false}\n");
            set_emergency_mode(false);
        }
    } else if (strcmp(line, "REBOOT") == 0) {
        s_live = 0;
        s_scan_live = false;
        s_rf_enabled = false;
        s_ring.crash_streak = 0;
        tx_line("@{\"t\":\"ok\",\"cmd\":\"reboot\"}\n");
        s_reboot_pending = true;
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

static void start_led_timer(void); // Health LED renderer, defined below
static void send_status(void);

/** Pushes a status line every second while a host is attached (priority 0: never delays timing). */
static void status_push_task(void *arg) {
    (void)arg;
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(1000));
        if (s_host_attached && !s_emergency_mode && !s_scan_live) {
            send_status();
        }
    }
}

void slaprf_diag_start(const volatile void *cfg, size_t len, uint8_t sweep_hz) {
    s_cfg = (const volatile uint8_t *)cfg;
    s_cfg_len = len;
    s_sweep_hz = sweep_hz ? sweep_hz : 50;
    s_tx_lock = xSemaphoreCreateMutex();
    memset(s_peak, -127, sizeof(s_peak));
    for (int i = 0; i < 8; i++) s_floor_q4[i] = FLOOR_UNSET;
    if (esp_flash_get_physical_size(NULL, &s_flash_bytes) != ESP_OK) {
        esp_flash_get_size(NULL, &s_flash_bytes);
    }
    gpio_config_t led_cfg = {
        .pin_bit_mask = 1ULL << XIAO_C5_LED_GPIO,
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    gpio_config(&led_cfg);
    gpio_set_level(XIAO_C5_LED_GPIO, 1);
    start_led_timer();
    usb_serial_jtag_driver_config_t usb_cfg = {
        .tx_buffer_size = 4096,
        .rx_buffer_size = 512,
    };
    if (usb_serial_jtag_driver_install(&usb_cfg) == ESP_OK) {
        // Priority 0 (below the main timing loop at 1): USB commands such as STATUS? run only in the
        // idle time the loop already yields between sweeps, so they never delay sweeps or beacons.
        xTaskCreate(console_task, "slaprf_diag", 4096, NULL, 0, NULL);
        xTaskCreate(status_push_task, "slaprf_status", 4096, NULL, 0, NULL);
    }
    if (s_crash_streak >= MAX_CRASH_STREAK) {
        s_booted_emergency_mode = true;
        set_emergency_mode(true);
        ESP_LOGE("slaprf_diag",
                 "EMERGENCY MODE: halted after %lu consecutive crash resets (%s). Radio and sweeps are off so USB stays up for rescue and reflashing; send EMERGENCY 0, REBOOT, or power-cycle to exit.",
                 (unsigned long)s_crash_streak, reset_reason_name(esp_reset_reason()));
        for (;;) {
            if (s_reboot_pending) {
                vTaskDelay(pdMS_TO_TICKS(40));
                esp_restart();
            }
            vTaskDelay(pdMS_TO_TICKS(100));
        }
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

void slaprf_diag_note_spoke(uint8_t slot, uint32_t fp, const char *label) {
    if (slot < 2 || slot > 7) return;
    diag_spoke_peer_t *p = &s_peer_spokes[slot - 2];
    if (p->fp != 0 && p->fp != fp && (p->fp & 0xFFFFFF00UL) != 0x53504B00UL) {
        p->frames = 0;
        p->has_dbm = false;
    }
    p->fp = fp;
    memset(p->label, 0, sizeof(p->label));
    if (label) {
        for (int i = 0; i < 24 && label[i]; i++) {
            char c = label[i];
            p->label[i] = (c == '"' || c == '\\' || c < 0x20) ? '?' : c;
        }
    }
    if (p->last_rx_us == 0) {
        p->last_rx_us = esp_timer_get_time();
    }
}

void slaprf_diag_note_spoke_rx(uint8_t slot) {
    if (slot < 2 || slot > 7) return;
    diag_spoke_peer_t *p = &s_peer_spokes[slot - 2];
    p->last_rx_us = esp_timer_get_time();
    p->frames++;
}

void slaprf_diag_note_spoke_frame(const uint8_t *frame, uint32_t len) {
    if (frame == NULL || len < 4) return;
    const uint8_t slot = frame[2];
    if (slot < 2 || slot > 7) return;
    diag_spoke_peer_t *p = &s_peer_spokes[slot - 2];
    p->last_rx_us = esp_timer_get_time();
    p->frames++;
    if (p->label[0] == '\0') {
        snprintf(p->label, sizeof(p->label), "S%u", (unsigned)(slot - 1));
    }
    if (frame[1] == 0x59) { // FRAME_MAGIC_WINDOW
        const uint8_t sample_count = frame[3];
        if (sample_count >= 1 && len >= 7U + (uint32_t)sample_count * 9U + 1U) {
            p->batt_mv = (uint16_t)frame[4] | ((uint16_t)frame[5] << 8);
            p->floor_dbm = (int8_t)frame[6];
            const uint32_t newest_off = 7U + (uint32_t)(sample_count - 1U) * 9U;
            p->last_seq = frame[newest_off];
            for (int ch = 0; ch < 8; ch++) {
                int8_t best = (int8_t)frame[newest_off + 1U + (uint32_t)ch];
                for (uint8_t s = 0; s < sample_count; s++) {
                    const int8_t v = (int8_t)frame[7U + (uint32_t)s * 9U + 1U + (uint32_t)ch];
                    if (v > best) best = v;
                }
                p->dbm[ch] = best;
            }
            p->has_dbm = true;
        }
    } else if (frame[1] == 0x58 && len >= 16U) { // FRAME_MAGIC_SINGLE
        p->last_seq = frame[3];
        p->batt_mv = (uint16_t)frame[4] | ((uint16_t)frame[5] << 8);
        p->floor_dbm = (int8_t)frame[6];
        for (int ch = 0; ch < 8; ch++) {
            p->dbm[ch] = (int8_t)frame[7 + ch];
        }
        p->has_dbm = true;
    }
}

/* ---- Health LED ------------------------------------------------------------------------------
 * Rendered by a 10 ms esp_timer, independent of the radio loop, so blink timing never depends on
 * when sweeps or the service loop happen to run. The loop only publishes state (s_led_rf_ok etc.).
 *   Hub:                    single blip every 2 s
 *   Spoke, joined:          double blip every 2 s
 *   Spoke searching:        slow 1 Hz blink
 *   Debug LIVE / SCAN LIVE: 5 Hz
 *   5.8 GHz boot check bad: 10 Hz
 *   Emergency mode:         siren fade (LEDC, see siren_led_task)
 */
static volatile bool s_led_rf_ok = true;
static esp_timer_handle_t s_led_timer;

static void led_timer_cb(void *arg) {
    (void)arg;
    if (s_emergency_mode) return; // The siren task owns the LED (LEDC) in emergency mode
    const uint8_t role = s_cfg ? s_cfg[CFG_OFF_ROLE] : 1;
    const int64_t now_ms = esp_timer_get_time() / 1000;
    bool led_on;
    if (s_identify_local || esp_timer_get_time() < s_identify_until_us) {
        // Identify: 3 quick flashes, then dark (600 ms cycle). The pause sets it apart from the
        // continuous 10 Hz "5.8 GHz boot check bad" blink.
        const int64_t phase = now_ms % 600;
        led_on = phase < 300 && ((phase / 50) & 1LL) == 0;
    } else if (!s_led_rf_ok) {
        led_on = ((now_ms / 50) & 1LL) == 0;
    } else if (s_live || s_scan_live) {
        led_on = ((now_ms / 100) & 1LL) == 0;
    } else if (role != 1 && (s_slot < 2 || slaprf_ms_since_hub_beacon() > 2500)) {
        led_on = ((now_ms / 500) & 1LL) == 0;
    } else {
        const int64_t phase = now_ms % 2000;
        const int64_t blip = 70;
        const int64_t gap = 220; // Start of the Spoke's second blip
        led_on = phase < blip || (role != 1 && phase >= gap && phase < gap + blip);
    }
    gpio_set_level(XIAO_C5_LED_GPIO, led_on ? 0 : 1); // Active-low user LED
}

static void start_led_timer(void) {
    if (s_led_timer != NULL) return;
    const esp_timer_create_args_t args = {
        .callback = led_timer_cb,
        .dispatch_method = ESP_TIMER_TASK,
        .name = "slaprf_led",
    };
    if (esp_timer_create(&args, &s_led_timer) == ESP_OK) {
        esp_timer_start_periodic(s_led_timer, 10000);
    }
}

/** Loop-side housekeeping: auto-stop orphaned USB streams and publish RF health for the LED. */
static void update_health_led(void) {
    if (s_emergency_mode) return;
    // Streams (LIVE / SCAN LIVE / LOG) run until the host stops them or USB writes keep failing
    // (tab closed: see tx_bytes_nowait / tx_raw). No command-silence timeout: the browser no longer
    // polls, so a timeout would cut off a LIVE stream the Debug page is still showing.

    bool rf_ok = false;
    int gain = 0, gain_max = 0;
    float floor_db = 0;
    slaprf_rf58_info(&rf_ok, &gain, &gain_max, &floor_db);
    s_led_rf_ok = rf_ok;
}

void slaprf_diag_sweep(const int8_t *dbm, uint32_t took_us) {
    if (s_emergency_mode) return;
    s_sweeps++;
    if (s_ring.crash_streak != 0 && s_sweeps >= (uint32_t)s_sweep_hz * 5U) {
        // Survived 5 full seconds of sweeps: clear any prior crash streak
        s_ring.crash_streak = 0;
        s_crash_streak = 0;
    }
    s_sweep_us_last = took_us;
    if (took_us > s_sweep_us_max) s_sweep_us_max = took_us;
    memcpy(s_last_dbm, dbm, sizeof(s_last_dbm));
    s_has_dbm = true;
    update_health_led();
    for (int i = 0; i < 8; i++) {
        if (dbm[i] <= -127) continue; // Receiver off or slot used by a live scan: no reading
        const int16_t v = (int16_t)(dbm[i] * 16);
        if (dbm[i] > s_peak[i]) s_peak[i] = dbm[i];
        // Floor = typical noise level: a slow average of readings that look like noise. Readings
        // well above it (a VTX, a Wi-Fi burst) are left out, so a parked VTX can't lift it.
        if (s_floor_q4[i] == FLOOR_UNSET) {
            s_floor_q4[i] = v; // First reading on this channel (boot, or channel table changed)
        } else if (v < s_floor_q4[i] + HIT_MARGIN_DB * 16 / 2) {
            s_floor_q4[i] += (v - s_floor_q4[i]) / 32;
        } else {
            s_floor_q4[i] += (v - s_floor_q4[i]) / 2048; // Very slow: follows a lasting rise in noise
        }
        if (v > s_floor_q4[i] + HIT_MARGIN_DB * 16 && s_hits[i] < 255) s_hits[i]++;
    }
    // LIVE 1: about 10 lines a second with the peak since the last line; LIVE 2: every sweep.
    const uint32_t every = s_live == 2 ? 1 : s_sweep_hz >= 10 ? s_sweep_hz / 10 : 1;
    if (!s_live || s_sweeps % every != 0) {
        return;
    }
    static char out[300];
    int8_t fl[8];
    for (int i = 0; i < 8; i++) fl[i] = s_floor_q4[i] == FLOOR_UNSET ? -127 : (int8_t)(s_floor_q4[i] / 16);
    snprintf(out, sizeof(out),
             "@{\"t\":\"live\",\"n\":%lu,\"us\":%lu,\"dbm\":[%d,%d,%d,%d,%d,%d,%d,%d],\"pk\":[%d,%d,%d,%d,%d,%d,%d,%d],"
             "\"hits\":[%u,%u,%u,%u,%u,%u,%u,%u],\"floor\":[%d,%d,%d,%d,%d,%d,%d,%d]}\n",
             (unsigned long)s_sweeps, (unsigned long)took_us, dbm[0], dbm[1], dbm[2], dbm[3], dbm[4], dbm[5], dbm[6],
             dbm[7], s_peak[0], s_peak[1], s_peak[2], s_peak[3], s_peak[4], s_peak[5], s_peak[6], s_peak[7],
             s_hits[0], s_hits[1], s_hits[2], s_hits[3], s_hits[4], s_hits[5], s_hits[6], s_hits[7], fl[0], fl[1],
             fl[2], fl[3], fl[4], fl[5], fl[6], fl[7]);
    for (int i = 0; i < 8; i++) {
        s_peak[i] = -127;
        s_hits[i] = 0;
    }
    tx_line_nowait(out); // Runs in the sweep task: never block timing on a slow USB host
}

void slaprf_diag_service(void) {
    if (s_ring.crash_streak != 0 && s_ring.crash_streak != EMERGENCY_MAGIC && !s_emergency_mode &&
        esp_timer_get_time() > 10000000LL) {
        // Survived 10 s: clear any prior crash streak (the collector Hub doesn't sweep, so the
        // sweep-based clear in slaprf_diag_sweep() never runs there).
        s_ring.crash_streak = 0;
    }
    if (s_reboot_pending) {
        vTaskDelay(pdMS_TO_TICKS(40));
        esp_restart();
    }
    // Streams (LIVE / SCAN LIVE / LOG) run until the host stops them or USB writes keep failing
    // (tab closed: see tx_bytes_nowait / tx_raw). No command-silence timeout: the browser no longer
    // polls, so a timeout would cut off a LIVE stream the Debug page is still showing.

    // Health LED (Hub single blip, Spoke double blip, Spoke searching 1 Hz, ...). Also refreshed on
    // every sweep; the collector Hub doesn't sweep, so this keeps its heartbeat going.
    update_health_led();
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
        tx_line_nowait(live_out);
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