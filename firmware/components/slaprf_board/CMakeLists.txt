idf_component_register(
    SRCS "slaprf_board.c"
    INCLUDE_DIRS "include"
    REQUIRES esp_driver_gpio esp_driver_rmt
)

# Board variant (see include/slaprf_board.h): pass -DSLAPRF_BOARD=c5-zero to idf.py to build for
# the Waveshare ESP32-C5-Zero; everything else builds for the Seeed Studio XIAO ESP32-C5.
set(SLAPRF_BOARD "xiao-c5" CACHE string "SlapRF board variant (xiao-c5 | c5-zero)")
if(SLAPRF_BOARD STREQUAL "c5-zero")
    target_compile_definitions(${COMPONENT_LIB} PRIVATE SLAPRF_BOARD_C5_ZERO=1)
    message(STATUS "SlapRF board: Waveshare ESP32-C5-Zero")
else()
    target_compile_definitions(${COMPONENT_LIB} PRIVATE SLAPRF_BOARD_XIAO_C5=1)
    message(STATUS "SlapRF board: Seeed Studio XIAO ESP32-C5")
endif()
