@echo off
rem Bench smoke test: build the firmware with USB logging, flash it with esptool, capture the boot log.
rem Usage: firmware\tools\smoke.bat <COMport> [seconds]
setlocal
if "%~1"=="" (echo usage: smoke.bat ^<COMport^> [seconds] & exit /b 1)
if "%IDF_PATH%"=="" set IDF_PATH=C:\esp\esp-idf
if "%IDF_TOOLS_PATH%"=="" set IDF_TOOLS_PATH=C:\esp\tools
call "%IDF_PATH%\export.bat" >nul || exit /b 1
set SECS=%~2
if "%SECS%"=="" set SECS=10

pushd "%~dp0..\slaprf" || exit /b 1
idf.py -B build-smoke -D SDKCONFIG=build-smoke/sdkconfig -D "SDKCONFIG_DEFAULTS=sdkconfig.defaults;../tools/smoke.defaults" build || (popd & exit /b 1)
idf.py -B build-smoke -p %~1 flash || (popd & exit /b 1)
popd
python "%~dp0serial_capture.py" %~1 %SECS%
