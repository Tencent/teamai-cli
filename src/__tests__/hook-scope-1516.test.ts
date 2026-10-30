/**
 * resolveHookConfig (#1516): a hook whose payload names a directory that holds
 * no teamai scope keeps the scope its session recorded. A host that sends its
 * own directory — the CodeBuddy plugin sends the extension host's — names a
 * place no scope lives in, and every handler that needs one is then dropped,
 * so the session's tool use is never recorded.
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
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-hook-scope-1516-')));
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
  events.map((e) => JSON.stringify({ type: 'prompt_submit', timestamp: new Date().toISOString(), tool: 'codebuddy', ...e })).join('\n') + '\n',
);

describe('resolveHookConfig for a host that sends its own directory (#1516)', () => {
  it('resolves the scope the session recorded when the payload names no scope', async () => {
    const project = path.join(tmp, 'project');
    fs.mkdirSync(project);
    git(project, 'init', '-q');
    git(project, '-c', 'user.name=T', '-c', 'user.email=t@e.invalid', 'commit', '-q', '--allow-empty', '-m', 'init');
    // A project-scope install, and no user-scope one: the payload's directory
    // resolves to no scope at all.
    writeConfig(path.join(project, '.teamai'), { scope: 'project', projectRoot: project });
    record([{ sessionId: 's-codebuddy', cwd: project, dataHomeKey: await dataHomeKey(path.join(project, '.teamai')), projectAnchor: project }]);

    // The extension host's own directory, which is what the plugin sends.
    const config = await resolveHookConfig({ session_id: 's-codebuddy', cwd: path.parse(project).root }, 'codebuddy');

    expect(config && getDataHome(config)).toBe(path.join(project, '.teamai'));
  });

  it('keeps today\'s answer for a session that recorded nothing', async () => {
    const config = await resolveHookConfig({ session_id: 's-new', cwd: path.parse(tmp).root }, 'codebuddy');
    expect(config).toBeNull();
  });

  it('keeps the payload\'s own scope when it holds one', async () => {
    const project = path.join(tmp, 'project');
    fs.mkdirSync(project);
    git(project, 'init', '-q');
    git(project, '-c', 'user.name=T', '-c', 'user.email=t@e.invalid', 'commit', '-q', '--allow-empty', '-m', 'init');
    writeConfig(path.join(project, '.teamai'), { scope: 'project', projectRoot: project });
    record([{ sessionId: 's-codebuddy', cwd: '/somewhere/else', dataHomeKey: await dataHomeKey(path.join(project, '.teamai')), projectAnchor: project }]);

    const config = await resolveHookConfig({ session_id: 's-codebuddy', cwd: project }, 'codebuddy');

    expect(config && getDataHome(config)).toBe(path.join(project, '.teamai'));
  });

  it('recovers the project scope when the payload\'s own directory holds only the user scope', async () => {
    const project = path.join(tmp, 'project');
    fs.mkdirSync(project);
    git(project, 'init', '-q');
    git(project, '-c', 'user.name=T', '-c', 'user.email=t@e.invalid', 'commit', '-q', '--allow-empty', '-m', 'init');
    // The member installed at user scope, then joined a project: the extension
    // host's directory resolves to the user scope, the project is the scope
    // the session works in.
    writeConfig(path.join(home, '.teamai'), {});
    writeConfig(path.join(project, '.teamai'), { scope: 'project', projectRoot: project });
    record([{ sessionId: 's-codebuddy', cwd: project, dataHomeKey: await dataHomeKey(path.join(project, '.teamai')), projectAnchor: project }]);

    const config = await resolveHookConfig({ session_id: 's-codebuddy', cwd: path.parse(project).root }, 'codebuddy');

    expect(config && getDataHome(config)).toBe(path.join(project, '.teamai'));
  });

  it('does not report another repository\'s work to the team the session started in', async () => {
    const team = path.join(tmp, 'team');
    const other = path.join(tmp, 'other');
    fs.mkdirSync(team);
    fs.mkdirSync(other);
    git(team, 'init', '-q');
    git(team, '-c', 'user.name=T', '-c', 'user.email=t@e.invalid', 'commit', '-q', '--allow-empty', '-m', 'init');
    git(other, 'init', '-q');
    git(other, '-c', 'user.name=T', '-c', 'user.email=t@e.invalid', 'commit', '-q', '--allow-empty', '-m', 'init');
    writeConfig(path.join(team, '.teamai'), { scope: 'project', projectRoot: team });
    record([{ sessionId: 's-claude', cwd: team, dataHomeKey: await dataHomeKey(path.join(team, '.teamai')), projectAnchor: team }]);

    // A host whose payload names the workspace it works in reports to what
    // that directory holds: nothing, for a repository without teamai (#748).
    const config = await resolveHookConfig({ session_id: 's-claude', cwd: other }, 'claude');

    expect(config).toBeNull();
  });
});
