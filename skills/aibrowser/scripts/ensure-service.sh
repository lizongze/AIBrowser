#!/usr/bin/env bash
# 确保 AIBrowser 后台服务就绪（幂等）。
# Agent 首次使用本 skill 时执行一次即可；之后所有命令都复用这个服务。
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -L)"
pv="$script_dir/pvs.sh"
# shellcheck source=./resolve-home.sh
. "$script_dir/resolve-home.sh"
# 供 Python 判定状态用（避免依赖 jq）
is_running() {
  python3 - "$@" <<'PY' 2>/dev/null
import json, subprocess, sys
cmd = sys.argv[1:]
try:
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=25).stdout.strip()
    data = json.loads(out.splitlines()[-1])
    sys.exit(0 if data.get('running') else 1)
except Exception:
    sys.exit(1)
PY
}

if is_running "$pv" status --json; then
  echo "[aibrowser] 服务已在运行："
  "$pv" status 2>/dev/null | head -4 || true
  exit 0
fi

echo "[aibrowser] 启动无头服务 ..."
"$pv" serve --json >/dev/null 2>&1 || "$pv" serve >/dev/null 2>&1 || true

if is_running "$pv" status --json; then
  echo "[aibrowser] 服务就绪："
  "$pv" status 2>/dev/null | head -4 || true
  exit 0
fi

home="$(resolve_aibrowser_home || true)"
echo "[aibrowser] 服务未能就绪。排查建议：" >&2
if [ -n "$home" ] && [ "$home" != "PATH" ]; then
  echo "  1) 确认能执行：node \"$home/bin/pvs.js\" status" >&2
else
  echo "  1) 未找到项目目录：export PVS_HOME=/path/to/aibrowser 后重试" >&2
fi
echo "  2) 该工具需要 Electron（Chromium）；无头模式不需要显示环境" >&2
exit 1
