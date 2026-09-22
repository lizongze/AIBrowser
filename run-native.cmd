@echo off
REM AIBrowser - launch the native Windows panel with a CLEAN environment.
REM
REM Why: when started from WSL (cmd.exe /c ...), the process inherits Linux
REM variables such as WSL_DISTRO_NAME, WSLENV, DISPLAY, WAYLAND_DISPLAY,
REM PULSE_SERVER, XDG_RUNTIME_DIR and LD_LIBRARY_PATH. Those break Windows-side
REM integration in Electron - observed as "Ctrl+V does not paste".
REM This wrapper runs scripts\run-native.ps1, which starts Electron from a
REM brand new environment block.
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run-native.ps1" %*
endlocal
