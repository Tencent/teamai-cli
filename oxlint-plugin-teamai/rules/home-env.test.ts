import { expect } from 'vitest';

import { ruleHarness } from '../test/harness.ts';

const rule = ruleHarness('teamai/home-env', { filename: 'src/utils/home.ts' });

rule.valid('allows the canonical home resolver to read HOME', `
export function getUserHome(): string {
  return process.env.HOME || 'fallback';
}
`);

rule.valid('allows the legacy test fixture that scans source text', `
const source = 'process.env.HOME';
`, { filename: 'src/__tests__/home.test.ts' });

rule.valid('allows unrelated environment variables elsewhere', `
export function getConfigDir(): string | undefined {
  return process.env.XDG_CONFIG_HOME;
}
`, { filename: 'src/config.ts' });

rule.valid('does not treat a computed environment variable name as HOME', `
const HOME = 'XDG_CONFIG_HOME';
export const configDir = process.env[HOME];
`, { filename: 'src/config.ts' });

rule.invalid('rejects a computed HOME string literal', `
export const home = process.env['HOME'];
`, undefined, { filename: 'src/config.ts' });

rule.invalid('rejects a direct HOME read outside the canonical resolver', `
export function cacheDir(): string {
  return process.env.HOME + '/.cache/teamai';
}
`, (output) => {
  expect(output).toContain('getUserHome()');
}, { filename: 'src/cache.ts' });

rule.invalid('reports each direct HOME member access', `
const first = process.env.HOME;
const second = process.env.HOME;
`, (output) => {
  expect(output).toContain('2 errors');
}, { filename: 'src/paths.ts' });
