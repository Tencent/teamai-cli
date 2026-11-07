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
  rule.invalid('rejects a print-mode call of a tool binary', `spawn('claude', ['-p', prompt]);`);
  rule.invalid('rejects a call of a tool binary through any process helper', `await execCommand('codex', ['exec', prompt], { cwd });`);
  rule.invalid('rejects a tool binary whose arguments it cannot read', `crossSpawn('cursor-agent', args);`);
  rule.invalid('rejects a tool binary given a subcommand it may not run', `crossSpawn('opencode', ['run', prompt]);`);
  rule.valid('allows asking a tool binary its version', `probeBinary('claude', ['--version'], executor); probeBinary('opencode');`, { filename: 'src/pkg/env-detect.ts' });
  rule.valid('allows serving and reading opencode sessions', `crossSpawn('opencode', ['serve', '--port', port]); execCommand('opencode', ['session', 'list']);`);
  rule.valid('allows a call that names a tool and starts no process', `toolHome('agy'); reconcileHooks('claude', []);`);
  rule.invalid('rejects a tool binary run through a method of a process helper', `await this.execute('claude', ['-p', prompt]);`);
  rule.valid('allows a workflow driver to run a tool binary', `spawn('claude', ['-p', prompt]);`, { filename: 'src/workflow/drivers/local/feature.ts' });
  rule.valid('allows tests to drive the launcher', `vi.mock('../tool-launch/call.js'); import { callTool } from '../tool-launch/call.js';`, { filename: 'src/__tests__/feature.test.ts' });
});
