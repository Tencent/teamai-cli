import fs from 'node:fs';
import path from 'node:path';
import { WAKE_COMMAND, type WakeRequestSchema } from '@teamai/runtime-protocol';
import { z } from 'zod';
import { describe, expect, it, onTestFinished } from 'vitest';
import { startFakeDaemon, type Behaviour } from './testing/fake-daemon.js';
import type { RuntimeMessage } from '@teamai/runtime-protocol';
import { behave, dir, isEnd, isInit, isOp, ready, start, useRuntimeSuite } from './testing/suite.js';
import { END_OF_WAKE } from './wake.js';

const REPOSITORY = 'https://example.com/team/app.git';

/** A wake's end: woken, failed or cancelled. */
const isWakeEnd = (op: string) => (line: RuntimeMessage): boolean => isOp(op, 'woken')(line) || isEnd(op)(line);

/** A wake as the fleet owner sends one. */
const wakeRequest = (op: string): z.input<typeof WakeRequestSchema> => ({
  type: 'wake', op, pool: 'gpu', repository: REPOSITORY, message: 'teamai workflow resume --next --pool gpu', title: 'teamai: step review of run r0123abcd',
});

/** Another Paseo daemon, on a machine of the member's, with its own state: the one a saved host routes to. */
async function otherDaemon(name: string, behaviour: Behaviour = {}) {
  const state = path.join(dir, name);
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'behaviour.json'), JSON.stringify(behaviour));
  const running = await startFakeDaemon({ state, port: 0 });
  onTestFinished(() => running.close());

  const creates = (): Array<z.infer<typeof CreateSchema>> => {
    const file = path.join(state, 'requests.jsonl');

    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((request) => request.type === 'agent.create.request').map((request) => CreateSchema.parse(request)) : [];
  };

  return { url: running.url, creates };
}

const CreateSchema = z.looseObject({ agentId: z.string(), initialPrompt: z.string(), config: z.looseObject({ provider: z.string(), cwd: z.string(), title: z.string(), providerOptions: z.unknown().optional() }) });

/** A checkout of the repository on another machine, opened in its Paseo. */
const checkout = (name: string): { member_workspaces: string[]; repositories: Record<string, string> } => {
  const at = path.join(dir, name, 'app');
  fs.mkdirSync(at, { recursive: true });

  return { member_workspaces: [at], repositories: { [at]: REPOSITORY } };
};

describe('waking a fleet member through another Paseo daemon', () => {
  useRuntimeSuite();

  it('offers wake when its daemon routes to saved hosts, and never in recover mode', async () => {
    expect(await ready(start())).toMatchObject({ type: 'init', ok: true, wake: true });
    expect(await ready(start(), { mode: 'recover' })).toEqual({ type: 'init', ok: true, can: {} });
  });

  it('offers no wake on a daemon that does not route to saved hosts', async () => {
    behave({ missing: ['connectedHosts'] });

    expect(await ready(start())).not.toHaveProperty('wake');
  });

  it('keeps the title of a wake that already names its pool, as the fleet owner writes it', async () => {
    const gpu = await otherDaemon('gpu', { server_id: 'srv_gpu', ...checkout('gpu') });
    behave({ hosts: [{ label: 'gpu-box', server_id: 'srv_gpu', url: gpu.url }] });
    const runtime = start();
    await ready(runtime);

    runtime.send({ ...wakeRequest('op-000000ef'), title: 'teamai: step review of run r0123abcd, fleet pool gpu' });

    await runtime.next(isWakeEnd('op-000000ef'));
    expect(gpu.creates()).toMatchObject([{ config: { title: 'teamai: step review of run r0123abcd, fleet pool gpu' } }]);
  });

  it('starts an agent on the first saved host that answers and has a workspace of the repository, titled with the run and pool, and told to end', async () => {
    const bare = await otherDaemon('bare', { server_id: 'srv_bare' });
    const gpu = await otherDaemon('gpu', { server_id: 'srv_gpu', ...checkout('gpu') });
    behave({ hosts: [{ label: 'lost-box', server_id: 'srv_lost', url: 'ws://127.0.0.1:9/ws', status: 'offline' }, { label: 'bare-box', server_id: 'srv_bare', url: bare.url }, { label: 'gpu-box', server_id: 'srv_gpu', url: gpu.url }] });
    const runtime = start();
    await ready(runtime);

    runtime.send(wakeRequest('op-000000ee'));

    const woken = await runtime.next(isWakeEnd('op-000000ee'));
    expect(bare.creates()).toEqual([]);
    const [create, ...more] = gpu.creates();
    expect(more).toEqual([]);
    expect(create).toMatchObject({ initialPrompt: `teamai workflow resume --next --pool gpu\n\n${END_OF_WAKE}`, config: { cwd: path.join(dir, 'gpu', 'app'), title: 'teamai: step review of run r0123abcd · gpu' } });
    // The first of teamai's tools the host runs, on its default model, which the client sends apart from the provider.
    expect(create?.config).toMatchObject({ provider: 'claude', model: 'claude-opus-5-5' });
    expect(woken).toEqual({
      op: 'op-000000ee', event: 'woken', where: 'gpu-box',
      display: { label: 'teamai: step review of run r0123abcd · gpu', url: expect.stringContaining(String(create?.agentId)), fields: { agent: create?.agentId, host: 'gpu-box' } },
    });
    expect(runtime.lines.filter(isOp('op-000000ee', 'accepted'))).toHaveLength(1);
  });

  it.each([
    // Each rule twice: as the tool writes it, and as derived from WAKE_COMMAND, the command teamai's message starts with.
    { tool: 'claude', allowed: { allowedTools: ['Bash(teamai workflow resume:*)'] }, derived: { allowedTools: [`Bash(${WAKE_COMMAND}:*)`] } },
    { tool: 'opencode', allowed: { permission: { bash: { 'teamai workflow resume *': 'allow' } } }, derived: { permission: { bash: { [`${WAKE_COMMAND} *`]: 'allow' } } } },
  ])('lets a woken $tool agent run teamai workflow resume without asking, in the mode Paseo starts it in', async ({ tool, allowed, derived }) => {
    const gpu = await otherDaemon('gpu', { server_id: 'srv_gpu', models: { [tool]: tool === 'claude' ? ['claude-opus-5-5'] : ['opencode/beam-free'] }, ...checkout('gpu') });
    behave({ hosts: [{ label: 'gpu-box', server_id: 'srv_gpu', url: gpu.url }] });
    const runtime = start();
    await ready(runtime);

    runtime.send(wakeRequest('op-000000ee'));

    expect(await runtime.next(isWakeEnd('op-000000ee'))).toMatchObject({ event: 'woken' });
    const [create] = gpu.creates();
    expect(create?.config).toMatchObject({ provider: tool, providerOptions: allowed });
    expect(create?.config.providerOptions).toEqual(derived);
    expect(create?.config).not.toHaveProperty('modeId');
    expect(create?.initialPrompt).toBe(`teamai workflow resume --next --pool gpu\n\n${END_OF_WAKE}`);
  });

  // Paseo's Codex modes ask for no single command: in its default, auto, Codex runs teamai's command in its sandbox, with
  // no network and no write to ~/.teamai, unless it asks to run it outside (codex-cli 0.167.0, Paseo 0.14.0 and 0.15.4).
  it('tells a woken Codex agent to run the command outside its sandbox, and the person to approve it when Codex asks', async () => {
    const gpu = await otherDaemon('gpu', { server_id: 'srv_gpu', models: { codex: ['gpt-6.1-sol'] }, ...checkout('gpu') });
    behave({ hosts: [{ label: 'gpu-box', server_id: 'srv_gpu', url: gpu.url }] });
    const runtime = start();
    await ready(runtime);

    runtime.send(wakeRequest('op-000000ee'));

    expect(await runtime.next(isWakeEnd('op-000000ee'))).toMatchObject({ event: 'woken' });
    const [create] = gpu.creates();
    expect(create?.config).toMatchObject({ provider: 'codex' });
    expect(create?.config.providerOptions).toBeUndefined();
    expect(create?.initialPrompt).toBe(`teamai woke this agent to take one attempt of the fleet pool gpu. Run \`teamai workflow resume\` below with escalated permissions, outside the sandbox: it needs the network and writes ~/.teamai, which the sandbox blocks. Whoever watches this agent: approve that command when Codex asks, or the attempt waits here.\n\nteamai workflow resume --next --pool gpu\n\n${END_OF_WAKE}`);
    expect(create?.initialPrompt).toContain(`Run \`${WAKE_COMMAND}\` below with escalated permissions`);
  });

  it('wakes once for a repeated op, answering it as it ended', async () => {
    const gpu = await otherDaemon('gpu', { server_id: 'srv_gpu', ...checkout('gpu') });
    behave({ hosts: [{ label: 'gpu-box', server_id: 'srv_gpu', url: gpu.url }] });
    const runtime = start();
    await ready(runtime);
    runtime.send(wakeRequest('op-000000ee'));
    const first = await runtime.next(isWakeEnd('op-000000ee'));

    runtime.send(wakeRequest('op-000000ee'));

    await runtime.next((line) => runtime.lines.filter(isWakeEnd('op-000000ee')).length === 2 && isWakeEnd('op-000000ee')(line));
    expect(runtime.lines.filter(isWakeEnd('op-000000ee'))).toEqual([first, first]);
    expect(gpu.creates()).toHaveLength(1);
  });

  it('fails wake_unavailable when no saved host has a workspace of the repository, saying what each one lacked and how to add one', async () => {
    const bare = await otherDaemon('bare', { server_id: 'srv_bare' });
    behave({ hosts: [{ label: 'lost-box', server_id: 'srv_lost', url: 'ws://127.0.0.1:9/ws', status: 'offline' }, { label: 'bare-box', server_id: 'srv_bare', url: bare.url }] });
    const runtime = start();
    await ready(runtime);

    runtime.send(wakeRequest('op-000000ee'));

    expect(await runtime.next(isWakeEnd('op-000000ee'))).toEqual({
      op: 'op-000000ee', event: 'failed',
      failure: {
        code: 'wake_unavailable',
        message: `No Paseo host saved on this machine has a workspace of ${REPOSITORY} (lost-box is offline; bare-box has no workspace of it). Add the machine with \`paseo host add <host:port>\`, and open a checkout of the repository in Paseo there.`,
      },
    });
    expect(bare.creates()).toEqual([]);
  });

  it('fails wake_unavailable naming `paseo host add` when the daemon has saved no host', async () => {
    const runtime = start();
    await ready(runtime);

    runtime.send(wakeRequest('op-000000ee'));

    expect(await runtime.next(isWakeEnd('op-000000ee'))).toEqual({
      op: 'op-000000ee', event: 'failed',
      failure: { code: 'wake_unavailable', message: `No Paseo host saved on this machine has a workspace of ${REPOSITORY}, since none is saved. Add the machine with \`paseo host add <host:port>\`, and open a checkout of the repository in Paseo there.` },
    });
  });

  it('ends a wake cancelled before it starts an agent, and starts none', async () => {
    const gpu = await otherDaemon('gpu', { server_id: 'srv_gpu', list_ms: 1500, ...checkout('gpu') });
    behave({ hosts: [{ label: 'gpu-box', server_id: 'srv_gpu', url: gpu.url }] });
    const runtime = start();
    await ready(runtime);
    runtime.send(wakeRequest('op-000000ee'));
    await runtime.next(isOp('op-000000ee', 'accepted'));

    runtime.send({ type: 'cancel', op: 'op-000000ee' });

    expect(await runtime.next(isWakeEnd('op-000000ee'))).toEqual({ op: 'op-000000ee', event: 'cancelled' });
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(gpu.creates()).toEqual([]);
    expect(runtime.lines.filter(isWakeEnd('op-000000ee'))).toHaveLength(1);
    expect(runtime.lines.filter(isInit)).toHaveLength(1);
  });
});
