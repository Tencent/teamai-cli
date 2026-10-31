import { describe } from 'vitest';
import { ruleHarness } from '../test/harness.ts';

const rule = ruleHarness('teamai/workflow-boundaries', { filename: 'src/workflow/drivers/skill/sample.ts' });

describe('teamai/workflow-boundaries', () => {
  rule.valid('allows a sibling import', `import { x } from './tick.js';`);
  rule.valid('allows a declared skill-driver store import', `import { takeRunLock } from '../../store.js';`, { filename: 'src/workflow/drivers/skill/skill-driver.ts' });
  rule.valid('allows a type-only flat helper', `import type { X } from '../../types.js';`);
  rule.valid('allows the canonical boundary test fixture', `import fs from 'node:fs';`, { filename: 'src/__tests__/workflow-module-boundaries.test.ts' });

  rule.invalid('rejects skill driver importing the local driver', `import { run } from '../local/local-driver.js';`);
  rule.invalid('rejects a flat engine module importing a driver', `import { run } from './drivers/local/local-driver.js';`, undefined, { filename: 'src/workflow/engine.ts' });
  rule.invalid('rejects bypassing a folder entry point', `import { setup } from './place/setup.js';`, undefined, { filename: 'src/workflow/engine.ts' });
  rule.invalid('rejects a non-entry test import into a guarded folder', `import { reader } from '../workflow/place/reader.js';`, undefined, { filename: 'src/__tests__/workflow-x.test.ts' });
});
