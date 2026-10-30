import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGit, createGitWithBlockTimeout } from '../utils/git.js';

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe.each([
  ['createGit', createGit],
  ['createGitWithBlockTimeout', createGitWithBlockTimeout],
] as const)('%s caller identity', (_name, factory) => {
  it('uses the caller global and counted Git configuration', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-git-environment-'));
    roots.push(root);
    execFileSync('git', ['init', '-q', root]);
    const globalConfig = path.join(root, 'global.gitconfig');
    fs.writeFileSync(globalConfig, '[teamai]\n  origin = global\n');
    vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'teamai.counted');
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'caller');

    const git = factory(root);
    expect((await git.raw(['config', '--get', 'teamai.origin'])).trim()).toBe('global');
    expect((await git.raw(['config', '--get', 'teamai.counted'])).trim()).toBe('caller');
  });

  it.skipIf(process.platform === 'win32')('runs the caller SSH command', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-git-environment-'));
    roots.push(root);
    execFileSync('git', ['init', '-q', root]);
    const marker = path.join(root, 'ssh-called');
    const ssh = path.join(root, 'ssh');
    fs.writeFileSync(ssh, `#!/bin/sh\nprintf called > "${marker}"\nexit 1\n`, { mode: 0o755 });
    vi.stubEnv('GIT_SSH_COMMAND', ssh);
    vi.stubEnv('GIT_SSH_VARIANT', 'ssh');

    await expect(factory(root).raw(['ls-remote', 'ssh://example.test/team.git'])).rejects.toThrow();
    expect(fs.readFileSync(marker, 'utf8')).toBe('called');
  });

  it('lets native Git use the caller author and committer instead of the repository fallback', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-git-environment-'));
    roots.push(root);
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Repository fallback']);
    execFileSync('git', ['-C', root, 'config', 'user.email', 'fallback@example.test']);
    vi.stubEnv('GIT_AUTHOR_NAME', 'Caller author');
    vi.stubEnv('GIT_AUTHOR_EMAIL', 'author@example.test');
    vi.stubEnv('GIT_AUTHOR_DATE', '@946684800 +0000');
    vi.stubEnv('GIT_COMMITTER_NAME', 'Caller committer');
    vi.stubEnv('GIT_COMMITTER_EMAIL', 'committer@example.test');
    vi.stubEnv('GIT_COMMITTER_DATE', '@946684801 +0000');

    const git = factory(root);
    expect((await git.raw(['var', 'GIT_AUTHOR_IDENT'])).trim()).toBe('Caller author <author@example.test> 946684800 +0000');
    expect((await git.raw(['var', 'GIT_COMMITTER_IDENT'])).trim()).toBe('Caller committer <committer@example.test> 946684801 +0000');
  });
});
