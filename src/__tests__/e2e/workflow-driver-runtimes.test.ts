import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { parse as parseToml } from 'smol-toml';
import { parse, stringify } from 'yaml';
import { resolveProjectDataHome } from '../../config.js';
import type { RunState } from '../../workflow/types.js';
import { attemptOf, CLAUDE_SESSIONS, CLI, codexOnPath, envelope, fakeTool, ROOT, runCLI, type Ran } from '../helpers/step-runtime-e2e.js';
import { hasPython, TYPED_TERMINAL } from '../helpers/in-terminal.js';
import { installToyRuntime, TOY_RUNTIME, TOY_RUNTIME_MARKER } from '../helpers/toy-runtime.js';
import { t3OnFakeServer } from '../helpers/t3-runtime.js';
import { signalPid } from '@teamai/shared/process-group';
import { entriesUnder } from '@teamai/shared/entries-under';

// A driver definition that lists several runtimes: each `next` offers one runtime's `can`, in definition order, and a
// step goes to the first that can take it. The toy runtime is the member's own here, and `local` runs on the host.

describe('a driver definition with several runtimes', () => {
  let sandbox: string;
  let repo: string;
  let bin: string;
  let launches: string;
  let dataHome: string;
  let state: string;
  const memberConfig = (): string => path.join(os.homedir(), '.teamai', 'config.yaml');
  let memberConfigBefore: string | undefined;

  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, LAUNCHES: launches, ...extra });

  /** A team definition `name` whose runtimes are `runtimes`, as YAML gives them. */
  const writeDefinition = (name: string, runtimes: Array<{ use: string; through?: string; options?: Record<string, unknown> }>, { tool = 'claude', dir = path.join(repo, '.teamai', 'drivers') } = {}): void => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.yaml`), stringify({ schemaVersion: 'v1alpha1', name, tool, runtimes }));
  };

  const writeFlow = (name: string, steps: string): void => {
    fs.writeFileSync(path.join(repo, '.teamai', 'workflows', `${name}.yaml`), `schemaVersion: v1alpha1\nname: ${name}\ndescription: ${name}\nsteps:\n${steps}\n`);
  };

  /** Sets `workflows` keys in the member's own config, over what `init` wrote there. */
  const setMemberWorkflows = (workflows: Record<string, unknown>): void => {
    const current = (fs.existsSync(memberConfig()) ? parse(fs.readFileSync(memberConfig(), 'utf8')) : {}) as Record<string, unknown> | null;
    const base = current ?? {};
    const before = (base.workflows ?? {}) as Record<string, unknown>;
    fs.writeFileSync(memberConfig(), stringify({ ...base, workflows: { ...before, ...workflows } }));
  };

  const readRunState = (runId: string): RunState => JSON.parse(fs.readFileSync(path.join(dataHome, 'workflows', 'runs', `${runId}.json`), 'utf8')) as RunState;
  const attemptDir = (runId: string, attempt: string): string => path.join(dataHome, 'workflows', 'runs', runId, 'attempts', attempt);
  const runtimeRecord = (runId: string, attempt: string): Record<string, unknown> | undefined => {
    const file = path.join(attemptDir(runId, attempt), 'runtime.json');
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown> : undefined;
  };

  const toyOpens = (): number => (fs.existsSync(path.join(state, 'ops'))
    ? fs.readdirSync(path.join(state, 'ops')).filter((name) => (JSON.parse(fs.readFileSync(path.join(state, 'ops', name), 'utf8')) as { kind: string }).kind === 'open').length
    : 0);

  const runOf = (ran: Ran): string => {
    const done = envelope(ran);
    const run = 'data' in done && typeof done.data.done === 'object' && done.data.done !== null && 'run' in done.data.done ? done.data.done.run : undefined;
    if (typeof run !== 'string') throw new Error(`no run in the envelope:\n${ran.stdout}\n${ran.stderr}`);
    return run;
  };

  /** The run a usage limit past an unattended run's wait offered on teamai-reports. */
  const offeredRunOf = (ran: Ran): string => {
    const done = envelope(ran);
    const handoff = 'data' in done && typeof done.data.handoff === 'object' && done.data.handoff !== null && 'run' in done.data.handoff ? done.data.handoff.run : undefined;
    if (typeof handoff !== 'string') throw new Error(`no offered run in the envelope:\n${ran.stdout}\n${ran.stderr}`);
    return handoff;
  };

  /** Claude's text for a limit that resets three days from now, past the 6 hours an unattended run waits for it. */
  const claudeWeekly = (): string => {
    const day = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'Europe/Madrid' }).format(Date.now() + 3 * 24 * 3600_000);
    return `You've hit your limit · resets ${day}, 9am (Europe/Madrid)`;
  };

  beforeAll(async () => {
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-driver-runtimes-e2e-')));
    repo = path.join(sandbox, 'repo');
    bin = path.join(sandbox, 'fake-bin');
    launches = path.join(sandbox, 'launches.jsonl');
    fs.mkdirSync(repo);
    fs.mkdirSync(bin);
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
    fs.writeFileSync(path.join(bin, 'claude'), fakeTool({ tool: 'claude', version: '2.1.0 (Claude Code)', homeVariable: 'CLAUDE_CONFIG_DIR', sessions: CLAUDE_SESSIONS }), { mode: 0o755 });
    const runtimeDir = path.join(os.homedir(), '.teamai', 'runtimes', 'toy');
    fs.mkdirSync(runtimeDir, { recursive: true });
    installToyRuntime(runtimeDir);
    fs.mkdirSync(path.join(repo, '.teamai', 'workflows'), { recursive: true });
    writeFlow('mixed', `  - id: build
    workspace: new
    command: node -e "process.stdout.write(JSON.stringify({built:true}))"
    output:
      built: boolean
  - id: review
    needs: [build]
    tool: claude
    prompt: Review the repository without changing it.
    output:
      ok: boolean`);
    writeFlow('sandboxed', `  - id: review
    tool: claude
    prompt: Review the repository in a sandbox.
    requires: { isolation: sandbox, strict: true }
    output:
      ok: boolean`);
    writeFlow('pair', `  - id: left
    workspace: new
    prompt: Review the left half.
    output:
      ok: boolean
  - id: right
    needs: []
    workspace: new
    prompt: Review the right half.
    output:
      ok: boolean`);
    writeFlow('online', `  - id: fetch
    tool: claude
    prompt: Fetch the release notes.
    requires: { network: true }
    output:
      ok: boolean`);
    writeFlow('oneprompt', `  - id: review
    prompt: Review the repository without changing it.
    output:
      ok: boolean`);
    writeFlow('budgeted', `  - id: review
    prompt: Review the repository without changing it.
    budget: { tokens: 1000 }
    on_limit: end_turn
    output:
      ok: boolean`);
    writeFlow('scoredpass', `  - id: review
    prompt: Review the repository without changing it.
    scorers: [quality]
    output:
      ok: boolean`);
    fs.writeFileSync(path.join(repo, '.teamai', 'workflows', 'setupflow.yaml'), `schemaVersion: v1alpha1
name: setupflow
description: setupflow
setup:
  command: "true"
steps:
  - id: review
    workspace: new
    tool: claude
    prompt: Review the change in a fresh worktree.
    output:
      ok: boolean
`);
    writeFlow('pairwork', `  - id: design
    tool: claude
    interactive: true
    prompt: Design the change with me.
    output:
      ok: boolean`);
    writeFlow('person', `  - id: review
    workspace: new
    interactive: true
    tool: claude
    prompt: Review the repository with a person.`);
    writeFlow('missingtool', `  - id: review
    workspace: new
    interactive: true
    tool: codex
    prompt: Review the repository with a person.`);
    writeFlow('policyperson', `  - id: review
    workspace: new
    interactive: true
    tool: claude
    requires: { network: true }
    prompt: Review the repository with a person.`);
    writeFlow('capped', `  - id: review
    tool: codex
    max_turns: 3
    prompt: Review the repository in three turns.
    output:
      ok: boolean`);
    writeFlow('agented', `  - id: review
    tool: claude
    agent: reviewer
    prompt: Review the repository as the reviewer.
    output:
      ok: boolean`);
    fs.mkdirSync(path.join(repo, '.teamai', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.teamai', 'agents', 'reviewer.yaml'), stringify({ name: 'reviewer', description: 'Reviews changes', instructions: 'Follow the review checklist.', model: 'claude-sonnet-4-6' }));
    fs.mkdirSync(path.join(repo, '.teamai', 'scorers'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.teamai', 'scorers', 'quality.md'), `---
labels:
  - { value: good, score: 1, description: Finds the real defects }
  - { value: missed, score: 0, description: Misses a real defect }
passingScore: 0.5
samplingRate: 0
---
Judge the review.
`);
    const pulled = await runCLI(['pull'], repo);
    expect(pulled.code, `${pulled.stdout}\n${pulled.stderr}`).toBe(0);
    dataHome = await resolveProjectDataHome(repo);
    memberConfigBefore = fs.existsSync(memberConfig()) ? fs.readFileSync(memberConfig(), 'utf8') : undefined;
  });

  beforeEach(() => {
    state = fs.mkdtempSync(path.join(sandbox, 'toy-state-'));
    fs.rmSync(launches, { force: true });
    if (memberConfigBefore === undefined) fs.rmSync(memberConfig(), { force: true });
    else fs.writeFileSync(memberConfig(), memberConfigBefore);
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('runs the command step on the runtime that runs commands and the prompt step it cannot take on local, in the same run', async () => {
    // The toy runs commands and offers no tool: the prompt needs one.
    writeDefinition('toyfirst', [{ use: 'toy', options: { state, can: { tools: [] } } }, { use: 'local' }]);

    const ran = await runCLI(['workflow', 'start', 'mixed', '--driver', 'toyfirst'], repo, env());

    expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const runId = runOf(ran);
    const [build, review] = readRunState(runId).steps;
    expect([build, review].map((step) => [step?.id, step?.status])).toEqual([['build', 'succeeded'], ['review', 'succeeded']]);
    expect(runtimeRecord(runId, attemptOf(build))).toMatchObject({ runtime: 'toy', phase: 'closed' });
    expect(runtimeRecord(runId, attemptOf(review))).toEqual({ runtime: 'tools', driver: 'toyfirst', inProcess: true });
    // The prompt ran on the host, in the member's own Claude home.
    const launched = fs.readFileSync(launches, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { home: string });
    expect(launched).toEqual([expect.objectContaining({ home: path.join(os.homedir(), '.claude') })]);
  });

  it('runs a prompt step that takes the definition\'s tool on the next runtime when the first does not offer that tool', async () => {
    writeDefinition('toynotool', [{ use: 'toy', options: { state, can: { tools: [] } } }, { use: 'local' }]);

    const ran = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'toynotool'], repo, env());

    expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const [review] = readRunState(runOf(ran)).steps;
    expect(review).toMatchObject({ id: 'review', status: 'succeeded' });
    expect(runtimeRecord(runOf(ran), attemptOf(review))).toEqual({ runtime: 'tools', driver: 'toynotool', inProcess: true });
    expect(toyOpens()).toBe(0);
  });

  it('fails a prompt step that takes the definition\'s tool when no runtime offers that tool', async () => {
    writeDefinition('toyonlynotool', [{ use: 'toy', options: { state, can: { tools: [] } } }]);

    const ran = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'toyonlynotool'], repo, env());

    expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(readRunState(runOf(ran)).steps).toMatchObject([{ id: 'review', status: 'failed', failure: {
      code: 'tool_unavailable', message: 'Step "review" names no tool and runs on claude, which the driver of this run cannot launch here. Install claude where the run is driven, or pick a tool it launches with --tools default=<tool>.',
    } }]);
    expect(toyOpens()).toBe(0);
  });

  it('never runs a command step on the host while a runtime of the definition runs commands, even one that cannot take it', async () => {
    // The toy runs commands in read-only places only, and the command needs a new worktree, which local would make.
    writeDefinition('toyreadonly', [{ use: 'toy', options: { state, can: { workspace: ['read-only'] } } }, { use: 'local' }]);

    const ran = await runCLI(['workflow', 'start', 'mixed', '--driver', 'toyreadonly'], repo, env());

    expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const [build] = readRunState(runOf(ran)).steps;
    expect(build).toMatchObject({ id: 'build', status: 'failed', failure: { code: 'requirement_unmet', message: expect.stringContaining('runtime local lacks commands (another runtime of the definition runs them)') } });
    expect(toyOpens()).toBe(0);
    expect(fs.existsSync(launches)).toBe(false);
  });

  it('runs a prompt step with setup on local when the runtime that runs commands runs no setup', async () => {
    writeDefinition('toynosetup', [{ use: 'toy', options: { state, can: { setup: false } } }, { use: 'local' }]);

    const ran = await runCLI(['workflow', 'start', 'setupflow', '--driver', 'toynosetup'], repo, env());

    expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(readRunState(runOf(ran)).steps).toMatchObject([{ id: 'review', status: 'succeeded' }]);
    expect(toyOpens()).toBe(0);
    expect(fs.readFileSync(launches, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  describe('setup on the runtime that runs the step', () => {
    // A command found only on the toy's PATH, so setup succeeds only where the toy runs it.
    const toySetup = (body: string): string => {
      const dir = fs.mkdtempSync(path.join(sandbox, 'toy-bin-'));
      fs.writeFileSync(path.join(dir, 'toy-setup'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      return dir;
    };

    const writeSetupFlow = async (name: string): Promise<void> => {
      fs.writeFileSync(path.join(repo, '.teamai', 'workflows', `${name}.yaml`), `schemaVersion: v1alpha1
name: ${name}
description: ${name}
setup:
  command: toy-setup
steps:
  - id: review
    workspace: new
    tool: claude
    prompt: Review the change in a fresh worktree.
    output:
      ok: boolean
`);
      expect((await runCLI(['pull'], repo)).code).toBe(0);
    };

    it('runs setup through the runtime, in the place it opened for the step\'s tool, before the step', async () => {
      await writeSetupFlow('toysetupflow');
      writeDefinition('toysetup', [{ use: 'toy', options: { state, path: toySetup('exit 0') } }]);

      const ran = await runCLI(['workflow', 'start', 'toysetupflow', '--driver', 'toysetup'], repo, env());

      expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      const runId = runOf(ran);
      const [review] = readRunState(runId).steps;
      expect(review).toMatchObject({ id: 'review', status: 'succeeded' });
      // One place, opened for Claude; setup ran there first, as an exec recorded apart from the tool's.
      const notes = fs.readFileSync(path.join(state, 'credentials.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { type: string; op?: string; names: string[] });
      expect(notes.filter((note) => note.type === 'open')).toHaveLength(1);
      const [setupExec, toolExec] = notes.filter((note) => note.type === 'exec');
      expect(toolExec).toBeDefined();
      const record = runtimeRecord(runId, attemptOf(review));
      expect(record).toMatchObject({ setup: { op: setupExec?.op }, exec: { op: toolExec?.op } });
      const opens = fs.readdirSync(path.join(state, 'ops')).map((name) => JSON.parse(fs.readFileSync(path.join(state, 'ops', name), 'utf8')) as { kind: string; tool?: string | null })
        .filter((op) => op.kind === 'open');
      expect(opens.map((op) => op.tool)).toEqual(['claude']);
    });

    it('checks on the host what setup on the runtime left, once collected, and fails the step on a tracked change', async () => {
      await writeSetupFlow('toydirtyflow');
      writeDefinition('toydirty', [{ use: 'toy', options: { state, path: toySetup('echo changed >> README.md') } }]);

      const ran = await runCLI(['workflow', 'start', 'toydirtyflow', '--driver', 'toydirty'], repo, env());

      expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'failed' } } });
      expect(readRunState(runOf(ran)).steps).toMatchObject([{
        id: 'review', status: 'failed',
        failure: { code: 'setup_dirty', message: 'Setup "toy-setup" changed README.md, which the step would commit, so the step did not run. Make setup write only files git ignores, then retry the step.' },
      }]);
      expect(fs.existsSync(launches)).toBe(false);
    });

    /**
     * Starts `flow` on a toy whose first setup runs until stopped, writing into the place by its path, and kills the
     * driver once it runs. Answers the run, the setup's pid, and the toy's options, for the definition the run resumes on.
     */
    const killedDuringSetup = async (flow: string, definition: string, toy: Record<string, unknown> = {}): Promise<{ runId: string; pid: number; options: Record<string, unknown> }> => {
      await writeSetupFlow(flow);
      const marks = fs.mkdtempSync(path.join(sandbox, 'setup-marks-'));
      const options = { ...toy, state, path: toySetup([
        `if [ -e "${marks}/started" ]; then exit 0; fi`,
        `echo $$ > "${marks}/started"`,
        'while :; do [ -d "$PWD" ] && : > "$PWD/left-by-old-setup" 2>/dev/null; sleep 0.01; done',
      ].join('\n')) };
      writeDefinition(definition, [{ use: 'toy', options }]);
      const child = spawn(process.execPath, [CLI, 'workflow', 'start', flow, '--driver', definition], { cwd: repo, env: { ...process.env, ...env(), FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      const closed = new Promise((resolve) => child.on('close', resolve));
      const started = path.join(marks, 'started');
      for (const deadline = Date.now() + 30_000; !(fs.existsSync(started) && fs.readFileSync(started, 'utf8').trim() !== '') && Date.now() < deadline;) await new Promise((resolve) => setTimeout(resolve, 50));
      const pid = Number(fs.readFileSync(started, 'utf8'));
      child.kill('SIGKILL');
      await closed;
      onTestFinished(() => {
        signalPid(pid, 'SIGKILL');
      });

      return { runId: /Run (r[0-9a-f]+) started/.exec(stderr)?.[1] ?? '', pid, options };
    };

    it('stops the setup a killed driver left running on the runtime, and opens the place prepared again anew there, as a runtime that binds its folder needs', async () => {
      const { runId, pid } = await killedDuringSetup('toykilledsetupflow', 'toykilledsetup', { binds: true });

      const resumed = await runCLI(['workflow', 'resume', runId, '--driver', 'toykilledsetup'], repo, env());

      expect(readRunState(runId).steps, resumed.stderr).toMatchObject([{ id: 'review', status: 'succeeded' }]);
      // Stopped first, it wrote nothing into the place prepared again, so the step committed nothing of it.
      expect(execFileSync('git', ['log', '--all', '--name-only', '--format='], { cwd: repo, encoding: 'utf8' })).not.toContain('left-by-old-setup');
      expect(signalPid(pid, 0)).toBe('gone');
    });

    it('fails the step runtime_lost and keeps the place when the runtime cannot stop the setup a killed driver left', async () => {
      const stuck = { code: 'cancel_failed', message: 'The toy cannot stop that exec now: its provider is down.' };
      const { runId, options } = await killedDuringSetup('toystucksetupflow', 'toystucksetup');
      writeDefinition('toystucksetup', [{ use: 'toy', options: { ...options, cancel_fails: stuck } }]);

      const resumed = await runCLI(['workflow', 'resume', runId, '--driver', 'toystucksetup'], repo, env());

      const [review] = readRunState(runId).steps;
      expect(review, resumed.stderr).toMatchObject({ status: 'failed', failure: { code: 'runtime_lost', message: expect.stringContaining(`could not stop the setup of attempt ${attemptOf(review)} that a teamai before this one left running, so it may still run there: ${stuck.message}`) } });
      // Its place is left as the setup has it, not removed under it.
      const place = JSON.parse(fs.readFileSync(path.join(attemptDir(runId, attemptOf(review)), 'place.json'), 'utf8')) as { phase: string; dir: string };
      expect(place.phase).toBe('setting-up');
      expect(fs.existsSync(place.dir)).toBe(true);
    });

    it('fails the step runtime_lost and keeps the place when the runtime cannot close the place whose folder the resumed run makes again', async () => {
      const { runId, options } = await killedDuringSetup('toyunclosedsetupflow', 'toyunclosedsetup', { binds: true });
      writeDefinition('toyunclosedsetup', [{ use: 'toy', options: { ...options, close_fails: true } }]);

      const resumed = await runCLI(['workflow', 'resume', runId, '--driver', 'toyunclosedsetup'], repo, env());

      const [review] = readRunState(runId).steps;
      expect(review, resumed.stderr).toMatchObject({ status: 'failed', failure: { code: 'runtime_lost', message: expect.stringContaining(`could not close the place of attempt ${attemptOf(review)}, whose folder teamai makes again after the setup a teamai before this one cut short, so the step cannot run in it: The toy keeps place`) } });
      const place = JSON.parse(fs.readFileSync(path.join(attemptDir(runId, attemptOf(review)), 'place.json'), 'utf8')) as { phase: string; dir: string };
      expect(place.phase).toBe('setting-up');
      expect(fs.existsSync(place.dir)).toBe(true);
    });

    it('stops, through the driver recorded for it, the setup a killed driver left on a runtime the resumed run does not use, then runs the step again', async () => {
      const otherDir = path.join(os.homedir(), '.teamai', 'runtimes', 'othertoy');
      fs.mkdirSync(otherDir, { recursive: true });
      installToyRuntime(otherDir);
      const { runId, pid, options } = await killedDuringSetup('toymovedsetupflow', 'toymovedsetup');
      writeDefinition('othertoysetup', [{ use: 'othertoy', options: { state: fs.mkdtempSync(path.join(sandbox, 'othertoy-')), path: options.path } }]);

      const resumed = await runCLI(['workflow', 'resume', runId, '--driver', 'othertoysetup'], repo, env());

      const [review] = readRunState(runId).steps;
      expect(review, resumed.stderr).toMatchObject({ status: 'succeeded' });
      expect(resumed.stderr).toContain(`Stopped attempt ${attemptOf(review)} of run ${runId} on step runtime "toy" and closed its place.`);
      // Stopped first, through the driver it was left on, it wrote nothing into the place prepared again.
      expect(signalPid(pid, 0)).toBe('gone');
      expect(execFileSync('git', ['log', '--all', '--name-only', '--format='], { cwd: repo, encoding: 'utf8' })).not.toContain('left-by-old-setup');
      expect(runtimeRecord(runId, attemptOf(review))).toMatchObject({ runtime: 'othertoy', driver: 'othertoysetup', phase: 'closed' });
    });

    it('stops, through the driver recorded for it, the setup a killed driver left on a runtime when the run resumes on the local driver', async () => {
      const { runId, pid } = await killedDuringSetup('toylocalsetupflow', 'toylocalsetup');

      const resumed = await runCLI(['workflow', 'resume', runId, '--driver', 'local'], repo, env());

      const [review] = readRunState(runId).steps;
      // Setup runs on this machine now, where toy-setup is not found: the step fails on that, not on the left setup.
      expect(review, resumed.stderr).toMatchObject({ status: 'failed', failure: { code: 'setup_failed' } });
      expect(resumed.stderr).toContain(`Stopped attempt ${attemptOf(review)} of run ${runId} on step runtime "toy" and closed its place.`);
      expect(signalPid(pid, 0)).toBe('gone');
    });

    it('fails the step runtime_lost and keeps the place when the driver recorded for a setup a killed driver left cannot stop it', async () => {
      const stuck = { code: 'cancel_failed', message: 'The toy cannot stop that exec now: its provider is down.' };
      const { runId, options } = await killedDuringSetup('toystuckmovedflow', 'toystuckmoved');
      writeDefinition('toystuckmoved', [{ use: 'toy', options: { ...options, cancel_fails: stuck } }]);

      const resumed = await runCLI(['workflow', 'resume', runId, '--driver', 'local'], repo, env());

      const [review] = readRunState(runId).steps;
      expect(review, resumed.stderr).toMatchObject({ status: 'failed', failure: { code: 'runtime_lost', message: expect.stringContaining(`Attempt ${attemptOf(review)} ran on step runtime "toy" of driver "toystuckmoved", which could not stop what ran there, so it may still run: `) } });
      expect(review).toMatchObject({ failure: { message: expect.stringContaining(`${stuck.message} Resume the run with --driver toystuckmoved.`) } });
      const place = JSON.parse(fs.readFileSync(path.join(attemptDir(runId, attemptOf(review)), 'place.json'), 'utf8')) as { phase: string; dir: string };
      expect(place.phase).toBe('setting-up');
      expect(fs.existsSync(place.dir)).toBe(true);
    });

    it('keeps the failure a runtime opens the place with when setup never ran there, and gives up the worktree', async () => {
      await writeSetupFlow('toybadopenflow');
      writeDefinition('toybadopensetup', [{ use: 'toy', options: { state, path: toySetup('exit 0'), open_fails: { code: 'bad_option', message: 'Option "image" names acme/agent:9, which this machine cannot pull' } } }]);
      const worktrees = (): string[] => execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8' }).split('\n').filter((line) => line.startsWith('worktree '));
      const worktreesBefore = worktrees();

      const ran = await runCLI(['workflow', 'start', 'toybadopenflow', '--driver', 'toybadopensetup'], repo, env());

      expect(readRunState(runOf(ran)).steps, ran.stderr).toMatchObject([{ id: 'review', status: 'failed', failure: { message: expect.stringContaining('(bad_option): Option "image" names acme/agent:9') } }]);
      expect(worktrees()).toEqual(worktreesBefore);
    });
  });

  it('fails a step whose requirements no single runtime meets, naming each runtime and what it lacks', async () => {
    // The toy is a sandbox with no tool; local has the tool and no sandbox.
    writeDefinition('splitd', [{ use: 'toy', options: { state, can: { isolation: 'sandbox', tools: [] } } }, { use: 'local' }]);

    const ran = await runCLI(['workflow', 'start', 'sandboxed', '--driver', 'splitd'], repo, env());

    expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const [review] = readRunState(runOf(ran)).steps;
    expect(review).toMatchObject({ id: 'review', status: 'failed', failure: { code: 'requirement_unmet' } });
    const message = review && 'failure' in review ? review.failure?.message : '';
    expect(message).toContain('driver "splitd"');
    expect(message).toContain('runtime toy lacks tools');
    expect(message).toContain('runtime local lacks isolation');
    expect(toyOpens()).toBe(0);
  });

  it('hands an interactive step to a person, unattended, when no runtime can ask and one of them lacks its workspace', async () => {
    writeDefinition('personless', [{ use: 'local' }, { use: 'toy', options: { state, can: { workspace: [] } } }]);

    const ran = await runCLI(['workflow', 'start', 'person', '--driver', 'personless'], repo, env({ TEAMAI_MODE: 'unattended' }));

    expect(envelope(ran), ran.stderr).toMatchObject({ data: { handoff: { steps: ['review'] } } });
    expect(ran.code).toBe(0);
    expect(toyOpens()).toBe(0);
    expect(fs.existsSync(launches)).toBe(false);
  });

  it.each([
    ['local', []],
    ['toolgap', ['local', 'toy']],
    ['gaptool', ['toy', 'local']],
  ] as const)('fails an interactive step tool_unavailable, unattended, on driver %s, when no runtime launches its tool, before a person is asked', async (driver, order) => {
    // The toy offers no tool and no workspace, so its plan defers the step.
    if (order.length > 0) writeDefinition(driver, order.map((use) => (use === 'toy' ? { use, options: { state, can: { workspace: [], tools: [] } } } : { use })));
    // Codex is on no runtime: local finds only the fake Claude and node on this PATH.
    const nodeOnly = fs.mkdtempSync(path.join(sandbox, 'node-bin-'));
    fs.symlinkSync(process.execPath, path.join(nodeOnly, 'node'));

    const ran = await runCLI(['workflow', 'start', 'missingtool', '--driver', driver], repo, env({ PATH: [bin, nodeOnly, '/usr/bin', '/bin'].join(path.delimiter), TEAMAI_MODE: 'unattended' }));

    expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(readRunState(runOf(ran)).steps).toMatchObject([{ id: 'review', status: 'failed', failure: {
      code: 'tool_unavailable', message: 'Step "review" runs on codex, which the driver of this run cannot launch here. Install codex where the run is driven, or remove tool from the step.',
    } }]);
    expect(toyOpens()).toBe(0);
    expect(fs.existsSync(launches)).toBe(false);
  });

  it.each([
    ['local', []],
    ['policymixed', ['local', 'toy']],
    ['policytoyfirst', ['toy', 'local']],
  ] as const)('stops busy on an interactive step the member\'s policy refuses, unattended, on driver %s, and hands it to no person', async (driver, order) => {
    setMemberWorkflows({ allow: { network: false } });
    // The toy offers no workspace, so its plan defers the step.
    if (order.length > 0) writeDefinition(driver, order.map((use) => (use === 'toy' ? { use, options: { state, can: { workspace: [] } } } : { use })));

    const ran = await runCLI(['workflow', 'start', 'policyperson', '--driver', driver], repo, env({ TEAMAI_MODE: 'unattended' }));

    // Busy names what the member can change, the policy, whichever runtime was offered last.
    expect(envelope(ran), ran.stderr).toEqual({ error: { code: 'busy', message: 'step "review" needs network, which workflows.allow in local config does not allow on this machine' } });
    expect(ran.code).toBe(1);
    expect(toyOpens()).toBe(0);
    expect(fs.existsSync(launches)).toBe(false);
  });

  it('refuses at start a strict sandbox answer step, which only this host answers, though a runtime of the definition is a sandbox', async () => {
    writeDefinition('sandboxanswer', [{ use: 'toy', options: { state, can: { isolation: 'sandbox' } } }]);
    // An answer step takes no requires of its own; the workflow's defaults apply to it.
    fs.writeFileSync(path.join(repo, '.teamai', 'workflows', 'asksandboxed.yaml'), `schemaVersion: v1alpha1
name: asksandboxed
description: asksandboxed
defaults:
  requires: { isolation: sandbox, strict: true }
steps:
  - id: ask
    answer: Name one risk in this repository.
    output:
      text: string
`);
    await runCLI(['pull'], repo);
    const runs = (): string[] => (fs.existsSync(path.join(dataHome, 'workflows', 'runs')) ? fs.readdirSync(path.join(dataHome, 'workflows', 'runs')) : []);
    const before = runs();

    const ran = await runCLI(['workflow', 'start', 'asksandboxed', '--driver', 'sandboxanswer'], repo, env({ TEAMAI_AI_TOOL: 'claude', FAKE_TOOL_REPLY: 'Unpinned dependencies.' }));

    const refused = envelope(ran);
    expect(refused, ran.stderr).toMatchObject({ error: { code: 'requirement_unmet' } });
    const message = 'error' in refused ? refused.error.message : '';
    expect(message).toContain('Step "ask" requires strict isolation');
    expect(message).toContain('runtime host of driver "sandboxanswer"');
    expect(runs()).toEqual(before);
    expect(toyOpens()).toBe(0);
  });

  it('refuses at start a strict sandbox step that no runtime of the definition is, naming the driver and its runtimes', async () => {
    writeDefinition('nosandbox', [{ use: 'toy', options: { state } }, { use: 'local' }]);
    const runs = (): string[] => (fs.existsSync(path.join(dataHome, 'workflows', 'runs')) ? fs.readdirSync(path.join(dataHome, 'workflows', 'runs')) : []);
    const before = runs();

    const ran = await runCLI(['workflow', 'start', 'sandboxed', '--driver', 'nosandbox'], repo, env());

    expect(envelope(ran)).toMatchObject({ error: { code: 'requirement_unmet' } });
    const refused = envelope(ran);
    const message = 'error' in refused ? refused.error.message : '';
    expect(message).toContain('Step "review" requires strict isolation');
    expect(message).toContain('driver "nosandbox"');
    expect(message).toContain('(toy: isolation none, local: isolation none)');
    // No run was created.
    expect(runs()).toEqual(before);
  });

  it('keeps the code a runtime fails an open with in the step\'s failure', async () => {
    writeDefinition('toybadopen', [{ use: 'toy', options: { state, open_fails: { code: 'bad_option', message: 'Option "image" names acme/agent:9, which this machine cannot pull' } } }]);

    const ran = await runCLI(['workflow', 'start', 'mixed', '--driver', 'toybadopen'], repo, env());

    expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const [build] = readRunState(runOf(ran)).steps;
    expect(build).toMatchObject({ id: 'build', status: 'failed', failure: { code: 'runtime_failed', message: expect.stringContaining('(bad_option): Option "image" names acme/agent:9') } });
  });

  it('publishes a scored pass\'s label from the checkout of teamai-reports in a single-repo team', async () => {
    const ran = await runCLI(['workflow', 'start', 'scoredpass', '--driver', 'claude'], repo, env());
    const runId = runOf(ran);

    const scored = await runCLI(['score', '--run', runId, '--step', 'review', '--scorer', 'quality'], repo, env());

    expect(envelope(scored), scored.stderr).toMatchObject({ data: { label: { scorer: 'quality', label: 'good' } } });
    const scoreRun = String((envelope(scored) as { data: { run: string } }).data.run);
    // The publish step runs in a checkout of teamai-reports, which holds no .teamai/: it reads the run's own config.
    const publish = readRunState(scoreRun).steps.find((step) => step.id === 'score[0].publish');
    expect(publish, JSON.stringify(publish)).toMatchObject({ status: 'succeeded' });
    const published = execFileSync('git', ['ls-tree', '-r', '--name-only', 'teamai-reports'], { cwd: path.join(sandbox, 'origin.git'), encoding: 'utf8' });
    expect(published).toMatch(/^scores\/[^/\n]+\/\d{4}-\d{2}\.jsonl$/m);
  });

  // A member whose Codex login lives in a CODEX_HOME outside HOME, which teamai does not record as Codex's root.
  it('scores a Codex pass whose session is in the CODEX_HOME the step ran with, outside HOME', async () => {
    writeFlow('codexscored', `  - id: review
    tool: codex
    prompt: Review the repository without changing it.
    scorers: [byclaude]`);
    // Judged by the fake Claude, which answers a judge; the recorded Codex answers only its step.
    fs.writeFileSync(path.join(repo, '.teamai', 'scorers', 'byclaude.md'), fs.readFileSync(path.join(repo, '.teamai', 'scorers', 'quality.md'), 'utf8').replace('---\nlabels:', '---\ntool: claude\nlabels:'));
    expect((await runCLI(['pull'], repo)).code).toBe(0);
    codexOnPath(bin);
    const codexHome = path.join(sandbox, 'codex-home-outside');
    fs.mkdirSync(codexHome, { recursive: true });
    expect(path.relative(os.homedir(), codexHome).startsWith('..')).toBe(true);

    const ran = await runCLI(['workflow', 'start', 'codexscored', '--driver', 'local'], repo, env({ CODEX_HOME: codexHome }));
    const runId = runOf(ran);
    const [review] = readRunState(runId).steps;
    expect(review, ran.stderr).toMatchObject({ status: 'succeeded', tool: 'codex' });
    expect(entriesUnder(path.join(codexHome, 'sessions')).some(({ relative }) => relative.endsWith('.jsonl'))).toBe(true);

    const scored = await runCLI(['score', '--run', runId, '--step', 'review', '--scorer', 'byclaude'], repo, env({ CODEX_HOME: codexHome }));

    expect(envelope(scored), scored.stderr).toMatchObject({ data: { label: { scorer: 'byclaude', label: 'good' } } });
  });

  // An instance whose home names no variable keeps its sessions in its own directory, whatever CLAUDE_CONFIG_DIR says.
  it('scores a pass of an instance in its own home, though the step ran with the base tool\'s home variable set elsewhere', async () => {
    const file = path.join(os.homedir(), '.teamai', 'tools', 'claude-work.yaml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'schemaVersion: v1alpha1\nname: claude-work\nextends: claude\ncommand: claude-work\nhome: { dir: .claude-work-home }\n');
    fs.writeFileSync(path.join(bin, 'claude-work'), fakeTool({ tool: 'claude-work-home', version: '2.1.0 (Claude Code)', homeVariable: 'CLAUDE_WORK_UNSET', sessions: CLAUDE_SESSIONS }), { mode: 0o755 });
    onTestFinished(() => {
      fs.rmSync(file, { force: true });
      fs.rmSync(path.join(bin, 'claude-work'), { force: true });
    });
    writeFlow('workscored', `  - id: review
    tool: claude-work
    prompt: Review the repository without changing it.
    scorers: [quality]`);
    expect((await runCLI(['pull'], repo)).code).toBe(0);
    const elsewhere = path.join(sandbox, 'claude-config-elsewhere');
    fs.mkdirSync(elsewhere, { recursive: true });

    const ran = await runCLI(['workflow', 'start', 'workscored', '--driver', 'local'], repo, env({ CLAUDE_CONFIG_DIR: elsewhere }));
    const runId = runOf(ran);
    expect(readRunState(runId).steps[0], ran.stderr).toMatchObject({ status: 'succeeded' });

    const scored = await runCLI(['score', '--run', runId, '--step', 'review', '--scorer', 'quality'], repo, env({ CLAUDE_CONFIG_DIR: elsewhere }));

    expect(envelope(scored), scored.stderr).toMatchObject({ data: { label: { scorer: 'quality', label: 'good' } } });
  });

  it('judges the pass teamai score names on the definition workflows.driver names, when this machine runs it', async () => {
    const ran = await runCLI(['workflow', 'start', 'scoredpass', '--driver', 'claude'], repo, env());
    const runId = runOf(ran);
    writeDefinition('toyscore', [{ use: 'toy', options: { state, judge: { reply: { answer: { label: 'missed', reasoning: 'read it' } } } } }]);
    setMemberWorkflows({ driver: 'toyscore' });

    const scored = await runCLI(['score', '--run', runId, '--step', 'review', '--scorer', 'quality'], repo, env());

    expect(envelope(scored), scored.stderr).toMatchObject({ data: { label: { scorer: 'quality', label: 'missed' } } });
    expect(scored.stderr).not.toContain('waits for driver');
    const scoreRun = String((envelope(scored) as { data: { run: string } }).data.run);
    const judge = readRunState(scoreRun).steps.find((step) => step.id.endsWith('.judge'));
    expect(runtimeRecord(scoreRun, attemptOf(judge))).toMatchObject({ runtime: 'toy', driver: 'toyscore' });
    // The judge's place was opened naming the tool its confined prompt runs.
    const opens = fs.readdirSync(path.join(state, 'ops')).map((name) => JSON.parse(fs.readFileSync(path.join(state, 'ops', name), 'utf8')) as { kind: string; tool?: string | null })
      .filter((op) => op.kind === 'open');
    expect(opens.map((op) => op.tool)).toEqual(['claude']);
  });

  it('ends the failure of a judge whose runtime restarted under it with the retry to run, its step path quoted for the shell', async () => {
    const ran = await runCLI(['workflow', 'start', 'scoredpass', '--driver', 'claude'], repo, env());
    const runId = runOf(ran);
    writeDefinition('toyjudgerestart', [{ use: 'toy', options: { state, judge: { fail: { code: 'daemon_restarted', message: 'The daemon stopped while the claude agent answered the confined prompt.' } } } }]);
    setMemberWorkflows({ driver: 'toyjudgerestart' });
    const runsDir = path.join(dataHome, 'workflows', 'runs');
    const before = new Set(fs.readdirSync(runsDir));

    const scored = await runCLI(['score', '--run', runId, '--step', 'review', '--scorer', 'quality'], repo, env());

    const [scoreRun = ''] = fs.readdirSync(runsDir).filter((name) => !before.has(name) && name.endsWith('.json')).map((name) => name.slice(0, -'.json'.length));
    const judge = readRunState(scoreRun).steps.find((step) => step.id.endsWith('.judge'));
    expect(judge, scored.stderr).toMatchObject({
      status: 'failed',
      failure: { message: `Step runtime "toy" could not run the confined claude prompt (daemon_restarted): The daemon stopped while the claude agent answered the confined prompt. Then run: teamai workflow retry ${scoreRun} 'score[0].judge'` },
    });
  });

  it('resumes a run that awaits a definition on that definition once this machine runs it, when the resume names no driver', async () => {
    const ran = await runCLI(['workflow', 'start', 'scoredpass', '--driver', 'claude'], repo, env());
    const runId = runOf(ran);
    setMemberWorkflows({ driver: 'toylater' });
    const waiting = await runCLI(['score', '--run', runId, '--step', 'review', '--scorer', 'quality'], repo, env());
    const scoreRun = String((envelope(waiting) as { data: { run: string } }).data.run);
    expect(waiting.stderr).toContain(`${scoreRun} waits for driver toylater, which this machine does not run`);
    writeDefinition('toylater', [{ use: 'toy', options: { state, judge: { reply: { answer: { label: 'missed', reasoning: 'read it' } } } } }]);

    const resumed = await runCLI(['workflow', 'resume', scoreRun], repo, env());

    expect(envelope(resumed), resumed.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const judge = readRunState(scoreRun).steps.find((step) => step.id.endsWith('.judge'));
    expect(runtimeRecord(scoreRun, attemptOf(judge))).toMatchObject({ runtime: 'toy', driver: 'toylater' });
  });

  /** The member's own instance `name` of claude, run by the fake claude, removed once the test ends. */
  const ownInstance = (name: string): void => {
    const file = path.join(os.homedir(), '.teamai', 'tools', `${name}.yaml`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `schemaVersion: v1alpha1\nname: ${name}\nextends: claude\ncommand: claude\nhome: { dir: .${name}-home }\n`);
    onTestFinished(() => fs.rmSync(file, { force: true }));
  };

  /** The member's own instance acme-claude of claude, with a command and a home variable of its own. */
  const acmeInstance = (): void => {
    const file = path.join(os.homedir(), '.teamai', 'tools', 'acme-claude.yaml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'schemaVersion: v1alpha1\nname: acme-claude\nextends: claude\ncommand: acme-claude\nhome: { dir: .acme-claude, env: ACME_CLAUDE_CONFIG_DIR }\n');
    fs.writeFileSync(path.join(bin, 'acme-claude'), fakeTool({ tool: 'acme-claude', version: '2.1.0 (Claude Code)', homeVariable: 'ACME_CLAUDE_CONFIG_DIR', sessions: CLAUDE_SESSIONS }), { mode: 0o755 });
    onTestFinished(() => {
      fs.rmSync(file, { force: true });
      fs.rmSync(path.join(bin, 'acme-claude'), { force: true });
    });
  };

  it('runs a step on an instance a runtime that execs its tool lists, with the instance\'s command and its home variable at the attempt\'s tool home', async () => {
    acmeInstance();
    writeDefinition('toyacme', [{ use: 'toy', options: { state, can: { tools: ['claude', 'acme-claude'] } } }]);

    const ran = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'toyacme', '--tools', 'default=acme-claude'], repo, env());

    const runId = runOf(ran);
    const [review] = readRunState(runId).steps;
    expect(review, ran.stderr).toMatchObject({ status: 'succeeded' });
    const [launch] = fs.readFileSync(launches, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { home: string });
    expect(launch?.home).toBe(path.join(attemptDir(runId, attemptOf(review)), 'tool-home', 'acme-claude'));
    // Its place was opened for the instance, by the name init.instances gives it.
    const opens = fs.readdirSync(path.join(state, 'ops')).map((name) => JSON.parse(fs.readFileSync(path.join(state, 'ops', name), 'utf8')) as { kind: string; tool?: string | null })
      .filter((op) => op.kind === 'open');
    expect(opens.map((op) => op.tool)).toEqual(['acme-claude']);
  });

  it('resumes the session of an instance on a runtime that execs its tool, from the earlier attempt\'s tool home', async () => {
    acmeInstance();
    writeFlow('acmefollow', `  - id: review
    prompt: Review the repository without changing it.
    output:
      ok: boolean
  - id: followup
    needs: [review]
    session: { from: review }
    prompt: Follow up on the review.
    output:
      ok: boolean`);
    expect((await runCLI(['pull'], repo)).code).toBe(0);
    writeDefinition('toyacmefollow', [{ use: 'toy', options: { state, can: { tools: ['claude', 'acme-claude'] } } }]);

    const ran = await runCLI(['workflow', 'start', 'acmefollow', '--driver', 'toyacmefollow', '--tools', 'default=acme-claude'], repo, env());

    const runId = runOf(ran);
    const [review, followup] = readRunState(runId).steps;
    expect(followup, ran.stderr).toMatchObject({ status: 'succeeded', session: `sess-${attemptOf(review)}` });
    const launched = fs.readFileSync(launches, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { home: string; resumed?: string; sessionFoundBefore: boolean });
    expect(launched[1]).toMatchObject({ home: path.join(attemptDir(runId, attemptOf(followup)), 'tool-home', 'acme-claude'), resumed: `sess-${attemptOf(review)}`, sessionFoundBefore: true });
  });

  it('names the instance a step runs on as the tool of its open and its prompt on a runtime that launches agents its own way', async () => {
    acmeInstance();
    writeDefinition('toyagentinstance', [{ use: 'toy', options: { state, can: { tools: ['claude', 'acme-claude'] }, agent: { output: { ok: true } } } }]);

    const ran = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'toyagentinstance', '--tools', 'default=acme-claude'], repo, env());

    expect(readRunState(runOf(ran)).steps, ran.stderr).toMatchObject([{ status: 'succeeded' }]);
    const sent = fs.readFileSync(path.join(state, 'prompts.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { sent?: { tool: string } }).find((line) => line.sent)?.sent;
    expect(sent?.tool).toBe('acme-claude');
    const opens = fs.readdirSync(path.join(state, 'ops')).map((name) => JSON.parse(fs.readFileSync(path.join(state, 'ops', name), 'utf8')) as { kind: string; tool?: string | null })
      .filter((op) => op.kind === 'open');
    expect(opens.map((op) => op.tool)).toEqual(['acme-claude']);
    expect(fs.existsSync(launches)).toBe(false);
  });

  it('fails a step on an instance a runtime that execs its tool does not list, naming the instance and --driver local', async () => {
    acmeInstance();
    writeDefinition('toynoacme', [{ use: 'toy', options: { state, can: { tools: ['claude'] } } }]);

    const ran = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'toynoacme', '--tools', 'default=acme-claude'], repo, env());

    const [review] = readRunState(runOf(ran)).steps;
    expect(review, ran.stderr).toMatchObject({
      status: 'failed',
      failure: { code: 'tool_unsupported', message: 'Step "review" runs on acme-claude, an instance of claude, which runtime toy of driver toynoacme cannot launch. Run it with --driver local.' },
    });
    expect(fs.existsSync(launches)).toBe(false);
  });

  describe('an instance a runtime says it cannot run now', () => {
    const reason = 'acme-claude runs acme-claude, which is not in the toy image: add it to the image, or run the step with --driver local.';

    it('says once, quoting the runtime\'s reason, that steps on a tool it cannot run now go to the next runtime', async () => {
      const claudeReason = 'claude is not signed in on the toy: run claude login there, or set ANTHROPIC_API_KEY.';
      writeFlow('twoprompts', `  - id: first
    tool: claude
    prompt: Review the left half.
    output:
      ok: boolean
  - id: second
    needs: [first]
    tool: claude
    prompt: Review the right half.
    output:
      ok: boolean`);
      expect((await runCLI(['pull'], repo)).code).toBe(0);
      writeDefinition('toyfallthrough', [{ use: 'toy', options: { state, unavailable: { claude: claudeReason } } }, { use: 'local' }]);

      const ran = await runCLI(['workflow', 'start', 'twoprompts', '--driver', 'toyfallthrough'], repo, env());

      expect(readRunState(runOf(ran)).steps, ran.stderr).toMatchObject([{ status: 'succeeded' }, { status: 'succeeded' }]);
      expect(toyOpens()).toBe(0);
      const line = `Runtime toy of driver toyfallthrough cannot run claude now, so steps on claude run on runtime local: toy: ${claudeReason}`;
      expect(ran.stderr.split(line).length - 1, ran.stderr).toBe(1);
    });

    it('fails its step with the runtime\'s reason, on a definition whose runtimes are all off this host', async () => {
      acmeInstance();
      writeDefinition('toyacmeunavailable', [{ use: 'toy', options: { state, can: { tools: ['claude'] }, unavailable: { 'acme-claude': reason } } }]);

      const ran = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'toyacmeunavailable', '--tools', 'default=acme-claude'], repo, env());

      expect(readRunState(runOf(ran)).steps, ran.stderr).toMatchObject([{
        status: 'failed',
        failure: { code: 'tool_unavailable', message: `Step "review" names no tool and runs on acme-claude, which the driver of this run cannot launch here: toy: ${reason} Or pick a tool it launches with --tools default=<tool>.` },
      }]);
      expect(fs.existsSync(launches)).toBe(false);
    });

    it('names the runtime\'s reason where a strict step needs what no single runtime offers', async () => {
      acmeInstance();
      writeFlow('strictnotool', `  - id: review
    prompt: Review the repository in a sandbox.
    requires: { isolation: sandbox, strict: true }
    output:
      ok: boolean`);
      expect((await runCLI(['pull'], repo)).code).toBe(0);
      writeDefinition('toysbxacme', [{ use: 'toy', options: { state, can: { isolation: 'sandbox', env: true, tools: ['claude'] }, unavailable: { 'acme-claude': reason } } }, { use: 'local' }]);

      const ran = await runCLI(['workflow', 'start', 'strictnotool', '--driver', 'toysbxacme', '--tools', 'default=acme-claude'], repo, env());

      const [review] = readRunState(runOf(ran)).steps;
      expect(review, ran.stderr).toMatchObject({ status: 'failed', failure: { code: 'requirement_unmet' } });
      expect(review && 'failure' in review ? review.failure?.message : '').toContain(`runtime toy lacks tools (toy: ${reason})`);
      expect(fs.existsSync(launches)).toBe(false);
    });
  });

  it('tells a runtime at init the checkout the run starts in, and starts it there', async () => {
    writeDefinition('toycheckout', [{ use: 'toy', options: { state } }]);

    await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'toycheckout'], repo, env());

    const inits = fs.readFileSync(path.join(state, 'inits.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { checkout?: string; cwd?: string });
    expect(inits.at(-1)).toMatchObject({ checkout: repo, cwd: repo });
  });

  it('gives a runtime the instances the member may run at init, with their command and their home resolved as teamai resolves it, and every variable teamai sets each tool\'s home with', async () => {
    acmeInstance();
    writeDefinition('toyagentacme', [{ use: 'toy', options: { state, agent: { output: { ok: true } } } }]);
    const moved = path.join(os.tmpdir(), 'acme-claude-moved');
    const initsOf = () => fs.readFileSync(path.join(state, 'inits.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { instances?: unknown[]; homeEnv?: Record<string, string[]> });

    await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'toyagentacme'], repo, env());
    expect(initsOf().at(-1)?.instances).toContainEqual(expect.objectContaining({ name: 'acme-claude', tool: 'claude', command: 'acme-claude', home: { dir: path.join(os.homedir(), '.acme-claude') } }));
    // A shipped tool's variables as well as an instance's, so a runtime names none of its own.
    expect(initsOf().at(-1)?.homeEnv).toMatchObject({ 'claude': ['CLAUDE_CONFIG_DIR'], 'codex': ['CODEX_HOME'], 'opencode': [], 'acme-claude': ['CLAUDE_CONFIG_DIR', 'ACME_CLAUDE_CONFIG_DIR'] });

    await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'toyagentacme'], repo, env({ ACME_CLAUDE_CONFIG_DIR: moved }));
    expect(initsOf().at(-1)?.instances).toContainEqual(expect.objectContaining({ name: 'acme-claude', home: { dir: moved } }));

    // A relative value, as teamai itself reads it from where it runs.
    await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'toyagentacme'], repo, env({ ACME_CLAUDE_CONFIG_DIR: 'acme-claude-here' }));
    expect(initsOf().at(-1)?.instances).toContainEqual(expect.objectContaining({ name: 'acme-claude', home: { dir: path.join(fs.realpathSync(repo), 'acme-claude-here') } }));
  });

  it('gives a runtime at init no instance for a file that only adjusts a shipped tool\'s paths', async () => {
    const file = path.join(os.homedir(), '.teamai', 'tools', 'claude.yaml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'schemaVersion: v1alpha1\nname: claude\nextends: claude\npaths: { skills: .claude/team-skills }\n');
    onTestFinished(() => fs.rmSync(file, { force: true }));
    writeDefinition('toyadjusted', [{ use: 'toy', options: { state, agent: { output: { ok: true } } } }]);

    await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'toyadjusted'], repo, env());

    const [init] = fs.readFileSync(path.join(state, 'inits.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { instances?: Array<{ name: string }> }).slice(-1);
    expect(init?.instances ?? []).not.toContainEqual(expect.objectContaining({ name: 'claude' }));
  });

  it('runs a step whose default tool is an instance on the next runtime when the first offers only the tool it extends', async () => {
    ownInstance('claude-work');
    writeDefinition('toyinstance', [{ use: 'toy', options: { state, can: { tools: ['claude'] } } }, { use: 'local' }]);

    const ran = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'toyinstance', '--tools', 'default=claude-work'], repo, env());

    const runId = runOf(ran);
    const [review] = readRunState(runId).steps;
    expect(review, ran.stderr).toMatchObject({ status: 'succeeded' });
    expect(runtimeRecord(runId, attemptOf(review))).toEqual({ runtime: 'tools', driver: 'toyinstance', inProcess: true });
    expect(toyOpens()).toBe(0);
  });

  it('fails a step a sandbox would take but cannot sign its tool in, with the sandbox\'s reason, rather than run it on local', async () => {
    writeFlow('codexreview', `  - id: review
    tool: codex
    prompt: Review the repository without changing it.
    output:
      ok: boolean`);
    expect((await runCLI(['pull'], repo)).code).toBe(0);
    // A codex on this machine's PATH, which local would launch.
    const codex = codexOnPath(bin);
    const reason = 'codex cannot sign in inside this sandbox. Sign it in there, then start again.';
    writeDefinition('sandboxthenlocal', [{ use: 'toy', options: { state, can: { isolation: 'sandbox' }, unavailable: { codex: reason } } }, { use: 'local' }]);

    const ran = await runCLI(['workflow', 'start', 'codexreview', '--driver', 'sandboxthenlocal'], repo, env());

    const [review] = readRunState(runOf(ran)).steps;
    expect(review, ran.stderr).toMatchObject({ status: 'failed', failure: { code: 'tool_unavailable', message: expect.stringContaining(`toy: ${reason}`) } });
    expect(codex.calls()).toEqual([]);
  });

  it('records the runtime each step ran on: the host command slot for a command a prompt runtime does not run', async () => {
    writeDefinition('agentandhost', [{ use: 'toy', options: { state, agent: { output: { ok: true } } } }]);

    const ran = await runCLI(['workflow', 'start', 'mixed', '--driver', 'agentandhost'], repo, env());

    const [build, review] = readRunState(runOf(ran)).steps;
    expect(build, ran.stderr).toMatchObject({ id: 'build', status: 'succeeded', runtime: 'host' });
    expect(review).toMatchObject({ id: 'review', status: 'succeeded', runtime: 'toy' });
  });

  describe('a step that requires the host', () => {
    it('runs the command steps of a team copy of teamai-score under another name on the host, though a runtime of the definition execs', async () => {
      const shipped = fs.readFileSync(path.join(ROOT, 'workflows', 'teamai-score.yaml'), 'utf8');
      fs.writeFileSync(path.join(repo, '.teamai', 'workflows', 'acme-score.yaml'), shipped.replace('name: teamai-score', 'name: acme-score'));
      expect((await runCLI(['pull'], repo)).code).toBe(0);
      writeDefinition('toyexecscore', [{ use: 'toy', options: { state } }]);
      const inputs = { subject: 'session:claude:none', scorers: ['quality'], label: '', batch: false, demand: 'named' };

      const scored = await runCLI(['workflow', 'start', 'acme-score', '--driver', 'toyexecscore', '--inputs', JSON.stringify(inputs)], repo, env());

      const [plan] = readRunState(runOf(scored)).steps;
      expect(plan, scored.stderr).toMatchObject({ id: 'plan', runtime: 'host' });
      expect(toyOpens()).toBe(0);
    });

    it('fails a prompt step that requires the host on a definition whose only runtime is off this host, naming host', async () => {
      writeFlow('hostprompt', `  - id: review
    prompt: Review the repository without changing it.
    requires: { host: true }
    output:
      ok: boolean`);
      expect((await runCLI(['pull'], repo)).code).toBe(0);
      writeDefinition('toyonlyhost', [{ use: 'toy', options: { state } }]);

      const ran = await runCLI(['workflow', 'start', 'hostprompt', '--driver', 'toyonlyhost'], repo, env());

      const [review] = readRunState(runOf(ran)).steps;
      expect(review, ran.stderr).toMatchObject({ status: 'failed', failure: { code: 'requirement_unmet', message: expect.stringContaining('runtime toy lacks host (the step stays on this machine)') } });
      expect(toyOpens()).toBe(0);
    });

    it('runs a prompt step that requires the host on the runtime of the definition that launches tools on this machine', async () => {
      writeFlow('hostprompt2', `  - id: review
    prompt: Review the repository without changing it.
    requires: { host: true }
    output:
      ok: boolean`);
      expect((await runCLI(['pull'], repo)).code).toBe(0);
      writeDefinition('toyandhost', [{ use: 'toy', options: { state } }, { use: 'local' }]);

      const ran = await runCLI(['workflow', 'start', 'hostprompt2', '--driver', 'toyandhost'], repo, env());

      const [review] = readRunState(runOf(ran)).steps;
      // A prompt step in teamai's process is recorded on tools, whatever name the definition gives that entry.
      expect(review, ran.stderr).toMatchObject({ status: 'succeeded', runtime: 'tools' });
      expect(toyOpens()).toBe(0);
    });
  });

  it.each([
    {
      tool: 'claude', file: 'settings.json',
      member: JSON.stringify({ model: 'opus', effortLevel: 'high', modelSettings: { opus: { thinking: true } }, env: { MEMBER_TOKEN: 'kept-home' }, permissions: { allow: ['Bash'] }, hooks: { Stop: [] }, mcpServers: { db: {} } }),
      seeded: { model: 'opus', effortLevel: 'high', modelSettings: { opus: { thinking: true } } },
    },
    {
      tool: 'codex', file: 'config.toml',
      member: 'model = "gpt-5.5"\nmodel_reasoning_effort = "high"\napproval_policy = "never"\n\n[mcp_servers.db]\ncommand = "db"\n\n[shell_environment_policy.set]\nMEMBER_TOKEN = "kept-home"\n',
      seeded: { model: 'gpt-5.5', model_reasoning_effort: 'high' },
    },
  ])('starts a $tool attempt home with the member\'s model choices and nothing else of their settings', async ({ tool, file, member, seeded }) => {
    writeFlow(`${tool}seeded`, `  - id: review
    tool: ${tool}
    prompt: Review the repository without changing it.
    output:
      ok: boolean`);
    expect((await runCLI(['pull'], repo)).code).toBe(0);
    const memberFile = path.join(os.homedir(), `.${tool}`, file);
    const before = fs.existsSync(memberFile) ? fs.readFileSync(memberFile, 'utf8') : undefined;
    fs.mkdirSync(path.dirname(memberFile), { recursive: true });
    fs.writeFileSync(memberFile, member);
    onTestFinished(() => (before === undefined ? fs.rmSync(memberFile, { force: true }) : fs.writeFileSync(memberFile, before)));
    if (tool === 'codex') codexOnPath(bin);
    writeDefinition(`toy${tool}seeded`, [{ use: 'toy', options: { state } }]);

    const ran = await runCLI(['workflow', 'start', `${tool}seeded`, '--driver', `toy${tool}seeded`], repo, env());

    const runId = runOf(ran);
    const [review] = readRunState(runId).steps;
    const homeFile = path.join(attemptDir(runId, attemptOf(review)), 'tool-home', tool, file);
    const text = fs.readFileSync(homeFile, 'utf8');
    expect(tool === 'claude' ? JSON.parse(text) : parseToml(text), ran.stderr).toEqual(seeded);
  });

  it('warns once that a runtime runs steps in full access on this machine, and records their isolation as none', async () => {
    writeFlow('worktreed', `  - id: review
    tool: claude
    prompt: Review the repository in a worktree.
    requires: { isolation: worktree }
    output:
      ok: boolean`);
    expect((await runCLI(['pull'], repo)).code).toBe(0);
    writeDefinition('toyfull', [{ use: 'toy', options: { state, can: { isolation: 'worktree' }, permissions: { claude: 'full-access' } } }]);

    const ran = await runCLI(['workflow', 'start', 'worktreed', '--driver', 'toyfull'], repo, env());

    const [review] = readRunState(runOf(ran)).steps;
    expect(review, ran.stderr).toMatchObject({ status: 'succeeded', unenforced: [{ requirement: 'isolation', asked: 'worktree', provided: 'none' }] });
    const warning = `Runtime toy of driver toyfull runs steps in full access on this machine, as drivers/toyfull.yaml in the team repo sets: they run without asking for permission, an unattended run approves the runtime's own full-access sign-in where it asks for one, and teamai cannot prove any isolation. Their isolation is recorded as none.`;
    expect(ran.stderr.split(warning).length - 1).toBe(1);
  });

  it.each([
    { reported: 'claude', status: 'succeeded' },
    { reported: 'codex', status: 'failed' },
  ])('runs a permissions: unattended step on claude only where the runtime reports full access for it, given $reported', async ({ reported, status }) => {
    writeFlow('unattendedfix', `  - id: fix
    tool: claude
    prompt: Fix the failing test.
    permissions: unattended
    requires: { isolation: sandbox, strict: true }
    output:
      ok: boolean`);
    expect((await runCLI(['pull'], repo)).code).toBe(0);
    writeDefinition('toyunattended', [{ use: 'toy', options: { state, can: { isolation: 'sandbox' }, permissions: { [reported]: 'full-access' } } }]);

    const ran = await runCLI(['workflow', 'start', 'unattendedfix', '--driver', 'toyunattended'], repo, env());

    const [fix] = readRunState(runOf(ran)).steps;
    expect(fix, ran.stderr).toMatchObject({ status });
  });

  it('refuses an agent\'s start that invoke denies before it opens any runtime of the definition', async () => {
    writeDefinition('toyonly', [{ use: 'toy', options: { state } }]);

    const ran = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'toyonly'], repo, env({ CLAUDE_CODE_SESSION_ID: 'agent-session-1' }));

    expect(envelope(ran)).toMatchObject({ error: { code: 'invoke_denied' } });
    // The toy notes every init it answers; none means no runtime process was started, so none signed in.
    expect(fs.existsSync(path.join(state, 'credentials.jsonl'))).toBe(false);
  });

  it('refuses a start its admission checks refuse before it opens any runtime of the definition', async () => {
    writeFlow('unsandboxedfix', `  - id: fix
    tool: claude
    prompt: Fix the failing test.
    permissions: unattended
    output:
      ok: boolean`);
    expect((await runCLI(['pull'], repo)).code).toBe(0);
    writeDefinition('toyrefused', [{ use: 'toy', options: { state } }]);

    const ran = await runCLI(['workflow', 'start', 'unsandboxedfix', '--driver', 'toyrefused'], repo, env());

    expect(envelope(ran), ran.stderr).toMatchObject({ error: { code: 'unattended_unsandboxed' } });
    // The toy notes every init it answers; none means no runtime process was started, so none signed in.
    expect(fs.existsSync(path.join(state, 'inits.jsonl'))).toBe(false);
  });

  it('closes again, once teamai removed a clone, on each runtime that ran a place in it, so the runtime sees it gone', async () => {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    writeFlow('cloned', `  - id: trial
    workspace: { clone: { commit: ${commit}, team: { treatment: none } } }
    workflow:
      steps:
        - id: edit
          workspace: continue
          command: node -e "require('fs').writeFileSync('clean.txt', 'C')"`);
    expect((await runCLI(['pull'], repo)).code).toBe(0);
    writeDefinition('toyclone', [{ use: 'toy', options: { state, can: { workspace: ['read-only', 'new', 'continue', 'clone'] } } }]);

    const ran = await runCLI(['workflow', 'start', 'cloned', '--driver', 'toyclone'], repo, env());

    expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const closes = fs.readFileSync(path.join(state, 'closes.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { handle: string; present?: boolean });
    const [first] = closes;
    expect(first).toMatchObject({ present: true });
    expect(closes.at(-1)).toEqual({ handle: first?.handle, present: false });
  });

  it('closes again, on a later drive whose start removes a clone a cancelled run left, the place the run\'s runtime ran in it', async () => {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    writeFlow('clonedhold', `  - id: trial
    workspace: { clone: { commit: ${commit}, team: { treatment: none } } }
    workflow:
      steps:
        - id: edit
          workspace: continue
          command: node -e "require('fs').writeFileSync(process.env.HOLD_MARK, '1'); setTimeout(() => {}, 120000)"`);
    expect((await runCLI(['pull'], repo)).code).toBe(0);
    writeDefinition('toyclonehold', [{ use: 'toy', options: { state, can: { workspace: ['read-only', 'new', 'continue', 'clone'] } } }]);
    const mark = path.join(state, 'hold-mark');
    const driving = spawn(process.execPath, [CLI, 'workflow', 'start', 'clonedhold', '--driver', 'toyclonehold'], { cwd: repo, env: { ...process.env, ...env({ HOLD_MARK: mark }), FORCE_COLOR: '0' }, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    driving.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const ended = new Promise((resolve) => driving.on('close', resolve));
    for (const deadline = Date.now() + 30_000; !fs.existsSync(mark) && Date.now() < deadline;) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fs.existsSync(mark), stderr).toBe(true);
    driving.kill('SIGKILL');
    await ended;
    const runId = /Run (r[0-9a-f]+) started/.exec(stderr)?.[1] ?? '';

    // The cancel stops the command and closes its place, with the clone still there; it removes no clone.
    const cancelled = await runCLI(['workflow', 'cancel', runId], repo, env());
    expect(envelope(cancelled), cancelled.stderr).toMatchObject({ data: { run: { id: runId } } });
    const closesOf = (): Array<{ handle: string; present?: boolean }> => fs.readFileSync(path.join(state, 'closes.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { handle: string; present?: boolean });
    const [closed] = closesOf();
    expect(closed).toMatchObject({ present: true });

    // Any later drive removes the clone at its start, and the runtime that ran in it hears of it at a close.
    const later = await runCLI(['workflow', 'start', 'mixed', '--driver', 'local'], repo, env());
    expect(envelope(later), later.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(closesOf()).toContainEqual({ handle: closed?.handle, present: false });
  });

  it('keeps what the runtime shows of the place in the attempt\'s record, for the run\'s details', async () => {
    const display = { label: 'toy place', url: 'https://runtimes.example.test/place/1', fields: { place: 'toy-1', image: 'warm:3f9c' } };
    writeDefinition('shown', [{ use: 'toy', options: { state, display } }]);

    const ran = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'shown'], repo, env());

    expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const runId = runOf(ran);
    const [review] = readRunState(runId).steps;
    expect(runtimeRecord(runId, attemptOf(review))).toMatchObject({ runtime: 'toy', phase: 'closed', display });
  });

  it('records a place its runtime could not close on the attempt, and says what may still run there', async () => {
    writeDefinition('unclosed', [{ use: 'toy', options: { state, close_fails: true } }]);

    const ran = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'unclosed'], repo, env());

    expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const runId = runOf(ran);
    const attempt = attemptOf(readRunState(runId).steps[0]);
    const handle = `toy-${runId}-${attempt}`;
    expect(runtimeRecord(runId, attempt)).toMatchObject({ phase: 'collected', closeFailed: { code: 'close_failed', message: `The toy keeps place ${handle}: close_fails is set.` } });
    expect(ran.stderr).toContain(`Step runtime "toy" could not close the place of attempt ${attempt}, so what ran there may still run (close_failed): The toy keeps place ${handle}: close_fails is set.`);
  });

  it('runs the commands of a runtime that cannot run a tool now, and fails a prompt step on that tool with the runtime\'s reason', async () => {
    const reason = 'claude is not signed in in the sandbox. Run sbx run claude <dir>, then /login.';
    writeDefinition('toolless', [{ use: 'toy', options: { state, unavailable: { claude: reason } } }]);

    const ran = await runCLI(['workflow', 'start', 'mixed', '--driver', 'toolless'], repo, env());

    const runId = runOf(ran);
    const [build, review] = readRunState(runId).steps;
    expect(build).toMatchObject({ id: 'build', status: 'succeeded', outputs: { built: true } });
    expect(review).toMatchObject({ id: 'review', status: 'failed', failure: { code: 'tool_unavailable', message: `Step "review" runs on claude, which the driver of this run cannot launch here: toy: ${reason} Or remove tool from the step.` } });
  });

  it('says which place teamai workflow cancel closed of a settled run, once the close an earlier one kept goes through', async () => {
    writeDefinition('closeslater', [{ use: 'toy', options: { state, close_fails: true } }]);
    const ran = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'closeslater'], repo, env());
    const runId = runOf(ran);
    const attempt = attemptOf(readRunState(runId).steps[0]);
    writeDefinition('closeslater', [{ use: 'toy', options: { state } }]);

    const cancelled = await runCLI(['workflow', 'cancel', runId], repo, env());

    // The run had settled; what this cancel did is the place it closed, not an error.
    expect(envelope(cancelled), cancelled.stderr).toEqual({ data: { run: { id: runId, status: 'succeeded' }, closed: [attempt] } });
    expect(cancelled.code).toBe(0);
    expect(cancelled.stderr).toContain(`Closed the place of attempt ${attempt} of run ${runId} on step runtime "toy", which an earlier close had kept.`);
    expect(runtimeRecord(runId, attempt)).toMatchObject({ phase: 'closed' });
  });

  it('finds a run whose checkout folder was removed, so cancel closes the place its runtime kept and retry answers for its step', async () => {
    writeDefinition('goneplace', [{ use: 'toy', options: { state, close_fails: true } }]);
    // A run started in a folder of the checkout that is gone by the time the person cancels it.
    const checkout = path.join(repo, `gone-${path.basename(state)}`);
    fs.mkdirSync(checkout);
    const ran = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'goneplace'], checkout, env());
    const runId = runOf(ran);
    const attempt = attemptOf(readRunState(runId).steps[0]);
    writeDefinition('goneplace', [{ use: 'toy', options: { state } }]);
    fs.rmSync(checkout, { recursive: true });

    const cancelled = await runCLI(['workflow', 'cancel', runId], repo, env());

    expect(envelope(cancelled), cancelled.stderr).toEqual({ data: { run: { id: runId, status: 'succeeded' }, closed: [attempt] } });
    expect(runtimeRecord(runId, attempt)).toMatchObject({ phase: 'closed' });

    // Retry finds the run too: it answers for the step, which succeeded, not that the run's config cannot be read.
    const retried = await runCLI(['workflow', 'retry', runId, 'review'], repo, env());

    expect(envelope(retried), retried.stderr).toMatchObject({ error: { code: 'not_retryable' } });
  });

  it('records why each runtime holds a step back, which the run\'s details show once the driver stops', async () => {
    setMemberWorkflows({ allow: { network: false } });
    writeDefinition('both', [{ use: 'toy', options: { state } }, { use: 'local' }]);
    const runsDir = path.join(dataHome, 'workflows', 'runs');
    const before = new Set(fs.existsSync(runsDir) ? fs.readdirSync(runsDir) : []);

    const ran = await runCLI(['workflow', 'start', 'online', '--driver', 'both'], repo, env());

    expect(envelope(ran), ran.stderr).toMatchObject({ error: { code: 'busy' } });
    const [runId] = fs.readdirSync(runsDir).filter((name) => !before.has(name) && name.endsWith('.json')).map((name) => name.slice(0, -'.json'.length));
    const reason = 'step "fetch" needs network, which workflows.allow in local config does not allow on this machine';
    expect(JSON.parse(fs.readFileSync(path.join(runsDir, String(runId), 'held.json'), 'utf8'))).toEqual({
      driver: 'both',
      runtimes: [{ runtime: 'toy', held: [{ step: 'fetch', reason }] }, { runtime: 'local', held: [{ step: 'fetch', reason }] }],
    });
    expect(toyOpens()).toBe(0);
  });

  describe('a runtime that launches agents its own way', () => {
    const runIds = (): Set<string> => new Set((fs.existsSync(path.join(dataHome, 'workflows', 'runs')) ? fs.readdirSync(path.join(dataHome, 'workflows', 'runs')) : []).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -'.json'.length)));

    type PromptLine = { op: string; sent?: { step: string; tool: string; prompt: string; result: string; permissions: string; model?: { name: string }; maxTurns?: number; resume?: string }; env?: string[]; provided?: string[]; ended?: string };

    /** What the toy logged of the prompts it was sent: each send, and how each ended. */
    const promptLog = (): PromptLine[] => (fs.existsSync(path.join(state, 'prompts.jsonl'))
      ? fs.readFileSync(path.join(state, 'prompts.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as PromptLine)
      : []);

    const sends = (): PromptLine[] => promptLog().filter((line) => line.sent !== undefined);

    const endings = (): Array<[string, string | undefined]> => promptLog().filter((line) => line.ended !== undefined).map((line) => [line.op, line.ended]);

    const startKilled = async (args: string[]): Promise<{ child: ReturnType<typeof spawn>; ended: Promise<Ran> }> => {
      const child = spawn(process.execPath, [CLI, ...args], { cwd: repo, env: { ...process.env, ...env(), FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      const ended = new Promise<Ran>((resolve) => child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr })));
      return { child, ended };
    };

    const until = async (check: () => boolean, ms = 30_000): Promise<void> => {
      for (const deadline = Date.now() + ms; !check() && Date.now() < deadline;) await new Promise((resolve) => setTimeout(resolve, 50));
      expect(check()).toBe(true);
    };

    it('sends a prompt step as one prompt, reports its session, output and usage, and runs the command step on the next runtime', async () => {
      writeDefinition('agentd', [{ use: 'toy', options: { state, agent: { output: { ok: true }, usage: { input: 40, output: 12 } } } }, { use: 'local' }]);

      const ran = await runCLI(['workflow', 'start', 'mixed', '--driver', 'agentd'], repo, env());

      expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      const runId = runOf(ran);
      const [build, review] = readRunState(runId).steps;
      // The command ran on local: the toy runs none, so it has no record of it.
      expect(build).toMatchObject({ id: 'build', status: 'succeeded', outputs: { built: true } });
      expect(runtimeRecord(runId, attemptOf(build))).toEqual({ runtime: 'host', driver: 'agentd', inProcess: true });
      // The prompt went to the toy as a prompt, with teamai's result instruction; no tool was launched here.
      const [sent] = sends();
      expect(sends()).toHaveLength(1);
      expect(sent?.sent).toMatchObject({ step: 'review', tool: 'claude', permissions: 'approval-required', result: path.join(attemptDir(runId, attemptOf(review)), 'out', 'result.json') });
      expect(sent?.sent?.prompt).toContain('Review the repository without changing it.');
      expect(sent?.sent?.prompt).toContain(`Write the workflow result as JSON to ${sent?.sent?.result}`);
      // The step's declared output, as JSON Schema, once.
      expect(sent?.sent?.prompt.split('JSON Schema: `{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"]}`')).toHaveLength(2);
      expect(review).toMatchObject({ id: 'review', status: 'succeeded', tool: 'claude', session: `toy-session-${sent?.op.slice(3)}`, outputs: { ok: true }, tokens: { input: 40, output: 12 } });
      expect(runtimeRecord(runId, attemptOf(review))).toMatchObject({ runtime: 'toy', phase: 'closed', prompt: { op: sent?.op } });
      expect(fs.existsSync(launches)).toBe(false);
    });

    it('names which of a prompt\'s env the team provides, apart from the attempt\'s markers', async () => {
      const secrets = path.join(repo, '.teamai', 'env', 'secrets.yaml');
      fs.mkdirSync(path.dirname(secrets), { recursive: true });
      fs.writeFileSync(secrets, 'secrets:\n  - key: WORKFLOW_TEAM_TOKEN\n');
      // The other tests share this repository: they run without the team's secret.
      onTestFinished(async () => {
        fs.rmSync(secrets);
        await runCLI(['pull'], repo);
      });
      writeFlow('teamenv', `  - id: review
    prompt: Review the repository with the team's token.
    requires: { env: [WORKFLOW_TEAM_TOKEN] }
    output:
      ok: boolean`);
      expect((await runCLI(['pull'], repo)).code).toBe(0);
      writeDefinition('agentenv', [{ use: 'toy', options: { state, agent: { output: { ok: true } } } }]);

      const ran = await runCLI(['workflow', 'start', 'teamenv', '--driver', 'agentenv'], repo, env({ WORKFLOW_TEAM_TOKEN: 'team-test-token' }));

      expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      const [sent] = sends();
      // A runtime that keeps env in plain text can drop the team's value and keep the rest.
      expect(sent?.env).toEqual(expect.arrayContaining(['TEAMAI_RUN_DIR', 'TEAMAI_WORKFLOW_ATTEMPT', 'WORKFLOW_TEAM_TOKEN']));
      expect(sent?.provided).toEqual(['WORKFLOW_TEAM_TOKEN']);
    });

    it.each([
      { given: 'the runtime\'s default over the member\'s', args: [], tool: 'claude' },
      { given: '--tools default= over the runtime\'s default', args: ['--tools', 'default=codex'], tool: 'codex' },
    ])('runs a step that names no tool, in a definition that names none, on $given', async ({ args, tool }) => {
      writeFlow('notool', `  - id: review
    prompt: Review the repository without changing it.
    output:
      ok: boolean`);
      expect((await runCLI(['pull'], repo)).code).toBe(0);
      const dir = path.join(repo, '.teamai', 'drivers');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'appdefault.yaml'), stringify({ schemaVersion: 'v1alpha1', name: 'appdefault', runtimes: [{ use: 'toy', options: { state, agent: { output: { ok: true } }, can: { default_tool: 'claude' } } }] }));

      const ran = await runCLI(['workflow', 'start', 'notool', '--driver', 'appdefault', ...args], repo, env({ TEAMAI_AI_TOOL: 'codex' }));

      expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      expect(sends().at(-1)?.sent).toMatchObject({ step: 'review', tool });
    });

    it('fails a step that names no tool, where no runtime default and no tool of the member is set, naming where to set one', async () => {
      writeFlow('notoolset', `  - id: review
    prompt: Review the repository without changing it.
    output:
      ok: boolean`);
      expect((await runCLI(['pull'], repo)).code).toBe(0);
      const dir = path.join(repo, '.teamai', 'drivers');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'nodefault.yaml'), stringify({ schemaVersion: 'v1alpha1', name: 'nodefault', runtimes: [{ use: 'toy', options: { state, agent: { output: { ok: true } } } }] }));
      const before = sends().length;
      // init --agent claude named the member's tool in the install's config; this member names none.
      const installConfig = path.join(dataHome, 'config.yaml');
      const { ai: _named, ...unnamed } = parse(fs.readFileSync(installConfig, 'utf8')) as Record<string, unknown>;
      fs.writeFileSync(installConfig, stringify(unnamed));

      const ran = await runCLI(['workflow', 'start', 'notoolset', '--driver', 'nodefault'], repo, env({ TEAMAI_AI_TOOL: '' }));

      const review = readRunState(runOf(ran)).steps.find((step) => step.id === 'review');
      expect(review).toMatchObject({ status: 'failed', failure: { code: 'tool_unconfigured', message: expect.stringContaining('Name one with the step\'s tool:, with --tools default=<tool>, or with ai.tool in your teamai config') } });
      expect(sends()).toHaveLength(before);
    });

    it('masks the team\'s secret a runtime echoes in a notice, as it masks the step\'s other output', async () => {
      const secrets = path.join(repo, '.teamai', 'env', 'secrets.yaml');
      fs.mkdirSync(path.dirname(secrets), { recursive: true });
      fs.writeFileSync(secrets, 'secrets:\n  - key: WORKFLOW_NOTICE_TOKEN\n');
      // The other tests share this repository: they run without the team's secret.
      onTestFinished(async () => {
        fs.rmSync(secrets);
        await runCLI(['pull'], repo);
      });
      writeFlow('teamnotice', `  - id: review
    prompt: Review the repository with the team's token.
    requires: { env: [WORKFLOW_NOTICE_TOKEN] }
    output:
      ok: boolean`);
      expect((await runCLI(['pull'], repo)).code).toBe(0);
      writeDefinition('agentnotice', [{ use: 'toy', options: { state, agent: { output: { ok: true } }, notice: { prompt: 'Signed in with {WORKFLOW_NOTICE_TOKEN}.' } } }]);

      const ran = await runCLI(['workflow', 'start', 'teamnotice', '--driver', 'agentnotice'], repo, env({ WORKFLOW_NOTICE_TOKEN: 'team-notice-value-5c1e' }));

      expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      expect(ran.stderr).toMatch(/Step runtime "toy", operation op-[0-9a-f]+: Signed in with <REDACTED:WORKFLOW_NOTICE_TOKEN>\./);
      expect(ran.stderr).not.toContain('team-notice-value-5c1e');
    });

    it('links no session a runtime started fresh to the one its step asked to resume', async () => {
      writeFlow('followed', `  - id: review
    prompt: Review the repository without changing it.
    output:
      ok: boolean
  - id: followup
    needs: [review]
    session: { from: review }
    prompt: Follow up on the review.
    output:
      ok: boolean`);
      expect((await runCLI(['pull'], repo)).code).toBe(0);
      writeDefinition('agentfresh', [{ use: 'toy', options: { state, agent: { output: { ok: true }, resumes: false, transcript: true } } }]);

      const ran = await runCLI(['workflow', 'start', 'followed', '--driver', 'agentfresh'], repo, env());

      expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      const stored = readRunState(runOf(ran));
      const [review, followup] = stored.steps.map((step) => ('session' in step ? step.session : undefined));
      // The toy was asked to resume the review's session, said nothing of it, and ran a new one.
      expect(sends()[1]?.sent).toMatchObject({ step: 'followup', resume: review });
      expect(followup).toEqual(expect.any(String));
      expect(followup).not.toBe(review);
      expect(stored.sessionContinuations).toBeUndefined();
    });

    it('runs a prompt step with setup on the next runtime, since setup is a command, even when the first claims setup', async () => {
      writeDefinition('agentsetup', [{ use: 'toy', options: { state, can: { setup: true }, agent: { output: { ok: true } } } }, { use: 'local' }]);

      const ran = await runCLI(['workflow', 'start', 'setupflow', '--driver', 'agentsetup'], repo, env());

      expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      const [review] = readRunState(runOf(ran)).steps;
      expect(review).toMatchObject({ id: 'review', status: 'succeeded', outputs: { ok: true } });
      // The toy was sent nothing; the fake Claude ran the prompt on local.
      expect(sends()).toEqual([]);
      expect(fs.readFileSync(launches, 'utf8').trim().split('\n')).toHaveLength(1);
    });

    it('sends an interactive step as a prompt a person works in, to a runtime that offers hitl', async () => {
      writeDefinition('agentpair', [{ use: 'toy', options: { state, can: { hitl: true }, agent: { output: { ok: true } } } }, { use: 'local' }]);

      const ran = await runCLI(['workflow', 'start', 'pairwork', '--driver', 'agentpair'], repo, env({ TEAMAI_MODE: 'attended' }));

      expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      expect(sends()).toEqual([expect.objectContaining({ sent: expect.objectContaining({ step: 'design', interactive: true }) })]);
      expect(fs.existsSync(launches)).toBe(false);
    });

    it('sends the step\'s turn cap to a runtime that offers max_turns, on any tool', async () => {
      writeDefinition('agentcap', [{ use: 'toy', options: { state, can: { max_turns: true }, agent: { output: { ok: true } } } }], { tool: 'codex' });

      const ran = await runCLI(['workflow', 'start', 'capped', '--driver', 'agentcap'], repo, env());

      expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      expect(sends()).toEqual([expect.objectContaining({ sent: expect.objectContaining({ tool: 'codex', maxTurns: 3 }) })]);
      expect(readRunState(runOf(ran)).steps[0]).not.toHaveProperty('unenforced');
    });

    it('sends the model of the step\'s agent definition, since no --agent flag carries it', async () => {
      writeDefinition('agentmodel', [{ use: 'toy', options: { state, agent: { output: { ok: true } } } }]);

      const ran = await runCLI(['workflow', 'start', 'agented', '--driver', 'agentmodel'], repo, env());

      expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      const [sent] = sends();
      expect(sent?.sent).toMatchObject({ tool: 'claude', model: { name: 'claude-sonnet-4-6' } });
      expect(sent?.sent?.prompt).toContain('Follow the review checklist.');
    });

    it('refuses at start a runtime that runs no command and takes no prompt, since it can run no step', async () => {
      writeDefinition('stepless', [{ use: 'toy', options: { state, can: { exec: false } } }, { use: 'local' }]);

      const ran = await runCLI(['workflow', 'start', 'mixed', '--driver', 'stepless'], repo, env());

      expect(envelope(ran)).toMatchObject({ error: { code: 'runtime_failed', message: expect.stringContaining('Runtime "toy" of driver "stepless" runs no command and takes no prompt') } });
      expect(sends()).toEqual([]);
    });

    it('refuses at start a runtime whose marker says it runs no command while its init offers commands', async () => {
      const manifest = path.join(os.homedir(), '.teamai', 'runtimes', 'toy', 'RUNTIME.yaml');
      fs.writeFileSync(manifest, `${TOY_RUNTIME_MARKER}exec: false\n`);
      onTestFinished(() => fs.writeFileSync(manifest, TOY_RUNTIME_MARKER));
      writeDefinition('toymislabeled', [{ use: 'toy', options: { state } }, { use: 'local' }]);

      const ran = await runCLI(['workflow', 'start', 'mixed', '--driver', 'toymislabeled'], repo, env());

      expect(envelope(ran)).toMatchObject({ error: { code: 'runtime_failed', message: expect.stringContaining(`Runtime "toy" of driver "toymislabeled" declares exec: false in ${manifest}, but its init does not offer can.exec: false, so it runs commands`) } });
      expect(sends()).toEqual([]);
    });

    it('refuses at start a login on a runtime that launches agents its own way', async () => {
      writeDefinition('agentlogin', [{ use: 'toy', options: { state, credentials: { codex: 'login' }, agent: { output: { ok: true } } } }], { tool: 'codex' });

      const ran = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'agentlogin'], repo, env());

      expect(envelope(ran)).toMatchObject({ error: { code: 'bad_option', message: expect.stringContaining('toy launches agents its own way, in each tool\'s own home, so it brings no login') } });
      expect(sends()).toEqual([]);
    });

    it('reads a session from the home the runtime reports for it, for scoring and the next pass\'s resume, and names the tool in open', async () => {
      writeFlow('homed', `  - id: review
    prompt: Review the repository without changing it.
    scorers: [quality]
    output:
      ok: boolean
  - id: followup
    needs: [review]
    session: { from: review }
    prompt: Follow up on the review.
    output:
      ok: boolean`);
      expect((await runCLI(['pull'], repo)).code).toBe(0);
      // A Claude home of the runtime's own, as a T3 provider instance keeps, apart from the member's ~/.claude.
      const home = path.join(sandbox, 'instance-claude-home');
      writeDefinition('agenthome', [{ use: 'toy', options: { state, agent: { output: { ok: true }, transcript: true, home } } }]);

      const ran = await runCLI(['workflow', 'start', 'homed', '--driver', 'agenthome'], repo, env());

      expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      const runId = runOf(ran);
      const [review] = readRunState(runId).steps;
      const session = 'session' in (review ?? {}) ? (review as { session?: string }).session : undefined;
      expect(runtimeRecord(runId, attemptOf(review))).toMatchObject({ sessionHome: { tool: 'claude', dir: home } });
      // The next pass found the review's session where the runtime keeps it, so it asked the runtime to continue it.
      expect(sends()[1]?.sent).toMatchObject({ step: 'followup', resume: session });
      expect(ran.stderr).not.toContain('starts a new claude session');
      // Each place was opened naming the tool its prompt runs.
      const opens = fs.readdirSync(path.join(state, 'ops')).map((name) => JSON.parse(fs.readFileSync(path.join(state, 'ops', name), 'utf8')) as { kind: string; tool?: string | null })
        .filter((op) => op.kind === 'open');
      expect(opens.map((op) => op.tool)).toEqual(['claude', 'claude']);

      const scored = await runCLI(['score', '--run', runId, '--step', 'review', '--scorer', 'quality'], repo, env());

      expect(envelope(scored), scored.stderr).toMatchObject({ data: { label: { scorer: 'quality', label: 'good' } } });
    });

    it('reads a session of an instance from the home the runtime reports for it, for scoring, the next pass\'s resume and the session archive', async () => {
      acmeInstance();
      writeFlow('homedacme', `  - id: review
    prompt: Review the repository without changing it.
    scorers: [quality]
    output:
      ok: boolean
  - id: followup
    needs: [review]
    session: { from: review }
    prompt: Follow up on the review.
    output:
      ok: boolean`);
      expect((await runCLI(['pull'], repo)).code).toBe(0);
      const home = path.join(sandbox, 'acme-provider-home');
      writeDefinition('agentacmehome', [{ use: 'toy', options: { state, can: { tools: ['claude', 'acme-claude'] }, agent: { output: { ok: true }, transcript: true, home } } }]);

      const ran = await runCLI(['workflow', 'start', 'homedacme', '--driver', 'agentacmehome', '--tools', 'default=acme-claude'], repo, env());

      expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      const runId = runOf(ran);
      const [review] = readRunState(runId).steps;
      const session = 'session' in (review ?? {}) ? (review as { session?: string }).session : undefined;
      expect(runtimeRecord(runId, attemptOf(review))).toMatchObject({ sessionHome: { tool: 'acme-claude', dir: home } });
      expect(sends()[1]?.sent).toMatchObject({ step: 'followup', tool: 'acme-claude', resume: session });
      expect(ran.stderr).not.toContain('could not read this session');

      const scored = await runCLI(['score', '--run', runId, '--step', 'review', '--scorer', 'quality'], repo, env());

      expect(envelope(scored), scored.stderr).toMatchObject({ data: { label: { scorer: 'quality', label: 'good' } } });
    });

    it('reads a session whose runtime reports no home in the tool\'s default home, not in the one the member moved theirs to', async () => {
      writeDefinition('agentdefaulthome', [{ use: 'toy', options: { state, agent: { output: { ok: true } } } }]);

      const ran = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'agentdefaulthome'], repo, env({ CLAUDE_CONFIG_DIR: path.join(sandbox, 'member-claude') }));

      expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      const runId = runOf(ran);
      const [review] = readRunState(runId).steps;
      expect(runtimeRecord(runId, attemptOf(review))).toMatchObject({ sessionHome: { tool: 'claude', dir: path.join(os.homedir(), '.claude') } });
    });

    it('offers the run of a prompt whose tool hit a usage limit past the wait, with the step pending and the text the runtime gave', async () => {
      const resets = Math.ceil(Date.now() / 1000) + 3 * 24 * 3600;
      writeDefinition('agentlimit', [{ use: 'toy', options: { state, agent: { fail: { code: 'usage_limited', message: `claude hit its usage limit: Claude AI usage limit reached|${resets}` } } } }]);

      const ran = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'agentlimit'], repo, env());

      const runId = offeredRunOf(ran);
      expect(ran.stderr).toContain(`Step "review" stopped: claude hit its usage limit: Claude AI usage limit reached|${resets}. teamai launches no more steps on claude until its limit resets, then runs the step again.`);
      expect(readRunState(runId).steps).toMatchObject([{ id: 'review', status: 'pending' }]);
    });

    it('ends the failure of a prompt whose runtime restarted under it with the retry to run', async () => {
      writeDefinition('agentrestart', [{ use: 'toy', options: { state, agent: { fail: { code: 'daemon_restarted', message: 'The daemon stopped while the claude agent worked. Its work is kept in the worktree.' } } } }]);

      const ran = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'agentrestart'], repo, env());

      const runId = runOf(ran);
      const [review] = readRunState(runId).steps;
      expect(review, ran.stderr).toMatchObject({
        status: 'failed',
        failure: { code: 'runtime_failed', message: `The step runtime could not run the prompt (daemon_restarted): The daemon stopped while the claude agent worked. Its work is kept in the worktree. Then run: teamai workflow retry ${runId} review` },
      });
    });

    it('fails the step with the failure the agent wrote, without the prompt it quotes', async () => {
      const result = { failure: { code: 'tool_failed', message: 'Gave up on: Review the repository without changing it.' } };
      writeDefinition('agentfail', [{ use: 'toy', options: { state, agent: { result } } }]);

      const ran = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'agentfail'], repo, env());

      expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'failed' } } });
      const [review] = readRunState(runOf(ran)).steps;
      expect(review).toMatchObject({ status: 'failed', failure: { code: 'tool_failed', message: 'Gave up on: [prompt omitted]' } });
    });

    it('runs a command step on the host and the prompt on the toy when the definition\'s only runtime runs no command', async () => {
      writeDefinition('agentonly', [{ use: 'toy', options: { state, agent: { output: { ok: true } } } }]);

      const ran = await runCLI(['workflow', 'start', 'mixed', '--driver', 'agentonly'], repo, env());

      expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      const runId = runOf(ran);
      const [build, review] = readRunState(runId).steps;
      // The host command slot ran the command: no step runtime has a record of it, and no tool was launched here.
      expect(build).toMatchObject({ id: 'build', status: 'succeeded', outputs: { built: true } });
      expect(runtimeRecord(runId, attemptOf(build))).toEqual({ runtime: 'host', driver: 'agentonly', inProcess: true });
      expect(review).toMatchObject({ id: 'review', status: 'succeeded', outputs: { ok: true } });
      expect(runtimeRecord(runId, attemptOf(review))).toMatchObject({ runtime: 'toy', phase: 'closed' });
      expect(sends()).toEqual([expect.objectContaining({ sent: expect.objectContaining({ step: 'review' }) })]);
      expect(fs.existsSync(launches)).toBe(false);
    });

    it('answers an answer step on this host with the member\'s tool, even when the runtime runs no tool, and sends the runtime no prompt', async () => {
      writeDefinition('agentanswer', [{ use: 'toy', options: { state, can: { tools: [] }, agent: { output: { ok: true } } } }]);
      writeFlow('asks', `  - id: ask
    answer: Name one risk in this repository.
    output:
      text: string`);
      await runCLI(['pull'], repo);

      const ran = await runCLI(['workflow', 'start', 'asks', '--driver', 'agentanswer'], repo, env({ TEAMAI_AI_TOOL: 'claude', FAKE_TOOL_REPLY: 'Unpinned dependencies.' }));

      expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      const runId = runOf(ran);
      const [ask] = readRunState(runId).steps;
      expect(ask).toMatchObject({ id: 'ask', status: 'succeeded', outputs: { text: 'Unpinned dependencies.' } });
      expect(runtimeRecord(runId, attemptOf(ask))).toEqual({ runtime: 'host', driver: 'agentanswer', inProcess: true });
      expect(sends()).toEqual([]);
    });

    it('reports the session, output and usage of a prompt that finished while teamai was killed, without sending a new one', async () => {
      writeDefinition('agentdie', [{ use: 'toy', options: { state, die_at: 'prompt-finished', agent: { output: { ok: true }, usage: { input: 7 } } } }]);

      const before = runIds();
      const killed = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'agentdie'], repo, env());
      expect(killed.signal, killed.stderr).toBe('SIGKILL');
      const [sent] = sends();
      expect(endings()).toEqual([[sent?.op, 'finished']]);
      const runId = [...runIds()].find((id) => !before.has(id));

      const resumed = await runCLI(['workflow', 'resume', String(runId), '--driver', 'agentdie'], repo, env());

      expect(envelope(resumed), resumed.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      const [review] = readRunState(String(runId)).steps;
      expect(review).toMatchObject({ status: 'succeeded', session: `toy-session-${sent?.op.slice(3)}`, outputs: { ok: true }, tokens: { input: 7 } });
      // The resumed teamai read the outcome the toy kept: it sent no prompt again.
      expect(sends().map((line) => line.op)).toEqual([sent?.op]);
    });

    it('ends a prompt that finished stopped at its budget while teamai was killed at that limit, on the outcome the runtime kept', async () => {
      writeDefinition('budgetdie', [{ use: 'toy', options: { state, die_at: 'prompt-finished', can: { end_turn: true }, agent: { output: { ok: true }, usage: { input: 7 }, stopped: 'budget' } } }]);

      const before = runIds();
      const killed = await runCLI(['workflow', 'start', 'budgeted', '--driver', 'budgetdie'], repo, env());
      expect(killed.signal, killed.stderr).toBe('SIGKILL');
      const runId = [...runIds()].find((id) => !before.has(id));

      const resumed = await runCLI(['workflow', 'resume', String(runId), '--driver', 'budgetdie'], repo, env());

      expect(envelope(resumed), resumed.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      expect(readRunState(String(runId)).steps).toMatchObject([{ id: 'review', status: 'succeeded', limit: 'budget', tokens: { input: 7 } }]);
    });

    it('reconnects to a prompt still running when teamai was killed, and reports it once its agent finishes', async () => {
      const release = path.join(state, 'release');
      writeDefinition('agentwait', [{ use: 'toy', options: { state, agent: { release, output: { ok: true } } } }]);
      const before = runIds();
      const first = await startKilled(['workflow', 'start', 'oneprompt', '--driver', 'agentwait']);
      await until(() => sends().length === 1);
      first.child.kill('SIGKILL');
      expect((await first.ended).signal).toBe('SIGKILL');
      const runId = [...runIds()].find((id) => !before.has(id));
      const [sent] = sends();

      const resumed = await startKilled(['workflow', 'resume', String(runId), '--driver', 'agentwait']);
      // The resumed teamai sends the same operation again, which reconnects to the agent instead of starting one.
      await until(() => sends().length === 2);
      fs.writeFileSync(release, '');
      const ended = await resumed.ended;

      expect(envelope(ended), ended.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      const [review] = readRunState(String(runId)).steps;
      expect(review).toMatchObject({ status: 'succeeded', session: `toy-session-${sent?.op.slice(3)}`, outputs: { ok: true } });
      expect(sends().map((line) => line.op)).toEqual([sent?.op, sent?.op]);
      expect(endings()).toEqual([[sent?.op, 'finished']]);
    });

    it('stops, through the driver recorded for it, a prompt a killed teamai left running when the run resumes on a driver without that runtime, then runs the step there', async () => {
      const release = path.join(state, 'release-never');
      writeDefinition('agentmoved', [{ use: 'toy', options: { state, agent: { release, output: { ok: true } } } }]);
      const before = runIds();
      const first = await startKilled(['workflow', 'start', 'oneprompt', '--driver', 'agentmoved']);
      await until(() => sends().length === 1);
      first.child.kill('SIGKILL');
      expect((await first.ended).signal).toBe('SIGKILL');
      const runId = String([...runIds()].find((id) => !before.has(id)));
      const [sent] = sends();

      const resumed = await runCLI(['workflow', 'resume', runId, '--driver', 'local'], repo, env());

      const [review] = readRunState(runId).steps;
      expect(review, resumed.stderr).toMatchObject({ status: 'succeeded' });
      expect(resumed.stderr).toContain(`Stopped attempt ${attemptOf(review)} of run ${runId} on step runtime "toy" and closed its place.`);
      // The toy's agent was told to stop, and its place closed, before the step ran again on this machine; no prompt went again.
      expect(fs.existsSync(path.join(state, 'cancel', String(sent?.op)))).toBe(true);
      expect(fs.readFileSync(path.join(state, 'closes.jsonl'), 'utf8')).toContain(`"handle":"toy-${runId}-${attemptOf(review)}"`);
      expect(sends()).toHaveLength(1);
    });

    it.each([
      { closes: true, case: 'closes the place as it offers the run' },
      { closes: false, case: 'offers nothing while the place cannot be closed, so the run stays here with it' },
    ])('publishing a run its teamai stopped with a place held for a conversation $case', async ({ closes: isClosable }) => {
      const waiting = path.join(state, 'waiting');
      writeDefinition('heldpub', [{ use: 'toy', options: { state, ...(!isClosable && { close_fails: true }), agent: { release: path.join(state, 'release-{step}'), output: { ok: true } } } }, { use: 'local' }]);
      writeFlow('heldpair', `  - id: change
    workspace: new
    workflow:
      steps:
        - id: one
          prompt: Plan the change.
          output:
            ok: boolean
        - id: pause
          needs: [one]
          command: node -e "require('fs').writeFileSync(process.argv[1], ''); setTimeout(() => {}, 60000)" ${JSON.stringify(waiting)}
        - id: two
          needs: [pause]
          session:
            from: one
          prompt: Make the change you planned.
          output:
            ok: boolean`);
      fs.writeFileSync(path.join(state, 'release-change.one'), '');
      expect((await runCLI(['pull'], repo)).code).toBe(0);
      const before = runIds();
      const first = await startKilled(['workflow', 'start', 'heldpair', '--driver', 'heldpub']);
      await until(() => fs.existsSync(waiting));
      // Ctrl-C while the command between the two prompts runs: step one's place stays held for step two.
      first.child.kill('SIGINT');
      await first.ended;
      const runId = String([...runIds()].find((id) => !before.has(id)));
      const one = attemptOf(readRunState(runId).steps.find((step) => step.id === 'change.one'));
      const closes = (): string => (fs.existsSync(path.join(state, 'closes.jsonl')) ? fs.readFileSync(path.join(state, 'closes.jsonl'), 'utf8') : '');
      expect(runtimeRecord(runId, one)).toMatchObject({ heldFor: { conversation: { tool: 'claude' } } });
      expect(closes()).not.toContain(`"handle":"toy-${runId}-${one}"`);
      // A run's branches reach its origin before it is published, as a member pushes them.
      execFileSync('git', ['push', '-q', 'origin', `refs/heads/teamai/${runId}/*:refs/heads/teamai/${runId}/*`], { cwd: repo });

      const published = await runCLI(['workflow', 'publish', runId], repo, env());

      if (isClosable) {
        expect(envelope(published), published.stderr).toMatchObject({ data: { run: runId, offered: true } });
        expect(closes()).toContain(`"handle":"toy-${runId}-${one}"`);
        expect(runtimeRecord(runId, one)).toMatchObject({ phase: 'closed' });
        return;
      }

      expect(envelope(published), published.stderr).toMatchObject({ error: { code: 'place_kept', message: expect.stringContaining(`attempt ${one}`) } });
      expect(runtimeRecord(runId, one)).toMatchObject({ heldFor: { conversation: { tool: 'claude' } } });
      expect(runtimeRecord(runId, one)).not.toMatchObject({ phase: 'closed' });
      // teamai-reports holds no state of the run, so no other machine can claim it.
      expect(spawnSync('git', ['ls-tree', '-r', '--name-only', 'teamai-reports'], { cwd: path.join(sandbox, 'origin.git'), encoding: 'utf8' }).stdout).not.toContain(`workflows/runs/${runId}/state.json`);
    });

    it('keeps the display the runtime gives with the prompt\'s acceptance while the prompt runs, for the run\'s details', async () => {
      const release = path.join(state, 'release');
      const display = { label: 'Review the repository', url: 'paseo://agent/9f2c', fields: { agent: 'claude', mode: 'default' } };
      writeDefinition('agentshown', [{ use: 'toy', options: { state, display: { label: 'workspace' }, agent: { release, output: { ok: true }, display } } }]);
      const before = runIds();
      const running = await startKilled(['workflow', 'start', 'oneprompt', '--driver', 'agentshown']);
      await until(() => sends().length === 1);
      const runId = [...runIds()].find((id) => !before.has(id)) ?? '';
      const attempt = (): string => attemptOf(readRunState(runId).steps[0]);

      await until(() => JSON.stringify(runtimeRecord(runId, attempt())?.display) === JSON.stringify(display));
      expect(runtimeRecord(runId, attempt())).toMatchObject({ phase: 'running', display });
      fs.writeFileSync(release, '');
      const ended = await running.ended;

      expect(envelope(ended), ended.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      expect(runtimeRecord(runId, attempt())).toMatchObject({ phase: 'closed', display });
    });

    it('keeps the display a runtime sends after it accepted the prompt, for the run\'s details', async () => {
      const release = path.join(state, 'release');
      const display = { label: 'Review the repository', url: 't3://thread/5e1c', fields: { agent: 'claude' } };
      writeDefinition('agentlater', [{ use: 'toy', options: { state, display: { label: 'workspace' }, agent: { release, output: { ok: true }, display, display_after_ms: 200 } } }]);
      const before = runIds();
      const running = await startKilled(['workflow', 'start', 'oneprompt', '--driver', 'agentlater']);
      await until(() => sends().length === 1);
      const runId = [...runIds()].find((id) => !before.has(id)) ?? '';
      const attempt = (): string => attemptOf(readRunState(runId).steps[0]);

      await until(() => JSON.stringify(runtimeRecord(runId, attempt())?.display) === JSON.stringify(display));
      expect(runtimeRecord(runId, attempt())).toMatchObject({ phase: 'running', display });
      fs.writeFileSync(release, '');
      const ended = await running.ended;

      expect(envelope(ended), ended.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      expect(runtimeRecord(runId, attempt())).toMatchObject({ phase: 'closed', display });
    });

    it('cancels a running prompt when teamai workflow cancel stops its run', async () => {
      const release = path.join(state, 'release');
      writeDefinition('agentcancel', [{ use: 'toy', options: { state, agent: { release, output: { ok: true } } } }]);
      const before = runIds();
      const running = await startKilled(['workflow', 'start', 'oneprompt', '--driver', 'agentcancel']);
      await until(() => sends().length === 1);
      const runId = [...runIds()].find((id) => !before.has(id));

      const cancelled = await runCLI(['workflow', 'cancel', String(runId)], repo, env());
      expect(cancelled.code, cancelled.stderr).toBe(0);

      const ended = await running.ended;
      expect(envelope(ended), ended.stderr).toMatchObject({ data: { done: { outcome: 'cancelled' } } });
      expect(endings()).toEqual([[sends()[0]?.op, 'cancelled']]);
    });

    it('keeps the place of a running prompt open when its runtime refuses the cancel of a driver that still runs', async () => {
      const release = path.join(state, 'release');
      const stuck = { code: 'cancel_failed', message: 'The toy cannot stop that agent now: its provider is down. Start the provider, then run teamai workflow cancel again.' };
      writeDefinition('agentstuck', [{ use: 'toy', options: { state, agent: { release, output: { ok: true } }, cancel_fails: stuck } }]);
      const before = runIds();
      const running = await startKilled(['workflow', 'start', 'oneprompt', '--driver', 'agentstuck']);
      await until(() => sends().length === 1);
      const runId = String([...runIds()].find((id) => !before.has(id)));

      await runCLI(['workflow', 'cancel', runId], repo, env());

      const ended = await running.ended;
      const attempt = attemptOf(readRunState(runId).steps[0]);
      expect(ended.stderr).toContain(`kept the place of attempt ${attempt} open, since what ran there may still run (cancel_failed): ${stuck.message}`);
      expect(runtimeRecord(runId, attempt)).toMatchObject({ phase: 'running', closeFailed: { code: 'cancel_failed', message: stuck.message } });
      expect(JSON.parse(fs.readFileSync(path.join(state, 'handles.json'), 'utf8'))).toMatchObject({ [`${runId}/${attempt}`]: `toy-${runId}-${attempt}` });
    });
  });

  it('refuses a runtime named host, the name of the command slot teamai adds to every definition, before a step runs', async () => {
    const hostDir = path.join(os.homedir(), '.teamai', 'runtimes', 'host');
    fs.mkdirSync(hostDir, { recursive: true });
    installToyRuntime(hostDir);
    writeDefinition('ownhost', [{ use: 'host', options: { state } }]);

    const ran = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'ownhost'], repo, env());

    expect(envelope(ran)).toMatchObject({ error: { code: 'runtime_not_found', message: expect.stringContaining('Driver "ownhost" uses runtime "host"') } });
    expect(toyOpens()).toBe(0);
    expect(fs.existsSync(launches)).toBe(false);
  });

  it('refuses a bad option of any runtime before a step runs, naming the key', async () => {
    writeDefinition('badparallel', [{ use: 'toy', options: { state, max_parallel: 'two' } }, { use: 'local' }]);
    const engineKey = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'badparallel'], repo, env());
    expect(envelope(engineKey)).toMatchObject({ error: { code: 'bad_option', message: expect.stringContaining('"max_parallel"') } });

    writeDefinition('badsecond', [{ use: 'local' }, { use: 'toy', options: { state, imgae: 'x' } }]);
    const runtimeKey = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'badsecond'], repo, env());
    expect(envelope(runtimeKey)).toMatchObject({ error: { code: 'bad_option', message: expect.stringContaining('"imgae"') } });

    writeDefinition('badlogin', [{ use: 'toy', options: { state, credentials: { codex: 'logn' } } }]);
    const credential = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'badlogin'], repo, env());
    expect(envelope(credential)).toMatchObject({ error: { code: 'bad_option', message: expect.stringContaining('"credentials.codex"') } });
    // No step ran: the fake tool was never launched.
    expect(fs.existsSync(launches)).toBe(false);
  });

  it('runs a team definition over the shipped one of its name, with the member\'s option over the team\'s', async () => {
    const teamState = path.join(sandbox, 'team-state');
    // The team replaces the shipped teamai-claude, which runs on local, with the toy.
    writeDefinition('teamai-claude', [{ use: 'toy', options: { state: teamState } }]);
    setMemberWorkflows({ drivers: { 'teamai-claude': { runtimes: { toy: { state } } } } });

    const ran = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'claude'], repo, env());

    expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const runId = runOf(ran);
    const [review] = readRunState(runId).steps;
    expect(runtimeRecord(runId, attemptOf(review))).toMatchObject({ runtime: 'toy', driver: 'teamai-claude' });
    expect(toyOpens()).toBe(1);
    expect(fs.existsSync(teamState)).toBe(false);
    fs.rmSync(path.join(repo, '.teamai', 'drivers', 'teamai-claude.yaml'));
  });

  it('runs a workflow of commands on the shipped teamai-t3 without opening T3: its server sees no request', async () => {
    const t3 = await t3OnFakeServer();
    const t3State = path.join(sandbox, 'commands-on-t3', 'state');
    fs.mkdirSync(t3State, { recursive: true });
    // A T3 Code that would answer, with a provider instance, were it asked.
    t3.options(t3State, { output: { ok: true } });
    await t3.ready(t3State);
    onTestFinished(() => t3.stop(t3State));
    writeFlow('commandsonly', '  - id: build\n    command: node -e "process.exit(0)"\n  - id: check\n    needs: [build]\n    command: node -e "process.exit(0)"');
    expect((await runCLI(['pull'], repo)).code).toBe(0);

    const ran = await runCLI(['workflow', 'start', 'commandsonly', '--driver', 't3'], repo, env({ T3CODE_HOME: path.join(t3State, 't3-home') }));

    expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(readRunState(runOf(ran))).toMatchObject({ steps: [{ id: 'build', status: 'succeeded', runtime: 'host' }, { id: 'check', status: 'succeeded', runtime: 'host' }] });
    expect(fs.existsSync(path.join(t3State, 't3-state', 'calls.jsonl')) ? fs.readFileSync(path.join(t3State, 't3-state', 'calls.jsonl'), 'utf8') : '').toBe('');
  }, 60_000);

  it('resolves the shipped teamai-t3, teamai-claude, teamai-codex and teamai-opencode, by either name', async () => {
    // A T3 home of its own, so a T3 Code the developer runs is never found, nor signed in to through their t3 command.
    const t3 = envelope(await runCLI(['workflow', 'start', 'oneprompt', '--driver', 't3'], repo, env({ T3CODE_HOME: path.join(sandbox, 't3-home') })));
    // The definition and its shipped t3 runtime resolved: what is missing is a T3 Code server on this machine.
    expect(t3).toMatchObject({ error: { code: 'runtime_failed', message: expect.stringContaining('Runtime "t3" of driver "teamai-t3" did not start (t3_unavailable): T3 Code is not running on this machine.') } });

    const claude = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'teamai-claude'], repo, env());
    expect(envelope(claude), claude.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });

    // Stand-ins for Codex and OpenCode, ahead of any real one, note each launch and fail the step.
    for (const tool of ['codex', 'opencode']) {
      fs.writeFileSync(path.join(bin, tool), `#!/bin/sh\nif [ "$1" = --version ]; then echo 1.0.0; exit 0; fi\necho ${tool} >> "$LAUNCHES"\nexit 3\n`, { mode: 0o755 });
    }
    for (const tool of ['codex', 'opencode']) {
      fs.rmSync(launches, { force: true });
      const ran = await runCLI(['workflow', 'start', 'oneprompt', '--driver', tool], repo, env());
      expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'failed' } } });
      const [review] = readRunState(runOf(ran)).steps;
      expect(review).toMatchObject({ status: 'failed', tool });
      expect(fs.readFileSync(launches, 'utf8').trim()).toBe(tool);
    }
    for (const tool of ['codex', 'opencode']) fs.rmSync(path.join(bin, tool));
  });

  it('resolves the shipped teamai-sandbox by either name, and starts the sandbox runtime teamai ships', async () => {
    // No sbx on PATH, so the shipped runtime stops at init before it creates any sandbox.
    const nodeOnly = path.join(sandbox, 'node-only-bin');
    fs.mkdirSync(nodeOnly, { recursive: true });
    if (!fs.existsSync(path.join(nodeOnly, 'node'))) fs.symlinkSync(process.execPath, path.join(nodeOnly, 'node'));

    for (const name of ['sandbox', 'teamai-sandbox']) {
      const ran = envelope(await runCLI(['workflow', 'start', 'oneprompt', '--driver', name], repo, env({ PATH: [bin, nodeOnly, '/usr/bin', '/bin'].join(path.delimiter) })));

      expect(ran).toMatchObject({ error: { code: 'runtime_failed', message: expect.stringMatching(/^Runtime "sandbox" of driver "teamai-sandbox" did not start \(sandbox_unavailable\): sbx is not installed here/) } });
    }
  });

  it('resolves the shipped teamai-paseo by either name, and starts the Paseo runtime teamai ships', async () => {
    // No Paseo client, so the shipped runtime stops at init before it looks for any daemon.
    const missing = path.join(sandbox, 'no-paseo-client');

    for (const name of ['paseo', 'teamai-paseo']) {
      const ran = envelope(await runCLI(['workflow', 'start', 'oneprompt', '--driver', name], repo, env({ PASEO_CLIENT_PATH: missing })));

      expect(ran).toMatchObject({ error: { code: 'runtime_failed', message: expect.stringMatching(/^Runtime "paseo" of driver "teamai-paseo" did not start \(client_missing\)/) } });
    }
  });

  it('gives two parallel attempts of one run their own tool homes, and finds both transcripts once both are collected', async () => {
    writeDefinition('toyonly', [{ use: 'toy', options: { state } }]);
    setMemberWorkflows({ max_parallel: 2 });
    const spans = path.join(sandbox, 'spans-homes.jsonl');

    const ran = await runCLI(['workflow', 'start', 'pair', '--driver', 'toyonly'], repo, env({ FAKE_TOOL_SPANS: spans, FAKE_TOOL_BARRIER: '2', FAKE_TOOL_HOLD_MS: '15000' }));

    expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const runId = runOf(ran);
    const steps = readRunState(runId).steps;
    const homes = steps.map((step) => path.join(attemptDir(runId, attemptOf(step)), 'tool-home', 'claude'));
    const launched = fs.readFileSync(launches, 'utf8').trim().split('\n').map((line) => (JSON.parse(line) as { home: string }).home);
    expect(launched.sort()).toEqual([...homes].sort());
    // They overlapped: each started before the other ended.
    const edges = fs.readFileSync(spans, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { edge: string });
    expect(edges.map((edge) => edge.edge)).toEqual(['start', 'start', 'end', 'end']);
    for (const step of steps) {
      expect(step).toMatchObject({ status: 'succeeded', session: `sess-${attemptOf(step)}` });
      const scored = await runCLI(['score', '--run', runId, '--step', step.id, '--scorer', 'quality'], repo, env());
      expect(scored.stdout + scored.stderr).not.toContain('evidence_missing');
    }
  });

  it('caps a runtime at its own max_parallel, and offers the next runtime the step it has no room for', async () => {
    writeDefinition('toyone', [{ use: 'toy', options: { state, max_parallel: 1 } }, { use: 'local' }]);
    setMemberWorkflows({ max_parallel: 2 });
    const spans = path.join(sandbox, 'spans-cap.jsonl');

    const ran = await runCLI(['workflow', 'start', 'pair', '--driver', 'toyone'], repo, env({ FAKE_TOOL_SPANS: spans, FAKE_TOOL_BARRIER: '2', FAKE_TOOL_HOLD_MS: '15000' }));

    expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const runId = runOf(ran);
    const ranOn = readRunState(runId).steps.map((step) => (runtimeRecord(runId, attemptOf(step))?.runtime as string | undefined));
    expect(ranOn.sort()).toEqual(['tools', 'toy']);
    const edges = fs.readFileSync(spans, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { edge: string });
    expect(edges.map((edge) => edge.edge)).toEqual(['start', 'start', 'end', 'end']);
  });

  it('runs a shipped runtime from the packed package, found in teamai\'s package directory before a same-named executable on PATH', async () => {
    // The package as npm packs it, with one more runtime of teamai's own, as a first-party runtime adds its own.
    const packs = path.join(sandbox, 'packs');
    fs.mkdirSync(packs, { recursive: true });
    const packed = execFileSync('npm', ['pack', '--ignore-scripts', '--silent', '--pack-destination', packs], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').at(-1) ?? '';
    execFileSync('tar', ['-xzf', path.join(packs, packed), '-C', packs]);
    const pkg = path.join(packs, 'package');
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(pkg, 'node_modules'));
    const manifest = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')) as { bin: Record<string, string> };
    manifest.bin['teamai-runtime-shiptoy'] = 'dist/runtime-shiptoy.js';
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify(manifest, null, 2));
    fs.copyFileSync(TOY_RUNTIME, path.join(pkg, 'dist', 'runtime-shiptoy.js'));
    fs.writeFileSync(path.join(pkg, 'runtimes', 'teamai-shiptoy.yaml'), 'protocol: 1\nentry: { bin: teamai-runtime-shiptoy }\n');
    // A stray executable of the same name on PATH, which must never run.
    const stray = path.join(sandbox, 'stray-ran');
    fs.writeFileSync(path.join(bin, 'teamai-runtime-shiptoy'), `#!/bin/sh\ntouch "${stray}"\nexit 1\n`, { mode: 0o755 });
    writeDefinition('shipd', [{ use: 'shiptoy', options: { state } }]);

    const ran = spawnSync(process.execPath, [path.join(pkg, 'dist', 'index.js'), 'workflow', 'start', 'oneprompt', '--driver', 'shipd'], { cwd: repo, env: { ...process.env, ...env(), FORCE_COLOR: '0' }, encoding: 'utf8' });

    const done = envelope({ code: ran.status, signal: null, stdout: ran.stdout, stderr: ran.stderr });
    expect(done, ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const runId = runOf({ code: ran.status, signal: null, stdout: ran.stdout, stderr: ran.stderr });
    const [review] = readRunState(runId).steps;
    expect(runtimeRecord(runId, attemptOf(review))).toMatchObject({ runtime: 'shiptoy', driver: 'shipd', phase: 'closed' });
    expect(toyOpens()).toBe(1);
    expect(fs.existsSync(stray)).toBe(false);
    fs.rmSync(path.join(bin, 'teamai-runtime-shiptoy'));
  });

  it('runs the member\'s own credential helper on the host push, never one the step planted in the checkout\'s config', async () => {
    // An origin that asks for credentials, so the push runs every credential helper git knows.
    const server = http.createServer((_request, response) => { response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="team"' }); response.end(); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const planted = path.join(sandbox, 'planted-helper-ran');
    const member = path.join(sandbox, 'member-helper-ran');
    const gitconfig = path.join(os.homedir(), '.gitconfig');
    const gitconfigBefore = fs.existsSync(gitconfig) ? fs.readFileSync(gitconfig, 'utf8') : undefined;

    try {
      fs.appendFileSync(gitconfig, `[credential]\n\thelper = "!f() { touch '${member}'; }; f"\n`);
      // The member's checkout pushes there; a push from a step's copy goes to the origin the checkout named before the run.
      execFileSync('git', ['config', '--local', 'remote.origin.pushurl', `http://127.0.0.1:${port}/team/workflow.git`], { cwd: repo });
      writeFlow('plantcred', `  - id: build
    workspace: new
    command: git config extensions.worktreeConfig true && git config --worktree credential.helper "!f() { touch '${planted}'; }; f" && echo change > planted.txt`);
      const pulled = await runCLI(['pull'], repo);
      expect(pulled.code).toBe(0);
      const ran = await runCLI(['workflow', 'start', 'plantcred', '--driver', 'local'], repo, env({ GIT_TERMINAL_PROMPT: '0' }));

      // The push was refused for want of credentials, after the member's helper was asked.
      expect(fs.existsSync(member), ran.stderr).toBe(true);
      expect(fs.existsSync(planted)).toBe(false);
    } finally {
      server.close();
      spawnSync('git', ['config', '--local', '--unset', 'remote.origin.pushurl'], { cwd: repo });
      if (gitconfigBefore === undefined) fs.rmSync(gitconfig, { force: true });
      else fs.writeFileSync(gitconfig, gitconfigBefore);
    }
  });

  it('runs the filter the member\'s own checkout names, such as git-crypt\'s, when it commits a step\'s work', async () => {
    const member = path.join(sandbox, 'member-filter-ran');
    const filter = path.join(sandbox, 'member-filter');
    fs.writeFileSync(filter, `#!/bin/sh\ntouch '${member}'\ncat\n`, { mode: 0o755 });
    const attributes = path.join(repo, '.git', 'info', 'attributes');
    execFileSync('git', ['config', '--local', 'filter.crypt.clean', filter], { cwd: repo });
    execFileSync('git', ['config', '--local', 'filter.crypt.required', 'true'], { cwd: repo });
    fs.writeFileSync(attributes, 'secret.txt filter=crypt\n');
    writeFlow('memberfilter', `  - id: build
    workspace: new
    command: echo hidden > secret.txt`);
    const pulled = await runCLI(['pull'], repo);
    expect(pulled.code).toBe(0);

    try {
      const ran = await runCLI(['workflow', 'start', 'memberfilter', '--driver', 'local'], repo, env());

      expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      expect(fs.existsSync(member)).toBe(true);
    } finally {
      execFileSync('git', ['config', '--local', '--remove-section', 'filter.crypt'], { cwd: repo });
      fs.rmSync(attributes, { force: true });
    }
  });

  describe('with an env credential', () => {
    const VALUE = 'toy-token-value-7f3a';
    type Noted = { type: string; op: string; handle: string; names: string[] };
    const noted = (): Noted[] => (fs.existsSync(path.join(state, 'credentials.jsonl'))
      ? fs.readFileSync(path.join(state, 'credentials.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Noted)
      : []);
    const credentialDefinition = (name: string, extra: Record<string, unknown> = {}): void => {
      writeDefinition(name, [{ use: 'toy', options: { state, credentials: { TOY_TOKEN: 'env:MEMBER_TOY_TOKEN' }, ...extra } }]);
    };

    /** Every file under `dir` whose bytes hold `text`. */
    const holding = (dir: string, text: string): string[] => (fs.existsSync(dir)
      ? entriesUnder(dir).map(({ relative }) => path.join(dir, relative)).filter((at) => fs.statSync(at).isFile() && fs.readFileSync(at).includes(text))
      : []);

    it('finds the tool\'s own sign-in variables in the member\'s environment by name when the runtime declares no credential', async () => {
      writeDefinition('signinbyname', [{ use: 'toy', options: { state } }]);

      const ran = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'signinbyname'], repo, env({ ANTHROPIC_AUTH_TOKEN: VALUE, ANTHROPIC_BASE_URL: 'https://gateway.example.test' }));

      expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      const runId = runOf(ran);
      const [review] = readRunState(runId).steps;
      expect(noted().find((line) => line.type === 'init')).toMatchObject({ names: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'] });
      expect(noted().filter((line) => line.handle === `toy-${runId}-${attemptOf(review)}`).map(({ type, names }) => ({ type, names }))).toEqual([
        { type: 'open', names: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'] },
        { type: 'exec', names: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'] },
      ]);
      expect([...holding(path.join(dataHome, 'workflows'), VALUE), ...holding(state, VALUE)]).toEqual([]);
      expect(`${ran.stdout}${ran.stderr}`).not.toContain(VALUE);
    });

    it('sends a Claude step only Claude\'s sign-in variables found by name, never another tool\'s', async () => {
      writeDefinition('signinpertool', [{ use: 'toy', options: { state } }]);

      const ran = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'signinpertool'], repo, env({ ANTHROPIC_API_KEY: VALUE, OPENAI_API_KEY: 'toy-openai-value', CODEBUDDY_API_KEY: 'toy-codebuddy-value' }));

      expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      const runId = runOf(ran);
      const [review] = readRunState(runId).steps;
      // init names every one found, since teamai cannot know which tool a step will take before the runtime offers.
      expect(noted().find((line) => line.type === 'init')).toMatchObject({ names: ['ANTHROPIC_API_KEY', 'CODEBUDDY_API_KEY', 'OPENAI_API_KEY'] });
      expect(noted().filter((line) => line.handle === `toy-${runId}-${attemptOf(review)}`).map(({ type, names }) => ({ type, names }))).toEqual([
        { type: 'open', names: ['ANTHROPIC_API_KEY'] },
        { type: 'exec', names: ['ANTHROPIC_API_KEY'] },
      ]);
    });

    // The member's own route, in order: the login the provider keeps, then the member's config credentials. The
    // definition's own credential is the team's choice, and goes either way.
    it.each([
      { from: 'member', names: [] },
      { from: 'definition', names: ['ANTHROPIC_API_KEY'] },
    ])('signs a Claude step in on the login the runtime\'s provider keeps before a credential the $from config declares for it', async ({ from, names }) => {
      const credentials = { ANTHROPIC_API_KEY: 'env:MEMBER_ANTHROPIC_KEY' };
      writeDefinition('keptlogin', [{ use: 'toy', options: { state, own_logins: ['claude'], ...(from === 'definition' && { credentials }) } }]);

      if (from === 'member') setMemberWorkflows({ drivers: { keptlogin: { runtimes: { toy: { credentials } } } } });

      const ran = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'keptlogin'], repo, env({ MEMBER_ANTHROPIC_KEY: VALUE }));

      expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      const runId = runOf(ran);
      const [review] = readRunState(runId).steps;
      const sent = noted().filter((line) => line.handle === `toy-${runId}-${attemptOf(review)}`);
      expect(sent.map(({ type }) => type)).toEqual(['open', 'exec']);
      for (const line of sent) expect(line.names).toEqual(names);
    });

    // The Claude step's own variables go unless the provider keeps Claude's login; another tool's never matter here.
    it.each([
      { ownLogins: ['claude'], claudeNames: [] },
      { ownLogins: ['codex'], claudeNames: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'] },
    ])('sends a Claude step none of the sign-in variables found by name of a tool whose login the runtime\'s provider keeps: $ownLogins', async ({ ownLogins, claudeNames }) => {
      writeDefinition('providerlogin', [{ use: 'toy', options: { state, own_logins: ownLogins } }]);

      const ran = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'providerlogin'], repo, env({ ANTHROPIC_AUTH_TOKEN: VALUE, ANTHROPIC_BASE_URL: 'http://127.0.0.1:8317', OPENAI_API_KEY: 'toy-openai-value' }));

      expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      const runId = runOf(ran);
      const [review] = readRunState(runId).steps;
      const sent = noted().filter((line) => line.handle === `toy-${runId}-${attemptOf(review)}`);
      expect(sent.map(({ type }) => type)).toEqual(['open', 'exec']);
      for (const { names } of sent) expect(names.filter((name) => name.startsWith('ANTHROPIC_'))).toEqual(claudeNames);
    });

    // An instance is scoped as the tool it extends: it gets that tool's sign-in variables, and none when the provider
    // keeps that tool's login, whichever name the runtime gives it in ownLogins.
    it.each([
      { ownLogins: undefined, claudeNames: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'] },
      { ownLogins: ['claude'], claudeNames: [] },
      { ownLogins: ['acme-claude'], claudeNames: [] },
    ])('scopes the sign-in variables found by name for an instance step as for the tool it extends: ownLogins $ownLogins', async ({ ownLogins, claudeNames }) => {
      acmeInstance();
      writeDefinition('acmelogin', [{ use: 'toy', options: { state, can: { tools: ['claude', 'acme-claude'] }, ...(ownLogins && { own_logins: ownLogins }) } }]);

      const ran = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'acmelogin', '--tools', 'default=acme-claude'], repo, env({ ANTHROPIC_AUTH_TOKEN: VALUE, ANTHROPIC_BASE_URL: 'http://127.0.0.1:8317', OPENAI_API_KEY: 'toy-openai-value' }));

      expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      const runId = runOf(ran);
      const [review] = readRunState(runId).steps;
      const sent = noted().filter((line) => line.handle === `toy-${runId}-${attemptOf(review)}`);
      expect(sent.map(({ type }) => type)).toEqual(['open', 'exec']);
      for (const { names } of sent) expect(names.filter((name) => name.startsWith('ANTHROPIC_') || name.startsWith('OPENAI_'))).toEqual(claudeNames);
    });

    it('fails at start, naming the variable, when an env credential is unset', async () => {
      credentialDefinition('tokenunset');

      const ran = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'tokenunset'], repo, env());

      expect(envelope(ran), ran.stderr).toMatchObject({ error: { code: 'credential_missing' } });
      expect(envelope(ran)).toMatchObject({ error: { message: expect.stringContaining('MEMBER_TOY_TOKEN') } });
      expect(toyOpens()).toBe(0);
    });

    it('sends an env credential to the tool\'s exec and the place it opens, never to a command step, and writes its value nowhere', async () => {
      credentialDefinition('tokened');

      const ran = await runCLI(['workflow', 'start', 'mixed', '--driver', 'tokened'], repo, env({ MEMBER_TOY_TOKEN: VALUE }));

      expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      const runId = runOf(ran);
      const [build, review] = readRunState(runId).steps;
      const of = (step: typeof build) => noted().filter((line) => line.handle === `toy-${runId}-${attemptOf(step)}`).map(({ type, names }) => ({ type, names }));
      expect(of(build)).toEqual([{ type: 'open', names: [] }, { type: 'exec', names: [] }]);
      expect(of(review)).toEqual([{ type: 'open', names: ['TOY_TOKEN'] }, { type: 'exec', names: ['TOY_TOKEN'] }]);
      expect([...holding(path.join(dataHome, 'workflows'), VALUE), ...holding(state, VALUE)]).toEqual([]);
      expect(`${ran.stdout}${ran.stderr}`).not.toContain(VALUE);
    });

    it('fails a tool that ended with an error with the tool\'s own reason, the credential\'s value masked', async () => {
      writeDefinition('tokenrefused', [{ use: 'toy', options: { state, credentials: { TOY_TEAM: 'env:MEMBER_TOY_TEAM' } } }]);

      const ran = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'tokenrefused'], repo, env({
        MEMBER_TOY_TEAM: VALUE, FAKE_TOOL_ERROR: 'Failed to authenticate. API Error: 401 Invalid bearer token', FAKE_TOOL_ERROR_ECHO: 'TOY_TEAM',
      }));

      const [review] = readRunState(runOf(ran)).steps;
      expect(review).toMatchObject({ status: 'failed', failure: { code: 'tool_failed', message: expect.stringContaining('claude exited with status 1: Failed to authenticate. API Error: 401 Invalid bearer token <REDACTED:TOY_TEAM (credential of toy)>') } });
      expect(holding(path.join(dataHome, 'workflows'), VALUE)).toEqual([]);
      expect(`${ran.stdout}${ran.stderr}`).not.toContain(VALUE);
    });

    it.each([
      { driver: 'local', definition: undefined },
      { driver: 'claudelimit', definition: 'toy' },
    ])('offers the run of a Claude step that hit its usage limit past the wait on $driver, naming Claude\'s own text', async ({ driver, definition }) => {
      if (definition) writeDefinition(driver, [{ use: definition, options: { state } }]);
      const limit = claudeWeekly();

      const ran = await runCLI(['workflow', 'start', 'oneprompt', '--driver', driver, '--tools', 'default=claude'], repo, env({ FAKE_TOOL_ERROR: limit }));

      const runId = offeredRunOf(ran);
      expect(ran.stderr).toContain(`Step "review" stopped: claude hit its usage limit: ${limit}. teamai launches no more steps on claude until its limit resets`);
      expect(ran.stderr).toContain(`past the 6 hours an unattended run waits for it. So run ${runId} is offered on teamai-reports`);
      expect(readRunState(runId).steps).toMatchObject([{ id: 'review', status: 'pending' }]);
    });

    it('waits on a Claude step the API refused on its rate limit, and leaves it pending when stopped', async () => {
      const refused = 'API Error: Request rejected (429) · This request would exceed your account\'s rate limit. Please try again later.';
      const child = spawn(process.execPath, [CLI, 'workflow', 'start', 'oneprompt', '--driver', 'local', '--tools', 'default=claude'], { cwd: repo, env: { ...process.env, ...env({ FAKE_TOOL_ERROR: refused }), FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      const closed = new Promise((resolve) => child.on('close', resolve));
      for (const deadline = Date.now() + 30_000; !stderr.includes('gave no reset time') && Date.now() < deadline;) await new Promise((resolve) => setTimeout(resolve, 50));
      child.kill('SIGINT');
      await closed;

      expect(stderr).toContain(`Step "review" stopped: claude hit its usage limit: ${refused} teamai launches no more steps on claude until its limit resets`);
      expect(stderr).toMatch(/Run (r[0-9a-f]+) waits: claude hit its usage limit and gave no reset time, so teamai tries it again at [0-9:]+ \(.+\)\. Then it runs the steps that limit holds\. To go on elsewhere instead, stop it \(Ctrl-C\) and run: teamai workflow publish \1/);
      const runId = /Run (r[0-9a-f]+) waits:/.exec(stderr)?.[1] ?? '';
      expect(readRunState(runId).steps).toMatchObject([{ id: 'review', status: 'pending' }]);
    });

    it('masks an env credential in the failure of a place its runtime could not close', async () => {
      writeDefinition('tokenunclosed', [{ use: 'toy', options: { state, credentials: { TOY_TEAM: 'env:MEMBER_TOY_TEAM' }, close_fails: 'TOY_TEAM' } }]);

      const ran = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'tokenunclosed'], repo, env({ MEMBER_TOY_TEAM: VALUE }));

      expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      const runId = runOf(ran);
      const attempt = attemptOf(readRunState(runId).steps[0]);
      expect(runtimeRecord(runId, attempt)).toMatchObject({ closeFailed: { message: expect.stringContaining('It holds <REDACTED:TOY_TEAM (credential of toy)>.') } });
      expect(holding(path.join(dataHome, 'workflows'), VALUE)).toEqual([]);
      expect(`${ran.stdout}${ran.stderr}`).not.toContain(VALUE);
    });

    it('sends an env credential with each prompt, and again when a restarted teamai reconnects to it', async () => {
      const release = path.join(state, 'release');
      credentialDefinition('tokenagent', { agent: { release, output: { ok: true } } });
      const prompts = (): Noted[] => noted().filter((line) => line.type === 'prompt');
      const startBackground = (args: string[]) => spawn(process.execPath, [CLI, ...args], { cwd: repo, env: { ...process.env, ...env({ MEMBER_TOY_TOKEN: VALUE }), FORCE_COLOR: '0' }, stdio: 'ignore' });
      const waitUntil = async (check: () => boolean): Promise<void> => {
        for (const deadline = Date.now() + 30_000; !check() && Date.now() < deadline;) await new Promise((resolve) => setTimeout(resolve, 50));
        expect(check()).toBe(true);
      };
      const first = startBackground(['workflow', 'start', 'oneprompt', '--driver', 'tokenagent']);
      await waitUntil(() => prompts().length === 1);
      const exited = new Promise((resolve) => first.on('close', resolve));
      first.kill('SIGKILL');
      await exited;
      const runId = /^toy-(r[0-9a-f]+)-/.exec(prompts()[0]?.handle ?? '')?.[1] ?? '';

      const resumed = runCLI(['workflow', 'resume', runId, '--driver', 'tokenagent'], repo, env({ MEMBER_TOY_TOKEN: VALUE }));
      await waitUntil(() => prompts().length === 2);
      fs.writeFileSync(release, '');
      const ended = await resumed;

      expect(envelope(ended), ended.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      const [sent, again] = prompts();
      expect(again?.op).toBe(sent?.op);
      expect(prompts().map((line) => line.names)).toEqual([['TOY_TOKEN'], ['TOY_TOKEN']]);
      expect(holding(path.join(dataHome, 'workflows'), VALUE)).toEqual([]);
    });

    it('refuses a credential written as a value instead of read from the environment, naming its key', async () => {
      writeDefinition('tokenliteral', [{ use: 'toy', options: { state, credentials: { TOY_TOKEN: 'toy-token-written-down' } } }]);

      const ran = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'tokenliteral'], repo, env());

      expect(envelope(ran), ran.stderr).toMatchObject({ error: { code: 'bad_option', message: expect.stringContaining('refused option "credentials.TOY_TOKEN": credentials take codex: login, the login teamai keeps for that tool, or NAME: env:VARIABLE, a value read from your environment') } });
      expect(toyOpens()).toBe(0);
    });

    it('masks a credential\'s value that the agent wrote into its output, whatever its name looks like', async () => {
      // A name nothing takes for a secret, unlike TOY_TOKEN, which teamai masks by its name already.
      writeDefinition('tokenecho', [{ use: 'toy', options: { state, credentials: { TOY_TEAM: 'env:MEMBER_TOY_TEAM' }, agent: { echo: 'TOY_TEAM' } } }]);
      writeFlow('echoed', `  - id: review
    prompt: Review the repository without changing it.
    output:
      echoed: string`);
      expect((await runCLI(['pull'], repo)).code).toBe(0);

      const ran = await runCLI(['workflow', 'start', 'echoed', '--driver', 'tokenecho'], repo, env({ MEMBER_TOY_TEAM: VALUE }));

      expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      const [review] = readRunState(runOf(ran)).steps;
      expect(review).toMatchObject({ status: 'succeeded', outputs: { echoed: expect.not.stringContaining(VALUE) } });
      expect(holding(path.join(dataHome, 'workflows'), VALUE)).toEqual([]);
    });

    it('masks the result file a tool wrote with a sign-in teamai found by name when teamai workflow cancel stops the run of a killed driver', async () => {
      writeDefinition('founddies', [{ use: 'toy', options: { state, die_at: 'exec-exited' } }]);
      const signedIn = { ANTHROPIC_API_KEY: VALUE, FAKE_TOOL_RESULT_ECHO: 'ANTHROPIC_API_KEY' };
      const killed = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'founddies'], repo, env(signedIn));
      expect(killed.signal, killed.stderr).toBe('SIGKILL');
      const runId = /Run (r[0-9a-f]+) started/.exec(killed.stderr)?.[1] ?? '';
      // The tool wrote its result, the sign-in's value in it, before teamai could read and mask it.
      expect(holding(path.join(dataHome, 'workflows', 'runs', runId), VALUE)).not.toEqual([]);

      const cancelled = await runCLI(['workflow', 'cancel', runId], repo, env(signedIn));

      expect(cancelled.code, cancelled.stderr).toBe(0);
      expect(holding(path.join(dataHome, 'workflows'), VALUE)).toEqual([]);
    });

    it('masks the result file an agent wrote itself with a credential\'s value when teamai workflow cancel stops the run of a killed driver', async () => {
      writeDefinition('echodies', [{ use: 'toy', options: { state, die_at: 'prompt-finished', credentials: { TOY_TEAM: 'env:MEMBER_TOY_TEAM' }, agent: { echo: 'TOY_TEAM' } } }]);
      writeFlow('echoedkilled', `  - id: review
    prompt: Review the repository without changing it.
    output:
      echoed: string`);
      expect((await runCLI(['pull'], repo)).code).toBe(0);
      const killed = await runCLI(['workflow', 'start', 'echoedkilled', '--driver', 'echodies'], repo, env({ MEMBER_TOY_TEAM: VALUE }));
      expect(killed.signal, killed.stderr).toBe('SIGKILL');
      const runId = /Run (r[0-9a-f]+) started/.exec(killed.stderr)?.[1] ?? '';
      // The agent wrote its result, the credential's value in it, before teamai could read and mask it.
      expect(holding(path.join(dataHome, 'workflows', 'runs', runId), VALUE)).not.toEqual([]);

      const cancelled = await runCLI(['workflow', 'cancel', runId], repo, env({ MEMBER_TOY_TEAM: VALUE }));

      expect(cancelled.code, cancelled.stderr).toBe(0);
      expect(holding(path.join(dataHome, 'workflows'), VALUE)).toEqual([]);
    });

    it('masks each entry\'s credential value when a definition lists one runtime twice under the same credential name', async () => {
      const OTHER = 'toy-token-other-91c4';
      writeDefinition('tokentwice', [
        { use: 'toy', options: { state, credentials: { TOY_TEAM: 'env:MEMBER_TOY_TEAM' }, agent: { echo: 'TOY_TEAM' } } },
        { use: 'toy', options: { state, credentials: { TOY_TEAM: 'env:MEMBER_TOY_OTHER' }, agent: { echo: 'TOY_TEAM' } } },
      ]);
      writeFlow('echoedtwice', `  - id: review
    prompt: Review the repository without changing it.
    output:
      echoed: string`);
      expect((await runCLI(['pull'], repo)).code).toBe(0);

      const ran = await runCLI(['workflow', 'start', 'echoedtwice', '--driver', 'tokentwice'], repo, env({ MEMBER_TOY_TEAM: VALUE, MEMBER_TOY_OTHER: OTHER }));

      expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      expect(holding(path.join(dataHome, 'workflows'), VALUE)).toEqual([]);
      expect(holding(path.join(dataHome, 'workflows'), OTHER)).toEqual([]);
    });

    it.each([
      ['local, which runs each step in the member\'s own environment',[{ use: 'local', options: { credentials: { TOY_TOKEN: 'env:MEMBER_TOY_TOKEN' } } }], 'local runs each step in the member\'s own environment, so it brings no credential'],
      ['a runtime that does not offer can.env', [{ use: 'toy', options: { state: 'STATE', can: { env: false }, credentials: { TOY_TOKEN: 'env:MEMBER_TOY_TOKEN' } } }], 'toy does not offer can.env, so it cannot keep a credential to the processes it is for'],
    ])('refuses an env credential at start on %s', async (_, runtimes, why) => {
      writeDefinition('tokenrefused', runtimes.map((entry) => ({ ...entry, options: JSON.parse(JSON.stringify(entry.options).replace('"STATE"', JSON.stringify(state))) as Record<string, unknown> })));

      const ran = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'tokenrefused'], repo, env({ MEMBER_TOY_TOKEN: VALUE }));

      expect(envelope(ran), ran.stderr).toMatchObject({ error: { code: 'bad_option', message: expect.stringContaining(`refused option "credentials": ${why}`) } });
      expect(toyOpens()).toBe(0);
    });
  });

  describe('with credentials: { codex: login }', () => {
    const dedicated = (): string => path.join(os.homedir(), '.teamai', 'logins', 'codex', 'auth.json');
    const auth = (account: string, refresh: string): string => JSON.stringify({ OPENAI_API_KEY: null, tokens: { account_id: account, refresh_token: refresh, access_token: 'access', id_token: 'id' }, last_refresh: '2026-11-01T00:00:00Z' });
    const dedicatedTokens = (): { account_id: string; refresh_token: string } => (JSON.parse(fs.readFileSync(dedicated(), 'utf8')) as { tokens: { account_id: string; refresh_token: string } }).tokens;
    const codexLaunches = (): Array<{ home: string; account: string; refresh: string }> => fs.readFileSync(launches, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { home: string; account: string; refresh: string });

    // A fake Codex: it reads the login in its home, records whose it is, holds, then refreshes it, as Codex does, for
    // the same account or for FAKE_CODEX_ACCOUNT's.
    const fakeCodex = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('codex-cli 0.130.0\\n'); process.exit(0); }
const home = process.env.CODEX_HOME || path.join(require('node:os').homedir(), '.codex');
// \`codex login\` signs in the home CODEX_HOME names, as account acct-new, and records where it ran.
if (args[0] === 'login') {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: null, tokens: { account_id: 'acct-new', refresh_token: 'r1', access_token: 'access', id_token: 'id' } }));
  fs.appendFileSync(process.env.LAUNCHES + '.logins', home + '\\n');
  process.stdout.write('Successfully logged in\\n');
  process.exit(0);
}
const file = path.join(home, 'auth.json');
const login = JSON.parse(fs.readFileSync(file, 'utf8'));
const span = (edge) => process.env.FAKE_TOOL_SPANS && fs.appendFileSync(process.env.FAKE_TOOL_SPANS, JSON.stringify({ attempt: process.env.TEAMAI_WORKFLOW_ATTEMPT, edge }) + '\\n');
span('start');
if (process.env.FAKE_CODEX_PID) fs.writeFileSync(process.env.FAKE_CODEX_PID, String(process.pid));
fs.appendFileSync(process.env.LAUNCHES, JSON.stringify({ home, account: login.tokens.account_id, refresh: login.tokens.refresh_token }) + '\\n');
// With FAKE_CODEX_ERROR, the turn fails with that message, as Codex reports a spent usage limit.
if (process.env.FAKE_CODEX_ERROR) {
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'th-failed' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'error', message: process.env.FAKE_CODEX_ERROR }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'turn.failed', error: { message: process.env.FAKE_CODEX_ERROR } }) + '\\n');
  process.exit(1);
}
const next = 'r' + (Number(login.tokens.refresh_token.slice(1)) + 1);
const refresh = () => fs.writeFileSync(file, JSON.stringify({ ...login, tokens: { ...login.tokens, account_id: process.env.FAKE_CODEX_ACCOUNT || login.tokens.account_id, refresh_token: next } }));
if (process.env.FAKE_CODEX_REFRESH_FIRST) refresh();
if (process.env.FAKE_TOOL_HOLD_MS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_TOOL_HOLD_MS));
refresh();
fs.mkdirSync(path.dirname(process.env.TEAMAI_WORKFLOW_RESULT), { recursive: true });
fs.writeFileSync(process.env.TEAMAI_WORKFLOW_RESULT, JSON.stringify({ output: { ok: true } }));
const thread = 'th-' + path.basename(process.env.TEAMAI_WORKFLOW_ATTEMPT);
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: thread }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 4, output_tokens: 2 } }) + '\\n');
span('end');
`;

    beforeEach(() => {
      fs.writeFileSync(path.join(bin, 'codex'), fakeCodex, { mode: 0o755 });
      fs.mkdirSync(path.dirname(dedicated()), { recursive: true });
      fs.writeFileSync(dedicated(), auth('acct-1', 'r1'), { mode: 0o600 });
      fs.chmodSync(dedicated(), 0o600);
      // The member's daily Codex login, which no step may ever see.
      fs.mkdirSync(path.join(os.homedir(), '.codex'), { recursive: true });
      fs.writeFileSync(path.join(os.homedir(), '.codex', 'auth.json'), auth('acct-daily', 'r900'));
    });

    afterAll(() => {
      fs.rmSync(path.join(bin, 'codex'), { force: true });
    });

    const loginDefinition = (name: string, toyState: string, extra: Record<string, unknown> = {}): void => {
      writeDefinition(name, [{ use: 'toy', options: { state: toyState, credentials: { codex: 'login' }, ...extra } }], { tool: 'codex' });
    };

    /** Starts `args` in the background, and resolves once its stderr holds `text`, or rejects after a while. */
    const startWatching = (args: string[], extra: NodeJS.ProcessEnv): { stderr: () => string; ended: Promise<Ran>; kill: () => void } => {
      const child = spawn(process.execPath, [CLI, ...args], { cwd: repo, env: { ...process.env, ...env(extra), FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      const ended = new Promise<Ran>((resolve) => child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr })));
      return { stderr: () => stderr, ended, kill: () => child.kill('SIGKILL') };
    };

    const pidAlive = (pid: number): boolean => {
      return signalPid(pid, 0) === 'sent';
    };

    const lockFile = (): string => path.join(os.homedir(), '.teamai', 'logins', 'codex.lock');

    /** Starts a run whose fake Codex refreshes the login, then holds it until stopped, and resolves with its run id and Codex's pid once Codex runs. */
    const holdingRun = async (definition: string, extra: NodeJS.ProcessEnv = {}): Promise<{ run: string; pid: number; watched: ReturnType<typeof startWatching> }> => {
      const pidFile = path.join(sandbox, `${definition}.pid`);
      fs.rmSync(pidFile, { force: true });
      const watched = startWatching(['workflow', 'start', 'oneprompt', '--driver', definition], { FAKE_TOOL_HOLD_MS: '120000', FAKE_CODEX_PID: pidFile, FAKE_CODEX_REFRESH_FIRST: '1', ...extra });
      await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8') !== '', 'Codex to start');
      const run = /Run (r[0-9a-f]+) started/.exec(watched.stderr())?.[1] ?? '';
      expect(run).not.toBe('');
      return { run, pid: Number(fs.readFileSync(pidFile, 'utf8')), watched };
    };

    const waitFor = async (check: () => boolean, what: string): Promise<void> => {
      for (const deadline = Date.now() + 30_000; Date.now() < deadline;) {
        if (check()) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`timed out waiting for ${what}`);
    };

    it('fails an unattended Codex step that needs the dedicated login and finds none credential_missing, naming the command and the retry', async () => {
      loginDefinition('codexnologin', state);
      fs.rmSync(dedicated());

      const ran = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'codexnologin'], repo, env({ TEAMAI_MODE: 'unattended' }));

      expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'failed' } } });
      const runId = runOf(ran);
      expect(readRunState(runId).steps).toMatchObject([{
        id: 'review', status: 'failed',
        failure: { code: 'credential_missing', message: `Step "review" signs Codex in on the login teamai keeps apart from your daily one, and ${path.dirname(dedicated())} has no Codex login yet. An unattended run does not sign in for you. Create it once with CODEX_HOME=${path.dirname(dedicated())} codex login, then run: teamai workflow retry ${runId} review` },
      }]);
      expect(fs.existsSync(launches)).toBe(false);
      expect(fs.existsSync(`${launches}.logins`)).toBe(false);
    });

    it('runs a run that launches no Codex on a runtime that brings the dedicated login, with none there', async () => {
      loginDefinition('codexunused', state);
      fs.rmSync(dedicated());

      const ran = await runCLI(['workflow', 'start', 'mixed', '--driver', 'codexunused'], repo, env({ TEAMAI_MODE: 'unattended' }));

      expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      expect(readRunState(runOf(ran)).steps).toMatchObject([{ id: 'build', status: 'succeeded' }, { id: 'review', status: 'succeeded', tool: 'claude' }]);
      expect(fs.existsSync(`${launches}.logins`)).toBe(false);
    });

    it.skipIf(!hasPython)('runs codex login into the dedicated home for the member on the first attended step that needs it and finds none, after saying why, then runs the step on it', async () => {
      loginDefinition('codexfirstlogin', state);
      fs.rmSync(dedicated());
      fs.rmSync(`${launches}.logins`, { force: true });
      const screen = path.join(sandbox, 'first-login.screen');
      const typed = path.join(sandbox, 'first-login.typed');
      const pidFile = path.join(sandbox, 'first-login.pid');
      fs.rmSync(screen, { force: true });

      const attended = spawn('python3', ['-c', TYPED_TERMINAL, pidFile, screen, typed, process.execPath, CLI, 'workflow', 'start', 'oneprompt', '--driver', 'codexfirstlogin'], {
        cwd: repo, env: { ...process.env, ...env(), TEAMAI_MODE: 'attended', FORCE_COLOR: '0' }, stdio: 'ignore',
      });
      const code = await new Promise<number | null>((resolve) => attended.on('close', resolve));
      const shown = fs.readFileSync(screen, 'utf8');

      expect(code, shown).toBe(0);
      expect(shown).toContain(`has no Codex login yet. Running CODEX_HOME=${path.dirname(dedicated())} codex login once to create it`);
      expect(shown).toContain('Successfully logged in');
      expect(shown).toContain('"outcome":"succeeded"');
      expect(fs.readFileSync(`${launches}.logins`, 'utf8')).toBe(`${path.dirname(dedicated())}\n`);
      expect(codexLaunches().map(({ account }) => account)).toEqual(['acct-new']);
    });

    it('copies the dedicated login into the attempt\'s tool home, never the member\'s own, and writes the refreshed one back', async () => {
      loginDefinition('codexlogin', state);

      const ran = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'codexlogin'], repo, env());

      expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      const runId = runOf(ran);
      const [review] = readRunState(runId).steps;
      expect(codexLaunches()).toEqual([{ home: path.join(attemptDir(runId, attemptOf(review)), 'tool-home', 'codex'), account: 'acct-1', refresh: 'r1' }]);
      // Written back by compare-and-replace, keeping the dedicated file's permissions.
      expect(dedicatedTokens()).toMatchObject({ account_id: 'acct-1', refresh_token: 'r2' });
      expect(fs.statSync(dedicated()).mode & 0o777).toBe(0o600);
      expect(JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codex', 'auth.json'), 'utf8'))).toMatchObject({ tokens: { account_id: 'acct-daily', refresh_token: 'r900' } });
    });

    it('offers the run of a Codex step that hit its usage limit past the wait, naming Codex\'s own text', async () => {
      loginDefinition('codexlimit', state);
      const limit = 'You\'ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) or try again in 2 days 1 hour 40 minutes.';

      const ran = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'codexlimit'], repo, env({ FAKE_CODEX_ERROR: limit }));

      const runId = offeredRunOf(ran);
      expect(ran.stderr).toContain(`Step "review" stopped: codex hit its usage limit: ${limit} teamai launches no more steps on codex until its limit resets`);
      expect(readRunState(runId).steps).toMatchObject([{ id: 'review', status: 'pending' }]);
    });

    it('copies no login into the attempt\'s tool home when the runtime\'s provider keeps its own Codex login', async () => {
      loginDefinition('codexownlogin', state, { own_logins: ['codex'] });

      const ran = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'codexownlogin'], repo, env());

      const runId = runOf(ran);
      const [review] = readRunState(runId).steps;
      // The fake Codex reads its login in its home, and finds none there, as the provider brings it instead.
      expect(fs.existsSync(path.join(attemptDir(runId, attemptOf(review)), 'tool-home', 'codex', 'auth.json')), ran.stderr).toBe(false);
      expect(dedicatedTokens()).toMatchObject({ account_id: 'acct-1', refresh_token: 'r1' });
    });

    it('fails the step, naming the lock to delete, when the login lock is not one teamai can read', async () => {
      loginDefinition('codexbadlock', state);
      fs.mkdirSync(path.dirname(lockFile()), { recursive: true });
      fs.writeFileSync(lockFile(), 'not a lock');

      try {
        const ran = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'codexbadlock'], repo, env());

        expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'failed' } } });
        const [review] = readRunState(runOf(ran)).steps;
        expect(review).toMatchObject({ failure: { code: 'login_held', message: `teamai cannot read the codex login lock ${lockFile()}, so it cannot tell which attempt holds the login. If no step uses that login now, delete ${lockFile()}, then retry the step.` } });
        expect(fs.readFileSync(lockFile(), 'utf8')).toBe('not a lock');
        expect(fs.existsSync(launches) ? codexLaunches() : []).toEqual([]);
      } finally {
        fs.rmSync(lockFile(), { force: true });
      }
    }, 60_000);

    it('keeps the dedicated login when the step left one for another account, and fails the step with login_not_written_back', async () => {
      loginDefinition('codexother', state);

      const ran = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'codexother'], repo, env({ FAKE_CODEX_ACCOUNT: 'acct-2' }));

      expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'failed' } } });
      const [review] = readRunState(runOf(ran)).steps;
      expect(review).toMatchObject({ status: 'failed', failure: { code: 'login_not_written_back', message: expect.stringContaining('another account') } });
      expect(review && 'failure' in review ? review.failure?.message : '').toContain(`CODEX_HOME=${path.dirname(dedicated())} codex login`);
      expect(dedicatedTokens()).toMatchObject({ account_id: 'acct-1', refresh_token: 'r1' });
    });

    it('runs two parallel attempts on the login one after the other', async () => {
      loginDefinition('codexpair', state);
      setMemberWorkflows({ max_parallel: 2 });
      const spans = path.join(sandbox, 'spans-login.jsonl');
      fs.rmSync(spans, { force: true });
      writeFlow('codexpair', `  - id: left
    workspace: new
    prompt: Review the left half.
    output:
      ok: boolean
  - id: right
    needs: []
    workspace: new
    prompt: Review the right half.
    output:
      ok: boolean`);
      const pulled = await runCLI(['pull'], repo);
      expect(pulled.code).toBe(0);

      const ran = await runCLI(['workflow', 'start', 'codexpair', '--driver', 'codexpair'], repo, env({ FAKE_TOOL_SPANS: spans, FAKE_TOOL_HOLD_MS: '1000' }));

      expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      const edges = fs.readFileSync(spans, 'utf8').trim().split('\n').map((line) => (JSON.parse(line) as { edge: string }).edge);
      expect(edges).toEqual(['start', 'end', 'start', 'end']);
      // The second used the login the first wrote back.
      expect(codexLaunches().map((launch) => launch.refresh)).toEqual(['r1', 'r2']);
      expect(dedicatedTokens().refresh_token).toBe('r3');
    });

    it('keeps the login held by an attempt whose driver was killed, so another run waits naming it until that attempt is resumed and written back', async () => {
      loginDefinition('codexdies', state, { die_at: 'exec-exited' });
      // Written before any run, so no read-only step sees the repository change under it.
      loginDefinition('codexwaits', fs.mkdtempSync(path.join(sandbox, 'toy-state-')));
      const killed = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'codexdies'], repo, env());
      expect(killed.signal, killed.stderr).toBe('SIGKILL');
      const holder = /Run (r[0-9a-f]+) started/.exec(killed.stderr)?.[1] ?? '';
      expect(holder).not.toBe('');

      const waiting = startWatching(['workflow', 'start', 'oneprompt', '--driver', 'codexwaits'], {});
      await waitFor(() => waiting.stderr().includes(`login teamai keeps, which attempt`) && waiting.stderr().includes(`of run ${holder} holds`), 'the second run to name the holder');
      // It has not launched: only the killed attempt used the login.
      expect(codexLaunches()).toHaveLength(1);

      const resumed = await runCLI(['workflow', 'resume', holder, '--driver', 'codexdies'], repo, env());
      expect(envelope(resumed), resumed.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      const second = await waiting.ended;
      expect(envelope(second), second.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      // The killed attempt ran once, wrote r2 back on resume, and the waiting one started from it.
      expect(codexLaunches().map((launch) => launch.refresh)).toEqual(['r1', 'r2']);
      expect(dedicatedTokens().refresh_token).toBe('r3');
    });

    it('releases the login of an attempt a killed driver left, once it is stopped through that driver before the run resumes on local', async () => {
      loginDefinition('codexleft', state, { die_at: 'exec-exited' });
      const killed = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'codexleft'], repo, env());
      expect(killed.signal, killed.stderr).toBe('SIGKILL');
      const holder = /Run (r[0-9a-f]+) started/.exec(killed.stderr)?.[1] ?? '';
      expect(fs.existsSync(lockFile())).toBe(true);

      const resumed = await runCLI(['workflow', 'resume', holder, '--driver', 'local'], repo, env());

      expect(resumed.stderr).toContain(`on step runtime "toy" and closed its place.`);
      // Written back, then let go: no later step waits on a run that holds the login no longer.
      expect(dedicatedTokens().refresh_token).toBe('r2');
      expect(fs.existsSync(lockFile()), resumed.stderr).toBe(false);
    });

    it('stops the tool and closes the place of an attempt whose driver was killed when teamai workflow cancel stops its run, then writes the login back and releases it', async () => {
      loginDefinition('codexorphan', state);
      const { run, pid, watched } = await holdingRun('codexorphan');
      watched.kill();
      await watched.ended;
      // The tool outlives its driver: only its runtime can stop it.
      expect(pidAlive(pid)).toBe(true);

      const cancelled = await runCLI(['workflow', 'cancel', run], repo, env());

      expect(envelope(cancelled), cancelled.stderr).toMatchObject({ data: { run: { status: 'cancelled' } } });
      expect(pidAlive(pid)).toBe(false);
      const [review] = readRunState(run).steps;
      expect(runtimeRecord(run, attemptOf(review))).toMatchObject({ runtime: 'toy', phase: 'closed' });
      expect(cancelled.stderr).toContain(`Stopped attempt ${attemptOf(review)} of run ${run} on step runtime "toy" and closed its place.`);
      expect(cancelled.stderr).toContain(`Released the codex login teamai keeps, which attempt ${attemptOf(review)} of run ${run} held.`);
      expect(fs.existsSync(lockFile())).toBe(false);
      // Codex refreshed the login before it was stopped: the dedicated home keeps the token Codex now holds.
      expect(dedicatedTokens()).toMatchObject({ account_id: 'acct-1', refresh_token: 'r2' });
    });

    it('stops the attempt of a killed driver when teamai workflow cancel runs in a shell without the env credential its runtime declares', async () => {
      loginDefinition('codexenvorphan', state, { credentials: { codex: 'login', TOY_TEAM: 'env:MEMBER_TOY_TEAM' } });
      const { run, pid, watched } = await holdingRun('codexenvorphan', { MEMBER_TOY_TEAM: 'member-team-value' });
      watched.kill();
      await watched.ended;

      // A cancel stops and closes, and sends no credential, so it needs none of their values.
      const cancelled = await runCLI(['workflow', 'cancel', run], repo, env());

      expect(envelope(cancelled), cancelled.stderr).toMatchObject({ data: { run: { status: 'cancelled' } } });
      expect(cancelled.stderr).not.toContain('MEMBER_TOY_TEAM');
      expect(pidAlive(pid)).toBe(false);
      expect(runtimeRecord(run, attemptOf(readRunState(run).steps[0]))).toMatchObject({ runtime: 'toy', phase: 'closed' });
      expect(fs.existsSync(lockFile())).toBe(false);
    });

    it('keeps the login held when teamai workflow cancel cannot reach the runtime of an attempt whose driver was killed, and says how to free it', async () => {
      loginDefinition('codexunreachable', state);
      const { run, pid, watched } = await holdingRun('codexunreachable');
      watched.kill();
      await watched.ended;
      fs.rmSync(path.join(repo, '.teamai', 'drivers', 'codexunreachable.yaml'));

      try {
        const cancelled = await runCLI(['workflow', 'cancel', run], repo, env());

        expect(envelope(cancelled), cancelled.stderr).toMatchObject({ data: { run: { status: 'cancelled' } } });
        const attempt = attemptOf(readRunState(run).steps[0]);
        expect(cancelled.stderr).toContain(`Could not stop attempt ${attempt} of run ${run} on step runtime "toy" of driver "codexunreachable"`);
        expect(cancelled.stderr).toContain(`The codex login teamai keeps stays held by attempt ${attempt} of run ${run}, whose tool may still run. Stop that tool on its step runtime, then run teamai workflow cancel ${run} --release ${attempt}, which lets the attempt go and ends its login.`);
        expect(JSON.parse(fs.readFileSync(lockFile(), 'utf8'))).toMatchObject({ run, attempt });
      } finally {
        signalPid(pid, 'SIGKILL');
        fs.rmSync(lockFile(), { force: true });
      }
    });

    it('keeps the place and the login when the runtime answers the close of an attempt whose driver was killed with an error that names no request', async () => {
      loginDefinition('codexerror', state);
      const { run, pid, watched } = await holdingRun('codexerror');
      watched.kill();
      await watched.ended;
      loginDefinition('codexerror', state, { answer: { close: 'error' } });

      const cancelled = await runCLI(['workflow', 'cancel', run], repo, env());

      expect(envelope(cancelled), cancelled.stderr).toMatchObject({ data: { run: { status: 'cancelled' } } });
      const attempt = attemptOf(readRunState(run).steps[0]);
      const handle = `toy-${run}-${attempt}`;
      expect(pidAlive(pid)).toBe(false);
      expect(runtimeRecord(run, attempt)).toMatchObject({ phase: 'collected', closeFailed: { code: 'runtime_unanswered' } });
      expect(cancelled.stderr).toContain(`Could not stop attempt ${attempt} of run ${run} on step runtime "toy" of driver "codexerror": Step runtime "toy" could not close the place of attempt ${attempt}, so what ran there may still run (runtime_unanswered): Step runtime "toy" did not answer close of ${handle}: it wrote an error that names no request (The toy cannot answer close of ${handle}: answer.close is set.).`);
      expect(cancelled.stderr).toContain(`The codex login teamai keeps stays held by attempt ${attempt} of run ${run}`);
      expect(JSON.parse(fs.readFileSync(lockFile(), 'utf8'))).toMatchObject({ run, attempt });
      // The toy still knows the place.
      expect(JSON.parse(fs.readFileSync(path.join(state, 'handles.json'), 'utf8'))).toMatchObject({ [`${run}/${attempt}`]: handle });
      fs.rmSync(lockFile(), { force: true });
    });

    it('releases an attempt whose runtime cannot close its place once the person runs teamai workflow cancel --release, writing the login back', async () => {
      loginDefinition('codexrelease', state);
      const { run, pid, watched } = await holdingRun('codexrelease');
      watched.kill();
      await watched.ended;
      loginDefinition('codexrelease', state, { close_fails: true });
      const attempt = attemptOf(readRunState(run).steps[0]);
      const handle = `toy-${run}-${attempt}`;

      const kept = await runCLI(['workflow', 'cancel', run], repo, env());

      expect(pidAlive(pid)).toBe(false);
      expect(kept.stderr).toContain(`Could not stop attempt ${attempt} of run ${run} on step runtime "toy" of driver "codexrelease": Step runtime "toy" could not close the place of attempt ${attempt}, so what ran there may still run (close_failed): The toy keeps place ${handle}: close_fails is set. Once you checked that nothing of it still runs there, run teamai workflow cancel ${run} --release ${attempt}.`);
      expect(JSON.parse(fs.readFileSync(lockFile(), 'utf8'))).toMatchObject({ run, attempt });

      const released = await runCLI(['workflow', 'cancel', run, '--release', attempt], repo, env());

      // The run was cancelled already; that cancel tries the attempts again, and lets this one go.
      expect(envelope(released), released.stderr).toEqual({ data: { run: { id: run, status: 'cancelled' }, released: [attempt] } });
      expect(released.stderr).toContain(`Released attempt ${attempt} of run ${run} on step runtime "toy" without its confirmation, as asked. What ran in its place may still be there, since the runtime did not confirm its end: Step runtime "toy" could not close the place of attempt ${attempt}, so what ran there may still run (close_failed): The toy keeps place ${handle}: close_fails is set.`);
      expect(released.stderr).toContain(`Released the codex login teamai keeps, which attempt ${attempt} of run ${run} held.`);
      expect(runtimeRecord(run, attempt)).toMatchObject({ phase: 'closed', closeFailed: { code: 'close_failed' } });
      expect(fs.existsSync(lockFile())).toBe(false);
      expect(dedicatedTokens()).toMatchObject({ account_id: 'acct-1', refresh_token: 'r2' });
      // The close was tried once more and refused, but it said the person let the attempt go, so the toy forgets the place.
      expect(JSON.parse(fs.readFileSync(path.join(state, 'handles.json'), 'utf8'))).not.toHaveProperty([`${run}/${attempt}`]);
      expect(fs.readFileSync(path.join(state, 'closes.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as unknown).at(-1)).toMatchObject({ handle, release: true });

      const again = await runCLI(['workflow', 'cancel', run], repo, env());

      expect(again.stderr).not.toContain(`Could not stop attempt ${attempt}`);
    });

    it('still stops the tool of an attempt the person releases, when its runtime can stop it', async () => {
      loginDefinition('codexreleaserun', state);
      const { run, pid, watched } = await holdingRun('codexreleaserun');
      watched.kill();
      await watched.ended;
      const attempt = attemptOf(readRunState(run).steps[0]);

      const released = await runCLI(['workflow', 'cancel', run, '--release', attempt], repo, env());

      expect(envelope(released), released.stderr).toMatchObject({ data: { run: { status: 'cancelled' } } });
      expect(pidAlive(pid)).toBe(false);
      expect(released.stderr).not.toContain('Released attempt');
      expect(runtimeRecord(run, attempt)).toMatchObject({ phase: 'closed' });
      expect(fs.existsSync(lockFile())).toBe(false);
    });

    const initModes = (toyState: string): string[] => fs.readFileSync(path.join(toyState, 'inits.jsonl'), 'utf8').trim().split('\n').map((line) => (JSON.parse(line) as { mode: string }).mode);
    const signedOut = { code: 'signed_out', message: 'The toy is signed out of its provider. Sign in again, then start the run again.' };
    const cannotStop = (run: string) => ({ code: 'cancel_failed', message: `The toy cannot stop that exec now: its provider is down. Start the provider, then run teamai workflow cancel ${run} again.` });

    it('stops the attempt of a killed driver through its runtime in recover mode when that runtime cannot start for new work', async () => {
      loginDefinition('codexrecover', state);
      const { run, pid, watched } = await holdingRun('codexrecover');
      watched.kill();
      await watched.ended;
      loginDefinition('codexrecover', state, { init_fails: signedOut });
      const before = initModes(state).length;

      try {
        const cancelled = await runCLI(['workflow', 'cancel', run], repo, env());

        expect(envelope(cancelled), cancelled.stderr).toMatchObject({ data: { run: { status: 'cancelled' } } });
        expect(cancelled.stderr).not.toContain('Could not stop attempt');
        expect(pidAlive(pid)).toBe(false);
        expect(runtimeRecord(run, attemptOf(readRunState(run).steps[0]))).toMatchObject({ runtime: 'toy', phase: 'closed' });
        expect(fs.existsSync(lockFile())).toBe(false);
        // It was opened only to stop what it ran, never asked to start for new work.
        expect(initModes(state).slice(before)).toEqual(['recover']);
      } finally {
        if (pidAlive(pid)) signalPid(pid, 'SIGKILL');
        fs.rmSync(lockFile(), { force: true });
      }
    });

    it('stops the attempt of a killed driver through recover mode without waiting on a runtime whose init for new work never answers', async () => {
      loginDefinition('codexstall', state);
      const { run, pid, watched } = await holdingRun('codexstall');
      watched.kill();
      await watched.ended;
      loginDefinition('codexstall', state, { answer: { init: 'silent' } });
      const before = initModes(state).length;
      const cancel = startWatching(['workflow', 'cancel', run], {});

      try {
        const cancelled = await Promise.race([cancel.ended, new Promise<undefined>((resolve) => setTimeout(resolve, 25_000))]);

        if (cancelled === undefined) throw new Error('teamai workflow cancel still waited 25 s later');
        expect(envelope(cancelled), cancelled.stderr).toMatchObject({ data: { run: { status: 'cancelled' } } });
        expect(pidAlive(pid)).toBe(false);
        expect(runtimeRecord(run, attemptOf(readRunState(run).steps[0]))).toMatchObject({ runtime: 'toy', phase: 'closed' });
        expect(fs.existsSync(lockFile())).toBe(false);
        expect(initModes(state).slice(before)).toEqual(['recover']);
      } finally {
        cancel.kill();
        if (pidAlive(pid)) signalPid(pid, 'SIGKILL');
        fs.rmSync(lockFile(), { force: true });
      }
    });

    it('stops the attempt of a killed driver through a normal init when its runtime refuses recover mode', async () => {
      loginDefinition('codexoldstop', state);
      const { run, pid, watched } = await holdingRun('codexoldstop');
      watched.kill();
      await watched.ended;
      loginDefinition('codexoldstop', state, { recover: false });
      const before = initModes(state).length;

      try {
        const cancelled = await runCLI(['workflow', 'cancel', run], repo, env());

        expect(envelope(cancelled), cancelled.stderr).toMatchObject({ data: { run: { status: 'cancelled' } } });
        expect(cancelled.stderr).not.toContain('Could not stop attempt');
        expect(pidAlive(pid)).toBe(false);
        expect(runtimeRecord(run, attemptOf(readRunState(run).steps[0]))).toMatchObject({ runtime: 'toy', phase: 'closed' });
        expect(initModes(state).slice(before)).toEqual(['recover', expect.not.stringMatching(/^recover$/)]);
      } finally {
        if (pidAlive(pid)) signalPid(pid, 'SIGKILL');
        fs.rmSync(lockFile(), { force: true });
      }
    });

    it('keeps the place and the login, with the runtime\'s advice, when its runtime cannot stop the attempt of a killed driver, and a second cancel stops it once it can', async () => {
      loginDefinition('codexstuck', state);
      const { run, pid, watched } = await holdingRun('codexstuck');
      watched.kill();
      await watched.ended;
      loginDefinition('codexstuck', state, { init_fails: signedOut, cancel_fails: cannotStop(run) });

      try {
        const cancelled = await runCLI(['workflow', 'cancel', run], repo, env());

        expect(envelope(cancelled), cancelled.stderr).toMatchObject({ data: { run: { status: 'cancelled' } } });
        const attempt = attemptOf(readRunState(run).steps[0]);
        expect(cancelled.stderr).toContain(`Could not stop attempt ${attempt} of run ${run} on step runtime "toy" of driver "codexstuck": its exec or prompt may still run, since the runtime did not confirm it stopped (cancel_failed): ${cannotStop(run).message}`);
        expect(cancelled.stderr).toContain(`The codex login teamai keeps stays held by attempt ${attempt} of run ${run}`);
        expect(pidAlive(pid)).toBe(true);
        expect(JSON.parse(fs.readFileSync(lockFile(), 'utf8'))).toMatchObject({ run, attempt });
        // Nothing was brought back or closed while the tool may still write the place.
        expect(runtimeRecord(run, attempt)).toMatchObject({ phase: 'running' });

        loginDefinition('codexstuck', state, { init_fails: signedOut });
        const again = await runCLI(['workflow', 'cancel', run], repo, env());

        expect(again.stderr).toContain(`Released the codex login teamai keeps, which attempt ${attempt} of run ${run} held.`);
        expect(pidAlive(pid)).toBe(false);
        expect(runtimeRecord(run, attempt)).toMatchObject({ phase: 'closed' });
        expect(fs.existsSync(lockFile())).toBe(false);
      } finally {
        if (pidAlive(pid)) signalPid(pid, 'SIGKILL');
        fs.rmSync(lockFile(), { force: true });
      }
    });

    it('releases an attempt whose stop its runtime does not confirm, writing the login back, when the release\'s close goes through', async () => {
      loginDefinition('codexreleasestuck', state);
      const { run, pid, watched } = await holdingRun('codexreleasestuck');
      watched.kill();
      await watched.ended;
      loginDefinition('codexreleasestuck', state, { cancel_fails: cannotStop(run) });
      const attempt = attemptOf(readRunState(run).steps[0]);

      try {
        const refused = await runCLI(['workflow', 'cancel', run], repo, env());
        expect(refused.stderr).toContain(cannotStop(run).message);

        // From a folder inside the checkout: the runtime still starts in the run's checkout.
        const inside = path.join(repo, 'docs-inside');
        fs.mkdirSync(inside, { recursive: true });
        const released = await runCLI(['workflow', 'cancel', run, '--release', attempt], inside, env());

        expect(envelope(released), released.stderr).toEqual({ data: { run: { id: run, status: 'cancelled' }, released: [attempt] } });
        expect(fs.readFileSync(path.join(state, 'inits.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as unknown).at(-1)).toMatchObject({ checkout: repo, cwd: repo });
        expect(released.stderr).toContain(`Released attempt ${attempt} of run ${run} on step runtime "toy" without its confirmation, as asked.`);
        expect(released.stderr).toContain(`Released the codex login teamai keeps, which attempt ${attempt} of run ${run} held.`);
        expect(runtimeRecord(run, attempt)).toMatchObject({ phase: 'closed' });
        expect(fs.existsSync(lockFile())).toBe(false);
      } finally {
        if (pidAlive(pid)) signalPid(pid, 'SIGKILL');
        fs.rmSync(lockFile(), { force: true });
      }
    });

    it('releases the login on a second cancel whose runtime confirms the stop only a while after it reads the cancel', async () => {
      loginDefinition('codexslowstop', state);
      const { run, pid, watched } = await holdingRun('codexslowstop');
      watched.kill();
      await watched.ended;
      loginDefinition('codexslowstop', state, { cancel_fails: cannotStop(run) });

      try {
        const refused = await runCLI(['workflow', 'cancel', run], repo, env());
        expect(refused.stderr).toContain(cannotStop(run).message);

        loginDefinition('codexslowstop', state, { stop_ms: 1500 });
        const again = await runCLI(['workflow', 'cancel', run], repo, env());

        const attempt = attemptOf(readRunState(run).steps[0]);
        expect(again.stderr).not.toContain('Could not stop attempt');
        expect(again.stderr).toContain(`Released the codex login teamai keeps, which attempt ${attempt} of run ${run} held.`);
        expect(pidAlive(pid)).toBe(false);
        expect(runtimeRecord(run, attempt)).toMatchObject({ phase: 'closed' });
        expect(fs.existsSync(lockFile())).toBe(false);
      } finally {
        if (pidAlive(pid)) signalPid(pid, 'SIGKILL');
        fs.rmSync(lockFile(), { force: true });
      }
    });

    it('says so, and keeps the login, when a runtime that cannot start does not open in recover mode either', async () => {
      loginDefinition('codexnorecover', state);
      const { run, pid, watched } = await holdingRun('codexnorecover');
      watched.kill();
      await watched.ended;
      loginDefinition('codexnorecover', state, { init_fails: signedOut, recover: false });

      try {
        const cancelled = await runCLI(['workflow', 'cancel', run], repo, env());

        const attempt = attemptOf(readRunState(run).steps[0]);
        expect(cancelled.stderr).toContain(`Could not stop attempt ${attempt} of run ${run} on step runtime "toy" of driver "codexnorecover": Runtime "toy" of driver "codexnorecover" did not start (signed_out): ${signedOut.message} It does not open in recover mode either, to stop what it ran (runtime_unanswered): Step runtime "toy" did not answer init: it wrote an error that names no request (The toy runtime does not know mode recover.).`);
        expect(JSON.parse(fs.readFileSync(lockFile(), 'utf8'))).toMatchObject({ run, attempt });
        expect(pidAlive(pid)).toBe(true);
      } finally {
        signalPid(pid, 'SIGKILL');
        fs.rmSync(lockFile(), { force: true });
      }
    });

    it('keeps the place and the login, unreleased, when the restarted driver cannot reattach to the exec a killed one left running, though its runtime still closes', async () => {
      // Both written before any run, so no read-only step sees the repository change under it.
      loginDefinition('codexreattach', state);
      loginDefinition('codexreattachfails', state, { answer: { reattach: 'failed' } });
      const { run, pid, watched } = await holdingRun('codexreattach');
      watched.kill();
      await watched.ended;

      try {
        const resumed = await runCLI(['workflow', 'resume', run, '--driver', 'codexreattachfails'], repo, env());

        expect(envelope(resumed), resumed.stderr).toMatchObject({ data: { done: { outcome: 'failed' } } });
        const [review] = readRunState(run).steps;
        const attempt = attemptOf(review);
        expect(review).toMatchObject({ status: 'failed', failure: { code: 'runtime_lost', message: expect.stringContaining('answer.reattach is set') } });
        // What the killed driver left may still run, so neither the place nor the login it holds is let go.
        expect(pidAlive(pid)).toBe(true);
        expect(JSON.parse(fs.readFileSync(lockFile(), 'utf8'))).toMatchObject({ run, attempt });
        expect(runtimeRecord(run, attempt)).not.toMatchObject({ phase: 'closed' });
        expect(resumed.stderr).toContain(`The codex login teamai keeps stays held by attempt ${attempt} of run ${run}`);

        // Once the runtime reattaches again, a cancel stops it and writes the refreshed login back before releasing it.
        loginDefinition('codexreattachfails', state);
        const stopped = await runCLI(['workflow', 'cancel', run], repo, env());
        expect(stopped.stderr).toContain(`Released the codex login teamai keeps, which attempt ${attempt} of run ${run} held.`);
        expect(pidAlive(pid)).toBe(false);
        expect(dedicatedTokens().refresh_token).toBe('r2');
      } finally {
        if (pidAlive(pid)) signalPid(pid, 'SIGKILL');
        fs.rmSync(lockFile(), { force: true });
      }
    });

    it('keeps the place and the login when a run resumed on another runtime cannot stop the exec a killed driver left on the first', async () => {
      const stuck = { code: 'cancel_failed', message: 'The toy cannot stop that exec now: its provider is down. Start the provider, then run teamai workflow cancel again.' };
      const otherDir = path.join(os.homedir(), '.teamai', 'runtimes', 'othertoy');
      fs.mkdirSync(otherDir, { recursive: true });
      installToyRuntime(otherDir);
      const otherState = fs.mkdtempSync(path.join(sandbox, 'toy-state-'));
      // Both written before any run, so no read-only step sees the repository change under it: the first toy runs the
      // exec, which needs no cancel, and cannot stop it later.
      loginDefinition('codexfirst', state, { cancel_fails: stuck });
      writeDefinition('codexother', [{ use: 'othertoy', options: { state: otherState, credentials: { codex: 'login' } } }], { tool: 'codex' });
      const { run, pid, watched } = await holdingRun('codexfirst');
      watched.kill();
      await watched.ended;

      try {
        const resumed = await runCLI(['workflow', 'resume', run, '--driver', 'codexother'], repo, env());

        expect(envelope(resumed), resumed.stderr).toMatchObject({ data: { done: { outcome: 'failed' } } });
        const [review] = readRunState(run).steps;
        const attempt = attemptOf(review);
        expect(review).toMatchObject({ status: 'failed', failure: { code: 'runtime_lost', message: expect.stringContaining(stuck.message) } });
        expect(pidAlive(pid)).toBe(true);
        expect(JSON.parse(fs.readFileSync(lockFile(), 'utf8'))).toMatchObject({ run, attempt });
        expect(runtimeRecord(run, attempt)).toMatchObject({ runtime: 'toy', driver: 'codexfirst' });
        expect(runtimeRecord(run, attempt)).not.toMatchObject({ phase: 'closed' });
        // The other runtime never saw the first one's place.
        expect(fs.existsSync(path.join(otherState, 'closes.jsonl'))).toBe(false);
      } finally {
        if (pidAlive(pid)) signalPid(pid, 'SIGKILL');
        fs.rmSync(lockFile(), { force: true });
        fs.rmSync(otherDir, { recursive: true, force: true });
      }
    });

    it('fails the step with the runtime\'s advice, keeping the place and the login, when the restarted driver cannot stop the exec a killed one left running', async () => {
      const stuck = { code: 'cancel_failed', message: 'The toy cannot stop that exec now: its provider is down. Start the provider, then run teamai workflow cancel again.' };
      // Both written before any run, so no read-only step sees the repository change under it: the restart reaches the
      // same toy state through a definition whose toy cannot stop.
      loginDefinition('codexrestart', state);
      loginDefinition('codexrestartstuck', state, { cancel_fails: stuck });
      const { run, pid, watched } = await holdingRun('codexrestart');
      watched.kill();
      await watched.ended;

      try {
        const resumed = await runCLI(['workflow', 'resume', run, '--driver', 'codexrestartstuck'], repo, env());

        expect(envelope(resumed), resumed.stderr).toMatchObject({ data: { done: { outcome: 'failed' } } });
        const [review] = readRunState(run).steps;
        const attempt = attemptOf(review);
        expect(review).toMatchObject({ status: 'failed', failure: { code: 'runtime_lost', message: expect.stringContaining(stuck.message) } });
        expect(pidAlive(pid)).toBe(true);
        expect(JSON.parse(fs.readFileSync(lockFile(), 'utf8'))).toMatchObject({ run, attempt });
        expect(runtimeRecord(run, attempt)).toMatchObject({ closeFailed: { code: 'cancel_failed' } });
        expect(resumed.stderr).toContain(`The codex login teamai keeps stays held by attempt ${attempt} of run ${run}`);

        // A cancel of the settled run tries the stop again, and keeps the login while the runtime still cannot stop it.
        const refused = await runCLI(['workflow', 'cancel', run], repo, env());
        expect(refused.stderr).toContain(stuck.message);
        expect(pidAlive(pid)).toBe(true);
        expect(JSON.parse(fs.readFileSync(lockFile(), 'utf8'))).toMatchObject({ run, attempt });

        expect(refused.stderr).not.toContain('Then run: teamai workflow retry');

        loginDefinition('codexrestartstuck', state);
        const stopped = await runCLI(['workflow', 'cancel', run], repo, env());
        expect(stopped.stderr).toContain(`Released the codex login teamai keeps, which attempt ${attempt} of run ${run} held.`);
        // The stop is confirmed now, so the step that failed on it can run again.
        expect(stopped.stderr).toContain(`Closed the place of attempt ${attempt} of run ${run} on step runtime "toy", which an earlier close had kept. Then run: teamai workflow retry ${run} review`);
        expect(pidAlive(pid)).toBe(false);
        expect(runtimeRecord(run, attempt)).toMatchObject({ phase: 'closed' });
      } finally {
        if (pidAlive(pid)) signalPid(pid, 'SIGKILL');
        fs.rmSync(lockFile(), { force: true });
      }
    });

    it('leaves the login to a driver that still runs when teamai workflow cancel stops its run, which releases it once its tool stopped', async () => {
      loginDefinition('codexlive', state);
      const { run, pid, watched } = await holdingRun('codexlive');

      const cancelled = await runCLI(['workflow', 'cancel', run], repo, env());

      expect(cancelled.stderr).not.toContain('Released the codex login');
      const driven = await watched.ended;
      expect(envelope(driven), driven.stderr).toMatchObject({ data: { done: { outcome: 'cancelled' } } });
      expect(pidAlive(pid)).toBe(false);
      expect(fs.existsSync(lockFile())).toBe(false);
    });

    it('keeps the place and the login when the runtime refuses the cancel of a driver that still runs, until a later cancel stops the tool', async () => {
      const stuck = { code: 'cancel_failed', message: 'The toy cannot stop that exec now: its provider is down. Start the provider, then run teamai workflow cancel again.' };
      loginDefinition('codexlivestuck', state, { cancel_fails: stuck });
      const { run, pid, watched } = await holdingRun('codexlivestuck');

      try {
        await runCLI(['workflow', 'cancel', run], repo, env());

        const driven = await watched.ended;
        const attempt = attemptOf(readRunState(run).steps[0]);
        expect(pidAlive(pid)).toBe(true);
        expect(JSON.parse(fs.readFileSync(lockFile(), 'utf8'))).toMatchObject({ run, attempt });
        expect(runtimeRecord(run, attempt)).toMatchObject({ phase: 'running', closeFailed: { code: 'cancel_failed', message: stuck.message } });
        expect(driven.stderr).toContain(`The codex login teamai keeps stays held by attempt ${attempt} of run ${run}, whose tool may still run.`);

        loginDefinition('codexlivestuck', state);
        const stopped = await runCLI(['workflow', 'cancel', run], repo, env());

        expect(stopped.stderr).toContain(`Released the codex login teamai keeps, which attempt ${attempt} of run ${run} held.`);
        expect(pidAlive(pid)).toBe(false);
        expect(runtimeRecord(run, attempt)).toMatchObject({ phase: 'closed' });
        expect(fs.existsSync(lockFile())).toBe(false);
      } finally {
        if (pidAlive(pid)) signalPid(pid, 'SIGKILL');
        fs.rmSync(lockFile(), { force: true });
      }
    });

    it('keeps the login held, naming the lock, when the runtime stops while the tool runs, and records the place it could not close', async () => {
      loginDefinition('codexlost', state, { exit_at: 'exec-accepted' });
      const pidFile = path.join(sandbox, 'codexlost.pid');
      fs.rmSync(pidFile, { force: true });

      try {
        const ran = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'codexlost'], repo, env({ FAKE_TOOL_HOLD_MS: '120000', FAKE_CODEX_PID: pidFile }));

        expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'failed' } } });
        const run = runOf(ran);
        const [review] = readRunState(run).steps;
        const attempt = attemptOf(review);
        expect(review).toMatchObject({ status: 'failed', failure: { code: 'runtime_lost' } });
        // The tool outlived its runtime, so the login stays with its attempt.
        expect(pidAlive(Number(fs.readFileSync(pidFile, 'utf8')))).toBe(true);
        expect(JSON.parse(fs.readFileSync(lockFile(), 'utf8'))).toMatchObject({ run, attempt });
        expect(ran.stderr).toContain(`The codex login teamai keeps stays held by attempt ${attempt} of run ${run}, whose tool may still run. Stop that tool on its step runtime; once run ${run} has ended, run teamai workflow cancel ${run} --release ${attempt}, which lets the attempt go and ends its login.`);
        expect(runtimeRecord(run, attempt)).toMatchObject({ phase: 'running', closeFailed: { code: 'runtime_exited' } });
      } finally {
        if (fs.existsSync(pidFile)) signalPid(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL');
        fs.rmSync(lockFile(), { force: true });
      }
    });

    it('releases the login when teamai workflow cancel stops the run whose killed attempt held it', async () => {
      loginDefinition('codexcancel', state, { die_at: 'exec-exited' });
      loginDefinition('codexafter', fs.mkdtempSync(path.join(sandbox, 'toy-state-')));
      const killed = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'codexcancel'], repo, env());
      expect(killed.signal, killed.stderr).toBe('SIGKILL');
      const holder = /Run (r[0-9a-f]+) started/.exec(killed.stderr)?.[1] ?? '';

      const cancelled = await runCLI(['workflow', 'cancel', holder], repo, env());
      expect(cancelled.stderr).toContain(`Released the codex login teamai keeps, which attempt`);

      const after = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'codexafter'], repo, env());
      expect(envelope(after), after.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      expect(after.stderr).not.toContain('waits for the codex login');
    });
  });

  describe('a runtime through another', () => {
    type Call = { toy: string; type: string; handle?: string; outer?: string; credentials?: string[]; toolHome?: Record<string, string>; unset?: string[] };

    let calls: string;
    let outerState: string;
    let innerState: string;

    /** What the two toys were asked, in the order each read it. */
    const asked = (): Call[] => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Call) : []);

    /** A definition whose only runtime is the toy through a sandbox toy, each with its own credential. */
    const throughDefinition = (name: string, inner: Record<string, unknown> = {}): void => writeDefinition(name, [{
      use: 'toy', through: 'sandboxtoy',
      options: {
        toy: { state: innerState, calls, agent: { output: { ok: true } }, credentials: { APP_TOKEN: 'env:MEMBER_APP_TOKEN' }, ...inner },
        sandboxtoy: { state: outerState, calls, can: { isolation: 'sandbox' }, credentials: { CLAUDE_CODE_OAUTH_TOKEN: 'env:MEMBER_CLAUDE_TOKEN' } },
      },
    }]);

    const tokens = { MEMBER_APP_TOKEN: 'app-value', MEMBER_CLAUDE_TOKEN: 'claude-value' };

    beforeAll(() => {
      const outerDir = path.join(os.homedir(), '.teamai', 'runtimes', 'sandboxtoy');
      fs.mkdirSync(outerDir, { recursive: true });
      installToyRuntime(outerDir);
    });

    beforeEach(() => {
      calls = path.join(state, 'calls.jsonl');
      outerState = path.join(state, 'outer');
      innerState = path.join(state, 'inner');
    });

    it('runs a command on the outer and a strict prompt on the inner, opened outer first with the outer\'s handle and closed inner first', async () => {
      throughDefinition('throughd');
      writeFlow('strictmixed', `  - id: build
    workspace: new
    command: node -e "process.stdout.write(JSON.stringify({built:true}))"
    output:
      built: boolean
  - id: review
    needs: [build]
    tool: claude
    prompt: Review the repository in a sandbox.
    requires: { isolation: sandbox, strict: true }
    output:
      ok: boolean`);
      expect((await runCLI(['pull'], repo)).code).toBe(0);

      const ran = await runCLI(['workflow', 'start', 'strictmixed', '--driver', 'throughd'], repo, env(tokens));

      expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      const runId = runOf(ran);
      const [build, review] = readRunState(runId).steps;
      expect(build).toMatchObject({ status: 'succeeded', outputs: { built: true } });
      expect(review).toMatchObject({ status: 'succeeded', outputs: { ok: true } });
      expect(runtimeRecord(runId, attemptOf(review))).toMatchObject({ runtime: 'toy through sandboxtoy', driver: 'throughd', phase: 'closed' });
      const prompted = asked().filter((call) => call.type !== 'exec' || call.toy === 'outer');
      const reviewCalls = prompted.slice(prompted.findLastIndex((call) => call.type === 'open' && call.toy === 'outer'));
      const outerHandle = reviewCalls.find((call) => call.toy === 'outer' && call.type === 'close')?.handle;
      expect(outerHandle).toEqual(expect.any(String));
      expect(reviewCalls.map(({ toy, type }) => `${toy} ${type}`)).toEqual(['outer open', 'inner open', 'inner prompt', 'inner collect', 'outer collect', 'inner close', 'outer close']);
      // The outer gets the prompt's credential, the inner its own and the outer's handle, unchanged.
      expect(reviewCalls.slice(0, 3)).toMatchObject([
        { toy: 'outer', credentials: ['CLAUDE_CODE_OAUTH_TOKEN'] },
        { toy: 'inner', outer: outerHandle, credentials: ['APP_TOKEN'] },
        { toy: 'inner', credentials: ['APP_TOKEN'] },
      ]);
      // The command ran on the outer, which runs commands: the inner runs none.
      expect(asked().filter((call) => call.type === 'exec').map((call) => call.toy)).toEqual(['outer']);
    });

    it('refuses an entry whose inner runtime launches no agents, before any step runs', async () => {
      writeDefinition('throughexec', [{ use: 'toy', through: 'sandboxtoy', options: { toy: { state: innerState }, sandboxtoy: { state: outerState } } }]);

      const ran = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'throughexec'], repo, env());

      expect(envelope(ran), ran.stderr).toMatchObject({ error: { code: 'driver_invalid', message: expect.stringContaining('runs toy through sandboxtoy, and toy launches no agents of its own') } });
    });

    it('refuses an entry whose inner runtime runs each tool itself on the attempt\'s tool home, as a sandbox does, before any step runs', async () => {
      writeDefinition('throughhome', [{ use: 'toy', through: 'sandboxtoy', options: { toy: { state: innerState, agent: { output: { ok: true } }, prompt_tool_home: true }, sandboxtoy: { state: outerState } } }]);

      const ran = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'throughhome'], repo, env());

      expect(envelope(ran), ran.stderr).toMatchObject({ error: { code: 'driver_invalid', message: expect.stringContaining('runs toy through sandboxtoy, and toy runs each tool itself, in its own place') } });
    });

    it('reattaches the outer, with the prompt\'s credential again, then the inner, when a killed teamai resumes', async () => {
      throughDefinition('throughdie', { die_at: 'prompt-finished' });

      const runs = (): string[] => (fs.existsSync(path.join(dataHome, 'workflows', 'runs')) ? fs.readdirSync(path.join(dataHome, 'workflows', 'runs')) : []).filter((name) => name.endsWith('.json'));
      const before = new Set(runs());
      const killed = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'throughdie'], repo, env(tokens));
      expect(killed.signal, killed.stderr).toBe('SIGKILL');
      const runId = runs().find((name) => !before.has(name))?.slice(0, -'.json'.length);
      fs.writeFileSync(calls, '');

      const resumed = await runCLI(['workflow', 'resume', String(runId), '--driver', 'throughdie'], repo, env(tokens));

      expect(envelope(resumed), resumed.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      const reattaches = asked().filter((call) => call.type === 'reattach');
      expect(reattaches).toMatchObject([{ toy: 'outer', credentials: ['CLAUDE_CODE_OAUTH_TOKEN'] }, { toy: 'inner' }]);
      expect(reattaches[1]?.credentials).toBeUndefined();
      expect(asked().filter((call) => call.type === 'prompt')).toEqual([]);
    });

    // The sandbox runs the app's tool for the inner, so it gets what the tool gets on any step runtime: the attempt's tool
    // home, the names the step goes without, and, after a restart, the credentials the place was opened with, none too.
    it('opens the outer with the attempt\'s tool home and the names the prompt goes without, and reattaches it with those names and the no credentials it opened with', async () => {
      writeDefinition('throughhome', [{
        use: 'toy', through: 'sandboxtoy',
        options: { toy: { state: innerState, calls, agent: { output: { ok: true } }, die_at: 'prompt-finished' }, sandboxtoy: { state: outerState, calls, can: { isolation: 'sandbox' } } },
      }]);
      writeFlow('homeprompt', `  - id: review
    tool: claude
    prompt: Review the repository in a sandbox.
    requires: { isolation: sandbox, strict: true }
    output:
      ok: boolean
  - id: deploy
    needs: [review]
    command: node -e "process.exit(0)"
    requires: { env: [DEPLOY_TOKEN] }`);
      expect((await runCLI(['pull'], repo)).code).toBe(0);
      const tokensAndDeploy = { ...tokens, DEPLOY_TOKEN: 'deploy-value' };

      const killed = await runCLI(['workflow', 'start', 'homeprompt', '--driver', 'throughhome'], repo, env(tokensAndDeploy));

      expect(killed.signal, killed.stderr).toBe('SIGKILL');
      const opened = asked().find((call) => call.toy === 'outer' && call.type === 'open');
      const [runId = '', attempt = ''] = Object.keys(JSON.parse(fs.readFileSync(path.join(innerState, 'handles.json'), 'utf8')) as Record<string, string>)[0]?.split('/') ?? [];
      const home = path.join(attemptDir(runId, attempt), 'tool-home', 'claude');
      expect(opened).toMatchObject({ toolHome: { CLAUDE_CONFIG_DIR: home }, unset: expect.arrayContaining(['DEPLOY_TOKEN', 'GITHUB_TOKEN']), credentials: [] });
      expect(fs.statSync(home).isDirectory()).toBe(true);
      fs.writeFileSync(calls, '');

      const resumed = await runCLI(['workflow', 'resume', runId, '--driver', 'throughhome'], repo, env(tokensAndDeploy));

      expect(envelope(resumed), resumed.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      expect(asked().filter((call) => call.type === 'reattach')).toMatchObject([{ toy: 'outer', credentials: [], unset: expect.arrayContaining(['DEPLOY_TOKEN', 'GITHUB_TOKEN']) }, { toy: 'inner' }]);
    });

    /** The places a toy's journal still holds, by `<run>/<attempt>`. */
    const placesOf = (dir: string): Record<string, string> => (fs.existsSync(path.join(dir, 'handles.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'handles.json'), 'utf8')) as Record<string, string> : {});
    /** Each request the toys were asked, as `<toy> <type>`. */
    const steps = (): string[] => asked().map(({ toy, type }) => `${toy} ${type}`);

    /** Starts `oneprompt` on `driver`, whose toy kills it; answers the run and the attempt the toy in `state` journaled. */
    const killedStart = async (driver: string, journal: string): Promise<{ runId: string; attempt: string }> => {
      const killed = await runCLI(['workflow', 'start', 'oneprompt', '--driver', driver], repo, env(tokens));
      expect(killed.signal, killed.stderr).toBe('SIGKILL');
      const [runId = '', attempt = ''] = Object.keys(placesOf(journal))[0]?.split('/') ?? [];
      fs.writeFileSync(calls, '');

      return { runId, attempt };
    };

    it('stops a composed attempt a killed teamai left, closing the inner place and then the outer, when the run is cancelled', async () => {
      throughDefinition('throughcancel', { die_at: 'prompt-finished' });
      const { runId, attempt } = await killedStart('throughcancel', innerState);

      const cancelled = await runCLI(['workflow', 'cancel', runId], repo, env(tokens));

      expect(cancelled.stderr).toContain(`Stopped attempt ${attempt} of run ${runId} on step runtime "toy through sandboxtoy" and closed its place.`);
      expect(steps().filter((step) => step.endsWith('close'))).toEqual(['inner close', 'outer close']);
      expect([placesOf(innerState), placesOf(outerState)]).toEqual([{}, {}]);
      expect(runtimeRecord(runId, attempt)).toMatchObject({ phase: 'closed' });
    });

    it('keeps the outer place of a composed attempt whose inner place teamai never recorded, and says so, until the person releases it', async () => {
      throughDefinition('throughinner', { die_at: 'open-accepted' });
      const { runId, attempt } = await killedStart('throughinner', innerState);

      const cancelled = await runCLI(['workflow', 'cancel', runId], repo, env(tokens));

      expect(cancelled.stderr).toContain(`Could not stop attempt ${attempt} of run ${runId}`);
      expect(cancelled.stderr).toContain(`teamai workflow cancel ${runId} --release ${attempt}`);
      expect(steps()).not.toContain('outer close');
      expect(Object.keys(placesOf(outerState))).toEqual([`${runId}/${attempt}`]);
      expect(runtimeRecord(runId, attempt)?.phase).not.toBe('closed');

      const released = await runCLI(['workflow', 'cancel', runId, '--release', attempt], repo, env(tokens));

      expect(released.stderr).toContain(`Released attempt ${attempt} of run ${runId}`);
      expect(steps()).toContain('outer close');
      expect(placesOf(outerState)).toEqual({});
      expect(runtimeRecord(runId, attempt)).toMatchObject({ phase: 'closed' });
    });

    it('says it cannot confirm the place of an attempt whose handle teamai never recorded, and keeps it until the person releases it', async () => {
      writeDefinition('throughouter', [{
        use: 'toy', through: 'sandboxtoy',
        options: {
          toy: { state: innerState, calls, agent: { output: { ok: true } }, credentials: { APP_TOKEN: 'env:MEMBER_APP_TOKEN' } },
          sandboxtoy: { state: outerState, calls, die_at: 'open-accepted', can: { isolation: 'sandbox' }, credentials: { CLAUDE_CODE_OAUTH_TOKEN: 'env:MEMBER_CLAUDE_TOKEN' } },
        },
      }]);
      const { runId, attempt } = await killedStart('throughouter', outerState);

      const cancelled = await runCLI(['workflow', 'cancel', runId], repo, env(tokens));

      expect(cancelled.stderr).toContain(`Could not stop attempt ${attempt} of run ${runId}`);
      expect(cancelled.stderr).not.toContain('closed its place');
      expect(Object.keys(placesOf(outerState))).toEqual([`${runId}/${attempt}`]);
      expect(runtimeRecord(runId, attempt)).toMatchObject({ phase: 'opening' });

      const released = await runCLI(['workflow', 'cancel', runId, '--release', attempt], repo, env(tokens));

      expect(released.stderr).toContain(`Released attempt ${attempt} of run ${runId}`);
      expect(runtimeRecord(runId, attempt)).toMatchObject({ phase: 'closed' });
    });
  });
});
