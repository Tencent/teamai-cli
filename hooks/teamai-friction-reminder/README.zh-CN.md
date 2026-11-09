# teamai-friction-reminder

[English](README.md) | 中文

Stop 时，teamai 会给这次会话打一个摩擦分。分数和工具调用次数都达到下面的阈值时，它会提醒 agent 分享这次会话学到的东西。这个目录保存这些阈值和提醒的文案。

## 替换它

把目录复制到团队仓库根目录，修改后推送。下一次 `teamai pull` 会检查并交付它，之后的 Stop 就会使用它：

```bash
cp -r "$(npm root -g)/teamai-cli/hooks/teamai-friction-reminder" hooks/
```

```yaml
# hooks/teamai-friction-reminder/HOOK.yaml
description: Remind only after longer sessions
with:
  min_tools: 30
```

`with:` 里没写的键沿用 teamai 的值。`weights: { reject: 30 }` 不会改另外两个权重。每个 `.md` 文案都要保留：缺少任何一个的替换会被拒绝。pull 也会拒绝超出范围的值、teamai 不接受的键、`command`，以及文案不提供的变量。每次都会指出是哪个字段，并继续使用 teamai 自带的目录。替换必须放在团队仓库根目录，不能放在命名空间里。

## 参数

| 键 | 默认值 | 范围 | 作用 |
|---|---|---|---|
| `min_tools` | 15 | 1-1000 | 提醒出现前会话至少要有的工具调用次数 |
| `min_score` | 20 | 1-1000 | 会话至少要达到的摩擦分 |
| `weights.interrupt` | 20 | 0-100 | 每次用户打断 agent 加的分 |
| `weights.reject` | 20 | 0-100 | 每次用户拒绝工具调用加的分 |
| `weights.correction` | 20 | 0-100 | 每条纠正 agent 的提示加的分 |
| `tool_error_tiers` | `[{min: 8, points: 25}, {min: 5, points: 18}, {min: 3, points: 10}]` | 1-5 档，`min` 1-1000 且严格递减，`points` 0-100 | agent 重试过的失败工具调用加的分：取次数达到的第一档 `min` |
| `skill_bonus` | 5 | 0-100 | 会话用到 skill 时加的分 |
| `diversity_bonus_max` | 5 | 0-100 | 用到很多不同工具时最多加的分 |
| `knowledge_gap_bonus` | 20 | 0-100 | recall 什么都没找到时加的分 |
| `low_quality_bonus` | 10 | 0-100 | recall 只找到弱匹配时加的分 |
| `low_quality_threshold` | 5.0 | 0-100 | recall 最高分低于它时，匹配算作弱匹配 |

## 文案

提醒由标题、会话有任务时的任务行和行动组成，之间空一行。

| 文件 | 显示位置 | 变量 |
|---|---|---|
| `problem.md` | 标题，不点出具体摩擦 | 无 |
| `problem-reasons.md` | 标题，点出具体摩擦 | `{{ reasons }}`，例如 "you interrupted the AI twice" |
| `gap.md` | recall 什么都没找到或只有弱匹配时的标题 | 无 |
| `gap-reasons.md` | 同上，点出具体摩擦 | `{{ reasons }}` |
| `task.md` | 任务行 | `{{ task }}`，会话的第一条提示压成一行，密钥已打码，过长会截断 |
| `action.md` | 行动 | 无 |
| `action-gap.md` | 知识缺口之后的行动 | 无 |
| `action-share-learnings.md` | agent 能启动 teamai-share-learnings 工作流时的行动 | `{{ command }}`，描述该工作流的命令 |

`{{ reasons }}` 保持英文。`teamai.yaml` 里设了 `language: zh` 或 `en` 时，目录里有 `<text>.zh.md` 或 `<text>.en.md` 就打印它，否则打印 `<text>.md`。

## 相关设置

- `teamai.yaml` 里的 `sharing.contributeHint.enabled: false` 为整个团队关闭提醒。单台机器用 `~/.teamai/config.yaml` 里的 `contributeHintEnabled: false`，或 `TEAMAI_CONTRIBUTE_HINT_DISABLED=1` 关闭。
- 只有 recall 开着时才会出现提醒。
- `teamai.yaml` 里的 `sharing.intervention.correctionKeywords` 在 teamai 自带的词之外，再加一些让提示算作纠正的词。
- `language` 决定用哪个文案版本。
