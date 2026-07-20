# TeamAI CLI

## Project Overview

TeamAI CLI — a CLI tool for syncing team skills, rules, docs, and env variables across AI coding tools (Claude Code, Cursor, Codex, CodeBuddy).

Published as two packages with identical code:

- **Public**: `teamai-cli` on [npmjs.org](https://www.npmjs.com/package/teamai-cli) — for open-source users
- **Internal mirror**: `@tencent/teamai-cli` on tnpm — for Tencent internal teams

## Tech Stack

- **Language**: TypeScript
- **Runtime**: Node.js 20+
- **Build**: tsup (ESM output)
- **Test**: Vitest
- **Package Registry**: public npm + tnpm mirror (see publish process below)
- **CI**: GitHub Actions (`.github/workflows/`) + Coding CI (`.coding-ci.yaml`) for internal tnpm
- **Git Hosting**: GitHub (primary) + TGit (`git.woa.com`) via provider abstraction

## Common Commands

```bash
npm run build          # Build with tsup
npx tsc --noEmit       # Type check
npx vitest run         # Run unit tests
npx vitest run --coverage  # Run tests with coverage
```

## Release Process

Publish is triggered by **tag push**. Two pipelines run in parallel:

- **GitHub Actions** (`.github/workflows/release.yml`): publishes `teamai-cli` to public npm
- **Coding CI** (`.coding-ci.yaml`): renames to `@tencent/teamai-cli` at build time and publishes to tnpm

```bash
# 1. Bump version (auto: modify package.json + git commit + git tag)
npm version patch      # bug fix / small change
npm version minor      # new feature, backward compatible
npm version major      # breaking change

# 2. Push code and tag together — CI auto-publishes both packages
git push origin main --tags
```

CI stages: validate (lint + test) -> build -> e2e -> publish (tag builds only).

## Git Conventions

- **Default branch**: `main` (not `master`). All worktrees and PRs should be based on `origin/main`.
- **PR target**: Always submit PRs to `Tencent/teamai-cli` (the upstream). Never push PRs to personal forks (`hsuchifeng`, `jeff-r2026`, etc.) unless explicitly told.
- **Clean PRs**: Before pushing, verify commit scope with `git log origin/main..HEAD`. If unrelated commits appear, rebase or cherry-pick onto a fresh branch from `origin/main`.

## Output Language

All CLI user-facing output must be in **English**. No Chinese strings in production code. Test assertions should match English output.

## Documentation

- **Bilingual docs stay in sync**: docs are paired as an English main version plus a `*.zh-CN.md` Chinese version (e.g. `README.md` / `README.zh-CN.md`, `docs/usage-guide.md` / `docs/usage-guide.zh-CN.md`). When you edit one language, update the other in the same change so they never drift.
- **Large changes must update all affected docs**: when a change alters observable behavior, a mechanism, a threshold, a command, or a workflow, update every doc that describes it — README (both languages), `docs/usage-guide.*`, and any design docs under `docs/designs/`. Grep for the old behavior/wording before opening the PR to confirm nothing stale remains. A behavior change whose docs still describe the old behavior is an incomplete PR.

## Workflow Rules

- **必须使用 Worktree**：每次需要修改代码前，必须先通过 `EnterWorktree` 进入一个隔离的 git worktree 进行开发，禁止直接在主工作目录修改代码。
- **功能必须实测**：每次完成功能开发后，必须 `npm run build` 并用真实 CLI 执行端到端功能验证（不能只跑 type check 和 unit test）。PR 的 Test Plan 中列出的每一项都必须实际执行通过后才能提交。
