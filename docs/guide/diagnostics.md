# Diagnostics and maintenance

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

---

```bash
teamai doctor
teamai doctor --json
teamai stats
teamai update --check
teamai update
teamai digest
teamai remove skills <name>
teamai remove rules <name> --force
```

`doctor` exits 1 when any check fails. `stats` adds a recall section when that scope has recall runs. See [Recall adoption and upvotes](./knowledge.md#recall-adoption-and-upvotes).

If a file occupies a tool's skills directory, `pull` keeps it, names the blocked path, and continues delivering to other tools. Move the file aside, then run `teamai pull` again to deliver the missing skills.

Auto-update runs when a session ends. The team can turn it off. A member's own policy wins:

```yaml
# teamai.yaml
autoUpdate: false
```

```yaml
# ~/.teamai/config.yaml
updatePolicy: skip    # auto, prompt, or skip
```
