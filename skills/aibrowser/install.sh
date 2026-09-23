#!/usr/bin/env bash
# 把 aibrowser skill 安装到本机常见的 skill 目录，便于其它 agent 直接发现。
#
# 用法：
#   bash skills/aibrowser/install.sh              # 安装到所有已存在的 skill 目录
#   bash skills/aibrowser/install.sh ~/my/skills  # 安装到指定目录
#
# 安装方式：
#   · 项目里的 skill（无 bundle/）→ 符号链接：仓库更新后安装处自动同步；
#   · 自带应用的分发包（有 bundle/）→ **复制**：别人下载的目录删了也不影响已安装的 skill。
#   想强制指定：--copy / --link。
set -euo pipefail

skill_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd "$skill_dir/../.." && pwd)"
mode=""
if [ -d "$skill_dir/bundle" ]; then mode="copy"; else mode="link"; fi
targets_args=()
for arg in "$@"; do
  case "$arg" in
    --copy) mode="copy" ;;
    --link) mode="link" ;;
    *) targets_args+=("$arg") ;;
  esac
done
set -- ${targets_args[@]+"${targets_args[@]}"}

if [ $# -gt 0 ]; then
  targets=("$@")
else
  # DeepSeek Harness 的加载位置优先（project: .agents/skills / user: ~/.agents/skills）
  candidates=(
    "$HOME/.agents/skills"
    "$HOME/.dsh/skills"
    "$HOME/.deepseek/skills"
    "$HOME/.codex/skills"
    "$HOME/.codefree-cli/skills"
    "$HOME/.claude/skills"
  )
  targets=()
  for c in "${candidates[@]}"; do
    # 已存在的 skill 目录一律安装
    if [ -d "$c" ] && [ ! -L "$c" ]; then
      targets+=("$c")
    fi
  done
  targets+=("$HOME/.agents/skills")
  # 项目级目录只在「从仓库里安装」（link 模式）时才装：自带应用的分发包解压位置未必在项目里
  if [ "$mode" = "link" ]; then
    targets+=("$project_dir/.agents/skills")
  fi
fi

# link 模式才记录路径：符号链接安装时脚本无法靠「向上查找」反推项目目录。
# copy 模式（自带应用）不需要项目目录，也就不要写这份记录，免得脚本反而去找仓库。
env_file="$HOME/.aibrowser-skill.env"
if [ "$mode" = "link" ]; then
  cat > "$env_file" <<ENV
# 由 AIBrowser skill 的 install.sh 生成，供 skill 脚本解析项目位置
PVS_HOME="$project_dir"
ENV
  echo "[aibrowser] 已记录路径到 $env_file"
else
  rm -f "$env_file" 2>/dev/null || true
  echo "[aibrowser] 自带应用模式（copy）：不写 $env_file，脚本会用 skill 内的 bundle/"
fi

echo "[aibrowser] skill 源目录: $skill_dir"
echo "[aibrowser] 项目目录    : $project_dir"

for t in "${targets[@]}"; do
  mkdir -p "$t"
  dest="$t/aibrowser"
  if [ -L "$dest" ]; then
    rm -f "$dest"
  elif [ -e "$dest" ]; then
    echo "  ! $dest 已存在且不是符号链接，跳过（请手动处理）"
    continue
  fi
  if [ "$mode" = "copy" ]; then
    cp -R "$skill_dir" "$dest"
    echo "  ✓ $dest（复制，含自带应用）"
  else
    ln -s "$skill_dir" "$dest"
    echo "  ✓ $dest -> $skill_dir"
  fi
done

cat <<MSG

[aibrowser] 安装完成（$mode 模式）。使用前建议确认一次：

  bash "$skill_dir/scripts/ensure-service.sh"

之后其它 agent 调用本 skill 时，用 scripts/pvs.sh 作为 CLI 入口即可。
$(if [ "$mode" = "link" ]; then echo "（开发模式：脚本走项目目录 $project_dir；改了代码 ensure-service.sh 会自动重启服务）"; else echo "（自带应用：脚本用 skill 内 bundle/ 里的 AIBrowser，不需要项目、node、npm）"; fi)
MSG
