import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from './testing/harness.js';
import { ANY_HOST, FILTER_SCRIPT, thisMachineFileRule } from './judge.js';

// The network filter as node runs it, on this machine: what it answers a CONNECT, never where the tunnel then goes.

const started: ChildProcess[] = [];

afterEach(() => {
  for (const filter of started.splice(0)) filter.kill('SIGKILL');
});

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = tcpAddressOf(server.address());
  await new Promise((resolve) => server.close(resolve));

  return port;
}

function tcpAddressOf(address: string | net.AddressInfo | null): net.AddressInfo {
  if (address === null || typeof address === 'string') throw new Error('a TCP server has a port');

  return address;
}

/** Starts the filter with `rules`, and waits until it listens, or until it exits with its code. */
async function startFilter(rules: string[]): Promise<{ port: number } | { exited: number | null }> {
  const port = await freePort();
  const filter = spawn(process.execPath, ['-e', FILTER_SCRIPT, String(port), ...rules], { stdio: 'ignore' });
  started.push(filter);

  for (let tries = 0; tries < 100; tries += 1) {
    if (filter.exitCode !== null) return { exited: filter.exitCode };
    const isListening = await new Promise<boolean>((resolve) => {
      const probe = net.connect(port, '127.0.0.1', () => { probe.destroy(); resolve(true); });
      probe.on('error', () => resolve(false));
    });

    if (isListening) return { port };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return { exited: filter.exitCode };
}

/** The filter's status for `CONNECT target`, or `none` when it answered nothing within a second. */
function connectThrough(port: number, target: string): Promise<string> {
  return new Promise((resolve) => {
    const request = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: target });
    const timer = setTimeout(() => { request.destroy(); resolve('none'); }, 1000);
    request.on('connect', (response, socket) => { clearTimeout(timer); socket.destroy(); resolve(String(response.statusCode)); });
    request.on('response', (response) => { clearTimeout(timer); resolve(String(response.statusCode)); });
    request.on('error', () => { clearTimeout(timer); resolve('none'); });
    request.end();
  });
}

describe('the network filter', () => {
  it("refuses an address of this machine the runtime lists in its file after the filter started, as when a VPN comes up during a step", async () => {
    const file = path.join(tempDir(), 'this-machine');
    fs.writeFileSync(file, '');
    const filter = await startFilter([ANY_HOST, thisMachineFileRule(file)]);

    if (!('port' in filter)) throw new Error(`the filter exited with ${filter.exited}`);
    // 192.0.2.1 (TEST-NET-1) stands in for a new address of this machine: nothing answers there.
    fs.writeFileSync(file, '192.0.2.1\n');

    expect(await connectThrough(filter.port, '192.0.2.1:22')).toBe('403');
  });

  it('does not start when the file of addresses of this machine it is given is not there, so it never runs without it', async () => {
    expect(await startFilter([ANY_HOST, thisMachineFileRule(path.join(tempDir(), 'missing'))])).toEqual({ exited: 1 });
  });
});
