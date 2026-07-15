# CI 调度示例说明

本目录提供若干 CI 示例：定期同步团队 codebase 摘要（`*-teamai-sync`）、MR 知识提炼（`*-mr-extract`）、codebase 产物一致性检查（`codebase-lint.yml`）。

## 文件说明

| 文件 | 用途 |
|------|------|
| `github-actions-teamai-sync.yml` | GitHub Actions 示例，复制到 `.github/workflows/teamai-sync.yml` 启用 |
| `coding-ci-teamai-sync.yaml`     | Coding CI 示例，复制到 `.coding-ci.yaml` 或合并到现有配置 |
| `github-actions-mr-extract.yml` | GitHub Actions 示例：PR 创建/更新时提炼知识并评论，PR 合入后写入团队知识仓库 |
| `coding-ci-mr-extract.yaml`     | 智研 / Coding CI（工蜂）示例：MR 创建/更新时提炼知识并评论，MR 合入后写入团队知识仓库 |

## 使用前提

1. **这两个文件不会自动启用**，需要团队手动复制到对应位置。
2. 触发频率建议每日一次（示例中为 UTC 02:17）。
3. 必须配置好对应 secret：
   - GitHub Actions：`TEAMAI_SYNC_TOKEN`（需要 repo 读写权限）
   - Coding CI：`TAI_PAT_TOKEN`（同上）
4. `.teamai/repo-whitelist.yaml` 必须存在且至少包含一个 repo entry。

## 增量模式说明

示例中使用了 `--incremental` 标志：

- **首次运行**：缓存目录不存在，自动降级为全量 `shallow clone`，速度同初次导入。
- **后续运行**：检测到缓存 + `LAST_SYNC` 存在，执行 `fetch + reset`，仅拉取增量，速度显著提升。
- **fetch 失败**：自动 fallback 到全量 clone，不阻塞流程。

## 产物提交

同步完成后，CI 示例会自动将以下文件 commit & push 回主仓库：

- `docs/team-codebase/` — 各仓库 codebase 摘要及聚合索引
- `.teamai/domains.yaml` — 域归属记录
- `.teamai/domains.history.jsonl` — 域操作历史（含漂移检测记录）

## codebase lint 示例（`codebase-lint.yml`）

`codebase-lint.yml` 对 `docs/team-codebase/` 与 `.teamai/` 产物做全局一致性检查：

- **触发条件**：PR 修改 codebase 相关文件时、每日 04:37 UTC 定时、手动触发
- **检查内容**：锚点未闭合、孤儿 md、source 失效、计数不一致、stale 等 12 类问题
- **退出码**：有 `high` 级问题时非零退出，可直接拦截 PR 合入；报告以 artifact 形式上传

## MR 知识提炼示例（`*-mr-extract`）

`github-actions-mr-extract.yml` / `coding-ci-mr-extract.yaml` 在 MR/PR 生命周期中自动提炼知识：

- **MR/PR 创建/更新时**：`teamai ci extract-mr --mode comment`，把知识建议以评论贴到 MR/PR 上
- **MR/PR 合入后**：`teamai ci extract-mr --mode write`，将 learning、docs、`.teamai/`、`teamwiki/` 图谱写入团队知识仓库并 push

### 使用前提

1. 这两个文件是**模板**，使用前需按文件内注释替换占位符（本仓库路径、知识仓库路径、默认分支、AI 网关地址）。
2. `teamai ci extract-mr` 会调用本地 AI CLI 做提炼，因此**必须**安装 AI CLI（`@anthropic-ai/claude-code`）并配置凭证：
   - GitHub Actions：`ANTHROPIC_AUTH_TOKEN`（Secret）+ `ANTHROPIC_BASE_URL` / 模型名（Variables）
   - 智研 / Coding CI（工蜂）：`ANTHROPIC_AUTH_TOKEN`、`TAI_PAT_TOKEN`（均为 Secret）
3. 需要对团队知识仓库有 push 权限的 token：GitHub 用 `TEAMAI_SYNC_TOKEN`，工蜂用 `TAI_PAT_TOKEN`。
4. 智研 / Coding CI（工蜂）的 MR 触发规则**必须写在 YAML 的 `mr:` 块**，仅在 UI 勾选无效。
