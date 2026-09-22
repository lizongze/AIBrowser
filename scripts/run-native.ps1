# AIBrowser · 在 Windows 上用「干净环境」启动原生面板
#
# 背景：从 WSL 里执行 cmd.exe /c start-windows.cmd 时，PowerShell/cmd 会把 WSL 的
# Linux 环境变量一并继承过去（WSL_DISTRO_NAME、WSLENV、DISPLAY、WAYLAND_DISPLAY、
# PULSE_SERVER、XDG_RUNTIME_DIR、LD_LIBRARY_PATH 等）。这些变量会让 Electron 的
# Windows 侧集成出现异常，实测表现为「Ctrl+V 粘贴无反应」。
#
# 本脚本用 .NET 的 ProcessStartInfo 配 UseShellExecute=$false，让子进程从
# 一个全新的环境块启动（不再继承 WSL 变量），并顺带保留原来 start-windows.cmd
# 的全部功能：依赖检查、构建、以 --win 启动。
#
# 用法：在 Windows 上双击 run-native.cmd（它会调用本脚本）

param(
  [string[]]$AppArgs = @(),
  [switch]$NoWait
)

# 注意：不要用 'Stop' —— PowerShell 5.1 会把原生命令（node/npm）写到 stderr 的内容
# 当成终止错误抛出，而 esbuild 的进度输出正好走 stderr，会导致脚本在构建后被中断。
$ErrorActionPreference = 'Continue'
$root = (Get-Location).Path  # run-native.cmd 已 cd 到项目根目录
if (-not (Test-Path (Join-Path $root 'package.json'))) {
  $root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
}
Set-Location $root

Write-Host '============================================'
Write-Host ' AIBrowser - Windows native (clean environment)'
Write-Host '============================================'
Write-Host ''

# ---- 1) 定位 Windows 侧依赖目录（自动兼容我们之前用过的多个目录名）----
$candidates = @('node_modules.win2', 'node_modules.win3', 'node_modules.win', 'node_modules')
$depDir = $null
foreach ($c in $candidates) {
  if (Test-Path (Join-Path $root "$c\node_modules\electron\package.json")) { $depDir = $c; break }
}
if (-not $depDir) { $depDir = 'node_modules.win2' }
$electronExe = Join-Path $root "$depDir\node_modules\electron\dist\electron.exe"

if (-not (Test-Path $electronExe)) {
  Write-Host "[X] 找不到 Windows 版 Electron（$electronExe）"
  Write-Host '    Run start-windows.cmd once to install dependencies'
  exit 1
  exit 1
}
Write-Host "[1/3] Electron: $depDir\node_modules\electron\dist\electron.exe"

# ---- 2) 构建渲染层（用 Windows 侧依赖，避免用到 WSL 装的 Linux 版 esbuild）----
Write-Host '[2/3] Building renderer ...'
$env:NODE_PATH = Join-Path $root "$depDir\node_modules"
& node (Join-Path $root 'scripts\build.mjs')
if ($LASTEXITCODE -ne 0) {
  Write-Host '[X] Build failed'
  exit 1
  exit 1
}

# ---- 3) 用全新环境块启动 Electron ----
# 关键：UseShellExecute=$false 时不指定 EnvironmentVariables 会继承当前环境；
# 这里显式换成一份全新的干净环境，只保留 Windows 运行必需项。
Write-Host '[3/3] Starting panel with a clean environment ...'
# 取「当前进程环境」为底（含 SystemRoot / TEMP / APPDATA 等 Windows 必需项），
# 再剔除 WSL/Linux 变量；不要用 Machine+User 重建 —— 那样会丢掉 SystemRoot，
# 导致网络监听、音频、COM 全部初始化失败。
$clean = @{}
foreach ($kv in [System.Environment]::GetEnvironmentVariables('Process').GetEnumerator()) {
  $clean[$kv.Key] = [string]$kv.Value
}
foreach ($bad in @('WSL_DISTRO_NAME', 'WSL_INTEROP', 'WSLENV', 'WSL2_GUI_APPS_ENABLED',
                   'DISPLAY', 'WAYLAND_DISPLAY', 'PULSE_SERVER', 'XDG_RUNTIME_DIR',
                   'LD_LIBRARY_PATH', 'LD_PRELOAD', 'TERM', 'TERM_PROGRAM',
                   'SHELL', 'LANG', 'OLDPWD', 'PWD', 'HOME')) {
  [void]$clean.Remove($bad)
}

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $electronExe
$psi.WorkingDirectory = $root
$psi.UseShellExecute = $false
$psi.EnvironmentVariables.Clear()
foreach ($kv in $clean.GetEnumerator()) { $psi.EnvironmentVariables[$kv.Key] = [string]$kv.Value }

# PowerShell 5.1 没有 ProcessStartInfo.ArgumentList（那是 PS7+ API），用字符串 Arguments
$argList = @("`"$root`"", '--win') + $AppArgs
$psi.Arguments = ($argList -join ' ')

$proc = [System.Diagnostics.Process]::Start($psi)
Write-Host "      started, pid $($proc.Id)"

if (-not $NoWait) {
  Write-Host '(closing this window does not stop the panel)'
  $proc.WaitForExit()
}
