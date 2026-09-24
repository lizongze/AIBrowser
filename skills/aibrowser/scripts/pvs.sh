#!/usr/bin/env bash
# AIBrowser skill 的 CLI 包装脚本：找到 AIBrowser，并把命令转交给它的 pvs CLI。
# 顺序：项目目录（$PVS_HOME / 安装记录 / 同仓库副本 / PATH 里的 pvs）→ skill 自带应用 bundle/。
# 前者优先是为了「开发时改了代码立刻生效」；别人只拿到 skill 时前者找不到，自然用自带的 bundle。
# 平台探测与路径规则见同目录的 resolve-home.sh。
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

# 输出格式：这个包装脚本是给 AI 用的 → 一律默认 JSON（哪怕 agent 在一个伪终端里跑，
# 源码里的「非终端才用 JSON」规则判断不出来）。人要看文本显式加 --text / --human，
# 或设 AIBROWSER_FORMAT=text。
want_text=0
for arg in "${args[@]}"; do
  case "$arg" in
    --text | --human | --no-json) want_text=1 ;;
    --json | -j) want_text=2 ;;
  esac
done
case "${AIBROWSER_FORMAT:-}" in
  text | human) [ "$want_text" = "0" ] && want_text=1 ;;
esac

final=("${args[@]}")
[ "$keep" = "1" ] || final+=(--fresh)
[ "$want_text" = "1" ] || final+=(--json)

# 惰性起服务：安装时不弹窗（面板是 GUI 窗口，会打扰用户），第一次真正用到这个 skill 时，
# 若发现还没有运行中的服务，就先拉起（用 ensure-service.sh：会自动选面板/无头、并轮询就绪）。
# 只做「文件不存在」这种零成本判断，不会给每次调用加延迟。
case "$command" in
  '' | stop | serve | status | --help | -h | help) ;;
  *)
    if [ "${AIBROWSER_NO_AUTO_START:-0}" != "1" ]; then
      if [ -n "${XDG_RUNTIME_DIR:-}" ] && [ -d "${XDG_RUNTIME_DIR}" ]; then
        state_file="$XDG_RUNTIME_DIR/aibrowser/state.json"
      else
        state_file="$HOME/.aibrowser/state.json"
      fi
      if [ ! -f "$state_file" ]; then
        echo "[aibrowser] 首次使用：先拉起服务 ..." >&2
        bash "$script_dir/ensure-service.sh" >&2 || true
      fi
    fi
    ;;
esac

# 1) 项目目录（开发者：$PVS_HOME / 安装记录 / 同仓库 / PATH 里的 pvs）
if home="$(resolve_aibrowser_home)"; then
  if [ "$home" = "PATH" ]; then
    exec pvs "${final[@]}"
  fi
  exec node "$home/bin/pvs.js" "${final[@]}"
fi

# 2) skill 自带应用（别人只拿 skill 时走这里：不需要项目、node、npm）
if bundle="$(resolve_bundle_dir)"; then
  if cli="$(bundle_cli "$bundle")"; then
    # 让应用知道「这份 skill 带了哪些平台的应用」（pvs packages 会读它）。
    # 注意清单在 bundle/manifest.json（bundle 的上一层），不在平台目录里。
    export AIBROWSER_BUNDLE_MANIFEST="$(dirname "$bundle")/manifest.json"
    exec "$cli" "${final[@]}"
  fi
fi

cat >&2 <<'MSG'
[aibrowser-skill] 找不到可用的 AIBrowser。任选一种方式解决：
  1) 用自带应用的 skill（推荐）：这份 skill 里应有 bundle/<平台>-<架构>/ 与其中的 pvs / pvs.cmd；
     用 `node scripts/pack-skill.mjs --platforms <平台>` 打一份，或向提供方索取带 bundle 的版本。
  2) export PVS_HOME=/path/to/aibrowser      # 指向含 bin/pvs.js 的项目目录（开发用）
  3) cd /path/to/aibrowser && npm link       # 把 pvs 装进 PATH
MSG
exit 1
