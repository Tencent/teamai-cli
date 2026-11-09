# teamai-import-from-mr

[English](README.md) | 中文

把已合并的 MR 或 PR 整理成团队 learning。你的 AI 工具为每个 MR 起草一份，由人接受、编辑或跳过每份草稿，接受的草稿按 `teamai contribute` 的方式发布。

`teamai import --from-mr` 会启动它，`teamai ci extract-mr` 通过 `teamai-ci-extract-mr` 运行它，会话开始时的 MR 提示也会提出运行它。

## 文件

| 文件 | 是什么 |
|---|---|
| `WORKFLOW.yaml` | 步骤 |
| `draft.en.md` | `language` 为 `en` 时，为每个 MR 向 AI 工具提的问题 |
| `draft.zh.md` | 同上，`language` 为 `zh` 时 |

两份草稿都是模板。`{{ steps.fetch.outputs.<field> }}` 读取 `teamai import fetch-mr` 为该 MR 找到的内容：`url`、`title`、`description`、`commits`、`diff`、`threads`、`thread_count`、`author`、`date`。

## 输入

| 输入 | 含义 |
|---|---|
| `mrs` | MR 或 PR 的 URL |
| `all` | 不询问，接受所有草稿 |
| `publish` | `false` 时不写入也不推送任何东西，草稿只作为运行的输出 |
| `dir` | 团队仓库；配合 `output` 时，是每份草稿以 `learning.md` 写入的目录（多份时为 `learning-<n>.md`）。默认 `''` |
| `output` | 把草稿作为文件写入 `dir` |
| `discussions` | 读取 MR 的评审讨论 |
| `language` | `en` 或 `zh`：使用哪份草稿文件 |

## 输出

| 输出 | 含义 |
|---|---|
| `text` | 命令打印的摘要 |
| `exit_code` | 有 MR 失败时为 `1`；其他 MR 仍会完成 |
| `learnings` | 每条已发布 learning 的 `url`、`title`、`file` 和 `repo_url` |

## 相关设置

- `teamai.yaml` 里的 `language`：为 `en` 时命令传 `language: en`，否则传 `zh`。
- `teamai.yaml` 里的 `sharing.mrHint.enabled`：会话开始时的提示是否列出已合并的 MR 并提出运行这个工作流。
- 起草的 AI 工具：你配置里的 `workflows.tools`、`TEAMAI_AI_TOOL` 或 `ai.tool`。

## 替换它

把这个目录复制到团队仓库的 `workflows/teamai-import-from-mr/`，修改后推送，再运行 `teamai pull`。团队的目录会整体替换这个目录：保留 `WORKFLOW.yaml` 引用的每个文件，并保留输入和输出，因为上面的命令会传这些输入、读这些输出。
