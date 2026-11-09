# teamai-import-from-repo

[English](README.md) | 中文

把仓库或本地检出导入 teamwiki。对每一个，它提取代码，向 AI 工具要它的叙述，运行 `teamai-codebase-enrich` 和 `teamai-codebase-deep-enrich`，然后发布。之后刷新 teamwiki 的索引，并统一发布一次。

`teamai import --dir`、`--from-repo`、`--from-repo-list` 和 `--from-org` 会启动它。

## 文件

| 文件 | 是什么 |
|---|---|
| `WORKFLOW.yaml` | 步骤 |
| `narrative.md` | 为仓库的 `codebase.md` 向 AI 工具提的问题。它读取 `{{ steps.stage.outputs.context }}`，即 stage 步骤收集的仓库上下文 |

## 输入

| 输入 | 含义 |
|---|---|
| `wiki_root` | 每一项落入的 teamwiki |
| `mode` | 启动这次运行的命令：`dir`、`repo`、`list`、`org`、`update` 或 `ci`。它决定这一批如何发布和汇总；`update` 和 `ci` 由命令自己发布 |
| `items` | 每一项是一个远程仓库（`kind: repo`，`source` 为 URL，`auth` 为 `token`、`ssh`、`public` 或 `''`）或一个本地检出（`kind: dir`，`source` 为目录），带有 `domain`、`slug`、`repo_url`（未提供时为 `''`）和 `mr_urls` |
| `settings` | `depth`、`ssh`、`incremental`、`skip_enrich`、`max_files`（`0` 保持默认）和 `team_repo`，即存放 `wiki_root` 的团队仓库（没有时为 `''`） |
| `skipped` | 命令在运行前排除了多少项，计入摘要 |
| `concurrency` | 同时导入多少项 |

## 输出

| 输出 | 含义 |
|---|---|
| `text` | 命令打印的摘要 |
| `exit_code` | 有项失败时为 `1`；其他项仍会完成 |
| `imported` | 每一项的 `source`、`slug`、`updated` 和 `failed` |

## 相关设置

- 编写叙述的 AI 工具：你配置里的 `workflows.tools`、`TEAMAI_AI_TOOL` 或 `ai.tool`。这里指定的工具无法运行时，该项在发布任何内容之前就会失败。

## 替换它

把这个目录复制到团队仓库的 `workflows/teamai-import-from-repo/`，修改后推送，再运行 `teamai pull`。团队的目录会整体替换这个目录：保留 `WORKFLOW.yaml` 引用的每个文件，并保留输入和输出，因为上面的命令会传这些输入、读这些输出。
