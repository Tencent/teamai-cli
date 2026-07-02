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

## Workflow Rules

- **必须使用 Worktree**：每次需要修改代码前，必须先通过 `EnterWorktree` 进入一个隔离的 git worktree 进行开发，禁止直接在主工作目录修改代码。
