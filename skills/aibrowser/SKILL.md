---
name: "aibrowser"
description: "Open local web pages or code files in a real Chromium engine and inspect them: extract rendered DOM text/HTML, run JavaScript in the page, take screenshots (full page or by CSS selector), read console errors and network requests. Use when the user asks to preview/verify a web page, check what a local HTML file looks like, screenshot a site or component, scrape rendered content, debug front-end errors, or read/render a code file."
---

# AIBrowser — 用真实 Chromium 打开网页/代码并截图

把「浏览器」做成可编程能力：打开本地 HTML 或 URL → 取渲染后的内容 → 执行 JS → 截图 → 读报错。
渲染引擎是 Chromium，所以「看起来对不对」可以用截图验收，不需要猜。

## 何时使用

- 用户要求**预览/确认**一个网页或本地 HTML 的渲染效果
- 需要**渲染后**的文本或 HTML（不是原始源码，而是执行 JS 之后的 DOM）
- 需要**截图**（整页、可视区、或某个 CSS 选择器对应的元素）
- 需要**定位前端报错**（console error、运行时异常、请求失败）
- 需要**读取/高亮**某个代码文件的内容

## 前置条件（一次即可）

```bash
npm install && npm run build        # 在 AIBrowser 项目目录内
npm link                            # 可选：把 pvs 装到 PATH，之后可直接用 pvs
bash scripts/ensure-service.sh      # 确保后台服务已就绪（幂等，见下）
```

**如何找到 AIBrowser 项目**：本 skill 目录下的 `scripts/pvs.sh` 会自动解析，顺序为
`$PVS_HOME` → `$AIBROWSER_HOME` → 同仓库内的副本 → `PATH` 里的 `pvs`。
若都找不到，向用户询问项目路径并设置 `export PVS_HOME=/path/to/aibrowser`。

## 核心命令

所有命令都支持 `--json`（**单行 JSON，直接可解析**）。stdout 只有结果，stderr 只有日志。

```bash
P=scripts/pvs.sh          # 本 skill 的包装脚本，等价于 pvs

# 打开（--root 授权项目目录，本地文件的相对资源才能加载）
$P open ./index.html --root . --json
$P open https://example.com/ --json

# 取渲染后的内容
$P content --selector "#main" --json          # 该元素的可见文本
$P content --selector "table" --html --json   # 该元素的 outerHTML
$P content --json                             # 整页可见文本

# 在页面里执行 JS（结果序列化成字符串）
$P eval "document.querySelectorAll('tr').length"
$P eval "[...document.querySelectorAll('.item')].map(e => e.innerText.trim())"

# 截图
$P shot --out /tmp/page.png --full-page --json
$P shot --selector ".card" --out /tmp/card.png --json

# 排错
$P console --json
$P network --on && $P reload && $P network --json

# 代码文件预览（高亮，不做网页渲染）
$P code ./src/app.ts --line 42 --json
```

## 必须遵守的三条

1. **本地文件先授权目录**：`--root <dir>`（或先用面板打开该目录）。否则报 `ENOTALLOWED`。
2. **异步渲染要轮询等待**，`open` 之后不要立刻取内容：

   ```bash
   for i in $(seq 1 20); do
     n=$($P eval "document.querySelectorAll('#list > *').length")
     [ "$n" -ge 10 ] && break
     sleep 0.3
   done
   ```

3. **不要用 `shot` 判断页面是否加载完**：截图会等页面首帧，但数据抓取要自己轮询条件。

## 错误码与处置

| code | 含义 | 处置 |
| --- | --- | --- |
| `ENOSESSION` | 没有可用会话 | 先 `$P open <file\|url>` |
| `ENOTALLOWED` | 路径不在已授权目录内 | 加 `--root <dir>` |
| `ENOUNREACHABLE` | 控制入口连不上 | `bash scripts/ensure-service.sh` |
| `EUSAGE` | 参数用法错误 | 检查命令拼写与参数 |

## 环境与约定

- **默认无头**：不弹窗口、不需要显示环境；服务首次调用时自动拉起（守护进程）。
- **用完可停**：`$P stop`（下次调用会自动重启）。
- 截图是**物理像素**，尺寸 = 逻辑尺寸 × 渲染缩放，别把它当 CSS 像素用。
- 控制信息在 `${XDG_RUNTIME_DIR:-$HOME}/.aibrowser/state.json`（`port` / `socket` / `token`）。

## 更多

- HTTP API 与全部动作名：见 `references/api.md`（长驻服务、多次调用时更省进程开销）
- 更完整的命令/配方/坑：项目仓库的 `docs/SKILL.md`
