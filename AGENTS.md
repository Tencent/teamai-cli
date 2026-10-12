# TeamAI CLI

CLI for managing a team's skills, rules, agents, learnings, models, MCP, and other AI assets in a git repo, and syncing them into AI coding tools. Package: [`teamai-cli`](https://www.npmjs.com/package/teamai-cli).

TypeScript, Node 20+ (`npm run lint` needs ^20.19 or >=22.12), tsup (ESM), Vitest. Commands: `npm run build`, `npx tsc --noEmit`, `npm run lint`, `npx vitest run`, `npm run test:e2e`.

## Git

- Default branch: `main`. Worktrees and PRs based on `origin/main`.
- PR only to `Tencent/teamai-cli`. Before push, check `git log origin/main..HEAD`; rebase or cherry-pick if unrelated commits appear.
- **Use a worktree**: call `EnterWorktree` before changing code. Do not edit the main working directory.

## Rules

- **Occam's razor**: do not add a new CLI command early. Skip it unless it is necessary. Reuse or extend an existing command or option.
- CLI user-facing output must be English. No Chinese in production code. Tests assert English output.
- **Doc layout**: user-facing docs are bilingual. Top-level files are `name.md` / `name.zh-CN.md`. Guide pages are `docs/guide/<page>.md` (English) and `docs/guide/zh-CN/<page>.md` (Chinese). A behavior change updates both. `docs/designs/` (design notes: a `> Status:` line at the top, and a status entry in `docs/designs/README.md`) and `docs/dev/` (maintainer docs) are English only. Behavior changes must update every affected doc; grep old wording before opening the PR.
- **Change docs rarely**: leave them alone when you can. A bugfix that does not change behavior a user runs into does not need a doc change. When you do edit docs, write them so you can understand them. Do not make them complicated.
- **Keep the README short**: change it as little as possible. When a change is required, update every language (`README.md` and every `README.*.md`; run `ls README*` first) and keep them consistent.
- **Treat `skill-data/` like docs**: that is what the agent actually reads. A behavior change must update the affected skills (`core` / `setup` / `wiki` / `share`), and grep the old wording before the PR.
- `skill-data/core/references/commands.md` is generated from the Commander command table. After changing a command or flag, regenerate it with `npx vitest run commands-reference -u`.
- **Leave the teamai skill body alone**: the source of truth for usage and flags is the CLI help (`teamai --help`, `teamai <cmd> --help`) and the generated `commands.md`. To make an agent better at a command, clarify that command's `description` and option help, and point the skill at help, instead of copying usage into the skill. Edit the skill body only when the workflow itself changes.
- Only `skills/teamai/SKILL.md` (the discovery entry) is deployed to the agent. Keep it version-independent: a new workflow is a directory under `skill-data/` plus one line in the stub. Do not put the content in the stub.

## Testing before a PR

A PR that changes runtime behavior (anything other than docs-only / tests-only) must, after `npm run build`, verify the change end to end with the real CLI. Type check and unit tests are not enough. **One representative real-CLI run is enough.** Paste the record of what actually passed into the PR. A docs-only or tests-only change needs no e2e record.

Iterate with `npm run test:e2e -- <test-file>`; run the full suite only when changing the E2E runner, shared fixtures, or test isolation ([CONTRIBUTING.md](.github/CONTRIBUTING.md#testing-guidelines)).

Do not cover the full provider × agent matrix below. Leave extra providers and agents to CI, or say so when the local environment cannot run them:

- Agents: Claude, Codex, CodeBuddy, OpenCode
- Providers: `git`, `gitlab`, `github`

## Self review before push

Review the whole branch diff, not only the last change. For every piece of
shared state, list every reader and every writer.

## Code Review Rules

- The PR description must document sufficient testing. For a PR that changes
  runtime behavior (anything beyond a docs-only or tests-only diff), that
  includes an end-to-end / real-CLI verification record, not only unit tests
  or type checks — flag such a PR that lacks one as `[P1 blocking]`. A
  docs-only or tests-only PR needs no e2e record; do not flag it for that.
  Do NOT require a full provider × agent matrix — one representative real-CLI
  run is enough. Missing coverage of extra providers (`gitlab`/`github`) or
  agents (`Codex`/`CodeBuddy`/`OpenCode`) is at most `[P3 nit]` when the author
  has flagged it as untestable in this environment or deferred to CI, never
  `[P1 blocking]`. A test record naming an older commit than the head is a
  note, not a blocking finding; the body may have been edited after the review
  pass started.
- Do not over-review. Report only findings you are confident are real in the
  current diff. Do not cap how many findings you report: every real bug should
  surface in one pass, not be deferred to a later one. Instead, gate severity
  by evidence — every `[P1 blocking]` must cite either a concrete failure
  scenario (the input or state that triggers it and the resulting misbehavior)
  or the exact `## Code Review Rules` item it breaks. A finding that can cite
  neither is at most `[P2 non-blocking]`; a speculative or theoretical risk
  that needs an unlikely precondition to trigger is at most `[P3 nit]`. Never
  restate a finding already resolved in the current diff.
- Reject over-engineering. Favor the smallest code that solves the problem;
  flag speculative abstractions, unused flexibility or config, error handling
  for cases that cannot occur, and new CLI commands added where an existing
  command could be reused or extended.
- Changes must be surgical. Every changed line should trace directly to the
  PR's stated goal; flag unrelated drive-by edits.
- Label every finding with an explicit severity a first-time reader can
  understand — never a bare `P1`/`P2`/`P3` code. Keep the `P` marker but spell
  out what it means inline on each finding, using the PR author's language:
  `[P1 blocking]` for issues that must be fixed before merge,
  `[P2 non-blocking]` for suggestions that do not block merge, and `[P3 nit]`
  for minor or optional polish, theoretical edge cases, and coverage deferred
  to CI. (In Chinese, `[P1 阻断]` / `[P2 非阻断]` / `[P3 可选]`.)
