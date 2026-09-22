#!/usr/bin/env bash
# 确保 AIBrowser 后台服务就绪（幂等）。Agent 首次使用本 skill 时执行一次即可。
#
# 默认优先「面板服务（GUI）」：代码截图只有在 GUI 下才是整块面板（含标签条、行号栏），
# 纯无头服务没有面板窗口，截出来只有文件内容本身（pvs://code/ 代码页）。
#   AIBROWSER_GUI=1  → 强制面板服务
#   AIBROWSER_GUI=0  → 强制纯无头服务（CI / 无显示环境）
# 未显式指定时：有 DISPLAY / WAYLAND_DISPLAY 就用面板服务，否则无头。
#
# 另外：服务是常驻进程，跑的是启动那一刻的代码。若仓库里的代码比服务新（或服务模式不是
# 想要的），这里会自动重启，避免「改了代码但截图还是旧行为」。
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -L)"
pv="$script_dir/pvs.sh"
# shellcheck source=./resolve-home.sh
. "$script_dir/resolve-home.sh"

# 探测一次，输出：<running> <mode> <stale>
# stale = 仓库代码比服务启动时间新（即服务还在用旧代码）
probe() {
  python3 - "$1" "$2" <<'PY' 2>/dev/null || echo "0 0 0"
import json, os, subprocess, sys

pv, home = sys.argv[1], sys.argv[2]
try:
    out = subprocess.run([pv, 'status', '--json'], capture_output=True, text=True, timeout=25).stdout
    state = json.loads(out.strip().splitlines()[-1])
except Exception:
    state = {}

running = 1 if state.get('running') else 0
mode = state.get('mode') or ''
started = state.get('startedAt') or 0
stale = 0
if running and started and home and home != 'PATH' and os.path.isdir(home):
    newest = 0.0
    for base in ('dist', 'src', 'bin', 'preload'):
        for dirpath, _dirs, files in os.walk(os.path.join(home, base)):
            for name in files:
                if name.endswith(('.js', '.mjs', '.cjs', '.css', '.html', '.json')):
                    try:
                        newest = max(newest, os.path.getmtime(os.path.join(dirpath, name)))
                    except OSError:
                        pass
    # 1 秒容差：构建产物常常和服务在同一秒里落盘
    stale = 1 if newest * 1000 > started + 1000 else 0
print(f'{running} {mode} {stale}')
PY
}

want_gui() {
  case "${AIBROWSER_GUI:-auto}" in
    1 | true | yes) return 0 ;;
    0 | false | no) return 1 ;;
  esac
  if [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ] || [ -n "${WSL_DISTRO_NAME:-}" ]; then
    return 0
  fi
  return 1
}

describe() {
  "$pv" status 2>/dev/null | head -4 || true
}

start() {
  local mode="$1"
  if [ "$mode" = gui ]; then
    echo "[aibrowser] 启动面板服务（GUI）..."
    "$pv" serve --gui --json >/dev/null 2>&1 || "$pv" serve --gui >/dev/null 2>&1 || true
  else
    echo "[aibrowser] 启动无头服务 ..."
    "$pv" serve --json >/dev/null 2>&1 || "$pv" serve >/dev/null 2>&1 || true
  fi
}

home="$(resolve_aibrowser_home || true)"
target=daemon
want_gui && target=gui

read -r running mode stale <<<"$(probe "$pv" "$home")"

if [ "$running" = "1" ]; then
  if [ "$target" = "gui" ] && [ "$mode" != "gui" ]; then
    echo "[aibrowser] 当前是无头服务，重启为面板服务（代码截图要带上标签条就得有面板）..."
    "$pv" stop >/dev/null 2>&1 || true
    sleep 1
    start gui
  elif [ "$stale" = "1" ]; then
    echo "[aibrowser] 仓库代码比运行中的服务新（常驻进程不会自动加载改动），重启以生效..."
    "$pv" stop >/dev/null 2>&1 || true
    sleep 1
    if [ "$mode" = gui ]; then start gui; else start daemon; fi
  else
    echo "[aibrowser] 服务已在运行（$([ "$mode" = gui ] && echo '面板窗口' || echo '无头服务')，代码已是最新）："
    describe
    exit 0
  fi
else
  start "$target"
fi

read -r running2 mode2 _stale2 <<<"$(probe "$pv" "$home")"
if [ "$running2" = "1" ]; then
  echo "[aibrowser] 服务就绪："
  describe
  if [ "$mode2" != gui ] && want_gui; then
    echo "[aibrowser] 提示：没拿到面板窗口，代码截图只会是文件内容（没有标签条）。可设 AIBROWSER_GUI=1 重试。" >&2
  fi
  exit 0
fi

echo "[aibrowser] 服务未能就绪。排查建议：" >&2
if [ -n "$home" ] && [ "$home" != "PATH" ]; then
  echo "  1) 确认能执行：node \"$home/bin/pvs.js\" status" >&2
else
  echo "  1) 未找到项目目录：export PVS_HOME=/path/to/aibrowser 后重试" >&2
fi
echo "  2) 该工具需要 Electron（Chromium）；无头模式不需要显示环境" >&2
exit 1
