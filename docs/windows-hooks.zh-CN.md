# TeamAI 在 Windows 上的使用 — 让钩子真正生效

> 一份在 **Windows** 上为每个已启用代理（Claude Code、Codex、ZCode、CodeBuddy、
> Qoder、WorkBuddy、Cline、Cursor、OpenCode）正确接入 TeamAI CLI（`teamai`）
> 钩子的实践指南，并说明导致此问题的上游 bug 以及给维护者的修复建议。

## 摘要（TL;DR）

在较早版本的 TeamAI 上，Windows 注入的钩子使用裸 `bash` 启动器，会**静默崩溃**
（WSL 的 `bash` 自带 Node 18，无法解析 TeamAI 打包产物），因此钩子实际上处于失效
状态——`|| true` 把错误吞掉了。同样的版本中，`codebuddy` / `workbuddy` 的钩子
**根本不会被写入**，因为 shell 检测（`fs.existsSync('/bin/sh')`）在 Windows 上
永远为假。

当前版本的 `teamai` 已自行处理 Windows，因此下文的用户侧绕行方案仅在旧版本上需要：
钩子命令通过 Git Bash 的绝对路径启动，且每个 GUI 工具都会解析各自的钩子 shell——
WorkBuddy 使用其自带的 PortableGit `sh.exe`，**CodeBuddy 使用 cmd.exe**
（`%ComSpec%`），任何 Windows 安装都提供 cmd.exe。两者都不再被跳过。

持久化的用户侧修复结合两种机制，无论 `teamai` 写入什么都能让钩子触发：

1. **在每个代理配置文件中使用 Git Bash 的绝对路径**（当下即可生效）。
2. **一个 WSL 包装脚本**，通过 `cmd.exe` 委派给原生的 Windows `teamai`
   （在日后 `teamai pull` 把钩子还原成裸 `bash` 时依然有效）。

两者都配置好后，`teamai doctor` 会报告六个已安装工具均健康，且每次
`hook-dispatch` 调用通过两种机制都返回 `exit=0`。

---

## TeamAI 钩子简介（回顾）

`teamai hooks inject` 会向每个代理的配置文件中写入类似如下的命令：

```json
"command": "bash -lc \"teamai hook-dispatch session-start --tool claude 2>/dev/null\" || true"
```

每个工具包含六个钩子：`SessionStart`、`Stop`、`PostToolUse`（三个匹配器：
`*`、`Skill`、`TodoWrite`）以及 `UserPromptSubmit`。它们让团队仓库能够记录会话
统计信息，并在各代理间应用共享的规则 / 技能。

---

## Windows 上的问题

### 故障模式 1 — 裸 `bash` → WSL Node 18 崩溃

在 Windows 上，`PATH` 中的裸 `bash` 会解析到 **WSL 启动器**
（`C:\Windows\System32\bash.exe`）。WSL 自带的 Node 是 **v18**，而 TeamAI
打包产物需要更高版本的 Node，因此每次钩子调用都会静默崩溃。由于命令以 `|| true`
结尾，崩溃被吞掉、不记录日志——钩子永不触发，但 `teamai doctor` 仍报告它们
“存在”。

### 故障模式 2 — `hasShell()` 曾跳过 CodeBuddy / WorkBuddy

`src/builtin-hooks.ts` 用 `hasShell()` 来门控依赖 shell 的工具：

```ts
export function hasShell(): boolean {
  if (_hasShellCache === undefined) {
    try {
      _hasShellCache = fs.existsSync('/bin/sh');
    } catch {
      _hasShellCache = false;
    }
  }
  return _hasShellCache;
}
```

`/bin/sh` 在 Windows 上不存在，因此 `hasShell()` 为 `false`，`skipToolsWithoutShell()`
曾把 `codebuddy` / `workbuddy`（`SHELL_DEPENDENT_TOOLS`）加入跳过集合，这两个代理
在 Windows 上**完全不会获得钩子**，即使其他一切都正常。

该跳过已不再存在：门控会先向每个工具询问其自身的钩子 shell
（`hasShellFor()` → `bundledShellFor()`）。`workbuddy` 通过其自带的 PortableGit
`sh.exe` 解析；`codebuddy` 通过 cmd.exe 解析——CodeBuddy 在 Windows 上的钩子运行器
是 `%ComSpec%`（它通过 `child_process.spawn(command, [], { shell: true })` 执行钩子
的 `command`），而任何 Windows 安装都提供 cmd.exe。只有无法解析出 shell 的工具才会
被跳过。

---

## 根本原因

1. **裸 `bash` → WSL Node 18.** Windows 的 `PATH` 会把 `bash` 解析到 WSL 启动器，
   而非 Git Bash；WSL 的 Node 18 无法解析 TeamAI 打包产物。
2. **`hasShell()` 的 Windows bug.** `fs.existsSync('/bin/sh')` 在 Windows 上永远为假，
   过去会跳过 `codebuddy` / `workbuddy` 的钩子注入；现在由按工具的
   `bundledShellFor()` 解析器覆盖它们。
3. **WSL 路径转换.** 在 WSL 侧用 `/mnt/c/...` 路径 `exec` Windows Node 的包装脚本会被
   改写成 `C:\mnt\c\...`，导致 `MODULE_NOT_FOUND`。

---

## 修复方案（用户侧，持久化）

### 机制 A — 在每个代理配置文件中使用 Git Bash 的绝对路径

把每个钩子命令中的裸 `bash` 替换为 Git Bash 的 Windows 绝对路径（若 Git 装在其他
位置请相应调整）：

```json
"command": "\"C:\\Program Files\\Git\\bin\\bash.exe\" -lc \"teamai hook-dispatch session-start --tool <agent> 2>/dev/null\" || true"
```

此修改适用于所有带钩子的代理：

- `~/.claude/settings.json` — 6 个钩子
- `~/.codex/hooks.json` — 6 个钩子
- `~/.zcode/cli/config.json` — `command` 字段 → Git Bash 路径；6 个钩子
- `~/.codebuddy/settings.json` — 若不存在则创建；6 个钩子
- `~/.qoder/settings.json` — 若不存在则创建；6 个钩子
- `~/.qoder-cn/settings.json` — Qoder CN；与 Qoder 相同，但位于其独立的用户根目录下
- WorkBuddy / Cline / Cursor / OpenCode 等对应配置

请用支持 JSON 的编辑器修改（不要用 `sed` 手工改——双引号必须保持转义）。建议为每个
原文件保留一份 `*.teamai-bak` 备份以便回滚。

### 机制 B — WSL 包装脚本（抵御 `teamai pull` 的持久化）

`teamai pull` / `hooks inject` 会把代理配置重新写回裸 `bash`。机制 A 会被覆盖，但
WSL 包装脚本能让裸 `bash` 依然可用。在你的 WSL 家目录（如
`/home/<user>/.teamai-wsl/bin/teamai`）创建包装脚本：

```sh
#!/bin/sh
# 通过 cmd.exe 委派给原生的 Windows teamai（正确的 Node 与路径）
exec cmd.exe /c teamai "$@"
```

在 `~/.profile` / `~/.bashrc` 中用一个标记把它加到 `PATH` 前面：

```sh
# [teamai-wsl-fix]
export PATH="$HOME/.teamai-wsl/bin:$PATH"
```

这样，裸 `bash` 钩子会找到 `teamai` → `cmd.exe` → 原生 Windows TeamAI。`cmd.exe`
委派方式完全绕开了 WSL 的 `/mnt/c` 路径转换 bug。**此方案要求 WSL 保持安装。**

### 让所有工具都完整可用

- 在 `~/.teamai/config.yaml` 的 `enabledAgents` 中加入 `qoder`、`qoder-cn` 和 `codebuddy`。
- 把团队仓库中的技能与规则复制到 `~/.qoder`、`~/.qoder-cn` 和 `~/.codebuddy`，让这些代理不仅接入
  Hooks，也具备完整的技能与规则。（Qoder CN 的用户作用域读取 `~/.qoder-cn/`；其项目作用域仍为
  `<project>/.qoder/`，与 Qoder 共用。）

---

## 验证（全部通过）

```sh
teamai doctor
```

预期：为 **claude、codex、qoder、qoder-cn、zcode、codebuddy、workbuddy** 报告钩子存在。

按工具分别检查两种方式：

```sh
# 机制 A（Git Bash 绝对路径）
"C:\Program Files\Git\bin\bash.exe" -lc "teamai hook-dispatch session-start --tool claude 2>/dev/null"; echo $?

# 机制 B（通过 WSL 包装脚本的裸 bash）
wsl bash -lc "teamai hook-dispatch session-start --tool claude 2>/dev/null"; echo $?
```

每个工具通过两种机制都应打印 `0`。

```text
doctor:   ✔ claude ✔ codex ✔ qoder ✔ qoder-cn ✔ zcode ✔ codebuddy ✔ workbuddy
dispatch (Git-Bash 路径): claude=0 codex=0 zcode=0 codebuddy=0 qoder=0 qoder-cn=0
dispatch (裸 bash/WSL):  claude=0 codex=0 zcode=0 codebuddy=0 qoder=0 qoder-cn=0 workbuddy=0
```

---

## 限制 / 无法做到的事

- **持久化依赖 WSL 包装脚本.** `teamai pull` 会把代理配置还原成裸 `bash`；机制 A 被
  覆盖，机制 B 仅在 **WSL 保持安装** 时有效。若移除 WSL，裸 `bash` 钩子会再次失效。
- **机制 B 需要 WSL.** 在没有 WSL 的机器上，只有机制 A（当前配置文件中的 Git Bash
  绝对路径）可用。
- **不会修补旧版 TeamAI.** 上文列出的 Windows 缺口（`hasShell()` 跳过、裸 `bash`
  默认值、分离拉取进程 PATH 里缺少自带 git）均已在当前 `teamai-cli` 中修复；执行
  `npm update teamai-cli` 即可获得，之后可移除本绕行方案。
- **macOS / Linux 无需修复.** 在这些系统上，裸 `bash` 已解析到系统 Node，原生可用。
- **`teamai doctor` 的 `gh` 检查可能是误报.** 它可能在没有 `APPDATA` 的情况下启动
  `gh`，因此即使 `gh auth status` 显示已登录，它也看不到登录状态。若其他检查均通过，
  可忽略此项。
- **会保留备份文件.** 已编辑代理配置的 `*.teamai-bak` 备份会保留作为回滚保险。

---

## 给维护者的修复建议（上游）

三处小改动即可让 Windows 开箱即用——目前均已在 `teamai-cli` 中落地，本节保留作背景
说明：

### 1. 让 `hasShell()` 感知 Windows

在 Windows 上 `/bin/sh` 不存在，但 Git for Windows（`sh.exe` / `bash.exe`）或 WSL
提供了可用的 POSIX shell。TeamAI 应当检测它们，而不是永远返回 `false`：

```ts
export function hasShell(): boolean {
  if (_hasShellCache === undefined) {
    try {
      if (process.platform === 'win32') {
        // Git for Windows 自带 sh.exe/bash.exe；WSL 也提供 bash。
        // 钩子通过 `bash -lc ...` 启动，因此以下任一存在即可。
        const candidates = [
          'C:\\Program Files\\Git\\bin\\bash.exe',
          'C:\\Program Files\\Git\\usr\\bin\\sh.exe',
          'C:\\Windows\\System32\\bash.exe',
        ];
        _hasShellCache = candidates.some((p) => fs.existsSync(p)) ||
          whichBash() !== null;
      } else {
        _hasShellCache = fs.existsSync('/bin/sh');
      }
    } catch {
      _hasShellCache = false;
    }
  }
  return _hasShellCache;
}
```

当前 `teamai` 通过 `hasShellFor()` → `bundledShellFor()` 实现了这一点，因此
`codebuddy` / `workbuddy` 的钩子如今会在 Windows 上被注入。

### 2. 在 Windows 上把 dispatch 命令默认指向 Git Bash 绝对路径

`getDispatchCommand()` 硬编码了 `bash -lc "..."`。在 Windows 上这会被解析到 WSL 的
Node 18 并崩溃。当 `process.platform === 'win32'` 时，应优先使用 Git Bash 的绝对路径
（或自带的 PortableGit `sh.exe`）。

两处改动均向后兼容：macOS/Linux 仍使用 `/bin/sh`，而 Windows 用户将不再需要上面的
手工绕行方案。

### 3. 把宿主自带的 git 放进分离拉取进程的 PATH

会话启动时的 pull 通过 WMI 派生（以便逃出宿主的 job object），而 WMI 创建的进程
继承的是服务提供方的环境——运行 `teamai` 时的 PATH（带着 GUI 宿主自带的 git）到不了
pull 进程。在没有系统 git 的机器上，pull 里所有裸名 `git` 调用都会以
`spawn git ENOENT` 失败，clone 静默冻结，而 post-pull 部署仍对着旧树继续跑。

现在的 `teamai` 在 CLI 启动时解析宿主自带的 git（`ensureBundledRuntimeOnPath`）并把
它的 `cmd` 目录放到 PATH 最前——msys 目录追加在后，已能解析 `git` 的机器原样不动——
因此没有系统 git 也能正常完成分离拉取。

---

## 故障排查

```sh
teamai doctor

# 按工具分别检查两种方式：
"C:\Program Files\Git\bin\bash.exe" -lc "teamai hook-dispatch session-start --tool claude 2>/dev/null"; echo $?
wsl bash -lc "teamai hook-dispatch session-start --tool claude 2>/dev/null"; echo $?

# 若某工具的钩子停止触发：
#   1. 确认包装脚本存在：   ls ~/.teamai-wsl/bin/teamai
#   2. 确认 ~/.profile 中的 PATH 导出（标记 # [teamai-wsl-fix]）
#   3. 否则重新应用机制 A（在代理配置中使用 Git Bash 绝对路径）
```

---

## 涉及的文件（典型用户侧布局）

| 文件 | 改动 |
|------|------|
| `~/.claude/settings.json` | 钩子命令 → Git Bash 绝对路径（备份：`*.teamai-bak`） |
| `~/.codex/hooks.json` | 钩子命令 → Git Bash 绝对路径（备份：`*.teamai-bak`） |
| `~/.zcode/cli/config.json` | `command` 字段 → Git Bash 路径（备份：`*.teamai-bak`） |
| `~/.codebuddy/settings.json` | 若不存在则创建，含 6 个钩子 |
| `~/.qoder/settings.json` | 若不存在则创建，含 6 个钩子 |
| `~/.qoder-cn/settings.json` | Qoder CN；若不存在则创建，含 6 个钩子 |
| `~/.teamai/config.yaml` | `enabledAgents` += `qoder`、`qoder-cn`、`codebuddy` |
| `~/.qoder/{skills,rules}`、`~/.qoder-cn/{skills,rules}`、`~/.codebuddy/{skills,rules}` | 复制团队资源 |
| `~/.teamai-wsl/bin/teamai`（Win）+ `<wsl-home>/.teamai-wsl/bin/teamai`（WSL） | 持久化包装脚本 |
| `~/.profile`、`~/.bashrc` | PATH 导出（标记 `# [teamai-wsl-fix]`） |
