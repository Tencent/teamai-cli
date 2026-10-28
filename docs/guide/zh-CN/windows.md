# Windows：让钩子生效

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

> TeamAI 的 Agent 钩子在 Windows 上不触发时该查什么。

## 摘要

钩子写的是 Git Bash 的绝对路径，不会走到 WSL。WorkBuddy 用自带的 shell，ZCode 用 Node。找不到 shell 的工具会被跳过。`teamai doctor` 通过，钩子就会触发。

## 验证

```powershell
teamai doctor                       # 每个已安装工具的钩子都应报告健康
teamai hooks list                   # 各工具的内置钩子集合

# 手动跑一个钩子；退出码 0 表示派发正常
& "C:\Program Files\Git\bin\bash.exe" -lc "teamai hook-dispatch session-start --tool claude 2>/dev/null"; $LASTEXITCODE
```

每个事件做什么，见[基础 Harness](sharing.md#hooks)。

## 拉取时的长路径

TeamAI 在 Windows 上为共享 Git 客户端启用 `core.longpaths`，不会修改全局或仓库的 Git 配置。
团队仓库刷新先检出文件，再按角色过滤，因此未启用的命名空间中层级很深的 skill 资源也需要长路径支持。
其他 Git 命令和工具可能仍需要单独配置长路径支持。

如果 Git 配置显式设置了 `core.longpaths=false`，部分 Git 版本仍需要将该设置改为 `true`。

首次 `teamai init` 克隆使用独立的 provider 路径。如果团队仓库已有长路径，请先运行
`git config --global core.longpaths true` 启用支持。

## 钩子仍不触发

- **没装 Git for Windows。** 没有它时派发命令退化为裸 `bash`，Windows 会解析到 WSL 启动器；
  安装 Git for Windows 后运行 `teamai hooks inject`。
- **`teamai doctor` 说 `gh` 未登录**，而 `gh auth status` 显示已登录。`doctor` 启动 `gh` 时可能
  没带 `APPDATA`，所以看不到登录态。其他检查都通过时可以忽略。
