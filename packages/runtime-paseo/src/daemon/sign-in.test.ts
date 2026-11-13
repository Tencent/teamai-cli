import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isCodexExecutable } from './sign-in.js';
import { dir, daemon, behave, start, ready, cannotRun, useRuntimeSuite } from '../testing/suite.js';
import { signalPid } from '@teamai/shared/process-group';

describe('the Codex the daemon resolves', () => {
  it.each([
    ['win32', 'C:\\tools\\codex.exe', true],
    ['win32', 'C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.cmd', true],
    ['win32', 'C:\\Tools\\Codex.EXE', true],
    ['win32', 'C:\\tools\\codex', false],
    ['win32', 'C:\\tools\\codex.ps1', false],
    ['win32', 'C:\\tools\\helper.exe', false],
    ['win32', 'codex.exe', false],
    ['linux', '/usr/local/bin/codex', true],
    ['linux', '/usr/local/bin/codex.exe', false],
    ['darwin', '/opt/homebrew/bin/Codex', false],
  ] as const)('on %s, runs the Codex the daemon resolves to %s: %s', (platform, resolved, runs) => {
    expect(isCodexExecutable(resolved, platform)).toBe(runs);
  });
});

describe('teamai-runtime-paseo', () => {
  useRuntimeSuite();

  it('offers Codex on a daemon on this machine only when `codex login status` says it is signed in', async () => {
    behave({ models: { claude: ['claude-opus-5-5'], codex: ['gpt-6.1-sol'] }, codex_login: 'signed_out' });

    expect(await ready(start())).toMatchObject({ ok: true, can: { tools: ['claude'], confined: [{ tools: ['claude'] }] } });
  });

  it('answers a check with the Codex the daemon resolves, running no `codex login status`', async () => {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const ran = path.join(dir, 'ran');
    fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\ntouch ${ran}\necho 'Logged in using ChatGPT' >&2\n`, { mode: 0o755 });
    behave({ models: { codex: ['gpt-6.1-sol'] }, codex_path: path.join(bin, 'codex') });

    expect(await ready(start(), { mode: 'check' })).toMatchObject({ type: 'init', ok: true, can: { tools: ['codex'] } });
    expect(fs.existsSync(ran)).toBe(false);
  });

  it('does not offer a Codex the daemon has not installed, though this machine has a signed-in codex', async () => {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\necho \'Logged in using ChatGPT\' >&2\n', { mode: 0o755 });
    behave({ models: { claude: ['claude-opus-5-5'] } });

    expect(await ready(start({ PATH: `${bin}${path.delimiter}${String(process.env.PATH)}` }))).toMatchObject({ ok: true, can: { tools: ['claude'], confined: [{ tools: ['claude'] }] } });
  });

  it('asks the codex the daemon resolves on its own PATH, not the one on the runtime\'s PATH', async () => {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\necho \'Logged in using ChatGPT\' >&2\n', { mode: 0o755 });
    // The daemon resolves a codex that holds no install, so the runtime's signed-in one is never asked.
    behave({ models: { codex: ['gpt-6.1-sol'] } });

    expect(await ready(start({ PATH: `${bin}${path.delimiter}${String(process.env.PATH)}` }))).toMatchObject({
      ok: true, unavailable: { codex: expect.stringMatching(/ codex: `\/\S+\/host-bin\/codex login status` did not answer \(.+\); run it on the daemon's host to see why\.$/) },
    });
  });

  it.each([
    ['a binary not named codex', (bin: string) => path.join(bin, 'helper')],
    ['a relative codex, which would resolve on the runtime\'s PATH', () => 'codex'],
  ])('runs nothing when the daemon resolves Codex to %s, and says so', async (_, resolvedIn) => {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const ran = path.join(dir, 'ran');

    for (const name of ['helper', 'codex']) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\ntouch ${ran}\necho 'Logged in using ChatGPT' >&2\n`, { mode: 0o755 });
    const resolved = resolvedIn(bin);
    behave({ models: { codex: ['gpt-6.1-sol'] }, codex_path: resolved });

    expect(await ready(start({ PATH: `${bin}${path.delimiter}${String(process.env.PATH)}` }))).toMatchObject({
      ok: true, unavailable: { codex: cannotRun('codex', `Paseo resolves it to "${resolved}", which is not an absolute path to a codex; run \`paseo provider diagnostic codex\` on the daemon's host to see why`) },
    });
    expect(fs.existsSync(ran)).toBe(false);
  });

  it('stops every process of a `codex login status` that does not answer in time, as an npm shim leaves its native codex', async () => {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const native = path.join(dir, 'native.pid');
    fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\nsh -c 'echo $$ > ${native}; exec sleep 60' &\nwait\n`, { mode: 0o755 });
    behave({ models: { codex: ['gpt-6.1-sol'] }, codex_path: path.join(bin, 'codex') });

    expect(await ready(start())).toMatchObject({ ok: true, unavailable: { codex: expect.stringContaining('login status` did not answer') } });
    const pid = Number(fs.readFileSync(native, 'utf8'));
    await expect.poll(() => signalPid(pid, 0), { timeout: 3_000 }).toBe('gone');
  }, 20_000);

  it('says it cannot tell, rather than signed out, when `codex login status` gives neither answer', async () => {
    behave({ models: { codex: ['gpt-6.1-sol'] }, codex_login: 'unknown' });

    expect(await ready(start())).toMatchObject({
      ok: true, unavailable: { codex: expect.stringMatching(/ codex: `\/\S+\/host-bin\/codex login status` gave no sign-in answer \(exit 2: error: unrecognized subcommand: status\); run it on the daemon's host to see why\.$/) },
    });
  });

  it('does not offer Codex on a daemon at an address that is not loopback, whose host teamai cannot ask, and says so', async () => {
    behave({ models: { codex: ['gpt-6.1-sol'] }, codex_login: 'signed_in' });
    // 0.0.0.0 reaches the fake on this machine, but names no loopback address, as a daemon on another host is named.
    const url = daemon.url.replace('127.0.0.1', '0.0.0.0');

    expect(await ready(start(), { options: { url } })).toMatchObject({
      ok: true, can: { tools: [] },
      unavailable: { codex: `The Paseo daemon at ${url} cannot run codex: teamai checks Codex's sign-in only on a daemon at a loopback address, and ${url} is not one.` },
    });
  });

  it('does not use a Claude whose sign-in Paseo does not report, and says so', async () => {
    behave({ models: { claude: ['claude-opus-5-5'] }, sign_in: { claude: 'unreported' } });

    expect(await ready(start())).toMatchObject({
      ok: true, unavailable: { claude: cannotRun('claude', 'Paseo does not report whether it is signed in; run `paseo provider diagnostic claude` on the daemon\'s host to see its Auth line') },
    });
  });
});
