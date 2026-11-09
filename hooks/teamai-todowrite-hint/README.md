# teamai-todowrite-hint

English | [中文](README.zh-CN.md)

Once the agent plans a task with TodoWrite, teamai suggests one search of the team knowledge base through the `teamai-recall` subagent, once per session. This folder holds the text of that suggestion.

## Replace it

Copy the folder to the root of the team repo, edit `message.md`, and push. The next `teamai pull` checks it and delivers it:

```bash
cp -r "$(npm root -g)/teamai-cli/hooks/teamai-todowrite-hint" hooks/
```

This hint takes no parameters, so `HOOK.yaml` holds only `description`. Keep every `.md` text: a replacement that misses one is refused. Pull also refuses a `with:` key, a `command`, and a variable the text does not offer. Each time it names the field, and teamai's folder stays in force. A replacement belongs at the root of the team repo, not in a namespace.

## Texts

| File | Shown | Variables |
|---|---|---|
| `message.md` | After a TodoWrite call | none |

`message.md` is bilingual. With `language: en` in `teamai.yaml`, teamai prints `message.en.md`, which is English only. With `language: zh`, it prints `message.zh.md` when the folder has one, and `message.md` otherwise.

## Related settings

- `TEAMAI_RECALL_DISABLED=1` turns the hint off, with recall.
- `language` picks the text variant.
