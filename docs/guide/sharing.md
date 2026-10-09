# Sharing Team Resources

> [English](sharing.md) | [简体中文](zh-CN/sharing.md)

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

---

## Sharing Team Resources

This is Team Execution: define skills, rules, and other harness once, review via MR, then `teamai pull` delivers them to every agent.

### Skills

```bash
# Create a skill
mkdir -p ~/.claude/skills/my-deploy-helper
cat > ~/.claude/skills/my-deploy-helper/SKILL.md << 'EOF'
# Deploy Helper
When the user requests a deployment, follow these steps:
1. Check that the current branch is master
2. Run tests `npm test`
3. Build `npm run build`
4. Deploy `./deploy.sh`
EOF

# Push to the team (YAML frontmatter is auto-completed)
teamai push

# Push to a specific role namespace
teamai push --role pm
```

> **Frontmatter auto-completion:** When pushing, the CLI checks the `SKILL.md` YAML frontmatter (`name`/`description`) and, if missing, derives and fills it in automatically from the directory name and content. You can also add more precise frontmatter yourself:
>
> ```yaml
> ---
> name: my-deploy-helper
> description: Automated skill for helping the team deploy services
> tags: [deploy, automation]
> ---
> ```
>
> Malformed YAML or a non-mapping frontmatter root is preserved unchanged and reported as a warning; fix it manually before pushing again.

With role-based skills enabled, the push target directory becomes:

- Default: `skills/<primaryRole>/<skill-name>/`
- Explicit override: `skills/<role>/<skill-name>/` (via `--role`)

### Rules

For a scoped rule, YAML comments stay outside the glob: `paths: **/*.ts # TypeScript files` scopes native rules to `**/*.ts` and gives inline channels the same path hint. This also applies to block-list entries under `paths:`.

```bash
# Create a rule
cat > ~/.claude/rules/code-review-guide.md << 'EOF'
# Code Review Guidelines
- All functions must have JSDoc comments
- `any` type is not allowed
- Test coverage must be at least 80%
EOF

# Push
teamai push
```

> Admins can set enforced rules in `teamai.yaml` (`sharing.rules.enforced`), which members cannot delete.

Most tools get one file per rule in their rules directory. Codex, `codex-internal` and `tcodex` read no rules directory (`.codex/rules/` holds Codex's own `*.rules` command policies), so `pull` writes no rule file for them. In user scope the team rules go into a `<!-- [teamai:team-rules:start] -->` block of the tool's own `AGENTS.md` (`~/.codex/AGENTS.md`, `~/.codex-internal/AGENTS.md`, `~/.tcodex/AGENTS.md`; a `toolRoots` entry moves it), which only that tool reads. In a project their session-start hook adds the project's team rules to each session instead: the project `AGENTS.md` is the owners' file, and other tools with a rules format of their own read it too. ZCode, DeepSeek Harness, OpenClaw, Pi and JoyCode have no rules format either, and in user scope get the same block in a file only that tool reads: `~/.zcode/AGENTS.md`, `$DSH_HOME/AGENTS.md` (`~/.dsh/AGENTS.md` when `DSH_HOME` is unset), the OpenClaw workspace `AGENTS.md` (found the way its hook finds it), `~/.pi/agent/AGENTS.md` beside the instruction blocks, and `~/.joycode/rules.txt`. Pull writes it only for an installed tool, and a project pull writes none of these files. When `openclaw.json` is not plain JSON (OpenClaw reads JSON5), teamai cannot tell which workspace OpenClaw uses, so it writes no block there: pull warns, and `doctor` fails until the file is plain JSON. In a project, ZCode and DeepSeek Harness get the project's team rules from the same session-start hook as Codex, and Pi from teamai's Pi extension, which adds them to each run's system prompt after the team instructions; none of them gets a user rule there, so with teamai in both scopes each rule reaches the tool once. ZCode and DeepSeek Harness drop the hook's text when they compact a session, so the rules come back in the next session, and DeepSeek Harness runs the hook detached, so its first request can miss them; in a project `init` and `doctor` say so. OpenClaw gets no project rules, since its only project file is the `AGENTS.md` other tools read too; in a project `init` and `doctor` say so. Earlier releases copied rules to `.openclaw/rules`, `.pi/rules`, `~/.pi/agent/rules` and `~/.joycode/rules`, which these tools never read: the next pull, even at an unchanged team revision, removes the copies that still hold what teamai delivered and names the ones you edited. Hermes gets the same text in its `SOUL.md` block, from a user-scope pull only: `SOUL.md` is global, so a project pull leaves it as the user-scope pull wrote it. A user pull rewrites the block also when the team repo has not moved, which repairs one an older release's project pull overwrote. On a machine with no user-scope config, a project pull removes the team rules block an older project pull left behind, preserving other SOUL.md content. Hermes gets no project rules, and in a project `init` and `doctor` say why: `.hermes.md` would hide the project `AGENTS.md`, a `pre_llm_call` hook repeats the rules on every turn, and the one plugin prompt section (at most 4,000 characters) already carries the team instructions. Frontmatter is dropped, so a rule with `paths:` applies everywhere there, led by an `Applies to files matching: <globs>` line. Codex runs the hook again after a compaction or a clear, and adds nothing when it resumes a session, which already holds the rules. A subagent Codex spawns gets them through the `SubagentStart` hook. The public Codex runs only trusted hooks. teamai trusts the hooks it writes automatically; if automatic trust is disabled or fails, approve them in `/hooks` to receive the project rules.

The culture, shared-instructions and recall blocks follow the same split. In user scope they go to that same `AGENTS.md`, and your own content outside the markers is kept. In a project the session-start hook adds them with the rules, and `pull` leaves the project `AGENTS.md` unchanged.

> A `toolPaths` in the team `teamai.yaml` replaces the built-in defaults whole. A team that sets it should give each Codex-family entry `userScope.claudemd: .codex/AGENTS.md` (`.codex-internal/…`, `.tcodex/…`) for the user-scope rules and blocks, and drop its `rules` path, since Codex never reads that directory. A top-level `claudemd` would put the blocks back in the project `AGENTS.md`, so leave it out. In a project the hook needs only the entry's `settings` path, where it is installed. The `codex` entry also needs `mcpProject: .codex/config.toml` for the project's team MCP servers. The same goes for the other tools whose rules moved in this release: an entry written before it still sends rules where the tool never reads them, and pull leaves those copies. Remove `rules` and `userScope.rules` from a Pi or OpenClaw entry, add `userScope.rules: null` to a JoyCode entry (its project `rules: .joycode/rules` stays), and set a WorkBuddy entry's `rules` to `.codebuddy/rules` with `userScope.rules: .workbuddy/rules`. `teamai doctor` fails `Rules delivered to <tool>` for such an entry and names the change.

> Upgrading from a release that copied rules to `.codex/rules/`: the next `pull` removes the `.md` copies teamai delivered there, including `teamai-recall.md`. Cleanup follows the recorded `toolRoots` location and checks both a publisher's bare local filename and its namespaced copy. A copy you edited is kept and named in a warning, and the `*.rules` files are never touched. A copy of a rule the team has since removed is deleted only if it matches its recorded delivery hash; without that record, it is kept and named too. The same pull adds `additionalContextLimit: 0` and a `SubagentStart` entry to the teamai hooks in `hooks.json`, which teamai then trusts again in the public Codex (see [Hooks](./advanced.md#hooks)).

### Env, hooks and MCP servers by namespace

Env variables, team hooks and MCP servers are each a list file in the team
repo's root, shared with everyone, plus one file per namespace:

```text
env/env.yaml              hooks/hooks.yaml              mcp/mcp.yaml              root, shared
env/<ns>/env.yaml         hooks/<ns>/hooks.yaml         mcp/<ns>/mcp.yaml         only where <ns> is active
```

A namespace is declared the same way as for skills and agents, under
`resources:` of a role in `manifest/roles.yaml` or a project in
`manifest/projects.yaml`, each type with its own key. A member's active
namespaces are the union of their roles' and their directory's projects':

```yaml
# manifest/projects.yaml
projects:
  - id: checkout
    resources:
      env:   [checkout]
      hooks: [checkout]
      mcp:   [checkout]
```

- **Override.** An active namespace entry replaces the root entry of the same
  name, whole: a variable by `key`, a hook by `id`, a server by `name` (its
  `command`, `args`, `env` and `tools:` together; an override without `tools:`
  reaches every tool). There is no field merge.
- **Conflicts stop the type, not the pull.** The same name twice in one file,
  the same name in two active namespaces, or an active file that does not parse
  or cannot be read means that type is not applied this run: what is installed stays as it is, and
  the warning names the file(s) and the fix. Hooks and MCP no longer remove every
  managed entry when their file is invalid. The built-in hooks are still
  installed where missing, so a first `teamai init` gets the session-start pull that applies
  the fix later; when `hooks/hooks.yaml` itself does not parse, they get their
  defaults, and only in a tool that has no teamai hook yet.
- **Deactivating** a namespace (`teamai projects set`, `teamai roles set`)
  restores the overridden root entries and removes the namespace-only ones on
  the next pull, `Already synced` included. `env.sh` is rewritten even when
  `env/env.yaml` is missing or empty.
- **Directory names** match a declared namespace case-folded, as for docs:
  `env: [checkout]` reads `env/Checkout/env.yaml` on every filesystem, and
  `env add --project checkout` writes to that file.
- **MCP `${VAR}`** resolves from the same resolved env set.
- **Legacy mode** (a member with no role and a team without `projects.yaml`)
  reads the root files only, as before; `teamai doctor` lists a name the root file
  repeats.
- **Where a value comes from.** `teamai env list`, `teamai mcp list`,
  `teamai hooks list` and `teamai list <env|hooks|mcp> --source repo` show each
  entry's namespace and whether it overrides the root, and name every entry that
  is not delivered, with why; `teamai status` counts per namespace and names
  them too; `teamai doctor` lists each override as a note. A variable takes your
  value for this team when you set one with `teamai env set KEY`, else the file's;
  the environment doesn't override either, and `env.sh` exports that value (not one
  set with `--from-env`). `teamai env list` and `teamai list env` show that value
  with where it comes from, `team` or `env.yaml`.
- **Upgrade every member first.** teamai 0.25.0 and the 0.26.0 betas reject a
  `resources:` key they do not know, so declaring `env`, `hooks` or `mcp` breaks
  their pull. From this version on, an unknown `resources:` key only warns, and
  `teamai roles` and `teamai projects` keep it when they save the manifest.

The per-entry keys these files replace:

| Key | On | Now |
|---|---|---|
| `projects:` | env, hooks, MCP | removed: the entry reaches nobody; pull, the list commands and status warn with the file to move it to |
| `roles:` | env | removed, the same way |
| `roles:` | hooks, MCP | deprecated: still filters for one minor release, as in 0.25.0, including a name the root file repeats under different `roles:`; pull warns and `teamai doctor` has a check, both naming every target file |

There is no automatic migration: move each entry into the namespace file the
warning names, and drop the key.
When `teamai env add` updates an existing variable that still carries a removed
per-entry `projects:` or `roles:` key, it keeps that key and warns that pull
will not deliver the variable, naming the namespace file to move it to.

An entry with any other key its schema does not know, such as a mistyped `role:`,
reaches nobody as well, and pull, the list commands, status and `teamai doctor` name the
file, the entry and the key. Correct the key or remove it. A key that a later
teamai version adds is unknown to an older one too, so upgrade every member
before the team uses a new entry key.

A hooks or MCP file that has none of its top-level keys, such as `server:` for
`servers:`, is treated like a file that does not parse: pull keeps the installed
servers or hooks, and pull and `teamai doctor` name the file, the keys found and
the key expected. An extra top-level key next to `servers:` or `hooks:` is ignored.

### Env (environment variables)

```bash
teamai env add API_ENDPOINT https://api.example.com --description "Team API endpoint"
teamai env add API_ENDPOINT https://checkout.internal --project checkout   # the project's env namespace file
teamai env remove API_ENDPOINT --role checkout                          # env/checkout/env.yaml
teamai env list
teamai push
```

Variables live in the team repo's `env/env.yaml`, and per namespace in
`env/<ns>/env.yaml` (see [Env, hooks and MCP servers by namespace](#env-hooks-and-mcp-servers-by-namespace)).
`teamai env add` and `teamai env remove` edit the root file, or with
`--role <ns>` / `--project <id>` that namespace's file; `--project` uses the one
env namespace the project declares, and `--role` warns when no role or project
declares that namespace, since its file then reaches nobody. Neither command
edits a file that does not parse, and `--project` changes nothing when the team
repo cannot be refreshed, since a stale `manifest/projects.yaml` may name the
wrong namespace. `teamai push` picks up a change to any of them.

```yaml
variables:
  - key: API_ENDPOINT
    value: https://api.example.com
    description: Team API endpoint        # optional
```

**Secrets.** A secret the team needs is declared with no value, in
`env/secrets.yaml` or a namespace's `env/<ns>/secrets.yaml` (active like
`env/<ns>/env.yaml`, and a namespace entry replaces the root entry with the same
key). Each member keeps the value on their own machine.

```yaml
secrets:
  - key: GITHUB_TOKEN
    description: GitHub token with repo scope   # optional
    url: https://github.com/settings/tokens     # optional: where a member gets one
```

```bash
teamai env add GITHUB_TOKEN --secret -d "GitHub token with repo scope" --url https://github.com/settings/tokens
teamai env remove GITHUB_TOKEN        # a key env.yaml does not set; --secret for one both files carry
teamai push
```

`teamai env add KEY --secret` declares a key, or updates its description and url,
in the root file or, with `--role` / `--project`, the namespace's; it takes no
value and prints none.

Each member sets their value for this directory's team, never as an argument:

```bash
teamai env set GITHUB_TOKEN                               # prompts, without echo
teamai env set GITHUB_TOKEN --stdin                       # from a pipe
teamai env set GITHUB_TOKEN --from-env WORK_GITHUB_TOKEN  # read from that variable when used
teamai env set GITHUB_TOKEN --global                      # for every team on this machine
teamai env unset GITHUB_TOKEN [--global]
```

`env set` accepts a key the scope declares as a secret or, without `--global`, an
`env.yaml` variable it receives, and stores the value in
`~/.teamai/secrets/teams/<hash>.json` (mode `0600`), one file per team
repo, named by the team repo URL in your `~/.teamai/config.yaml` (not `teamai.yaml`'s `repo:`) so renaming `team:` keeps it; with `--global`, in `~/.teamai/secrets/machine.json`, for every team on the
machine, and a value set for a team still wins. Outside any scope, `--global`
accepts any valid key and notes that no team declares it yet. A value stays the
kind the key had when you set it: once the team stops declaring a secret that
`env.yaml` also sets, your value is not used for the variable, and `env list`
says to run `teamai env unset KEY`, then `teamai env set KEY`.
`teamai env list` and `teamai list env` show each declared secret as
`team` (you set it for this team), `global` (you set it for the machine),
`environment` (your own environment has a value for it), `missing`, or
`unreadable` (your values file can't be read), and never show a value, `--reveal` included. A key declared as a
secret and also set in `env.yaml` is a secret: its `env.yaml` value is not
exported to `env.sh` or listed. A secrets file that cannot be used is not read
as "no secrets": `env.sh` and the MCP servers keep what they had, `pull` warns,
`env list` and `mcp list` exit non-zero (`env list` then shows no variable
value, since any of them may be a secret), and `teamai doctor` fails a check
naming the file. A values file that can't be read fails
`Your team secret values can be read`. `teamai push` picks up a
change to any secrets file. See [Team secrets](../designs/team-secrets.md).

A CLI such as `gh` or `glab` gets this directory's variables and secrets when it
runs under `teamai env exec`, which finds the scope the same way for every
worktree of a project:

```bash
teamai env exec -- gh pr create
teamai env exec -- glab mr list
```

The command inherits your environment, overlaid with the scope's `env.yaml`
variables and its secrets in the [resolution order](../designs/team-secrets.md#resolution);
a declared secret with no value for this scope is removed from it. Put `--`
before the command: without it, teamai would read the command's flags as its
own, so it says so and exits 2. A missing secret prints the `teamai env set`
line on stderr and the command runs anyway. Everything teamai prints goes to
stderr, and the exit code is the command's. With no teamai config here, the
command runs with your environment and a notice. No value is written to disk.
See [Running a CLI with `env exec`](../designs/team-secrets.md#running-a-cli-with-env-exec).

When the scope declares secrets, the session-start hook tells the agent which
keys exist, with their `description`, and to run the CLIs that need them through
`teamai env exec --`. Agents whose tool discards hook output get the same rule
from the teamai core skill. An agent never asks for a secret value: when one is
missing, it asks you to run `teamai env set KEY` in your own terminal. See
[Telling the agent](../designs/team-secrets.md#telling-the-agent).

A variable that no longer reaches this directory is removed from `env.sh` on
the next pull, even one that reports `Already synced` because the team repo has
not moved. Until that pull runs, `teamai doctor` reports a variable that
`env.sh` still exports, so the previous project's secrets are not left live in
silence.

The shell profile keeps the user scope's teamai block alongside one project block: a pull in a project-scoped directory replaces the previous project's block and leaves the user scope's in place. The user block comes first, so a project value wins on a key both define. A machine that pulls in several project-scoped directories therefore ends up with the user scope's variables plus the last-pulled directory's in new shells. Each directory's own `env.sh` stays correct; the profile points only at the last project's.

On `pull`, when `injectShellProfile` is enabled (default), the env block goes into `~/.zshrc` if `$SHELL` is zsh, otherwise `~/.bashrc` — except on Windows: `$SHELL` is normally unset there, and Git Bash starts as a *login* shell that never reads `.bashrc`, so teamai instead prefers an existing `~/.bash_profile`, then `~/.bash_login`, then `~/.profile`, falling back to `~/.bashrc` only when none of them exist (a zsh installed via MSYS2/Cygwin, which does set `$SHELL`, still resolves to `.zshrc`). This matches Git for Windows' own fallback in `/etc/profile.d/bash_profile.sh`, whose guard is `[ -e ~/.bashrc -a ! -e ~/.bash_profile -a ! -e ~/.bash_login -a ! -e ~/.profile ]` — it only synthesizes a `.bash_profile` that sources `.bashrc` in that same one case, which is why a stray `~/.profile` (even one that just sources something else, e.g. `~/.local/bin/env`) is enough to make `.bashrc` alone go unread. Override the target file with `sharing.env.shellProfilePath` in `teamai.yaml`.

Every pull re-runs this order to find the file the current environment actually reads, then follows every reference from it to one of the other four candidate filenames — transitively, through as many hops as it takes — looking for a candidate that already carries the block, rather than duplicating it. When no file along that chain carries this scope's block yet, the first one carrying another scope's block is used, so the user scope's block and a project's end up ordered in one file rather than split across two. A chain through a file outside that fixed set of five (e.g. a custom `~/.config/shell/profile` some setups source instead) is not followed. This is what keeps the Git-for-Windows bootstrap above from moving the target out from under it: that same guard condition means a first pull into `.bashrc` leaves the exact state that makes the next login shell auto-generate a `~/.bash_profile` sourcing it, and without following that forwarding relationship the next pull would prefer the newly-created file and inject a second block there, leaving the original — still working, just loaded further away — reported as a dead leftover. The same reasoning covers a plain `.profile` that flat-guards a source of `.bashrc` for interactive shells (`[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"`), two hops from whatever a login shell reads first.

Only two literal line shapes count as a real reference, though: a bare `source X` / `. X` on a line by itself, or the exact self-referential existence guard Git for Windows itself generates, `test -f X && . X` / `[ -f X ] && . X` (tested and sourced path the same file), also on a line by itself — in both cases `X` must be an unquoted `~/name` or an unquoted-or-double-quoted `$HOME/name` (never a quoted `~`, never a single-quoted `$HOME`: a shell does not expand either, so a reference that looks right there would source a literal, nonexistent path). Anything else — a trailing redirection or extra argument on the source itself, an `||` fallback, an unrelated `&&`-chained command, a condition this can't independently verify — is not recognized, and falls back to the order-based pick rather than being guessed at. This is a deliberately narrow, closed set of two forms rather than an attempt to parse arbitrary shell conditionals: matching everything a real shell script could do to make a line conditional (or to disguise one as inert text) needs an actual shell parser, and no fixed-size grammar ever finishes that job. Nothing inside an `if`, `for`/`while`/`until`, `case`, `select`, a function body, or a `(...)`/`{...}` group counts, however it's guarded — none of those are guaranteed to run (a subshell or brace group's body may always run, but its exports never reach the caller either way) — which also means the standard Debian/Ubuntu `.profile` template (the same source, but nested two `if`s deep, checking `$BASH_VERSION` on the way) is not recognized and falls back to the order-based pick. Nothing textually after an unconditional, top-level `return` or `exit` counts either, since control never reaches it. Anything this can't resolve one way or the other, and a block sitting in a candidate nothing in the chain actually reaches, is never preferred over the order-based pick — otherwise a stale block left by a pre-#682 install would outrank the correct file forever, silently reintroducing #682 on upgrade.

`doctor` (and the check `pull` runs automatically afterward) also flags a teamai env block left behind in a *different* candidate file — e.g. a block a pre-#682 install wrote to `.bashrc` before this file-selection logic changed — even if that block is broken and was never functional. `teamai uninstall` removes it.

### Docs

Place documentation in the team repo's `docs/` directory; after pushing, team members will automatically receive it on their next `pull`.

**Docs by namespace.** A top-level `docs/<ns>/` becomes a namespace once any role or project lists it under `resources.docs`. From then on it reaches only the members who have it active (their roles' and their directory's projects' namespaces); everyone else stops receiving it. A `docs/<dir>/` that no role or project lists stays shared, so existing subdirectories keep reaching everyone:

```yaml
# manifest/projects.yaml
projects:
  - id: checkout
    resources:
      docs: [checkout]     # docs/checkout/ only where checkout is active
```

- There is no override: each namespace is its own subtree, so a namespace file never replaces a root one.
- When a namespace stops being active for you, the next pull removes its local docs that still match the team copy byte for byte, or an earlier team version (the team edited it after you received it). A doc you edited is kept, and the pull prints a line naming it. A local file there that the team repo does not have is removed, as anywhere else in the docs mirror.
- `team-codebase` cannot be a docs namespace: `docs/team-codebase/` is the legacy codebase output. A manifest that declares it fails to load.
- `recall` and `teamai doctor` use the same filter: recall indexes only the docs you receive, and `Team docs delivered` does not expect a namespace you do not have.
- Legacy mode (no role and no `projects.yaml`) delivers all of `docs/`, as before.

### MCP servers

Declare each server once in the team repo's `mcp/mcp.yaml`. On `teamai pull` it is written into every installed tool's own MCP config, translated into that tool's native format. Tools outside `enabledAgents` or listed in `disabledAgents` are skipped.

```yaml
servers:
  - name: gpu-analysis
    description: GPU inventory and pricing queries
    transport: http                      # stdio | http | sse
    url: https://example.com/api/mcp
    headers:
      Authorization: Bearer ${GPU_ANALYSIS_TOKEN}
    timeout: 600000

  - name: local-formatter
    transport: stdio
    command: npx
    args: ['-y', '@acme/formatter-mcp']
    env:
      FORMATTER_MODE: strict
    requires: [npx]                      # skipped with a hint when npx is absent from PATH
    tools: [claude, cursor]              # optional; default is every capable tool
```

`requires` is resolved from `PATH`. On Windows a name also matches a `PATHEXT` suffix (`uvx` matches `uvx.exe` / `uvx.cmd`).

A project or role scopes servers with `mcp/<ns>/mcp.yaml` (see
[Env, hooks and MCP servers by namespace](#env-hooks-and-mcp-servers-by-namespace)):
a server there reaches only members with that namespace active, and replaces the
root server of the same name. Scoping by namespace is what keeps the cost down: a
team with five projects and three servers each would otherwise give every member
fifteen server processes and fifteen tool lists in the context of every session.

`teamai remove mcp <name>` follows the same convention as `push`: it removes the
server from `mcp/mcp.yaml` when that file defines it, otherwise from the one
`mcp/<ns>/mcp.yaml` that does. `--role <ns>` or `--project <id>` picks a
namespace file instead, and is required only when several namespace files, and
not the root, define the name. While an MCP file does not parse, a bare name the
root file does not define removes nothing, because the broken file may define
it; fix the file or pass `--role` / `--project`. A flag that names the broken
file says so instead of reporting the name as not found.

Where each tool's servers land:

| Tool | User scope | Project scope |
|---|---|---|
| claude | `~/.claude.json` | `<project>/.mcp.json` |
| cursor | `~/.cursor/mcp.json` | `<project>/.cursor/mcp.json` |
| codebuddy | `~/.codebuddy/mcp.json` | `<project>/.mcp.json` |
| workbuddy | `~/.workbuddy/mcp.json` | `<project>/.workbuddy/mcp.json` |
| copilot | `$COPILOT_HOME/mcp-config.json` | `<project>/.github/mcp.json` |
| codex | `~/.codex/config.toml` | `<project>/.codex/config.toml` |
| qoder | `~/.qoder/settings.json` | `<project>/.qoder/settings.json` |
| qoder-cn | `~/.qoder-cn/settings.json` | `<project>/.qoder/settings.json` |
| kiro | `~/.kiro/settings/mcp.json` | `<project>/.kiro/settings/mcp.json` |
| opencode | `~/.config/opencode/opencode.json` | `<project>/opencode.json` |
| omp | `~/.omp/agent/mcp.json` | `<project>/.omp/mcp.json` |
| pi | `~/.pi/agent/mcp.json` | `<project>/.pi/mcp.json` |
| zcode | `~/.agents/mcp.json` | — (ZCode's project MCP format is not written) |

Codex reads `<project>/.codex/config.toml` only in a trusted project. After writing team MCP servers, `teamai pull` trusts the main checkout automatically, unless `codexTrustEnabled: false` is set or the project was explicitly marked untrusted. If automatic trust is disabled or fails, add a `[projects."<main checkout real path>"]` table with `trust_level = "trusted"` to `~/.codex/config.toml`; trusting the main checkout covers every worktree of the repository. `teamai doctor` reports an untrusted project whose file holds team servers.


CodeBuddy Code's [MCP documentation](https://www.codebuddy.ai/docs/cli/mcp)
lists the project root's `.mcp.json` as its preferred project configuration.
This is separate from TeamAI's user-scope `~/.codebuddy/mcp.json` target.
Explicit `toolPaths.codebuddy.mcpProject` values in `teamai.yaml` still take
precedence. For an existing team that pins run
`teamai mcp remove` in the affected workspace before changing that value to
`.mcp.json`, then run `teamai mcp inject`. Review and preserve any personal
servers in either file; TeamAI does not migrate or delete the old file.
Claude Code also reads the root `.mcp.json`, so this file is shared by both tools.

TeamAI removes a bare Copilot entry beside `mcpServers` only when its ownership record proves a completed bare write and the entry still matches that write. Older records without placement evidence leave the bare entry alone, even if it matches the team definition. A bare ownership record does not authorize changes to a same-named member entry under `mcpServers`; update skips that collision and removal cleans only the owned bare copy. An unmarked record can claim a keyed entry only when its hash matches that entry and does not also match the bare entry. Completed keyed writes record `bare: false`; a failed placement-record write leaves ownership unproven. New HTTP local-agent installs check Git protection without changing it, persist provisional ownership, then add the exclusion and file record before writing a credential. A failed initial ownership write changes neither Git exclusions nor the MCP config.

An HTTP local-agent update keeps the existing JSON MCP ownership record until the config write succeeds. If saving the new record then fails, it restores the previous config. `uninstall_mcp` removes the entry before dropping its ownership record; a failed config write or an unreadable config keeps that record for a retry, and a failed manifest write restores the entry. A failed MCP reconcile restores each config it wrote before saving ownership, including a file shared by multiple tools. A restoration failure reports both errors and the affected files: repair the config and ownership record before retrying. Git protection remains while a credential is still present.

Copilot uses its native `mcpServers` schema: `stdio` becomes `type: "local"`, remote transports keep `http` or `sse`, and every managed entry gets the required `tools: ["*"]` allowlist. TeamAI honors `COPILOT_HOME`; project configuration uses Copilot CLI's documented `.github/mcp.json` repository location. See [Adding MCP servers for GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers). Codex supports `stdio` and `http`; `sse` is skipped. Qoder supports the Claude-compatible `mcpServers` format in its scope-specific `.qoder/settings.json`. Kiro supports the same `mcpServers` format in its dedicated, mcpServers-only `.kiro/settings/mcp.json` (see [Kiro's MCP configuration docs](https://kiro.dev/docs/mcp/configuration/)). OpenCode supports `stdio` (written as its `type:"local"` shape), `http`, and `sse` (both `type:"remote"`, negotiated by its client); its servers live under the `mcp` key of the shared `opencode.json`. Ownership is tracked in `~/.teamai/managed-mcp.json` — hand-added servers are left alone; name collisions skip unless `--force`.

**Secrets.** Write `${VAR}`, never a literal, in `mcp.yaml`. A key the team declares in `env/secrets.yaml` resolves from your value for this team (`teamai env set`), then your value for the machine (`teamai env set --global`), then your own environment, which leaves out values a teamai `env.sh` exported (see [Team secrets](../designs/team-secrets.md#resolution)). Any other variable resolves from your value for this team (`teamai env set KEY`), then from the team env variables this directory receives (`env/env.yaml` and the active `env/<ns>/env.yaml`); the environment fills only a key the team sets nothing for, and no longer overrides a team variable (see [Team secrets](../designs/team-secrets.md#variables)). An interactive `pull` and `teamai doctor` say when your export differs from the team's value and is ignored. Unresolved variables skip the server with a hint. A declared secret is different: when a pull can't find it, the entry an earlier pull wrote stays as it is, so it may hold a value that was since rotated, until a pull finds the new one (see [Team secrets](../designs/team-secrets.md#a-missing-secret-keeps-the-mcp-entry)). An interactive `pull`, `teamai mcp list`, `teamai env list`, `teamai doctor` and `teamai env exec` name a declared secret with no value, the servers that use it and the command that sets it: `` github: GITHUB_TOKEN is not set. Run `teamai env set GITHUB_TOKEN` (<url>). ``

teamai **resolves every `${VAR}` to its value and writes it verbatim** into each tool's config, which is then written `0600`, an existing `0644` one included (a config without a resolved value keeps its mode; new files are created `0600`). It does not rely on any tool's own env-var expansion: that expansion is fragile — most decisively, IDEs launched from the GUI (Dock/Launchpad) never inherit your shell's exported variables, so a `${VAR}` placeholder expands to empty and the server 401s. Resolving to plaintext makes the token present no matter how the tool is started.

> ⚠️ **The resolved token lands on disk.** Project-scope MCP configs (`.mcp.json`, `.github/mcp.json`, `.cursor/mcp.json`, `.codex/config.toml`, `opencode.json`) then contain the literal secret. Whenever such a file would hold a value teamai resolved and git would track it, teamai lists the path in the clone's `.git/info/exclude`, inside a `# [teamai:mcp-exclude:start]` block (the worktrees of a repo share it), before it writes the value. A config reached through a symlinked directory (say `.cursor/` linking to `config/`) is judged where the write lands: that path (`/config/mcp.json`) is the one listed, checked and reported, and a tracked one is named with both paths. A symlink at the file itself is replaced by the write, so there the file's own path counts. That covers a file this pull did not write: one written earlier for a tool since disabled, one at the built-in location of a tool the team has dropped from `toolPaths` or moved elsewhere (it counts while it holds any MCP server, since teamai's record for that tool describes another file or none; one another tool maps today, such as CodeBuddy's `.mcp.json`, which Claude maps, while it holds a server that tool did not write, as below), one written under a `toolPaths` mapping the team has since changed (each worktree records the files it wrote a resolved value to in `managed-mcp-files.json`, beside its `managed-mcp.json`; for one an older teamai wrote before it kept that record, the first pull reads each `mcpProject` path in the team repo's history of `teamai.yaml`, and the built-in ones teamai has since changed (CodeBuddy's `.codebuddy/mcp.json`), once, as far as the clone has it, inside the project only, skipping a path the same tool maps today; such a file counts while it holds any MCP server, since teamai's record for the tool describes only today's path (one another tool maps today, while it holds a server that tool did not write, as below), and `teamai doctor` checks the same files until that pull; one git tracks is not listed, since a line does nothing for it, but is recorded as tracked whatever it holds, judged as the others once git no longer tracks it (`git rm --cached`), and forgotten once it is gone from both the disk and git), or one still holding a server since removed from `mcp.yaml`. An entry a pull wrote with a resolved value counts while it is unchanged, even after the team makes its `${VAR}` a literal. While the worktree has no `managed-mcp.json` at all (lost, or before its first pull), a config git does not track counts while it holds a server no record claims, one of your own included: the pull notes those servers in `managed-mcp-files.json`, as when it rebuilds a lost record, and they keep its path until they leave the file; `teamai doctor` checks the same way. So does a config a pull writes a tool's first record for while `managed-mcp.json` holds none for that tool (lost, or teamai's first delivery to it). A path git cannot say it ignores is listed all the same once `git ls-files` shows the file untracked; when git cannot say that either, it counts as git failing. When it cannot — `.git/info` or the exclude file is not writable, another teamai command holds the exclude file past a short wait, git already tracks the file, a rule in your own git ignore files re-includes it (say `!/.mcp.json`; the warning names it), or git fails — it leaves that file as it was (an entry an earlier pull wrote stays), warns with the reason and the fix, and `teamai mcp list` and `teamai doctor` report the server as withheld from each tool a pull would write it to; make the file writable (or `git rm --cached` the tracked file, or remove the rule that re-includes it) and run `teamai pull` again. A tracked file is reported first, and listed nowhere. The committed `.gitignore` is left alone, a path git already ignores adds nothing, and a pull, `teamai mcp remove` and `teamai uninstall` remove a path from the block (the block with its last path) once that file is gone, holds no MCP server, or holds none of: a team server with a resolved value, an entry of teamai's that cleanup left, a server that was in the file when teamai rebuilt a lost `managed-mcp.json`, or the value (8+ characters) of a variable still set in the environment, with teamai's record of what it wrote there (`managed-mcp.json`) present before the command ran, readable, and holding an entry for that file's tool (for a file two tools map, such as Claude and CodeBuddy on `.mcp.json`: for each tool `managed-mcp-files.json` says wrote a resolved value there, or for each tool mapping it when it names none; an empty, unreadable or truncated record proves nothing, and neither does one written by a pull that rebuilt it or found no record for its tool in `managed-mcp.json`, while that pull could not note the file's other servers in `managed-mcp-files.json`, until a later pull notes them). A file written under a mapping since changed, one at the built-in location of a tool the team dropped or moved (unless another tool maps it today), or one in a linked worktree of a nested repository, needs to be gone or hold no MCP server. One written for a tool the team has since moved elsewhere (recorded, found in that history, or at the tool's built-in location), that another tool's mapping still reaches, also keeps its path while it holds a server the tools now mapping it did not write (by their `managed-mcp.json` record); as in any file under a changed mapping, a server of your own there keeps it too. `teamai uninstall` applies that to the file in every worktree of the repository; a pull and `teamai mcp remove` apply it only to the current worktree's file, and keep the path while the file in any other worktree still holds an MCP server: an entry that worktree's last pull wrote (say, a `${VAR}` the team has since made a literal) is judged only by a pull there. A path a pull listed and then wrote no value into (the file does not parse, or holds a server of your own under the team's name) comes out again at the end of that pull, and so does its record in `managed-mcp-files.json`. Otherwise, or for a file it cannot check (for example one that does not parse), the path stays, and `teamai uninstall` warns, naming the file and why: remove teamai's servers from it, then delete that line yourself (with its last line, the block's markers). `teamai doctor` reports such a file git would still commit or cannot answer for — for example one already tracked: `git rm --cached` it and rotate the token. A Copilot project config whose servers sit bare at the top level has those counted, and teamai's among them removed once the team drops them, after another tool writes `mcpServers` into the same file too. For an HTTP-backed team (`teamai init --http`) no pull writes a server: the local agent's `install_mcp` does, with the values themselves rather than `${VAR}` references, so a project-scope server carrying any header, env value or argument, a URL (a token can sit in its path), or a command line with arguments counts as holding a credential; only a bare stdio command doesn't. Its install lists the file first and records it in `managed-mcp-files.json`, and when it cannot (the same causes as above), writes nothing and reports the install as failed with the reason. A file an older local agent wrote a credential into without listing it is listed and recorded, judged as `teamai doctor` judges it below, by the local agent's next sync in that workspace (its hooks run one in each session) and by a `teamai pull` there; a dry run writes nothing. No command but `teamai uninstall` takes such a line out. `teamai doctor` checks those files by the local agent's records: one it noted as carrying a credential, or an older install's entry carrying one, and, with no record of the tool, a file `managed-mcp-files.json` lists while it holds any server; add a file it names to `.git/info/exclude` yourself, or `git rm --cached` it and rotate the token.

Claude Code may show project `.mcp.json` servers as pending approval until you accept them once in an interactive session.

```bash
teamai mcp list              # servers, the file each comes from, secret status, and where they are installed
teamai mcp inject            # apply now; --dry-run to preview, --force to override collisions
teamai mcp remove            # remove every teamai-managed server; --dry-run to preview
```
