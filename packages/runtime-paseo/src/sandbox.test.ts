import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { serveAttemptSocket, writeFakeWrapper, type FakeAttemptSocket } from './testing/attempt-socket.js';
import { dir, daemonState, behave, received, start, isOp, isEnd, ready, openRequest, promptRequest, createdAgent, useRuntimeSuite } from './testing/suite.js';

describe('teamai-runtime-paseo', () => {
  useRuntimeSuite();

  let attempt: FakeAttemptSocket | undefined;

  afterEach(async () => {
    await attempt?.close();
    attempt = undefined;
  });

  /** A runtime whose PATH finds a stand-in `teamai-sandbox-claude` that asks `attempt`'s socket. */
  const startThrough = (served: FakeAttemptSocket) => {
    const bin = path.join(dir, 'bin');
    const wrapper = writeFakeWrapper({ bin, tool: 'claude', socket: served.socket });

    return { runtime: start({ PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` }), wrapper };
  };

  /** Opens the place through the sandbox, with the attempt's tool home, and waits for the open to end. */
  const openThrough = async (runtime: ReturnType<typeof start>, served: FakeAttemptSocket, { tool = 'claude' }: { tool?: string } = {}) => {
    const toolHome = path.join(dir, 'attempt-home', '.claude');
    const request = openRequest('op-0000000a', 'a0123abcd', tool);
    runtime.send({ ...request, outer: served.handle, view: { ...request.view, toolHome: { CLAUDE_CONFIG_DIR: toolHome } } });
    const accepted = await runtime.next(isOp('op-0000000a', 'accepted'));
    const end = await runtime.next((line) => isOp('op-0000000a', 'ready')(line) || isOp('op-0000000a', 'failed')(line));

    return { handle: 'handle' in accepted ? String(accepted.handle) : '', end, toolHome };
  };

  const startedTools = (): unknown[] => {
    const file = path.join(daemonState, 'started.jsonl');

    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
  };

  it('runs a step through the sandbox: its agent starts on teamai-sandbox-claude with no prompt, gets the prompt once the wrapper connected, and names the attempt\'s tool home as its session\'s', async () => {
    behave({ output: { verdict: 'approve' } });
    attempt = await serveAttemptSocket();
    const { runtime, wrapper } = startThrough(attempt);
    await ready(runtime);
    const { handle, end, toolHome } = await openThrough(runtime, attempt);

    expect(end).toMatchObject({ event: 'ready' });
    const notice = runtime.lines.find(isOp('op-0000000a', 'notice'));
    runtime.send(promptRequest(handle, 'op-0000000b'));
    const finished = await runtime.next(isEnd('op-0000000b'));
    const agentId = createdAgent('op-0000000b');

    expect(notice).toMatchObject({ message: expect.stringContaining(`teamai added the Paseo provider teamai-sandbox-claude to the daemon at`) });
    expect(finished).toMatchObject({ event: 'finished', result: { output: { verdict: 'approve' } }, session: { tool: 'claude', home: toolHome } });
    expect(received().filter((request) => request.type === 'set_daemon_config_request')).toMatchObject([
      { config: { providers: { 'teamai-sandbox-claude': { extends: 'claude', label: 'teamai-sandbox-claude', command: [wrapper] } } } },
    ]);
    const create = received().find((request) => request.type === 'agent.create.request');
    expect(create).toMatchObject({ config: { provider: 'teamai-sandbox-claude' } });
    expect(create).not.toHaveProperty('initialPrompt');
    expect(received().filter((request) => ['list_commands_request', 'send_agent_message_request'].includes(request.type))).toMatchObject([
      { type: 'list_commands_request', agentId },
      { type: 'send_agent_message_request', agentId, text: expect.stringContaining('Review the change.') },
    ]);
    expect(attempt.lines).toEqual([{ register: { agent: agentId } }, { ask: { tool: 'claude', agent: agentId, cwd: expect.any(String) } }]);
    expect(startedTools()).toEqual([{ agentId, command: [wrapper] }]);
  });

  it('never sends the prompt to an agent whose wrapper the sandbox refused: it removes the agent and fails the step isolation_unproven', async () => {
    behave({ output: { verdict: 'approve' } });
    attempt = await serveAttemptSocket({ grants: false });
    const { runtime } = startThrough(attempt);
    await ready(runtime);
    const { handle } = await openThrough(runtime, attempt);
    runtime.send(promptRequest(handle, 'op-0000000b'));
    const failed = await runtime.next(isEnd('op-0000000b'));
    const agentId = createdAgent('op-0000000b');

    expect(failed).toMatchObject({ event: 'failed', failure: { code: 'isolation_unproven', message: expect.stringContaining(`teamai-sandbox-claude exited with code 2`) } });
    expect(received().map((request) => request.type)).not.toContain('send_agent_message_request');
    expect(received().filter((request) => request.type === 'delete_agent_request')).toMatchObject([{ agentId }]);
  });

  it('sends no prompt, removes the agent and fails the step naming what it could not journal, when it cannot journal the prompt as sent once the wrapper connected', async () => {
    behave({ output: { verdict: 'approve' } });
    const granted = path.join(dir, 'grant');
    attempt = await serveAttemptSocket({ holdUntil: granted });
    const { runtime } = startThrough(attempt);
    await ready(runtime);
    const { handle } = await openThrough(runtime, attempt);
    runtime.send(promptRequest(handle, 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'display'));
    const ops = path.join(dir, 'home', '.teamai', 'runtime-state', 'paseo', 'ops');
    fs.chmodSync(ops, 0o500);

    try {
      fs.writeFileSync(granted, '');
      const failed = await runtime.next(isEnd('op-0000000b'));
      const agentId = createdAgent('op-0000000b');

      expect(failed).toMatchObject({
        event: 'failed',
        failure: { code: 'tool_failed', message: expect.stringMatching(new RegExp(`^teamai-runtime-paseo could not journal that it sends the prompt to the claude agent ${agentId} \\(EACCES: .*\\), so it sent none, and removed the agent\\. Make the folder of the file it names writable, then run the step again\\.$`)) },
      });
      expect(received().map((request) => request.type)).not.toContain('send_agent_message_request');
      expect(received().filter((request) => request.type === 'delete_agent_request')).toMatchObject([{ agentId }]);
    } finally {
      fs.chmodSync(ops, 0o700);
    }
  });

  it('registers the agent again from a runtime started after this one was killed, so the sandbox serves its wrapper when Paseo starts it again', async () => {
    const release = path.join(dir, 'release');
    behave({ release, output: { verdict: 'approve' } });
    attempt = await serveAttemptSocket();
    const first = startThrough(attempt).runtime;
    await ready(first);
    const { handle } = await openThrough(first, attempt);
    first.send(promptRequest(handle, 'op-0000000b'));
    await expect.poll(() => received().some((request) => request.type === 'send_agent_message_request')).toBe(true);
    await first.kill();
    const agentId = createdAgent('op-0000000b');

    const second = startThrough(attempt).runtime;
    await ready(second);
    second.send({ type: 'reattach', handle });
    await second.next((line) => 'event' in line && line.event === 'alive');
    second.send(promptRequest(handle, 'op-0000000b'));
    await expect.poll(() => attempt?.lines.filter((line) => 'register' in line)).toEqual([{ register: { agent: agentId } }, { register: { agent: agentId } }]);
    fs.writeFileSync(release, '');

    expect(await second.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished' });
    expect(received().filter((request) => request.type === 'send_agent_message_request')).toHaveLength(1);
  });

  it('never sends the prompt once a cancel from another runtime stopped the agent while its wrapper waited for the sandbox, and leaves no agent behind', async () => {
    behave({ output: { verdict: 'approve' } });
    const grant = path.join(dir, 'grant');
    attempt = await serveAttemptSocket({ holdUntil: grant });
    const { runtime } = startThrough(attempt);
    await ready(runtime);
    const { handle } = await openThrough(runtime, attempt);
    runtime.send(promptRequest(handle, 'op-0000000b'));
    await expect.poll(() => attempt?.lines.some((line) => 'ask' in line)).toBe(true);

    // `teamai workflow cancel` reaches the prompt through a runtime of its own, which finds the agent idle.
    const canceller = start();
    await ready(canceller, { mode: 'recover' });
    canceller.send({ type: 'cancel', op: 'op-0000000b' });
    expect(await canceller.next(isEnd('op-0000000b'))).toEqual({ op: 'op-0000000b', event: 'cancelled' });
    fs.writeFileSync(grant, '');

    expect(await runtime.next(isEnd('op-0000000b'))).toEqual({ op: 'op-0000000b', event: 'cancelled' });
    expect(received().map((request) => request.type)).not.toContain('send_agent_message_request');
    await expect.poll(() => received().filter((request) => request.type === 'delete_agent_request')).toMatchObject([{ agentId: createdAgent('op-0000000b') }]);
  });

  it('refuses to open a place through a sandbox that serves no attempt socket, as seatbelt\'s plain handle, naming those that do, and adds no provider', async () => {
    attempt = await serveAttemptSocket();
    const { runtime } = startThrough(attempt);
    await ready(runtime);
    const request = openRequest('op-0000000a', 'a0123abcd', 'claude');
    runtime.send({ ...request, outer: 'teamai-r0123abcd-a0123abcd' });
    await runtime.next(isOp('op-0000000a', 'accepted'));

    expect(await runtime.next((line) => isOp('op-0000000a', 'ready')(line) || isOp('op-0000000a', 'failed')(line))).toMatchObject({
      event: 'failed',
      failure: { code: 'open_failed', message: 'Runtime paseo runs a tool through another runtime only on that runtime\'s attempt socket, and teamai could not register this step\'s tool on it (its handle names no attempt socket), so the sandbox would refuse the tool. Run Paseo through a sandbox provider that serves one: sbx, or docker 26.0.0 or later (25.0.5, 23.0.11) on Docker Desktop or on this Linux machine, on an image that holds node.' },
    });
    expect(received().map((crossed) => crossed.type)).not.toContain('set_daemon_config_request');
  });

  it('refuses to open an OpenCode place through the sandbox, since Paseo may serve several agents from one OpenCode server', async () => {
    attempt = await serveAttemptSocket();
    const { runtime } = startThrough(attempt);
    await ready(runtime);
    const { end } = await openThrough(runtime, attempt, { tool: 'opencode' });

    expect(end).toMatchObject({ event: 'failed', failure: { code: 'tool_unavailable', message: expect.stringContaining('OpenCode') } });
    expect(received().map((request) => request.type)).not.toContain('set_daemon_config_request');
  });
});
