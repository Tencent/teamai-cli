# Tool launch

Maintainer notes on `src/tool-launch/`, the code that starts a coding tool headless. Workflow drivers call it: for a
step that prompts a tool, a step that answers a prompt, and a scorer's judge. Nothing else launches one.

Each rule below spans more than one file. The rule names the code that owns it, so you can read the details there.

## How a feature asks an AI tool

It writes an `answer` step in its default workflow. This is the step `recall maintenance --update-quality` runs, from
`workflows/teamai-draft-learning-updates/WORKFLOW.yaml`:

```yaml
- id: ask
  needs: [context]
  answer: |-
    You are a technical writer updating a team knowledge base entry.
    …
    Output ONLY the updated markdown file content (including frontmatter).
  output: { text: string }
  timeout: 600s
```

The local driver runs it in `drivers/local/answer-step.ts`. The tool is the first of these that is set:

```text
TEAMAI_AI_TOOL=codex                                  → codex
ai.tool: claude in the project's teamai config        → claude
ai.tool: gemini in ~/.teamai/config.yaml              → gemini, which teamai cannot launch: the step fails tool_unconfigured
none                                                  → the first tool of LAUNCH_ORDER on PATH, else tool_unavailable
```

A tool that ran and failed fails the step `tool_failed`. Other drivers get the step as a prompt lease that their agent
answers.

Importing the launcher anywhere else fails `npm run lint`:

```text
teamai(launch-through-workflows): Only a workflow driver launches an AI tool. Run this AI work as a workflow step instead of importing the launcher (docs/designs/ai-through-workflows.md).
```

## Rules that span files

- **Only a workflow driver launches a tool.** `teamai/launch-through-workflows`
  (`oxlint-plugin-teamai/rules/launch-through-workflows.js`) fails an import of `call.ts`, `run.ts` or `runConfined`
  outside `src/workflow/` and `src/tool-launch/`, with no exceptions.
- **An answer step picks the member's tool.** `memberTools` in `member-tools.ts` lists what the member names, most
  specific first: `TEAMAI_AI_TOOL`, then `ai.tool` in the scope's own config, then in the machine's. `createToolCaller` in
  `call.ts` takes the first and fails with `CallError` `override_invalid` when teamai cannot launch it, or takes the
  first installed tool of `LAUNCH_ORDER` when none is named. `answer-step.ts` maps `CallError` kinds to step failures
  (`no_tool` → `tool_unavailable`, `override_invalid` → `tool_unconfigured`, `call_failed` → `tool_failed`). A
  workflow's fallback reads `steps.<id>.failure.code` and ends the run on `tool_unconfigured`, so a wrong setting is
  never hidden.
- **A tool launches through its adapter.** `launch` on the tool's descriptor (`packages/tool-<family>/src/definitions.ts`) names an entry of `LAUNCH_ADAPTERS` in `adapters.ts`, or `none`. The adapter holds the profiles teamai builds for it, declared in the family's `launch.ts`: `call` always, `step` and `confined` when the tool can run them. Code in `src/` reads an adapter with `launchAdapterOf(tool)` (`tools.ts`), never `LAUNCH_ADAPTERS` itself (lint rule `teamai/tool-registry`). `LAUNCH_ORDER` in `tools.ts` is the order an answer step tries installed tools in; the step tools (`LAUNCH_TOOLS`) and confined tools (`CONFINED_TOOLS`) are the tools of that order whose adapter has the profile. To add a tool, add or reuse a profile in its family's `launch.ts`, add the adapter's row to `LAUNCH_ADAPTERS`, set `launch`, and place the tool in `LAUNCH_ORDER`.
- **A tool instance launches on its own command, once accepted.** A step whose tool is an instance (`tools/<name>.yaml` in the team repo, or `~/.teamai/tools/`) runs through the adapter of the tool it extends: `launchTargetOf` in `tool-launch/tools.ts` resolves the name, and `LocalToolRun.command` in `local-tool-adapter.ts` carries the instance's `command`, which is looked up with `resolvePathCommand` (`@teamai/tool-core/cli-path`) in the PATH directories alone: on Windows `where $PATH:<name>`, since a bare `where` searches the current directory, the checkout, first. Before a team instance's command runs, the local driver calls `acceptToolCommand` in `tool-instances.ts`, which asks a person attended, through the driver's one terminal reader (it closes an open HITL question until answered, the step's abort ends it, and Ctrl-C stops the run as `interrupted`), and refuses unattended with `tool_not_accepted` until that file content is accepted. Answer steps and judges do not launch instances.
- **A launched session says who launched it.** Answer steps, prompt steps and judges set `LAUNCHED_BY_ENV`
  (`launch-context.ts`). `hook-dispatch-cli.ts` skips every hook of a session teamai launched, except a workflow
  step's, so the member's hooks neither capture nor judge an answer. `hook-fast-path.ts` makes the same check before
  the CLI bundle loads, with a copy of the variable's name that `hook-fast-path.test.ts` keeps equal.
- **The support page follows the adapters.** The `workflows` and `aiBackend` cells in `src/tools.ts` stay hand-written,
  for their evidence and notes, and `tools.test.ts` fails when a cell marks a feature built that the adapter has no
  profile for, or the reverse.
- **Steps and judges still switch on the adapter.** `invocation` in `drivers/local/local-tool-adapter.ts` ends in a `never` check, and the confined argv and reply tables in `tool-launch/confined.ts` (`LAUNCHES`, which launches every judge step, and `REPLIES`) need an entry per adapter with a `confined` profile, so a new adapter with a `step` or `confined` profile fails the type check until both handle it.
