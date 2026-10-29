# Tool launch

Maintainer notes on `src/tool-launch/`, which starts coding tools for internal knowledge-generation calls.

- A tool's `launch` descriptor in `src/tools.ts` names an entry of `LAUNCH_ADAPTERS`, or `none`. The adapter owns its invocation and answer reader. `LAUNCH_ORDER` determines the default when no tool is configured.
- Every internal AI call goes through `callTool`. It resolves `TEAMAI_AI_TOOL`, then the scope's `ai.tool`, then the machine's setting, then an installed tool. Invalid explicit overrides are errors, including for callers with a fallback.
- Calls set `LAUNCHED_BY_ENV` from `launch-context.ts`. Hooks skip these internal sessions so they cannot recursively invoke member automation. Historical launcher labels remain readable for session attribution.
- The `aiBackend` cells in `src/tools.ts` document support. `tools.test.ts` checks that built support agrees with the adapter. Workflow execution and session scoring are no longer supported.
