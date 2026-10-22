import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sameSkillDir, settleSkillDirs, type LeftSkillDir, type SkillDirs } from '../resources/skill-dirs.js';

type Case = {
  readonly name: string;
  readonly previous: SkillDirs | undefined;
  readonly current: SkillDirs;
  readonly incomplete?: readonly string[];
  readonly followSession?: readonly string[];
  readonly record: SkillDirs;
  readonly left: readonly LeftSkillDir[];
};

const CASES: readonly Case[] = [
  {
    name: 'leaves nothing when no tool moved',
    previous: { hermes: ['/a'] }, current: { hermes: ['/a'] },
    record: { hermes: ['/a'] }, left: [],
  },
  {
    name: 'leaves nothing without a previous record',
    previous: undefined, current: { hermes: ['/b'] },
    record: { hermes: ['/b'] }, left: [],
  },
  {
    name: 'leaves the old directory of a tool that moved and took everything',
    previous: { hermes: ['/a'] }, current: { hermes: ['/b'] },
    record: { hermes: ['/b'] }, left: [{ dir: '/a', tool: 'hermes', currentDir: '/b' }],
  },
  {
    name: 'keeps both directories on record for a tool that moved and missed something',
    previous: { hermes: ['/a'] }, current: { hermes: ['/b'] }, incomplete: ['hermes'],
    record: { hermes: ['/a', '/b'] }, left: [],
  },
  {
    name: 'leaves both directories a held move kept once the tool takes everything elsewhere',
    previous: { hermes: ['/a', '/b'] }, current: { hermes: ['/c'] },
    record: { hermes: ['/c'] }, left: [{ dir: '/a', tool: 'hermes', currentDir: '/c' }, { dir: '/b', tool: 'hermes', currentDir: '/c' }],
  },
  {
    name: 'does not leave a directory another tool still writes',
    previous: { hermes: ['/a'], pi: ['/a'] }, current: { hermes: ['/b'], pi: ['/a'] },
    record: { hermes: ['/b'], pi: ['/a'] }, left: [],
  },
  {
    name: 'does not leave a shared directory a held tool keeps, when the other tool moves in the same pull',
    previous: { hermes: ['/a'], pi: ['/a'] }, current: { hermes: ['/b'], pi: ['/c'] }, incomplete: ['hermes'],
    record: { hermes: ['/a', '/b'], pi: ['/c'] }, left: [],
  },
  {
    name: 'does not leave a shared directory a held tool keeps, when the other tool moves in a later pull',
    previous: { hermes: ['/a', '/b'], pi: ['/a'] }, current: { hermes: ['/b'], pi: ['/c'] }, incomplete: ['hermes'],
    record: { hermes: ['/a', '/b'], pi: ['/c'] }, left: [],
  },
  {
    name: 'names a directory two tools moved off once',
    previous: { hermes: ['/a'], pi: ['/a'] }, current: { hermes: ['/b'], pi: ['/c'] },
    record: { hermes: ['/b'], pi: ['/c'] }, left: [{ dir: '/a', tool: 'hermes', currentDir: '/b' }],
  },
  {
    name: 'does not leave a directory a session-following tool writes now, and leaves that tool off the record',
    previous: { hermes: ['/a'] }, current: { hermes: ['/b'], openclaw: ['/a'] }, followSession: ['openclaw'],
    record: { hermes: ['/b'] }, left: [],
  },
  {
    name: 'never names the old directory of a session-following tool',
    previous: { openclaw: ['/a'] }, current: { openclaw: ['/b'] }, followSession: ['openclaw'],
    record: {}, left: [],
  },
  {
    name: 'drops a tool that takes skills nowhere now, and names nothing of it',
    previous: { hermes: ['/a'] }, current: {},
    record: {}, left: [],
  },
  {
    name: 'leaves only the directory of a tool with two that moved',
    previous: { codex: ['/home/.codex/skills', '/home/.agents/skills'] }, current: { codex: ['/x/skills', '/home/.agents/skills'] },
    record: { codex: ['/x/skills', '/home/.agents/skills'] }, left: [{ dir: '/home/.codex/skills', tool: 'codex', currentDir: '/x/skills' }],
  },
];

describe('settleSkillDirs', () => {
  it.each(CASES)('$name', async ({ previous, current, incomplete = [], followSession = [], record, left }) => {
    const settled = await settleSkillDirs({
      previous, current, incomplete: new Set(incomplete), followsSession: (tool) => followSession.includes(tool),
    });

    expect(settled).toEqual({ record, left });
  });

  it('compares Windows directories in their own flavor', async () => {
    const settled = await settleSkillDirs({
      previous: { hermes: ['C:\\Users\\M\\hermes\\skills'] }, current: { hermes: ['c:\\users\\m\\hermes\\skills\\'] },
      incomplete: new Set(), followsSession: () => false,
    });

    expect(settled.left).toEqual([]);
  });

  it('leaves nothing when the tool takes skills from its old directory through a link', async () => {
    const tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-settle-'));
    try {
      const real = path.join(tmp, 'real'); const link = path.join(tmp, 'link');
      await fse.ensureDir(real); await fse.symlink(real, link, 'junction');

      const settled = await settleSkillDirs({ previous: { hermes: [real] }, current: { hermes: [link] }, incomplete: new Set(), followsSession: () => false });

      expect(settled).toEqual({ record: { hermes: [link] }, left: [] });
    } finally {
      await fse.remove(tmp);
    }
  });
});

describe('sameSkillDir', () => {
  let tmp: string;
  beforeAll(async () => {
    tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-same-dir-'));
    await fse.ensureDir(path.join(tmp, 'real'));
    await fse.ensureDir(path.join(tmp, 'other'));
    await fse.symlink(path.join(tmp, 'real'), path.join(tmp, 'link'), 'junction');
  });
  afterAll(async () => { await fse.remove(tmp); });

  it.each([
    { name: 'the same existing path', a: 'real', b: 'real', same: true },
    { name: 'a link and the directory it points to', a: 'link', b: 'real', same: true },
    { name: 'a trailing separator', a: 'real', b: `real${path.sep}`, same: true },
    { name: 'a path that does not exist yet, as written', a: 'missing', b: 'missing', same: true },
    { name: 'a missing path and an existing one', a: 'missing', b: 'real', same: false },
    { name: 'two existing directories', a: 'real', b: 'other', same: false },
  ])('$name: $same', async ({ a, b, same }) => {
    expect(await sameSkillDir(path.join(tmp, a), path.join(tmp, b))).toBe(same);
  });

  it.each([
    { name: 'a Windows path in either case and separator', a: 'C:\\Users\\M\\skills', b: 'c:/users/m/skills/', same: true },
    { name: 'a POSIX path in another case', a: '/Users/M/skills', b: '/users/m/skills', same: false },
  ])('$name: $same', async ({ a, b, same }) => {
    expect(await sameSkillDir(a, b)).toBe(same);
  });
});
