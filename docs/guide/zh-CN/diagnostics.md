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

自动更新在会话结束时跑。团队可以关掉，成员可以改自己的策略：

```yaml
# teamai.yaml
autoUpdate: false
```

```yaml
# ~/.teamai/config.yaml
updatePolicy: skip    # auto / prompt / skip，优先于团队设置
```
