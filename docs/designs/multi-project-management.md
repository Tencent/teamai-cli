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
but is an error. 

The id keeps the
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

When `init` has no `--project` flag and the manifest declares projects, it offers
an optional multi-select after role selection. A blank answer and a non-interactive
run keep `projects: []`; neither auto-activates a project. The non-interactive
path prints the `teamai projects set <id>` follow-up, while an explicit flag
continues to resolve through the manifest as before.

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
action, not the auto-activation ruled out above. 

Because the value is reserved, a
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
<type>/                 root, shared with everyone (skills: through a tag, see below)
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
| secrets (`env/<ns>/secrets.yaml`, [#875](team-secrets.md)) | `env` | secret `key` | conflict |
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
resolved env set, with the member's value for this team (`teamai env set KEY`)
first; the environment no longer overrides a team variable ([Team secrets](team-secrets.md#variables)).

Skills keep one difference: in role/project mode the root `skills/` stays the tag
catalog and is not delivered by default. A root skill that arrives through a
subscribed tag is replaced by an active namespace skill of the same name, and
among tag matches the root skill wins over one in an inactive namespace. A tagged
skill that exists only in an inactive namespace still reaches a subscribed member:
tags cross namespaces by design (#337). 

Installing
a skill removes the files that another team version of that skill (root or any
namespace) has and the new one lacks, when they match that version byte for
byte, so switching versions leaves no team file behind; a file the member added
or edited stays, because push never counts such extras as changes and they may
never have been pushed, and one at a path another version has is named on each
pull. With a record of what teamai delivered (below), a file at such a path is
also removed when it is still what teamai wrote there, and one teamai has no
record of is the member's own and stays without a warning.

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
both delivered and only the root item gives way. 

The root is never a side of a
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
| secrets | the declared secrets are not resolved, and `env.sh`, the env backup and the MCP servers keep what they had; `teamai env list` and `teamai doctor` fail naming the file |
| hooks | installed team hooks and the managed-hooks record stay as they are. The built-in hooks are still installed in each tool that misses one (a tool with all of them is not rewritten), so a first install gets the session-start pull that heals it: with the root file's `builtin:` overrides whenever `hooks/hooks.yaml` parses (a broken namespace file or a clash does not hide them), and when the root file itself does not parse, with their defaults and only in a tool that has no teamai hook yet. `teamai init` and bootstrap say the team hooks were not installed; `teamai hooks inject` exits 1 |
| mcp | no tool's MCP config changes |
| models | no switched agent is updated; `teamai models` commands fail with the same message; `teamai push` refuses any invalid models file, active or not |
| skills, agents | that type is neither installed nor swept; the other types and the search index still sync |
| rules, claudemd, docs, learnings | no conflict case |

For env, secrets, hooks, MCP and models the warning is also written to
`~/.teamai/debug.log`, so a silent session-start pull leaves a trace. This
replaces two earlier behaviours: an invalid hooks or MCP file reconciled to the
empty set and removed every managed entry, and a skills or agents collision
aborted the whole scope.

A `recall` that has to build a missing index follows the same policy. Learnings
do not depend on the manifests and are always indexed: when `projects.yaml`
cannot be read, only the shared root, never every namespace. Docs, rules and
skills that depend on an unreadable `roles.yaml` or `projects.yaml` are left out
with one warning naming the cause, and a skills collision with no index to keep
skills from is named the same way. The partial index is saved like any other;
the next `pull` with the manifest fixed rebuilds it whole. When it cannot be
saved, recall searches nothing in that scope rather than the older index, which
still holds what the warning left out.

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
edited ones, naming them. 

The docs mirror (#817) targets this resolved set: it
copies only the delivered files and prunes a local file the team repo no longer
has only when it is a version of that doc from the team history (#993), inside a
withheld namespace too, but never a local copy of a withheld namespace's team doc;
those follow the byte-equal rule. A file at a path the team history never had is
the member's and stays. The search index and
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
for. 

The binding applies whoever changed the URL, so moving the root profile to
another host (legacy mode included) makes each member re-key once. A key stored
by a 0.26.0 beta as `team:<id>` counts only for the root profile's origin. When
the namespace deactivates, agents return to the root profile with its key; a
profile that existed only in a namespace the member left keeps the agent's
settings, and pull says it `is no longer active in your namespaces`.

### Manifest and per-entry keys

`resources:` gains `env`, `hooks`, `mcp`, `models`, `docs` and (#912) `wiki`. They are optional
and never defaulted: saving a manifest writes back the parsed object, so a
default would add `env: []` to every manifest an admin edits and break members on
an older CLI. For the same reason `--namespaces` on `teamai roles` and
`teamai projects` `add`/`update` sets only the older keys (`knowledge`, `skills`,
`agents`, and `learnings` for projects); the new keys are declared by hand. 

An unknown `resources:` key now warns instead of failing the
scope, and a manifest these commands save keeps it, so the next axis does not break older members again. 0.25.0 and the
0.26.0 betas still reject unknown keys: every member has to upgrade before a team
declares one of the new axes.

The per-entry keys go away. `projects:` on env, hooks and MCP, and `roles:` on
env, existed only in the 0.26.0 betas: an entry that carries one reaches nobody,
and pull, `status`, `env list`, `mcp list`, `hooks list` and
`list <env|hooks|mcp> --source repo` warn with the namespace file to move it to,
one per listed id.
When `teamai env add` updates a variable still carrying one of these removed
keys, it preserves the key and warns that pull will not deliver the variable,
naming the namespace file to move it to.


`roles:` on hooks and MCP shipped in 0.25.0 and keeps filtering for one more
minor release; pull warns once per run and `doctor` has an informational check,
both naming every target file. Model profiles are strict, so a per-entry key
fails the file. An env, hook or MCP entry with any other key its schema does not
know, such as a mistyped `role:`, reaches nobody too. Pull, `status`, `env list`,
`mcp list`, `hooks list`, `list <env|hooks|mcp> --source repo` and `doctor` name
the file, the entry and the key (#822); `env add`, `env remove` and `remove mcp`
keep such a key when they rewrite the file. 

A key that a later version adds is
unknown to this one as well, so an entry that uses it is not delivered to a member
still on this version: every member has to upgrade before the team uses a new
entry key, as for a new `resources:` key. A hooks or MCP file with none of its
top-level keys (`server:` for `servers:`, `hook:` for `hooks:`) used to read as
empty and remove every installed server or hook; it now fails like a file that
does not parse, naming the keys it found, as `env.yaml` has since #662. An extra
top-level key beside a known one is still ignored. 

`pull --dry-run` resolves the hooks
and MCP entries and reports their warnings (an unknown id, a per-entry key, a file
that does not parse) without writing, so a maintainer can see them before a real
pull applies them. There is no automatic migration.

### Push and commands

Write-back goes to the origin the resolver reports: an edited item that replaces
a root one is written to its namespace file, never to the root. The agents
source order is active namespace, then this machine's placement record, then the
shared root; in role/project mode a same-stem root file no longer withdraws the
placement record (legacy mode still does). The skills push scan uses role ∪
project namespaces. A skill outside them stays out unless the delivery record
shows teamai wrote that copy, as when pull keeps an edited skill after a switch.
A copy still exactly as recorded is not an edit and stays out. An edited one goes
back to the team skill whose history holds the SKILL.md version pull recorded,
inactive namespace, active namespace or shared root, even after the team changed
it. When that version matches no single copy, wherever the copies are, it is
skipped with a warning naming them, so a same-named skill that replaced the
deleted one is never overwritten (#1020). A copy teamai never delivered matches
by name only a shared-root or active skill. In legacy mode with no active role
or project, a delivered duplicate goes back only when its record identifies
exactly one same-named skill across all namespaces; missing or ambiguous
records are skipped with a warning. A never-delivered duplicate is also skipped
instead of taking the first namespace, and the warning names the
`push --skill <path> --role <ns>` run that sends it. `push --skill` resolves its skill the
same way, and asks for `--role` rather than taking the first directory that
holds the name. An open PR is reused for a resource only when it records the
same destination this push sends the resource to: a resource already in the
team repo is identified by its path, so same-named skills in two namespaces are
two resources, and a new one by its name. Otherwise this push opens its own PR
and leaves that one untouched. A new skill keeps the destination its open PR
recorded even when a same-named team skill appears elsewhere and the scan would
call the copy an edit of that skill. Open PRs holding a new skill's name at
several destinations prove none of them: push leaves the copy out, and
`--skill <path> --role <ns>` picks the one at that namespace. Edits from several tools of one team skill
are one candidate, the newest, whether or not each copy has a delivery record.
Each copy's destination is decided before copies are merged, so a new skill
awaiting review in one tool and an edit of a same-named team skill in another
stay two candidates.
A new skill, rule or
agent pushed without `--role` or `--project` is placed among the role ∪ active
project namespaces on its own axis, as pull delivers them. When a role is
configured but the role and active projects give no namespace, the resource
stays at the shared root; with no configured role and no active-project
namespace, the pre-project fallback applies (the skills namespace scan for
skills, shared root for rules and agents). Active projects the projects
manifest cannot resolve (an undeclared id, or no `manifest/projects.yaml`) stop
a push without `--role` or `--project` before it scans anything, so neither the
skills scan nor `push --skill` treats every namespace as the member's (#1021).
With a flag the skills scan stays scoped to the role's namespaces rather than
falling back to the unscoped legacy scan. `push` picks up a change to any `env/<ns>/env.yaml` or `env/<ns>/secrets.yaml`.
`teamai env add|remove` take `--role` / `--project`, and `--secret` for that namespace's `secrets.yaml`.


`teamai remove mcp <name>`
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

### Local edits (#822)

Each checkout record (`lastPullByWorkspace[<checkout>]`, HOME's for the user
scope) carries `delivered`: the sha256 of the bytes teamai last wrote at each
skill, rule and agent file path. Pull and the pre-push sync update it when they
write, through the same state save. A copy is the member's edit only when it
has a record and no longer matches it. Pull keeps such a copy and names it: an
info line when the team version is unchanged, a warning when it has moved.
Push warns about such a copy as well (the SessionStart pull is silent), without
holding it, since the member may have merged the team change already. 

A
skill directory is one unit, and files only the member added are not recorded.
Tombstone cleanup keeps an edited copy the same way, and so does the rules
sweep of a rule no longer delivered (deleted from the team repo, or of a
namespace the member left). `--force` keeps edits;
deleting the copy and running `pull --force` takes the team version. 

A rule or
agent file, or a skill directory, with no entry in `delivered` (the first pull on this version, a new
worktree, a restored checkout whose `.git` key changed, the member's own file)
is teamai's only on proof (#993): its bytes, by git blob id, equal a version of
the resource's team file in the team repo's history, or teamai's render of one
for that tool (`isTeamaiCopy`, the target's `origin`). The proof runs only for
a file that exists without a record. 

Otherwise it is the member's: neither
written nor deleted, named (with the kept-edit wording when another checkout's
record lists the path, else `describeMembersFile`), listed by `doctor`, and the
pull does not count as synced, so the next one retries. No record is carried
over to a new key. A skill directory (`isTeamaiSkillCopy`) is decided only when
no file under it has a record: it is teamai's when every file in it but
CONTRIBUTORS is today's team file or a version of that file of a team skill of
that name (root or any namespace, SKILL.md also with its frontmatter repaired),
so one file of the member's makes it the member's, whole. 

The docs mirror keeps
no record: a file at a team doc's path is teamai's only when it is a version
of that doc (`membersDocs`), and the mirror prune deletes a file at a removed
team doc's path only on the same proof (`isPrunableDoc`). teamai writes files,
never links: a link at any delivered path (skill directory, rule or agent file,
docs mirror entry, source skill destination), or anywhere inside a delivered
skill directory, is the member's, never followed, written through, replaced or
deleted by pull, `remove`, `uninstall` or a cleanup sweep, and pull names it
(`describeMembersLink`). 

The mirror prune keeps any file or link at a path the
team never had, and delivery skips a link inside a team or source skill. A forced
full sync elsewhere keeps each checkout's `delivered`.
`doctor` does not fail on a kept copy; next to another problem it lists one
as "changed by you (kept by pull)". A member's own file fails the delivery
check, as the team version does not reach that tool: it is listed as "not
teamai's (kept by pull)" with pull's line for each file.

Codex's shared `.agents/skills/<name>` is a destination only for a copy that
is teamai's under the same rule (#993): `resolveSkillDestination` takes the
ownership predicate, `judgeCopy` against the checkout's record in pull, the
history proof alone (`isTeamaiSkillCopy`) in doctor, and `ownsSkillDir` in
`teamai remove` and `uninstall` (below). Any other copy there is the member's
or another tool's, and is
not "kept" in the sense above: Codex gets `.codex/skills/<name>` instead, the
team skill is delivered, and every full sync names the conflict (Codex sees two
skills of that name). 

Source skills use the same rule with the source repo
as origin (#993 bug 8): a shared copy is the source's when its installation
manifest records it, or it is the source skill as pulled now or a version in
the source repo's history (`isTeamaiSkillCopy` against the source cache).
The built-in stub still takes an existing shared copy as its own.

The commands that delete skill directories by a team skill's name apply the
same rule in every tool's skills root (#993): `teamai remove skills <name>` and
`uninstall` delete a directory only when a file under it is on the checkout's
record (edited or not) or `isTeamaiSkillCopy` proves it (`ownsSkillDir`), and
name each one they leave; uninstall also deletes a built-in's name and a name
the local agent's manifest lists. `uninstall` removes from the docs mirror only
what the history proves teamai's (`removeTeamDocs`: a file or link at `<rel>`
that is a version of `docs/<rel>`), keeps and names the rest, and leaves the
directories holding it, inside the data home too. 

Pull's sweep of the namespace-nested copies
earlier releases left of an excluded skill deletes one only when
`judgeRemoval` returns `remove`, and leaves the rest silently, as pull never
delivers there. `judgeRemoval` sorts a copy of a resource no longer
delivered into `remove`, `edited` (changed since teamai delivered it, or on
another checkout's record) and `notTeamais` (no record, no team version), so
each caller names a kept copy for what it is.

Codex's shared `.agents/skills/<name>` is swept with the configured skills
directory (#915): when a skill stops being delivered (an inactive namespace,
Step 3b, a tombstone), pull deletes the shared copy only when `judgeRemoval`
returns `remove`, and names an `edited` or `notTeamais` one. No removal pass of
pull deletes a path the index of its checkout tracks (#915): the check
(`keepsTrackedCopy`) sits right before each deletion of a copy no longer
delivered (inactive namespaces, Step 3b, tombstones, the rules sweep and
unselected rules, inactive agents, a source dropping a skill), so a later pull
that proves the copy teamai's keeps it too. Each pull names it once, with
`git rm -r <path>`; a source's kept copy stays on its installation's record.
The same check guards layout migrations (a rule's legacy `.md`, the copy a
namespaced rule supersedes, legacy rule directories, moved nested copies,
agent format siblings, Codex's configured copy of a skill in `.agents/skills`,
leftover files of another team version of a skill, the built-in recall agent's
old format), whose message adds where the resource lives now, the prune of the
files earlier releases shipped in the CLI's built-in skills, and the explicit
commands: `teamai remove`,
`teamai source remove` and `uninstall`, whose summary counts them as
`Kept (tracked)`. A team repo with no rules left still runs the rules sweep,
so the copies of a last rule the team deleted go, on the same ownership proof.

### Known gaps

- `teamai remove`'s rules refresh judges copies against the checkout's record
  and the team history as pull does (#993), and deletes a copy of the removed
  rule only when it is on record or proven teamai's (the author's root copy by
  its placement record); it records nothing. Local-agent installs deliver rules
  and skills as before: they overwrite a changed copy and record nothing. The
  next pull judges a skill, rule or agent copy either wrote by the team history.
- Step 3b and the inactive-namespace cleanup of skills and agents still compare
  with the team source, not the record, so an untouched copy delivered at an
  older revision stays there with a warning.

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
- `src/contribute.ts` — explicit `--namespace` must belong to the active projects'
  learnings namespaces; otherwise default to the only active namespace or the
  shared root. Persist the chosen relative path in the existing pending queue
  so retries keep their destination. `projects list` shows the default and choices.
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
6. **Contribute landing.** `teamai contribute` defaults to the only active
   learnings namespace, or the root when there are none or several. With
   `--namespace`, it accepts only an active learnings namespace (not necessarily
   a project id); unavailable paths are refused before queueing. Preview and
   offline retry retain the selected destination.
7. **Namespace-aware index.** `teamai recall` in dir A scans root + `hai-inference/`
   subdir (proves the flat→recursive collector change).
8. **Member roster append.** `init` in both dirs → `members/<user>.yaml` lists
   both projects (append+dedup), while each dir syncs only its own.
9. **Backward-compat roster/config.** An old member file / config without
   `projects` parses without error and is upgraded on next `init`.
10. **`projects set/members`.** After-the-fact `teamai projects set` corrects the
    active project; `teamai projects members hai-inference` lists its members.
