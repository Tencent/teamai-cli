# oxlint-plugin-teamai

This repository's own lint rules. `npm run lint` loads them through `jsPlugins` in `.oxlintrc.json`, as `teamai/<rule>`.

| Rule | What it stops |
|---|---|
| `teamai/remove-delivered` | A bare `remove(` of a delivered copy in pull's files, which leaves a stale entry on the delivery record (#1577). Use `removeDelivered(ledger, dest)`. It checks only the files in `PULL_SIDE_FILES`: a new file that deletes delivered copies must be added there. |

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

`filename` is where the fixture sits, relative to the repository root, so a rule scoped to some files can be tested in and out of them. Shared AST helpers go in `utils.ts`.

A line that must break a rule carries the reason:

```ts
// oxlint-disable-next-line teamai/remove-delivered -- a team-repo file, which pull never records
await remove(teamFile);
```

`npx vitest run oxlint-plugin-teamai` runs the rule tests; `npm run typecheck` checks the plugin.
