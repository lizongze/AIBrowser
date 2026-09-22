# AIBrowser HTTP API 参考

长驻服务下比反复启动 CLI 更省开销。适用于同一会话里要连续多次操作页面的场景。

## 发现控制入口

服务启动后会写 `state.json`：

```bash
# WSL / Linux
STATE="${XDG_RUNTIME_DIR:-$HOME}/.aibrowser/state.json"
# 或者读取环境变量指定的运行时目录
STATE="${AIBROWSER_RUNTIME:-${XDG_RUNTIME_DIR:-$HOME}/.aibrowser}/state.json"

PORT=$(python3 -c "import json,sys;print(json.load(open('$STATE'))['port'])")
TOKEN=$(python3 -c "import json,sys;print(json.load(open('$STATE'))['token'])")
```

## 调用约定

- 作用入口：`POST http://127.0.0.1:$PORT/<action>`，body 为参数 JSON
- 鉴权：请求头 `X-PVS-Token: $TOKEN`
- 免鉴权：`GET /health`、`GET /sessions`
- 返回：`{"ok":true,"result":{…}}` 或 `{"ok":false,"error":"…","code":"…"}`
- 截图：`GET /screenshot?token=$TOKEN&format=png&fullPage=true` 直接返回图片字节

```bash
curl -s -X POST "http://127.0.0.1:$PORT/open" -H "X-PVS-Token: $TOKEN" \
  -H "content-type: application/json" -d '{"file":"./index.html","root":"."}'

curl -s -X POST "http://127.0.0.1:$PORT/content" -H "X-PVS-Token: $TOKEN" \
  -H "content-type: application/json" -d '{"selector":"#main","format":"text"}'

curl -s "http://127.0.0.1:$PORT/screenshot?token=$TOKEN&fullPage=true" -o page.png
```

## 动作表

| action | 参数 | 返回 |
| --- | --- | --- |
| `ping` | — | `{pong,pid,mode,version}` |
| `open` | `file` 或 `url`、`root`、`focus`、`fresh`（先关掉所有已有面板） | `{sessionId,url,title,kind}` |
| `openCode` | `file`、`line`、`column` | `{sessionId,kind:'code',language}` |
| `openPath` | `path`（目录自动找 index.html，按类型选网页/代码） | 同上 |
| `list` | — | `{sessions:[…],roots:[…]}` |
| `focus` / `close` | `sessionId`（`close` 支持 `all:true`） | `{sessionId}` / `{closed}` |
| `reload` | `sessionId`、`hard` | `{sessionId,url}` |
| `navigate` | `sessionId`、`url`/`file`/`back`/`forward` | `{sessionId,url}` |
| `screenshot` | `sessionId`、`format`、`fullPage`、`selector`、`out` | `{filePath,width,height,bytes,dataBase64,source}`；`source=panel` 表示截的是整块面板（GUI 服务，含标签条），`code-page` 表示无头服务下的代码页渲染（只有文件内容） |
| `content` | `selector`、`format:'text'\|'html'` | `{text,length,truncated}` |
| `eval` | `expression` | `{value,type}`（值是字符串） |
| `console` | `sessionId`、`clear` | `{entries:[{level,text,ts}]}` |
| `network` | `enabled`、`clear` | `{enabled,entries:[{method,url,status,resourceType,ok,durationMs}]}` |
| `read` | `file`、`maxLength` | `{path,size,text,language,binary}` |
| `save` | `file`、`content` | `{file,bytes}` |
| `tree` | `dir`、`includeIgnored`（默认忽略 node_modules/.git 等） | `{dir,entries:[{name,path,dir,size,isPreview,hidden}]}` |
| `roots` | `root` | `{roots:[{id,dir}]}` |
| `ui` | `view:'code'\|'web'\|'console'` | `{view}`（有面板时切视图） |
| `batch` | `items`、`outDir`、`fullPage`、`timeout`、`format` | `{total,succeeded,failed,items:[{index,target,name,ok,image,images,width,height,bytes,source,sessionId}]}`；串行逐项切成活动标签，`source=panel` 表示该项截的是整块面板 |
| `debugWatch` | `sessionId` | `{enabled,entry,files,pageAssets,extraFiles,intervalMs,extensions}`：热重载当前关注哪些文件 |
| `shutdown` | — | 关闭该实例 |

`sessionId` 可省略 —— 默认作用于「最近打开/聚焦」的会话。

## GUI 实例才能用的调试动作

`panelState`（面板快照）、`panelEditor`（编辑器内部状态）、`debugLayout`（原生视图与槽位对齐自检，
可带 `screenshot:true`）、`panelAction`（模拟界面操作，如 `new-tab` / `content-only` / `ui-zoom`）。

## 退出码（CLI）

`0` 成功 · `1` 失败 · `2` 用法错误。错误码见 `SKILL.md` 的表格。
