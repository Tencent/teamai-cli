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

For tools with known agent search paths, `doctor` also checks that the configured agents directory is one the tool reads. A successful delivery to a custom directory alone does not pass this check; correct `toolPaths.<tool>.agents` in the team repo and pull again.

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

In a project, Hermes gets the team instructions from teamai's plugin section, which shares 8,000 characters and 32 sections with every other plugin's. Hermes fills them in section id order and drops a section that does not fit whole. Which sections other plugins add is only known once they run, so `doctor` reads the last outcome Hermes logged in `logs/agent.log`. That log names no project, so a dropped section warns:

```text
  ⚠ Hermes's last logged session took teamai's instructions section
    → The Hermes session at 2026-11-01 10:22:03 got none of the team instructions: teamai.instructions exceeded the aggregate session budget (8000 chars) and was skipped. Plugin sections share 8,000 characters and 32 sections, filled in id order, and other plugins' sections sorting before teamai.instructions took them first. Disable a plugin you do not need (plugins.disabled in /home/ana/.hermes/config.yaml) or shorten its section, then start a new Hermes session. /home/ana/.hermes/logs/agent.log lists each section Hermes rendered and its size.
```

Pi extensions launch the Node executable and TeamAI entry recorded by `teamai pull` or `teamai hooks inject`. After moving or reinstalling either, rerun one of those commands and restart Pi.

Pi reads `AGENTS.override.md` before `AGENTS.md` from 0.84.0 (`@earendil-works/pi-coding-agent`). When you keep an override, pull writes the team instructions there, and an older Pi never sees them:

```text
  ✖ Pi reads the AGENTS.override.md holding the team instructions
    → Pi 0.73.1 reads /home/ana/.pi/agent/AGENTS.md, not /home/ana/.pi/agent/AGENTS.override.md, so it never sees the team instructions: Pi reads AGENTS.override.md from 0.84.0. Upgrade Pi (`npm uninstall -g @mariozechner/pi-coding-agent && npm install -g @earendil-works/pi-coding-agent`), or move your text from /home/ana/.pi/agent/AGENTS.override.md into AGENTS.md, delete the override, and run `teamai pull`.
```

Hermes hooks and its instructions plugin launch the Node executable and TeamAI entry recorded by `teamai hooks inject` or `teamai pull`. After moving or reinstalling either, rerun one of those commands and restart Hermes.

## A tool has not trusted the project yet

Some tools load a project's files only after you trust the project, or start its MCP servers only after you approve them. `pull` writes the files either way. `doctor` reads each tool's own answer:

- `⚠` the tool has not asked yet. It asks the first time you open it in the project. `doctor` still passes, so a tool you do not use today costs you nothing.
- `✖` the answer is no: you or a setting turned it down, or teamai cannot read the answer. Opening the tool changes nothing, so `doctor` fails.

A new checkout, right after the first pull, with Pi and Claude Code installed:

```text
$ teamai doctor
  ⚠ Pi trusts this project, so it loads its team skills
    → /home/ana/work/web-app/.pi/skills holds team skills (release-notes), but Pi loads a project's skills only in a trusted project, and /home/ana/.pi/agent/trust.json has no entry for /home/ana/work/web-app or a folder above it. Start `pi` in /home/ana/work/web-app and choose Trust, or add "/home/ana/work/web-app": true to /home/ana/.pi/agent/trust.json. Until then a headless run (`pi -p`) skips them.
  ⚠ Claude Code approves this project's team MCP servers
    → /home/ana/work/web-app/.mcp.json holds team MCP servers (issues), but Claude Code starts a project's .mcp.json servers in an interactive session only once you approve them, and issues waits for approval. ...
All checks passed!
```

When you open a tool in the project, answer its prompt:

```text
$ cd ~/work/web-app
$ pi          # choose "Trust"
$ claude      # trust the folder, then "Use this MCP server"
$ teamai doctor
  ✔ Pi trusts this project, so it loads its team skills
  ✔ Claude Code approves this project's team MCP servers
```

A server someone turned down once stays off and is never offered again, so that one fails:

```text
  ✖ Claude Code approves this project's team MCP servers
    → /home/ana/work/web-app/.mcp.json holds team MCP servers (issues), but ... issues was rejected. Remove the rejected ones from disabledMcpjsonServers in /home/ana/work/web-app/.claude/settings.local.json; `claude mcp reset-project-choices` in /home/ana/work/web-app clears the local settings' choices.
```

A machine that only runs tools headless (a CI runner, a workflow box) is never asked, so add the entry the fix names:

```bash
# Pi, for every checkout under ~/work, on a runner with no trust.json yet
mkdir -p ~/.pi/agent && echo '{ "/home/ci/work": true }' > ~/.pi/agent/trust.json
```

| Tool | What waits | Where the answer is kept | How to give it |
|---|---|---|---|
| Claude Code | `.mcp.json` servers, in an interactive session | `~/.claude/settings.json`, `.claude/settings*.json` of the main checkout, trust in `~/.claude.json` | Trust the folder, then approve the servers |
| Claude Code | teamai's hooks, while `disableAllHooks` is true | `.claude/settings.local.json`, then `.claude/settings.json`, then `~/.claude/settings.json` | Remove `disableAllHooks`, or set it to `false` |
| Codex | project agents, `.codex/config.toml` | `[projects."<main checkout>"]` in `~/.codex/config.toml` | Trust the project when Codex asks |
| Copilot CLI | `.github/mcp.json`, `.github/hooks` | `trustedFolders` in `~/.copilot/config.json` | "Yes, and remember this folder" |
| Pi, from 0.79.0 | `.pi/skills`, `.pi/mcp.json` | `~/.pi/agent/trust.json` | "Trust" |
| Muse Code | `.agents/skills`, `.mcp.json`, `.muse/hooks.json` | `~/.config/muse/trust.json`, one entry per worktree | "Trust and continue" |
| Qoder CLI | `.qoder/settings.json`, in an interactive session | `permissions.trustDirectories` and `mcp.*ProjectMcpServers` in `~/.qoder/settings.json` | Trust the folder, then approve the servers |
| CodeBuddy Code | `.mcp.json` servers, `-p` too | `.codebuddy/settings.local.json` | "Use this MCP server" |
| Cursor CLI | `.cursor/mcp.json` servers | `~/.cursor/projects/<project>/` | `cursor-agent mcp enable <name>` |

Oh My Pi has no trust gate.
