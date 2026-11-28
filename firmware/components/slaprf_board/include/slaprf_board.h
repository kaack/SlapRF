/**
 * slaprf_board — board bring-up layer shared by the USB Hub/Spoke and Bluetooth Hub images.
 *
 * Owns the hardware bits that differ between the supported boards (status LED, antenna switch,
 * BOOT button, battery sense) so the radio and console code stay board-independent. The board is
 * selected at build time with the CMake cache variable SLAPRF_BOARD:
 *   xiao-c5 (default)   Seeed Studio XIAO ESP32-C5
 *   c5-zero             Waveshare ESP32-C5-Zero
 * Both boards run the same ESP32-C5 chip, so the 5.8 GHz capture engine, 2.4 GHz link, and USB
 * console (slaprf_radio / slaprf_ble_link) need no board-specific code.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Configure board pins (status LED, antenna switch, BOOT button). Call once at boot. */
void slaprf_board_init(void);

/** Route the RF switch to the external antenna connector (U.FL on the XIAO, IPEX-1 on the C5-Zero). */
void slaprf_board_select_external_antenna(void);

/** Battery voltage in mV, or 0 if unknown (the laptop then keeps its last value). */
uint16_t slaprf_board_read_battery_mv(void);

/**
 * Status / identify LED. Driven by the console's 10 ms health timer (health blinks, IDENTIFY
 * strobe). On the XIAO this is the plain active-low user LED; on the C5-Zero it lights the
 * onboard WS2812 green.
 */
void slaprf_board_led_set(bool on);

/** BOOT tactile button (GPIO28 on both boards, active-low: true = pressed). */
bool slaprf_board_boot_button_pressed(void);

#ifdef __cplusplus
}
#endif
