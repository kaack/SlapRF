@echo off
rem Local firmware build on Windows (ESP-IDF v5.5.1 installed at C:\esp; see firmware\README.md).
rem Usage: firmware\tools\build_local.bat [xiao-c5|c5-zero]   (default: xiao-c5)
rem Writes web\firmware\slaprf-<board>.bin so the local server/flasher use the real image.
setlocal
rem Unset MSYSTEM (git-bash): idf.py silently skips all work when it is set.
set MSYSTEM=
set BOARD=%1
if "%BOARD%"=="" set BOARD=xiao-c5
set BUILDDIR=build
if not "%BOARD%"=="xiao-c5" set BUILDDIR=build-%BOARD%
set OUTNAME=slaprf-%BOARD%.bin
if "%BOARD%"=="xiao-c5" set OUTNAME=slaprf-xiao-c5.bin
if "%IDF_PATH%"=="" set IDF_PATH=C:\esp\esp-idf
if "%IDF_TOOLS_PATH%"=="" set IDF_TOOLS_PATH=C:\esp\tools
call "%IDF_PATH%\export.bat" >nul || exit /b 1

set ROOT=%~dp0..\..
set SDKDEF=
if not "%BOARD%"=="xiao-c5" set SDKDEF=-DSDKCONFIG=%BUILDDIR%/sdkconfig
pushd "%ROOT%\firmware\slaprf" || exit /b 1
idf.py -B %BUILDDIR% -DSLAPRF_BOARD=%BOARD% %SDKDEF% build || (popd & exit /b 1)
pushd %BUILDDIR%
python -m esptool --chip esp32c5 merge_bin -o "%ROOT%\web\firmware\%OUTNAME%" @flash_args || (popd & popd & exit /b 1)
popd
popd
echo Done.
