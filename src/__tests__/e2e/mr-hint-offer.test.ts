/**
 * E2E: the MR hint a session start's background pass leaves is shown at the session's first prompt, offering
 * teamai-import-from-mr while `sharing.mrHint.enabled` leaves it on, and `workflow start --describe` then proposes, to
 * that session, the PR the hint listed. `gh` is a stand-in on PATH; the team repo is a local bare repository.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForDetachedChildrenSync } from '../helpers/detached-processes.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../dist/index.js');
const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_TERMINAL_PROMPT: '0' };
const PR7 = 'https://github.com/acme/app/pull/7';
const SESSION = 'mr-hint-session';

const sandboxes: string[] = [];

afterEach(() => {
  // The session start's background pass writes into the sandbox HOME; it ends before the sandbox goes.
  waitForDetachedChildrenSync();
  for (const root of sandboxes.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } });
}

/** A member in git mode on a local bare team repo of `teamYaml`, in a checkout of acme/app whose `gh` lists PR 7 as merged now. */
function sandbox(teamYaml: string[]) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-mr-hint-offer-')));
  sandboxes.push(root);
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.teamai'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = t\n\temail = t@t\n');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const merged = JSON.stringify([{ number: 7, title: 'Retry flaky upload', url: PR7, mergedAt: new Date().toISOString() }]);
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nif [ "$1 $2" = "pr list" ]; then echo '${merged}'; exit 0; fi\necho "fake gh: $*" >&2; exit 1\n`, { mode: 0o755 });
  const remote = path.join(root, 'team.git');
  const work = path.join(root, 'team-work');
  const teamRepo = path.join(home, '.teamai', 'team-repo');
  git(['init', '-q', '--bare', '-b', 'main', remote], root);
  git(['init', '-q', '-b', 'main', work], root);
  fs.writeFileSync(path.join(work, 'teamai.yaml'), ['team: mr', `repo: ${remote}`, 'provider: git', 'usageReport: false', 'language: en', ...teamYaml, ''].join('\n'));
  git(['add', '-A'], work);
  git(['commit', '-qm', 'team'], work);
  git(['push', '-q', remote, 'main'], work);
  git(['clone', '-q', remote, teamRepo], root);
  fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), [
    'repo:', `  localPath: ${teamRepo}`, `  remote: ${remote}`, '  kind: git',
    'username: alice', 'updatePolicy: auto', 'additionalRoles: []', 'scope: user', 'enabledAgents: [claude]', '',
  ].join('\n'));
  const app = path.join(root, 'app');
  git(['init', '-q', '-b', 'main', app], root);
  git(['remote', 'add', 'origin', 'https://github.com/acme/app.git'], app);

  const { CLAUDE_CODE_SESSION_ID: _session, TEAMAI_MODE: _mode, TEAMAI_LAUNCHED_BY: _launched, TEAMAI_WORKFLOW_ATTEMPT: _attempt, TEAMAI_MR_HINT_DISABLED: _off, GITHUB_TOKEN: _token, GH_TOKEN: _gh, ...inherited } = process.env;
  const env = {
    ...inherited, ...GIT_ENV, HOME: home, USERPROFILE: home, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, FORCE_COLOR: '0', NO_COLOR: '1',
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', TEAMAI_CONTRIBUTE_HINT_DISABLED: '1',
  };
  const run = (args: string[], extra: Record<string, string> = {}, input = '') => spawnSync(process.execPath, [CLI, ...args], { cwd: app, env: { ...env, ...extra }, input, encoding: 'utf8' });
  const pulled = run(['pull']);

  if (pulled.status !== 0) throw new Error(`teamai pull failed: ${pulled.stdout}${pulled.stderr}`);

  const pendingHint = path.join(home, '.teamai', 'sessions', `${SESSION}.mr-hint.pending.json`);
  const hook = (event: 'session-start' | 'prompt-submit') => run(['hook-dispatch', event, '--tool', 'claude'], {}, JSON.stringify(event === 'session-start'
    ? { cwd: app, session_id: SESSION, hook_event_name: 'SessionStart' }
    : { cwd: app, session_id: SESSION, hook_event_name: 'UserPromptSubmit', prompt: 'hi' }));

  return { app, teamRepo, run, pendingHint, hook };
}

describe('the MR hint at the session\'s first prompt', () => {
  it('offers teamai-import-from-mr, whose describe proposes the PR it listed to that session', async () => {
    const { teamRepo, run, pendingHint, hook } = sandbox([]);

    const started = hook('session-start');

    expect(started.status, started.stderr).toBe(0);
    expect(started.stdout).not.toContain(PR7);
    await vi.waitFor(() => expect(fs.existsSync(pendingHint)).toBe(true), { timeout: 30_000, interval: 50 });

    const prompt = hook('prompt-submit');

    expect(prompt.status, prompt.stderr).toBe(0);
    expect(prompt.stdout).toContain(`- Retry flaky upload (merged: ${new Date().toISOString().slice(0, 10)}) ${PR7}`);
    expect(prompt.stdout).toContain('teamai workflow start --describe teamai-import-from-mr --driver skill');
    expect(prompt.stdout).not.toContain('teamai import --from-mr');

    const second = hook('prompt-submit');

    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toBe('');

    const described = run(['workflow', 'start', '--describe', 'teamai-import-from-mr', '--driver', 'skill'], { CLAUDE_CODE_SESSION_ID: SESSION });

    expect(described.status, described.stderr).toBe(0);
    const inputs: unknown = JSON.parse(described.stdout).data.describe.ask.question.inputs;
    expect(inputs).toContainEqual(expect.objectContaining({ name: 'mrs', value: [PR7] }));
    expect(inputs).toContainEqual(expect.objectContaining({ name: 'dir', value: teamRepo }));
    expect(inputs).toContainEqual(expect.objectContaining({ name: 'language', value: 'en' }));
  });

  it('says nothing while sharing.mrHint.enabled is false', () => {
    const { pendingHint, hook } = sandbox(['sharing:', '  mrHint:', '    enabled: false']);

    const started = hook('session-start');

    expect(started.status, started.stderr).toBe(0);
    expect(started.stdout).not.toContain(PR7);
    waitForDetachedChildrenSync();
    expect(fs.existsSync(pendingHint)).toBe(false);

    const prompt = hook('prompt-submit');

    expect(prompt.status, prompt.stderr).toBe(0);
    expect(prompt.stdout).not.toContain(PR7);
    expect(prompt.stdout).not.toContain('teamai-import-from-mr');
  });
});
