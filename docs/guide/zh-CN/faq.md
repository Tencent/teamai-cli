# 卸载与常见问题

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

---

## 卸载

`teamai uninstall` 删除 TeamAI 装上去的资源。你自己建的文件会留下。user scope 卸载会保留本机仍登记的项目的数据。请先逐个卸载项目，再在任何项目之外运行 `teamai uninstall`，移除剩余的共享数据。

使用共享数据分区的项目中，完整卸载会先移除所有 checkout 的共享 hooks 和注册，再删除分区。`uninstall --agent <tool>` 只移除当前 checkout 中该工具的 hooks 和注册；若该工具是分区中最后一个工具，则会删除分区以及所有 checkout 的 hooks。bare 仓库的 worktree 分别拥有自己的 hook 文件。

即使没有本地文件需要删除，排除项目中的指定工具也需要确认或 `--force`。`--dry-run` 或拒绝确认不会修改项目配置。

```bash
# 预览将要移除的每个受管路径（不做实际变更）
teamai uninstall --dry-run

# 交互式确认卸载
teamai uninstall

# 跳过确认直接卸载（适合脚本/CI）
teamai uninstall --force

# 只卸载某一个工具的资源（与 init --agent 对称）
teamai uninstall --agent claude
```

卸载后如需重新加入：

```bash
teamai init --repo https://github.com/your-org/your-repo --scope user --role <role_id> --force
```

---

## 常见问题 FAQ

**Q: `init` 提示成员注册失败或 reports 分支被占用？**

本地初始化仍会完成。注册失败时会显示具体原因；修复后，重新执行相同的
`teamai init` 命令来重试。如果另一个写入正在占用 `teamai-reports` 分支，
请等它结束后再重新执行该命令。

**Q: 命令提示 `Cannot acquire lock <path>: <reason>`？**

锁无法检查、创建或回收，dry-run 预览也可能报告此错误。
先修复提示中的文件系统错误（例如权限不足、磁盘已满，
或父路径是文件），再重试；等待其他 teamai 进程结束无法解决这类错误。
另一个进程持有锁时仍使用该命令原有的占用或跳过提示；已有锁因权限不足无法读取或
未记录所有者时，也会被视为已占用以保护它。

**Q: 崩溃后 `~/.teamai` 里留下了锁文件？**

锁文件记录了持有它的进程 PID。所有者已消失的锁不会阻塞任何操作：
下一个获取同一把锁的命令会自动回收它，而正常退出的进程现在也会清掉
自己仍持有的锁。`teamai doctor` 会报告遗留的锁文件，
`teamai doctor --fix` 只删除所有者确认已死的锁——仍被存活进程持有、
或未记录所有者的锁不会被删除。

**Q: User scope 和 Workspace scope 可以共存吗？**

可以，但 workspace scope 默认保持隔离。当前工作目录包含 workspace scope 配置时，该工作区生效并跳过 user scope。先初始化 user scope，再使用 `--inherit-user-scope` 初始化工作区（或在工作区本地配置中设置 `inheritUserScope: true`），即可组合安全资源和 Recall 结果；MCP 和密钥仍只使用 workspace scope。设置了 `inheritUserScope: true` 的工作区也会接收 user scope 的环境变量，但工作区已将同名 key 声明为变量或密钥时除外。hooks 例外：非-self 的 workspace scope 会把内置 hooks 注入到 HOME，以便 `hook-dispatch` 依据 `cwd` 门控（详见 Hooks 章节）。

**Q: `pull` 提示某个 workspace 子项被排除（left out）？**

workspace 中已初始化的仓库，只有在使用 workspace 的团队仓库且不是单仓库模式时才计入。这一行会给出仓库和原因。在该仓库中运行 `teamai init <团队仓库>` 即可把它纳入，也可以保持原样：它仍然独立工作。`teamai doctor` 会列出所有被排除的子项。

**Q: workspace 中 `pull` 提示某个 skill、agent 或 server 在两个 namespace 之间不同（differs between）？**

workspace 中的两个仓库收到了同名但内容不同的条目，所以 workspace 暂缓（held）它并指出名字：teamai 之前为它安装的内容保持不变，放在 workspace 规则指定的位置。在团队仓库中让两份内容一致，或给其中一个改名。每个仓库仍会收到自己的那一份。

**Q: `teamai init` 提示已初始化？**

交互模式下会提示是否覆盖，输入 `y` 即可。也可用 `--force` 跳过确认：

```bash
teamai init --repo https://github.com/your-org/your-repo --force
```

**Q: 在项目里执行 `teamai init` 后没有 `.claude/`（或 `.cursor/`、`.codebuddy/`）目录？**

对于内置工具，如果 `init` 没带 `--agent`，且在非交互终端中运行（不会显示选择器），它不会创建工具根目录，因为你还没有选择 Agent。`teamai init` 不会复制团队的 skills、rules 或 MCP。执行 `teamai init <repo> --agent claude`（或其他 Agent ID）会创建该工具的根目录并装上 hook。团队资源要等该工具开始一次会话，或执行 `teamai pull` 后才到达。你也可以在项目中打开该工具。它的 SessionStart hook 会创建根目录并拉取资源。

`teamai pull` 不会创建缺失的 Agent 根目录。例外是在继承配置的子模块克隆中首次 pull，它会根据原始子模块配置创建根目录（见[项目 checkout](./distribution.md#项目-checkout)）。对于只在 `teamai.yaml` 的 `toolPaths` 中定义的自定义 Agent，git 模式的 init 会通过 `init --agent <id>` 创建其根目录。HTTP init 无法读取本地 `teamai.yaml` 路径，因此只会为已安装的内置 Agent 创建根目录。

**Q: `teamai.yaml` 里的 `toolPaths` 条目——没有写到的键会怎样？**

该条目会整体替换此工具的默认值：没写的键*消失*，不会被继承。只自定义 `skills` 而省略 `settings` 的条目会让该工具没有 settings 文件，hook 对账会静默跳过它；省略 `skills` 或 `rules` 则是有意停用对应投递。`teamai doctor` 会点名自定义条目丢掉的、默认表提供的每一个键，以及补回用的值。

**Q: Hooks 没有自动触发？**

```bash
teamai doctor        # 诊断
teamai hooks inject --dry-run # 先预览
teamai hooks inject  # 重新注入
```

**Q: push 提示 "no new resources detected"？**

`push` 只检测新增或修改的资源。没有变更时无需推送。

**Q: 如何删除已推送的资源？**

```bash
teamai remove skills <name>
teamai remove rules <name>
```

---

> **仓库**：https://github.com/Tencent/teamai-cli
> **问题反馈**：https://github.com/Tencent/teamai-cli/issues
