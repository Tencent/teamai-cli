# Workflows

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

A workflow is a YAML file at `workflows/<name>.yaml` in the team repo. It runs command and prompt steps, each after the steps it needs. A command with no workspace is read-only; [Workspaces](#workspaces) is how a step changes code on its own branch. [Advanced workflows](workflow-advanced.md) covers parallel steps, loops, `for_each`, what an end does to steps that still run, and the full expression language.

```yaml
schemaVersion: v1alpha1
name: build
description: Compile the project, then run its tests.
steps:
  - id: compile
    command: npm run build
  - id: test
    needs: [compile]
    command: npm test
    output:
      ok: boolean
  - id: review
    needs: []
    prompt_file: prompts/review.md
    agent: reviewer
```

`schemaVersion` must be `v1alpha1`. `name` must match the file name. `description` is required. Each step has a unique `id` and exactly one action: `command`, `prompt`, `prompt_file`, or `workflow`. A step can omit the action when it has `end`, `approve`, or `choose`. `agent` is optional on prompt steps. `output` uses the existing shorthand: `string`, `number`, `boolean`, a literal union, an object, or an array with one item type. TeamAI validates successful command stdout or a prompt tool's `output` against it.

Local command steps read stdout and stderr as UTF-8. Non-ASCII JSON string values are preserved in stored outputs and when later steps read them.

A prompt step can set `model`: an alias from `models/aliases.yaml` or a model name, without spaces or templates. `defaults: { model: fast }` at the top of a file sets one for its prompt steps. A prompt step runs on the first of these that is set:

1. the step's `model`;
2. the model its agent's definition sets for the tool;
3. `defaults.model`;
4. the tool's default model.

A step's `model` replaces the agent's model and effort, and keeps its other settings. A model name that is not an alias runs at the tool's default effort. A workflow file that another runs uses its own `defaults.model`, else the one in effect for the step that runs it. An inline workflow uses the enclosing one. When the alias has no model for the step's tool, or the member's `~/.teamai/models/aliases.yaml` turns it off, the step fails with `model_unavailable` before the tool starts. On OpenCode 1, so does a step whose `model` is its agent's own model with no effort while the agent file sets `variant` and a `mode` other than `subagent`, since OpenCode 1 would apply that variant. OpenCode 2 does not take the model or variant from the agent file, and OpenCode 1 does not start a subagent with `opencode run --agent`, so the driver passes the definition's own model and variant on the command line. For an agent file with `mode: subagent`, which pull writes by default, OpenCode 1 gets the agent's instructions in the prompt, and the driver warns about the file settings that then do not apply. A lease carries `model` and `defaultModel` as written, and the driver resolves them.

A prompt or workflow step can list [scorers](scorers.md) that judge its succeeded passes:

```yaml
schemaVersion: v1alpha1
name: ship
description: Implement the change, then review it.
defaults:
  scorers: { batch: true }
steps:
  - id: implement
    prompt: Implement the change.
    scorers: [review-quality]
  - id: review
    needs: [implement]
    prompt: Review the change.
    scorers: { names: [review-quality], batch: false }
```

Every step after the first lists the steps it waits for in `needs`. `needs: []` starts another branch with no dependency. Each `next` leases the first step in the file whose needs are done. `--driver local` runs one step at a time unless `workflows.max_parallel` is above 1. A step is skipped when a step it needs failed, or when every step it needs was skipped. A skipped step never runs. A failure does not stop other branches. When nothing is left to run, the run ends `failed` if any step failed, otherwise `succeeded`. A missing `needs`, a `needs` id that is not a step, or a cycle makes the file invalid. A missing `needs` also leaves the workflow with nothing to run, even when an older version was valid.

A step can carry an `if` expression. When it is false, the step is skipped, and that does not fail the run. An expression reads `steps.<id>.outcome` (`success`, `failed`, or `skipped`) and `steps.<id>.outputs.<field>`, only for steps it needs, directly or through their needs. It has `==`, `!=`, `<`, `<=`, `>`, `>=`, `&&`, `||`, `!`, parentheses, and the literals `'text'`, numbers, `true`, `false`, `null`, and `[]`. A path can index an array, as in `steps.review.outputs.files[0]`. The functions `length`, `any`, `all`, and `filter` read arrays. A missing value reads as `null`. `false`, `null`, `0`, and `''` are false; everything else is true. `==` is strict and compares whole values: `'1' == 1` and `'Build' == 'build'` are false.

A step whose dependency failed still runs when its `if` reads every failed dependency. Use this to recover:

```yaml
  - id: label
    needs: [check]
    if: steps.check.outcome == 'failed'
    command: gh issue edit 42 --add-label needs-human
```

The run still ends `failed` unless it reaches an end. An `if` that does not parse, reads a step it does not need, or reads a field missing from that step's `output` makes the file invalid. So does an `if` that is always false, and then the workflow has nothing to run, even when an older version was valid.

`teamai pull` and `teamai push` check each file, and check a step that runs another workflow against that workflow's runnable version. A `prompt_file` must be a regular, non-symlink file under `prompts/` in the team repo. Its text is cached with the validated workflow, so an existing run keeps that revision even if the source is later changed or deleted. A file that was valid before keeps that version in the local cache when a new revision is invalid, as long as that version still fits the workflows it runs. A field this version of teamai does not know is different: that workflow has nothing to run until teamai is updated.

`teamai review --branch <name>` checks that branch with the same rules. It exits 1 when any workflow file is invalid, or when a step's `model` or `defaults.model` is an alias the branch's `models/aliases.yaml` maps for no tool. It writes nothing and does not run the workflow. This file fails the check:

```yaml
schemaVersion: v1alpha1
name: deploy
description: Ship the release candidate.
steps:
  - id: release
    needs: [biuld]
    command: echo release
```

```text
teamai review --branch feature/deploy
[review] branch feature/deploy: 1 fail, 0 warn, 0 info
  ✖ [workflows] workflows/deploy.yaml:6: field "steps[0].needs": step "release" needs "biuld", which is not a step in this workflow
```

Gate that branch from CI with one step:

```yaml
- run: teamai review --branch feature/deploy
```

A workflow can declare named `ends`, each `succeeded` or `failed`, such as `ends: { dropped: succeeded, stuck: failed }`. A step with `end: <name>` finishes the workflow when it succeeds. A step with only `id`, `needs`, `if`, and `end` runs nothing: it ends the workflow as soon as its needs are done. When an end is reached, every step that has not run is skipped, and the run takes that end's outcome, even if another step failed. `done` then carries the end: `{"done":{"run":"<run>","outcome":"succeeded","end":"dropped"}}`. An `end` that is not in `ends`, an `end` without `ends`, a declared end that no step uses, or a step that needs a step that only ends the workflow makes the file invalid.

A workflow can declare `inputs` with the same shorthand as `output`, such as `inputs: { issue: number, title: string }`. Every input is required. Pass them as a JSON object: `teamai workflow start fix --driver local --inputs '{"issue":42,"title":"Crash"}'`. A missing, extra, or mistyped input returns `invalid_inputs` naming the field, and no run is created. An `if` can read `inputs.<name>`.

`{{ inputs.<name> }}` and `{{ steps.<id>.outputs.<field> }}` (or `.outcome`) fill in a `prompt`, the text of a `prompt_file`, and `env` values when the step starts. A template can also evaluate an expression as an `if` does, such as `{{ length(steps.review.outputs.files) }}`. Other `{{ ... }}` text, such as `${{ secrets.TOKEN }}`, stays as written. So does any `{{` right after a `$`, such as `${{ inputs.version }}` in a prompt about GitHub Actions. To put a value right after a `$`, add a space: `$ {{ inputs.price }}`. Strings appear as they are, numbers and booleans as text, objects and arrays as JSON, and `null` or a missing value as empty text. A template reads only what an `if` on that step could read.

A `command` is never filled in. Pass values to it through `env`, which only a command step can have:

```yaml
  - id: label
    needs: [plan]
    command: gh issue edit "$ISSUE" --title "$TITLE"
    env:
      ISSUE: "{{ inputs.issue }}"
      TITLE: "{{ steps.plan.outputs.title }}"
```

The command gets these variables on top of its usual environment, so a value such as `$(touch pwned)` stays plain text. Names must match `^[A-Za-z_][A-Za-z0-9_]*$`. A YAML number or boolean is passed as its text. A template inside `command`, `env` on a prompt step, or an `if` or template that reads an input the workflow does not declare makes the file invalid. A template that does not parse or reads something it may not read also leaves the workflow with nothing to run, even when an older version was valid. So does a `.` in a step id or a field name.

A step can run another workflow from `workflows/` with `workflow: <name>` and pass that workflow's inputs with `with`:

```yaml
  - id: check
    needs: [plan]
    workflow: check-issue
    with:
      issue: "{{ inputs.issue }}"
      task: "{{ steps.plan.outputs.task }}"
```

Every string in `with`, at any depth, is a template. A string that is exactly one template keeps its JSON type, so `task` gets the object itself; any other string is text. When the step is ready, the values are checked against the child's `inputs`, and a mismatch fails the step with `invalid_inputs`. The child sees only its own inputs and steps. Its steps run in place of the step and are leased by their path, such as `check.classify`. The step takes the child's outcome. An `end` inside the child finishes only the child, and the parent reads it as `steps.<id>.end`. A child returns values with `outputs`, each a path to one of its steps, such as `outputs: { verdict: steps.classify.outputs.verdict }`, and the parent reads `steps.<id>.outputs.verdict`. A step that runs a workflow cannot have `output`, `agent`, `model`, or `env`.

A `prompt` or `prompt_file` step can have `with` too, so several workflows can share one prompt file. Its values follow the same rules, and the prompt reads them as `{{ with.<name> }}`, such as `Fix {{ with.task }}`. `{{ with.<name> }}` is valid only in the prompt of a step whose `with` has that name. A command step cannot have `with`; it uses `env`.

`workflow: <name>` is looked up by name in the validated cache that `teamai pull` writes, not in the files. `workflow start` takes every workflow the run uses from that cache and keeps them in the run, so a later pull does not change a run in progress. A child with no runnable version, or workflows that run each other in a cycle, stop `start` with an error that names them. `teamai pull` reports the same problems on the parent's step, along with `with` keys that do not match the child's `inputs` and a read of an output or end the child does not declare; such a read also leaves the parent with nothing to run.

A step can also write the workflow it runs in place, to treat a group of steps as one step:

```yaml
  - id: check
    needs: [plan]
    workflow:
      ends: { dropped: succeeded }
      outputs: { verdict: steps.classify.outputs.verdict }
      steps:
        - id: classify
          prompt: "Classify {{ inputs.title }} for {{ steps.plan.outputs.task }}."
          output: { verdict: fix | drop }
        - id: drop
          needs: [classify]
          if: steps.classify.outputs.verdict == 'drop'
          end: dropped
```

An inline workflow has `steps` and optional `ends` and `outputs`, which work as in a file. It has no `inputs` and its step has no `with`: its steps read the enclosing workflow's inputs and the steps the enclosing step needs, directly or through their needs. A step inside it with the same id as an outer step hides that step. Its steps are leased by path, such as `check.classify`, and an `end` inside it finishes only the inline workflow. An inline workflow can run a workflow file or contain another inline workflow.

Choose headless tools for this machine in `~/.teamai/config.yaml`, or for one workspace in its own `config.yaml` (see [Member settings](./reference.md#member-settings)):

```yaml
workflows:
  tools:
    default: claude
    implementer: codex
```

An agent-specific entry wins over `default`. `claude`, `claude-internal`, `tclaude`, `codex`, `codex-internal`, `tcodex`, `opencode`, `codebuddy`, and `workbuddy` are supported. For CI, override this selection for one start with `--tools default=claude,implementer=codex`. A step with no entry of its own runs on `TEAMAI_AI_TOOL`, then `default`, then [`ai.tool`](./reference.md#ai-tool-aitool) in the run's workspace config, then in `~/.teamai/config.yaml`. When `TEAMAI_AI_TOOL` or `ai.tool` names a tool that cannot run steps, the step skips it with a warning; a name teamai does not launch at all fails the step with `tool_unsupported`. A named agent is read from the file `teamai pull` already deployed for the selected tool, in that tool's directory for this scope.

```text
teamai workflow start build --driver local
```

`--driver local` runs a step with no `workspace` in the current checkout, unless an enclosing step opened a workspace. A command there is read-only: if it exits 0 and changed repository files, their permissions, a symlink target, the destination of a staged rename, a file inside a dirty submodule, the index, or HEAD, the step fails and leaves that change in place. This includes a change inside an existing untracked directory; leaving that directory unchanged does not fail the step. A step with `workspace: new` changes files on its own branch. See [Workspaces](#workspaces). Steps that share the current checkout run one at a time. Steps in different worktrees run together up to [`workflows.max_parallel`](workflow-advanced.md#run-local-commands-in-parallel). Each attempt uses `result.json` under the scope's TeamAI data directory, outside the checkout. The driver calls the same `next` and `report` operations shown below:

```text
teamai workflow start build
teamai workflow next <run> --json '{"driver":{"kind":"local","machine":"host","workspace":"/work"}}'
teamai workflow report <run> --json '{"attempt":"<attempt>","revision":1,"outcome":"success","driver":{"kind":"local","machine":"host","workspace":"/work"}}'
```

`outcome` is `success`, `failed`, or `released`. `released` puts the step back to pending. It does not use up a retry. A report for an attempt that was already settled returns `repeated_report`, even when the revision is old. The run keeps recent settled attempts for that check. An older attempt uses the other checks: an old revision returns `stale_revision`, and a current revision that is not the leased attempt returns `wrong_attempt`. Another driver returns `wrong_driver`. `changes` whose `branch` or `base` differs from the lease returns `invalid_report`, and the step stays leased. A read-only step in a workspace reports `read` (`branch`, `base`, and the `commit` it read) in place of `changes`. `changes` from it, a success without `read`, `read` from any other step, or `read` that differs from the lease returns `invalid_report` too. `used` (`{"skills":["review-notes"]}`) names the team skills the pass loaded, for its [scorer labels](scorers.md#any-driver). A value that is not a skill name is dropped, and a `used` of another shape returns `invalid_report`. `runMode` (`attended` or `unattended`) on `next` is the [run mode](#attended-and-unattended-runs) the driver runs its leases in. The lease keeps it, so the pass and its labels keep it however the pass settles, also on a timeout or a cancel. Any other value returns `invalid_json`. A payload field the CLI does not read, such as a misspelled `tokens` written as `tokenz` or a field from a newer protocol version, is accepted but reported back: the success envelope of `next`, `report`, and `respond --json` carries `ignored` with those names — top-level fields first, then `driver.<field>` and `changes.<field>` names — names only and never values. The key is left out when nothing was ignored, and an error envelope stays as it is.

The run is stored in its owning scope's TeamAI data directory. `next`, `report`, `respond`, and the run controls find it by id across configured local scopes, including from a workflow worktree or outside the product repository. An id that two scopes hold answers `ambiguous_run`. The command exits when it finishes. A local run that ends `failed` or `cancelled` exits with status 1. No workflow process keeps running.

Use `workflow respond <run> <step> <choice>` for a waiting HITL request, `workflow retry <run> <step>` for a failed or stuck step, `workflow cancel <run> [step]` to stop work, `workflow resume <run>` to continue locally, and `workflow publish <run>` to let another machine continue it ([Continue a run on another machine](#continue-a-run-on-another-machine)). `next` answers `lease`, `hitl`, `wait`, or `done`. See [HITL](workflow-advanced.md#hitl-human-in-the-loop) and [Retry, cancel, and resume](workflow-advanced.md#retry-cancel-and-resume).

## Workspaces

A command with no `workspace` is read-only. Outside a workspace it runs in the current checkout. If it exits 0 and changed repository files, their permissions, a symlink target, the destination of a staged rename, a file inside a dirty submodule, the index, or HEAD, the step fails with `read_only_dirty` and leaves that change in place. A headless prompt with no `workspace` is read-only in the same way, unless an enclosing workflow or `for_each` opens a workspace. An interactive prompt keeps the person's edits, unless that prompt sets `workspace: read-only`. Submodule changes count even when `submodule.<name>.ignore` or `diff.ignoreSubmodules` hides them from `git status`: a read-only step that makes one fails, and a step that writes commits the submodule's new commit.

Inside a workspace an enclosing step opened, a read-only step runs in that workspace, so a test sees the change it follows. It reads the branch its `needs` changed, or the enclosing branch when they changed none. When they changed more than one branch, it fails with `workspace_base`: add a step that merges them, and need that step. It runs one at a time with the workspace's other steps, on the same base agent files, and only a driver that declares `continue` and owns that workspace takes it. It commits nothing. Afterwards the driver puts the workspace back as the step found it: if the step changed it or left its branch, what it changed is kept on `refs/teamai/kept/<attempt>`, and the submodule commits it made under `refs/teamai/kept-modules/<attempt>/`. The worktree and the submodules the step changed are then reset to the commit it read and its untracked files are removed, and an exit 0 still fails with `read_only_dirty`. Ignored files stay in place. A submodule the step changed that has uncommitted or untracked files cannot be kept, so then nothing is reset. When the workspace is not put back, the step fails with `workspace_base`. The workspace is marked when the step starts, so later steps there fail, even after the driver was killed during the step, until you put it back on its branch at that commit as the step found it and run `teamai workflow retry <run> <step>`. If the workspace already had changes when the step started, also delete the marker file the failure names. The pass records `read`: the branch, the base, and the commit it read. The workspace is a fresh worktree without ignored files such as `node_modules`, so a test installs what it needs, for example `npm ci && npm test`, unless the team's [`postDeploy`](distribution.md#team-scripts) does.

`workspace: new` runs the step in its own git worktree, on a branch named for this run, step, and pass. The step commits what it changed. A step that leaves that branch, for example with `git switch`, fails with `workspace_base`: nothing is committed or pushed, and the worktree stays as the step left it. The current checkout is not switched, reset, or cleaned. A later step that lists it in `needs` starts from the first of those branches and merges the rest, in `needs` order. A merge conflict stops there. A command fails with `merge_conflict`, and the message names the branch and the files. A prompt is told which files still conflict and which branches were not merged.

`workspace: continue` stays on the branch an enclosing `workflow` step opened with `new`. A prompt with no `workspace` continues that copy. A `for_each` with `workspace: new` gives each item its own branch, so items do not share a worktree. `steps.<id>.branches` lists those branches, and each `results` entry has `branch` when the item has one. An item with `after` starts from the branches it waits for. A top-level `workspace: continue`, with no enclosing `new`, fails the step with `workspace_base`.

The step sees the agent files from the commit the run started at: `AGENTS.md`, `CLAUDE.md`, `.agents`, `.githooks`, every tool's project directory such as `.claude` or `.tclaude`, the project MCP files `.mcp.json` and `opencode.json`, and Copilot's agent paths under `.github`. A hook an earlier step committed does not run in a later step. The team's skills, rules, agents and MCP are then delivered into the worktree, as they are for any new worktree of this checkout. Those delivered files are not part of the step's commit. A file the step itself edits is committed.

When the checkout has an `origin` and the step made commits, the driver pushes that branch, also when the step failed. A later attempt that adds no commit still pushes when this branch has commits `origin` does not have. That includes a first push that never landed, and an origin that has no branches yet. A failed push fails a step that succeeded with `push_failed` and keeps the worktree. A step that failed keeps its own failure, and its message adds that the push failed. With no `origin`, or when `origin` already has that commit, the run still succeeds and reports the branch.

`session: continue` resumes this step's previous pass with the same tool. `session: { from: <step> }` resumes a step this one needs. A different tool resumes a copy of the session. OpenCode gets the copy but always starts fresh, because it has no flag to resume a session. A step resumes a session as the last step that continued it left it, whichever tool or machine that step ran on. A step that started a new session, such as an OpenCode step, does not change what later steps resume.

A command that starts its own sandbox, such as `docker`, stays read-only. What it writes does not become a branch a later step can merge.

```yaml
schemaVersion: v1alpha1
name: change
description: Change two files on their own branches, then join them.
steps:
  - id: left
    needs: []
    workspace: new
    command: node -e "require('fs').writeFileSync('left.txt', 'L')"
  - id: right
    needs: []
    workspace: new
    command: node -e "require('fs').writeFileSync('right.txt', 'R')"
  - id: join
    needs: [left, right]
    workspace: new
    command: node -e "require('fs').writeFileSync('joined.txt', 'J')"
```

## Deliver a PR

Set `deliver: pr` on a step that writes a branch, and TeamAI opens a pull request from that branch once the step succeeds. It never merges it. A step writes a branch when it has `workspace: new` or `continue`, or when it is a prompt inside a workflow that opened one. A command that delivers must set `workspace`, since a command without one is read-only. A `workflow` step with `workspace: new` delivers its branch once, for all its steps. A step inside it that writes a branch of its own needs a later step that merges that branch through `needs`, or its own `deliver: pr`. Otherwise the delivery fails with `delivery_failed`, since the pull request would leave that work out. On a `for_each` step, each item delivers its own branch.

```yaml
schemaVersion: v1alpha1
name: ship-issue
description: Implement an issue for review.
inputs: { issue: number }
steps:
  - id: change
    workspace: new
    deliver: pr
    prompt: "Implement issue #{{ inputs.issue }}."
```

A `deliver: pr` step that would run read-only fails validation, and so does a delivering `workflow` step, `for_each` or not, when no step of its workflow writes a branch. `workflow start` refuses a run that would start from a detached HEAD, which has no branch for a pull request to go into. Check out a named branch first.

When the step succeeds, its driver has already pushed the branch, as for any writable step, and the step is `delivering`. Steps that need it wait. The next `teamai workflow next`, from whichever driver calls it, looks for an open pull request from that branch into its target, and opens one only when there is none. While another step that writes the same branch still runs, delivery waits for its report, so TeamAI checks that step's commit before the pull request is opened or taken. A run that a crash stopped finds the pull request it opened before and opens no other. So does a run another machine took over, unless the machine that handed it over is still opening one at that moment. GitHub and GitLab reject such a duplicate. TeamAI opens pull requests on GitHub, GitLab, TGit, and GitCode origins, with the login the provider's CLI or token already has, and never starts a login prompt. On any other origin, such as a generic git host or CNB, it opens none, and the step fails naming its branch.

A pull request goes into the nearest branch its own branch grew from that already delivered one, or else into the branch the run started from. A branch grows first from its `for_each` item's `after` branches, then from its `needs` in order. The first step of a sub-workflow grows from the needs of the step that runs it. A skipped step wrote no branch, so it is passed over. Each pull request then shows only the work done since the branch it goes into.

Each pass of a looped `workspace: new` step has its own `/p<pass>` branch, so it opens its own pull request. The earlier ones stay open, by design. A step that loops on one `continue` branch has one pull request.

Before it opens or accepts a pull request, TeamAI compares the delivered commit with the run's base commit. A change to CI configuration (such as `.github/workflows` or `.gitlab-ci.yml`), to hooks, to `AGENTS.md` or `CLAUDE.md` at any depth, or to any tool's agent, rule, or MCP files fails the step with `protected_path`, and the message names the files. These are the agent files a workspace step gets from the run's base, plus CI and hook paths. Deletions and renames count, and so do changes the branch got from an earlier step. `teamai workflow retry <run> <step>` then runs the step again, in a new pass. When only a later commit that another step recorded on a shared branch made the change, the step fails with `delivery_failed` instead, and the retry does not run it again. Its message says how to deliver only the step's own commit, or how to run the steps of that branch again in a new one.

Any other delivery failure fails the step with `delivery_failed`. Its message says what went wrong, names the branch the work is kept in, and gives the retry command. Fix the cause, such as the provider's credentials, then run `teamai workflow retry <run> <step>`, and run `teamai workflow resume <run>` or let your driver call `next`. The retry delivers the same branch again, without running the step again. A run cancelled while its pull request is being opened cannot take that pull request back. The run lists it, and the step stays cancelled.

If origin has no branch to deliver, TeamAI opens no request. The failure names the missing branch and the commit to push to it, then gives the retry command.

If a host may have opened the request but TeamAI cannot confirm it, the step fails with `delivery_failed` and records no URL. Run the retry command in the message. TeamAI looks for the request before opening one again.

A driver that opens its own pull request, such as one on another machine, reports it as `changes.pr_url` with the step's other `changes`. TeamAI keeps an `https` URL without credentials, of at most 512 characters, and removes its query and fragment. On the origin's own host, the URL must be the open pull request of the branch into its target, and one TeamAI cannot check with the host is dropped. Delivery then finds the open pull request itself. A URL on another host, such as a private review service, is kept as it is. A URL TeamAI does not keep is dropped, and so is one no delivery uses: from a step without `deliver: pr`, from a step that failed or was released, or for a branch with no changes beyond the run base. The report is still accepted, and its envelope lists `"dropped":[{"field":"changes.pr_url","reason":"…"}]` without the value. The branch is then delivered as for any driver.

### Start from CI

A GitHub Actions job can start a run with the local driver, and the run delivers its pull requests unattended. Store the workflow in the team repo. Give the job a token that can read the team repo, push branches to the product repo, and open pull requests there. The job below reads it from a `WORKFLOW_TOKEN` secret, and the team repo's URL from a `TEAM_REPO` variable. The runner also needs the tool that runs the prompt steps, signed in, and `--tools` picks it for this start.

```yaml
on: { issues: { types: [labeled] } }
concurrency: ship-issue-${{ github.event.issue.number }}
jobs:
  ship:
    runs-on: ubuntu-latest
    env:
      TEAM_REPO: ${{ vars.TEAM_REPO }}
      GH_TOKEN: ${{ secrets.WORKFLOW_TOKEN }}
    steps:
      - uses: actions/checkout@v5
        with: { ref: main, token: "${{ secrets.WORKFLOW_TOKEN }}" }
      - run: npx teamai-cli init "$TEAM_REPO" --scope workspace
      - run: npx teamai-cli pull
      - run: npx teamai-cli workflow start ship-issue --driver local --tools default=claude --auto-approve --inputs '{"issue":${{ github.event.issue.number }}}'
```

`--auto-approve` answers an optional `approve` request yes and an optional `choose` request with its default. Nobody can answer a required one in an unattended job, so its step fails with `hitl_required`, and so does the run. To start a run from another branch, such as one whose CI failed, check that branch out by name, for example `ref: ${{ github.head_ref }}` on a `pull_request` event. The default `pull_request` checkout is a detached merge commit, which `workflow start` refuses. TeamAI installs no trigger and does not wait for CI or a merge.

### Take offered runs from CI

A runner job finishes the runs members [hand to it](#hand-a-run-to-a-runner) instead of starting its own. In self mode, where the business repository is also the team repo (`teamai init .`), the job's own token reaches both, so it needs no personal token:

```yaml
# .github/workflows/teamai-runner.yml
on:
  workflow_dispatch:
  schedule: [{ cron: "*/15 * * * *" }]
concurrency: teamai-runner
jobs:
  run:
    runs-on: ubuntu-latest
    permissions: { contents: write, pull-requests: write }
    env:
      TEAMAI_MODE: unattended                                 # CI already sets it; a cron job on a VM needs it
      GH_TOKEN: ${{ github.token }}                           # deliver: pr opens pull requests with it
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}     # the key of the tool the prompt steps run
      SIGNING_KEY: ${{ secrets.SIGNING_KEY }}                 # each requires.env key of the runs it should take
    steps:
      - uses: actions/checkout@v5
      - run: npm install -g @anthropic-ai/claude-code         # the tool --tools names
      - run: git config --global user.name acme-runner && git config --global user.email runner@acme.example
      - run: npx teamai-cli init . --provider git && npx teamai-cli pull
      - run: npx teamai-cli workflow resume --next --tools default=claude --auto-approve
      - if: always()
        run: npx teamai-cli score --drain                     # judges and publishes what a cut-short job left
```

Each job takes at most one run; the schedule takes the next. `git config user.name` is the runner's member name: list it in [`.teamai/manifest/members.yaml`](distribution.md#assigning-roles-in-the-team-repo) when the team assigns roles (`manifest/members.yaml` in a separate team repo). A team repo separate from the business repository needs a credential that can push to it, where `teamai-reports` lives, such as a deploy key with write access set up before `teamai init <team repo URL> --provider git`.

## Continue a run on another machine

A run lives in the TeamAI data directory of the machine that started it. To continue it somewhere else, publish it, then resume it on the other machine. Use this when your tool runs out of tokens in the middle of a run, when you hand a run to a teammate, or when a CI run failed and you want to finish it on your own machine.

```text
teamai workflow publish <run>     # on the machine that has the run
teamai workflow resume <run>      # on the other machine, in a checkout of the same repository
```

`publish` writes the run's state to the team's `teamai-reports` branch and makes this install the run's owner. Stop the driver first, so no step is in flight. A step still leased when you publish runs again on the other machine. A Ctrl-C leaves what the in-flight step wrote in that step's worktree on this machine, and another machine can still claim the run. If you take the run back here while it is still running, the claim makes this install the owner, but `resume` refuses with `branch_diverged` and names the worktree. Move those changes elsewhere or remove them, then run `resume` again. On a machine that does not have the run, `resume` takes it from `teamai-reports`, makes that install the owner, and drives it with the local driver.

Only the owner continues a published run. On another install that has the run, `resume` and `publish` answer `not_owner` with the owner's user name and install id. Two installs of one member show the same user name, and the install id tells them apart. To take the run over, run `teamai workflow resume <run> --claim`. The claim replaces this machine's copy of the run and releases the leases other machines held. The previous owner can then no longer publish or resume the run, unless it claims it back.

To continue the run from a coding session, the agent runs `teamai workflow resume <run> --driver skill`, with `--claim` to take it from the owner. It claims the run the same way, then drives it with the skill driver in the session's run mode, with the options of a skill start: `--parallel`, `--hitl` or `--auto-approve`, and `--no-judge`. Without them, one step runs at a time and the agent asks you before it answers an optional gate. In an unattended run it answers optional gates as `--auto-approve` does, and refuses, before claiming it, a run whose steps left need a person (`unattended_denied`); an approval or interactive step that already ran no longer counts, unless a loop can run it again. A run that already ended needs nobody, so it is never refused for that. `--hitl person` is refused in an unattended run (`invalid_arguments`): nobody would answer. Its first turn asks the host question when the workflow has prompt steps or the session judges it, and dispatches again the steps the other machine had leased. A workflow that must run with the local driver comes back to you as `teamai workflow resume <run>`. Taking the run over is your decision, so the agent asks you before it runs either command.

When a published run ends, teamai publishes how it ended, without `--sessions`. A member who then takes the run over runs none of its steps again.

`publish` writes the run's state with [usage reporting](reporting.md) on or off: it is the state another machine needs to continue the run, not a usage report. A run you never publish stays on this machine. While usage reporting is on, only its [run records](#run-records) reach `teamai-reports`.

A step with `session: continue` or `session.from` starts a new agent session on the other machine, unless you publish with `--sessions`. When a run goes back and forth, every machine that continued a session publishes with `--sessions` before the next claim, so the next step gets every turn. [Publish and claim](workflow-advanced.md#publish-and-claim) covers what the published state carries, every error and its next step, and publishing from CI.

### Hand a run to a runner

`publish` also offers a running run. The first `teamai workflow resume --next` in a checkout of the same business repository (the same `origin`) claims it and drives it. Start a run yourself, and let a CI runner finish it:

```console
$ teamai workflow start ship-issue --inputs '{"issue":42}'        # no --driver: creates the run, runs nothing
{"data":{"run":"rba115c30f5a3b946","name":"ship-issue","status":"running","revision":1,"record":"published"}}
$ teamai workflow publish rba115c30f5a3b946
{"data":{"run":"rba115c30f5a3b946","publication":"published","stateRevision":1,"offered":true,"inFlight":[]}}
$ gh workflow run teamai-runner.yml                                # wake the runner, or wait for its schedule
```

On the runner ([the job](#take-offered-runs-from-ci)):

```console
$ teamai workflow resume --next --auto-approve
✔ Claimed rba115c30f5a3b946 (ship-issue) from alice
⚠ Step "review" was approved by auto_approve.
{"data":{"done":{"run":"rba115c30f5a3b946","outcome":"succeeded","record":"published"},"cancelled":[]}}

$ teamai workflow resume --next --auto-approve
ℹ Left r482011be75fd0ad9 (release) offered for a person: only a person can answer the approval at ship
{"data":{"idle":{"offered":1}}}      # the one run left needs a person, so it stays offered
```

`teamai workflow resume` with no run id lists what this checkout can resume, and the command for each. On bob's machine, before the runner took `ship-issue`, with a run of alice's that waits for a person and one bob claimed:

```console
$ teamai workflow resume
RUN                WORKFLOW        STATUS          OWNER                      WHERE
r482011be75fd0ad9  release         needs a person  alice (install 4c514375…)  offered on teamai-reports, only a person can answer the approval at ship: a person runs teamai workflow resume r482011be75fd0ad9 --claim
rba115c30f5a3b946  ship-issue      running         alice (install 4c514375…)  offered on teamai-reports: teamai workflow resume --next
r89c346a218d2f5e9  nightly-report  running         this install               local: teamai workflow resume r89c346a218d2f5e9
```

On alice's machine, the run bob took shows who has it:

```console
r89c346a218d2f5e9  nightly-report  claimed  bob (install 6c4853e2…)  claimed on teamai-reports since 2026-10-28T00:26:42.741Z: teamai workflow resume r89c346a218d2f5e9 --claim takes it back
```

A runner that lacks what a run needs leaves the run offered instead of failing it. Say alice offers `release-docs`, whose steps left are a prompt step and a step that signs:

```yaml
# workflows/release-docs.yaml
schemaVersion: v1alpha1
name: release-docs
description: Write the release notes, then sign the docs bundle.
steps:
  - id: notes
    prompt: Write the release notes for the latest tag into NOTES.md.
  - id: sign
    needs: [notes]
    requires: { env: [SIGNING_KEY] }
    command: ./scripts/sign-docs.sh
```

On a runner whose job sets no `SIGNING_KEY` and installs no `claude`, `--next` takes neither run, and says why. The listing says the same:

```console
$ teamai workflow resume --next --tools default=claude --auto-approve
ℹ Left r482011be75fd0ad9 (release) offered for a person: only a person can answer the approval at ship
⚠ Left r814cea92baadffac (release-docs) offered: sign requires env SIGNING_KEY, which has no value here: teamai env set SIGNING_KEY, or set it in the environment; the prompt step notes run on claude, which is not on PATH here: install claude, or pass --tools default=<tool> for one that is
{"data":{"idle":{"offered":2}}}

$ teamai workflow resume --tools default=claude
RUN                WORKFLOW      STATUS           OWNER                      WHERE
r482011be75fd0ad9  release       needs a person   alice (install 4c514375…)  offered on teamai-reports, only a person can answer the approval at ship: a person runs teamai workflow resume r482011be75fd0ad9 --claim
r814cea92baadffac  release-docs  cannot run here  alice (install 4c514375…)  offered on teamai-reports, sign requires env SIGNING_KEY, which has no value here: teamai env set SIGNING_KEY, or set it in the environment; the prompt step notes run on claude, which is not on PATH here: install claude, or pass --tools default=<tool> for one that is; then teamai workflow resume --next
```

Add `SIGNING_KEY` to the job's `env` and install `claude`, as [the job](#take-offered-runs-from-ci) does, and the next `--next` takes it:

```console
$ teamai workflow resume --next --tools default=claude --auto-approve
ℹ Left r482011be75fd0ad9 (release) offered for a person: only a person can answer the approval at ship
✔ Claimed r814cea92baadffac (release-docs) from alice
{"data":{"done":{"run":"r814cea92baadffac","outcome":"succeeded","record":"published"},"cancelled":[]}}
```

A cron job on a VM that leaves `TEAMAI_MODE` unset runs attended, but has no terminal, so nobody could answer the approval at `ship`. `--next` leaves `release` for a person there too:

```console
$ teamai workflow resume --next --tools default=claude     # crontab, TEAMAI_MODE unset
ℹ Left r482011be75fd0ad9 (release) offered for a person: only a person can answer the approval at ship
{"data":{"idle":{"offered":1}}}
```

What `--next` does with each offered run:

| The offered run | Unattended `--next` (CI, or `TEAMAI_MODE=unattended`) | Attended `--next` |
|---|---|---|
| Nothing in its steps left needs a person | takes it | takes it |
| A step left has a required approval, is `interactive`, or is a choice with no default | skips it: listed as `needs a person` | takes it from a terminal; with no terminal, such as cron, skips it |
| A step left requires env with no value here | skips it: listed as `cannot run here` | skips it |
| A prompt step left has no tool here: `--tools`, `workflows.tools` and your AI tool name none, or the one they name is not on `PATH` | skips it: listed as `cannot run here` | skips it |
| You published it from this install | skips it | skips it |
| It works in another business repository | skips it | skips it |
| Another runner claimed it a moment earlier | takes the next one | takes the next one |

Any claim takes the offer away: `--next`, `resume <run>` on a machine without the run, `resume <run> --claim`, or a driver's `"claim": true`. So does your own `resume <run>` on the machine that published it; publish again to offer it again. So two runners never drive one run. Publish once you stop driving the run, since a runner can take it at once. The dashboard's [Workflow Runs page](dashboard.md#workflow-runs) shows the same runs. [Offer a run to a runner](workflow-advanced.md#offer-a-run-to-a-runner) has the rules for agent sessions and every error.

## Run records

With [usage reporting](reporting.md) on, every run publishes a privacy-preserving record to the team's `teamai-reports` branch: once when it starts and once when it ends. With it off, nothing is published and the envelopes carry no `record`. Records live in `workflows/runs/<run id>.json`, keyed by run id, so a retried publication updates the same record instead of adding a copy.

A record carries only: the run id, workflow name, `sourceHash`, optional `teamRevision`, phase (`start` or `end`), driver kind, the run mode it started in (`runMode`), status, the end the run reached (when it reached one), the failure code of a run that failed without reaching an end, when it is a code teamai sets, such as `loop_exhausted` for a loop that ran out or `tool_unavailable` when the local driver cannot find the tool (never its message), start and end times, duration, per-step entries (step path such as `check.classify`, agent, tool, model, outcome, tokens, the pass's `runMode` when its driver sent one on `next`, and what the pass delivered (`outcomes`: the commit shas on its branch, the pull request delivered for it, and the ids of the learnings `teamai contribute` recorded in its attempt) — a mixed-agent run records each step's own fields; `tool` is kept only when it is one of the local driver's tools, and `model` is the name the driver reported, kept only when it is shaped like a model name), summary step counts (succeeded, failed, skipped, cancelled), the cumulative settled-attempt count, the pull requests the run delivered (`prs`), and the publishing username. `sourceHash` identifies the exact workflow and prompt bytes that ran. `teamRevision` is present only when one remote-reachable team commit stores those exact bytes for the parent and every child workflow; local or unpushed edits and mixed cached revisions leave it out. Every entry has its `pass` number, and a step that a loop ran more than once has one entry per pass. An item of a `for_each` counts the times that item ran, so its `pass` can be lower than its step's when an earlier pass had fewer items. A cancelled step's entry has the outcome `cancelled`, and a skipped step's has none. The counts cover each step once, as the run ended. Steps of a sub-workflow that never started are not counted. Prompts, command text, input values, `env` values, outputs, diffs, secret values, local workspace paths, session ids, and hostnames have no field to land in — the record is built from an allowlist, not filtered from the run state.

An entry's `agent` is what that pass ran as, as observed. It holds the step's `agent:` definition and how the tool got it (`main` when the tool reads its own agent file, `prompt` when the instructions are prepended), the tool and its version, the model and effort the launch asked for and the model the tool reported, the team commit the checkout last pulled and whether a delivered file was edited since, the project commit, the TeamAI version, and the driver kind. A value nobody observed is left out. `fingerprint` hashes the definition, tool, model, effort and team commit, so two passes with the same fingerprint ran with the same recorded parts. It is left out when the model or the team commit is unknown, or a delivered file was edited. A pass nothing observed, and a record from an older TeamAI, carry only the definition's name. While a step runs, the tool it starts, and any session that tool starts in the same checkout, skips the session-start pull when the checkout's last pull delivered completely to that tool, so the step keeps the team commit it records.

`prs` lists every pull request the run delivered, whether TeamAI opened it or a driver reported it, once each, in the order the run first delivered them. A URL from a step's output is never listed. Like the rest of the record, `prs` follows the usage-report opt-out, and it is public when the team repo is public. A record from before `prs` still reads. To find the run that opened a pull request, run this in a checkout of the team repo's `teamai-reports` branch:

```text
jq -r 'select((.prs // []) | index("<url>")) | .run' workflows/runs/*.json
```

The operation that settles the run queues its end record under the run lock and publishes it after releasing that lock. Retry updates the same record path when the run ends again. Answer entries publish choice, channel, and agent only; notes, answer timestamps, and answer driver identities stay local. A publication that fails — no remote, a busy reports lock, a rejected push — is queued in this scope's data directory and retried on the next `teamai pull`. The `start` and `next` envelopes then carry `record: pending` instead of `record: published`. The run itself is unaffected: a machine that dies after starting a run leaves it visible as started but not ended.

Run ids are `r` plus 16 hex digits. Runs created before this scheme used 8 hex digits and still resolve.

Workflow totals (runs, succeeded, failed, cumulative duration) are folded into `stats/<username>.yaml` on the reports branch at publication time and shown by `teamai digest`.

## Run from a coding session

A coding session, such as Claude Code or Codex, can run a team workflow for the person it works with. `invoke` in the workflow file says whether it may. It limits agents only:

| `invoke` | Agent session (any driver; `--driver skill` always counts) | A person's terminal, local driver | CI without an agent session, local driver | Sub-workflow |
|---|---|---|---|---|
| `allow` | Starts | Starts | Starts | Starts |
| `ask` | Starts once the person agrees (describe, then `--confirmed`). Unattended: `denied`, also with `--confirmed` | Starts | Starts | Starts |
| `deny`, the default | Refused | Starts | Starts | Starts |

`resume`, `next --takeover`, and a driver's `next` claim follow the same rule.

`alias` is an optional second name for `workflow start`, a single token. An alias that another workflow also uses, or takes as its name, starts nothing (`alias_conflict`). Start those workflows by name.

```yaml
schemaVersion: v1alpha1
name: session-change
description: Implement a requested task in a separate branch.
invoke: allow
alias: session-fix
inputs: { task: string }
steps:
  - id: implement
    workspace: new
    prompt: "Implement {{ inputs.task }}."
```

teamai before 0.28.0 drops a workflow that sets `invoke` or `alias`, so members and CI jobs need 0.28.0 or later. `teamai review --branch` warns about each workflow that adds either key.

A process runs inside an agent session when an agent's session variable, such as `CLAUDE_CODE_SESSION_ID`, is set. From there, `workflow start` of a `deny` workflow answers `invoke_denied`. The message names the command the person runs in their own terminal, and the `invoke` setting that lets agents start the workflow. An `ask` workflow answers `confirm_needed` without `--confirmed`, which the session adds once the person agreed. In an unattended run (`TEAMAI_MODE=unattended`, or `CI`), it answers `unattended_denied`, also with `--confirmed`, since no person is there to agree. These hold with every driver, and with no driver. `CI` exempts nothing: a CI job starts any workflow because it sets no session variable. A `workflow start --driver skill` counts as an agent's even when its host sets no such variable, since only a coding agent drives the skill driver.

No run starts or is driven from inside a step of another run. The process of a step carries `TEAMAI_WORKFLOW_ATTEMPT`: the local driver sets it for the commands it runs and the tools of its prompt steps, the skill driver for its runners and their commands, and every driver for setup. With it set, every `workflow` command that changes a run (`start`, `next`, `report`, `respond`, `retry`, `cancel`, `resume`, and `publish`) answers `nested_workflow`, except a skill driver runner's report of its own attempt. `start` also answers `nested_workflow` in a workflow worktree under `.teamai/workflow-worktrees`, and in a checkout on a `teamai/<run>/...` branch. The other commands still work there, since a step's child reports from its place. To run another workflow as part of a run, add it to the definition as a `workflow` step.

### Workflow skills

`teamai pull` writes a `workflow-<name>` skill for each workflow with `invoke: allow` or `ask`. A session finds the workflow through it: the skill carries the workflow's description and alias, and sends the agent to `teamai skill get workflow`, the instructions the installed CLI serves. It carries no step, prompt, or command. On Claude Code and CodeBuddy, the skill of an `allow` workflow pre-approves its `workflow start` command. A user-scope pull writes these skills into your home, where every session sees them. In a project that has no runnable workflow of that name, `workflow start` starts the user scope's, and the run belongs to the user scope.

Edit the workflow, not the skill. Pull rewrites an unchanged skill when the workflow changes, and removes it when the workflow is removed or set to `deny`. It keeps a skill you edited, with a warning. A team or member skill named `workflow-<name>` without the generated marker takes its place, and `teamai doctor` lists it. `teamai push` never publishes a generated skill. `push --skill` refuses one, and refuses a skill the CLI owns, such as `teamai`. In a project, pull lists the generated skills in `.git/info/exclude`.

In self mode, a workflow worktree holds the team files as committed. Commit a workflow before a session runs it in a worktree, or its skill is missing there.

### What the session does

The agent runs `teamai workflow start --describe <name> --driver skill`. The reply says how to start the run: directly, after one question to the person, or with the local driver. The question covers the inputs, how many steps run at once, who answers optional approvals, and whether to judge.

TeamAI names the session's tool from the session variable its host sets. When it finds none, as in Oh My Pi or Qoder, and a step pins a model or is scored, describe asks for it, and the agent describes again with `--tools default=<tool>`. Every command teamai prints after that keeps it. The run keeps that tool: it judges the scored steps, and the steps' models resolve for it when teamai installs agents for that tool.

After the start, every reply is a turn: the actions for the agent, the steps that run, what happened since the last call, and the command to run next. The run's state stays in the CLI, so the agent keeps nothing between calls. After a compaction, or in a new session, `teamai workflow next <run> --driver skill` prints the current turn. When another session still drives the run, it answers `orchestrator_active`, and the person decides whether this session takes over with `--takeover`.

- A command step runs in a background process that TeamAI starts on this machine.
- A prompt step goes to a child agent that the session starts, with a brief and the directory to work in. The child reports when it is done. When the step has a workspace, TeamAI commits and pushes the child's work.
- An `interactive` step is worked by the session's agent itself, with the person, one at a time.
- Once per run, the agent says how its host starts children. When the host makes a worktree for each child, TeamAI checks that worktree and adopts it. When the host starts no child, the agent works each step in the checkout itself, and a step that needs a worktree waits for the person's terminal.
- The session tells the person what happened, asks the questions, and gives the outcome and the pull requests.

`teamai skill get workflow` prints the instructions the agent follows. `teamai workflow <command> --help` lists every option.

The skill driver declares `env: "commands"` (see [Requirements and limits](workflow-advanced.md#requirements-and-limits)). A command step and setup get their `requires.env` keys as with the local driver. A prompt step with `requires.env` waits, because TeamAI scopes team env only in the processes it starts. The driver never declares `tokens`, `max_turns`, or `network`, since no host reports a child's tokens or turns to TeamAI. A headless prompt step under a `budget` waits, so a run-level `budget` holds every headless prompt step of the run. `max_turns` and `requires.network: false` are listed in `unenforced`. A worktree is not a sandbox: `requires.isolation: sandbox` is listed in `unenforced` too.

When a step that waits for env or a budget works in a workspace that an earlier step of the run opens, describe sends the whole run to the local driver, for the person to start in their own terminal. Otherwise the session runs what it can. Once only waiting steps are left, it hands the run to the person, who continues it with `teamai workflow resume <run>` in their own terminal. The local driver runs its prompt steps with the headless tool that `workflows.tools` in local config names, or that `--tools` picks. When none of `TEAMAI_AI_TOOL`, `workflows.tools.default` and either `ai.tool` names a tool, the local start and the `resume` command the session gives carry `--tools default=<the session's tool>`.

### Attended and unattended runs

A run is attended when a person is there to answer, and unattended in CI or a cloud agent. TeamAI takes the mode from `TEAMAI_MODE` (`attended` or `unattended`), else from `CI` (set, and not `0` or `false`, means unattended), else attended. It warns about any other `TEAMAI_MODE` value and ignores it.

In an unattended run, describe asks no question. It answers the start of the recommended option with `--auto-approve`, and the agent fills `{inputs}` from its task. It refuses a workflow that needs a person (`denied`), naming why: `invoke: ask`, an `interactive` step, a required approval, a choice without a default, or a route only the local driver can run.

Every process TeamAI starts for a step, setup included, gets the run's `TEAMAI_MODE`, with either driver. The skill driver keeps the mode that its start, or a `resume --driver skill`, resolved. The local driver resolves it each time it starts driving, with `start` or `resume`.

### Answers only the person gives

A required approval reaches only the person. The session shows it and gives them the `teamai workflow respond` command for their own terminal, or they answer in [`teamai dashboard`](dashboard.md#workflow-runs). TeamAI decides who answered from the process that sends the answer. Any answer sent from inside an agent session counts as the agent's: `respond --driver skill`, `respond --json` with a driver identity, and a dashboard started from that session. A required approval refuses it with `agent_in_path`. These variables are evidence, not proof: a process that unsets them, or opens a terminal, passes as the person.

Optional approvals and choices are answered as the person picked at the start. The start question says what each one guards: the command, prompt step, workflow or end it comes before, or the steps that wait for it; for a choice, its options and default. A command shows its first line, cut after 80 characters. For example:

```text
- Optional approval at contribute: before `teamai contribute --file "$FILE" --title "$TITLE" --namespace "$NS" --session-id…`.
- The recommended start lets this session's agent answer optional approvals and say why; "answer optional approvals automatically" answers each approval yes.
```

With `--hitl person`, the agent asks the person. With `--hitl recommend`, the agent decides and says why. With `--auto-approve`, TeamAI answers an approval yes and a choice with its default.

### Judging

When a step lists [scorers](scorers.md) and the confined judge of the session's tool is installed on this machine, TeamAI judges each scored pass in the background, and the session tells the person the labels. When this machine has no verified judge of the session's tool, such as Cursor's, the session takes the run's judge work once the run is done and judges each pass in a fresh subagent at `best-effort` isolation. Work a scorer requires `verified` for stays open for another driver, and so does all of it when the session's host starts no child agent. To leave the scored steps unjudged on this machine, the person picks the start option without judging (`--no-judge`). The orchestrating agent never judges a pass in its own context.

### Limits

- On Windows, a command whose background runner was killed keeps running until it ends. TeamAI does not stop it.
- A prompt step's `timeout` is noticed at the session's next `next` call or poll, not at the moment it passes.
