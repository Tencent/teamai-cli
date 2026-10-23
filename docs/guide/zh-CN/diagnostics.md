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

`init` 将缓存切换到另一个团队仓库时，会把旧 clone 及 reports/learnings 工作树保留到输出中的 `previous-team-*` 目录。未提交文件和未推送提交都会保留，Git 关联也会修复。确认所需内容已恢复或发布后再处理备份。正在写入、无法确认归属或存在其他注册工作树时，切换会在移动文件前停止。Git 的 `url.*.insteadOf` 传输重写不会被视为仓库变化。

自动更新在会话结束时跑。团队可以关掉，成员可以改自己的策略：

```yaml
# teamai.yaml
autoUpdate: false
```

```yaml
# ~/.teamai/config.yaml
updatePolicy: skip    # auto / prompt / skip，优先于团队设置
```
