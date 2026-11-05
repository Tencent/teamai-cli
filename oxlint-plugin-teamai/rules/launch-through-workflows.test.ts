import { describe, expect } from 'vitest';
import { ruleHarness } from '../test/harness.ts';

const rule = ruleHarness('teamai/launch-through-workflows', { filename: 'src/feature.ts' });

describe('teamai/launch-through-workflows', () => {
  rule.invalid('rejects a static import of the AI call', `import { callTool } from './tool-launch/call.js';`, (output) => {
    expect(output).toContain('docs/designs/ai-through-workflows.md');
  });
  rule.invalid('rejects a dynamic import of the AI call', `const { callTool } = await import('./tool-launch/call.js');`);
  rule.invalid('rejects a re-export of the AI call', `export { callToolParallel } from './tool-launch/call.js';`);
  rule.invalid('rejects the process runner', `import { runTool } from '../tool-launch/run.js';`, undefined, { filename: 'src/scorers/feature.ts' });
  rule.invalid('rejects a confined launch', `import { runConfined } from './tool-launch/confined.js';`);
  rule.invalid('rejects a renamed confined launch', `import { runConfined as launch } from './tool-launch/confined.js';`);
  rule.invalid('rejects a dynamic import of the confined tools, which may launch one', `const confined = await import('./tool-launch/confined.js');`);
  rule.valid('allows what the confined tools of this machine can do', `import { installedConfinedTools, type ConfinedResult } from './tool-launch/confined.js';`);
  rule.valid('allows the tool a member names and the error a bad one raises', `import { CallError, isOverrideInvalid, memberTools } from './tool-launch/member-tools.js';`);
  rule.valid('allows the types of an AI call', `import type { CallResult } from './tool-launch/call.js';`);
  rule.valid('allows a workflow driver to launch', `import { runConfined } from '../../../tool-launch/confined.js'; import { runTool } from '../../../tool-launch/run.js';`, { filename: 'src/workflow/drivers/local/feature.ts' });
  rule.valid('allows the launcher its own modules', `import { runTool } from './run.js';`, { filename: 'src/tool-launch/call.ts' });
  rule.valid('allows tests to drive the launcher', `vi.mock('../tool-launch/call.js'); import { callTool } from '../tool-launch/call.js';`, { filename: 'src/__tests__/feature.test.ts' });
  rule.valid('allows a caller in the baseline', `import { callTool } from './tool-launch/call.js';`, { filename: 'src/import-local.ts' });
  rule.valid('allows a dynamic import in a baseline caller', `const { callTool } = await import('./tool-launch/call.js');`, { filename: 'src/import-mr.ts' });
  rule.invalid('reports a baseline caller that no longer launches', `import { isOverrideInvalid } from './tool-launch/member-tools.js';`, (output) => {
    expect(output).toContain('BASELINE');
  }, { filename: 'src/import-local.ts' });
});
