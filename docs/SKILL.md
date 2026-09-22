# Preview Studio · 给 AI Agent 的使用说明

你（AI）可以用这个工具**查看网页的真实渲染结果**：打开本地 HTML/URL → 等加载 → 取文本/HTML → 执行 JS → 截图 → 读控制台报错。
它基于 Chromium，渲染结果与浏览器一致，适合做「改完代码看一眼效果」「抓取渲染后数据」「定位前端报错」这类工作。

## 最快路径（无需 GUI、无需人看着）

```bash
# 1) 打开页面（没有实例会自动拉起无头守护进程；--root 指定项目根目录以便访问本地资源）
node bin/pvs.js open ./path/to/index.html --root ./path/to/project

# 2) 等页面稳定（可选：确认没有致命报错）
node bin/pvs.js console

# 3) 取渲染后的文本 / HTML
node bin/pvs.js content                       # 整页可见文本
node bin/pvs.js content --selector "#main"    # 局部文本
node bin/pvs.js content --selector "table" --html
node bin/pvs.js content --json                # 结构化输出，含 title/url/length

# 4) 在页面里执行 JS（结果自动序列化成字符串）
node bin/pvs.js eval "document.querySelectorAll('tr').length"
node bin/pvs.js eval "[...document.querySelectorAll('.item')].map(e => e.innerText.trim())"

# 5) 截图（视觉确认的唯一可靠方式）
node bin/pvs.js shot --out /tmp/page.png --full-page
node bin/pvs.js shot --selector ".card" --out /tmp/card.png

# 6) 用完收工
node bin/pvs.js stop
```

约定：
- **stdout 是结果，stderr 是日志**：加 `--json` 得到单行 JSON（`{"ok":true,...}` 或 `{"ok":false,"error":"..."}`）。
- 退出码：`0` 成功 / `1` 失败 / `2` 用法错误。
- `sessionId` 可省略 —— 默认作用于最近打开/聚焦的会话。

## 常用组合

```bash
# 检查前端是否有报错
node bin/pvs.js console --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const e=JSON.parse(s).result.entries.filter(x=>x.level==='error');console.log(e.length?e:'没有错误')})"

# 抓取接口请求（页面内 fetch 与页面加载都会记录）
node bin/pvs.js network --on
node bin/pvs.js reload
node bin/pvs.js network

# 看某个 DOM 元素长什么样（含样式命中）
node bin/pvs.js eval "(() => { const el = document.querySelector('#btn'); const s = getComputedStyle(el); return { text: el.innerText, color: s.color, size: s.fontSize, rect: el.getBoundingClientRect().toJSON() }; })()"

# 改代码后自动重载并复验（热重载 0.6s 内生效）
# ...编辑 index.html...
sleep 2 && node bin/pvs.js eval "document.querySelector('h1').innerText"
```

## 直接走 HTTP（长驻服务，适合多次调用）

```bash
node bin/pvs.js serve            # 起无头服务（幂等；已在运行会直接返回信息）
STATE="${XDG_RUNTIME_DIR:-$HOME/.preview-studio}/preview-studio/state.json"
PORT=$(node -e "console.log(require('$STATE').port)")
TOKEN=$(node -e "console.log(require('$STATE').token)")

curl -s -X POST "http://127.0.0.1:$PORT/open" -H "content-type: application/json" \
  -H "X-PVS-Token: $TOKEN" -d '{"file":"./index.html"}'
curl -s -X POST "http://127.0.0.1:$PORT/eval" -H "X-PVS-Token: $TOKEN" \
  -H "content-type: application/json" -d '{"expression":"document.title"}'
curl -s "http://127.0.0.1:$PORT/screenshot?token=$TOKEN&fullPage=true" -o page.png
curl -s "http://127.0.0.1:$PORT/health"     # 免鉴权
```

完整动作表见 `docs/CONTRACT.md` 第 4 节。

## 界面提示

- 打开文件即显示对应视图（HTML/SVG → 网页，其它 → 代码高亮），没有视图切换按钮。
- 控制台（含页面报错）用标题栏右侧的 ⌨ 图标打开，等价命令：`pvs console`。
- 代码视图默认可编辑、自动换行；面板内 `Ctrl+S` 保存。
- ⛶ 图标 / `Ctrl+Shift+M` 进入全屏预览（隐藏标题栏与工具栏），`Esc` 退出；`panelAction` 的 `content-only` 可程序化控制。

## 界面缩放（只看不点也可忽略）

面板界面缩放可用 `Ctrl+滚轮` 调整（60%~300%），会持久化到运行时目录的 `config.json`。

WSLg 下 `devicePixelRatio` 会被报成 2.25，而 Windows 实际是 150%，面板已自动纠正为 1.5x。
截图尺寸因此 = 逻辑尺寸 × 1.5，脚本里不要把截图宽高当成逻辑像素用。

## 注意事项

- 本地文件必须位于**已授权根目录**内：`pvs open ./x.html --root .` 或先在 GUI 里打开该文件夹；否则会报 `ENOTALLOWED`。
- `eval`/`content`/`screenshot`/`network` 只对**网页会话**有效；代码预览会话没有网页图层，会返回 `NOSESSION` 与提示。
- 截图在无头模式使用离屏渲染；极少数环境取不到帧时会自动回退，仍失败再报错。
- GUI 面板与无头守护不能同时持有控制通道：后启动的接管，旧实例退出 —— 不需要手动清理。
- 页面注入脚本会用 `fetch` 上报 console/网络事件到本地控制端口（仅本机回环，带 token 校验）。
