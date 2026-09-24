# AIBrowser (Windows): start the service by launching the app itself, then poll status.
#
# Why not `pvs serve`: the CLI spawns the service through cmd/CLI/child processes, and some agent
# shells (console-less PowerShell with captured output) keep waiting on that process tree, so the
# command appears to hang. Launching the app from the caller's own PowerShell via Start-Process is
# the reliable path: the command returns in a few seconds and the service comes up in the background.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File serve.ps1              # panel window (default)
#   powershell -NoProfile -ExecutionPolicy Bypass -File serve.ps1 -Headless    # headless
#   powershell -NoProfile -ExecutionPolicy Bypass -File serve.ps1 -TimeoutSec 30
# Exit code: 0 = service ready; 1 = not ready within the timeout.
# NOTE: keep this file ASCII-only (PowerShell 5.1 reads non-BOM scripts as ANSI/GBK).
param(
  [switch]$Headless,
  # 45s aligns with the CLI start window: the first launch from a skill bundle has to unpack/scan
  # hundreds of MB on Windows, so 20s was too short and produced false "not ready" reports.
  [int]$TimeoutSec = 45
)

$ErrorActionPreference = 'Stop'

# 1) Locate the bundled app: this script lives in <skill>/scripts/, app in <skill>/bundle/<os>-<arch>/
$skillDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$bundle = Join-Path $skillDir ("bundle/win32-" + $arch)
if (-not (Test-Path (Join-Path $bundle 'AIBrowser.exe'))) {
  # Fall back to the only platform present in the bundle
  $dirs = @(Get-ChildItem -Path (Join-Path $skillDir 'bundle') -Directory -ErrorAction SilentlyContinue)
  if ($dirs.Count -eq 1) { $bundle = $dirs[0].FullName }
}
$exe = Join-Path $bundle 'AIBrowser.exe'
$pvs = Join-Path $bundle 'pvs.cmd'
if (-not (Test-Path $exe)) {
  Write-Output ("[aibrowser] bundled app not found: " + $exe)
  exit 1
}
$env:AIBROWSER_BUNDLE = $bundle

# 2) Nothing to do if a matching service is already running
if (Test-Path $pvs) {
  # starting:true means a process is already up but not answering yet (first run / unpack / AV scan
  # can take 10-20s). Launching another app would just exit (single instance), so wait instead.
  $now = & $pvs status --json 2>$null
  if ($now -match '"starting":true') {
    Write-Output '[aibrowser] service is already starting, waiting for it...'
    for ($i = 1; $i -le $TimeoutSec; $i++) {
      Start-Sleep -Seconds 1
      $out = & $pvs status --json 2>$null
      if ($out -match '"running":true') {
        Write-Output ("[aibrowser] ready after " + $i + "s")
        Write-Output $out
        exit 0
      }
      if ($out -notmatch '"starting":true') { break }
    }
    # Never became ready: treat it as a stuck instance, stop it and start a fresh one below.
    Write-Output ("[aibrowser] the previous instance never became ready after " + $TimeoutSec + "s; restarting it...")
    & $pvs stop --json 2>$null | Out-Null
    Start-Sleep -Seconds 2
    $now = & $pvs status --json 2>$null
  }
  if ($now -match '"running":true') {
    if (-not $Headless -and $now -notmatch '"mode":"gui"') {
      Write-Output '[aibrowser] headless service running, restarting in panel mode...'
      & $pvs stop --json 2>$null | Out-Null
      Start-Sleep -Seconds 1
    } else {
      Write-Output '[aibrowser] service already running'
      Write-Output $now
      exit 0
    }
  }
}

# 3) Launch the app (Start-Process does not inherit our handles) and poll until ready.
#    Same argument shape as the packaged pvs.cmd lazy start: --serve --gui|--headless --json.
$argList = if ($Headless) { @('--serve', '--headless', '--json') } else { @('--serve', '--gui', '--json') }
# ELECTRON_RUN_AS_NODE must not leak into the app: it would run as plain Node and never serve.
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Start-Process -FilePath $exe -ArgumentList $argList -WindowStyle Hidden
$modeLabel = if ($Headless) { 'headless' } else { 'panel' }
Write-Output ("[aibrowser] started AIBrowser (" + $modeLabel + "), waiting for readiness...")

for ($i = 1; $i -le $TimeoutSec; $i++) {
  Start-Sleep -Seconds 1
  if (-not (Test-Path $pvs)) { Write-Output ("[aibrowser] " + $i + "s: pvs.cmd missing, cannot verify"); continue }
  $out = & $pvs status --json 2>$null
  if ($out -match '"running":true') {
    Write-Output ("[aibrowser] ready after " + $i + "s")
    Write-Output $out
    exit 0
  }
  Write-Output ("[aibrowser] " + $i + "s: waiting...")
}

Write-Output ("[aibrowser] timeout: service not ready after " + $TimeoutSec + "s (try -Headless without a display)")
exit 1
