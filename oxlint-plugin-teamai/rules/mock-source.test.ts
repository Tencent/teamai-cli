import { expect } from 'vitest';

import { ruleHarness } from '../test/harness.ts';

const rule = ruleHarness('teamai/mock-source', { filename: 'src/__tests__/pull.test.ts' });
const shim = { 'src/utils/log-forward.ts': `export * from '@teamai/shared/log';\n` };

rule.invalid('rejects mocking a module that only re-exports a package', `vi.mock('../utils/log-forward.js', () => ({ log: { info: vi.fn() } }));`, (output) => {
  expect(output).toContain(`'../utils/log-forward.js' only re-exports '@teamai/shared/log'`);
  expect(output).toContain(`vi.mock('@teamai/shared/log')`);
}, { files: shim });

rule.invalid('rejects vi.doMock of a re-export', `vi.doMock('../utils/log-forward.js');`, undefined, { files: shim });

rule.invalid('resolves a specifier written without an extension', `vi.mock('../utils/log-forward');`, undefined, { files: shim });

rule.invalid('resolves a specifier written with .ts', `vi.mock('../utils/log-forward.ts');`, undefined, { files: shim });

rule.invalid('resolves a directory to its index', `vi.mock('../utils/log');`, (output) => {
  expect(output).toContain(`vi.mock('@teamai/shared/log')`);
}, { files: { 'src/utils/log/index.ts': `export * from '@teamai/shared/log';\n` } });

rule.invalid('rejects a re-export of a relative module, naming it from the test', `vi.mock('../utils/run.js');`, (output) => {
  expect(output).toContain(`vi.mock('../process/exec.js')`);
}, { files: { 'src/utils/run.ts': `// Moved.\nexport * from '../process/exec.js';\n` } });

rule.valid('allows mocking the package module', `vi.mock('@teamai/shared/log', () => ({ log: { info: vi.fn() } }));`, { files: shim });

rule.valid('allows mocking a module with code of its own', `vi.mock('../utils/parse.js');`, {
  files: { 'src/utils/parse.ts': `export * from 'yaml';\nexport const parseYaml = (text: string) => text;\n` },
});

rule.invalid('rejects a module that re-exports named bindings', `vi.mock('../utils/user-home.js');`, (output) => {
  expect(output).toContain(`vi.mock('@teamai/shared/home')`);
}, { files: { 'src/utils/user-home.ts': `export { homeDir } from '@teamai/shared/home';\nexport type { Home } from '@teamai/shared/home';\n` } });

rule.valid('allows mocking a barrel over several modules', `vi.mock('../session-flow/index.js');`, {
  files: { 'src/session-flow/index.ts': `export * from './sync.js';\nexport * from './scrub.js';\n` },
});

rule.valid('leaves a mock of a missing file to vitest', `vi.mock('../utils/gone.js');`);
