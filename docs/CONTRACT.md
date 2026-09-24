# AIBrowser — 架构与接口契约（v0.1，实现以此为准）

一个 **Electron（Chromium 内核）预览工具**：`GUI 面板` + `无头渲染守护进程` + `本地控制 API / CLI`（给 AI 与脚本调用）。
所有能力（开网页、开代码、截图、取 DOM 文本、执行 JS、读控制台）在 GUI 与无头模式下**完全一致**。

## 1. 进程模型

- 一个 Electron 进程 = 一个「控制器」。它监听：
  - **Unix socket**（Windows 为命名管道）`<runtimeDir>/control.sock` — CLI 控制入口，协议为 **NDJSON**（每行一个 JSON 请求，每行一个 JSON 响应）。
  - **HTTP** `127.0.0.1:<port>` — 同样能力的 REST 入口，端口写在 `<runtimeDir>/state.json`。
- 首个进程绑定 socket；后到进程发现 socket 已被占用时**不会接管**（返回 `existing:true`，只有显式 `--takeover` 才请旧实例退出），也不会覆盖 `state.json` —— 状态文件只由真正持有通道的那个实例写。
- 每个进程把 `state.json` 写成：
  ```json
  { "pid": 1234, "port": 7411, "socket": "/run/user/1000/aibrowser/control.sock",
    "token": "…", "mode": "gui" | "daemon", "startedAt": 1700000000000 }
  ```
- `<runtimeDir>`：`process.env.AIBROWSER_RUNTIME` > Linux 下 `$XDG_RUNTIME_DIR/aibrowser` > `~/.aibrowser`。
- 端口默认取空闲端口；可用 `AIBROWSER_PORT` 固定，或 `--port` 指定。

## 2. 模块

| 文件 | 职责 |
| --- | --- |
| `src/main/main.js` | 应用引导。CLI 参数（`pvs` 与 `electron .` 共用）；`--headless` 走无头，否则建 GUI 窗口；全局开关：`--no-sandbox`、`--disable-gpu`、`--disable-dev-shm-usage`（WSL/容器必需）。 |
| `scripts/package.mjs` | 跨平台打包：产出 `release/AIBrowser-<版本>-<平台>-<架构>.zip` 与 `release/manifest.json`（平台 → zip / 可执行文件 / sha256），并往包里写 `pvs` / `pvs.cmd` 命令行入口。 |
| `src/main/browser-identity.js` | 对外自报身份：默认同版本 Windows Chrome（UA + UA-CH + `navigator.platform` + `Accept-Language` 一致）；`AIBROWSER_IDENTITY=native` 可关闭。只改自报身份，不做反检测。 |
| `src/main/safe-io.js` | 日志出口：`writeStderr`/`writeStdout` 吞掉「对端已断开」（EPIPE / ERR_STREAM_DESTROYED）；`installCrashGuard()` 把 `uncaughtException` 记到 `<runtimeDir>/aibrowser-crash.log` 而不是弹模态框。 |
| `src/main/watch-scope.js` | 热重载关注的类型白名单（前端/样式/模板/后端/数据接口/测试/配置/文档/资源，9 类 160 种后缀）。 |
| `src/main/panel-shot.js` | 面板截图：切活动标签 + 截整个面板窗口，供控制 API 与批量任务共用（代码会话的原生视图是隐藏的，取不到帧）。 |
| `src/main/preview-session.js` | `PreviewSession`：一个预览网页的 `WebContentsView`。负责加载 URL/文件、`pvs://` 协议、截图、读 DOM、执行 JS、收集控制台日志、文件监听热重载。 |
| `src/main/preview-manager.js` | 会话表：create/get/list/close/closeAll，字号与网络开关，GUI 侧视图寄宿（`attachView`）。 |
| `src/main/file-service.js` | 目录读取、文件读取（文本/二进制判定）、文件树、根目录切换与授权。 |
| `src/main/preview-protocol.js` | 注册 `pvs://` 协议：把本地文件按目录服务出去，并注入「控制台采集 + 热重载」脚本。 |
| `src/main/control/server.js` | socket + HTTP 控制服务，实现第 4 节路由。 |
| `src/main/control/state.js` | `state.json` 读写与探测、探活、socket 绑定/接管。 |
| `src/main/cli/args.js` | `argv` 解析（不含 electron 启动参数）。 |
| `src/main/cli/client.js` | CLI 与 socket 通信（NDJSON、超时、`--json` 输出、文本表格输出）。 |
| `src/main/preload.js` | GUI 渲染进程的 `contextBridge` 通道（见第 6 节）。 |
| `src/renderer/*` | GUI 面板（见第 5 节）。 |
| `bin/pvs.js` | CLI 入口：`#!/usr/bin/env node`，转交 `src/main/cli/index.js`。 |

## 3. 预览协议 `pvs://`

- `pvs://host/<relative/path>`：`host` 是根目录 id（`r1`、`r2`…），路径相对于该根目录；目录自动回退到 `index.html`；HTML 响应注入注入脚本（`<base>` 修正 + 控制台采集 + 热重载 websocket 或轮询）。只有**已授权根目录**下的文件可访问，其它一律 403。
- 相对链接在预览中保持可用（同源），因此本地站点可正常跳转。
- `pvs://` 与 GUI 自己加载的面板页面使用 **partition `persist:pvs`** 的 session，避免与 GUI session 的权限交叉。
- **没有根目录**时（例如直接开 `file.html`），以该文件所在目录为临时根目录（id `rFile`）。

## 4. 控制 API（socket NDJSON 与 HTTP 等价）

请求格式（socket）：`{"id":"1","action":"open","params":{…}}`。HTTP：`POST /<action>`，body 为 `params`，返回 `{"ok":true,"result":…}` 或 `{"ok":false,"error":"…"}`；
`GET /health`、`GET /sessions` 免鉴权；HTTP 需要 `X-PVS-Token: <token>`（AI 从 `state.json` 读取）。

| action | params | result |
| --- | --- | --- |
| `ping` | — | `{pong:true,pid,mode,version}` |
| `open` | `{file?, url?, root?, title?, focus?, sessionId?}` | `{sessionId, url, title, file?, kind:'web'}` |
| `openCode` | `{file, root?, line?, column?}` | `{sessionId, kind:'code', file, language}` |
| `list` | — | `{sessions:[{sessionId,title,url,file,kind,focused,canGoBack,canGoForward}]}` |
| `reload` | `{sessionId, hard?}` | `{sessionId,url}` |
| `close` | `{sessionId}` | `{closed:true}` |
| `screenshot` | `{sessionId?, selector?, fullPage?, format?, quality?}` | `{sessionId,format,width,height,bytes,filePath?,dataBase64?}` |
| `content` | `{sessionId?, selector?, format:'text'\|'html'}` | `{sessionId,text,length,truncated}` |
| `eval` | `{sessionId?, expression, timeoutMs?}` | `{sessionId,value,type,logs}` |
| `console` | `{sessionId?, clear?, since?}` | `{sessionId,entries:[{level,text,ts}]}` |
| `network` | `{sessionId?, enabled?, clear?}` | `{sessionId,enabled,entries:[{method,url,status,resourceType,ok,ts,durationMs}]}` |
| `focus` | `{sessionId}` | `{sessionId}`（GUI 下切换标签；无头下标记 focused） |
| `zoom` | `{sessionId?, factor}` | `{sessionId,factor}` |
| `save` | `{file, content}` | `{file,bytes}`（写本地文件，供 AI 落盘） |
| `roots` | `{root?}` | `{roots:[{id,dir}]}` |
| `shutdown` | — | `{shutdown:true}` |
| `ui` | `{view:'code'\|'web'\|'console', sessionId?}` | `{view}` |

- `sessionId` 缺省时用 **focused 会话**（最后一个 open/focus 的）；无会话时报错 `no session`。
- `screenshot` 默认返回 base64（`dataBase64`），`filePath` 存在时同时落盘并返回路径。
- HTTP 额外：`GET /screenshot?sessionId=…&format=png` 直接返回图片字节（AI 取图最省事）。

## 5. GUI 面板（Codex app 风格）

单窗口、深色、紧凑、等宽字体、1px 分隔线、低饱和高对比。布局：

```
┌ titlebar ── 应用名 · 根目录 chip · 视图切换(code/web/console) · 状态点 ──────┐
├ sidebar (240–360px, 可拖拽) ─┬ main ─────────────────────────────────────────┤
│ 文件树 / 会话列表 / 最近          │ tab strip（多标签 + 末尾「＋」新建，可多个空标签）    │
│                              │ toolbar（地址栏回车打开 / 前进 后退 刷新）           │
│                              │ 内容区：web = WebContentsView 承载的 Chromium 视图 │
│                              │        code = CodeMirror 高亮（只读 + 行号 + 搜索） │
├──────────────────────────────┴───────────────────────────────────────────────┤
│ console drawer（控制台 / 网络 / eval 输入框，可折叠）                            │
└──────────────────────────────────────────────────────────────────────────────┘
```

要点：
- **会话 = 标签**。`open`/`openCode` 都会新增标签；同一个文件重复打开则复用标签。
- 左侧文件树点击行为：`*.html/htm/svg` 默认进 web 预览（可切 code），其它文件进 code 预览。
- 文件树的根目录是**显式且稳定**的：用户点 📂 / 目录名选的目录优先，否则取**第一个用户声明的根目录**。
  根目录分两类：用户声明的（启动目录、`--root`、📂 选的目录）与 `auto` 的（打开项目外文件时只为授权而注册的目录）；
  文件树与切换栏只认声明的那类，`listRoots()` 会带上 `auto` 标记。
  打开文件时主进程会把该文件所在目录也注册成根目录（授权需要），但**树不会跟着跑到子目录里** ——
  多根目录时侧栏顶部会出现根目录切换栏（`#root-bar`），点一下就切；否则展开子目录点个文件就「父级消失、回不去」。
  `panelState.treeRoot` / `treeRows` 暴露当前树根与行数，`panelAction set-tree-root` 可在验收里切换。
- 文件树默认忽略 `node_modules`（含 `node_modules.*` 变体）、`.git`/`.hg`/`.svn`、`.aibrowser`、`dist`/`build`/`.next` 等
  依赖、版本库与构建目录（`IGNORED_DIRS` + `IGNORED_DIR_PATTERNS`，见 `src/main/file-service.js`）；
  `tree` 动作传 `includeIgnored:true`（CLI `pvs tree --all`）可列出全部。
- 文件树高亮用的是**独立的选中状态**（`state.treeSelected`），点击时同步设好并就地改 class，
  不等 `files.read` + 编辑器装载（那会让高亮慢半拍、连点几个文件时还停在旧行）；
  `panelState.treeSelected` / `treeActivePath` 便于验收。
- 代码视图支持：语法高亮、行号、折叠、搜索（`Ctrl+F`）、自动换行；默认即可编辑，`Ctrl+S` 保存（走 `api.save`）。
- 代码区顶部（`.code-head`）固定顺序：`#code-name`（文件名）→ `#code-lang`（语言类型）→ `#code-path`（文件地址）→ 保存状态。
  地址取「最外层根目录」下的相对路径（保留目录层级；根目录下的文件与根目录外的文件直接显示绝对路径），
  因此打开文件时主进程顺带注册的「文件所在目录」根不会把地址压成一个文件名。
  空间不足时按目录段从左侧省略（`…/a/b/file.js`），始终保留文件名一侧；`title` 与 `panelState.codeHead` 给的是完整信息。
- 视图（网页/代码/控制台）不再由工具条切换：打开什么就显示什么；控制台用右侧 ⌨ 图标开关（`Ctrl+J`）；
  ⛶ 图标（`Ctrl+Shift+M`）进入全屏预览：隐藏 `#titlebar` 与 `#toolbar`（`body.content-only`），只留标签条与内容区，`Esc` 退出。
- 视图切换与 `open` 也由控制 API 驱动：AI 调 `open` 时 GUI 立刻出现新标签并聚焦（主进程 → 渲染进程广播事件）。

## 6. preload `contextBridge` 契约（`window.api`）

```ts
interface PreviewApi {
  runtime(): Promise<{ mode:'gui'|'daemon'; port?:number; socket?:string;
                       token?:string; version:string; chrome:string; platform:string }>;

  files: {
    openFolder(p?: { defaultPath?: string }): Promise<{ root: string; id: string } | null>;
    roots(): Promise<Array<{ id: string; dir: string }>>;
    setRoot(dir: string): Promise<{ root: string; id: string }>;
    tree(dir: string): Promise<Array<{ name: string; path: string; dir: boolean;
                                       size?: number; hidden?: boolean; isPreview?: boolean }>>;
    read(path: string): Promise<{ path: string; name: string; size: number; binary: boolean;
                                  text: string; language: string; truncated?: boolean }>;
    write(path: string, text: string): Promise<{ path: string; bytes: number }>;
    stat(path: string): Promise<{ path: string; exists: boolean; dir: boolean; size: number }>;
  };

  sessions: {
    open(p: { file?: string; url?: string; focus?: boolean }): Promise<{ sessionId: string; url: string; title: string }>;
    openCode(p: { file: string; line?: number; column?: number }): Promise<{ sessionId: string; language: string }>;
    list(): Promise<SessionInfo[]>;
    close(sessionId: string): Promise<{ closed: boolean }>;
    focus(sessionId: string): Promise<{ sessionId: string }>;
    reload(sessionId?: string, hard?: boolean): Promise<unknown>;
    navigate(sessionId: string, { url?: string; file?: string }): Promise<{ url: string }>;
    back(sessionId: string): Promise<unknown>;
    forward(sessionId: string): Promise<unknown>;
    zoom(sessionId: string | undefined, factor: number): Promise<{ factor: number }>;
    screenshot(p: { sessionId?: string; format?: 'png'|'jpeg'; fullPage?: boolean }):
      Promise<{ dataBase64: string; width: number; height: number; format: string }>;
    console(p: { sessionId?: string; clear?: boolean }): Promise<{ entries: ConsoleEntry[] }>;
    network(p: { sessionId?: string; enabled?: boolean; clear?: boolean }): Promise<{ entries: NetworkEntry[] }>;
    eval(p: { sessionId?: string; expression: string }): Promise<{ value: string; type: string }>;
  };

  ui: {
    setView(view: 'code'|'web'|'console'): Promise<{ view: string }>;
    layout(p: { tabsTop: number; bodyWidth: number; bodyHeight: number; viewLeft: number;
                viewTop: number; viewWidth: number; viewHeight: number }): Promise<{ ok: true }>;
    openExternal(url: string): Promise<{ ok: true }>;
    setTheme(theme: 'dark' | 'light'): Promise<{ theme: string }>;
  };

  on(event: 'files:changed'|'sessions:updated'|'ui:view'|'console:entry'|'log',
     cb: (payload: any) => void): () => void;   // 返回取消订阅函数
}
```

- `SessionInfo = { sessionId, title, url, file, kind:'web'|'code', focused, canGoBack, canGoForward, loading }`
- `ConsoleEntry = { level:'log'|'warn'|'error'|'info'|'debug'; text; ts }`
- `NetworkEntry = { method, url, status, resourceType, ok, ts, durationMs }`
- 事件名固定，payload 形状：`files:changed {root}`、`sessions:updated {sessions: SessionInfo[]}`、
  `ui:view {view}`、`console:entry {sessionId, entry}`、`log {level, text}`。

## 7. CLI `pvs`

```
pvs open <file|url> [--root dir] [--new] [--daemon] [--json]
pvs code <file> [--line n] [--json]
pvs list [--json]
pvs shot [sessionId] [--out file] [--format png|jpeg] [--full-page] [--json]
pvs content [sessionId] [--selector css] [--html] [--json]
pvs eval "<js>" [--session id] [--json]
pvs console [sessionId] [--clear] [--json]
pvs network [sessionId] [--on|--off] [--clear] [--json]
pvs reload [sessionId] [--hard] [--json]
pvs close [sessionId|--all] [--json]
pvs serve [--port n] [--gui] [--json]     # 常驻守护进程（--gui = 开面板窗口）
pvs stop [--json]
pvs status [--json]                       # 输出 state.json 摘要 + health
```

- 目标进程选择：默认「**连通优先**」——读 `state.json`，探活成功就用它（GUI 或 daemon 皆可）；探活失败则 `spawn` 一个 detach 的无头 daemon，等就绪后执行。
- `--daemon`：强制忽略现有 GUI，另起无头会话；`--gui`：强制在 GUI 里操作（无 GUI 则启动 GUI）。
- 输出：默认人类可读（含 `sessionId`、URL、尺寸）；`--json` 输出**单行 JSON**（stdout 干净，日志走 stderr），退出码 `0` 成功 / `1` 失败 / `2` 用法错误。
- 环境变量：`AIBROWSER_RUNTIME`、`AIBROWSER_PORT`、`AIBROWSER_TOKEN`、`AIBROWSER_NO_SPAWN=1`（禁止自动拉起进程）。

## 7.4 字体渲染

主进程默认附加 `--disable-lcd-text`（灰度抗锯齿，与 Chrome 一致）+ `--font-render-hinting=medium`；
CSS 侧不设 `-webkit-font-smoothing`，使用 `text-rendering: geometricPrecision` 并关闭连字，
避免等宽字体上的重影。量化自检：文字边缘最大通道差应 < 30（可用 `scripts/panel-check.cjs` 的思路采样）。

## 7.5 渲染缩放

WSLg 下 Chromium 报告的 devicePixelRatio（2.25）大于 Windows 桌面缩放（常见 150%），
`src/main/display-scale.js` 提供观测与建议值，主进程默认套用 **1.5x**；
`--scale-factor` / `AIBROWSER_SCALE` 显式覆盖，`AIBROWSER_WSLG_SCALE=0` 关闭。
截图（`capturePage`）输出的是物理像素 = 逻辑尺寸 × 缩放系数。

## 8. 无头渲染与截图

- 无头会话用 `BrowserWindow({ show:false, webPreferences:{ offscreen:false } })`，等 `did-finish-load` + `requestAnimationFrame` 稳定后再 `capturePage()`，避免拍到白屏。
- `fullPage`：调 `webContents.executeJavaScript` 拿 `document.documentElement.scrollHeight`，临时 `setContentSize` 后截图，再还原。
- `--smoke`：启动无头、开一个本地测试页、`eval` + 截图，退出码反映结果（供 CI 与 AI 自检）。

> 显示质量、字体、渲染缩放、Windows 原生运行等环境相关事项见 `docs/NOTES.md`。
