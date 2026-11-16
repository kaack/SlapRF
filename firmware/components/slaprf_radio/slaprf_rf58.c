/**
 * 5.8 GHz band-power measurement on the ESP32-C5, time-sliced with the 2.4 GHz link.
 *
 * Implemented from documented facts about Espressif's PHY / RF-test libraries (register
 * addresses, bit fields, call order, timings) — see firmware/README.md "5.8 GHz sensing on the
 * C5" for the sources. None of this is documented by Espressif; re-verify after any change of
 * chip revision, ESP-IDF or PHY library (the CI build checks the symbols and the SRAM layout).
 *
 * Per 10 ms sweep (500 Hz multi-pass on-chip oversampling -> 100 Hz uniform output):
 *   enter():  transmitter path off, 5 GHz band setup at Raceband midpoint (5785 MHz, wide),
 *             ADC decimation filter enabled (ADC rate 1 + RX filter mode 8) to suppress
 *             odd-80 MHz spurs (5680 / 5840 MHz) and adjacent-VTX aliasing.
 *   sweep():  up to 5 ping-pong passes across active channels (~68 us in-band PLL hop, cycle-counter
 *             direct ADC capture of 256..1024 samples, single-pass periodic IRAM DFT), combined via
 *             outlier-rejecting trimmed linear mean and encoded at 0.5 dB resolution.
 *   leave():  back onto the Wi-Fi driver's 2.4 GHz channel, transmitter path on.
 */
#include <math.h>
#include <string.h>
#include <sys/lock.h>

#include "esp_attr.h"
#include "esp_cpu.h"
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
extern void phy_rfpll_set_freq(uint32_t mhz, uint8_t xtal_sel, int16_t trim, void *sdm);
extern void phy_write_rfpll_sdm(void *sdm);
extern void phy_set_freq_i2c(uint32_t mhz);
extern void phy_restart_cal(void);
extern void phy_i2c_sdm_en(uint8_t is5g);
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
#define PARAM_IS_5G         42          // phy_param byte: non-zero while configured on 5 GHz
#define PARAM_XTAL_SEL      49          // phy_param byte the channel code forwards as xtal select
#define PARAM_FREQ_TRIM     30          // phy_param int16 forwarded as the frequency trim
#define PARAM_CUR_MHZ       714         // phy_param uint16 where phy_set_rfpll_freq records MHz
#define BAND_SETUP_MHZ      5785        // 5.8 GHz FPV Raceband midpoint calibration frequency
#define LO_OFFSET_MHZ       10          // LO sits this far below the pilot

#define REG_GAIN            0x600A702CU // forced gain index [31:24], force [23], max index [14:8]
#define REG_DUMP_CTRL       0x600A9004U // count [16:0], done [18], trigger [19], enable [31]
#define REG_SRAM_OWNER      0x60095004U // [11:8] = 2 and [16] = modem owns the capture bank
#define IQ_BANK_START       0x40820000U // 128 KiB the capture engine may write (reserved below)
#define IQ_BANK_END         0x40840000U
#define IQ_DUMP_ADDR        0x40830000U // where samples land

#define CAPTURE_SAMPLES     1024        // Max capture size (12.8 us of RF at 80 MS/s)
#define BLOCK               8           // window length = one ~10 MHz bin at 80 MS/s
#define MAX_BLOCKS          (CAPTURE_SAMPLES / BLOCK)
#define POLL_CYCLES_1MS     (240U * 1000U)
#define SUB_SWEEPS_PER_TICK 5           // 5 passes per 10 ms sweep = 500 Hz RF hop rate
#define MIN_PASS_SPACING_US 800         // Spread sub-passes across ~3.5..4.2 ms (~55+ NTSC video lines)
#define LEAVE_RESERVE_US    2200        // Margin reserved before budget_us for final pass + slaprf_rf58_leave()
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
static uint32_t s_cur_lo_mhz;
static volatile int s_last_sub_passes;
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
static int32_t s_blk_w_re;
static int32_t s_blk_w_im;
static float s_unit_sq_inv; // 1 / (window sum in Q14)^2

static uint8_t xtal_sel(void) { return phy_param[PARAM_XTAL_SEL]; }

static int16_t freq_trim(void) {
    int16_t t;
    memcpy(&t, &phy_param[PARAM_FREQ_TRIM], sizeof(t));
    return t;
}

static void build_coefficients(void) {
    int64_t wsum = 0;
    int32_t wre = 0;
    int32_t wim = 0;
    for (int n = 0; n < BLOCK; n++) {
        // Hann offset by half a sample so no sample gets zero weight (window sum = BLOCK / 2).
        const double w = 0.5 - 0.5 * cos(2.0 * M_PI * (n + 0.5) / BLOCK);
        s_coef_re[n] = (int32_t)lrint(w * cos(M_PI * n / 4.0) * 16384.0);
        s_coef_im[n] = (int32_t)lrint(w * sin(M_PI * n / 4.0) * 16384.0);
        wre += s_coef_re[n];
        wim += s_coef_im[n];
        wsum += (int64_t)lrint(w * 16384.0);
    }
    s_blk_w_re = wre;
    s_blk_w_im = wim;
    s_unit_sq_inv = 1.0f / ((float)wsum * (float)wsum);
}

/**
 * Fast in-band 5.8 GHz PLL hop (~68 us): programs the RF PLL SDM and triggers VCO calibration
 * directly without the extra 20 us + 300 us spins or redundant 5G clock-gen / freq-mem updates
 * (already calibrated at BAND_SETUP_MHZ in slaprf_rf58_enter() at the start of every sweep).
 */
static void hop_no_wait(uint32_t lo_mhz) {
    if (s_cur_lo_mhz == lo_mhz) {
        return;
    }
    uint32_t sdm[4] = {0};
    const uint16_t m16 = (uint16_t)lo_mhz;
    memcpy(&phy_param[PARAM_CUR_MHZ], &m16, sizeof(m16));
    phy_rfpll_set_freq(lo_mhz, xtal_sel(), freq_trim(), sdm);
    phy_write_rfpll_sdm(sdm);
    phy_set_freq_i2c(lo_mhz);
    phy_restart_cal();
    phy_i2c_sdm_en(phy_param[PARAM_IS_5G]);
    s_cur_lo_mhz = lo_mhz;
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
static void stock_capture_n(int n_samples) {
    adctrig((uint32_t)(n_samples - 1), 0, 0, 0, 0, 0, 0, 0, 0);
    // The stock call can leave the modem owning the capture bank. That ownership survives a
    // USB/RTS system reset and then hangs the ROM loader (watchdog boot loop until power-cycled),
    // so hand the bank straight back.
    release_engine();
}

/** One n-sample capture driving the dump registers directly (~10..28 us). Returns false on timeout/corruption. */
static IRAM_ATTR bool direct_capture_n(int n_samples) {
    volatile uint32_t *words = (volatile uint32_t *)IQ_DUMP_ADDR;
    words[0] = SENTINEL;
    words[n_samples / 2] = SENTINEL;
    words[n_samples - 1] = SENTINEL;
    for (int i = 0; i < 4; i++) {
        words[n_samples + i] = GUARD_WORD;
    }

    bool done = false;
    portENTER_CRITICAL(&s_mux);
    const uint32_t owner = REG32(REG_SRAM_OWNER);
    REG32(REG_SRAM_OWNER) = (owner & ~(0xFU << 8)) | (2U << 8) | (1U << 16);

    uint32_t ctrl = REG32(REG_DUMP_CTRL);
    ctrl &= ~(0x1FFFFU | (1U << 17) | (1U << 18) | (1U << 19) | (1U << 20) | (1U << 21));
    ctrl |= ((uint32_t)n_samples & 0x1FFFFU) | (1U << 31);
    REG32(REG_DUMP_CTRL) = ctrl;
    REG32(REG_DUMP_CTRL) = ctrl | (1U << 19); // trigger pulse
    REG32(REG_DUMP_CTRL) = ctrl;

    const uint32_t c0 = esp_cpu_get_cycle_count();
    while (esp_cpu_get_cycle_count() - c0 < POLL_CYCLES_1MS) {
        if (REG32(REG_DUMP_CTRL) & (1U << 18)) {
            done = true;
            break;
        }
    }
    REG32(REG_DUMP_CTRL) = ctrl & ~(1U << 31);
    REG32(REG_SRAM_OWNER) = owner & ~((0xFU << 8) | (1U << 16));
    REG32(REG_SRAM_OWNER) = owner;
    portEXIT_CRITICAL(&s_mux);

    if (!done || words[0] == SENTINEL || words[n_samples / 2] == SENTINEL ||
        words[n_samples - 1] == SENTINEL) {
        return false;
    }
    for (int i = 0; i < 4; i++) {
        if (words[n_samples + i] != GUARD_WORD) {
            return false;
        }
    }
    return true;
}

static inline int32_t sext10(uint32_t v) {
    return (int32_t)(v << 22) >> 22;
}

/**
 * Single-pass periodic band-power meter (LSB^2): DC removed, ~10 MHz around the pilot.
 * Because the 10 MHz mixer at 80 MS/s repeats every 8 samples (1 block), all coefficients stay in
 * RISC-V registers during a single pass over IQ_DUMP_ADDR, and the constant DC response is subtracted
 * across the block sums afterwards (~2x faster than a two-pass scan with identical results).
 */
static __attribute__((optimize("O3"))) IRAM_ATTR float band_power_periodic_n(int n_samples) {
    const volatile uint32_t *words = (const volatile uint32_t *)IQ_DUMP_ADDR;
    const int blocks = n_samples / BLOCK;
    const int32_t cr0 = s_coef_re[0], ci0 = s_coef_im[0];
    const int32_t cr1 = s_coef_re[1], ci1 = s_coef_im[1];
    const int32_t cr2 = s_coef_re[2], ci2 = s_coef_im[2];
    const int32_t cr3 = s_coef_re[3], ci3 = s_coef_im[3];
    const int32_t cr4 = s_coef_re[4], ci4 = s_coef_im[4];
    const int32_t cr5 = s_coef_re[5], ci5 = s_coef_im[5];
    const int32_t cr6 = s_coef_re[6], ci6 = s_coef_im[6];
    const int32_t cr7 = s_coef_re[7], ci7 = s_coef_im[7];

    int32_t blk_re[MAX_BLOCKS];
    int32_t blk_im[MAX_BLOCKS];
    int32_t sum_i = 0;
    int32_t sum_q = 0;

    for (int b = 0; b < blocks; b++) {
        const volatile uint32_t *bw = words + b * BLOCK;
        int32_t re = 0;
        int32_t im = 0;
        uint32_t w;
        int32_t xi, xq;

        #define MIX_STEP(k, crk, cik) \
            w = bw[k]; \
            xi = sext10(w & 0x3FFU); \
            xq = sext10((w >> 10) & 0x3FFU); \
            sum_i += xi; \
            sum_q += xq; \
            re += xi * (crk) - xq * (cik); \
            im += xi * (cik) + xq * (crk)

        MIX_STEP(0, cr0, ci0);
        MIX_STEP(1, cr1, ci1);
        MIX_STEP(2, cr2, ci2);
        MIX_STEP(3, cr3, ci3);
        MIX_STEP(4, cr4, ci4);
        MIX_STEP(5, cr5, ci5);
        MIX_STEP(6, cr6, ci6);
        MIX_STEP(7, cr7, ci7);
        #undef MIX_STEP

        blk_re[b] = re;
        blk_im[b] = im;
    }

    const int32_t mi_q8 = (sum_i << 8) / n_samples;
    const int32_t mq_q8 = (sum_q << 8) / n_samples;
    const int32_t dc_re = (int32_t)(((int64_t)mi_q8 * s_blk_w_re - (int64_t)mq_q8 * s_blk_w_im) >> 8);
    const int32_t dc_im = (int32_t)(((int64_t)mi_q8 * s_blk_w_im + (int64_t)mq_q8 * s_blk_w_re) >> 8);

    uint64_t acc = 0;
    for (int b = 0; b < blocks; b++) {
        const int64_t re = (int64_t)(blk_re[b] - dc_re);
        const int64_t im = (int64_t)(blk_im[b] - dc_im);
        acc += (uint64_t)(re * re) + (uint64_t)(im * im);
    }
    return (float)acc * (s_unit_sq_inv / (float)blocks);
}

static float band_power_db_n(int n_samples) {
    return 10.0f * log10f(band_power_periodic_n(n_samples) + 1e-3f);
}

/** Combine 1..5 linear-power sub-sweep readings while discarding min/max hop or sync outliers. */
static float trimmed_mean_linear(float *vals, int count) {
    if (count <= 0) return 0.0f;
    if (count == 1) return vals[0];
    if (count == 2) return (vals[0] + vals[1]) * 0.5f;
    for (int i = 1; i < count; i++) {
        const float key = vals[i];
        int j = i - 1;
        while (j >= 0 && vals[j] > key) {
            vals[j + 1] = vals[j];
            j--;
        }
        vals[j + 1] = key;
    }
    if (count == 3) {
        return vals[1]; // Median of 3
    }
    // Drop lowest and highest reading (post-hop spike or sync dropout), average the middle readings.
    float sum = 0.0f;
    for (int i = 1; i < count - 1; i++) {
        sum += vals[i];
    }
    return sum / (float)(count - 2);
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
    s_cur_lo_mhz = 0;
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
    s_cur_lo_mhz = 0;
    // Full channel set: reprograms the RF chain (including the TX path) for the 2.4 GHz link.
    phy_set_chanfreq(2407U + 5U * primary, 0);
    phy_pbus_workmode();    // PHY bus under hardware (MAC) control
    force_rx_gain(0, 0, 0); // Hand gain back to the AGC for Wi-Fi / ESP-NOW
    _lock_release(&lock);
}

int slaprf_rf58_sweep_channels_half_dbm(const uint16_t ch_mhz[8], uint8_t out_half_dbm[8],
                                        int64_t sweep_start_us, uint32_t budget_us) {
    memset(out_half_dbm, 0, 8);
#ifdef SLAPRF_RF58_DISABLED
    s_last_sub_passes = 0;
    return 0;
#endif
    if (!s_ready) {
        s_last_sub_passes = 0;
        return 0;
    }

    int active_ch = 0;
    for (int i = 0; i < 8; i++) {
        if (ch_mhz[i] >= 5180 && ch_mhz[i] <= 5945) {
            active_ch++;
        }
    }
    if (active_ch == 0) {
        s_last_sub_passes = 0;
        return 0;
    }

    // Scale per-visit capture length to active channel count so 500 Hz (5 passes / 10 ms) always
    // fits comfortably inside budget_us while maximizing total integrated RF energy per channel.
    const int n_samples = (active_ch == 1) ? 1024 : ((active_ch <= 4) ? 512 : 256);
    const int64_t cutoff_us = (budget_us > LEAVE_RESERVE_US) ? (int64_t)(budget_us - LEAVE_RESERVE_US) : 0;

    float pass_pwr[8][SUB_SWEEPS_PER_TICK];
    int passes_done = 0;

    slaprf_rf58_enter();
    const int64_t pass0_us = esp_timer_get_time();

    for (int p = 0; p < SUB_SWEEPS_PER_TICK; p++) {
        if (p > 0) {
            const int64_t target_us = pass0_us + (int64_t)p * MIN_PASS_SPACING_US;
            int64_t now = esp_timer_get_time();
            if (now - sweep_start_us > cutoff_us || target_us - sweep_start_us > cutoff_us) {
                break;
            }
            if (now < target_us) {
                __real_ets_delay_us((uint32_t)(target_us - now));
            }
        }

        _lock_t lock = phy_get_lock();
        _lock_acquire(&lock);
        // Ping-pong channel order (0..7 on even passes, 7..0 on odd passes): avoids the 259 MHz
        // R8->R1 wraparound jump and turns every pass turnaround into a 0-us no-op hop.
        for (int step = 0; step < 8; step++) {
            const int i = (p & 1) ? (7 - step) : step;
            const uint16_t mhz = ch_mhz[i];
            if (mhz < 5180 || mhz > 5945) {
                continue;
            }
            hop_no_wait((uint32_t)(mhz - LO_OFFSET_MHZ));
            hold_gain();
            if (!direct_capture_n(n_samples)) {
                stock_capture_n(n_samples);
                hold_gain();
            }
            pass_pwr[i][p] = band_power_periodic_n(n_samples);
        }
        _lock_release(&lock);
        passes_done++;
    }

    slaprf_rf58_leave();

    for (int i = 0; i < 8; i++) {
        if (ch_mhz[i] < 5180 || ch_mhz[i] > 5945) {
            out_half_dbm[i] = 0U;
            continue;
        }
        const float mean_pwr = trimmed_mean_linear(pass_pwr[i], passes_done);
        const float dbm = 10.0f * log10f(mean_pwr + 1e-3f) + DBM_OFFSET;
        out_half_dbm[i] = encode_half_dbm(dbm);
    }
    s_last_sub_passes = passes_done;
    return passes_done;
}

int slaprf_rf58_last_sub_passes(void) {
    return s_last_sub_passes;
}

static float measure_channel_dbm_float(uint16_t center_freq_mhz, int avg_captures) {
    if (avg_captures < 1) avg_captures = 1;
    if (avg_captures > 4) avg_captures = 4;

    _lock_t lock = phy_get_lock();
    _lock_acquire(&lock);
    phy_set_rf_freq_offset(xtal_sel(), (uint32_t)(center_freq_mhz - LO_OFFSET_MHZ), freq_trim());
    s_cur_lo_mhz = (uint32_t)(center_freq_mhz - LO_OFFSET_MHZ);
    hold_gain();

    float sum_power = 0.0f;
    for (int c = 0; c < avg_captures; c++) {
        if (!direct_capture_n(CAPTURE_SAMPLES)) {
            stock_capture_n(CAPTURE_SAMPLES); // Re-programs the engine; also the fallback if the direct path stalls
            hold_gain();
        }
        sum_power += band_power_periodic_n(CAPTURE_SAMPLES);
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
    stock_capture_n(CAPTURE_SAMPLES); // Programs the dump engine's setup registers for the direct path
    const volatile uint32_t *words = (const volatile uint32_t *)IQ_DUMP_ADDR;
    const uint32_t gain_field = (words[0] >> 20) & 0x7FU;
    s_ready = direct_capture_n(CAPTURE_SAMPLES);
    const float floor_db = s_ready ? band_power_db_n(CAPTURE_SAMPLES) : 0.0f;
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
