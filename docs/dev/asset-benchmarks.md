# Compare team assets on fixed tasks

`scripts/benchmark-assets.mjs` is a developer harness over the existing built
`teamai pull` CLI. It compares two team revisions, or a revision against `none`,
without adding a CLI command or depending on the proposed benchmark workflow
schema in #1379.

Build first, then run:

```sh
npm run build
node scripts/benchmark-assets.mjs /path/to/suite.json /path/to/report.json
```

The suite is JSON. Repository paths are relative to the suite directory; Git
URLs also work. Refs resolve once to commit SHAs before any trial starts.

```json
{
  "codeRepo": "./task-repo",
  "codeRef": "broken-task",
  "teamRepo": "./team-assets",
  "before": "main",
  "after": "candidate-skill",
  "tool": "claude",
  "run": ["claude", "--print"],
  "repetitions": 3,
  "timeoutMs": 600000,
  "tasks": [
    {
      "id": "expired-token",
      "prompt": "Reject expired refresh tokens. Fix the implementation.",
      "check": ["{node}", "{suite}/checks/expired-token.mjs"]
    }
  ]
}
```

`tool` selects delivery for `claude`, `codex`, `opencode`, or `codebuddy`. `run`
is the same argv array for both arms. It receives the task prompt on stdin and
runs in the trial's workspace. Authenticate the runner through its environment
or a wrapper: its HOME and tool config roots are empty for every trial. On
Windows, use a native executable or an explicit wrapper for a `.cmd` launcher.
Commands are never implicitly passed through a shell.

`setup`, when present, is an argv array run in each fresh workspace before the
baseline check or asset delivery. Use it for installing the task's dependencies.
All command arrays expand `{node}` to this Node executable, `{suite}` to the
suite directory, and `{workspace}` to the trial checkout. The code revision must
not already contain a `.teamai/config.yaml`.

For a team with role or project namespaces, set optional `role` (a role ID)
and `projects` (an array of project IDs). The same selection applies to both arms.

Every task's check must run and fail at `codeRef` before an agent runs. Check
files can stay outside the workspace, as in the example, so they are not part
of the task checkout. This is process and directory isolation, not an agent
security sandbox. Run only assets and commands you intend to execute.

Each trial gets its own code clone, team clone, HOME, XDG directories and tool
config roots. The code clone has no origin. Pull is silent and usage reporting
is disabled; any Git writes go to a disposable local mirror. `none` skips TeamAI delivery; any
instructions committed in the task repo remain the same in both arms.

Before/after order alternates by repetition. Each command has `timeoutMs` to
finish; a timeout stops its process tree. A failed runner, timeout or checker
that cannot start is an error, separate from a check that ran and failed.

Runners can optionally write a JSON file at `TEAMAI_BENCHMARK_RESULT`:

```json
{ "tokens": 1234, "costUsd": 0.02 }
```

Use the runner's measured totals. Missing usage stays `null`/`unknown`; it is
never inferred as zero. Cost per successful task includes failed attempts and
is unknown unless every trial in the arm reports cost. Token/cost values must
be finite and nonnegative.

The JSON report includes fixed commits, the suite SHA-256, runner argv, baseline results, every trial, arm
totals, and changes paired by task and repetition. A companion
`report.json.md` lists improvements, regressions and inconclusive pairs. Reports
are saved after each trial. Planned and not-run counts remain visible if a run
stops early. The script exits 1 for setup/run errors, while a
completed comparison may contain genuine task failures. Results establish
behavior only for these tasks, runner and machine; use repeated real tasks
before deciding whether to adopt an asset change.

Verification:

```sh
node --test scripts/benchmark-assets.test.mjs
npm run test:e2e -- asset-benchmark
```

The E2E runner is deterministic: it proves version isolation, CLI delivery,
pairing, usage accounting and failure handling. It does not measure a model's
ability to follow the delivered assets.
