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
| `file` / `url` | 二选一 |
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
2. **一个会话复用**：所有项共用一个预览会话，逐项 `open` 覆盖，避免 N 个 BrowserWindow。
   - 本地文件与 URL 混排时会话会切换类型，仍复用同一个。
3. **等待就绪**：默认等 `did-finish-load`（上限 15s），再按 `waitFor` / `waitMs` 补充等待。
   每项的超时可配 `--timeout`（默认 20000ms），超时记为失败但继续下一项。
4. **失败隔离**：任何一项失败只记入该项结果，不中断批次。
5. **文件名安全化**：把 URL/路径转成 `example-com-docs` 这类名字，去掉 `?query` 与非法字符，
   重复时追加序号。
6. **可只截图不取内容**：默认只截图；需要文本时在项里写 `content`。

## 与 skill 的关系

`skills/aibrowser/SKILL.md` 里把它作为「一次处理多个页面」的推荐入口，
AI 只需一次调用 + 读一份 JSON，比循环调 N 条命令更省 token 与进程开销。
