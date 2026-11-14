import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveProjectDataHome } from '../../config.js';
import type { RunState } from '../../workflow/types.js';
import { hasPython, TYPED_TERMINAL } from '../helpers/in-terminal.js';
import { folderRevision } from '../../workflow/runtimes/resource-folder.js';
import { installToyRuntime, TOY_RUNTIME, TOY_RUNTIME_MARKER } from '../helpers/toy-runtime.js';
import { attemptOf, CLAUDE_SESSIONS, CLI, CODEBUDDY_SESSIONS, envelope, fakeTool, runCLI, type Ran } from '../helpers/step-runtime-e2e.js';
import { signalPid } from '@teamai/shared/process-group';

/** Whether `record`, an attempt's runtime.json, says the attempt ran in teamai's process. */
const isInProcessRecord = (record: unknown): boolean => typeof record === 'object' && record !== null && 'inProcess' in record && record.inProcess === true;

describe('workflow steps on a step runtime a driver definition chooses', () => {
  let sandbox: string;
  let repo: string;
  let bin: string;
  let launches: string;
  let dataHome: string;

  const env = (): NodeJS.ProcessEnv => ({ PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, LAUNCHES: launches });

  const writeDefinition = (name: string, options: Record<string, string>, { use = 'toy', dir = path.join(repo, '.teamai', 'drivers') } = {}): void => {
    fs.mkdirSync(dir, { recursive: true });
    const lines = Object.entries(options).map(([key, value]) => `      ${key}: ${JSON.stringify(value)}`);
    fs.writeFileSync(path.join(dir, `${name}.yaml`), [
      'schemaVersion: v1alpha1', `name: ${name}`, 'tool: claude', 'runtimes:', `  - use: ${use}`, ...(lines.length > 0 ? ['    options:', ...lines] : []), '',
    ].join('\n'));
  };

  /** A team runtime: the toy behind a script that notes each spawn in `spawns`. */
  const writeTeamRuntime = (relative: string, spawns: string): string => {
    const dir = path.join(repo, '.teamai', 'runtimes', relative);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'runtime'), `#!/bin/sh\necho spawned >> "${spawns}"\nexec "${process.execPath}" "${TOY_RUNTIME}" "$@"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'RUNTIME.yaml'), TOY_RUNTIME_MARKER);
    return dir;
  };

  const runtimeRecords = (runId: string): Array<Record<string, unknown>> => fs.readdirSync(attemptsOf(runId))
    .map((attempt) => JSON.parse(fs.readFileSync(path.join(attemptsOf(runId), attempt, 'runtime.json'), 'utf8')) as Record<string, unknown>);

  const startedRun = (ran: Ran): string => {
    const id = /Run (r[0-9a-f]+) started/.exec(ran.stderr)?.[1];
    if (id === undefined) throw new Error(`no run started:\n${ran.stdout}\n${ran.stderr}`);
    return id;
  };

  /** The id of the run `ran` finished, which must have succeeded. */
  const succeededRun = (ran: Ran): string => {
    const done = envelope(ran);
    expect(done, ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const run = 'data' in done && typeof done.data.done === 'object' && done.data.done !== null && 'run' in done.data.done ? done.data.done.run : undefined;
    if (typeof run !== 'string') throw new Error(`no run in the envelope:\n${ran.stdout}`);
    return run;
  };

  /** The open operations the toy with state `state` recorded: one per attempt it opened, however often it was asked. */
  const toyOpens = (state: string): Array<{ handle: string }> => fs.readdirSync(path.join(state, 'ops'))
    .map((name) => JSON.parse(fs.readFileSync(path.join(state, 'ops', name), 'utf8')) as { kind: string; handle: string })
    .filter((op) => op.kind === 'open');

  const readRunState = (runId: string): RunState => JSON.parse(fs.readFileSync(path.join(dataHome, 'workflows', 'runs', `${runId}.json`), 'utf8')) as RunState;
  const attemptsOf = (runId: string): string => path.join(dataHome, 'workflows', 'runs', runId, 'attempts');

  beforeAll(async () => {
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-step-runtime-e2e-')));
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
    // Then a bare origin on disk, so a step's branch is pushed.
    const origin = path.join(sandbox, 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    execFileSync('git', ['remote', 'set-url', 'origin', origin], { cwd: repo });
    execFileSync('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: repo });
    fs.writeFileSync(path.join(bin, 'claude'), fakeTool({ tool: 'claude', version: '2.1.0 (Claude Code)', homeVariable: 'CLAUDE_CONFIG_DIR', sessions: CLAUDE_SESSIONS }));
    fs.chmodSync(path.join(bin, 'claude'), 0o755);
    fs.writeFileSync(path.join(bin, 'codebuddy'), fakeTool({ tool: 'codebuddy', version: '2.179.1', homeVariable: 'CODEBUDDY_CONFIG_DIR', sessions: CODEBUDDY_SESSIONS }));
    fs.chmodSync(path.join(bin, 'codebuddy'), 0o755);
    // The toy is the member's own runtime here, which runs without acceptance.
    const runtimeDir = path.join(os.homedir(), '.teamai', 'runtimes', 'toy');
    fs.mkdirSync(runtimeDir, { recursive: true });
    installToyRuntime(runtimeDir);
    const workflows = path.join(repo, '.teamai', 'workflows');
    fs.mkdirSync(workflows, { recursive: true });
    fs.writeFileSync(path.join(workflows, 'toyflow.yaml'), `schemaVersion: v1alpha1
name: toyflow
description: A command step and two prompt steps, the second resuming the first's session.
steps:
  - id: prepare
    command: node -e "process.stdout.write(JSON.stringify({ready:true}))"
    output:
      ready: boolean
  - id: review
    needs: [prepare]
    prompt: Review the repository without changing it.
    scorers: [quality]
    output:
      ok: boolean
  - id: followup
    needs: [review]
    session: { from: review }
    prompt: Follow up on the review.
    output:
      ok: boolean
`);
    const flows: Record<string, string> = {
      onecommand: `  - id: build
    command: node -e "require('fs').appendFileSync(process.env.RUNS_FILE, 'x'); process.stdout.write(JSON.stringify({built:true}))"
    output:
      built: boolean`,
      oneprompt: `  - id: review
    prompt: Review the repository without changing it.
    output:
      ok: boolean`,
      tworundirs: `  - id: first
    command: node -e "require('fs').appendFileSync(process.env.RUNS_FILE, process.env.TEAMAI_RUN_DIR + '\\n')"
  - id: second
    needs: [first]
    command: node -e "require('fs').appendFileSync(process.env.RUNS_FILE, process.env.TEAMAI_RUN_DIR + '\\n')"`,
      buddyprompt: `  - id: review
    tool: codebuddy
    prompt: Review the repository without changing it.
    scorers: [quality]
    output:
      ok: boolean`,
      failwork: `  - id: build
    workspace: new
    command: run=\${TEAMAI_WORKFLOW_ATTEMPT%%/*}; if git fetch -q origin "teamai/$run/build/p1" && test "$(git show FETCH_HEAD:work.txt)" = kept; then echo found; else echo kept > work.txt; exit 1; fi`,
      planthook: `  - id: build
    workspace: new
    command: git config extensions.worktreeConfig true && git config --worktree core.hooksPath "$PLANTED_HOOKS" && echo change > planted.txt`,
      turned: `  - id: review
    timeout: 10m
    on_limit: end_turn
    prompt: Review the repository without changing it.
    output:
      ok: boolean`,
      timed: `  - id: build
    timeout: 10m
    command: echo built
  - id: untimed
    needs: [build]
    command: echo built`,
      sleeper: `  - id: wait
    command: sleep 60 & echo $! > "$CHILD_PID"; wait`,
      rundir: `  - id: note
    command: echo kept > "$TEAMAI_RUN_DIR/from-the-place"
  - id: check
    needs: [note]
    command: test "$(cat "$TEAMAI_RUN_DIR/from-the-place")" = kept && echo '{"kept":true}'
    output:
      kept: boolean`,
      scored: `  - id: review
    prompt: Review the repository without changing it.
    scorers: [always]
    output:
      ok: boolean`,
    };
    for (const [name, steps] of Object.entries(flows)) {
      fs.writeFileSync(path.join(workflows, `${name}.yaml`), `schemaVersion: v1alpha1\nname: ${name}\ndescription: ${name}\nsteps:\n${steps}\n`);
    }
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
    // Judged on every pass, so the pass's own drive starts its teamai-score run.
    fs.writeFileSync(path.join(repo, '.teamai', 'scorers', 'always.md'), `---
labels:
  - { value: good, score: 1, description: Finds the real defects }
  - { value: missed, score: 0, description: Misses a real defect }
passingScore: 0.5
samplingRate: 100
---
Judge the review.
`);
    const pulled = await runCLI(['pull'], repo);
    expect(pulled.code, `${pulled.stdout}\n${pulled.stderr}`).toBe(0);
    dataHome = await resolveProjectDataHome(repo);
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('runs a command step and prompt steps on the toy runtime, each prompt in its attempt\'s tool home, the next resuming from a seeded copy', async () => {
    writeDefinition('toyd', { state: path.join(sandbox, 'toy-state-1') });
    fs.rmSync(launches, { force: true });

    const ran = await runCLI(['workflow', 'start', 'toyflow', '--driver', 'toyd'], repo, env());

    const runId = succeededRun(ran);
    const stored = readRunState(runId);
    expect(stored.steps.map((step) => [step.id, step.status])).toEqual([['prepare', 'succeeded'], ['review', 'succeeded'], ['followup', 'succeeded']]);
    expect(stored.steps[0]).toMatchObject({ outputs: { ready: true } });
    expect(stored.steps[1]).toMatchObject({ tool: 'claude', session: `sess-${attemptOf(stored.steps[1])}`, outputs: { ok: true } });
    // The follow-up resumed the review's session, from a copy of the review's tool home in its own.
    expect(stored.steps[2]).toMatchObject({ session: `sess-${attemptOf(stored.steps[1])}` });

    const records = fs.readdirSync(attemptsOf(runId)).map((attempt) => JSON.parse(fs.readFileSync(path.join(attemptsOf(runId), attempt, 'runtime.json'), 'utf8')) as Record<string, unknown>);
    expect(records).toHaveLength(3);
    for (const record of records) expect(record).toMatchObject({ runtime: 'toy', driver: 'toyd', phase: 'closed' });

    const launched = fs.readFileSync(launches, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { home: string; resumed?: string; sessionFoundBefore: boolean });
    const reviewAttempt = attemptOf(stored.steps[1]);
    const followupAttempt = attemptOf(stored.steps[2]);
    expect(launched).toEqual([
      { home: path.join(attemptsOf(runId), reviewAttempt, 'tool-home', 'claude'), sessionFoundBefore: false, secret: null },
      { home: path.join(attemptsOf(runId), followupAttempt, 'tool-home', 'claude'), resumed: `sess-${reviewAttempt}`, sessionFoundBefore: true, secret: null },
    ]);
    // Each prompt's result came back through the attempt's out/ directory.
    expect(fs.existsSync(path.join(attemptsOf(runId), reviewAttempt, 'out', 'result.json'))).toBe(true);
    // The command's place was opened naming no tool, and each prompt's naming the tool it runs.
    const opened = fs.readdirSync(path.join(sandbox, 'toy-state-1', 'ops')).map((name) => JSON.parse(fs.readFileSync(path.join(sandbox, 'toy-state-1', 'ops', name), 'utf8')) as { kind: string; tool?: string | null })
      .filter((op) => op.kind === 'open').map((op) => op.tool).sort();
    expect(opened).toEqual(['claude', 'claude', null]);

    // Scoring reads the review's session from its attempt's tool home: the member's own store has none.
    const scored = await runCLI(['score', '--run', runId, '--step', 'review', '--scorer', 'quality'], repo, env());
    expect(envelope(scored), scored.stderr).toMatchObject({ data: { label: { scorer: 'quality', label: 'good' } } });
  });

  it('runs a CodeBuddy prompt step on the toy runtime with CODEBUDDY_CONFIG_DIR set to its attempt\'s tool home', async () => {
    writeDefinition('toybuddy', { state: path.join(sandbox, 'toy-state-buddy') });
    fs.rmSync(launches, { force: true });

    const ran = await runCLI(['workflow', 'start', 'buddyprompt', '--driver', 'toybuddy'], repo, env());

    const runId = succeededRun(ran);
    const [review] = readRunState(runId).steps;
    expect(review).toMatchObject({ tool: 'codebuddy', session: `sess-${attemptOf(review)}`, outputs: { ok: true } });
    const launched = fs.readFileSync(launches, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { home: string });
    expect(launched).toEqual([{ home: path.join(attemptsOf(runId), attemptOf(review), 'tool-home', 'codebuddy'), sessionFoundBefore: false, secret: null }]);

    // Scoring reads the step's session from its attempt's CodeBuddy home: the member's own store has none.
    const scored = await runCLI(['score', '--run', runId, '--step', 'review', '--scorer', 'quality'], repo, env());
    expect(envelope(scored), scored.stderr).toMatchObject({ data: { label: { scorer: 'quality', label: 'good' } } });
  });

  it('resumes on the same handle after teamai is killed once the runtime accepted open, before it wrote the handle', async () => {
    const state = path.join(sandbox, 'toy-state-open');
    const runs = path.join(sandbox, 'runs-open');
    writeDefinition('toyopen', { state, die_at: 'open-accepted' });

    const killed = await runCLI(['workflow', 'start', 'onecommand', '--driver', 'toyopen'], repo, { ...env(), RUNS_FILE: runs });
    expect(killed.signal, killed.stderr).toBe('SIGKILL');
    const runId = startedRun(killed);
    const [attempt] = fs.readdirSync(attemptsOf(runId));
    expect(JSON.parse(fs.readFileSync(path.join(attemptsOf(runId), String(attempt), 'runtime.json'), 'utf8'))).toMatchObject({ phase: 'opening', open: { op: expect.any(String) } });

    const resumed = await runCLI(['workflow', 'resume', runId, '--driver', 'toyopen'], repo, { ...env(), RUNS_FILE: runs });

    expect(envelope(resumed), resumed.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const [opened] = toyOpens(state);
    expect(toyOpens(state)).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(attemptsOf(runId), String(attempt), 'runtime.json'), 'utf8'))).toMatchObject({ open: { handle: opened?.handle }, phase: 'closed' });
    expect(fs.readFileSync(runs, 'utf8')).toBe('x');
  });

  it('resumes on the definition the run was started with when the printed resume command names none', async () => {
    const state = path.join(sandbox, 'toy-state-recorded');
    const runs = path.join(sandbox, 'runs-recorded');
    writeDefinition('toyrecorded', { state, die_at: 'open-accepted' });

    const killed = await runCLI(['workflow', 'start', 'onecommand', '--driver', 'toyrecorded'], repo, { ...env(), RUNS_FILE: runs });
    expect(killed.signal, killed.stderr).toBe('SIGKILL');
    const runId = startedRun(killed);
    expect(killed.stderr).toContain(`continue it here with: teamai workflow resume ${runId}, or hand it to another machine with: teamai workflow publish ${runId}\n`);

    const resumed = await runCLI(['workflow', 'resume', runId], repo, { ...env(), RUNS_FILE: runs });

    expect(envelope(resumed), resumed.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(fs.readFileSync(runs, 'utf8')).toBe('x');
    const [attempt] = fs.readdirSync(attemptsOf(runId));
    expect(toyOpens(state)).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(attemptsOf(runId), String(attempt), 'runtime.json'), 'utf8'))).toMatchObject({ runtime: 'toy', driver: 'toyrecorded', phase: 'closed' });
  });

  it('spells the run directory one way in every process of a run, whatever spelling of HOME each one has', async () => {
    const runs = path.join(sandbox, 'runs-rundirs');
    writeDefinition('toyrundirs', { state: path.join(sandbox, 'toy-state-rundirs'), die_at: 'exec-exited' });
    // The start sees the member's home through a link, as a shell that keeps /tmp does on macOS; the resume does not.
    const linkedHome = path.join(sandbox, 'home-link');
    fs.symlinkSync(os.homedir(), linkedHome);

    const killed = await runCLI(['workflow', 'start', 'tworundirs', '--driver', 'toyrundirs'], repo, { ...env(), RUNS_FILE: runs, HOME: linkedHome });
    expect(killed.signal, killed.stderr).toBe('SIGKILL');
    const resumed = await runCLI(['workflow', 'resume', startedRun(killed)], repo, { ...env(), RUNS_FILE: runs });

    expect(envelope(resumed), resumed.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const [started, again] = fs.readFileSync(runs, 'utf8').trim().split('\n');
    expect(again).toBe(started);
  });

  it('refuses to resume a run whose recorded definition no longer resolves, naming it and how to go on', async () => {
    const state = path.join(sandbox, 'toy-state-gone');
    writeDefinition('toygone', { state, die_at: 'open-accepted' });
    const killed = await runCLI(['workflow', 'start', 'onecommand', '--driver', 'toygone'], repo, { ...env(), RUNS_FILE: path.join(sandbox, 'runs-gone') });
    const runId = startedRun(killed);
    fs.rmSync(path.join(repo, '.teamai', 'drivers', 'toygone.yaml'));

    const resumed = await runCLI(['workflow', 'resume', runId], repo, env());

    expect(envelope(resumed)).toMatchObject({ error: { code: 'driver_not_found', message: expect.stringContaining('toygone') } });
  });

  describe('a definition whose only runtime is the toy, on a host with no agent CLI', () => {
    /** PATH for teamai with no agent CLI: teamai, node and git only, and the system's own directories. */
    let hostPath: string;

    const judgeOffer = [{ level: 'best-effort', access: 'read', tools: ['claude'] }];

    type ToyPrompt = { op: string; sent?: { step: string }; confined?: { dir: string; level: string; access: string }; sees?: string[] };

    const toyPrompts = (state: string): ToyPrompt[] => (fs.existsSync(path.join(state, 'prompts.jsonl'))
      ? fs.readFileSync(path.join(state, 'prompts.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as ToyPrompt)
      : []);

    const toyOpenViews = (state: string): unknown[] => fs.readdirSync(path.join(state, 'ops'))
      .map((name) => JSON.parse(fs.readFileSync(path.join(state, 'ops', name), 'utf8')) as { kind: string; view?: unknown })
      .filter((op) => op.kind === 'open').map((op) => op.view);

    beforeAll(() => {
      const hostBin = path.join(sandbox, 'host-bin');
      fs.mkdirSync(hostBin);
      fs.symlinkSync(process.execPath, path.join(hostBin, 'node'));
      for (const tool of ['git', 'teamai']) fs.symlinkSync(execFileSync('which', [tool], { encoding: 'utf8' }).trim(), path.join(hostBin, tool));
      hostPath = [hostBin, '/usr/bin', '/bin'].join(path.delimiter);
    });

    it('judges a scored pass on the toy, in a place with no view, reading only its evidence, and writes the label', async () => {
      const state = path.join(sandbox, 'toy-state-judge');
      writeDefinition('toyjudge', {});
      // The toy runs the scored prompt's claude from its own tools, and answers the judge itself.
      fs.writeFileSync(path.join(repo, '.teamai', 'drivers', 'toyjudge.yaml'), [
        'schemaVersion: v1alpha1', 'name: toyjudge', 'tool: claude', 'runtimes:', '  - use: toy', '    options:',
        `      state: ${JSON.stringify(state)}`, `      path: ${JSON.stringify(bin)}`,
        '      judge: { reply: { answer: { label: good, reasoning: "read it" } } }', '',
      ].join('\n'));

      const ran = await runCLI(['workflow', 'start', 'scored', '--driver', 'toyjudge'], repo, { PATH: hostPath, LAUNCHES: launches });

      succeededRun(ran);
      expect(ran.stderr).toMatch(/teamai-score run r[0-9a-f]+/);
      const scoring = String(/teamai-score run (r[0-9a-f]+)/.exec(ran.stderr)?.[1]);
      const { steps } = readRunState(scoring);
      expect(ran.stderr, JSON.stringify(steps.filter((step) => step.status !== 'succeeded').map((step) => [step.id, step.status, 'failure' in step ? step.failure : undefined]))).toContain(`: always good (teamai-score run ${scoring})`);
      const judge = steps.find((step) => step.id.endsWith('.judge'));
      expect(judge).toMatchObject({ status: 'succeeded', confined: { tool: 'claude', isolation: 'best-effort', access: 'read' } });
      const judgeRecord = path.join(attemptsOf(scoring), attemptOf(judge), 'runtime.json');
      expect(JSON.parse(fs.readFileSync(judgeRecord, 'utf8'))).toMatchObject({ runtime: 'toy', driver: 'toyjudge', phase: 'closed' });
      // teamai's own steps ran on the host: each record of one says it ran in teamai's process, and only the judge has a
      // step runtime's record.
      const recordOf = (step: (typeof steps)[number]): unknown => {
        const file = path.join(attemptsOf(scoring), attemptOf(step), 'runtime.json');

        return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined;
      };
      const onRuntime = steps.filter((step) => 'attempt' in step && recordOf(step) !== undefined && !isInProcessRecord(recordOf(step))).map((step) => step.id);
      expect(onRuntime).toEqual([judge?.id]);
      // The judge's place was opened with no view of the host, and its agent read only the evidence directory.
      expect(toyOpenViews(state)).toContain(null);
      const [judged, ...more] = toyPrompts(state).filter((line) => line.confined !== undefined);
      expect(more).toEqual([]);
      expect(judged).toMatchObject({ confined: { level: 'best-effort', access: 'read' } });
      expect(judged?.sees).toEqual(expect.arrayContaining(['evidence.json']));
      expect(judged?.sees?.every((name) => !name.startsWith('..'))).toBe(true);
    });

    it('sends the judge only the credentials its tool reads, of those the definition declares', async () => {
      const state = path.join(sandbox, 'toy-state-judgecreds');
      fs.mkdirSync(path.join(repo, '.teamai', 'drivers'), { recursive: true });
      fs.writeFileSync(path.join(repo, '.teamai', 'drivers', 'toyjudgecreds.yaml'), [
        'schemaVersion: v1alpha1', 'name: toyjudgecreds', 'tool: claude', 'runtimes:', '  - use: toy', '    options:',
        `      state: ${JSON.stringify(state)}`, `      path: ${JSON.stringify(bin)}`,
        '      credentials: { ANTHROPIC_API_KEY: "env:MEMBER_ANTHROPIC_KEY", OPENAI_API_KEY: "env:MEMBER_OPENAI_KEY" }',
        '      judge: { reply: { answer: { label: good, reasoning: "read it" } } }', '',
      ].join('\n'));

      const ran = await runCLI(['workflow', 'start', 'scored', '--driver', 'toyjudgecreds'], repo, { PATH: hostPath, LAUNCHES: launches, MEMBER_ANTHROPIC_KEY: 'anthropic-test-key', MEMBER_OPENAI_KEY: 'openai-test-key' });

      succeededRun(ran);
      const scoring = String(/teamai-score run (r[0-9a-f]+)/.exec(ran.stderr)?.[1]);
      const judge = readRunState(scoring).steps.find((step) => step.id.endsWith('.judge'));
      expect(judge).toMatchObject({ status: 'succeeded', confined: { tool: 'claude' } });
      const noted = fs.readFileSync(path.join(state, 'credentials.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { type: string; handle: string; names: string[] });
      // The toy knew at init the names it was given, so it could offer only the judges it can sign in.
      expect(noted.filter((line) => line.type === 'init')).toContainEqual({ type: 'init', names: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'], logins: [] });
      // A claude judge reads ANTHROPIC_API_KEY, never OPENAI_API_KEY: its place and its prompt get claude's alone.
      expect(noted.filter((line) => line.handle === `toy-${scoring}-${attemptOf(judge)}`).map(({ type, names }) => ({ type, names })))
        .toEqual([{ type: 'open', names: ['ANTHROPIC_API_KEY'] }, { type: 'prompt', names: ['ANTHROPIC_API_KEY'] }]);
    });

    it('sends the judge the proxy and gateway variables the definition declares, as a confined run here passes them', async () => {
      const state = path.join(sandbox, 'toy-state-judgeproxy');
      fs.mkdirSync(path.join(repo, '.teamai', 'drivers'), { recursive: true });
      fs.writeFileSync(path.join(repo, '.teamai', 'drivers', 'toyjudgeproxy.yaml'), [
        'schemaVersion: v1alpha1', 'name: toyjudgeproxy', 'tool: claude', 'runtimes:', '  - use: toy', '    options:',
        `      state: ${JSON.stringify(state)}`, `      path: ${JSON.stringify(bin)}`,
        '      credentials: { ANTHROPIC_API_KEY: "env:MEMBER_ANTHROPIC_KEY", ANTHROPIC_BASE_URL: "env:MEMBER_GATEWAY", HTTPS_PROXY: "env:MEMBER_PROXY", NO_PROXY: "env:MEMBER_NO_PROXY", OPENAI_API_KEY: "env:MEMBER_OPENAI_KEY" }',
        '      judge: { reply: { answer: { label: good, reasoning: "read it" } } }', '',
      ].join('\n'));

      const ran = await runCLI(['workflow', 'start', 'scored', '--driver', 'toyjudgeproxy'], repo, {
        PATH: hostPath, LAUNCHES: launches, MEMBER_ANTHROPIC_KEY: 'anthropic-test-key', MEMBER_GATEWAY: 'https://llm-gateway.acme.test', MEMBER_PROXY: 'http://proxy.acme.test:3128', MEMBER_NO_PROXY: 'localhost,.acme.test', MEMBER_OPENAI_KEY: 'openai-test-key',
      });

      succeededRun(ran);
      const scoring = String(/teamai-score run (r[0-9a-f]+)/.exec(ran.stderr)?.[1]);
      const judge = readRunState(scoring).steps.find((step) => step.id.endsWith('.judge'));
      const noted = fs.readFileSync(path.join(state, 'credentials.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { type: string; handle: string; names: string[] });
      // A claude judge here gets the proxies with claude's own variables, and still no OpenAI key.
      const claudeNames = ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'HTTPS_PROXY', 'NO_PROXY'];
      expect(noted.filter((line) => line.handle === `toy-${scoring}-${attemptOf(judge)}`).map(({ type, names }) => ({ type, names })))
        .toEqual([{ type: 'open', names: claudeNames }, { type: 'prompt', names: claudeNames }]);
    });

    it('never leases the judge to a toy that offers can.confined without saying it answers confined prompts', async () => {
      const state = path.join(sandbox, 'toy-state-nojudge');
      fs.writeFileSync(path.join(repo, '.teamai', 'drivers', 'toynojudge.yaml'), [
        'schemaVersion: v1alpha1', 'name: toynojudge', 'tool: claude', 'runtimes:', '  - use: toy', '    options:',
        `      state: ${JSON.stringify(state)}`, `      path: ${JSON.stringify(bin)}`, `      can: { confined: ${JSON.stringify(judgeOffer)} }`, '',
      ].join('\n'));

      const ran = await runCLI(['workflow', 'start', 'scored', '--driver', 'toynojudge'], repo, { PATH: hostPath, LAUNCHES: launches });

      succeededRun(ran);
      expect(ran.stderr).toMatch(/is not labelled yet \(confined_pending\)/);
      expect(toyPrompts(state).filter((line) => line.confined !== undefined)).toEqual([]);
      expect(toyOpenViews(state)).not.toContain(null);
    });
  });

  it('gives a place the run\'s scratch directory read-write, where $TEAMAI_RUN_DIR of its exec points', async () => {
    const state = path.join(sandbox, 'toy-state-rundir');
    writeDefinition('toyrundir', { state });

    const ran = await runCLI(['workflow', 'start', 'rundir', '--driver', 'toyrundir'], repo, env());

    const runId = succeededRun(ran);
    const scratch = path.join(dataHome, 'workflows', 'runs', runId, 'scratch');
    const views = fs.readdirSync(path.join(state, 'ops')).map((name) => JSON.parse(fs.readFileSync(path.join(state, 'ops', name), 'utf8')) as { kind: string; view?: { runDir?: string } })
      .filter((op) => op.kind === 'open').map((op) => op.view);
    expect(views).toEqual([expect.objectContaining({ runDir: scratch }), expect.objectContaining({ runDir: scratch })]);
    // One exec wrote there, and the next read it back.
    expect(readRunState(runId).steps.find((step) => step.id === 'check')).toMatchObject({ status: 'succeeded', outputs: { kept: true } });
    expect(runtimeRecords(runId).map((record) => record.runtime)).toEqual(['toy', 'toy']);
  });

  it('reports the output, session and usage of an exec that finished while teamai was killed, without running it again', async () => {
    writeDefinition('toyexec', { state: path.join(sandbox, 'toy-state-exec'), die_at: 'exec-exited' });
    fs.rmSync(launches, { force: true });

    const killed = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'toyexec'], repo, env());
    expect(killed.signal, killed.stderr).toBe('SIGKILL');
    const runId = startedRun(killed);

    const resumed = await runCLI(['workflow', 'resume', runId, '--driver', 'toyexec'], repo, env());

    expect(envelope(resumed), resumed.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const [review] = readRunState(runId).steps;
    expect(review).toMatchObject({ status: 'succeeded', session: `sess-${attemptOf(review)}`, model: 'fake-claude', outputs: { ok: true }, tokens: { input: 4, output: 2 } });
    expect(fs.readFileSync(launches, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('commits and pushes a failed step\'s work, which its retry reads from the failed pass\'s branch', async () => {
    writeDefinition('toyretry', { state: path.join(sandbox, 'toy-state-retry') });

    const failed = await runCLI(['workflow', 'start', 'failwork', '--driver', 'toyretry'], repo, env());
    expect(envelope(failed), failed.stderr).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const runId = startedRun(failed);
    const retried = await runCLI(['workflow', 'retry', runId, 'build'], repo, env());
    expect(retried.code, retried.stderr).toBe(0);

    const resumed = await runCLI(['workflow', 'resume', runId, '--driver', 'toyretry'], repo, env());

    expect(envelope(resumed), resumed.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
  });

  it('does not run a hook the step planted in config.worktree while it commits the step\'s work', async () => {
    writeDefinition('toyhook', { state: path.join(sandbox, 'toy-state-hook') });
    const hooks = path.join(sandbox, 'planted-hooks');
    const mark = path.join(sandbox, 'hook-ran');
    fs.mkdirSync(hooks, { recursive: true });
    for (const hook of ['pre-commit', 'commit-msg', 'post-commit', 'pre-push']) {
      fs.writeFileSync(path.join(hooks, hook), `#!/bin/sh\necho ${hook} >> "${mark}"\n`, { mode: 0o755 });
    }

    const ran = await runCLI(['workflow', 'start', 'planthook', '--driver', 'toyhook'], repo, { ...env(), PLANTED_HOOKS: hooks });

    expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const [build] = readRunState(String(startedRun(ran))).steps;
    expect(build).toMatchObject({ status: 'succeeded', changes: { commits: [expect.any(String)] } });
    expect(fs.existsSync(mark)).toBe(false);
  });

  it('shows a runtime\'s notices to the person while the step runs, with a credential it echoes masked', async () => {
    fs.mkdirSync(path.join(repo, '.teamai', 'drivers'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.teamai', 'drivers', 'toynotice.yaml'), [
      'schemaVersion: v1alpha1', 'name: toynotice', 'tool: claude', 'runtimes:', '  - use: toy', '    options:',
      `      state: ${JSON.stringify(path.join(sandbox, 'toy-state-notice'))}`,
      '      credentials: { ANTHROPIC_API_KEY: "env:MEMBER_ANTHROPIC_KEY" }',
      '      notice: { init: "Signed in to the toy as al.", open: "The key {ANTHROPIC_API_KEY} expires tomorrow." }', '',
    ].join('\n'));

    const ran = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'toynotice'], repo, { ...env(), MEMBER_ANTHROPIC_KEY: 'sk-ant-api03-notice-7f3a91c2e5' });

    succeededRun(ran);
    expect(ran.stderr).toContain('Step runtime "toy": Signed in to the toy as al.');
    expect(ran.stderr).toMatch(/Step runtime "toy", operation op-[0-9a-f]+: The key <REDACTED:ANTHROPIC_API_KEY \(credential of toy\)> expires tomorrow\./);
    expect(ran.stderr).not.toContain('sk-ant-api03-notice-7f3a91c2e5');
  });

  it('tells the runtime the latest time a step\'s timeout lets its place run, and no time for a step without one', async () => {
    const state = path.join(sandbox, 'toy-state-timed');
    writeDefinition('toytimed', { state });
    const before = Date.now();

    const ran = await runCLI(['workflow', 'start', 'timed', '--driver', 'toytimed'], repo, env());

    succeededRun(ran);
    const opens = fs.readdirSync(path.join(state, 'ops')).map((name) => JSON.parse(fs.readFileSync(path.join(state, 'ops', name), 'utf8')) as { kind: string; deadline?: string | null })
      .filter((op) => op.kind === 'open').map((op) => op.deadline ?? null);
    const deadline = opens.find((at): at is string => at !== null);
    expect(opens.filter((at) => at === null)).toHaveLength(1);
    expect(Date.parse(String(deadline)) - before).toBeGreaterThan(9 * 60_000);
    expect(Date.parse(String(deadline)) - Date.now()).toBeLessThanOrEqual(10 * 60_000);
  });

  it('gives no deadline to a step whose timeout ends the agent\'s turn, since the driver ends that turn itself', async () => {
    const state = path.join(sandbox, 'toy-state-turned');
    writeDefinition('toyturned', { state });

    const ran = await runCLI(['workflow', 'start', 'turned', '--driver', 'toyturned'], repo, env());

    succeededRun(ran);
    const opens = fs.readdirSync(path.join(state, 'ops')).map((name) => JSON.parse(fs.readFileSync(path.join(state, 'ops', name), 'utf8')) as { kind: string; deadline?: string | null })
      .filter((op) => op.kind === 'open').map((op) => op.deadline ?? null);
    expect(opens).toEqual([null]);
  });

  it('cancels a running step with the processes it started', async () => {
    writeDefinition('toycancel', { state: path.join(sandbox, 'toy-state-cancel') });
    const pidFile = path.join(sandbox, 'sleeper.pid');

    const running = runCLI(['workflow', 'start', 'sleeper', '--driver', 'toycancel'], repo, { ...env(), CHILD_PID: pidFile });
    const deadline = Date.now() + 30_000;
    while (!(fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    const child = Number(fs.readFileSync(pidFile, 'utf8').trim());
    const runs = fs.readdirSync(path.join(dataHome, 'workflows', 'runs')).filter((name) => name.endsWith('.json')).map((name) => name.replace(/\.json$/, ''));
    const runId = runs.find((id) => readRunState(id).name === 'sleeper');
    expect(runId).toBeDefined();

    const cancelled = await runCLI(['workflow', 'cancel', String(runId)], repo, env());
    expect(cancelled.code, cancelled.stderr).toBe(0);

    const ended = await running;
    expect(envelope(ended), ended.stderr).toMatchObject({ data: { done: { outcome: 'cancelled' } } });
    expect(signalPid(child, 0)).toBe('gone');
  });

  it('does not spawn a team runtime at a revision no one accepted here, and runs it once a person accepts it at the terminal', async () => {
    const spawns = path.join(sandbox, 'team-spawns');
    const runtimeDir = writeTeamRuntime('teamtoy', spawns);
    writeDefinition('teamd', { state: path.join(sandbox, 'toy-state-team') }, { use: 'teamtoy' });
    const runs = path.join(sandbox, 'runs-team');

    const refused = await runCLI(['workflow', 'start', 'onecommand', '--driver', 'teamd'], repo, { ...env(), RUNS_FILE: runs });

    expect(envelope(refused)).toMatchObject({ error: { code: 'runtime_not_accepted', message: expect.stringContaining('runtimes/teamtoy') } });
    expect(fs.existsSync(spawns)).toBe(false);
    if (!hasPython) return;

    const pidFile = path.join(sandbox, 'pty.pid');
    const screen = path.join(sandbox, 'pty.out');
    const typed = path.join(sandbox, 'pty.in');
    const attended = spawn('python3', ['-c', TYPED_TERMINAL, pidFile, screen, typed, process.execPath, CLI, 'workflow', 'start', 'onecommand', '--driver', 'teamd'], {
      cwd: repo, env: { ...process.env, ...env(), RUNS_FILE: runs, TEAMAI_MODE: 'attended', FORCE_COLOR: '0' }, stdio: 'ignore',
    });
    const exited = new Promise<number | null>((resolve) => attended.on('close', resolve));
    const deadline = Date.now() + 30_000;
    while (!(fs.existsSync(screen) && fs.readFileSync(screen, 'utf8').includes('Run it? [y/N]')) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fs.existsSync(spawns)).toBe(false);
    fs.writeFileSync(typed, 'y\r');

    expect(await exited, fs.readFileSync(screen, 'utf8')).toBe(0);
    expect(fs.readFileSync(spawns, 'utf8')).toBe('spawned\n');
    expect(fs.readFileSync(runs, 'utf8')).toBe('x');

    // Any change to the runtime's directory is a new revision, which needs accepting again.
    fs.writeFileSync(path.join(runtimeDir, 'notes.txt'), 'changed\n');
    const changed = await runCLI(['workflow', 'start', 'onecommand', '--driver', 'teamd'], repo, { ...env(), RUNS_FILE: runs });
    expect(envelope(changed)).toMatchObject({ error: { code: 'runtime_not_accepted' } });
    expect(fs.readFileSync(spawns, 'utf8')).toBe('spawned\n');
  });

  it('says once that a team runtime replaces teamai\'s, and records in each attempt where its runtime came from, at which revision', async () => {
    const runtimeDir = writeTeamRuntime('t3', path.join(sandbox, 'team-t3-spawns'));
    writeDefinition('teamt3', { state: path.join(sandbox, 'toy-state-team-t3') }, { use: 't3' });
    const revision = await folderRevision(runtimeDir);
    const trust = path.join(os.homedir(), '.teamai', 'trust', 'runtimes.json');
    const accepted = fs.existsSync(trust) ? (JSON.parse(fs.readFileSync(trust, 'utf8')) as { accepted: unknown[] }).accepted : [];
    fs.mkdirSync(path.dirname(trust), { recursive: true });
    fs.writeFileSync(trust, JSON.stringify({ accepted: [...accepted, { dir: runtimeDir, revision, acceptedAt: new Date().toISOString() }] }));

    const ran = await runCLI(['workflow', 'start', 'onecommand', '--driver', 'teamt3'], repo, { ...env(), RUNS_FILE: path.join(sandbox, 'runs-team-t3') });

    const runId = succeededRun(ran);
    expect(ran.stderr.split(`Runtime "t3" of the team (runtimes/t3/, revision ${revision.slice(0, 12)}) replaces teamai's.`)).toHaveLength(2);
    expect(runtimeRecords(runId)).toEqual([expect.objectContaining({ runtime: 't3', sources: [{ runtime: 't3', layer: 'team', location: 'runtimes/t3/', revision }] })]);
  });

  it.skipIf(!hasPython)('stops as interrupted at Ctrl-C to accept a team runtime, spawning nothing and accepting nothing, and asks again next time', async () => {
    const spawns = path.join(sandbox, 'team-spawns-ctrlc');
    writeTeamRuntime('teamtoyc', spawns);
    writeDefinition('teamc', { state: path.join(sandbox, 'toy-state-team-ctrlc') }, { use: 'teamtoyc' });
    const asked = async (typed: string): Promise<{ code: number | null; screen: string }> => {
      const pidFile = path.join(sandbox, `pty-c-${typed.length}.pid`);
      const screen = path.join(sandbox, `pty-c-${typed.length}.out`);
      const input = path.join(sandbox, `pty-c-${typed.length}.in`);
      const attended = spawn('python3', ['-c', TYPED_TERMINAL, pidFile, screen, input, process.execPath, CLI, 'workflow', 'start', 'onecommand', '--driver', 'teamc'], {
        cwd: repo, env: { ...process.env, ...env(), RUNS_FILE: path.join(sandbox, 'runs-team-ctrlc'), TEAMAI_MODE: 'attended', FORCE_COLOR: '0' }, stdio: 'ignore',
      });
      const exited = new Promise<number | null>((resolve) => attended.on('close', resolve));
      const deadline = Date.now() + 30_000;
      while (!(fs.existsSync(screen) && fs.readFileSync(screen, 'utf8').includes('Run it? [y/N]')) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
      fs.writeFileSync(input, typed);
      return { code: await exited, screen: fs.readFileSync(screen, 'utf8') };
    };

    const stopped = await asked('\x03');

    expect(stopped.screen).toContain('"code":"interrupted"');
    expect(stopped.code, stopped.screen).toBe(1);
    expect(fs.existsSync(spawns)).toBe(false);
    expect(fs.existsSync(path.join(os.homedir(), '.teamai', 'trust', 'runtimes.json')) ? fs.readFileSync(path.join(os.homedir(), '.teamai', 'trust', 'runtimes.json'), 'utf8') : '').not.toContain('teamtoyc');
    const again = await asked('n\r');
    expect(again.screen).toContain('"code":"runtime_not_accepted"');
  });

  it('runs the same definition for --driver x and --driver teamai-x', async () => {
    writeDefinition('teamai-toyx', { state: path.join(sandbox, 'toy-state-x') });

    for (const name of ['toyx', 'teamai-toyx']) {
      const ran = await runCLI(['workflow', 'start', 'onecommand', '--driver', name], repo, { ...env(), RUNS_FILE: path.join(sandbox, `runs-${name}`) });

      expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      expect(runtimeRecords(startedRun(ran))).toEqual([expect.objectContaining({ runtime: 'toy', driver: 'teamai-toyx' })]);
    }
  });

  it('runs the member\'s own definition over the team\'s of the same name, and never for a run resume --next takes', async () => {
    const teamState = path.join(sandbox, 'toy-state-team-own');
    const ownState = path.join(sandbox, 'toy-state-own');
    writeDefinition('toyown', { state: teamState });
    writeDefinition('toyown', { state: ownState }, { dir: path.join(os.homedir(), '.teamai', 'drivers') });
    writeDefinition('onlymine', { state: ownState }, { dir: path.join(os.homedir(), '.teamai', 'drivers') });

    const ran = await runCLI(['workflow', 'start', 'onecommand', '--driver', 'toyown'], repo, { ...env(), RUNS_FILE: path.join(sandbox, 'runs-own') });

    expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(toyOpens(ownState)).toHaveLength(1);
    expect(fs.existsSync(teamState)).toBe(false);

    const next = await runCLI(['workflow', 'resume', '--next', '--driver', 'onlymine'], repo, env());
    expect(envelope(next)).toMatchObject({ error: { code: 'driver_not_found', message: expect.stringContaining('"onlymine"') } });
  });

  it('refuses a runtime name two active namespaces define, and an option the runtime does not take', async () => {
    writeTeamRuntime(path.join('ns-one', 'dup'), path.join(sandbox, 'dup-spawns'));
    writeTeamRuntime(path.join('ns-two', 'dup'), path.join(sandbox, 'dup-spawns'));
    writeDefinition('toydup', {}, { use: 'dup' });
    writeDefinition('toybad', { state: path.join(sandbox, 'toy-state-bad'), imgae: 'x' });

    const conflict = await runCLI(['workflow', 'start', 'onecommand', '--driver', 'toydup'], repo, env());
    const badOption = await runCLI(['workflow', 'start', 'onecommand', '--driver', 'toybad'], repo, env());

    expect(envelope(conflict)).toMatchObject({ error: { code: 'runtime_namespace_conflict', message: expect.stringContaining('ns-one') } });
    expect(envelope(badOption)).toMatchObject({ error: { code: 'bad_option', message: expect.stringContaining('"imgae"') } });
    expect(fs.existsSync(path.join(sandbox, 'dup-spawns'))).toBe(false);
  });
});
