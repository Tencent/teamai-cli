import { ruleHarness } from '../test/harness.ts';
const rule = ruleHarness('teamai/workflow-boundaries', { filename: 'src/workflow/drivers/skill/tick.ts' });
rule.invalid('rejects a skill driver import of the engine', `import { startRun } from '../../engine.js';`);
rule.invalid('rejects a transitive path to the local driver', `import { protocol } from '../../protocol.js';`, undefined, { files: {
  'src/workflow/protocol.ts': `export { protocol } from '../bridge.js';`,
  'src/bridge.ts': `export { protocol } from './workflow/drivers/local/local-driver.js';`,
  'src/workflow/drivers/local/local-driver.ts': `export const protocol = 1;`,
} });
rule.invalid('rejects a transitive dynamic import of the local driver', `import { protocol } from '../../protocol.js';`, undefined, { files: {
  'src/workflow/protocol.ts': `export const protocol = () => import('./drivers/local/local-driver.js');`,
  'src/workflow/drivers/local/local-driver.ts': `export const local = 1;`,
} });
rule.invalid('rejects private entries from consumers', `export { tick } from './workflow/drivers/skill/tick.js';`, undefined, { filename: 'src/pull.ts' });
rule.invalid('rejects private entries in test mocks', `vi.mock('../workflow/place/setup.js');`, undefined, { filename: 'src/__tests__/sample.test.ts' });
rule.invalid('rejects runtime imports in transitions', `import { tick } from './tick.js';`, undefined, { filename: 'src/workflow/drivers/skill/transitions.ts' });
rule.invalid('rejects dynamic imports of drivers from flat workflow modules', `const later = import('./drivers/local/local-driver.js');`, undefined, { filename: 'src/workflow/engine.ts' });
rule.invalid('rejects restricted store symbols', `import { readRun as read } from '../../store.js';`);
rule.valid('allows named protocol schemas and approved values', `import { LeaseWireSchema } from '../../lease-wire.js'; import { envAdvice } from '../../requirements.js';`);
rule.valid('allows types in transitions', `import type { Tick } from './tick.js';`, { filename: 'src/workflow/drivers/skill/transitions.ts' });
rule.valid('allows the skill driver entry', `import { drive } from './workflow/drivers/skill/skill-driver.js';`, { filename: 'src/workflow-commands.ts' });
rule.valid('allows the protocol place entry', `import { place } from './place/place.js';`, { filename: 'src/workflow/protocol.ts' });
rule.invalid('rejects delivery imports of the engine', `import { startRun } from './engine.js';`, undefined, { filename: 'src/workflow/pr-delivery.ts' });
rule.invalid('rejects transitive provider loading from the snapshot', `import { snapshot } from '../snapshot-helper.js';`, undefined, { filename: 'src/workflow/snapshot.ts', files: {
  'src/snapshot-helper.ts': `export { snapshot } from './providers/new/adapter.js';`,
  'src/providers/new/adapter.ts': `export const snapshot = 1;`,
} });
rule.invalid('rejects snapshot loading delivery through a re-export', `import { snapshot } from '../snapshot-helper.js';`, undefined, { filename: 'src/workflow/snapshot.ts', files: {
  'src/snapshot-helper.ts': `export { snapshot } from './workflow/pr-delivery.js';`,
  'src/workflow/pr-delivery.ts': `export const snapshot = 1;`,
} });
rule.valid('allows provider types in the snapshot', `import type { Snapshot } from '../snapshot-helper.js';`, { filename: 'src/workflow/snapshot.ts', files: {
  'src/snapshot-helper.ts': `export { Snapshot } from './providers/new/adapter.js';`,
  'src/providers/new/adapter.ts': `export type Snapshot = string;`,
} });
rule.invalid('rejects a local driver mocked by a transitive dependency', `import { protocol } from '../../protocol.js';`, undefined, { files: {
  'src/workflow/protocol.ts': `vi.mock('./drivers/local/local-driver.js'); export const protocol = 1;`,
  'src/workflow/drivers/local/local-driver.ts': `export const local = 1;`,
} });
rule.invalid('rejects export-star access to private entries', `export * from './workflow/drivers/skill/tick.js';`, undefined, { filename: 'src/pull.ts' });
rule.valid('leaves unrelated calls and dynamic mock names alone', `log.info('ready'); vi.fn(); vi['fn'](); vi.mock(modulePath); getMocker().mock('module'); flush();`);
rule.valid('allows default and namespace type imports from the shared types', `import type Context from '../../../types.js'; import type * as Shapes from '../../../types.js';`);
rule.valid('follows a shared TSX dependency without crossing the local driver', `import { protocol } from '../../protocol.js'; import { attempt } from '../../attempt-marker.js';`, { files: {
  'src/workflow/protocol.ts': `export { guide as protocol } from '../guide.js';`,
  'src/workflow/attempt-marker.ts': `export { guide as attempt } from '../guide.js';`,
  'src/guide.tsx': `export const guide = <span />;`,
} });
