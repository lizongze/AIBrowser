#!/usr/bin/env bash
# AIBrowser skill 的 CLI 包装脚本：找到 AIBrowser，并把命令转交给它的 pvs CLI。
# 解析逻辑见同目录的 resolve-home.sh（支持 $PVS_HOME / 安装记录 / 同仓库副本 / PATH）。
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -L)"
# shellcheck source=./resolve-home.sh
. "$script_dir/resolve-home.sh"

if home="$(resolve_aibrowser_home)"; then
  if [ "$home" = "PATH" ]; then
    exec pvs "$@"
  fi
  exec node "$home/bin/pvs.js" "$@"
fi

cat >&2 <<'MSG'
[aibrowser-skill] 找不到 AIBrowser 项目目录。任选一种方式解决：
  1) export PVS_HOME=/path/to/aibrowser      # 指向含 bin/pvs.js 的项目目录
  2) bash <skill>/install.sh                 # 重新安装（会记录路径到 ~/.aibrowser-skill.env）
  3) cd /path/to/aibrowser && npm link       # 把 pvs 装进 PATH
MSG
exit 1
