/**
 * slaprf_board — board bring-up for the supported ESP32-C5 timer boards.
 *
 *   xiao-c5 (default, SLAPRF_BOARD_XIAO_C5)   Seeed Studio XIAO ESP32-C5:
 *     plain yellow user LED on GPIO27 (active-low), BOOT button on GPIO28, no battery sense yet,
 *     no antenna-switch GPIO driven (module default path, see slaprf_radio.c history).
 *
 *   c5-zero (SLAPRF_BOARD_C5_ZERO)            Waveshare ESP32-C5-Zero:
 *     WS2812 RGB LED on GPIO27 (driven over RMT; "on" = dim green), antenna switch on GPIO26
 *     (0 = onboard ceramic, 1 = external IPEX-1), BOOT button on GPIO28 (chip boot-strap pin),
 *     no battery header.
 *
 * BOOT on GPIO28 is the ESP32-C5 boot-strap pin, so both boards' tactile BOOT buttons land there.
 */
#include "slaprf_board.h"

#include "driver/gpio.h"

#if defined(SLAPRF_BOARD_C5_ZERO)

#include "driver/rmt_tx.h"

#define C5_ZERO_LED_GPIO 27 // Onboard WS2812 RGB LED (not broken out; RMT-driven)
#define C5_ZERO_ANT_GPIO 26 // Antenna switch: 0 = onboard ceramic, 1 = external IPEX-1
#define BOARD_BOOT_GPIO  28 // BOOT tactile button (active-low)
#define LED_ON_GRB_G     48 // "LED on" brightness (dim green: GRB {48, 0, 0})

static rmt_channel_handle_t s_led_chan;
static rmt_encoder_handle_t s_led_encoder;
static bool s_led_ready;
static bool s_led_on;

static void board_led_init(void) {
    rmt_tx_channel_config_t tx_cfg = {
        .gpio_num = C5_ZERO_LED_GPIO,
        .clk_src = RMT_CLK_SRC_DEFAULT,
        .resolution_hz = 10 * 1000 * 1000, // 100 ns ticks
        .mem_block_symbols = 64,
        .trans_queue_depth = 1,
    };
    rmt_bytes_encoder_config_t enc_cfg = {
        // WS2812 (800 kHz mode): bit0 = 400 ns high + 800 ns low; bit1 = 800 ns high + 400 ns low.
        .bit0 = {.duration0 = 4, .level0 = 1, .duration1 = 8, .level1 = 0},
        .bit1 = {.duration0 = 8, .level0 = 1, .duration1 = 4, .level1 = 0},
        .flags.msb_first = 1,
    };
    if (rmt_new_tx_channel(&tx_cfg, &s_led_chan) == ESP_OK &&
        rmt_new_bytes_encoder(&enc_cfg, &s_led_encoder) == ESP_OK &&
        rmt_enable(s_led_chan) == ESP_OK) {
        s_led_ready = true;
    }
}

static void board_led_apply(bool on) {
    if (!s_led_ready || on == s_led_on) return; // Only retransmit on state changes
    s_led_on = on;
    const uint8_t grb[3] = {on ? LED_ON_GRB_G : 0, 0, 0};
    const rmt_transmit_config_t tx_cfg = {.loop_count = 0};
    if (rmt_transmit(s_led_chan, s_led_encoder, grb, sizeof(grb), &tx_cfg) == ESP_OK) {
        rmt_tx_wait_all_done(s_led_chan, 50); // 24 bits take ~29 us
    }
}

static void board_antenna_init(void) {
    gpio_config_t ant_cfg = {
        .pin_bit_mask = 1ULL << C5_ZERO_ANT_GPIO,
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    gpio_config(&ant_cfg);
    // Leave the switch at its power-on path until slaprf_board_select_external_antenna() runs.
}

void slaprf_board_select_external_antenna(void) {
    // Default to the onboard ceramic antenna so the timer works with nothing attached. The
    // ceramic covers both bands (2.4 GHz link + 5.8 GHz pilots). TODO(hardware): when a 5.8 GHz
    // antenna is attached to the IPEX-1 connector, drive GPIO26 high here to route to it.
    gpio_set_level(C5_ZERO_ANT_GPIO, 0); // 0 = onboard ceramic (1 = external IPEX-1)
}

uint16_t slaprf_board_read_battery_mv(void) {
    return 0; // No battery header on the C5-Zero
}

#else /* SLAPRF_BOARD_XIAO_C5 (default) */

#define XIAO_C5_LED_GPIO  27 // Yellow user LED (active-low: 0 = ON, 1 = OFF)
#define BOARD_BOOT_GPIO   28 // BOOT tactile button (active-low)

static void board_led_init(void) {
    gpio_config_t led_cfg = {
        .pin_bit_mask = 1ULL << XIAO_C5_LED_GPIO,
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    gpio_config(&led_cfg);
    gpio_set_level(XIAO_C5_LED_GPIO, 1); // Active-low: start off
}

static void board_led_apply(bool on) {
    gpio_set_level(XIAO_C5_LED_GPIO, on ? 0 : 1);
}

static void board_antenna_init(void) {
    // No GPIO-driven antenna switch on the XIAO (module default path); see slaprf_board_select_external_antenna().
}

void slaprf_board_select_external_antenna(void) {
    // TODO(hardware): drive the XIAO ESP32-C5 RF switch GPIO to the U.FL port once confirmed
    // against Seeed's schematic. Until then the board's default antenna path is used.
}

uint16_t slaprf_board_read_battery_mv(void) {
    // TODO(hardware): read the battery divider via ADC oneshot. 0 = unknown to the laptop.
    return 0;
}

#endif /* Board selection */

static void board_boot_init(void) {
    // BOOT button (GPIO28, active-low): hold 3 s in the BLE image to clear Bluetooth pairing.
    gpio_config_t boot_cfg = {
        .pin_bit_mask = 1ULL << BOARD_BOOT_GPIO,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    gpio_config(&boot_cfg);
}

void slaprf_board_init(void) {
    board_led_init();
    board_antenna_init();
    board_boot_init();
}

void slaprf_board_led_set(bool on) {
    board_led_apply(on);
}

bool slaprf_board_boot_button_pressed(void) {
    return gpio_get_level(BOARD_BOOT_GPIO) == 0;
}
