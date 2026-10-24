import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { placesUnmoved, samePlace, settlePlaces, type LeftPlace, type Places } from '../resources/places.js';

type Case = {
  readonly name: string;
  readonly previous: Places | undefined;
  readonly current: Places;
  readonly incomplete?: readonly string[];
  readonly followSession?: readonly string[];
  readonly record: Places;
  readonly left: readonly LeftPlace[];
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
    record: { hermes: ['/b'] }, left: [{ place: '/a', tool: 'hermes', currentPlace: '/b' }],
  },
  {
    name: 'keeps both directories on record for a tool that moved and missed something',
    previous: { hermes: ['/a'] }, current: { hermes: ['/b'] }, incomplete: ['hermes'],
    record: { hermes: ['/a', '/b'] }, left: [],
  },
  {
    name: 'leaves both directories a held move kept once the tool takes everything elsewhere',
    previous: { hermes: ['/a', '/b'] }, current: { hermes: ['/c'] },
    record: { hermes: ['/c'] }, left: [{ place: '/a', tool: 'hermes', currentPlace: '/c' }, { place: '/b', tool: 'hermes', currentPlace: '/c' }],
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
    record: { hermes: ['/b'], pi: ['/c'] }, left: [{ place: '/a', tool: 'hermes', currentPlace: '/b' }],
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
    record: { codex: ['/x/skills', '/home/.agents/skills'] }, left: [{ place: '/home/.codex/skills', tool: 'codex', currentPlace: '/x/skills' }],
  },
];

describe('settlePlaces', () => {
  it.each(CASES)('$name', async ({ previous, current, incomplete = [], followSession = [], record, left }) => {
    const settled = await settlePlaces({
      previous, current, incomplete: new Set(incomplete), followsSession: (tool) => followSession.includes(tool),
    });

    expect(settled).toEqual({ record, left });
  });

  it('compares Windows directories in their own flavor', async () => {
    const settled = await settlePlaces({
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

      const settled = await settlePlaces({ previous: { hermes: [real] }, current: { hermes: [link] }, incomplete: new Set(), followsSession: () => false });

      expect(settled).toEqual({ record: { hermes: [link] }, left: [] });
    } finally {
      await fse.remove(tmp);
    }
  });
});

describe('samePlace', () => {
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
    expect(await samePlace(path.join(tmp, a), path.join(tmp, b))).toBe(same);
  });

  it.each([
    { name: 'a Windows path in either case and separator', a: 'C:\\Users\\M\\skills', b: 'c:/users/m/skills/', same: true },
    { name: 'a POSIX path in another case', a: '/Users/M/skills', b: '/users/m/skills', same: false },
  ])('$name: $same', async ({ a, b, same }) => {
    expect(await samePlace(a, b)).toBe(same);
  });
});

describe('placesUnmoved', () => {
  it('holds while every recorded resource is where the last full pull wrote it, and not for a record without one', async () => {
    const current = {
      skills: { hermes: ['/a/skills'] },
      rules: { hermes: ['/a/SOUL.md'] },
      blocks: { hermes: ['/a/SOUL.md'] },
      agents: { claude: ['/a/agents'] },
    };

    expect(await placesUnmoved({ places: current }, current)).toBe(true);
    expect(await placesUnmoved({ places: { ...current, skills: { hermes: ['/b/skills'] } } }, current)).toBe(false);
    expect(await placesUnmoved({ places: { ...current, rules: { hermes: ['/b/SOUL.md'] } } }, current)).toBe(false);
    expect(await placesUnmoved({ places: { ...current, blocks: { hermes: ['/b/SOUL.md'] } } }, current)).toBe(false);
    expect(await placesUnmoved({ places: { ...current, agents: { claude: ['/b/agents'] } } }, current)).toBe(false);
    const { skills, rules, blocks, agents } = current;
    expect(await placesUnmoved({ places: { rules, blocks, agents } }, current)).toBe(false);
    expect(await placesUnmoved({ places: { skills, blocks, agents } }, current)).toBe(false);
    expect(await placesUnmoved({ places: { skills, rules, agents } }, current)).toBe(false);
    expect(await placesUnmoved({ places: { skills, rules, blocks } }, current)).toBe(false);
    expect(await placesUnmoved({ places: { skills: current.skills } }, current)).toBe(false);
  });
});
