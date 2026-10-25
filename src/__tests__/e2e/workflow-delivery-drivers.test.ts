/**
 * Real CLI: the delivery scenarios of `conformance.ts` for each kind of driver, through `teamai workflow` JSON alone. Two
 * installs, each with its own HOME and checkout, share a team origin and a product origin whose URL is
 * `https://github.com/fixture/app.git`, which git rewrites to a bare repository. One fake `gh` on PATH is the host of
 * every case: it records each create, answers lookups from what it recorded, and holds the call a case names.
 *
 * - local: `workflow start --driver local` runs the run; after a crash, `workflow resume` continues it. While another
 *   process delivers, `workflow resume` drives a run another driver reported.
 * - session: commits in a worktree of the install's checkout, pushes the branch itself, reports, then calls next.
 * - external: knows nothing of delivery. It works in a clone of its own and sleeps on every `wait`, whatever it says.
 * - remote: works in a clone on another machine, opens its own pull request there, and reports it as changes.pr_url.
 */
import { execFileSync, execSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { deliveryConformanceWorkflow, workflowDeliveryConformanceScenarios, type DeliveryConformanceScenario } from '../../workflow/conformance.js';
import { trackDetachedProcesses } from '../helpers/detached-processes.js';
import { fakeGhHost, type FakeGh } from '../helpers/fake-gh.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');
const TEAM_URL = 'https://github.com/acme/team.git';
const PRODUCT_URL = 'https://github.com/fixture/app.git';
const POLL_MS = 250;
const HOLD_MS = 2_000;

type Profile = 'local' | 'session' | 'external' | 'remote';
type Member = 'alice' | 'bob';

const EnvelopeSchema = z.object({
  data: z.record(z.unknown()).optional(),
  error: z.object({ code: z.string(), message: z.string() }).passthrough().optional(),
});
type Envelope = z.infer<typeof EnvelopeSchema>;

const LeaseSchema = z.object({
  step: z.string(), attempt: z.string(), revision: z.number(), command: z.string().optional(),
  workspace: z.object({ branch: z.string(), base: z.object({ commit: z.string() }), start: z.object({ commit: z.string() }) }).optional(),
});
type Lease = z.infer<typeof LeaseSchema>;

const ReceiptSchema = z.object({ url: z.string(), branch: z.string(), base: z.string(), step: z.string(), pass: z.number() });
const RunFileSchema = z.object({
  status: z.string(),
  steps: z.array(z.object({
    id: z.string(), status: z.string(),
    changes: z.object({ branch: z.string(), to: z.string() }).optional(),
    failure: z.object({ code: z.string(), message: z.string() }).optional(),
  })),
  deliveries: z.array(ReceiptSchema).optional(),
});
type RunFile = z.infer<typeof RunFileSchema>;
const RecordSchema = z.object({ run: z.string(), prs: z.array(z.string()).optional() });
const OpenSchema = z.array(z.object({ html_url: z.string(), head: z.object({ ref: z.string() }) }));

interface Result {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

let sandbox = '';
let teamOrigin = '';
let productOrigin = '';
let gh: FakeGh;
let ghDir = '';
let clones = 0;
let detached: ReturnType<typeof trackDetachedProcesses>;

const homeOf = (member: Member): string => path.join(sandbox, member);
const workOf = (member: Member): string => path.join(homeOf(member), 'work');
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function envOf(member: Member): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeOf(member), USERPROFILE: homeOf(member), GIT_CONFIG_GLOBAL: path.join(homeOf(member), '.gitconfig'),
    GH_CONFIG_DIR: path.join(homeOf(member), '.gh'), PATH: `${ghDir}${path.delimiter}${process.env.PATH ?? ''}`,
    GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', FORCE_COLOR: '0',
    NODE_OPTIONS: [process.env.NODE_OPTIONS, detached.nodeOptions].filter(Boolean).join(' '),
    SHIP_OPEN: path.join(ghDir, 'open.json'), SHIP_SAW: path.join(ghDir, 'ship-saw.json'),
  };
  for (const name of ['XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GITHUB_TOKEN', 'GH_TOKEN']) delete env[name];
  return env;
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function teamai(member: Member, args: string[], options: { cwd?: string; spawned?: (child: ChildProcess) => void; stderr?: (text: string) => void } = {}): Promise<Result> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: options.cwd ?? workOf(member), env: envOf(member), stdio: ['ignore', 'pipe', 'pipe'] });
    options.spawned?.(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); options.stderr?.(stderr); });
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function envelope(result: Result): Envelope {
  const line = result.stdout.trim().split('\n').filter((item) => item.startsWith('{')).at(-1);
  if (!line) throw new Error(`no JSON envelope:\n${said(result)}`);
  return EnvelopeSchema.parse(JSON.parse(line));
}

function said(result: Result): string {
  return `exit ${result.code ?? result.signal}\n${result.stdout}\n${result.stderr}`;
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  for (const until = Date.now() + ms; !check(); await sleep(50)) if (Date.now() > until) return false;
  return true;
}

function seed(dir: string, files: Record<string, string>, origin: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.com', 'commit', '-qm', 'seed']);
  git(dir, ['push', '-q', origin, 'main']);
}

async function join(member: Member): Promise<void> {
  fs.mkdirSync(path.join(homeOf(member), '.gh'), { recursive: true });
  fs.writeFileSync(path.join(homeOf(member), '.gitconfig'), [
    '[user]', `\tname = ${member}`, `\temail = ${member}@example.com`,
    // Git's own maintenance can outlive an awaited command and still write during teardown.
    '[gc]', '\tautoDetach = false',
    `[url "file://${teamOrigin}"]`, `\tinsteadOf = ${TEAM_URL}`,
    `[url "file://${productOrigin}"]`, `\tinsteadOf = ${PRODUCT_URL}`, '',
  ].join('\n'));
  git(sandbox, ['clone', '-q', PRODUCT_URL, workOf(member)], envOf(member));
  for (const args of [['init', TEAM_URL, '--provider', 'git', '--agent', 'claude', '--scope', 'user', '--force'], ['pull']]) {
    const result = await teamai(member, args);
    expect(result.code, said(result)).toBe(0);
  }
}

function readRun(member: Member, run: string): RunFile {
  return RunFileSchema.parse(JSON.parse(fs.readFileSync(path.join(homeOf(member), '.teamai', 'workflows', 'runs', `${run}.json`), 'utf8')));
}

function endRecordPrs(run: string): string[] | undefined {
  const text = git(sandbox, ['--git-dir', teamOrigin, 'show', `teamai-reports:workflows/runs/${run}.json`]);
  return RecordSchema.parse(JSON.parse(text)).prs;
}

function createsOf(run: string): string[][] {
  return gh.calls().filter((call) => call.args[0] === 'pr' && call.args[1] === 'create' && call.args.includes(`teamai/${run}/work/p1`))
    .map((call) => ['-R', '-H', '-B'].map((flag) => call.args[call.args.indexOf(flag) + 1] ?? ''));
}

const ReportAnswerSchema = z.object({ step: z.object({ status: z.string() }) });

/**
 * What a stub driver did: the steps it was leased, the steps it reported with the status each report answered, its
 * next calls, those killed, and the waits it slept on.
 */
interface DriverLog {
  leases: string[];
  reports: Array<{ step: string; status: string }>;
  nexts: number;
  killed: number;
  waits: number;
}

/**
 * A driver that speaks only `teamai workflow next|report` JSON. It runs each leased command, in the workspace its
 * profile keeps for a lease with one, commits and pushes that branch itself, and reports. It sleeps on every `wait`, and
 * calls `next` again when one was killed, unless `stopped` says it was stopped.
 */
async function stubDriver(profile: Exclude<Profile, 'local'>, member: Member, run: string, options: {
  claim?: boolean;
  afterReport?: (step: string) => Promise<void>;
  stopped?: () => boolean;
  reportedUrl?: (branch: string) => { open: string; report: string };
  onReport?: (step: string, result: Result) => void;
} = {}): Promise<DriverLog> {
  const log: DriverLog = { leases: [], reports: [], nexts: 0, killed: 0, waits: 0 };
  const driver = { kind: profile, machine: `${member}-${profile}`, workspace: workOf(member), can: { workspace: ['new', 'continue', 'read-only'] } };
  let claim = options.claim === true;
  for (let calls = 0; calls < 80; calls++) {
    if (options.stopped?.()) return log;
    const next = await teamai(member, ['workflow', 'next', run, '--json', JSON.stringify({ driver, ...(claim ? { claim: true } : {}) })]);
    log.nexts++;
    if (next.signal) {
      log.killed++;
      continue;
    }
    claim = false;
    const answer = envelope(next);
    if (answer.error) throw new Error(`next answered an error:\n${said(next)}`);
    if (answer.data?.done) return log;
    if (answer.data?.wait) {
      log.waits++;
      await sleep(POLL_MS);
      continue;
    }
    const lease = LeaseSchema.parse(answer.data?.lease);
    log.leases.push(lease.step);
    const reported = await work(profile, member, lease, options.reportedUrl);
    const body = { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver, ...reported };
    const result = await teamai(member, ['workflow', 'report', run, '--json', JSON.stringify(body)]);
    const answered = envelope(result);
    log.reports.push({ step: lease.step, status: ReportAnswerSchema.safeParse(answered.data).data?.step.status ?? answered.error?.code ?? '' });
    options.onReport?.(lease.step, result);
    expect(result.code === 0 || answered.error?.code === 'lease_cancelled', said(result)).toBe(true);
    await options.afterReport?.(lease.step);
  }
  throw new Error(`${profile} driver did not finish run ${run}: ${JSON.stringify(log)}`);
}

/** Runs a lease's command where `profile` keeps its workspace, and returns the `changes` the report carries. */
async function work(profile: Exclude<Profile, 'local'>, member: Member, lease: Lease, reportedUrl?: (branch: string) => { open: string; report: string }): Promise<Record<string, unknown>> {
  const env = envOf(member);
  if (!lease.workspace) {
    execSync(lease.command ?? 'true', { cwd: workOf(member), env, stdio: 'ignore' });
    return {};
  }
  const { branch, base, start } = lease.workspace;
  const dir = path.join(sandbox, `${member}-${profile}-${clones++}`);
  if (profile === 'session') git(workOf(member), ['worktree', 'add', '-q', '-b', branch, dir, start.commit], env);
  else {
    git(sandbox, ['clone', '-q', PRODUCT_URL, dir], env);
    git(dir, ['checkout', '-q', '-b', branch, start.commit], env);
  }
  execSync(lease.command ?? 'true', { cwd: dir, env, stdio: 'ignore' });
  git(dir, ['add', '-A'], env);
  git(dir, ['commit', '-qm', lease.step], env);
  git(dir, ['push', '-q', 'origin', branch], env);
  const to = git(dir, ['rev-parse', 'HEAD'], env);
  const changes: Record<string, unknown> = { branch, base: base.commit, from: start.commit, to, commits: [to] };
  if (profile !== 'remote') return { changes };
  const url = (reportedUrl ?? ((head) => ({ open: openOwn(head), report: '' })))(branch);
  return { changes: { ...changes, pr_url: url.report || `${url.open}?tab=files#top` } };
}

/** Opens a pull request from `head` into main on the host, as a remote driver's own tooling does, and returns its URL. */
function openOwn(head: string): string {
  const file = path.join(ghDir, 'open.json');
  const open = fs.existsSync(file) ? z.array(z.unknown()).parse(JSON.parse(fs.readFileSync(file, 'utf8'))) : [];
  const url = `https://github.com/fixture/app/pull/${900 + open.length}`;
  const repo = { full_name: 'fixture/app' };
  fs.writeFileSync(file, JSON.stringify([...open, { state: 'open', html_url: url, head: { ref: head, repo }, base: { ref: 'main', repo } }]));
  return url;
}

/**
 * Starts the run on alice's install, drives it with `profile`, and does what the scenario's hold says while it holds.
 * `polled` says the driver was still driving when a `poll` hold was released.
 */
async function drive(profile: Profile, scenario: DeliveryConformanceScenario): Promise<{ run: string; member: Member; log?: DriverLog; held: boolean; killed: boolean; polled: boolean }> {
  for (const marker of ['release', 'lookup.held', 'create.held', 'ship-saw.json']) fs.rmSync(path.join(ghDir, marker), { force: true });
  gh.configure({ ...(scenario.unreachable ? { lookup: 'fail' as const } : {}), ...(scenario.hold ? { hold: scenario.hold.call } : {}) });
  const heldFile = scenario.hold && path.join(ghDir, `${scenario.hold.call}.held`);
  const release = (): void => fs.writeFileSync(path.join(ghDir, 'release'), '');
  let run = '';
  let stopped = false;
  let finished = false;
  let polled = false;
  let watcher: Promise<Result> | undefined;
  // A process of the same machine that polls without taking leases starts the delivery and holds it.
  const deliverElsewhere = async (step: string): Promise<void> => {
    if (step !== 'work' || scenario.hold?.action !== 'poll' || !heldFile) return;
    const poller = { kind: 'watcher', machine: 'alice', workspace: workOf('alice') };
    let exited = false;
    watcher = teamai('alice', ['workflow', 'next', run, '--json', JSON.stringify({ driver: poller, canTakeLease: false })]);
    void watcher.then(() => { exited = true; });
    await waitFor(() => fs.existsSync(heldFile) || exited, 30_000);
  };

  let driving: Promise<DriverLog | Result>;
  if (profile === 'local' && scenario.hold?.action === 'poll') {
    // The local driver delivers in its own process right after it reports, so here a session driver reports work and
    // stops while another process delivers it, and the local driver resumes the run meanwhile.
    run = String(envelope(await teamai('alice', ['workflow', 'start', 'deliver'])).data?.run);
    await stubDriver('session', 'alice', run, { afterReport: deliverElsewhere, stopped: () => watcher !== undefined });
    driving = teamai('alice', ['workflow', 'resume', run]);
  } else if (profile === 'local') {
    driving = teamai('alice', ['workflow', 'start', 'deliver', '--driver', 'local'], { stderr: (text) => {
      run ||= /Run (r[0-9a-f]{16}) started/.exec(text)?.[1] ?? '';
    } });
    expect(await waitFor(() => run !== '', 30_000), 'the local driver printed its run').toBe(true);
  } else {
    const started = await teamai('alice', ['workflow', 'start', 'deliver']);
    run = String(envelope(started).data?.run);
    driving = stubDriver(profile, 'alice', run, { stopped: () => stopped, afterReport: deliverElsewhere });
  }
  void driving.then(() => { finished = true; }, () => { finished = true; });

  const held = heldFile !== undefined && await waitFor(() => fs.existsSync(heldFile) || finished, 60_000) && fs.existsSync(heldFile);
  let member: Member = 'alice';
  let log: DriverLog | undefined;
  let killed = false;
  if (held && scenario.hold && heldFile) {
    const pid = Number(fs.readFileSync(heldFile, 'utf8'));
    switch (scenario.hold.action) {
      case 'crash':
        process.kill(pid, 'SIGKILL');
        release();
        break;
      case 'publish': {
        const published = await teamai('alice', ['workflow', 'publish', run]);
        expect(envelope(published), said(published)).toMatchObject({ data: { publication: 'published' } });
        stopped = true;
        process.kill(pid, 'SIGKILL');
        release();
        await driving.catch(() => undefined);
        member = 'bob';
        break;
      }
      case 'cancel': {
        const cancelled = await teamai('alice', ['workflow', 'cancel', run]);
        expect(cancelled.code, said(cancelled)).toBe(0);
        release();
        break;
      }
      case 'poll':
        await sleep(HOLD_MS);
        polled = !finished;
        release();
        break;
      default: {
        const unknown: never = scenario.hold.action;
        throw new Error(`unknown hold action ${String(unknown)}`);
      }
    }
  }
  if (member === 'bob') {
    if (profile === 'local') {
      const resumed = await teamai('bob', ['workflow', 'resume', run]);
      expect(envelope(resumed), said(resumed)).toMatchObject({ data: { done: { run } } });
    } else {
      log = await stubDriver(profile, 'bob', run, { claim: true });
    }
  } else {
    const driven = await driving;
    if ('leases' in driven) {
      log = driven;
      killed = driven.killed > 0;
    } else if (driven.signal) {
      killed = true;
      const resumed = await teamai('alice', ['workflow', 'resume', run]);
      expect(envelope(resumed), said(resumed)).toMatchObject({ data: { done: { run } } });
    }
  }
  if (watcher) await watcher;
  return { run, member, log, held, killed, polled };
}

const PROFILES: Profile[] = ['local', 'session', 'external', 'remote'];

describe('workflow delivery conformance of each kind of driver through the CLI', () => {
  beforeAll(async () => {
    sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-delivery-drivers-')));
    detached = trackDetachedProcesses(sandbox);
    teamOrigin = path.join(sandbox, 'team.git');
    productOrigin = path.join(sandbox, 'app.git');
    ghDir = path.join(sandbox, 'gh');
    git(sandbox, ['init', '-q', '--bare', '-b', 'main', teamOrigin]);
    git(sandbox, ['init', '-q', '--bare', '-b', 'main', productOrigin]);
    seed(path.join(sandbox, 'seed-team'), { 'teamai.yaml': `team: acme\nrepo: ${TEAM_URL}\nprovider: github\n`, 'workflows/deliver.yaml': deliveryConformanceWorkflow }, teamOrigin);
    seed(path.join(sandbox, 'seed-app'), { 'README.md': '# app\n' }, productOrigin);
    gh = fakeGhHost(ghDir);
    await join('alice');
    await join('bob');
  }, 120_000);

  afterAll(async () => {
    if (!sandbox) return;
    await detached.waitForExit();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  for (const scenario of workflowDeliveryConformanceScenarios) {
    for (const profile of PROFILES) {
      it(`${profile}: ${scenario.name}`, async () => {
        const expected = profile === 'remote' ? scenario.reported : scenario.opened;
        const { run, member, log, held, killed, polled } = await drive(profile, scenario);
        const state = readRun(member, run);
        const branch = `teamai/${run}/work/p1`;
        const work = state.steps.find((step) => step.id === 'work');
        const steps = state.steps.map((step) => `${step.id} ${step.status}${step.failure ? `: ${step.failure.message}` : ''}`).join('\n');

        // A driver that reports its own pull request is looked up only when it reports, and never reaches a create.
        const holds = profile === 'remote' ? scenario.hold?.call === 'lookup' : scenario.hold !== undefined;
        expect(held, 'the case reached the call it holds').toBe(holds);
        expect(killed, 'the process inside the create was killed').toBe(holds && scenario.hold?.action === 'crash');
        if (holds && scenario.hold?.action === 'poll') {
          expect(polled, 'the driver kept driving while the delivery held').toBe(true);
          if (log) expect(log.waits, 'the driver polled while the delivery held').toBeGreaterThan(0);
        }
        expect([state.status, work?.status], steps).toEqual([expected.run, expected.work]);
        expect(createsOf(run)).toEqual(Array.from({ length: expected.creates }, () => ['fixture/app', branch, 'main']));
        expect(state.deliveries ?? []).toHaveLength(expected.prs);
        expect(endRecordPrs(run) ?? []).toEqual((state.deliveries ?? []).map((receipt) => receipt.url));
        for (const receipt of state.deliveries ?? []) {
          expect(receipt).toMatchObject({ branch, base: 'main', step: 'work', pass: 1 });
          expect(receipt.url).toMatch(/^https:\/\/github\.com\/fixture\/app\/pull\/\d+$/);
        }
        if (expected.failure) expect(work?.failure).toMatchObject({ code: expected.failure, message: expect.stringContaining(branch) });
        const tip = git(sandbox, ['--git-dir', productOrigin, 'rev-parse', `refs/heads/${branch}`]);
        if (work?.changes) expect(tip, 'the branch is on origin').toBe(work.changes.to);
        if (expected.run === 'succeeded') {
          const saw = OpenSchema.parse(JSON.parse(fs.readFileSync(path.join(ghDir, 'ship-saw.json'), 'utf8')));
          expect(saw.filter((pull) => pull.head.ref === branch).map((pull) => pull.html_url), 'ship ran once work was delivered')
            .toEqual((state.deliveries ?? []).map((receipt) => receipt.url));
        }
        if (profile === 'external' && log) {
          expect(log.reports.map((report) => report.step), 'it reports only what it was leased').toEqual(log.leases);
          expect(log.reports.filter((report) => report.step === 'work').map((report) => report.status), 'its report leaves work delivering, for TeamAI to settle')
            .toEqual(log.leases.includes('work') ? ['delivering'] : []);
          expect(log.waits, 'it sleeps on each wait').toBeLessThanOrEqual(HOLD_MS / POLL_MS + 2);
          expect(log.nexts, 'its next calls stay bounded').toBeLessThanOrEqual(log.leases.length + log.waits + 2);
        }
      }, 120_000);
    }
  }

  it('remote: a reported URL with credentials is named in the report envelope without its value, and the open pull request of the branch is delivered', async () => {
    gh.configure({});
    const started = await teamai('alice', ['workflow', 'start', 'deliver']);
    const run = String(envelope(started).data?.run);
    let opened = '';
    const reports: Result[] = [];
    await stubDriver('remote', 'alice', run, {
      reportedUrl: (branch) => {
        opened = openOwn(branch);
        return { open: opened, report: opened.replace('https://', 'https://x-access-token:ghs_droppedvalue@') };
      },
      onReport: (step, result) => { if (step === 'work') reports.push(result); },
    });
    const [report] = reports;
    expect(report && envelope(report)).toMatchObject({ data: { accepted: true, step: { id: 'work', status: 'delivering' }, dropped: [{ field: 'changes.pr_url', reason: 'contains credentials' }] } });
    expect(report && said(report)).not.toContain('ghs_droppedvalue');
    const state = readRun('alice', run);
    expect(state.status).toBe('succeeded');
    expect(state.deliveries?.map((receipt) => receipt.url)).toEqual([opened]);
    expect(createsOf(run)).toEqual([]);
    expect(JSON.stringify(state)).not.toContain('ghs_droppedvalue');
  }, 120_000);
});
