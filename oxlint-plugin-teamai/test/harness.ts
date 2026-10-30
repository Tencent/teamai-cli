import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, it } from 'vitest';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OXLINT = path.join(PLUGIN_ROOT, '..', 'node_modules', '.bin', process.platform === 'win32' ? 'oxlint.cmd' : 'oxlint');

interface RuleHarness {
  /** The source lints clean with only this rule on. */
  readonly valid: (name: string, source: string, options?: { filename?: string }) => void;
  /** The source fails this rule; `assertion` checks the reported output. */
  readonly invalid: (name: string, source: string, assertion?: (output: string) => void, options?: { filename?: string }) => void;
}

/**
 * Run one rule of the teamai plugin through the real oxlint, on a fixture
 * written at `filename` (relative, like a path in this repository), with only
 * that rule enabled.
 */
export function ruleHarness(rule: `teamai/${string}`, defaults: { filename: string }): RuleHarness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-oxlint-rule-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  let fixtures = 0;

  const lint = (source: string, filename: string): { status: number | null; output: string } => {
    const root = path.join(dir, String(fixtures++));
    const file = path.join(root, filename);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
    const config = path.join(root, '.oxlintrc.json');
    fs.writeFileSync(config, JSON.stringify({
      jsPlugins: [path.join(PLUGIN_ROOT, 'index.js')],
      categories: { correctness: 'off' },
      rules: { [rule]: 'error' },
    }));
    const result = spawnSync(OXLINT, ['-c', config, file], { encoding: 'utf8', shell: process.platform === 'win32' });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  };

  return {
    valid: (name, source, options) => {
      it(`valid: ${name}`, () => {
        const { status, output } = lint(source, options?.filename ?? defaults.filename);
        expect(status, output).toBe(0);
      });
    },
    invalid: (name, source, assertion, options) => {
      it(`invalid: ${name}`, () => {
        const { status, output } = lint(source, options?.filename ?? defaults.filename);
        expect(status, output).not.toBe(0);
        expect(output).toContain(rule.replace('/', '('));
        assertion?.(output);
      });
    },
  };
}
