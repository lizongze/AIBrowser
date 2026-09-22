# AIBrowser · 额外说明

与能力无关的运行环境相关事项（显示质量、缩放、容器兼容、历史诊断记录）。

**遇到显示不清晰、字号不对、Windows 该怎么跑这类问题看这里；只想了解功能请看 [README](../README.md)。**

---

## 在 Windows 原生运行

WSL 里的面板窗口要经 **WSLg 的远程呈现层**送到屏幕：应用只能拿到「窗口大小」的画布，
再被 WSLg 缩放到显示器物理分辨率。实测数据（本机 150% / 3072×1920）：

| 项 | 值 |
| --- | --- |
| X11 窗口几何（= `capturePage` 截图尺寸） | **1524 × 927** |
| 笔记本屏物理分辨率 | **3072 × 1920** |
| 逻辑桌面（150%） | 2048 × 1280 |
| WSLg 给的虚拟屏 | 4976 × 1586（与实际桌面不匹配） |
| 窗口占物理屏 | 约 50% 宽、48% 高 |

结论：**画面被 WSLg 放大过**，所以既显小又发虚；应用无法参与这个缩放。

### 怎么在 Windows 原生跑

**推荐用 `run-native.cmd`**（而不是直接双击 `start-windows.cmd`）：

```text
双击 run-native.cmd
```

两者的区别很重要：

| 启动方式 | 环境 | 结果 |
| --- | --- | --- |
| `start-windows.cmd` | 从 WSL 调用时会把 Linux 变量带给 Windows 进程 | **Ctrl+V 粘贴失效**等问题 |
| `run-native.cmd` | 走 `scripts/run-native.ps1`，剔除 WSL 变量后启动 | 剪贴板等 Windows 集成正常 |

被剔除的变量：`WSL_DISTRO_NAME`、`WSL_INTEROP`、`WSLENV`、`DISPLAY`、`WAYLAND_DISPLAY`、
`PULSE_SERVER`、`XDG_RUNTIME_DIR`、`LD_LIBRARY_PATH`、`TERM`、`SHELL`、`LANG`、`HOME` 等。

> 从 WSL 手动启动时，**不要**用 `cmd.exe /c start-windows.cmd`，那样等于第一种方式；
> 要用 `powershell.exe -File scripts\run-native.ps1 -NoWait`（或先自行清理上述变量）。

脚本会：
1. 在 `node_modules.win\` 里装一份 **Windows 版依赖**（约 150MB，需联网）——WSL 与 Windows
   的 `node_modules` **不能共用**（Electron 与 esbuild 都带平台原生模块），这份独立目录不会动到 WSL 侧；
2. 构建渲染层；
3. 带 `--win` 启动面板。`--win` 的作用是**跳过 WSLg 缩放纠正**：原生下 Electron 会自己读系统缩放
   （如 150%），再叠加 `force-device-scale-factor` 会放大到 2.25 倍。

首次运行后，之后每次双击直接启动（依赖已就绪会跳过安装）。想删掉原生依赖：删除 `node_modules.win*` 目录。

### 原生 vs WSL 实测对照

| 项 | WSL（WSLg） | Windows 原生 |
| --- | --- | --- |
| 窗口逻辑尺寸 | 1017×619 | **2246×938** |
| 截图（物理像素） | 1524×927 | **3369×1260** |
| 渲染缩放 | 手动纠正为 1.25x（仍经 WSLg 缩放到屏幕） | 系统 150%，1:1 |
| 自检 | 10/10 | **10/10** |
| 端到端验收 | 36/36 | **36/36** |

### Windows 侧已修复的平台差异

原生跑通过程中发现并修好了三处只在 Windows 出现的问题：

| 问题 | 原因 | 修法 |
| --- | --- | --- |
| 控制通道 `EACCES`，CLI 完全不可用 | Windows 不支持「文件路径形式的 Unix socket」 | `socketPath()` 在 win32 下返回命名管道 `\\.\pipe\aibrowser-control-<用户>` |
| 截图 0×0 | 隐藏窗口在 Windows 不参与合成，offscreen 也不产出帧 | 无头窗口放到屏幕外并 `showInactive()`；取帧时空帧视为失败并轮询重试 |
| 界面被放大成 2.25 倍 | WSLg 缩放纠正被套用到原生 | `--win` 参数（原生自动识别）时跳过纠正 |

另外 `scripts/verify.mjs` 现在跨平台可用：自动选择 `node_modules.win*` 里的 Windows 版 Electron、临时目录用 `os.tmpdir()`。

### 原生与 WSL 的分工

| 场景 | 建议 |
| --- | --- |
| 看面板、调 UI、写前端看效果 | **Windows 原生**（画质与 Chrome 一致） |
| 无头截图 / CLI / 给 AI 调用（`pvs serve`） | WSL 侧即可，不涉及窗口呈现 |

## 文字大小与清晰度

面板默认关闭 **LCD 亚像素抗锯齿**（`--disable-lcd-text`），与 Chrome 一致使用灰度抗锯齿：开启时实测文字边缘
彩色通道差最高 204（明显彩边），关闭后降到 18。

WSLg 会把 `devicePixelRatio` 报成 **2.25**（偏大），而笔记本屏通常是 **1536 逻辑 / 2304 物理 = 150%**。
WSLg 下会自动把渲染缩放纠正为 **1.25x**（1.5 虽然更贴近物理像素，但界面字号明显偏大）。
Windows 原生运行不套用此值，由系统缩放决定。需要调整时：

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

## 默认界面状态（面向 AI 截图与自动化）

为了「打开即用于预览/截图」，默认值如下，并持久化在运行时目录的 `config.json`：

| 配置 | 默认 | 效果 | 命令行覆盖 |
| --- | --- | --- | --- |
| `contentOnly` | **true** | 全屏预览：隐藏标题栏与工具栏，只留标签条 → 内容区从顶部 32px 开始 | `--no-fullscreen` / `--fullscreen` |
| `sidebar` | **false** | 不显示左侧文件树 | `--show-sidebar` |
| `hotReload` | false | 热重载关闭 | `--hot-reload` / `--no-hot-reload` |
| `uiScale` | 1 | 界面缩放 100% | `Ctrl+滚轮` |

全屏模式下按 `Esc` 或 `Ctrl+Shift+M` 可临时退出查看完整界面（退出状态会持久化）。

## 热重载

默认**关闭**（不做任何文件轮询）。三种开启方式：

```bash
electron . --hot-reload          # 启动时开启（与配置一起生效，参数优先）
# 或点标题栏 ⟳ / 按 Ctrl+Shift+H / 菜单「热重载」
```

状态持久化在运行时目录的 `config.json`（`hotReload`）。关闭状态可用 `--no-hot-reload` 强制覆盖。
开启后每 0.6s 轮询被预览文件所在目录中的 `html/css/js/json/svg/md`，变化即自动刷新页面。

## WSL / 容器兼容

已内置 `--no-sandbox`、`--disable-gpu`、`--disable-dev-shm-usage`，无需手工配置。
字体方面：若 WSL 里缺少中文字体，可把 Windows 字体复制到 `~/.fonts` 后执行 `fc-cache -f`，例如

```bash
mkdir -p ~/.fonts && cp /mnt/c/Windows/Fonts/msyh.ttc /mnt/c/Windows/Fonts/simhei.ttf ~/.fonts/ && fc-cache -f ~/.fonts
```

## 在 Windows 上的启动方式与剪贴板

| 启动方式 | 说明 |
| --- | --- |
| **`run-native.cmd`（推荐）** | 走 `scripts/run-native.ps1`，以「继承当前环境 + 剔除 WSL/Linux 变量」的方式启动，剪贴板与 Windows 集成正常 |
| `start-windows.cmd` | 从 WSL 调用时会继承 `WSLENV` / `DISPLAY` / `PULSE_SERVER` 等变量并安装依赖；仅建议首次装依赖时用 |

面板菜单包含完整的「编辑」子菜单，并**显式写出加速键**（`Ctrl+X/C/V`、`Ctrl+A`、`Ctrl+Z` 等）——
只写 `role` 不写 `accelerator` 时，部分平台上加速键不会注册，表现为「Ctrl+V 粘贴没反应」
（此时 `Shift+Insert` 仍可用）。渲染层另有一层 Ctrl+V 兜底：捕获阶段读剪贴板并插入光标处。

## 诊断过的非问题（避免重复排查）

| 现象 | 结论 |
| --- | --- |
| 文字像是「重影 / 彩边」 | LCD 亚像素抗锯齿所致，已用 `--disable-lcd-text` 关闭 |
| 打开/关闭 GPU 有区别吗 | 实测截图像素**逐像素相同**（该链路没有 GPU 直通设备 `/dev/dri`） |
| 换字体有用吗 | 有用但不解决根本问题；中文栈已优先微软雅黑/苹方等高质量字体 |
| 缩放 1.0 / 1.25 / 1.5 差异 | 渲染表面始终约 1525px，但报告的 DPR 从 1 变到 2.25 —— 说明呈现层在做缩放 |
| WSLg 暴露的 X 屏 | 4976px 宽，窗口只占其中一块，最终呈现必然经过缩放 |

## skill 的安装位置（DeepSeek Harness）

DSH 从这些位置加载 skill（按优先级）：

| 来源 | 路径 |
| --- | --- |
| project-dsh | `<项目根>/.dsh/skills` |
| **project-agents** | `<项目根>/.agents/skills` |
| user-dsh | `~/.dsh/skills` |
| **user-agents** | `~/.agents/skills` |

`npm install` 后由 `postinstall`（`scripts/install-skill.mjs`）自动把 `skills/aibrowser`
以符号链接装到 `.agents/skills` 与 `~/.agents/skills`，因此新会话能直接发现；
仓库内的 skill 改动会自动同步（符号链接）。手动重装：`node scripts/install-skill.mjs`。
