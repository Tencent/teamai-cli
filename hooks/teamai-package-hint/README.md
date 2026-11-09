# teamai-package-hint

At session start, when the team's package declarations in `teamai.yaml` changed since this machine last applied them, teamai tells the agent to review them and run `teamai packages`. This folder holds the text of that hint.

## Replace it

Copy the folder to the root of the team repo, edit `message.md`, and push. The next `teamai pull` checks it and delivers it:

```bash
cp -r "$(npm root -g)/teamai-cli/hooks/teamai-package-hint" hooks/
```

This hint takes no parameters, so `HOOK.yaml` holds only `description`. Keep every `.md` text: a replacement that misses one is refused. Pull also refuses a `with:` key, a `command`, and a variable the text does not offer. Each time it names the field, and teamai's folder stays in force. A replacement belongs at the root of the team repo, not in a namespace.

## Texts

| File | Shown | Variables |
|---|---|---|
| `message.md` | When the declarations changed | `{{ summary }}`, such as "2 npm packages and 1 Claude plugin" |

`{{ summary }}` stays English. With `language: zh` or `en` in `teamai.yaml`, teamai prints `message.zh.md` or `message.en.md` when the folder has it, and `message.md` otherwise.

## Related settings

- `TEAMAI_PACKAGE_HINT_DISABLED=1` turns the hint off on one machine.
- `language` picks the text variant.
