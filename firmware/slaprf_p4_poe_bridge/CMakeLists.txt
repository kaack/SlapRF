# SlapRF PoE Ethernet Bridge firmware (Waveshare ESP32-P4-POE-ETH / ESP32-P4-WIFI6-POE-ETH)
# Build: idf.py set-target esp32p4 && idf.py build   (ESP-IDF v5.5.1)
cmake_minimum_required(VERSION 3.16)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(slaprf_p4_poe_bridge)
