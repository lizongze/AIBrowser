# AIBrowser · AI Agent 使用说明

你（AI / Agent）可以用它**查看网页的真实 Chromium 渲染结果**并与之交互：
打开本地 HTML 或 URL → 等页面稳定 → 取渲染后的文本/HTML → 执行 JS → 截图 → 读控制台报错。
也支持**代码高亮预览**（40+ 语言）与**读取/写入文件**。

渲染引擎是 Chromium（与浏览器一致），所以「看起来对不对」可以用截图验收，不需要靠猜。

---

## 0. 一句话上手

> 下面所有示例用 `$P` 代表**自带应用**的入口，不需要 node / npm：
>
> ```bash
> P="<skill>/scripts/pvs.sh"     # 自带应用（等价于 bundle/<平台>-<架构>/pvs）；开发环境可换成 node bin/pvs.js
> ```


**起服务**：第一次真正用 `pvs` 干活（`open` / `shot` / `code` …）时会**自动拉起**服务（安装时不弹窗）；
想自己控制时机/模式再用 `pvs serve --gui --json` —— 默认**拉起即返回**（不等就绪），
随后用 `pvs status --json` 确认 `running:true`；想要「等就绪再返回」加 `--wait`。
skill 的 `scripts/ensure-service.sh`（Windows：`scripts/serve.ps1`）就是「拉起 + 轮询 + 清残留状态」。

**先装好它**：本文件所在 skill 若是「自带应用」的包（目录里有 `bundle/<平台>-<架构>/`），
解压后 `cp -r aibrowser ~/.agents/skills/` 就能用，不需要 node/npm；
有本项目仓库时优先看 `dist-skill/aibrowser-skill-*-<平台>-<架构>.tar.gz`，
没有才 `npm install && npm run build && npm run skill -- --platforms <平台>`。
完整步骤（平台探测、三种情况、Windows/Git Bash）见 `skills/aibrowser/SKILL.md` 的「第 0 节：先装好它」。

```bash
$P open ./path/to/index.html --root ./path/to/project    # 打开
$P content --selector "#main"                            # 取渲染后文本
$P eval "document.title"                                 # 执行 JS
$P shot --out /tmp/page.png --full-page                  # 截图
$P console                                               # 读报错
$P stop                                                  # 收工
```

**没有实例也能用**：第一条命令会自动拉起一个无头守护进程，之后所有命令复用它（第二次起几乎零延迟）。

---

## 1. 输出与退出码约定

| 项 | 约定 |
| --- | --- |
| stdout | **只有结果**。默认就按场景选好了格式：非终端（被管道/重定向捕获，AI 常用）→ **单行 JSON**；终端里 → 人读文本。`--json` / `--text`（`--human`）或 `AIBROWSER_FORMAT=json\|text` 可强制 |
| skill 包装脚本 | `skills/aibrowser/scripts/pvs.sh` 一律注入 `--json`（哪怕 agent 跑在伪终端里），要人读加 `--text` |
| stderr | 日志、进度、错误提示（`[pvs] …`）。不要把 stderr 当结果解析 |
| 退出码 | `0` 成功 / `1` 失败 / `2` 用法错误 |
| 成功 JSON | `{"ok":true,...}`（`open` 带 `sessionId` / `url` / `kind` / `title`） |
| 失败 JSON | `{"ok":false,"error":"…","code":"ENOSESSION"}` |

常见 `code`：`ENOSESSION`（没有可用会话，先 open）、`ENOTALLOWED`（路径不在已授权根目录内，加 `--root`）、
`ENOUNREACHABLE`（控制入口连不上，先 `pvs serve`）、`EUSAGE`（用法错误）。

---

## 2. 命令速查

| 命令 | 用途 | 关键参数 |
| --- | --- | --- |
| `pvs open <file\|url>` | 打开网页预览 | `--root <dir>` 授权根目录、`--json` |
| `pvs code <file>` | 打开代码高亮预览 | `--line n`、`--column n` |
| `pvs list` | 列出会话与已打开的项目目录 | `--json` |
| `pvs shot [sessionId]` | 截图 | `--out p.png`、`--full-page`、`--selector css`、`--format png\|jpeg` |
| `pvs content [sessionId]` | 取渲染后的文本或 HTML | `--selector css`、`--html` |
| `pvs eval "<js>"` | 在页面里执行 JS | `--session id` |
| `pvs console [sessionId]` | 读控制台日志 | `--clear` |
| `pvs network [sessionId]` | 网络请求记录 | `--on` / `--off` / `--clear` |
| `pvs reload [sessionId]` | 重新加载 | `--hard`（绕过缓存） |
| `pvs close [sessionId]` | 关闭会话 | `--all` |
| `pvs serve [--gui]` | 起常驻服务（`--gui` 开面板窗口，否则纯无头）；**默认拉起即返回** | `--port n`、`--wait`（等就绪再返回） |
| `pvs status` / `pvs stop` | 控制入口信息 / 关闭服务 | `--json`（`status` 里含当前浏览器身份 `identity`） |
| `pvs tree [dir]` | 列出目录（文件树同一套忽略规则） | `--all` 连 `node_modules`/`.git` 一起列 |
| `pvs debugWatch` | 热重载当前盯着哪些文件 | `--json` |
| `pvs packages` | 按平台挑打包产物（zip / 可执行文件 / sha256） | `--target linux\|win32\|darwin`、`--arch x64\|arm64`、`--json` |

通用参数：`--json`、`--root <dir>`、`--daemon`（强制无头）、`--gui`（强制面板）、`--no-spawn`（不自动拉起）、`--quiet`。

> `sessionId` 可省略 —— 默认作用于「最近打开 / 聚焦」的会话。

---

## 3. 典型任务配方

### 3.0 起服务并确认就绪（通常不用手动做）

第一次真正干活的命令（`open` / `shot` / `code` …）会自己把服务拉起来，无需额外步骤。
想自己控制时机/模式：

```bash
bash <skill>/scripts/ensure-service.sh       # 拉起 + 确认就绪（幂等）

# 或者自己来（serve 拉起即返回，不会卡住调用方）
$P serve --gui --json                        # 没跑就启动；返回 running:false + starting:true（已在启动中则 spawned:false，不重复拉起）
until $P status --json | grep -q '"running":true'; do sleep 0.5; done   # 轮询到就绪（首次解包可能 10-20s）
```

**`serve` 与 `status` 的字段是同一套**（`running` / `starting` / `pid`），不用在 `spawning` / `ready`
之间做翻译：`serve` 拉起来但还没就绪时回 `running:false,starting:true,spawned:true`，已经就绪时回
`running:true,alreadyRunning:true`。

**轮询时看 `starting` / `stuck`**：`"running":true` 才是就绪；`"starting":true` 表示进程已在、通道还没应答，
**继续等就行**（别 `stop`、也别再 `serve` —— 应用是单实例，多敲几次不会更快）；
**等超过 45s** 会变成 `"stuck":true`（进程卡死），这时**再跑一次 `$P serve --gui --json`** 会自动清掉它重来
—— 所以轮询要有上限，不要无限等。`status` 每次都带 `hint`（下一步该做什么），没起来时还带
`logFile` 与 `logTail`（应用日志尾巴），直接看原因，不用去翻目录。

**Windows（PowerShell）**：直接跑 skill 的启动脚本（内部就是「`Start-Process` 拉起应用本体 + 轮询」）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<skill>\scripts\serve.ps1"   # 无头加 -Headless
```

等价的手写版本（源码里走的也是这条路，老包也能用）：

```powershell
$B = "<skill>\bundle\win32-x64"
Start-Process -FilePath "$B\AIBrowser.exe" -ArgumentList "--serve","--gui","--json" -WindowStyle Hidden
for ($i = 0; $i -lt 20; $i++) { Start-Sleep -Milliseconds 500; if ((& "$B\pvs.cmd" status --json) -match '"running":true') { break } }
```

- 已经在跑（`status` 里 `"running":true`）就不用重复启动。
- 不想让它自动起：设 `AIBROWSER_NO_AUTO_START=1`。

### 3.1 改完前端代码自检

```bash
$P open ./index.html --root .
$P console --json            # 先排除报错
$P shot --out /tmp/shot.png  # 再截图确认
```

### 3.2 抓渲染后的数据（DOM 结果，不是原始 HTML）

```bash
$P content --selector ".price" --json
$P eval "[...document.querySelectorAll('.item')].map(e => e.innerText.trim())"
$P content --selector "table" --html
```

### 3.3 定位前端报错

```bash
$P console --json | grep -o '"level":"error"' | wc -l    # 错误条数（不需要 node/jq；也可以交给 agent 直接解析 JSON）
```

### 3.4 查元素真实样式与位置

```bash
$P eval "(() => { const el = document.querySelector('#btn'); const s = getComputedStyle(el); return { text: el.innerText, color: s.color, display: s.display, rect: el.getBoundingClientRect().toJSON() }; })()"
```

### 3.5 等异步渲染完成（避免拿到空内容）

页面是异步渲染的：`open` 之后不要立刻取内容，先轮询等条件成立。

```bash
# 等 #list 至少出现 10 个子项，最多等 6 秒
for i in $(seq 1 20); do
  n=$($P eval "document.querySelectorAll('#list > *').length")
  [ "$n" -ge 10 ] && break
  sleep 0.3
done
```

### 3.6 改文件后靠热重载复验

热重载只盯**当前面板里打开的文件**和**该页面实际引用的本地资源**，改动会在 **0.6s** 内自动刷新预览；
没打开、也没被页面引用的文件改了不会刷新（不会误判，也不会被日志刷屏）。想看清单：`pvs debugWatch --json`。

```bash
# ...编辑 index.html...
sleep 1 && $P eval "document.querySelector('h1').innerText"
```

### 3.7 检查接口请求

```bash
$P network --on
$P reload
$P network --json     # entries: [{method,url,status,resourceType,ok,durationMs}]
```

### 3.8 预览代码文件（高亮，不做网页渲染）

```bash
$P code ./src/app.ts --line 42 --json
# → {"ok":true,"sessionId":"s3","kind":"code","file":"...","language":"typescript"}
```

### 3.9 实战配方：批量截图（面板模式 + 无 AI 水印）

**场景**：用户给一批文件/URL，要求用面板模式截图、不带 AI 水印
（平台会对 `.png` 等落盘文件注入 AIGC 水印，可用 `.png.zip` 中转文件名绕过）。
按下述步骤执行，**不要写死输出路径——问用户要输出目录**（或用用户已指定的）。

**Step 0 — 确认输出目录**

向用户确认截图输出目录（如用户消息里已指明则直接用）。可在目录下加时间戳子目录，
也可直接用用户给的路径。**不要写死 `gen/<时间戳>/`**。

**Step 1 — 确保面板服务运行（GUI 模式）**

```bash
bash <skill>/scripts/ensure-service.sh          # 拉起 + 轮询就绪（幂等；第一次真正干活时也会自动起）
# 或：$P serve --gui --json 然后轮询 $P status --json 到 "running":true
```

代码文件只有 GUI 面板服务才能截到「整块面板」（标签条 + 行号栏），无头服务只能截到纯代码页。

**Step 2 — 清空所有已有 tab（重要！）**

**每次开始批量截图前，先关掉所有已有会话**，避免残留标签干扰：

```bash
$P close --all --json
```

**Step 3 — 逐个截图（`.png.zip` 中转绕水印）**

对每个目标文件，按这个序列执行（**不要循环写脚本，逐个调命令**）：

1. **打开**（`--fresh` 自动关掉上一个面板，面板里始终只有当前文件）：

   ```bash
   $P open <file> --json
   # 从返回 JSON 取 sessionId
   ```

2. **等待**渲染就绪（2~3 秒；HTML 页面偶尔需要更久）。

3. **截图**，落盘用 `.png.zip` 后缀（平台水印 hook 只认真实扩展名，`.zip` 不触发注入）：

   ```bash
   $P shot <sessionId> --out "<输出目录>/001-<文件名>.png.zip" --json
   ```

   - 报「取不到渲染帧」时，等 3 秒重试一次 `shot`。
   - 返回 JSON 里 `source=panel` = 面板截图（正确）；`source=code-page` = 无头模式（需切 GUI）。

4. **改名**回 `.png`（`Rename-Item` 不会触发水印补注）：

   ```powershell
   Rename-Item "<输出目录>/001-<文件名>.png.zip" "001-<文件名>.png"
   ```

重复 Step 3 直到所有文件截图完成。

**Step 4 — 汇总**

全部截完后，列出每张图的文件名、尺寸、source 类型，告知用户输出目录路径。

**常见坑**

| 现象 | 原因与处理 |
| --- | --- |
| 截到旧文件内容 | 开始前没执行 `close --all`，或 open 没加 `--fresh`；清 tab 后重开重截 |
| 报「取不到渲染帧（host=view …）」 | 页面/面板未就绪，等 2-3 秒重试 shot；还不行就重新 open 一次 |
| `source=code-page`（无标签条） | 服务是无头模式，需 `serve --gui` 切 GUI 面板服务重截 |
| 图片有 AI 水印 | 落盘时没走 `.png.zip` 中转；确认 `--out` 路径以 `.png.zip` 结尾 |
| 面板里堆了一排标签 | open 没加 `--fresh`，或没用 `close --all` 预清 |

---

### 3.10 跨平台打包与分发（让 AI 直接选应用文件）

```bash
npm run package:all                   # 三平台 × x64/arm64（Electron 预编译包会自动取）
npm run package:linux                 # 只打 linux（win32 / darwin 同理）
npm run skill:linux                   # 顺手把「skill + 自带应用」也打出来
pvs packages --target win32 --json    # 拿该平台的 zip / 解压后的可执行文件 / sha256
```

产物在 `release/`：每个平台一个 zip（自带 Electron 运行时 + asar 应用），解压即用；
包内还有 `pvs` / `pvs.cmd`，用同一份应用以 Node 模式执行，**目标机器不需要 node / npm / 依赖**。
`release/manifest.json` 的 `pick["<平台>-<架构>"]` 就是给 AI/脚本用的挑选入口（MCP：`browser_packages`）。

- 交叉打包的产物先在目标平台验证：`AIBrowser --smoke-test --headless`（应为 18/18）。
- macOS 未签名：首次打开右键「打开」或 `xattr -dr com.apple.quarantine`；要分发请自行签名公证。
- 共享 `node_modules` 被另一平台 `npm install` 换过时：`npm run build` 会预检并提示补装
  `@esbuild/<平台>-<架构>`；Electron 由 CLI 按平台自动挑（Windows 首选 `node_modules.win*`）。

---

## 4. HTTP API（适合长驻、多次调用）

```bash
$P serve                 # 幂等；已在运行会直接返回信息
STATE="${XDG_RUNTIME_DIR:-$HOME/.aibrowser}/aibrowser/state.json"
PORT=$(node -e "console.log(require('$STATE').port)")
TOKEN=$(node -e "console.log(require('$STATE').token)")
```

所有动作都是 `POST /<action>`，body 为参数 JSON，需请求头 `X-PVS-Token: <token>`。
`GET /health` 与 `GET /sessions` 免鉴权；`GET /screenshot?token=…&format=png` 直接返回图片字节（最省事）。

```bash
curl -s -X POST "http://127.0.0.1:$PORT/open" -H "X-PVS-Token: $TOKEN" \
  -H "content-type: application/json" -d '{"file":"./index.html"}'
curl -s -X POST "http://127.0.0.1:$PORT/content" -H "X-PVS-Token: $TOKEN" \
  -H "content-type: application/json" -d '{"selector":"#main","format":"text"}'
curl -s "http://127.0.0.1:$PORT/screenshot?token=$TOKEN&fullPage=true" -o page.png
```

| 动作 | 参数要点 | 返回 |
| --- | --- | --- |
| `ping` | — | `{pong,pid,mode,version}` |
| `open` | `file` 或 `url`、`root`、`focus` | `{sessionId,url,title,kind}` |
| `openCode` | `file`、`line`、`column` | `{sessionId,kind:'code',language}` |
| `openPath` | `path`（目录自动找 index.html，按类型选网页/代码） | 同上 |
| `list` | — | `{sessions:[…],roots:[…]}` |
| `focus` / `close` | `sessionId`（`close` 支持 `all`） | `{sessionId}` / `{closed}` |
| `reload` | `sessionId`、`hard` | `{sessionId,url}` |
| `navigate` | `sessionId`、`url`/`file`/`back`/`forward` | `{sessionId,url}` |
| `screenshot` | `sessionId`、`format`、`fullPage`、`selector`、`out` | `{filePath,width,height,bytes,dataBase64}` |
| `content` | `selector`、`format:'text'\|'html'` | `{text,length,truncated}` |
| `eval` | `expression` | `{value,type}`（值已序列化为字符串） |
| `console` | `sessionId`、`clear` | `{entries:[{level,text,ts}]}` |
| `network` | `enabled`、`clear` | `{enabled,entries:[…]}` |
| `read` / `save` / `tree` / `roots` | 文件与目录操作 | 结构化结果 |
| `ui` | `view:'code'\|'web'\|'console'` | `{view}`（切换面板视图） |
| `shutdown` | — | 关闭当前实例 |

读写文件不必另开权限，直接走这两个动作：

```bash
curl -s -X POST "http://127.0.0.1:$PORT/read" -H "X-PVS-Token: $TOKEN" \
  -H "content-type: application/json" -d '{"file":"./src/app.ts","maxLength":40000}'
curl -s -X POST "http://127.0.0.1:$PORT/save" -H "X-PVS-Token: $TOKEN" \
  -H "content-type: application/json" -d '{"file":"./src/app.ts","content":"..."}'
```

### GUI 专用调试动作（仅在 `--gui` 实例上有效）

| 动作 | 用途 |
| --- | --- |
| `panelState` | 面板快照：视图、标签、主题、视口宽度、布局上报计数、执行轨迹 |
| `panelEditor` | 编辑器内部状态：`docLines` / `docChars` / `renderedLines` / `viewport` |
| `debugLayout` | 布局对齐自检：`slot`（渲染层报告的槽位）vs `activeViewBounds`（原生视图），可带 `screenshot` |
| `panelAction` | 模拟界面操作：`font-report`（报告各区域实际字体）、`new-tab`、`close-draft`、`toggle-sidebar`、`set-view`、`content-only`、`ui-zoom`、`wheel-zoom`、`open-tree`、`edit-doc`、`save`、`press-escape`、`idle-stats` |

`panelAction` 的价值是**不用鼠标也能驱动界面**，适合端到端验收：

```bash
curl -s -X POST "http://127.0.0.1:$PORT/panelAction" -H "X-PVS-Token: $TOKEN" \
  -H "content-type: application/json" -d '{"action":"open-tree","payload":{"name":"index.html"}}'
```

---

## 5. 自检与验收（改完代码后跑；用自带应用的人不需要这一步）

```bash
npm run smoke     # 无头全链路 18 项：加载 → 取文本 → eval → 控制台 → 截图 → 像素校验 → 身份/EPIPE 兜底
npm run verify    # GUI 端到端 72 项：代码渲染 / 网页渲染 / 文件树 / 热重载范围 / 批量 / 打包清单 / 全屏 / 缩放
```

两者都用**客观证据**判定，而不是「进程起来了就算成功」：
`smoke` 校验截图里真的出现页面上的强调色像素；`verify` 校验编辑器真的渲染出可见行、原生视图与槽位真的对齐。

---

## 6. 注意事项与坑

1. **本地文件必须在已授权根目录内**：`pvs open ./x.html --root .`，或先在面板里打开该文件夹；否则报 `ENOTALLOWED`。
2. **`eval` / `content` / `screenshot` / `network` 只对网页会话有效**：代码预览会话没有网页图层，会返回 `NOSESSION` 与提示。
3. **异步渲染要等**：不要 `open` 完立刻 `content`，先轮询条件（见 3.5）。
4. **`eval` 的返回值是字符串**：结果在页面内序列化后回传，`undefined` / DOM 节点 / 循环引用都不会报错；
   需要结构化数据时让表达式返回对象或 `JSON.stringify(...)`。
5. **`--json` 时 stdout 是干净的单行 JSON**：stderr 单独处理，别混着解析。
6. **截图是物理像素**：宽高 = 逻辑尺寸 × 渲染缩放（WSLg 下默认 1.5x），不要把截图宽高当 CSS 像素用。
7. **无头模式不会弹窗**：使用离屏渲染，适合后台长跑。
8. **面板与无头互斥且单实例**：同一时刻只有一个进程持有控制通道；重复启动会自己退出（不会顶掉正在服务的那个），不需要手工清理。换模式直接 `$P serve --gui` / `$P serve`，它会把不对的先停掉。
9. **`pvs stop` 之后**：下一条命令会自动重新拉起实例，不必手动 `serve`。
10. **页面看到的不是 Electron**：默认自报同版本 Windows Chrome（UA / Client Hints / platform / languages
    四处一致）。要确认真实情况看 `pvs status --json` 的 `identity`；排查时可用 `--native-ua` 关掉伪装。
    这层只改「自报身份」，不碰 `navigator.webdriver`、不伪造指纹。
11. **热重载范围很小**：只盯面板里打开的文件 + 该页面实际引用的资源（`pvs debugWatch` 可查），
    没打开也没被引用的文件改了不会刷新 —— 这是刻意设计，避免日志/构建产物把预览刷成幻灯片。

---

### skill 自带应用（别人只拿 skill 就能用）

`npm run skill -- --platforms <平台>` 会打出「skill + 自带应用」的 tar.gz；
解压后 `cp -r aibrowser ~/.agents/skills/` 即可，不需要项目、node、npm：

```bash
tar -xzf aibrowser-skill-0.1.0-linux-x64.tar.gz
cp -r aibrowser ~/.agents/skills/
bash ~/.agents/skills/aibrowser/scripts/pvs.sh status --json   # 验证（不起服务）
```

`pvs.sh` 的解析顺序：项目目录（`$PVS_HOME` / 安装记录 / 同仓库 / `PATH` 的 pvs）→ **skill 自带 bundle/**。
自带平台按 `uname` 判定（`bundle/linux-x64`、`bundle/win32-x64`、`bundle/darwin-arm64`…），
可用 `AIBROWSER_BUNDLE=<目录>` 指定；清单在 `bundle/manifest.json`，说明在包内 `BUNDLE.md`。

安装时不起服务（面板是 GUI 窗口）；第一次真正干活的命令会自己拉起，所以上面三步之后直接就能用。

---

## 7. 路径与发现

| 项 | 位置 |
| --- | --- |
| 控制信息 | `${XDG_RUNTIME_DIR:-~/.aibrowser}/aibrowser/state.json`（`pid` / `port` / `socket` / `token`） |
| 控制 socket | 同目录 `control.sock`（NDJSON：`{"id","action","params"}` → `{"id","ok","result"}`） |
| 用户偏好 | 同目录 `config.json`（界面缩放、主题、侧栏状态） |
| 环境变量 | `AIBROWSER_RUNTIME`、`AIBROWSER_PORT`、`AIBROWSER_TOKEN`、`AIBROWSER_SCALE`、`AIBROWSER_WSLG_SCALE=0`；**旧前缀 `PREVIEW_STUDIO_*` 仍然兼容**（新前缀优先） |

架构与完整接口契约见 `docs/CONTRACT.md`；项目能力总览见 `README.md`；
显示质量 / 字体 / 缩放 / Windows 原生运行等环境相关事项见 `docs/NOTES.md`。