# TeamAI CLI

CLI for managing a team's skills, rules, agent definitions, learnings, models, MCP, and other agent resources in a git repo, and syncing them into AI coding tools. Package: [`teamai-cli`](https://www.npmjs.com/package/teamai-cli).

TypeScript, Node 20+ (`npm run lint` needs ^20.19 or >=22.12), tsup (ESM), Vitest. Commands: `npm run build`, `npm run typecheck`, `npm run lint`, `npx vitest run`, `npm run test:e2e`, `npm run verify:world` (`npm run -s verify -- help` lists its verbs).

Terms follow [docs/dev/glossary.md](docs/dev/glossary.md). Here, **you** means the agent changing teamai, a **member** is a person whose team uses teamai, and **maintainers** review your PR.

## How it works

A team keeps its agent resources in a team repo. `teamai pull` resolves each one through its layers (teamai's default, the team root, the active namespace) and delivers it into every tool a member uses. AI work runs as workflows on a driver. The [glossary](docs/dev/glossary.md) names these concepts, [the workflow engine](docs/dev/workflow-engine.md) explains how runs work, and [tool support](docs/guide/tool-support.md) shows what each tool receives.

## Git

- Default branch: `main`. Worktrees and PRs based on `origin/main`.
- PR only to `Tencent/teamai-cli`. Before push, check `git log origin/main..HEAD`; rebase or cherry-pick if unrelated commits appear.
- **Use a worktree**: call `EnterWorktree` before changing code. Do not edit the main working directory.

## Rules

- **Occam's razor**: do not add a new CLI command early. Skip it unless it is necessary. Reuse or extend an existing command or option.
- **Workflow first**: a feature that orchestrates AI work is a default workflow, `workflows/<name>.yaml` or a folder `workflows/<name>/WORKFLOW.yaml` with the files it needs, and a team replaces it with a file or folder of the same name. What a team may change (steps, their order, prompts, thresholds) lives in that YAML and its folder. The feature's command is only a shortcut that starts the workflow. Code keeps only the invariants a team must not change. A new workflow key is generic: the engine never branches on a feature (`docs/dev/workflow-engine.md`).
- **Shortcut on the default driver**: a feature command starts its default workflow on the driver `workflows.driver` names, local when unset, through `runShortcut`. It adds no `--driver` flag.
- **No AI call outside a workflow**: only drivers launch AI tools; a feature asks an AI tool through an `answer` or `prompt` step. The lint rule `teamai/launch-through-workflows` fails an import of the launcher outside `src/workflow/`.
- **Judgment goes through scorers**: anything that judges AI work is a scorer that `teamai-score` judges, never a direct AI call. A rubric teamai ships is a default scorer, `scorers/<name>.md`, and a team replaces it with a file of the same name. Code keeps only the contract: the variables a default offers and what pull refuses (`src/default-scorers.ts`).
- **Compose workflows**: before writing steps, run an existing workflow as a `workflow:` step instead of repeating it, as `teamai-share-session` runs `teamai-score`. Write a new one so another workflow can run it the same way: its inputs and outputs say what it takes and gives, and it does not assume it is the root run.
- CLI user-facing output must be English. No Chinese in production code. Tests assert English output.
- If a rule here fights the task, say so and get a maintainer's sign-off before breaking it.

## Documentation

Most code changes do not need a documentation change. Agents can read the code.

- `docs/dev/` is for architectural decisions and their reasons, constraints that span modules, and implementation traps that are hard to discover from the source. Before adding a paragraph, ask what a maintainer would get wrong without it. If reading the relevant code answers the question, leave it out. English only.
- Do not document every feature, enumerate fields or methods, narrate control flow, maintain file catalogs, or append PR summaries. Types, tests, and code already record the implementation. The [glossary](docs/dev/glossary.md) defines shared vocabulary; it is not a feature index. A new public concept adds its entry in the same PR, and an avoided spelling is fixed on the lines you touch; lint counts the rest.
- A local reason the code can't show goes in a short nearby code comment. Use `docs/dev/` when the reasoning crosses modules or needs context the code cannot carry well. Link to the relevant source instead of copying it.
- When a documented decision or constraint changes, rewrite or remove the affected text. Do not append another account of the new behavior. A new page needs a distinct, durable reason to exist.
- `docs/guide/` helps members accomplish tasks. Give each major feature a concise section explaining what it does, how to start, and anything unintuitive. Keep it in the product's voice, without implementation details or contributor tooling. Each page has an English `docs/guide/<page>.md` and a Chinese `docs/guide/zh-CN/<page>.md`, and a change to how a feature is used updates both. Top-level docs pair `name.md` with `name.zh-CN.md`.
- `skill-data/` is what agents read at run time, reached from the teamai skill by progressive disclosure. A behavior change updates the affected skill. The CLI help is the source of truth for usage and flags: to make an agent better at a command, sharpen that command's description and option help, and point the skill at `--help` instead of copying usage into it.
- The teamai skill is the one skill teamai ships, and its context pointer sits in every session. Keep it version-independent: a new workflow is a directory under `skill-data/` plus one line in the skill. Edit its body only when the workflow itself changes.
- Generated pages, the command reference and the tool support pages, change through their source: `node scripts/check-docs.mjs --write`. Their cell text stays English in both languages.
- The README stays short. When it must change, every `README*.md` changes together.
- Before the PR, grep the old wording across docs and `skill-data/`.

## Plans and work artifacts

- Do not commit implementation plans, research notes, or agent scratch files. Keep temporary working material outside the worktree.
- A merged PR is the implementation record. Close or update its tracking issue when the work lands; do not preserve a second checklist in the repository.

## Hit every surface

The most common defect is a change that works on the path you tested and is missing everywhere else. Before you call work done, walk this list and say in the PR which entries applied:

- **Tools**: every supported tool gets a decision, even "not supported here".
- **Where a step runs**: every driver and runtime gets a decision, even "not supported here"; `npm run -s verify -- help drivers` lists each one's entry point and end state.
- **Scopes**: user and workspace.
- **Team repo modes**: `git`, `http`, and self mode.
- **Checkouts**: a linked worktree, a submodule, a workspace with workspace children, a bare repo. The repo anchor, main checkout, and workspace root can differ between them.
- **Layers**: a default, its replacement at the team root, and the active namespace.
- **Entry points**: the CLI command, a workflow step, a hook, and the dashboard.
- **Reverse states**: whatever pull delivers, a later pull and `teamai uninstall` remove. A way in has a way out and a way to see it.
- **Runs**: the first run and the second. A cache, a stamp or a cooldown makes them differ, and a member lives in the second.
- **OS**: Windows CI runs a subset of the tests. Say when a path change did not run there.
- **Docs and `skill-data/`**: check whether the change makes existing guidance inaccurate. Apply the [documentation rules](#documentation) before adding anything.

## Ways to hurt yourself

1. **Running the CLI against your own HOME.** `teamai init` and `pull` write into `~/.teamai` and into the config of the tool you are running in. Run the CLI in a world: `npm run -s verify -- help`.
2. **Testing a build you did not mean.** A world freezes the build it was made from. Change teamai, and the next proof needs a new world. `doctor <run>` warns when the checkout has moved on.
3. **Letting your shell leak in.** `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `TEAMAI_*` and the other tool homes point outside any sandbox you make by hand. A world's commands start from an empty environment, and its ledger reports any run that reached the real HOME or this checkout.

## Testing before a PR

Import boundaries, banned APIs, and required helper calls belong in `oxlint-plugin-teamai`, with fixtures using `ruleHarness`. Do not scan source with `fs` or `web-tree-sitter` in `src/__tests__/`, or repeat helper wiring checks in per-command E2E files. For example, `teamai/remove-delivered` rejects bare deletion at pull call sites; `delivered-copies.test.ts` checks the helper's file and ledger behavior.

Documentation checks run in `npm run lint`.

A PR that changes runtime behavior (anything other than docs-only / tests-only / lint-rule-only) must verify the change end to end with the real CLI, in a world (`npm run verify:world`). Type check and unit tests are not enough. **One representative real-CLI run is enough.** Paste the record of what actually passed into the PR. A docs-only, tests-only, or lint-rule-only change (no runtime code touched) needs no real-CLI record. For a required helper call enforced by an enabled `teamai/*` rule, run `npm run lint` and the helper unit test; do not add an E2E file for each command.

CI reports how the text teamai's defaults put in an agent's context changes against main: always loaded, through progressive disclosure, and on hook events. When always-loaded text grows, say why in the PR.

CI also reports the agent wait budget against main: the processes a hook or a pull makes the agent wait on, on its first run and its second. When one grows, say why in the PR.

Test behavior that can break, such as delivery into each tool, layer resolution, workflow runs and their failures, config and external-format parsing, and the logic a bug fix changed. Leave out tests for what types already guarantee, trivial logic, copy text, smoke runs, mock-call mirrors, and callback wiring.

Extend before you add. When an existing test or table covers the behavior, add a row or an assertion there. Write a new `it` only when no case fits.

Test at one layer: the lowest one that fails on `main`. Do not repeat the case in a wrapper test or at each call site.

Proof for a bug fix is a failing test first: the fewest that fail on `main` for that reason, in an existing case of the module's test file where one fits. Then the fix.

The Code Review Rules below carry these testing rules for the review bot, and its prompt restates them. Change all three together.

Iterate with `npm run test:e2e -- <test-file>`; run the full suite only when changing the E2E runner, shared fixtures, or test isolation ([CONTRIBUTING.md](.github/CONTRIBUTING.md#testing-guidelines)).

Do not cover the full tool × repo provider matrix below. Leave extra repo providers and tools to CI, or say so when the local environment cannot run them:

- Tools: Claude Code, Codex, CodeBuddy, OpenCode
- Repo providers: `git`, `gitlab`, `github`

## Where code lives

- `src/` - the CLI. `src/dashboard/` is the web UI `teamai dashboard` serves, and `src/workflow/` is the workflow engine and its drivers.
- `website/` - the standalone public site: its own package, with no CLI code or copied documentation, and its own build, tests and CI.
- `skills/`, `skill-data/`, `rules/`, `agents/`, `hooks/`, `workflows/`, `scorers/` - the agent resources teamai ships as its default layer. A team replaces each one by name.
- `oxlint-plugin-teamai/` - the repo's lint rules; its README lists what each one rejects.
- `scripts/` - repo tooling: documentation checks, the verify world, the context budget and the agent wait budget.

## Taste

- Complexity belongs at the tool boundary. A per-tool fact lives in that tool's `TOOLS` entry, and shared code stays tool-agnostic; `teamai/tool-facts` fails a tool list or a partial per-tool table anywhere else.
- Parse inputs at the boundary with zod. Inferred types over annotations. `any` is the enemy.
- Default to no comment. Write one only for a constraint, an external quirk, or an invariant the code can't show, in one line where you can. Don't restate names or signatures, narrate steps, record history, or explain the fix you just made; the PR carries that. `teamai/no-low-value-comments` enforces the mechanical cases.
- An agent waits on every hook and on every pull it runs. Do after the hook returns whatever the agent does not need to continue, and prove a saving in the agent wait budget's counts, never in elapsed time.

## Self review before push

Review the whole branch diff, not only the last change. For every piece of
shared state, list every reader and every writer.

## Code Review Rules

- Find implicit state machines: lifecycles whose state, transitions, or
  ownership are scattered instead of held in one place, and the illegal
  combinations they allow. Every non-terminal state needs a guaranteed exit
  (failure, cancel, timeout, restart), not just the happy path.
- Find every invariant the code relies on but does not enforce.
- The PR description must document sufficient testing. For a PR that changes
  runtime behavior (anything beyond a docs-only, tests-only, or lint-rule-only
  diff), that includes an end-to-end / real-CLI verification record, not only unit tests
  or type checks — flag such a PR that lacks one as `[P1 blocking]`. A
  docs-only, tests-only, or lint-rule-only PR (no runtime code touched) needs
  no real-CLI record; do not flag it for that. An enabled
  `teamai/*` rule plus its helper unit test requires lint and that test, not
  a new E2E file per command; do not flag it for lacking those E2Es.
  Do NOT require a full tool × repo provider matrix — one representative real-CLI
  run is enough. Missing coverage of extra repo providers (`gitlab`/`github`) or
  tools (`Codex`/`CodeBuddy`/`OpenCode`) is at most `[P3 nit]` when the author
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
- A PR that adds a tool, changes where teamai writes for a tool, or changes
  what a tool supports updates that tool's entry in `TOOLS` (`src/tools.ts`).
  A missing update is at most `[P2 non-blocking]`. A cell marked `verified`
  with no recorded run (tool version, date and command) in the PR is
  `[P3 nit]`. `unknown` is never a finding. What the locate matrix test checks
  stays out of review.
- Label every finding with an explicit severity a first-time reader can
  understand — never a bare `P1`/`P2`/`P3` code. Keep the `P` marker but spell
  out what it means inline on each finding, using the PR author's language:
  `[P1 blocking]` for issues that must be fixed before merge,
  `[P2 non-blocking]` for suggestions that do not block merge, and `[P3 nit]`
  for minor or optional polish, theoretical edge cases, and coverage deferred
  to CI. (In Chinese, `[P1 阻断]` / `[P2 非阻断]` / `[P3 可选]`.)
