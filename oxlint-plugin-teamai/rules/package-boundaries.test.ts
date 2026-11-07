import { expect } from 'vitest';

import { ruleHarness } from '../test/harness.ts';

const rule = ruleHarness('teamai/package-boundaries', { filename: 'packages/tool-core/src/sessions.ts' });

const workspace = {
  'package.json': JSON.stringify({ name: 'teamai-cli', workspaces: ['packages/*'] }),
  'packages/tool-core/package.json': JSON.stringify({ name: '@teamai/tool-core', private: true }),
  'packages/tool-core/src/definition.ts': 'export const definition = 1;',
  'packages/runtime-sandbox/package.json': JSON.stringify({ name: '@teamai/runtime-sandbox', private: true }),
  'src/locate.ts': 'export const locate = 1;',
  'scripts/check-docs.mjs': 'export const check = 1;',
};
const inWorkspace = (filename: string, files: Readonly<Record<string, string>> = {}) => ({ filename, files: { ...workspace, ...files } });

rule.invalid('rejects a package importing src/', `import { locate } from '../../../src/locate.js';`, (output) => {
  expect(output).toContain('A workspace package imports only its own files and other workspace packages by name');
  expect(output).toContain('packages/tool-core/src/sessions.ts -> src/locate.js');
}, inWorkspace('packages/tool-core/src/sessions.ts'));

rule.invalid('rejects a type-only import of src/ from a package', `import type { Locate } from '../../../src/locate.js';`, undefined, inWorkspace('packages/tool-core/src/sessions.ts'));

rule.invalid('rejects a package test importing src/', `import { locate } from '../../../src/locate.js';`, undefined, inWorkspace('packages/tool-core/src/sessions.test.ts'));

rule.invalid('rejects a package importing a repository script', `import { check } from '../../../scripts/check-docs.mjs';`, undefined, inWorkspace('packages/tool-core/src/sessions.ts'));

rule.invalid('rejects a package mocking src/', `vi.mock('../../../src/locate.js');`, undefined, inWorkspace('packages/tool-core/src/sessions.test.ts'));

rule.invalid('rejects a relative import into another package', `import { definition } from '../../tool-core/src/definition.js';`, (output) => {
  expect(output).toContain('Import a workspace package by its package name');
  expect(output).toContain('@teamai/tool-core');
}, inWorkspace('packages/runtime-sandbox/src/index.ts'));

rule.invalid('rejects a relative import from src/ into a package', `import { definition } from '../packages/tool-core/src/definition.js';`, (output) => {
  expect(output).toContain('@teamai/tool-core');
}, inWorkspace('src/tools.ts'));

rule.invalid('rejects src/ importing a runtime package', `import { runtime } from '@teamai/runtime-sandbox';`, (output) => {
  expect(output).toContain('src/ never imports a runtime package');
  expect(output).toContain('src/workflow/engine.ts -> @teamai/runtime-sandbox');
}, inWorkspace('src/workflow/engine.ts'));

rule.invalid('rejects src/ importing a runtime package subpath', `export { runtime } from '@teamai/runtime-sandbox/protocol';`, undefined, inWorkspace('src/workflow/engine.ts'));

rule.invalid('rejects src/ loading a runtime package dynamically', `export const load = () => import('@teamai/runtime-sandbox');`, undefined, inWorkspace('src/workflow/engine.ts'));

rule.invalid('rejects a unit test importing a runtime package', `vi.mock('@teamai/runtime-sandbox');`, undefined, inWorkspace('src/__tests__/engine.test.ts'));

rule.invalid('rejects a file in a package that is not private', `export const definition = 1;`, (output) => {
  expect(output).toContain('A workspace package is private');
  expect(output).toContain('packages/tool-public/package.json');
}, inWorkspace('packages/tool-public/src/index.ts', { 'packages/tool-public/package.json': JSON.stringify({ name: '@teamai/tool-public' }) }));

rule.invalid('rejects a file in a packages/ folder with no package.json', `export const definition = 1;`, (output) => {
  expect(output).toContain('packages/tool-orphan/package.json');
}, inWorkspace('packages/tool-orphan/src/index.ts'));

rule.valid('allows a package importing its own files', `import { definition } from './definition.js';`, inWorkspace('packages/tool-core/src/sessions.ts'));

rule.valid('allows a package importing another package by name', `import { definition } from '@teamai/tool-core/definition';`, inWorkspace('packages/runtime-sandbox/src/index.ts'));

rule.valid('allows src/ importing a package that is not a runtime', `import { definition } from '@teamai/tool-core/definition';`, inWorkspace('src/tools.ts'));

rule.valid('allows src/ importing src/', `import { locate } from './locate.js';`, inWorkspace('src/tools.ts'));

rule.valid('leaves a checkout without workspaces alone', `import { locate } from '../../../src/locate.js';`, { filename: 'packages/tool-core/src/sessions.ts' });
