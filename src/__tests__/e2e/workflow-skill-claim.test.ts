/**
 * Real CLI: two members, each with their own HOME and install, share a team origin and a business origin. A run one
 * member stops mid-step with the local driver and publishes is claimed by the other member's coding session with
 * `workflow resume --driver skill --claim`, which drives it to done; the first member then gets `not_owner`.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { waitForDetachedChildren } from '../helpers/detached-processes.js';
import { AGENT_SESSION_ENV } from '../../utils/session-id.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');
const TEAM_URL = 'https://github.com/acme/team.git';
const BUSINESS_URL = 'https://github.com/acme/business.git';

// `build` holds, after writing, while the file HOLD_AT names exists: the member who started the run stops it there.
const RELAY = `schemaVersion: v1alpha1
name: relay
description: Build, then write the release notes.
invoke: allow
steps:
  - id: build
    command: node -e "const fs=require('fs'); const hold=process.env.HOLD_AT; if (hold && fs.existsSync(hold)) { fs.writeFileSync(hold + '.held', ''); setInterval(() => {}, 1000); }"
  - id: notes
    needs: [build]
    prompt: Write the release notes.
`;

interface Envelope {
  data?: Record<string, unknown>;
  error?: { code: string; message: string } & Record<string, unknown>;
}

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  envelope: () => Envelope;
}

/** The parts of a skill driver turn this test reads. */
interface Turn {
  run: string;
  status: string;
  actions: Array<{ kind: string; options?: Array<{ run: string }>; step?: string; ack?: string; brief?: string; report?: string; outcome?: string }>;
  events: Array<{ kind: string; step?: string; attempt?: string }>;
  then?: { kind: string; run: string };
}

let sandbox = '';
let teamOrigin = '';
let businessOrigin = '';

function homeOf(member: string): string {
  return path.join(sandbox, member);
}

function workOf(member: string): string {
  return path.join(homeOf(member), 'work');
}

function envOf(member: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeOf(member),
    USERPROFILE: homeOf(member),
    GIT_CONFIG_GLOBAL: path.join(homeOf(member), '.gitconfig'),
    GIT_TERMINAL_PROMPT: '0',
    FORCE_COLOR: '0',
    ...extra,
  };
  for (const name of ['XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'TEAMAI_WORKFLOW_ATTEMPT', ...AGENT_SESSION_ENV]) {
    if (!(name in extra)) delete env[name];
  }
  return env;
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function originGit(origin: string, ...args: string[]): string {
  return git(sandbox, ['--git-dir', origin, ...args]);
}

/** Runs the CLI as `member`; with `detached`, in a process group of its own, as a terminal's foreground job. */
function teamai(member: string, args: string[], options: { env?: NodeJS.ProcessEnv; detached?: boolean; started?: (pid: number) => void } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: workOf(member),
      env: envOf(member, options.env),
      detached: options.detached === true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (child.pid !== undefined) options.started?.(child.pid);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('close', (code, signal) => resolve({
      code,
      signal,
      stdout,
      stderr,
      envelope: () => {
        const line = stdout.trim().split('\n').filter((item) => item.startsWith('{')).at(-1);
        if (!line) throw new Error(`no JSON envelope in stdout:\n${stdout}\n${stderr}`);
        return JSON.parse(line) as Envelope;
      },
    }));
  });
}

function said(result: RunResult): string {
  return `exit ${result.code}\n${result.stdout}\n${result.stderr}`;
}

async function waitFor(file: string, ms: number): Promise<boolean> {
  for (let waited = 0; !fs.existsSync(file); waited += 100) {
    if (waited >= ms) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}

function publishedState(run: string): { status: string; owner: { id: string } } {
  return JSON.parse(originGit(teamOrigin, 'show', `teamai-reports:workflows/runs/${run}/state.json`)) as { status: string; owner: { id: string } };
}

function seed(dir: string, files: Record<string, string>, message: string, origin: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.com', 'commit', '-qm', message]);
  git(dir, ['push', '-q', origin, 'main']);
}

async function join(member: string): Promise<void> {
  const home = homeOf(member);
  fs.mkdirSync(home, { recursive: true });
  // init needs a forge URL; git maps it onto the bare origins, so nothing leaves the machine.
  fs.writeFileSync(path.join(home, '.gitconfig'), [
    '[user]', `\tname = ${member}`, `\temail = ${member}@example.com`,
    `[url "file://${teamOrigin}"]`, `\tinsteadOf = ${TEAM_URL}`,
    `[url "file://${businessOrigin}"]`, `\tinsteadOf = ${BUSINESS_URL}`, '',
  ].join('\n'));
  git(sandbox, ['clone', '-q', BUSINESS_URL, workOf(member)], envOf(member));
  const init = await teamai(member, ['init', TEAM_URL, '--provider', 'git', '--agent', 'claude', '--scope', 'user', '--force']);
  expect(init.code, said(init)).toBe(0);
  const pulled = await teamai(member, ['pull']);
  expect(pulled.code, said(pulled)).toBe(0);
}

describe('a coding session claims a run another member published', () => {
  beforeAll(async () => {
    sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-skill-claim-e2e-')));
    teamOrigin = path.join(sandbox, 'team.git');
    businessOrigin = path.join(sandbox, 'business.git');
    git(sandbox, ['init', '-q', '--bare', '-b', 'main', teamOrigin]);
    git(sandbox, ['init', '-q', '--bare', '-b', 'main', businessOrigin]);
    seed(path.join(sandbox, 'seed-team'), {
      'teamai.yaml': `team: acme\nrepo: ${TEAM_URL}\nprovider: github\n`,
      'workflows/relay.yaml': RELAY,
    }, 'team repo', teamOrigin);
    seed(path.join(sandbox, 'seed-business'), { 'README.md': '# business\n' }, 'business repo', businessOrigin);
    await join('alice');
    await join('bob');
  }, 120_000);

  afterAll(async () => {
    await waitForDetachedChildren();
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('drives the claimed run to done from the session, and leaves the member who published it not_owner', async () => {
    const hold = path.join(sandbox, 'hold');
    fs.writeFileSync(hold, '');
    let pid = 0;
    const started = teamai('alice', ['workflow', 'start', 'relay', '--driver', 'local'], {
      env: { HOLD_AT: hold }, detached: true, started: (value) => { pid = value; },
    });
    expect(await waitFor(`${hold}.held`, 30_000), 'alice reached build').toBe(true);
    // Ctrl-C in a terminal: the foreground group, the driver and the command it runs, gets SIGINT.
    process.kill(-pid, 'SIGINT');
    const stopped = await started;
    expect(stopped.signal, said(stopped)).toBe('SIGINT');
    fs.rmSync(hold);
    const run = /Run (r[0-9a-f]{16}) started\./m.exec(stopped.stderr)?.[1] ?? '';
    expect(run, said(stopped)).not.toBe('');

    const published = await teamai('alice', ['workflow', 'publish', run]);
    expect(published.code, said(published)).toBe(0);
    const [held] = (published.envelope().data?.inFlight ?? []) as Array<{ step: string; attempt: string }>;
    expect(held, said(published)).toMatchObject({ step: 'build' });
    const alices = publishedState(run).owner.id;

    const session = { CLAUDE_CODE_SESSION_ID: 'session-bob' };
    /** Runs a literal the CLI printed, `teamai …`, in bob's coding session: its answer. */
    const literal = async (line: string): Promise<Envelope> => {
      const result = await teamai('bob', line.split(' ').slice(1), { env: session });
      expect(result.code, said(result)).toBe(0);
      return result.envelope();
    };
    const turnOf = (envelope: Envelope): Turn => {
      const turn = envelope.data?.turn as Turn | undefined;
      if (!turn) throw new Error(JSON.stringify(envelope));
      return turn;
    };

    let turn = turnOf(await literal(`teamai workflow resume ${run} --driver skill --claim`));
    expect(turn).toMatchObject({ run, status: 'driving', actions: [{ kind: 'choose' }] });
    expect(publishedState(run).owner.id, 'the claim made bob the owner').not.toBe(alices);
    const h1 = turn.actions[0]?.options?.[0]?.run ?? '';
    turn = turnOf(await literal(h1));
    const events = [...turn.events];
    for (let poll = 0; poll < 10 && !turn.actions.some((action) => action.kind === 'dispatch'); poll += 1) {
      turn = turnOf(await literal(turn.then?.kind === 'wake' ? `teamai workflow next ${run} --driver skill` : turn.then?.run ?? ''));
      events.push(...turn.events);
    }
    expect(events, 'bob ran the step alice held again').toContainEqual({ kind: 'started', step: 'build', attempt: expect.not.stringMatching(held?.attempt ?? '') });
    const dispatch = turn.actions.find((action) => action.kind === 'dispatch');
    expect(dispatch, JSON.stringify(turn)).toMatchObject({ step: 'notes' });
    await literal(dispatch?.ack ?? '');
    const result = /Write `([^`]+result\.json)`/.exec(fs.readFileSync(dispatch?.brief ?? '', 'utf8'))?.[1] ?? '';
    fs.writeFileSync(result, JSON.stringify({ kind: 'output', output: 'Wrote the release notes.' }));
    expect(await literal(dispatch?.report ?? '')).toMatchObject({ data: { runner: { status: 'reported' } } });
    turn = turnOf(await literal(`teamai workflow next ${run} --driver skill`));
    for (let poll = 0; poll < 10 && turn.status !== 'done'; poll += 1) turn = turnOf(await literal(turn.then?.run ?? ''));
    expect(turn).toMatchObject({ run, status: 'done', actions: [{ kind: 'done', outcome: 'succeeded' }] });
    expect(publishedState(run), 'the run published how it ended').toMatchObject({ status: 'succeeded' });

    const refused = await teamai('alice', ['workflow', 'resume', run]);
    expect(refused.code, said(refused)).toBe(1);
    expect(refused.envelope()).toMatchObject({ error: { code: 'not_owner', owner: publishedState(run).owner } });
  }, 240_000);
});
