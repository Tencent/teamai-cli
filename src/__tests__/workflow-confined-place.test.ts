import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LocalConfig } from '../types.js';
import { checkConfinedDir, confinedCandidates, decideConfined } from '../workflow/confined-place.js';

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
    await dirWith(runDir(), 'unlevelled', { 'confined.json': '{"level":"none","isolation":"none"}' });
    await dirWith(runDir(), 'outside', { 'confined.json': '{"level":"verified","schema":"../schema.json"}' });
    await dirWith(runDir(), 'listed', { 'confined.json': '{"level":"verified","schema":"schema.json"}', 'schema.json': '[]' });
    const check = (dir: string) => checkConfinedDir({ step: 'judge', runDir: runDir(), dir });

    expect(await check('link')).toMatchObject({ ok: false, failure: { code: 'confined_invalid', message: expect.stringContaining('which is a symlink.') } });
    expect(await check('plain')).toMatchObject({ ok: false, failure: { message: expect.stringContaining('which is not a directory.') } });
    expect(await check('broken')).toMatchObject({ ok: false, failure: { message: expect.stringContaining('whose confined.json is not JSON: ') } });
    expect(await check('loose')).toMatchObject({ ok: false, failure: { message: expect.stringMatching(/which is not a confined\.json teamai reads \(Unrecognized key: "isolation"\)\. /) } });
    expect(await check('unlevelled')).toMatchObject({ ok: false, failure: { message: expect.stringMatching(/which is not a confined\.json teamai reads \(level: [^;]+; Unrecognized key: "isolation"\)\. /) } });
    expect(await check('outside')).toMatchObject({ ok: false, failure: { message: expect.stringContaining('names reply schema ../schema.json in ') } });
    expect(await check('outside')).toMatchObject({ ok: false, failure: { message: expect.stringContaining('which is not inside the directory.') } });
    expect(await check('listed')).toMatchObject({ ok: false, failure: { message: expect.stringContaining('which is not a JSON Schema object.') } });
  });

  it('refuses a directory that does not exist, also under a file, and one without confined.json', async () => {
    await dirWith(runDir(), 'empty', {});
    await fs.writeFile(path.join(runDir(), 'plain'), 'x');

    expect(await checkConfinedDir({ step: 'judge', runDir: runDir(), dir: 'plain/inside' })).toMatchObject({ ok: false, failure: { message: expect.stringContaining('inside, which does not exist.') } });

    expect(await checkConfinedDir({ step: 'judge', runDir: runDir(), dir: 'gone' })).toMatchObject({ ok: false, failure: { code: 'confined_invalid', message: `Step "judge" runs confined to ${path.join(runDir(), 'gone')}, which does not exist. Write the directory under $TEAMAI_RUN_DIR in a step the confined step needs, with its confined.json.` } });
    expect(await checkConfinedDir({ step: 'judge', runDir: runDir(), dir: 'empty' })).toMatchObject({ ok: false, failure: { message: expect.stringContaining('whose confined.json does not exist. Write confined.json there') } });
  });

  it('takes a directory with its schema, as the real path of that file', async () => {
    const dir = await dirWith(runDir(), 'evidence', { 'confined.json': '{"level":"best-effort","prefer":"cursor","schema":"reply.json"}', 'reply.json': '{"type":"object"}' });

    expect(await checkConfinedDir({ step: 'judge', runDir: runDir(), dir: 'evidence' })).toEqual({ ok: true, place: { level: 'best-effort', prefer: 'cursor', schema: path.join(dir, 'reply.json'), dir } });
  });
});

describe('confinedCandidates', () => {
  it('puts the preferred tool first only when an offer that reaches the level has it', () => {
    const offers: Parameters<typeof confinedCandidates>[0] = [{ level: 'verified', access: 'read', tools: ['claude'] }, { level: 'best-effort', access: 'full', tools: ['cursor', 'claude'] }];

    expect(confinedCandidates(offers, { level: 'best-effort', prefer: 'cursor' })).toEqual(['cursor', 'claude']);
    expect(confinedCandidates(offers, { level: 'verified', prefer: 'cursor' })).toEqual(['claude']);
  });

  it('tries each preferred tool the offers hold, in order, then the offers in theirs', () => {
    const offers: Parameters<typeof confinedCandidates>[0] = [{ level: 'best-effort', access: 'read', tools: ['claude', 'codex', 'opencode'] }];

    expect(confinedCandidates(offers, { level: 'best-effort', prefer: ['opencode', 'claude'] })).toEqual(['opencode', 'claude', 'codex']);
    expect(confinedCandidates(offers, { level: 'best-effort', prefer: ['acme-judge', 'codex'] })).toEqual(['codex', 'claude', 'opencode']);
  });
});

describe('decideConfined', () => {
  let config: LocalConfig;

  beforeEach(async () => {
    config = { repo: { localPath: path.join(root, 'team'), remote: 'local', kind: 'git' }, username: 'tester', scope: 'user', additionalRoles: [], dataHome: path.join(root, 'data') };
    await dirWith(path.join(root, 'team'), 'models', { 'aliases.yaml': 'aliases:\n  confined-judge:\n    codex: gpt-6-astra\n' });
  });

  it('holds a step whose model no candidate resolves, with the reason of the first that names one', async () => {
    await dirWith(path.join(root, 'scratch'), 'evidence', { 'confined.json': '{"level":"best-effort"}' });

    const decided = await decideConfined({ step: 'judge', dir: 'evidence', runDir: path.join(root, 'scratch'), offers: [{ level: 'best-effort', access: 'read', tools: ['pi', 'claude'] }], model: 'confined-judge', config });

    expect(decided).toEqual({ kind: 'hold', held: { step: 'judge', missing: ['model'], reason: expect.stringMatching(/^step "judge" needs a model one of its confined tools resolves, and none of pi, claude does: Step "judge" asks for model alias "confined-judge", which has no model for claude/) } });
  });

  it('holds a step whose default model no candidate resolves, and one whose candidates take no model, without a reason of theirs', async () => {
    await dirWith(path.join(root, 'scratch'), 'evidence', { 'confined.json': '{"level":"best-effort"}' });
    const decide = (tools: string[], models: { model?: string; defaultModel?: string }) => decideConfined({ step: 'judge', dir: 'evidence', runDir: path.join(root, 'scratch'), offers: [{ level: 'best-effort', access: 'read', tools }], ...models, config });

    expect(await decide(['claude'], { defaultModel: 'confined-judge' })).toMatchObject({ kind: 'hold', held: { missing: ['model'], reason: expect.stringContaining('gets model alias "confined-judge" from defaults') } });
    expect(await decide(['pi'], { model: 'confined-judge' })).toEqual({ kind: 'hold', held: { step: 'judge', missing: ['model'], reason: 'step "judge" needs a model one of its confined tools resolves, and none of pi does' } });
  });

  it('grants a step with its candidates and its reply schema', async () => {
    const dir = await dirWith(path.join(root, 'scratch'), 'evidence', { 'confined.json': '{"level":"verified","schema":"reply.json"}', 'reply.json': '{"type":"object"}' });

    const decided = await decideConfined({ step: 'judge', dir: 'evidence', runDir: path.join(root, 'scratch'), offers: [{ level: 'verified', access: 'read', tools: ['codex'] }], model: 'confined-judge', config });

    expect(decided).toEqual({ kind: 'grant', lease: { dir, level: 'verified', tools: ['codex'], schema: path.join(dir, 'reply.json') } });
  });
});
