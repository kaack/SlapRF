/**
 * 5.8 GHz band-power measurement on the ESP32-C5, time-sliced with the 2.4 GHz link.
 *
 * Implemented from documented facts about Espressif's PHY / RF-test libraries (register
 * addresses, bit fields, call order, timings) — see firmware/README.md "5.8 GHz sensing on the
 * C5" for the sources. None of this is documented by Espressif; re-verify after any change of
 * chip revision, ESP-IDF or PHY library (the CI build checks the symbols and the SRAM layout).
 *
 * Per sweep:
 *   enter():  transmitter path off, 5 GHz band setup at Raceband midpoint (5785 MHz, wide),
 *             ADC decimation filter enabled (ADC rate 1 + RX filter mode 8) to suppress
 *             odd-80 MHz spurs (5680 / 5840 MHz) and adjacent-VTX aliasing.
 *   measure(): PLL-only hop with the LO 10 MHz below the pilot (skipping the redundant 300 us
 *              post-cal spin), 1..4 linear-averaged 1024-sample ADC captures (12.8..51.2 us at
 *              80 MS/s), band power over ~10 MHz around the pilot at 0.5 dB resolution.
 *   leave():  back onto the Wi-Fi driver's 2.4 GHz channel, transmitter path on.
 */
#include <math.h>
#include <string.h>
#include <sys/lock.h>

#include "esp_attr.h"
#include "esp_log.h"
#include "esp_private/phy.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "heap_memory_layout.h"
#include "slaprf_radio.h"

static const char *TAG = "slaprf_rf58";

/* ---- Espressif PHY / RF-test library entry points (libphy.a, librftest.a) ----------------- */
extern uint8_t phy_param[];
extern int phy_set_chanfreq(uint32_t mhz, uint8_t wide);
extern void phy_set_rf_freq_offset(uint8_t xtal_sel, uint32_t mhz, int16_t trim);
extern void phy_adc_rate_set(uint8_t rate);
extern void phy_rx_filter_mode(uint8_t mode);
extern void phy_pbus_workmode(void);
// Writes the TX-path power-down values on the PHY's internal bus while it stays in hardware
// (work) mode. NOTE: phy_pbus_xpd_tx_on() is NOT its inverse: it is an RF-test routine that puts
// the bus into forced debug mode and drives the TX chain manually, taking TX away from the MAC.
extern void phy_pbus_xpd_tx_off(void);
extern void force_rx_gain(int enable, int index, int bt_path);
extern void adctrig(uint32_t count_minus_1, uint32_t selector, uint32_t mode, uint32_t rate,
                    uint32_t unused, uint32_t wait_style, uint32_t w1, uint32_t w2, uint32_t w3);
extern void __real_ets_delay_us(uint32_t us);

// librftest.a can reference the RF test console's command parser; we never use that console.
__attribute__((weak)) int cmd_parse(void *arg) {
    (void)arg;
    return -1;
}

/* ---- Facts ---------------------------------------------------------------------------------- */
#define PARAM_XTAL_SEL      49          // phy_param byte the channel code forwards as xtal select
#define PARAM_FREQ_TRIM     30          // phy_param int16 forwarded as the frequency trim
#define BAND_SETUP_MHZ      5785        // 5.8 GHz FPV Raceband midpoint calibration frequency
#define LO_OFFSET_MHZ       10          // LO sits this far below the pilot

#define REG_GAIN            0x600A702CU // forced gain index [31:24], force [23], max index [14:8]
#define REG_DUMP_CTRL       0x600A9004U // count [16:0], done [18], trigger [19], enable [31]
#define REG_SRAM_OWNER      0x60095004U // [11:8] = 2 and [16] = modem owns the capture bank
#define IQ_BANK_START       0x40820000U // 128 KiB the capture engine may write (reserved below)
#define IQ_BANK_END         0x40840000U
#define IQ_DUMP_ADDR        0x40830000U // where samples land

#define CAPTURE_SAMPLES     1024        // 12.8 us of RF at 80 MS/s (4x 256-sample baseline)
#define BLOCK               8           // window length = one ~10 MHz bin at 80 MS/s
#define SENTINEL            0xA5A5A5A5U // impossible sample word (bits 27..31 set)
#define GUARD_WORD          0x5A5A5A5AU

// Calibration from relative band power (LSB^2, dB) to dBm at gain index 38.
// Gain 38 provides ~8 dB lower front-end noise figure than gain 30 while keeping the ADC floor near -90.5 dBm.
#define DEFAULT_GAIN_INDEX  38
#define DBM_OFFSET          (-89.0f)

#define REG32(a) (*(volatile uint32_t *)(a))

// Keep the heap out of the capture bank: while a capture runs the modem owns this SRAM.
SOC_RESERVE_MEMORY_REGION(IQ_BANK_START, IQ_BANK_END, slaprf_iq_bank);

static bool s_ready;
static volatile bool s_in_rf58_rx;
static int s_gain_max_seen;
static float s_floor_db;
static int s_gain = DEFAULT_GAIN_INDEX;
static portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;

/**
 * In libphy.a (ESP-IDF v5.5.1), phy_set_rfpll_freq() already waits for hardware PLL calibration
 * via phy_wait_rfpll_cal_end() and then tail-calls ets_delay_us(300). Skipping that redundant
 * 300 us spin solely while in 5.8 GHz RX saves ~2.4 ms per 8-channel sweep while leaving all
 * 2.4 GHz Wi-Fi / ESP-NOW timing untouched.
 */
IRAM_ATTR void __wrap_ets_delay_us(uint32_t us) {
    if (s_in_rf58_rx && us == 300U) {
        return;
    }
    __real_ets_delay_us(us);
}

// Window * mixer coefficients (Q14): w[n] * e^{+j*pi*n/4}. The C5's spectrum is inverted, so
// RF 10 MHz above the LO appears at -10 MHz; multiplying by e^{+j*2*pi*(10/80)*n} brings it to
// 0 Hz, and at 80 MS/s that phasor repeats every 8 samples, so every block shares these.
static int32_t s_coef_re[BLOCK];
static int32_t s_coef_im[BLOCK];
static float s_scale; // 1 / ((window sum in Q14)^2 * blocks)

static uint8_t xtal_sel(void) { return phy_param[PARAM_XTAL_SEL]; }

static int16_t freq_trim(void) {
    int16_t t;
    memcpy(&t, &phy_param[PARAM_FREQ_TRIM], sizeof(t));
    return t;
}

static void build_coefficients(void) {
    int64_t wsum = 0;
    for (int n = 0; n < BLOCK; n++) {
        // Hann offset by half a sample so no sample gets zero weight (window sum = BLOCK / 2).
        const double w = 0.5 - 0.5 * cos(2.0 * M_PI * (n + 0.5) / BLOCK);
        s_coef_re[n] = (int32_t)lrint(w * cos(M_PI * n / 4.0) * 16384.0);
        s_coef_im[n] = (int32_t)lrint(w * sin(M_PI * n / 4.0) * 16384.0);
        wsum += (int64_t)lrint(w * 16384.0);
    }
    s_scale = 1.0f / ((float)wsum * (float)wsum * (float)(CAPTURE_SAMPLES / BLOCK));
}

/** Force the receiver gain, rewriting only when the lock is off or on another index. */
static IRAM_ATTR void hold_gain(void) {
    const uint32_t r = REG32(REG_GAIN);
    if (((r >> 23) & 1U) && (int)(r >> 24) == s_gain) {
        return;
    }
    force_rx_gain(1, s_gain, 0);
}

/** Put the capture engine and SRAM ownership back to their idle state. */
static void release_engine(void) {
    REG32(REG_DUMP_CTRL) &= ~((1U << 31) | (1U << 19));
    REG32(REG_SRAM_OWNER) &= ~((0xFU << 8) | (1U << 16));
}

/** One capture through the stock trigger: software trigger, receive-only mode, 80 MS/s. */
static void stock_capture(void) {
    adctrig(CAPTURE_SAMPLES - 1, 0, 0, 0, 0, 0, 0, 0, 0);
    // The stock call can leave the modem owning the capture bank. That ownership survives a
    // USB/RTS system reset and then hangs the ROM loader (watchdog boot loop until power-cycled),
    // so hand the bank straight back.
    release_engine();
}

/** One 1024-sample capture driving the dump registers directly (~15 us). Returns false on timeout/corruption. */
static IRAM_ATTR bool direct_capture(void) {
    volatile uint32_t *words = (volatile uint32_t *)IQ_DUMP_ADDR;
    words[0] = SENTINEL;
    words[CAPTURE_SAMPLES / 2] = SENTINEL;
    words[CAPTURE_SAMPLES - 1] = SENTINEL;
    for (int i = 0; i < 4; i++) {
        words[CAPTURE_SAMPLES + i] = GUARD_WORD;
    }

    bool done = false;
    portENTER_CRITICAL(&s_mux);
    const uint32_t owner = REG32(REG_SRAM_OWNER);
    REG32(REG_SRAM_OWNER) = (owner & ~(0xFU << 8)) | (2U << 8) | (1U << 16);

    uint32_t ctrl = REG32(REG_DUMP_CTRL);
    ctrl &= ~(0x1FFFFU | (1U << 17) | (1U << 18) | (1U << 19) | (1U << 20) | (1U << 21));
    ctrl |= (CAPTURE_SAMPLES & 0x1FFFFU) | (1U << 31);
    REG32(REG_DUMP_CTRL) = ctrl;
    REG32(REG_DUMP_CTRL) = ctrl | (1U << 19); // trigger pulse
    REG32(REG_DUMP_CTRL) = ctrl;

    const int64_t deadline = esp_timer_get_time() + 1000;
    while (esp_timer_get_time() < deadline) {
        if (REG32(REG_DUMP_CTRL) & (1U << 18)) {
            done = true;
            break;
        }
    }
    REG32(REG_DUMP_CTRL) = ctrl & ~(1U << 31);
    REG32(REG_SRAM_OWNER) = owner & ~((0xFU << 8) | (1U << 16));
    REG32(REG_SRAM_OWNER) = owner;
    portEXIT_CRITICAL(&s_mux);

    if (!done || words[0] == SENTINEL || words[CAPTURE_SAMPLES / 2] == SENTINEL ||
        words[CAPTURE_SAMPLES - 1] == SENTINEL) {
        return false;
    }
    for (int i = 0; i < 4; i++) {
        if (words[CAPTURE_SAMPLES + i] != GUARD_WORD) {
            return false;
        }
    }
    return true;
}

static inline int32_t sext10(uint32_t v) {
    return (int32_t)(v << 22) >> 22;
}

/**
 * Linear band power of the last capture (LSB^2): DC removed, ~10 MHz around the pilot.
 * Streams directly from IQ_DUMP_ADDR in two passes so zero static RAM buffers are needed.
 */
static IRAM_ATTR float band_power_linear(void) {
    const volatile uint32_t *words = (const volatile uint32_t *)IQ_DUMP_ADDR;
    int32_t sum_i = 0;
    int32_t sum_q = 0;
    for (int n = 0; n < CAPTURE_SAMPLES; n++) {
        const uint32_t w = words[n];
        sum_i += sext10(w & 0x3FFU);
        sum_q += sext10((w >> 10) & 0x3FFU);
    }
    const int32_t dc_i = sum_i / CAPTURE_SAMPLES;
    const int32_t dc_q = sum_q / CAPTURE_SAMPLES;

    uint64_t acc = 0;
    for (int b = 0; b < CAPTURE_SAMPLES / BLOCK; b++) {
        int64_t re = 0;
        int64_t im = 0;
        const volatile uint32_t *bw = words + b * BLOCK;
        for (int n = 0; n < BLOCK; n++) {
            const uint32_t w = bw[n];
            const int32_t x_i = sext10(w & 0x3FFU) - dc_i;
            const int32_t x_q = sext10((w >> 10) & 0x3FFU) - dc_q;
            re += (int64_t)x_i * s_coef_re[n] - (int64_t)x_q * s_coef_im[n];
            im += (int64_t)x_i * s_coef_im[n] + (int64_t)x_q * s_coef_re[n];
        }
        acc += (uint64_t)(re * re) + (uint64_t)(im * im);
    }
    return (float)acc * s_scale;
}

static float band_power_db(void) {
    return 10.0f * log10f(band_power_linear() + 1e-3f);
}

/** esp_restart() / panic path: never leave the modem owning the capture bank across a reset. */
static void rf58_shutdown(void) {
    s_in_rf58_rx = false;
    release_engine();
    force_rx_gain(0, 0, 0);
}

static inline uint8_t encode_half_dbm(float dbm) {
    if (dbm <= -127.0f) return 1U; // 0U is reserved for disabled / unmeasured slot
    if (dbm >= 0.0f) return 255U;
    int c = (int)lrintf((dbm + 127.5f) * 2.0f);
    if (c < 1) c = 1;
    if (c > 255) c = 255;
    return (uint8_t)c;
}

/* ---- Public API ----------------------------------------------------------------------------- */

void slaprf_rf58_enter(void) {
#ifdef SLAPRF_RF58_DISABLED
    return;
#endif
    _lock_t lock = phy_get_lock();
    _lock_acquire(&lock);
    s_in_rf58_rx = true;
    phy_pbus_workmode();
    phy_pbus_xpd_tx_off(); // Nothing may transmit while the radio sits in the FPV video band
    phy_set_chanfreq(BAND_SETUP_MHZ, 1);
    // Enable ADC decimation filter across the entire 5.8 GHz band (by default libphy only enables
    // it above 5830 MHz, leaving 5680 / 5840 MHz harmonic spurs and VTX aliasing on R1..R6).
    phy_adc_rate_set(1);
    phy_rx_filter_mode(8);
    hold_gain();
    _lock_release(&lock);
}

void slaprf_rf58_leave(void) {
#ifdef SLAPRF_RF58_DISABLED
    return;
#endif
    uint8_t primary = 1;
    wifi_second_chan_t second = WIFI_SECOND_CHAN_NONE;
    esp_wifi_get_channel(&primary, &second);

    _lock_t lock = phy_get_lock();
    _lock_acquire(&lock);
    s_in_rf58_rx = false;
    // Full channel set: reprograms the RF chain (including the TX path) for the 2.4 GHz link.
    phy_set_chanfreq(2407U + 5U * primary, 0);
    phy_pbus_workmode();    // PHY bus under hardware (MAC) control
    force_rx_gain(0, 0, 0); // Hand gain back to the AGC for Wi-Fi / ESP-NOW
    _lock_release(&lock);
}

static float measure_channel_dbm_float(uint16_t center_freq_mhz, int avg_captures) {
    if (avg_captures < 1) avg_captures = 1;
    if (avg_captures > 4) avg_captures = 4;

    _lock_t lock = phy_get_lock();
    _lock_acquire(&lock);
    phy_set_rf_freq_offset(xtal_sel(), (uint32_t)(center_freq_mhz - LO_OFFSET_MHZ), freq_trim());
    hold_gain();

    float sum_power = 0.0f;
    for (int c = 0; c < avg_captures; c++) {
        if (!direct_capture()) {
            stock_capture(); // Re-programs the engine; also the fallback if the direct path stalls
            hold_gain();
        }
        sum_power += band_power_linear();
    }
    _lock_release(&lock);

    const float mean_power = sum_power / (float)avg_captures;
    return 10.0f * log10f(mean_power + 1e-3f) + DBM_OFFSET;
}

uint8_t esp_sdr_measure_5g_channel_half_dbm(uint16_t center_freq_mhz, int avg_captures) {
    if (!s_ready || center_freq_mhz < 5180 || center_freq_mhz > 5945) {
        return 0U;
    }
    return encode_half_dbm(measure_channel_dbm_float(center_freq_mhz, avg_captures));
}

int8_t esp_sdr_measure_5g_channel_dbm(uint16_t center_freq_mhz) {
    if (!s_ready || center_freq_mhz < 5180 || center_freq_mhz > 5945) {
        return -95;
    }
    float dbm = measure_channel_dbm_float(center_freq_mhz, 1);
    if (dbm < -127.0f) dbm = -127.0f;
    if (dbm > 0.0f) dbm = 0.0f;
    return (int8_t)lrintf(dbm);
}

bool slaprf_rf58_init(void) {
#ifdef SLAPRF_RF58_DISABLED
    ESP_LOGW(TAG, "capture engine disabled at build time (SLAPRF_RF58_DISABLED)");
    return false;
#endif
    release_engine(); // In case a previous run was reset mid-capture
    esp_register_shutdown_handler(rf58_shutdown);
    build_coefficients();
    const uint32_t gain_max = (REG32(REG_GAIN) >> 8) & 0x7FU;
    if (gain_max > 0 && s_gain > (int)gain_max) {
        s_gain = (int)gain_max;
    }

    slaprf_rf58_enter();
    _lock_t lock = phy_get_lock();
    _lock_acquire(&lock);
    phy_set_rf_freq_offset(xtal_sel(), 5800 - LO_OFFSET_MHZ, freq_trim());
    phy_adc_rate_set(1);
    phy_rx_filter_mode(8);
    hold_gain();
    stock_capture(); // Programs the dump engine's setup registers for the direct path
    const volatile uint32_t *words = (const volatile uint32_t *)IQ_DUMP_ADDR;
    const uint32_t gain_field = (words[0] >> 20) & 0x7FU;
    s_ready = direct_capture();
    const float floor_db = s_ready ? band_power_db() : 0.0f;
    _lock_release(&lock);

    s_gain_max_seen = (int)gain_max;
    s_floor_db = floor_db + DBM_OFFSET;
    slaprf_rf58_leave();

    ESP_LOGW(TAG, "boot check: direct=%d gain_field=%lu gain=%d max=%lu floor=%.1f dBm (raw %.1f dB)",
             s_ready, (unsigned long)gain_field, s_gain, (unsigned long)gain_max, s_floor_db, floor_db);
    return s_ready;
}

void slaprf_rf58_info(bool *ok, int *gain, int *gain_max, float *floor_db) {
    *ok = s_ready;
    *gain = s_gain;
    *gain_max = s_gain_max_seen;
    *floor_db = s_floor_db;
}
