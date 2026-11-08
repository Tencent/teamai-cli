# CI 调度示例说明

<p align="center">
  <a href="README.md">English</a> | <a href="README.zh-CN.md">中文</a>
</p>

本目录提供若干 CI 示例：MR 知识提炼（`*-mr-extract`）、teamwiki 一致性检查（`codebase-lint.yml`）。

## 文件说明

| 文件 | 用途 |
|------|------|
| `github-actions-mr-extract.yml` | GitHub Actions 示例：PR 创建/更新时提炼知识并评论，PR 合入后写入团队知识仓库 |
| `coding-ci-mr-extract.yaml`     | 智研 / Coding CI（工蜂）示例：MR 创建/更新时提炼知识并评论，MR 合入后写入团队知识仓库 |
| `gitlab-ci-mr-extract.yml`      | GitLab CI（自建实例，API v4）示例：MR 创建/更新时提炼知识并评论，合入默认分支后写入团队知识仓库 |
| `codebase-lint.yml`             | GitHub Actions 示例：对 teamwiki 知识图谱做全局一致性检查 |

## MR 知识提炼示例（`*-mr-extract`）

`github-actions-mr-extract.yml` / `coding-ci-mr-extract.yaml` 在 MR/PR 生命周期中自动提炼知识：

- **MR/PR 创建/更新时**：`teamai ci extract-mr --mode comment`，把知识建议以评论贴到 MR/PR 上
- **MR/PR 合入后**：`teamai ci extract-mr --mode write`，将 learning、`teamwiki/` 图谱写入团队知识仓库并 push。`teamwiki/` 走 `teamai import --dir . --incremental` 的同一流程：在合入后的源码 checkout 中运行，只重新提取改过的文件，写入 `teamwiki/evidence/code/<provider>__<owner>__<repo>/`（与 `teamai import --from-repo` 同一 slug）

### 使用前提

1. 这两个文件是**模板**，使用前需按文件内注释替换占位符（本仓库路径、知识仓库路径、默认分支、AI 网关地址）。
2. `teamai ci extract-mr` 会调用本地 AI CLI 做提炼，因此**必须**安装 AI CLI（`@anthropic-ai/claude-code`）并配置凭证：
   - GitHub Actions：`ANTHROPIC_AUTH_TOKEN`（Secret）+ `ANTHROPIC_BASE_URL` / 模型名（Variables）
   - 智研 / Coding CI（工蜂）：`ANTHROPIC_AUTH_TOKEN`、`TGIT_TOKEN`（均为 Secret）
3. 需要对团队知识仓库有 push 权限的 token：GitHub 用 `TEAMAI_SYNC_TOKEN`，工蜂用 `TGIT_TOKEN`。
4. 智研 / Coding CI（工蜂）的 MR 触发规则**必须写在 YAML 的 `mr:` 块**，仅在 UI 勾选无效。
5. write 模式的工作目录必须是合入后的源码 checkout，团队知识仓库必须克隆在 checkout **之外**（模板分别用并排目录和 `/tmp/teamai-team-repo`）；克隆在 checkout 内时，CLI 会跳过 `teamwiki/` 更新，只写 learning。
6. GitLab CI（`gitlab-ci-mr-extract.yml`）：凭据用 `GITLAB_TOKEN`（GitLab PAT，`api` 权限）；GitLab 没有 "MR merged" 原生触发器，合入后的 write 阶段跑在默认分支 push pipeline 上，按 merge/squash commit 反查 MR。MR 上不想要的建议点 👎 award emoji 拒绝。
7. 源码 checkout 需要包含合入提交和它的父提交，git 才能知道这次合入改了哪些文件：`actions/checkout` 设 `fetch-depth: 2` 或更多（默认是 1）。GitLab 默认的 `GIT_DEPTH` 是 20，够用。
8. 调 GitHub 的请求（评论、reaction、git 用户）在设置了 `GITHUB_API_URL` 时发往它（GitHub Actions 会自动设置），否则发往 `https://api.github.com`。
9. 不需要 `teamai init`：命令在一个临时作用域里运行默认 workflow `teamai-ci-extract-mr`，结束时删除该作用域。带 `teamai.yaml` 的 `--team-repo` 就是这个作用域的团队仓库：它的 `language` 和 `workflows/` 生效，团队文件 `workflows/teamai-ci-extract-mr.yaml` 会替换默认 workflow。

一个最小的合入后 job（GitHub Actions）：

```yaml
write:
  if: github.event.pull_request.merged == true
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
      with: { ref: "${{ github.event.pull_request.merge_commit_sha }}", fetch-depth: 2, path: source }
    - uses: actions/checkout@v4
      with: { repository: myteam/knowledge, token: "${{ secrets.TEAMAI_SYNC_TOKEN }}", path: team-repo }
    - run: npm install -g teamai-cli @anthropic-ai/claude-code
    - working-directory: source
      run: teamai ci extract-mr --url "${{ github.event.pull_request.html_url }}" --mode write --team-repo ../team-repo
      env:
        GITHUB_TOKEN: ${{ secrets.TEAMAI_SYNC_TOKEN }}
        ANTHROPIC_AUTH_TOKEN: ${{ secrets.ANTHROPIC_AUTH_TOKEN }}
```

输出：

```text
✔ MR data fetched
ℹ ✅ Learning draft generated: Retry uploads on 5xx
ℹ    Tags: retry, s3
✔ Learning written: learnings/2026-11-05-Retry-uploads-on-5xx.md
✔ Pushed to the team repo
```

合入改了源码文件时，`Learning written` 之前还会打印 `teamwiki/` 的更新。

## teamwiki 一致性检查示例（`codebase-lint.yml`）

`codebase-lint.yml` 对 `teamwiki/` 知识图谱做全局一致性检查：

- **触发条件**：PR 修改 codebase 相关文件时、每日 04:37 UTC 定时、手动触发
- **检查内容**：锚点未闭合、孤儿 md、source 失效、计数不一致、stale 等一致性问题
- **退出码**：有 `high` 级问题时非零退出，可直接拦截 PR 合入；报告以 artifact 形式上传
