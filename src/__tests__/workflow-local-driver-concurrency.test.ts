import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type LocalConfig } from '../types.js';
import { leaseNext, reportAttempt } from '../workflow/engine.js';
import { LeaseIdSchema } from '../workflow/lease-wire.js';
import { cancelRun, respondProvenance, respondToHitl, retryStep } from '../workflow/run-controls.js';
import { type LocalToolAdapter } from '../workflow/drivers/local/local-tool-adapter.js';
import { _setDriverPollMs, runLocalDriver } from '../workflow/drivers/local/local-driver.js';
import { driverIdentity } from '../driver-identity.js';
import { attemptDir, readRun, RunIdSchema } from '../workflow/store.js';
import { knownSecrets } from '../env-resolution.js';
import { alive, dirs, exitsWithin, LOG, parallelFixture, toolPaths, TWO_BARRIERS, workflowFixture } from './helpers/workflow-local-driver-fixture.js';
import { recordGroup } from '../tool-launch/process-stop.js';

_setDriverPollMs(20);

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('a prompt step confined to a directory, under the local driver', () => {
  /** A run whose first step writes the directory, with `confined`, and whose second answers from it, confined there. */
  const judged = (confined: object): string => `schemaVersion: v1alpha1
name: build
description: Judge a change from the evidence an earlier step wrote.
steps:
  - id: evidence
    command: |
      node -e "const p=require('path'),fs=require('fs'),d=p.join(process.env.TEAMAI_RUN_DIR,'evidence');fs.mkdirSync(d);fs.writeFileSync(p.join(d,'confined.json'),process.argv[1]);fs.writeFileSync(p.join(d,'diff.txt'),'retries 3')" '${JSON.stringify(confined)}'
  - id: judge
    needs: [evidence]
    workspace: { confined: evidence }
    prompt: Judge the change from the files here.
    output:
      verdict: pass | fail
`;

  /** A machine whose only confined tool is a Cursor that replies `reply` on any prompt, and prints a version. */
  function cursorOnly(root: string, reply: object): (executable: string) => string | null {
    const cursor = path.join(root, 'cursor-agent');
    fs.writeFileSync(cursor, `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('2026.10.1'); process.exit(); }
console.log(JSON.stringify({ type: 'result', result: ${JSON.stringify(JSON.stringify(reply))} }));\n`, { mode: 0o755 });

    return (executable) => (executable === 'cursor-agent' ? cursor : null);
  }

  it('runs a best-effort step on a Cursor-only machine and keeps what the run measured', async () => {
    const { config, workspace, runId } = await workflowFixture(judged({ level: 'best-effort' }));
    const resolveTool = cursorOnly(path.dirname(workspace), { verdict: 'pass' });

    expect(await runLocalDriver(config, runId, workspace, { toolPaths, resolveTool })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(await readRun(config, runId)).toMatchObject({
      steps: [{ id: 'evidence', status: 'succeeded' }, {
        id: 'judge', status: 'succeeded', tool: 'cursor', outputs: { verdict: 'pass' }, confined: { tool: 'cursor', isolation: 'best-effort', access: 'full' },
      }],
    });
  });

  it('leaves a verified step pending on a Cursor-only machine, which offers no verified tool', async () => {
    const { config, workspace, runId } = await workflowFixture(judged({ level: 'verified' }));
    const resolveTool = cursorOnly(path.dirname(workspace), { verdict: 'pass' });

    expect(await runLocalDriver(config, runId, workspace, { toolPaths, resolveTool })).toEqual({
      error: {
        code: 'confined_pending',
        message: `Run ${runId} waits for a confined tool: step "judge" runs confined at verified, which no offer in this driver's can.confined reaches. Make one available here, then run teamai workflow resume ${runId}, or drive the run with a driver that offers one.`,
      },
    });
    expect(await readRun(config, runId)).toMatchObject({ status: 'running', steps: [{ id: 'evidence', status: 'succeeded' }, { id: 'judge', status: 'pending' }] });
  });

  it('leaves the step pending, and stops, when the tool it was leased for no longer resolves its model at launch', async () => {
    const { config, workspace, runId } = await workflowFixture(judged({ level: 'best-effort' }));
    const resolveTool = cursorOnly(path.dirname(workspace), { verdict: 'pass' });
    const reason = 'Step "judge" runs confined on cursor, and none of them resolves its model here. Alias fast names no model of cursor.';
    vi.spyOn(await import('../workflow/confined-step.js'), 'runConfinedStep').mockResolvedValue({ kind: 'unresolved', reason });
    const engine = await import('../workflow/engine.js');
    const real = engine.leaseNext;
    let asked = 0;
    vi.spyOn(engine, 'leaseNext').mockImplementation(async (...args) => {
      asked += 1;
      if (asked > 100) throw new Error('The driver kept asking for work after it handed the confined lease back.');
      return real(...args);
    });

    expect(await runLocalDriver(config, runId, workspace, { toolPaths, resolveTool })).toEqual({
      error: { code: 'confined_pending', message: `Run ${runId} waits for a confined tool: ${reason.replace(/\.$/u, '')}. Make one available here, then run teamai workflow resume ${runId}, or drive the run with a driver that offers one.` },
    });
    expect(await readRun(config, runId)).toMatchObject({ status: 'running', steps: [{ id: 'evidence', status: 'succeeded' }, { id: 'judge', status: 'pending' }] });
  });
});

describe('local workflow driver and a lease from a newer teamai', () => {
  it('fails a step whose place it cannot read with the wording every driver uses', async () => {
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: One command in a worktree of its own.
steps:
  - id: change
    workspace: new
    command: node -e "process.exit(0)"
`);
    const engine = await import('../workflow/engine.js');
    const real = engine.leaseNext;
    // The workspace of the lease takes a shape a newer teamai wrote.
    vi.spyOn(engine, 'leaseNext').mockImplementationOnce(async (...args) => {
      const answer = await real(...args);
      const lease = 'data' in answer ? answer.data.lease : undefined;
      return lease !== null && typeof lease === 'object' ? { data: { lease: { ...lease, workspace: { mode: 'teleported' } } } } : answer;
    });

    expect(await runLocalDriver(config, runId, workspace, { toolPaths })).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(await readRun(config, runId)).toMatchObject({
      steps: [{ id: 'change', status: 'failed', failure: { code: 'workspace_base', message: `Run ${runId} leased a place this teamai cannot read. Update teamai.` } }],
    });
  });
});

describe('local workflow driver concurrency', () => {
  it('runs two command roots at the same time with max_parallel 2', async () => {
    const { config, workspace, runId } = await parallelFixture(TWO_BARRIERS, 2);

    const done = await runLocalDriver(config, runId, workspace);

    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
  });

  it.each([
    ['in worktrees of their own', '    workspace: new\n', 2],
    ['in the checkout they share', '', 1],
  ] as const)('runs two headless prompts %s with max_parallel 2, at most %s at a time', async (_place, workspaceLine, most) => {
    const { config, workspace, runId } = await parallelFixture(`schemaVersion: v1alpha1
name: build
description: Two prompts with no needs.
steps:
  - id: left
    needs: []
${workspaceLine}    prompt: Implement the left half.
  - id: right
    needs: []
${workspaceLine}    prompt: Implement the right half.
`, 2);
    let running = 0;
    let overlap = 0;
    const together = (): boolean => running === 2;
    const adapter: LocalToolAdapter = {
      runInteractive: vi.fn(),
      run: vi.fn(async () => {
        running += 1;
        overlap = Math.max(overlap, running);
        // Each waits a while for the other, so two prompts that may run together do.
        for (const deadline = Date.now() + 1000; Date.now() < deadline && !together();) await new Promise((resolve) => setTimeout(resolve, 20));
        running -= 1;
        return { started: true as const, exitCode: 0 };
      }),
    };

    const done = await runLocalDriver(config, runId, workspace, { adapter, toolPaths });

    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(adapter.run).toHaveBeenCalledTimes(2);
    expect(overlap).toBe(most);
  });

  it('holds a prompt leased while a command runs, and starts it once the command has exited', async () => {
    const { config, workspace, runId } = await parallelFixture(`schemaVersion: v1alpha1
name: build
description: A command and a prompt with no needs.
steps:
  - id: slow
    needs: []
    command: node -e "setTimeout(() => require('fs').writeFileSync(require('path').join(process.cwd(), '..', 'slow.done'), ''), 300)"
  - id: ask
    needs: []
    prompt: Review this project.
    output:
      ok: boolean
`, 2);
    const commandExitedFirst: boolean[] = [];
    const adapter: LocalToolAdapter = {
      runInteractive: vi.fn(),
      run: vi.fn(async () => {
        commandExitedFirst.push(fs.existsSync(path.join(workspace, '..', 'slow.done')));
        return { started: true as const, exitCode: 0, output: { ok: true } };
      }),
    };

    const done = await runLocalDriver(config, runId, workspace, { adapter, toolPaths });

    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(commandExitedFirst).toEqual([true]);
  });

  it.each([
    ['a command in another worktree', (mark: (name: string, untilRelease?: boolean) => string) => `  - id: change
    workspace: new
    prompt: Implement.
  - id: lint
    needs: []
    workspace: new
    command: ${mark('lint')}
`, ['lint'], []],
    ['a command in the current checkout', (mark: (name: string, untilRelease?: boolean) => string) => `  - id: change
    workspace: new
    prompt: Implement.
  - id: lint
    needs: []
    command: ${mark('lint')}
`, ['lint'], []],
    ['a command in the prompt\'s own worktree', (mark: (name: string, untilRelease?: boolean) => string) => `  - id: change
    workspace: new
    workflow:
      steps:
        - id: implement
          prompt: Implement.
        - id: lint
          needs: []
          workspace: continue
          command: ${mark('lint')}
`, [], ['lint']],
    ['a command past max_parallel, counting the prompt', (mark: (name: string, untilRelease?: boolean) => string) => `  - id: change
    workspace: new
    prompt: Implement.
  - id: first
    needs: []
    workspace: new
    command: ${mark('first', true)}
  - id: second
    needs: []
    workspace: new
    command: ${mark('second')}
`, ['first'], ['second']],
  ] as const)('runs a ready step beside a headless prompt only in a free checkout and slot: %s', async (_name, steps, overlaps, waits) => {
    const markers = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-markers-'));
    dirs.push(markers);
    const mark = (name: string, untilRelease = false): string => `node -e "const fs=require('fs'),p=require('path'); fs.writeFileSync(p.join('${markers}','${name}'),'');${
      untilRelease ? ` const t=setInterval(()=>{ if (fs.existsSync(p.join('${markers}','release'))) clearInterval(t); },20);` : ''}"`;
    const { config, workspace, runId } = await parallelFixture(`schemaVersion: v1alpha1
name: build
description: Steps beside a prompt.
steps:
${steps(mark)}`, 2);
    const exists = (name: string): boolean => fs.existsSync(path.join(markers, name));
    const seen: string[] = [];
    const adapter: LocalToolAdapter = {
      runInteractive: vi.fn(),
      run: vi.fn(async () => {
        for (const deadline = Date.now() + 3000; Date.now() < deadline && !overlaps.every(exists);) await new Promise((resolve) => setTimeout(resolve, 20));
        if (waits.length > 0) await new Promise((resolve) => setTimeout(resolve, 500));
        seen.push(...[...overlaps, ...waits].filter(exists));
        fs.writeFileSync(path.join(markers, 'release'), '');
        return { started: true as const, exitCode: 0 };
      }),
    };

    const done = await runLocalDriver(config, runId, workspace, { adapter, toolPaths });

    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(seen).toEqual(overlaps);
  });

  it('drops a held prompt that an end cancels before it starts, and the run goes on', async () => {
    const { config, workspace, runId } = await parallelFixture(`schemaVersion: v1alpha1
name: build
description: An inline workflow ends while its prompt is held.
steps:
  - id: w
    needs: []
    workflow:
      ends:
        stopped: succeeded
      steps:
        - id: finish
          needs: []
          command: node -e "setTimeout(() => {}, 200)"
          end: stopped
        - id: ask
          needs: []
          prompt: Review this project.
          output:
            ok: boolean
  - id: after
    needs: [w]
    command: node -e "process.exit(0)"
`, 2);
    const adapter: LocalToolAdapter = { runInteractive: vi.fn(), run: vi.fn(async () => ({ started: true as const, exitCode: 0, output: { ok: true } })) };

    const done = await runLocalDriver(config, runId, workspace, { adapter, toolPaths });

    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(adapter.run).not.toHaveBeenCalled();
    expect(await readRun(config, runId)).toMatchObject({
      steps: expect.arrayContaining([
        expect.objectContaining({ id: 'w.ask', status: 'cancelled' }),
        expect.objectContaining({ id: 'after', status: 'succeeded' }),
      ]),
    });
  });

  // Real worktree preparation and the five-second SIGKILL grace period share this
  // budget, and a loaded runner prepares a worktree far slower than an idle one.
  it('kills a cancelled command that ignores SIGTERM after the grace period, and finishes', { timeout: 120_000 }, async ({ signal }) => {
    const { config, workspace, runId } = await parallelFixture(`schemaVersion: v1alpha1
name: build
description: An end cancels a command that ignores SIGTERM.
ends:
  done: succeeded
steps:
  - id: stubborn
    needs: []
    workspace: new
    command: node stubborn.js
  - id: finish
    needs: []
    workspace: new
    command: node finish.js
    end: done
`, 2);
    const pidFile = path.join(workspace, '..', 'markers', 'stubborn.pid');
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'stubborn.js'), `process.on('SIGTERM', () => {});
require('fs').mkdirSync(${JSON.stringify(path.dirname(pidFile))}, { recursive: true });
require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`);
    fs.writeFileSync(path.join(workspace, 'finish.js'), `const deadline = setTimeout(() => {
  console.error('The stubborn command did not publish its PID');
  process.exit(1);
}, 10000);
const timer = setInterval(() => {
  if (require('fs').existsSync(${JSON.stringify(pidFile)})) {
    clearTimeout(deadline);
    clearInterval(timer);
  }
}, 20);
`);
    execFileSync('git', ['add', 'stubborn.js', 'finish.js'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'scripts'], { cwd: workspace });
    const cleanup = (): void => {
      if (!fs.existsSync(pidFile)) return;
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      if (Number.isSafeInteger(pid) && pid > 0 && alive(pid)) process.kill(pid, 'SIGKILL');
    };
    signal.addEventListener('abort', cleanup, { once: true });
    try {
      const done = await runLocalDriver(config, runId, workspace);
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));

      expect(done).toMatchObject({ data: { done: { outcome: 'succeeded', end: 'done' } } });
      expect(await exitsWithin(pid, 1000)).toBe(true);
      expect(await readRun(config, runId)).toMatchObject({
        steps: [{ id: 'stubborn', status: 'cancelled' }, { id: 'finish', status: 'succeeded' }],
      });
    } finally {
      signal.removeEventListener('abort', cleanup);
      cleanup();
    }
  });

  // The same real worktree preparation and SIGKILL grace as the case above.
  it('kills a descendant that ignores SIGTERM after the cancelled command itself exited, and finishes', { timeout: 120_000 }, async () => {
    const { config, workspace, runId } = await parallelFixture(`schemaVersion: v1alpha1
name: build
description: An end cancels a command whose child ignores SIGTERM and outlives it.
ends:
  done: succeeded
steps:
  - id: parent
    needs: []
    workspace: new
    command: node parent.js
  - id: finish
    needs: []
    workspace: new
    command: node finish.js
    end: done
`, 2);
    const pidFile = path.join(workspace, '..', 'markers', 'child.pid');
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'parent.js'), `require('child_process').spawn(process.execPath, ['-e', \`process.on('SIGTERM', () => {});
require('fs').mkdirSync(${JSON.stringify(path.dirname(pidFile))}, { recursive: true });
require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);\`], { stdio: 'ignore' });
setInterval(() => {}, 1000);
`);
    fs.writeFileSync(path.join(workspace, 'finish.js'), `const timer = setInterval(() => {
  if (require('fs').existsSync(${JSON.stringify(pidFile)})) clearInterval(timer);
}, 20);
`);
    execFileSync('git', ['add', 'parent.js', 'finish.js'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'scripts'], { cwd: workspace });
    let pid: number | undefined;
    try {
      const done = await runLocalDriver(config, runId, workspace);
      pid = Number(fs.readFileSync(path.join(workspace, '..', 'markers', 'child.pid'), 'utf8'));

      expect(done).toMatchObject({ data: { done: { outcome: 'succeeded', end: 'done' } } });
      expect(await exitsWithin(pid, 1000)).toBe(true);
    } finally {
      if (pid !== undefined && alive(pid)) process.kill(pid, 'SIGKILL');
    }
  });

  it.each([
    ['leased with the answer that cancels the command', 2, `  - id: ask
    needs: [w]
`],
    ['held when the command is cancelled', 3, `  - id: ask
    needs: []
`],
  ])('starts a prompt %s only once the command exits in its grace period', async (_case, maxParallel, ask) => {
    const { config, workspace, runId } = await parallelFixture(`schemaVersion: v1alpha1
name: build
description: An end cancels a command that takes a moment to exit, and a prompt waits for it.
steps:
  - id: w
    needs: []
    workflow:
      ends:
        stopped: succeeded
      steps:
        - id: finish
          needs: []
          workspace: new
          command: node finish.js
          end: stopped
        - id: lingering
          needs: []
          command: node lingering.js
${ask}    prompt: Review this project.
    output:
      ok: boolean
`, maxParallel);
    const startedFile = path.join(workspace, '..', 'markers', 'lingering.started');
    const exitedFile = path.join(workspace, '..', 'markers', 'lingering.exited');
    fs.mkdirSync(path.dirname(startedFile), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'lingering.js'), `const fs = require('fs');
process.on('SIGTERM', () => setTimeout(() => { fs.writeFileSync(${JSON.stringify(exitedFile)}, ''); process.exit(0); }, 300));
fs.mkdirSync(${JSON.stringify(path.dirname(startedFile))}, { recursive: true });
fs.writeFileSync(${JSON.stringify(startedFile)}, '');
setInterval(() => {}, 1000);
`);
    fs.writeFileSync(path.join(workspace, 'finish.js'), `const timer = setInterval(() => {
  if (require('fs').existsSync(${JSON.stringify(startedFile)})) clearInterval(timer);
}, 20);
`);
    execFileSync('git', ['add', 'lingering.js', 'finish.js'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'scripts'], { cwd: workspace });
    const commandExitedFirst: boolean[] = [];
    const adapter: LocalToolAdapter = {
      runInteractive: vi.fn(),
      run: vi.fn(async () => {
        commandExitedFirst.push(fs.existsSync(path.join(workspace, '..', 'markers', 'lingering.exited')));
        return { started: true as const, exitCode: 0, output: { ok: true } };
      }),
    };

    const done = await runLocalDriver(config, runId, workspace, { adapter, toolPaths });

    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(commandExitedFirst).toEqual([true]);
    expect(await readRun(config, runId)).toMatchObject({
      steps: expect.arrayContaining([
        expect.objectContaining({ id: 'w.lingering', status: 'cancelled' }),
        expect.objectContaining({ id: 'ask', status: 'succeeded' }),
      ]),
    });
  });

  it('discards the lease_cancelled answer for a command cancelled while it ran, and finishes', async () => {
    const { config, workspace, runId } = await parallelFixture(`schemaVersion: v1alpha1
name: build
description: Another caller with the same identity reaches an end while slow runs.
ends:
  done: succeeded
steps:
  - id: slow
    needs: []
    command: node slow.js
  - id: finish
    needs: []
    command: node -e "process.exit(0)"
    end: done
`, 1);
    fs.writeFileSync(path.join(workspace, 'slow.js'), `const fs = require('fs');
fs.writeFileSync('slow.started', '');
const timer = setInterval(() => { if (fs.existsSync('go')) clearInterval(timer); }, 20);
`);
    const driving = runLocalDriver(config, runId, workspace);
    while (!fs.existsSync(path.join(workspace, 'slow.started'))) await new Promise((resolve) => setTimeout(resolve, 20));
    const run = await readRun(config, runId);
    const slow = typeof run === 'object' ? run.steps.find((step) => step.id === 'slow') : undefined;
    if (slow?.status !== 'leased') throw new Error('slow is not leased');
    const same = driverIdentity('local', workspace);
    // The other caller runs with room for a second open lease.
    const leased = await leaseNext({ ...config, workflows: { tools: {}, max_parallel: 2 } }, runId, same, { running: [slow.attempt] });
    const finish = 'data' in leased ? leased.data.lease as { attempt: string; revision: number } : undefined;
    if (!finish) throw new Error('finish was not leased');
    await reportAttempt(config, runId, { attempt: finish.attempt, revision: finish.revision, outcome: 'success', driver: same });
    expect(await leaseNext(config, runId, same, { running: [slow.attempt], canTakeLease: false })).toMatchObject({
      data: { cancelled: [slow.attempt] },
    });
    fs.writeFileSync(path.join(workspace, 'go'), '');

    expect(await driving).toMatchObject({ data: { done: { outcome: 'succeeded', end: 'done' } } });
    expect(await readRun(config, runId)).toMatchObject({ steps: [{ id: 'slow', status: 'cancelled' }, { id: 'finish', status: 'succeeded' }] });
  });

  it.skipIf(process.platform === 'win32').each([
    [1, 'the driver\'s process group', true],
    [2, 'a process group of its own', false],
  ] as const)('runs a command with max_parallel %i in %s', async (maxParallel, _group, shared) => {
    const { config, workspace, runId } = await parallelFixture(`schemaVersion: v1alpha1
name: build
description: Report the process group a command runs in.
steps:
  - id: group
    command: node pgid.js
    output:
      pgid: number
`, maxParallel);
    fs.writeFileSync(path.join(workspace, 'pgid.js'), `const pgid = require('child_process').execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)]);
process.stdout.write(JSON.stringify({ pgid: Number(String(pgid).trim()) }));
`);
    const driverGroup = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim());

    await runLocalDriver(config, runId, workspace);

    const run = await readRun(config, runId);
    const outputs = typeof run === 'object' && run.steps[0]?.status === 'succeeded' ? run.steps[0].outputs as { pgid: number } : undefined;
    expect(outputs?.pgid).toEqual(expect.any(Number));
    expect(outputs?.pgid === driverGroup).toBe(shared);
  });

  it('gets the leases of an earlier driver back one at a time, and runs them one at a time with max_parallel 1', async () => {
    const { config, workspace, runId } = await parallelFixture(`schemaVersion: v1alpha1
name: build
description: Two roots an earlier driver leased and never reported.
steps:
  - id: a
    needs: []
    command: node log.js a
  - id: b
    needs: []
    command: node log.js b
`, 1);
    fs.writeFileSync(path.join(workspace, 'log.js'), LOG);
    const earlier = driverIdentity('local', workspace);
    // The earlier driver ran while this machine allowed more open leases.
    const before: LocalConfig = { ...config, workflows: { tools: {}, max_parallel: 2 } };
    const a = await leaseNext(before, runId, earlier);
    const attempt = 'data' in a ? (a.data.lease as { attempt: string }).attempt : '';
    expect(await leaseNext(before, runId, earlier, { running: [attempt] })).toMatchObject({ data: { lease: { step: 'b' } } });

    const done = await runLocalDriver(config, runId, workspace);

    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(fs.readFileSync(path.join(workspace, '..', 'log.txt'), 'utf8')).toBe('start a\nend a\nstart b\nend b\n');
  });

  it('stops what an earlier driver left running in an attempt it gets back, before that attempt runs again', async () => {
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: A step whose earlier driver was killed while its setup ran.
steps:
  - id: check
    command: "true"
`);
    const leased = await leaseNext(config, runId, driverIdentity('local', workspace));
    if (!('data' in leased)) throw new Error(leased.error.message);
    const dir = attemptDir(config, RunIdSchema.parse(runId), LeaseIdSchema.parse(leased.data.lease).attempt);
    fs.mkdirSync(dir, { recursive: true });
    // What the killed driver's setup left: a process group of its own, recorded where its attempt keeps it.
    const left = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    const exited = new Promise<NodeJS.Signals | null>((resolve) => left.on('exit', (_code, signal) => resolve(signal)));
    recordGroup(left, dir);
    try {
      expect(await runLocalDriver(config, runId, workspace)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      expect(await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve('still running'), 2000))])).toBe('SIGTERM');
    } finally {
      left.kill('SIGKILL');
    }
  });

  it('runs a prompt an earlier driver leased alone, between the commands leased before and after it', async () => {
    const { config, workspace, runId } = await parallelFixture(`schemaVersion: v1alpha1
name: build
description: A command, a prompt and a command an earlier driver leased.
steps:
  - id: c1
    needs: []
    command: node log.js c1
  - id: ask
    needs: []
    prompt: Review this project.
    output:
      ok: boolean
  - id: c2
    needs: []
    command: node log.js c2
`, 2);
    fs.writeFileSync(path.join(workspace, 'log.js'), LOG);
    const earlier = driverIdentity('local', workspace);
    // The earlier driver ran while this machine allowed more open leases.
    const before: LocalConfig = { ...config, workflows: { tools: {}, max_parallel: 3 } };
    const running: string[] = [];
    for (const step of ['c1', 'ask', 'c2']) {
      const leased = await leaseNext(before, runId, earlier, { running });
      expect(leased).toMatchObject({ data: { lease: { step } } });
      if ('data' in leased) running.push((leased.data.lease as { attempt: string }).attempt);
    }
    const logAtPrompt: string[] = [];
    const adapter: LocalToolAdapter = {
      runInteractive: vi.fn(),
      run: vi.fn(async () => {
        logAtPrompt.push(fs.readFileSync(path.join(workspace, '..', 'log.txt'), 'utf8'));
        return { started: true as const, exitCode: 0, output: { ok: true } };
      }),
    };

    const done = await runLocalDriver(config, runId, workspace, { adapter, toolPaths });

    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(logAtPrompt).toEqual(['start c1\nend c1\n']);
    expect(fs.readFileSync(path.join(workspace, '..', 'log.txt'), 'utf8')).toBe('start c1\nend c1\nstart c2\nend c2\n');
  });

  it('runs one command at a time with max_parallel 1, so the barrier fails', async () => {
    const { config, workspace, runId } = await parallelFixture(TWO_BARRIERS, 1);

    const done = await runLocalDriver(config, runId, workspace);

    expect(done).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(await readRun(config, runId)).toMatchObject({
      steps: [{ id: 'left', status: 'failed', exitCode: 1 }, { id: 'right', status: 'succeeded' }],
    });
  });

  it.skipIf(process.platform === 'win32')('kills an attached descendant that ignores SIGTERM after its shell exits', async () => {
    const { config, workspace, runId } = await parallelFixture(`schemaVersion: v1alpha1
name: build
description: Cancel a foreground command with a stubborn descendant.
steps:
  - id: parent
    command: node parent.js; true
`, 1);
    fs.writeFileSync(path.join(workspace, 'parent.js'), `require('child_process').spawn(process.execPath, ['-e', \`process.on('SIGTERM', () => {});
require('fs').writeFileSync('child.pid', String(process.pid));
setInterval(() => {}, 1000);\`], { stdio: 'ignore' });
setInterval(() => {}, 1000);
`);
    const driving = runLocalDriver(config, runId, workspace);
    let pid: number | undefined;
    try {
      await vi.waitFor(() => expect(fs.existsSync(path.join(workspace, 'child.pid'))).toBe(true), { timeout: 10_000, interval: 20 });
      pid = Number(fs.readFileSync(path.join(workspace, 'child.pid'), 'utf8'));
      expect(await cancelRun(config, runId, await knownSecrets(config))).not.toHaveProperty('error');

      expect(await driving).toMatchObject({ data: { done: { outcome: 'cancelled' } } });
      expect(await exitsWithin(pid, 1000)).toBe(true);
    } finally {
      if (pid !== undefined && alive(pid)) process.kill(pid, 'SIGKILL');
      await cancelRun(config, runId, await knownSecrets(config));
      await driving;
    }
  }, 30_000);

  const controls = ['retry step', 'retry ancestor', 'cancel step then retry', 'cancel run then retry'] as const;
  it.each(controls.flatMap((control) => [1, 2].flatMap((maxParallel) =>
    ['exec node work.js', 'node work.js; true'].map((command) => ({ control, maxParallel, command })))))(
    '$control never overlaps live attempts at max_parallel $maxParallel with $command', async ({ control, maxParallel, command }) => {
      const { config, workspace, runId } = await parallelFixture(`schemaVersion: v1alpha1
name: build
description: Keep retry and cancel attempts separate.
steps:
  - id: plan
    choose: { message: Which plan?, options: [small, big] }
  - id: work
    needs: [plan]
    command: ${command}
`, maxParallel);
      const markers = path.join(workspace, '..', 'markers');
      fs.mkdirSync(markers);
      fs.writeFileSync(path.join(workspace, 'work.js'), `const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'markers');
const file = (name) => path.join(dir, name);
try { fs.writeFileSync(file('live'), '', { flag: 'wx' }); }
catch { fs.writeFileSync(file('overlap'), ''); process.exit(1); }
if (fs.existsSync(file('first.started'))) {
  fs.writeFileSync(file('second.saw'), fs.existsSync(file('first.cleaned')) ? 'cleaned' : 'running');
  fs.unlinkSync(file('live'));
  process.exit(0);
}
process.once('SIGTERM', () => {
  fs.writeFileSync(file('first.stopping'), '');
  setTimeout(() => {
    fs.writeFileSync(file('first.cleaned'), '');
    fs.unlinkSync(file('live'));
    process.exit(1);
  }, 2500);
});
fs.writeFileSync(file('first.pid'), String(process.pid));
fs.writeFileSync(file('first.started'), '');
setInterval(() => {}, 1000);
`);
      expect(await respondToHitl(config, runId, await knownSecrets(config), { step: 'plan', choice: 'small', provenance: respondProvenance({ kind: 'terminal', caller: { tty: true, evidence: { kind: 'none' } } }) }))
        .not.toHaveProperty('error');
      const options = { hitl: true, question: async () => 'big' };
      const driving = runLocalDriver(config, runId, workspace, options);
      try {
        await vi.waitFor(() => expect(fs.existsSync(path.join(markers, 'first.started'))).toBe(true), { timeout: 10_000, interval: 20 });
        expect(await readRun(config, runId)).toMatchObject({ steps: [{ id: 'plan', status: 'succeeded' }, { id: 'work', status: 'leased' }] });
        if (control.startsWith('cancel')) {
          expect(await cancelRun(config, runId, await knownSecrets(config), control.startsWith('cancel step') ? 'work' : undefined)).not.toHaveProperty('error');
        }
        expect(await retryStep(config, runId, await knownSecrets(config), control === 'retry ancestor' ? 'plan' : 'work'))
          .toMatchObject({ data: { retried: { pass: 2 } } });
        await vi.waitFor(() => expect(fs.existsSync(path.join(markers, 'first.stopping'))).toBe(true), { timeout: 7000, interval: 20 });
        expect(await driving).not.toHaveProperty('error');
        const pid = Number(fs.readFileSync(path.join(markers, 'first.pid'), 'utf8'));
        expect(() => process.kill(pid, 0)).toThrow();
        expect(await runLocalDriver(config, runId, workspace, options)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
        expect(fs.existsSync(path.join(markers, 'first.stopping'))).toBe(true);
        expect(fs.existsSync(path.join(markers, 'first.cleaned'))).toBe(true);
        expect(fs.existsSync(path.join(markers, 'live'))).toBe(false);
        expect(fs.existsSync(path.join(markers, 'overlap'))).toBe(false);
        expect(fs.readFileSync(path.join(markers, 'second.saw'), 'utf8')).toBe('cleaned');
      } finally {
        await cancelRun(config, runId, await knownSecrets(config));
        const pidFile = path.join(markers, 'first.pid');
        if (fs.existsSync(pidFile) && !fs.existsSync(path.join(markers, 'first.cleaned'))) {
          try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* Already exited. */ }
        }
        await driving;
      }
    }, 30_000,
  );
});
