# Assigned roles

> Status: Implemented — `manifest/members.yaml` decides a member's roles when it exists (#1186).

## Problem

A member's roles were a local setting. `teamai roles set <role>` checked the id against `manifest/roles.yaml` and wrote `primaryRole`/`additionalRoles` into that member's own config; nothing said who may hold which role. A member with no role received every namespace.

That is fine while roles only pick what gets delivered. A team that also uses the effective roles as a bound for its agents — a `PreToolUse` hook that lets the agent of a `frontend` member change `frontend/` and shared files, and nothing else — gets a different property: the agent can lift its own bound by the same means the member has. It can run `teamai roles set`, write the config file, or clear the role and remove the filter altogether. Blocking the command in a hook is string matching on shell commands, and the config is a plain YAML file in the member's home that the agent's shell can write.

## Design

Role assignments become team data, reviewed like any other change in the team repo, and the local setting stops deciding while they exist.

`manifest/members.yaml`, next to `roles.yaml`:

```yaml
version: 1
members:
  alice: [frontend]
  bob: [backend, ki]
default: []   # roles of a member this file does not list
```

The first role listed is the primary role, the rest are additional. Who may change the file is the forge's decision, as it already is for `roles.yaml`: protected branch, merge request, code owners for `manifest/`. teamai keeps no access list of its own — the people allowed to assign roles are the code owners of that file.

### One overlay, every reader

The roles are overlaid onto the member's config where it is loaded (`applyRoleAssignment` in `config.ts`, beside the legacy role migration it precedes). Every existing reader of `primaryRole`/`additionalRoles` — pull, push placement, the namespace filter, the per-entry role scope, the dashboard, child workspaces — then sees the team's assignment without knowing it was assigned.

The overlay is runtime-only (`LocalConfig.roleAssignment`). `serializeLocalConfig` writes the member's own on-disk selection back, so a save by any other command (`projects set`, a tag subscription) never freezes a copy of an assignment into the config file. A stale copy that outlives the assignment is the thing the file exists to prevent.

### Fail closed

With assignments in place, nothing falls back to an unfiltered sync:

- `activeRoleIds` returns `[]`, not `null`: a member assigned no roles matches no role-scoped entry, where `null` means "no role filter".
- `resolveOwnResourceNamespaces` keeps its three unfiltered fallbacks closed, so such a member receives the shared root only.
- A `members.yaml` that exists but cannot be read or parsed leaves this run with no roles, loudly. Only absence of the file returns role selection to the member.
- The file is read from the team repo's fetched default branch (`origin/<default>`), not from the clone's working tree. A local edit, a deletion or an unpushed commit in the clone changes nothing, and a copy only the working tree has is absent: only what the forge merged counts. Where no fetched default branch exists — an HTTP source, a repo without a remote — the working tree is all there is.
- An assigned role `roles.yaml` does not declare is dropped with a warning, rather than failing every command for that member over one stale line. If that leaves no roles — including when `roles.yaml` is missing entirely — the member holds none.

### Resolved again where a load cannot reach

`refreshRoleAssignment` re-resolves the assignment on a config already in memory. The checkout record keeps the selection it delivered, and pull's revision fast path compares the roles in it — which ones, and whether the team assigned them: a reassignment, or the file appearing, that arrives without moving the checkout — a workspace pinned to a tag reads `origin/<default>` for it — still gets a full sync. It **mutates** that config rather than returning a copy: pull keys `teamEnvs` and `instructions` on config identity, and reconciles hooks, MCP and env on the object its caller holds, so a replacement would reach none of them.

Two callers:

- `pull`. The assignment lives in the repo `pull` itself refreshes, and the config is loaded before that refresh. Resolved only at load time, the first pull after a reassignment would deliver the previous roles and record the new revision as synced, so the fast path would skip every pull after it until `--force`. `pullForScope` therefore re-resolves right after the team repo moves, which also picks up an assignments file that just arrived or just went away.
- `init`. It builds the config in memory and hands it straight to the hook, MCP and env reconciliation, before any load can overlay it. Without this the config reaches them role-less, and a role-less config matches every role-scoped entry: a member assigned `frontend` would have `backend`'s hooks installed at init. The assignment is applied after the role profile and before that reconciliation; nothing of it is written, since the save keeps the member's own selection, which an assignment leaves empty.

In a workspace with children (#913) every delivered member holds the workspace's assignment: a child cannot select a role, so the selection it recorded is not one to honour.

### What the member sees

- `teamai roles set` refuses, naming the file and the roles held, and exits non-zero.
- `teamai roles list` prints the effective roles and says where they come from. `--json` reports `{ roles, primaryRole, additionalRoles, source, assignmentFile }` with `source` one of `assigned` (listed), `default` (not listed), `local` (no such file) or `none`. A team hook reads that instead of parsing teamai's config file, whose path and shape are teamai's own.
- `teamai init` skips the role prompt and says which roles the team assigned; `--role` is refused.
- The dashboard's Distribution page shows the roles read-only; the role save and preview APIs refuse with 409. Active projects stay each workspace's own choice.

### Identity

The member key is the `username` in that member's teamai config, which `teamai init` records from the git provider (`gitlabWhoami`, `ghAuthWhoami`, ...). No whoami call happens per command: it would put a network round trip on every load, with nothing useful to do when it fails.

Two member keys that differ only by case are refused when the file loads, since a forge that folds usernames would make them one person.

An HTTP source (`init --repo <url>`, `username: http-consumer`) has no forge identity, so such a consumer resolves as an unlisted member and holds `default`.

## What this is not

A boundary against a determined process running as the member. The agent runs as that member and can edit the config the username comes from, or patch teamai itself. The narrower aim: a role change is a reviewed team decision with a history, and an agent can no longer change its own role with one command or one file write.

## Not included

- `sharing.roles.required` in `teamai.yaml` (#1096). The presence of `members.yaml` already decides fail-closed delivery.
- A cached forge whoami check as a stronger binding of the key to the member's token.
