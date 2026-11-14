import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TOOLS } from '../tools.js';
import { homeVariables, isToolId } from '../tool-registry.js';
import { RELOCATABLE_TOOLS } from '../types.js';
import { toolRootVariables } from './helpers/tool-root-vars.js';

const ROOT = path.join(import.meta.dirname, '../..');
const SEEDED = ['CLAUDE_CODE_SESSION_ID', 'TEAMAI_WORKFLOW_ATTEMPT', 'TEAMAI_MODE', 'CI', 'BASH_ENV'];
// The roots `init` records in `toolRoots`. The scrub used to read only `TOOLS[tool].home.moves`,
// which names none of these, so a shell that set one wrote the team's resources into the
// developer's own tool home.
const RECORDED_ROOTS = Object.values(RELOCATABLE_TOOLS).map(({ envVar }) => envVar);
const ConfigSchema = z.object({ default: z.object({ test: z.object({ env: z.record(z.string(), z.string()) }) }) });

describe('the test environment', () => {
  it.each(['vitest.config.ts', 'vitest.e2e.config.ts'])('%s seeds an agent session, a workflow attempt, a run mode and a bash startup file for the scrub to remove', async (file) => {
    const { default: { test } } = ConfigSchema.parse(await import(path.join(ROOT, file)));
    expect(Object.keys(test.env)).toEqual(expect.arrayContaining(SEEDED));
  });

  it('starts every test with none of them set', () => {
    expect(SEEDED.filter((name) => process.env[name] !== undefined)).toEqual([]);
  });

  it.each(['vitest.config.ts', 'vitest.e2e.config.ts'])('%s seeds every root a shell records, so the scrub removing each one is proven rather than assumed', async (file) => {
    const { default: { test } } = ConfigSchema.parse(await import(path.join(ROOT, file)));
    expect(Object.keys(test.env)).toEqual(expect.arrayContaining(RECORDED_ROOTS));
  });

  it('starts every test with no recorded root set', () => {
    expect(RECORDED_ROOTS.filter((name) => process.env[name] !== undefined)).toEqual([]);
  });

  it('scrubs both ways a root moves: the recorded roots and every home a tool descriptor moves', () => {
    expect(toolRootVariables()).toEqual(expect.arrayContaining([
      ...RECORDED_ROOTS,
      ...Object.keys(TOOLS).filter(isToolId).flatMap(homeVariables),
    ]));
  });
});
