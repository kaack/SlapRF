idf_component_register(
    SRCS "main.c"
    PRIV_REQUIRES esp_eth esp_netif esp_event esp_timer nvs_flash driver usb lwip vfs
    INCLUDE_DIRS "."
)
