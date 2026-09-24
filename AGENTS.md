# TeamAI CLI

CLI for syncing team skills, rules, docs, and env across AI coding tools. Package: [`teamai-cli`](https://www.npmjs.com/package/teamai-cli).

TypeScript, Node 20+, tsup (ESM), Vitest. Commands: `npm run build`, `npx tsc --noEmit`, `npx vitest run`, `npm run test:e2e`.

## Git

- Default branch: `main`. Worktrees and PRs based on `origin/main`.
- PR only to `Tencent/teamai-cli`. Before push, check `git log origin/main..HEAD`; rebase or cherry-pick if unrelated commits appear.
- **必须使用 Worktree**：改代码前先 `EnterWorktree`，禁止在主工作目录修改。

## Rules

- CLI user-facing output must be English. No Chinese in production code. Tests assert English output.
- Keep bilingual docs in sync (`README` / `*.zh-CN.md`, `docs/usage-guide.*`). Behavior changes must update every affected doc (including `docs/designs/`); grep old wording before opening the PR.
- **README 精简**：尽量少改动 README，保持简洁。确需改动时，所有语言版本（`README.md` 及全部 `README.*.md`，改前先 `ls README*` 确认清单）必须全部改完并保持一致。
- **`skill-data/` 与文档同等对待**：那是 agent 真正读到的内容。行为变更必须同步更新受影响的 skill（`core` / `setup` / `wiki` / `share`），并在 PR 前 grep 旧措辞。
- `skill-data/core/references/commands.md` 由 Commander 命令表生成，改动命令或 flag 后运行 `npx vitest run commands-reference -u` 重新生成。
- 部署到 agent 的只有 `skills/teamai/SKILL.md`（发现入口），保持与版本无关：新增工作流是在 `skill-data/` 下加目录 + 在 stub 里加一行，不要把内容写进 stub。
- **奥卡姆剃刀**：避免过早添加新 CLI 命令；非必要不加；优先复用或扩展现有命令与选项。

## PR 前测试

改动运行时行为的 PR（docs-only / tests-only 之外），`npm run build` 后必须用真实 CLI 对本次改动做端到端验证，不能只跑 type check / unit test；**一次代表性的 real-CLI 运行即可**，把实际通过的验证记录贴进 PR。docs-only / tests-only 的改动无需 e2e 记录。

不要求覆盖下面的完整 provider × agent 矩阵——额外 provider / agent 的覆盖交给 CI，或在本地环境不具备时说明即可：

- Agent：Claude、Codex、CodeBuddy、OpenCode
- Provider：`git`、`gitlab`、`github`

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
