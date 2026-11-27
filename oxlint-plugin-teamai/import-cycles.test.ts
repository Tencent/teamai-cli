import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

// `import/no-cycle` is oxlint's own rule, scoped to production source by an override in .oxlintrc.json. These tests run
// that override as the repository writes it, so a scope or option change is checked here.

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OXLINT = path.join(REPO, 'node_modules', '.bin', process.platform === 'win32' ? 'oxlint.cmd' : 'oxlint');

const OverrideSchema = z.object({ files: z.array(z.string()), excludeFiles: z.array(z.string()).optional(), rules: z.record(z.string(), z.unknown()) });
const ConfigSchema = z.object({ plugins: z.array(z.string()), overrides: z.array(OverrideSchema) });

const ReportSchema = z.object({ number_of_files: z.number(), diagnostics: z.array(z.object({ filename: z.string(), code: z.string() })) });

/** `glob`, an oxlint override pattern of `*` and `**` segments, as a regular expression over a path from the repository root. */
function globPattern(glob: string): RegExp {
  const source = glob.split('/').map((part) => (part === '**' ? '.*' : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*'))).join('/');

  return new RegExp(`^${source.replaceAll('.*/', '(?:.*/)?')}$`);
}

const rawConfig: unknown = JSON.parse(fs.readFileSync(path.join(REPO, '.oxlintrc.json'), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
const repoConfig = ConfigSchema.parse(rawConfig);
const cycleRule = (override: z.infer<typeof OverrideSchema>) => override.rules['import/no-cycle'];
const { plugins } = repoConfig;
const [guard, ...more] = repoConfig.overrides.filter((override) => Array.isArray(cycleRule(override)));

/**
 * The files `import/no-cycle` reports under `dir`'s `paths`, linted with `overrides` and nothing else. oxlint reads an
 * override's globs from its config file's folder, so the config is written in `dir`.
 */
function cycleFiles(dir: string, overrides: readonly object[], paths: readonly string[]): { files: string[]; linted: number } {
  const file = path.join(dir, '.oxlintrc.json');
  fs.writeFileSync(file, JSON.stringify({ plugins: ['import'], categories: { correctness: 'off' }, overrides }));
  // Given by its absolute path, oxlint matches no override glob; from the folder it is in, it does.
  const lint = spawnSync(OXLINT, ['-c', '.oxlintrc.json', '--format', 'json', ...paths], { cwd: dir, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024 });
  expect(lint.error, lint.stderr).toBeUndefined();
  const report = ReportSchema.parse(JSON.parse(lint.stdout));

  return { files: [...new Set(report.diagnostics.filter((diagnostic) => diagnostic.code === 'import(no-cycle)').map((diagnostic) => diagnostic.filename))].sort(), linted: report.number_of_files };
}

describe('the import cycle guard', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-cycle-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (relative: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
    fs.writeFileSync(path.join(dir, relative), text);
  };

  it('is one override, scoped to production source, that allows type-only cycles, with the import plugin on for the whole config', () => {
    expect(plugins).toContain('import');
    expect(more).toEqual([]);
    // Any other setting, "off" included, would weaken the guard where it applies: no file is let off it.
    expect(repoConfig.overrides.map(cycleRule).filter((setting) => setting !== undefined && !Array.isArray(setting))).toEqual([]);
    expect(z.object({ rules: z.record(z.string(), z.unknown()) }).parse(rawConfig).rules['import/no-cycle']).toBeUndefined();
    expect(guard).toMatchObject({ files: ['src/**', 'packages/*/src/**'], rules: { 'import/no-cycle': ['error', { ignoreTypes: true }] } });
  });

  it('refuses a cycle of two files, in src/ and in a package no rule names, and allows one of type-only imports or of tests', () => {
    expect(guard).toBeDefined();
    if (guard === undefined) return;
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    write('src/x/a.ts', "import { b } from './b.js';\nexport const a = (): unknown => b;\n");
    write('src/x/b.ts', "import { a } from './a.js';\nexport const b = (): unknown => a;\n");
    write('packages/zzz/src/e.ts', "import { f } from './f.js';\nexport const e = (): unknown => f;\n");
    write('packages/zzz/src/f.ts', "import { e } from './e.js';\nexport const f = (): unknown => e;\n");
    write('src/y/c.ts', "import type { D } from './d.js';\nexport type C = { d?: D };\n");
    write('src/y/d.ts', "import { type C } from './c.js';\nexport type D = { c?: C };\n");
    write('src/__tests__/g.test.ts', "import { h } from './h.test.js';\nexport const g = (): unknown => h;\n");
    write('src/__tests__/h.test.ts', "import { g } from './g.test.js';\nexport const h = (): unknown => g;\n");

    expect(cycleFiles(dir, [guard], ['src', 'packages']).files).toEqual(['packages/zzz/src/e.ts', 'packages/zzz/src/f.ts', 'src/x/a.ts', 'src/x/b.ts']);
  });

  it('finds no cycle in this checkout\'s production source, over more than a thousand files', () => {
    expect(guard).toBeDefined();
    if (guard === undefined) return;
    // The rule unscoped over the checkout, with the guard's options, then the guard's own globs: oxlint reads those
    // only from a config in the checkout's folder, which a test does not write.
    const config = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-cycle-config-')), 'oxlintrc.json');
    fs.writeFileSync(config, JSON.stringify({ plugins: ['import'], categories: { correctness: 'off' }, rules: { 'import/no-cycle': cycleRule(guard) } }));
    const lint = spawnSync(OXLINT, ['-c', config, '--format', 'json', 'src', 'packages'], { cwd: REPO, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024 });
    fs.rmSync(path.dirname(config), { recursive: true, force: true });
    const report = ReportSchema.parse(JSON.parse(lint.stdout));
    const inScope = (file: string) => guard.files.some((glob) => globPattern(glob).test(file)) && !(guard.excludeFiles ?? []).some((glob) => globPattern(glob).test(file));
    const found = { files: [...new Set(report.diagnostics.filter((diagnostic) => diagnostic.code === 'import(no-cycle)').map((diagnostic) => diagnostic.filename))].filter(inScope).sort(), linted: report.number_of_files };

    expect(found.linted).toBeGreaterThan(1000);
    expect(found.files).toEqual([]);
  });
});
