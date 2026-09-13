# Design: DSH Team Context integration (v0, read-only)

> Status: v0 implemented. DSH Team Context → TeamAI, one direction only.

## Problem

DSH Team Context is a separate, canonical source of truth for org-wide shared
skills, rules, and governance — distinct from a team's own teamai team repo
(which stays authoritative for its own skills/rules/learnings). TeamAI must
consume it without becoming a second owner of that content: no automatic
promotion into it, no write path, no silent local override of governance.

## Decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Direction | DSH Team Context → TeamAI only | No review/promotion workflow exists yet on the DSH side; a write path would need one |
| 2 | Config location | Team-level `teamai.yaml: teamContext: { repo }` | Same governance as any other team-config change (reviewed via `teamai push`), not per-user |
| 3 | Allow-list | None. Everything under `skills/`, `rules/`, `governance/` is canonical | Unlike peer `sources` (`publicSkills` opt-in), a canonical repo is trusted by default |
| 4 | Contract | `team-context.yaml` (`schemaVersion: 1`) at the DSH repo root | Version/shape validation, not a publication filter; unknown version fails loud before any local write |
| 5 | Skills collision | Local team skill wins; canonical copy skipped, **observably** (logged + reflected in the adapter's own manifest) | Team-authored content must not be silently shadowed by canonical content |
| 6 | Rules collision | Canonical wins by default | Governance-adjacent rules must land uniformly; achieved by materializing rules AFTER the per-scope team-rule sync in `pull()` |
| 7 | Governance | Always fully regenerated into its own CLAUDE.md block; no config flag anywhere disables or shadows it | The one entity where local override must be structurally impossible, not just discouraged |
| 8 | Learnings | Deferred entirely (not part of v0) | Curated cross-team learnings need their own resolution semantics; scope was cut to ship skills/rules/governance first |
| 9 | Shared primitives | Clone/pull-with-TTL and name-set diffing extracted into `utils/external-repo-cache.ts`, reused by both `source.ts` (peer sources) and `team-context.ts` | Avoid duplicating the same clone/TTL/diff logic a second time |
| 10 | Atomicity | Resolve the full snapshot (skills + rules + governance + schema check) in memory before any local write | An invalid/incompatible upstream must never leave partial or tombstoned local state |

## Architecture

```
DSH Team Context repo (git)              teamai.yaml (consumer team)
  team-context.yaml                        teamContext:
    schemaVersion: 1                          repo: <git-url>
  skills/<name>/SKILL.md
  rules/<name>.md
  governance/*.md
          │                                        │
          │              teamai pull                │
          ▼                                         ▼
~/.teamai/team-context/<hash>/repo/  ← git clone (read-only, never pushed to)
~/.teamai/team-context/<hash>/installed.json ← manifest (skills/rules/governanceFiles deployed)
          │
          ▼
resolveTeamContextSnapshot() → validates schemaVersion, resolves the WHOLE
snapshot → materializeTeamContext() → per-entity collision policy → tool dirs
+ CLAUDE.md governance block
```

`team-context.ts` runs as its own step in `pull()`, immediately after the
existing cross-team `pullSources()` step — same contention-filtered scope,
same best-effort semantics, no new hook event. `scanLocalForPush` (skills.ts,
rules.ts) excludes canonical names via `getTeamContextItemNames()`, so
canonical content can never be swept into a team PR.

## Deferred

- Curated cross-team learnings (index-only ingestion).
- Namespace/role-aware filtering of Team Context content (v0 deploys
  everything the repo publishes).
- Admin-enforced protection of the `teamContext` field itself — today it is
  an ordinary team-config field; a team member can still remove or repoint it
  through the normal `teamai push` flow.
- Any propose/promote path back into DSH Team Context.
