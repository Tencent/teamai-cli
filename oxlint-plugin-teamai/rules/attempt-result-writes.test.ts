import { describe, expect } from 'vitest';

import { ruleHarness } from '../test/harness.ts';

const rule = ruleHarness('teamai/attempt-result-writes', { filename: 'src/workflow/drivers/local/local-driver.ts' });

describe('teamai/attempt-result-writes', () => {
  rule.invalid('reports a write to attemptResultPath(...), naming AttemptResult.write', `
import { writeJsonAtomic } from '../../../utils/fs.js';
import { attemptResultPath } from '../../store.js';
export async function keep(config: never, run: never, attempt: never, output: string): Promise<void> {
  await writeJsonAtomic(attemptResultPath(config, run, attempt), { output });
}
`, (output) => {
    expect(output).toContain('AttemptResult.write(file, body, secrets)');
  });

  rule.invalid('reports a write to a name bound to attemptResultPath(...)', `
import fs from 'node:fs/promises';
import { attemptResultPath } from '../../store.js';
export async function keep(config: never, run: never, attempt: never, text: string): Promise<void> {
  const resultFile = attemptResultPath(config, run, attempt);
  await fs.writeFile(resultFile, text);
}
`, (output) => {
    expect(output).toContain('a bare writeFile(');
  });

  rule.invalid('reports a write to the resultPath a tool launch carries', `
import { writeJsonAtomic } from '../../../utils/fs.js';
export async function keep(input: { resultPath: string }, output: string): Promise<void> {
  await writeJsonAtomic(input.resultPath, { output });
}
`, undefined, { filename: 'src/workflow/drivers/local/local-tool-adapter.ts' });

  rule.valid('allows the write through AttemptResult.write', `
import { AttemptResult } from '../../attempt-result.js';
import { attemptResultPath } from '../../store.js';
export async function keep(config: never, run: never, attempt: never, output: string, secrets: Record<string, string>): Promise<void> {
  await AttemptResult.write(attemptResultPath(config, run, attempt), { output }, secrets);
}
`);

  rule.valid('allows writes to other files', `
import { writeJsonAtomic } from '../../../utils/fs.js';
import { attemptDir } from '../../store.js';
export async function keep(config: never, run: never, attempt: never): Promise<void> {
  await writeJsonAtomic(attemptDir(config, run, attempt) + '/job.json', {});
}
`);

  rule.valid('allows the owner module its own writes', `
import { writeJsonAtomic } from '../utils/fs.js';
export async function write(resultPath: string): Promise<void> {
  await writeJsonAtomic(resultPath, {});
}
`, { filename: 'src/workflow/attempt-result.ts' });

  rule.valid('leaves tests, which write result files as tools do, alone', `
import fs from 'node:fs';
export function prewrite(resultPath: string): void {
  fs.writeFileSync(resultPath, '{}');
}
`, { filename: 'src/__tests__/workflow-local-tool-adapter.test.ts' });
});
