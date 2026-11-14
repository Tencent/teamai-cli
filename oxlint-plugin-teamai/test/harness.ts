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
  readonly valid: (name: string, source: string, options?: { filename?: string; files?: Readonly<Record<string, string>> }) => void;
  /** The source fails this rule; `assertion` checks the reported output. */
  readonly invalid: (name: string, source: string, assertion?: (output: string) => void, options?: { filename?: string; files?: Readonly<Record<string, string>> }) => void;
}

/**
 * Run one rule of the teamai plugin through the real oxlint, on a fixture
 * written at `filename` (relative, like a path in this repository), with only
 * that rule enabled, given `options` when the rule takes them.
 */
export function ruleHarness(rule: `teamai/${string}`, defaults: { filename: string; options?: readonly object[] }): RuleHarness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-oxlint-rule-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fixtures: string[] = [];
  const diagnostics = new Map<string, string[]>();
  const config = path.join(dir, '.oxlintrc.json');
  fs.writeFileSync(config, JSON.stringify({
    jsPlugins: [path.join(PLUGIN_ROOT, 'index.js')],
    categories: { correctness: 'off' },
    rules: { [rule]: defaults.options ? ['error', ...defaults.options] : 'error' },
  }));

  const fixture = (source: string, filename: string, files: Readonly<Record<string, string>> = {}): string => {
    const file = path.join(dir, String(fixtures.length), filename);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
    const root = path.join(dir, String(fixtures.length));
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    for (const [relative, contents] of Object.entries(files)) {
      const dependency = path.join(root, relative);
      fs.mkdirSync(path.dirname(dependency), { recursive: true });
      fs.writeFileSync(dependency, contents);
    }
    fixtures.push(file);
    return file;
  };

  beforeAll(() => {
    const lint = spawnSync(OXLINT, ['-c', config, '--format', 'json', ...fixtures], {
      encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 10 * 1024 * 1024,
    });
    expect(lint.error, lint.stderr).toBeUndefined();
    expect([0, 1], lint.stdout + lint.stderr).toContain(lint.status);
    const parsed = z.object({ diagnostics: z.array(z.object({
      filename: z.string(), code: z.string(), message: z.string(), severity: z.string(),
    }).passthrough()) }).safeParse(JSON.parse(lint.stdout));
    expect(parsed.success, lint.stdout + lint.stderr).toBe(true);
    if (!parsed.success) throw parsed.error;
    const report = parsed.data;
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
      const file = fixture(source, options?.filename ?? defaults.filename, options?.files);
      it(`valid: ${name}`, () => {
        expect(diagnostics.get(file) ?? []).toEqual([]);
      });
    },
    invalid: (name, source, assertion, options) => {
      const file = fixture(source, options?.filename ?? defaults.filename, options?.files);
      it(`invalid: ${name}`, () => {
        const messages = diagnostics.get(file) ?? [];
        const output = `${messages.join('\n')}\n${messages.length} errors`;
        expect(messages.length, output).toBeGreaterThan(0);
        assertion?.(output);
      });
    },
  };
}

/**
 * Run the real oxlint with `rule` configured with `options` on an empty fixture, and return its exit status and what it
 * printed, so a test can show that a rule refuses an option it no longer takes.
 */
export function lintWithOptions(rule: `teamai/${string}`, options: readonly object[]): { status: number | null; output: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-oxlint-options-'));
  try {
    const config = path.join(dir, '.oxlintrc.json');
    fs.writeFileSync(config, JSON.stringify({ jsPlugins: [path.join(PLUGIN_ROOT, 'index.js')], categories: { correctness: 'off' }, rules: { [rule]: ['error', ...options] } }));
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    const file = path.join(dir, 'src', 'x.ts');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'export const x = 1;\n');
    const lint = spawnSync(OXLINT, ['-c', config, '--format', 'json', file], { encoding: 'utf8', shell: process.platform === 'win32' });
    return { status: lint.status, output: lint.stdout + lint.stderr };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
