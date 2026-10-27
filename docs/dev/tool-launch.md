# Tool launch

Maintainer notes on `src/tool-launch/`, the code that starts a coding tool headless: for teamai's own AI calls, for a workflow step, and for a scorer judge.

Each rule below spans more than one file. The rule names the code that owns it, so you can read the details there.

## Rules that span files

- **A tool launches through its adapter.** `launch` on the tool's descriptor in `src/tools.ts` names an entry of `LAUNCH_ADAPTERS` in `adapters.ts`, or `none`. The adapter holds the profiles teamai builds for it: `call` always, `step` and `judge` when the tool can run them. `LAUNCH_ORDER` in `tools.ts` is the order a call tries installed tools in; the step tools (`LAUNCH_TOOLS`) and judge tools (`JUDGE_TOOLS`) are the tools of that order whose adapter has the profile. To add a tool, add or reuse an adapter, set `launch`, and place it in `LAUNCH_ORDER`.
- **Every AI call goes through `callTool`.** `call.ts` picks the tool (`TEAMAI_AI_TOOL`, then `ai.tool`, then the first installed tool of `LAUNCH_ORDER`), runs it with `runTool` in `run.ts`, and reads the reply with the adapter's `read`. A caller with a fallback rethrows `isOverrideInvalid` errors, so a wrong override is never hidden.
- **A launched session says who launched it.** Calls, steps and judges set `LAUNCHED_BY_ENV` (`launch-context.ts`). `hook-dispatch-cli.ts` skips every hook of a session teamai launched, except a workflow step's.
- **The support page follows the adapters.** The `workflows` and `aiBackend` cells in `src/tools.ts` stay hand-written, for their evidence and notes, and `tools.test.ts` fails when a cell marks a feature built that the adapter has no profile for, or the reverse.
- **Steps and judges still switch on the adapter.** `invocation` in `drivers/local/local-tool-adapter.ts` and the judge argv and answer reader in `scorers/judge.ts` each end in a `never` check, so a new adapter with a `step` or `judge` profile fails the type check until both handle it.
