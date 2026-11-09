# teamai-friction-reminder

At Stop, teamai scores the session for friction. When the score and the tool count reach the thresholds below, it reminds the agent to share what the session taught. This folder holds those thresholds and the texts of the reminder.

## Replace it

Copy the folder to the root of the team repo, edit it, and push. The next `teamai pull` checks it and delivers it, and the next Stop uses it:

```bash
cp -r "$(npm root -g)/teamai-cli/hooks/teamai-friction-reminder" hooks/
```

```yaml
# hooks/teamai-friction-reminder/HOOK.yaml
description: Remind only after longer sessions
with:
  min_tools: 30
```

A key you leave out of `with:` keeps teamai's value. `weights: { reject: 30 }` keeps the other two weights. Keep every `.md` text: a replacement that misses one is refused. Pull also refuses a value out of its range, a key teamai does not take, a `command`, and a variable a text does not offer. Each time it names the field, and teamai's folder stays in force. A replacement belongs at the root of the team repo, not in a namespace.

## Parameters

| Key | Default | Range | What it does |
|---|---|---|---|
| `min_tools` | 15 | 1-1000 | Tool calls the session needs before the reminder can show |
| `min_score` | 20 | 1-1000 | Friction score the session needs |
| `weights.interrupt` | 20 | 0-100 | Points for each time the person stopped the agent |
| `weights.reject` | 20 | 0-100 | Points for each tool call the person refused |
| `weights.correction` | 20 | 0-100 | Points for each prompt that corrected the agent |
| `tool_error_tiers` | `[{min: 8, points: 25}, {min: 5, points: 18}, {min: 3, points: 10}]` | 1-5 tiers, `min` 1-1000 strictly descending, `points` 0-100 | Points for failing tool calls the agent retried: the first tier whose `min` the count reaches |
| `skill_bonus` | 5 | 0-100 | Points when the session used a skill |
| `diversity_bonus_max` | 5 | 0-100 | Most points for using many different tools |
| `knowledge_gap_bonus` | 20 | 0-100 | Points when no recall search found anything |
| `low_quality_bonus` | 10 | 0-100 | Points when recall found only weak matches |
| `low_quality_threshold` | 5.0 | 0-100 | Top recall score under which a match counts as weak |

## Texts

The reminder is a headline, the task line when the session has one, and an action, separated by a blank line.

| File | Shown | Variables |
|---|---|---|
| `problem.md` | Headline, with no friction to name | none |
| `problem-reasons.md` | Headline, naming the friction | `{{ reasons }}`, such as "you interrupted the AI twice" |
| `gap.md` | Headline when recall found nothing or only weak matches | none |
| `gap-reasons.md` | The same, naming the friction | `{{ reasons }}` |
| `task.md` | Task line | `{{ task }}`, the session's first prompt on one line, secrets redacted and long prompts cut |
| `action.md` | Action | none |
| `action-gap.md` | Action after a knowledge gap | none |
| `action-share-learnings.md` | Action where the agent can start the teamai-share-learnings workflow | `{{ command }}`, the command that describes the workflow |

`{{ reasons }}` stays English. With `language: zh` or `en` in `teamai.yaml`, teamai prints `<text>.zh.md` or `<text>.en.md` when the folder has it, and `<text>.md` otherwise.

## Related settings

- `sharing.contributeHint.enabled: false` in `teamai.yaml` turns the reminder off for the team. One machine turns it off with `contributeHintEnabled: false` in `~/.teamai/config.yaml`, or `TEAMAI_CONTRIBUTE_HINT_DISABLED=1`.
- The reminder shows only where recall is on.
- `sharing.intervention.correctionKeywords` in `teamai.yaml` adds words, beside teamai's own, that make a prompt count as a correction.
- `language` picks the text variants.
