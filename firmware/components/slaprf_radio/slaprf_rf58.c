/**
 * 5.8 GHz band-power measurement on the ESP32-C5, time-sliced with the 2.4 GHz link.
 *
 * Implemented from documented facts about Espressif's PHY / RF-test libraries (register
 * addresses, bit fields, call order, timings) — see firmware/README.md "5.8 GHz sensing on the
 * C5" for the sources. None of this is documented by Espressif; re-verify after any change of
 * chip revision, ESP-IDF or PHY library (the CI build checks the symbols and the SRAM layout).
 *
 * Per sweep:
 *   enter():  transmitter path off, 5 GHz band setup (phy_set_chanfreq at 5180 MHz, wide).
 *   measure(): PLL-only hop with the LO 10 MHz below the pilot, one raw ADC capture
 *             (256 I/Q samples at 80 MS/s), band power over ~10 MHz around the pilot.
 *   leave():  back onto the Wi-Fi driver's 2.4 GHz channel, transmitter path on.
 */
#include <math.h>
#include <string.h>

#include "esp_log.h"
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
extern void phy_pbus_workmode(void);
extern void phy_pbus_xpd_tx_off(void);
extern void phy_pbus_xpd_tx_on(void);
extern void force_rx_gain(int enable, int index, int bt_path);
extern void adctrig(uint32_t count_minus_1, uint32_t selector, uint32_t mode, uint32_t rate,
                    uint32_t unused, uint32_t wait_style, uint32_t w1, uint32_t w2, uint32_t w3);

// librftest.a can reference the RF test console's command parser; we never use that console.
__attribute__((weak)) int cmd_parse(void *arg) {
    (void)arg;
    return -1;
}

/* ---- Facts ---------------------------------------------------------------------------------- */
#define PARAM_XTAL_SEL      49          // phy_param byte the channel code forwards as xtal select
#define PARAM_FREQ_TRIM     30          // phy_param int16 forwarded as the frequency trim
#define BAND_SETUP_MHZ      5180        // 5 GHz band calibration point
#define LO_OFFSET_MHZ       10          // LO sits this far below the pilot

#define REG_GAIN            0x600A702CU // forced gain index [31:24], force [23], max index [14:8]
#define REG_DUMP_CTRL       0x600A9004U // count [16:0], done [18], trigger [19], enable [31]
#define REG_SRAM_OWNER      0x60095004U // [11:8] = 2 and [16] = modem owns the capture bank
#define IQ_BANK_START       0x40820000U // 128 KiB the capture engine may write (reserved below)
#define IQ_BANK_END         0x40840000U
#define IQ_DUMP_ADDR        0x40830000U // where samples land

#define CAPTURE_SAMPLES     256         // 3.2 us of RF at 80 MS/s
#define BLOCK               8           // window length = one ~10 MHz bin at 80 MS/s
#define SENTINEL            0xA5A5A5A5U // impossible sample word (bits 27..31 set)
#define GUARD_WORD          0x5A5A5A5AU

// Calibration from relative band power (LSB^2, dB) to dBm. Bench-calibrate per board/antenna.
#define DEFAULT_GAIN_INDEX  30
#define DBM_OFFSET          (-89.0f)

#define REG32(a) (*(volatile uint32_t *)(a))

// Keep the heap out of the capture bank: while a capture runs the modem owns this SRAM.
SOC_RESERVE_MEMORY_REGION(IQ_BANK_START, IQ_BANK_END, slaprf_iq_bank);

static bool s_ready;
static int s_gain = DEFAULT_GAIN_INDEX;
static portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;

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
static void hold_gain(void) {
    const uint32_t r = REG32(REG_GAIN);
    if (((r >> 23) & 1U) && (int)(r >> 24) == s_gain) {
        return;
    }
    force_rx_gain(1, s_gain, 0);
}

/** One capture through the stock trigger: software trigger, receive-only mode, 80 MS/s. */
static void stock_capture(void) {
    adctrig(CAPTURE_SAMPLES - 1, 0, 0, 0, 0, 0, 0, 0, 0);
}

/** One capture driving the dump registers directly (~10 us). Returns false on timeout/corruption. */
static bool direct_capture(void) {
    volatile uint32_t *words = (volatile uint32_t *)IQ_DUMP_ADDR;
    for (int i = 0; i < CAPTURE_SAMPLES; i++) {
        words[i] = SENTINEL;
    }
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

    if (!done || words[CAPTURE_SAMPLES - 1] == SENTINEL) {
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

/** Band power of the last capture in dB (LSB^2): DC removed, ~10 MHz around the pilot. */
static float band_power_db(void) {
    const volatile uint32_t *words = (const volatile uint32_t *)IQ_DUMP_ADDR;
    static int32_t i_s[CAPTURE_SAMPLES]; // static: keep 2 KB off the caller's stack
    static int32_t q_s[CAPTURE_SAMPLES];
    int64_t sum_i = 0;
    int64_t sum_q = 0;
    for (int n = 0; n < CAPTURE_SAMPLES; n++) {
        const uint32_t w = words[n];
        i_s[n] = sext10(w & 0x3FFU);
        q_s[n] = sext10((w >> 10) & 0x3FFU);
        sum_i += i_s[n];
        sum_q += q_s[n];
    }
    const int32_t dc_i = (int32_t)(sum_i / CAPTURE_SAMPLES);
    const int32_t dc_q = (int32_t)(sum_q / CAPTURE_SAMPLES);

    int64_t acc = 0;
    for (int b = 0; b < CAPTURE_SAMPLES / BLOCK; b++) {
        int64_t re = 0;
        int64_t im = 0;
        for (int n = 0; n < BLOCK; n++) {
            const int32_t x_i = i_s[b * BLOCK + n] - dc_i;
            const int32_t x_q = q_s[b * BLOCK + n] - dc_q;
            re += (int64_t)x_i * s_coef_re[n] - (int64_t)x_q * s_coef_im[n];
            im += (int64_t)x_i * s_coef_im[n] + (int64_t)x_q * s_coef_re[n];
        }
        acc += re * re + im * im; // |block|^2 (fits: <= 32 * (1023 * 2^16)^2 * 2)
    }
    const float power = (float)acc * s_scale; // a tone of amplitude A reads A^2 (LSB^2)
    return 10.0f * log10f(power + 1e-3f);
}

/* ---- Public API ----------------------------------------------------------------------------- */

void slaprf_rf58_enter(void) {
    phy_pbus_workmode();
    phy_pbus_xpd_tx_off(); // Nothing may transmit while the radio sits in the FPV video band
    phy_set_chanfreq(BAND_SETUP_MHZ, 1);
    hold_gain();
}

void slaprf_rf58_leave(void) {
    uint8_t primary = 1;
    wifi_second_chan_t second = WIFI_SECOND_CHAN_NONE;
    esp_wifi_get_channel(&primary, &second);
    phy_set_chanfreq(2407U + 5U * primary, 0); // Back onto the link channel, 20 MHz
    force_rx_gain(0, 0, 0);                    // Hand gain back to the AGC for Wi-Fi / ESP-NOW
    phy_pbus_xpd_tx_on();
}

int8_t esp_sdr_measure_5g_channel_dbm(uint16_t center_freq_mhz) {
    if (!s_ready || center_freq_mhz < 5180 || center_freq_mhz > 5917) {
        return -95;
    }
    phy_set_rf_freq_offset(xtal_sel(), (uint32_t)(center_freq_mhz - LO_OFFSET_MHZ), freq_trim());
    hold_gain();
    if (!direct_capture()) {
        stock_capture(); // Re-programs the engine; also the fallback if the direct path stalls
    }
    float dbm = band_power_db() + DBM_OFFSET;
    if (dbm < -127.0f) dbm = -127.0f;
    if (dbm > 0.0f) dbm = 0.0f;
    return (int8_t)lrintf(dbm);
}

bool slaprf_rf58_init(void) {
    build_coefficients();
    const uint32_t gain_max = (REG32(REG_GAIN) >> 8) & 0x7FU;
    if (gain_max > 0 && s_gain > (int)gain_max) {
        s_gain = (int)gain_max;
    }

    slaprf_rf58_enter();
    phy_set_rf_freq_offset(xtal_sel(), 5800 - LO_OFFSET_MHZ, freq_trim());
    stock_capture(); // Programs the dump engine's setup registers for the direct path
    const volatile uint32_t *words = (const volatile uint32_t *)IQ_DUMP_ADDR;
    const uint32_t gain_field = (words[0] >> 20) & 0x7FU;
    s_ready = direct_capture();
    const float floor_db = s_ready ? band_power_db() : 0.0f;
    slaprf_rf58_leave();

    ESP_LOGW(TAG, "boot check: direct=%d gain_field=%lu gain=%d max=%lu floor=%.1f dB", s_ready,
             (unsigned long)gain_field, s_gain, (unsigned long)gain_max, floor_db);
    return s_ready;
}
