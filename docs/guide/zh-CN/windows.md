# Windows：让钩子生效

> [English](../windows.md) | [简体中文](windows.md)

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

> TeamAI 的 Agent 钩子在 Windows 上不触发时该查什么。

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

各工具的钩子集合和每个事件的作用见[使用指南](hooks.md#hooks)。

## 钩子仍不触发

- **没装 Git for Windows。** 没有它时派发命令退化为裸 `bash`，Windows 会解析到 WSL 启动器；
  安装 Git for Windows 后运行 `teamai hooks inject`。
- **`teamai doctor` 说 `gh` 未登录**，而 `gh auth status` 显示已登录。`doctor` 启动 `gh` 时可能
  没带 `APPDATA`，所以看不到登录态。其他检查都通过时可以忽略。
