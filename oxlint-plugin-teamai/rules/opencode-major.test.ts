import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { ruleHarness } from '../test/harness.ts';
import { isProductionSource } from '../utils.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const rule = ruleHarness('teamai/opencode-major', { filename: 'packages/tool-launch/src/run-step-launch.ts' });

rule.invalid('rejects a major taken when the launch does not ask', `const opencodeMajor = opencode && interactive ? await host.opencodeMajor(executable) : 1;`,
  (output) => { expect(output).toContain('ASSUMED_OPENCODE_MAJOR'); });
rule.invalid('rejects a host that answers a major of its own', `const IN_SANDBOX = { opencodeMajor: async () => 1, writeResult: async () => {} };`);
rule.invalid('rejects a host whose answer returns a major', `const host = { async opencodeMajor() { return 2; } };`);
rule.invalid('rejects a major given in an argument object', `confinedArgs({ family: 'opencode', opencodeMajor: effort ? await deps.opencodeMajor(executable) : 2 });`);
rule.invalid('rejects a major behind a fallback', `const opencodeMajor = probed ?? 1;`);
rule.invalid('rejects a major assigned later', `let opencodeMajor: number;\nopencodeMajor = 1;`);
rule.invalid('rejects a major as a default', `function launch({ opencodeMajor = 2 }: { opencodeMajor?: number }) { return opencodeMajor; }`);
rule.invalid('rejects a function declaration that returns a major', `async function opencodeMajor() { return 1; }\nexport const host = { opencodeMajor };`);
rule.invalid('rejects a major returned from a branch', `const host = { async opencodeMajor(executable: string) { if (!executable) return 1; return probe(executable); } };`);
rule.invalid('rejects a major returned from a catch', `const host = { async opencodeMajor() { try { return await probe(); } catch { return 1; } } };`);
rule.invalid('rejects a major returned from a switch', `const host = { opencodeMajor(kind: string) { switch (kind) { case 'old': return 1; default: return probe(); } } };`);
rule.invalid('rejects a major behind a non-null fallback', `const opencodeMajor = (probed ?? 1)!;`);
rule.invalid('holds src/ too', `export const input = { prompt, opencodeMajor: 2 };`, undefined, { filename: 'src/workflow/runtimes/tool-caller.ts' });
rule.invalid('holds a package added later, with no rule edit', `const opencodeMajor = 1;`, undefined, { filename: 'packages/runtime-newcomer/src/launch.ts' });
rule.valid('allows the assumed major', `const opencodeMajor = opencode ? await host.opencodeMajor(executable) : ASSUMED_OPENCODE_MAJOR;`);
rule.valid('allows a major the host reads', `const IN_SANDBOX = { opencodeMajor: async () => ASSUMED_OPENCODE_MAJOR };`);
rule.valid('allows a feature threshold, which is a fact of a version and no assumption', `const standalone = (opencodeMajor: number) => (opencodeMajor >= 2 ? ['--standalone'] : []);`);
rule.valid('allows a major compared in a condition or a case', `async function opencodeMajor(executable: string) { const read = await probe(executable); if (read === 1) return read; switch (read) { case 2: return read; default: return read; } }`);
rule.valid('allows a literal no major is named after', `const retries = opencode ? 1 : 2;`);
rule.valid('leaves a test that pins the version it means alone', `const host = { opencodeMajor: async () => 1 };`, { filename: 'packages/tool-launch/src/run-step-launch.test.ts' });
rule.valid('leaves the E2E suite alone', `const host = { opencodeMajor: async () => 1 };`, { filename: 'src/__tests__/e2e/opencode.test.ts' });

it('holds every production file that names an OpenCode major, packages included, and no test', () => {
  const files = execFileSync('git', ['grep', '-l', 'opencodeMajor', '--', 'src', 'packages'], { cwd: REPO, encoding: 'utf8' }).split('\n').filter((file) => /\.[cm]?tsx?$/.test(file));
  const matched = files.filter(isProductionSource);

  expect(matched).toEqual(expect.arrayContaining(['packages/tool-launch/src/run-step-launch.ts', 'packages/runtime-sandbox/src/step.ts', 'packages/runtime-tools/src/confined.ts']));
  expect(matched.filter((file) => /\.test\.|\/__tests__\//.test(file))).toEqual([]);
});

it('is an error in this checkout, with no file let off', () => {
  const config = fs.readFileSync(path.join(REPO, '.oxlintrc.json'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  const parsed = z.object({ rules: z.record(z.string(), z.unknown()), overrides: z.array(z.object({ rules: z.record(z.string(), z.unknown()) })) }).parse(JSON.parse(config));

  expect(parsed.rules['teamai/opencode-major']).toBe('error');
  expect(parsed.overrides.filter((override) => 'teamai/opencode-major' in override.rules)).toEqual([]);
});
