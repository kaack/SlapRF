<#
.SYNOPSIS
Fast local firmware build & optional in-place USB flasher for SlapRF (Seeed Studio XIAO ESP32-C5).

.DESCRIPTION
Configures the ESP-IDF v5.5.1 toolchain paths directly (skipping the slow export.bat check),
compiles the specified firmware profile(s) with Ninja + ccache, writes the merged flasher image to
web\firmware\slaprf-xiao-c5-<profile>.bin, and optionally flashes a connected board over USB while
preserving its existing 160-byte SLAPRF02 identity/config block.

.EXAMPLE
.\firmware\tools\build_local.ps1 open-ground
.\firmware\tools\build_local.ps1 open-ground -FlashPort COM3
.\firmware\tools\build_local.ps1
#>
param(
    [Parameter(Position = 0)]
    [string[]]$Profiles = @(),
    [Parameter()]
    [string]$FlashPort = ""
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path

$env:IDF_PATH = "C:/esp/esp-idf"
$env:IDF_TOOLS_PATH = "C:\esp\tools"
$env:IDF_PYTHON_ENV_PATH = "C:\esp\tools\python_env\idf5.5_py3.12_env"
$romElfDir = Get-ChildItem -Path "C:\esp\tools\tools\esp-rom-elfs" -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending | Select-Object -First 1
if ($romElfDir) {
    $env:ESP_ROM_ELF_DIR = $romElfDir.FullName
}

$toolDirs = @(
    "C:\esp\tools\tools\ninja\1.12.1",
    "C:\esp\tools\tools\cmake\3.30.2\bin",
    "C:\esp\tools\tools\ccache\4.11.2\ccache-4.11.2-windows-x86_64",
    "C:\esp\tools\tools\riscv32-esp-elf\esp-14.2.0_20241119\riscv32-esp-elf\bin",
    "C:\esp\tools\python_env\idf5.5_py3.12_env\Scripts"
)
$env:PATH = ($toolDirs -join ";") + ";" + $env:PATH

$python = "C:\esp\tools\python_env\idf5.5_py3.12_env\Scripts\python.exe"
$ninja  = "C:\esp\tools\tools\ninja\1.12.1\ninja.exe"

if (-not $Profiles -or $Profiles.Count -eq 0) {
    $Profiles = Get-ChildItem -Path (Join-Path $Root "firmware") -Directory |
        Where-Object { Test-Path (Join-Path $_.FullName "profile.json") } |
        Select-Object -ExpandProperty Name
}

$outDir = Join-Path $Root "web\firmware"
if (-not (Test-Path $outDir)) {
    New-Item -ItemType Directory -Path $outDir | Out-Null
}

foreach ($p in $Profiles) {
    $projDir = Join-Path $Root "firmware\$p"
    $buildDir = Join-Path $projDir "build"
    Write-Host "=== Building profile: $p ===" -ForegroundColor Cyan

    if (-not (Test-Path (Join-Path $buildDir "build.ninja"))) {
        Push-Location $projDir
        try {
            & $python "$env:IDF_PATH/tools/idf.py" reconfigure
            if ($LASTEXITCODE -ne 0) { throw "idf.py reconfigure failed for $p" }
        } finally {
            Pop-Location
        }
    }

    & $ninja -C $buildDir
    if ($LASTEXITCODE -ne 0) { throw "ninja build failed for $p" }

    $nm = "C:\esp\tools\tools\riscv32-esp-elf\esp-14.2.0_20241119\riscv32-esp-elf\bin\riscv32-esp-elf-nm.exe"
    $elfPath = Join-Path $buildDir "slaprf-$p.elf"
    $bssLine = & $nm $elfPath | Select-String " _bss_end$"
    if ($bssLine) {
        $bssHex = ($bssLine.ToString().Trim() -split "\s+")[0]
        $bssAddr = [Convert]::ToUInt64($bssHex, 16)
        $headroom = 0x40820000 - $bssAddr
        Write-Host (" -> _bss_end = 0x{0} ({1} bytes headroom below 0x40820000 IQ bank)" -f $bssHex, $headroom) -ForegroundColor DarkGray
        if ($bssAddr -ge 0x40820000) {
            throw "_bss_end (0x$bssHex) overlaps 0x40820000 IQ capture bank!"
        }
    }

    Push-Location $buildDir
    try {
        $mergedOut = Join-Path $outDir "slaprf-xiao-c5-$p.bin"
        & $python -m esptool --chip esp32c5 merge_bin -o $mergedOut "@flash_args"
        if ($LASTEXITCODE -ne 0) { throw "esptool merge_bin failed for $p" }
        Write-Host " -> Updated $mergedOut" -ForegroundColor Green
    } finally {
        Pop-Location
    }

    if ($FlashPort -ne "") {
        $appBin = Join-Path $buildDir "slaprf-$p.bin"
        $patchedBin = Join-Path $buildDir "slaprf-$p-patched.bin"
        Write-Host "=== Flashing $p onto $FlashPort (preserving SLAPRF02 config) ===" -ForegroundColor Cyan
        & $python -c @"
import serial, hashlib, struct, sys, time
port, bin_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
s = serial.Serial(port, 115200, timeout=1.5)
time.sleep(1.2)
s.reset_input_buffer()
s.write(b'SLAPRF?\n')
time.sleep(0.25)
raw = s.read(512)
s.close()
idx = raw.find(b'SLAPRF02')
cfg = bytearray(raw[idx:idx+160]) if idx >= 0 and len(raw) >= idx + 160 else bytearray()
data = bytearray(open(bin_path, 'rb').read())
if len(cfg) == 160 and cfg[:8] == b'SLAPRF02':
    off = data.find(b'SLAPRF02')
    assert off > 0, 'SLAPRF02 not found in binary'
    # Keep the newly built firmware version bytes [8..10], preserve board identity/settings [11..158]
    cfg[8:11] = data[off+8:off+11]
    if struct.unpack_from('<I', cfg, 14)[0] == 1 and not cfg[107]:
        struct.pack_into('<I', cfg, 14, 0xBE7C0001)
        cfg[107:109] = b'H1'
    crc = 0
    for b in cfg[:159]:
        crc ^= b
    cfg[159] = crc
    data[off:off+160] = cfg
    has_sha = data[23] == 1
    body_end = len(data) - (32 if has_sha else 0)
    pos, chk = 24, 0xEF
    for _ in range(data[1]):
        seg_len = struct.unpack_from('<I', data, pos + 4)[0]
        pos += 8
        for b in data[pos:pos+seg_len]:
            chk ^= b
        pos += seg_len
    data[body_end - 1] = chk
    if has_sha:
        data[body_end:] = hashlib.sha256(data[:body_end]).digest()
    print(f'Preserved SLAPRF02 config from {port} at offset {hex(off)}')
else:
    print('Warning: no existing SLAPRF02 config read from port; flashing default config')
open(out_path, 'wb').write(data)
"@ $FlashPort $appBin $patchedBin
        if ($LASTEXITCODE -ne 0) { throw "Failed to prepare patched image for $FlashPort" }
        try {
            & $python -m esptool --chip esp32c5 -p $FlashPort -b 460800 --before default_reset --after hard_reset write_flash 0x10000 $patchedBin
            if ($LASTEXITCODE -ne 0) { throw "esptool write_flash failed on $FlashPort" }
        } finally {
            Remove-Item -ErrorAction SilentlyContinue $patchedBin
        }
    }
}
