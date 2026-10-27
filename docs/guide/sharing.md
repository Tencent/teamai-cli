# Core Harness

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

## Skills

```bash
mkdir -p ~/.claude/skills/my-deploy-helper
cat > ~/.claude/skills/my-deploy-helper/SKILL.md << 'EOF'
---
name: my-deploy-helper
description: Deploy a service for the team
---
# Deploy Helper
When the user requests a deployment, follow these steps:
1. Check that the current branch is master
2. Run tests `npm test`
3. Build `npm run build`
4. Deploy `./deploy.sh`
EOF

teamai push
teamai push --role pm
```

`push` fills in `name` and `description` when the frontmatter is missing. A new skill goes to `skills/<ns>/<name>/`, where `<ns>` comes from your role or the active projects. Several choices ask which one, including an explicit shared-root choice. `--role` picks a namespace; `--shared` places new resources at the shared root for the whole team, even when namespaces exist. It cannot combine with `--role` or `--project`. Edits of resources already delivered from a namespace keep their destination. When a namespace is selected and the team has `manifest/roles.yaml` or `manifest/projects.yaml`, a role or project there must declare it.

Shared-root skills keep the existing tag-subscription delivery rules when roles or projects filter skills. `--shared` selects the publishing location.

## Rules

```bash
cat > ~/.claude/rules/code-review-guide.md << 'EOF'
# Code Review Guidelines
- All functions must have JSDoc comments
- `any` type is not allowed
EOF

teamai push
```

A rule members cannot delete goes in `teamai.yaml`:

```yaml
sharing:
  rules:
    enforced: [code-review-guide]
```

A rule you wrote yourself stays. `push` writes back only the body of a rule the team already has.

## Agents

`agents/<name>.yaml`. `name` matches the filename. Commit it, or run `teamai push` after editing the copy in a tool.

```yaml
# agents/code-reviewer.yaml
name: code-reviewer
description: Review a change before it is pushed
instructions: |
  Read the diff and comment on correctness, tests, and risks.
tools: [Read, Grep]
targets: [claude, cursor]
```

Leave `targets` out to send the agent to every installed tool. An agent for one role goes in `agents/<namespace>/`, declared under `resources.agents`.

```bash
teamai push
teamai push --role frontend
teamai remove agents code-reviewer
```

`pull` writes each tool's own format into that tool's agents directory: `<name>.toml` for the Codex family, `<name>.agent.md` for Copilot, `<name>.json` for Kiro, and `<name>.md` for the rest. Trae and Trae CN load `.trae/agents` only while the Beta setting "Enable Subagents Directory" is on, and accept only their own model ids, so their copy leaves out the agent's `model`. Trae CN's user copy in `~/.trae-cn/agents` takes one an alias or `tool_extras.trae-cn` gives it. A project's `.trae/agents` is read by both editions, so it never gets a `model`, and it takes the other keys of both `tool_extras.trae` and `tool_extras.trae-cn`; an agent whose two editions give one key different values is skipped there, with a warning naming the key. `push` refuses an edit to that file that changes or removes a key the other edition gives.

In single-repo mode, your root copy of an agent placed in a namespace is pushed to the placed file. Changing it from `.md` to `.yaml` retires the original file, even while your checkout is behind its own merged PR. Either way, TeamAI compares the placed file with the blob your last merged push delivered there. If the team edited it since, the push stops and prints a `teamai push --carried <path>@<blob>` command. Carry that edit into your root copy, then run it. The option accepts only that version, so a plain retry or a later team edit stops the push again. An agent deleted by the team is not re-added from your root copy. An older placement record without a blob catches a team edit only while your checkout is behind it, until your first edit through it merges and records its blob.

### Model aliases

A name such as `model: strong` is mapped per tool in `models/aliases.yaml`:

```yaml
aliases:
  strong:
    claude: { model: opus, effort: high }
    codex: { model: gpt-6-sol, effort: high }
  fast:
    claude: haiku
```

An alias starts with a lowercase letter, then lowercase letters, digits, or `-`. A namespace that needs its own mapping uses `models/<ns>/aliases.yaml`.

## Env, hooks and MCP servers by namespace

The root file reaches everyone. A namespace declared under `resources:` reaches only members who have it active, and replaces the root entry of the same name.

```text
env/env.yaml              hooks/hooks.yaml              mcp/mcp.yaml
env/<ns>/env.yaml         hooks/<ns>/hooks.yaml         mcp/<ns>/mcp.yaml
```

```yaml
# manifest/projects.yaml
projects:
  - id: checkout
    resources:
      env: [checkout]
      hooks: [checkout]
      mcp: [checkout]
```

## Env (environment variables)

```bash
teamai env add API_ENDPOINT https://api.example.com --description "Team API endpoint"
teamai env add API_ENDPOINT https://checkout.internal --project checkout
teamai env add GITHUB_TOKEN --secret -d "GitHub token with repo scope" --url https://github.com/settings/tokens
teamai push
```

```yaml
# env/env.yaml
variables:
  - key: API_ENDPOINT
    value: https://api.example.com
    description: Team API endpoint
```

```yaml
# env/secrets.yaml
secrets:
  - key: GITHUB_TOKEN
    description: GitHub token with repo scope
    url: https://github.com/settings/tokens
```

Secret values stay off the repo. On each machine:

```bash
teamai env set GITHUB_TOKEN
teamai env exec -- gh pr create
```

### Shell environment by directory

A shell gets the team env of the directory it starts in, so several projects open at once each get their own. `teamai pull` adds one block to your shell profile (`.zshenv` for zsh, the bash startup files for bash). An interactive shell switches env on `cd` and puts your own values back when you leave a project.

- In a project: the project's env. With `inheritUserScope: true`, the user scope's variables load too, but a key the project declares stays the project's, and user-scope secrets never load.
- In a workspace with repos set up inside it: its own env plus theirs. A key two of them set differently is held: the value installed before stays, and `pull` names it.
- In a project no pull has registered yet: nothing, until you pull there.
- Anywhere else: the user scope's env.
- Where git cannot read the repository (git missing, a broken `.git`, `safe.directory`): nothing.

`injectShellProfile: false` turns this off for that team's scope.

Limits:

- Only bash and zsh load env by directory. In fish, PowerShell, or a tool that does not start one of them, run commands through `teamai env exec --`.
- Team env cannot set names that control the shell or the loader, such as `BASH_ENV`, `HOME`, `IFS`, `PROMPT_COMMAND`, or names starting `__TEAMAI_`. Pull warns and ignores them.
- `teamai doctor` checks that a shell in this directory loads this scope's env.

## Hooks

`teamai init` installs these built-in hooks:

| Event | What it does |
|-------|----------------|
| `SessionStart` | Pull team resources and record the session start |
| `PostToolUse` | Record skill use |
| `UserPromptSubmit` | Record the prompt |
| `Stop` | Check for a CLI update and record the session end |

```bash
teamai hooks list
teamai hooks inject --dry-run
teamai hooks inject
teamai hooks remove
```

Only tools that are already installed are touched.

Commit the team's own hooks in `hooks/hooks.yaml`. `id` is lowercase letters, digits, and `-`. `builtin` belongs only in the root file. Use it to turn a built-in hook off, or to change its timeout.

```yaml
hooks:
  - id: block-secret
    description: Scan for secrets before a commit
    event: PreToolUse
    matcher: Bash
    command: bash ~/.teamai/team-scripts/scan-secret.sh
    timeout: 15
    tools: [claude, cursor]
```

A hook for one project goes in `hooks/<ns>/hooks.yaml`.

```yaml
sharing:
  hooks:
    autoApply: false          # pull only prints a hint; run teamai hooks inject
    requireTeamScripts: true  # command must live under ~/.teamai/team-scripts/
```

Turn team hooks off on this machine with `TEAMAI_HOOKS_DISABLED=1`.

## MCP servers

Muse may save stdio servers without `type`. Pull and removal compare that form without rewriting personal servers or unchanged managed entries when another server changes.

```yaml
# mcp/mcp.yaml
servers:
  - name: gpu-analysis
    description: GPU inventory and pricing
    transport: http
    url: https://example.com/api/mcp
    headers:
      Authorization: Bearer ${GPU_ANALYSIS_TOKEN}
    timeout: 600000
  - name: local-formatter
    transport: stdio
    command: npx
    args: ["-y", "@acme/formatter-mcp"]
    env:
      FORMATTER_MODE: strict
    requires: [npx]
    tools: [claude, cursor]
```

Write secrets as `${VAR}` and declare the key in `env/secrets.yaml`. A server for one project goes in `mcp/<ns>/mcp.yaml`.

ZCode servers use `mcp.servers` in `~/.zcode/cli/config.json` or the project's `.zcode/config.json`. This follows the 3.16.2 source; 3.15.1 is not certified. Pull moves only unchanged teamai entries out of `~/.agents/mcp.json`. Doctor names other servers there because the desktop app stops reading that fallback once the native config has servers.

WorkBuddy uses the first existing user file in `~/.workbuddy/.mcp.json`, `~/.workbuddy/mcp.json`, and `~/.codebuddy.json`. `CODEBUDDY_CONFIG_DIR` moves the last file. A project uses `.mcp.json`, or `mcp.json` when only that exists. With `sharing.gitExclude` on, its servers use `projects[<project path>].mcpServers` in `.codebuddy.json`. These paths follow the CodeBuddy 2.168.0 engine; WorkBuddy's launcher binding is not certified. Pull removes only unchanged teamai entries from the former `.workbuddy/mcp.json` project file.

When `.workbuddy-ai/` exists in the home or project (WorkBuddy 5.7+), the default skills path moves to `.workbuddy-ai/skills`. Every other surface still waits for `.workbuddy/`, so a member with only `.workbuddy-ai/` gets no rules, team instructions, agents, MCP servers or hooks, and `teamai doctor` fails `workbuddy receives ...` with the ones held.

When a tool's home or configured MCP path moves, pull leaves old copies in place and names them once. Remove them after no tool reads them. Doctor reports unread mappings, moved files, and project MCP that is read only from a session started at the project root. Internal builds with an unknown MCP channel get a note instead of a guessed config.

In a workspace with repos set up inside it, Claude Code, CodeBuddy, and WorkBuddy get the servers through their local scope, not the project's MCP file, so a session in one of those repos does not load them. In single-repo mode, or while tclaude or Muse Code reads that file, Claude Code's servers stay in it, and such a session does load them.

```bash
teamai mcp list
teamai mcp inject
teamai mcp remove
```

`mcp inject` and `mcp remove` exit with code 1 when a tool's config cannot be read or parsed, including with `--dry-run`. Other tools may still be updated; the command lists those changes and reports that the operation is incomplete. Fix the config named in the warning, then rerun the command. The unreadable config and its ownership records are kept for the retry.

Muse reordering JSON object keys does not make a managed server a personal edit. Removal compares its recorded content, including nested objects, while preserving real command, argument or environment changes. Older records without that content fingerprint need a matching original definition in team Git history; if that proof is unavailable, removal keeps the server and warns.

## Models

Commit `models/models.yaml` yourself. The key stays on each machine. A catalog for one project goes in `models/<ns>/models.yaml`.

```yaml
profiles:
  - id: tokenhub
    name: Tencent TokenHub
    base_url: https://tokenhub.tencentmaas.com
    api_key: ${API_KEY}
    model_groups:
      - protocols: [anthropic, openai-chat-completions]
        models:
          - glm-5.3
          - deepseek-v4-flash
```

```bash
teamai models switch tokenhub
```

## Packages

```bash
teamai packages install typescript
teamai packages install code-review@claude-plugins-official
teamai push
```

```yaml
packages:
  npm:
    - name: typescript
      version: "*"
  claude:
    marketplaces:
      - name: claude-plugins-official
        repo: anthropics/claude-plugins-official
    plugins:
      - name: code-review@claude-plugins-official
```

After pull, run `teamai packages`.

## Sessions

Unattended runs now publish their sessions by default. In CI, on a cloud VM or in a hosted job, [`teamai score --drain`](scorers.md#drain-before-an-unattended-job-ends) archives the sessions this machine captured as unattended, and the step sessions of the workflow runs driven here, scrubbed, on `teamai-reports`. The local driver runs it at the end of an unattended run. To keep the old behavior, set `unattended: off`:

```yaml
# teamai.yaml
sessions: { publish: { unattended: off } }
```

`sessions.publish` takes `off`, `ask` or `auto` for each run mode. These are the defaults, written out:

```yaml
# teamai.yaml
sessions:
  publish: { attended: ask, unattended: auto }
```

`ask` acts as `off` for now, so a person's sessions are archived only by a command such as `teamai session push`. Attended `auto` archives a session once nothing has happened in it for six hours, in the background pass that judges finished sessions. Publishing always scrubs. An HTTP team keeps no session archive, so there `sessions.publish` acts as `off`, and `teamai doctor` says so.

A member's `config.yaml` wins, one mode at a time. A mode it does not name falls through to `teamai.yaml`:

```yaml
# config.yaml
sessions:
  publish: { attended: ask }   # attended only; unattended still follows the team
```

`teamai doctor` reports a value that is not `off`, `ask` or `auto`, with its file and key, and teamai ignores it, so that mode falls to the next level. `teamai review --branch` fails a branch whose `teamai.yaml` has such a value. [Finished sessions](scorers.md#finished-sessions) covers `sessions` in `scorers/scoring.yaml`, which decides whether sessions are judged.

## Docs

Put files in the team repo's `docs/`. Members receive them on `pull`. To limit a directory, declare it under `resources.docs`:

```yaml
# manifest/projects.yaml
projects:
  - id: checkout
    resources:
      docs: [checkout]
```

In self mode, pushing an edited skill from a checkout behind the default branch stops with exit 2 if it would overwrite an upstream file. The check covers the whole skill directory, including references and deletions, even when your edit is in another file. Merge the default branch, reconcile the skill, and retry; a copy that already contains the upstream changes can be pushed.

If the team recreates a retired agent at its old namespace, edit that namespace source directly; the old flattened copy remains a backup. Deleting the retired root copy does not make its remaining tool copies new agents. Editing or converting a placed agent also checks the last delivered blob after the checkout has caught up with the default branch.
