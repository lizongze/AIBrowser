#!/usr/bin/env bash
# 确保 AIBrowser 后台服务就绪（幂等）。Agent 首次使用本 skill 时执行一次即可。
#
# 两种来源都能用：
#   A) skill 自带应用：<skill>/bundle/<平台>-<架构>/（打包好的 AIBrowser + pvs），
#      不需要项目、node、npm —— 别人只拿 skill 时走这条；
#   B) 项目目录：$PVS_HOME / 安装记录 / 同仓库副本 / PATH 里的 pvs（开发时走这条）。
#   A 找不到才用 B，与 pvs.sh 的顺序一致。
#
# 默认优先「面板服务（GUI）」：代码截图只有在 GUI 下才是整块面板（含标签条、行号栏），
# 纯无头服务没有面板窗口，截出来只有文件内容本身（pvs://code/ 代码页）。
#   AIBROWSER_GUI=1  → 强制面板服务
#   AIBROWSER_GUI=0  → 强制纯无头服务（CI / 无显示环境）
# 未显式指定时：有 DISPLAY / WAYLAND_DISPLAY 就用面板服务，否则无头。
#
# 项目目录模式下，服务是常驻进程、跑的是启动那一刻的代码：仓库代码更新后这里会自动重启。
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -L)"
pv="$script_dir/pvs.sh"
# shellcheck source=./resolve-home.sh
. "$script_dir/resolve-home.sh"

# 读一次服务状态，输出：<running> <mode> <stale>
#   running / mode 用 grep + sed 解析 status --json：不依赖 jq / python3，别人拿 skill 就能跑；
#   stale（仓库代码比服务新）只在「有 python3 且用的是项目目录」时才算，算不了就当 0。
probe() {
  local pv_bin="$1" home_dir="$2" out running=0 mode="" stale=0
  out="$("$pv_bin" status --json 2>/dev/null | tail -1 || true)"
  case "$out" in
    *'"running":true'*) running=1 ;;
  esac
  mode="$(printf '%s' "$out" | sed -n 's/.*"mode":"\([^"]*\)".*/\1/p')"
  if [ "$running" = "1" ] && [ -n "$home_dir" ] && [ "$home_dir" != "PATH" ] && [ -d "$home_dir" ] \
    && [ "${AIBROWSER_NO_STALE_CHECK:-0}" != "1" ] && command -v python3 >/dev/null 2>&1; then
    stale="$(python3 - "$home_dir" <<'PY' 2>/dev/null || echo 0
import json, os, sys

home = sys.argv[1]
state_path = os.path.join(os.environ.get('XDG_RUNTIME_DIR') or os.path.expanduser('~'), 'aibrowser', 'state.json')
try:
    started = json.load(open(state_path)).get('startedAt') or 0
except Exception:
    started = 0
stale = 0
if started:
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
print(stale)
PY
)"
    case "$stale" in
      0 | 1) ;;
      *) stale=0 ;;
    esac
  fi
  printf '%s %s %s\n' "$running" "$mode" "$stale"
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
  local mode="$1" i
  # 用 --detach 拉起（立刻返回），再由本脚本轮询 status 确认就绪。
  # 为什么不用阻塞式 serve：agent 的 shell 包装器（无控制台 + 管道的 PowerShell 等）
  # 会在 serve 等待就绪期间一直挂着，表现就是「命令 pending、拿不到回传」。
  if [ "$mode" = gui ]; then
    echo "[aibrowser] 启动面板服务（GUI）..."
    "$pv" serve --gui --detach --json >/dev/null 2>&1 || "$pv" serve --gui --detach >/dev/null 2>&1 || true
  else
    echo "[aibrowser] 启动无头服务 ..."
    "$pv" serve --detach --json >/dev/null 2>&1 || "$pv" serve --detach >/dev/null 2>&1 || true
  fi
}

# 判断这次用的是自带应用还是项目目录
home="$(resolve_aibrowser_home || true)"
using_bundle=""
if [ -z "$home" ]; then
  if bundle="$(resolve_bundle_dir 2>/dev/null)"; then
    using_bundle="$bundle"
    echo "[aibrowser] 使用 skill 自带的应用：$bundle"
  fi
fi

target=daemon
want_gui && target=gui

read -r running mode stale <<<"$(probe "$pv" "$home")"
# 自带应用没有仓库可比，stale 无意义
[ -n "$using_bundle" ] && stale=0

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
    echo "[aibrowser] 服务已在运行（$([ "$mode" = gui ] && echo '面板窗口' || echo '无头服务')）："
    describe
    exit 0
  fi
else
  start "$target"
fi

# 服务是「拉起即返回」的，这里要自己轮询到就绪（最多 20s）
for _i in $(seq 1 40); do
  read -r running2 mode2 _stale2 <<<"$(probe "$pv" "$home")"
  [ "$running2" = "1" ] && break
  sleep 0.5
done
if [ "$running2" = "1" ]; then
  echo "[aibrowser] 服务就绪："
  describe
  if [ "$mode2" != gui ] && want_gui; then
    echo "[aibrowser] 提示：没拿到面板窗口，代码截图只会是文件内容（没有标签条）。可设 AIBROWSER_GUI=1 重试。" >&2
  fi
  exit 0
fi

echo "[aibrowser] 服务未能就绪。排查建议：" >&2
if [ -n "$using_bundle" ]; then
  echo "  1) 确认自带应用可执行：\"$using_bundle/pvs\" status" >&2
elif [ -n "$home" ] && [ "$home" != "PATH" ]; then
  echo "  1) 确认能执行：node \"$home/bin/pvs.js\" status" >&2
else
  echo "  1) 未找到可用的 AIBrowser：这份 skill 里应带 bundle/<平台>-<架构>/；开发时 export PVS_HOME=/path/to/aibrowser" >&2
fi
echo "  2) 该工具需要 Chromium；无头模式不需要显示环境，面板模式需要 DISPLAY / WSLg" >&2
exit 1
