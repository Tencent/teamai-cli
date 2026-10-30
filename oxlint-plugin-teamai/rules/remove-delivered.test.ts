import { describe, expect } from 'vitest';

import { ruleHarness } from '../test/harness.ts';

const rule = ruleHarness('teamai/remove-delivered', { filename: 'src/pull.ts' });

const bareRemove = `
import { remove } from './utils/fs.js';
export async function sweep(dir: string): Promise<void> {
  await remove(dir);
}
`;

describe('teamai/remove-delivered', () => {
  for (const filename of ['src/pull.ts', 'src/resources/skills.ts', 'src/resources/rules.ts', 'src/resources/agents.ts']) {
    rule.invalid(`reports a bare remove( in ${filename}, naming removeDelivered`, bareRemove, (output) => {
      expect(output).toContain('removeDelivered(ledger, dest)');
    }, { filename });
  }

  rule.valid('allows the removal through removeDelivered', `
import { removeDelivered, type DeliveryLedger } from './resources/delivered-copies.js';
export async function sweep(ledger: DeliveryLedger | undefined, dir: string): Promise<void> {
  await removeDelivered(ledger, dir);
}
`);

  rule.valid('allows a bare remove( with a reason it records nothing', `
import { remove } from './utils/fs.js';
export async function pushItem(dir: string): Promise<void> {
  // oxlint-disable-next-line teamai/remove-delivered -- a team-repo file, which pull never records
  await remove(dir);
}
`);

  rule.valid('leaves remove( alone outside the pull-side files', bareRemove, { filename: 'src/push.ts' });
});
