import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { ruleHarness } from '../test/harness.ts';
import { SKILL_IMPORTS } from './workflow-boundaries.js';
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
rule.invalid('rejects a transitive import-equals require of the local driver', `import { protocol } from '../../protocol.js';`, undefined, { files: {
  'src/workflow/protocol.ts': `import local = require('./drivers/local/local-driver.js');\nexport const protocol = local;`,
  'src/workflow/drivers/local/local-driver.ts': `export const local = 1;`,
} });
rule.invalid('rejects private entries from consumers', `export { tick } from './workflow/drivers/skill/tick.js';`, undefined, { filename: 'src/pull.ts' });
rule.invalid('rejects private entries in test mocks', `vi.mock('../workflow/place/setup.js');`, undefined, { filename: 'src/__tests__/sample.test.ts' });
rule.valid('allows a test of the worktree snapshot', `import { snapshotWorktree } from '../workflow/place/worktree-snapshot.js';`, { filename: 'src/__tests__/sample.test.ts' });
rule.invalid('rejects runtime imports in transitions', `import { tick } from './tick.js';`, undefined, { filename: 'src/workflow/drivers/skill/transitions.ts' });
rule.invalid('rejects dynamic imports of drivers from flat workflow modules', `const later = import('./drivers/local/local-driver.js');`, undefined, { filename: 'src/workflow/engine.ts' });
rule.invalid('rejects restricted store symbols', `import { readRun as read } from '../../store.js';`);
rule.valid('allows what the confined tools of this machine can do', `import { confinedAccess, isConfinedTool } from '../../confined-launch.js';`);
rule.invalid('rejects the scorer judge the confined tools moved out of', `import { runLocalJudge } from '../../../scorers/judge.js';`);
rule.invalid('rejects a confined launch it does not name', `import { runConfined } from '../../confined-launch.js';`);
rule.valid('allows the usage limits the skill driver keeps between calls', `import { UsageLimits, KeptLimitSchema, type KeptLimit, type WhenIdle } from '../../usage-limits.js';`);
rule.invalid('rejects a usage-limit name the skill driver does not keep', `import { UsageLimits, isUsageLimited } from '../../usage-limits.js';`);
rule.valid('allows named protocol schemas and approved values', `import { LeaseWireSchema } from '../../lease-wire.js'; import { envAdvice } from '../../requirements.js';`);
rule.valid('allows types in transitions', `import type { Tick } from './tick.js';`, { filename: 'src/workflow/drivers/skill/transitions.ts' });
rule.valid('allows the skill driver the driver names teamai keeps', `import { RESERVED_DRIVERS } from '../../reserved-drivers.js';`);
rule.valid('allows transitions the type of a driver name teamai keeps', `import type { HostDriverName } from '../../reserved-drivers.js';`, { filename: 'src/workflow/drivers/skill/transitions.ts' });
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
rule.invalid('rejects a workflow module import of a benchmark module', `import { plan } from '../benchmark/plan.js';`, undefined, { filename: 'src/workflow/engine.ts' });
rule.valid('allows the engine to reach the place entry', `import { place } from './place/place.js';`, { filename: 'src/workflow/engine.ts' });
rule.invalid('rejects a benchmark entry from a module it does not name', `import { startBenchmark } from './benchmark/start.js';`, undefined, { filename: 'src/pull.ts' });
rule.valid('allows a benchmark entry from the module it names', `import { startBenchmark } from './benchmark/start.js';`, { filename: 'src/workflow-commands.ts' });
rule.invalid('rejects a flat workflow module import of a scorers module', `import { scoresDir } from '../scorers/home.js';`, undefined, { filename: 'src/workflow/engine.ts' });
rule.invalid('rejects a place module import of a scorers module', `import { stageEvidence } from '../../scorers/scoring-evidence.js';`, undefined, { filename: 'src/workflow/place/clone.ts' });
rule.invalid('rejects a skill driver type import of a scorers module', `import type { JudgeUsage } from '../../../scorers/label.js';`);
rule.invalid('rejects a workflow module new to the tree importing a scorers module', `import { scoresDir } from '../scorers/home.js';`, undefined, { filename: 'src/workflow/new-module.ts' });
rule.valid('allows the engine to reach scoring through its hooks', `import { verifiedScorers } from '../scorers/engine-hooks.js';`, { filename: 'src/workflow/protocol.ts' });
rule.valid('allows a test the gate questions of a fleet member', `import { gateQuestions } from '../workflow/fleet/gate.js';`, { filename: 'src/__tests__/workflow-fleet-gate.test.ts' });
rule.valid('allows the fleet member the local driver, which drives a whole workflow step it took', `import { runLocalDriver } from '../drivers/local/local-driver.js';`, { filename: 'src/workflow/fleet/member.ts' });
rule.valid('allows the command layer the fleet member', `import { takeFleetAttempt } from './workflow/fleet/member.js';`, { filename: 'src/workflow-commands.ts' });
rule.valid('allows publish the fleet records', `import { offeredPool } from './fleet/record.js';`, { filename: 'src/workflow/handoff.ts' });
rule.invalid('rejects the fleet owner from the command layer', `import { fleetCommand } from './workflow/fleet/owner.js';`, undefined, { filename: 'src/workflow-commands.ts' });
rule.invalid('rejects the fleet records from an engine module that does not read them', `import { readAttemptRecord } from './fleet/record.js';`, undefined, { filename: 'src/workflow/engine.ts' });

it('lets the skill driver import only modules that exist, so a removed module keeps no entry', () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

  /** Whether `module` resolves: a source file, or a package entry its manifest exports. */
  const resolves = (module: string): boolean => {
    if (!module.startsWith('@teamai/')) return fs.existsSync(path.join(repo, module));
    const [pkg = '', ...entry] = module.slice('@teamai/'.length).split('/');
    const exported = z.object({ exports: z.record(z.string(), z.unknown()) }).safeParse(JSON.parse(fs.readFileSync(path.join(repo, 'packages', pkg, 'package.json'), 'utf8')));

    return exported.success && Object.hasOwn(exported.data.exports, ['.', ...entry].join('/'));
  };

  for (const module of Object.keys(SKILL_IMPORTS)) expect(resolves(module), module).toBe(true);
});
