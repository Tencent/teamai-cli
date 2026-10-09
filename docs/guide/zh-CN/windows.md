# Windows：让钩子生效

> [English](../windows.md) | [简体中文](windows.md)

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

> TeamAI 的 Agent 钩子在 Windows 上不触发时该查什么，以及为什么旧版本需要手工绕行。
> 当前版本的 `teamai-cli` 已自行处理 Windows；旧安装的修法就是 `npm update -g teamai-cli`。

## 摘要

在 Windows 上，teamai 写进各 Agent 配置的钩子命令用 **Git Bash 的绝对路径**引用
（先查标准安装位置，再查注册表 `HKLM\SOFTWARE\GitForWindows`），因此不会落到 WSL 的
`bash.exe` 启动器上。每个 GUI 工具解析自己的钩子 shell：WorkBuddy 用它自带的 PortableGit
`sh.exe`，CodeBuddy 用它在 Windows 上必需的 Git Bash。只有解析不到任何 shell 的工具才会被跳过。
ZCode 的钩子通过 `wscript.exe` 启动器运行，完全不需要 bash。

装了 Git for Windows 且 `teamai doctor` 通过，钩子就会触发。钩子没触发的话再往下看。

## 验证

```powershell
teamai doctor                       # 每个已安装工具的钩子都应报告健康
teamai hooks list                   # 各工具的内置钩子集合

# 手动跑一个钩子；退出码 0 表示派发正常
& "C:\Program Files\Git\bin\bash.exe" -lc "teamai hook-dispatch session-start --tool claude 2>/dev/null"; $LASTEXITCODE
```

各工具的钩子集合和每个事件的作用见[使用指南](advanced.md#hooks)。

## 钩子仍不触发

- **没装 Git for Windows。** 没有它时派发命令退化为裸 `bash`，Windows 会解析到 WSL 启动器；
  安装 Git for Windows 后运行 `teamai hooks inject`。
- **teamai-cli 版本太旧。** 加入 Git Bash 解析之前的版本写的是裸 `bash` 命令，并且完全跳过
  CodeBuddy / WorkBuddy（见下文）。升级后运行 `teamai hooks inject`；不需要旧指南里的 WSL
  包装脚本和手改配置文件，`teamai pull` 也不会再把命令改回去。
- **`teamai doctor` 说 `gh` 未登录**，而 `gh auth status` 显示已登录。`doctor` 启动 `gh` 时可能
  没带 `APPDATA`，所以看不到登录态。其他检查都通过时可以忽略。

## 旧版本出了什么问题

1. **裸 `bash` → WSL Node 18。** Windows 的 `PATH` 先把 `bash` 解析到 WSL 启动器
   （`C:\Windows\System32\bash.exe`），其自带 Node 是 v18，解析不了 teamai 打包产物，于是每次
   钩子都静默崩溃；末尾的 `|| true` 吞掉了错误，`doctor` 仍报告钩子"存在"。
2. **`hasShell()` 跳过了 CodeBuddy / WorkBuddy。** shell 检测是 `fs.existsSync('/bin/sh')`，
   在 Windows 上永远为假，这两个工具因此完全没有钩子。现在改为向每个工具询问它自己的钩子 shell
   （`hasShellFor()` → `bundledShellFor()`）。
3. **WSL 路径转换。** WSL 侧的包装脚本用 `/mnt/c/...` 路径 `exec` Windows 的 Node 时会被
   改写成 `C:\mnt\c\...`（`MODULE_NOT_FOUND`），所以旧的 WSL 绕行方案要经 `cmd.exe` 委派。

当前 `teamai-cli` 已修复这三个问题。macOS 和 Linux 不受影响。
