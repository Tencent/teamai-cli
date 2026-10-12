# 卸载与常见问题

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

---

## 卸载

`teamai uninstall` 删除 TeamAI 装上去的资源。你自己建的文件会留下。

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

**Q: 命令提示 `Cannot acquire lock <path>: <reason>`？**

锁无法检查、创建或回收，dry-run 预览也可能报告此错误。
先修复提示中的文件系统错误（例如权限不足、磁盘已满，
或父路径是文件），再重试；等待其他 teamai 进程结束无法解决这类错误。
另一个进程持有锁时仍使用该命令原有的占用或跳过提示；已有锁因权限不足无法读取或
未记录所有者时，也会被视为已占用以保护它。

**Q: User scope 和 Project scope 可以共存吗？**

可以，但 project scope 默认保持隔离。当前工作目录包含 project scope 配置时，该项目生效并跳过 user scope。先初始化 user scope，再使用 `--inherit-user-scope` 初始化项目（或在项目本地配置中设置 `inheritUserScope: true`），即可组合安全资源和 Recall 结果；可执行配置和控制面配置（`env`、MCP）仍只使用 project scope；hooks 例外——非-self 的 project scope 会把内置 hooks 注入到 HOME，以便 `hook-dispatch` 依据 `cwd` 门控（详见 Hooks 章节）。

**Q: `teamai init` 提示已初始化？**

交互模式下会提示是否覆盖，输入 `y` 即可。也可用 `--force` 跳过确认：

```bash
teamai init --repo https://github.com/your-org/your-repo --force
```

**Q: 在项目里执行 `teamai init` 后没有 `.claude/`（或 `.cursor/`、`.codebuddy/`）目录？**

对内置工具而言，`init` 未带 `--agent` 且没有终端（不弹选择器）时这是预期行为：它不知道你会打开哪个 Agent。执行 `teamai init <repo> --agent claude`（或 `cursor`、`codebuddy` 等）会在 init 结束前创建该工具的根目录并填充；或者在项目中打开该工具：SessionStart hook 会创建该工具的项目根目录并随后 pull。单独执行 `teamai pull` 不会为缺失的 Agent 根目录建目录。例外是仅在 `teamai.yaml` 的 `toolPaths` 中定义的自定义 Agent（不属于内置工具）

——`init --agent <id>` 会自行创建该 Agent 的根目录，因为没有其他流程会为它创建。这仅在 git 模式的 init（默认或 `--self`）下生效：HTTP init（`--http`）不会在本地克隆 `teamai.yaml`，因此没有自定义路径可供创建，只会为已安装的内置工具创建根目录。

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
