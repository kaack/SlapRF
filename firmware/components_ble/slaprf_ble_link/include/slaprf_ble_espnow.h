/**
 * slaprf_ble_espnow.h: Lean 2.4 GHz Wi-Fi STA + ESP-NOW link for the SlapRF Bluetooth Hub image.
 *
 * Replaces slaprf_radio.c inside the BLE firmware build without esp_netif or lwip overhead, and
 * uses a compact 24 x 64-byte FreeRTOS RX queue sized for SlapRF Spoke frames (<= 44 bytes) so
 * static SRAM and heap stay well inside the XIAO ESP32-C5 0x40820000 IQ capture ceiling.
 */
#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Initialize NVS, default event loop, Wi-Fi STA on `channel` (2.4 GHz only, modem sleep off,
 * 11b/g/n + LR RX enabled), and ESP-NOW with a 6 Mbps OFDM broadcast peer by default.
 */
void slaprf_ble_init_2g4_espnow(uint8_t channel, int8_t default_tx_power_qdbm);

#ifdef __cplusplus
}
#endif
