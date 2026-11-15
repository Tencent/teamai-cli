import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { entriesUnder } from '@teamai/shared/entries-under';

import { ruleHarness } from '../test/harness.ts';
import { isWriteChecked } from './step-path-writes.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const rule = ruleHarness('teamai/step-path-writes', { filename: 'src/workflow/steps/outcome.ts' });

const MESSAGE = 'Write a file with writeRegularFile, appendRegularFile or openRegularFileForWrite';

/** A file the rule lets off plain writes in, and how many. */
const [LEFT_FILE, LEFT_COUNT]: [string, number] = Object.entries(z.record(z.string(), z.number()).parse(JSON.parse(fs.readFileSync(path.join(REPO, 'oxlint-plugin-teamai/rules/step-path-writes.left.json'), 'utf8'))))[0] ?? ['', 0];
const writes = (count: number): string => `import fs from 'node:fs/promises';\nexport const all = (file: string) => [${Array.from({ length: count }, () => "fs.appendFile(file, 'x')").join(', ')}];`;

rule.valid('lets off as many plain writes as a file had when the rule came to check it', writes(LEFT_COUNT), { filename: LEFT_FILE });

rule.invalid('rejects every plain write of a let-off file once it has more than it had', writes(LEFT_COUNT + 1), (output) => {
  expect(output.match(/Write a file with writeRegularFile/g)).toHaveLength(LEFT_COUNT + 1);
}, { filename: LEFT_FILE });

rule.invalid('asks for a let-off file\'s count to come down once it has fewer, so the list only shrinks', writes(LEFT_COUNT - 1), (output) => {
  expect(output).toContain(`${LEFT_FILE} has ${LEFT_COUNT - 1} plain writes where step-path-writes.left.json lets off ${LEFT_COUNT}`);
}, { filename: LEFT_FILE });

rule.invalid('rejects an open of fs.promises with a write flag', `import fs from 'node:fs';
export const open = (file: string) => fs.promises.open(file, 'a');`, (output) => {
  expect(output).toContain(MESSAGE);
});

rule.invalid('rejects a named import of openSync with a write flag, under any local name', `import { openSync as at } from 'node:fs';
export const open = (file: string) => at(file, 'w+');`, (output) => {
  expect(output).toContain(MESSAGE);
});

rule.invalid('rejects write flags given as constants', `import fs from 'node:fs';
export const open = (file: string) => fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT);`, (output) => {
  expect(output).toContain(MESSAGE);
});

rule.invalid('rejects flags it cannot read, as a write', `import fs from 'node:fs/promises';
export const open = (file: string, flags: string) => fs.open(file, flags);`, (output) => {
  expect(output).toContain(MESSAGE);
});

rule.invalid('rejects a write stream and an append, from node:fs and fs-extra', `import fs from 'node:fs';
import fse from 'fs-extra';
import { appendFile } from 'node:fs/promises';
export const all = async (file: string) => [fs.createWriteStream(file), fs.appendFileSync(file, 'x'), await fse.appendFile(file, 'x'), await appendFile(file, 'x')];`, (output) => {
  expect(output.match(/Write a file with writeRegularFile/g)).toHaveLength(4);
});

rule.invalid('rejects a write in a folder no rule names, so new code is in scope', `import fs from 'node:fs/promises';
export const add = (file: string) => fs.appendFile(file, 'x');`, (output) => {
  expect(output).toContain(MESSAGE);
}, { filename: 'src/workflow/zzz-new/x.ts' });

rule.invalid('rejects a whole-file write, which waits on a FIFO as an open for writing does', `import fs from 'node:fs';
import { writeFile } from 'node:fs/promises';
export const all = async (file: string) => [await fs.promises.writeFile(file, 'x', 'utf-8'), fs.writeFileSync(file, 'x'), await writeFile(file, 'x', { mode: 0o600 })];`, (output) => {
  expect(output.match(/Write a file with writeRegularFile/g)).toHaveLength(3);
});

rule.invalid('rejects a copy, which opens its destination for writing', `import fs from 'node:fs/promises';
import fse from 'fs-extra';
export const all = async (from: string, to: string) => [await fs.copyFile(from, to), fse.copyFileSync(from, to)];`, (output) => {
  expect(output.match(/Write a file with writeRegularFile/g)).toHaveLength(2);
});

rule.invalid('rejects fs-extra\'s writers of a whole file', `import fse from 'fs-extra';
export const all = async (file: string) => [await fse.outputFile(file, 'x'), await fse.writeJson(file, {}), fse.outputJsonSync(file, {}), fse.writeJSONSync(file, {})];`, (output) => {
  expect(output.match(/Write a file with writeRegularFile/g)).toHaveLength(4);
});

rule.valid('allows the helper and an atomic JSON write', `import { appendRegularFile, openRegularFileForWrite, writeRegularFile } from '@teamai/shared/regular-file';
import { writeJsonAtomic } from '../../utils/fs.js';
export const all = async (file: string) => [await appendRegularFile(file, 'x'), await openRegularFileForWrite(file, { append: false }), await writeRegularFile(file, 'x'), await writeJsonAtomic(file, {})];`);

rule.valid('allows a whole-file write that only creates, which fails at once on anything already there', `import fs from 'node:fs/promises';
export const create = async (file: string) => [await fs.writeFile(file, 'x', { mode: 0o600, flag: 'wx' }), await fs.writeFile(file, 'x', { flag: 'ax' })];`);

rule.invalid('rejects a whole-file write whose flag it cannot read, as one that may replace', `import fs from 'node:fs/promises';
export const write = async (file: string, flag: string) => fs.writeFile(file, 'x', { flag });`, (output) => {
  expect(output).toContain(MESSAGE);
});

rule.valid('allows an open for reading, with no flag, a read flag or read constants', `import fs from 'node:fs';
export const open = (file: string) => [fs.promises.open(file), fs.openSync(file, 'r'), fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)];`);

rule.valid('allows an open method that is no file module\'s', `export const open = (runtime: { open: (view: string, flags: string) => void }, flags: string) => runtime.open('view', flags);`);

rule.invalid('rejects a write anywhere in production source, a new package\'s too, as the read rule checks reads', `import fs from 'node:fs/promises';
export const add = (file: string) => fs.appendFile(file, 'x');`, (output) => {
  expect(output).toContain(MESSAGE);
}, { filename: 'packages/zzz-new/src/x.ts' });

rule.valid('allows writes outside production source', `import fs from 'node:fs/promises';
export const add = (file: string) => fs.appendFile(file, 'x');`, { filename: 'scripts/verify/world.ts' });

rule.valid('allows writes in tests', `import fs from 'node:fs/promises';
export const add = (file: string) => fs.appendFile(file, 'x');`, { filename: 'src/workflow/steps/outcome.test.ts' });

it('matches the production source of src/ and of every package in this checkout, and no test', () => {
  const sources = ['src', ...fs.readdirSync(path.join(REPO, 'packages')).map((name) => `packages/${name}/src`)].filter((dir) => fs.existsSync(path.join(REPO, dir)));
  const files = sources.flatMap((dir) => entriesUnder(path.join(REPO, dir)).map(({ relative }) => `${dir}/${relative.split(path.sep).join('/')}`));
  const matched = files.filter(isWriteChecked);

  expect(matched.filter((file) => file.startsWith('src/workflow/')).length).toBeGreaterThan(100);
  expect(matched.filter((file) => file.startsWith('packages/')).length).toBeGreaterThan(100);
  expect(matched.filter((file) => /\.test\.|\/__tests__\/|\/testing\//.test(file))).toEqual([]);
});

it('lets off only files of this checkout it checks, each with writes left', () => {
  const left = z.record(z.string(), z.number().int().positive()).parse(JSON.parse(fs.readFileSync(path.join(REPO, 'oxlint-plugin-teamai/rules/step-path-writes.left.json'), 'utf8')));

  expect(Object.keys(left).filter((file) => !fs.existsSync(path.join(REPO, file)) || !isWriteChecked(file))).toEqual([]);
  expect(Object.keys(left).filter((file) => file.startsWith('src/workflow/'))).toEqual([]);
});

it('is an error in this checkout', () => {
  const config = fs.readFileSync(path.join(REPO, '.oxlintrc.json'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  const rules = z.object({ rules: z.record(z.string(), z.unknown()) }).parse(JSON.parse(config)).rules;

  expect(rules['teamai/step-path-writes']).toBe('error');
});

rule.invalid('rejects a write passed on as a value, which a later call makes', `import { writeFile } from 'node:fs/promises';
export const writer = writeFile;`, (output) => {
  expect(output).toContain(MESSAGE);
});

rule.invalid('rejects a file module passed on as a value, so no wrapper carries plain writes out of sight', `import fs from 'node:fs';
declare function writeWith(files: object, file: string): void;
export const write = (file: string) => writeWith(fs, file);
export { appendFile } from 'node:fs/promises';`, (output) => {
  expect(output.match(/re-exports or passes on a file module/g)).toHaveLength(2);
});

rule.invalid('rejects an open for reading and writing', `import fs from 'node:fs';
export const open = (file: string) => fs.openSync(file, 'r+');`, (output) => {
  expect(output).toContain(MESSAGE);
});
