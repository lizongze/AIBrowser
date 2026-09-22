# AIBrowser

用 **Chromium 内核**预览网页，用 **CodeMirror 6** 预览代码；GUI 面板与无头渲染共用同一套能力，**AI 可以直接调用**。

- 🖥️ **面板式 GUI**（Electron + 原生 WebContentsView）：默认最大化、白天模式；文件树默认隐藏（`Ctrl+B` 或左上角 ▥ 切换）；标签栏可连续新建多个空标签（末尾「＋」）；右侧 ⌨ 开关控制台、⛶ 一键全屏（只留标签页）。
- 🌐 **网页预览**：真正的 Chromium 渲染（不是 iframe 模拟），支持本地 `pvs://` 站点、相对路径 CSS/JS、历史前进后退、缩放、全页截图、按 CSS 选择器截图。
- 🧩 **代码预览**：语法高亮覆盖 40+ 种语言，行号、折叠、自动换行、搜索（`Ctrl+F`），可直接编辑并 `Ctrl+S` 保存。
- 🔁 **热重载**：本地 HTML 及其同目录静态资源变化后 0.6s 内自动刷新（轮询实现，WSL 的 `/mnt/*` 挂载同样可靠）。
- 🖨️ **控制台 / 网络**：抓取页面 console、运行时错误、`fetch` 请求；网络记录可按需开启。
- 🤖 **AI 可调用**：`pvs` CLI + 本地 HTTP API + 控制 socket；无头模式可截图、取 DOM 文本、执行 JS —— 不需要有人看着屏幕。
  给 Agent 用的完整说明见 [`docs/SKILL.md`](docs/SKILL.md)（命令速查、API 表、任务配方、常见坑）。

---

## 快速开始

```bash
npm install          # 安装依赖（Electron + CodeMirror）
npm run build        # 打包渲染层到 dist/
npm start            # 启动面板（默认最大化）
```

首次运行会自动把**当前工作目录**作为项目根目录：文件树里点 `.html`/`.svg` 进网页预览，点其它文件进代码预览。

## GUI 快捷键

| 快捷键 | 作用 |
| --- | --- |
| `Ctrl/Cmd + O` | 打开文件夹（作为项目根目录） |
| `Ctrl/Cmd + B` | 显示/隐藏左侧文件树 |
| `Ctrl/Cmd + T` | 新建标签页（等价于点标签条末尾的「＋」） |
| `Ctrl/Cmd + J` | 开关控制台（也可点标题栏 ⌨ 图标） |
| `Ctrl/Cmd + Shift + M` | 全屏预览：隐藏标题栏与工具栏，只留标签页（也可点 ⛶ 图标） |
| `Esc` | 退出全屏预览（先关控制台抽屉、再退全屏） |
| `Ctrl/Cmd + 滚轮` | 缩放整个界面（面板与代码字号），也可用菜单里的「界面放大/缩小/重置」 |
| `Ctrl/Cmd + Shift + = / - / 0` | 界面放大 / 缩小 / 重置（60%~300%） |
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
| `pvs serve [--gui]` / `pvs stop` / `pvs status` | 常驻服务（`--gui` 开面板窗口，否则纯无头） |

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
npm run verify    # GUI 端到端：31 项断言，覆盖代码渲染、网页渲染、热重载、空标签、全屏、缩放
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
docs/CONTRACT.md            架构与接口契约（含完整 API 表）
docs/SKILL.md               给 AI Agent 的使用说明
```

## 常见问题

- **面板里网页区域空着？** 网页是原生视图覆盖在面板槽位上的，不是 DOM；先看状态栏与「控制台」里的加载错误。
- **代码文件打开没内容？** 早期版本在容器隐藏时创建编辑器会渲染 0 行，现已强制重新测量；仍有问题就把 `pvs console` 与 `panelState` 发出来。
- **热重载没反应？** 只关注同目录的 `html/css/js/json/svg/md`，其它目录的改动不触发；轮询间隔 0.6s。
- **想要普通窗口而不是最大化？** `electron . --no-maximize`。
- **字体显示、缩放、Windows 原生运行** → 见下方「额外说明」。

---

# 额外说明

与能力无关的运行环境相关事项，只在遇到时看。

## 在 Windows 原生运行（推荐用于追求显示效果）

在 WSL 里，面板窗口画面要经过 **WSLg 的远程呈现层**（RDP/Weston）送到屏幕，再由 Windows 按屏幕比例合成，
笔画会被二次重采样，观感不如原生 Chrome / 原生应用。

**想要 Chrome 级观感，请在 Windows 侧原生运行**（项目就在同一个目录 `D:\gitData\codefree\aiFlow`，Windows 侧已有 Node）：

```text
双击 start-windows.cmd      # 首次会安装 Windows 版依赖（约 100MB，需联网）
```

WSL 侧仍然适合 **无头模式 / CLI / 给 AI 调用**（`pvs serve`）——这条路径不涉及窗口呈现，画质不受影响。

## 文字大小与清晰度

面板默认关闭 **LCD 亚像素抗锯齿**（`--disable-lcd-text`），与 Chrome 一致使用灰度抗锯齿：开启时实测文字边缘
彩色通道差最高 204（明显彩边），关闭后降到 18。

WSLg 会把 `devicePixelRatio` 报成 **2.25**（偏大），而笔记本屏通常是 **1536 逻辑 / 2304 物理 = 150%**。
因此 WSLg 下会自动把渲染缩放纠正为 **1.5x**：窗口缓冲区约等于屏幕物理像素，呈现层不必再做小数缩放，笔画最锐利
（用 1.25 时还需要一次额外的 1.2 倍重采样，看起来会发虚）。需要调整时：

```bash
electron . --scale-factor 1.25          # 更小
electron . --scale-factor 1.75          # 更大
AIBROWSER_WSLG_SCALE=0 npm start   # 关掉自动纠正，用系统默认
```

启动日志会打印实际生效值，例如 `窗口内容尺寸 1440×768（逻辑像素）· 渲染缩放 1.5x`。
界面内部缩放另有 `Ctrl+滚轮`（60%~300%，持久化到运行时目录的 `config.json`）。

## 关于改名

应用原名为 Preview Studio，现更名为 **AIBrowser**。运行时目录（`$XDG_RUNTIME_DIR/aibrowser`）与
环境变量前缀（`AIBROWSER_*`）都已同步；**旧前缀 `PREVIEW_STUDIO_*` 仍然兼容**，新前缀优先。

## 字体

| 用途 | 字体栈（按优先级） |
| --- | --- |
| 代码 / 地址栏 / 控制台 | **Cascadia Code** → Cascadia Mono → JetBrains Mono → SF Mono → Menlo → Consolas → Ubuntu Sans Mono → DejaVu Sans Mono |
| 界面 / 文件树 / 标题 | **Microsoft YaHei UI** → Microsoft YaHei → PingFang SC → Noto Sans CJK SC → system-ui → Ubuntu Sans → 文泉驿正黑 |

代码区默认开启 **编程连字**（`=>`、`!=`、`>=` 等），Cascadia Code 原生支持。

Linux/WSL 侧若没装这些字体，可从 Windows 复制过来（无需 sudo）：

```bash
mkdir -p ~/.fonts
cp /mnt/c/Windows/Fonts/CascadiaCode.ttf /mnt/c/Windows/Fonts/msyh.ttc ~/.fonts/   # 代码字体 + 中文字体
fc-cache -f ~/.fonts
```

`Cascadia Code`（微软开源）与 `Consolas` 都可自由分发；`msyh.ttc` 仅建议在本机使用，不要随项目分发。

## WSL / 容器兼容

已内置 `--no-sandbox`、`--disable-gpu`、`--disable-dev-shm-usage`，无需手工配置。
字体方面：若 WSL 里缺少中文字体，可把 Windows 字体复制到 `~/.fonts` 后执行 `fc-cache -f`，例如

```bash
mkdir -p ~/.fonts && cp /mnt/c/Windows/Fonts/msyh.ttc /mnt/c/Windows/Fonts/simhei.ttf ~/.fonts/ && fc-cache -f ~/.fonts
```

## 诊断过的非问题（避免重复排查）

| 现象 | 结论 |
| --- | --- |
| 文字像是「重影 / 彩边」 | LCD 亚像素抗锯齿所致，已用 `--disable-lcd-text` 关闭 |
| 打开/关闭 GPU 有区别吗 | 实测截图像素**逐像素相同**（该链路没有 GPU 直通设备 `/dev/dri`） |
| 换字体有用吗 | 有用但不解决根本问题；中文栈已优先微软雅黑/苹方等高质量字体 |
| 缩放 1.0 / 1.25 / 1.5 差异 | 渲染表面始终约 1525px，但报告的 DPR 从 1 变到 2.25 —— 说明呈现层在做缩放 |
| WSLg 暴露的 X 屏 | 4976px 宽，窗口只占其中一块，最终呈现必然经过缩放 |
