import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { RUN_DIR_ENV, RuntimeMessageSchema, WORKFLOW_DIR_ENV } from '@teamai/runtime-protocol';
import { encodeCwdClaude } from '@teamai/tool-core/sessions/fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CLAUDE, CODEX, credentialsFile, fakeT3, signIn, type Connection, type FakeT3Config, type Line } from './testing/harness.js';
import { checkout, dir, ended, initialized, linkTo, noticesOf, opened, openOn, prompt, result, RUN, start, t3, replaceT3, SHIPPED_HOME_ENV, usePromptStep, useT3Runtime, worktree } from './testing/suite.js';

describe('teamai-runtime-t3', () => {
  useT3Runtime();

  describe('a prompt step', () => {
    usePromptStep();

    describe('with no mode or model set for the step', () => {
      it.each<{ set: string; settings: Line; options: Line; mode: string }>([
        { set: 'the member\'s T3 default mode', settings: { defaultRuntimeMode: 'approval-required' }, options: {}, mode: 'approval-required' },
        { set: 'the project\'s default mode, over the global one', settings: { defaultRuntimeMode: 'approval-required', projectSettingsOverrides: { 'project-1': { defaultRuntimeMode: 'auto-accept-edits' } } }, options: {}, mode: 'auto-accept-edits' },
        { set: 'runtime_mode, over the member\'s default', settings: { defaultRuntimeMode: 'approval-required' }, options: { runtime_mode: 'auto' }, mode: 'auto' },
        { set: 'no default at all', settings: {}, options: {}, mode: 'auto' },
      ])('starts the thread in $set', async ({ settings, options, mode }) => {
        t3.settings(settings);
        const { runtime, handle } = await opened('attended', {}, options);
        runtime.send(prompt(handle, 'op-0000000b'));

        expect(await ended(runtime, 'op-0000000b')).toMatchObject({ event: 'finished' });
        expect(t3.calls().find((call) => call.tool === 't3_thread_launch')?.args['runtimeMode']).toBe(mode);
        expect(runtime.stderr()).toBe('');
        expect(noticesOf(runtime)).toEqual([]);
      });

      it('starts threads in Auto, never in full access, when that is the member\'s T3 default, and says so once', async () => {
        t3.settings({ defaultRuntimeMode: 'full-access' });
        const { runtime, handle } = await opened();
        runtime.send(prompt(handle, 'op-0000000b'));
        runtime.send(prompt(handle, 'op-0000000c', { step: 'second' }));

        expect(await ended(runtime, 'op-0000000b')).toMatchObject({ event: 'finished' });
        expect(await ended(runtime, 'op-0000000c')).toMatchObject({ event: 'finished' });
        expect(t3.calls().filter((call) => call.tool === 't3_thread_launch').map((call) => call.args['runtimeMode'])).toEqual(['auto', 'auto']);
        expect(noticesOf(runtime)).toEqual([{ event: 'notice', op: 'op-0000000b', handle, message: 'T3\'s default mode is Full access; teamai starts its threads in Auto unless runtime_mode says full-access.' }]);
        expect(runtime.stderr()).toBe('');
      });

      // T3 applies the member's default, its options, and their fallback once its usage is spent, only to a launch that names no model.
      it('names no model when the step\'s tool runs on the instance of the member\'s default, so T3 applies that default, and shows the model T3 chose', async () => {
        t3.settings({ defaultModelSelection: { instanceId: 'claudeAgent', model: 'claude-sonnet-5-5' } });
        const { runtime, handle } = await opened();
        runtime.send(prompt(handle, 'op-0000000b', { model: undefined }));

        expect(await runtime.next((line) => line['op'] === 'op-0000000b' && line['event'] === 'display')).toMatchObject({ display: { fields: { model: 'claude-sonnet-5-5' } } });
        expect(await ended(runtime, 'op-0000000b')).toMatchObject({ event: 'finished' });
        expect(t3.calls().find((call) => call.tool === 't3_thread_launch')?.args).not.toHaveProperty('modelSelection');
        expect(t3.threads()[0]).toMatchObject({ provider: 'claudeAgent', model: 'claude-sonnet-5-5' });
      });

      it('runs a tool on the instance of the project\'s default model, over the global default', async () => {
        t3.config({ providers: [CLAUDE, { ...CLAUDE, providerInstanceId: 'claude-work', displayName: 'Claude (work)' }, CODEX] });
        t3.settings({ defaultModelSelection: { instanceId: 'claudeAgent', model: 'claude-opus-5-5' }, projectSettingsOverrides: { 'project-1': { defaultModelSelection: { instanceId: 'claude-work', model: 'claude-opus-5-5' } } } });
        const runtime = start({}, checkout);
        runtime.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'attended', options: { environment: 'local' } });
        expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: true });
        expect(await openOn(runtime, worktree)).toMatchObject({ event: 'ready' });
        runtime.send(prompt(`t3-${RUN}-a1b2c3d4`, 'op-0000000b', { model: { name: 'claude-sonnet-5-5' } }));

        expect(await ended(runtime, 'op-0000000b')).toMatchObject({ event: 'finished' });
        expect(t3.calls().find((call) => call.tool === 't3_thread_launch')?.args['modelSelection']).toEqual({ instanceId: 'claude-work', model: 'claude-sonnet-5-5' });
      });

      it('offers no tool whose instance the member turned off for the checkout\'s project, though it is on globally', async () => {
        t3.settings({ projectSettingsOverrides: { 'project-1': { providerInstances: { codex: { enabled: false } } } } });
        const runtime = start({}, checkout);

        runtime.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'attended', options: { environment: 'local' } });

        expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: true, can: { tools: ['claude'] } });
      });
    });

    it('runs as a T3 thread of its own on the attempt\'s worktree, then ends finished with the result and the session', async () => {
      const { runtime, handle } = await opened('attended', { T3CODE_THREAD_ID: 'thread-parent-1' });
      const op = 'op-0000000b';

      runtime.send(prompt(handle, op));

      // The prompt is accepted before the launch, and its thread is shown once T3 launched it, so the run details link it during the run.
      expect(await runtime.next((line) => line['op'] === op)).toEqual({ op, event: 'accepted' });
      const shown = await runtime.next((line) => line['op'] === op);
      expect(RuntimeMessageSchema.safeParse(shown).success).toBe(true);
      expect(shown).toEqual({
        op, event: 'display',
        display: { label: `review · teamai ${RUN}`, url: expect.stringMatching(/^t3code:\/\/threads\/env-fake-1\/mcp%3Alaunch%3A[0-9a-f]{64}$/), fields: { thread: expect.stringMatching(/^mcp:launch:/), model: 'claude-opus-5-5', environment: 'fake-laptop' } },
      });
      const end = await ended(runtime, op);
      expect(RuntimeMessageSchema.safeParse(end).success).toBe(true);
      // The fake agent bills no request, so the runtime, which offers tokens, says why it reports none.
      expect(end).toEqual({
        op, event: 'finished', session: { tool: 'claude', id: expect.stringMatching(/^[0-9a-f-]{36}$/) }, result: { output: { verdict: 'approve' } },
        unmeasured: { cause: expect.stringContaining('records no request since the step started'), next: 'Retry the step.' },
      });

      const [thread] = t3.threads();
      expect(thread).toMatchObject({
        title: `review · teamai ${RUN}`, worktreePath: worktree, projectId: 'project-1', provider: 'claudeAgent', model: 'claude-opus-5-5',
        runtimeMode: 'auto', status: 'completed',
      });
      // In T3's own chat form, which T3 shows as a link to that thread.
      expect(thread?.message).toMatch(new RegExp(`^This thread runs step "review" of teamai workflow run ${RUN} \\(attempt a1b2c3d4\\)\\. It was started from the T3 thread <t3-thread://v2/env-fake-1/thread-parent-1>\\.`));
      expect(thread?.message).toContain(`Write the workflow result as JSON to ${result}.`);
      expect(t3.calls().find((call) => call.tool === 't3_thread_launch')?.args).toMatchObject({ clientRequestId: op, workspaceStrategy: { type: 'existing_worktree', worktreePath: worktree } });
      expect(t3.calls().find((call) => call.tool === 't3_thread_launch')?.args).not.toHaveProperty('delegatedFrom');
    });

    // teamai ends a prompt lost that is not accepted within 15 s, and T3 may take a while to launch a thread.
    it('accepts a prompt before T3 answers its launch, and shows the thread once it did', async () => {
      t3.config({ launchMs: 3_000 });
      const { runtime, handle } = await opened();
      const sentAt = Date.now();

      runtime.send(prompt(handle, 'op-00000064'));

      expect(await runtime.next((line) => line['op'] === 'op-00000064')).toEqual({ op: 'op-00000064', event: 'accepted' });
      expect(Date.now() - sentAt).toBeLessThan(2_000);
      expect(await runtime.next((line) => line['op'] === 'op-00000064', 10_000)).toMatchObject({ event: 'display', display: { url: linkTo(t3.threads()[0]?.threadId) } });
      expect(await ended(runtime, 'op-00000064')).toMatchObject({ event: 'finished' });
    });

    // A failure after the acceptance ends the op once, with no second acceptance. Only a check's refusal proves T3
    // launched nothing, so this one leaves a thread that may run, and the op ends as a stop teamai could not confirm.
    it('accepts once a prompt whose launch T3 refuses after accepting it', async () => {
      t3.config({ launchFails: true });
      const { runtime, handle } = await opened();

      runtime.send(prompt(handle, 'op-00000065'));

      expect(await ended(runtime, 'op-00000065')).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed', message: expect.stringContaining('T3 Code cannot launch threads now') } });
      expect(runtime.lines.filter((line) => line['op'] === 'op-00000065').map((line) => line['event'])).toEqual(['accepted', 'failed']);
    });

    // Only a check a new launch runs proves T3 launched nothing: the op keeps its own failure, and close, finding the same
    // refusal when it repeats the launch, forgets it.
    it('fails t3_launch_failed when a new launch\'s check refuses the thread, and closes once the repeated launch is refused the same way', async () => {
      t3.config({ launchInvalid: true });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-00000078'));

      expect(await ended(runtime, 'op-00000078')).toEqual({ op: 'op-00000078', event: 'failed', failure: { code: 't3_launch_failed', message: expect.stringContaining('is not a worktree of project project-1') } });
      runtime.send({ type: 'close', handle });

      expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'closed', handle });
      expect(t3.calls().filter((call) => call.tool === 't3_thread_launch').map((call) => call.args['clientRequestId'])).toEqual(['op-00000078', 'op-00000078']);
    });

    it.each(['auto-accept-edits', 'approval-required'])('runs every thread in %s when `runtime_mode` tightens it', async (runtimeMode) => {
      const { runtime, handle } = await opened('attended', {}, { runtime_mode: runtimeMode });

      runtime.send(prompt(handle, 'op-0000001a'));

      expect(await ended(runtime, 'op-0000001a')).toMatchObject({ event: 'finished' });
      expect(t3.threads()[0]?.runtimeMode).toBe(runtimeMode);
    });

    it('runs every thread in full access when `runtime_mode` is full-access', async () => {
      const { runtime, handle } = await opened('attended', {}, { runtime_mode: 'full-access' });

      runtime.send(prompt(handle, 'op-0000001c'));

      expect(await ended(runtime, 'op-0000001c')).toMatchObject({ event: 'finished' });
      expect(t3.threads()[0]?.runtimeMode).toBe('full-access');
      expect(noticesOf(runtime)).toEqual([]);
    });

    it('fails sign_in_too_narrow, asking for Full access, when T3 refuses a full-access thread on the kept sign-in', async () => {
      t3.config({ access: 'auto' });
      const { runtime, handle } = await opened('attended', {}, { runtime_mode: 'full-access' });

      runtime.send(prompt(handle, 'op-0000001d'));

      expect(await ended(runtime, 'op-0000001d')).toEqual({
        op: 'op-0000001d', event: 'failed', failure: {
          code: 'sign_in_too_narrow',
          message: 'T3 Code refused to start the step\'s thread in full-access mode, because teamai\'s sign-in does not allow it (Child runtime mode full-access is broader than parent mode auto.). Remove ~/.teamai/runtime-state/t3/credentials.json and start the workflow again; teamai signs in again; approve it with Full access if T3 Code asks. Or set runtime_mode to a mode the sign-in allows.',
        },
      });
    });

    it('runs an Auto thread on the sign-in a run at a tighter runtime_mode left', async () => {
      fs.rmSync(credentialsFile(t3.home));
      const tighter = start();
      tighter.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'unattended', options: { environment: 'local', runtime_mode: 'approval-required' } });
      expect(await tighter.next((line) => line['type'] === 'init')).toMatchObject({ ok: true });
      await tighter.close();

      const { runtime, handle } = await opened('unattended');
      runtime.send(prompt(handle, 'op-000000c7'));

      const end = await ended(runtime, 'op-000000c7');
      expect(end, JSON.stringify(end)).toMatchObject({ event: 'finished' });
      expect(t3.threads()[0]?.runtimeMode).toBe('auto');
      expect(t3.calls().filter((call) => call.tool === 'oauth_token')).toHaveLength(1);
    });

    it('fails sign_in_too_narrow, naming the fix, when the sign-in does not allow the mode the thread runs in', async () => {
      t3.config({ access: 'approval-required' });
      const { runtime, handle } = await opened();

      runtime.send(prompt(handle, 'op-0000001b'));

      expect(await ended(runtime, 'op-0000001b')).toEqual({
        op: 'op-0000001b', event: 'failed', failure: {
          code: 'sign_in_too_narrow',
          message: 'T3 Code refused to start the step\'s thread in auto mode, because teamai\'s sign-in does not allow it (Child runtime mode auto is broader than parent mode approval-required.). Remove ~/.teamai/runtime-state/t3/credentials.json and start the workflow again; teamai signs in again; approve it with Auto access if T3 Code asks. Or set runtime_mode to a mode the sign-in allows.',
        },
      });
      expect(t3.threads()).toEqual([]);

      // T3 refuses the repeated launch close looks the thread up with as well: there was none, and none is left.
      runtime.send({ type: 'close', handle });
      expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'closed', handle });
      expect(t3.threads()).toEqual([]);
    });

    // Once a step ended and T3 holds no run of its thread, teamai settles it at close, since a later step may continue it
    // until then: it leaves the active list and still opens from its link.
    it.each([
      { ended: 'finished', agent: { output: { verdict: 'approve' } }, event: 'finished' },
      { ended: 'finished, reporting the step failed', agent: { failure: { code: 'tests_failed', message: 'npm test fails in src/cart.test.ts.' } }, event: 'finished' },
      { ended: 'failed', agent: { fail: true }, event: 'failed' },
      { ended: 'cancelled', agent: { hold: true, output: {} }, event: 'cancelled' },
    ])('settles the thread of a step that ended $ended once teamai closes its place', async ({ agent, event }) => {
      t3.config({ agent });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-00000030'));
      await runtime.next((line) => line['op'] === 'op-00000030' && line['event'] === 'accepted');

      if (event === 'cancelled') {
        await expect.poll(() => t3.threads()[0]?.status).toBe('running');
        runtime.send({ type: 'cancel', op: 'op-00000030' });
      }

      expect(await ended(runtime, 'op-00000030')).toMatchObject({ event });
      expect(t3.threads()[0]?.settled).toBe(false);

      runtime.send({ type: 'collect', handle });

      expect(await runtime.next((line) => line['event'] === 'collected')).toEqual({ event: 'collected', handle });
      expect(t3.threads()[0]?.settled).toBe(false);
      const { threadId } = t3.threads()[0] ?? {};
      runtime.send({ type: 'close', handle });

      expect(await runtime.next((line) => line['handle'] === handle && line['event'] === 'closed')).toEqual({ event: 'closed', handle });
      expect(t3.calls().filter((call) => call.tool === 't3_thread_organize').map((call) => call.args)).toEqual([{ threadId, action: 'settle' }]);
    });

    it('started outside a T3 thread, names no thread it was started from', async () => {
      const { runtime, handle } = await opened();

      runtime.send(prompt(handle, 'op-0000000c'));

      expect(await ended(runtime, 'op-0000000c')).toMatchObject({ event: 'finished' });
      expect(t3.threads()[0]?.message).not.toContain('started from');
    });

    it('names in its first message the run\'s scratch directory and the workflow\'s folder, which the thread\'s shell is not given', async () => {
      const { runtime, handle } = await opened();
      const folder = path.join(dir, 'folders', 'f1');

      runtime.send({ ...prompt(handle, 'op-0000000d'), env: { [RUN_DIR_ENV]: path.join(dir, 'scratch'), [WORKFLOW_DIR_ENV]: folder } });

      expect(await ended(runtime, 'op-0000000d')).toMatchObject({ event: 'finished' });
      expect(t3.threads()[0]?.message).toContain(`Its shell has no ${RUN_DIR_ENV} or ${WORKFLOW_DIR_ENV}: the run's scratch directory is ${path.join(dir, 'scratch')}, and the workflow's folder ${folder}.`);
    });

    it('runs a Codex step on the Codex instance with the effort the lease asks, and finds its session', async () => {
      const { runtime, handle } = await opened();

      runtime.send(prompt(handle, 'op-0000000d', { tool: 'codex', model: { name: 'gpt-6.1-sol', effort: 'high' } }));

      expect(await ended(runtime, 'op-0000000d')).toMatchObject({ event: 'finished', session: { tool: 'codex', id: expect.stringMatching(/^[0-9a-f-]{36}$/) } });
      expect(t3.calls().find((call) => call.tool === 't3_thread_launch')?.args['modelSelection']).toEqual({ instanceId: 'codex', model: 'gpt-6.1-sol', options: [{ id: 'reasoningEffort', value: 'high' }] });
    });

    // Each tool reports its tokens as its own end-of-run usage counts them: Claude's input leaves the cache out, Codex's
    // counts cached input inside it.
    it.each([
      { tool: 'claude', model: 'claude-opus-5-5', usage: { input: 1_200, output: 340, cachedInput: 18_000 } },
      { tool: 'codex', model: 'gpt-6.1-sol', usage: { input: 19_200, output: 340, cachedInput: 18_000 } },
    ])('reports the tokens the $tool session\'s transcript records for the step', async ({ tool, model, usage }) => {
      t3.config({ agent: { output: { verdict: 'approve' }, usage: { input: 1_200, output: 340, cacheRead: 18_000 } } });
      const { runtime, handle } = await opened();

      runtime.send(prompt(handle, 'op-0000000f', { tool, model: { name: model } }));

      const end = await ended(runtime, 'op-0000000f');
      expect(RuntimeMessageSchema.safeParse(end).success).toBe(true);
      expect(end).toMatchObject({ event: 'finished', session: { tool }, usage });
    });

    // T3 runs an instance's tool in the instance's own home, so scoring and resume read the session there.
    it.each([
      { tool: 'claude', instance: 'claudeAgent', model: 'claude-opus-5-5', where: '~/.claude-work', homePath: () => '~/.claude-work', home: () => path.join(t3.home, '.claude-work') },
      { tool: 'codex', instance: 'codex', model: 'gpt-6.1-sol', where: '~/.codex-work', homePath: () => '~/.codex-work', home: () => path.join(t3.home, '.codex-work') },
      { tool: 'claude', instance: 'claudeAgent', model: 'claude-opus-5-5', where: 'an absolute path', homePath: () => path.join(dir, 'accounts', 'second'), home: () => path.join(dir, 'accounts', 'second') },
    ])('finds the session of a $tool step in the home its instance names, $where, and names that home', async ({ tool, instance, model, homePath, home }) => {
      t3.settings({ providerInstances: { [instance]: { driver: instance, config: { homePath: homePath() } } } });
      const { runtime, handle } = await opened();

      runtime.send(prompt(handle, 'op-0000000e', { tool, model: { name: model } }));

      const end = await ended(runtime, 'op-0000000e');
      expect(RuntimeMessageSchema.safeParse(end).success).toBe(true);
      expect(end).toMatchObject({ event: 'finished', session: { tool, id: expect.stringMatching(/^[0-9a-f-]{36}$/), home: home() } });
    });

    // T3 runs a Codex instance that has a shadow home, its own or the one T3 gives a managed instance not named codex,
    // with only its sign-in there: it links the shadow's sessions to the instance's shared home, which scoring reads.
    it.each<{ set: string; config: Line; home(): string | undefined }>([
      { set: 'a shadow home of its own', config: { homePath: '~/.codex-work', shadowHomePath: '~/.codex-t3/work' }, home: () => path.join(t3.home, '.codex-work') },
      { set: 'the shadow home T3 gives a managed instance', config: { setupMode: 'managed' }, home: () => undefined },
    ])('names the shared home of a Codex instance with $set, where its sessions are', async ({ config, home }) => {
      t3.config({ providers: [CLAUDE, { ...CODEX, providerInstanceId: 'codex-work' }] });
      t3.settings({ providerInstances: { 'codex-work': { driver: 'codex', config } } });
      const { runtime, handle } = await opened();

      runtime.send(prompt(handle, 'op-00000025', { tool: 'codex', model: { name: 'gpt-6.1-sol' } }));

      const end = await ended(runtime, 'op-00000025');
      expect(end).toMatchObject({ event: 'finished', session: { tool: 'codex', id: expect.stringMatching(/^[0-9a-f-]{36}$/) } });
      expect(z.object({ session: z.object({ home: z.string().optional() }) }).parse(end).session.home).toBe(home());
    });

    // A member whose shell runs teamai with another HOME, such as a script's scratch HOME, still runs T3 Code as
    // themselves: an instance with no homePath keeps its sessions in the tool's home in T3 Code's own home.
    it('finds the session in the tool home of T3 Code\'s own user when teamai runs with another HOME, and names that home', async () => {
      await t3.stop();
      replaceT3(fakeT3(path.join(dir, 'member'), checkout, { t3HomeInHome: true }));
      await t3.start();
      const elsewhere = path.join(dir, 'scratch-home');
      fs.mkdirSync(elsewhere);
      const { runtime, handle } = await opened('attended', { HOME: elsewhere });

      runtime.send(prompt(handle, 'op-0000000f'));

      expect(await ended(runtime, 'op-0000000f')).toMatchObject({ event: 'finished', session: { tool: 'claude', id: expect.stringMatching(/^[0-9a-f-]{36}$/), home: path.join(t3.home, '.claude') } });
    });

    // Each home shortened against its own user's home would read alike, "~/.claude" against "~/.claude".
    it('names both homes in full when the instance runs in T3 Code\'s own user\'s home and teamai runs with another HOME', async () => {
      await t3.stop();
      replaceT3(fakeT3(path.join(dir, 'member'), checkout, { t3HomeInHome: true }));
      await t3.start();
      signIn(t3);
      t3.config({ providers: [CLAUDE, CODEX, { ...CLAUDE, providerInstanceId: 'acme-claude-t3', displayName: 'Claude (acme)' }] });
      t3.settings({ providerInstances: { 'acme-claude-t3': { config: { binaryPath: '/opt/acme/bin/acme-claude' } } } });
      const elsewhere = path.join(dir, 'scratch-home');
      fs.mkdirSync(elsewhere);
      const runtime = start({ HOME: elsewhere });
      runtime.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' }, instances: [{ name: 'acme-claude', tool: 'claude', command: 'acme-claude' }], homeEnv: { ...SHIPPED_HOME_ENV, 'acme-claude': ['CLAUDE_CONFIG_DIR'] } });
      await runtime.next((line) => line['type'] === 'init');

      const theirs = path.join(t3.home, '.claude');
      const ours = path.join(elsewhere, '.claude');
      expect(noticesOf(runtime)).toContainEqual({ event: 'notice', message: `T3 Code provider instance "acme-claude-t3" runs acme-claude in ${theirs}, while teamai gives acme-claude the home ${ours}: on T3 it signs in and keeps its sessions there. To use the same home, set the instance's Home path in T3 Code under Settings → Providers to ${ours}.` });
    });

    // teamai gives an instance with no home of its own its base tool's home, which CLAUDE_CONFIG_DIR moves.
    it.each<{ set: string; homePath: string | undefined; env: Record<string, string>; noticed: boolean }>([
      { set: 'names it when the T3 instance runs it in Claude\'s default home', homePath: undefined, env: {}, noticed: true },
      { set: 'says nothing when the T3 instance runs it in that home', homePath: 'claude-config', env: {}, noticed: false },
      // T3 sets CLAUDE_CONFIG_DIR in a thread to the home of that thread's instance, which says nothing of the tool.
      { set: 'says nothing in a run started from a T3 thread, where T3 set it', homePath: undefined, env: { T3CODE_THREAD_ID: 'thread-parent-1' }, noticed: false },
    ])('takes CLAUDE_CONFIG_DIR as the home of a command-only instance, and $set', async ({ homePath, env, noticed }) => {
      const moved = path.join(dir, 'claude-config');
      t3.config({ providers: [CLAUDE, CODEX, { ...CLAUDE, providerInstanceId: 'acme-claude-t3', displayName: 'Claude (acme)' }] });
      t3.settings({ providerInstances: { 'acme-claude-t3': { config: { binaryPath: '/opt/acme/bin/acme-claude', ...(homePath && { homePath: path.join(dir, homePath) }) } } } });
      t3.addThread({ threadId: 'thread-parent-1', title: 'Fix the README', status: 'running', instanceId: 'claudeAgent', model: 'claude-opus-5-5' });
      const runtime = start({ CLAUDE_CONFIG_DIR: moved, ...env });
      runtime.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' }, instances: [{ name: 'acme-claude', tool: 'claude', command: 'acme-claude' }], homeEnv: { ...SHIPPED_HOME_ENV, 'acme-claude': ['CLAUDE_CONFIG_DIR'] } });

      expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: true, can: { tools: ['claude', 'codex', 'acme-claude'] } });
      const expected = noticed ? [{ event: 'notice', message: `T3 Code provider instance "acme-claude-t3" runs acme-claude in ~/.claude, while teamai gives acme-claude the home ${moved}: on T3 it signs in and keeps its sessions there. To use the same home, set the instance's Home path in T3 Code under Settings → Providers to ${moved}.` }] : [];
      expect(noticesOf(runtime)).toEqual(expected);
    });

    it('reads a CLAUDE_CONFIG_DIR that starts with ~ under the member\'s home', async () => {
      t3.config({ providers: [CLAUDE, CODEX, { ...CLAUDE, providerInstanceId: 'acme-claude-t3', displayName: 'Claude (acme)' }] });
      t3.settings({ providerInstances: { 'acme-claude-t3': { config: { binaryPath: '/opt/acme/bin/acme-claude' } } } });
      const runtime = start({ CLAUDE_CONFIG_DIR: '~/.claude-moved' });
      runtime.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' }, instances: [{ name: 'acme-claude', tool: 'claude', command: 'acme-claude' }], homeEnv: { ...SHIPPED_HOME_ENV, 'acme-claude': ['CLAUDE_CONFIG_DIR'] } });

      expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: true });
      expect(noticesOf(runtime)).toEqual([{ event: 'notice', message: 'T3 Code provider instance "acme-claude-t3" runs acme-claude in ~/.claude, while teamai gives acme-claude the home ~/.claude-moved: on T3 it signs in and keeps its sessions there. To use the same home, set the instance\'s Home path in T3 Code under Settings → Providers to ~/.claude-moved.' }]);
    });

    it('runs a tool instance\'s step on the T3 provider instance whose Binary path is its command, and names the session after the instance, in that instance\'s home', async () => {
      t3.config({ providers: [CLAUDE, CODEX, { ...CLAUDE, providerInstanceId: 'acme-claude-t3', displayName: 'Claude (acme)' }] });
      t3.settings({ providerInstances: { 'acme-claude-t3': { config: { binaryPath: '/opt/acme/bin/acme-claude', homePath: '~/.acme-claude' } } } });
      const runtime = start();
      runtime.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' }, instances: [{ name: 'acme-claude', tool: 'claude', command: 'acme-claude', home: { dir: '.acme-claude' } }], homeEnv: { ...SHIPPED_HOME_ENV, 'acme-claude': ['CLAUDE_CONFIG_DIR'] } });
      expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: true, can: { tools: ['claude', 'codex', 'acme-claude'] } });
      expect(await openOn(runtime, worktree)).toMatchObject({ event: 'ready' });

      runtime.send(prompt(`t3-${RUN}-a1b2c3d4`, 'op-0000001e', { tool: 'acme-claude' }));

      expect(await ended(runtime, 'op-0000001e')).toMatchObject({ event: 'finished', session: { tool: 'acme-claude', id: expect.stringMatching(/^[0-9a-f-]{36}$/), home: path.join(t3.home, '.acme-claude') } });
      expect(t3.calls().find((call) => call.tool === 't3_thread_launch')?.args['modelSelection']).toEqual({ instanceId: 'acme-claude-t3', model: 'claude-opus-5-5' });
    });

    it('runs a tool on the provider instance `instances` maps it to', async () => {
      t3.config({ providers: [CLAUDE, CODEX, { ...CLAUDE, providerInstanceId: 'claude-work', displayName: 'Claude (work)' }] });
      const runtime = await initialized({ instances: { claude: 'claude-work' } });
      expect(await openOn(runtime, worktree)).toMatchObject({ event: 'ready' });

      runtime.send(prompt(`t3-${RUN}-a1b2c3d4`, 'op-0000001f'));

      expect(await ended(runtime, 'op-0000001f')).toMatchObject({ event: 'finished', session: { tool: 'claude' } });
      expect(t3.calls().find((call) => call.tool === 't3_thread_launch')?.args['modelSelection']).toEqual({ instanceId: 'claude-work', model: 'claude-opus-5-5' });
    });

    // A member whose T3 default is a team tool's wrapper still runs plain claude as Claude itself, not through the wrapper.
    it('runs a claude step on the instance named after Claude, not on the member\'s default instance when that one runs a wrapper, which serves the tool instance', async () => {
      t3.config({ providers: [CLAUDE, CODEX, { ...CLAUDE, providerInstanceId: 'acme-claude-t3', displayName: 'Claude (acme)' }] });
      t3.settings({ defaultModelSelection: { instanceId: 'acme-claude-t3', model: 'claude-opus-5-5' }, providerInstances: { 'acme-claude-t3': { config: { binaryPath: '/opt/acme/bin/acme-claude' } } } });
      const runtime = start();
      runtime.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' }, instances: [{ name: 'acme-claude', tool: 'claude', command: 'acme-claude' }], homeEnv: { ...SHIPPED_HOME_ENV, 'acme-claude': ['CLAUDE_CONFIG_DIR'] }, checkout });
      expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: true, can: { tools: ['claude', 'codex', 'acme-claude'], default_tool: 'acme-claude' } });
      expect(await openOn(runtime, worktree)).toMatchObject({ event: 'ready' });

      runtime.send(prompt(`t3-${RUN}-a1b2c3d4`, 'op-00000020'));

      expect(await ended(runtime, 'op-00000020')).toMatchObject({ event: 'finished', session: { tool: 'claude' } });
      expect(t3.calls().find((call) => call.tool === 't3_thread_launch')?.args['modelSelection']).toEqual({ instanceId: 'claudeAgent', model: 'claude-opus-5-5' });
    });

    // Claude's installer keeps each version under a file named after the version, which a member may point at.
    it('runs a claude step on the instance named after Claude when its Binary path is a Claude version file', async () => {
      t3.settings({ defaultModelSelection: { instanceId: 'claudeAgent', model: 'claude-opus-5-5' }, providerInstances: { claudeAgent: { config: { binaryPath: '/Users/member/.local/share/claude/versions/2.1.3' } } } });
      const runtime = start();
      runtime.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'attended', options: { environment: 'local' }, checkout });

      expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: true, can: { tools: ['claude', 'codex'], default_tool: 'claude' } });
    });

    // T3 sets T3CODE_THREAD_ID in the sessions of its threads, so a run started there takes that thread's model.
    describe('started from a T3 thread', () => {
      const FROM = { T3CODE_THREAD_ID: 'thread-parent-1' };
      const MEMBER_DEFAULT = { defaultModelSelection: { instanceId: 'claudeAgent', model: 'claude-opus-5-5' }, defaultRuntimeMode: 'approval-required' };

      const initFrom = async (env: Record<string, string>): Promise<Connection> => {
        const runtime = start(env);
        runtime.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'attended', options: { environment: 'local' }, checkout });
        expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: true });
        expect(await openOn(runtime, worktree)).toMatchObject({ event: 'ready' });

        return runtime;
      };

      it('runs a step that names no tool or model on that thread\'s instance and model, sent as they are, in the member\'s mode, never the thread\'s', async () => {
        t3.settings(MEMBER_DEFAULT);
        t3.addThread({ threadId: 'thread-parent-1', title: 'Fix the README', status: 'running', instanceId: 'codex', model: 'gpt-6.1-sol', runtimeMode: 'full-access' });
        const runtime = start(FROM);
        runtime.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'attended', options: { environment: 'local' }, checkout });

        expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: true, can: { tools: ['claude', 'codex'], default_tool: 'codex' } });
        expect(await openOn(runtime, worktree)).toMatchObject({ event: 'ready' });
        runtime.send(prompt(`t3-${RUN}-a1b2c3d4`, 'op-00000021', { tool: 'codex', model: undefined }));

        expect(await ended(runtime, 'op-00000021')).toMatchObject({ event: 'finished', session: { tool: 'codex' } });
        // T3 applies only the project's default to a launch that names no model, so the thread's is named.
        expect(t3.calls().find((call) => call.tool === 't3_thread_launch')?.args).toMatchObject({ modelSelection: { instanceId: 'codex', model: 'gpt-6.1-sol' }, runtimeMode: 'approval-required' });
        expect(noticesOf(runtime)).toEqual([]);
      });

      it('runs a claude step on the Claude instance that thread runs on, with its model, over the member\'s default instance', async () => {
        t3.config({ providers: [CLAUDE, { ...CLAUDE, providerInstanceId: 'claude-work', displayName: 'Claude (work)' }, CODEX] });
        t3.settings(MEMBER_DEFAULT);
        t3.addThread({ threadId: 'thread-parent-1', title: 'Fix the README', status: 'completed', instanceId: 'claude-work', model: 'claude-sonnet-5-5' });
        const runtime = await initFrom(FROM);
        runtime.send(prompt(`t3-${RUN}-a1b2c3d4`, 'op-00000022', { model: undefined }));

        expect(await ended(runtime, 'op-00000022')).toMatchObject({ event: 'finished', session: { tool: 'claude' } });
        expect(t3.calls().find((call) => call.tool === 't3_thread_launch')?.args['modelSelection']).toEqual({ instanceId: 'claude-work', model: 'claude-sonnet-5-5' });
      });

      it('keeps the model a step names over that thread\'s', async () => {
        t3.settings(MEMBER_DEFAULT);
        t3.addThread({ threadId: 'thread-parent-1', title: 'Fix the README', status: 'running', instanceId: 'claudeAgent', model: 'claude-sonnet-5-5' });
        const runtime = await initFrom(FROM);
        runtime.send(prompt(`t3-${RUN}-a1b2c3d4`, 'op-00000023', { model: { name: 'claude-opus-5-5', effort: 'high' } }));

        expect(await ended(runtime, 'op-00000023')).toMatchObject({ event: 'finished' });
        expect(t3.calls().find((call) => call.tool === 't3_thread_launch')?.args['modelSelection']).toEqual({ instanceId: 'claudeAgent', model: 'claude-opus-5-5', options: [{ id: 'effort', value: 'high' }] });
      });

      it.each<{ set: string; instanceId: string; model: string; providers?: FakeT3Config['providers']; binaryPaths?: Record<string, string>; options?: Line }>([
        { set: 'runs on an instance this runtime does not run', instanceId: 'opencode', model: 'big-pickle' },
        { set: 'runs on the member\'s own default, so T3 applies its options and fallback', instanceId: 'claudeAgent', model: 'claude-sonnet-5-5' },
        {
          set: 'runs on another instance than the one `instance` names', instanceId: 'claude-work', model: 'claude-opus-5-5',
          providers: [CLAUDE, { ...CLAUDE, providerInstanceId: 'claude-work' }, CODEX], options: { instance: 'claudeAgent' },
        },
        {
          set: 'runs on an instance whose Binary path is a wrapper no tool of this run runs', instanceId: 'acme-claude-t3', model: 'claude-opus-5-5',
          providers: [CLAUDE, { ...CLAUDE, providerInstanceId: 'acme-claude-t3' }, CODEX], binaryPaths: { 'acme-claude-t3': '/opt/acme/bin/acme-claude' },
        },
      ])('leaves the member\'s T3 default to T3 when that thread $set', async ({ instanceId, model, providers, binaryPaths = {}, options = {} }) => {
        if (providers) t3.config({ providers });
        t3.settings({ defaultModelSelection: { instanceId: 'claudeAgent', model: 'claude-sonnet-5-5' }, providerInstances: Object.fromEntries(Object.entries(binaryPaths).map(([id, binaryPath]) => [id, { config: { binaryPath } }])) });
        t3.addThread({ threadId: 'thread-parent-1', title: 'Fix the README', status: 'running', instanceId, model });
        const runtime = start(FROM);
        runtime.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'attended', options: { environment: 'local', ...options }, checkout });

        expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: true, can: { default_tool: 'claude' } });
        expect(await openOn(runtime, worktree)).toMatchObject({ event: 'ready' });
        runtime.send(prompt(`t3-${RUN}-a1b2c3d4`, 'op-00000026', { model: undefined }));

        expect(await ended(runtime, 'op-00000026')).toMatchObject({ event: 'finished' });
        expect(t3.calls().find((call) => call.tool === 't3_thread_launch')?.args).not.toHaveProperty('modelSelection');
        expect(noticesOf(runtime)).toEqual([]);
      });

      it('runs on the member\'s T3 default, and says why once, when T3 cannot read that thread', async () => {
        t3.settings({ defaultModelSelection: { instanceId: 'claudeAgent', model: 'claude-sonnet-5-5' } });
        const runtime = await initFrom({ T3CODE_THREAD_ID: 'thread-gone-1' });
        runtime.send(prompt(`t3-${RUN}-a1b2c3d4`, 'op-00000024', { model: undefined }));

        expect(await ended(runtime, 'op-00000024')).toMatchObject({ event: 'finished' });
        expect(t3.calls().find((call) => call.tool === 't3_thread_launch')?.args).not.toHaveProperty('modelSelection');
        expect(noticesOf(runtime)).toEqual([{ event: 'notice', message: expect.stringMatching(/^teamai could not read the T3 thread thread-gone-1 this run was started from \(Thread thread-gone-1 is no longer available\), so a step that names no tool or model runs on your T3 Code default instead\.$/) }]);
      });
    });

    // A T3 thread always starts a session of its own, so teamai must not link it to the one the step asked to resume.
    it('says nothing of resuming when the lease asks to resume a session, since the thread started a new one', async () => {
      const { runtime, handle } = await opened();

      runtime.send(prompt(handle, 'op-0000001b', { resume: '0b7e4a52-6f3c-4d1e-9a2b-5c8d7e6f1a30' }));

      const end = await ended(runtime, 'op-0000001b');
      expect(end).toMatchObject({ event: 'finished', session: { tool: 'claude' } });
      expect(end).not.toHaveProperty('resumed');
    });

    it('fails model_unavailable for a model or an effort the instance does not run, and launches nothing', async () => {
      const { runtime, handle } = await opened();

      runtime.send(prompt(handle, 'op-0000000e', { model: { name: 'claude-opus-9' } }));
      runtime.send(prompt(handle, 'op-0000000f', { model: { name: 'claude-sonnet-5-5', effort: 'max' } }));

      expect(await ended(runtime, 'op-0000000e')).toEqual({ op: 'op-0000000e', event: 'failed', failure: { code: 'model_unavailable', message: 'T3 Code provider instance "claudeAgent" (Claude) has no model claude-opus-9. Its models: claude-opus-5-5, claude-sonnet-5-5.' } });
      expect(await ended(runtime, 'op-0000000f')).toMatchObject({ failure: { code: 'model_unavailable', message: 'T3 Code provider instance "claudeAgent" (Claude) runs claude-sonnet-5-5 with no effort "max".' } });
      expect(t3.threads()).toEqual([]);
    });

    it('fails tool_failed when the thread\'s run fails, naming the thread by its link', async () => {
      t3.config({ agent: { fail: true } });
      const { runtime, handle } = await opened();

      runtime.send(prompt(handle, 'op-00000010'));

      expect(await ended(runtime, 'op-00000010')).toEqual({ op: 'op-00000010', event: 'failed', failure: { code: 'tool_failed', message: `The T3 thread ${linkTo(t3.threads()[0]?.threadId)} ("review · teamai r7f3a91c2") ended failed before the step was done.` } });
    });

    // T3 records why a run failed as an error item, titled "Usage limit reached" when the provider's usage ran out.
    it('fails usage_limited, naming the tool, its instance and what T3 says of the reset, when the thread\'s run stops on a usage limit', async () => {
      t3.config({ agent: { fail: true, error: { title: 'Usage limit reached', text: 'You\'ve hit your limit · resets 3pm (Europe/Madrid)' } } });
      const { runtime, handle } = await opened();

      runtime.send(prompt(handle, 'op-00000014'));

      const end = await ended(runtime, 'op-00000014');
      expect(RuntimeMessageSchema.safeParse(end).success).toBe(true);
      expect(end).toEqual({
        op: 'op-00000014', event: 'failed',
        failure: { code: 'usage_limited', message: 'claude reached its usage limit on T3 Code provider instance "claudeAgent" (Claude): You\'ve hit your limit · resets 3pm (Europe/Madrid)' },
      });
    });

    it('fails tool_failed when the thread\'s run fails on a provider error that is no usage limit', async () => {
      t3.config({ agent: { fail: true, error: { title: 'Provider error', text: 'Claude API is overloaded (529). Try again shortly.' } } });
      const { runtime, handle } = await opened();

      runtime.send(prompt(handle, 'op-00000015'));

      expect(await ended(runtime, 'op-00000015')).toMatchObject({ event: 'failed', failure: { code: 'tool_failed', message: expect.stringContaining('ended failed before the step was done.') } });
    });

    it('fails a thread that completes without writing the result file', async () => {
      t3.config({ agent: {} });
      const { runtime, handle } = await opened();

      runtime.send(prompt(handle, 'op-00000011'));

      expect(await ended(runtime, 'op-00000011')).toMatchObject({ event: 'failed', failure: { code: 'tool_failed', message: expect.stringContaining(`ended without writing the result file ${result}.`) } });
    });

    it.skipIf(process.platform === 'win32')('fails a thread whose result file teamai cannot read, saying which file and how to let teamai read it', async () => {
      t3.config({ agent: { output: { verdict: 'approve' } } });
      // The agent can write its result there, and teamai cannot read it.
      fs.writeFileSync(result, '');
      fs.chmodSync(result, 0o200);
      const { runtime, handle } = await opened();

      runtime.send(prompt(handle, 'op-0000fe12'));

      try {
        expect(await ended(runtime, 'op-0000fe12')).toMatchObject({ event: 'failed', failure: { code: 'tool_failed', message: expect.stringContaining(`wrote the result file ${result}, which teamai cannot read because it has no permission to read it. Let the user teamai runs as read ${result}, then retry the step.`) } });
      } finally {
        fs.chmodSync(result, 0o600);
      }
    });

    it.skipIf(process.platform === 'win32')('fails at once a thread that left a FIFO at the result file, rather than waiting on it', async () => {
      t3.config({ agent: {} });
      const { runtime, handle } = await opened();
      execFileSync('mkfifo', [result]);

      runtime.send(prompt(handle, 'op-0000fe10'));

      expect(await ended(runtime, 'op-0000fe10')).toMatchObject({ event: 'failed', failure: { code: 'tool_failed', message: expect.stringContaining(`left a pipe at the result file ${result}, not a regular file, so teamai did not read it.`) } });
    });

    it('fails a thread whose tool kept no session, since the step could not be scored', async () => {
      t3.config({ agent: { output: { verdict: 'approve' }, noSession: true } });
      const { runtime, handle } = await opened();

      runtime.send(prompt(handle, 'op-00000012'));

      expect(await ended(runtime, 'op-00000012')).toMatchObject({ event: 'failed', failure: { code: 'tool_failed', message: expect.stringContaining(`claude kept no session for ${worktree} in ${path.join(t3.home, '.claude')}, so the step cannot be scored or resumed.`) } });
    });

    // Claude's own project folder, which it writes its transcript into; Codex's store, which it writes its rollouts under,
    // and the day folder of that store it writes today's rollout into, as one another user's Codex made.
    it.skipIf(process.platform === 'win32').each([
      { tool: 'claude', model: 'claude-opus-5-5', folder: () => path.join(t3.home, '.claude', 'projects', encodeCwdClaude(fs.realpathSync(worktree))) },
      { tool: 'codex', model: 'gpt-6.1-sol', folder: () => path.join(t3.home, '.codex', 'sessions') },
      { tool: 'codex', model: 'gpt-6.1-sol', folder: () => path.join(t3.home, '.codex', 'sessions', ...new Date().toISOString().slice(0, 10).split('-')) },
    ])('fails a $tool thread whose session folder teamai cannot list, saying which folder and how to let teamai read it', async ({ tool, model, folder: folderOf }) => {
      t3.config({ agent: { output: { verdict: 'approve' } } });
      // The tool can write there, and teamai cannot list the folder.
      const folder = folderOf();
      fs.mkdirSync(folder, { recursive: true });
      fs.chmodSync(folder, 0o300);
      const { runtime, handle } = await opened();

      runtime.send(prompt(handle, 'op-0000fe11', { tool, model: { name: model } }));

      try {
        expect(await ended(runtime, 'op-0000fe11')).toMatchObject({ event: 'failed', failure: { code: 'tool_failed', message: expect.stringContaining(`finished, but teamai cannot list ${folder}, where ${tool} keeps the step's session, because it has no permission to read it, so the step cannot be scored or resumed. Let the user teamai runs as read ${folder}, then retry the step.`) } });
      } finally {
        fs.chmodSync(folder, 0o700);
      }
    });

    it.skipIf(process.platform === 'win32')('finds a Codex thread\'s session past a folder of its store teamai cannot list, and reports its tokens', async () => {
      t3.config({ agent: { output: { verdict: 'approve' }, usage: { input: 1_200, output: 340, cacheRead: 18_000 } } });
      // A folder another user left in Codex's store, which Codex never lists.
      const foreign = path.join(t3.home, '.codex', 'sessions', '0000');
      fs.mkdirSync(foreign, { recursive: true });
      fs.chmodSync(foreign, 0o300);
      const { runtime, handle } = await opened();

      runtime.send(prompt(handle, 'op-0000fe13', { tool: 'codex', model: { name: 'gpt-6.1-sol' } }));

      try {
        expect(await ended(runtime, 'op-0000fe13')).toMatchObject({ event: 'finished', session: { tool: 'codex' }, usage: { input: 19_200, output: 340, cachedInput: 18_000 } });
      } finally {
        fs.chmodSync(foreign, 0o700);
      }
    });

    it('says where it looked for the session, and the T3 setting that names another home, when the tool kept none there', async () => {
      t3.config({ agent: { output: { verdict: 'approve' }, noSession: true } });
      const { runtime, handle } = await opened();

      runtime.send(prompt(handle, 'op-0000fe22'));
      const end = await ended(runtime, 'op-0000fe22');
      const { message } = z.object({ failure: z.object({ message: z.string() }) }).parse(end).failure;

      expect(message).toContain(`teamai looks for it in the home path of T3 provider instance "claudeAgent", else in ~/.claude of the user T3 Code runs as (${path.join(t3.home, '.claude')}).`);
      expect(message).toContain(`If the T3 server runs claude with a CLAUDE_CONFIG_DIR of its own, set providerInstances.claudeAgent.config.homePath to that directory in ${path.join(t3.t3Home, 'userdata', 'settings.json')} (Settings → Providers in T3 Code), then retry the step.`);
    });

    it('stops the thread on cancel and ends cancelled once its run has ended', async () => {
      t3.config({ agent: { hold: true, output: {} } });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-00000013'));
      await runtime.next((line) => line['op'] === 'op-00000013' && line['event'] === 'accepted');
      await expect.poll(() => t3.threads()[0]?.status).toBe('running');
      t3.config({ stopLagMs: 1_000 });

      runtime.send({ type: 'cancel', op: 'op-00000013' });

      expect(await ended(runtime, 'op-00000013')).toEqual({ op: 'op-00000013', event: 'cancelled' });
      expect(t3.calls().find((call) => call.tool === 't3_thread_interrupt')?.args).toMatchObject({ stop: true });
      expect(t3.threads()[0]?.status).toBe('interrupted');
    });

    // T3 answers a wait with the run's own status, and timedOut until the work it delegated settled too.
    describe('when the step\'s run delegated work that has not settled', () => {
      it('ends the step only once the delegated work settled, even though its own run completed', async () => {
        t3.config({ delegatesPending: true, waitCapMs: 50 });
        const { runtime, handle } = await opened();
        runtime.send(prompt(handle, 'op-00000040'));
        await expect.poll(() => t3.threads()[0]?.status).toBe('completed');
        await new Promise((resolve) => setTimeout(resolve, 300));

        expect(runtime.lines.filter((line) => line['op'] === 'op-00000040').map((line) => line['event'])).toEqual(['accepted', 'display']);
        t3.config({ delegatesPending: false });

        expect(await ended(runtime, 'op-00000040')).toMatchObject({ event: 'finished', result: { output: { verdict: 'approve' } } });
      });

      it('ends the step as the run that answered once the work settled ended, rather than as its own run', async () => {
        t3.config({ resultRunStatus: 'failed' });
        const { runtime, handle } = await opened();

        runtime.send(prompt(handle, 'op-00000041'));

        expect(await ended(runtime, 'op-00000041')).toMatchObject({ event: 'failed', failure: { code: 'tool_failed', message: expect.stringContaining('ended failed before the step was done.') } });
      });

      // T3 answers the stop no_active_run, from the run's own events, while it stops the delegated work apart.
      it('answers close_failed, keeping the place, until the delegated work of a run that already ended settles', async () => {
        t3.config({ delegatesPending: true, waitCapMs: 50 });
        const { runtime, handle } = await opened();
        runtime.send(prompt(handle, 'op-00000042'));
        await expect.poll(() => t3.threads()[0]?.status).toBe('completed');

        runtime.send({ type: 'close', handle });

        expect(await runtime.next((line) => line['handle'] === handle && line['event'] !== 'accepted')).toMatchObject({
          event: 'close_failed', handle, failure: { code: 'thread_still_runs', message: expect.stringContaining('the work it delegated had not settled') },
        });
        expect(t3.calls().filter((call) => call.tool === 't3_thread_interrupt')).toHaveLength(1);
        expect(t3.threads()[0]?.settled).toBe(false);
        t3.config({ delegatesPending: false });
        runtime.send({ type: 'close', handle });

        expect(await runtime.next((line) => line['handle'] === handle && line['event'] === 'closed')).toEqual({ event: 'closed', handle });
        expect(t3.threads()[0]?.settled).toBe(true);
      });

      it('answers a cancel after a restart cancel_failed until the stopped run\'s delegated work settled, and running while a later cancel retries', async () => {
        t3.config({ agent: { hold: true, output: {} } });
        const first = await opened();
        first.runtime.send(prompt(first.handle, 'op-00000043'));
        await first.runtime.next((line) => line['op'] === 'op-00000043' && line['event'] === 'accepted');
        await expect.poll(() => t3.threads()[0]?.status).toBe('running');
        await first.runtime.close();
        t3.config({ delegatesPending: true, waitCapMs: 300, stopLagMs: 100 });

        const second = start();
        second.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'attended', options: { environment: 'local' } });
        await second.next((line) => line['type'] === 'init');
        second.send({ type: 'cancel', op: 'op-00000043' });

        expect(await second.next((line) => line['op'] === 'op-00000043')).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed', message: expect.stringContaining('the work it delegated had not settled') } });
        expect(t3.threads()[0]?.status).toBe('interrupted');
        second.send({ type: 'reattach', handle: first.handle });
        expect(await second.next((line) => line['event'] === 'alive')).toMatchObject({ ops: [{ op: 'op-00000043', state: 'failed', failure: { code: 'cancel_failed' } }] });

        // The retried stop takes a while: until it is confirmed, the op runs, so its old failure is not read as this cancel's outcome.
        t3.config({ delegatesPending: false, interruptMs: 1_000 });
        second.send({ type: 'cancel', op: 'op-00000043' });
        second.send({ type: 'reattach', handle: first.handle });
        expect(await second.next((line) => line['event'] === 'alive')).toMatchObject({ ops: [{ op: 'op-00000043', state: 'running' }] });

        expect(await second.next((line) => line['op'] === 'op-00000043')).toEqual({ op: 'op-00000043', event: 'cancelled' });
        second.send({ type: 'close', handle: first.handle });
        await second.next((line) => line['handle'] === first.handle && line['event'] === 'closed');
        expect(t3.threads()[0]).toMatchObject({ status: 'interrupted', settled: true });
      });
    });

    it('refuses a prompt that carries credentials, since the thread runs on T3 Code\'s own sign-in, and launches nothing', async () => {
      const { runtime, handle } = await opened();

      runtime.send({ ...prompt(handle, 'op-0000001e'), credentials: { ACME_TOKEN: 'acme-secret-value' } });

      const end = await ended(runtime, 'op-0000001e');
      expect(end).toEqual({
        op: 'op-0000001e', event: 'failed', failure: {
          code: 'credentials_unsupported',
          message: 'Runtime t3 got credentials ACME_TOKEN, but a T3 thread runs its tool in T3 Code\'s environment, on T3 Code\'s own sign-in, and this runtime cannot pass it a value (its init offers can.env: false). Remove the credentials from the runtime, or run the step on a runtime that offers can.env.',
        },
      });
      expect(JSON.stringify(runtime.lines)).not.toContain('acme-secret-value');
      expect(t3.threads()).toEqual([]);
    });

    it('ends a cancelled prompt cancel_failed, and a later close fails, while T3 will not stop its thread', async () => {
      t3.config({ agent: { hold: true, output: {} }, waitCapMs: 50 });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-00000021'));
      await runtime.next((line) => line['op'] === 'op-00000021' && line['event'] === 'accepted');
      await expect.poll(() => t3.threads()[0]?.status).toBe('running');
      // Waits on the thread answer while each refused stop is still pending.
      t3.config({ interruptFails: true, interruptMs: 400 });

      runtime.send({ type: 'cancel', op: 'op-00000021' });
      runtime.send({ type: 'close', handle });
      expect(await runtime.next((line) => line['event'] === 'close_failed', 5_000)).toMatchObject({ handle });
      const [thread] = t3.threads();

      expect(await ended(runtime, 'op-00000021')).toEqual({
        op: 'op-00000021', event: 'failed', failure: {
          code: 'cancel_failed',
          message: `The T3 thread ${linkTo(thread?.threadId)} ("review · teamai ${RUN}") still runs, and T3 Code did not stop it: Thread ${thread?.threadId} has a run T3 cannot interrupt now. Stop it in T3 Code with its Stop button, then run teamai workflow cancel ${RUN} again.`,
        },
      });
      runtime.send({ type: 'close', handle });
      expect(await runtime.next((line) => line['event'] === 'close_failed' || line['event'] === 'closed', 5_000)).toMatchObject({ event: 'close_failed', failure: { code: 'thread_still_runs' } });
      runtime.send({ type: 'reattach', handle });
      expect(await runtime.next((line) => line['event'] === 'alive')).toMatchObject({ ops: [{ op: 'op-00000021', state: 'failed', failure: { code: 'cancel_failed' } }] });
      expect(runtime.lines.filter((line) => line['op'] === 'op-00000021' && line['event'] === 'cancelled')).toEqual([]);
      expect(t3.threads()[0]?.status).toBe('running');
    });

    // A retried cancel owns the op's end, as the prompt that launched it did: a resent prompt joins it, and starts no follow.
    it('keeps a retried cancel\'s cancelled when teamai resends the prompt while the stop is under way', async () => {
      t3.config({ agent: { hold: true, output: {} } });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-0000006f'));
      await runtime.next((line) => line['op'] === 'op-0000006f' && line['event'] === 'display');
      await expect.poll(() => t3.threads()[0]?.status).toBe('running');
      t3.config({ interruptFails: true });
      runtime.send({ type: 'cancel', op: 'op-0000006f' });
      expect(await ended(runtime, 'op-0000006f')).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed' } });

      t3.config({ interruptFails: false, interruptMs: 1_000 });
      runtime.send({ type: 'cancel', op: 'op-0000006f' });
      runtime.send(prompt(handle, 'op-0000006f'));
      runtime.send({ type: 'reattach', handle });
      expect(await runtime.next((line) => line['event'] === 'alive')).toMatchObject({ ops: [{ op: 'op-0000006f', state: 'running' }] });

      expect(await ended(runtime, 'op-0000006f')).toEqual({ op: 'op-0000006f', event: 'cancelled' });
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(runtime.lines.filter((line) => line['op'] === 'op-0000006f').map((line) => line['event'])).toEqual(['accepted', 'display', 'failed', 'accepted', 'cancelled']);
      runtime.send({ type: 'reattach', handle });
      expect(await runtime.next((line) => line['event'] === 'alive')).toMatchObject({ ops: [{ op: 'op-0000006f', state: 'cancelled' }] });
      expect(t3.threads()).toHaveLength(1);
    });

    // teamai ends a live prompt it cancelled lost when no outcome comes within 15 s, so the runtime answers well before.
    it('answers a live cancel cancel_failed within the stop bound when T3 Code does not answer the stop', async () => {
      t3.config({ agent: { hold: true, output: {} } });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-00000063'));
      await runtime.next((line) => line['op'] === 'op-00000063' && line['event'] === 'accepted');
      await expect.poll(() => t3.threads()[0]?.status).toBe('running');
      t3.config({ interruptMs: 30_000 });
      const cancelledAt = Date.now();

      runtime.send({ type: 'cancel', op: 'op-00000063' });

      expect(await ended(runtime, 'op-00000063')).toMatchObject({
        event: 'failed', failure: { code: 'cancel_failed', message: expect.stringContaining('T3 Code did not answer the stop within 10 s') },
      });
      expect(Date.now() - cancelledAt).toBeLessThan(12_000);
    }, 20_000);

    // The 10 s run from the moment the cancel is read, a launch still pending included, so the answer beats teamai's 15 s.
    it('answers a cancel that comes while T3 launches the thread within the stop bound, when T3 then does not answer the stop', async () => {
      t3.config({ agent: { hold: true, output: {} }, launchMs: 7_000, interruptMs: 30_000 });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-00000069'));
      await runtime.next((line) => line['op'] === 'op-00000069' && line['event'] === 'accepted');
      const cancelledAt = Date.now();

      runtime.send({ type: 'cancel', op: 'op-00000069' });

      expect(await ended(runtime, 'op-00000069')).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed' } });
      expect(Date.now() - cancelledAt).toBeLessThan(12_000);
    }, 30_000);

    it('keeps the thread of a launch T3 answers after the cancel gave up on it, with no second outcome, and a later cancel stops it', async () => {
      t3.config({ agent: { hold: true, output: {} }, launchMs: 12_000 });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-0000006a'));
      await runtime.next((line) => line['op'] === 'op-0000006a' && line['event'] === 'accepted');
      const cancelledAt = Date.now();

      runtime.send({ type: 'cancel', op: 'op-0000006a' });

      expect(await ended(runtime, 'op-0000006a')).toEqual({
        op: 'op-0000006a', event: 'failed', failure: {
          code: 'cancel_failed',
          message: `teamai cancelled the step while T3 Code launched its thread "review · teamai ${RUN}", and the launch had not finished 10 s later, so the thread may run. Run teamai workflow cancel ${RUN} again.`,
        },
      });
      expect(Date.now() - cancelledAt).toBeLessThan(12_000);
      // The launch answers now: the thread is the runtime's to stop, and the op keeps its one outcome.
      await runtime.next((line) => line['op'] === 'op-0000006a' && line['event'] === 'display', 10_000);
      runtime.send({ type: 'reattach', handle });
      expect(await runtime.next((line) => line['event'] === 'alive')).toMatchObject({ ops: [{ op: 'op-0000006a', state: 'failed', failure: { code: 'cancel_failed' } }], display: { url: linkTo(t3.threads()[0]?.threadId) } });

      runtime.send({ type: 'cancel', op: 'op-0000006a' });

      expect(await runtime.next((line) => line['op'] === 'op-0000006a')).toEqual({ op: 'op-0000006a', event: 'cancelled' });
      expect(t3.threads()[0]?.status).toBe('interrupted');
      expect(runtime.lines.filter((line) => line['op'] === 'op-0000006a').map((line) => line['event'])).toEqual(['accepted', 'failed', 'display', 'cancelled']);
    }, 40_000);

    // T3 Code went away mid-run: the thread may still run, so the op ends as a stop teamai could not confirm.
    it('ends a prompt cancel_failed when it loses track of a thread that may still run', async () => {
      t3.config({ agent: { hold: true, output: {} } });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-00000068'));
      await runtime.next((line) => line['op'] === 'op-00000068' && line['event'] === 'display');
      await expect.poll(() => t3.threads()[0]?.status).toBe('running');
      await t3.stop();

      expect(await runtime.next((line) => line['op'] === 'op-00000068' && line['event'] !== 'accepted' && line['event'] !== 'display', 30_000)).toMatchObject({
        event: 'failed', failure: { code: 'cancel_failed', message: expect.stringMatching(/could not be followed, so it may still run: .+ Run teamai workflow cancel r7f3a91c2 to stop it\.$/) },
      });
    }, 40_000);

    it('fails a step whose agent asks for an approval in an unattended run, and stops its thread', async () => {
      t3.config({ agent: { waits: true } });
      const { runtime, handle } = await opened('unattended');

      runtime.send(prompt(handle, 'op-00000014'));

      expect(await ended(runtime, 'op-00000014')).toMatchObject({ event: 'failed', failure: { code: 'tool_failed', message: expect.stringContaining('asked for an approval, and nobody is there to give it in an unattended run.') } });
      expect(t3.threads()[0]).toMatchObject({ runtimeMode: 'auto', status: 'interrupted' });
    });

    // T3 holds an approval a delegated task asks for on the task's own thread, not as a pending request of the step's.
    it('fails a step whose delegated task asks for an approval in an unattended run, and stops its thread and the task', async () => {
      t3.config({ agent: { delegatedWaits: true } });
      const { runtime, handle } = await opened('unattended');

      runtime.send(prompt(handle, 'op-00000014'));

      const end = await ended(runtime, 'op-00000014');
      const step = t3.threads().find((thread) => thread.parentThreadId === undefined);
      expect(end).toEqual({ op: 'op-00000014', event: 'failed', failure: { code: 'tool_failed', message: `The T3 thread ${linkTo(step?.threadId)} ("review · teamai ${RUN}") delegated a task that asked for an approval, and nobody is there to give it in an unattended run.` } });
      expect(t3.threads().map((thread) => thread.status)).toEqual(['interrupted', 'interrupted']);
    });

    it('refuses a lease in unattended permissions, which its offer never takes, and launches nothing', async () => {
      const { runtime, handle } = await opened();

      runtime.send(prompt(handle, 'op-00000015', { permissions: 'unattended' }));

      expect(await ended(runtime, 'op-00000015')).toMatchObject({ event: 'failed', failure: { code: 'unattended_unsupported' } });
      expect(t3.threads()).toEqual([]);
    });

    it('reconnects to the same thread after its own restart: reattach shows it running, and the repeated prompt launches no other', async () => {
      const release = path.join(dir, 'release');
      t3.config({ agent: { release, output: { verdict: 'approve' } } });
      const first = await opened();
      first.runtime.send(prompt(first.handle, 'op-00000017'));
      await first.runtime.next((line) => line['op'] === 'op-00000017' && line['event'] === 'accepted');
      await expect.poll(() => t3.threads()[0]?.status).toBe('running');
      await first.runtime.close();

      const second = start();
      second.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'attended', options: { environment: 'local' } });
      await second.next((line) => line['type'] === 'init');
      second.send({ type: 'reattach', handle: first.handle });
      const [thread] = t3.threads();

      expect(await second.next((line) => line['event'] === 'alive')).toEqual({
        event: 'alive', handle: first.handle, ops: [{ op: 'op-00000017', state: 'running' }],
        display: { label: `review · teamai ${RUN}`, url: linkTo(thread?.threadId), fields: { thread: thread?.threadId, model: 'claude-opus-5-5', environment: 'fake-laptop' } },
      });
      second.send(prompt(first.handle, 'op-00000017'));
      fs.writeFileSync(release, '');

      expect(await ended(second, 'op-00000017')).toMatchObject({ event: 'finished', result: { output: { verdict: 'approve' } } });
      expect(t3.threads()).toHaveLength(1);
    });

    it('reconnects to the same thread after the member signed in again, where a repeated launch would start another', async () => {
      t3.config({ agent: { hold: true, output: {} } });
      const first = await opened();
      first.runtime.send(prompt(first.handle, 'op-0000004f'));
      await first.runtime.next((line) => line['op'] === 'op-0000004f' && line['event'] === 'accepted');
      await expect.poll(() => t3.threads()[0]?.status).toBe('running');
      await first.runtime.close();
      t3.config({ token: 'fake-t3-token-second-0987654321', namespace: 'session-2' });
      signIn(t3, 'fake-t3-token-second-0987654321');

      const second = start();
      second.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'attended', options: { environment: 'local' } });
      expect(await second.next((line) => line['type'] === 'init')).toMatchObject({ ok: true });
      second.send(prompt(first.handle, 'op-0000004f'));
      await second.next((line) => line['op'] === 'op-0000004f' && line['event'] === 'accepted');
      second.send({ type: 'close', handle: first.handle });

      expect(await second.next((line) => line['handle'] === first.handle)).toEqual({ event: 'closed', handle: first.handle });
      expect(t3.threads()).toHaveLength(1);
      expect(t3.threads()[0]).toMatchObject({ status: 'interrupted', settled: true });
    });

    it('stops the thread a runtime before it left running when teamai cancels that prompt first thing after a restart, and settles it at close', async () => {
      t3.config({ agent: { release: path.join(dir, 'release'), output: { verdict: 'approve' } } });
      const first = await opened();
      first.runtime.send(prompt(first.handle, 'op-0000001c'));
      await first.runtime.next((line) => line['op'] === 'op-0000001c' && line['event'] === 'accepted');
      await expect.poll(() => t3.threads()[0]?.status).toBe('running');
      await first.runtime.close();

      // As `teamai workflow cancel` does for a run whose driver died: cancel, then reattach until the op no longer runs.
      const second = start();
      second.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'attended', options: { environment: 'local' } });
      await second.next((line) => line['type'] === 'init');
      second.send({ type: 'cancel', op: 'op-0000001c' });

      await expect.poll(async () => {
        second.send({ type: 'reattach', handle: first.handle });

        return (await second.next((line) => line['event'] === 'alive'))['ops'];
      }).toEqual([{ op: 'op-0000001c', state: 'cancelled' }]);
      expect(t3.threads()[0]).toMatchObject({ status: 'interrupted', settled: false });

      second.send({ type: 'close', handle: first.handle });

      expect(await second.next((line) => line['handle'] === first.handle && line['event'] === 'closed')).toEqual({ event: 'closed', handle: first.handle });
      expect(t3.threads()[0]).toMatchObject({ status: 'interrupted', settled: true });
    });

    describe('in recover mode, after the runtime that launched a thread exited', () => {
      /** A step thread left running by a runtime that exited, and a runtime opened in recover mode. */
      const recovering = async (op: string): Promise<{ runtime: Connection; handle: string }> => {
        t3.config({ agent: { hold: true, output: {} } });
        const first = await opened();
        first.runtime.send(prompt(first.handle, op));
        await first.runtime.next((line) => line['op'] === op && line['event'] === 'accepted');
        await expect.poll(() => t3.threads()[0]?.status).toBe('running');
        await first.runtime.close();

        const runtime = start();
        runtime.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'recover', options: { environment: 'local' } });
        expect(await runtime.next((line) => line['type'] === 'init')).toEqual({ type: 'init', ok: true, can: {} });

        return { runtime, handle: first.handle };
      };

      // `workflow cancel --release`: the person checked nothing of the attempt runs, and let it go.
      it('forgets the place when a close that releases the attempt cannot stop its thread, and still answers close_failed', async () => {
        const { runtime, handle } = await recovering('op-00000063');
        t3.config({ interruptFails: true });
        const record = path.join(t3.home, '.teamai', 'runtime-state', 't3', 'places', `${encodeURIComponent(handle)}.json`);

        runtime.send({ type: 'close', handle, release: true });

        expect(await runtime.next((line) => line['handle'] === handle)).toEqual({
          event: 'close_failed', handle,
          failure: { code: 'thread_still_runs', message: `Runtime t3 forgot ${handle}, as you released it, though T3 Code did not confirm it closed (thread_still_runs). If one of its T3 threads still runs, stop it in T3 Code with its Stop button.` },
        });
        expect(fs.existsSync(record)).toBe(false);
        runtime.send({ type: 'reattach', handle });
        expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'gone', handle });
        runtime.send({ type: 'close', handle });
        expect(await runtime.next((line) => line['handle'] === handle && line['event'] !== 'gone')).toEqual({ event: 'closed', handle });
      });

      it('forgets a place whose record it cannot read when a close releases the attempt', async () => {
        const { runtime, handle } = await recovering('op-00000064');
        const record = path.join(t3.home, '.teamai', 'runtime-state', 't3', 'places', `${encodeURIComponent(handle)}.json`);
        fs.writeFileSync(record, '{broken');

        runtime.send({ type: 'close', handle, release: true });

        expect(await runtime.next((line) => line['handle'] === handle)).toMatchObject({ event: 'close_failed', handle, failure: { code: 'journal_unreadable' } });
        expect(fs.existsSync(record)).toBe(false);
      });

      it('answers reattach from its journal, and reaches T3 only to stop the thread on cancel and to settle it at close', async () => {
        const { runtime, handle } = await recovering('op-00000060');
        const before = t3.calls().length;

        runtime.send({ type: 'reattach', handle });
        expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'alive', handle, ops: [{ op: 'op-00000060', state: 'running' }] });
        expect(t3.calls().slice(before)).toEqual([]);

        runtime.send({ type: 'cancel', op: 'op-00000060' });
        expect(await runtime.next((line) => line['op'] === 'op-00000060')).toEqual({ op: 'op-00000060', event: 'cancelled' });
        runtime.send({ type: 'collect', handle });
        expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'collected', handle });
        runtime.send({ type: 'close', handle });

        expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'closed', handle });
        expect(t3.threads()[0]).toMatchObject({ status: 'interrupted', settled: true });
      });

      // A whole close fits 10 s, looking a lost launch up included; past that it keeps the place.
      it('answers close_failed within the close bound, keeping the place, while T3 is slow to answer the repeated launch', async () => {
        t3.config({ agent: { hold: true, output: {} }, launchMs: 30_000 });
        const first = await opened();
        first.runtime.send(prompt(first.handle, 'op-0000006c'));
        await expect.poll(() => t3.threads()[0]?.status).toBe('running');
        await first.runtime.close();
        t3.config({ launchMs: 16_000 });

        const runtime = start();
        runtime.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'recover', options: { environment: 'local' } });
        await runtime.next((line) => line['type'] === 'init');
        const closedAt = Date.now();
        runtime.send({ type: 'close', handle: first.handle });

        expect(await runtime.next((line) => line['handle'] === first.handle, 20_000)).toMatchObject({
          event: 'close_failed', handle: first.handle, failure: { code: 't3_unavailable', message: expect.stringContaining(`"review · teamai ${RUN}" and T3 Code never answered, so it may run, and T3 Code did not say within 10 s whether it launched it`) },
        });
        expect(Date.now() - closedAt).toBeLessThan(12_000);
        runtime.send({ type: 'reattach', handle: first.handle });
        expect(await runtime.next((line) => line['handle'] === first.handle)).toMatchObject({ event: 'alive', ops: [{ op: 'op-0000006c', state: 'running' }] });
        expect(t3.threads()[0]?.status).toBe('running');

        t3.config({ launchMs: 0 });
        runtime.send({ type: 'close', handle: first.handle });

        expect(await runtime.next((line) => line['handle'] === first.handle, 20_000)).toEqual({ event: 'closed', handle: first.handle });
        expect(t3.threads()).toHaveLength(1);
        expect(t3.threads()[0]).toMatchObject({ status: 'interrupted', settled: true });
      }, 60_000);

      // A retried cancel that cannot journal its op running leaves nothing behind that would swallow the next one.
      it('answers a retried cancel again once the record can be written, after it could not journal the retry', async () => {
        t3.config({ agent: { hold: true, output: {} } });
        const first = await opened();
        first.runtime.send(prompt(first.handle, 'op-00000076'));
        await first.runtime.next((line) => line['op'] === 'op-00000076' && line['event'] === 'display');
        await expect.poll(() => t3.threads()[0]?.status).toBe('running');
        t3.config({ interruptFails: true });
        first.runtime.send({ type: 'cancel', op: 'op-00000076' });
        expect(await ended(first.runtime, 'op-00000076')).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed' } });
        await first.runtime.close();
        t3.config({ interruptFails: false });

        const runtime = start();
        runtime.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'recover', options: { environment: 'local' } });
        await runtime.next((line) => line['type'] === 'init');
        // Each operation is kept in a record of its own, apart from its place.
        const ops = path.join(t3.home, '.teamai', 'runtime-state', 't3', 'ops');
        fs.chmodSync(ops, 0o500);
        runtime.send({ type: 'cancel', op: 'op-00000076' });
        expect(await runtime.next((line) => line['op'] === 'op-00000076')).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed', message: expect.stringContaining('EACCES') } });
        fs.chmodSync(ops, 0o700);

        runtime.send({ type: 'cancel', op: 'op-00000076' });

        expect(await runtime.next((line) => line['op'] === 'op-00000076')).toEqual({ op: 'op-00000076', event: 'cancelled' });
        expect(t3.threads()[0]?.status).toBe('interrupted');
      });

      it('keeps the place while T3 Code cannot be reached, and closes it once T3 Code is back', async () => {
        const { runtime, handle } = await recovering('op-00000061');
        await t3.stop();
        fs.rmSync(path.join(t3.t3Home, 'userdata', 'server-runtime.json'));

        runtime.send({ type: 'cancel', op: 'op-00000061' });
        expect(await runtime.next((line) => line['op'] === 'op-00000061')).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed', message: expect.stringContaining('Open T3 Code') } });
        runtime.send({ type: 'close', handle });
        expect(await runtime.next((line) => line['handle'] === handle)).toMatchObject({ event: 'close_failed', failure: { code: 't3_unavailable', message: expect.stringContaining('Open T3 Code') } });

        // The fake comes back on another port, where the same sign-in is kept under its new address.
        await t3.start();
        signIn(t3);
        runtime.send({ type: 'close', handle });

        expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'closed', handle });
        expect(t3.threads()[0]).toMatchObject({ status: 'interrupted', settled: true });
      });
    });

    // As `teamai workflow cancel` goes for a run whose driver died (cancel, reattach, collect, close), with T3 Code down.
    it('neither forgets nor drops a place whose thread still runs while T3 Code cannot be reached after a restart', async () => {
      t3.config({ agent: { hold: true, output: {} } });
      const first = await opened();
      first.runtime.send(prompt(first.handle, 'op-00000044'));
      await first.runtime.next((line) => line['op'] === 'op-00000044' && line['event'] === 'accepted');
      await expect.poll(() => t3.threads()[0]?.status).toBe('running');
      await first.runtime.close();
      await t3.stop();
      fs.rmSync(path.join(t3.t3Home, 'userdata', 'server-runtime.json'));

      const second = start();
      second.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'attended', options: { environment: 'local' } });
      expect(await second.next((line) => line['type'] === 'init')).toMatchObject({ ok: false, error: { code: 't3_unavailable' } });
      second.send({ type: 'reattach', handle: first.handle });

      expect(await second.next((line) => line['handle'] === first.handle)).toEqual({ event: 'alive', handle: first.handle, ops: [{ op: 'op-00000044', state: 'running' }] });
      second.send({ type: 'close', handle: first.handle });
      expect(await second.next((line) => line['handle'] === first.handle)).toMatchObject({ event: 'close_failed', failure: { code: 't3_unavailable' } });
      second.send({ type: 'reattach', handle: first.handle });
      expect(await second.next((line) => line['handle'] === first.handle)).toMatchObject({ event: 'alive' });

      // T3 Code is back: the place closes as usual.
      await t3.start();
      const third = start();
      third.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'attended', options: { environment: 'local' } });
      await third.next((line) => line['type'] === 'init');
      third.send({ type: 'close', handle: first.handle });

      expect(await third.next((line) => line['handle'] === first.handle)).toEqual({ event: 'closed', handle: first.handle });
      expect(t3.threads()[0]).toMatchObject({ status: 'interrupted', settled: true });
    });

    // A thread the journal holds stays the runtime's to stop until it saw that thread stop, whatever ended its op and
    // whichever runtime process launched it.
    describe('when a prompt resumed after a restart is refused while its thread still runs', () => {
      /** A step thread left running by a runtime that exited, and a second runtime, set up by `before`, that it is resent to. */
      const resumed = async (op: string, before: () => void): Promise<{ runtime: Connection; handle: string }> => {
        t3.config({ agent: { hold: true, output: {} } });
        const first = await opened();
        first.runtime.send(prompt(first.handle, op));
        await first.runtime.next((line) => line['op'] === op && line['event'] === 'accepted');
        await expect.poll(() => t3.threads()[0]?.status).toBe('running');
        await first.runtime.close();
        before();

        const runtime = start();
        runtime.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'attended', options: { environment: 'local' } });
        expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: true });
        runtime.send(prompt(first.handle, op));

        return { runtime, handle: first.handle };
      };

      // Only a running op, or one failed cancel_failed, may still run, so the refusal rides in a cancel_failed.
      it('keeps the thread when T3 no longer offers the model: collect leaves it, and close stops it first', async () => {
        const { runtime, handle } = await resumed('op-00000045', () => t3.config({ providers: [{ ...CLAUDE, models: [{ id: 'claude-sonnet-5-5' }] }, CODEX] }));

        expect(await ended(runtime, 'op-00000045')).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed', message: expect.stringContaining('has no model claude-opus-5-5') } });
        runtime.send({ type: 'collect', handle });
        expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'collected', handle });
        expect(t3.threads()[0]).toMatchObject({ status: 'running', settled: false });

        t3.config({ interruptFails: true });
        runtime.send({ type: 'close', handle });
        expect(await runtime.next((line) => line['handle'] === handle)).toMatchObject({ event: 'close_failed', failure: { code: 'thread_still_runs' } });
        runtime.send({ type: 'reattach', handle });
        expect(await runtime.next((line) => line['handle'] === handle)).toMatchObject({ event: 'alive', ops: [{ op: 'op-00000045', state: 'failed' }] });

        t3.config({ interruptFails: false });
        runtime.send({ type: 'close', handle });

        expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'closed', handle });
        expect(t3.threads()).toHaveLength(1);
        expect(t3.threads()[0]).toMatchObject({ status: 'interrupted', settled: true });
      });

      // T3 finds a repeated launch only under the sign-in that sent it, so a thread the journal names is reconnected to by its id.
      it('sends no launch for a thread it holds, so T3 refusing launches cannot drop it, and close stops it', async () => {
        const { runtime, handle } = await resumed('op-00000046', () => t3.config({ launchFails: true }));
        await runtime.next((line) => line['op'] === 'op-00000046' && line['event'] === 'accepted');

        runtime.send({ type: 'close', handle });

        expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'closed', handle });
        expect(await ended(runtime, 'op-00000046')).toEqual({ op: 'op-00000046', event: 'cancelled' });
        expect(t3.calls().filter((call) => call.tool === 't3_thread_launch')).toHaveLength(1);
        expect(t3.calls().filter((call) => call.tool === 't3_thread_interrupt')).toHaveLength(1);
        expect(t3.threads()[0]).toMatchObject({ status: 'interrupted', settled: true });
      });
    });

    // A launch's clientRequestId is journaled before the launch, and T3 answers a repeated launch with the thread it
    // launched for that id, so a launch whose reply never came is found again.
    describe('when T3 launched a step\'s thread but its reply never came', () => {
      it('finds the thread at close by repeating the launch, keeping the place while T3 cannot answer', async () => {
        t3.config({ agent: { hold: true, output: {} }, launchReplyLost: true });
        const { runtime, handle } = await opened();
        runtime.send(prompt(handle, 'op-00000047'));

        expect(await ended(runtime, 'op-00000047')).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed', message: expect.stringContaining(`"review · teamai ${RUN}"`) } });
        await expect.poll(() => t3.threads()[0]?.status).toBe('running');
        runtime.send({ type: 'close', handle });
        expect(await runtime.next((line) => line['handle'] === handle)).toMatchObject({
          event: 'close_failed', failure: { code: 't3_unavailable', message: expect.stringContaining(`"review · teamai ${RUN}"`) },
        });

        t3.config({ launchReplyLost: false });
        runtime.send({ type: 'close', handle });

        expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'closed', handle });
        expect(t3.threads()).toHaveLength(1);
        expect(t3.threads()[0]).toMatchObject({ status: 'interrupted', settled: true });
      });

      // T3 answers a call it could not complete with orchestration_error, which says nothing of what it launched.
      it('keeps the place when T3 cannot complete the repeated launch, and finds the thread once it can', async () => {
        t3.config({ agent: { hold: true, output: {} }, launchReplyLost: true });
        const { runtime, handle } = await opened();
        runtime.send(prompt(handle, 'op-0000004a'));
        expect(await ended(runtime, 'op-0000004a')).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed' } });
        await expect.poll(() => t3.threads()[0]?.status).toBe('running');
        t3.config({ launchReplyLost: false, launchUnavailable: true });

        runtime.send({ type: 'close', handle });
        expect(await runtime.next((line) => line['handle'] === handle)).toMatchObject({
          event: 'close_failed', failure: { code: 't3_unavailable', message: expect.stringContaining('The operation could not be completed') },
        });
        expect(t3.threads()[0]).toMatchObject({ status: 'running', settled: false });

        t3.config({ launchUnavailable: false });
        runtime.send({ type: 'close', handle });

        expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'closed', handle });
        expect(t3.threads()).toHaveLength(1);
        expect(t3.threads()[0]).toMatchObject({ status: 'interrupted', settled: true });
      });

      // The op may still run, so it ends as a stop teamai could not confirm, which neither collect nor finishing may follow.
      it('ends the prompt cancel_failed, and a later cancel finds and stops the thread', async () => {
        t3.config({ agent: { hold: true, output: {} }, launchReplyLost: true });
        const { runtime, handle } = await opened();
        runtime.send(prompt(handle, 'op-00000067'));

        expect(await ended(runtime, 'op-00000067')).toEqual({
          op: 'op-00000067', event: 'failed', failure: {
            code: 'cancel_failed',
            message: `teamai launched the T3 thread "review · teamai ${RUN}", and T3 Code did not confirm the launch, so it may run: MCP error -32603: The connection closed before T3 answered. Run teamai workflow cancel ${RUN} to find and stop it.`,
          },
        });
        await expect.poll(() => t3.threads()[0]?.status).toBe('running');
        expect(t3.calls().filter((call) => call.tool === 't3_thread_interrupt')).toEqual([]);

        t3.config({ launchReplyLost: false });
        runtime.send({ type: 'cancel', op: 'op-00000067' });

        expect(await ended(runtime, 'op-00000067')).toEqual({ op: 'op-00000067', event: 'cancelled' });
        expect(t3.threads()).toHaveLength(1);
        expect(t3.threads()[0]?.status).toBe('interrupted');
      });

      it('answers a cancel after a restart cancel_failed while T3 cannot complete the repeated launch, and cancelled once it can', async () => {
        t3.config({ agent: { hold: true, output: {} }, launchMs: 3_000 });
        const first = await opened();
        first.runtime.send(prompt(first.handle, 'op-0000004b'));
        await expect.poll(() => t3.threads()[0]?.status).toBe('running');
        await first.runtime.close();
        t3.config({ launchMs: 0, launchUnavailable: true });

        const second = start();
        second.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'attended', options: { environment: 'local' } });
        await second.next((line) => line['type'] === 'init');
        second.send({ type: 'cancel', op: 'op-0000004b' });

        expect(await second.next((line) => line['op'] === 'op-0000004b')).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed', message: expect.stringContaining('The operation could not be completed') } });
        expect(t3.calls().filter((call) => call.tool === 't3_thread_launch')).toHaveLength(2);
        second.send({ type: 'reattach', handle: first.handle });
        expect(await second.next((line) => line['event'] === 'alive')).toMatchObject({ ops: [{ op: 'op-0000004b', state: 'failed', failure: { code: 'cancel_failed' } }] });
        expect(t3.threads()[0]).toMatchObject({ status: 'running', settled: false });

        t3.config({ launchUnavailable: false });
        second.send({ type: 'cancel', op: 'op-0000004b' });

        expect(await second.next((line) => line['op'] === 'op-0000004b')).toEqual({ op: 'op-0000004b', event: 'cancelled' });
        expect(t3.threads()).toHaveLength(1);
        expect(t3.threads()[0]?.status).toBe('interrupted');
      });

      // T3 checks the mode a sign-in allows before it looks a repeated launch up, so a repeat in another mode finds nothing.
      it('resends a prompt whose launch T3 never answered as it was journaled, so it reconnects even in a mode the sign-in would refuse', async () => {
        const release = path.join(dir, 'release');
        t3.config({ agent: { release, output: { verdict: 'approve' } }, access: 'approval-required', launchMs: 3_000 });
        const first = await opened('attended', {}, { runtime_mode: 'approval-required' });
        first.runtime.send(prompt(first.handle, 'op-00000066'));
        await expect.poll(() => t3.threads()[0]?.status).toBe('running');
        await first.runtime.close();
        t3.config({ launchMs: 0 });

        // This runtime launches new threads in auto, which the sign-in does not allow.
        const second = start();
        second.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'attended', options: { environment: 'local' } });
        expect(await second.next((line) => line['type'] === 'init')).toMatchObject({ ok: true });
        second.send(prompt(first.handle, 'op-00000066'));
        expect(await second.next((line) => line['op'] === 'op-00000066' && line['event'] === 'display')).toMatchObject({ display: { url: linkTo(t3.threads()[0]?.threadId) } });
        fs.writeFileSync(release, '');

        expect(await ended(second, 'op-00000066')).toMatchObject({ event: 'finished', result: { output: { verdict: 'approve' } } });
        expect(t3.threads()).toHaveLength(1);
        expect(t3.calls().filter((call) => call.tool === 't3_thread_launch').map((call) => call.args['runtimeMode'])).toEqual(['approval-required', 'approval-required']);
      });

      // T3 finds a repeated launch only under the sign-in that sent it, and a sign-in lasts a limited time.
      describe('after the member signed in again', () => {
        const SECOND = 'fake-t3-token-second-0987654321';

        /** A launch T3 made under the first sign-in and never answered, its runtime gone, and a runtime on a new sign-in. */
        const lostThenSignedInAgain = async (op: string): Promise<{ runtime: Connection; handle: string; record: string }> => {
          t3.config({ agent: { hold: true, output: {} }, launchMs: 3_000 });
          const first = await opened();
          first.runtime.send(prompt(first.handle, op));
          await expect.poll(() => t3.threads()[0]?.status).toBe('running');
          await first.runtime.close();
          t3.config({ launchMs: 0, token: SECOND, namespace: 'session-2' });
          signIn(t3, SECOND);

          const runtime = start();
          runtime.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'attended', options: { environment: 'local' } });
          expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: true });

          return { runtime, handle: first.handle, record: path.join(t3.home, '.teamai', 'runtime-state', 't3', 'places', `${encodeURIComponent(first.handle)}.json`) };
        };

        const unconfirmed = (record: string) => ({
          code: 'launch_unconfirmed',
          message: `teamai launched the T3 thread "review · teamai ${RUN}" in the T3 project "acme-app" under an earlier T3 Code sign-in, and T3 Code never answered, so it may still run. T3 Code finds that launch only under the sign-in that sent it, so teamai cannot find or stop it. In T3 Code, stop "review · teamai ${RUN}" with its Stop button if it runs, then delete ${record} and run teamai workflow cancel ${RUN} again.`,
        });

        it('keeps the place at close, naming the thread to stop and the record to delete, and launches nothing', async () => {
          const { runtime, handle, record } = await lostThenSignedInAgain('op-0000004c');

          runtime.send({ type: 'close', handle });

          expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'close_failed', handle, failure: unconfirmed(record) });
          expect(t3.threads()).toHaveLength(1);
          expect(t3.threads()[0]).toMatchObject({ status: 'running', settled: false });
          // The record names the sign-in by a hash, never by its token.
          expect(fs.readFileSync(record, 'utf8')).not.toContain('fake-t3-token');
        });

        it('fails the op on a cancel, saying the same, and launches nothing', async () => {
          const { runtime, handle, record } = await lostThenSignedInAgain('op-0000004d');

          runtime.send({ type: 'cancel', op: 'op-0000004d' });

          expect(await runtime.next((line) => line['op'] === 'op-0000004d')).toEqual({ op: 'op-0000004d', event: 'failed', failure: { ...unconfirmed(record), code: 'cancel_failed' } });
          runtime.send({ type: 'close', handle });
          expect(await runtime.next((line) => line['handle'] === handle)).toMatchObject({ event: 'close_failed', failure: { code: 'launch_unconfirmed' } });
          expect(t3.threads()).toHaveLength(1);
          expect(t3.threads()[0]?.status).toBe('running');
        });

        it('fails a resumed prompt, saying the same, rather than launching the step again', async () => {
          const { runtime, handle, record } = await lostThenSignedInAgain('op-0000004e');

          runtime.send(prompt(handle, 'op-0000004e'));

          expect(await ended(runtime, 'op-0000004e')).toEqual({ op: 'op-0000004e', event: 'failed', failure: { ...unconfirmed(record), code: 'cancel_failed' } });
          expect(t3.threads()).toHaveLength(1);
        });
      });

      // Looking the launch up counts toward the cancel's 10 s.
      it('answers a cancel after a restart cancel_failed within the stop bound while T3 is slow to answer the repeated launch', async () => {
        t3.config({ agent: { hold: true, output: {} }, launchMs: 3_000 });
        const first = await opened();
        first.runtime.send(prompt(first.handle, 'op-0000006b'));
        await expect.poll(() => t3.threads()[0]?.status).toBe('running');
        await first.runtime.close();
        t3.config({ launchMs: 16_000 });

        const second = start();
        second.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'attended', options: { environment: 'local' } });
        await second.next((line) => line['type'] === 'init');
        const cancelledAt = Date.now();
        second.send({ type: 'cancel', op: 'op-0000006b' });

        expect(await second.next((line) => line['op'] === 'op-0000006b', 20_000)).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed', message: expect.stringContaining('did not say within 10 s whether it launched it') } });
        expect(Date.now() - cancelledAt).toBeLessThan(12_000);
        expect(t3.threads()[0]?.status).toBe('running');
      }, 40_000);

      // A record written after its place closed would be a place no close removes.
      it('writes no record for a place a close removed while a cancel still looked its launch up', async () => {
        t3.config({ agent: { hold: true, output: {} }, launchMs: 3_000 });
        const first = await opened();
        first.runtime.send(prompt(first.handle, 'op-0000007b'));
        await expect.poll(() => t3.threads()[0]?.status).toBe('running');
        await first.runtime.close();
        t3.config({ launchMs: 13_000 });

        const second = start();
        second.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'attended', options: { environment: 'local' } });
        await second.next((line) => line['type'] === 'init');
        const cancelledAt = Date.now();
        second.send({ type: 'cancel', op: 'op-0000007b' });
        expect(await second.next((line) => line['op'] === 'op-0000007b', 20_000)).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed' } });

        t3.config({ launchMs: 0 });
        second.send({ type: 'close', handle: first.handle });
        expect(await second.next((line) => line['handle'] === first.handle, 20_000)).toEqual({ event: 'closed', handle: first.handle });
        const places = path.join(t3.home, '.teamai', 'runtime-state', 't3', 'places');
        expect(fs.readdirSync(places)).toEqual([]);

        // The cancel's lookup answers 13 s after it was sent.
        await new Promise((resolve) => { setTimeout(resolve, Math.max(cancelledAt + 14_500 - Date.now(), 0)); });
        expect(fs.readdirSync(places)).toEqual([]);
      }, 40_000);

      it('finds and stops the thread when teamai cancels the prompt after the runtime that launched it exited first', async () => {
        t3.config({ agent: { hold: true, output: {} }, launchMs: 3_000 });
        const first = await opened();
        first.runtime.send(prompt(first.handle, 'op-00000048'));
        await expect.poll(() => t3.threads()[0]?.status).toBe('running');
        await first.runtime.close();
        t3.config({ launchMs: 0 });

        const second = start();
        second.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'attended', options: { environment: 'local' } });
        await second.next((line) => line['type'] === 'init');
        second.send({ type: 'cancel', op: 'op-00000048' });

        await expect.poll(async () => {
          second.send({ type: 'reattach', handle: first.handle });

          return (await second.next((line) => line['event'] === 'alive'))['ops'];
        }).toEqual([{ op: 'op-00000048', state: 'cancelled' }]);
        expect(t3.threads()).toHaveLength(1);
        expect(t3.threads()[0]?.status).toBe('interrupted');
        second.send({ type: 'close', handle: first.handle });
        expect(await second.next((line) => line['handle'] === first.handle)).toEqual({ event: 'closed', handle: first.handle });
        expect(t3.threads()[0]?.settled).toBe(true);
      });
    });

    // A record that cannot be read is not proof the op launched nothing, so the cancel neither stops nor forgets its thread.
    it('fails a cancel after a restart cancel_failed, naming the record it cannot read, and a resent prompt then reconnects rather than ending cancelled', async () => {
      t3.config({ agent: { hold: true, output: {} } });
      const first = await opened();
      first.runtime.send(prompt(first.handle, 'op-00000070'));
      await first.runtime.next((line) => line['op'] === 'op-00000070' && line['event'] === 'display');
      await expect.poll(() => t3.threads()[0]?.status).toBe('running');
      await first.runtime.close();
      const record = path.join(t3.home, '.teamai', 'runtime-state', 't3', 'places', `${encodeURIComponent(first.handle)}.json`);
      const kept = fs.readFileSync(record, 'utf8');
      fs.writeFileSync(record, '{broken');

      const second = start();
      second.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'attended', options: { environment: 'local' } });
      await second.next((line) => line['type'] === 'init');
      second.send({ type: 'cancel', op: 'op-00000070' });

      expect(await second.next((line) => line['op'] === 'op-00000070')).toEqual({ op: 'op-00000070', event: 'failed', failure: { code: 'cancel_failed', message: expect.stringContaining(record) } });
      expect(fs.readFileSync(record, 'utf8')).toBe('{broken');

      // The person repairs the record: the resent prompt follows the thread the record names.
      fs.writeFileSync(record, kept);
      second.send(prompt(first.handle, 'op-00000070'));
      await second.next((line) => line['op'] === 'op-00000070' && line['event'] === 'accepted');
      second.send({ type: 'reattach', handle: first.handle });
      expect(await second.next((line) => line['event'] === 'alive')).toMatchObject({ ops: [{ op: 'op-00000070', state: 'running' }] });
      expect(second.lines.filter((line) => line['op'] === 'op-00000070' && line['event'] === 'cancelled')).toEqual([]);
      expect(t3.threads()[0]?.status).toBe('running');
    });

    // An op's own record names its place, so another place's record that cannot be read says nothing of it: the cancel
    // stands, and the prompt it cancelled launches nothing.
    it('launches nothing for a prompt teamai cancelled, whatever another place\'s record holds', async () => {
      const { runtime, handle } = await opened();
      const other = path.join(t3.home, '.teamai', 'runtime-state', 't3', 'places', 't3-rother-a0000000.json');
      fs.writeFileSync(other, '{broken');

      runtime.send({ type: 'cancel', op: 'op-00000076' });
      runtime.send(prompt(handle, 'op-00000076'));

      expect(await ended(runtime, 'op-00000076')).toEqual({ op: 'op-00000076', event: 'cancelled' });
      expect(runtime.lines.filter((line) => line['op'] === 'op-00000076' && line['event'] === 'failed')).toEqual([]);
      expect(t3.calls().filter((call) => call.tool === 't3_thread_launch')).toEqual([]);
    });

    // A cancel that cannot read the op's own record cannot tell whether it launched a thread, so it fails, naming it.
    it('fails a cancel cancel_failed, naming the op\'s record, when that record cannot be read', async () => {
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-0000007e'));
      await ended(runtime, 'op-0000007e');
      await runtime.close();
      const record = path.join(t3.home, '.teamai', 'runtime-state', 't3', 'ops', 'op-0000007e.json');
      fs.writeFileSync(record, '{broken');

      const second = start();
      second.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'recover', options: { environment: 'local' } });
      await second.next((line) => line['type'] === 'init');
      second.send({ type: 'cancel', op: 'op-0000007e' });

      expect(await second.next((line) => line['op'] === 'op-0000007e')).toEqual({ op: 'op-0000007e', event: 'failed', failure: { code: 'cancel_failed', message: expect.stringContaining(record) } });
      expect(fs.readFileSync(record, 'utf8')).toBe('{broken');
    });

    // Only a confirmed stop ends an op cancelled, never a mark that teamai cancelled it before the runtime saw its prompt.
    it('stops the thread a record names before it ends cancelled a prompt teamai cancelled while that record was missing', async () => {
      t3.config({ agent: { hold: true, output: {} } });
      const first = await opened();
      first.runtime.send(prompt(first.handle, 'op-00000071'));
      await first.runtime.next((line) => line['op'] === 'op-00000071' && line['event'] === 'display');
      await expect.poll(() => t3.threads()[0]?.status).toBe('running');
      await first.runtime.close();
      const record = path.join(t3.home, '.teamai', 'runtime-state', 't3', 'places', `${encodeURIComponent(first.handle)}.json`);
      fs.renameSync(record, `${record}.aside`);

      const second = start();
      second.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'attended', options: { environment: 'local' } });
      await second.next((line) => line['type'] === 'init');
      second.send({ type: 'cancel', op: 'op-00000071' });
      second.send({ type: 'reattach', handle: first.handle });
      expect(await second.next((line) => line['handle'] === first.handle)).toEqual({ event: 'gone', handle: first.handle });

      fs.renameSync(`${record}.aside`, record);
      second.send(prompt(first.handle, 'op-00000071'));

      expect(await ended(second, 'op-00000071')).toEqual({ op: 'op-00000071', event: 'cancelled' });
      expect(t3.threads()[0]?.status).toBe('interrupted');
      expect(t3.calls().filter((call) => call.tool === 't3_thread_interrupt')).toHaveLength(1);
    });

    // teamai fails every request it waits on when a runtime writes a line that names none, so each failure names its own.
    it('fails only the request it cannot carry out, naming its handle or op, when its journal cannot be written', async () => {
      const { runtime, handle } = await opened();
      const places = path.join(t3.home, '.teamai', 'runtime-state', 't3', 'places');
      fs.chmodSync(places, 0o500);

      runtime.send({ type: 'open', op: 'op-00000062', run: RUN, attempt: 'a9e8d7c6', credentials: {}, view: { worktree, readonly: [], result: path.dirname(result), runDir: path.join(dir, 'run'), toolHome: {} } });
      expect(await runtime.next((line) => line['op'] === 'op-00000062' && line['event'] !== 'accepted')).toEqual({
        op: 'op-00000062', event: 'failed', failure: { code: 'runtime_failed', message: expect.stringMatching(/^Runtime t3 could not carry out open of op-00000062: .*EACCES/) },
      });
      runtime.send({ type: 'close', handle });
      expect(await runtime.next((line) => line['handle'] === handle)).toEqual({
        event: 'failed', handle, failure: { code: 'runtime_failed', message: expect.stringMatching(new RegExp(`^Runtime t3 could not carry out close of ${handle}: .*EACCES`)) },
      });

      expect(runtime.lines.filter((line) => line['event'] === 'error')).toEqual([]);
    });

    // An op that owned its end without a journaled launch would make the resent prompt join it and never end.
    it('launches nothing for a prompt whose launch it cannot journal, and runs the prompt teamai resends once it can', async () => {
      const { runtime, handle } = await opened();
      const ops = path.join(t3.home, '.teamai', 'runtime-state', 't3', 'ops');
      fs.mkdirSync(ops, { recursive: true });
      fs.chmodSync(ops, 0o500);

      runtime.send(prompt(handle, 'op-00000077'));
      expect(await ended(runtime, 'op-00000077')).toEqual({ op: 'op-00000077', event: 'failed', failure: { code: 'runtime_failed', message: expect.stringMatching(/^Runtime t3 could not carry out prompt of op-00000077: .*EACCES/) } });
      expect(t3.calls().filter((call) => call.tool === 't3_thread_launch')).toEqual([]);

      fs.chmodSync(ops, 0o700);
      runtime.send(prompt(handle, 'op-00000077'));

      expect(await ended(runtime, 'op-00000077')).toMatchObject({ event: 'finished' });
      expect(t3.threads()).toHaveLength(1);
    });

    // teamai fails every request it waits on for an uncorrelated error, so only a line that names no request gets one.
    it('fails a malformed request that still names its op or handle on its own, and answers a line that names none with an error', async () => {
      t3.config({ agent: { hold: true, output: {} } });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-00000073'));
      await runtime.next((line) => line['op'] === 'op-00000073' && line['event'] === 'display');

      runtime.send({ type: 'prompt', op: 'op-00000074', handle });
      expect(await runtime.next((line) => line['op'] === 'op-00000074')).toEqual({ op: 'op-00000074', event: 'failed', failure: { code: 'runtime_protocol', message: expect.stringMatching(/^Not a protocol 1 request: /) } });
      runtime.send({ type: 'settle', handle });
      expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'failed', handle, failure: { code: 'runtime_protocol', message: expect.stringMatching(/^Not a protocol 1 request: /) } });
      runtime.send({ type: 'close' });
      expect(await runtime.next((line) => line['event'] === 'error')).toEqual({ event: 'error', message: expect.stringMatching(/^Not a protocol 1 request: /) });

      expect(runtime.lines.filter((line) => line['event'] === 'error')).toHaveLength(1);
      expect(runtime.lines.filter((line) => line['op'] === 'op-00000073').map((line) => line['event'])).toEqual(['accepted', 'display']);
    });

    // A failure for an op the runtime already runs would be a second outcome, while its thread still runs.
    it('drops a malformed request that names an op it already runs, which then ends once', async () => {
      t3.config({ agent: { hold: true, output: {} } });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-00000075'));
      await runtime.next((line) => line['op'] === 'op-00000075' && line['event'] === 'display');

      runtime.send({ type: 'prompt', op: 'op-00000075', handle });
      // Lines are read in order: the reattach answers after the malformed line was.
      runtime.send({ type: 'reattach', handle });
      await runtime.next((line) => line['event'] === 'alive');
      expect(runtime.lines.filter((line) => line['op'] === 'op-00000075').map((line) => line['event'])).toEqual(['accepted', 'display']);
      expect(runtime.stderr()).toContain('op-00000075');
      runtime.send({ type: 'cancel', op: 'op-00000075' });

      expect(await ended(runtime, 'op-00000075')).toEqual({ op: 'op-00000075', event: 'cancelled' });
      expect(runtime.lines.filter((line) => line['op'] === 'op-00000075').map((line) => line['event'])).toEqual(['accepted', 'display', 'cancelled']);
      expect(runtime.lines.filter((line) => line['event'] === 'error')).toEqual([]);
    });

    it('keeps running, and ends its prompt, when it notes a dropped line after teamai stopped reading its stderr', async () => {
      t3.config({ agent: { hold: true, output: {} } });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-00000079'));
      await runtime.next((line) => line['op'] === 'op-00000079' && line['event'] === 'display');
      runtime.child.stderr.destroy();

      // Its note about the dropped line goes to a stderr nobody reads.
      runtime.send({ type: 'prompt', op: 'op-00000079', handle });
      runtime.send({ type: 'reattach', handle });
      await runtime.next((line) => line['event'] === 'alive');
      await new Promise((resolve) => { setTimeout(resolve, 500); });
      runtime.send({ type: 'cancel', op: 'op-00000079' });

      expect(await ended(runtime, 'op-00000079')).toEqual({ op: 'op-00000079', event: 'cancelled' });
    });

    // A prompt whose end goes unanswered is one teamai waits on for good.
    it('answers a prompt that ends while its record cannot be written, once, and says in a notice that it was not recorded', async () => {
      const release = path.join(dir, 'release');
      t3.config({ agent: { release, output: {} } });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-0000007a'));
      await runtime.next((line) => line['op'] === 'op-0000007a' && line['event'] === 'display');
      const ops = path.join(t3.home, '.teamai', 'runtime-state', 't3', 'ops');
      fs.chmodSync(ops, 0o500);
      fs.writeFileSync(release, '');

      expect(await ended(runtime, 'op-0000007a')).toMatchObject({ op: 'op-0000007a', event: 'finished' });
      fs.chmodSync(ops, 0o700);
      expect(runtime.lines.find((line) => line['op'] === 'op-0000007a' && line['event'] === 'notice')).toEqual({
        op: 'op-0000007a', event: 'notice', message: expect.stringMatching(/^Runtime t3 could not record how op-0000007a ended \(.*EACCES.*\), so only this runtime process remembers that end, until the place closes\.$/),
      });
      runtime.send({ type: 'close', handle });
      await runtime.next((line) => line['event'] === 'closed');
      expect(runtime.lines.filter((line) => line['op'] === 'op-0000007a').map((line) => line['event'])).toEqual(['accepted', 'display', 'notice', 'finished']);
    });

    // A place whose record cannot be read is never written over, and the end it holds back is the ledger's to keep.
    it('answers a prompt that ends while its place\'s record cannot be read, and says in a notice that it was not recorded', async () => {
      const release = path.join(dir, 'release');
      t3.config({ agent: { release, output: {} } });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-000000b7'));
      await runtime.next((line) => line['op'] === 'op-000000b7' && line['event'] === 'display');
      const record = path.join(t3.home, '.teamai', 'runtime-state', 't3', 'places', `${encodeURIComponent(handle)}.json`);
      const readable = fs.readFileSync(record, 'utf8');
      fs.writeFileSync(record, '{"handle":');
      fs.writeFileSync(release, '');

      expect(await ended(runtime, 'op-000000b7')).toMatchObject({ op: 'op-000000b7', event: 'finished' });
      fs.writeFileSync(record, readable);
      expect(runtime.lines.find((line) => line['op'] === 'op-000000b7' && line['event'] === 'notice')).toEqual({
        op: 'op-000000b7', event: 'notice', message: expect.stringMatching(/^Runtime t3 could not record how op-000000b7 ended \(.*cannot be read.*\), so only this runtime process remembers that end, until the place closes\.$/),
      });
    });

    it('reports the end of a prompt it could not record to a reattach, a cancel and a repeated prompt in the same process, never another end', async () => {
      const release = path.join(dir, 'release');
      t3.config({ agent: { release, output: {} } });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-0000007c'));
      await runtime.next((line) => line['op'] === 'op-0000007c' && line['event'] === 'display');
      const ops = path.join(t3.home, '.teamai', 'runtime-state', 't3', 'ops');
      fs.chmodSync(ops, 0o500);
      fs.writeFileSync(release, '');
      const end = await ended(runtime, 'op-0000007c');
      fs.chmodSync(ops, 0o700);
      expect(end).toMatchObject({ event: 'finished' });

      runtime.send({ type: 'reattach', handle });

      expect(await runtime.next((line) => line['event'] === 'alive')).toMatchObject({ ops: [{ op: 'op-0000007c', state: 'finished' }] });
      runtime.send({ type: 'cancel', op: 'op-0000007c' });
      expect(await ended(runtime, 'op-0000007c')).toEqual(end);
      const launches = t3.calls().filter((call) => call.tool === 't3_thread_launch').length;
      runtime.send(prompt(handle, 'op-0000007c'));
      expect(await ended(runtime, 'op-0000007c')).toEqual(end);
      expect(t3.calls().filter((call) => call.tool === 't3_thread_launch')).toHaveLength(launches);
    });

    // A cancelled end, unlike a finished one, cannot be rebuilt by following the stopped thread again.
    it('answers a repeated prompt with a cancelled end it could not record, not with the stopped thread\'s own end', async () => {
      t3.config({ agent: { hold: true, output: {} } });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-0000007d'));
      await runtime.next((line) => line['op'] === 'op-0000007d' && line['event'] === 'display');
      const ops = path.join(t3.home, '.teamai', 'runtime-state', 't3', 'ops');
      fs.chmodSync(ops, 0o500);
      runtime.send({ type: 'cancel', op: 'op-0000007d' });
      const end = await ended(runtime, 'op-0000007d');
      fs.chmodSync(ops, 0o700);
      expect(end).toEqual({ op: 'op-0000007d', event: 'cancelled' });

      runtime.send(prompt(handle, 'op-0000007d'));

      expect(await ended(runtime, 'op-0000007d')).toEqual(end);
    });

    it('answers a repeated prompt that ended with the same outcome, before and after its own restart', async () => {
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-00000018'));
      const end = await ended(runtime, 'op-00000018');
      runtime.send(prompt(handle, 'op-00000018'));
      expect(await ended(runtime, 'op-00000018')).toEqual(end);
      await runtime.close();

      const second = start();
      second.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'attended', options: { environment: 'local' } });
      await second.next((line) => line['type'] === 'init');
      second.send({ type: 'reattach', handle });
      expect(await second.next((line) => line['event'] === 'alive')).toMatchObject({ ops: [{ op: 'op-00000018', state: 'finished', session: end['session'], result: end['result'] }] });
      second.send(prompt(handle, 'op-00000018'));

      expect(await ended(second, 'op-00000018')).toEqual(end);
      expect(t3.threads()).toHaveLength(1);
    });

    it('ends an interactive step only once the agent wrote the result: an idle thread after a turn does not end it', async () => {
      t3.config({ agent: {} });
      const { runtime, handle } = await opened();

      runtime.send(prompt(handle, 'op-00000019', { interactive: true }));
      await expect.poll(() => t3.threads()[0]?.status).toBe('completed');
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(runtime.lines.filter((line) => line['op'] === 'op-00000019').map((line) => line['event'])).toEqual(['accepted', 'display']);
      expect(t3.threads()[0]?.message).toContain('Write the result file only once they say the step is done.');
      // The person said it is done, and the agent wrote the result.
      fs.writeFileSync(result, JSON.stringify({ output: { notes: 'agreed' } }));

      expect(await ended(runtime, 'op-00000019')).toMatchObject({ event: 'finished', result: { output: { notes: 'agreed' } } });
    });

    it('runs no command', async () => {
      const { runtime, handle } = await opened();

      runtime.send({ type: 'exec', op: 'op-00000016', handle, argv: ['/bin/sh', '-c', 'touch ran'], env: {}, unset: [], cwd: worktree });

      expect(await ended(runtime, 'op-00000016')).toMatchObject({ event: 'failed', failure: { code: 'exec_unsupported' } });
      expect(fs.existsSync(path.join(worktree, 'ran'))).toBe(false);
    });
  });
});

// A prompt whose lease names the conversation of an earlier prompt runs as a new turn of that prompt's T3 thread, when
// the runtime still holds it, on the same provider instance and model selection, in the same folder.

/** The place of the step that continues the conversation: a later attempt, on the same worktree unless `folder` says. */
async function openLater(runtime: Connection, folder = worktree, { op, attempt }: { op: string; attempt: string } = { op: 'op-000000c0', attempt: 'a5e6f7a8' }): Promise<{ handle: string; result: string }> {
  const laterResult = path.join(dir, attempt, 'out', 'result.json');
  fs.mkdirSync(path.dirname(laterResult), { recursive: true });
  runtime.send({ type: 'open', op, run: RUN, attempt, credentials: {}, view: { worktree: folder, readonly: [], result: path.dirname(laterResult), runDir: path.join(dir, 'run'), toolHome: {} } });
  const accepted = await runtime.next((line) => line['op'] === op && line['event'] === 'accepted');
  expect(await runtime.next((line) => line['op'] === op && line['event'] !== 'accepted' && line['event'] !== 'notice')).toMatchObject({ event: 'ready' });

  return { handle: z.string().parse(accepted['handle']), result: laterResult };
}

/** The later step's prompt, which continues the conversation of `earlier`'s op in the place `earlier.handle`. */
const turn = (at: { handle: string; result: string }, op: string, earlier: { handle: string; op: string }, lease: Parameters<typeof prompt>[2] = {}) => prompt(at.handle, op, {
  step: 'fix', result: at.result, prompt: `Fix what the review found.\n\nWrite the workflow result as JSON to ${at.result}. Use this shape: {"output":{}}.`, continue: earlier, ...lease,
});

describe('teamai-runtime-t3', () => {
  useT3Runtime();

  describe('a prompt that continues an earlier prompt\'s conversation', () => {
    usePromptStep();

    it('sends the prompt as a new turn of the earlier thread, follows it under its own op, and answers resumed with the same session', async () => {
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-000000b1'));
      const first = await ended(runtime, 'op-000000b1');
      expect(first).toMatchObject({ event: 'finished' });
      const later = await openLater(runtime);

      runtime.send(turn(later, 'op-000000b2', { handle, op: 'op-000000b1' }));

      expect(await ended(runtime, 'op-000000b2')).toMatchObject({ event: 'finished', resumed: true, session: first['session'], result: { output: { verdict: 'approve' } } });
      expect(t3.threads()).toHaveLength(1);
      expect(t3.threads()[0]).toMatchObject({ runCount: 2, settled: false, message: expect.stringContaining('Fix what the review found.') });
      expect(t3.calls().filter((call) => call.tool === 't3_thread_send').map((call) => call.args['clientRequestId'])).toEqual(['op-000000b2']);
      expect(noticesOf(runtime)).toEqual([]);
    });

    it('reports only the tokens of its own turn, not those of the earlier steps in the same session', async () => {
      t3.config({ agent: { output: { verdict: 'approve' }, usage: { input: 1_200, output: 340, cacheRead: 18_000 } } });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-000000b1'));
      expect(await ended(runtime, 'op-000000b1')).toMatchObject({ event: 'finished', usage: { input: 1_200, output: 340, cachedInput: 18_000 } });
      const later = await openLater(runtime);

      runtime.send(turn(later, 'op-000000b2', { handle, op: 'op-000000b1' }));

      expect(await ended(runtime, 'op-000000b2')).toMatchObject({ event: 'finished', resumed: true, usage: { input: 1_200, output: 340, cachedInput: 18_000 } });
    });

    /** A first step that finished in the place `handle`, and the later step's place on `folder`. */
    const finishedFirst = async (folder = worktree) => {
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-000000b1'));
      const first = await ended(runtime, 'op-000000b1');
      expect(first).toMatchObject({ event: 'finished' });
      const threadId = z.string().parse(t3.threads()[0]?.threadId);

      return { runtime, handle, first, threadId, later: await openLater(runtime, folder) };
    };

    /** The one notice the runtime wrote for `op`. */
    const noticeOf = (runtime: Connection, op: string) => noticesOf(runtime).filter((line) => line['op'] === op);

    it('starts a new thread, saying why, when the person deleted the earlier thread in T3 Code', async () => {
      const { runtime, handle, threadId, later } = await finishedFirst();
      t3.deleteThread(threadId);

      runtime.send(turn(later, 'op-000000b2', { handle, op: 'op-000000b1' }));

      const end = await ended(runtime, 'op-000000b2');
      expect(end).toMatchObject({ event: 'finished' });
      expect(end['resumed']).toBeUndefined();
      expect(t3.threads()).toHaveLength(1);
      expect(t3.threads()[0]?.threadId).not.toBe(threadId);
      expect(noticeOf(runtime, 'op-000000b2')).toEqual([{
        event: 'notice', op: 'op-000000b2', handle: later.handle,
        message: `Runtime t3 starts a new T3 thread for step "fix" rather than continue the conversation of op-000000b1: the T3 thread ${linkTo(threadId)} ("review · teamai ${RUN}") of op-000000b1 is no longer in T3 Code.`,
      }]);
    });

    it('starts a new thread, saying why, when the earlier thread runs again in T3 Code', async () => {
      const { runtime, handle, threadId, later } = await finishedFirst();
      t3.runAgain(threadId);

      runtime.send(turn(later, 'op-000000b2', { handle, op: 'op-000000b1' }));

      const end = await ended(runtime, 'op-000000b2');
      expect(end).toMatchObject({ event: 'finished' });
      expect(end['resumed']).toBeUndefined();
      expect(t3.calls().filter((call) => call.tool === 't3_thread_send')).toEqual([]);
      expect(noticeOf(runtime, 'op-000000b2')).toEqual([{
        event: 'notice', op: 'op-000000b2', handle: later.handle,
        message: `Runtime t3 starts a new T3 thread for step "fix" rather than continue the conversation of op-000000b1: the T3 thread ${linkTo(threadId)} ("review · teamai ${RUN}") of op-000000b1 runs in T3 Code (running).`,
      }]);
    });

    it('starts a new thread, saying why, when the step works in another folder than the earlier thread', async () => {
      const other = path.join(checkout, '.teamai', 'workflow-worktrees', `${RUN}-a5e6f7a8`);
      execFileSync('git', ['-C', checkout, 'worktree', 'add', '-q', '--detach', other]);
      const { runtime, handle, threadId, later } = await finishedFirst(other);

      runtime.send({ ...turn(later, 'op-000000b2', { handle, op: 'op-000000b1' }), cwd: other });

      const end = await ended(runtime, 'op-000000b2');
      expect(end).toMatchObject({ event: 'finished' });
      expect(end['resumed']).toBeUndefined();
      expect(t3.threads()).toHaveLength(2);
      expect(noticeOf(runtime, 'op-000000b2')).toEqual([{
        event: 'notice', op: 'op-000000b2', handle: later.handle,
        message: `Runtime t3 starts a new T3 thread for step "fix" rather than continue the conversation of op-000000b1: the T3 thread ${linkTo(threadId)} ("review · teamai ${RUN}") of op-000000b1 works in ${worktree}, not in this step's folder ${other}.`,
      }]);
    });

    // T3 runs a later turn on another model of the thread's provider instance once the thread is set to it.
    it.each<{ change: string; lease: Line; selection: Line }>([
      { change: 'another model', lease: { model: { name: 'claude-sonnet-5-5' } }, selection: { instanceId: 'claudeAgent', model: 'claude-sonnet-5-5' } },
      { change: 'another effort', lease: { model: { name: 'claude-opus-5-5', effort: 'high' } }, selection: { instanceId: 'claudeAgent', model: 'claude-opus-5-5', options: [{ id: 'effort', value: 'high' }] } },
    ])('continues the thread on $change of the same provider instance, set on the thread before the turn', async ({ lease, selection }) => {
      const { runtime, handle, first, later } = await finishedFirst();

      runtime.send(turn(later, 'op-000000b2', { handle, op: 'op-000000b1' }, lease));

      expect(await ended(runtime, 'op-000000b2')).toMatchObject({ event: 'finished', resumed: true, session: first['session'] });
      expect(t3.threads()).toEqual([expect.objectContaining({ runCount: 2, model: selection['model'] })]);
      expect(t3.calls().filter((call) => call.tool === 't3_thread_configure' || call.tool === 't3_thread_send').map((call) => [call.tool, call.args['modelSelection']])).toEqual([['t3_thread_configure', selection], ['t3_thread_send', undefined]]);
      expect(noticesOf(runtime)).toEqual([]);
    });

    // A chain names its first prompt, while a turn between may have set the thread to another model.
    it('sets the thread back to the model a third step asks for, after the second step set it to another', async () => {
      const { runtime, handle, later } = await finishedFirst();
      runtime.send(turn(later, 'op-000000b2', { handle, op: 'op-000000b1' }, { model: { name: 'claude-sonnet-5-5' } }));
      expect(await ended(runtime, 'op-000000b2')).toMatchObject({ event: 'finished', resumed: true });
      const third = await openLater(runtime, worktree, { op: 'op-000000c1', attempt: 'a9b0c1d2' });

      runtime.send(turn(third, 'op-000000b3', { handle, op: 'op-000000b1' }, { model: { name: 'claude-opus-5-5' } }));

      expect(await ended(runtime, 'op-000000b3')).toMatchObject({ event: 'finished', resumed: true });
      expect(t3.threads()).toEqual([expect.objectContaining({ runCount: 3, model: 'claude-opus-5-5' })]);
      expect(t3.calls().filter((call) => call.tool === 't3_thread_configure').map((call) => call.args['modelSelection'])).toEqual([
        { instanceId: 'claudeAgent', model: 'claude-sonnet-5-5' }, { instanceId: 'claudeAgent', model: 'claude-opus-5-5' },
      ]);
    });

    // A step that names no model is launched on T3's default, which T3 applies and says back; the runtime names none.
    it('sets the thread back to the model it was launched on for a third step that names none, after the second step set it to another', async () => {
      t3.settings({ defaultModelSelection: { instanceId: 'claudeAgent', model: 'claude-haiku-5-5' } });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-000000b1', { model: undefined }));
      expect(await ended(runtime, 'op-000000b1')).toMatchObject({ event: 'finished' });
      expect(t3.calls().find((call) => call.tool === 't3_thread_launch')?.args).not.toHaveProperty('modelSelection');
      const later = await openLater(runtime);
      runtime.send(turn(later, 'op-000000b2', { handle, op: 'op-000000b1' }, { model: { name: 'claude-sonnet-5-5' } }));
      expect(await ended(runtime, 'op-000000b2')).toMatchObject({ event: 'finished', resumed: true });
      const third = await openLater(runtime, worktree, { op: 'op-000000c1', attempt: 'a9b0c1d2' });

      runtime.send(turn(third, 'op-000000b3', { handle, op: 'op-000000b1' }, { model: undefined }));

      expect(await ended(runtime, 'op-000000b3')).toMatchObject({ event: 'finished', resumed: true });
      expect(t3.threads()).toEqual([expect.objectContaining({ runCount: 3, model: 'claude-haiku-5-5' })]);
      expect(t3.calls().filter((call) => call.tool === 't3_thread_configure').map((call) => call.args['modelSelection'])).toEqual([
        { instanceId: 'claudeAgent', model: 'claude-sonnet-5-5' }, { instanceId: 'claudeAgent', model: 'claude-haiku-5-5' },
      ]);
    });

    it('starts a new thread, saying why, when the step runs on another provider instance than the earlier thread', async () => {
      const { runtime, handle, threadId, later } = await finishedFirst();

      runtime.send(turn(later, 'op-000000b2', { handle, op: 'op-000000b1' }, { tool: 'codex', model: { name: 'gpt-6.1-sol' } }));

      expect(await ended(runtime, 'op-000000b2')).not.toHaveProperty('resumed');
      expect(t3.threads()).toHaveLength(2);
      expect(noticeOf(runtime, 'op-000000b2')).toEqual([{
        event: 'notice', op: 'op-000000b2', handle: later.handle,
        message: `Runtime t3 starts a new T3 thread for step "fix" rather than continue the conversation of op-000000b1: the T3 thread ${linkTo(threadId)} ("review · teamai ${RUN}") of op-000000b1 runs on T3 Code provider instance "claudeAgent", and this step asks for "codex".`,
      }]);
    });

    it('stops only the continuing turn on its cancel, and leaves the thread to the earlier place to settle at its close', async () => {
      const { runtime, handle, threadId, later } = await finishedFirst();
      t3.config({ agent: { hold: true, output: {} } });
      runtime.send(turn(later, 'op-000000b2', { handle, op: 'op-000000b1' }));
      await expect.poll(() => t3.threads()[0]).toMatchObject({ status: 'running', runCount: 2 });

      runtime.send({ type: 'cancel', op: 'op-000000b2' });

      expect(await ended(runtime, 'op-000000b2')).toEqual({ op: 'op-000000b2', event: 'cancelled' });
      expect(t3.threads()).toEqual([expect.objectContaining({ threadId, status: 'interrupted' })]);
      runtime.send({ type: 'reattach', handle });
      expect(await runtime.next((line) => line['event'] === 'alive' && line['handle'] === handle)).toMatchObject({ ops: [{ op: 'op-000000b1', state: 'finished' }] });

      runtime.send({ type: 'close', handle: later.handle });
      expect(await runtime.next((line) => line['handle'] === later.handle && line['event'] === 'closed')).toEqual({ event: 'closed', handle: later.handle });
      expect(t3.threads()[0]?.settled).toBe(false);
      runtime.send({ type: 'close', handle });
      expect(await runtime.next((line) => line['handle'] === handle && line['event'] === 'closed')).toEqual({ event: 'closed', handle });
      expect(t3.threads()[0]?.settled).toBe(true);
    });

    it('stops only its turn when the later place closes while the turn runs, and leaves the conversation to the earlier place', async () => {
      const { runtime, handle, threadId, later } = await finishedFirst();
      t3.config({ agent: { hold: true, output: {} } });
      runtime.send(turn(later, 'op-000000b2', { handle, op: 'op-000000b1' }));
      await expect.poll(() => t3.threads()[0]).toMatchObject({ status: 'running', runCount: 2 });

      runtime.send({ type: 'close', handle: later.handle });

      expect(await runtime.next((line) => line['handle'] === later.handle && line['event'] === 'closed')).toEqual({ event: 'closed', handle: later.handle });
      expect(await ended(runtime, 'op-000000b2')).toEqual({ op: 'op-000000b2', event: 'cancelled' });
      expect(t3.threads()).toEqual([expect.objectContaining({ threadId, status: 'interrupted', settled: false })]);
      runtime.send({ type: 'reattach', handle });
      expect(await runtime.next((line) => line['event'] === 'alive' && line['handle'] === handle)).toMatchObject({ ops: [{ op: 'op-000000b1', state: 'finished' }] });
    });

    it('reattaches the later op to its turn after a restart while the turn runs, and follows the turn to its end', async () => {
      const release = path.join(dir, 'release');
      const { runtime, handle, first, later } = await finishedFirst();
      t3.config({ agent: { release, output: { verdict: 'approve' } } });
      runtime.send(turn(later, 'op-000000b2', { handle, op: 'op-000000b1' }));
      await expect.poll(() => t3.threads()[0]).toMatchObject({ status: 'running', runCount: 2 });
      await runtime.close();

      const again = start();
      again.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'attended', options: { environment: 'local' } });
      expect(await again.next((line) => line['type'] === 'init')).toMatchObject({ ok: true });
      again.send({ type: 'reattach', handle: later.handle });
      expect(await again.next((line) => line['event'] === 'alive' && line['handle'] === later.handle)).toMatchObject({ ops: [{ op: 'op-000000b2', state: 'running' }] });
      again.send(turn(later, 'op-000000b2', { handle, op: 'op-000000b1' }));
      fs.writeFileSync(release, '');

      expect(await ended(again, 'op-000000b2')).toMatchObject({ event: 'finished', resumed: true, session: first['session'] });
      expect(t3.threads()).toEqual([expect.objectContaining({ runCount: 2, status: 'completed' })]);
    });

    it('settles the thread at the later place\'s close when the earlier place closed first', async () => {
      const { runtime, handle, later } = await finishedFirst();
      runtime.send(turn(later, 'op-000000b2', { handle, op: 'op-000000b1' }));
      expect(await ended(runtime, 'op-000000b2')).toMatchObject({ event: 'finished', resumed: true });

      runtime.send({ type: 'close', handle });
      expect(await runtime.next((line) => line['handle'] === handle && line['event'] === 'closed')).toEqual({ event: 'closed', handle });
      expect(t3.threads()[0]?.settled).toBe(true);
      // The turn left the Settled group; the later place settles it once more.
      runtime.send({ type: 'close', handle: later.handle });
      expect(await runtime.next((line) => line['handle'] === later.handle && line['event'] === 'closed')).toEqual({ event: 'closed', handle: later.handle });
      expect(t3.calls().filter((call) => call.tool === 't3_thread_organize')).toHaveLength(2);
    });

    it('follows the turn\'s own run, not the earlier run T3 still shows as ended right after the send', async () => {
      const { runtime, handle, later } = await finishedFirst();
      t3.config({ turnStartsLateMs: 600 });

      runtime.send(turn(later, 'op-000000b2', { handle, op: 'op-000000b1' }));

      expect(await ended(runtime, 'op-000000b2')).toMatchObject({ event: 'finished', resumed: true, result: { output: { verdict: 'approve' } } });
      expect(t3.threads()[0]?.runCount).toBe(2);
    });

    // The earlier run's end, which T3 still shows right after the send, is not the turn's stop.
    it('stops the turn\'s own run when teamai cancels it before T3 shows that run, and only then ends it cancelled', async () => {
      const { runtime, handle, later } = await finishedFirst();
      t3.config({ turnStartsLateMs: 1_500, agent: { hold: true, output: {} } });
      runtime.send(turn(later, 'op-000000b2', { handle, op: 'op-000000b1' }));
      await runtime.next((line) => line['op'] === 'op-000000b2' && line['event'] === 'display');
      await expect.poll(() => t3.calls().filter((call) => call.tool === 't3_thread_send')).toHaveLength(1);

      runtime.send({ type: 'cancel', op: 'op-000000b2' });

      expect(await ended(runtime, 'op-000000b2')).toEqual({ op: 'op-000000b2', event: 'cancelled' });
      expect(t3.threads()[0]).toMatchObject({ runCount: 2, status: 'interrupted' });
    });

    it('fails the cancel, never ends it cancelled, when T3 shows no run of the turn within 10 s', async () => {
      const { runtime, handle, later } = await finishedFirst();
      t3.config({ turnStartsLateMs: 60_000 });
      runtime.send(turn(later, 'op-000000b2', { handle, op: 'op-000000b1' }));
      await runtime.next((line) => line['op'] === 'op-000000b2' && line['event'] === 'display');
      await expect.poll(() => t3.calls().filter((call) => call.tool === 't3_thread_send')).toHaveLength(1);

      runtime.send({ type: 'cancel', op: 'op-000000b2' });

      expect(await ended(runtime, 'op-000000b2')).toMatchObject({
        event: 'failed', failure: { code: 'cancel_failed', message: expect.stringContaining('T3 Code showed no run of the turn teamai sent within 10 s') },
      });
    }, 20_000);

    it('sends the turn once, after a restart between its send and T3\'s answer, and follows it to the end', async () => {
      const { runtime, handle, first, later } = await finishedFirst();
      t3.config({ sendMs: 5_000 });
      runtime.send(turn(later, 'op-000000b2', { handle, op: 'op-000000b1' }));
      await expect.poll(() => t3.threads()[0]?.runCount).toBe(2);
      await runtime.close();
      t3.config({ sendMs: 0 });

      const again = start();
      again.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'attended', options: { environment: 'local' } });
      expect(await again.next((line) => line['type'] === 'init')).toMatchObject({ ok: true });
      again.send(turn(later, 'op-000000b2', { handle, op: 'op-000000b1' }));

      expect(await ended(again, 'op-000000b2')).toMatchObject({ event: 'finished', resumed: true, session: first['session'] });
      expect(t3.threads()).toEqual([expect.objectContaining({ runCount: 2 })]);
      expect(t3.calls().filter((call) => call.tool === 't3_thread_send').map((call) => call.args['clientRequestId'])).toEqual(['op-000000b2', 'op-000000b2']);
    });
  });
});
