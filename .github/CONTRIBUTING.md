# Contributing to TeamAI CLI

Thanks for your interest in improving TeamAI! This document explains how to get a dev environment running, how to structure changes, and how to get your PR merged.

## Development Setup

Fork [`Tencent/teamai-cli`](https://github.com/Tencent/teamai-cli), then clone your fork:

```bash
git clone https://github.com/<your-user>/teamai-cli.git
cd teamai-cli
git remote add upstream https://github.com/Tencent/teamai-cli.git
npm install
```

### Common commands

```bash
npm run build          # Build with tsup → dist/
npx tsc --noEmit       # Type check
npm run lint           # oxlint; CI fails on any warning
npx vitest run         # Run unit tests
npx vitest run --coverage
npm run test:e2e       # Build and run E2E tests; remote cases require credentials
```

`npm run lint` needs Node ^20.19 or >=22.12 (oxlint's requirement); the CLI itself still supports Node 20.

### Running your local build

```bash
npm run build && npm link
teamai --version
```

### Dogfood against a public team repo

All contributors should exercise pull, hooks, and recall while developing the CLI. Create a **regular** (not template) public team repo under [teamai-hub](https://github.com/teamai-hub), e.g. `https://github.com/teamai-hub/teamai-cli-dev`, with `main` branch protection (PR + review). Put only public-safe skills / rules / docs there.

In the **CLI clone** (not as `teamai init .`):

```bash
npm run build && npm link
teamai init https://github.com/teamai-hub/teamai-cli-dev --scope workspace --role dev
teamai pull
git status   # nothing under .teamai/ or tool dirs should be staged for this repo
```

Pitfalls:

- Init the **canonical hub URL**, not a personal fork. `teamai init <url>` treats that URL as the team repo; a fork diverges immediately, and GitHub push/PR today targets the configured remote (no fork-to-upstream flow).
- Do **not** run `teamai init .`. That is single-repo mode: it turns the CLI source tree into the team repo and writes scaffolding at the repo root (easy to commit by mistake).
- A member-registration warning is **expected** without write access. It names the failure reason, or says another write holds `teamai-reports`. Local config is still saved and `teamai pull` still works. Fix the cause or wait for the other write, then re-run the same `teamai init` command to retry registration.

#### Write access and team stats

`digest` / `dashboard` read `stats/`, `sessions/`, and `members/` from the team repo. Those files are written via git, so **no write ⇒ not in team stats**.

Giving every internet contributor write on the hub repo is not acceptable.

| Who | Hub repo access | Required setup | In team digest |
|-----|-----------------|----------------|----------------|
| Contributors | read | `init` + `pull` | no |
| Collaborators (after a few PRs) | write, `main` protected | full, including reports | yes |

## Project Layout

```
src/
  providers/         # git hosting provider abstraction
    github/          # GitHub (gh CLI or GITHUB_TOKEN)
    gitlab/          # GitLab (GITLAB_TOKEN)
    gitcode/         # GitCode (GITCODE_TOKEN)
    cnb/             # CNB (cnb CLI or CNB_TOKEN)
    tgit/            # Tencent TGit (gf CLI)
    git/             # any Git host, no platform API
  resources/         # per-resource-type handlers (skills, rules, docs, env, ...)
  utils/             # shared helpers (git, fs, logger, prompt, ...)
  *.ts               # top-level command entry points (init, push, pull, ...)
```

See [docs/dev/adding-a-provider.md](../docs/dev/adding-a-provider.md) for how to add a new git provider.

Before you change `src/session-flow/`, read [docs/dev/agent-sessions.md](../docs/dev/agent-sessions.md). It lists the rules that span more than one file.

Before you change `src/workflow/`, read [docs/dev/workflow-engine.md](../docs/dev/workflow-engine.md). It lists the rules that span more than one file.

## Making a Change

1. Update from `upstream/main`, then create a feature branch. Prefer a git worktree for code changes when practical.
2. Write tests for your change (we target 80%+ coverage).
3. Run `npx vitest run`, `npx tsc --noEmit` and `npm run lint` — all must pass.
4. Use conventional commits where possible: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`.
5. Push the branch to your fork and open a PR against `Tencent/teamai-cli:main`. Describe the problem, the fix, and anything reviewers should pay attention to.

Your PR also gets an informational `Code Erosion` report (SlopCodeBench verbosity/erosion metrics) posted as a comment — it never blocks the merge and is just there to flag creeping complexity. See [docs/dev/ci-code-erosion.md](../docs/dev/ci-code-erosion.md).

## Coding Style

- TypeScript strict mode is on; avoid `any` unless genuinely needed.
- Prefer async/await over callbacks.
- Keep commands in `src/*.ts` thin — heavy lifting lives in `src/resources/` or `src/utils/`.
- Avoid narrating comments ("// increment counter"). Comments should explain _why_, not _what_.

## Testing Guidelines

- Unit tests go in `src/__tests__/`. Mirror the source file name (`init.ts` → `init.test.ts`).
- Mock external I/O (git, fetch, child_process) at the module boundary.
- Avoid relying on real network access unless guarded by an env variable (like `TEAMAI_TEST_TOKEN`).

Iterate on the affected E2E files; run the full suite when changing the E2E runner, shared fixtures, or test isolation:

```bash
npm run test:e2e -- <test-file> [-t "<test-name>"]   # add --maxWorkers=2 on constrained machines
```

The runner first rejects `TMPDIR` (or `TMP` / `TEMP` on Windows) inside any Git checkout, including a linked worktree or a symlink into one. Set all three to a directory outside your checkouts before testing. This prevents fixtures without their own `.git` from delivering files into the contributor's repository.

Workers share the prepared `dist/` and OpenCode binary: never rebuild or reinstall them inside a test. Cases needing remote credentials skip without them ([CI E2E setup](../docs/dev/ci-e2e-setup.md)). PRs changing runtime behavior (not docs- or tests-only) include one real-CLI verification, such as a focused E2E run, with its command and result.

### When a test fails only on CI

Find the failed cases, from the first attempt when a rerun passed:

```bash
gh run view <run-id> --attempt 1 --log-failed | grep -E '×|Test timed out'
```

The duration on the `×` line tells you what kind of failure it is:

| The `×` line | What happened | What to do |
|---|---|---|
| `× … does not publish conflict markers a prompt left in an agent file 684ms`<br>`→ expected undefined to match object { code: 'merge_conflict' }` | It ended early, with the wrong outcome: a race. Its passing neighbours took 1.5 s. | Find the race. More time changes nothing. |
| `× … stops setup when the lease passes its timeout at max_parallel 1, … 12994ms`<br>`→ setup did not start` | A timeout inside the test ran out before the slow work it waits for. | Give that timeout room, not the case. |
| `× … continues the plan's session with every turn a step added on either machine, … 15197ms`<br>`→ Test timed out in 15000ms.` | The case ran out of budget on a slow runner. | Give it a budget only if it waits on real processes, and say so. |

**A race: let the failure say why, then make it fail every run.** First put the state in the assertion message, so the next CI failure names the cause (#1526):

```ts
expect(join && 'failure' in join ? join.failure : undefined, JSON.stringify(typeof run === 'object' ? run.steps : null))
  .toMatchObject({ code: 'merge_conflict' });
```

That message showed `fatal: failed to read .git/worktrees/<id>/commondir`: two steps ran `git worktree add` at once. Then widen the window with a fake binary first on `PATH`, so a test fails on every run until the cause is fixed. The case "opens a worktree for each of two steps that start at once, while git still writes the first one" in `workflow-workspace.test.ts` uses a `git` that leaves a worktree entry half written for half a second.

**A timeout inside the test: slow down what comes before it.** The setup case gave its step `timeout: 1s`, which counts from the lease, and the lease makes the worktree first. This `git` makes that worktree as slow as a loaded runner does, and the case fails on every run, as it did on CI:

```bash
#!/bin/sh
case " $* " in *" worktree add "*) sleep 1.5;; esac
exec /usr/bin/git "$@"
```

**A case that runs out of budget.** Tests and hooks get 15 s (`vitest.config.ts`). A case that waits on real work, such as real git across machines, can take its own budget, with a comment saying what it waits on:

```ts
// Two members, a worktree each and a publish and a claim between them: real git,
// which a loaded runner takes far longer over.
it('continues a copy it took back from the commit the other machine recorded, fast-forwarding its own branch', { timeout: 120_000 }, async () => {
```

**When you cannot make it fail every run,** run it many times at once, as a runner runs its shards:

```bash
for i in $(seq 12); do
  npx vitest run src/__tests__/workflow-workspace.test.ts -t "left in an agent file" > "/tmp/run-$i.log" 2>&1 &
done; wait
grep -lE "Tests +[0-9]+ failed" /tmp/run-*.log
```

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
