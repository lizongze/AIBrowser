# AIBrowser

用 **Chromium 内核**预览网页，用 **CodeMirror 6** 预览代码；GUI 面板与无头渲染共用同一套能力，**AI 可以直接调用**。

- 🖥️ **面板式 GUI**（Electron + 原生 WebContentsView）：**默认全屏**（隐藏标题栏与工具栏，只留标签条）、白天模式、**默认不显示左侧文件树**；标签栏末尾「＋」可连续新建多个空标签；右侧 ⌨ 开关控制台、⛶ 切换全屏。
  文件树的根目录是稳定可切换的：打开文件顺带注册的目录标记为 auto（只为让 `pvs://` 能读到该文件），
  不会进文件树、也不会冒到切换栏上；只有你显式声明的根目录（启动目录 / `--root` / 📂 选的目录）多于一个时，
  侧栏顶部才出现「根目录」切换栏，一键切过去再切回来。
  文件树**默认忽略** `node_modules`（含 `node_modules.win2` 这类变体）、`.git`、构建产物与缓存目录（`pvs tree --all` 可列全）；
  点文件时高亮**立刻**落在点击的那一行，不等文件装载完；切换标签时高亮也跟着当前标签走。
- 🕶️ **浏览器身份**：预览默认对外自报**同版本 Windows Chrome** —— UA、Client Hints（`Sec-CH-UA` / `navigator.userAgentData`）、
  `navigator.platform`、`Accept-Language` 四处一致，不含 `Electron/…` 与 `AIBrowser/…` 标识，
  免得站点看到 Electron 就走特殊分支（禁用能力、弹「请用 Chrome」、拒绝服务）而让预览结果失真。
  只改「自报身份」这一层；要保留原始身份排查问题用 `--native-ua` 或 `AIBROWSER_IDENTITY=native`。
- 🌐 **网页预览**：真正的 Chromium 渲染（不是 iframe 模拟），支持本地 `pvs://` 站点、相对路径 CSS/JS、历史前进后退、缩放、全页截图、按 CSS 选择器截图。
- 🧩 **代码预览**：语法高亮覆盖 40+ 种语言，行号、折叠、自动换行、搜索（`Ctrl+F`），可直接编辑并 `Ctrl+S` 保存。
  代码区顶部依次显示 **文件名 · 语言类型 · 文件地址**（项目内显示相对路径、保留目录层级），全屏截图时一眼能看出这段代码在项目中的位置；空间不足时从左侧按目录段省略，始终保留文件名一侧。
  **代码文件也能截图**：会话内部会把代码渲染成 `pvs://code/` 页面（highlight.js 高亮 + 顶部信息条）再交给 Chromium 截图，GUI 与无头一致。
- 🔁 **热重载（默认开启）**：只盯**面板（tab）里打开的文件 + 该页面真正加载过的本地资源**，每 0.6s 比对一次 mtime+size 指纹（轮询实现，WSL 的 `/mnt/*` 挂载同样可靠）。
  **不扫描项目目录**：没在面板里打开、页面也没引用的文件改了不会触发刷新，所以不会被日志/构建产物刷成幻灯片。
  类型覆盖前端、样式、模板、后端、数据接口、测试、配置、文档、资源共 9 类 160 种后缀（白名单：`src/main/watch-scope.js`），`pvs debugWatch` 可随时查看当前盯着哪些文件。
  点标题栏 ⟳、`Ctrl+Shift+H` 或 `--no-hot-reload` 可关闭。
- 🖨️ **控制台 / 网络**：抓取页面 console、运行时错误、`fetch` 请求；网络记录可按需开启。
- 🤖 **AI 可调用**：`pvs` CLI + 本地 HTTP API + 控制 socket；无头模式可截图、取 DOM 文本、执行 JS —— 不需要有人看着屏幕。
  给 Agent 用的完整说明见 [`docs/SKILL.md`](docs/SKILL.md)（命令速查、API 表、任务配方、常见坑）。

---

## 界面预览

Windows 原生运行下的界面（全屏模式：只留标签条，标题栏与工具栏隐藏）。
截图尺寸 **3072×1876**，与 3072 宽屏幕的物理像素一致：

| JavaScript | CSS |
| --- | --- |
| ![代码预览 · JavaScript](images/code-javascript.png) | ![代码预览 · CSS](images/code-css.png) |

| CLI 实现 | 单文件千行代码 |
| --- | --- |
| ![代码预览 · CLI](images/code-cli.png) | ![大文件代码预览](images/code-large-file.png) |

| Markdown | 网页预览（Chromium 渲染） |
| --- | --- |
| ![Markdown 预览](images/code-markdown.png) | ![网页预览](images/web-preview.png) |

> 代码区使用 Cascadia Code（含编程连字）；界面中文字体优先微软雅黑/苹方/思源黑体。
> 想在 WSL 里获得同样的画质，见 [`docs/NOTES.md`](docs/NOTES.md) 的「在 Windows 原生运行」。

## 打包成各平台应用（给 AI 直接用）

```bash
npm run package                          # 当前平台
npm run package -- --targets all         # linux + win32 + darwin（能下到 Electron 就行）
npm run package -- --targets win32       # 交叉打 Windows 包（复用 node_modules.win* 里的现成 dist，离线可用）
pvs packages --json                      # 列出产物（AI 按平台挑文件）
pvs packages --target win32 --json       # 只挑 Windows 的
```

产物落在 `release/`（已 gitignore）：

```
release/AIBrowser-0.1.0-linux-x64.zip     # 113MB：Electron 运行时 + 应用，解压即用
release/AIBrowser-0.1.0-win32-x64.zip
release/AIBrowser-0.1.0-darwin-arm64.zip
release/manifest.json                     # 每个产物的平台/架构/可执行文件/sha256/说明
```

解压后：`AIBrowser`（GUI 或 `--headless` 服务），另有 `pvs` / `pvs.cmd` 命令行入口 ——
**用同一份应用以 Node 模式执行，不需要目标机器装 node / npm / 依赖**：

```bash
unzip AIBrowser-0.1.0-linux-x64.zip && cd AIBrowser-linux-x64
./AIBrowser                      # 面板窗口
./AIBrowser --headless           # 无头服务
./pvs open ./index.html --root . # 命令行（等价于开发时的 pvs）
./pvs shot --out page.png --json
```

`manifest.json` 就是给 AI/脚本看的清单：`pick["win32-x64"].archive` 直接给出该平台该下哪个包。
MCP 里对应 `browser_packages` 工具，CLI 里对应 `pvs packages`。

> macOS 产物未签名：首次打开需右键「打开」或 `xattr -dr com.apple.quarantine`；要分发给别人请自行签名/公证。
> 交叉打包出来的包请务必在目标平台跑一次自检：`AIBrowser --smoke-test --headless`（应输出 18/18）。

## 快速开始

```bash
npm install          # 安装依赖（Electron + CodeMirror）
npm run build        # 打包渲染层到 dist/
npm start            # 启动面板（默认最大化）
```

首次运行会自动把**当前工作目录**作为项目根目录：文件树里点 `.html`/`.svg` 进网页预览，点其它文件进代码预览。

## 作为 Skill 给其它 Agent 调用

`skills/aibrowser/` 是一份**可分发的 Agent Skill**（标准结构：`SKILL.md` + `scripts/` + `references/`），
让其它 agent 能直接获得「打开网页/代码 → 取渲染结果 → 执行 JS → 截图 → 读报错」的能力。

```bash
node scripts/install-skill.mjs            # 安装到 .agents/skills 与 ~/.agents/skills（npm install 后自动执行）
bash skills/aibrowser/install.sh          # 或安装到本机所有已知 skill 目录
bash skills/aibrowser/scripts/ensure-service.sh   # 确保后台服务就绪（幂等）
```

其它 agent 侧只需要 skill 目录，路径由 `scripts/resolve-home.sh` 自动解析：
`$PVS_HOME` → 安装时记录的 `~/.aibrowser-skill.env` → 同仓库副本 → `PATH` 里的 `pvs`。

```bash
S=<skill目录>/scripts/pvs.sh
$S open ./index.html --root . --json
$S content --selector "#main" --json
$S shot --out /tmp/page.png --full-page --json
```

| 文件 | 作用 |
| --- | --- |
| `SKILL.md` | 触发条件、命令速查、错误码处置（agent 读这一份就够） |
| `scripts/pvs.sh` | CLI 包装：自动找到项目并把命令转交 `pvs` |
| `scripts/ensure-service.sh` | 确保无头服务就绪（幂等，首次调用时自动拉起） |
| `scripts/resolve-home.sh` | 路径解析（支持符号链接安装） |
| `references/api.md` | HTTP API 与全部动作名（长驻服务场景更省开销） |
| `install.sh` | 安装到 `~/.codex/skills`、`~/.codefree-cli/skills` 等已有目录 |

## MCP server（给支持 MCP 的 Agent）

```json
{ "mcpServers": { "aibrowser": {
  "command": "node",
  "args": ["/abs/path/to/aibrowser/bin/aibrowser-mcp.js"],
  "env": { "PVS_HOME": "/abs/path/to/aibrowser" }
} } }
```

stdio 传输，无第三方依赖，暴露 11 个工具：`browser_open` / **`browser_batch`** / `browser_content` /
`browser_eval` / `browser_screenshot` / `browser_console` / `browser_network` / `browser_read_file` /
`browser_write_file` / `browser_sessions` / `browser_health`。

**批量以「列表参数」为一等公民**：`browser_batch({ items: [...], outDir })` 一次传清单，
串行打开并逐项截图，返回结果清单（含截图路径、尺寸、来源、可选文本、控制台报错）。详见 `docs/BATCH.md`。
串行 + **逐个切成活动标签**：面板里始终只有当前这一项，代码文件也能截到面板图
（隐藏的原生视图不产生帧，所以代码项截的是面板；结果里的 `source` 会写明 `panel` / `code-page`）。

## 批量任务（CLI）

```bash
pvs batch --from list.json --out ./shots        # 清单文件（json/txt/csv）
pvs batch https://a.com ./page.html             # 直接给多个目标
pvs batch --dir ./site --ext html               # 收集目录里的 HTML
```

产出 `<out>/report.json`（+ `.jsonl`）与 `NNN-<name>.png`；单项失败不影响其它项。
**Windows 路径可直接传入**（`D:\dir\a.html` 自动转 `/mnt/d/dir/a.html`）。

## GUI 快捷键

| 快捷键 | 作用 |
| --- | --- |
| `Ctrl/Cmd + O` | 打开文件夹（作为项目根目录） |
| `Ctrl/Cmd + B` | 显示/隐藏左侧文件树 |
| `Ctrl/Cmd + T` | 新建标签页（等价于点标签条末尾的「＋」） |
| `Ctrl/Cmd + J` | 开关控制台（也可点标题栏 ⌨ 图标） |
| `Ctrl/Cmd + Shift + M` | 切换全屏预览（**默认开启**）——隐藏标题栏与工具栏，只留标签页；也可点 ⛶ 图标 |
| `Esc` | 退出全屏预览（先关控制台抽屉、再退全屏） |
| `Ctrl/Cmd + 滚轮` | 缩放整个界面（面板与代码字号），也可用菜单里的「界面放大/缩小/重置」 |
| `Ctrl/Cmd + Shift + = / - / 0` | 界面放大 / 缩小 / 重置（60%~300%） |
| `Ctrl/Cmd + Shift + H` | 开关热重载（也可点标题栏 ⟳ 图标）；**默认开启** |
| `Ctrl/Cmd + R` / `Shift+R` | 刷新预览 / 强制刷新（绕过缓存） |
| `Ctrl/Cmd + F` | 代码视图内搜索 |
| `Ctrl/Cmd + S` | 保存当前代码文件 |

## CLI：`pvs`

```bash
node bin/pvs.js <命令>           # 直接用
npm link && pvs <命令>           # 或者安装到 PATH，之后可以直接 pvs
```

| 命令 | 说明 |
| --- | --- |
| `pvs open <file\|url>` | 打开网页预览（HTML / 目录 / URL 自动识别） |
| `pvs code <file> [--line n]` | 打开代码高亮预览 |
| `pvs list` | 列出会话与已打开的项目目录 |
| `pvs shot [id] [--out f.png] [--full-page] [--selector css] [--format png\|jpeg]` | 截图（无头也能截） |
| `pvs content [id] [--selector css] [--html]` | 取渲染后的文本 / HTML |
| `pvs eval "<js>"` | 在页面里执行 JS（结果自动序列化，支持 undefined / DOM / 循环引用） |
| `pvs console [id] [--clear]` | 读取控制台日志 |
| `pvs network [id] [--on\|--off] [--clear]` | 网络请求记录 |
| `pvs reload [id] [--hard]` / `pvs close [id\|--all]` | 刷新 / 关闭会话 |
| `pvs serve [--gui]` / `pvs stop` / `pvs status` | 常驻服务（`--gui` 开面板窗口，否则纯无头）；`--native-ua` 保留 Electron 原始 UA |
| `pvs packages [--target win32\|linux\|darwin] [--json]` | 列出已打包的各平台应用（按平台挑 zip / 可执行文件 / sha256） |

通用参数：`--json`（单行 JSON 输出，便于脚本与 AI 解析）、`--root <dir>`、`--daemon`、`--gui`、`--no-spawn`、`--quiet`。

**没有实例也能用**：直接 `pvs open examples/demo.html` 会按需拉起一个无头守护进程，之后所有命令复用它。

```bash
# 典型无头流程（AI / CI 友好）
pvs open ./site/index.html --root ./site                   # 打开本地站点
pvs eval "document.querySelector('#price').innerText"      # 读取渲染后的数据
pvs shot --out /tmp/check.png --full-page                  # 全页截图
pvs console --json | jq '.entries[] | select(.level=="error")'   # 检查页面报错
pvs stop
```

## HTTP API（无头渲染服务）

`pvs serve` 或任何运行中的实例都会在 `state.json` 暴露端口与令牌：

```bash
STATE="${XDG_RUNTIME_DIR:-$HOME/.aibrowser}/aibrowser/state.json"
PORT=$(jq -r .port "$STATE"); TOKEN=$(jq -r .token "$STATE")

curl -s -X POST "http://127.0.0.1:$PORT/open" \
  -H "content-type: application/json" -H "X-PVS-Token: $TOKEN" \
  -d '{"file":"./examples/demo.html"}'

curl -s -X POST "http://127.0.0.1:$PORT/eval" -H "X-PVS-Token: $TOKEN" \
  -H "content-type: application/json" -d '{"expression":"document.title"}'

curl -s "http://127.0.0.1:$PORT/screenshot?format=png&token=$TOKEN" -o shot.png
curl -s "http://127.0.0.1:$PORT/health"            # 免鉴权健康检查
```

动作清单（socket 与 HTTP 完全等价）：`ping` `open` `openCode` `openPath` `list` `focus` `reload` `close`
`navigate` `screenshot` `content` `eval` `console` `network` `zoom` `save` `read` `tree` `roots` `ui` `shutdown`
以及调试用 `panelState` / `panelEditor` / `panelActions` / `debugLayout`。

## GUI 与无头的关系

- 任何时刻只有一个「控制器」进程持有控制通道；后启动的实例会**接管**（旧实例优雅退出），CLI 永远连到最新那个。
- GUI 里的每个网页标签就是一个原生 `WebContentsView`，位置由渲染层上报的槽位实时对齐（面板尺寸变化、侧栏开关都会重算）。
- 无头会话使用**离屏渲染**；截图优先取 `paint` 帧，取不到时回退 `capturePage`，两条路都不需要显示窗口。

## 验收 / 自检

```bash
npm run smoke     # 无头全链路：本地页面 → 渲染文本 → eval → 控制台 → 截图 → 像素校验
npm run verify    # GUI 端到端：50 项断言，覆盖代码渲染、网页渲染、热重载范围、单面板打开、空标签、全屏、缩放
```

`npm run smoke` 会校验截图里真的出现了页面上的强调色像素，`npm run verify` 会校验编辑器里真的渲染出可见行 —— 避免「看起来起来了其实没渲染」。

## 项目结构

```
bin/pvs.js                  CLI 入口
src/main/
  main.js                   进程引导（GUI / 无头两种模式、菜单、IPC）
  preview-session.js        一个预览会话：加载、截图、eval、控制台、热重载
  preview-manager.js        会话表 + 面板内原生视图寄宿
  preview-protocol.js       pvs:// 本地站点协议 + 注入脚本（日志/热重载）
  file-service.js           根目录授权、文件树、读写
  language.js               扩展名 → 语言识别
  display-scale.js          显示缩放探测（WSLg 场景）
  config.js                 用户偏好持久化（界面缩放等）
  control/server.js         socket + HTTP + WebSocket 控制服务
  control/state.js          控制通道发现（state.json / socket 接管）
  cli/                      pvs 命令解析、客户端、命令实现
  preload.js                contextBridge 通道
src/renderer/               面板 UI（index.html / index.js / styles.css）
scripts/                    构建、端到端验收、面板像素检查
examples/                   示例页面（demo.html / font-compare.html）
skills/aibrowser/           可分发的 Agent Skill（SKILL.md + scripts + references）
docs/CONTRACT.md            架构与接口契约（含完整 API 表）
docs/SKILL.md               给 AI Agent 的使用说明（可直接喂给模型）
docs/NOTES.md               额外说明（显示质量 / 字体 / 缩放 / Windows 原生运行 / 容器兼容）
```

## 常见问题

- **面板里网页区域空着？** 网页是原生视图覆盖在面板槽位上的，不是 DOM；先看状态栏与「控制台」里的加载错误。
- **代码文件打开没内容？** 早期版本在容器隐藏时创建编辑器会渲染 0 行，现已强制重新测量；仍有问题就把 `pvs console` 与 `panelState` 发出来。
- **站点说「不支持当前浏览器」/ 行为跟 Chrome 不一样？** 预览默认已伪装成同版本 Chrome（见上方特性）。
  若仍被区别对待：先用 `pvs status --json` 看当前身份（`identity` 字段），再确认站点是不是在查 `navigator.webdriver`（我们保持 Chromium 默认的 `false`，不做改写）。
  需要 Electron 原始身份时用 `pvs serve --native-ua`。
- **开面板前弹「A JavaScript error occurred in the main process」？** 那是日志写进了已断开的管道（EPIPE）：
  拉起面板的 shell / cmd 退出后，`stderr` 就断了。现在 `pvs serve` 会把子进程日志写到
  `<runtimeDir>/gui.log`（或 `daemon.log`），写不出去的日志直接丢弃，未捕获异常记进
  `<runtimeDir>/aibrowser-crash.log` 而不弹模态框。想恢复弹框调试：`AIBROWSER_CRASH_DIALOG=1`。
- **热重载没反应？** 它只盯**面板里打开的文件**和**该页面实际引用的本地资源**（`pvs debugWatch` 会列出清单）；
  没打开、也没被引用的文件改了不会刷新，轮询间隔 0.6s。
- **想要普通窗口而不是最大化？** `electron . --no-maximize`。
- **显示质量、字体、缩放、Windows 原生运行、容器兼容** → 见 [`docs/NOTES.md`](docs/NOTES.md)

