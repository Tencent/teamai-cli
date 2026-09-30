import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _setLogFilePath, setSilent } from '../utils/logger.js';
import { savePendingLearning } from '../utils/pending-learnings.js';
import { publishQueuedLearnings } from '../utils/learnings-publish.js';
import { writeInstallConfig } from './helpers/install-config.js';

// Real-git test (#808): `import --from-mr` publishes with the logger silenced
// (its task list owns the terminal), so a refusal warned there is never shown.
// Its reason must then carry the whole message, not "see the warning above".

const GIT_ENV = {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.co', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.co',
};

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, ...GIT_ENV } });
}

describe('a checkout refusal during a silent publish (#808)', () => {
  let testRoot: string;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    testRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-refusal-silent-')));
    process.env.HOME = testRoot;
    _setLogFilePath(path.join(testRoot, 'debug.log'));
  });

  afterEach(() => {
    setSilent(false);
    process.env.HOME = originalHome;
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it('names the checkout and the way out when no warning was shown, and stays short once one was', async () => {
    const businessRoot = path.join(testRoot, 'business');
    const remote = path.join(testRoot, 'remote.git');
    const dataHome = path.join(testRoot, 'partition');
    fs.mkdirSync(path.join(businessRoot, '.teamai'), { recursive: true });
    fs.writeFileSync(path.join(businessRoot, '.teamai', 'teamai.yaml'), 'mode: self\n');
    git(['init', '-q', '--bare', remote], testRoot);
    git(['init', '-q', '-b', 'main'], businessRoot);
    git(['config', 'user.email', 't@t.co'], businessRoot);
    git(['config', 'user.name', 't'], businessRoot);
    git(['add', '-A'], businessRoot);
    git(['commit', '-q', '-m', 'init'], businessRoot);
    git(['remote', 'add', 'origin', remote], businessRoot);
    git(['push', '-q', '-u', 'origin', 'main'], businessRoot);

    // Another team's checkout of teamai-learnings where this project's would be.
    const teamRemote = path.join(testRoot, 'team.git');
    const teamSeed = path.join(testRoot, 'team-seed');
    git(['init', '-q', '--bare', teamRemote], testRoot);
    git(['init', '-q', '-b', 'teamai-learnings', teamSeed], testRoot);
    fs.writeFileSync(path.join(teamSeed, 'README.md'), 'other team\n');
    git(['add', '-A'], teamSeed);
    git(['commit', '-q', '-m', 'learnings'], teamSeed);
    git(['remote', 'add', 'origin', teamRemote], teamSeed);
    git(['push', '-q', 'origin', 'teamai-learnings'], teamSeed);
    const teamClone = path.join(dataHome, 'team-repo');
    git(['clone', '-q', teamRemote, teamClone], testRoot);
    git(['worktree', 'add', '-q', path.join(dataHome, 'learnings-wt'), 'teamai-learnings'], teamClone);

    const config = {
      repo: { localPath: path.join(businessRoot, '.teamai'), kind: 'self' as const, businessRepoRoot: businessRoot, remote },
      username: 'test',
      additionalRoles: [],
      scope: 'project' as const,
      projectRoot: businessRoot,
      dataHome,
    };
    writeInstallConfig(config);
    const queued = await savePendingLearning(config, 'note-2026-01-01-aaaaaa.md', '# Note\n');
    expect(queued.status).toBe('saved');

    setSilent(true);
    const silent = await publishQueuedLearnings(config, 'test');
    setSilent(false);
    expect(silent.published).toEqual([]);
    expect(silent.lastError).toContain(`worktree remove ${path.join(dataHome, 'learnings-wt')}`);
    expect(silent.lastError).not.toContain('see the warning above');

    // Printed this time, so the reason a caller quotes points at it.
    const shown = await publishQueuedLearnings(config, 'test');
    expect(shown.lastError).toBe('the teamai-learnings checkout belongs to another repository; see the warning above');
  });
});
