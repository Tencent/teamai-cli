# Design: multi-project management — `project` as a dimension orthogonal to `role`

> Status: **proposed** (this doc ships with the first implementation PR for issue #375).
> Phasing: P1+P2 in one PR, P3 separate, P4 docs. See "Phasing" below.

## Problem

One team repo often serves several projects, but resource distribution today has
only two knobs:

| Mechanism | Carrier | Granularity | Controlled by |
|---|---|---|---|
| roles | `manifest/roles.yaml` | namespace (directory-level) | team admin |
| tags  | `tags.yaml`            | single skill / rule        | team tagging + personal subscription |

Three concrete problems appear at multi-project scale (all verifiable in current code):

- **P1 — semantics collapsed to one dimension.** `resolveRoleResourceNamespaces()`
  (`src/roles.ts:130`) makes `role` carry both *job function* and *resource bundle*.
  Expressing "HAI dev", "HAI PM", "billing dev" forces one role per
  `project × function` pair → N projects × M functions = N×M roles, and the
  manifest becomes unmaintainable.
- **P2 — learnings have zero isolation (the painful one).** `src/roles.ts:13-15`
  documents that the learnings namespace is ignored; `teamai contribute` writes
  flat into `learnings/` (`src/contribute.ts`); the index builder uses the
  **non-recursive** `collectFlatMdEntries` (`src/utils/search-index.ts:549`), so
  subdirectories are never scanned. Result: project A's learnings surface in
  project B members' `teamai recall`, and recall signal-to-noise degrades linearly
  with project count. **`project` scope does not fix this** — two directories clone
  the *same* team repo, so `learnings/` stays one flat pile.
- **P3 — member registration is a placeholder.** `MemberConfigSchema`
  (`src/types.ts:268`) has a `role?` field, but `init.ts` writes the member file
  only when it doesn't yet exist (`isNewMember`, `src/init.ts:1177`) and records
  neither role nor project. The team side cannot answer "who is on project X".

**Why tags aren't enough.** Tags are a personal local subscription (stored as
`subscribedTags` in `config.yaml`, `src/types.ts:316`): invisible and
unqueryable team-side, scoped to skill/rule only (not learnings/claudemd/docs),
with no "membership" semantics. Tags express "I'm interested in a topic", not
"I belong to this project".

## This is NOT issue #374's `project`

The two concepts share a word and must not be conflated in code:

| | #374 project | #375 project (this doc) |
|---|---|---|
| what it is | a **working directory** (path slug) | a team-defined **logical project** (manifest id) |
| decided by | path → slug, pure function | admin, in `manifest/projects.yaml` |
| solves | *where* machine-local data lives | *who* team knowledge is distributed to |
| example | `-Users-x-work-hai` | `hai-inference` |

They compose orthogonally. After #374, this doc's field lives at
`~/.teamai/projects/<path-slug>/config.yaml` as `projects: [<logical-id>]`; one
path-slug maps to 0..N logical projects.

## Dependency on #374

The main path requires `cwd → project root` to resolve correctly in subdirectories
and git worktrees. #374 found that pre-P0 `detectProjectConfig()` only inspected
the cwd's own layer, silently falling back to user scope inside a worktree. **#374
P0 already fixed this** (`detectProjectConfig()` now retries at the git
`workspaceRoot`; `resolveAnchors()` exists — see `docs/designs/data-directory-layout.md`),
and P0/P1-1/P1-2 are merged to `main`. The distribution feature in this doc does
not depend on the remaining #374 phases (P1-3 auto-migration, P2 self-slimming,
P3), which relocate data rather than distribute knowledge.

## Solution: `project` as a second, orthogonal dimension

New `manifest/projects.yaml`, sibling to `roles.yaml`, neither referencing the other:

```yaml
version: 1
projects:
  - id: hai-inference
    name: HAI Inference Platform
    resources:
      knowledge: [hai-inference]
      skills:    [hai-inference]
      learnings: [hai-inference]   # makes the learnings namespace actually take effect
      agents:    [hai-inference]   # optional; agents/<namespace>/ scoped to this project
```

The id and every namespace are refused at the manifest boundary unless they can
name a directory without escaping it, since each becomes a directory component. A
namespace must be a single path segment: no `/`, `\`, `:` or control character,
no trailing `.` or space, and not a Windows device name (`CON`, `NUL`, `COM1`, …).
Two namespaces of one resource type may not differ only by case, within a manifest
or between `roles.yaml` and `projects.yaml`, since case-insensitive filesystems
would give both the same directory.
Win32 strips a trailing period or space from every component, so `.. ` would
arrive as `..` and `frontend.` as `frontend`, escaping the parent in the first
case and another namespace's directory in the second; `.` and `..` fall out of the
same rule. A manifest file that exists but cannot be read, or is empty, is an
error rather than an absent manifest: treating it as absent would drop the
filtering the manifest exists to apply. Absence means the path is genuinely not
there — a dangling symlink, on the file or on `manifest/` itself, reads as ENOENT
but is an error. The id keeps the
older, narrower rule it has always had — letters, digits, `.`, `_`, `-`, and not
`.` or `..` — because it is also typed on the command line and split on commas.
The namespace guard applies to `manifest/roles.yaml`'s active namespaces
(`knowledge`, `skills`, `agents`, and since #707 `env`, `hooks`, `mcp`, `models`
and `docs`); its `learnings:` is kept for backward compatibility, ignored at
runtime, and therefore unchecked.

Agent push uses the same role/project namespace resolution as pull: an edit goes back to the namespace it was delivered from (see [Push and commands](#push-and-commands)), and an agent with two active sources is skipped as ambiguous. Placement follows it: a new agent pushed with `--role`/`--project` lands under `agents/<namespace>/` (the project's `agents` axis), the same way a new rule resolves from `knowledge` and a new skill from `skills` (issue #649). On a role or project change, agent cleanup checks each tool destination independently, including YAML `targets` and legacy format support. Locally edited copies are preserved.

Directory layout reuses the existing namespace convention, adding one learnings layer:

```text
team-repo/
  manifest/  roles.yaml  projects.yaml
  skills/    common/  hai-inference/  billing/
  claudemd/  common/  hai-inference/  billing/
  learnings/
    team-general-2026-03-15.md   # root = shared with the whole team (unchanged)
    hai-inference/               # NEW: project-private learnings
    billing/
```

**Key invariant: `.md` at the `learnings/` root is always visible to everyone.**
This is both the backward-compatibility pivot (today every learning is at the
root → zero migration) and the natural home for cross-project shared experience.

Namespace resolution becomes a union:

```
activeNamespaces = resolveRole(primaryRole, additionalRoles)
                 ∪ resolveProjects(activeProjects)
```

`roles.yaml`'s `learnings` field **stays ignored** — the learnings namespace is
provided *only* by projects, otherwise P1's semantic confusion returns.

**`role` and `project` are orthogonal, not competing — there is no priority
between them.** They live on different planes: a "HAI dev" legitimately
needs generic dev skills (from `role`) *plus* HAI-specific knowledge (from
`project`), so the resolver takes the **union**, never one-overrides-the-other.
Learnings are the one dimension `project` alone provides (`role` contributes
nothing).

The only precedence rule is between an active namespace and the shared root, and
it is the same for every resource type: see
[One namespace model for every resource type](#one-namespace-model-for-every-resource-type)
(#707). A role namespace and a project namespace that define the same name are
two active namespaces like any other pair: where both would land in one place it
is a conflict the admin resolves by renaming, never a project-over-role (or
role-over-project) rule, which would pick a winner the manifest does not show.

### Data model

`src/projects.ts` (new), mirroring `src/roles.ts`:

- `ProjectResourceNamespacesSchema` = `{ knowledge, skills, learnings }` (all
  `string[]`; here `learnings` is **active**, unlike in roles).
- `ProjectSchema` = `{ id, name, description?, resources }`.
- `ProjectsManifestSchema` = `{ version, projects: Project[] }` (may be **empty**,
  unlike roles' `.min(1)` — a repo can define projects without requiring them).
- `loadProjectsManifest(repoPath)` returns `null` when
  `manifest/projects.yaml` is absent (roles throws; projects is optional).
- `resolveProjectResourceNamespaces({ manifest, activeProjects })` →
  `{ knowledge, skills, learnings }`, dedup within each type.

`ResourceNamespaces` (`src/roles.ts:34`) gains a `learnings` key:
`Record<'knowledge' | 'skills' | 'learnings', string[]>`. This is a type-level
change that ripples into `pull.ts` and `search-index.ts` (see below). Role
resolution keeps `learnings: []`; only project resolution populates it.

### Entry point: follows the working directory, no join/leave

Project identity is set by the working directory, exactly like `--role`:

```bash
cd ~/work/hai-inference && teamai init <team-repo> --project hai-inference
cd ~/work/billing       && teamai init <team-repo> --project billing
```

There is deliberately **no `projects join/leave`** command. The tags analogy that
suggested it does not hold: tags express a personal preference with no external
basis and need an explicit toggle; a project has an external basis (cwd) and is
already known at `init` time. Recorded here so it isn't re-proposed.

`--project all` (issue #509) is the one reserved value for the flag: it expands to
every id the manifest declares, via `listProjectIds(manifest)`, and that snapshot
is what `config.yaml` records. It keeps a monorepo's onboarding to a single line
and keeps `projects.yaml` the single source of truth for the project set. Snapshot
rather than a live alias is deliberate — the active set is re-resolved only by
re-running `init`, like every other activation — and it stays an explicit operator
action, not the auto-activation ruled out above. Because the value is reserved, a
project whose id is literally `all` is shadowed: it is still covered by the
expansion, but selecting only it goes through `teamai projects set all`, which
takes plain ids.

`teamai projects set/list/members` are kept as low-frequency after-the-fact
correction/query, mirroring `teamai roles set` relative to `init --role`
(registered in `src/index.ts` next to the `roles` command at `src/index.ts:206`).
The admin side, `teamai projects add/update/remove`, mirrors `roles add/update/remove`:
each edits `manifest/projects.yaml` and opens a PR, and the first `add` creates the
file, so there is no separate `init`.

### Two `projects[]`, two deliberately-different semantics

| Location | Contents | Semantics |
|---|---|---|
| `<project>/config.yaml` (`LocalConfig.projects`) | projects active in this directory | **overwrite** |
| `members/<user>.yaml` (`MemberConfig.projects`) | every project I've participated in | **append + dedup** |

Running `init` in two directories naturally lists two projects on the roster,
while each directory syncs only its own. This requires changing the
`isNewMember`-gated write at `src/init.ts:1177` (currently "write only if the file
doesn't exist") to always **merge** project membership into the existing file.

`LocalConfig.projects` is an **array**: monorepos (one repo, multiple sub-projects)
and cross-project functions (platform/infra people who need multi-project
experience) both need it, without affecting the single-project main path.

## One namespace model for every resource type

> Added by [#707](https://github.com/Tencent/teamai-cli/issues/707). Before it,
> env, hooks and MCP servers were scoped per entry (`roles:` on hooks and MCP
> from #563, `projects:` and env `roles:` from #668), docs and team model
> profiles could not be scoped, and a same-name item in a namespace and the root
> was an error for agents while the other types delivered both or picked one
> silently.

Every resource type uses one layout and one rule:

```text
<type>/                 root, shared with everyone
<type>/<ns>/            delivered only where <ns> is active in resources.<type>
namespace vs root       the namespace item replaces the root item, whole, no merge
namespace vs namespace  conflict when both would take one slot (see below)
duplicate in one file   conflict
broken active file      that type is not applied this run, installed state is kept
legacy mode             no override and no conflict rule (see below)
```

The active set is the union above: the namespaces the member's roles and the
directory's projects list under `resources.<type>`.

| Type | `resources:` key | Replaced by name | Two active namespaces, one name |
|---|---|---|---|
| env | `env` | variable `key` | conflict |
| hooks | `hooks` | hook `id` | conflict |
| mcp | `mcp` | server `name` (`command`, `args`, `env` and `tools:` together) | conflict |
| models | `models` | profile `id` | conflict |
| skills | `skills` | skill directory | conflict |
| agents | `agents` | file stem | conflict |
| rules | `knowledge` | first-level file name: `rules/<ns>/<name>.md` replaces `rules/<name>.md` | both delivered |
| claudemd | `knowledge` | file name | both delivered |
| docs | `docs` | none: each namespace is its own subtree | cannot happen |
| learnings | `learnings` (projects only) | none: ids cannot collide | cannot happen |

`src/namespace-resolver.ts` holds the rule. It takes candidates (name, source
file, namespace or root) and the active set, and returns either the resolved
items, each with its origin and the root item it replaces, or a tagged conflict
that names the item and both source files. The result does not depend on the
order files are read (property-tested). Per-type code parses files into
candidates, renders messages and applies the result.

### Override

The namespace item replaces the root item whole; there is no field merge, so an
MCP override without `tools:` reaches every tool. When the namespace stops being
active, the next pull delivers the root item again and removes items that only
the namespace had; for env, hooks and MCP that happens on an `Already synced`
pull too, and `env.sh` is regenerated from the resolved set even when
`env/env.yaml` is missing or declares nothing. MCP `${VAR}` lookup reads the same
resolved env set.

Skills keep one difference: in role/project mode the root `skills/` stays the tag
catalog and is not delivered by default. A root skill that arrives through a
subscribed tag is replaced by an active namespace skill of the same name, and
among tag matches the root skill wins over one in an inactive namespace. Installing
a skill removes the files that another team version of that skill (root or any
namespace) has and the new one lacks, when they match that version byte for
byte, so switching versions leaves no team file behind; a file the member added
or edited stays, because push never counts such extras as changes and they may
never have been pushed, and one at a path another version has is named on each
pull.

An item that cannot be used replaces nothing. A skill directory without
`SKILL.md` is not a skill: it is left out of the desired set, so the root skill
of its name is still delivered and its installed `SKILL.md` is never removed as
a leftover, and pull names the directory once a run; push does not take it for
the member's copy of that skill either. While a namespace agent
file cannot be read or parsed it delivers nothing, and cleanup keeps the root
agent it would replace.

Overridable shared content belongs at the root, not in a namespace every role
activates (`common/`): a root item gives way to an active namespace, a namespace
item never does. `rules/code-style.md` is replaced by `rules/checkout/code-style.md`
for checkout members; `rules/common/code-style.md` would be delivered beside it.

### What counts as a conflict

A conflict is two items competing for one slot on the member's machine. Skills and
agents are flattened into one directory per tool, env keys into one `env.sh`, MCP
servers into one config map by name, hooks and model profiles into one set by
id: two active namespaces with the same name cannot both land, and choosing one
would depend on read order. Rules and claudemd namespaces never share a slot:
`rules/<ns>/` keeps its own local path and each claudemd file has its own part
of the managed block (in namespace order), so two namespaces with one name are
both delivered and only the root item gives way. The root is never a side of a
conflict: root plus two namespaces is reported as the two namespaces.

### Failure policy

A conflict, a duplicate name inside one file, or a file in the active set that
does not parse or cannot be read (only a missing file is absent) stops that type for the run and keeps what is installed; the rest
of the pull goes on. The warning names the file or files and the fix. During the
`roles:` deprecation window a name repeated in one file with `roles:` on every
copy is not a duplicate: each copy that passes the role filter is delivered, as
0.25.0 did (MCP keeps the last).

| Type | Effect of a failure |
|---|---|
| env | `env.sh` and the shell profile keep what they had |
| hooks | installed team hooks and the managed-hooks record stay as they are. The built-in hooks are still installed in each tool that misses one (a tool with all of them is not rewritten), so a first install gets the session-start pull that heals it: with the root file's `builtin:` overrides whenever `hooks/hooks.yaml` parses (a broken namespace file or a clash does not hide them), and when the root file itself does not parse, with their defaults and only in a tool that has no teamai hook yet. `teamai init` and bootstrap say the team hooks were not installed; `teamai hooks inject` exits 1 |
| mcp | no tool's MCP config changes |
| models | no switched agent is updated; `teamai models` commands fail with the same message; `teamai push` refuses any invalid models file, active or not |
| skills, agents | that type is neither installed nor swept; the other types and the search index still sync |
| rules, claudemd, docs, learnings | no conflict case |

For env, hooks, MCP and models the warning is also written to
`~/.teamai/debug.log`, so a silent session-start pull leaves a trace. This
replaces two earlier behaviours: an invalid hooks or MCP file reconciled to the
empty set and removed every managed entry, and a skills or agents collision
aborted the whole scope.

### Legacy mode

Legacy mode is a directory with no active role and no active project in a team
without `manifest/projects.yaml` (`resolveResourceNamespaces` returns `null`).
It keeps its old behaviour, and the types differ in what that is:

- **env, hooks, MCP, models** read the root file only; namespace files are
  ignored. A name the root file repeats is let through as before, and `doctor`
  lists it. Delivering every namespace here would turn every override into a
  conflict (`API_BASE` in both `env/checkout/` and `env/billing/`).
- **skills** deliver every namespace beside the root, flattened; a repeated name
  installs one of them, and `doctor` lists the name.
- **agents** keep rejecting a stem clash, root plus namespace included, because
  the install is flat; agents are not updated that run.
- **rules, claudemd, docs** deliver every namespace (rules at their own paths,
  claudemd all in the block, all of `docs/`).

A consequence for hooks and MCP: a role-less member in a team with `roles.yaml`
used to receive every `roles:`-scoped entry (no role matched all), and stops
receiving it once the admin moves it into `hooks/<ns>/` or `mcp/<ns>/`.

### Docs

A top-level `docs/<ns>/` is **declared** once any role or project in either
manifest lists it under `resources.docs`, whatever the member's own roles. A
declared namespace reaches only members who have it active; an undeclared
`docs/<dir>/` stays shared, so existing subdirectories keep reaching everyone.
The directory match is case-folded, so `docs/Checkout/` is withheld for an
inactive `checkout` on every filesystem. When a namespace stops being active,
pull removes the local copies that are byte-equal to the team file, or to any
earlier commit of it (`isPastVersionOf`: the team edited it after delivery), and keeps
edited ones, naming them. The docs mirror (#817) targets this resolved set: it
copies only the delivered files and prunes every local file the team repo does
not have, inside a withheld namespace too, but never a local copy of a withheld
namespace's team doc; those follow the byte-equal rule. The search index and
`doctor`'s `Team docs delivered` use the same filter as pull: doctor expects
only the delivered files, and does not report a withheld namespace's team doc
as stale, since pull names the edited copies it keeps.

`team-codebase` (any case) is rejected as a docs namespace at the manifest schema,
so the manifest fails to load like any invalid namespace:
`docs/team-codebase/` is the legacy codebase output. It therefore stays delivered
and indexed for everyone. The search index reaches the legacy codebase docs
only through the docs walk, so withholding `docs/team-codebase/` in a later
change would silently drop them from recall.

### Models

Team profiles come from `models/models.yaml` plus `models/<ns>/models.yaml` for
each active namespace; a namespace profile replaces the root one by `id`. A
stored team API key is bound to the profile id and the origin (scheme, host,
port) of its `base_url`, stored as `team:<id>@<origin>` so several origins of one
id coexist. When the resolved profile's origin has no key, pull leaves the agents
switched to it alone and prints a line to run `teamai models switch team:<id>`;
an override can therefore never send a key to a gateway it was not configured
for. The binding applies whoever changed the URL, so moving the root profile to
another host (legacy mode included) makes each member re-key once. A key stored
by a 0.26.0 beta as `team:<id>` counts only for the root profile's origin. When
the namespace deactivates, agents return to the root profile with its key; a
profile that existed only in a namespace the member left keeps the agent's
settings, and pull says it `is no longer active in your namespaces`.

### Manifest and per-entry keys

`resources:` gains `env`, `hooks`, `mcp`, `models` and `docs`. They are optional
and never defaulted: saving a manifest writes back the parsed object, so a
default would add `env: []` to every manifest an admin edits and break members on
an older CLI. For the same reason `--namespaces` on `teamai roles` and
`teamai projects` `add`/`update` sets only the older keys (`knowledge`, `skills`,
`agents`, and `learnings` for projects); the new keys are declared by hand. An unknown `resources:` key now warns instead of failing the
scope, and a manifest these commands save keeps it, so the next axis does not break older members again. 0.25.0 and the
0.26.0 betas still reject unknown keys: every member has to upgrade before a team
declares one of the new axes.

The per-entry keys go away. `projects:` on env, hooks and MCP, and `roles:` on
env, existed only in the 0.26.0 betas: an entry that carries one reaches nobody,
and pull warns with the namespace file to move it to, one per listed id.
`roles:` on hooks and MCP shipped in 0.25.0 and keeps filtering for one more
minor release; pull warns once per run and `doctor` has an informational check,
both naming every target file. Model profiles are strict, so a per-entry key
fails the file. There is no automatic migration.

### Push and commands

Write-back goes to the origin the resolver reports: an edited item that replaces
a root one is written to its namespace file, never to the root. The agents
source order is active namespace, then this machine's placement record, then the
shared root; in role/project mode a same-stem root file no longer withdraws the
placement record (legacy mode still does). The skills push scan uses role ∪
project namespaces, and `push` picks up a change to any `env/<ns>/env.yaml`.
`teamai env add|remove` take `--role` / `--project`. `teamai remove mcp <name>`
removes from the root file when it defines the name, otherwise from the one
namespace file that does, and asks for `--role` / `--project` only when several
namespace files and not the root define it, and removes nothing by a bare name
the root does not define while any MCP file does not parse; removing a root
server that a namespace overrides leaves that namespace's members with their
override. `--role` / `--project` write into the existing directory the
namespace matches case-folded, the file pull reads.

`doctor` lists each override as a note (information, not a failed check), and in
legacy mode each repeated name. `teamai env|mcp|hooks|models list`,
`teamai list <env|hooks|mcp> --source repo` and `teamai status` show where each
entry comes from.

### Known gaps

- The tag channel matches skills by name across every namespace, so a tagged
  skill that exists only in an inactive namespace still reaches the member.
- No pull protects a local edit from being overwritten, override transitions
  included.
- A mistyped per-entry key (`role:`) is stripped by the schema and the entry
  reaches everyone. `pull --dry-run` resolves the hooks and MCP entries and
  reports their warnings (an unknown id, a deprecated per-entry `roles:`, a file
  that does not parse) without writing, so a maintainer can see them before a
  real pull applies them.

## Backward compatibility

| Scenario | Behavior |
|---|---|
| no `manifest/projects.yaml` | identical to today; every project code path short-circuits (`loadProjectsManifest` → `null`) |
| manifest present, directory activates no project | role namespaces + `learnings/` root only |
| old `members/<user>.yaml` / `config.yaml` without `projects` | parsed as `[]`, no error |
| existing flat `learnings/*.md` | all stay at root = shared with everyone, **zero migration** |

## Open questions — resolved

- **Q1: auto-activate when the manifest has exactly one project?** Roles auto-select
  the sole role (`src/init.ts:85`). Projects **do not** auto-activate: a role is
  "you must have one", a project is "you may belong to none" — an infra member may
  need only `common`, and auto-activation would push project-private learnings to
  them, recreating P2. (Small change to relax later if teams turn out to be
  one-repo-one-project in practice.)
- **Q2: explicit `learnings/shared/` vs "root = shared"?** Keep **root = shared**:
  zero migration outweighs the slightly uneven directory listing.

## Affected surface

**New:** `src/projects.ts`, `src/projects-cmd.ts`, and their unit tests.

**Modified:**
- `src/types.ts` — `MemberConfigSchema` + `LocalConfigSchema` each gain `projects`.
- `src/roles.ts` — `ResourceNamespaces` gains the `learnings` key.
- `src/pull.ts` — merge role ∪ project namespaces (`src/pull.ts:135`); filter
  skills/rules/claudemd by the union; namespace-aware learnings sync + cleanup
  (`src/pull.ts:687-745`, which today copies the whole flat `learnings/`).
- `src/push.ts` — `--project` landing point.
- `src/contribute.ts` — landing-point priority (active project namespace → root).
- `src/utils/search-index.ts` — a namespace-aware learnings collector (root +
  active project subdirs), replacing the flat `collectFlatMdEntries` call at
  `src/utils/search-index.ts:549`.
- `src/init.ts` — `--project` flag + append member registration (`src/init.ts:1177`).
- `src/bootstrap.ts`, `src/members.ts`, `src/index.ts` — wiring.

**Docs:** README (bilingual) + usage-guide (bilingual) per the CLAUDE.md sync rule.

**Extended by [#707](https://github.com/Tencent/teamai-cli/issues/707):** env,
hooks, MCP servers, team model profiles and docs, which this design did not
cover, take the same `<type>/<ns>/` namespaces, and an active namespace item
replaces a root item of the same name for every type. It replaces the per-entry
`roles:` / `projects:` keys that #563 and #668 had added to hooks, MCP servers and
env variables. See
[One namespace model for every resource type](#one-namespace-model-for-every-resource-type).

## Phasing

| Phase | Scope |
|---|---|
| P1 | `projects.ts` + manifest + `LocalConfig.projects` + pull filtering of skills/rules/claudemd |
| P2 | learnings namespace + namespace-aware index collector + contribute landing + pull cleanup |
| P3 | member append-registration + query + `projects set/members` + push `--project` |
| P4 | bilingual docs |

**P1 and P2 ship as one PR.** They share the namespace-resolution change; splitting
them leaves an awkward intermediate state — projects isolated but learnings still
cross-talking — which is exactly the most painful half (P2). P3 is a separate PR.

## Relationship to other issues

- **Depends on #374** (subdirectory/worktree `cwd → project root`; P0 satisfies it).
- **Aligned with #341 (Go management backend).** #341's model is
  `Organization → Team → Project` with per-layer resource override and project
  member roles; the `project` semantics match. `projects.yaml` is the declarative
  representation the backend can later import/export. This doc deliberately omits
  Organization/Team layers: in Git mode a team repo *is* one Team, and the extra
  levels have no carrier.

### Explicitly out of scope

`teamai projects join/leave`; Organization/Team hierarchy; auto-activation of a
lone project; migrating existing flat learnings into a `shared/` subdirectory;
`teamai projects set --all` (the `all` selector is limited to `init --project` —
re-running `init --project all` already re-resolves the current manifest).

Also out of scope here, and delivered later by
[#707](https://github.com/Tencent/teamai-cli/issues/707): namespace scoping of
hooks, MCP servers, env variables, model profiles and docs. Still unscoped after
it: `packages` (whose schema mixes an array with a nested object, so it is not the
same edit) and `culture.md`, which suits a document defining how the whole team
works.

## End-to-end test plan (real CLI, per CLAUDE.md — type-check/unit tests don't count)

1. **No manifest → unchanged.** Repo without `projects.yaml`: `init`/`pull`/`recall`
   behave exactly as today (regression baseline).
2. **Admin authoring.** `teamai projects init` / edit `projects.yaml` with two
   projects → `teamai projects list` shows both.
3. **Per-directory activation.** `init --project hai-inference` in dir A and
   `init --project billing` in dir B → each `config.yaml` has its own `projects`.
4. **Skill/rule/claudemd isolation.** After `pull`, dir A has only
   `common` + `hai-inference` resources; dir B has only `common` + `billing`.
5. **Learnings isolation (P2 core).** A learning contributed under `hai-inference`
   does **not** appear in dir B's `teamai recall`; a root-level learning appears in
   both.
6. **Contribute landing.** `teamai contribute` in dir A lands under
   `learnings/hai-inference/`; with no active project it lands at the root.
7. **Namespace-aware index.** `teamai recall` in dir A scans root + `hai-inference/`
   subdir (proves the flat→recursive collector change).
8. **Member roster append.** `init` in both dirs → `members/<user>.yaml` lists
   both projects (append+dedup), while each dir syncs only its own.
9. **Backward-compat roster/config.** An old member file / config without
   `projects` parses without error and is upgraded on next `init`.
10. **`projects set/members`.** After-the-fact `teamai projects set` corrects the
    active project; `teamai projects members hai-inference` lists its members.
