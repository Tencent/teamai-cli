import { describe, expect, it } from 'vitest';
import { WAKE_COMMAND } from '@teamai/runtime-protocol';
import { CLAUDE, CODEX, signIn, type Connection, type FakeT3Config, type Line } from './testing/harness.js';
import { start, t3, useT3Runtime, SHIPPED_HOME_ENV } from './testing/suite.js';
import { END_OF_WAKE } from './wake.js';

// A wake launches a fleet member's thread on a machine linked to this T3 Code that has the run's repository as a
// project, and forgets it.

const REPOSITORY = 'https://github.com/acme/acme-app.git';

/** The project of the repository on a linked machine, as T3 lists it there. */
const acmeApp = { id: 'project-there', title: 'acme-app', workspaceRoot: '/Users/sam/code/acme-app', deletedAt: null, repositoryIdentity: { canonicalKey: 'github.com/acme/acme-app' } };

/** Three linked machines: one that does not answer, one without the repository, and one with it. */
const LINKED: Pick<FakeT3Config, 'links' | 'environments'> = {
  links: [
    { environmentId: 'env-gone', label: 'old-mac', status: 'unreachable' },
    { environmentId: 'env-other', label: 'build-box', status: 'reachable' },
    { environmentId: 'env-sam', label: 'sams-laptop', status: 'reachable' },
  ],
  environments: {
    'env-other': { projects: [{ id: 'project-web', title: 'web', workspaceRoot: '/srv/web', repositoryIdentity: { canonicalKey: 'github.com/acme/web' } }], providers: [CLAUDE] },
    'env-sam': { projects: [acmeApp], providers: [CODEX, CLAUDE] },
  },
};

const wake = (op: string, request: Line = {}) => ({ type: 'wake', op, pool: 'gpu', repository: REPOSITORY, message: 'Run teamai workflow resume --claim gpu, then report.', title: 'teamai fleet r7f3a91c2 · gpu', ...request });

/** A runtime past an attended init, and its init reply. */
async function initialized(env: Record<string, string> = {}, options: Line = {}): Promise<{ runtime: Connection; reply: Line }> {
  const runtime = start(env);
  runtime.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'attended', options: { environment: 'local', ...options } });
  const reply = await runtime.next((line) => line['type'] === 'init');
  expect(reply).toMatchObject({ ok: true });

  return { runtime, reply };
}

/** How the wake `op` ended. */
const woke = (runtime: Connection, op: string): Promise<Line> => runtime.next((line) => line['op'] === op && line['event'] !== 'accepted');

describe('teamai-runtime-t3', () => {
  useT3Runtime();

  describe('waking a fleet member', () => {
    // With them off, the wake itself says how to turn them on, when the person uses it.
    it('offers wake when T3 Code has linked environments, on or off in its Labs settings, and not when it has none', async () => {
      signIn(t3);
      t3.config({ links: [] });
      expect((await initialized()).reply['wake']).toBe(true);

      t3.config({ links: undefined });
      expect((await initialized()).reply['wake']).toBe(true);

      t3.config({ noLinkedEnvironments: true });
      expect((await initialized()).reply).not.toHaveProperty('wake');
    });

    it('offers no wake in recover mode', async () => {
      t3.config(LINKED);
      const runtime = start();
      runtime.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'recover', options: { environment: 'local' } });

      expect(await runtime.next((line) => line['type'] === 'init')).toEqual({ type: 'init', ok: true, can: {} });
    });

    // With no model set for the project there, the member starts on the first model of the first tool this runtime runs, Claude before Codex.
    it('launches the member on the first linked machine that answers and has the repository, with teamai\'s message and the end, delegated from the run\'s thread', async () => {
      signIn(t3);
      t3.config(LINKED);
      t3.addThread({ threadId: 'thread-owner-1', title: 'Ship the GPU pass', status: 'running' });
      const { runtime } = await initialized({ T3CODE_THREAD_ID: 'thread-owner-1' });

      runtime.send(wake('op-000000e1'));

      const end = await woke(runtime, 'op-000000e1');
      const member = t3.threads().find((thread) => thread.environmentId !== undefined);
      expect(end).toEqual({
        op: 'op-000000e1', event: 'woken', where: 'sams-laptop',
        display: { label: 'teamai fleet r7f3a91c2 · gpu', url: `t3code://threads/env-sam/${encodeURIComponent(member?.threadId ?? '')}`, fields: { thread: member?.threadId, environment: 'sams-laptop' } },
      });
      expect(member).toMatchObject({
        environmentId: 'env-sam', title: 'teamai fleet r7f3a91c2 · gpu', message: `Run teamai workflow resume --claim gpu, then report.\n\n${END_OF_WAKE}`,
        workspace: 'root', provider: 'claudeAgent', model: 'claude-opus-5-5', runtimeMode: 'auto',
        delegatedFrom: { environmentId: 'env-fake-1', threadId: 'thread-owner-1', title: 'Ship the GPU pass' },
      });
      expect(t3.calls().filter((call) => call.tool === 't3_thread_launch').map((call) => call.args['clientRequestId'])).toEqual(['op-000000e1']);
    });

    it('starts the member on the model the project there sets, and names the pool in a title that lacks it', async () => {
      signIn(t3);
      t3.config({ ...LINKED, environments: { ...LINKED.environments, 'env-sam': { projects: [{ ...acmeApp, defaultModelSelection: { instanceId: 'claudeAgent', model: 'claude-sonnet-5-5' } }], providers: [CODEX, CLAUDE] } } });
      const { runtime } = await initialized();

      runtime.send(wake('op-000000e2', { title: 'teamai fleet r7f3a91c2' }));

      expect(await woke(runtime, 'op-000000e2')).toMatchObject({ event: 'woken', where: 'sams-laptop' });
      expect(t3.threads().find((thread) => thread.environmentId !== undefined)).toMatchObject({ title: 'teamai fleet r7f3a91c2 · gpu', provider: 'claudeAgent', model: 'claude-sonnet-5-5' });
    });

    // A woken member runs on another machine, which the run's definition grants no full access.
    it('launches the member in Auto when runtime_mode is full-access, never in full access', async () => {
      signIn(t3, undefined, undefined, 'orchestration:read orchestration:operate settings:write source-control:write');
      t3.config(LINKED);
      const { runtime } = await initialized({}, { runtime_mode: 'full-access' });

      runtime.send(wake('op-000000e7'));

      expect(await woke(runtime, 'op-000000e7')).toMatchObject({ event: 'woken' });
      expect(t3.threads().find((thread) => thread.environmentId !== undefined)).toMatchObject({ runtimeMode: 'auto', message: `Run teamai workflow resume --claim gpu, then report.\n\n${END_OF_WAKE}` });
    });

    // In Auto, T3 runs teamai's command without asking; a stricter mode asks first, with nobody there to answer.
    it.each([
      { mode: 'approval-required', label: 'Supervised' },
      { mode: 'auto-accept-edits', label: 'Auto-accept edits' },
    ])('keeps runtime_mode $mode, and starts the message with what to approve', async ({ mode, label }) => {
      signIn(t3);
      t3.config(LINKED);
      const { runtime } = await initialized({}, { runtime_mode: mode });

      runtime.send(wake('op-000000e8'));

      expect(await woke(runtime, 'op-000000e8')).toMatchObject({ event: 'woken' });
      expect(t3.threads().find((thread) => thread.environmentId !== undefined)).toMatchObject({
        runtimeMode: mode,
        message: `This thread runs in ${label} mode, so it asks before it runs teamai's command below: approve that command, or allow it on this machine with the permission rule Bash(teamai workflow resume:*) in this checkout's .claude/settings.local.json.\n\nRun teamai workflow resume --claim gpu, then report.\n\n${END_OF_WAKE}`,
      });
      // The rule it names is the one the command teamai sends derives: Claude's prefix rule on WAKE_COMMAND.
      expect(t3.threads().find((thread) => thread.environmentId !== undefined)?.message).toContain(`permission rule Bash(${WAKE_COMMAND}:*) in`);
    });

    // Codex runs teamai's command in its sandbox in every mode, with no network and no write to ~/.teamai, unless it asks
    // to run it outside; it asks the person only for that (codex-cli 0.167.0 on T3 Code, Auto and Supervised).
    it.each([
      { runtimeMode: undefined, launched: 'auto' },
      { runtimeMode: 'approval-required', launched: 'approval-required' },
      { runtimeMode: 'auto-accept-edits', launched: 'auto-accept-edits' },
    ])('tells a Codex member to run the command outside its sandbox, and the person to approve it, in mode $launched', async ({ runtimeMode, launched }) => {
      signIn(t3);
      t3.config({ ...LINKED, environments: { ...LINKED.environments, 'env-sam': { projects: [{ ...acmeApp, defaultModelSelection: { instanceId: 'codex', model: 'gpt-6.1-sol' } }], providers: [CODEX, CLAUDE] } } });
      const { runtime } = await initialized({}, runtimeMode === undefined ? {} : { runtime_mode: runtimeMode });

      runtime.send(wake('op-000000e9'));

      expect(await woke(runtime, 'op-000000e9')).toMatchObject({ event: 'woken' });
      const member = t3.threads().find((thread) => thread.environmentId !== undefined);
      expect(member).toMatchObject({
        provider: 'codex', runtimeMode: launched,
        message: `teamai woke this agent to take one attempt of the fleet pool gpu. Run \`teamai workflow resume\` below with escalated permissions, outside the sandbox: it needs the network and writes ~/.teamai, which the sandbox blocks. Whoever watches this agent: approve that command when Codex asks, or the attempt waits here.\n\nRun teamai workflow resume --claim gpu, then report.\n\n${END_OF_WAKE}`,
      });
      expect(member?.message).toContain(`Run \`${WAKE_COMMAND}\` below with escalated permissions`);
    });

    it('tells a Codex member to run the command outside its sandbox when the machine lists no provider for the project\'s default', async () => {
      signIn(t3);
      t3.config({ ...LINKED, environments: { ...LINKED.environments, 'env-sam': { projects: [{ ...acmeApp, defaultModelSelection: { instanceId: 'codex', model: 'gpt-6.1-sol' } }], providers: [] } } });
      const { runtime } = await initialized({}, { runtime_mode: 'approval-required' });

      runtime.send(wake('op-000000ea'));

      expect(await woke(runtime, 'op-000000ea')).toMatchObject({ event: 'woken' });
      expect(t3.threads().find((thread) => thread.environmentId !== undefined)?.message).toMatch(/^teamai woke this agent to take one attempt of the fleet pool gpu\. Run `teamai workflow resume` below with escalated permissions, outside the sandbox/);
    });

    it('fails wake_unavailable, naming each machine it looked at and what to add, when no linked machine has the repository', async () => {
      signIn(t3);
      t3.config({ ...LINKED, environments: { 'env-other': LINKED.environments?.['env-other'] ?? { projects: [], providers: [] } } });
      const { runtime } = await initialized();

      runtime.send(wake('op-000000e3'));

      expect(await woke(runtime, 'op-000000e3')).toEqual({
        op: 'op-000000e3', event: 'failed',
        failure: { code: 'wake_unavailable', message: `No machine linked to T3 Code has ${REPOSITORY} as a project (old-mac is unreachable; build-box has no project of it; sams-laptop has no project of it). Link a machine in T3 Code, and add the repository there as a project.` },
      });
      expect(t3.calls().filter((call) => call.tool === 't3_thread_launch')).toEqual([]);
    });

    it('fails wake_unavailable, naming the fix, when T3 Code has linked environments off', async () => {
      signIn(t3);
      const { runtime } = await initialized();

      runtime.send(wake('op-000000e4'));

      expect(await woke(runtime, 'op-000000e4')).toEqual({
        op: 'op-000000e4', event: 'failed',
        failure: { code: 'wake_unavailable', message: 'Linked environments is off in T3 Code, so it reaches no other machine. Turn on Linked environments in T3 Code\'s Labs settings, link the machine, and add the repository there as a project.' },
      });
    });

    it('says the member may have launched, and to check that machine\'s thread list before waking again, when the launch\'s reply is lost', async () => {
      signIn(t3);
      t3.config({ ...LINKED, agent: { hold: true, output: {} }, launchReplyLost: true });
      const { runtime } = await initialized();

      runtime.send(wake('op-000000f1'));

      expect(await woke(runtime, 'op-000000f1')).toEqual({
        op: 'op-000000f1', event: 'failed',
        failure: { code: 'wake_unavailable', message: 'T3 Code may have launched the member on sams-laptop before the call failed: MCP error -32603: The connection closed before T3 answered. Check the thread list of sams-laptop in T3 Code for "teamai fleet r7f3a91c2 · gpu" before waking again.' },
      });
    });

    it('says T3 Code did not launch the member when a check a new launch runs refused it', async () => {
      signIn(t3);
      t3.config({ ...LINKED, launchInvalid: true });
      const { runtime } = await initialized();

      runtime.send(wake('op-000000f2'));

      expect(await woke(runtime, 'op-000000f2')).toMatchObject({
        op: 'op-000000f2', event: 'failed',
        failure: { code: 'wake_unavailable', message: expect.stringMatching(/^T3 Code did not launch the member on the linked machine: .*is not a worktree of project/) },
      });
    });

    it('launches one member for an op teamai sends twice, and answers both with it', async () => {
      signIn(t3);
      t3.config({ ...LINKED, launchMs: 300 });
      const { runtime } = await initialized();

      runtime.send(wake('op-000000e5'));
      runtime.send(wake('op-000000e5'));
      const first = await woke(runtime, 'op-000000e5');
      runtime.send(wake('op-000000e5'));
      await runtime.next((line) => line['op'] === 'op-000000e5' && line['event'] === 'woken' && runtime.lines.filter((one) => one['event'] === 'woken').length === 2);

      expect(first).toMatchObject({ event: 'woken', where: 'sams-laptop' });
      expect(t3.calls().filter((call) => call.tool === 't3_thread_launch')).toHaveLength(1);
      expect(t3.threads().filter((thread) => thread.environmentId !== undefined)).toHaveLength(1);
    });

    it('ends a wake cancelled before its launch went out, and launches nothing', async () => {
      signIn(t3);
      t3.config({ ...LINKED, projectsMs: 1_000 });
      const { runtime } = await initialized();
      runtime.send(wake('op-000000e6'));
      await runtime.next((line) => line['op'] === 'op-000000e6' && line['event'] === 'accepted');

      runtime.send({ type: 'cancel', op: 'op-000000e6' });

      expect(await woke(runtime, 'op-000000e6')).toEqual({ op: 'op-000000e6', event: 'cancelled' });
      await new Promise((resolve) => setTimeout(resolve, 3_500));
      expect(runtime.lines.filter((line) => line['op'] === 'op-000000e6').map((line) => line['event'])).toEqual(['accepted', 'cancelled']);
      expect(t3.calls().filter((call) => call.tool === 't3_thread_launch')).toEqual([]);
    });

    it('answers a second cancel of a wake it cancelled once, while that wake still looks for a machine', async () => {
      signIn(t3);
      t3.config({ ...LINKED, projectsMs: 1_000 });
      const { runtime } = await initialized();
      runtime.send(wake('op-000000e7'));
      await runtime.next((line) => line['op'] === 'op-000000e7' && line['event'] === 'accepted');
      runtime.send({ type: 'cancel', op: 'op-000000e7' });
      await woke(runtime, 'op-000000e7');

      runtime.send({ type: 'cancel', op: 'op-000000e7' });

      await new Promise((resolve) => setTimeout(resolve, 3_500));
      expect(runtime.lines.filter((line) => line['op'] === 'op-000000e7').map((line) => line['event'])).toEqual(['accepted', 'cancelled', 'cancelled']);
      expect(t3.calls().filter((call) => call.tool === 't3_thread_launch')).toEqual([]);
    });

    it('keeps a wake cancelled while it read the machine\'s providers cancelled, when that machine turns out to have none', async () => {
      signIn(t3);
      t3.config({
        links: [{ environmentId: 'env-sam', label: 'sams-laptop', status: 'reachable' }],
        environments: { 'env-sam': { projects: [acmeApp], providers: [] } },
        providersMs: 1_000,
      });
      const { runtime } = await initialized();
      runtime.send(wake('op-000000e8'));
      await runtime.next((line) => line['op'] === 'op-000000e8' && line['event'] === 'accepted');
      await new Promise((resolve) => setTimeout(resolve, 300));

      runtime.send({ type: 'cancel', op: 'op-000000e8' });

      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(runtime.lines.filter((line) => line['op'] === 'op-000000e8').map((line) => line['event'])).toEqual(['accepted', 'cancelled']);
    });
  });
});
