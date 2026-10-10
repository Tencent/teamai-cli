# Reference

> [English](reference.md) | [简体中文](zh-CN/reference.md)

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

---

## Command Reference

The complete list of commands and flags is generated from the CLI itself: see [`skill-data/core/references/commands.md`](../../skill-data/core/references/commands.md), or run `teamai --help` and `teamai <command> --help`.

---

## Configuration Reference

### teamai.yaml (remote team config)

```yaml
team: my-team
description: Team AI resource repo
repo: https://github.com/your-org/your-repo.git
provider: github
# scope: ignored if present — local install location is set by `teamai init --scope`

reviewers:
  - reviewer1

packages:
  npm:
    - name: typescript
      version: "*"

sharing:
  rules:
    enforced: [code-review-guide]
  recall:
    enabled: false             # optional; members can override locally
  docs:
    localDir: ./.teamai/docs   # default ~/.teamai/docs; in project scope a ~/ prefix resolves to the project root
  env:
    injectShellProfile: true
  coAuthor:
    enabled: false             # optional; strip AI-tool commit trailers team-wide
  gitExclude:
    enabled: true              # optional; keep delivered files out of git (init writes true for a new team)
  contributeHint:
    enabled: true              # optional; false = no /teamai nudge after high-friction sessions
  intervention:
    correctionKeywords: []     # optional; extra course-correction words merged with the built-in zh/en/ja list
  webhooks:                    # optional; notify external endpoints on team events (see "Webhook notifications")
    enabled: true
    endpoints:
      - url: https://example.com/hook
        type: json             # json | feishu | wecom
        events: ["*"]          # any of: session-start, session-stop, skill-use, push, pull, or "*" for all
        secret: my-signing-key # optional; enables the X-TeamAI-Signature header
        timeout: 5000          # optional; per-request timeout in ms (default 5000)
        retries: 3             # optional; retry attempts on failure (default 3)
```

`teamai pull` mirrors the non-hidden `docs/` files you receive (see [Docs by namespace](./sharing.md#docs)) into `sharing.docs.localDir`: documents deleted from the team repo are also deleted locally, even when the last document or the entire team directory is removed. A local file at a deleted document's path is deleted only when it holds a version of that document from the team repo's history; any other is kept, and pull names it (`Kept <path>: the team removed docs/<file>, but this copy matches no team version of it. Delete it when you no longer need it.`). A directory you put where the team had a document is kept whole, and named the same way. 

A link you put in the mirror at a path the team never had is kept too, and named (`Kept <path>: it is a link of yours, and the team does not have docs/<file>. Delete it when you no longer need it.`). When `sharing.docs.localDir` itself is a link, it is yours: pull delivers no docs through it, deletes nothing behind it and names it (`Kept <path>: it is a link of yours, so teamai delivers no docs through it. ...`), `teamai doctor` fails `Team docs delivered` with that line, and `teamai uninstall` leaves it and what it points at. 

While the team repo's history cannot be read (the team clone is not a git repository, or git fails), no local file is deleted, since nothing proves it teamai's. Empty stale directories are removed; hidden files and directories are preserved. A file of yours at a path the team repo's history never had stays, untouched and unnamed. 

The mirror keeps no record of what it wrote, so a file at a team document's path is teamai's only when it holds that document at some revision of the team repo's history; anything else there is yours: pull keeps it and names it with the `Kept <path>: it is not teamai's ...` line above, `teamai doctor` lists it under `Team docs delivered`, and the team version reaches that path once you rename or delete it and run `teamai pull`. A destination that overlaps the team repo or contains the home/project root is rejected; if it is already the team's `docs/` directory, no copying or cleanup is needed. 

File/directory type changes at the same path are handled using staged replacements, and only for an entry the team history proves teamai's: a file where the team now has a directory, or a directory where the team now has a file, whose every file holds a team version. Any other such entry is yours and is kept and named like a file above, a link included unless the team has the same link there; pull never follows a link. Failed replacements restore the conflicting local entries. If a directory to be replaced contains hidden local entries, move those entries first; the sync refuses to discard them. A failed copy stops cleanup. 

`teamai pull --dry-run` previews the sync without changing files; use `teamai pull --force` to clean residue from a revision already synced by an older CLI.

### config.yaml (local config)

```yaml
repo:
  localPath: /path/to/.teamai/team-repo
  remote: https://github.com/your-org/your-repo.git
username: your-name
updatePolicy: auto
scope: project                 # project (default from init) or user
projectRoot: /path/to/project  # project scope only
inheritUserScope: true         # optional; project scope only, defaults to false
coAuthorEnabled: true          # optional; per-machine co-author override
gitExcludeEnabled: true        # optional; per-machine override of sharing.gitExclude.enabled
contributeHintEnabled: false   # optional; per-machine override of sharing.contributeHint.enabled
codexTrustEnabled: false       # optional; per-machine, stops teamai trusting its Codex hooks and project (see Hooks)
toolRoots:                     # optional; per-machine tool roots (see below)
  claude: ~/.claude-work
  codex: ~/.codex-alt
```

#### Relocated tool roots (`toolRoots`)

A tool that can be told to keep its configuration somewhere else — Claude Code through `CLAUDE_CONFIG_DIR`, Codex through `CODEX_HOME` — reads nothing that teamai writes to the team-wide default. `toolRoots` names the directory that tool actually uses, keyed by the same tool id as `toolPaths`, and every path teamai resolves for it (skills, rules, agents, `CLAUDE.md`, settings and hooks, the user-scope MCP config, and Codex's co-author setting in `config.toml`) moves there with it. Other tools are untouched, and so are project-scope paths: those hang off the project root, where a per-machine root has nothing to say. 

Hooks are the exception that makes this worth recording — the built-in hooks are injected into your home directory even in project scope, so they follow `toolRoots` in both, and teamai trusts Codex hooks in the `config.toml` under `toolRoots.codex`.

`teamai init` fills it in for you: whenever `CLAUDE_CONFIG_DIR` or `CODEX_HOME` is set, init records the directory it points at (`toolRoots.claude`, `toolRoots.codex`) and prints it. That includes `CLAUDE_CONFIG_DIR=~/.claude`, which is not the same as leaving the variable unset — Claude Code reads `.claude.json` from inside the configured directory, so teamai writes the MCP config to `~/.claude/.claude.json` rather than `~/.claude.json`. `init` is also the only command that reads these variables, because they live in one shell profile while teamai also runs from session hooks and other terminals; resolving it per run would make the sync target depend on who started the process. 

A re-init keeps a root that was recorded earlier, so running `init` from a shell without the variable does not send the sync back to the default. When a re-init does move the root, the hooks teamai injected into the previous root's settings file (`settings.json`, Codex's `hooks.json`) are removed so that the tool stops syncing into the new one; the skills, rules and instruction files written there are left in place and named in the output. A project-scope `init` that has no record of its own and no variable to read starts from the user-scope record, since the root is a fact about the machine and project hooks land in your home directory. 

To end a relocation, run `init` once with the variable set but blank (`CLAUDE_CONFIG_DIR= teamai init …`, `CODEX_HOME= teamai init …`): the record is cleared and the old root released the same way. Along with the hooks, the old root loses the teamai-managed MCP servers and, for Claude Code, any gateway credentials the local agent delivered there; they are active configuration, unlike the skills and rules.

A root has to be somewhere teamai can recognize the tool at: a directory in your home other than `~/.config` itself (`~/.claude-work`), or a `~/.config/<name>` directory (a leading `~/` is expanded). Those are the two shapes the "is this tool installed?" check can look for; anything deeper, or outside your home directory, is refused with a warning rather than silently half-applied.

Skill-use tracking reads the recorded roots as well, so a relocated tool's skills count as installed, and `import --from-claude` reads a relocated Claude Code's rules.

`toolRoots` currently applies to `claude` and `codex` only, and any other tool id is refused with a warning. A root is only honest for a tool whose every user-scope write goes through `toolPaths`; the other tools still write somewhere teamai resolves separately — OMP's extension directory, the Cursor co-author file, OpenCode's plugin directory — so moving their `toolPaths` entries would leave the rest behind. Copilot CLI has its own mechanism: set `COPILOT_HOME`.

If you set or change `CLAUDE_CONFIG_DIR` or `CODEX_HOME` after initializing, `teamai doctor` reports it: the `Claude Code root matches CLAUDE_CONFIG_DIR` and `Codex root matches CODEX_HOME` checks (each built only when this config syncs that tool) compare the variable against the root this config actually syncs to and tell you to re-run `teamai init` — or, for a value teamai cannot sync to, say why. With the variable unset, the check stays out of the report.

### Webhook notifications (`sharing.webhooks`)

Notify external endpoints when team events happen. Each endpoint declares a `url`, a `type` (`json`, `feishu`, or `wecom`), and the `events` it subscribes to; `secret`, `timeout` (default `5000` ms), and `retries` (default `3`) are optional.

**Events and when they fire:**

| Event | Fires when |
| --- | --- |
| `session-start` | An AI session starts |
| `session-stop` | An AI session ends (includes Copilot's `SessionEnd`) |
| `skill-use` | A skill is invoked |
| `push` | `teamai push` **actually completes a real push** — not on `--dry-run`, a cancelled selection, a no-change run, or a failed PR creation |
| `pull` | `teamai pull` completes a real (non-`--dry-run`) sync — not when it held an agent whose model it could not resolve |
| `*` | Wildcard — subscribe to every event above |

**Payload.** Only whitelisted, non-sensitive fields are sent: `skillName` for `skill-use`, `sessionId` for session events; `push`/`pull` carry the event and metadata only. Raw tool input and tool output are **never** forwarded, and the whole body is passed through teamai's secret redactor before it leaves the machine.

**Signature.** When `secret` is set, each request carries `X-TeamAI-Signature: sha256=<hmac>`, an HMAC-SHA256 computed over the exact request body — so a receiver can verify authenticity. `teamai webhook list` and `teamai webhook test` inspect and exercise configured endpoints; `teamai webhook test --dry-run` previews how many endpoints would receive a request without sending one.

---

## Model profiles

Model profiles point Claude Code, Codex, OpenCode, CodeBuddy, WorkBuddy, Pi, and OMP at a shared model gateway. Nothing changes an agent until you run `teamai models switch`; after that, `teamai pull` keeps the switched agents on the team's latest catalog.

There are two sources, both in the same format:

- `team:<id>` comes from the team repository's `models/models.yaml`, and from `models/<ns>/models.yaml` for your active namespaces (see [Team profiles by namespace](#team-profiles-by-namespace)). It holds URLs and model IDs, never a key.
- `local:<id>` is a personal profile in `~/.teamai/models/models.yaml`, visible only on this machine.

Plain `<id>` works while it is unique; if a team and a personal profile share an ID, write `team:<id>` or `local:<id>`.

### Team catalog

Create `models/models.yaml` in the team repository:

```yaml
profiles:
  - id: tokenhub
    name: Tencent TokenHub
    base_url: https://tokenhub.tencentmaas.com
    api_key: ${API_KEY}          # placeholder; each member configures the real key locally
    model_groups:
      - protocols: [anthropic, openai-chat-completions]
        models:
          - glm-5.3               # the first model is the default
          - deepseek-v4-flash
```

- `base_url` is the gateway root. TeamAI calls it directly for `anthropic` and adds `/v1` for the OpenAI protocols, which matches [TokenHub](https://cloud.tencent.com/document/product/1823/130078).
- `protocols` lists what the models in a group support: `anthropic`, `openai-chat-completions`, `openai-responses`. Put models with different protocol support in separate groups; each model ID appears once.
- `api_key` must be the literal `${API_KEY}`. Unknown fields, duplicate model IDs, and URLs with credentials, a query, or a fragment are rejected, and `teamai push` refuses an invalid catalog.

Which agents can use a profile follows from its protocols:

| Agent | Needs | What `switch` writes |
| --- | --- | --- |
| Claude Code | `anthropic` | `~/.claude/settings.json`: gateway URL and key in `env`, every model in the `/model` picker, `opus`/`sonnet`/`haiku` mapped to matching gateway models (or the default) |
| Codex | `openai-responses` | `~/.codex/config.toml`: the default model and a `[model_providers.teamai]` block |
| OpenCode | any | `opencode.json`: one provider per protocol with every model |
| CodeBuddy / WorkBuddy | `openai-chat-completions` | `models.json`: one entry per model |
| Pi | any | `~/.pi/agent/models.json`: one provider keyed by the profile ref, holding every model. `settings.json` is left alone, so you pick the default with `/model` |
| OMP | any | `~/.omp/agent/models.yml`: one provider keyed by the profile ref, holding every model — Pi's shape, in YAML |

The example above has no `openai-responses` group, so Codex is left alone; add that protocol once your gateway serves those models over the Responses API.

### Use a team profile

```bash
teamai models list                     # every profile: file it comes from, key source, gateway, models, agents, where it is active
teamai models list tokenhub            # just one profile
teamai models switch tokenhub          # asks for the key the first time
teamai models switch                   # lists the profiles and asks which one to use
```

Run `switch` with no profile and it lists every profile, team ones first, and switches the one you pick; answer `none` to cancel. It takes a single profile, so an answer naming several is asked again rather than silently narrowed. Without a terminal there is nothing to pick from, so the profile is required there.

`switch` updates every installed, compatible agent. Narrow it with `--agent claude` (repeatable), pick the default model with `--model deepseek-v4-flash`, or preview with `--dry-run`.

To avoid storing the key, reference an environment variable instead:

```bash
teamai models configure tokenhub --from-env TOKENHUB_API_KEY
printf '%s' "$TOKENHUB_API_KEY" | teamai models configure tokenhub --api-key-stdin
```

Codex, OpenCode, CodeBuddy, and WorkBuddy then read the variable themselves. Claude Code cannot, so `switch` writes the resolved key into `~/.claude/settings.json`. There is no `--api-key <value>` option, because arguments end up in shell history and process lists. Key files are written with mode `0600`.

When the team edits the catalog, `teamai pull` re-applies it to the agents you switched to it.

### Team profiles by namespace

A project or role can give a team profile its own version, for example to point
checkout members at the checkout gateway under the same `id`. Put it in
`models/<ns>/models.yaml` and declare the namespace under `resources.models`, the
same way as for env, hooks and MCP servers (see
[Env, hooks and MCP servers by namespace](./sharing.md#env-hooks-and-mcp-servers-by-namespace)):

```yaml
# manifest/projects.yaml
projects:
  - id: checkout
    resources:
      models: [checkout]
```

- **Override.** While `checkout` is active, a profile in `models/checkout/models.yaml`
  replaces the root profile with the same `id`, whole. Agents switched to
  `team:<id>` follow it on the next pull; when the namespace deactivates they go
  back to the root profile. A profile that exists only in a namespace you left
  is not removed from your agents: pull says it `is no longer active in your
  namespaces`, and `teamai models restore` undoes it.
- **Your key stays with its gateway.** A team profile's API key is stored for the
  profile `id` and the origin (scheme, host and port) of its `base_url`. When an
  override moves a profile to another origin, pull leaves the agents on it alone
  and prints a line to run `teamai models switch team:<id>`, which asks for the
  key of the new gateway (or run `teamai models configure team:<id>` first). The
  key for the first gateway is kept, so leaving the namespace needs no new key.
  The same applies when the team moves the root profile to another origin. A key
  configured before this version is used for the root profile's origin only.
- **Conflicts stop models, not the pull.** The same `id` in two active namespaces,
  or an active file that does not parse, means no agent is updated this run; the
  warning names the file(s). `teamai push` refuses any invalid models file.
- `teamai models list` shows the file each team profile comes from and whether
  it overrides the root one; `teamai doctor` lists each override as a note.
- **Upgrade every member first.** teamai 0.25.0 and the 0.26.0 betas reject the
  `models` key in `resources:`.

### Personal profiles

```bash
teamai models add my-gateway --name "My gateway" \
  --protocol anthropic,openai-chat-completions \
  --base-url https://gateway.example.com \
  --model glm-5.3,deepseek-v4-flash \
  --from-env MY_GATEWAY_KEY
teamai models switch my-gateway
```

Omit flags to be prompted. Edit a personal profile with `configure`: `--name`, `--base-url`, `--model` (adds models), and `--protocol` (serves the models over another protocol; combine with `--model` to limit it to those models). You can also edit `~/.teamai/models/models.yaml` directly. Personal IDs may not reuse a team profile's ID.

### Switching back

```bash
teamai models restore                  # every agent TeamAI switched
teamai models restore --agent codex
```

TeamAI changes only the fields and entries it manages and records what they were before its first switch; `restore` puts that back. If you change a managed field yourself (for example the gateway URL in Claude's `env`), later switches, pulls, and restores leave that agent alone. Picking another model with Claude's `/model` is not treated as a takeover. Codex's `~/.codex/auth.json` is never touched.

Claude notes: `switch` refuses while `settings.json` enables Bedrock, Vertex, or Foundry. It warns when the current shell exports `ANTHROPIC_*` values that differ from what TeamAI writes, because sessions started from that shell keep those values.

Other commands:

```bash
teamai models remove local:my-gateway  # agents keep their settings; restore still works
```

A full user-scope `teamai uninstall` restores managed model settings first and stops, keeping the record, if one cannot be restored. Project-scope uninstall leaves these machine-wide settings alone.
