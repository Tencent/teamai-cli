# 使用统计上报

> [English](../reporting.md) | [简体中文](reporting.md)

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

---

Pull 对整批统计上报最多等待 5 秒，之后继续其他工作，上报任务仍会完成。
超时后推送成功，仍会更新本地已上报快照。skill 使用按 scope 记录：写入会话所在
目录对应的已配置 teamai 项目的数据目录（或 user scope），因此每个目标只上报
自己的使用；未配置 teamai 的目录不记录。Dashboard 会话仍写入整机共用的
`~/.teamai/dashboard/events.jsonl`，但每条事件都记下所属 scope 数据目录（data home）的键（哈希值，不是路径），因此每个 scope
只上报在其中记录的会话：

user scope 的 pull 不再上报项目的会话，项目会上报自己的
Copilot 会话以及从软链接路径启动的会话。每个会话只上报一次，整体归属其开始时所在的
scope，即使之后切换到另一个项目：它的 Stop 带有整份 transcript 的累计值，第二个 scope
会重复计算。没有目录或目录已删除的事件不由任何 scope 上报。


每个 scope 还各自保存已上报快照，且复用回退 ID 的新会话（Copilot 未提供会话 ID 时基于 PID 的 ID）
总算作新会话，无论先前那个由哪个 scope 上报；恢复的会话（`claude --resume`）保留原 ID，仍是同一个会话，无论在哪里恢复，都由最先上报它的 scope 上报。目标确认成功后才清理自己的使用事件，
推送失败会保留事件（最多保留最新 5,000 条，见下文）。上报完成前继续持有相关同步锁，
避免另一次 Pull 与尚未完成的上报竞争。

这仍是尽力上报，不提供崩溃恢复保证：远端推送成功与本地确认之间如果进程
被终止，统计仍可能重复；也不提供多仓库部分成功时的持久化逐目标去重。
5 秒限制只结束等待，不取消 Git，也不强制仍有子进程运行的 CLI 退出。

默认情况下，`teamai pull` 会把会话/使用统计提交进团队仓。从只读远端拉取（或
不想要统计提交）的团队可在 `teamai.yaml` 中关闭：

```yaml
usageReport: false
```

Pull 在上报步骤之后把每个 scope 的使用文件限制为最新 5,000 条事件，丢弃更早的
事件。对 HTTP 源或 `usageReport: false` 的团队，该文件是 `teamai stats` 唯一的
数据来源，因此文件保持有界而不会被清空；上报未完成且事件超过 5,000 条的上报
scope 也以同样方式丢弃最早的未上报事件。该上限只在上报清理完已发送事件之后执行。Hook 追加、上报后的清理与该上限共用使用文件旁的一把锁，
因此改写文件时不会丢失期间记录的事件。Hook 在约 250 ms 内拿不到锁时，把事件写入旁边的
`*.pending-<id>.jsonl` 文件，由下一个持锁者追加进使用文件；改写在约 5 秒内拿不到锁时保持文件不变。


pending 文件的权限不宽于使用文件（尚无使用文件时仅所有者可读写）。工作区内的 `.teamai/.gitignore`
忽略该锁、改写的临时副本与 pending 文件；`pull` 与 `push` 会为已有的单仓库 `.gitignore` 补上这些条目，
已有的项目级 `.gitignore` 则在使用文件第一次写 pending 文件或改写时补上。

**删除其他项目上报进你 `stats/` 的 skill。** 在 skill 使用按 scope 记录之前，下一个
执行 pull 的项目会上报所有项目的 skill，因此 `teamai-reports` 上的 `stats/<user>.yaml` 可能
统计了属于无关仓库的 skill。这些事件没有记录目录，teamai 无法归属，也不会改写该
文件。请手动删除该条目，在单独的 clone 中操作，不要动 teamai 的 `reports-wt/` 检出：

```bash
git clone --branch teamai-reports --single-branch <team-repo-url> teamai-reports
cd teamai-reports
# 删除 stats/<user>.yaml 中 `skills:` 下该 skill 的条目
git commit -am "stats: remove <skill> reported from another project"
git push origin teamai-reports
```

下一次上报会先读取该分支，所以条目不会再出现。
