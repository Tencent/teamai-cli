import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { entriesUnder } from '@teamai/shared/entries-under';

import { lintWithOptions, ruleHarness } from '../test/harness.ts';
import { isReadChecked } from './regular-file-reads.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const rule = ruleHarness('teamai/regular-file-reads', { filename: 'src/workflow/steps/result.ts' });
const { valid, invalid } = rule;

const MESSAGE = 'Read a file with readRegularFile or openRegularFile';

invalid('rejects fs.promises.readFile of the result file a step wrote', `import fs from 'node:fs/promises';
export const read = (resultPath: string) => fs.readFile(resultPath, 'utf8');`, (output) => {
  expect(output).toContain(MESSAGE);
});

invalid('rejects readFileSync off a namespace import of node:fs', `import * as fs from 'node:fs';
export const read = (file: string) => fs.readFileSync(file, 'utf8');`, (output) => {
  expect(output).toContain(MESSAGE);
});

invalid('rejects readFile off the promises of node:fs, and off fs-extra', `import fs from 'node:fs';
import fse from 'fs-extra';
export const read = async (file: string) => [await fs.promises.readFile(file), await fse.readFile(file)];`, (output) => {
  expect(output.match(/Read a file with readRegularFile/g)).toHaveLength(2);
});

invalid('rejects a stream opened on a path', `import fs from 'node:fs';
export const stream = (file: string) => fs.createReadStream(file);`, (output) => {
  expect(output).toContain(MESSAGE);
});

invalid('rejects a named import of a read, under any local name', `import { readFile as read } from 'node:fs/promises';
export const text = (file: string) => read(file, 'utf8');`, (output) => {
  expect(output).toContain(MESSAGE);
});

invalid('rejects a copy of a path, and fs-extra reading JSON off one', `import fs from 'node:fs/promises';
import fse from 'fs-extra';
export const copy = async (from: string, to: string) => [await fs.copyFile(from, to), await fse.readJson(from), fse.readJSONSync(from)];`, (output) => {
  expect(output.match(/Read a file with readRegularFile/g)).toHaveLength(3);
});

invalid('rejects fs-extra or node copying a path or a folder, which reads every file under it', `import fse from 'fs-extra';
import fs from 'node:fs';
import { copySync } from 'fs-extra';
export const copy = async (from: string, to: string) => [await fse.copy(from, to, { overwrite: true }), fse.copySync(from, to), copySync(from, to), await fs.promises.cp(from, to, { recursive: true }), fs.cpSync(from, to, { recursive: true })];`, (output) => {
  expect(output.match(/Read a file with readRegularFile/g)).toHaveLength(5);
});

invalid('rejects fs-extra moving a path, which copies every file under it when the destination is on another filesystem', `import fse from 'fs-extra';
import { moveSync } from 'fs-extra';
export const move = async (from: string, to: string) => [await fse.move(from, to, { overwrite: false }), fse.moveSync(from, to), moveSync(from, to)];`, (output) => {
  expect(output.match(/Read a file with readRegularFile/g)).toHaveLength(3);
});

valid('allows the move of the helper, and a rename, which never copies', `import { moveRegularTree } from '@teamai/shared/regular-file';
import fs from 'node:fs';
export const move = async (from: string, to: string) => [await moveRegularTree(from, to), await fs.promises.rename(from, to)];`);

valid('allows the recursive copy of the helper', `import { copyRegularTree } from '@teamai/shared/regular-file';
export const copy = (from: string, to: string) => copyRegularTree(from, to, { existing: 'fail' });`);

invalid('rejects an open for reading, with no flag, a read flag or read constants', `import fs from 'node:fs';
export const open = async (file: string) => [await fs.promises.open(file), fs.openSync(file, 'r'), fs.openSync(file, fs.constants.O_RDONLY)];`, (output) => {
  expect(output.match(/Read a file with readRegularFile/g)).toHaveLength(3);
});

valid('allows an open for writing, which the write rule guards where a step writes', `import fs from 'node:fs';
export const open = (file: string) => fs.openSync(file, 'w');`);

invalid('rejects a read under computed access, destructured from a file module or its promises, or off one imported at run time', `import fs from 'node:fs';
const { readFileSync: readNow, promises: later } = fs;
export const all = async (file: string) => {
  const fsp = await import('node:fs/promises');
  const { readFile } = await import('node:fs/promises');
  return [fs['readFileSync'](file), readNow(file), await fsp.readFile(file), await readFile(file), await (await import('node:fs/promises')).readFile(file), await later.readFile(file)];
};`, (output) => {
  expect(output.match(/Read a file with readRegularFile/g)).toHaveLength(6);
});

invalid('rejects a read passed on as a value, which a later call makes', `import { readFile } from 'node:fs/promises';
export const texts = (files: string[]) => Promise.all(files.map(readFile));`, (output) => {
  expect(output).toContain(MESSAGE);
});

invalid('reports each call of a named import, not the import once', `import { readFileSync } from 'node:fs';
export const all = (file: string) => [readFileSync(file), readFileSync(file), readFileSync(file)];`, (output) => {
  expect(output.match(/Read a file with readRegularFile/g)).toHaveLength(3);
});

valid('allows the read wrappers of src/utils/fs.ts, which open through the helper', `import { readFileSafe, readJson, fileHash } from '../../utils/fs.js';
export const all = (file: string) => Promise.all([readFileSafe(file), readJson(file), fileHash(file)]);`);

invalid('rejects a plain read inside src/utils/fs.ts itself, so a new wrapper is checked where it is written', `import fse from 'fs-extra';
export const readFileSafe = (file: string) => fse.readFile(file, 'utf-8');`, (output) => {
  expect(output).toContain(MESSAGE);
}, { filename: 'src/utils/fs.ts' });

for (const filename of ['packages/shared/src/regular-file.ts', 'src/hook-fast-path.ts']) {
  invalid(`rejects a new plain read in ${filename}, whose own reads are allowed line by line`, `import fs from 'node:fs';
export const read = (file: string) => fs.readFileSync(file, 'utf8');`, (output) => {
    expect(output).toContain(MESSAGE);
  }, { filename });
}

valid('allows the helper, and a read of an open handle it returned', `import { openRegularFile, readRegularFile } from '@teamai/shared/regular-file';
export const text = (file: string) => readRegularFile(file, 'utf8');
export const head = async (file: string) => {
  const handle = await openRegularFile(file);
  try { return await handle.readFile('utf8'); } finally { await handle.close(); }
};`);

valid('allows the other calls of a file module, writes among them', `import fs from 'node:fs/promises';
export const write = (file: string) => fs.writeFile(file, '{}');
export const list = (dir: string) => fs.readdir(dir);`);

invalid('rejects a read in src/ outside src/workflow, such as a scorer reading evidence a step wrote', `import fs from 'node:fs';
export const read = (file: string) => fs.readFileSync(file, 'utf8');`, (output) => {
  expect(output).toContain(MESSAGE);
}, { filename: 'src/scorers/x.ts' });

invalid('rejects a read in a package folder no rule names, so a new package is in scope', `import { readFile } from 'node:fs/promises';
export const read = (file: string) => readFile(file, 'utf8');`, (output) => {
  expect(output).toContain(MESSAGE);
}, { filename: 'packages/tool-zzz/src/x.ts' });

valid('allows the helper in a package', `import { readRegularFileSync } from '@teamai/shared/regular-file';
export const read = (file: string) => readRegularFileSync(file, 'utf8');`, { filename: 'packages/tool-zzz/src/x.ts' });

for (const filename of ['src/config/listed.ts', 'src/utils/migrate.ts', 'packages/runtime-zzz/src/place.ts']) {
  invalid(`rejects a raw read in ${filename}, with no file exempt`, `import fs from 'node:fs';
export const read = (file: string) => fs.readFileSync(file, 'utf8');`, (output) => {
    expect(output).toContain(MESSAGE);
  }, { filename });
}

it('takes no option, so no file can be given an allowance of plain reads', () => {
  const { status, output } = lintWithOptions('teamai/regular-file-reads', [{ baseline: 'oxlint-plugin-teamai/rules/regular-file-reads.baseline.json' }]);

  expect(status, output).not.toBe(0);
  expect(output).toContain("Rule 'teamai/regular-file-reads' does not accept options");
});

valid('allows reads in tests', `import fs from 'node:fs/promises';
export const read = (file: string) => fs.readFile(file, 'utf8');`, { filename: 'src/workflow/steps/result.test.ts' });

it('matches the production source of src/ and of every package in this checkout', () => {
  const sources = (dir: string) => entriesUnder(path.join(REPO, dir))
    .map(({ relative }) => `${dir}/${relative.split(path.sep).join('/')}`)
    .filter((file) => !file.includes('node_modules'));
  const matched = [...sources('src'), ...sources('packages')].filter(isReadChecked);

  expect(matched.filter((file) => file.startsWith('src/')).length).toBeGreaterThan(500);
  expect(matched.filter((file) => file.startsWith('packages/')).length).toBeGreaterThan(150);
  expect(matched.filter((file) => /\.test\.|\/__tests__\/|\/testing\//.test(file))).toEqual([]);
});

invalid('rejects a module re-exporting a read, so no wrapper module carries plain reads out of sight', `export { readFile } from 'node:fs/promises';
export { readFileSync as readNow } from 'node:fs';`, (output) => {
  expect(output.match(/re-exports or passes on a file module/g)).toHaveLength(2);
}, { filename: 'src/utils/files.ts' });

invalid('rejects a module re-exporting a file module whole', `export * from 'fs-extra';
export { default as fs } from 'node:fs';
export * as fsp from 'node:fs/promises';`, (output) => {
  expect(output.match(/re-exports or passes on a file module/g)).toHaveLength(3);
}, { filename: 'src/utils/files.ts' });

invalid('rejects a file module passed on as a value: an argument, an export, a property, a return', `import fs from 'node:fs';
import fse from 'fs-extra';
declare function readWith(files: object, file: string): string;
export const viaArgument = (file: string) => readWith(fs, file);
export const files = fse;
export const deps = { fs: fs.promises };
export function module() { return fs; }`, (output) => {
  expect(output.match(/re-exports or passes on a file module/g)).toHaveLength(4);
}, { filename: 'src/workflow/steps/result.ts' });

valid('allows a file module used where it stands, aliased or destructured', `import fs from 'node:fs';
const fsp = fs.promises;
const local = fs;
const { stat } = fs;
export const all = async (dir: string) => [await fsp.readdir(dir), local.existsSync(dir), await stat(dir)];`);

invalid('rejects an open that may read as well as write, whose handle reads elsewhere', `import fs from 'node:fs';
export const open = async (file: string) => [await fs.promises.open(file, 'r+'), fs.openSync(file, 'w+'), fs.openSync(file, 'a+'), fs.openSync(file, fs.constants.O_RDWR)];`, (output) => {
  expect(output.match(/Read a file with readRegularFile/g)).toHaveLength(4);
});
