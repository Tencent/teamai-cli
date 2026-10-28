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

## Take the runs members offer

A runner job finishes a run a member started and published, instead of starting its own. The guide has the job to copy: [Take offered runs from CI](https://github.com/Tencent/teamai-cli/blob/main/docs/guide/workflow.md#take-offered-runs-from-ci). Its steps, in order:

1. `git config user.name` set to the runner's member name. List that name in `.teamai/manifest/members.yaml` when the team assigns roles, or in `manifest/members.yaml` of a separate team repo.
2. `teamai init . --provider git`, then `teamai pull`. In self mode the job's own token reaches the team repo too. A separate team repo needs a credential that can push to it, such as a deploy key, never a personal token.
3. `teamai workflow resume --next --tools default=<tool> --auto-approve`. It takes the oldest offered run of this repository that a runner can finish, or prints `{"data":{"idle":{"offered":N}}}` and exits 0. It leaves a run whose steps left need an env key the job does not set or a tool it does not install; `teamai workflow resume --tools default=<tool>` lists each as `cannot run here`, with what gives it.
4. `teamai score --drain` with `if: always()`, last.

The token needs `contents: write` and `pull-requests: write`. The job exports it as `GH_TOKEN`, since `deliver: pr` opens pull requests with it, and exports the API key of the tool `--tools` names, such as `ANTHROPIC_API_KEY`, and each `requires.env` key of the workflows it should take, such as `SIGNING_KEY`. It sets `TEAMAI_MODE=unattended` when the scheduler sets no `CI`. Pin a `teamai-cli` version whose `teamai workflow resume --help` lists `--next`.

Done when `teamai workflow resume` on the runner's checkout lists the offered run, and the job's log reads `Claimed <run> (<workflow>) from <member>`.
