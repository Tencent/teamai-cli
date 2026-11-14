import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { lintWithOptions, ruleHarness } from '../test/harness.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OXLINT = path.join(REPO, 'node_modules', '.bin', process.platform === 'win32' ? 'oxlint.cmd' : 'oxlint');

const rule = ruleHarness('teamai/recursive-readdir', { filename: 'src/workflow/steps/prompt.ts' });
const { valid, invalid } = rule;

const MESSAGE = 'List a folder and what is under it with entriesUnder from @teamai/shared/entries-under';

invalid('rejects a recursive readdirSync, which follows a link to a folder', `import fs from 'node:fs';
export const all = (dir: string) => fs.readdirSync(dir, { recursive: true, encoding: 'utf8' });`, (output) => {
  expect(output).toContain(MESSAGE);
});

invalid('rejects a recursive listing however the call reaches it: promises, fs-extra, a named import, opendir', `import fs from 'node:fs';
import fse from 'fs-extra';
import { readdir } from 'node:fs/promises';
import { opendirSync as open } from 'node:fs';
export const all = async (dir: string) => [
  await fs.promises.readdir(dir, { recursive: true, withFileTypes: true }),
  await fse.readdir(dir, { 'recursive': true }),
  await readdir(dir, { recursive: true }),
  open(dir, { recursive: true }),
  fs.readdirSync(dir, { recursive: !dir }),
];`, (output) => {
  expect(output.match(/List a folder and what is under it/g)).toHaveLength(5);
});

invalid('rejects options lint cannot read, which may list recursively', `import fs from 'node:fs';
const deep = { recursive: true } as const;
export const all = (dir: string, more: object) => [fs.readdirSync(dir, deep), fs.readdirSync(dir, { ...more, encoding: 'utf8' })];`, (output) => {
  expect(output.match(/Give readdir or opendir its options as an object literal/g)).toHaveLength(2);
});

invalid('rejects a listing passed on as a value or given spread arguments, whose options lint cannot see', `import fs from 'node:fs';
import { promisify } from 'node:util';
const list = fs.readdirSync;
const listLater = promisify(fs.readdir);
export const all = (dir: string, args: [string, object]) => [
  list(dir),
  listLater(dir),
  fs.readdirSync.call(fs, dir, { recursive: true }),
  fs.readdirSync.bind(fs)(dir),
  fs.readdirSync(...args),
  fs.readdirSync(dir, ...[{ recursive: true }]),
];`, (output) => {
  expect(output.match(/Give readdir or opendir its options as an object literal/g)).toHaveLength(6);
});

for (const filename of ['src/__tests__/new-area.test.ts', 'packages/runtime-zzz/src/testing/walk.ts', 'scripts/new-check.ts', 'oxlint-plugin-teamai/rules/new-rule.test.ts']) {
  invalid(`rejects a recursive listing in ${filename}, a test, a new package or a script included, with no rule edit`, `import fs from 'node:fs';
export const all = (dir: string) => fs.readdirSync(dir, { recursive: true });`, (output) => {
    expect(output).toContain(MESSAGE);
  }, { filename });
}

valid('allows a listing of one folder, and one that says it is not recursive', `import fs from 'node:fs';
export const one = async (dir: string) => [fs.readdirSync(dir), fs.readdirSync(dir, 'utf8'), await fs.promises.readdir(dir, { withFileTypes: true }), fs.readdirSync(dir, { recursive: false })];`);

valid('allows a listing of one folder given a callback, or no options before it', `import fs from 'node:fs';
export const one = (dir: string) => {
  fs.readdir(dir, (error, names) => names);
  fs.readdir(dir, function done() {});
  fs.readdir(dir, undefined, () => {});
  fs.readdir(dir, null, () => {});
};`);

valid('allows entriesUnder, and a readdir that is no file module\'s', `import { entriesUnder } from '@teamai/shared/entries-under';
declare const archive: { readdir(dir: string, options: object): string[] };
export const all = (dir: string) => [entriesUnder(dir), archive.readdir(dir, { recursive: true })];`);

valid('allows a file not yet moved as many recursive listings as it is given', `import fs from 'node:fs';
export const pages = (dir: string) => fs.readdirSync(dir, { recursive: true, encoding: 'utf8' });`, { filename: 'src/recall.ts' });

invalid('rejects a recursive listing a file not yet moved adds over its count', `import fs from 'node:fs';
export const pages = (dir: string) => [fs.readdirSync(dir, { recursive: true }), fs.readdirSync(dir, { recursive: true })];`, (output) => {
  expect(output).toContain('lets this file keep 1 such calls, and it has 2.');
}, { filename: 'src/recall.ts' });

invalid('rejects a file not yet moved once it lists recursively fewer times than its count', `import fs from 'node:fs';
export const pages = (dir: string) => fs.readdirSync(dir);`, (output) => {
  expect(output).toContain('set its count there to 0, or remove the file from the list at 0');
}, { filename: 'src/recall.ts' });

it('takes no option, so no file is let off it but through NOT_YET_MOVED', () => {
  const { status, output } = lintWithOptions('teamai/recursive-readdir', [{ allow: ['src/recall.ts'] }]);

  expect(status, output).not.toBe(0);
  expect(output).toContain("Rule 'teamai/recursive-readdir' does not accept options");
});

it('is on for every file lint reads, and this checkout keeps exactly the counts NOT_YET_MOVED gives', () => {
  const ConfigSchema = z.object({ rules: z.record(z.string(), z.unknown()), ignorePatterns: z.array(z.string()), overrides: z.array(z.object({ rules: z.record(z.string(), z.unknown()) })) });
  const repoConfig = ConfigSchema.parse(JSON.parse(fs.readFileSync(path.join(REPO, '.oxlintrc.json'), 'utf8').replace(/^\s*\/\/.*$/gm, '')));
  expect(repoConfig.rules['teamai/recursive-readdir']).toBe('error');
  expect(repoConfig.overrides.filter((override) => 'teamai/recursive-readdir' in override.rules)).toEqual([]);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-recursive-readdir-'));
  try {
    const config = path.join(dir, '.oxlintrc.json');
    fs.writeFileSync(config, JSON.stringify({
      jsPlugins: [path.join(REPO, 'oxlint-plugin-teamai', 'index.js')],
      categories: { correctness: 'off' },
      ignorePatterns: repoConfig.ignorePatterns,
      rules: { 'teamai/recursive-readdir': 'error' },
    }));
    const lint = spawnSync(OXLINT, ['-c', config, '--format', 'json', '.'], { cwd: REPO, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024 });
    expect(lint.error, lint.stderr).toBeUndefined();
    const report = z.object({ number_of_files: z.number(), diagnostics: z.array(z.object({ filename: z.string(), message: z.string() })) }).parse(JSON.parse(lint.stdout));

    expect(report.number_of_files).toBeGreaterThan(2000);
    expect(report.diagnostics).toEqual([]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
