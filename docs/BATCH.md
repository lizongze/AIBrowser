# AIBrowser 批量任务（batch）设计说明

面向「AI 给一份文件/URL 清单，工具逐个打开并截图」的场景。核心诉求是**串行、可观测、可续跑**。

## 为什么不是让 AI 循环调 N 次命令

| 自己循环 | 用 `pvs batch` |
| --- | --- |
| N 次进程启动（每次 ~1-2s 开销） | 1 次进程，N 次串行会话 |
| 结果散在 N 个 stdout 里，难汇总 | 一份 JSON/JSONL 结果清单 |
| 中途失败要自己重试/记录 | 逐项隔离失败，`errors` 汇总 |
| 截图命名要自己拼 | 统一目录 + 规范化文件名 + index 对照 |

## 输入格式

三种来源，可混用：

```bash
# 1) 直接给多个目标
pvs batch https://a.com https://b.com ./page.html

# 2) 从文件读（.json / .txt / .csv，每行一个；# 开头为注释）
pvs batch --from urls.txt
pvs batch --from items.json

# 3) 给目录：递归收集其中的 HTML 文件
pvs batch --dir ./site --ext html
```

`items.json` 支持逐项选项：

```json
[
  "https://example.com/",
  { "file": "./index.html", "root": ".", "name": "home", "fullPage": true },
  { "url": "https://example.com/docs", "waitFor": "#content", "waitMs": 500, "content": "#main" }
]
```

每项可用字段：

| 字段 | 说明 |
| --- | --- |
| 直接给字符串 | **推荐**：`"https://a.com"` 或 `"./index.html"`，工具自己判断类型 |
| `file` / `url` | 显式指定（需要精确控制时用） |
| `root` | 本地文件的授权根目录（缺省取父目录） |
| `name` | 输出名（缺省由 URL/路径推导，会做文件名安全化） |
| `waitFor` | 等待该 CSS 选择器出现后再截图 |
| `waitMs` | 额外固定等待（毫秒） |
| `fullPage` | 整页截图（**默认 true**） |
| `format` | `png`（默认）或 `jpeg` |
| `content` | 额外提取该选择器的可见文本，写入结果清单 |
| `viewports` | **只有显式给出时才多尺寸**：`[{width,height}, …]`，每项出一张图（文件名带宽度后缀） |
| `viewport` | `{width,height}` 单尺寸（默认 1280×800，主要影响非整页图的宽度） |
| `skip` | 跳过该项（便于临时剔除） |
| `sessionId` | 复用已有会话（给了就不新开面板，也不在批次里关它） |

## 输出

- **默认每项只出一张整页图**（`fullPage: true`），命名 `NNN-<name>.<ext>`；
  只有显式传 `viewports: [{width,height}, …]` 才会按多种尺寸各出一张（`NNN-<name>-<宽>.<ext>`）
- 截图写到 `--out <dir>`（默认 `./aibrowser-shots`）
- 结果清单写到 `--report <file>`（默认 `<out>/report.json` + `.jsonl`）
- stdout 逐项输出 JSONL（AI 可流式解析），stderr 打进度

结果清单结构：

```json
{
  "ok": true,
  "startedAt": 1700000000000,
  "finishedAt": 1700000012345,
  "outDir": "/abs/path/aibrowser-shots",
  "total": 3, "succeeded": 2, "failed": 1, "skipped": 0,
  "items": [
    { "index": 1, "target": "https://example.com/", "name": "example-com",
      "ok": true, "status": 200, "title": "Example Domain", "url": "https://example.com/",
      "image": "/abs/path/aibrowser-shots/001-example-com.png",
      "width": 1280, "height": 800, "bytes": 51200,
      "elapsedMs": 1834, "consoleErrors": 0, "content": null },
    { "index": 3, "target": "./missing.html", "ok": false,
      "error": "路径不存在：./missing.html", "elapsedMs": 12 }
  ],
  "errors": [ { "index": 3, "error": "路径不存在：./missing.html" } ]
}
```

退出码：全部成功 `0`；有失败 `1`（但**结果清单仍然完整写出**，便于续跑）。

## 行为约定

1. **串行**：同一时刻只有一个会话在加载，避免并发抢占 CPU/内存（无头下尤其重要）。
2. **一项一个面板，下一项开始前关掉上一项**：面板（tab）里始终只有「当前这一项」，最后一项保留下来方便直接看。
   传了 `sessionId` 的项不动（调用方的会话归调用方管）。
3. **等待就绪**：默认等 `did-finish-load`（上限 15s），再按 `waitFor` / `waitMs` 补充等待。
   每项的超时可配 `--timeout`（默认 20000ms），超时记为失败但继续下一项。
4. **失败隔离**：任何一项失败只记入该项结果，不中断批次。
5. **文件名安全化**：把 URL/路径转成 `example-com-docs` 这类名字，去掉 `?query` 与非法字符，
   重复时追加序号。
6. **可只截图不取内容**：默认只截图；需要文本时在项里写 `content`。

## 产品模式（GUI）下为什么必须「逐个激活标签」

代码文件在面板里是用 CodeMirror 渲染的：会话内部那个承载 `pvs://code/` 页面的原生
`WebContentsView` 是**隐藏**的，而**隐藏视图不产生帧** —— 直接对它 `capturePage()`
只会一直拿到空帧，直到超时并报「当前环境取不到渲染帧（host=view …）」。
网页会话走的是另一条渲染路径（可见的原生视图），所以同一批次里 HTML 成功、代码文件全挂。

所以批次里对每一项都做两件事（见 `src/main/panel-shot.js`）：

1. **切活动标签**：`setFocus` + 广播 `ui:focus`，再等渲染进程回报「活动会话就是它」；
2. **截面板**：代码项直接截整个面板窗口（标签条 + 行号栏 + 代码区），与手工 `open` + `shot` 一致。

代码项的结果里 `source` 会写明来源：`panel` = 面板截图，`code-page` = 无头模式下的代码页渲染。
要注意面板截图的尺寸由窗口决定：`fullPage` / `viewport` / `viewports` 对面板截图不生效
（那是无头渲染、或网页会话的整页截图才有的能力）。

## 与 skill 的关系

`skills/aibrowser/SKILL.md` 里把它作为「一次处理多个页面」的推荐入口，
AI 只需一次调用 + 读一份 JSON，比循环调 N 条命令更省 token 与进程开销。
