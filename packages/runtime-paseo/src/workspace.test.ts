import fs from 'node:fs';
import path from 'node:path';
import type { RuntimeMessage } from '@teamai/runtime-protocol';
import { describe, expect, it } from 'vitest';
import { type Behaviour } from './testing/fake-daemon.js';
import { restartDaemon, createdAgent, dir, worktree, daemonState, daemon, RUN, ATTEMPT, behave, received, stopped, start, isOp, isEnd, ready, openRequest, opened, journalFiles, agentsOf, mayStartMessage, delay, until, worktreeWorkspace, promptRequest, useRuntimeSuite } from './testing/suite.js';

describe('teamai-runtime-paseo', () => {
  useRuntimeSuite();

  it('answers a close whose archive Paseo does not answer close_failed within 10 s, and keeps the attempt to close again', async () => {
    behave({ archive_ms: 30_000 });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    const workspace = worktreeWorkspace();
    const asked = Date.now();

    runtime.send({ type: 'close', handle });

    expect(await runtime.next((line) => 'event' in line && !('op' in line) && ['closed', 'close_failed'].includes(line.event))).toEqual({
      event: 'close_failed', handle,
      failure: { code: 'close_failed', message: `Paseo did not answer the archive of workspace worktree (${String(workspace)}) within 10 s. Its agents may still run; archive it in the Paseo app.` },
    });
    expect(Date.now() - asked).toBeLessThan(12_000);
    runtime.send({ type: 'reattach', handle });
    expect(await runtime.next((line) => 'event' in line && line.event === 'alive')).toMatchObject({ event: 'alive', handle });
  }, 40_000);

  it('keeps an attempt whose refused create may still start its agent, after a restart too, and closes it once Paseo shows the agent', async () => {
    behave({ hold_ms: 60_000, output: { ok: true }, create_ms: 8_000, refuse_create_early: 'Connection reset before the create was answered' });
    const first = start();
    await ready(first, { mode: 'attended' });
    const handle = await opened(first);
    first.send(promptRequest(handle, 'op-0000000b'));
    expect(await first.next(isEnd('op-0000000b'))).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed' } });
    const agentId = createdAgent('op-0000000b');
    const isCloseAnswer = (line: RuntimeMessage): boolean => 'event' in line && !('op' in line) && ['closed', 'close_failed'].includes(line.event);
    const mayStart = {
      event: 'close_failed', handle,
      failure: {
        code: 'close_failed',
        message: mayStartMessage(agentId),
      },
    };

    first.send({ type: 'close', handle });

    expect(await first.next(isCloseAnswer)).toEqual(mayStart);
    await first.kill();
    const recovering = start();
    await ready(recovering, { mode: 'recover' });
    recovering.send({ type: 'close', handle });
    expect(await recovering.next(isCloseAnswer)).toEqual(mayStart);
    expect(received().map((request) => request.type)).toEqual(['agent.create.request']);

    // The create lands: the next close stops the agent it started.
    await expect.poll(agentsOf, { timeout: 15_000 }).toEqual([agentId]);
    recovering.send({ type: 'close', handle });
    expect(await recovering.next(isCloseAnswer)).toEqual({ event: 'closed', handle });
    const kept = JSON.parse(fs.readFileSync(path.join(daemonState, 'agents.json'), 'utf8')) as { agents: Record<string, { status: string }> };
    expect(Object.values(kept.agents).filter((agent) => agent.status === 'running')).toEqual([]);
    expect(journalFiles()).toEqual([]);
  }, 40_000);

  it('keeps an attempt whose refused create never starts its agent, naming how to release it, and closes it once its record is gone', async () => {
    behave({ hold_ms: 60_000, output: { ok: true }, create_ms: 60_000, refuse_create_early: 'Connection reset before the create was answered' });
    const runtime = start();
    await ready(runtime, { mode: 'attended' });
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b'));
    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed' } });
    const isCloseAnswer = (line: RuntimeMessage): boolean => 'event' in line && !('op' in line) && ['closed', 'close_failed'].includes(line.event);
    runtime.send({ type: 'close', handle });
    expect(await runtime.next(isCloseAnswer)).toEqual({ event: 'close_failed', handle, failure: { code: 'close_failed', message: mayStartMessage(createdAgent('op-0000000b')) } });

    // A record gone, as a person removed it before releases existed, no longer keeps the attempt.
    fs.rmSync(path.join(dir, 'home', '.teamai', 'runtime-state', 'paseo', 'ops', 'op-0000000b.json'));
    runtime.send({ type: 'close', handle });

    expect(await runtime.next(isCloseAnswer)).toEqual({ event: 'closed', handle });
    expect(journalFiles()).toEqual([]);
    expect(agentsOf()).toEqual([]);
  });

  it('closes an attempt whose prompt waits for its models, ending the prompt cancelled first, and creates no agent after', async () => {
    behave({ output: { ok: true }, models_ms: 3_000 });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'accepted'));

    runtime.send({ type: 'close', handle });

    expect(await runtime.next((line) => 'event' in line && !('op' in line) && ['closed', 'close_failed'].includes(line.event))).toEqual({ event: 'closed', handle });
    const events = runtime.lines.map((line) => ('event' in line ? `${'op' in line ? line.op : 'handle'} ${line.event}` : ''));
    expect(events.indexOf('op-0000000b cancelled')).toBeGreaterThan(-1);
    expect(events.indexOf('op-0000000b cancelled')).toBeLessThan(events.indexOf('handle closed'));
    await delay(4_000);
    expect(received().map((request) => request.type)).toEqual(['archive_workspace_request']);
    expect(agentsOf()).toEqual([]);
    expect(journalFiles()).toEqual([]);
  });

  it('says the attempt closed only once the agents of its archived workspace stopped running', async () => {
    behave({ hold_ms: 60_000, output: { ok: true }, stop_lag_ms: 1_500 });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'display'));

    runtime.send({ type: 'close', handle });

    expect(await runtime.next((line) => 'event' in line && ['closed', 'close_failed'].includes(line.event))).toEqual({ event: 'closed', handle });
    expect(stopped()).toEqual([{ agentId: String(received()[0]?.agentId), status: 'closed' }]);
  });

  it.each([
    ['while Paseo creates its agent', 'create', 0],
    ['while its agent waits on a permission nobody answered', 'display', 0],
    // The archive stops the agent at once, and Paseo shows that only 2.5 s later: the prompt's own wait, which looks at the
    // permission each second, sees the agent stop first.
    ['while its agent waits on a permission nobody answered, though Paseo is slow to show the agent stopped', 'display', 2_500],
  ] as const)('ends a prompt cancelled, once, before its place closes %s', async (_, reached, fetchMs) => {
    behave({ create_ms: 1_000, ask_permission: true, hold_ms: 60_000, archive_ms: 100 });
    const runtime = start();
    await ready(runtime, { mode: 'attended' });
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b'));

    if (reached === 'create') await expect.poll(() => received().map((request) => request.type)).toEqual(['agent.create.request']);
    else await runtime.next(isOp('op-0000000b', 'display'));

    behave({ create_ms: 1_000, ask_permission: true, hold_ms: 60_000, archive_ms: 100, fetch_ms: fetchMs });
    runtime.send({ type: 'close', handle });

    expect(await runtime.next((line) => 'event' in line && !('op' in line) && ['closed', 'close_failed'].includes(line.event))).toEqual({ event: 'closed', handle });
    await delay(2_000);
    expect(runtime.lines.filter(isEnd('op-0000000b'))).toEqual([{ op: 'op-0000000b', event: 'cancelled' }]);
    const events = runtime.lines.map((line) => ('event' in line ? `${'op' in line ? line.op : 'handle'} ${line.event}` : ''));
    expect(events.indexOf('op-0000000b cancelled')).toBeLessThan(events.indexOf('handle closed'));
    expect(journalFiles()).toEqual([]);
  });

  it('archives the Paseo workspace when teamai closes the attempt, and keeps nothing of it', async () => {
    behave({ output: { ok: true } });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b'));
    await runtime.next(isEnd('op-0000000b'));
    const workspace = worktreeWorkspace();

    runtime.send({ type: 'close', handle });

    expect(await runtime.next((line) => 'event' in line && ['closed', 'close_failed'].includes(line.event))).toEqual({ event: 'closed', handle });
    expect(received().filter((request) => request.type === 'archive_workspace_request')).toMatchObject([{ workspaceId: workspace }]);
    runtime.send({ type: 'reattach', handle });
    expect(await runtime.next((line) => 'event' in line && line.event === 'gone')).toEqual({ event: 'gone', handle });
  });

  it('never archives a workspace the member had open in Paseo on that directory before teamai opened it, as on their checkout for a read-only step, stops only its own agents, and names them as left there', async () => {
    // The member works in this directory in Paseo, as in their own checkout, which a read-only step runs in.
    behave({ output: { ok: true }, member_workspaces: [worktree] });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    const workspace = worktreeWorkspace();
    runtime.send(promptRequest(handle, 'op-0000000b'));
    await runtime.next(isEnd('op-0000000b'));

    runtime.send({ type: 'close', handle });

    expect(await runtime.next((line) => 'event' in line && ['closed', 'close_failed'].includes(line.event))).toEqual({ event: 'closed', handle, kept: [`Paseo agent ${createdAgent('op-0000000b')}`] });
    expect(received().filter((request) => request.type === 'archive_workspace_request')).toEqual([]);
    // The member's workspace stays open in Paseo, on the same id.
    expect(worktreeWorkspace()).toBe(workspace);
  });

  it('never archives its workspace once the member works there too, as when they open the same checkout in Paseo during a read-only step, stops only its own agents, and names them as left there', async () => {
    behave({ output: { ok: true }, member_joins: true });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b'));
    await runtime.next(isEnd('op-0000000b'));

    runtime.send({ type: 'close', handle });

    expect(await runtime.next((line) => 'event' in line && ['closed', 'close_failed'].includes(line.event))).toEqual({ event: 'closed', handle, kept: [`Paseo agent ${createdAgent('op-0000000b')}`] });
    expect(received().filter((request) => request.type === 'archive_workspace_request')).toEqual([]);
    const kept = JSON.parse(fs.readFileSync(path.join(daemonState, 'agents.json'), 'utf8')) as { agents: Record<string, { title: string | null; status: string }> };
    expect(Object.values(kept.agents).filter((agent) => agent.title === 'member').map((agent) => agent.status)).toEqual(['idle']);
  });

  it('archives a workspace once though a second attempt opens its directory while Paseo makes it for the first', async () => {
    behave({ output: { ok: true }, open_reply_ms: 1_500 });
    const runtime = start();
    await ready(runtime);
    runtime.send(openRequest('op-0000000a', ATTEMPT));
    const first = await runtime.next(isOp('op-0000000a', 'accepted'));
    await until(() => fs.existsSync(path.join(daemonState, 'agents.json')) && worktreeWorkspace() !== undefined);
    runtime.send(openRequest('op-0000000c', 'a4567cdef'));
    const second = await runtime.next(isOp('op-0000000c', 'accepted'));
    await runtime.next(isOp('op-0000000a', 'ready'));
    await runtime.next(isOp('op-0000000c', 'ready'));
    const workspace = worktreeWorkspace();

    for (const accepted of [first, second]) {
      const handle = 'handle' in accepted ? accepted.handle : undefined;
      runtime.send({ type: 'close', handle: String(handle) });
      expect(await runtime.next((line) => 'event' in line && ['closed', 'close_failed'].includes(line.event))).toEqual({ event: 'closed', handle });
    }

    expect(received().filter((request) => request.type === 'archive_workspace_request')).toMatchObject([{ workspaceId: workspace }]);
  });

  it('archives a workspace two attempts shared once the last of them closes, though each ran an agent there', async () => {
    behave({ output: { ok: true } });
    const runtime = start();
    await ready(runtime);
    const first = await opened(runtime);
    const second = await opened(runtime, { attempt: 'a4567cdef', op: 'op-0000000c' });
    const workspace = worktreeWorkspace();
    runtime.send(promptRequest(first, 'op-0000000b'));
    runtime.send(promptRequest(second, 'op-0000000d'));
    await runtime.next(isEnd('op-0000000b'));
    await runtime.next(isEnd('op-0000000d'));

    for (const handle of [first, second]) {
      runtime.send({ type: 'close', handle });
      expect(await runtime.next((line) => 'event' in line && ['closed', 'close_failed'].includes(line.event))).toEqual({ event: 'closed', handle });
    }

    expect(received().filter((request) => request.type === 'archive_workspace_request')).toMatchObject([{ workspaceId: workspace }]);
  });

  it('archives a workspace once though another runtime on the same journal opens its directory while Paseo makes it for this one', async () => {
    behave({ output: { ok: true }, open_reply_ms: 1_500 });
    const runtime = start();
    const other = start();
    await ready(runtime);
    await ready(other);
    runtime.send(openRequest('op-0000000a', ATTEMPT));
    const first = await runtime.next(isOp('op-0000000a', 'accepted'));
    await until(() => fs.existsSync(path.join(daemonState, 'agents.json')) && worktreeWorkspace() !== undefined);
    other.send(openRequest('op-0000000c', 'a4567cdef'));
    const second = await other.next(isOp('op-0000000c', 'accepted'));
    await runtime.next(isOp('op-0000000a', 'ready'));
    await other.next(isOp('op-0000000c', 'ready'));
    const workspace = worktreeWorkspace();

    for (const [owner, accepted] of [[runtime, first], [other, second]] as const) {
      const handle = 'handle' in accepted ? accepted.handle : undefined;
      owner.send({ type: 'close', handle: String(handle) });
      expect(await owner.next((line) => 'event' in line && ['closed', 'close_failed'].includes(line.event))).toEqual({ event: 'closed', handle });
    }

    expect(received().filter((request) => request.type === 'archive_workspace_request')).toMatchObject([{ workspaceId: workspace }]);
  });

  it('takes over the hold on a directory once it is a minute old, as one whose runtime hangs on a Paseo that never answers, or died with its pid in use since', async () => {
    behave({ output: { ok: true }, open_reply_ms: 60_000 });
    const stuck = start();
    const other = start();
    await ready(stuck);
    await ready(other);
    stuck.send(openRequest('op-0000000a', ATTEMPT));
    await stuck.next(isOp('op-0000000a', 'accepted'));
    await until(() => fs.existsSync(path.join(daemonState, 'agents.json')) && worktreeWorkspace() !== undefined);
    const holds = path.join(dir, 'home', '.teamai', 'runtime-state', 'paseo', 'opening');
    const aMinuteAgo = new Date(Date.now() - 61_000);

    for (const name of fs.readdirSync(holds)) fs.utimesSync(path.join(holds, name), aMinuteAgo, aMinuteAgo);
    other.send(openRequest('op-0000000c', 'a4567cdef'));

    expect(await other.next((line) => isOp('op-0000000c', 'ready')(line) || isOp('op-0000000c', 'failed')(line))).toMatchObject({ event: 'ready' });
  });

  it('archives the workspace an open made after taking over the hold of one still waiting for Paseo, whichever closes last', async () => {
    behave({ output: { ok: true }, list_ms: 4_000 });
    const stuck = start();
    const other = start();
    await ready(stuck);
    await ready(other);
    const stuckOpen = opened(stuck);
    const holds = path.join(dir, 'home', '.teamai', 'runtime-state', 'paseo', 'opening');
    await until(() => fs.existsSync(holds) && fs.readdirSync(holds).some((name) => !name.startsWith('.')));
    // Its question is with Paseo; the next one is answered at once.
    await delay(500);
    behave({ output: { ok: true } });
    const aMinuteAgo = new Date(Date.now() - 61_000);

    for (const name of fs.readdirSync(holds)) fs.utimesSync(path.join(holds, name), aMinuteAgo, aMinuteAgo);
    const taken = await opened(other, { attempt: 'a4567cdef', op: 'op-0000000c' });
    expect(other.lines.find(isOp('op-0000000c', 'ready'))).toBeDefined();
    const late = await stuckOpen;
    expect(stuck.lines.find(isOp('op-0000000a', 'ready'))).toBeDefined();
    const workspace = worktreeWorkspace();

    other.send({ type: 'close', handle: taken });
    expect(await other.next((line) => 'event' in line && ['closed', 'close_failed'].includes(line.event))).toMatchObject({ event: 'closed' });
    stuck.send({ type: 'close', handle: late });
    expect(await stuck.next((line) => 'event' in line && ['closed', 'close_failed'].includes(line.event))).toMatchObject({ event: 'closed' });

    expect(received().filter((request) => request.type === 'archive_workspace_request')).toMatchObject([{ workspaceId: workspace }]);
  });

  // Each case waits out the runtime's real 20 s limit on a question to Paseo, then opens again.
  it.each([
    ['whether a workspace is open on the worktree', { list_ms: 60_000 }, ''],
    ['the open of the worktree as a workspace', { open_ms: 60_000 }, '; if Paseo opens it later, archive that workspace in the Paseo app'],
  ] satisfies Array<[string, Behaviour, string]>)('fails an open whose question to Paseo, %s, gets no answer in 20 s, and lets the next open of the directory go on', async (_question, slow, later) => {
    behave(slow);
    const runtime = start();
    await ready(runtime);
    const asked = Date.now();
    runtime.send(openRequest('op-0000000a', ATTEMPT));

    expect(await runtime.next((line) => isOp('op-0000000a', 'ready')(line) || isOp('op-0000000a', 'failed')(line))).toEqual({
      op: 'op-0000000a', event: 'failed',
      failure: { code: 'workspace_failed', message: `Paseo could not open the worktree as a workspace: no answer in 20 s; check that its daemon answers with \`paseo ls\`, then run the step again${later}` },
    });
    expect(Date.now() - asked).toBeLessThan(30_000);

    behave({});
    await opened(runtime, { attempt: 'a4567cdef', op: 'op-0000000c' });
    expect(runtime.lines.find(isOp('op-0000000c', 'ready'))).toBeDefined();
  }, 60_000);

  it('fails an open it cannot journal before asking Paseo, and opens nothing there', async () => {
    const runtime = start();
    await ready(runtime);
    // A file where the journal keeps its opens in flight, so none can be written there.
    fs.mkdirSync(path.join(dir, 'home', '.teamai', 'runtime-state', 'paseo'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'home', '.teamai', 'runtime-state', 'paseo', 'opening'), '');
    runtime.send(openRequest('op-0000000a', ATTEMPT));

    expect(await runtime.next((line) => isOp('op-0000000a', 'ready')(line) || isOp('op-0000000a', 'failed')(line))).toMatchObject({
      event: 'failed', failure: { code: 'workspace_failed', message: expect.stringMatching(/^teamai-runtime-paseo could not journal its open of .+ before asking Paseo, so it opened nothing: /) },
    });
    expect(fs.existsSync(path.join(daemonState, 'agents.json')) ? worktreeWorkspace() : undefined).toBeUndefined();
  });

  it('archives the workspace a runtime made before it died mid-open, once a runtime started again opens the attempt', async () => {
    behave({ output: { ok: true }, open_reply_ms: 60_000 });
    const runtime = start();
    await ready(runtime);
    runtime.send(openRequest('op-0000000a', ATTEMPT));
    const accepted = await runtime.next(isOp('op-0000000a', 'accepted'));
    await until(() => fs.existsSync(path.join(daemonState, 'agents.json')) && worktreeWorkspace() !== undefined);
    await runtime.kill();
    const workspace = worktreeWorkspace();

    const again = start();
    await ready(again);
    again.send(openRequest('op-0000000c', ATTEMPT));
    expect(await again.next(isOp('op-0000000c', 'accepted'))).toMatchObject({ handle: 'handle' in accepted ? accepted.handle : undefined });
    expect(await again.next((line) => isOp('op-0000000c', 'ready')(line) || isOp('op-0000000c', 'failed')(line))).toMatchObject({ event: 'ready' });
    again.send({ type: 'close', handle: String('handle' in accepted ? accepted.handle : '') });
    expect(await again.next((line) => 'event' in line && ['closed', 'close_failed'].includes(line.event))).toMatchObject({ event: 'closed' });

    expect(received().filter((request) => request.type === 'archive_workspace_request')).toMatchObject([{ workspaceId: workspace }]);
  });

  it('archives the workspace it opened on a directory the member opened in Paseo under another path, which Paseo keeps apart, and leaves the member\'s', async () => {
    // The member opened the checkout through a link to it; Paseo matches a directory's workspace by its path, not its target.
    const link = path.join(dir, 'checkout-link');
    fs.symlinkSync(worktree, link);
    behave({ output: { ok: true }, member_workspaces: [link] });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    const workspace = worktreeWorkspace();
    runtime.send(promptRequest(handle, 'op-0000000b'));
    await runtime.next(isEnd('op-0000000b'));

    runtime.send({ type: 'close', handle });

    expect(await runtime.next((line) => 'event' in line && ['closed', 'close_failed'].includes(line.event))).toEqual({ event: 'closed', handle });
    expect(received().filter((request) => request.type === 'archive_workspace_request')).toMatchObject([{ workspaceId: workspace }]);
  });

  it('archives the workspace a second attempt opened through a link to the checkout, which Paseo keeps apart from the member\'s that a first attempt found there', async () => {
    const link = path.join(dir, 'checkout-link');
    fs.symlinkSync(worktree, link);
    behave({ output: { ok: true }, member_workspaces: [worktree] });
    const runtime = start();
    await ready(runtime);
    await opened(runtime);
    const viaLink = openRequest('op-0000000c', 'a4567cdef');
    runtime.send({ ...viaLink, view: { ...viaLink.view, worktree: link } });
    const accepted = await runtime.next(isOp('op-0000000c', 'accepted'));
    const handle = 'handle' in accepted ? String(accepted.handle) : '';
    await runtime.next((line) => isOp('op-0000000c', 'ready')(line) || isOp('op-0000000c', 'failed')(line));
    const linked = (JSON.parse(fs.readFileSync(path.join(daemonState, 'agents.json'), 'utf8')) as { workspaces: Record<string, string> }).workspaces[link];

    runtime.send({ type: 'close', handle });

    expect(await runtime.next((line) => 'event' in line && ['closed', 'close_failed'].includes(line.event))).toEqual({ event: 'closed', handle });
    expect(linked).toBeDefined();
    expect(received().filter((request) => request.type === 'archive_workspace_request')).toMatchObject([{ workspaceId: linked }]);
  });

  it('answers close_failed when Paseo will not archive the workspace, and keeps the attempt to close again', async () => {
    behave({ output: { ok: true }, refuse_archive: 'Workspace is busy' });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    const workspace = worktreeWorkspace();

    runtime.send({ type: 'close', handle });

    expect(await runtime.next((line) => 'event' in line && ['closed', 'close_failed'].includes(line.event))).toEqual({
      event: 'close_failed', handle,
      failure: { code: 'close_failed', message: `Paseo did not archive workspace worktree (${String(workspace)}): Workspace is busy. Its agents may still run; archive it in the Paseo app.` },
    });
    runtime.send({ type: 'reattach', handle });
    expect(await runtime.next((line) => 'event' in line && line.event === 'alive')).toMatchObject({ event: 'alive', handle });
  });

  it('forgets an attempt the person released though its close fails, so the last other attempt on its workspace archives it', async () => {
    behave({ hold_ms: 60_000, output: { ok: true }, refuse_cancel: 'Agent is busy' });
    const runtime = start();
    await ready(runtime);
    const released = await opened(runtime);
    const other = await opened(runtime, { attempt: 'a4567cdef', op: 'op-0000000c' });
    const workspace = worktreeWorkspace();
    runtime.send(promptRequest(released, 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'display'));

    runtime.send({ type: 'close', handle: released, release: true });
    expect(await runtime.next((line) => 'event' in line && ['closed', 'close_failed'].includes(line.event))).toMatchObject({ event: 'close_failed', handle: released, failure: { code: 'close_failed' } });
    runtime.send({ type: 'reattach', handle: released });
    expect(await runtime.next((line) => 'event' in line && ['alive', 'gone'].includes(line.event))).toEqual({ event: 'gone', handle: released });

    behave({ output: { ok: true } });
    runtime.send({ type: 'close', handle: other });
    expect(await runtime.next((line) => 'event' in line && ['closed', 'close_failed'].includes(line.event))).toEqual({ event: 'closed', handle: other });
    expect(received().filter((request) => request.type === 'archive_workspace_request')).toMatchObject([{ workspaceId: workspace }]);
    expect(journalFiles()).toEqual([]);
  });

  it('names the agents of an attempt released though its close failed as what it leaves', async () => {
    behave({ hold_ms: 60_000, output: { ok: true }, refuse_cancel: 'Agent is busy' });
    const runtime = start();
    await ready(runtime);
    const released = await opened(runtime);
    const other = await opened(runtime, { attempt: 'a4567cdef', op: 'op-0000000c' });
    runtime.send(promptRequest(released, 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'display'));
    const [agent] = agentsOf();

    runtime.send({ type: 'close', handle: released, release: true });
    expect(await runtime.next((line) => 'event' in line && ['closed', 'close_failed'].includes(line.event))).toMatchObject({ event: 'close_failed', handle: released, kept: [`Paseo agent ${String(agent)}`] });

    behave({ output: { ok: true } });
    runtime.send({ type: 'close', handle: other });
    expect(await runtime.next((line) => 'event' in line && ['closed', 'close_failed'].includes(line.event))).toEqual({ event: 'closed', handle: other });
  });

  // It waits out the close's real 10 s wait for the create, then the create Paseo finishes at 14 s.
  it('keeps forgetting an attempt released while Paseo still created its agent, once that create finishes', async () => {
    const runtime = start();
    await ready(runtime);
    const released = await opened(runtime);
    const other = await opened(runtime, { attempt: 'a4567cdef', op: 'op-0000000c' });
    const workspace = worktreeWorkspace();
    behave({ hold_ms: 60_000, output: { ok: true }, create_ms: 14_000 });
    runtime.send(promptRequest(released, 'op-0000000b'));
    await expect.poll(() => received().map((request) => request.type)).toEqual(['agent.create.request']);

    runtime.send({ type: 'close', handle: released, release: true });
    expect(await runtime.next((line) => 'event' in line && !('op' in line) && ['closed', 'close_failed'].includes(line.event))).toMatchObject({
      event: 'close_failed', handle: released, failure: { message: expect.stringMatching(/^Paseo did not finish creating an agent of /) },
    });
    // The create finishes, and the runtime has seen it land.
    await until(() => agentsOf().length === 1, 20_000);
    await delay(500);
    runtime.send({ type: 'reattach', handle: released });
    expect(await runtime.next((line) => 'event' in line && ['alive', 'gone'].includes(line.event))).toEqual({ event: 'gone', handle: released });

    behave({ output: { ok: true } });
    runtime.send({ type: 'close', handle: other });
    expect(await runtime.next((line) => 'event' in line && !('op' in line) && ['closed', 'close_failed'].includes(line.event))).toEqual({ event: 'closed', handle: other });
    expect(received().filter((request) => request.type === 'archive_workspace_request')).toMatchObject([{ workspaceId: workspace }]);
  }, 45_000);

  // It waits out the close's real 10 s wait for the open, then the open Paseo answers at 14 s.
  it('keeps forgetting an attempt released while Paseo still opened its worktree, once that open ends', async () => {
    const runtime = start();
    await ready(runtime);
    const other = await opened(runtime, { attempt: 'a4567cdef', op: 'op-0000000c' });
    const workspace = worktreeWorkspace();
    // Paseo answers the open after the close gave up waiting for it, and before the open's own question times out.
    behave({ open_ms: 14_000 });
    runtime.send(openRequest('op-0000000a', ATTEMPT));
    const accepted = await runtime.next(isOp('op-0000000a', 'accepted'));
    const released = 'handle' in accepted ? String(accepted.handle) : '';

    runtime.send({ type: 'close', handle: released, release: true });
    expect(await runtime.next((line) => 'event' in line && ['closed', 'close_failed'].includes(line.event))).toMatchObject({ event: 'close_failed', handle: released });
    await runtime.next((line) => isOp('op-0000000a', 'ready')(line) || isOp('op-0000000a', 'failed')(line));

    behave({});
    runtime.send({ type: 'close', handle: other });
    expect(await runtime.next((line) => 'event' in line && ['closed', 'close_failed'].includes(line.event))).toEqual({ event: 'closed', handle: other });
    expect(received().filter((request) => request.type === 'archive_workspace_request')).toMatchObject([{ workspaceId: workspace }]);
    expect(journalFiles()).toEqual([]);
  }, 30_000);

  it('archives a workspace two attempts share only when the last of them closes, one whose open is still in flight included', async () => {
    const runtime = start();
    await ready(runtime);
    const first = await opened(runtime);
    const workspace = worktreeWorkspace();
    behave({ open_ms: 2_000 });
    runtime.send(openRequest('op-0000000c', 'a4567cdef'));
    const accepted = await runtime.next(isOp('op-0000000c', 'accepted'));
    const second = 'handle' in accepted ? String(accepted.handle) : '';
    const archives = (): unknown[] => received().filter((request) => request.type === 'archive_workspace_request');

    runtime.send({ type: 'close', handle: first });
    expect(await runtime.next((line) => 'event' in line && line.event === 'closed')).toEqual({ event: 'closed', handle: first });
    expect(archives()).toEqual([]);
    expect(await runtime.next(isOp('op-0000000c', 'ready'))).toMatchObject({ display: { fields: { workspace } } });
    runtime.send({ type: 'close', handle: second });
    expect(await runtime.next((line) => 'event' in line && line.event === 'closed')).toEqual({ event: 'closed', handle: second });
    expect(archives()).toMatchObject([{ workspaceId: workspace }]);
  });

  it('accepts an open before Paseo opens the worktree as a workspace, and sends ready with that workspace once it does', async () => {
    behave({ open_ms: 3_000 });
    const runtime = start();
    await ready(runtime);
    runtime.send(openRequest('op-0000000a', ATTEMPT));

    expect(await runtime.next(isOp('op-0000000a', 'accepted'))).toEqual({ op: 'op-0000000a', event: 'accepted', handle: `worktree/${RUN}/${ATTEMPT}` });
    expect(worktreeWorkspace()).toBeUndefined();
    const shown = await runtime.next(isOp('op-0000000a', 'ready'));
    expect(shown).toEqual({ op: 'op-0000000a', event: 'ready', display: { label: 'Paseo workspace worktree', fields: { workspace: worktreeWorkspace(), daemon: 'Paseo 0.14.0' } } });
  });

  it('closes an attempt whose open is still in flight once Paseo opened its workspace, and archives it', async () => {
    behave({ open_ms: 2_000 });
    const runtime = start();
    await ready(runtime);
    runtime.send(openRequest('op-0000000a', ATTEMPT));
    const accepted = await runtime.next(isOp('op-0000000a', 'accepted'));
    const handle = 'handle' in accepted ? String(accepted.handle) : '';

    runtime.send({ type: 'close', handle });

    expect(await runtime.next((line) => 'event' in line && ['closed', 'close_failed'].includes(line.event))).toEqual({ event: 'closed', handle });
    expect(received().filter((request) => request.type === 'archive_workspace_request')).toHaveLength(1);
    runtime.send({ type: 'reattach', handle });
    expect(await runtime.next((line) => 'event' in line && ['alive', 'gone'].includes(line.event))).toEqual({ event: 'gone', handle });
  });

  it('reads an attempt\'s prompts from its own index alone, so a record outside it never blocks its reattach or close', async () => {
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    const root = path.join(dir, 'home', '.teamai', 'runtime-state', 'paseo');
    // A place with no index of its own, as one journaled before the index was kept, and another attempt's damaged record.
    fs.rmSync(path.join(root, 'handles', encodeURIComponent(handle)), { recursive: true });
    fs.mkdirSync(path.join(root, 'ops'), { recursive: true });
    fs.writeFileSync(path.join(root, 'ops', 'op-0000000f.json'), '{not json');

    runtime.send({ type: 'reattach', handle });

    expect(await runtime.next((line) => 'handle' in line && !('op' in line) && ['alive', 'gone', 'failed'].includes(line.event))).toMatchObject({ event: 'alive', handle, ops: [] });
    runtime.send({ type: 'close', handle });
    expect(await runtime.next((line) => 'event' in line && !('op' in line) && ['closed', 'close_failed'].includes(line.event))).toEqual({ event: 'closed', handle });
  });

  it('stops only its own agents when another attempt shares its workspace, and leaves that attempt running', async () => {
    behave({ hold_ms: 60_000, output: { ok: true }, stop_lag_ms: 1_500 });
    const runtime = start();
    await ready(runtime);
    const first = await opened(runtime);
    const second = await opened(runtime, { attempt: 'a4567cdef', op: 'op-0000000c' });
    runtime.send(promptRequest(first, 'op-0000000b'));
    runtime.send(promptRequest(second, 'op-0000000d'));
    await runtime.next(isOp('op-0000000b', 'display'));
    await runtime.next(isOp('op-0000000d', 'display'));

    runtime.send({ type: 'close', handle: first });

    expect(await runtime.next((line) => 'event' in line && ['closed', 'close_failed'].includes(line.event))).toEqual({ event: 'closed', handle: first });
    expect(stopped()).toEqual([{ agentId: createdAgent('op-0000000b'), status: 'idle' }]);
    expect(received().filter((request) => request.type === 'archive_workspace_request')).toEqual([]);
    runtime.send({ type: 'reattach', handle: second });
    expect(await runtime.next((line) => 'event' in line && line.event === 'alive')).toMatchObject({ handle: second, ops: [{ op: 'op-0000000d', state: 'running' }] });
  });

  it('keeps an attempt whose agent still runs when another attempt shares its workspace, so it can be closed again', async () => {
    behave({ hold_ms: 60_000, output: { ok: true }, refuse_cancel: 'Agent is busy', stop_lag_ms: 60_000 });
    const runtime = start();
    await ready(runtime);
    const first = await opened(runtime);
    const second = await opened(runtime, { attempt: 'a4567cdef', op: 'op-0000000c' });
    const workspace = worktreeWorkspace();
    const isClose = (handle: string) => (line: RuntimeMessage): boolean => 'event' in line && ['closed', 'close_failed'].includes(line.event) && 'handle' in line && line.handle === handle;
    const archives = (): unknown[] => received().filter((request) => request.type === 'archive_workspace_request');
    runtime.send(promptRequest(first, 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'display'));
    runtime.send({ type: 'cancel', op: 'op-0000000b' });
    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed' } });
    const agent = createdAgent('op-0000000b');

    runtime.send({ type: 'close', handle: first });

    expect(await runtime.next(isClose(first))).toEqual({
      event: 'close_failed', handle: first,
      failure: { code: 'close_failed', message: `Paseo did not cancel the claude agent ${agent}: Agent is busy. It may still run in the worktree; stop it in the Paseo app.` },
    });
    runtime.send({ type: 'close', handle: second });
    expect(await runtime.next(isClose(second))).toEqual({ event: 'closed', handle: second });
    expect(archives()).toEqual([]);
    expect(stopped()).toEqual([]);
    runtime.send({ type: 'reattach', handle: first });
    expect(await runtime.next((line) => 'event' in line && line.event === 'alive')).toMatchObject({ handle: first, ops: [{ op: 'op-0000000b', state: 'failed' }] });

    // Paseo stops the agent once asked again: the attempt, now the workspace's last, archives it and closes.
    behave({ hold_ms: 60_000, output: { ok: true } });
    runtime.send({ type: 'close', handle: first });
    expect(await runtime.next(isClose(first))).toEqual({ event: 'closed', handle: first });
    expect(archives()).toMatchObject([{ workspaceId: workspace }]);
    expect(stopped()).toEqual([{ agentId: agent, status: 'closed' }]);
  }, 30_000);

  it('answers a place from its journal after a restart that cannot reach the daemon, and refuses to close it until it can', async () => {
    behave({ hold_ms: 60_000, output: { ok: true } });
    const first = start();
    await ready(first);
    const handle = await opened(first);
    first.send(promptRequest(handle, 'op-0000000b'));
    await first.next(isOp('op-0000000b', 'accepted'));
    await first.kill();
    const workspace = worktreeWorkspace();
    const { url } = daemon;
    await daemon.close();
    const isAnswer = (events: string[]) => (line: RuntimeMessage): boolean => 'event' in line && [...events, 'error'].includes(line.event);

    const restarted = start();
    expect(await ready(restarted, { options: { url } })).toMatchObject({ ok: false, error: { code: 'daemon_unreachable' } });
    restarted.send({ type: 'reattach', handle });
    expect(await restarted.next(isAnswer(['alive', 'gone']))).toEqual({ event: 'alive', handle, ops: [{ op: 'op-0000000b', state: 'running' }] });
    restarted.send({ type: 'collect', handle });
    expect(await restarted.next(isAnswer(['collected', 'collect_failed']))).toEqual({ event: 'collected', handle });
    restarted.send({ type: 'close', handle });
    expect(await restarted.next(isAnswer(['closed', 'close_failed']))).toEqual({
      event: 'close_failed', handle,
      failure: { code: 'daemon_unreachable', message: `teamai-runtime-paseo reaches no Paseo daemon, so it cannot stop the agents of ${handle} or archive its workspace. Start the daemon with \`paseo start\`, then close the attempt again.` },
    });
    restarted.send({ type: 'reattach', handle });
    expect(await restarted.next(isAnswer(['alive', 'gone']))).toMatchObject({ event: 'alive', handle });

    // The daemon is back, and has closed the agent it ran, as Paseo does on a restart: a runtime that reaches it archives
    // the workspace and closes.
    await restartDaemon({ port: Number(new URL(url).port) });
    const back = start();
    await ready(back);
    back.send({ type: 'close', handle });
    expect(await back.next(isAnswer(['closed', 'close_failed']))).toEqual({ event: 'closed', handle });
    expect(received().filter((request) => request.type === 'archive_workspace_request')).toMatchObject([{ workspaceId: workspace }]);
  }, 40_000);

  it('refuses to close a place whose record it cannot read, and never calls it gone', async () => {
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    const record = path.join(dir, 'home', '.teamai', 'runtime-state', 'paseo', 'places', `${encodeURIComponent(handle)}.json`);
    fs.writeFileSync(record, '{"kind":');
    const isAnswer = (events: string[]) => (line: RuntimeMessage): boolean => 'event' in line && !('op' in line) && [...events, 'error'].includes(line.event);

    runtime.send({ type: 'close', handle });

    expect(await runtime.next(isAnswer(['closed', 'close_failed']))).toMatchObject({ event: 'close_failed', handle, failure: { code: 'paseo_failed' } });
    expect(fs.readFileSync(record, 'utf8')).toBe('{"kind":');
    runtime.send({ type: 'reattach', handle });
    expect(await runtime.next(isAnswer(['alive', 'gone', 'failed']))).toMatchObject({ event: 'failed', handle, failure: { code: 'paseo_failed' } });
  });

  it('refuses a repeated open of an attempt whose place record it cannot read, and keeps that record', async () => {
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    const record = path.join(dir, 'home', '.teamai', 'runtime-state', 'paseo', 'places', `${encodeURIComponent(handle)}.json`);
    fs.writeFileSync(record, '{"kind":');

    runtime.send(openRequest('op-0000000c', ATTEMPT));

    expect(await runtime.next(isEnd('op-0000000c'))).toMatchObject({ event: 'failed', failure: { code: 'paseo_failed' } });
    expect(fs.readFileSync(record, 'utf8')).toBe('{"kind":');
  });

  it('answers and closes a healthy attempt though the record of another attempt\'s prompt cannot be read, and refuses its own unreadable one', async () => {
    behave({ output: { ok: true } });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b'));
    await runtime.next(isEnd('op-0000000b'));
    const ops = path.join(dir, 'home', '.teamai', 'runtime-state', 'paseo', 'ops');
    fs.writeFileSync(path.join(ops, 'op-0000000f.json'), '{"kind":');
    const isAnswer = (events: string[]) => (line: RuntimeMessage): boolean => 'event' in line && !('op' in line) && [...events, 'error'].includes(line.event);

    runtime.send({ type: 'reattach', handle });
    expect(await runtime.next(isAnswer(['alive', 'gone', 'failed']))).toMatchObject({ event: 'alive', handle, ops: [{ op: 'op-0000000b', state: 'finished' }] });
    runtime.send({ type: 'close', handle });
    expect(await runtime.next(isAnswer(['closed', 'close_failed']))).toEqual({ event: 'closed', handle });

    const other = await opened(runtime, { attempt: 'a4567cdef', op: 'op-0000000c' });
    runtime.send(promptRequest(other, 'op-0000000d'));
    await runtime.next(isEnd('op-0000000d'));
    fs.writeFileSync(path.join(ops, 'op-0000000d.json'), '{"kind":');
    runtime.send({ type: 'reattach', handle: other });
    expect(await runtime.next(isAnswer(['alive', 'gone', 'failed']))).toMatchObject({ event: 'failed', handle: other });
  });

  it('closes a healthy attempt though another attempt\'s place record cannot be read, and leaves the workspace that place may share', async () => {
    behave({ output: { ok: true } });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    fs.writeFileSync(path.join(dir, 'home', '.teamai', 'runtime-state', 'paseo', 'places', `${encodeURIComponent(`worktree/${RUN}/a4567cdef`)}.json`), '{"kind":');

    runtime.send({ type: 'close', handle });

    expect(await runtime.next((line) => 'event' in line && !('op' in line) && ['closed', 'close_failed', 'failed', 'error'].includes(line.event))).toEqual({ event: 'closed', handle });
    expect(received().filter((request) => request.type === 'archive_workspace_request')).toEqual([]);
  });
});
