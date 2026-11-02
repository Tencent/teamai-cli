import fs from 'node:fs';
import { describe, it } from 'vitest';
import { RuleTester } from 'oxlint/plugins-dev';

// The upstream rule tests call RuleTester at import time; route its cases
// through vitest so each one reports as a test.
RuleTester.describe = describe;
RuleTester.it = it;
const rules = new URL('./anti-slop/rules/', import.meta.url);
for (const file of fs.readdirSync(rules).filter((name) => name.endsWith('.test.ts')).sort()) {
  await import(new URL(file, rules).href);
}
