import { describe, expect } from 'vitest';

import { ruleHarness } from '../test/harness.ts';

const rule = ruleHarness('teamai/no-provider-merge', { filename: 'src/providers/github/gh-cli.ts' });

describe('teamai/no-provider-merge', () => {
  rule.valid('allows request creation', `
async function createPullRequest() {
  return fetch('/repos/acme/app/pulls', { method: 'POST' });
}
`);

  rule.valid('allows harmless merge request wording', `
const help = 'Create a pull/merge request for review';
`);

  rule.invalid('rejects a merge method', `
async function finish(client) {
  await client.merge();
}
`, (output) => expect(output).toContain('must not merge'));

  rule.invalid('rejects a merge command embedded in a shell string', `
exec('gh pr merge 123 --squash');
`);

  rule.invalid('rejects an accept endpoint', `
const endpoint = '/projects/acme/accept';
`);

  rule.invalid('rejects auto merge configuration', `
const options = { auto_merge: true };
`);

  rule.valid('ignores unrelated files', `
client.merge();
`, { filename: 'src/pull.ts' });
});
