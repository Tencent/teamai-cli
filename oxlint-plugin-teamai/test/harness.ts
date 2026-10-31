import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';

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
  const fixtures: string[] = [];
  const diagnostics = new Map<string, string[]>();
  const config = path.join(dir, '.oxlintrc.json');
  fs.writeFileSync(config, JSON.stringify({
    jsPlugins: [path.join(PLUGIN_ROOT, 'index.js')],
    categories: { correctness: 'off' },
    rules: { [rule]: 'error' },
  }));

  const fixture = (source: string, filename: string): string => {
    const file = path.join(dir, String(fixtures.length), filename);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
    fixtures.push(file);
    return file;
  };

  beforeAll(() => {
    const lint = spawnSync(OXLINT, ['-c', config, '--format', 'json', ...fixtures], {
      encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 10 * 1024 * 1024,
    });
    expect(lint.error, lint.stderr).toBeUndefined();
    expect([0, 1], lint.stdout + lint.stderr).toContain(lint.status);
    const report = z.object({ diagnostics: z.array(z.object({
      filename: z.string(), code: z.string(), message: z.string(), severity: z.string(),
    }).passthrough()) }).parse(JSON.parse(lint.stdout));
    for (const diagnostic of report.diagnostics) {
      const file = path.resolve(diagnostic.filename);
      expect(fixtures).toContain(file);
      expect(diagnostic.code).toBe(rule.replace('/', '(') + ')');
      expect(diagnostic.severity).toBe('error');
      const messages = diagnostics.get(file) ?? [];
      messages.push(JSON.stringify(diagnostic));
      diagnostics.set(file, messages);
    }
  });

  return {
    valid: (name, source, options) => {
      const file = fixture(source, options?.filename ?? defaults.filename);
      it(`valid: ${name}`, () => {
        expect(diagnostics.get(file) ?? []).toEqual([]);
      });
    },
    invalid: (name, source, assertion, options) => {
      const file = fixture(source, options?.filename ?? defaults.filename);
      it(`invalid: ${name}`, () => {
        const messages = diagnostics.get(file) ?? [];
        const output = `${messages.join('\n')}\n${messages.length} errors`;
        expect(messages.length, output).toBeGreaterThan(0);
        assertion?.(output);
      });
    },
  };
}
