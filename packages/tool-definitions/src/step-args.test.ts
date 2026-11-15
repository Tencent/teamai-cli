import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BUILT_IN_TOOLS } from './registry.js';

// What each family launched a workflow step with before its argv moved into the family, recorded from that code: the
// expected argv is never derived from the code under test.
const Row = z.object({
  tool: z.enum(['claude', 'codebuddy', 'codex', 'opencode', 'agy']),
  case: z.string(),
  interactive: z.boolean(),
  opencodeMajor: z.number(),
  platform: z.enum(['posix', 'win32']),
  input: z.object({
    prompt: z.string(),
    resultDir: z.string(),
    resume: z.string().optional(),
    maxTurns: z.number().optional(),
    model: z.string().optional(),
    effort: z.string().optional(),
    agent: z.object({ name: z.string(), model: z.string().optional(), inPrompt: z.boolean() }).strict().optional(),
    unattended: z.literal(true).optional(),
    streamsUsage: z.boolean(),
  }).strict(),
  argv: z.array(z.string()),
}).strict();

const rows = z.array(Row).parse(JSON.parse(fs.readFileSync(new URL('./fixtures/step-args.golden.json', import.meta.url), 'utf8')));

const STEPS = {
  claude: BUILT_IN_TOOLS.claude.launch.claude.step,
  codebuddy: BUILT_IN_TOOLS.codebuddy.launch.codebuddy.step,
  codex: BUILT_IN_TOOLS.codex.launch.codex.step,
  opencode: BUILT_IN_TOOLS.opencode.launch.opencode.step,
  agy: BUILT_IN_TOOLS.agy.launch.agy.step,
};

const platform = process.platform;

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
});

describe('a workflow step argv, built by its family', () => {
  it('covers each family headless and interactive on POSIX and Windows', () => {
    const covered = new Set(rows.map((row) => `${row.tool} ${row.interactive} ${row.platform}`));

    expect(covered.size).toBe(Object.keys(STEPS).length * 2 * 2);
  });

  it.each(rows.map((row) => [`${row.tool} ${row.interactive ? 'interactive' : 'headless'} ${row.case} (opencode ${row.opencodeMajor}, ${row.platform})`, row] as const))('%s', (_name, row) => {
    if (row.platform === 'win32') Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    expect(STEPS[row.tool].args(row.input, { interactive: row.interactive, opencodeMajor: row.opencodeMajor })).toEqual(row.argv);
  });
});
