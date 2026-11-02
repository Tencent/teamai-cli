import fs from 'node:fs';
import { describe, it } from 'vitest';
import { RuleTester } from 'oxlint/plugins-dev';

// oxlint's RuleTester refuses Node before 22, where CI also lints; the Node 22 and 24 jobs run these cases.
const runsRuleTester = Number(process.versions.node.split('.')[0]) >= 22;

if (runsRuleTester) {
  // The upstream rule tests call RuleTester at import time; route its cases
  // through vitest so each one reports as a test.
  RuleTester.describe = describe;
  RuleTester.it = it;
  const rules = new URL('./anti-slop/rules/', import.meta.url);
  for (const file of fs.readdirSync(rules).filter((name) => name.endsWith('.test.ts')).sort()) {
    await import(new URL(file, rules).href);
  }
} else {
  describe.skip('anti-slop rule tests: oxlint RuleTester needs Node 22 or later', () => {
    it('runs on Node 22 and 24 in CI', () => {});
  });
}
