import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkConfinedDir } from '../workflow/confined-place.js';

let root = '';

beforeEach(async () => { root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-confined-place-'))); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

/** A directory under `runDir` with `files` in it. */
async function dirWith(runDir: string, name: string, files: Record<string, string>): Promise<string> {
  const dir = path.join(runDir, name);
  await fs.mkdir(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) await fs.writeFile(path.join(dir, file), text);
  return dir;
}

describe('checkConfinedDir', () => {
  const runDir = () => path.join(root, 'scratch');

  it('refuses a symlink, a file, a confined.json that is not JSON or names an unknown key, and a schema outside the directory', async () => {
    const real = await dirWith(runDir(), 'real', { 'confined.json': '{"level":"verified"}' });
    await fs.symlink(real, path.join(runDir(), 'link'));
    await fs.writeFile(path.join(runDir(), 'plain'), 'x');
    await dirWith(runDir(), 'broken', { 'confined.json': '{level' });
    await dirWith(runDir(), 'loose', { 'confined.json': '{"level":"best-effort","isolation":"none"}' });
    await dirWith(runDir(), 'outside', { 'confined.json': '{"level":"verified","schema":"../schema.json"}' });
    await dirWith(runDir(), 'listed', { 'confined.json': '{"level":"verified","schema":"schema.json"}', 'schema.json': '[]' });
    const check = (dir: string) => checkConfinedDir({ step: 'judge', runDir: runDir(), dir });

    expect(await check('link')).toMatchObject({ ok: false, failure: { code: 'confined_invalid', message: expect.stringContaining('which is a symlink.') } });
    expect(await check('plain')).toMatchObject({ ok: false, failure: { message: expect.stringContaining('which is not a directory.') } });
    expect(await check('broken')).toMatchObject({ ok: false, failure: { message: expect.stringContaining('whose confined.json is not JSON: ') } });
    expect(await check('loose')).toMatchObject({ ok: false, failure: { message: expect.stringContaining('which is not a confined.json teamai reads (') } });
    expect(await check('outside')).toMatchObject({ ok: false, failure: { message: expect.stringContaining('names reply schema ../schema.json in ') } });
    expect(await check('outside')).toMatchObject({ ok: false, failure: { message: expect.stringContaining('which is not inside the directory.') } });
    expect(await check('listed')).toMatchObject({ ok: false, failure: { message: expect.stringContaining('which is not a JSON Schema object.') } });
  });

  it('takes a directory with its schema, as the real path of that file', async () => {
    const dir = await dirWith(runDir(), 'evidence', { 'confined.json': '{"level":"best-effort","prefer":"cursor","schema":"reply.json"}', 'reply.json': '{"type":"object"}' });

    expect(await checkConfinedDir({ step: 'judge', runDir: runDir(), dir: 'evidence' })).toEqual({ ok: true, place: { level: 'best-effort', prefer: 'cursor', schema: path.join(dir, 'reply.json'), dir } });
  });
});
