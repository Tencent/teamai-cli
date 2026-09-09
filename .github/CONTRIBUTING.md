# Contributing to TeamAI CLI

Thanks for your interest in improving TeamAI! This document explains how to get a dev environment running, how to structure changes, and how to get your PR merged.

## Development Setup

```bash
git clone https://github.com/Tencent/teamai-cli.git
cd teamai-cli
npm install
```

### Common commands

```bash
npm run build          # Build with tsup → dist/
npx tsc --noEmit       # Type check
npx vitest run         # Run unit tests
npx vitest run --coverage
npm run test:e2e       # E2E tests (optional, requires a live test repo)
```

### Running your local build

```bash
npm link
teamai --version
```

## Project Layout

```
src/
  providers/         # git hosting provider abstraction
    github/          # GitHub (gh CLI or GITHUB_TOKEN)
    tgit/            # Tencent TGit (gf CLI)
  resources/         # per-resource-type handlers (skills, rules, docs, env, ...)
  utils/             # shared helpers (git, fs, logger, prompt, ...)
  *.ts               # top-level command entry points (init, push, pull, ...)
```

See [docs/providers.md](../docs/providers.md) for how to add a new git provider.

## Making a Change

1. Fork the repo and create a feature branch from `main`.
2. Write tests for your change (we target 80%+ coverage).
3. Run `npx vitest run` and `npx tsc --noEmit` — both must pass.
4. Use conventional commits where possible: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`.
5. Open a PR with a clear description: what's the problem, what's the fix, anything reviewers should pay attention to.

## Coding Style

- TypeScript strict mode is on; avoid `any` unless genuinely needed.
- Prefer async/await over callbacks.
- Keep commands in `src/*.ts` thin — heavy lifting lives in `src/resources/` or `src/utils/`.
- Avoid narrating comments ("// increment counter"). Comments should explain _why_, not _what_.

## Testing Guidelines

- Unit tests go in `src/__tests__/`. Mirror the source file name (`init.ts` → `init.test.ts`).
- Mock external I/O (git, fetch, child_process) at the module boundary.
- Avoid relying on real network access unless guarded by an env variable (like `TEAMAI_TEST_TOKEN`).

## Bug Reports & Feature Requests

Please file issues at [github.com/Tencent/teamai-cli/issues](https://github.com/Tencent/teamai-cli/issues). Include:

- What you tried to do
- What happened (error output, stack trace)
- What you expected
- Your OS, Node.js version, and `teamai --version`

## Security

For security issues, please do **not** open a public issue. Email the maintainers or use GitHub's private vulnerability reporting.

## License

By contributing, you agree your contribution will be licensed under the [MIT License](../LICENSE).
