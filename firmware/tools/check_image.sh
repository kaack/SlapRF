#!/usr/bin/env bash
# Post-build checks for a SlapRF firmware profile (run from the profile directory after
# `idf.py build`, with the ESP-IDF toolchain on PATH).
#
#  1. The 5.8 GHz capture engine writes into SRAM 0x40820000-0x4083FFFF, which the firmware
#     reserves from the heap. Static code/data must end below it, or captures would overwrite it.
#  2. The undocumented PHY entry points must actually be linked (CONFIG_ESP_PHY_ENABLE_CERT_TEST).
#  3. The SLAPRF02 config block must be present so the flasher can patch it.
set -euo pipefail

elf=$(ls build/*.elf | head -1)
bank=$((0x40820000))
fail=0

for sym in _iram_end _data_end _bss_end; do
  addr=$(riscv32-esp-elf-nm "$elf" | awk -v s="$sym" '$3 == s {print $1}' | head -1)
  if [ -z "$addr" ]; then
    echo "::warning::$sym not found in $elf"
    continue
  fi
  if [ $((16#$addr)) -ge $bank ]; then
    echo "::error::$sym = 0x$addr reaches the capture bank at 0x40820000"
    fail=1
  else
    echo "$sym = 0x$addr (headroom $(( (bank - 16#$addr) / 1024 )) KiB)"
  fi
done

for sym in adctrig force_rx_gain phy_set_chanfreq phy_set_rf_freq_offset phy_pbus_xpd_tx_off phy_pbus_xpd_tx_on; do
  if ! riscv32-esp-elf-nm "$elf" | awk '{print $NF}' | grep -qx "$sym"; then
    echo "::error::$sym is not linked into $elf"
    fail=1
  fi
done

if ! grep -qa SLAPRF02 "$elf"; then
  echo "::error::SLAPRF02 config block missing from $elf"
  fail=1
fi

exit $fail
