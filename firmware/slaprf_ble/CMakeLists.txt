# SlapRF Bluetooth Hub firmware (Seeed XIAO ESP32-C5)
# Dedicated BLE image: the Hub talks to the phone / laptop over Bluetooth LE instead of USB.
# Build: firmware\tools\build_local_ble.ps1   (or: idf.py set-target esp32c5 && idf.py build, ESP-IDF v5.5.1)
cmake_minimum_required(VERSION 3.16)

# Only the BLE component set: the USB console component (components/slaprf_radio) is NOT added,
# so the USB build stays untouched and the BLE build carries no USB-console code. The BLE component
# compiles the shared 5.8 GHz sensing and radio sources from ../components/slaprf_radio by path.
set(EXTRA_COMPONENT_DIRS "${CMAKE_CURRENT_LIST_DIR}/../components_ble")

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(slaprf_ble)
