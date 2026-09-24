AIBrowser —— 自带应用的 skill 分发包

目录里只有这些是「产物」：
  aibrowser-skill-<版本>-<平台>-<架构>.tar.gz   发给别人的 skill 包（自带该平台的 AIBrowser）
  manifest.json                                 上面这些包的索引（sha256 / 大小 / 打包时间）

用法（对方机器上）：
  tar -xzf aibrowser-skill-<...>.tar.gz
  cp -r aibrowser ~/.agents/skills/
  bash ~/.agents/skills/aibrowser/scripts/pvs.sh status --json
  （安装时不起服务：面板是 GUI 窗口；第一次真正干活 open/shot/code 时自动拉起）

注意：本目录里若出现 `aibrowser/` 解包目录，那是中间产物（正常不会生成，除非用了 --unpacked）。
      可以放心删除；若删不掉（Windows 侧占用 app.asar），重启后再删或从资源管理器删。
