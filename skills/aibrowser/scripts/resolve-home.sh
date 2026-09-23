#!/usr/bin/env bash
# 解析 AIBrowser 的位置，供 pvs.sh / ensure-service.sh 共用。
#
# 两条路：
#   A) skill 自带应用（推荐给只想用 skill 的人）：<skill>/bundle/<平台>-<架构>/ 里有打包好的
#      AIBrowser 与 pvs / pvs.cmd，不需要项目、node、npm。用 resolve_bundle_dir 取。
#   B) 项目目录（开发者）：$PVS_HOME → ~/.aibrowser-skill.env → 逐级向上找 bin/pvs.js → PATH 的 pvs。
#      用 resolve_aibrowser_home 取（返回 "PATH" 表示用命令本身）。
#
# 成功时把绝对路径写到 stdout；失败返回 1。

# 当前平台 key（与 scripts/pack-skill.mjs 生成的 bundle 目录名一致）
bundle_platform_key() {
  local os arch
  case "$(uname -s)" in
    Linux*) os=linux ;;
    Darwin*) os=darwin ;;
    MINGW* | MSYS* | CYGWIN*) os=win32 ;;
    *) os=unknown ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) arch="$(uname -m)" ;;
  esac
  echo "${os}-${arch}"
}

# skill 自带应用目录（没有就返回 1）
resolve_bundle_dir() {
  local skill_dir bundle os
  skill_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -L)"
  # 显式指定优先（同一份 skill 里带了多平台时可以用它切换）
  if [ -n "${AIBROWSER_BUNDLE:-}" ] && [ -d "${AIBROWSER_BUNDLE}" ]; then
    echo "$AIBROWSER_BUNDLE"
    return 0
  fi
  bundle="$skill_dir/bundle/$(bundle_platform_key)"
  if [ -d "$bundle" ]; then
    echo "$bundle"
    return 0
  fi
  # 平台没带全时，退一步：只要目录里只有一个平台，就用它
  if [ -d "$skill_dir/bundle" ]; then
    local dirs=()
    for d in "$skill_dir"/bundle/*/; do [ -d "$d" ] && dirs+=("$d"); done
    if [ "${#dirs[@]}" -eq 1 ]; then
      echo "${dirs[0]%/}"
      return 0
    fi
  fi
  return 1
}

# 自带应用里的命令行入口（Windows 是 pvs.cmd）
bundle_cli() {
  local dir="$1"
  if [ -f "$dir/pvs" ]; then
    echo "$dir/pvs"
    return 0
  fi
  if [ -f "$dir/pvs.cmd" ]; then
    echo "$dir/pvs.cmd"
    return 0
  fi
  return 1
}
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
