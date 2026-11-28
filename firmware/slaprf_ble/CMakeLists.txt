# SlapRF Bluetooth Hub firmware (ESP32-C5 boards: Seeed XIAO / Waveshare C5-Zero)
# Dedicated BLE image: the Hub talks to the phone / laptop over Bluetooth LE instead of USB.
# Build: firmware\tools\build_local_ble.ps1   (or: idf.py set-target esp32c5 && idf.py build, ESP-IDF v5.5.1)
cmake_minimum_required(VERSION 3.16)

# The BLE component set plus the shared board bring-up: the USB console component
# (components/slaprf_radio) is required by nothing here, so the USB build stays untouched and the
# BLE build carries no USB-console code. The BLE component compiles the shared 5.8 GHz sensing
# sources from ../components/slaprf_radio by path, and ../components also provides slaprf_board
# (status LED / antenna switch / BOOT button per board variant).
set(EXTRA_COMPONENT_DIRS "${CMAKE_CURRENT_LIST_DIR}/../components_ble"
                         "${CMAKE_CURRENT_LIST_DIR}/../components")

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(slaprf_ble)
