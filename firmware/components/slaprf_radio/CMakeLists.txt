idf_component_register(
    SRCS "slaprf_radio.c" "slaprf_rf58.c"
    INCLUDE_DIRS "include"
    REQUIRES esp_wifi esp_netif esp_event esp_timer nvs_flash lwip esp_driver_usb_serial_jtag heap esp_phy
)
