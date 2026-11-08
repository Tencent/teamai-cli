import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkoutRecordKey, deliveredHashes } from '../pull.js';
import { StateSchema, type LocalConfig } from '../types.js';

describe.runIf(process.platform !== 'win32')('user-scope record paths through a symlinked HOME (#1743)', () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('re-keys delivered paths to the current HOME spelling', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-user-record-symlink-'));
    const home = path.join(root, 'home');
    const link = path.join(root, 'home-link');
    const deliveredFile = path.join(home, '.claude', 'skills', 'owned', 'SKILL.md');
    const config: LocalConfig = {
      repo: { localPath: path.join(home, '.teamai', 'team-repo'), remote: 'local', kind: 'git' },
      username: 'tester',
      scope: 'user',
      additionalRoles: [],
    };

    roots.push(root);
    fs.mkdirSync(home);
    fs.symlinkSync(home, link, 'dir');
    vi.stubEnv('HOME', link);
    const key = await checkoutRecordKey(config);
    const state = StateSchema.parse({
      lastPullByWorkspace: {
        [key!]: { rev: 'one', targets: [], delivered: { [path.join(link, path.relative(home, deliveredFile))]: 'hash' } },
      },
    });

    vi.stubEnv('HOME', home);
    expect(await deliveredHashes(config, state)).toEqual({ [deliveredFile]: 'hash' });
  });
});
