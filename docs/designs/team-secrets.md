# Team secrets

[简体中文](team-secrets.zh-CN.md)

Proposal: [#875](https://github.com/Tencent/teamai-cli/issues/875). Plan: [#879](https://github.com/Tencent/teamai-cli/issues/879).

A team declares which secrets its members need, in the team repo, with no value. Each member supplies the value on their own machine. No secret value is written to the team repo.

This document grows with the implementation and describes only what the current version does. Today that is declaring secrets, seeing, per member, whether a value is available, and keeping an MCP entry when a pull can't find a declared secret. Storing a member's value and `env exec` come later.

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
- A file that does not parse, that has no top-level `secrets:` key, or that defines a key twice fails the secrets only: they are not resolved this run, and the env variables are delivered as usual. `pull` warns, `env list` exits non-zero, and `teamai doctor` fails the `Team secrets can be resolved` check, each naming the file and the fix.
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
| `environment` | The member's environment has a non-empty value for the key. |
| `missing` | No value is available. |

```text
Team secrets (2):

  GITHUB_TOKEN  environment  (root)
  GITLAB_TOKEN  missing  (checkout)
```

`teamai list env` shows the same, as `GITHUB_TOKEN  secret, environment  (root)`. With `--verbose`, both print the description, and `env list` the `url` too.

## Declarations are absent, valid or failed

The declarations a member reads have three outcomes, and consumers keep them apart: `absent` (no secrets file this member reads exists), `valid` (possibly declaring none), and `failed`. A failed file is never read as "no secrets": a consumer that did would act on a team having no secrets while it has some.

## A missing secret keeps the MCP entry

`${VAR}` in `mcp/mcp.yaml` can name a declared secret. The session-start pull runs in the agent's environment, which often lacks the member's shell exports (a GUI-launched tool, or a zsh export under `bash -lc`), so a secret can be there for one pull and gone for the next. When a pull finds no value for a server's declared secret:

- A server an earlier pull wrote keeps its entry in each tool's config, as it is, and teamai still manages it: a later pull that finds a value updates it.
- A server no pull has written yet is skipped, as before.
- The entry is removed when its server leaves `mcp.yaml`, and by `teamai mcp remove`, `teamai uninstall`, and `teamai init` when it moves the Claude Code root.
- A server that also misses a variable not declared as a secret is removed, as before. Variables that aren't declared as secrets keep today's behaviour.

A kept entry holds the value the earlier pull wrote. After a secret is rotated or revoked, the server keeps the old value until a pull finds the new one.

While the declarations fail, `pull` and `teamai mcp inject` change no MCP server: nothing is added, updated or removed, and `mcp inject` exits 1. `mcp remove` and uninstall still remove every managed server.

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
