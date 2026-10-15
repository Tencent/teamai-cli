# 团队上下文

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

---

团队上下文是 learnings、代码知识图谱和 teamwiki。`teamai recall` 会一起搜。

## 知识沉淀与检索

### 贡献知识

会话里纠正过 AI、拒绝过工具调用，或 AI 反复重试失败的命令时，结束时会提示把这次经验交给团队：

```text
[teamai] This session may contain a problem worth documenting: you interrupted the AI twice.

Consider running `/teamai share what this session taught me` to summarize what you learned and share it with your team (or run `teamai skill get share`).
```

也可以直接交一份笔记：

```bash
teamai contribute --file /tmp/session.md
teamai contribute --file /tmp/session.md --namespace payments
```

`--namespace` 必须是当前 scope 在 `manifest/projects.yaml` 里声明的 learnings namespace。

不想要这条提醒时，在 `teamai.yaml` 里写：

```yaml
sharing:
  contributeHint:
    enabled: false
```

本机覆盖：`~/.teamai/config.yaml` 的 `contributeHintEnabled: false`，或 `TEAMAI_CONTRIBUTE_HINT_DISABLED=1`。

### 搜索知识

```bash
teamai recall "API 超时"
teamai recall --check "API 超时"
```

`--check` 只回答 `RELEVANT` 或 `NOT_RELEVANT`。代码库结果可能多一行 `Source freshness:`，状态含义见下面的[代码知识图谱](#代码知识图谱)。

### Recall 采纳与 upvote

这次会话打开了 recall 返回的文档，就计一次 upvote。也可以手动记：

```bash
teamai recall feedback --positive <docId>
teamai recall feedback --negative <docId>
```

`teamai stats` 在有记录时，会列出最近 10 个跑过 recall 的会话。

### 开启 / 关闭 Recall

默认关。团队打开：

```yaml
sharing:
  recall:
    enabled: true
```

```bash
teamai recall enable
teamai recall disable
teamai recall status
```

本机覆盖写在 `~/.teamai/config.yaml` 的 `recallEnabled`。`TEAMAI_RECALL_DISABLED=1` 强制关掉。关掉之后 pull 不再安装 recall；直接运行 `teamai recall` 仍然可以搜。

关闭 recall 不会隐藏 SessionStart 的近期已合入 MR 提示。这条提示指向 `teamai import --from-mr`，团队在开启 recall 前也可以先提炼并发布 learning。它有自己的开关，关闭它不会影响 `contributeHint`：

```yaml
sharing:
  mrHint:
    enabled: false
```

单机可在 `~/.teamai/config.yaml` 里设置 `mrHintEnabled: false`，或设置 `TEAMAI_MR_HINT_DISABLED=1`。

`teamai.yaml` 的 `language` 可以是 `en` 或 `zh`。`en` 时，内置 recall 规则、TodoWrite 提示和已合入 MR 提示只用英文。不写或写 `zh`，保持中英双语。下一次 `teamai pull` 按这个重写。

### 知识库维护

```bash
teamai recall maintenance --prune --dry-run
teamai recall maintenance --prune --archive
teamai recall maintenance --update-quality
```

`--archive` 收走置信度低于 0.15 的 learning。`--update-quality` 写出 `.draft.md`，改好后把文件名改成 `.md`。

### 晋升 Learnings

置信度至少 0.90、至少 5 次 upvote、至少 2 个贡献者、存在至少 14 天，可以升成 skill、rule 或 doc。

```bash
teamai recall promote
teamai recall promote <learningId> --category skills
teamai recall promote <learningId> --dry-run
```

## 代码知识图谱

`teamai import` 把源码仓库写成团队仓库里的 `teamwiki/`，`teamai recall` 会一起搜。所有来源都写进同一个位置：`<团队仓库>/teamwiki/evidence/code/<slug>/`，源码目录本身不会多出 `teamwiki/`。

```bash
teamai import --dir /path/to/project
teamai import --dir /path/to/project --incremental
teamai import --from-repo https://github.com/org/repo
teamai import --from-org myorg
teamai import --from-repo-list repos.yaml
teamai import --from-mr https://github.com/org/repo/pull/123
teamai import --from-repo https://github.com/org/repo --incremental
teamai import --from-repo https://github.com/org/repo --skip-enrich
```

`--incremental` 只重新提取上次导入后改过的文件，基线随每个代码库存在它自己的 `evidence/code/<slug>/` 里。远端仓库的 slug 是 `<provider>__<owner>__<repo>`，`--from-repo`、`--from-mr` 和 `teamai ci extract-mr` 用的都是它；`--dir` 用仓库名。

导入之后，用 `teamai codebase` 检查和加工同一份 `teamwiki/`：

```bash
teamai codebase --status
teamai codebase --deep-enrich --project <slug>
teamai codebase --lint
```

没有团队仓库时，给 `teamai import` 和 `teamai codebase` 都加上 `--output <dir>`，两者都用 `<dir>/teamwiki/`。

`teamai codebase --extract` 已移除，改用 `teamai import --dir`。

recall 结果里的 `Source freshness:`：`current` 是内容和上次扫描一致，`stale` 是变了，`missing` 是文件不在了，`unknown` 是对不上。`current` 也不代表文档本身正确。

只让一部分人看到某个代码库时：

```yaml
# manifest/projects.yaml
projects:
  - id: svc-a
    resources:
      wiki: [svc-a]
```

`svc-a` 是提取时用的 slug，不一定等于项目 id。

## CI 集成

从合并请求里抽出知识。打开时发评论，合并后把没被拒绝的写进团队仓库。

```bash
teamai ci extract-mr --url "$MR_URL" --mode comment --individual-comments
teamai ci extract-mr --url "$MR_URL" --mode write --team-repo ../team-repo --individual-comments
```

write 模式在合并后的源码 checkout 里运行，代码知识走和 `teamai import --dir . --incremental` 相同的流程，写进 `<team-repo>/teamwiki/evidence/code/<provider>__<owner>__<repo>/`，只重新提取改过的文件。团队仓库要克隆在 checkout 之外，否则它的文件会被当成源码提取，这一步会被跳过。

不要的建议打上拒绝标记：GitHub 用 👎，工蜂用 ☝️。模板在 [`examples/ci/`](../../../examples/ci/README.md)。

## 知识库健康报告

```bash
teamai dashboard
```

打开后进团队上下文，或直接访问 `http://localhost:3721/kb-report`。
