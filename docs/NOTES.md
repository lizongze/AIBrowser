# AIBrowser · 额外说明

与能力无关的运行环境相关事项（显示质量、缩放、容器兼容、历史诊断记录）。

**遇到显示不清晰、字号不对、Windows 该怎么跑这类问题看这里；只想了解功能请看 [README](../README.md)。**

---

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

## 诊断过的非问题（避免重复排查）

| 现象 | 结论 |
| --- | --- |
| 文字像是「重影 / 彩边」 | LCD 亚像素抗锯齿所致，已用 `--disable-lcd-text` 关闭 |
| 打开/关闭 GPU 有区别吗 | 实测截图像素**逐像素相同**（该链路没有 GPU 直通设备 `/dev/dri`） |
| 换字体有用吗 | 有用但不解决根本问题；中文栈已优先微软雅黑/苹方等高质量字体 |
| 缩放 1.0 / 1.25 / 1.5 差异 | 渲染表面始终约 1525px，但报告的 DPR 从 1 变到 2.25 —— 说明呈现层在做缩放 |
| WSLg 暴露的 X 屏 | 4976px 宽，窗口只占其中一块，最终呈现必然经过缩放 |
