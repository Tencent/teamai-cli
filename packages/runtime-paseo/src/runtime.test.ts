import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { RuntimeMessage } from '@teamai/runtime-protocol';
import { describe, expect, it, onTestFinished } from 'vitest';
import { restartDaemon, createdAgent, dir, worktree, daemon, RUN, ATTEMPT, behave, start, isOp, isEnd, ready, opened, delay, promptRequest, useRuntimeSuite } from './testing/suite.js';

describe('teamai-runtime-paseo', () => {
  useRuntimeSuite();

  it('serves only when teamai starts it, and passes no sign of that on to what it runs', async () => {
    const refused = start({ TEAMAI_RUNTIME_PROTOCOL: '' });
    const status = await new Promise<number | null>((resolve) => refused.child.once('exit', resolve));
    expect(status).toBe(2);
    expect(refused.lines).toEqual([]);

    // The codex whose sign-in init reads records whether it inherited the variable teamai starts the runtime with.
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const marker = path.join(dir, 'marker');
    fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\nprintf '%s\\n' "\${TEAMAI_RUNTIME_PROTOCOL+set}" >> ${marker}\necho 'Logged in using ChatGPT' >&2\n`, { mode: 0o755 });
    behave({ models: { codex: ['gpt-6.1-sol'] }, codex_path: path.join(bin, 'codex') });

    expect(await ready(start())).toMatchObject({ type: 'init', ok: true, can: { tools: ['codex'] } });
    expect(fs.readFileSync(marker, 'utf8')).toBe('\n');
  });

  it('opens in recover mode with no daemon to reach, checking no tool and offering nothing', async () => {
    const { url } = daemon;
    await daemon.close();

    expect(await ready(start(), { mode: 'recover', options: { url } })).toEqual({ type: 'init', ok: true, can: {} });
  });

  it('answers a recover-mode cancel and close within 10 s of reading them while the daemon is down, keeping the attempt', async () => {
    behave({ hold_ms: 60_000, output: { ok: true } });
    const first = start();
    await ready(first);
    const handle = await opened(first);
    first.send(promptRequest(handle, 'op-0000000b'));
    await first.next(isOp('op-0000000b', 'display'));
    await first.kill();
    const { url } = daemon;
    await daemon.close();
    const recovering = start();
    await ready(recovering, { mode: 'recover', options: { url } });
    let asked = Date.now();

    recovering.send({ type: 'cancel', op: 'op-0000000b' });

    expect(await recovering.next(isEnd('op-0000000b'))).toEqual({
      op: 'op-0000000b', event: 'failed',
      failure: {
        code: 'cancel_failed',
        message: `No Paseo daemon answered at ${url} within 10 s. Start it with \`paseo start\`, or set the runtime's url option to the daemon's address. Until then teamai-runtime-paseo cannot cancel the claude agent ${createdAgent('op-0000000b')}, which may still run in the worktree; cancel the run again.`,
      },
    });
    const cancelMs = Date.now() - asked;
    asked = Date.now();
    recovering.send({ type: 'close', handle });
    expect(await recovering.next((line) => 'event' in line && !('op' in line) && ['closed', 'close_failed'].includes(line.event))).toMatchObject({ event: 'close_failed', handle, failure: { code: 'daemon_unreachable' } });
    const closeMs = Date.now() - asked;
    process.stderr.write(`recover answers: cancel ${cancelMs} ms, close ${closeMs} ms\n`);
    expect(cancelMs).toBeLessThan(10_500);
    expect(closeMs).toBeLessThan(10_500);
    await restartDaemon({ port: 0 });
  }, 40_000);

  it('answers a recover-mode cancel within 10 s while the daemon\'s address accepts connections and never answers, and stops the agent on a retry once the daemon is back', async () => {
    behave({ hold_ms: 60_000, output: { ok: true } });
    const first = start();
    await ready(first);
    const handle = await opened(first);
    first.send(promptRequest(handle, 'op-0000000b'));
    await first.next(isOp('op-0000000b', 'display'));
    await first.kill();
    const { url } = daemon;
    const port = Number(new URL(url).port);
    await daemon.close();
    // A host that takes the connection and never says hello, as a hung daemon or a firewall that holds it does.
    const sockets = new Set<net.Socket>();
    const silent = net.createServer((socket) => sockets.add(socket));
    await new Promise<void>((resolve) => silent.listen(port, '127.0.0.1', resolve));
    const recovering = start();
    await ready(recovering, { mode: 'recover', options: { url } });
    const asked = Date.now();

    recovering.send({ type: 'cancel', op: 'op-0000000b' });

    expect(await recovering.next(isEnd('op-0000000b'))).toMatchObject({ op: 'op-0000000b', event: 'failed', failure: { code: 'cancel_failed' } });
    expect(Date.now() - asked).toBeLessThan(10_500);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => silent.close(() => resolve()));
    await restartDaemon({ port });

    recovering.send({ type: 'cancel', op: 'op-0000000b' });

    expect(await recovering.next(isEnd('op-0000000b'))).toEqual({ op: 'op-0000000b', event: 'cancelled' });
  }, 40_000);

  it('answers a recover-mode cancel that joined another cancel\'s connection by its own deadline, connecting again once that one gave up, so a daemon back by then is reached', async () => {
    behave({ hold_ms: 60_000, output: { ok: true } });
    const first = start();
    await ready(first);
    const handle = await opened(first);
    first.send(promptRequest(handle, 'op-0000000b'));
    first.send(promptRequest(handle, 'op-0000000c'));
    await first.next(isOp('op-0000000b', 'display'));
    await first.next(isOp('op-0000000c', 'display'));
    await first.kill();
    const { url } = daemon;
    const port = Number(new URL(url).port);
    await daemon.close();
    const sockets = new Set<net.Socket>();
    const silent = net.createServer((socket) => sockets.add(socket));
    await new Promise<void>((resolve) => silent.listen(port, '127.0.0.1', resolve));
    onTestFinished(() => {
      for (const socket of sockets) socket.destroy();
    });
    const recovering = start();
    await ready(recovering, { mode: 'recover', options: { url } });

    recovering.send({ type: 'cancel', op: 'op-0000000b' });
    await delay(4_000);
    recovering.send({ type: 'cancel', op: 'op-0000000c' });
    // The daemon is back, though the connection both cancels share still hangs on the host that never answered.
    silent.close();
    await restartDaemon({ port });

    expect(await recovering.next(isEnd('op-0000000b'))).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed' } });
    expect(await recovering.next(isEnd('op-0000000c'))).toEqual({ op: 'op-0000000c', event: 'cancelled' });
  }, 40_000);

  it('fails a request it cannot read on its own when its op or handle is new, never with an error line', async () => {
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);

    runtime.child.stdin?.write(`${JSON.stringify({ type: 'prompt', op: 'op-0000000b', handle })}\n`);
    runtime.child.stdin?.write(`${JSON.stringify({ type: 'shut', handle: 'worktree/r4567cdef/a4567cdef' })}\n`);

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'failed', failure: { code: 'runtime_protocol', message: expect.stringMatching(/^Not a protocol 1 request: /) } });
    expect(await runtime.next((line) => 'handle' in line && line.handle === 'worktree/r4567cdef/a4567cdef')).toMatchObject({ event: 'failed', failure: { code: 'runtime_protocol' } });
    expect(runtime.lines.filter((line) => 'event' in line && line.event === 'error')).toEqual([]);
  });

  it('drops a request it cannot read for a prompt it already runs, so that prompt still ends once, and fails no other request than the unreadable ones', async () => {
    const release = path.join(dir, 'release');
    behave({ release, output: { ok: true } });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'display'));

    runtime.child.stdin?.write(`${JSON.stringify({ type: 'stop', op: 'op-0000000b' })}\n`);
    runtime.child.stdin?.write(`${JSON.stringify({ type: 'shut', handle })}\n`);
    await delay(1_000);
    fs.writeFileSync(release, '');

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished' });
    await delay(500);
    expect(runtime.lines.filter(isEnd('op-0000000b'))).toHaveLength(1);
    // The line it cannot read for the place gets that line's own failure; nothing else fails.
    expect(runtime.lines.filter((line) => 'event' in line && (line.event === 'error' || ('handle' in line && !('op' in line) && line.event === 'failed')))).toEqual([
      { event: 'failed', handle, failure: { code: 'runtime_protocol', message: expect.stringMatching(/^Not a protocol 1 request: /) } },
    ]);
  });

  it('keeps running, and ends its prompt, when it notes a dropped request after teamai stopped reading its stderr', async () => {
    const release = path.join(dir, 'release');
    behave({ release, output: { ok: true } });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000e'));
    await runtime.next(isOp('op-0000000e', 'display'));
    runtime.child.stderr?.destroy();

    // Its note about the dropped request goes to a stderr nobody reads.
    runtime.child.stdin?.write(`${JSON.stringify({ type: 'stop', op: 'op-0000000e' })}\n`);
    runtime.send({ type: 'reattach', handle });
    await runtime.next((line) => 'event' in line && line.event === 'alive');
    await delay(500);
    fs.writeFileSync(release, '');

    expect(await runtime.next(isEnd('op-0000000e'))).toMatchObject({ event: 'finished' });
  });

  it('answers an open or a prompt it cannot run, before a successful init or in recover mode, with its own failure, never an error line', async () => {
    const { url } = daemon;
    await daemon.close();
    const isAnswer = (op: string) => (line: RuntimeMessage): boolean => 'event' in line && (line.event === 'error' || ('op' in line && line.op === op));

    const unstarted = start();
    expect(await ready(unstarted, { options: { url } })).toMatchObject({ ok: false, error: { code: 'daemon_unreachable' } });
    unstarted.send({ type: 'open', op: 'op-0000000a', run: RUN, attempt: ATTEMPT, credentials: {}, view: { worktree, readonly: [], result: path.join(dir, 'out'), runDir: path.join(dir, 'run'), toolHome: {} } });
    expect(await unstarted.next(isAnswer('op-0000000a'))).toEqual({
      op: 'op-0000000a', event: 'failed', failure: { code: 'not_started', message: 'teamai-runtime-paseo got open before a successful init.' },
    });

    const recovering = start();
    await ready(recovering, { mode: 'recover', options: { url } });
    recovering.send(promptRequest('worktree/r/a', 'op-0000000b'));
    expect(await recovering.next(isAnswer('op-0000000b'))).toEqual({
      op: 'op-0000000b', event: 'failed', failure: { code: 'not_started', message: 'teamai-runtime-paseo opened in recover mode only stops what it ran: it got prompt.' },
    });
  });
});
