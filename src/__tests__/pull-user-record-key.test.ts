import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkoutKey, checkoutRecordKey, deliveredHashes, userScopeRecord } from '../pull.js';
import { StateSchema, type LocalConfig } from '../types.js';

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): { config: LocalConfig; home: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-user-record-key-'));
  const home = path.join(root, 'home');

  roots.push(root);
  fs.mkdirSync(home);

  return {
    home,
    config: {
      repo: { localPath: path.join(home, '.teamai', 'team-repo'), remote: 'local', kind: 'git' },
      username: 'tester',
      scope: 'user',
      additionalRoles: [],
    },
  };
}

describe('user-scope checkout record identity (#1743)', () => {
  it('uses one key for HOME with or without a trailing separator', async () => {
    const { config, home } = fixture();

    vi.stubEnv('HOME', home);
    const plain = await checkoutRecordKey(config);
    vi.stubEnv('HOME', `${home}${path.sep}`);

    expect(await checkoutRecordKey(config)).toBe(plain);
  });

  it.runIf(process.platform === 'win32')('ignores Windows path casing', async () => {
    const { config, home } = fixture();
    const deliveredFile = path.join(home, '.claude', 'skills', 'owned', 'SKILL.md');

    vi.stubEnv('HOME', home);
    const original = await checkoutRecordKey(config);
    const alternateHome = `${home[0].toLowerCase()}${home.slice(1)}`;
    const state = StateSchema.parse({
      lastPullByWorkspace: {
        [original!]: { rev: 'one', targets: [], delivered: { [path.join(alternateHome, path.relative(home, deliveredFile))]: 'hash' } },
      },
    });

    vi.stubEnv('HOME', alternateHome);
    expect(await checkoutRecordKey(config)).not.toBe(original);
    expect(await deliveredHashes(config, state)).toEqual({ [path.join(alternateHome, path.relative(home, deliveredFile))]: 'hash' });
    const record = await userScopeRecord(state);
    const alternateKey = await checkoutRecordKey(config);

    expect(state.lastPullByWorkspace).toEqual({ [alternateKey!]: record });
    vi.stubEnv('HOME', home);
    expect(await deliveredHashes(config, state)).toEqual({ [deliveredFile]: 'hash' });
  });

  it('reads and migrates a sole legacy HOME record without losing its delivery ledger', async () => {
    const { config, home } = fixture();
    const legacyHome = `${home}${path.sep}`;
    const legacyKey = await checkoutKey(legacyHome);
    const delivered = { [path.join(home, '.claude', 'skills', 'owned', 'SKILL.md')]: 'member-safe-hash' };
    const state = StateSchema.parse({
      lastPullRev: 'abc1234',
      lastPullByWorkspace: {
        [legacyKey]: { rev: 'abc1234', targets: ['claude'], delivered },
      },
    });

    vi.stubEnv('HOME', home);
    expect(await deliveredHashes(config, state)).toEqual(delivered);

    const record = await userScopeRecord(state);
    const canonicalKey = await checkoutRecordKey(config);

    expect(record.delivered).toEqual(delivered);
    expect(state.lastPullByWorkspace).toEqual({ [canonicalKey!]: record });
    expect(legacyKey).not.toBe(canonicalKey);
  });

  it('does not borrow an ambiguous legacy record', async () => {
    const { config, home } = fixture();
    const state = StateSchema.parse({
      lastPullByWorkspace: {
        one: { rev: 'one', targets: [], delivered: { a: 'one' } },
        two: { rev: 'two', targets: [], delivered: { b: 'two' } },
      },
    });

    vi.stubEnv('HOME', home);
    expect(await deliveredHashes(config, state)).toBeUndefined();
  });
});
