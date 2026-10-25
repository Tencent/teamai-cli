# 诊断与维护

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

---

```bash
teamai doctor
teamai doctor --json
teamai stats
teamai update --check
teamai update
teamai digest
teamai remove skills <name>
teamai remove rules <name> --force
```

`doctor` 有一项没过就以状态码 1 退出。`stats` 在有 recall 记录时会多一节，见 [Recall 采纳与 upvote](./knowledge.md#recall-采纳与-upvote)。

如果工具的 skills 目录被普通文件占用，`pull` 会保留该文件、指出阻塞路径，并继续向其他工具分发。移开该文件后，再运行 `teamai pull` 即可补齐缺失的技能。

即使在单仓库模式，ZCode CLI 也从 `~/.zcode/cli/config.json` 读取 hooks。`hooks inject` 会迁移旧项目文件中属于 teamai 的条目，保留个人设置，并限制团队 hooks 只在所属项目运行。`hooks list` 和 `doctor` 检查同一个 HOME 文件。

自动更新在会话结束时跑。团队可以关掉，成员可以改自己的策略：

```yaml
# teamai.yaml
autoUpdate: false
```

```yaml
# ~/.teamai/config.yaml
updatePolicy: skip    # auto / prompt / skip，优先于团队设置
```

对于 OpenClaw 的默认工作区，`doctor` 会根据实际 `openclaw.json` 的 `agents.defaults.bootstrapMaxChars` 和 `bootstrapTotalMaxChars` 检查整个 `AGENTS.md`，包括个人内容。两项默认分别为 20,000 和 60,000 字符。如果会截断或跳过，请缩短文件或检查上限；`pull` 不会截断你的指令。单独智能体的覆盖配置需要另行检查。

OpenCode hooks 使用 `teamai hooks inject` 或 `teamai pull` 记录的 Node 可执行文件和 TeamAI 入口，因此服务的 PATH 无需包含 `teamai`。移动或重新安装 Node 或 TeamAI 后，重新运行其中一个命令并重启 OpenCode。

`doctor` 会检查 Hermes 的整个 `SOUL.md`，包括个人内容。Hermes 的 `config.yaml` 中显式设置的 `context_file_max_chars` 是明确上限；未设置时，上限随模型变化，超过最低 20,000 字符会产生提示性警告。请缩短文件或检查上限；`pull` 不会截断你的指令。

Pi 扩展会启动 `teamai pull` 或 `teamai hooks inject` 记录的 Node 可执行文件和 TeamAI 入口。移动或重新安装后，请重新运行其中一个命令并重启 Pi。
