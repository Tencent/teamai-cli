import { describe, expect } from 'vitest';

import { ruleHarness } from '../test/harness.ts';

const rule = ruleHarness('teamai/launch-env', { filename: 'src/workflow/attempt-marker.ts' });

describe('teamai/launch-env', () => {
  rule.valid('allows the owner module', `
const MODE = 'TEAMAI_MODE';
`, { filename: 'src/launch-context.ts' });

  rule.valid('allows tests to describe the contract', `
const expected = 'TEAMAI_MODE';
`, { filename: 'src/__tests__/launch-context.test.ts' });

  rule.invalid('rejects a duplicated launch mode name', `
const mode = process.env.TEAMAI_MODE;
`, (output) => expect(output).toContain('launch-context.ts'));

  rule.invalid('rejects a duplicated workflow attempt name', `
const marker = 'TEAMAI_WORKFLOW_ATTEMPT';
`);

  rule.valid('allows unrelated environment variables', `
const ci = process.env.CI;
`);
});
