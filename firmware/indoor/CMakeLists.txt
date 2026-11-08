# SlapRF firmware profile: indoor
# Build: idf.py set-target esp32c5 && idf.py build   (ESP-IDF v5.5+)
cmake_minimum_required(VERSION 3.16)

# Hardware layer shared by all profiles (2.4 GHz link, Hub bridge, 5.8 GHz sensing).
set(EXTRA_COMPONENT_DIRS "${CMAKE_CURRENT_LIST_DIR}/../components")

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(slaprf-indoor)
