# Start a run from CI

The guide has the GitHub Actions job to copy: [Start from CI](https://github.com/Tencent/teamai-cli/blob/main/docs/guide/workflow.md#start-from-ci). It checks out a named branch, runs `teamai init` and `teamai pull`, then `teamai workflow start <name> --driver local`.

Two settings in that job decide whether the run works:

1. **The teamai version.** teamai before 0.28.0 drops a workflow that sets `invoke` or `alias`, so the job finds nothing to run. Pin `teamai-cli` at 0.28.0 or later.
2. **The token.** It reads the team repo, pushes branches to the product repo, and opens pull requests there, which a `deliver: pr` step needs. The default GitHub Actions token cannot read another repository.

A CI job sets `CI`, which makes the run unattended, and every process of its steps gets `TEAMAI_MODE=unattended`. A scheduler that sets no `CI`, such as cron, makes the run unattended itself:

```yaml
env: { TEAMAI_MODE: unattended }
```

Done when the job pins that version and its token has those three permissions.
