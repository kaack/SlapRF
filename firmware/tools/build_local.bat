@echo off
rem Local firmware build on Windows (ESP-IDF v5.5.1 installed at C:\esp; see firmware\README.md).
rem Usage: firmware\tools\build_local.bat
rem Writes web\firmware\slaprf-xiao-c5.bin so the local server/flasher use the real image.
setlocal
if "%IDF_PATH%"=="" set IDF_PATH=C:\esp\esp-idf
if "%IDF_TOOLS_PATH%"=="" set IDF_TOOLS_PATH=C:\esp\tools
call "%IDF_PATH%\export.bat" >nul || exit /b 1

set ROOT=%~dp0..\..
pushd "%ROOT%\firmware\slaprf" || exit /b 1
idf.py build || (popd & exit /b 1)
pushd build
python -m esptool --chip esp32c5 merge_bin -o "%ROOT%\web\firmware\slaprf-xiao-c5.bin" @flash_args || (popd & popd & exit /b 1)
popd
popd
echo Done.