import { expect } from 'vitest';

import { ruleHarness } from '../test/harness.ts';

const rule = ruleHarness('teamai/no-low-value-comments', { filename: 'src/status.ts' });

rule.invalid('rejects a comment that only repeats the name below it', `
// State
const state = loadState();
`, (output) => {
  expect(output).toContain('only repeats the name below it');
});

rule.invalid('rejects commented-out code', `
// const legacy = loadLegacy();
export const state = 1;
`, (output) => {
  expect(output).toContain('Delete commented-out code');
});

rule.invalid('rejects a task marker with no issue', `
// TODO: drop the legacy path
export const state = 1;
`, (output) => {
  expect(output).toContain('Link the issue');
});

rule.invalid('rejects a JSDoc type in TypeScript', `
/** @param {string} name the tool */
export function find(name: string) { return name; }
`);

rule.invalid('rejects a test step label', `
// Arrange
export const state = 1;
`, undefined, { filename: 'src/__tests__/status.test.ts' });

rule.valid('allows a comment that says why', `
// Read before the lock: a held lock would block the status report.
const state = loadState();
`);

rule.valid('allows issue numbers and section dividers, which this repository uses', `
// ─── Status (#1552) ───────────────────
export const state = 1;
`);

rule.valid('allows a task marker that links its issue', `
// TODO(#1656): drop the legacy path
export const state = 1;
`);

rule.valid('allows a comment in Chinese whose English words match the name', `
/** git log 读取条数。 */
const GIT_LOG_MAX_COUNT = 20;
`);

rule.valid('allows lint directives', `
// oxlint-disable-next-line no-console -- the CLI prints here
console.log(1);
`);
