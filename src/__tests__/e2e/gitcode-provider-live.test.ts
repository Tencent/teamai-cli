import { describe, it, expect } from 'vitest';
import { GitCodeProvider } from '../../providers/gitcode/index.js';

/**
 * Opt-in live GitCode test. Skipped unless GITCODE_TOKEN is set.
 *
 * Run with:  GITCODE_TOKEN=xxx npx vitest run src/__tests__/e2e/gitcode-provider-live.test.ts
 */
const RUN = !!process.env.GITCODE_TOKEN;

describe.skipIf(!RUN)('GitCode provider (live)', () => {
  it('whoami returns a username', async () => {
    const provider = new GitCodeProvider();
    const name = await provider.authenticate();
    expect(name).toBeTruthy();
  });
});
