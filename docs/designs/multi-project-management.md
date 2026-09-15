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
```

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
override between them.** They live on different planes: a "HAI dev" legitimately
needs generic dev skills (from `role`) *plus* HAI-specific knowledge (from
`project`), so the resolver takes the **union**, never one-overrides-the-other.
Concretely:

- **learnings** — `project` alone owns this dimension (`role` contributes nothing),
  so "project wins" is already a hard invariant here, with nothing to override.
- **skills / knowledge** — the only place the two dimensions could "cross" is a
  **same-named** resource in a role namespace and a project namespace. That case
  is already a hard error today (`src/pull.ts:204` `Duplicate skill ... found in
  active namespaces`), resolved by the **admin** disambiguating names in the
  manifest — deliberately **not** by a runtime priority rule. A well-formed
  manifest keeps role and project namespaces non-overlapping, so the crossing is
  eliminated at the source rather than arbitrated at pull time.

Implementers should therefore **not** add any project-over-role precedence logic:
the union + existing duplicate-guard is the whole model.

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
