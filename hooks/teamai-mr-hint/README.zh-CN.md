# teamai-mr-hint

[English](README.md) | 中文

会话开始时，teamai 列出团队最近合并、还没进知识库的 MR，并提出把它们整理成 learning。这个目录保存它往回看多远，以及这条提议的文案。

## 替换它

把目录复制到团队仓库根目录，修改后推送。下一次 `teamai pull` 会检查并交付它：

```bash
cp -r "$(npm root -g)/teamai-cli/hooks/teamai-mr-hint" hooks/
```

```yaml
# hooks/teamai-mr-hint/HOOK.yaml
description: Offer the last two weeks of MRs
with:
  lookback_days: 14
```

`with:` 里没写的键沿用 teamai 的值。每个 `.md` 文案都要保留：缺少任何一个的替换会被拒绝。pull 也会拒绝超出范围的值、teamai 不接受的键、`command`，以及文案不提供的变量。每次都会指出是哪个字段，并继续使用 teamai 自带的目录。替换必须放在团队仓库根目录，不能放在命名空间里。

## 参数

| 键 | 默认值 | 范围 | 作用 |
|---|---|---|---|
| `lookback_days` | 7 | 1-90 | MR 最多可以是多少天前合并的 |
| `max_mrs` | 10 | 1-100 | 最多列出多少个 MR，也是向代码托管平台请求的每页数量 |

## 文案

| 文件 | 显示位置 | 变量 |
|---|---|---|
| `offer-command.md` | agent 不能启动工作流时，例如 teamai 自己启动的会话：给出 `teamai import --from-mr` | `{{ count }}`、`{{ mr_lines }}`、`{{ command }}` |
| `offer-workflow.md` | agent 能启动 teamai-import-from-mr 工作流时 | `{{ count }}`、`{{ mr_lines }}`、`{{ command }}` |

`{{ mr_lines }}` 每个 MR 一行。来自 `.en.md` 文件时是 `- <title> (merged: YYYY-MM-DD)`，来自其他文件时是 `- <title>（merged: YYYY-MM-DD）`。在 `offer-workflow` 里，每行末尾带上 MR 的 URL。

基础文件是中英双语的。`teamai.yaml` 里设了 `language: en` 时，teamai 打印只有英文的 `offer-command.en.md` 和 `offer-workflow.en.md`。设了 `language: zh` 时，目录里有 `.zh.md` 文件就打印它，否则打印基础文件。

## 相关设置

- `teamai.yaml` 里的 `sharing.mrHint.enabled: false` 为整个团队关闭这条提示。单台机器用 `~/.teamai/config.yaml` 里的 `mrHintEnabled: false`，或 `TEAMAI_MR_HINT_DISABLED=1` 关闭。
- `language` 决定用哪个文案版本。
