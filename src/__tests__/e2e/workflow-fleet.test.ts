/**
 * Real CLI: the fleet. Two members, each with their own HOME and data home, share one bare origin, which holds the
 * business repository and the team repository's teamai-reports. Alice starts a run on a definition whose first runtime
 * is `fleet`; Bob takes its command step with `workflow resume --next --pool`, runs it on his own machine and pushes
 * its work to the attempt's ref. Alice need not stay up: a later `workflow resume` collects what Bob wrote.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { CLAUDE_SESSIONS, CLI, fakeTool } from '../helpers/step-runtime-e2e.js';
import { installToyRuntime } from '../helpers/toy-runtime.js';
import { REPORTS_LOCK_FILENAME } from '../../types.js';
import { signalGroup, signalPid } from '@teamai/shared/process-group';

const URL = 'https://github.com/acme/business.git';

const flow = (name: string, steps: string): string => `schemaVersion: v1alpha1\nname: ${name}\ndescription: ${name}\nsteps:\n${steps}`;

/**
 * `remote` goes to the fleet; `here`, a prompt step on a tool the fleet's pool does not list (`can.tools: []`), which
 * needs nothing of `remote`, runs on Alice's `local` while the fleet holds `remote`.
 */
const SPLIT = flow('split', `  - id: remote
    workspace: new
    command: node -e "require('fs').writeFileSync('built.txt', 'B'); console.log(JSON.stringify({built:true}))"
  - id: here
    needs: []
    workspace: new
    prompt: Write here.txt.
  - id: after
    needs: [remote, here]
    command: node -e "process.exit(0)"
`);

/** Writes part of its work, then waits for a file that never comes, unless an earlier attempt's work is already there. */
const SLOW = flow('slow', `  - id: long
    workspace: new
    command: node -e "const fs = require('fs'); if (fs.existsSync('partial.txt')) { fs.writeFileSync('done.txt', 'D'); process.exit(0); } fs.writeFileSync('partial.txt', 'P'); setInterval(() => {}, 1000)"
`);

/** A command on the owner's own machine that runs until stopped, writing its pid where the test reads it. */
const HOLD = flow('hold', `  - id: hold
    command: node -e "require('fs').writeFileSync(require('os').homedir() + '/hold.pid', String(process.pid)); setInterval(() => {}, 1000)"
`);

/** One command step. */
const ONE = flow('one', `  - id: build
    workspace: new
    command: node -e "require('fs').writeFileSync('built.txt', 'B')"
`);

/** Leaves a file uncommitted past a progress write, then checks that git still shows it so: the member's beat left it alone. */
const LOOK = flow('look', `  - id: look
    workspace: new
    command: node -e "require('fs').writeFileSync('made.txt', 'M'); setTimeout(() => process.exit(3 * Number(!require('child_process').execSync('git status --porcelain').toString().includes('made.txt'))), 4000)"
`);

/** Three items, each written by the member that runs it. */
const FAN = `schemaVersion: v1alpha1
name: fan
description: fan
inputs: { parts: [string] }
defaults:
  inputs: { parts: [a, b, c] }
steps:
  - id: part
    workspace: new
    for_each: inputs.parts
    env:
      PART: "{{ item }}"
    command: node -e "require('fs').writeFileSync('part-' + process.env.PART + '.txt', process.env.PART)"
`;

/** A workflow step whose two commands work in its copy, so the fleet takes it whole. */
const WHOLE = `schemaVersion: v1alpha1
name: whole
description: whole
outputs:
  counted: steps.pair.outputs.counted
steps:
  - id: pair
    workspace: new
    workflow: pair
    with:
      mark: made.txt
`;

const PAIR = `schemaVersion: v1alpha1
name: pair
description: pair
inputs: { mark: string }
outputs:
  counted: steps.count.outputs.counted
steps:
  - id: write
    workspace: continue
    env:
      MARK: "{{ inputs.mark }}"
    command: node -e "require('fs').writeFileSync(process.env.MARK, 'W')"
  - id: count
    needs: [write]
    workspace: continue
    command: node -e "console.log(JSON.stringify({counted:Number(require('fs').existsSync('made.txt'))}))"
    output:
      counted: number
`;

/** A workflow step whose first command requires this machine, so it runs where it stands rather than whole on a member. */
const WHOLE_PINNED = `schemaVersion: v1alpha1
name: wholepinned
description: wholepinned
outputs:
  counted: steps.pair.outputs.counted
steps:
  - id: pair
    workspace: new
    workflow: pinnedpair
    with:
      mark: made.txt
`;
const PINNED_PAIR = PAIR.replace('name: pair\ndescription: pair', 'name: pinnedpair\ndescription: pinnedpair')
  .replace('  - id: write\n    workspace: continue\n', '  - id: write\n    workspace: continue\n    requires: { host: true }\n');

/** A workflow step a member takes whole, whose one command holds until stopped the first time, writing its pid where the test reads it. */
const WHOLE_HOLD = flow('wholehold', `  - id: pair
    workspace: new
    workflow: holdone
`);
const HOLD_ONE = flow('holdone', `  - id: hold
    workspace: continue
    command: node -e "const fs = require('fs'); const pid = require('os').homedir() + '/nested.pid'; if (fs.existsSync(pid)) process.exit(0); fs.writeFileSync(pid, String(process.pid)); setInterval(() => {}, 1000)"
`);

/** A run on a budget whose one workflow step a member takes whole; its prompt spends more than the run may. */
const WHOLE_SPEND = `schemaVersion: v1alpha1
name: wholespend
description: wholespend
budget: { tokens: 5 }
steps:
  - id: pair
    workspace: new
    workflow: spendone
`;
const SPEND_ONE = flow('spendone', `  - id: review
    workspace: continue
    tool: claude
    prompt: Review the work.
    output:
      ok: boolean
`);

/** A run on a budget whose workflow step a member takes whole: a review that spends 6 of its 10 tokens, then a hold. */
const WHOLE_SPEND_HOLD = `schemaVersion: v1alpha1
name: wholespendhold
description: wholespendhold
budget: { tokens: 10 }
steps:
  - id: pair
    workspace: new
    workflow: spendhold
`;
const SPEND_HOLD = flow('spendhold', `  - id: review
    workspace: continue
    tool: claude
    prompt: Review the work.
    output:
      ok: boolean
  - id: hold
    needs: [review]
    workspace: continue
    command: node -e "const fs = require('fs'); const pid = require('os').homedir() + '/nested.pid'; if (fs.existsSync(pid)) process.exit(0); fs.writeFileSync(pid, String(process.pid)); setInterval(() => {}, 1000)"
`);

const FLEET = { schemaVersion: 'v1alpha1', name: 'build-fleet', tool: 'claude', runtimes: [{ use: 'fleet', options: { pool: 'build', stale_after: '6s', max_parallel: 1, can: { tools: [] } } }, { use: 'local' }] };

/** The default pool, two attempts out at once. */
/** The default pool, whose members run claude and report the tokens it spent. */
const TOKEN_FLEET = { schemaVersion: 'v1alpha1', name: 'token-fleet', runtimes: [{ use: 'fleet', options: { can: { tools: ['claude'], tokens: true } } }, { use: 'local' }] };

const FAN_FLEET = { schemaVersion: 'v1alpha1', name: 'fan-fleet', runtimes: [{ use: 'fleet', options: { max_parallel: 2 } }, { use: 'local' }] };

/** Pool `wake`, whose offers the toy wakes a member for; the toy's options come from the owner's own config. */
const WAKE_FLEET = { schemaVersion: 'v1alpha1', name: 'wake-fleet', runtimes: [{ use: 'fleet', options: { pool: 'wake', wake: { use: 'toy' } } }, { use: 'local' }] };

interface Envelope { data?: Record<string, unknown>; error?: { code: string; message: string } }

interface RunResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; envelope: () => Envelope }

let sandbox = '';
let origin = '';

const homeOf = (member: string): string => path.join(sandbox, member);
const workOf = (member: string): string => path.join(homeOf(member), 'work');

/** Each member's PATH starts with a fake Claude Code, which writes each launch to `launches`. */
const binOf = (member: string): string => path.join(homeOf(member), 'bin');
const launchesOf = (member: string): string => path.join(homeOf(member), 'launches.jsonl');
/** Each wake the toy runtime on Alice's machine was sent, one JSON line each. */
const wakeLog = (): string => path.join(homeOf('alice'), 'wakes.jsonl');

function envOf(member: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: homeOf(member), USERPROFILE: homeOf(member), GIT_CONFIG_GLOBAL: path.join(homeOf(member), '.gitconfig'), GIT_TERMINAL_PROMPT: '0', FORCE_COLOR: '0',
    PATH: `${binOf(member)}${path.delimiter}${process.env.PATH ?? ''}`, LAUNCHES: launchesOf(member),
  };
  delete env.XDG_CONFIG_HOME;
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;

  return env;
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const originGit = (...args: string[]): string => git(sandbox, ['--git-dir', origin, ...args]);

/** The process group each CLI call leads, which teardown stops whether or not the call is still running. */
const groups = new Set<number>();

/**
 * Runs the CLI as `member`; `started` gets its pid. A call still running after `limitMs` is stopped, so its output shows
 * where it waited. It leads a process group of its own, so teardown reaches what it started without reaching this test.
 */
function teamai(member: string, args: string[], started?: (pid: number) => void, limitMs = 90_000): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: workOf(member), env: envOf(member), stdio: ['ignore', 'pipe', 'pipe'], detached: true });

    if (child.pid !== undefined) {
      groups.add(child.pid);
      started?.(child.pid);
    }
    let stdout = '';
    let stderr = '';
    const limit = setTimeout(() => {
      stderr += `\n[test] ${args.join(' ')} was still running after ${limitMs} ms, so it was stopped`;
      child.kill('SIGTERM');
    }, limitMs);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('close', (code, signal) => clearTimeout(limit) ?? resolve({
      code, signal, stdout, stderr,
      envelope: () => {
        const line = stdout.trim().split('\n').findLast((item) => item.startsWith('{'));

        if (!line) throw new Error(`no JSON envelope in stdout:\n${stdout}\n${stderr}`);

        return JSON.parse(line) as Envelope;
      },
    }));
  });
}

const said = (result: RunResult): string => `exit ${result.code}\n${result.stdout}\n${result.stderr}`;

/** The record of each attempt of `run` as origin holds it. */
function records(run: string): Array<{ attempt: string; state: string; start: string; pushed?: string; lease: { step: string }; result?: { exitCode: number; to?: string } }> {
  const listed = originGit('ls-tree', '--name-only', `teamai-reports:workflows/attempts/${run}/`);

  return listed.split('\n').filter(Boolean).map((file) => JSON.parse(originGit('show', `teamai-reports:workflows/attempts/${run}/${path.basename(file)}`)) as ReturnType<typeof records>[number]);
}

async function until(check: () => boolean, ms: number): Promise<boolean> {
  for (let waited = 0; !check(); waited += 200) {
    if (waited >= ms) return false;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  return true;
}

/** Waits for `check`, else stops `pid` and fails with what its run printed. */
async function waitOn(check: () => boolean, ms: number, pid: () => number, running: Promise<RunResult>): Promise<void> {
  if (await until(check, ms)) return;

  signalPid(pid(), 'SIGTERM');

  expect.fail(said(await running));
}

/** The processes, by pid, whose working directory is inside `dir`: what a member or the command of its step left running. */
function processesIn(dir: string): number[] {
  const inside = (cwd: string): boolean => cwd === dir || cwd.startsWith(`${dir}${path.sep}`);

  if (process.platform === 'linux') {
    return fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name)).flatMap((name) => {
      try {
        return inside(fs.readlinkSync(`/proc/${name}/cwd`)) ? [Number(name)] : [];
      } catch {
        return [];
      }
    });
  }

  // lsof exits 1 when it could not read some process, and still lists the others.
  const listed = spawnSync('lsof', ['-a', '-d', 'cwd', '-u', String(os.userInfo().uid), '-F', 'pn'], { encoding: 'utf8' }).stdout ?? '';
  const found: number[] = [];
  let pid = 0;

  for (const line of listed.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && inside(line.slice(1))) found.push(pid);
  }

  return found;
}

/**
 * Stops each member's whole process group: those of the CLI calls, and those a member recorded for the command of a step,
 * which leads one of its own and outlives a member that was killed. Only a group with a process still in the sandbox is
 * signalled, so a pid reused since is left alone.
 */
async function stopMembers(): Promise<void> {
  const recorded = (dir: string): number[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const at = path.join(dir, entry.name);

    if (entry.isDirectory()) return recorded(at);

    return /^group-\d+\.json$/.test(entry.name) ? [(JSON.parse(fs.readFileSync(at, 'utf8')) as { pid: number }).pid] : [];
  });
  const live = new Set(processesIn(sandbox).map((pid) => Number(spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim())));

  for (const group of [...groups, ...recorded(sandbox)]) {
    if (!live.has(group)) continue;

    signalGroup(group, 'SIGKILL');
  }

  groups.clear();
  await until(() => processesIn(sandbox).every((pid) => pid === process.pid), 5_000);
}

/** Fails the test that left a process running in the sandbox, once it stopped them so they do not outlive the suite. */
async function expectNothingLeft(): Promise<void> {
  const left = processesIn(sandbox).filter((pid) => pid !== process.pid);
  const commands = left.map((pid) => spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim());

  for (const pid of left) {
    signalPid(pid, 'SIGKILL');
  }

  expect(commands, 'processes still running in the sandbox after the test').toEqual([]);
}

/** The runs with an attempt record on origin. */
function offeredRuns(): string[] {
  try {
    return originGit('ls-tree', '--name-only', 'teamai-reports:workflows/attempts/').split('\n').filter(Boolean).map((name) => path.basename(name));
  } catch {
    return [];
  }
}

/** `member`'s data home for their checkout, which `init --scope workspace` made. */
function dataHomeOf(member: string): string {
  const projects = path.join(homeOf(member), '.teamai', 'projects');
  const found = fs.readdirSync(projects).map((name) => path.join(projects, name))
    .find((dir) => fs.existsSync(path.join(dir, 'config.yaml')) && fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8').includes(`projectRoot: ${workOf(member)}`));

  if (!found) throw new Error(`no data home for ${workOf(member)}`);

  return found;
}

type Step = { id: string; status: string; runtime?: string; failure?: { code: string; message: string } };

function runStateOf(member: string, run: string): { steps: Step[] } {
  const file = path.join(dataHomeOf(member), 'workflows', 'runs', `${run}.json`);

  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as { steps: Step[] } : { steps: [] };
}

/** The status of `member`'s run `run`. */
function runStatusOf(member: string, run: string): string {
  return (JSON.parse(fs.readFileSync(path.join(dataHomeOf(member), 'workflows', 'runs', `${run}.json`), 'utf8')) as { status: string }).status;
}

/** The ids of `member`'s runs. */
function runsOf(member: string): string[] {
  const dir = path.join(dataHomeOf(member), 'workflows', 'runs');

  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -'.json'.length)) : [];
}

function isAlive(pid: number): boolean {
  return signalPid(pid, 0) === 'sent';
}

async function join(member: string): Promise<void> {
  fs.mkdirSync(binOf(member), { recursive: true });
  fs.writeFileSync(path.join(binOf(member), 'claude'), fakeTool({ tool: 'claude', version: '2.1.0 (Claude Code)', homeVariable: 'CLAUDE_CONFIG_DIR', sessions: CLAUDE_SESSIONS }), { mode: 0o755 });
  fs.writeFileSync(path.join(homeOf(member), '.gitconfig'), ['[user]', `\tname = ${member}`, `\temail = ${member}@example.com`, `[url "file://${origin}"]`, `\tinsteadOf = ${URL}`, ''].join('\n'));
  git(sandbox, ['clone', '-q', URL, workOf(member)], envOf(member));
  const init = await teamai(member, ['init', URL, '--provider', 'git', '--agent', 'claude', '--scope', 'workspace', '--force']);
  expect(init.code, said(init)).toBe(0);
  const pulled = await teamai(member, ['pull']);
  expect(pulled.code, said(pulled)).toBe(0);
}

describe('the fleet', () => {
  beforeAll(async () => {
    sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-fleet-e2e-')));
    origin = path.join(sandbox, 'origin.git');
    git(sandbox, ['init', '-q', '--bare', '-b', 'main', origin]);
    const seed = path.join(sandbox, 'seed');
    fs.mkdirSync(seed);
    git(seed, ['init', '-q', '-b', 'main']);
    const files: Record<string, string> = {
      'README.md': '# business\n',
      'teamai.yaml': `team: acme\nrepo: ${URL}\nprovider: github\n`,
      'workflows/split.yaml': SPLIT,
      'workflows/slow.yaml': SLOW,
      'workflows/one.yaml': ONE,
      'workflows/hold.yaml': HOLD,
      'workflows/look.yaml': LOOK,
      'workflows/fan.yaml': FAN,
      'workflows/whole.yaml': WHOLE,
      'workflows/pair.yaml': PAIR,
      'workflows/wholepinned.yaml': WHOLE_PINNED,
      'workflows/pinnedpair.yaml': PINNED_PAIR,
      'workflows/wholehold.yaml': WHOLE_HOLD,
      'workflows/wholespend.yaml': WHOLE_SPEND,
      'workflows/spendone.yaml': SPEND_ONE,
      'workflows/wholespendhold.yaml': WHOLE_SPEND_HOLD,
      'workflows/spendhold.yaml': SPEND_HOLD,
      'drivers/token-fleet.yaml': stringify(TOKEN_FLEET),
      'workflows/holdone.yaml': HOLD_ONE,
      'drivers/build-fleet.yaml': stringify(FLEET),
      'drivers/fan-fleet.yaml': stringify(FAN_FLEET),
      'drivers/wake-fleet.yaml': stringify(WAKE_FLEET),
    };

    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(seed, file)), { recursive: true });
      fs.writeFileSync(path.join(seed, file), text);
    }

    git(seed, ['add', '-A']);
    git(seed, ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.com', 'commit', '-qm', 'seed']);
    git(seed, ['push', '-q', origin, 'main']);
    await join('alice');
    await join('bob');
    await join('carol');
    // Alice runs steps beside the ones the fleet holds; the fleet's own max_parallel is the lower cap.
    const config = path.join(dataHomeOf('alice'), 'config.yaml');
    // The toy that wakes members for wake-fleet is a runtime of Alice's own, with options only her config gives it.
    fs.writeFileSync(config, `${fs.readFileSync(config, 'utf8')}workflows:\n  max_parallel: 4\n  drivers:\n    wake-fleet:\n      runtimes:\n        toy:\n          state: ${path.join(homeOf('alice'), 'toy-state')}\n          wake_log: ${wakeLog()}\n`);
    const toy = path.join(homeOf('alice'), '.teamai', 'runtimes', 'toy');
    fs.mkdirSync(toy, { recursive: true });
    installToyRuntime(toy);
  }, 180_000);

  afterEach(async () => {
    await stopMembers();
    await expectNothingLeft();
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('runs a step on a member while the owner runs what needs nothing of it, and collects it once the owner comes back', async () => {
    let alicePid = 0;
    const started = teamai('alice', ['workflow', 'start', 'split', '--driver', 'build-fleet'], (pid) => { alicePid = pid; });
    await waitOn(() => offeredRuns().length > 0, 60_000, () => alicePid, started);
    const [run = ''] = offeredRuns();
    // `here` needs nothing of `remote`, so it ran on Alice's tools, a prompt step in her teamai, while the offer waited for a member.
    await waitOn(() => runStateOf('alice', run).steps.find((step) => step.id === 'here')?.status === 'succeeded', 60_000, () => alicePid, started);
    expect(fs.readFileSync(launchesOf('alice'), 'utf8').trim().split('\n')).toHaveLength(1);
    expect(records(run).map((record) => record.state)).toEqual(['offered']);

    // The owner goes away while the attempt is out.
    expect(signalPid(alicePid, 'SIGKILL')).toBe('sent');
    await started;

    const published = await teamai('alice', ['workflow', 'publish', run]);
    expect(published.envelope().error?.code, said(published)).toBe('fleet_attempts_out');
    expect(published.envelope().error?.message).toContain(`teamai workflow resume ${run}`);

    const taken = await teamai('bob', ['workflow', 'resume', '--next', '--pool', 'build']);
    expect(taken.envelope(), said(taken)).toMatchObject({ data: { ran: { run, step: 'remote', exit_code: 0 } } });
    const [finished] = records(run);
    expect(finished).toMatchObject({ state: 'finished', result: { exitCode: 0 } });
    expect(originGit('show', `${finished?.result?.to ?? ''}:built.txt`)).toBe('B');

    // Back, Alice collects Bob's work, and offers `after`, a command step, to the fleet again.
    let resumePid = 0;
    const resuming = teamai('alice', ['workflow', 'resume', run], (pid) => { resumePid = pid; });
    await waitOn(() => records(run).some((record) => record.state === 'offered'), 60_000, () => resumePid, resuming);
    const next = await teamai('bob', ['workflow', 'resume', '--next', '--pool', 'build']);
    expect(next.envelope(), said(next)).toMatchObject({ data: { ran: { run, step: 'after', exit_code: 0 } } });
    const resumed = await resuming;
    expect(resumed.envelope(), said(resumed)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const steps = runStateOf('alice', run).steps;
    expect(steps.map((step) => [step.id, step.status, step.runtime])).toEqual([['remote', 'succeeded', 'fleet'], ['here', 'succeeded', 'tools'], ['after', 'succeeded', 'fleet']]);
    // The workflow's branch has Bob's commit; only Alice moved it.
    const branches = originGit('for-each-ref', '--format=%(refname:short)', 'refs/heads/teamai/').split('\n');
    const remoteBranch = branches.find((branch) => branch.includes('remote')) ?? '';
    expect(originGit('show', `${remoteBranch}:built.txt`)).toBe('B');
  }, 240_000);

  it('gives up a claim whose member went away once stale_after passed, and a retry goes on from what it pushed', async () => {
    let alicePid = 0;
    const started = teamai('alice', ['workflow', 'start', 'slow', '--driver', 'build-fleet'], (pid) => { alicePid = pid; });
    const before = new Set(offeredRuns());
    const fresh = (): string | undefined => offeredRuns().find((name) => !before.has(name));
    await waitOn(() => fresh() !== undefined, 60_000, () => alicePid, started);
    const run = fresh() ?? '';
    expect(signalPid(alicePid, 'SIGKILL')).toBe('sent');
    await started;

    let bobPid = 0;
    const taking = teamai('bob', ['workflow', 'resume', '--next', '--pool', 'build'], (pid) => { bobPid = pid; });
    // Bob pushed part of the work and said so, then went away.
    expect(await until(() => records(run).some((record) => record.state === 'claimed' && record.pushed !== record.start), 60_000)).toBe(true);
    const [claimed] = records(run);
    expect(signalPid(bobPid, 'SIGKILL')).toBe('sent');
    await taking;
    await new Promise((resolve) => setTimeout(resolve, 7_000));

    const back = await teamai('alice', ['workflow', 'resume', run]);
    expect(back.envelope(), said(back)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(runStateOf('alice', run).steps[0]?.failure?.code).toBe('fleet_member_gone');
    expect(records(run)).toEqual([expect.objectContaining({ state: 'expired', pushed: claimed?.pushed })]);

    const retried = await teamai('alice', ['workflow', 'retry', run, 'long']);
    expect(retried.code, said(retried)).toBe(0);
    let resumePid = 0;
    const resuming = teamai('alice', ['workflow', 'resume', run], (pid) => { resumePid = pid; });
    expect(await until(() => records(run).some((record) => record.state === 'offered'), 60_000)).toBe(true);
    const offered = records(run).find((record) => record.state === 'offered');
    // The new attempt starts from the work the gone member last pushed.
    originGit('merge-base', '--is-ancestor', claimed?.pushed ?? '', offered?.start ?? '');
    expect(originGit('show', `${offered?.start ?? ''}:partial.txt`)).toBe('P');

    const again = await teamai('bob', ['workflow', 'resume', '--next', '--pool', 'build']);
    expect(again.envelope(), said(again)).toMatchObject({ data: { ran: { run, step: 'long', exit_code: 0 } } });
    const done = await resuming;
    expect(done.envelope(), said(done)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(resumePid).toBeGreaterThan(0);
    // The expired claim stays as it was.
    expect(records(run).find((record) => record.attempt === claimed?.attempt)).toMatchObject({ state: 'expired' });
  }, 300_000);

  it('gives an attempt to one of two members that try at once, and the other takes none', async () => {
    let alicePid = 0;
    const started = teamai('alice', ['workflow', 'start', 'one', '--driver', 'build-fleet'], (pid) => { alicePid = pid; });
    const before = new Set(offeredRuns());
    const fresh = (): string | undefined => offeredRuns().find((name) => !before.has(name));
    await waitOn(() => fresh() !== undefined, 60_000, () => alicePid, started);
    const run = fresh() ?? '';

    const [bob, carol] = await Promise.all([teamai('bob', ['workflow', 'resume', '--next', '--pool', 'build']), teamai('carol', ['workflow', 'resume', '--next', '--pool', 'build'])]);
    const answers = [bob.envelope(), carol.envelope()];

    expect(answers.filter((answer) => answer.data?.ran !== undefined), `${said(bob)}\n${said(carol)}`).toEqual([{ data: { ran: expect.objectContaining({ run, step: 'build', exit_code: 0 }) } }]);
    expect(answers.filter((answer) => answer.data?.idle !== undefined)).toEqual([{ data: { idle: { offered: 0 } } }]);
    const done = await started;
    expect(done.envelope(), said(done)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
  }, 180_000);

  it('wakes a member for an offer no member claimed through the runtime the fleet entry names, and the member it started takes the step', async () => {
    let alicePid = 0;
    const before = new Set(offeredRuns());
    const fresh = (): string | undefined => offeredRuns().find((name) => !before.has(name));
    const wakes = (): Array<{ type: string; pool: string; repository: string; message: string; title: string }> => (fs.existsSync(wakeLog()) ? fs.readFileSync(wakeLog(), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as ReturnType<typeof wakes>[number]) : []);
    const started = teamai('alice', ['workflow', 'start', 'one', '--driver', 'wake-fleet'], (pid) => { alicePid = pid; });
    await waitOn(() => fresh() !== undefined && wakes().length > 0, 60_000, () => alicePid, started);
    const run = fresh() ?? '';
    const [wake] = wakes();
    expect(wake).toMatchObject({ type: 'wake', pool: 'wake', repository: URL });
    expect(wake?.message).toContain(URL);
    expect(wake?.title).toContain('build');
    expect(wake?.title).toContain('wake');

    // The owner's listing says where the member was woken.
    const listed = await teamai('alice', ['workflow', 'resume']);
    expect(listed.stdout.split('\n').find((line) => line.startsWith(run) && line.includes(' wake ')), said(listed)).toMatch(/ offered .* toy\s*$/);

    // The member the wake started runs what its message says, in a checkout of the repository it names.
    const [command = ''] = (wake?.message ?? '').split('\n');
    expect(command).toBe('teamai workflow resume --next --pool wake');
    const taken = await teamai('bob', command.split(' ').slice(1));
    expect(taken.envelope(), said(taken)).toMatchObject({ data: { ran: { run, step: 'build', exit_code: 0 } } });
    const done = await started;
    expect(done.envelope(), said(done)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(wakes()).toHaveLength(1);
  }, 180_000);

  it('writes progress without committing in the step\'s copy while the step runs, and takes the step\'s work at its end', async () => {
    let alicePid = 0;
    const started = teamai('alice', ['workflow', 'start', 'look', '--driver', 'build-fleet'], (pid) => { alicePid = pid; });
    const before = new Set(offeredRuns());
    const fresh = (): string | undefined => offeredRuns().find((name) => !before.has(name));
    await waitOn(() => fresh() !== undefined, 60_000, () => alicePid, started);
    const run = fresh() ?? '';

    const ran = await teamai('bob', ['workflow', 'resume', '--next', '--pool', 'build']);

    expect(ran.envelope(), said(ran)).toMatchObject({ data: { ran: { run, step: 'look', exit_code: 0 } } });
    const done = await started;
    expect(done.envelope(), said(done)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
  }, 180_000);

  it('writes nothing for a member whose claim was given up while it was away, and stops its command', async () => {
    let alicePid = 0;
    const started = teamai('alice', ['workflow', 'start', 'slow', '--driver', 'build-fleet'], (pid) => { alicePid = pid; });
    const before = new Set(offeredRuns());
    const fresh = (): string | undefined => offeredRuns().find((name) => !before.has(name));
    await waitOn(() => fresh() !== undefined, 60_000, () => alicePid, started);
    const run = fresh() ?? '';

    let bobPid = 0;
    const taking = teamai('bob', ['workflow', 'resume', '--next', '--pool', 'build'], (pid) => { bobPid = pid; });
    await waitOn(() => records(run).some((record) => record.state === 'claimed' && record.pushed !== record.start), 60_000, () => bobPid, taking);
    // Bob's machine sleeps past stale_after: the owner, still up, gives the claim up.
    expect(signalPid(bobPid, 'SIGSTOP')).toBe('sent');
    const failed = await started;
    expect(signalPid(bobPid, 'SIGCONT')).toBe('sent');

    expect(failed.envelope(), said(failed)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(runStateOf('alice', run).steps[0]?.failure?.code).toBe('fleet_member_gone');
    const late = await taking;
    expect(late.envelope(), said(late)).toMatchObject({ error: { code: 'state_moved' } });
    expect(records(run)).toEqual([expect.objectContaining({ state: 'expired' })]);
  }, 180_000);

  it('offers each item of a for_each as an attempt of its own, no more at once than the fleet\'s max_parallel', async () => {
    let alicePid = 0;
    const started = teamai('alice', ['workflow', 'start', 'fan', '--driver', 'fan-fleet'], (pid) => { alicePid = pid; });
    const before = new Set(offeredRuns());
    const fresh = (): string | undefined => offeredRuns().find((name) => !before.has(name));
    await waitOn(() => fresh() !== undefined && records(fresh() ?? '').length >= 2, 60_000, () => alicePid, started);
    const run = fresh() ?? '';
    // Give the loop time to offer a third, which it must not.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(records(run).map((record) => record.state)).toEqual(['offered', 'offered']);

    for (let taken = 0; taken < 3; taken += 1) {
      await waitOn(() => records(run).some((record) => record.state === 'offered'), 60_000, () => alicePid, started);
      const ran = await teamai('bob', ['workflow', 'resume', '--next', '--pool']);
      expect(ran.envelope(), said(ran)).toMatchObject({ data: { ran: { run, exit_code: 0 } } });
    }

    const done = await started;
    expect(done.envelope(), said(done)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(records(run).map((record) => [record.state, record.lease.step]).sort()).toEqual([['finished', 'part[0]'], ['finished', 'part[1]'], ['finished', 'part[2]']]);
  }, 240_000);

  it('runs a whole workflow step on a member as one attempt, its steps driven there, and settles it from what that run returned', async () => {
    let alicePid = 0;
    const before = new Set(offeredRuns());
    const started = teamai('alice', ['workflow', 'start', 'whole', '--driver', 'fan-fleet'], (pid) => { alicePid = pid; });
    const fresh = (): string | undefined => offeredRuns().find((name) => !before.has(name));
    await waitOn(() => fresh() !== undefined && records(fresh() ?? '').length > 0, 60_000, () => alicePid, started);
    const run = fresh() ?? '';
    expect(records(run)).toEqual([expect.objectContaining({ state: 'offered', lease: { kind: 'workflow', step: 'pair', inputs: { mark: 'made.txt' }, env: {} } })]);

    const ran = await teamai('bob', ['workflow', 'resume', '--next', '--pool']);
    expect(ran.envelope(), said(ran)).toMatchObject({ data: { ran: { run, step: 'pair', exit_code: 0 } } });
    const done = await started;
    expect(done.envelope(), said(done)).toMatchObject({ data: { done: { outcome: 'succeeded', outputs: { counted: 1 } } } });
    // The owner's run holds the workflow step alone: its steps ran on the member, as one attempt.
    expect(runStateOf('alice', run).steps.map((step) => [step.id, step.status, step.runtime])).toEqual([['pair', 'succeeded', 'fleet']]);
    const [finished] = records(run);
    expect(originGit('show', `${finished?.result?.to ?? ''}:made.txt`)).toBe('W');
    // The member's nested run pushed nothing of its own to origin.
    expect(originGit('for-each-ref', '--format=%(refname:short)', 'refs/heads/teamai/').split('\n').filter((branch) => branch.endsWith('/_run'))).toEqual([]);
  }, 240_000);

  it('runs a workflow step whose child requires this machine where it stands: the pinned step here, the other on a member', async () => {
    let alicePid = 0;
    const before = new Set(offeredRuns());
    const started = teamai('alice', ['workflow', 'start', 'wholepinned', '--driver', 'fan-fleet'], (pid) => { alicePid = pid; });
    const fresh = (): string | undefined => offeredRuns().find((name) => !before.has(name));
    await waitOn(() => fresh() !== undefined && records(fresh() ?? '').length > 0, 60_000, () => alicePid, started);
    const run = fresh() ?? '';
    // The member is offered the step that may leave this machine, never the workflow step whole.
    expect(records(run)).toEqual([expect.objectContaining({ state: 'offered', lease: expect.objectContaining({ step: 'pair.count' }) })]);

    const ran = await teamai('bob', ['workflow', 'resume', '--next', '--pool']);
    expect(ran.envelope(), said(ran)).toMatchObject({ data: { ran: { run, step: 'pair.count', exit_code: 0 } } });
    const done = await started;
    expect(done.envelope(), said(done)).toMatchObject({ data: { done: { outcome: 'succeeded', outputs: { counted: 1 } } } });
    expect(runStateOf('alice', run).steps.filter((step) => step.id !== 'pair').map((step) => [step.id, step.status, step.runtime])).toEqual([
      ['pair.write', 'succeeded', 'host'], ['pair.count', 'succeeded', 'fleet'],
    ]);
  }, 240_000);

  it('counts what a member\'s whole workflow step spent against the run\'s budget', async () => {
    let alicePid = 0;
    const before = new Set(offeredRuns());
    const started = teamai('alice', ['workflow', 'start', 'wholespend', '--driver', 'token-fleet'], (pid) => { alicePid = pid; });
    const fresh = (): string | undefined => offeredRuns().find((name) => !before.has(name));
    await waitOn(() => fresh() !== undefined && records(fresh() ?? '').length > 0, 60_000, () => alicePid, started);
    const run = fresh() ?? '';

    // Bob's Claude reports 4 input and 2 output tokens: 6, past the run's 5, which the offer carries, so bob's nested
    // run stops there and returns what it spent.
    const ran = await teamai('bob', ['workflow', 'resume', '--next', '--pool']);
    expect(ran.envelope(), said(ran)).toMatchObject({ data: { ran: { run, step: 'pair', exit_code: 1 } } });
    expect(records(run)[0]?.result).toMatchObject({ failure: { code: 'budget_exceeded' }, tokens: { input: 4, output: 2 } });
    const done = await started;
    expect(done.envelope(), said(done)).toMatchObject({ data: { done: { outcome: 'failed', failure: { code: 'budget_exceeded' } } } });
  }, 240_000);

  it('stops the nested run a member killed during a whole workflow step left running before it runs the step again', async () => {
    let alicePid = 0;
    const before = new Set(offeredRuns());
    const started = teamai('alice', ['workflow', 'start', 'wholehold', '--driver', 'fan-fleet'], (pid) => { alicePid = pid; });
    const fresh = (): string | undefined => offeredRuns().find((name) => !before.has(name));
    await waitOn(() => fresh() !== undefined && records(fresh() ?? '').length > 0, 60_000, () => alicePid, started);
    const run = fresh() ?? '';
    const pidFile = path.join(homeOf('bob'), 'nested.pid');
    fs.rmSync(pidFile, { force: true });
    const bobsBefore = new Set(runsOf('bob'));

    let bobPid = 0;
    const taking = teamai('bob', ['workflow', 'resume', '--next', '--pool'], (pid) => { bobPid = pid; });
    await waitOn(() => fs.existsSync(pidFile), 60_000, () => bobPid, taking);
    const left = Number(fs.readFileSync(pidFile, 'utf8'));
    // Bob's teamai is killed; the command of its nested run, in a process group of its own, is not.
    expect(signalPid(bobPid, 'SIGKILL')).toBe('sent');
    await taking;
    expect(isAlive(left)).toBe(true);

    const again = await teamai('bob', ['workflow', 'resume', '--next', '--pool']);
    expect(again.envelope(), said(again)).toMatchObject({ data: { ran: { run, step: 'pair', exit_code: 0 } } });
    expect(isAlive(left)).toBe(false);
    const done = await started;
    expect(done.envelope(), said(done)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    // The nested run the killed teamai left ended cancelled; the one the restart ran, succeeded.
    expect(runsOf('bob').filter((id) => !bobsBefore.has(id)).map((id) => runStatusOf('bob', id)).sort()).toEqual(['cancelled', 'succeeded']);
  }, 240_000);

  it('counts what the nested run a killed member left spent once it runs the whole workflow step again', async () => {
    let alicePid = 0;
    const before = new Set(offeredRuns());
    const started = teamai('alice', ['workflow', 'start', 'wholespendhold', '--driver', 'token-fleet'], (pid) => { alicePid = pid; });
    const fresh = (): string | undefined => offeredRuns().find((name) => !before.has(name));
    await waitOn(() => fresh() !== undefined && records(fresh() ?? '').length > 0, 60_000, () => alicePid, started);
    const run = fresh() ?? '';
    const pidFile = path.join(homeOf('bob'), 'nested.pid');
    fs.rmSync(pidFile, { force: true });

    let bobPid = 0;
    const taking = teamai('bob', ['workflow', 'resume', '--next', '--pool'], (pid) => { bobPid = pid; });
    await waitOn(() => fs.existsSync(pidFile), 60_000, () => bobPid, taking);
    expect(signalPid(bobPid, 'SIGKILL')).toBe('sent');
    await taking;

    const again = await teamai('bob', ['workflow', 'resume', '--next', '--pool']);
    expect(again.envelope(), said(again)).toMatchObject({ data: { ran: { run, step: 'pair', exit_code: 1 } } });
    const [finished] = records(run);
    // Bob's Claude reports 4 input and 2 output tokens per review: the left run's and the restart's.
    expect(finished?.result).toMatchObject({ failure: { code: 'budget_exceeded' }, tokens: { input: 8, output: 4 } });
    const done = await started;
    expect(done.envelope(), said(done)).toMatchObject({ data: { done: { outcome: 'failed' } } });
  }, 240_000);

  it('runs no whole workflow step again after a restart while the record of the nested run the killed member left cannot be read, and says why', async () => {
    let alicePid = 0;
    const before = new Set(offeredRuns());
    const started = teamai('alice', ['workflow', 'start', 'wholehold', '--driver', 'fan-fleet'], (pid) => { alicePid = pid; });
    const fresh = (): string | undefined => offeredRuns().find((name) => !before.has(name));
    await waitOn(() => fresh() !== undefined && records(fresh() ?? '').length > 0, 60_000, () => alicePid, started);
    const run = fresh() ?? '';
    const pidFile = path.join(homeOf('bob'), 'nested.pid');
    fs.rmSync(pidFile, { force: true });
    const bobsBefore = new Set(runsOf('bob'));

    let bobPid = 0;
    const taking = teamai('bob', ['workflow', 'resume', '--next', '--pool'], (pid) => { bobPid = pid; });
    await waitOn(() => fs.existsSync(pidFile), 60_000, () => bobPid, taking);
    const left = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(signalPid(bobPid, 'SIGKILL')).toBe('sent');
    await taking;
    const nested = path.join(dataHomeOf('bob'), 'workflows', 'runs', run, 'attempts', records(run)[0]?.attempt ?? '', 'nested-run');
    fs.chmodSync(nested, 0o000);

    try {
      const again = await teamai('bob', ['workflow', 'resume', '--next', '--pool']);

      // The member keeps the claim it cannot finish, and takes no other work: the owner gives it up after stale_after.
      expect(again.envelope(), said(again)).toMatchObject({ data: { idle: {} } });
      expect(again.stderr).toContain(`which this member claimed before: The nested run of the whole workflow it ran may still run: its id in ${nested} could not be read`);
      expect(isAlive(left)).toBe(true);
      expect(runsOf('bob').filter((id) => !bobsBefore.has(id))).toHaveLength(1);
    } finally {
      fs.chmodSync(nested, 0o644);
      if (isAlive(left)) signalPid(left, 'SIGKILL');
      await teamai('alice', ['workflow', 'cancel', run]);
      // The owner waits for the member to answer the cancel of a whole step, with what it spent, until stale_after:
      // bob, whose nested run's record reads again, answers it, so neither waits on it in a later test.
      await teamai('bob', ['workflow', 'resume', '--next', '--pool']);
      await started;
    }
  }, 240_000);

  it('stops a member\'s step when the owner cancels the run, and the member pushes its work and answers the cancel', async () => {
    let alicePid = 0;
    const started = teamai('alice', ['workflow', 'start', 'slow', '--driver', 'build-fleet'], (pid) => { alicePid = pid; });
    const before = new Set(offeredRuns());
    const fresh = (): string | undefined => offeredRuns().find((name) => !before.has(name));
    await waitOn(() => fresh() !== undefined, 60_000, () => alicePid, started);
    const run = fresh() ?? '';

    let bobPid = 0;
    const taking = teamai('bob', ['workflow', 'resume', '--next', '--pool', 'build'], (pid) => { bobPid = pid; });
    await waitOn(() => records(run).some((record) => record.state === 'claimed' && record.pushed !== record.start), 60_000, () => bobPid, taking);

    const cancel = await teamai('alice', ['workflow', 'cancel', run]);
    expect(cancel.code, said(cancel)).toBe(0);

    const answered = await taking;
    expect(answered.envelope(), said(answered)).toEqual({ data: { cancelled: { run, attempt: records(run)[0]?.attempt, step: 'long' } } });
    const [cancelled] = records(run);
    expect(cancelled).toMatchObject({ state: 'cancelled' });
    expect(originGit('show', `${cancelled?.pushed ?? ''}:partial.txt`)).toBe('P');
    const ended = await started;
    expect(ended.envelope(), said(ended)).toMatchObject({ data: { done: { outcome: 'cancelled' } } });
  }, 180_000);

  it('cancels a member\'s step through its record when the owner\'s driver is gone', async () => {
    let alicePid = 0;
    const started = teamai('alice', ['workflow', 'start', 'slow', '--driver', 'build-fleet'], (pid) => { alicePid = pid; });
    const before = new Set(offeredRuns());
    const fresh = (): string | undefined => offeredRuns().find((name) => !before.has(name));
    await waitOn(() => fresh() !== undefined, 60_000, () => alicePid, started);
    const run = fresh() ?? '';
    expect(signalPid(alicePid, 'SIGKILL')).toBe('sent');
    await started;

    let bobPid = 0;
    const taking = teamai('bob', ['workflow', 'resume', '--next', '--pool', 'build'], (pid) => { bobPid = pid; });
    await waitOn(() => records(run).some((record) => record.state === 'claimed' && record.pushed !== record.start), 60_000, () => bobPid, taking);

    const cancel = await teamai('alice', ['workflow', 'cancel', run]);
    expect(cancel.code, said(cancel)).toBe(0);
    expect(records(run)).toEqual([expect.objectContaining({ state: expect.stringMatching(/^cancell(ing|ed)$/) })]);

    const answered = await taking;
    expect(answered.envelope(), said(answered)).toMatchObject({ data: { cancelled: { run, step: 'long' } } });
    expect(records(run)).toEqual([expect.objectContaining({ state: 'cancelled' })]);
  }, 180_000);

  /**
   * Holds `member`'s teamai-reports lock, as `workflow cancel` holds it while it publishes the run, in a process that
   * takes it once no other write holds it and gives it back after `ms`. Answers once the lock is held, with its
   * release.
   */
  async function holdReportsLock(member: string, ms: number): Promise<{ released: Promise<RunResult> }> {
    // Beside the teamai-reports checkout, in the data home of the member's checkout.
    const lock = JSON.stringify(path.join(dataHomeOf(member), REPORTS_LOCK_FILENAME));
    const script = `const fs = require('fs');
const take = () => { try { fs.writeFileSync(${lock}, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), owner: require('crypto').randomUUID() }), { flag: 'wx' }); return true; } catch { return false; } };
const wait = () => { if (!take()) return setTimeout(wait, 20); console.log('held'); setTimeout(() => fs.rmSync(${lock}), ${ms}); };
wait();`;
    let isHeld = false;
    const holder = new Promise<RunResult>((resolve) => {
      const child = spawn(process.execPath, ['-e', script], { cwd: homeOf(member), stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); isHeld = stdout.includes('held'); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr, envelope: () => ({}) }));
    });
    expect(await until(() => isHeld, 10_000), 'the test could not take the teamai-reports lock').toBe(true);

    // Wrapped: returned bare, the promise would be adopted, and the caller would wait for the release.
    return { released: holder };
  }

  it('writes the cancel of a live owner once the publish holding its teamai-reports lets it go, and the member stops', async () => {
    let alicePid = 0;
    const started = teamai('alice', ['workflow', 'start', 'slow', '--driver', 'build-fleet'], (pid) => { alicePid = pid; });
    const before = new Set(offeredRuns());
    const fresh = (): string | undefined => offeredRuns().find((name) => !before.has(name));
    await waitOn(() => fresh() !== undefined, 60_000, () => alicePid, started);
    const run = fresh() ?? '';
    let bobPid = 0;
    const taking = teamai('bob', ['workflow', 'resume', '--next', '--pool', 'build'], (pid) => { bobPid = pid; });
    await waitOn(() => records(run).some((record) => record.state === 'claimed' && record.pushed !== record.start), 60_000, () => bobPid, taking);

    const held = await holdReportsLock('alice', 3_000);
    const cancel = await teamai('alice', ['workflow', 'cancel', run]);
    expect(cancel.code, said(cancel)).toBe(0);
    expect((await held.released).code).toBe(0);

    const answered = await taking;
    expect(answered.envelope(), said(answered)).toMatchObject({ data: { cancelled: { run, step: 'long' } } });
    expect(records(run)).toEqual([expect.objectContaining({ state: 'cancelled' })]);
    const ended = await started;
    expect(ended.envelope(), said(ended)).toMatchObject({ data: { done: { outcome: 'cancelled' } } });
  }, 180_000);

  it('ends a live owner\'s cancel cancel_failed when the publish holds its teamai-reports past the deadline, and a second workflow cancel stops the member', async () => {
    let alicePid = 0;
    const started = teamai('alice', ['workflow', 'start', 'slow', '--driver', 'build-fleet'], (pid) => { alicePid = pid; }, 150_000);
    const before = new Set(offeredRuns());
    const fresh = (): string | undefined => offeredRuns().find((name) => !before.has(name));
    await waitOn(() => fresh() !== undefined, 60_000, () => alicePid, started);
    const run = fresh() ?? '';
    let bobPid = 0;
    const taking = teamai('bob', ['workflow', 'resume', '--next', '--pool', 'build'], (pid) => { bobPid = pid; }, 200_000);
    await waitOn(() => records(run).some((record) => record.state === 'claimed' && record.pushed !== record.start), 60_000, () => bobPid, taking);

    const held = await holdReportsLock('alice', 75_000);
    const asked = Date.now();
    const cancel = await teamai('alice', ['workflow', 'cancel', run]);
    expect(cancel.code, said(cancel)).toBe(0);
    const ended = await started;
    const waited = Date.now() - asked;

    expect(said(ended), said(ended)).toContain(`its cancel could not be written to the record of attempt ${records(run)[0]?.attempt ?? ''} on teamai-reports for 60 s`);
    expect(said(ended), said(ended)).toContain(`Run teamai workflow cancel ${run} again.`);
    expect(waited, 'the owner stopped waiting within the deadline and a poll').toBeLessThan(75_000);
    // The member was never asked to stop: it still runs the step, and its claim is on the record.
    expect(records(run)).toEqual([expect.objectContaining({ state: 'claimed' })]);
    expect(isAlive(bobPid)).toBe(true);

    expect((await held.released).code).toBe(0);
    const again = await teamai('alice', ['workflow', 'cancel', run]);
    expect(again.code, said(again)).toBe(0);
    const answered = await taking;
    expect(answered.envelope(), said(answered)).toMatchObject({ data: { cancelled: { run, step: 'long' } } });
    expect(records(run)).toEqual([expect.objectContaining({ state: 'cancelled' })]);
  }, 300_000);

  it('withdraws an attempt through its record when the owner\'s driver was stopped before the cancel', async () => {
    const before = new Set(offeredRuns());
    const fresh = (): string | undefined => offeredRuns().find((name) => !before.has(name));
    let alicePid = 0;
    const started = teamai('alice', ['workflow', 'start', 'slow', '--driver', 'build-fleet'], (pid) => { alicePid = pid; });
    await waitOn(() => fresh() !== undefined, 60_000, () => alicePid, started);
    const run = fresh() ?? '';
    // A stop the driver hears, as Ctrl-C: it leaves the attempt out for a later resume.
    expect(signalPid(alicePid, 'SIGTERM')).toBe('sent');
    await started;

    const cancel = await teamai('alice', ['workflow', 'cancel', run]);

    expect(cancel.code, said(cancel)).toBe(0);
    expect(records(run)).toEqual([expect.objectContaining({ state: 'withdrawn' })]);
  }, 180_000);

  it('takes no attempt on a driver definition of the member\'s own, as resume --next reads none', async () => {
    const mine = path.join(homeOf('carol'), '.teamai', 'drivers', 'mine.yaml');
    fs.mkdirSync(path.dirname(mine), { recursive: true });
    fs.writeFileSync(mine, stringify({ schemaVersion: 'v1alpha1', name: 'mine', runtimes: [{ use: 'local' }] }));

    try {
      const taken = await teamai('carol', ['workflow', 'resume', '--next', '--pool', 'build', '--driver', 'mine']);

      expect(taken.envelope().error?.code, said(taken)).toBe('driver_not_found');
    } finally {
      fs.rmSync(path.dirname(mine), { recursive: true, force: true });
    }
  }, 60_000);

  // A member in a sandbox that refuses writes under its ~/.teamai (Codex's workspace-write) meets the reports lock first.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('tells a member whose teamai-reports folder refuses writes which folder and what to do, not to check the connection', async () => {
    const localPath = /^\s*localPath:\s*['"]?([^'"\n]+)['"]?\s*$/m.exec(fs.readFileSync(path.join(dataHomeOf('bob'), 'config.yaml'), 'utf8'))?.[1] ?? '';
    const folder = path.dirname(localPath);
    expect(fs.existsSync(path.join(folder, 'reports-wt')), `no reports-wt beside ${localPath}`).toBe(true);
    fs.chmodSync(folder, 0o555);

    try {
      const refused = await teamai('bob', ['workflow', 'resume', '--next', '--pool', 'build']);
      const error = refused.envelope().error;

      expect(error?.code, said(refused)).toBe('reports_unreachable');
      expect(error?.message).toBe(`teamai-reports could not be read on this machine: teamai may not write in ${folder} (EACCES). Give this process write access to that folder, or run the command outside its sandbox.`);
    } finally {
      fs.chmodSync(folder, 0o755);
    }
  }, 60_000);

  // One step at a time, the default, runs the command attached to the driver's terminal; in parallel, in a group of its own.
  it.each([{ parallel: 'workflows.max_parallel: 4', isDefault: false }, { parallel: 'the default max_parallel', isDefault: true }])('stops the command a killed local driver left running when the run is cancelled, with $parallel', async ({ isDefault }) => {
    const config = path.join(dataHomeOf('alice'), 'config.yaml');
    const kept = fs.readFileSync(config, 'utf8');
    if (isDefault) fs.writeFileSync(config, kept.replace('\n  max_parallel: 4\n', '\n'));
    const pidFile = path.join(homeOf('alice'), 'hold.pid');
    fs.rmSync(pidFile, { force: true });
    const before = new Set(runsOf('alice'));
    let alicePid = 0;

    try {
      const started = teamai('alice', ['workflow', 'start', 'hold', '--driver', 'local'], (pid) => { alicePid = pid; });
      await waitOn(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8') !== '', 60_000, () => alicePid, started);
      const command = Number(fs.readFileSync(pidFile, 'utf8'));
      const run = runsOf('alice').find((name) => !before.has(name)) ?? '';
      expect(signalPid(alicePid, 'SIGKILL')).toBe('sent');
      await started;
      expect(isAlive(command)).toBe(true);

      const cancel = await teamai('alice', ['workflow', 'cancel', run]);

      expect(cancel.code, said(cancel)).toBe(0);
      expect(await until(() => !isAlive(command), 10_000), `the step's command ${command} still runs after workflow cancel`).toBe(true);
    } finally {
      fs.writeFileSync(config, kept);
    }
  }, 180_000);
});
