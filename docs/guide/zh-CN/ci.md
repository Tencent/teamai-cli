# CI 集成

> [English](../ci.md) | [简体中文](ci.md)

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

---

`teamai ci extract-mr --output <dir> --dry-run` 在访问 provider 或创建 artifacts 前拒绝执行，打印 `teamai ci extract-mr --output has no --dry-run preview, nothing was run` 并以退出码 1 结束。省略 `--output` 可执行预览；去掉 `--dry-run` 可写入 artifacts。

`teamai ci extract-mr` 接入 CI 流水线，从每个 MR/PR 自动提取知识：

```bash
# 评论模式：以评论形式发布建议（在 PR 打开/更新时运行）
teamai ci extract-mr --url "$MR_URL" --mode comment --individual-comments

# 写入模式：合并后将审批通过的建议写入知识库
teamai ci extract-mr --url "$MR_URL" --mode write --team-repo ./team-repo --individual-comments
```

工作流程：

1. MR 打开/更新 → CI 触发 `--mode comment`，提取知识建议并发布为 MR 评论
2. Reviewer 审查评论，对不需要的建议添加拒绝标记（GitHub 👎 / TGit ☝️）
3. MR 合并 → CI 触发 `--mode write`，将未被拒绝的建议写入团队知识仓库

如果审核状态 API 返回非 2xx 响应，write 模式会按 fail-closed 处理：任务失败退出，且不会向团队知识仓库写入文件、提交或 push。

评论模式在无法列出已有 marker 评论时也会按 fail-closed 处理，避免临时的 Provider 错误创建重复评论。

模板及配置说明见 [`examples/ci/`](../../../examples/ci/README.md)。
