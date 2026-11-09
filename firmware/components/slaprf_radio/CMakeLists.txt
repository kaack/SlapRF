idf_component_register(
    SRCS "slaprf_radio.c" "slaprf_rf58.c" "slaprf_diag.c"
    INCLUDE_DIRS "include"
    REQUIRES esp_wifi esp_netif esp_event esp_timer nvs_flash lwip esp_driver_usb_serial_jtag heap esp_phy
)

# Bench diagnostics: build with the 5.8 GHz capture engine stubbed out (env SLAPRF_RF58_DISABLED=1).
if(DEFINED ENV{SLAPRF_RF58_DISABLED})
    target_compile_definitions(${COMPONENT_LIB} PRIVATE SLAPRF_RF58_DISABLED=1)
endif()
