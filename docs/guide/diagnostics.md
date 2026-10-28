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

Generated-hook checks accept a launcher from another installation when the handler logic matches. Running `doctor` from a different CLI path alone does not require reinstalling hooks. The saved paths must be files, and the runtime must be named `node`, `nodejs`, or `bun`. Node names may have a numeric version suffix such as `node-22` or `nodejs-22`; `.exe` names are also accepted. An invalid saved launcher or changed handler still requires `teamai hooks inject` or `teamai pull`.

If a file occupies a tool's skills directory, `pull` keeps it, names the blocked path, and continues delivering to other tools. `doctor` fails the skills-directory check instead of treating the skipped tool as delivered. Move the file aside, then run `teamai pull` again to deliver the missing skills. `uninstall` preserves the blocking file and continues cleaning the tool's other managed resources.

ZCode's CLI reads hooks from `~/.zcode/cli/config.json` even in single-repo mode. `hooks inject` moves teamai's old project-file entries there, keeps personal settings, and gates team hooks to their project. `hooks list` and `doctor` check that same HOME file.

Auto-update runs when a session ends. The team can turn it off. A member's own policy wins. The CLI is shared by the machine, so the user-scope config and its team decide when there is one, else the workspace the session runs in:

```yaml
# teamai.yaml
autoUpdate: false
```

```yaml
# ~/.teamai/config.yaml, else ~/.teamai/projects/<slug>/config.yaml
updatePolicy: skip    # auto, prompt, or skip
```

For OpenClaw's default workspace, `doctor` checks the whole `AGENTS.md`, including personal text, against `agents.defaults.bootstrapMaxChars` and `bootstrapTotalMaxChars` in the resolved `openclaw.json`. Their defaults are 20,000 and 60,000 characters. Shorten the file or review these limits if it would be truncated or skipped; `pull` does not truncate your instructions. Per-agent overrides require checking that agent's configuration separately.

OpenCode hooks use the Node executable and TeamAI entry recorded by `teamai hooks inject` or `teamai pull`, so a service does not need `teamai` on PATH. After moving or reinstalling Node or TeamAI, run either command again and restart OpenCode.

`doctor` checks the whole Hermes `SOUL.md`, including personal text. An explicit `context_file_max_chars` in Hermes' `config.yaml` is a hard cap. Without it, the cap depends on the selected model; files over the 20,000-character minimum produce an informational warning. Shorten the file or review the cap; `pull` does not truncate your instructions.

Pi extensions launch the Node executable and TeamAI entry recorded by `teamai pull` or `teamai hooks inject`. After moving or reinstalling either, rerun one of those commands and restart Pi.

Hermes hooks and its instructions plugin launch the Node executable and TeamAI entry recorded by `teamai hooks inject` or `teamai pull`. After moving or reinstalling either, rerun one of those commands and restart Hermes.
