@echo off
REM AIBrowser (Windows/cmd): start the service.
REM Delegates to serve.ps1, which launches the app from this shell (Start-Process) and polls status.
REM ASCII only + CRLF: cmd.exe parses .cmd in the console codepage, non-ASCII comments can break it.
REM Usage: serve.cmd [headless]
setlocal
set "HERE=%~dp0"
if /i "%~1"=="headless" (
  powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%HERE%serve.ps1" -Headless
) else (
  powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%HERE%serve.ps1"
)
exit /b %ERRORLEVEL%
