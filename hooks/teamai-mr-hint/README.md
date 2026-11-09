# teamai-mr-hint

At session start, teamai lists the team's recently merged MRs that are not in the knowledge base yet, and offers to turn them into learnings. This folder holds how far back it looks and the texts of the offer.

## Replace it

Copy the folder to the root of the team repo, edit it, and push. The next `teamai pull` checks it and delivers it:

```bash
cp -r "$(npm root -g)/teamai-cli/hooks/teamai-mr-hint" hooks/
```

```yaml
# hooks/teamai-mr-hint/HOOK.yaml
description: Offer the last two weeks of MRs
with:
  lookback_days: 14
```

A key you leave out of `with:` keeps teamai's value. Keep every `.md` text: a replacement that misses one is refused. Pull also refuses a value out of its range, a key teamai does not take, a `command`, and a variable a text does not offer. Each time it names the field, and teamai's folder stays in force. A replacement belongs at the root of the team repo, not in a namespace.

## Parameters

| Key | Default | Range | What it does |
|---|---|---|---|
| `lookback_days` | 7 | 1-90 | How many days back an MR may have merged |
| `max_mrs` | 10 | 1-100 | Most MRs listed, and the page size asked of the provider |

## Texts

| File | Shown | Variables |
|---|---|---|
| `offer-command.md` | Where the agent cannot start the workflow, such as a session teamai launched: names `teamai import --from-mr` | `{{ count }}`, `{{ mr_lines }}`, `{{ command }}` |
| `offer-workflow.md` | Where the agent can start the teamai-import-from-mr workflow | `{{ count }}`, `{{ mr_lines }}`, `{{ command }}` |

`{{ mr_lines }}` holds one line per MR. From a `.en.md` file it reads `- <title> (merged: YYYY-MM-DD)`, and from any other file `- <title>（merged: YYYY-MM-DD）`. In `offer-workflow` each line ends with the MR's URL.

The base files are bilingual. With `language: en` in `teamai.yaml`, teamai prints `offer-command.en.md` and `offer-workflow.en.md`, which are English only. With `language: zh`, it prints a `.zh.md` file when the folder has one, and the base file otherwise.

## Related settings

- `sharing.mrHint.enabled: false` in `teamai.yaml` turns the hint off for the team. One machine turns it off with `mrHintEnabled: false` in `~/.teamai/config.yaml`, or `TEAMAI_MR_HINT_DISABLED=1`.
- `language` picks the text variants.
