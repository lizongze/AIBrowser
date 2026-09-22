# AIBrowser · AI Agent 使用说明

你（AI / Agent）可以用它**查看网页的真实 Chromium 渲染结果**并与之交互：
打开本地 HTML 或 URL → 等页面稳定 → 取渲染后的文本/HTML → 执行 JS → 截图 → 读控制台报错。
也支持**代码高亮预览**（40+ 语言）与**读取/写入文件**。

渲染引擎是 Chromium（与浏览器一致），所以「看起来对不对」可以用截图验收，不需要靠猜。

---

## 0. 一句话上手

```bash
node bin/pvs.js open ./path/to/index.html --root ./path/to/project    # 打开
node bin/pvs.js content --selector "#main"                            # 取渲染后文本
node bin/pvs.js eval "document.title"                                 # 执行 JS
node bin/pvs.js shot --out /tmp/page.png --full-page                  # 截图
node bin/pvs.js console                                               # 读报错
node bin/pvs.js stop                                                  # 收工
```

**没有实例也能用**：第一条命令会自动拉起一个无头守护进程，之后所有命令复用它（第二次起几乎零延迟）。

---

## 1. 输出与退出码约定

| 项 | 约定 |
| --- | --- |
| stdout | **只有结果**。加 `--json` 就是**单行 JSON**，可直接 `JSON.parse` |
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
| `pvs serve [--gui]` | 起常驻服务（`--gui` 开面板窗口，否则纯无头） | `--port n` |
| `pvs status` / `pvs stop` | 控制入口信息 / 关闭服务 | `--json` |

通用参数：`--json`、`--root <dir>`、`--daemon`（强制无头）、`--gui`（强制面板）、`--no-spawn`（不自动拉起）、`--quiet`。

> `sessionId` 可省略 —— 默认作用于「最近打开 / 聚焦」的会话。

---

## 3. 典型任务配方

### 3.1 改完前端代码自检

```bash
node bin/pvs.js open ./index.html --root .
node bin/pvs.js console --json            # 先排除报错
node bin/pvs.js shot --out /tmp/shot.png  # 再截图确认
```

### 3.2 抓渲染后的数据（DOM 结果，不是原始 HTML）

```bash
node bin/pvs.js content --selector ".price" --json
node bin/pvs.js eval "[...document.querySelectorAll('.item')].map(e => e.innerText.trim())"
node bin/pvs.js content --selector "table" --html
```

### 3.3 定位前端报错

```bash
node bin/pvs.js console --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const e=JSON.parse(s).result.entries.filter(x=>x.level==='error');console.log(e.length?e:'没有错误')})"
```

### 3.4 查元素真实样式与位置

```bash
node bin/pvs.js eval "(() => { const el = document.querySelector('#btn'); const s = getComputedStyle(el); return { text: el.innerText, color: s.color, display: s.display, rect: el.getBoundingClientRect().toJSON() }; })()"
```

### 3.5 等异步渲染完成（避免拿到空内容）

页面是异步渲染的：`open` 之后不要立刻取内容，先轮询等条件成立。

```bash
# 等 #list 至少出现 10 个子项，最多等 6 秒
for i in $(seq 1 20); do
  n=$(node bin/pvs.js eval "document.querySelectorAll('#list > *').length")
  [ "$n" -ge 10 ] && break
  sleep 0.3
done
```

### 3.6 改文件后靠热重载复验

同目录下的 `html/css/js/json/svg/md` 改动会在 **0.6s** 内自动刷新预览。

```bash
# ...编辑 index.html...
sleep 1 && node bin/pvs.js eval "document.querySelector('h1').innerText"
```

### 3.7 检查接口请求

```bash
node bin/pvs.js network --on
node bin/pvs.js reload
node bin/pvs.js network --json     # entries: [{method,url,status,resourceType,ok,durationMs}]
```

### 3.8 预览代码文件（高亮，不做网页渲染）

```bash
node bin/pvs.js code ./src/app.ts --line 42 --json
# → {"ok":true,"sessionId":"s3","kind":"code","file":"...","language":"typescript"}
```

---

## 4. HTTP API（适合长驻、多次调用）

```bash
node bin/pvs.js serve                 # 幂等；已在运行会直接返回信息
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

## 5. 自检与验收（改完代码后跑）

```bash
npm run smoke     # 无头全链路 10 项：加载 → 取文本 → eval → 控制台 → 截图 → 像素校验
npm run verify    # GUI 端到端 31 项：代码渲染 / 网页渲染 / 文件树点击 / 空标签 / 全屏 / 缩放 / 静置无重排
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
8. **面板与无头互斥**：同一时刻只有一个进程持有控制通道，后启动者接管、旧实例退出，不需要手工清理。
9. **`pvs stop` 之后**：下一条命令会自动重新拉起实例，不必手动 `serve`。

---

## 7. 路径与发现

| 项 | 位置 |
| --- | --- |
| 控制信息 | `${XDG_RUNTIME_DIR:-~/.aibrowser}/aibrowser/state.json`（`pid` / `port` / `socket` / `token`） |
| 控制 socket | 同目录 `control.sock`（NDJSON：`{"id","action","params"}` → `{"id","ok","result"}`） |
| 用户偏好 | 同目录 `config.json`（界面缩放、主题、侧栏状态） |
| 环境变量 | `AIBROWSER_RUNTIME`、`AIBROWSER_PORT`、`AIBROWSER_TOKEN`、`AIBROWSER_SCALE`、`AIBROWSER_WSLG_SCALE=0`；**旧前缀 `PREVIEW_STUDIO_*` 仍然兼容**（新前缀优先） |

架构与完整接口契约见 `docs/CONTRACT.md`；项目能力总览见 `README.md`。
