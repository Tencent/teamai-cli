# TODOS

## ~~Cursor PostToolUse Hook Support~~ ✅ DONE
**Completed:** 2026-03-22 — Cursor hooks API 已稳定支持 postToolUse。已实现：
- `hooks.ts`: 注入 postToolUse hook (matcher: Read) 到 Cursor hooks.json
- `usage-tracker.ts`: trackFromStdin 支持 Read 工具 + SKILL.md 路径检测，tool 字段区分 cursor/claude
- 完整测试覆盖
**Added:** 2026-03-19 by /plan-eng-review

## Digest 自动推送到企微群
**What:** 将 `teamai digest` 输出通过 webhook 自动发送到企业微信群。
**Why:** 目前 digest 需要手动运行 `teamai digest`。自动推送提高团队 AI 工具使用感知，让团队成员被动接收周报而不是主动去查。
**Pros:** 零摩擦的团队 AI 使用可见性，推动 skill 采用率。
**Cons:** 需要配置企微 webhook URL，增加外部依赖。群消息过多可能被忽视。
**Context:** Feature 7 (digest) 实现后，可通过 wecom-bot skill 的 webhook 机制发送。需要在 teamai.yaml 中新增 webhook URL 配置字段。建议支持 cron 定时触发（每周一早上）。
**Effort:** M (human: ~3 days / CC: ~20min)
**Priority:** P3
**Depends on:** Feature 7 (digest) 完成。
**Added:** 2026-03-19 by /plan-ceo-review

## 增量搜索索引更新
**What:** 当文档数超过阈值时，基于 mtime 增量更新 search-index.json 而非全量重建。
**Why:** V1 全量重建简单可靠，但随着文档增长（数千篇）每次 pull 的索引重建会变慢。
**Pros:** Pull 速度不会随文档数线性增长。
**Cons:** 增量更新复杂度高（删除、重命名、损坏恢复都需要处理）。
**Context:** Eng review Issue 4 中决定 V1 先全量重建并记录耗时。search-index.ts 中应有耗时监控，当超过 2 秒时输出 warning。该 warning 触发后再考虑实现增量更新。增量方案基于文件 mtime 比对，只重建新增/修改的 doc 条目。
**Effort:** M (human: ~2 days / CC: ~30min)
**Priority:** P3
**Depends on:** Phase 2 (搜索 + 投票) 完成。
**Added:** 2026-03-19 by /plan-eng-review

## E2E 负面场景测试
**What:** 为 E2E 测试新增 token 过期、仓库无效、网络超时等负面场景用例。
**Why:** 现有 E2E 全是 happy path，错误处理逻辑（Error Handling 表格中的 5 种场景）未被验证。
**Pros:** 确保 CI 失败时给出清晰提示（如 "TEAMAI_TEST_TOKEN expired"），而不是不明报错。
**Cons:** 需要 mock 或制造失败环境，写起来比 happy path 复杂。
**Context:** CI pipeline 设计文档 `docs/designs/ci-pipeline.md` 的 Error Handling 表列了 5 种错误场景。Eng review Issue 6 中决定先只迁移 happy path，负面测试等 CI 基础版跑通后再加。优先覆盖：(1) token 未设置/过期 (2) 无效 repo URL (3) 网络超时。
**Effort:** S (human: ~2 hours / CC: ~10min)
**Priority:** P3
**Depends on:** CI pipeline 基础版（.gitlab-ci.yml + E2E 迁移）完成。
**Added:** 2026-03-20 by /plan-eng-review
