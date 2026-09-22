#!/usr/bin/env bash
# 解析 AIBrowser 项目目录，供 pvs.sh / ensure-service.sh 共用。
# 解析顺序：
#   1) $PVS_HOME / $AIBROWSER_HOME（显式指定最优先）
#   2) 安装时写入的 ~/.aibrowser-skill.env（install.sh 生成，解决符号链接安装的情形）
#   3) 从本文件所在目录逐级向上查找含 bin/pvs.js 的目录（skill 与项目同仓库时命中）
#   4) PATH 里的 pvs（npm link 安装）
# 成功时把绝对路径写到 stdout；失败返回 1。
set -uo pipefail

_here() {
  # 注意：这里刻意用 pwd -L（逻辑路径），因为 install.sh 常以符号链接方式安装 skill，
  # 用 pwd（物理路径）会直接跳到真实目录，导致「逐级向上查找」找不到同仓库的项目。
  cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -L
}

is_project() {
  [ -n "${1:-}" ] && [ -f "$1/bin/pvs.js" ] && [ -f "$1/package.json" ]
}

resolve_aibrowser_home() {
  local candidate

  for candidate in "${PVS_HOME:-}" "${AIBROWSER_HOME:-}"; do
    if is_project "$candidate"; then (cd "$candidate" && pwd -L); return 0; fi
  done

  local env_file="${HOME:-}/.aibrowser-skill.env"
  if [ -f "$env_file" ]; then
    # shellcheck disable=SC1090
    . "$env_file" 2>/dev/null || true
    if is_project "${PVS_HOME:-}"; then (cd "$PVS_HOME" && pwd -L); return 0; fi
  fi

  local dir
  dir="$(_here)"
  while [ -n "$dir" ] && [ "$dir" != "/" ]; do
    if is_project "$dir"; then echo "$dir"; return 0; fi
    dir="$(dirname "$dir")"
  done

  if command -v pvs >/dev/null 2>&1; then
    echo "PATH"   # 约定值：调用方用 pvs 命令本身
    return 0
  fi

  return 1
}

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  if home="$(resolve_aibrowser_home)"; then
    echo "$home"
  else
    exit 1
  fi
fi
