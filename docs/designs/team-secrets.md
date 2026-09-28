# Team secrets

[简体中文](team-secrets.zh-CN.md)

Proposal: [#875](https://github.com/Tencent/teamai-cli/issues/875). Plan: [#879](https://github.com/Tencent/teamai-cli/issues/879).

A team declares which secrets its members need, in the team repo, with no value. Each member supplies the value on their own machine. No secret value is written to the team repo.

This document grows with the implementation and describes only what the current version does. Today that is declaring secrets, a member's value for each team or for every team on the machine, `${VAR}` in MCP servers, keeping an MCP entry when a pull can't find a declared secret, telling the member what to run for it, running a CLI with the team's env and secrets through `teamai env exec`, and telling the agent which secrets exist. The same order resolves the team's plain `env.yaml` variables: the member's value for this team, then `env.yaml`; the environment no longer overrides either (see [Variables](#variables)).

## Declaring secrets

Secrets live next to the env variables, in a file of their own:

```yaml
# env/secrets.yaml
secrets:
  - key: GITHUB_TOKEN
    description: GitHub token with repo scope, for the github MCP server and gh   # optional
    url: https://github.com/settings/tokens                                      # optional: where a member gets one
  - key: GITLAB_TOKEN
```

- `key` is required and must be a shell variable name (letters, digits and underscores, not starting with a digit).
- An entry with any other key, `value:` included, is not declared, and `pull` and `teamai doctor` name the file, the secret and the key. A value does not belong in this file.
- A file that does not parse, that has no top-level `secrets:` key, or that defines a key twice is never read as "no secrets": the secrets are not resolved this run, and `env.sh`, the env backup and the MCP servers keep what they had, as for an `env.yaml` that cannot be used; `env exec` applies no variables and no secrets, since any `env.yaml` key may be one the file declares. `pull` warns, `env list` and `mcp list` exit non-zero (`mcp list` shows the servers' variables as `not resolved`), and `teamai doctor` fails the `Team secrets can be resolved` check, each naming the file and the fix.
- An empty file or `secrets: []` declares none.

It is a separate file so a member on an older CLI, which reads only `env.yaml`, ignores it, and an older `teamai env add` or `env remove`, which rewrite `env.yaml`, cannot drop it.

An admin declares a secret with `teamai env add --secret`, which takes no value, and publishes it with `teamai push`, which lists a changed `env/secrets.yaml` or `env/<ns>/secrets.yaml` like an env file, in single-repo mode too. Editing the file directly works as well.

```text
teamai env add GITHUB_TOKEN --secret -d "GitHub token with repo scope" --url https://github.com/settings/tokens
teamai env add GITHUB_TOKEN --secret --role checkout     # or --project <id>: env/<ns>/secrets.yaml
teamai env remove GITHUB_TOKEN                          # removes the declaration (same --role / --project)
teamai push
```

- `env add KEY --secret` declares the key, or updates the `description` and `url` of a key already declared in that file; an option not passed leaves its field as it was. A value after the key is rejected and not stored, and no output of `env add` or `env remove` names a value.
- `env remove KEY` removes a variable from `env.yaml` when that file sets the key, and otherwise the declaration from the `secrets.yaml` next to it. `env remove KEY --secret` removes only the declaration, for a key both files carry.
- Neither command edits a secrets file that does not parse. `--role` and `--project` pick the namespace as they do for variables.

## Namespaces

A namespace declares its own secrets in `env/<ns>/secrets.yaml`. It is active where `env/<ns>/env.yaml` is: a role or project that lists `<ns>` under `resources.env`. The rules are the env rules (see [Env, hooks and MCP servers by namespace](../usage-guide.md#env-hooks-and-mcp-servers-by-namespace)):

- An active namespace entry replaces the root entry with the same key, whole.
- The same key in two active namespaces, or twice in one file, fails the secrets.
- Legacy mode (a member with no role and a team without `projects.yaml`) reads `env/secrets.yaml` only, and `teamai doctor` notes a key it repeats.

`teamai doctor` notes each override (`secrets: "GITHUB_TOKEN" from env/checkout/secrets.yaml replaces env/secrets.yaml`).

## States

`teamai env list` and `teamai list env` show each declared secret this directory receives, where it comes from, and its state. They never show a value, `--reveal` included; `--reveal` reveals only the env variables.

| State | Meaning |
|---|---|
| `team` | The member set a value for this team with `teamai env set`. |
| `global` | The member set a value for every team on the machine with `teamai env set --global`, and none for this team. |
| `environment` | The member's own environment has a non-empty value for the key (see [Resolution](#resolution)). |
| `missing` | No value is available. |
| `unreadable` | The member's values file for this team or the machine can't be read, so nobody can tell. |

```text
Team env variables (2):

  GITLAB_HOST=gi****  team  (root)
  API_URL=ht****  env.yaml  (checkout)

Team secrets (3):

  GITHUB_TOKEN  team  (root)
  SENTRY_AUTH_TOKEN  environment  (root)
  GITLAB_TOKEN  missing  (checkout)
```

Both commands print this same listing. Each variable shows the value it resolves to (masked unless `--reveal`) and where that comes from: `team` for the member's value (see [Variables](#variables)), `env.yaml` for the team's. While the declarations can't be used, the variables are listed without a value, `--reveal` included, since any of them may be a secret whose repo value is ignored; while the values file can't be read, a variable shows `unreadable` too. With `--verbose`, both print the description and the `url`.

## Setting a value

A member keeps their value for a secret the scope declares, or for an env variable it receives (see [Variables](#variables)), for this directory's team:

```text
teamai env set GITHUB_TOKEN                               prompts, without echo
printf '%s' "$TOKEN" | teamai env set GITHUB_TOKEN --stdin   for the member's own scripts
teamai env set GITHUB_TOKEN --from-env WORK_GITHUB_TOKEN  reads WORK_GITHUB_TOKEN each time the value is used; no copy is stored
teamai env set GITHUB_TOKEN --global                      for every team on this machine; a value set for a team still wins
teamai env unset GITHUB_TOKEN [--global]
```

- The value is never taken from an argument, so it stays out of shell history. `--stdin` refuses a terminal.
- `env set` accepts a key the scope declares as a secret or, without `--global`, an `env.yaml` variable it receives; `--global` is for secrets only. When the declarations or `env.yaml` cannot be read it changes nothing, since it cannot tell. A project config that exists but can't be read makes `env set`, `env unset` and `env list` fail with its path and why, rather than use the user scope, whose team may not be this project's.
- Outside any scope (no project here and no user scope), `env set --global` accepts any valid key name and notes that no team declares it yet, so a member can set a token they reuse across teams ahead of time. `env unset` accepts any key that has a value.
- `--from-env` warns when the variable is not set in the current shell. While it is unset, the secret is `missing`: the next source in the [order](#resolution) is not used instead, since that could be another account's token.
- Run `teamai pull` afterwards to update the MCP servers, and `env.sh` for a variable.

## Storage

- One file per team repo: `~/.teamai/secrets/teams/<hash>.json`, named by a hash of the repository identity alone (the hash `teamai models configure` puts in its team key file names), so renaming `team:` in `teamai.yaml` keeps every member's values. Every project and worktree that uses the same team reads the same file, so a member sets a value once per team.
- One file for the machine: `~/.teamai/secrets/machine.json`, in the same format. Every scope reads it for the secrets it declares.
- Always under `~/.teamai`, never in the scope's data directory, which in single-repo mode sits inside the business repo. `~/.teamai/env` is not used: it is the user scope's env backup file.
- Written atomically with mode `0600`. That is not encryption: anyone who can read the member's files can read the value.
- Each entry is exactly one of `{"value": "..."}` or `{"env": "VAR"}`, with a `kind`, `secret` or `variable`: what the scope declared the key as when `env set` wrote it. An entry without `kind` is a secret's. An entry is used only as its kind, so a secret's value is never exported as a variable after the team stops declaring the key while `env.yaml` still sets it, and a member's value for a variable never becomes a secret's. `env list` shows an entry of the other kind under its key as not used, with the fix: `teamai env unset KEY`, then `teamai env set KEY`. A file that does not parse is reported by its path only, one that holds any other entry by its path and the entry number, never with its content, and every secret of that team (of every team, for `machine.json`) is `unreadable` until it is fixed.
- Lifetime: uninstalling a project scope leaves the per-team and machine values in place, since another scope may use them; `teamai uninstall` of the user scope removes `~/.teamai`, and the values with it.
- Model profile keys stay where they are ([Model profiles](model-profiles.md)): `env set` does not configure them, and `env/secrets.yaml` cannot declare one.

## Resolution

`${VAR}` in `mcp/mcp.yaml` and [`env exec`](#running-a-cli-with-env-exec) resolve a declared secret in this order:

```text
the member's value for this team     teamai env set KEY [--from-env VAR]
> the member's value for the machine teamai env set KEY --global
> the member's own environment       not a value a teamai env.sh exported
> missing                            the server is skipped; env exec runs the command without it
```

A team value wins over the environment because it is an explicit choice for that team: otherwise a personal `GITHUB_TOKEN` exported in `.zshrc` would override the token a member set for their work team. A machine value suits a token the member uses with every team; a team that needs another account sets its own value, which wins.

**The member's own environment.** The shell profile loads the `env.sh` of whichever scope pulled, so the environment also carries values teamai exported. For a key, a value in the environment does not count when it equals what any teamai `env.sh` on the machine exports for that key (`~/.teamai/env.sh`, `~/.teamai/projects/*/env.sh`) or has exported for it before, or, for a declared secret, this scope's `env.yaml` value for it. A shell opened before a pull keeps the old values in every command it runs, so each `env.sh` keeps a record beside it, `env.sh.exports.json`: for each key, a SHA-256 of `KEY=VALUE` for each of the last 20 values it exported, never the value, so the record adds no copy of a team value or token to the machine (mode `0600`). Not covered: a project in a non-git directory other than this scope (`<dir>/.teamai/env.sh`), a value older than the last 20 of its key, and one dropped from an `env.sh` by a CLI that kept no record.

### Variables

An `env.yaml` variable that isn't a declared secret resolves in one order, in MCP servers, `env exec` and `env.sh`:

```text
the member's value for this team   teamai env set KEY [--from-env VAR]
> env.yaml                         the root file, or the active namespace file that replaces it
```

- The environment no longer overrides it, so a value exported for one team doesn't reach another team's servers. This changes existing teams: a member who exported a variable to override `env.yaml` sets it with `teamai env set KEY` instead. A machine value doesn't apply to a variable.
- An interactive `pull` and `teamai doctor` (as a note) say so when the member's own environment (below) has another value: `` GITLAB_HOST in your environment differs from the value in env/env.yaml, which this team uses. To use yours for this team, run `teamai env set GITLAB_HOST`. `` `doctor` lists it because it runs in the member's shell and explains why an MCP server doesn't use their export. `mcp list` and `env list` don't, and the silent pull prints nothing. No line is printed once the member set a value for the key.
- `env.sh` exports the member's literal value, so a new shell follows the same order. A value stored with `--from-env` is left out of `env.sh`, which holds no copy of it, so a new shell has no value for the key at all, neither the member's nor the team's: the shell has the variable the entry reads, not the key. MCP servers and `env exec` still resolve it. While that variable is unset, the `env.yaml` value is used: unlike a secret's next source, it is the value every other member gets.
- A `${VAR}` the team sets nothing for still resolves from the environment.
- When the member's value file can't be read, MCP servers keep the values the last pull wrote, `pull` leaves `env.sh` as it is, and `teamai doctor` fails the `Your team secret values can be read` check with the reason.

**Same key twice.** A key declared as a secret and also set as a variable in `env.yaml` resolves as the secret, and the repo value is ignored everywhere: it is left out of `env.sh` and the env backup (on every pull, `Already synced` included), out of `env list` and `list env`, `--reveal` included, and out of MCP servers. An older CLI keeps using the variable while the team removes the value.

**Not bound to a host.** A secret reaches whatever server `mcp.yaml` names, as `${VAR}` always has. Unlike model profile keys, it is not tied to a gateway, so whoever can change `mcp.yaml` or add a namespace decides where members' tokens go. Whoever can push to the team repo already ships hooks that run on every member's machine.

**Still reachable.** The resolved value is written in plaintext to each tool's MCP config, as before. A config that holds a resolved `${VAR}` value is written `0600`, an existing wider one (`.mcp.json` is often `0644`) included; one without such a value keeps its mode, and a new one is created `0600`. A command run under `env exec` gets it in its environment, and so does every process it starts: an agent that runs `teamai env exec -- env` can read it. The agent skills forbid that, but nothing enforces it. This keeps secrets out of git, not away from the member's machine or the agent running on it.

## A missing secret keeps the MCP entry

`${VAR}` in `mcp/mcp.yaml` can name a declared secret. The session-start pull runs in the agent's environment, which often lacks the member's shell exports (a GUI-launched tool, or a zsh export under `bash -lc`), so a secret can be there for one pull and gone for the next. When a pull finds no value for a server's declared secret:

- A server an earlier pull wrote keeps its entry in each tool's config, as it is, and teamai still manages it: a later pull that finds a value updates it.
- A server no pull has written yet is skipped, as before.
- The entry is removed when its server leaves `mcp.yaml`, and by `teamai mcp remove`, `teamai uninstall`, and `teamai init` when it moves the Claude Code root.
- A server that also misses a variable not declared as a secret is removed, as before. Variables that aren't declared as secrets keep today's behaviour.

A kept entry holds the value the earlier pull wrote. After a secret is rotated or revoked, the server keeps the old value until a pull finds the new one.

While the declarations fail, `pull` and `teamai mcp inject` change no MCP server: nothing is added, updated or removed, and `mcp inject` exits 1. `mcp remove` and uninstall still remove every managed server.

## A missing secret tells the member what to run

An interactive `pull`, `teamai mcp list`, `teamai env list`, `teamai doctor` and `teamai env exec` (on stderr) print one line for each declared secret with no value: the MCP servers that use it, if any, the command that sets it, and the declared `url`.

```text
github: GITHUB_TOKEN is not set. Run `teamai env set GITHUB_TOKEN` (https://github.com/settings/tokens).
GITLAB_TOKEN is not set. Run `teamai env set GITLAB_TOKEN`.
```

- The line comes from the declarations, so it appears for a secret no MCP server uses, with no `mcp.yaml`, with no tool to write to, and with `sharing.mcp.autoApply` off.
- `doctor` prints it as a note (`notes` in `doctor --json`) and exits as it would without it: a server skipped only because a declared secret has no value doesn't fail `MCP servers delivered to <tool>`. Any other problem in that tool's servers still fails it.
- The silent session-start pull prints nothing.
- `pull` and `doctor` also say when an entry is kept and may hold an old value (`github: the entry an earlier pull wrote stays in claude and may hold an old GITHUB_TOKEN until a pull finds its value.`), and warn about a key declared as a secret and also set in `env.yaml`, whose value is ignored, naming the file to remove it from.
- A secret stored with `--from-env` whose variable is unset reads as missing too, and its line says so: ``GITHUB_TOKEN reads WORK_GITHUB_TOKEN, which is not set. Set WORK_GITHUB_TOKEN, or run `teamai env set GITHUB_TOKEN` to replace the reference.`` (`--global` in the command for a machine value).
- When the declarations or the member's value file can't be read, no line is printed: the command reports that failure instead.

## Running a CLI with `env exec`

A CLI such as `gh`, `glab` or one the company ships reads its token from its environment. `teamai env exec` runs it with this directory's team env:

```text
teamai env exec -- gh pr create
teamai env exec -- glab mr list     GITLAB_HOST from env.yaml and GITLAB_TOKEN from the member, for this directory's team
```

- **Scope.** The directory's scope: the project teamai is set up for there, found through git, so every worktree of a project resolves to that project, else the user scope.
- **Environment.** The command inherits teamai's environment, overlaid with the scope's variables in the [variable order](#variables) (a scope variable wins over an inherited one), then with its secrets in the [resolution order](#resolution). A key declared as a secret that has no value for this scope is removed from the command's environment, so the command never sees a value `teamai env list` doesn't show for this scope: another team's export, or the member's own export when this team's value names another variable with `--from-env`.
- **Missing secret.** The [line](#a-missing-secret-tells-the-member-what-to-run) goes to stderr, and the command runs anyway: `gh` and `glab` can still use their own login.
- **Failures.** When the declarations fail, no variable and no secret is applied, and the command runs with the inherited environment: any `env.yaml` key may be a secret the file declares, so its repo value is not passed on; when `env.yaml` fails, the secrets are applied and no variable is; when the value file can't be read, every declared key is removed and no variable is applied. Each says so on stderr. A project config that exists but can't be read is named on stderr, and the command runs with the inherited environment: it is not taken for "no scope", nor for the user scope.
- **No scope.** With no project or user config, the command runs with the inherited environment and a notice on stderr. Machine values are not applied there, since no team declares which keys the command needs. An HTTP team repo delivers no env here either.
- **Output.** Everything teamai prints goes to stderr, so the command's stdout can be piped. The exit code is the command's; a command ended by a signal ends teamai with the same signal, or exits 128 + its number for one Node doesn't end on (SIGPIPE, SIGUSR1). A SIGTERM or SIGHUP sent to teamai is passed on. `Ctrl-C` and `Ctrl-\` are not: the terminal already sent them to the command, and a second SIGINT makes tools such as terraform force-quit, so teamai ignores them and waits for the command. A command that can't be started exits 127.
- **Nothing written.** No value is written to disk or to `debug.log`. Finding the scope does what every command that finds one does: it may adopt a project partition, save the user scope's role migration, or set up a freshly cloned single-repo project; none of these writes a value.
- **Inherited as is, with three exceptions.** Without a terminal (every agent), teamai sets `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=echo` and `GCM_INTERACTIVE=never` where they are unset, so a git child never waits for a credential prompt. The command inherits them.
- **Not for agents.** A variable or secret named like one a model profile writes (`ANTHROPIC_*`) overrides that profile for the command. `env exec` is for CLIs, not for starting an agent.
- Put `--` before the command: without it, teamai would read the command's own options as its own (`teamai env exec gh pr list --dry-run` would run nothing), so it prints `Put -- before the command: teamai env exec -- <command>` and exits 2. teamai's own options may come before `--`.

## Telling the agent

An agent that runs `gh` without `env exec` silently uses whatever account its environment has. When the scope declares secrets, the session-start hook adds one line to the agent's context (`additionalContext`, beside the MR and package hints):

```text
Team secrets in this scope: GITHUB_TOKEN (gh and the github MCP server), SENTRY_AUTH_TOKEN. Run the CLIs that need them through `teamai env exec -- <command>` so they get this team's values. Never ask for, read or print a secret value; if one is missing, ask the member to run `teamai env set KEY` in their own terminal.
```

- The line lists each declared key with its `description`, so the description should say which tool or server uses the key. It carries no value and no state.
- No line when the scope declares no secrets, when its secrets files can't be used (`pull` and `doctor` report that), or in a directory without teamai.
- Hosts that run SessionStart but discard its output (Hermes, Pi, OpenCode, OpenClaw), and JoyCode, which has no hooks, get the same rule from the teamai core skill.
- The skills say an agent never asks for a secret value in chat, never passes one through `--stdin`, never reads the value files and never prints a secret (`teamai env exec -- env` included). On a missing secret it asks the member to run `teamai env set KEY` in their own terminal. Declaring a secret with `env add --secret` takes no value, so an agent can run it.

## Rotation

A token that was ever committed to the team repo stays in its git history: rotate it, then declare it here and have each member set the new value. After `teamai env set` with a new value, `teamai pull` writes it to the MCP servers.

## Declarations are absent, valid or failed

The declarations a member reads have three outcomes, and consumers keep them apart: `absent` (no secrets file this member reads exists), `valid` (possibly declaring none), and `failed`. A failed file is never read as "no secrets": a consumer that did would act on a team having no secrets while it has some.

## Workflows (#818)

Workflows are a future consumer. Recorded here so the two fit ([#818](https://github.com/Tencent/teamai-cli/issues/818)):

- A step's `requires.env` names keys declared here or in `env.yaml`; there is no second list in the workflow.
- A step gets only the secrets it lists, not every secret the scope declares.
- A missing required key fails the run before it starts, naming the key.
- Unattended runs take secrets from the environment only, never as flags.
- Resolved values are masked before anything is stored (outputs, `result.json`, run events).
- Inputs passed as environment variables cannot shadow a declared key.
- Headless agent steps get the step's environment.
- `run-step` carries no secret values; a remote executor maps `env/secrets.yaml` to its own secret store.
