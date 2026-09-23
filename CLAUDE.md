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
- **奥卡姆剃刀**：避免过早添加新 CLI 命令；非必要不加；优先复用或扩展现有命令与选项。

## PR 前测试

`npm run build` 后用真实 CLI 对本次改动做完整端到端验证（不能只跑 type check / unit test）。Test Plan 每一项必须实际通过，测试报告贴进 PR。

- Agent：Claude、Codex、CodeBuddy、OpenCode
- Provider：`git`、`gitlab`、`github`
