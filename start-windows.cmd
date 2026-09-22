@echo off
REM ============================================================================
REM  AIBrowser - run natively on Windows (best rendering quality)
REM
REM  Why native: inside WSL the window goes through WSLg remote compositing, so
REM  the app only gets a window-sized canvas (measured 1524x927) which WSLg then
REM  scales up to the physical 3072x1920 panel. Native Windows compositing has no
REM  such layer - text quality equals Chrome.
REM
REM  Windows and WSL cannot share node_modules (Electron and esbuild ship
REM  platform-specific binaries), so this script keeps a separate Windows set in
REM  node_modules.win and leaves the WSL side untouched.
REM
REM  Usage: double-click this file.
REM ============================================================================
setlocal enabledelayedexpansion
chcp 65001 >nul 2>nul
cd /d "%~dp0"

echo ============================================
echo  AIBrowser - Windows native
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 goto no_node
for /f "delims=" %%v in ('node -v') do echo [1/4] Node.js %%v

call :try_dir node_modules.win
if defined WIN_DIR goto build
echo       first candidate unavailable, trying another folder name ...
call :try_dir node_modules.win2
if defined WIN_DIR goto build
call :try_dir node_modules.win3
if defined WIN_DIR goto build
echo [X] Could not prepare a Windows dependency directory.
echo     A leftover folder may be locked. Delete node_modules.win* in Explorer and retry.
pause
exit /b 1

:build
echo [3/4] Building renderer ...
set "NODE_PATH=%~dp0%WIN_DIR%\node_modules"
call node scripts\build.mjs
if errorlevel 1 goto build_fail

echo [4/4] Starting AIBrowser (close this window to quit)
echo.
call "%WIN_BIN%\electron.cmd" . --win %*
goto end

REM ---- prepare one dependency dir; leaves WIN_DIR empty on failure ----
:try_dir
set "WIN_DIR="
set "CAND=%~1"
set "CAND_BIN=%CAND%\node_modules\.bin"
if not exist "%CAND%\node_modules\electron\package.json" goto install_cand
if not exist "%CAND_BIN%\esbuild.cmd" goto install_cand
echo [2/4] Dependencies ready in %CAND% - skipping install
set "WIN_DIR=%CAND%"
set "WIN_BIN=%CAND_BIN%"
exit /b 0

:install_cand
echo [2/4] Installing Windows dependencies into %CAND% ...
echo        first run downloads about 150 MB, please wait
if not exist "%CAND%" mkdir "%CAND%"
node "scripts\make-native-manifest.mjs" "%CAND%" >nul
if errorlevel 1 exit /b 1
pushd "%CAND%"
call npm install --no-audit --no-fund
set "NPM_RESULT=!errorlevel!"
popd
if not "!NPM_RESULT!"=="0" exit /b 1
if not exist "%CAND_BIN%\electron.cmd" exit /b 1
if not exist "%CAND_BIN%\esbuild.cmd" exit /b 1
echo       OK
set "WIN_DIR=%CAND%"
set "WIN_BIN=%CAND_BIN%"
exit /b 0

:no_node
echo [X] Node.js not found. Install Node 18+ from https://nodejs.org/
pause
exit /b 1

:build_fail
echo [X] Build failed.
pause
exit /b 1

:end
endlocal
