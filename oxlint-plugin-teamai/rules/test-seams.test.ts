import { expect } from 'vitest';

import { ruleHarness } from '../test/harness.ts';

const rule = ruleHarness('teamai/test-seams', { filename: 'packages/runtime-x/src/connect.test.ts' });

const pkg = { 'packages/runtime-x/package.json': JSON.stringify({ name: '@teamai/runtime-x', private: true, exports: { './serve': './src/serve.ts' } }) };

rule.valid('allows a test the module it is named after', `import { connect } from './connect.js';`, { files: pkg });

rule.valid('allows a test its package\'s test support', `import { harness } from './testing/harness.js';`, { files: pkg });

rule.valid('allows a test an entry of its package\'s exports', `import { serveRuntime } from './serve.js';`, { files: pkg });

rule.valid('leaves a test\'s imports of other packages by name alone', `import { opLedger } from '@teamai/runtime-kit/ledger';`, { files: pkg });

rule.invalid('rejects a test reaching another module of its package', `import { agentIdOf } from './runtime.js';`, (output) => {
  expect(output).toContain('packages/runtime-x/src/connect.test.ts reaches src/runtime.ts, past its package\'s seams');
  expect(output).toContain('Test it through ./connect.js');
}, { files: pkg });

rule.invalid('rejects a test in a folder reaching a module above it', `import { launch } from '../launch.js';`, (output) => {
  expect(output).toContain('reaches src/launch.ts');
}, { filename: 'packages/runtime-x/src/daemon/connect.test.ts', files: pkg });

rule.invalid('rejects a test named apart from the module it tests, with no file let off', `import { platforms } from './sessions.js';`, (output) => {
  expect(output).toContain('packages/tool-claude/src/project-dir.test.ts reaches src/sessions.ts, past its package\'s seams');
}, { filename: 'packages/tool-claude/src/project-dir.test.ts', files: { 'packages/tool-claude/package.json': JSON.stringify({ name: '@teamai/tool-claude', private: true }) } });

rule.invalid('rejects a test of a fake reaching the module it fakes past the package\'s seams', `import { launch } from '../launch.js';`, (output) => {
  expect(output).toContain('reaches src/launch.ts');
}, { filename: 'packages/tool-zzz/src/testing/fake-agent.test.ts', files: { 'packages/tool-zzz/package.json': JSON.stringify({ name: '@teamai/tool-zzz', private: true }) } });
