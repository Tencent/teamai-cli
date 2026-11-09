# teamai-env-hint

At session start, teamai names the team env variables and secrets this scope delivers, and tells the agent to run the commands that need them through `teamai env exec`. This folder holds the texts of that hint.

## Replace it

Copy the folder to the root of the team repo, edit the texts, and push. The next `teamai pull` checks it and delivers it:

```bash
cp -r "$(npm root -g)/teamai-cli/hooks/teamai-env-hint" hooks/
```

This hint takes no parameters, so `HOOK.yaml` holds only `description`. Keep every `.md` text: a replacement that misses one is refused. Pull also refuses a `with:` key, a `command`, and a variable a text does not offer. Each time it names the field, and teamai's folder stays in force. A replacement belongs at the root of the team repo, not in a namespace.

## Texts

The hint joins the texts it shows with a space, in this order.

| File | Shown | Variables |
|---|---|---|
| `variables.md` | When the scope delivers variables | `{{ variables }}`, such as `API_URL (the staging API), LOG_LEVEL` |
| `secrets.md` | When the scope delivers secrets | `{{ secrets }}`, in the same form |
| `exec.md` | Always | none |
| `secrets-rule.md` | When the scope delivers secrets | none |

With `language: zh` or `en` in `teamai.yaml`, teamai prints `<text>.zh.md` or `<text>.en.md` when the folder has it, and `<text>.md` otherwise.

## Related settings

- The hint shows nothing when the scope delivers no variable and no secret.
- `language` picks the text variants.
