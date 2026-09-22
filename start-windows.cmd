@echo off
REM ============================================================================
REM  Preview Studio —— 在 Windows 原生运行（推荐）
REM
REM  为什么推荐：WSL 里的图形窗口要经过 WSLg 的远程呈现层（RDP/Weston）送到
REM  笔记本屏幕，最终按屏幕比例缩放后才显示，字号与笔画会被重采样，观感明显
REM  不如原生 Chrome / 原生应用。在 Windows 上直接跑 Electron 没有这一层，
rem  渲染质量与 Chrome 完全一致。
REM
REM  用法：双击本文件即可。首次运行需要联网（下载 Windows 版 Electron 约 100MB）。
REM ============================================================================
setlocal
cd /d "%~dp0"

echo [1/3] 检查 Node.js ...
where node >nul 2>nul
if errorlevel 1 (
  echo   ✗ 没找到 node，请先安装 Node.js 18+：https://nodejs.org/
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do echo   ✓ Node %%v

if not exist "node_modules\electron\package.json" goto install
findstr /c:"\"electron\"" package.json >nul 2>nul || goto install
echo [2/3] 依赖看起来已就绪，跳过安装。
goto build

:install
echo [2/3] 安装依赖（首次较慢，会下载 Windows 版 Electron）...
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo   ✗ 依赖安装失败，请检查网络后重试
  pause
  exit /b 1
)

:build
echo [3/3] 构建渲染层并启动面板 ...
call npm run build
if errorlevel 1 (
  echo   ✗ 构建失败
  pause
  exit /b 1
)

echo.
echo 启动 Preview Studio（关闭本窗口即可退出）
call npx electron . %*
endlocal
