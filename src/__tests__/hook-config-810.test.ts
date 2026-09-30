/**
 * resolveHookConfig (#810): a hook whose cwd is gone keeps the scope its
 * session recorded, but only when the config at the recorded repo is still the
 * scope of that data home. The e2e test covers the common case; these cover
 * the answers that must stay today's.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { dataHomeKey, resolveHookConfig } from '../dashboard-collector.js';
import { getDataHome } from '../types.js';

let tmp = '';
let home = '';
let originalHome: string | undefined;

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-hook-config-810-')));
  home = path.join(tmp, 'home');
  fs.mkdirSync(path.join(home, '.teamai', 'dashboard'), { recursive: true });
  originalHome = process.env.HOME;
  process.env.HOME = home;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
  cwd, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
});

const writeConfig = (dataHome: string, config: Record<string, unknown>) => {
  fs.mkdirSync(dataHome, { recursive: true });
  fs.writeFileSync(path.join(dataHome, 'config.yaml'), YAML.stringify({
    repo: { localPath: path.join(dataHome, 'team-repo'), remote: 'https://example.test/team.git' },
    username: 'tester',
    ...config,
  }));
};

const record = (events: Array<Record<string, unknown>>) => fs.writeFileSync(
  path.join(home, '.teamai', 'dashboard', 'events.jsonl'),
  events.map((e) => JSON.stringify({ type: 'prompt_submit', timestamp: new Date().toISOString(), tool: 'claude', ...e })).join('\n') + '\n',
);

describe('resolveHookConfig for a removed worktree (#810)', () => {
  it('does not hand a worktree\'s own legacy scope to its main checkout\'s scope', async () => {
    const main = path.join(tmp, 'main');
    const worktree = path.join(tmp, 'wt');
    fs.mkdirSync(main);
    git(main, 'init', '-q');
    git(main, '-c', 'user.name=T', '-c', 'user.email=t@e.invalid', 'commit', '-q', '--allow-empty', '-m', 'init');
    git(main, 'worktree', 'add', '-q', worktree);
    // Two un-migrated installs: one in the main checkout, one in the worktree.
    writeConfig(path.join(main, '.teamai'), { scope: 'project', projectRoot: main });
    writeConfig(path.join(worktree, '.teamai'), { scope: 'project', projectRoot: worktree });
    writeConfig(path.join(home, '.teamai'), { scope: 'user' });
    record([{ sessionId: 's-legacy', cwd: worktree, dataHomeKey: await dataHomeKey(path.join(worktree, '.teamai')), projectAnchor: main }]);
    git(main, 'worktree', 'remove', '--force', worktree);

    const config = await resolveHookConfig({ session_id: 's-legacy', cwd: worktree }, 'claude');
    // Today's answer (the user scope), not the main checkout's other scope.
    expect(config && getDataHome(config)).toBe(path.join(home, '.teamai'));
  });

  it('keeps today\'s answer for a session that recorded nothing', async () => {
    writeConfig(path.join(home, '.teamai'), { scope: 'user' });
    record([]);
    const config = await resolveHookConfig({ session_id: 's-new', cwd: path.join(tmp, 'gone') }, 'claude');
    expect(config && getDataHome(config)).toBe(path.join(home, '.teamai'));
  });
});
