# TeamAI CLI

## Project Overview

TeamAI CLI (`@tencent/teamai-cli`) — a CLI tool for syncing team skills, rules, docs, and env variables across Claude Code users.

## Tech Stack

- **Language**: TypeScript
- **Runtime**: Node.js 20+
- **Build**: tsup (ESM output)
- **Test**: Vitest
- **Package Registry**: tnpm (http://r.tnpm.oa.com)
- **CI**: Coding CI (`.coding-ci.yaml`)
- **Git Hosting**: TGit (git.woa.com)

## Common Commands

```bash
npm run build          # Build with tsup
npx tsc --noEmit       # Type check
npx vitest run         # Run unit tests
npx vitest run --coverage  # Run tests with coverage
```

## Release Process

Publish is triggered by **tag push** via CI pipeline (not by pushing to master).

```bash
# 1. Bump version (auto: modify package.json + git commit + git tag)
npm version patch      # bug fix / small change
npm version minor      # new feature, backward compatible
npm version major      # breaking change

# 2. Push code and tag together — CI auto-publishes to tnpm
git push origin master --tags
```

CI pipeline stages: validate (lint + test) -> build -> e2e -> publish (tag builds only).
