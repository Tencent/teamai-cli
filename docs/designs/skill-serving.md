# Serving built-in skill content from the CLI

Issue: [#678](https://github.com/Tencent/teamai-cli/issues/678). Unreleased; targets the release after 0.25.0.

## The problem

The built-in skills describe the CLI, but they did not travel with it.
`deployBuiltinSkills` copied three whole skill directories into every installed
agent's skills directory on `init`, on `pull` and on a recall toggle, and nothing
else touched them. After `npm i -g teamai-cli@latest` the agent kept reading the
previous release's instructions until the member happened to run a pull, and a
machine with several agents could hold several different versions at once. Four
commits exist only to re-align deployed text after a command changed (`e151d43`,
`1ca43ac`, `8bb0548`, `2ddb546`), and every one of them needed a pull on every
machine to take effect.

The copies were also large — 176 KB per agent, with
`skills/team-wiki-codebase/SKILL.md` alone at 38 705 bytes read in full on every
activation — but that is the secondary cost. The primary one is that the agent's
instructions and the binary they describe were versioned separately.

## The shape

**The skill content is versioned with the CLI.** It ships inside the npm package
and is printed by the installed binary, so `teamai skill get core` on version X
prints version X's instructions, byte for byte, with no pull in between.
Upgrading the CLI is the update; there is nothing else to sync.

One deployable unit, everything else served on demand. The pattern is
`vercel-labs/agent-browser`'s, verified against its published 0.38.1 package.

```text
npm package
├── skills/
│   └── teamai/SKILL.md          the only unit deployed into agents (~2 KB)
└── skill-data/                  never deployed; printed by `teamai skill get`
    ├── core/                    daily sync, routing, publishing a skill, command reference
    ├── setup/                   day 0 and repo lifecycle
    ├── wiki/                    codebase knowledge base, incl. scripts/
    └── share/                   session learnings
```

`skills/` keeps the invariant "everything here is deployed", which is what lets
`BUILTIN_SKILL_NAMES` hold a single name instead of a list of guards.

What an agent reads, and when:

```text
session start            stub frontmatter (description)   1 005 B   always in context
task matches             stub body                          1 524 B  holds the commands
`teamai skill get core`  daily workflow                     6 479 B  on demand
`… core --full`          + commands.md, contribute-member,
                           troubleshooting                 36 267 B  on demand
`… setup` / `wiki`       5 566 B / 19 315 B                          on demand
`… setup --full` / `… wiki --full`   38 570 B / 132 949 B            on demand
```

Served sizes include the resolved `{SKILL_DIR}`, so they grow with the install
path (measured here from a 77-character one).

## Contracts worth keeping

- **`skill get` prints the file byte for byte**, frontmatter included, with no
  banner. The only transformation is `{SKILL_DIR}`, replaced with the absolute
  packaged directory, so a documented `python3 {SKILL_DIR}/scripts/scan_repo.py`
  runs as written. `agent-browser` leaves that placeholder unsubstituted; an
  agent copying such a line literally fails, which is why we resolve it.
- **Content on stdout, diagnostics on stderr.** An unknown flag warns and the
  command continues — a hallucinated flag should not cost a round trip. An
  unknown *name* is fatal: acting on the wrong instructions is worse than a
  retry.
- **`--full` walks `references/` and `templates/` recursively**, sorted by
  relative path. Our references nest (`references/methodology/`,
  `references/phases/`); a single-level scan would serve an incomplete skill.
- **The stub lands where team skills land.** Deploy, the legacy prune,
  `recall disable` and `uninstall` resolve the skills directory through
  `skillsDirForTool`, the resolver team-skill sync uses, so OpenClaw gets it in
  its workspace and Hermes under `HERMES_HOME` rather than under a tool root
  that agent never reads. The link guard walks from the scope root (home, or
  the project root) when the skills directory is under it, else from just above
  the configured root, so that root is checked too.
- **Nothing repairs the deployed stub.** `ensureSkillFrontmatter` is not called
  on it, so deployed and packaged bytes are identical and a diff means a bug.
- **Recall is decided at run time**, not by withholding a directory at deploy
  time, and so is the read-only HTTP source that `reportingOnly` used to skip
  `share` for (`teamai contribute` refuses there, so the workflow would fail at
  its last step; `skill list --json` reports `blockedBy: "read-only"`). Both hold
  on every path that hands out content or a location:
  `skill get <name>` refuses, `skill get --all` leaves the skill out and says so
  on stderr, `skill path <name>` and `skill show <name>` refuse, and
  `skill list --json` reports `blockedBy: "recall"` with `path: null`. With no
  config on the machine at all it fails open: a refusal a fresh install cannot act
  on is worse than serving the workflow. A config that exists but cannot be loaded
  blocks instead (`blockedBy: "config"`), since recall and the source are then
  unknown and the workflow would fail at `teamai contribute` — a project config
  too, which detection alone would skip in favour of the user config
  (`findUnreadableProjectConfig`). The Stop-hook share reminder is gated the same
  way (`contributeHintAllowed`, `src/hook-handlers.ts`), because it points at this
  command, with one difference: with no config at all it stays silent. The hook
  fires in every project on the machine, and a directory without teamai has no
  team to share with (#748). The gate lives in one place:
  `resolveServableSkill` (`src/skill-content.ts`) is the only way to obtain a
  packaged skill outside that module, and it returns `blocked` instead of the
  skill, so a command cannot print a directory it never received.
- **`skill path` takes a name, always,** and a blocked name gets the same
  refusal as `skill get`. The gate routes the agent away from a workflow that
  cannot finish; it is not access control, since the files ship in the package.
- **A member's own skill outranks a packaged name.** `locateSkill` searches the
  team repo, then the installed agents, then the package. `codebase`, `default`,
  `learning` and `share` are ordinary names: a directory a member created under
  one of them is the skill they are asking about, and the recall gate does not
  apply to it. The two legacy directory names are the exception, by design:
  `team-wiki-codebase` and `teamai-share-learnings` classify as `[builtin]` and
  are skipped by the push scan by name alone (`isCliOwnedSkillName`), because a
  tree with that name is one a pre-stub release wrote until the first pull has
  pruned it. That rule retires with `LEGACY_BUILTIN_SKILL_NAMES`.
- **`skill get` has no `--json`.** #678 sketched one; the content is markdown for
  an agent to read, and the machine-readable half is `skill list --json`. An
  unknown flag on `skill get`, `--json` included, is warned about on stderr and
  ignored, so the content still arrives.
- **`skill list` needs no team.** The human-readable listing prints the packaged
  catalog even before `teamai init`, with a hint for the team half, so a fresh
  machine can discover what the installed CLI serves the way `skill get` lets it.


## Drift guards

Two tests, both in the unit suite:

- `commands-reference.test.ts` renders `skill-data/core/references/commands.md`
  from the Commander table and diffs it. Regenerate with
  `npx vitest run commands-reference -u`.
- `skill-commands-exist.test.ts` resolves every `teamai …` string written
  anywhere under `skill-data/` against that same table, and fails on an unknown
  command or flag. It carries a case proving it catches `teamai extract graph`,
  the command the wiki skill advertised for four releases.

A third, in `skill-content.test.ts`, asserts through `npm pack` that both
`skills/` and `skill-data/` are in the published tarball. Without it, a missing
`package.json` "files" entry passes every other test and serves nothing once
installed. The same file fails on Chinese text under `skills/` or `skill-data/`:
both reach the agent as CLI output, which the repo keeps English.

## Migration

`LEGACY_BUILTIN_SKILL_NAMES` (`src/builtin-skills.ts`) names the directories
earlier releases deployed: `team-wiki-codebase` and `teamai-share-learnings`.
Deployment removes those two, after the stub is in place, from every installed,
non-excluded agent, in its configured skills path; Codex's pass also covers the
shared `.agents/skills`, which no other tool's pass touches. `teamai-workflow`
and `teamai-import` sat in the old guard set but were never packaged, so they
are not in it: a directory by either name is the user's own and is never
touched.

Codex's shared root is on the removal side of three commands now, because
`resolveSkillDestination` puts the stub there whenever the skill already lives
there: the legacy prune, `recall disable`, and `uninstall`, whose skill discovery
adds `.agents/skills` for `codex` alone. Without it, an uninstall reported
success while leaving `~/.agents/skills/teamai` behind.

**`uninstall` deletes a CLI-owned directory by the same rule.** A team-repo skill
is synced whole, so uninstall removes the whole directory. A CLI-owned one is
not: deployment writes only `PACKAGED_SKILL_FILES` and never touched a file the
member added beside them, so uninstall removes those same paths through
`removeOwnedFiles` and keeps the rest, saying which directory it kept. Deleting
the directory there would undo, one command over, the guarantee pull makes.

Pull's archive is deliberately not applied there: pull runs on an upgrade the
member did not ask anything to be removed by, while uninstall is them asking for
all of it to go. Leaving copies behind would be the thing they ran it to avoid.

**It removes only the files those releases packaged, at the content they
packaged.** `PACKAGED_SKILL_DIGESTS` (`src/packaged-skill-digests.ts`) records the
sha256 of every blob `git ls-tree -r <ref> -- skills/` shows over all 100 tags
through v0.25.0 and `main` before the stub, minus `teamai-wiki` (see below): 42
versions across 21 paths. A file is ours only at one of those paths *and* with one
of those digests, whole file, frontmatter included: a member who changed only a
skill's description changed the skill. The deploy repaired frontmatter from
0.16.1 on, but every `SKILL.md` those releases shipped was already complete, and
the copies came from the npm tarball byte for byte, so an unedited one matches.
No release shipped a symlink, so a link is never ours, and bytecode is ours only
beside a script proven ours by content. Anything else at a packaged path — an edit, a
member's own skill that uses a legacy name, a root TeamAI never managed because
`toolPaths` or `HERMES_HOME` moved — is the member's and stays, with its
directory. Checking the path alone would have deleted those. What is removed is
still copied first to
`~/.teamai/removed-skills/<run>/<base>/<tool>/<skill-root>/<skill>/`, so no
removal is a one-way door. Order matters as much as ownership: the stub is
written first, then the references it no longer points at are pruned, and the
legacy trees go only once the stub deployed for that agent, so a stub that cannot
be written leaves a working old skill rather than a broken one. The destination
is resolved without side effects before the link guard runs. Codex reads both `.codex/skills` and the shared `.agents/skills`, and the
stub goes to the shared one when a copy already lives there; the copy an earlier
release left in the other root is retired by the same rule
(`retireOtherCodexCopy`), so Codex never sees a stale `teamai` beside the current
one. That path is the machine's
home, never the tool's base directory, which under project scope is the repo
root. Only *retired* paths are archived: the stub is rewritten on every session
start, so archiving it would file an identical copy per session forever. A
link on any component between the scope root (home, or the project root) and
the skill directory — `~/.claude`, `~/.config/opencode`, `~/.claude/skills`,
`COPILOT_HOME`, the skill directory itself — is refused outright: neither pruned nor written through, link
and target untouched, since everything under it matches our names and none of it
is ours. Pull, deploy and `uninstall` apply the same check; uninstall carries
each skill directory's base for it. Components at or above the base are not
checked: a home directory under a link is ordinary. The cost is a member whose
whole `~/.claude` is a link (stow, chezmoi): the stub is not deployed and the
legacy trees stay, with a warning on each pull naming the path, until the link
is replaced by a directory. Deleting through a link is the one thing the prune
must never do, so that member is told rather than guessed for. The
`<base>` segment is there because `inheritUserScope` deploys the user base and
then the project base in one process, with the same tool, root and skill name. A file whose copy fails is
kept rather than removed: a backup that did not happen must not authorise the
delete. The path carries the run and the skill root because neither is unique on
its own — two pulls land on the same day, and Codex prunes the same skill name
from both `.codex/skills` and the shared `.agents/skills`. Directories left empty go; a directory still holding a member's
file is kept, and `pull` says which one and why. Python bytecode of a script we
shipped counts as ours, so a `__pycache__` left by running the wiki scripts does
not strand the tree. The same rule governs the stub directory: the seven
`teamai/references/*.md` a pre-stub release wrote are removed by name, not by
"everything that is not SKILL.md".

`teamai-wiki` (0.13.0, 0.16.x) is deliberately not in the set. It predates the
trees this migration is about, and widening a destructive set belongs in its own
change.

Between the upgrade and that first pull the legacy trees are still on disk, so
two other commands know the names too: `push` never offers them as new user
skills (`isCliOwnedSkillName`), and `recall disable` still removes
`teamai-share-learnings` (`LEGACY_RECALL_SKILL_NAMES`), as it did before the stub.

**Retire that set once 0.25.x, the last release to deploy those trees, is no longer in the field.** The short names
(`wiki`, `share`) are the canonical ones; the long names survive as aliases in
`SKILL_ALIASES` (`src/skill-content.ts`) for documentation and muscle memory,
and can be dropped on the same schedule.

`/teamai-share-learnings` was never a deployed slash command in its own right —
it existed because the directory was installed. The Stop-hook nudge now names
`/teamai share what this session taught me`, an invocation the core skill routes
to `share` (bare `/teamai` prints the menu and stops), and carries
`teamai skill get share` literally, so an agent can act on it even without
inferring the intent. It is withheld while recall is off, because that command
refuses then.
