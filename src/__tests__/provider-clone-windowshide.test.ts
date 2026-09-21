/**
 * Every provider that shells out to `git clone` must hide the console window.
 *
 * A parent with no console of its own — a GUI or a hook host — makes Windows
 * allocate a new console for each child, which flashes a window on every
 * `teamai init`. CI runs on ubuntu/macos only, so there is no Windows runner to
 * catch a regression; these assertions on the spawn options are the guard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockedSpawnSync } = vi.hoisted(() => ({
  mockedSpawnSync: vi.fn((..._args: unknown[]) => ({ status: 0, stdout: '', stderr: '' })),
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  spawnSync: mockedSpawnSync,
  exec: vi.fn(),
  execSync: vi.fn(),
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  fork: vi.fn(),
}));

// `gfRepoClone` only clones when the token-aware URL builder yields a URL.
vi.mock('../providers/tgit/rest-auth.js', () => ({
  tgitGitCloneUrl: (url: string) => url,
  tgitFetch: vi.fn(),
}));

import { cnbRepoClone } from '../providers/cnb/cnb-cli.js';
import { ghRepoClone } from '../providers/github/gh-cli.js';
import { gitcodeRepoClone } from '../providers/gitcode/gitcode-api.js';
import { gitlabRepoClone } from '../providers/gitlab/gitlab-api.js';
import { gfRepoClone } from '../providers/tgit/gf-cli.js';

const ORIGINAL_ENV = { ...process.env };

function gitCalls(): unknown[][] {
  return mockedSpawnSync.mock.calls.filter((call) => call[0] === 'git') as unknown[][];
}

beforeEach(() => {
  mockedSpawnSync.mockClear();
  process.env.GITHUB_TOKEN = 'test-token';
  process.env.GITLAB_TOKEN = 'test-token';
  process.env.GITCODE_TOKEN = 'test-token';
  // Deliberately unset: the no-token CNB path is the one that also writes the
  // local credential helper, so it exercises two git launches instead of one.
  delete process.env.CNB_TOKEN;
  delete process.env.CNB_ACCESS_TOKEN;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('provider clone: git child launches hide the console window', () => {
  const cases: Array<[string, () => void, number]> = [
    ['ghRepoClone', () => ghRepoClone('owner/repo', 'D:/tmp/e2e-gh'), 1],
    ['gitlabRepoClone', () => gitlabRepoClone('owner/repo', 'D:/tmp/e2e-gl'), 1],
    ['gitcodeRepoClone', () => gitcodeRepoClone('owner/repo', 'D:/tmp/e2e-gc'), 1],
    ['cnbRepoClone', () => cnbRepoClone('owner/repo', 'D:/tmp/e2e-cnb'), 2],
    ['gfRepoClone', () => gfRepoClone('owner/repo', 'D:/tmp/e2e-gf'), 1],
  ];

  for (const [name, invoke, expectedLaunches] of cases) {
    it(`${name} passes windowsHide: true to every git launch`, () => {
      invoke();
      const calls = gitCalls();
      expect(calls.length).toBe(expectedLaunches);
      for (const call of calls) {
        expect(call[2]).toEqual(expect.objectContaining({ windowsHide: true }));
      }
    });
  }
});
