import { describe } from 'vitest';
import { ruleHarness } from '../test/harness.ts';

const rule = ruleHarness('teamai/workflow-boundaries', { filename: 'src/workflow/drivers/skill/sample.ts' });

describe('teamai/workflow-boundaries', () => {
  rule.valid('allows a sibling import', `import { x } from './tick.js';`);
  rule.valid('allows a declared skill-driver store import', `import { takeRunLock } from '../../store.js';`, { filename: 'src/workflow/drivers/skill/skill-driver.ts' });
  rule.valid('allows an aliased declared skill-driver store import', `import { takeRunLock as lock } from '../../store.js';`, { filename: 'src/workflow/drivers/skill/skill-driver.ts' });
  rule.valid('allows a mixed type and value requirements import', `import { type Requirement, envAdvice } from '../../requirements.js';`, { filename: 'src/workflow/drivers/skill/skill-driver.ts' });
  rule.valid('allows a dynamic import from an unrestricted skill helper', `await import('../../protocol.js');`, { filename: 'src/workflow/drivers/skill/skill-driver.ts' });
  rule.valid('allows a flat module to import an ordinary workflow helper', `import { x } from './protocol.js';`, { filename: 'src/workflow/engine.ts' });
  rule.valid('allows a type-only flat helper', `import type { X } from '../../types.js';`);
  rule.valid('allows an aliased permitted re-export', `export { takeRunLock as lock } from '../../store.js';`, { filename: 'src/workflow/drivers/skill/skill-driver.ts' });
  rule.valid('allows a type-only wildcard re-export', `export type * from '../../types.js';`, { filename: 'src/workflow/drivers/skill/skill-driver.ts' });
  rule.valid('preserves an explicit TypeScript extension for a permitted entry', `import { place } from '../../place/place.ts';`, { filename: 'src/workflow/drivers/local/local-driver.ts' });
  rule.valid('allows the canonical boundary test fixture', `import fs from 'node:fs';`, { filename: 'src/__tests__/workflow-x.test.ts' });

  rule.invalid('rejects skill driver importing the local driver', `import { run } from '../local/local-driver.js';`);
  rule.invalid('rejects namespace imports from a symbol-limited skill helper', `import * as takeRunLock from '../../store.js';`, undefined, { filename: 'src/workflow/drivers/skill/skill-driver.ts' });
  rule.invalid('rejects a forbidden vi mock with a source location', `vi.mock('./drivers/local/local-driver.js');`, undefined, { filename: 'src/workflow/engine.ts' });
  rule.invalid('rejects unrestricted import into a type-only skill helper', `await import('../../types.js');`, undefined, { filename: 'src/workflow/drivers/skill/skill-driver.ts' });
  rule.invalid('rejects unrestricted export from a symbol-limited skill helper', `export * from '../../store.js';`, undefined, { filename: 'src/workflow/drivers/skill/skill-driver.ts' });
  rule.invalid('rejects a flat engine module importing a driver', `import { run } from './drivers/local/local-driver.js';`, undefined, { filename: 'src/workflow/engine.ts' });
  rule.invalid('rejects bypassing a folder entry point', `import { setup } from './place/setup.js';`, undefined, { filename: 'src/workflow/engine.ts' });
  rule.invalid('rejects a non-entry test import into a guarded folder', `import { reader } from '../workflow/place/reader.js';`, undefined, { filename: 'src/__tests__/workflow-x.test.ts' });
});
