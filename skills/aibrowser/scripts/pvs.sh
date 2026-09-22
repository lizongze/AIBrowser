#!/usr/bin/env bash
# AIBrowser skill 的 CLI 包装脚本：找到 AIBrowser，并把命令转交给它的 pvs CLI。
# 解析逻辑见同目录的 resolve-home.sh（支持 $PVS_HOME / 安装记录 / 同仓库副本 / PATH）。
#
# 与裸 pvs 的差别：**一条命令 = 一个面板**。
#   open / code 默认加 --fresh：打开新的文件面板前先关掉之前所有面板，
#   避免 AI 连着预览几个文件后堆出一排标签，也让热重载只盯着当前这个文件。
#   想保留多个标签：加 --keep，或 AIBROWSER_KEEP_TABS=1 bash scripts/pvs.sh open ...
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -L)"
# shellcheck source=./resolve-home.sh
. "$script_dir/resolve-home.sh"

args=("$@")
command="${args[0]:-}"
keep="${AIBROWSER_KEEP_TABS:-0}"
for arg in "${args[@]}"; do
  [ "$arg" = "--keep" ] && keep=1
done

# 只有「打开」类命令需要单面板语义；截图 / content / close 等照旧
case "$command" in
  open | code) ;;
  *) keep=1 ;;
esac

if [ "$keep" = "1" ]; then
  final=("${args[@]}")
else
  final=("${args[@]}" --fresh)
fi

if home="$(resolve_aibrowser_home)"; then
  if [ "$home" = "PATH" ]; then
    exec pvs "${final[@]}"
  fi
  exec node "$home/bin/pvs.js" "${final[@]}"
fi

cat >&2 <<'MSG'
[aibrowser-skill] 找不到 AIBrowser 项目目录。任选一种方式解决：
  1) export PVS_HOME=/path/to/aibrowser      # 指向含 bin/pvs.js 的项目目录
  2) bash <skill>/install.sh                 # 重新安装（会记录路径到 ~/.aibrowser-skill.env）
  3) cd /path/to/aibrowser && npm link       # 把 pvs 装进 PATH
MSG
exit 1
