import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ensureReportsWorktree } from '../utils/reports-branch.js';
import type { LocalConfig } from '../types.js';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI test',
  GIT_AUTHOR_EMAIL: 'test@teamai.invalid',
  GIT_COMMITTER_NAME: 'TeamAI test',
  GIT_COMMITTER_EMAIL: 'test@teamai.invalid',
};

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, ...GIT_ENV } });
}

describe('side-branch worktree ownership across scopes (#1443)', () => {
  let sandbox: string;
  let oldHome: string | undefined;
  let business: string;
  let remote: string;
  let userConfig: LocalConfig;
  let projectConfig: LocalConfig;

  beforeEach(() => {
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-scope-evict-')));
    oldHome = process.env.HOME;
    process.env.HOME = path.join(sandbox, 'home');
    fs.mkdirSync(process.env.HOME, { recursive: true });

    remote = path.join(sandbox, 'team.git');
    business = path.join(sandbox, 'business');
    git(['init', '-q', '--bare', remote], sandbox);
    git(['init', '-q', '-b', 'main', business], sandbox);
    fs.mkdirSync(path.join(business, '.teamai'), { recursive: true });
    fs.writeFileSync(path.join(business, '.teamai', 'teamai.yaml'), 'mode: self\n');
    git(['add', '-A'], business);
    git(['commit', '-qm', 'init'], business);
    git(['remote', 'add', 'origin', remote], business);
    git(['push', '-q', '-u', 'origin', 'main'], business);

    // The reports orphan branch lives on the team remote.
    git(['checkout', '-q', '--orphan', 'teamai-reports'], business);
    git(['rm', '-qrf', '.'], business);
    fs.writeFileSync(path.join(business, '.gitignore'), 'reports-wt/\n');
    git(['add', '.gitignore'], business);
    git(['commit', '-qm', 'reports'], business);
    git(['push', '-q', 'origin', 'teamai-reports'], business);
    git(['checkout', '-q', 'main'], business);

    const repo = {
      localPath: path.join(business, '.teamai'),
      kind: 'self' as const,
      businessRepoRoot: business,
      remote,
    };
    userConfig = { repo, username: 'tester', scope: 'user', additionalRoles: [] };
    projectConfig = {
      repo,
      username: 'tester',
      scope: 'project',
      projectRoot: business,
      dataHome: path.join(process.env.HOME!, '.teamai', 'projects', 'workspace'),
      additionalRoles: [],
    };
  });

  afterEach(() => {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('lets the user scope take the reports checkout back from the project scope', async () => {
    const projectWt = await ensureReportsWorktree(projectConfig);
    expect(fs.existsSync(projectWt)).toBe(true);

    // Before #1443 this threw CheckoutRefusedError: the project worktree was
    // not under a `.teamai/` suffix, so the user scope could not evict it.
    const userWt = await ensureReportsWorktree(userConfig);

    expect(userWt).toBe(path.join(process.env.HOME!, '.teamai', 'reports-wt'));
    expect(fs.existsSync(userWt)).toBe(true);
    expect(fs.existsSync(projectWt)).toBe(false);
  });

  it('leaves a checkout the member made outside teamai alone', async () => {
    const elsewhere = path.join(sandbox, 'elsewhere-reports');
    git(['worktree', 'add', '-q', elsewhere, 'teamai-reports'], business);

    // teamai did not create that checkout, so it must not delete it, however
    // clean: the worktree add fails and the member is told which one is in the way.
    await expect(ensureReportsWorktree(userConfig)).rejects.toThrow(/already (used by worktree|checked out)/);

    expect(fs.existsSync(elsewhere)).toBe(true);
    expect(fs.existsSync(path.join(process.env.HOME!, '.teamai', 'reports-wt'))).toBe(false);
  });

  it('leaves a member checkout under a non-teamai projects path alone', async () => {
    const memberWt = path.join(sandbox, 'code', 'projects', 'demo', 'reports-wt');
    fs.mkdirSync(path.dirname(memberWt), { recursive: true });
    git(['worktree', 'add', memberWt, 'teamai-reports'], business);

    await expect(ensureReportsWorktree(projectConfig)).rejects.toThrow(/already (used by worktree|checked out)|still has/);
    expect(fs.existsSync(memberWt)).toBe(true);
  });
});
