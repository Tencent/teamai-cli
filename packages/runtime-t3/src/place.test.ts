import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { RuntimeMessageSchema } from '@teamai/runtime-protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PATH_WITHOUT_T3, type Connection, type Line } from './testing/harness.js';
import { checkout, dir, ended, initialized, isNotice, linkTo, noticesOf, OPEN, opened, openOn, prompt, result, RUN, scriptsInProject1, SHIPPED_HOME_ENV, start, t3, usePromptStep, useT3Runtime, worktree } from './testing/suite.js';

/** teamai's wrapper for Claude, which a step through a sandbox runs in place of Claude. */
const SANDBOX_CLAUDE = 'teamai-sandbox-claude';

/** The registration of an app's tool that has no agent id, as the attempt socket reads it. */
const REGISTERED = '{"register":{"agent":null}}';

describe('teamai-runtime-t3', () => {
  useT3Runtime();

  describe('a prompt step', () => {
    usePromptStep();

    describe('in a checkout that is no T3 project yet', () => {
      it('adds it to T3 Code with the t3 command, as the member, saying so, and runs the step there', async () => {
        t3.config({ projects: [] });
        const runtime = await initialized();

        expect(await openOn(runtime, worktree)).toMatchObject({ event: 'ready' });
        expect(t3.commandRuns()).toContainEqual(['project', 'add', '--base-dir', t3.t3Home, checkout]);
        expect(noticesOf(runtime)).toEqual([{ event: 'notice', op: OPEN, handle: `t3-${RUN}-a1b2c3d4`, message: `Adding ${checkout} to T3 Code as a project, so its steps can run there.` }]);
        expect(runtime.stderr()).toBe('');

        const handle = `t3-${RUN}-a1b2c3d4`;
        runtime.send(prompt(handle, 'op-0000000b'));
        expect(await ended(runtime, 'op-0000000b')).toMatchObject({ event: 'finished' });
        expect(t3.threads()[0]).toMatchObject({ projectId: expect.stringMatching(/^project-/), workspace: 'existing_worktree', worktreePath: worktree });
      });

      it('fails open when the t3 command cannot add it, naming the command that does', async () => {
        t3.config({ projects: [], projectAddFails: 4 });
        const runtime = await initialized();

        expect(await openOn(runtime, worktree)).toEqual({
          op: OPEN, event: 'failed',
          failure: { code: 'not_a_t3_project', message: `${checkout} is not a project in T3 Code fake-laptop, and teamai could not add it (t3 project add exited with status 4: Could not add the project). Add it in T3 Code (Add project), or run t3 project add ${checkout}, then start the workflow again.` },
        });
      });

      it('runs the step on the project another step\'s open added meanwhile, when its own add finds it there', async () => {
        t3.config({ projects: [], projectAddRaced: true });
        const runtime = await initialized();

        expect(await openOn(runtime, worktree)).toMatchObject({ event: 'ready' });
        runtime.send(prompt(`t3-${RUN}-a1b2c3d4`, 'op-0000000b'));

        expect(await ended(runtime, 'op-0000000b')).toMatchObject({ event: 'finished' });
        expect(t3.threads()[0]).toMatchObject({ projectId: expect.stringMatching(/^project-/), workspace: 'existing_worktree', worktreePath: worktree });
      });

      it('fails open within its bound when the t3 command never finishes adding it', async () => {
        t3.config({ projects: [], projectAddHangs: true });
        const runtime = await initialized();

        expect(await openOn(runtime, worktree, OPEN, 15_000)).toEqual({
          op: OPEN, event: 'failed',
          failure: { code: 'not_a_t3_project', message: `${checkout} is not a project in T3 Code fake-laptop, and teamai could not add it (t3 project add did not finish within 10 s). Add it in T3 Code (Add project), or run t3 project add ${checkout}, then start the workflow again.` },
        });
      }, 20_000);

      it('adds it again when T3 deleted the project it had', async () => {
        t3.config({ projects: [{ id: 'project-old', title: 'acme-app', workspaceRoot: checkout, deletedAt: '2026-10-01T09:00:00.000Z' }] });
        const runtime = await initialized();

        expect(await openOn(runtime, worktree)).toMatchObject({ event: 'ready' });
        expect(t3.commandRuns()).toContainEqual(['project', 'add', '--base-dir', t3.t3Home, checkout]);
      });
    });

    // T3 runs a project's setup script in every worktree a thread binds, before the agent starts, so its output would be
    // committed as the step's work. A thread on a project's own folder runs no setup script.
    it('runs the step on a project of its own for the worktree when T3 would run the project\'s setup script in it, and nothing of that script lands there', async () => {
      t3.settings(scriptsInProject1({ name: 'Install', command: 'echo installed > SETUP_RAN.txt', runOnWorktreeCreate: true }));
      const runtime = await initialized();

      expect(await openOn(runtime, worktree)).toMatchObject({ event: 'ready' });
      runtime.send(prompt(`t3-${RUN}-a1b2c3d4`, 'op-0000000b'));

      expect(await ended(runtime, 'op-0000000b')).toMatchObject({ event: 'finished', result: { output: { verdict: 'approve' } } });
      expect(t3.commandRuns()).toContainEqual(['project', 'add', '--base-dir', t3.t3Home, '--title', `acme-app · teamai ${RUN}`, worktree]);
      expect(t3.threads()[0]).toMatchObject({ workspace: 'root', worktreePath: worktree, projectId: expect.not.stringMatching(/^project-1$/) });
      expect(fs.existsSync(path.join(worktree, 'SETUP_RAN.txt'))).toBe(false);
      expect(noticesOf(runtime)).toEqual([{
        event: 'notice', op: OPEN, handle: `t3-${RUN}-a1b2c3d4`,
        message: `T3 Code runs the setup script "Install" of acme-app in each worktree a thread opens on, so teamai adds the step's worktree ${worktree} to T3 Code as a project of its own, where that script does not run.`,
      }]);
      expect(runtime.stderr()).toBe('');
    });

    // The project teamai added for the worktree points at a folder that no longer exists once teamai removed it.
    it('removes the project it added for the step\'s worktree once teamai removed the worktree, and keeps the checkout\'s project', async () => {
      t3.settings(scriptsInProject1({ name: 'Install', command: 'echo installed > SETUP_RAN.txt', runOnWorktreeCreate: true }));
      const handle = `t3-${RUN}-a1b2c3d4`;
      const runtime = await initialized();
      expect(await openOn(runtime, worktree)).toMatchObject({ event: 'ready' });
      runtime.send(prompt(handle, 'op-0000000b'));
      expect(await ended(runtime, 'op-0000000b')).toMatchObject({ event: 'finished' });
      const added = t3.threads()[0]?.projectId;
      runtime.send({ type: 'collect', handle });
      await runtime.next((line) => line['event'] === 'collected');
      execFileSync('git', ['-C', checkout, 'worktree', 'remove', '--force', worktree]);

      runtime.send({ type: 'close', handle });

      expect(await runtime.next((line) => line['handle'] === handle && line['event'] === 'closed')).toEqual({ event: 'closed', handle });
      expect(t3.commandRuns()).toContainEqual(['project', 'remove', '--base-dir', t3.t3Home, '--force', added]);
      expect(t3.projects().filter((project) => !project.deletedAt).map((project) => project.id)).toEqual(['project-1']);
      expect(t3.threads()).toEqual([]);
    });

    it('keeps the project it added for a folder teamai still has at close, and removes it at a later close once the folder is gone', async () => {
      const clone = path.join(dir, 'clones', `${RUN}-a1b2c3d4`);
      execFileSync('git', ['clone', '-q', checkout, clone]);
      const runtime = await initialized();
      expect(await openOn(runtime, clone)).toMatchObject({ event: 'ready' });
      const added = t3.projects().find((project) => project.workspaceRoot === clone)?.id;
      runtime.send({ type: 'close', handle: `t3-${RUN}-a1b2c3d4` });
      await runtime.next((line) => line['event'] === 'closed');
      expect(t3.commandRuns().filter((run) => run[1] === 'remove')).toEqual([]);

      fs.rmSync(clone, { recursive: true, force: true });
      runtime.send({ type: 'open', op: 'op-0000000c', run: RUN, attempt: 'a5e6f7a8', credentials: {}, view: { worktree, readonly: [], result: path.dirname(result), runDir: path.join(dir, 'run'), toolHome: {} } });
      await runtime.next((line) => line['op'] === 'op-0000000c' && line['event'] === 'ready');
      runtime.send({ type: 'close', handle: `t3-${RUN}-a5e6f7a8` });
      await runtime.next((line) => line['event'] === 'closed' && line['handle'] === `t3-${RUN}-a5e6f7a8`);

      expect(t3.commandRuns().filter((run) => run[1] === 'remove')).toEqual([['project', 'remove', '--base-dir', t3.t3Home, '--force', added]]);
      expect(t3.projects().filter((project) => !project.deletedAt).map((project) => project.id)).toEqual(['project-1']);
    });

    it('keeps the project it added for a folder it cannot look at, which may still be in use', async () => {
      const clones = path.join(dir, 'clones');
      const clone = path.join(clones, `${RUN}-a1b2c3d4`);
      execFileSync('git', ['clone', '-q', checkout, clone]);
      const runtime = await initialized();
      expect(await openOn(runtime, clone)).toMatchObject({ event: 'ready' });
      runtime.send({ type: 'close', handle: `t3-${RUN}-a1b2c3d4` });
      await runtime.next((line) => line['event'] === 'closed');

      fs.chmodSync(clones, 0o000);

      try {
        runtime.send({ type: 'open', op: 'op-0000000c', run: RUN, attempt: 'a5e6f7a8', credentials: {}, view: { worktree, readonly: [], result: path.dirname(result), runDir: path.join(dir, 'run'), toolHome: {} } });
        await runtime.next((line) => line['op'] === 'op-0000000c' && line['event'] === 'ready');
        runtime.send({ type: 'close', handle: `t3-${RUN}-a5e6f7a8` });
        await runtime.next((line) => line['event'] === 'closed' && line['handle'] === `t3-${RUN}-a5e6f7a8`);
      } finally {
        fs.chmodSync(clones, 0o755);
      }

      expect(t3.commandRuns().filter((run) => run[1] === 'remove')).toEqual([]);
      expect(t3.projects().filter((project) => !project.deletedAt).map((project) => project.workspaceRoot)).toContain(clone);
    });

    it('never removes the checkout\'s project, though teamai added it', async () => {
      t3.config({ projects: [] });
      const handle = `t3-${RUN}-a1b2c3d4`;
      const runtime = await initialized();
      expect(await openOn(runtime, worktree)).toMatchObject({ event: 'ready' });
      execFileSync('git', ['-C', checkout, 'worktree', 'remove', '--force', worktree]);

      runtime.send({ type: 'close', handle });
      await runtime.next((line) => line['event'] === 'closed');

      expect(t3.commandRuns().filter((run) => run[1] === 'remove')).toEqual([]);
      expect(t3.projects()).toEqual([expect.objectContaining({ workspaceRoot: checkout, deletedAt: null })]);
    });

    it('runs the thread on the worktree\'s own project in the mode the member set for the checkout\'s project', async () => {
      const settings = scriptsInProject1({ name: 'Install', command: 'echo installed > SETUP_RAN.txt', runOnWorktreeCreate: true });
      t3.settings({ ...settings, defaultRuntimeMode: 'auto', projectSettingsOverrides: { 'project-1': { ...settings.projectSettingsOverrides['project-1'], defaultRuntimeMode: 'approval-required' } } });
      const runtime = await initialized();

      expect(await openOn(runtime, worktree)).toMatchObject({ event: 'ready' });
      runtime.send(prompt(`t3-${RUN}-a1b2c3d4`, 'op-0000000b'));

      expect(await ended(runtime, 'op-0000000b')).toMatchObject({ event: 'finished' });
      expect(t3.threads()[0]).toMatchObject({ runtimeMode: 'approval-required', projectId: expect.not.stringMatching(/^project-1$/) });
    });

    it('runs the thread on the worktree\'s own project on the default model the member set for the checkout\'s project', async () => {
      const settings = scriptsInProject1({ name: 'Install', command: 'echo installed > SETUP_RAN.txt', runOnWorktreeCreate: true });
      t3.settings({
        ...settings, defaultModelSelection: { instanceId: 'claudeAgent', model: 'claude-opus-5-5' },
        projectSettingsOverrides: { 'project-1': { ...settings.projectSettingsOverrides['project-1'], defaultModelSelection: { instanceId: 'claudeAgent', model: 'claude-sonnet-5-5' } } },
      });
      const runtime = await initialized();

      expect(await openOn(runtime, worktree)).toMatchObject({ event: 'ready' });
      runtime.send(prompt(`t3-${RUN}-a1b2c3d4`, 'op-0000000b', { model: undefined }));

      expect(await ended(runtime, 'op-0000000b')).toMatchObject({ event: 'finished' });
      expect(t3.threads()[0]).toMatchObject({ provider: 'claudeAgent', model: 'claude-sonnet-5-5', projectId: expect.not.stringMatching(/^project-1$/) });
    });

    it('leaves a thread unsettled, saying why once, when settling it would run the project\'s settle script in the step\'s worktree', async () => {
      t3.settings(scriptsInProject1({ name: 'Stop services', command: 'echo stopped > SETTLE_RAN.txt', runOnWorktreeCreate: false, runOnSettle: true }));
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-0000000b'));
      expect(await ended(runtime, 'op-0000000b')).toMatchObject({ event: 'finished' });

      runtime.send({ type: 'collect', handle });
      await runtime.next((line) => line['event'] === 'collected');
      runtime.send({ type: 'close', handle });
      await runtime.next((line) => line['event'] === 'closed');

      const [thread] = t3.threads();
      expect(thread?.settled).toBe(false);
      expect(t3.calls().filter((call) => call.tool === 't3_thread_organize')).toEqual([]);
      expect(fs.existsSync(path.join(worktree, 'SETTLE_RAN.txt'))).toBe(false);
      expect(noticesOf(runtime)).toEqual([{
        event: 'notice', handle,
        message: `teamai leaves the T3 thread ${linkTo(thread?.threadId)} ("review · teamai ${RUN}") in T3 Code's active threads: settling it would run the project's script "Stop services" in the step's folder.`,
      }]);
      expect(runtime.stderr()).toBe('');
    });

    // A read-only step reads the checkout where it is, as on local, and a clone is a folder of its own: each is a
    // project's own folder, where T3 runs no setup script.
    it('runs a step in the checkout itself as a thread of the checkout\'s project, where T3 runs no setup script', async () => {
      t3.settings(scriptsInProject1({ name: 'Install', command: 'echo installed > SETUP_RAN.txt', runOnWorktreeCreate: true }));
      const runtime = await initialized();

      expect(await openOn(runtime, checkout)).toMatchObject({ event: 'ready' });
      runtime.send({ ...prompt(`t3-${RUN}-a1b2c3d4`, 'op-0000000b'), cwd: checkout });

      expect(await ended(runtime, 'op-0000000b')).toMatchObject({ event: 'finished', session: { tool: 'claude' } });
      expect(t3.threads()[0]).toMatchObject({ projectId: 'project-1', workspace: 'root', worktreePath: checkout });
      expect(t3.commandRuns()).toEqual([]);
      expect(fs.existsSync(path.join(checkout, 'SETUP_RAN.txt'))).toBe(false);
    });

    it('runs a step in a clone teamai prepared on a project it adds for the clone', async () => {
      const clone = path.join(dir, 'clones', `${RUN}-a1b2c3d4`);
      execFileSync('git', ['clone', '-q', checkout, clone]);
      const runtime = await initialized();

      expect(await openOn(runtime, clone)).toMatchObject({ event: 'ready' });
      runtime.send({ ...prompt(`t3-${RUN}-a1b2c3d4`, 'op-0000000b'), cwd: clone });

      expect(await ended(runtime, 'op-0000000b')).toMatchObject({ event: 'finished', session: { tool: 'claude' } });
      expect(t3.commandRuns()).toContainEqual(['project', 'add', '--base-dir', t3.t3Home, clone]);
      expect(t3.threads()[0]).toMatchObject({ projectId: expect.not.stringMatching(/^project-1$/), workspace: 'root', worktreePath: clone });
    });

    // After a restart, cancel ends the op once T3 acknowledged the stop, which may come before the run ended.
    it('settles the thread of a step cancelled after a restart at close, once its run ends after T3 acknowledged the stop', async () => {
      t3.config({ agent: { hold: true, output: {} } });
      const first = await opened();
      first.runtime.send(prompt(first.handle, 'op-00000036'));
      await first.runtime.next((line) => line['op'] === 'op-00000036' && line['event'] === 'accepted');
      await expect.poll(() => t3.threads()[0]?.status).toBe('running');
      await first.runtime.close();
      t3.config({ stopLagMs: 1_000 });

      const second = start();
      second.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'attended', options: { environment: 'local' } });
      await second.next((line) => line['type'] === 'init');
      second.send({ type: 'cancel', op: 'op-00000036' });
      expect(await second.next((line) => line['op'] === 'op-00000036')).toEqual({ op: 'op-00000036', event: 'cancelled' });
      expect(t3.threads()[0]?.status).toBe('interrupted');
      second.send({ type: 'close', handle: first.handle });

      expect(await second.next((line) => line['handle'] === first.handle && line['event'] === 'closed')).toEqual({ event: 'closed', handle: first.handle });
      expect(t3.threads()[0]).toMatchObject({ status: 'interrupted', settled: true });
    });

    // A later step may continue the thread's conversation, which T3 keeps in the person's active threads until the place closes.
    it('leaves the thread of a step that ended unsettled at collect, and settles it at close', async () => {
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-00000039'));
      expect(await ended(runtime, 'op-00000039')).toMatchObject({ event: 'finished' });

      runtime.send({ type: 'collect', handle });
      expect(await runtime.next((line) => line['event'] === 'collected')).toEqual({ event: 'collected', handle });
      expect(t3.threads()[0]).toMatchObject({ status: 'completed', settled: false });

      runtime.send({ type: 'close', handle });
      expect(await runtime.next((line) => line['handle'] === handle && line['event'] === 'closed')).toEqual({ event: 'closed', handle });
      expect(t3.threads()[0]).toMatchObject({ status: 'completed', settled: true });
    });

    it('never settles a thread that still runs, or an interactive step\'s thread that waits for the person', async () => {
      t3.config({ agent: {} });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-00000031', { interactive: true }));
      await expect.poll(() => t3.threads()[0]?.status).toBe('completed');
      t3.config({ agent: { hold: true, output: {} } });
      runtime.send(prompt(handle, 'op-00000032'));
      await expect.poll(() => t3.threads().map((thread) => thread.status).sort()).toEqual(['completed', 'running']);

      runtime.send({ type: 'collect', handle });

      expect(await runtime.next((line) => line['event'] === 'collected')).toEqual({ event: 'collected', handle });
      expect(t3.threads().map((thread) => thread.settled)).toEqual([false, false]);
      expect(t3.calls().filter((call) => call.tool === 't3_thread_organize')).toEqual([]);
    });

    // The step fails at once, but its thread is still teamai's to stop: close keeps the place until T3 stops it.
    it.each([
      { stop: 'refuses', config: { interruptFails: true } },
      { stop: 'acknowledges but the run does not end', config: { stopLagMs: 60_000, waitCapMs: 50 } },
    ])('never settles or drops the thread of a step that ended while T3 still runs it, when T3 $stop the stop', async ({ config }) => {
      t3.config({ agent: { waits: true }, ...config });
      const { runtime, handle } = await opened('unattended');
      runtime.send(prompt(handle, 'op-00000035'));
      // The thread may still run, so the op ends with the one code teamai reads as a stop it could not confirm.
      expect(await ended(runtime, 'op-00000035')).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed', message: expect.stringContaining('Stop it in T3 Code with its Stop button.') } });

      runtime.send({ type: 'collect', handle });

      expect(await runtime.next((line) => line['event'] === 'collected')).toEqual({ event: 'collected', handle });
      expect(t3.threads()[0]).toMatchObject({ status: 'running', settled: false });

      runtime.send({ type: 'close', handle });

      expect(await runtime.next((line) => line['handle'] === handle && line['event'] !== 'collected')).toMatchObject({ event: 'close_failed', handle, failure: { code: 'thread_still_runs' } });
      runtime.send({ type: 'reattach', handle });
      expect(await runtime.next((line) => line['event'] === 'alive')).toMatchObject({ ops: [{ op: 'op-00000035', state: 'failed', failure: { code: 'cancel_failed' } }] });
      expect(t3.threads()[0]).toMatchObject({ status: 'running', settled: false });

      // T3 stops it now: close stops it, settles it and drops the place.
      t3.config({ interruptFails: false, stopLagMs: 0 });
      runtime.send({ type: 'close', handle });

      expect(await runtime.next((line) => line['handle'] === handle && line['event'] === 'closed')).toEqual({ event: 'closed', handle });
      expect(t3.threads()[0]).toMatchObject({ status: 'interrupted', settled: true });
    });

    it('settles only the threads it launched', async () => {
      t3.addThread({ threadId: 'thread-person-1', title: 'Fix the cart total', status: 'completed' });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-00000033'));
      expect(await ended(runtime, 'op-00000033')).toMatchObject({ event: 'finished' });
      const launched = t3.threads().find((thread) => thread.threadId !== 'thread-person-1');

      runtime.send({ type: 'collect', handle });
      await runtime.next((line) => line['event'] === 'collected');
      runtime.send({ type: 'close', handle });
      await runtime.next((line) => line['event'] === 'closed');

      expect(t3.calls().filter((call) => call.tool === 't3_thread_organize').map((call) => call.args['threadId'])).toEqual([launched?.threadId]);
      expect(t3.threads().find((thread) => thread.threadId === 'thread-person-1')?.settled).toBe(false);
    });

    // T3 leaves a delegated task's thread unsettled when it settles the thread that delegated it.
    it('settles the tasks a step thread delegated, at any depth, with the step thread at close, and no task of another thread', async () => {
      t3.config({ agent: { output: { verdict: 'approve' }, delegates: true } });
      t3.addThread({ threadId: 'thread-person-1', title: 'Fix the cart total', status: 'completed' });
      t3.addThread({ threadId: 'thread-person-1:task', title: 'Check the totals', status: 'completed', parentThreadId: 'thread-person-1' });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-00000037'));
      expect(await ended(runtime, 'op-00000037')).toMatchObject({ event: 'finished' });
      const step = t3.threads().find((thread) => thread.title === `review · teamai ${RUN}`)?.threadId;

      runtime.send({ type: 'close', handle });
      await runtime.next((line) => line['handle'] === handle && line['event'] === 'closed');

      expect(Object.fromEntries(t3.threads().map((thread) => [thread.threadId, thread.settled]))).toEqual({
        [`${step}`]: true, [`${step}:task`]: true, [`${step}:task:task`]: true, 'thread-person-1': false, 'thread-person-1:task': false,
      });
      expect(noticesOf(runtime)).toEqual([]);
    });

    // T3 lists threads by their last change, newest first; a task the step delegated changed after the step was launched.
    it('lists only the threads changed since the step was launched to settle its tasks, however many the person left unsettled', async () => {
      t3.config({ agent: { output: { verdict: 'approve' }, delegates: true } });
      const lastWeek = new Date(Date.now() - 7 * 24 * 3_600_000).toISOString();

      for (let index = 0; index < 250; index += 1) t3.addThread({ threadId: `thread-person-${index}`, title: `Older work ${index}`, status: 'completed', updatedAt: lastWeek });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-00000038'));
      expect(await ended(runtime, 'op-00000038')).toMatchObject({ event: 'finished' });
      const step = t3.threads().find((thread) => thread.title === `review · teamai ${RUN}`)?.threadId;

      runtime.send({ type: 'close', handle });
      await runtime.next((line) => line['handle'] === handle && line['event'] === 'closed');

      const settled = Object.fromEntries(t3.threads().filter((thread) => thread.threadId.startsWith(`${step}`)).map((thread) => [thread.threadId, thread.settled]));
      expect(settled).toEqual({ [`${step}`]: true, [`${step}:task`]: true, [`${step}:task:task`]: true });
      expect(t3.threads().filter((thread) => thread.threadId.startsWith('thread-person-') && thread.settled)).toEqual([]);
      expect(t3.calls().filter((call) => call.tool === 't3_thread_list' && call.args['settled'] === false)).toHaveLength(1);
    });

    it('says once that a thread could not be settled, and the step still counts', async () => {
      t3.config({ organizeFails: true });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-00000034'));
      expect(await ended(runtime, 'op-00000034')).toMatchObject({ event: 'finished', result: { output: { verdict: 'approve' } } });
      const threadId = t3.threads()[0]?.threadId;

      runtime.send({ type: 'collect', handle });
      expect(await runtime.next((line) => line['event'] === 'collected')).toEqual({ event: 'collected', handle });
      runtime.send({ type: 'collect', handle });
      expect(await runtime.next((line) => line['event'] === 'collected')).toEqual({ event: 'collected', handle });
      runtime.send({ type: 'close', handle });
      expect(await runtime.next((line) => line['event'] === 'closed')).toEqual({ event: 'closed', handle });

      expect(noticesOf(runtime)).toEqual([{
        event: 'notice', handle,
        message: `teamai could not settle the T3 thread ${linkTo(threadId)} ("review · teamai ${RUN}"), so it stays in T3 Code's active threads: Thread ${threadId} cannot be organized now.`,
      }]);
      expect(t3.threads()[0]?.settled).toBe(false);
    });

    it('answers close_failed, keeping the place, when T3 acknowledges the stop but the thread\'s run does not end', async () => {
      t3.config({ agent: { hold: true, output: {} }, waitCapMs: 50 });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-00000038'));
      await runtime.next((line) => line['op'] === 'op-00000038' && line['event'] === 'accepted');
      await expect.poll(() => t3.threads()[0]?.status).toBe('running');
      t3.config({ stopLagMs: 60_000 });

      runtime.send({ type: 'close', handle });

      expect(await runtime.next((line) => line['handle'] === handle && line['event'] !== 'accepted')).toMatchObject({
        event: 'close_failed', handle, failure: { code: 'thread_still_runs', message: expect.stringContaining('T3 Code acknowledged the stop, but its run was still running') },
      });
      expect(t3.threads()[0]).toMatchObject({ status: 'running', settled: false });
    });

    // T3 acknowledges a stop before the run ends, so close waits for the run's end before it settles the thread.
    it('stops a thread still running when teamai closes its place, settles it once its run ends, then answers closed', async () => {
      t3.config({ agent: { hold: true, output: {} } });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-0000001f'));
      await runtime.next((line) => line['op'] === 'op-0000001f' && line['event'] === 'accepted');
      await expect.poll(() => t3.threads()[0]?.status).toBe('running');
      t3.config({ stopLagMs: 1_000 });

      runtime.send({ type: 'close', handle });

      expect(await runtime.next((line) => line['handle'] === handle && line['event'] !== 'accepted')).toEqual({ event: 'closed', handle });
      expect(t3.threads()[0]).toMatchObject({ status: 'interrupted', settled: true });
      // The prompt it stopped ends once, before the place is forgotten.
      const events = runtime.lines.filter((line) => line['op'] === 'op-0000001f' || line['event'] === 'closed').map((line) => line['event']);
      expect(events).toEqual(['accepted', 'display', 'cancelled', 'closed']);
    });

    it('stops every thread of the place at once when teamai closes it, within the close bound', async () => {
      t3.config({ agent: { hold: true, output: {} } });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-0000006d'));
      runtime.send(prompt(handle, 'op-0000006e'));
      await expect.poll(() => t3.threads().map((thread) => thread.status)).toEqual(['running', 'running']);
      t3.config({ interruptMs: 6_000 });
      const closedAt = Date.now();

      runtime.send({ type: 'close', handle });

      expect(await runtime.next((line) => line['handle'] === handle, 20_000)).toEqual({ event: 'closed', handle });
      expect(Date.now() - closedAt).toBeLessThan(10_000);
      expect(t3.threads().map((thread) => thread.status)).toEqual(['interrupted', 'interrupted']);
    }, 30_000);

    it('answers close_failed, keeping the place, when T3 will not stop a thread still running there', async () => {
      t3.config({ agent: { hold: true, output: {} } });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-00000020'));
      await runtime.next((line) => line['op'] === 'op-00000020' && line['event'] === 'accepted');
      await expect.poll(() => t3.threads()[0]?.status).toBe('running');
      t3.config({ interruptFails: true });
      const [thread] = t3.threads();

      runtime.send({ type: 'close', handle });

      const answer = await runtime.next((line) => line['handle'] === handle && line['event'] !== 'accepted');
      expect(RuntimeMessageSchema.safeParse(answer).success).toBe(true);
      expect(answer).toEqual({
        event: 'close_failed', handle, failure: {
          code: 'thread_still_runs',
          message: `The T3 thread ${linkTo(thread?.threadId)} ("review · teamai ${RUN}") still runs, and T3 Code did not stop it: Thread ${thread?.threadId} has a run T3 cannot interrupt now. Stop it in T3 Code with its Stop button.`,
        },
      });
      runtime.send({ type: 'reattach', handle });
      expect(await runtime.next((line) => line['event'] === 'alive')).toMatchObject({ ops: [{ op: 'op-00000020', state: 'running' }] });
    });

    // `workflow cancel --release` let the attempt go: a launch T3 answers later finds no place to record its thread in.
    it('does not record a released place again when T3 answers its launch after the close gave up on it', async () => {
      t3.config({ agent: { hold: true, output: {} }, launchMs: 12_000 });
      const { runtime, handle } = await opened();
      const record = path.join(t3.home, '.teamai', 'runtime-state', 't3', 'places', `${encodeURIComponent(handle)}.json`);
      runtime.send(prompt(handle, 'op-000000b0'));
      await runtime.next((line) => line['op'] === 'op-000000b0' && line['event'] === 'accepted');

      runtime.send({ type: 'close', handle, release: true });

      expect(await runtime.next((line) => line['handle'] === handle, 15_000)).toMatchObject({ event: 'close_failed', handle, failure: { code: 't3_unavailable' } });
      expect(fs.existsSync(record)).toBe(false);
      await runtime.next((line) => line['op'] === 'op-000000b0' && line['event'] === 'display', 10_000);
      expect(fs.existsSync(record)).toBe(false);
      runtime.send({ type: 'reattach', handle });
      expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'gone', handle });
    }, 40_000);

    it('does not record a released place when its open ends after the close gave up on it', async () => {
      const runtime = await initialized();
      t3.config({ projectsMs: 12_000 });
      const handle = `t3-${RUN}-a1b2c3d4`;
      const record = path.join(t3.home, '.teamai', 'runtime-state', 't3', 'places', `${encodeURIComponent(handle)}.json`);
      runtime.send({ type: 'open', op: 'op-000000b1', run: RUN, attempt: 'a1b2c3d4', credentials: {}, view: { worktree, readonly: [], result: path.dirname(result), runDir: path.join(dir, 'run'), toolHome: {} } });
      await runtime.next((line) => line['op'] === 'op-000000b1' && line['event'] === 'accepted');

      runtime.send({ type: 'close', handle, release: true });

      expect(await runtime.next((line) => line['handle'] === handle && line['event'] !== 'accepted' && !isNotice(line), 15_000)).toMatchObject({ event: 'close_failed', handle, failure: { code: 't3_unavailable' } });
      expect(await runtime.next((line) => line['op'] === 'op-000000b1' && line['event'] !== 'accepted' && !isNotice(line), 10_000)).toEqual({
        op: 'op-000000b1', event: 'failed', failure: { code: 'open_failed', message: `teamai released ${handle} while T3 Code was still opening it, so the runtime does not keep it.` },
      });
      expect(fs.existsSync(record)).toBe(false);
      runtime.send({ type: 'reattach', handle });
      expect(await runtime.next((line) => line['handle'] === handle && line['event'] !== 'accepted' && !isNotice(line))).toEqual({ event: 'gone', handle });
    }, 40_000);

    // T3 answers a stop of a thread the person deleted thread_not_found: nothing of it runs any more.
    it('counts a thread the person deleted in T3 as stopped and settled, so close finishes', async () => {
      t3.config({ agent: { waits: true }, interruptFails: true });
      const { runtime, handle } = await opened('unattended');
      runtime.send(prompt(handle, 'op-00000050'));
      expect(await ended(runtime, 'op-00000050')).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed' } });
      t3.config({ interruptFails: false });
      t3.deleteThread(z.string().parse(t3.threads()[0]?.threadId));

      runtime.send({ type: 'close', handle });

      expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'closed', handle });
      expect(runtime.stderr()).not.toContain('could not settle');
    });

    it('keeps a place whose record it cannot read, failing what needs it with the file to look at, rather than answering gone', async () => {
      const { runtime, handle } = await opened();
      const record = path.join(t3.home, '.teamai', 'runtime-state', 't3', 'places', `${encodeURIComponent(handle)}.json`);
      fs.writeFileSync(record, '{broken');
      const unreadable = { code: 'journal_unreadable', message: expect.stringContaining(record) };

      runtime.send({ type: 'reattach', handle });
      expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'failed', handle, failure: unreadable });
      // The record may hold the op's thread, launched by a runtime before this one, so the prompt may still run.
      runtime.send(prompt(handle, 'op-00000049'));
      expect(await ended(runtime, 'op-00000049')).toEqual({ op: 'op-00000049', event: 'failed', failure: { ...unreadable, code: 'cancel_failed' } });
      runtime.send({ type: 'collect', handle });
      expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'collect_failed', handle, failure: unreadable });
      runtime.send({ type: 'close', handle });
      expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'close_failed', handle, failure: unreadable });

      expect(fs.readFileSync(record, 'utf8')).toBe('{broken');
      expect(t3.threads()).toEqual([]);
    });

    // teamai may close a place it opened before the open answered: close waits for the open, then removes what it made.
    it('closes a place only once its open finished, leaving no record of it', async () => {
      t3.config({ projectsMs: 2_000 });
      const runtime = start();
      runtime.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'attended', options: { environment: 'local' } });
      await runtime.next((line) => line['type'] === 'init');
      runtime.send({ type: 'open', op: 'op-00000072', run: RUN, attempt: 'a1b2c3d4', credentials: {}, view: { worktree, readonly: [], result: path.dirname(result), runDir: path.join(dir, 'run'), toolHome: {} } });
      const handle = z.string().parse((await runtime.next((line) => line['op'] === 'op-00000072'))['handle']);

      runtime.send({ type: 'close', handle });

      expect(await runtime.next((line) => line['handle'] === handle && line['event'] !== 'accepted', 15_000)).toEqual({ event: 'closed', handle });
      expect(runtime.lines.filter((line) => line['op'] === 'op-00000072').map((line) => line['event'])).toEqual(['accepted', 'ready']);
      runtime.send({ type: 'reattach', handle });
      expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'gone', handle });
    });

    it('answers reattach of a closed place gone', async () => {
      const { runtime, handle } = await opened();
      runtime.send({ type: 'collect', handle });
      expect(await runtime.next((line) => line['event'] === 'collected')).toEqual({ event: 'collected', handle });
      runtime.send({ type: 'close', handle });
      expect(await runtime.next((line) => line['event'] === 'closed')).toEqual({ event: 'closed', handle });

      runtime.send({ type: 'reattach', handle });

      expect(await runtime.next((line) => line['event'] === 'gone')).toEqual({ event: 'gone', handle });
    });

    describe('through a sandbox', () => {
      const SANDBOX = 'sandbox-r7f3a91c2';
      let bin: string;
      let toolHome: string;
      let socketDir: string;
      let server: net.Server;
      let lines: string[];
      const clients = new Set<net.Socket>();

      beforeEach(async () => {
        // teamai's wrapper on the member's PATH, which T3 starts in place of the tool.
        bin = path.join(dir, 'teamai-bin');
        fs.mkdirSync(bin);
        fs.writeFileSync(path.join(bin, SANDBOX_CLAUDE), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        toolHome = path.join(dir, 'attempt', 'tool-home', 'claude');
        fs.mkdirSync(toolHome, { recursive: true });
        t3.config({ wrappedHome: toolHome });
        // The sandbox's attempt socket. A unix socket's path must stay short: macOS's own temporary folder is too deep.
        socketDir = fs.mkdtempSync('/tmp/teamai-t3-outer-');
        lines = [];
        server = net.createServer((client) => {
          clients.add(client);
          client.on('close', () => clients.delete(client));
          client.setEncoding('utf8').on('data', (data: string) => lines.push(...data.split('\n').filter(Boolean)));
        });
        await new Promise<void>((resolve) => server.listen(path.join(socketDir, 'attempt.sock'), resolve));
      });

      afterEach(async () => {
        for (const client of clients) client.destroy();
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(socketDir, { recursive: true, force: true });
      });

      const outer = (): string => JSON.stringify({ place: SANDBOX, socket: path.join(socketDir, 'attempt.sock') });

      const settingsNow = (): unknown => {
        const file = path.join(t3.t3Home, 'userdata', 'settings.json');

        return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
      };

      const throughSandbox = async (env: Record<string, string> = {}): Promise<Connection> => {
        const runtime = start({ PATH: [bin, t3.bin, PATH_WITHOUT_T3].join(path.delimiter), ...env });
        runtime.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' }, homeEnv: SHIPPED_HOME_ENV });
        expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: true });

        return runtime;
      };

      /** Opens the step's place with the sandbox's handle as its outer, and answers how the open ended. */
      const openThrough = async (runtime: Connection, handle: string = outer(), tool = 'claude'): Promise<Line> => {
        runtime.send({ type: 'open', op: OPEN, run: RUN, attempt: 'a1b2c3d4', tool, credentials: {}, outer: handle, view: { worktree, readonly: [], result: path.dirname(result), runDir: path.join(dir, 'run'), toolHome: { CLAUDE_CONFIG_DIR: toolHome } } });
        await runtime.next((line) => line['op'] === OPEN && line['event'] === 'accepted');

        return runtime.next((line) => line['op'] === OPEN && line['event'] !== 'accepted' && !isNotice(line), 30_000);
      };

      it('registers the step\'s tool on the attempt socket before it runs, through teamai\'s wrapper, and finds the session in the attempt\'s tool home', async () => {
        const runtime = await throughSandbox();

        expect(await openThrough(runtime)).toMatchObject({ event: 'ready' });
        await expect.poll(() => lines).toEqual([REGISTERED]);
        expect(settingsNow()).toMatchObject({
          providerInstances: { [SANDBOX_CLAUDE]: { driver: 'claudeAgent', displayName: SANDBOX_CLAUDE, enabled: true, config: { binaryPath: path.join(bin, SANDBOX_CLAUDE) } } },
        });

        runtime.send(prompt(`t3-${RUN}-a1b2c3d4`, 'op-0000000b'));

        expect(await ended(runtime, 'op-0000000b')).toMatchObject({ event: 'finished', session: { tool: 'claude', home: toolHome } });
        expect(t3.calls().find((call) => call.tool === 't3_thread_launch')?.args['modelSelection']).toMatchObject({ instanceId: SANDBOX_CLAUDE });
      });

      it('adds teamai\'s wrapper again, telling the person again, when the member removed it in T3 Code after the open', async () => {
        const runtime = await throughSandbox();
        expect(await openThrough(runtime)).toMatchObject({ event: 'ready' });
        t3.settings({});

        runtime.send(prompt(`t3-${RUN}-a1b2c3d4`, 'op-0000000c'));

        expect(await ended(runtime, 'op-0000000c')).toMatchObject({ event: 'finished', session: { tool: 'claude', home: toolHome } });
        expect(settingsNow()).toMatchObject({ providerInstances: { [SANDBOX_CLAUDE]: { driver: 'claudeAgent', config: { binaryPath: path.join(bin, SANDBOX_CLAUDE) } } } });
        expect(noticesOf(runtime).filter((line) => String(line['message']).startsWith(`Added the T3 Code provider instance "${SANDBOX_CLAUDE}"`)).map((line) => line['op'])).toEqual([OPEN, 'op-0000000c']);
        expect(t3.calls().find((call) => call.tool === 't3_thread_launch')?.args['modelSelection']).toMatchObject({ instanceId: SANDBOX_CLAUDE });
      });

      it('registers the step\'s tool again when a runtime started after its own restart reattaches the place', async () => {
        const first = await throughSandbox();
        expect(await openThrough(first)).toMatchObject({ event: 'ready' });
        await expect.poll(() => lines).toHaveLength(1);
        await first.close();

        const second = await throughSandbox();
        second.send({ type: 'reattach', handle: `t3-${RUN}-a1b2c3d4` });

        expect(await second.next((line) => line['event'] === 'alive')).toMatchObject({ handle: `t3-${RUN}-a1b2c3d4` });
        await expect.poll(() => lines).toEqual([REGISTERED, REGISTERED]);
      });

      it('fails the open, naming the fix and adding no provider instance, when the outer runtime gives no attempt socket to register on', async () => {
        const runtime = await throughSandbox();

        expect(await openThrough(runtime, SANDBOX)).toMatchObject({
          event: 'failed',
          failure: { code: 'open_failed', message: `Runtime t3 runs a tool through another runtime only on that runtime's attempt socket, and teamai could not register this step's tool on it (its handle names no attempt socket), so the sandbox would refuse the tool. Run T3 through a sandbox provider that serves one: sbx, or docker 26.0.0 or later (25.0.5, 23.0.11) on Docker Desktop or on this Linux machine, on an image that holds node.` },
        });
        expect(settingsNow()).not.toHaveProperty(['providerInstances', SANDBOX_CLAUDE]);
      });

      it('ends the step\'s registration on the attempt socket when the open fails after registering it', async () => {
        t3.config({ projects: [], projectAddFails: 4 });
        const runtime = await throughSandbox();

        expect(await openThrough(runtime)).toMatchObject({ event: 'failed', failure: { code: 'not_a_t3_project' } });
        await expect.poll(() => lines).toHaveLength(1);
        await expect.poll(() => clients.size).toBe(0);
      });

      it('refuses Codex before registering anything or adding a provider instance, since T3 cannot run it through a sandbox', async () => {
        fs.writeFileSync(path.join(bin, 'teamai-sandbox-codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        const runtime = await throughSandbox();

        expect(await openThrough(runtime, outer(), 'codex')).toMatchObject({
          event: 'failed',
          failure: { code: 'open_failed', message: 'Runtime t3 runs only Claude through a sandbox: T3 Code starts Codex as an app server outside the step\'s folder, and teamai\'s wrapper cannot yet tell which attempt it belongs to. Run this step on T3 without through: sandbox, or on the sandbox runtime alone.' },
        });
        expect(lines).toEqual([]);
        expect(settingsNow()).not.toHaveProperty(['providerInstances', 'teamai-sandbox-codex']);
      });

      it('fails the open, naming the command, when teamai\'s wrapper for the tool is not on PATH', async () => {
        fs.rmSync(path.join(bin, SANDBOX_CLAUDE));
        const runtime = await throughSandbox();

        expect(await openThrough(runtime)).toMatchObject({
          event: 'failed',
          failure: { code: 'open_failed', message: expect.stringContaining(`${SANDBOX_CLAUDE} is not on PATH here`) },
        });
      });
    });
  });
});
