import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const ROOT = path.join(import.meta.dirname, '../..');
const SEEDED = ['CLAUDE_CODE_SESSION_ID', 'TEAMAI_WORKFLOW_ATTEMPT'];
const ConfigSchema = z.object({ default: z.object({ test: z.object({ env: z.record(z.string()) }) }) });

describe('the test environment', () => {
  it.each(['vitest.config.ts', 'vitest.e2e.config.ts'])('%s seeds an agent session and a workflow attempt for the scrub to remove', async (file) => {
    const { default: { test } } = ConfigSchema.parse(await import(path.join(ROOT, file)));
    expect(Object.keys(test.env)).toEqual(expect.arrayContaining(SEEDED));
  });

  it('starts every test with neither set', () => {
    expect(SEEDED.filter((name) => process.env[name] !== undefined)).toEqual([]);
  });
});
