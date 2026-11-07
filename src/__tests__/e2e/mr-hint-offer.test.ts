/**
 * E2E: the SessionStart hook's MR hint offers teamai-import-from-mr while `sharing.mrHint.enabled` leaves it on, and
 * `workflow start --describe` then proposes, to that session, the PR the hint listed. `gh` is a stand-in on PATH; the
 * team repo is a local bare repository.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../dist/index.js');
const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_TERMINAL_PROMPT: '0' };
const PR7 = 'https://github.com/acme/app/pull/7';
const SESSION = 'mr-hint-session';

const sandboxes: string[] = [];

afterEach(() => {
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

  return { app, teamRepo, run };
}

describe('the session-start MR hint', () => {
  it('offers teamai-import-from-mr, whose describe proposes the PR it listed to that session', () => {
    const { app, teamRepo, run } = sandbox([]);

    const hook = run(['hook-dispatch', 'session-start', '--tool', 'claude'], {}, JSON.stringify({ cwd: app, session_id: SESSION, hook_event_name: 'SessionStart' }));

    expect(hook.status, hook.stderr).toBe(0);
    expect(hook.stdout).toContain(`- Retry flaky upload (merged: ${new Date().toISOString().slice(0, 10)}) ${PR7}`);
    expect(hook.stdout).toContain('teamai workflow start --describe teamai-import-from-mr --driver skill');
    expect(hook.stdout).not.toContain('teamai import --from-mr');

    const described = run(['workflow', 'start', '--describe', 'teamai-import-from-mr', '--driver', 'skill'], { CLAUDE_CODE_SESSION_ID: SESSION });

    expect(described.status, described.stderr).toBe(0);
    const inputs: unknown = JSON.parse(described.stdout).data.describe.ask.question.inputs;
    expect(inputs).toContainEqual(expect.objectContaining({ name: 'mrs', value: [PR7] }));
    expect(inputs).toContainEqual(expect.objectContaining({ name: 'dir', value: teamRepo }));
    expect(inputs).toContainEqual(expect.objectContaining({ name: 'language', value: 'en' }));
  });

  it('says nothing while sharing.mrHint.enabled is false', () => {
    const { app, run } = sandbox(['sharing:', '  mrHint:', '    enabled: false']);

    const hook = run(['hook-dispatch', 'session-start', '--tool', 'claude'], {}, JSON.stringify({ cwd: app, session_id: SESSION, hook_event_name: 'SessionStart' }));

    expect(hook.status, hook.stderr).toBe(0);
    expect(hook.stdout).not.toContain('[teamai:mr-hint]');
  });
});
