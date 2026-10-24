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

ZCode's CLI reads hooks from `~/.zcode/cli/config.json` even in single-repo mode. `hooks inject` moves teamai's old project-file entries there, keeps personal settings, and gates team hooks to their project. `hooks list` and `doctor` check that same HOME file.

Auto-update runs when a session ends. The team can turn it off. A member's own policy wins:

```yaml
# teamai.yaml
autoUpdate: false
```

```yaml
# ~/.teamai/config.yaml
updatePolicy: skip    # auto, prompt, or skip
```

For OpenClaw's default workspace, `doctor` checks the whole `AGENTS.md`, including personal text, against `agents.defaults.bootstrapMaxChars` and `bootstrapTotalMaxChars` in the resolved `openclaw.json`. Their defaults are 20,000 and 60,000 characters. Shorten the file or review these limits if it would be truncated or skipped; `pull` does not truncate your instructions. Per-agent overrides require checking that agent's configuration separately.
