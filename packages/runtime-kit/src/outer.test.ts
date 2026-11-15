import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerThrough, socketOf } from './outer.js';

let dir: string;
let server: net.Server;
let lines: string[];
let ended: Promise<void>;
/** What the socket answers each line with, as the sandbox runtime's does: nothing unless a test says so. */
let answer: (line: string) => string[];

const outerOf = (socket: string): string => JSON.stringify({ place: 'sandbox-1', socket });

beforeEach(async () => {
  // A unix socket's path must stay short: macOS's own temporary folder is too deep for one.
  dir = fs.mkdtempSync('/tmp/teamai-kit-outer-');
  lines = [];
  answer = () => [];
  let end = (): void => {};
  ended = new Promise((resolve) => { end = resolve; });
  server = net.createServer((client) => {
    client.setEncoding('utf8').on('data', (data: string) => {
      for (const line of data.split('\n').filter(Boolean)) {
        lines.push(line);

        for (const reply of answer(line)) client.write(`${reply}\n`);
      }
    });
    client.on('end', end);
  });
  await new Promise<void>((resolve) => server.listen(path.join(dir, 'attempt.sock'), resolve));
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('a registration on an outer runtime\'s attempt socket', () => {
  it('registers the step\'s tool on the socket the outer handle names, and ends once closed', async () => {
    const registered = await registerThrough({ outer: outerOf(path.join(dir, 'attempt.sock')), agent: null });

    expect(registered.ok).toBe(true);
    await expect.poll(() => lines).toEqual(['{"register":{"agent":null}}']);
    if (registered.ok) registered.close();
    await ended;
  });

  it('registers nothing for an outer handle that names no attempt socket, saying so', async () => {
    expect(await registerThrough({ outer: 'sandbox-1', agent: null })).toEqual({ ok: false, why: 'its handle names no attempt socket' });
  });

  it('says why when nothing answers on the socket', async () => {
    const registered = await registerThrough({ outer: outerOf(path.join(dir, 'gone.sock')), agent: null });

    expect(registered).toEqual({ ok: false, why: expect.stringContaining('ENOENT') });
  });

  it('reads the attempt socket from a sandbox handle, and none from another runtime\'s handle', () => {
    expect(socketOf(outerOf('/s/attempt.sock'))).toBe('/s/attempt.sock');
    expect(socketOf('teamai-r0123abcd-a0123abcd')).toBeUndefined();
  });

  it('says the agent\'s wrapper connected once the sandbox says so for that agent, not for another', async () => {
    answer = () => [JSON.stringify({ connected: { agent: 'helper' } }), JSON.stringify({ connected: { agent: 'step' } })];
    const registered = await registerThrough({ outer: outerOf(path.join(dir, 'attempt.sock')), agent: 'step' });

    if (!registered.ok) throw new Error(registered.why);
    expect(await registered.connected).toEqual({ ok: true });
    expect(lines).toEqual(['{"register":{"agent":"step"}}']);
    registered.close();
    await ended;
  });

  it('says why the wrapper never connects when the socket ends the registration first', async () => {
    server.on('connection', (client) => client.on('data', () => client.destroy()));
    const registered = await registerThrough({ outer: outerOf(path.join(dir, 'attempt.sock')), agent: 'step' });

    if (!registered.ok) throw new Error(registered.why);
    expect(await registered.connected).toEqual({ ok: false, why: expect.stringContaining('closed the registration') });
  });

  it('registers nothing for an empty agent id, saying so rather than throwing', async () => {
    const registered = await registerThrough({ outer: outerOf(path.join(dir, 'attempt.sock')), agent: '' });

    expect(registered).toEqual({ ok: false, why: expect.stringContaining('agent') });
    expect(lines).toEqual([]);
  });

  it('never registers on a socket whose directory others may open, since whoever made it would say what ran', async () => {
    fs.chmodSync(dir, 0o755);

    expect(await registerThrough({ outer: outerOf(path.join(dir, 'attempt.sock')), agent: 'step' })).toEqual({ ok: false, why: expect.stringContaining('0700') });
    expect(lines).toEqual([]);
  });
});
