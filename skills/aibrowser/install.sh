#!/usr/bin/env bash
# 把 aibrowser skill 安装到本机常见的 skill 目录，便于其它 agent 直接发现。
#
# 用法：
#   bash skills/aibrowser/install.sh              # 安装到所有已存在的 skill 目录
#   bash skills/aibrowser/install.sh ~/my/skills  # 安装到指定目录
#
# 采用「符号链接」安装：仓库里的 skill 更新后，安装处自动同步。
set -euo pipefail

skill_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd "$skill_dir/../.." && pwd)"

if [ $# -gt 0 ]; then
  targets=("$@")
else
  # DeepSeek Harness 的加载位置优先（project: .agents/skills / user: ~/.agents/skills）
  candidates=(
    "$project_dir/.agents/skills"
    "$HOME/.agents/skills"
    "$HOME/.dsh/skills"
    "$HOME/.deepseek/skills"
    "$HOME/.codex/skills"
    "$HOME/.codefree-cli/skills"
    "$HOME/.claude/skills"
  )
  targets=()
  for c in "${candidates[@]}"; do
    # 已存在的 skill 目录一律安装；另外始终创建项目级与用户级 .agents/skills
    if [ -d "$c" ] && [ ! -L "$c" ]; then
      targets+=("$c")
    fi
  done
  targets+=("$project_dir/.agents/skills" "$HOME/.agents/skills")
fi

# 记录路径：符号链接安装时脚本无法靠「向上查找」反推项目目录
env_file="$HOME/.aibrowser-skill.env"
cat > "$env_file" <<ENV
# 由 AIBrowser skill 的 install.sh 生成，供 skill 脚本解析项目位置
PVS_HOME="$project_dir"
ENV
echo "[aibrowser] 已记录路径到 $env_file"

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
  ln -s "$skill_dir" "$dest"
  echo "  ✓ $dest -> $skill_dir"
done

cat <<MSG

[aibrowser] 安装完成。使用前建议确认一次：

  export PVS_HOME="$project_dir"      # 或 cd "$project_dir" && npm link
  bash "$skill_dir/scripts/ensure-service.sh"

之后其它 agent 调用本 skill 时，用 scripts/pvs.sh 作为 CLI 入口即可。
MSG
