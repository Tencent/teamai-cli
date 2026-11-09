import { describe, expect } from 'vitest';
import { ruleHarness } from '../test/harness.ts';

const rule = ruleHarness('teamai/uncached-entry', { filename: 'src/hook-fast-path.ts' });

describe('teamai/uncached-entry', () => {
  rule.invalid('rejects a package import in the fast path', `import { z } from 'zod';`, (output) => {
    expect(output).toContain('runs before the CLI bundle loads');
  });
  rule.invalid('rejects a bundle module in the fast path', `import { log } from './utils/logger.js';`);
  rule.invalid('rejects a dynamic import of a bundle module', `const { TOOLS } = await import('./tools.js');`);
  rule.invalid('rejects a re-export of a bundle module', `export { launchedBy } from './launch-context.js';`);
  rule.invalid('rejects a bundle module in the entry', `import { log } from './utils/logger.js';`, undefined, { filename: 'src/bin.ts' });
  rule.invalid('rejects a bundle module in a helper the entry loads', `import { getCurrentVersion } from '../package-info.js';`, undefined, { filename: 'src/utils/debug-log.ts' });
  rule.valid('allows node modules and the other uncached files', `import fs from 'node:fs'; import { writeToFile } from './utils/debug-log.js'; import { readStdin } from './utils/hook-stdin.js';`);
  rule.valid('allows a type-only import, which the build erases', `import type { HookEvent } from './hook-dispatch.js';`);
  rule.valid('allows the entry to load the CLI by URL', `await import(new URL('./cli.js', import.meta.url).href);`, { filename: 'src/bin.ts' });
  rule.valid('leaves the bundle\'s own modules alone', `import { z } from 'zod';`, { filename: 'src/hook-dispatch-cli.ts' });
});
