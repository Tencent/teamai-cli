/**
 * Real CLI: a workflow started from an app's agent session. In a T3 thread, describe offers the start on the app's
 * driver when a run could start on it now, and a run started there from the session, with no terminal, stops at a gate
 * for the session to relay rather than deciding it. The member's own `t3` definition runs the toy runtime here.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { resolveProjectDataHome } from '../../config.js';
import type { RunState } from '../../workflow/types.js';
import { envelope, runCLI } from '../helpers/step-runtime-e2e.js';
import { installToyRuntime } from '../helpers/toy-runtime.js';

describe('a workflow started from an app\'s agent session', () => {
  let sandbox: string;
  let repo: string;
  let state: string;
  let dataHome: string;
  const session = { CLAUDE_CODE_SESSION_ID: 'session-in-a-thread' };
  const thread = { ...session, T3CODE_THREAD_ID: 'thread-1' };
  const paseoAgent = { ...session, PASEO_AGENT_ID: 'agent-1' };
  const definitionFile = (driver = 't3'): string => path.join(os.homedir(), '.teamai', 'drivers', `${driver}.yaml`);

  /** The member's own definition of an app's driver: the toy runtime, which a person reaches through its app, then `local`. */
  const writeApp = (driver: string, toy: Record<string, unknown> = {}): void => {
    fs.mkdirSync(path.dirname(definitionFile(driver)), { recursive: true });
    fs.writeFileSync(definitionFile(driver), stringify({ schemaVersion: 'v1alpha1', name: driver, tool: 'claude', runtimes: [{ use: 'toy', options: { state, can: { hitl: true }, agent: { output: { ok: true } }, ...toy } }, { use: 'local' }] }));
  };

  const writeT3 = (toy: Record<string, unknown> = {}): void => writeApp('t3', toy);

  const writeFlow = (name: string, body: string): void => {
    fs.writeFileSync(path.join(repo, '.teamai', 'workflows', `${name}.yaml`), `schemaVersion: v1alpha1\nname: ${name}\ndescription: ${name}\n${body}`);
  };

  const inits = (): Array<{ mode: string }> => (fs.existsSync(path.join(state, 'inits.jsonl'))
    ? fs.readFileSync(path.join(state, 'inits.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { mode: string })
    : []);

  /** The operations the toy was sent after `init`, such as an `open`, which is where a runtime creates what it lacks. */
  const operations = (): string[] => (fs.existsSync(path.join(state, 'ops')) ? fs.readdirSync(path.join(state, 'ops')) : []);

  const readRunState = (runId: string): RunState => JSON.parse(fs.readFileSync(path.join(dataHome, 'workflows', 'runs', `${runId}.json`), 'utf8')) as RunState;

  beforeAll(async () => {
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-session-start-e2e-')));
    repo = path.join(sandbox, 'repo');
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['add', 'README.md'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd: repo });
    execFileSync('git', ['remote', 'add', 'origin', 'http://127.0.0.1:9/team/workflow.git'], { cwd: repo });
    const initialized = await runCLI(['init', '--self', '--agent', 'claude', '--force'], repo);
    expect(initialized.code, `${initialized.stdout}\n${initialized.stderr}`).toBe(0);
    const origin = path.join(sandbox, 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    execFileSync('git', ['remote', 'set-url', 'origin', origin], { cwd: repo });
    execFileSync('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: repo });
    const runtimeDir = path.join(os.homedir(), '.teamai', 'runtimes', 'toy');
    fs.mkdirSync(runtimeDir, { recursive: true });
    installToyRuntime(runtimeDir);
    fs.mkdirSync(path.join(repo, '.teamai', 'workflows'), { recursive: true });
    writeFlow('review', `invoke: allow
steps:
  - id: review
    prompt: Review the repository without changing it.
    output:
      ok: boolean
`);
    writeFlow('release', `invoke: deny
steps:
  - id: tag
    command: node -e "process.exit(0)"
`);
    writeFlow('shipit', `invoke: allow
steps:
  - id: build
    command: node -e "process.exit(0)"
  - id: ship
    needs: [build]
    approve: Ship the build?
    command: node -e "process.exit(0)"
`);
    writeFlow('asked', `invoke: ask
steps:
  - id: build
    command: node -e "process.exit(0)"
  - id: ship
    needs: [build]
    approve: Ship the build?
    command: node -e "process.exit(0)"
`);
    const pulled = await runCLI(['pull'], repo);
    expect(pulled.code, `${pulled.stdout}\n${pulled.stderr}`).toBe(0);
    dataHome = await resolveProjectDataHome(repo);
  });

  beforeEach(() => {
    state = fs.mkdtempSync(path.join(sandbox, 'toy-state-'));
    fs.rmSync(definitionFile(), { force: true });
    fs.rmSync(definitionFile('paseo'), { force: true });
    fs.rmSync(definitionFile('teamai-t3'), { force: true });
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('offers the start on the app\'s driver in the background once a run could start on it, checked in check mode', async () => {
    writeT3();

    const described = await runCLI(['workflow', 'start', '--describe', 'review', '--driver', 'skill'], repo, thread);

    expect(envelope(described), described.stderr).toMatchObject({ data: { describe: { ask: {
      kind: 'background', start: 'teamai workflow start review --driver t3', background: "Each prompt step appears in T3 Code as a thread under this thread, except a step that resumes the session of an earlier step in the same workspace on the same tool (session: continue or session: { from }), which goes on in that step's thread while T3 Code still has it.",
    } } } });
    expect(inits()).toEqual([expect.objectContaining({ mode: 'check' })]);
    expect(operations()).toEqual([]);
  });

  // An older runtime ignores a field it does not know, but refuses a mode it does not know: the check fails closed.
  it('answers as outside the app when the app\'s runtime refuses check mode, as one older than it does', async () => {
    writeT3({ check: false });

    const described = await runCLI(['workflow', 'start', '--describe', 'review', '--driver', 'skill'], repo, thread);

    expect(envelope(described), described.stderr).toMatchObject({ data: { describe: { ask: { kind: 'start', start: 'teamai workflow start review --driver skill' } } } });
    expect(inits()).toEqual([expect.objectContaining({ mode: 'check' })]);
    expect(operations()).toEqual([]);
  });

  it('answers as outside the app when the app\'s driver declares a credential whose variable is unset', async () => {
    writeT3({ credentials: { TOY_TOKEN: 'env:MEMBER_TOY_TOKEN' }, can: { hitl: true, env: true } });

    const described = await runCLI(['workflow', 'start', '--describe', 'review', '--driver', 'skill'], repo, thread);

    expect(envelope(described), described.stderr).toMatchObject({ data: { describe: { ask: { kind: 'start', start: 'teamai workflow start review --driver skill' } } } });
    expect(inits()).toEqual([]);
  });

  it('answers as outside the app when no run could start on its driver now, and outside a thread asks nothing of the driver', async () => {
    writeT3({ init_fails: { code: 'sign_in_needed', message: 'teamai has no valid T3 Code sign-in.' } });

    const unready = await runCLI(['workflow', 'start', '--describe', 'review', '--driver', 'skill'], repo, thread);
    expect(envelope(unready), unready.stderr).toMatchObject({ data: { describe: { ask: { kind: 'start', start: 'teamai workflow start review --driver skill' } } } });
    expect(inits()).toHaveLength(1);

    const outside = await runCLI(['workflow', 'start', '--describe', 'review', '--driver', 'skill'], repo, session);
    expect(envelope(outside), outside.stderr).toMatchObject({ data: { describe: { ask: { kind: 'start' } } } });
    expect(inits()).toHaveLength(1);
  });

  it('gives the person the start on the app\'s driver for a workflow no agent starts, without opening it', async () => {
    writeT3();

    const described = await runCLI(['workflow', 'start', '--describe', 'release', '--driver', 'skill'], repo, thread);

    expect(envelope(described), described.stderr).toMatchObject({ data: { describe: { ask: {
      kind: 'local', start: 'teamai workflow start release --driver t3', reason: expect.stringContaining('The person can start it from this thread\'s T3 terminal with teamai workflow start release --driver t3.'),
    } } } });
    expect(inits()).toEqual([]);
  });

  it('stops at a gate the session relays, rather than deciding it, and goes on once it is answered and resumed', async () => {
    writeT3();

    const started = await runCLI(['workflow', 'start', 'shipit', '--driver', 't3'], repo, thread);

    const stopped = envelope(started);
    expect(stopped, started.stderr).toMatchObject({ data: { hitl_waiting: { step: 'ship', pass: 1, kind: 'approve', message: 'Ship the build?', options: ['yes', 'no'], required: false } } });
    const waiting = 'data' in stopped ? stopped.data.hitl_waiting as { run: string; respond: string; resume: string } : undefined;
    const run = waiting?.run ?? '';
    expect(waiting).toMatchObject({ respond: `teamai workflow respond ${run} ship <option> --pass 1`, resume: `teamai workflow resume ${run} --driver t3` });
    expect(started.stderr).toContain(`Run ${run} waits at step "ship" (pass 1): Ship the build?\nOptions: yes, no. Required: no.\nAnswer: teamai workflow respond ${run} ship <option> --pass 1\nThen: teamai workflow resume ${run} --driver t3`);
    expect(readRunState(run).steps.map((step) => [step.id, step.status])).toEqual([['build', 'succeeded'], ['ship', 'waiting']]);

    const answered = await runCLI(['workflow', 'respond', run, 'ship', 'yes', '--pass', '1'], repo, thread);
    expect(answered.code, `${answered.stdout}\n${answered.stderr}`).toBe(0);
    const resumed = await runCLI(['workflow', 'resume', run, '--driver', 't3'], repo, thread);

    expect(envelope(resumed), resumed.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(readRunState(run).steps.map((step) => [step.id, step.status])).toEqual([['build', 'succeeded'], ['ship', 'succeeded']]);
  });

  it('sends a run no step of which needs an AI tool to the host driver in the background, which drives it to its gate in one call', async () => {
    writeT3();

    const described = await runCLI(['workflow', 'start', '--describe', 'shipit', '--driver', 'skill'], repo, thread);

    expect(envelope(described), described.stderr).toMatchObject({ data: { describe: { ask: {
      kind: 'ask', background: 'Each step runs on this machine in teamai, and no agent runs any of them.',
      question: { options: [{ start: 'teamai workflow start shipit --driver host' }, { start: 'teamai workflow start shipit --driver host --auto-approve' }] },
    } } } });
    expect(inits()).toEqual([]);

    const started = await runCLI(['workflow', 'start', 'shipit', '--driver', 'host'], repo, thread);

    const stopped = envelope(started);
    const waiting = 'data' in stopped ? stopped.data.hitl_waiting as { run: string; resume: string } | undefined : undefined;
    const run = waiting?.run ?? '';
    expect(waiting, started.stderr).toMatchObject({ step: 'ship', kind: 'approve', resume: `teamai workflow resume ${run} --driver host` });
    expect(readRunState(run).steps.map((step) => [step.id, step.status])).toEqual([['build', 'succeeded'], ['ship', 'waiting']]);

    const answered = await runCLI(['workflow', 'respond', run, 'ship', 'yes', '--pass', '1'], repo, thread);
    expect(answered.code, `${answered.stdout}\n${answered.stderr}`).toBe(0);
    const resumed = await runCLI(['workflow', 'resume', run, '--driver', 'host'], repo, thread);

    expect(envelope(resumed), resumed.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(readRunState(run).steps.map((step) => [step.id, step.status])).toEqual([['build', 'succeeded'], ['ship', 'succeeded']]);
    expect(fs.existsSync(path.join(dataHome, 'workflows', 'runs', run, 'skill.json'))).toBe(false);
    expect(inits()).toEqual([]);
  });

  it('gives the resume of a relayed gate the confirmation a workflow the person confirms was started with', async () => {
    writeT3();

    const started = await runCLI(['workflow', 'start', 'asked', '--driver', 't3', '--confirmed'], repo, thread);

    const stopped = envelope(started);
    const waiting = 'data' in stopped ? stopped.data.hitl_waiting as { run: string; resume: string } | undefined : undefined;
    expect(waiting?.resume, started.stderr).toBe(`teamai workflow resume ${waiting?.run ?? ''} --driver t3 --confirmed`);
  });

  it('names the driver in a relayed gate\'s resume as the person gave it, not by the definition it resolved to', async () => {
    writeApp('teamai-t3');

    const started = await runCLI(['workflow', 'start', 'shipit', '--driver', 't3'], repo, thread);

    const stopped = envelope(started);
    const waiting = 'data' in stopped ? stopped.data.hitl_waiting as { run: string; resume: string } | undefined : undefined;
    expect(waiting?.resume, started.stderr).toBe(`teamai workflow resume ${waiting?.run ?? ''} --driver t3`);
  });

  it('offers the start on Paseo\'s driver in a Paseo agent, and relays the gates of the run it starts there', async () => {
    writeApp('paseo');

    const described = await runCLI(['workflow', 'start', '--describe', 'review', '--driver', 'skill'], repo, paseoAgent);

    expect(envelope(described), described.stderr).toMatchObject({ data: { describe: { ask: {
      kind: 'background', start: 'teamai workflow start review --driver paseo', background: "Each prompt step appears in Paseo as an agent of its own, except a step that resumes the session of an earlier step in the same workspace on the same tool (session: continue or session: { from }), which goes on in that step's agent while Paseo still has it.",
    } } } });
    expect(inits()).toEqual([expect.objectContaining({ mode: 'check' })]);

    const started = await runCLI(['workflow', 'start', 'shipit', '--driver', 'paseo'], repo, paseoAgent);

    const stopped = envelope(started);
    const waiting = 'data' in stopped ? stopped.data.hitl_waiting as { run: string; resume: string } | undefined : undefined;
    expect(waiting, started.stderr).toMatchObject({ resume: `teamai workflow resume ${waiting?.run ?? ''} --driver paseo` });
  });

  // A Paseo daemon started from a T3 thread's terminal hands that thread's variable to every agent it launches.
  it('offers the start on Paseo\'s driver in a Paseo agent that a T3 thread\'s variable also reaches', async () => {
    writeT3();
    writeApp('paseo');

    const described = await runCLI(['workflow', 'start', '--describe', 'review', '--driver', 'skill'], repo, { ...thread, ...paseoAgent });

    expect(envelope(described), described.stderr).toMatchObject({ data: { describe: { ask: { kind: 'background', start: 'teamai workflow start review --driver paseo' } } } });
  });

  it('decides the gate as before on the local driver, which no person reaches from the session', async () => {
    const started = await runCLI(['workflow', 'start', 'shipit', '--driver', 'local'], repo, thread);

    const ended = envelope(started);
    expect(ended, started.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const run = 'data' in ended ? (ended.data.done as { run: string }).run : '';
    expect(readRunState(run).steps.find((step) => step.id === 'ship')).toMatchObject({ status: 'skipped' });
  });
});
