#!/usr/bin/env bash
# CI build of the firmware (run from firmware/slaprf inside the ESP-IDF container).
# Compiler / linker errors are echoed as GitHub annotations so they're readable without log access.
set -uo pipefail

idf.py build > build.log 2>&1
status=$?
if [ $status -ne 0 ]; then
  grep -E "in function|first defined|error:|undefined reference|multiple definition|region .* overflowed|Error [0-9]|CMake Error|warning: .*\[-Werror" build.log \
    | head -40 | while IFS= read -r line; do echo "::error title=firmware build::$line"; done
  tail -n 25 build.log
  exit $status
fi

bash ../tools/check_image.sh || exit 1

cd build
python -m esptool --chip esp32c5 merge_bin -o slaprf-xiao-c5.bin @flash_args
