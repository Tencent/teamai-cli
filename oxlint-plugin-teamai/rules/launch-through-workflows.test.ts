import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ruleHarness } from '../test/harness.ts';
import { ALLOWED, LAUNCHERS } from './launch-through-workflows.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const rule = ruleHarness('teamai/launch-through-workflows', { filename: 'src/feature.ts' });

describe('teamai/launch-through-workflows', () => {
  rule.invalid('rejects a static import of the AI call', `import { createToolCaller } from './workflow/runtimes/tool-caller.js';`, (output) => {
    expect(output).toContain('docs/designs/ai-through-workflows.md');
  });
  rule.invalid('rejects a dynamic import of the AI call', `const { createToolCaller } = await import('./workflow/runtimes/tool-caller.js');`);
  rule.invalid('rejects a re-export of the AI call', `export { createToolCaller } from './workflow/runtimes/tool-caller.js';`);
  rule.invalid('rejects a confined launch', `import { runConfined } from './workflow/confined-launch.js';`);
  rule.invalid('rejects a renamed confined launch', `import { runConfined as launch } from './workflow/confined-launch.js';`);
  rule.invalid('rejects a dynamic import of the confined tools, which may launch one', `const confined = await import('./workflow/confined-launch.js');`);
  rule.valid('allows what the confined tools of this machine can do', `import { installedConfinedTools, type ConfinedResult } from './workflow/confined-launch.js';`);
  rule.valid('allows the tool a member names and the error a bad one raises', `import { CallError, isOverrideInvalid, memberTools } from './workflow/member-tools.js';`);
  rule.valid('allows the types of an AI call', `import type { CallResult } from './workflow/runtimes/tool-caller.js';`);
  rule.invalid('rejects the launch library from a scorer', `import { callLaunch } from '@teamai/tool-launch/call-launch';`, undefined, { filename: 'src/scorers/x.ts' });
  rule.invalid('rejects the tools runtime\'s answer launch outside a workflow driver', `import { answerLaunch } from '@teamai/runtime-tools/answer';`, undefined, { filename: 'src/x.ts' });
  rule.invalid('rejects the tools runtime itself outside a workflow driver', `import { toolsStepRuntime } from '@teamai/runtime-tools';`, undefined, { filename: 'src/x.ts' });
  rule.invalid('rejects a launcher from a folder no one has listed yet', `import { runTool } from '@teamai/runtime-tools/headless';`, undefined, { filename: 'src/brand-new/x.ts' });
  rule.valid('allows the sandbox runtime the launch library', `import { runStepLaunch } from '@teamai/tool-launch/run-step-launch';`, { filename: 'packages/runtime-sandbox/src/prompt.ts' });
  rule.valid('allows the tools runtime the launch library', `import { callLaunch } from '@teamai/tool-launch/call-launch';`, { filename: 'packages/runtime-tools/src/answer.ts' });
  rule.valid('allows a workflow driver to launch', `import { runConfined } from '../../confined-launch.js'; import { answerLaunch } from '@teamai/runtime-tools/answer';`, { filename: 'src/workflow/drivers/local/feature.ts' });
  rule.valid('allows the types of the launch library and of the tools runtime anywhere', `import type { CallEnd } from '@teamai/tool-launch/call-launch'; import type { StepLauncher } from '@teamai/runtime-tools';`, { filename: 'src/scorers/x.ts' });
  rule.valid('allows other workspace packages', `import { spawnCommand } from '@teamai/shared/exec';`);
  rule.invalid('rejects a print-mode call of a tool binary', `spawn('claude', ['-p', prompt]);`);
  rule.invalid('rejects a call of a tool binary through any process helper', `await execCommand('codex', ['exec', prompt], { cwd });`);
  rule.invalid('rejects a tool binary whose arguments it cannot read', `crossSpawn('cursor-agent', args);`);
  rule.invalid('rejects a tool binary given a subcommand it may not run', `crossSpawn('opencode', ['run', prompt]);`);
  rule.valid('allows asking a tool binary its version', `probeBinary('claude', ['--version'], executor); probeBinary('opencode');`, { filename: 'src/pkg/env-detect.ts' });
  rule.valid('allows serving and reading opencode sessions', `crossSpawn('opencode', ['serve', '--port', port]); execCommand('opencode', ['session', 'list']);`);
  rule.valid('allows a call that names a tool and starts no process', `toolHome('agy'); reconcileHooks('claude', []);`);
  rule.invalid('rejects a tool binary run through a method of a process helper', `await this.execute('claude', ['-p', prompt]);`);
  rule.valid('allows a workflow driver to run a tool binary', `spawn('claude', ['-p', prompt]);`, { filename: 'src/workflow/drivers/local/feature.ts' });
  rule.valid('allows tests to drive the launcher', `vi.mock('../workflow/runtimes/tool-caller.js'); import { createToolCaller } from '../workflow/runtimes/tool-caller.js';`, { filename: 'src/__tests__/feature.test.ts' });
});

describe('what the rule lists', () => {
  it('names only folders that exist, so an emptied folder keeps no exemption', () => {
    for (const folder of ALLOWED) expect(fs.statSync(path.join(REPO, folder)).isDirectory(), folder).toBe(true);
  });

  it('names only launchers that resolve, a module to its file and a package to its manifest', () => {
    for (const launcher of Object.keys(LAUNCHERS)) {
      const file = launcher.startsWith('@teamai/') ? path.join(REPO, 'packages', launcher.slice('@teamai/'.length), 'package.json') : path.join(REPO, launcher);

      expect(fs.existsSync(file), launcher).toBe(true);
    }
  });
});
