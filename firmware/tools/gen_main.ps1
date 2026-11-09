# Generates firmware/<profile>/main/main.c from firmware/tools/main_template.c.
# Edit the template (shared code) or the per-profile settings below, then run:
#   powershell -ExecutionPolicy Bypass -File firmware\tools\gen_main.ps1
$tpl = [IO.File]::ReadAllText("$PSScriptRoot\main_template.c", [Text.Encoding]::UTF8)
$plain = "        cur->rssi_dbm[i] = raw;"
$common = @"
#define TX_POWER_QDBM_NOTE       0
"@
$profiles = @(
 @{ id="open-ground"; name="Open field · Ground mount";
    blurb="Timers sit on the grass at the base of each gate. Wet grass and ground-level Fresnel grazing eat the`n * 2.4 GHz link, so this design spends airtime on margin: Espressif Long Range 500 kbps at +20 dBm,`n * 50 Hz sweeps, and 4-sweep windows sent every 2 sweeps so every sample arrives twice.";
    defines="#define SLAPRF_PROFILE_CODE      1`n#define SWEEP_HZ                 50   // 8-channel 5.8 GHz sweeps per second`n#define WINDOW_SAMPLES           4    // Sweeps per window frame`n#define TX_EVERY_SWEEPS          2    // 4 / 2 = every sweep delivered twice`n#define LINK_LONG_RANGE          1    // Espressif LR 500 kbps`n#define TX_POWER_QDBM            80   // +20 dBm`n#define TDMA_SLOT_US             3500 // LR frame (~2.1 ms) + guard`n#define SWEEP_BUDGET_US          7000 // Radio away from 2.4 GHz per sweep (measured ~6.3 ms on chip v1.0)";
    extra=""; sample=$plain; tail="" },
 @{ id="open-elevated"; name="Open field · Gate-top mount";
    blurb="Timers are mounted on top of the gate or a pole with clear line of sight to the Hub, so the link has`n * margin to spare. This design spends it on timing resolution instead: 100 Hz sweeps over a standard`n * 1 Mbps link at +14 dBm, with 4-sweep windows sent every 2 sweeps so every sample arrives twice.";
    defines="#define SLAPRF_PROFILE_CODE      2`n#define SWEEP_HZ                 100  // 8-channel 5.8 GHz sweeps per second`n#define WINDOW_SAMPLES           4    // Sweeps per window frame`n#define TX_EVERY_SWEEPS          2    // 4 / 2 = every sweep delivered twice`n#define LINK_LONG_RANGE          0    // Standard 1 Mbps ESP-NOW`n#define TX_POWER_QDBM            56   // +14 dBm`n#define TDMA_SLOT_US             900  // 1 Mbps frame (~0.5 ms) + guard`n#define SWEEP_BUDGET_US          7000 // Radio away from 2.4 GHz per sweep (measured ~6.3 ms on chip v1.0)";
    extra=""; sample=$plain; tail="" },
 @{ id="indoor"; name="Indoor · Gym or warehouse";
    blurb="Short distances and reflective walls: the problem is multipath, not range. Low +8 dBm TX keeps the`n * 2.4 GHz link from flooding the room, 100 Hz sweeps keep timing tight, and a median-of-3 filter on each`n * channel rejects single-sweep multipath nulls before they reach the laptop.";
    defines="#define SLAPRF_PROFILE_CODE      3`n#define SWEEP_HZ                 100  // 8-channel 5.8 GHz sweeps per second`n#define WINDOW_SAMPLES           4    // Sweeps per window frame`n#define TX_EVERY_SWEEPS          2    // 4 / 2 = every sweep delivered twice`n#define LINK_LONG_RANGE          0    // Standard 1 Mbps ESP-NOW`n#define TX_POWER_QDBM            32   // +8 dBm`n#define TDMA_SLOT_US             900  // 1 Mbps frame (~0.5 ms) + guard`n#define SWEEP_BUDGET_US          7000 // Radio away from 2.4 GHz per sweep (measured ~6.3 ms on chip v1.0)";
    extra="`n/* ---- Indoor only: median-of-3 multipath filter ------------------------------------------- */`n`nstatic int8_t s_hist[2][MAX_PILOT_SLOTS] = {`n    {-95, -95, -95, -95, -95, -95, -95, -95},`n    {-95, -95, -95, -95, -95, -95, -95, -95},`n};`n`nstatic int8_t median3(int8_t a, int8_t b, int8_t c) {`n    if (a > b) { int8_t t = a; a = b; b = t; }`n    if (b > c) { int8_t t = b; b = c; c = t; }`n    if (a > b) { int8_t t = a; a = b; b = t; }`n    return b;`n}`n";
    sample="        if (raw <= -127) {`n            cur->rssi_dbm[i] = -127;`n            s_hist[0][i] = -95;`n            s_hist[1][i] = -95;`n        } else {`n            cur->rssi_dbm[i] = median3(raw, s_hist[0][i], s_hist[1][i]);`n            s_hist[1][i] = s_hist[0][i];`n            s_hist[0][i] = raw;`n        }"; tail="" },
 @{ id="obstructed"; name="Technical · Trees & obstacles";
    blurb="Timers sit behind trees, under ramps, or inside structures, so the Hub link drops out for long`n * stretches. Long Range 500 kbps at +20 dBm with 6-sweep windows sent every 2 sweeps delivers each`n * sample three times (a 100 ms outage loses nothing), and a Spoke that stops hearing the Hub for`n * 2 s re-syncs and re-joins on its own.";
    defines="#define SLAPRF_PROFILE_CODE      4`n#define SWEEP_HZ                 50   // 8-channel 5.8 GHz sweeps per second`n#define WINDOW_SAMPLES           6    // Sweeps per window frame`n#define TX_EVERY_SWEEPS          2    // 6 / 2 = every sweep delivered three times`n#define LINK_LONG_RANGE          1    // Espressif LR 500 kbps`n#define TX_POWER_QDBM            80   // +20 dBm`n#define TDMA_SLOT_US             3500 // LR frame (~2.1 ms) + guard`n#define SWEEP_BUDGET_US          7000 // Radio away from 2.4 GHz per sweep (measured ~6.3 ms on chip v1.0)`n#define HUB_LOST_MS              2000 // Re-sync + re-join after this long without a beacon";
    extra="";
    sample=$plain;
    tail="            // Obstructed only: re-sync + re-join faster (2.0 s) without dropping USB.`n            if (slaprf_ms_since_hub_beacon() > HUB_LOST_MS) {`n                break;`n            }" }
)
$enc = New-Object Text.UTF8Encoding($false)
foreach ($p in $profiles) {
  $c = $tpl.Replace("{{NAME}}",$p.name).Replace("{{BLURB}}",$p.blurb).Replace("{{DEFINES}}",$p.defines).Replace("{{EXTRA_FUNCS}}",$p.extra).Replace("{{SAMPLE}}",$p.sample).Replace("{{LOOP_TAIL}}",$p.tail)
  $c = $c -replace "`r`n","`n"
  [IO.File]::WriteAllText("$PSScriptRoot\..\$($p.id)\main\main.c",$c,$enc)
  "$($p.id): $((Select-String -InputObject $c -Pattern '\{\{' -AllMatches).Matches.Count) leftover placeholders"
}
