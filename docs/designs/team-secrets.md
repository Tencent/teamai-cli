# Team secrets

[简体中文](team-secrets.zh-CN.md)

Proposal: [#875](https://github.com/Tencent/teamai-cli/issues/875). Plan: [#879](https://github.com/Tencent/teamai-cli/issues/879).

A team declares which secrets its members need, in the team repo, with no value. Each member supplies the value on their own machine. No secret value is written to the team repo.

This document grows with the implementation and describes only what the current version does. Today that is declaring secrets, a member's value for each team, and `${VAR}` in MCP servers. A value for every team on the machine and `env exec` come later.

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
- A file that does not parse, that has no top-level `secrets:` key, or that defines a key twice is never read as "no secrets": the secrets are not resolved this run, and `env.sh` and the env backup keep what they had, as for an `env.yaml` that cannot be used. `pull` warns, `env list` exits non-zero, and `teamai doctor` fails the `Team secrets can be resolved` check, each naming the file and the fix.
- An empty file or `secrets: []` declares none.

It is a separate file so a member on an older CLI, which reads only `env.yaml`, ignores it, and an older `teamai env add` or `env remove`, which rewrite `env.yaml`, cannot drop it.

For now an admin edits the file directly and publishes it with `teamai push`, which lists a changed `env/secrets.yaml` or `env/<ns>/secrets.yaml` like an env file, in single-repo mode too.

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
| `environment` | The member's own environment has a non-empty value for the key (see [Resolution](#resolution)). |
| `missing` | No value is available. |

```text
Team secrets (3):

  GITHUB_TOKEN  team  (root)
  SENTRY_AUTH_TOKEN  environment  (root)
  GITLAB_TOKEN  missing  (checkout)
```

`teamai list env` shows the same, as `GITHUB_TOKEN  secret, team  (root)`. With `--verbose`, both print the description, and `env list` the `url` too.

## Setting a value

A member keeps their value for a secret the scope declares, for this directory's team:

```text
teamai env set GITHUB_TOKEN                               prompts, without echo
printf '%s' "$TOKEN" | teamai env set GITHUB_TOKEN --stdin   for the member's own scripts
teamai env set GITHUB_TOKEN --from-env WORK_GITHUB_TOKEN  reads WORK_GITHUB_TOKEN each time the value is used; no copy is stored
teamai env unset GITHUB_TOKEN
```

- The value is never taken from an argument, so it stays out of shell history. `--stdin` refuses a terminal.
- `env set` accepts only a key the scope declares as a secret. When the declarations cannot be read it changes nothing, since it cannot tell.
- `--from-env` warns when the variable is not set in the current shell. While it is unset, the secret is `missing`: the member's own environment is not used instead, since that could be another account's token.
- Run `teamai pull` afterwards to update the MCP servers.

## Storage

- One file per team repo: `~/.teamai/secrets/teams/<team>-<hash>.json`, named from `teamai.yaml`'s team name and a hash of the repository identity, the way `teamai models configure` names its team key files. Every project and worktree that uses the same team reads the same file, so a member sets a value once per team.
- Always under `~/.teamai`, never in the scope's data directory, which in single-repo mode sits inside the business repo. `~/.teamai/env` is not used: it is the user scope's env backup file.
- Written atomically with mode `0600`. That is not encryption: anyone who can read the member's files can read the value.
- Each entry is exactly one of `{"value": "..."}` or `{"env": "VAR"}`. A file that does not parse, or holds any other entry, is reported by its path and a line and column or entry number, never with its content, and every secret of that team is `missing` until it is fixed.
- Lifetime: uninstalling a project scope leaves the per-team values in place, since another scope may use the same team; `teamai uninstall` of the user scope removes `~/.teamai`, and the values with it.
- Model profile keys stay where they are ([Model profiles](model-profiles.md)): `env set` does not configure them, and `env/secrets.yaml` cannot declare one.

## Resolution

`${VAR}` in `mcp/mcp.yaml` resolves a declared secret in this order:

```text
the member's value for this team     teamai env set KEY [--from-env VAR]
> the member's own environment       not a value a teamai env.sh exported
> missing                            the server is skipped
```

A team value wins over the environment because it is an explicit choice for that team: otherwise a personal `GITHUB_TOKEN` exported in `.zshrc` would override the token a member set for their work team. Variables that are not declared as secrets resolve as before.

**The member's own environment.** The shell profile loads the `env.sh` of whichever scope pulled, so the environment also carries values teamai exported. For a key, a value in the environment does not count when it equals what any teamai `env.sh` on the machine exports for that key (`~/.teamai/env.sh`, `~/.teamai/projects/*/env.sh`, and this scope's as it stood before the pull rewrote it), or, for a declared secret, this scope's `env.yaml` value for it. Not covered: a project in a non-git directory other than this scope (`<dir>/.teamai/env.sh`), and another scope's value rotated after the shell started.

**Same key twice.** A key declared as a secret and also set as a variable in `env.yaml` resolves as the secret, and the repo value is ignored everywhere: it is left out of `env.sh` and the env backup (on every pull, `Already synced` included), out of `env list` and `list env`, `--reveal` included, and out of MCP servers. An older CLI keeps using the variable while the team removes the value.

**Not bound to a host.** A secret reaches whatever server `mcp.yaml` names, as `${VAR}` always has. Unlike model profile keys, it is not tied to a gateway, so whoever can change `mcp.yaml` or add a namespace decides where members' tokens go. Whoever can push to the team repo already ships hooks that run on every member's machine.

**Still reachable.** The resolved value is written in plaintext to each tool's MCP config, as before (new files are created `0600`).

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
