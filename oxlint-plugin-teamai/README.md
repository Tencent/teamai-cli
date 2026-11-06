# oxlint-plugin-teamai

This repository's own lint rules. `npm run lint` loads them through `jsPlugins` in `.oxlintrc.json`, as `teamai/<rule>`.

| Rule | What it stops |
|---|---|
| `teamai/home-env` | HOME reads outside `src/utils/home.ts`. |
| `teamai/learnings-root` | Manual learnings-root joins outside their owner. |
| `teamai/configured-tool-paths` | Manual configured skill, rules, and instruction-file joins outside `src/locate.ts`. |
| `teamai/launch-env` | Launch environment literals outside `src/launch-context.ts`. |
| `teamai/launch-through-workflows` | Launching an AI tool outside a workflow driver: an import of `src/tool-launch/call.ts` or `run.ts`, or of `runConfined` from `confined.ts`, from outside `src/workflow/` and `src/tool-launch/`; or a process call (`spawn`, `execFile`, `exec`, `crossSpawn`, `execa`, `execCommand`, `probeBinary`, `execute`) there whose command is a tool's executable, unless its arguments start with `--version`, `claude plugin`, `opencode serve` or `opencode session`. Run the AI work as a workflow step (`docs/designs/ai-through-workflows.md`). Tests and type-only imports are exempt. `BASELINE` lists today's callers and may only shrink; a listed file that stops launching is reported until its entry is removed. |
| `teamai/workflow-boundaries` | Workflow entry-point violations and transitive skill-to-local dependencies. |
| `teamai/no-provider-merge` | Merge operations in providers and delivery, and forbidden delivery/snapshot dependencies. |
| `teamai/windows-tests` | POSIX constructs in the current `WINDOWS_TESTS` selection. |
| `teamai/rules-locate` | MCP path lookups during rules activation. |
| `teamai/workflow-failure-codes` | Unclassified failure producers and unexplained forwarded codes. |
| `teamai/config-load-options` | Missing preview options at named `loadLocalConfig`, `loadLocalConfigForScope`, and `autoDetectInit` calls outside their owner. Forwarded options are accepted; wrapper behavior still needs tests. |
| `teamai/remove-delivered` | A bare `remove(` of a delivered copy in pull's files, which leaves a stale entry on the delivery record (#1577). Use `removeDelivered(ledger, dest)`. It checks only the files in `PULL_SIDE_FILES`: a new file that deletes delivered copies must be added there. |
| `teamai/attempt-result-writes` | A write to an attempt's result file outside `src/workflow/attempt-result.ts`, which would keep any credential its body repeats. Use `AttemptResult.write(file, body, secrets)`. It recognizes the file by `attemptResultPath(...)`, a name bound to one, or a `resultPath`: a path passed on under another name is not caught. |
| `teamai/tool-facts` | A list of tool ids, or a table keyed by tool that leaves some out, outside `src/tools.ts`. Put the fact in `TOOLS`, or key the table by every tool (`Record<ToolId, ...>`), so a new tool fails the type check until it is decided. An ordered registry, an alias map or a frozen history table carries an explained disable. |
| `teamai/yaml-parse` | `YAML.parse` or yaml's `parse` outside `src/utils/yaml.ts`. Use `parseYaml`, which returns JSON values instead of a Set, Buffer or Date for `!!set`, `!!binary` or `!!timestamp`. |
| `teamai/no-low-value-comments` | A comment that only repeats the name below it (`// State` above `const state`), commented-out code, a `TODO` with no issue, or a JSDoc type in TypeScript. Issue numbers and `// ───` dividers stay allowed. |
| `teamai/suppression-reason` | An `oxlint-disable` / `eslint-disable`, or a `@ts-expect-error` / `@ts-ignore` / `@ts-nocheck`, that says nothing about why. End it with `-- reason` (after a TypeScript directive, just the reason), or put the reason in a comment on the line above. |

The plugin also carries the generic rules of anti-slop, vendored in `anti-slop/` (`anti-slop/UPSTREAM.md` says from where). They report as `teamai/<rule>` and hold production code only; tests are exempt. Each message names its fix, for example:

| You wrote | `npm run lint` says | Fix |
|---|---|---|
| `typeof payload.session_id === 'string'` on parsed hook JSON | `` teamai(no-runtime-typeof): A `typeof` check narrows a representation without establishing its contract. `` | Parse the payload with a zod schema where it comes in, then read `parsed.data.session_id`. |
| `return name as ToolId;` | `` teamai(require-safety-comment-for-type-assertion): This type assertion has no `SAFETY:` justification. `` | Drop the cast, or write the check that makes it true on the line above: `// SAFETY: the includes() check above proves name is a ToolId.` |
| `const body: Record<string, unknown> = { name, private: true }` | `` teamai(no-known-value-widening): The explicit open dictionary type on binding `body` discards known type evidence. `` | `const body = { name, private: true }` |
| `items.filter((item) => item.active).map((item) => item.id)` | `` teamai(no-array-filter-map): Avoid consecutive array `filter` and `map` passes. `` | `items.flatMap((item) => (item.active ? [item.id] : []))` |

## Add a rule

1. Write `rules/<rule>.js` with `defineRule`, and register it in `index.js`. oxlint imports these files with plain Node, so they are JavaScript (`npm run lint` runs on Node 20 in CI); `npm run typecheck` checks them through their JSDoc types.
2. Turn it on in `.oxlintrc.json`: `"teamai/<rule>": "error"`.
3. Test it with real oxlint in `rules/<rule>.test.ts`:

```ts
import { describe, expect } from 'vitest';
import { ruleHarness } from '../test/harness.ts';

const rule = ruleHarness('teamai/remove-delivered', { filename: 'src/pull.ts' });

describe('teamai/remove-delivered', () => {
  rule.invalid('reports a bare remove(', `await remove(dir);`, (output) => {
    expect(output).toContain('removeDelivered');
  });
  rule.valid('allows removeDelivered', `await removeDelivered(ledger, dir);`);
  rule.valid('only in pull\'s files', `await remove(dir);`, { filename: 'src/push.ts' });
});
```

`filename` is where the fixture sits, relative to the repository root, so a rule scoped to some files can be tested in and out of them. Shared AST helpers go in `utils.js`. All cases in one harness invocation run through one oxlint subprocess, with diagnostics checked against each fixture and its intended rule.

A line that must break a rule carries the reason:

```ts
// oxlint-disable-next-line teamai/remove-delivered -- a team-repo file, which pull never records
await remove(teamFile);
```

`npx vitest run oxlint-plugin-teamai` runs the rule tests; `npm run typecheck` checks the plugin.
