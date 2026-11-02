import { expect } from 'vitest';

import { ruleHarness } from '../test/harness.ts';

const rule = ruleHarness('teamai/suppression-reason', { filename: 'src/viz.ts' });

rule.invalid('rejects a lint directive with no reason', `
// oxlint-disable-next-line teamai/learnings-root
export const learningsDir = root + '/learnings';
`, (output) => {
  expect(output).toContain('end the directive with `-- reason`');
});

rule.invalid('rejects a TypeScript directive with no reason', `
// @ts-expect-error
export const count: number = 'text';
`, (output) => {
  expect(output).toContain('write the reason after the directive');
}, { filename: 'src/__tests__/tools.type-test.ts' });

rule.valid('allows a lint directive that ends with a reason', `
// oxlint-disable-next-line teamai/learnings-root -- an explicit --repo path, with no config to resolve
export const learningsDir = root + '/learnings';
`);

rule.valid('allows a TypeScript directive followed by its reason', `
// @ts-expect-error every tool states its MCP channel
export const count: number = 'text';
`, { filename: 'src/__tests__/tools.type-test.ts' });

rule.valid('ignores an enable directive', `
/* oxlint-enable no-console */
`);

rule.invalid('rejects a file-level directive with no reason', `
/* oxlint-disable no-console */
console.log('x');
`);

rule.invalid('rejects a TypeScript directive whose only text is punctuation', `
// @ts-ignore: -
export const count: number = 'text';
`);

rule.valid('allows a directive explained by the comment above', `
// \`settled\` flips inside the \`.finally()\` callback registered above, which the linter can't see.
// oxlint-disable-next-line no-unmodified-loop-condition
for (let now = Date.now(); !settled; now += 1000) tick(now);
`);

rule.valid('allows stacked directives under one explanation', `
// The fixture is invalid on purpose.
// @ts-expect-error
// oxlint-disable-next-line no-unused-vars
const value: number = 'text';
`, { filename: 'src/__tests__/tools.type-test.ts' });

rule.invalid('rejects a directive whose line above is code, not a comment', `
const settled = false;
// oxlint-disable-next-line no-unmodified-loop-condition
for (let now = Date.now(); !settled; now += 1000) tick(now);
`);

rule.invalid('rejects a triple-slash TypeScript directive with no reason', `
/// @ts-expect-error
export const count: number = 'text';
`, undefined, { filename: 'src/__tests__/tools.type-test.ts' });
