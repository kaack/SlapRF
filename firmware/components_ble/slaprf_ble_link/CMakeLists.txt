idf_component_register(
    SRCS "slaprf_ble_link.c" "slaprf_ble_console.c" "slaprf_ble_espnow.c"
         "../../components/slaprf_radio/slaprf_rf58.c"
    INCLUDE_DIRS "include" "../../components/slaprf_radio/include"
    REQUIRES esp_wifi esp_event esp_timer nvs_flash esp_driver_usb_serial_jtag esp_driver_gpio
             esp_driver_ledc heap esp_phy spi_flash bt
)

# Same link wraps as the USB image: panic capture (PANIC?) and the skipped 300 us PLL spin during
# 5.8 GHz sweeps. ble_transport_to_hs_evt_impl is wrapped so the Hub can timestamp the controller's
# "Number Of Completed Packets" events and lock its sweep schedule to the BLE connection events.
target_link_libraries(${COMPONENT_LIB} INTERFACE
    "-Wl,--wrap=esp_panic_handler"
    "-Wl,--wrap=ets_delay_us"
    "-Wl,--wrap=ble_transport_to_hs_evt_impl")

if(DEFINED ENV{SLAPRF_RF58_DISABLED})
    target_compile_definitions(${COMPONENT_LIB} PRIVATE SLAPRF_RF58_DISABLED=1)
endif()
