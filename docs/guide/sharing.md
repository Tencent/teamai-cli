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

`push` fills in `name` and `description` when the frontmatter is missing. A new skill goes to `skills/<ns>/<name>/`, where `<ns>` comes from your role or the active projects. Several choices ask which one. `--role` picks one.

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

`pull` writes each tool's own format into that tool's agents directory: `<name>.toml` for the Codex family, `<name>.agent.md` for Copilot, `<name>.json` for Kiro, and `<name>.md` for the rest.

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

```bash
teamai mcp list
teamai mcp inject
teamai mcp remove
```

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

## Docs

Put files in the team repo's `docs/`. Members receive them on `pull`. To limit a directory, declare it under `resources.docs`:

```yaml
# manifest/projects.yaml
projects:
  - id: checkout
    resources:
      docs: [checkout]
```
