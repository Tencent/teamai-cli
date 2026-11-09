import { describe, expect } from 'vitest';

import { ruleHarness } from '../test/harness.ts';

const rule = ruleHarness('teamai/remove-delivered', { filename: 'src/pull.ts' });

const bareRemove = `
import { remove } from './utils/fs.js';
export async function sweep(dir: string): Promise<void> {
  await remove(dir);
}
`;

const resourceRemove = `
import { remove } from '../utils/fs.js';
export async function sweep(dir: string): Promise<void> {
  await remove(dir);
}
`;

describe('teamai/remove-delivered', () => {
  rule.invalid('reports remove from src/utils/fs in pull.ts, naming removeDelivered', bareRemove, (output) => {
    expect(output).toContain('removeDelivered(ledger, dest)');
  });

  for (const filename of ['src/resources/skills.ts', 'src/resources/delivered-folders.ts', 'src/resources/a-type-added-later.ts']) {
    rule.invalid(`reports remove from src/utils/fs in ${filename}, as in every file under src/resources/`, resourceRemove, (output) => {
      expect(output).toContain('removeDelivered(ledger, dest)');
    }, { filename });
  }

  rule.invalid('reports fs-extra\'s remove through its default import', `
import fse from 'fs-extra';
export async function sweep(dir: string): Promise<void> {
  await fse.remove(dir);
}
`, (output) => {
    expect(output).toContain('removeDelivered(ledger, dest)');
  }, { filename: 'src/resources/rules.ts' });

  rule.invalid('reports fs-extra\'s remove imported under another name', `
import { remove as rm } from 'fs-extra';
export async function sweep(dir: string): Promise<void> {
  await rm(dir);
}
`, (output) => {
    expect(output).toContain('removeDelivered(ledger, dest)');
  }, { filename: 'src/resources/agents.ts' });

  rule.valid('allows the removal through removeDelivered', `
import { removeDelivered, type DeliveryLedger } from './resources/delivered-copies.js';
export async function sweep(ledger: DeliveryLedger | undefined, dir: string): Promise<void> {
  await removeDelivered(ledger, dir);
}
`);

  rule.valid('leaves a remove that comes from neither fs-extra nor src/utils/fs alone', `
import { remove } from './entries.js';
const list = new Set<string>();
export function drop(entry: string): void {
  remove(entry);
  list.delete(entry);
}
`, { filename: 'src/resources/hooks.ts' });

  rule.valid('allows a bare remove with a reason it records nothing', `
import { remove } from './utils/fs.js';
export async function pushItem(dir: string): Promise<void> {
  // oxlint-disable-next-line teamai/remove-delivered -- a team-repo file, which pull never records
  await remove(dir);
}
`);

  rule.valid('leaves remove alone outside pull.ts and src/resources/', bareRemove, { filename: 'src/push.ts' });
});
