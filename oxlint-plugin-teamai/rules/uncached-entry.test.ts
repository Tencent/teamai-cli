import { describe, expect } from 'vitest';
import { ruleHarness } from '../test/harness.ts';

const rule = ruleHarness('teamai/uncached-entry', { filename: 'src/hook-fast-path.ts' });

const workspace = {
  'package.json': JSON.stringify({ name: 'teamai-cli', workspaces: ['packages/*'] }),
  'packages/shared/package.json': JSON.stringify({ name: '@teamai/shared', private: true, exports: { './debug-log': './src/debug-log.ts', './home': './src/home.ts', './log': './src/log.ts' } }),
};
const inWorkspace = (filename: string) => ({ filename, files: workspace });

describe('teamai/uncached-entry', () => {
  rule.invalid('rejects a package import in the fast path', `import { z } from 'zod';`, (output) => {
    expect(output).toContain('runs before the CLI bundle loads');
  });
  rule.invalid('rejects a bundle module in the fast path', `import { log } from './utils/fs.js';`);
  rule.invalid('rejects a dynamic import of a bundle module', `const { TOOLS } = await import('./tools.js');`);
  rule.invalid('rejects a re-export of a bundle module', `export { launchedBy } from './launch-context.js';`);
  rule.invalid('rejects a bundle module in the entry', `import { log } from './utils/fs.js';`, undefined, { filename: 'src/bin.ts' });
  rule.invalid('rejects a bundle module in a helper the entry loads', `import { getCurrentVersion } from '../../../src/package-info.js';`, undefined, inWorkspace('packages/shared/src/debug-log.ts'));
  rule.invalid('rejects a workspace package module outside UNCACHED', `import { log } from '@teamai/shared/log';`, (output) => {
    expect(output).toContain('Import @teamai/shared/log from code the CLI bundle runs instead');
  }, inWorkspace('src/hook-fast-path.ts'));
  rule.invalid('rejects a workspace package subpath its exports map does not name', `import { home } from '@teamai/shared/home-extra';`, undefined, inWorkspace('src/hook-fast-path.ts'));
  rule.valid('allows node modules and the other uncached files', `import fs from 'node:fs'; import { writeToFile } from '@teamai/shared/debug-log'; import { getUserHome } from '@teamai/shared/home'; import { readStdin } from './utils/hook-stdin.js';`, inWorkspace('src/hook-fast-path.ts'));
  rule.valid('allows an uncached package file to import another by its relative path', `import { getUserHome } from './home.js';`, inWorkspace('packages/shared/src/debug-log.ts'));
  rule.valid('allows a type-only import, which the build erases', `import type { HookEvent } from './hook-dispatch.js';`);
  rule.valid('allows the entry to load the CLI by URL', `await import(new URL('./cli.js', import.meta.url).href);`, { filename: 'src/bin.ts' });
  rule.valid('leaves the bundle\'s own modules alone', `import { z } from 'zod';`, { filename: 'src/hook-dispatch-cli.ts' });
  rule.valid('leaves a package file named like an uncached src/ file alone', `import { z } from 'zod';`, inWorkspace('packages/tool-core/src/bin.ts'));
});
