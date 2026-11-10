import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { LAUNCHED_BY_ENV, LOGIN_DEFERRED_ENV, runLoginDeferredHook } from '../hook-fast-path.js';

const READ = ['hook-dispatch', 'post-tool-use', '--tool', 'claude'];
const PROMPT = ['hook-dispatch', 'prompt-submit', '--tool', 'claude'];

// A hook command that deferred its login shell starts teamai through ~/.teamai/bin; the login shell then runs where
// nothing waits for it. A fake `bash` records how it was started: its argv, its stdin, the marker and PATH.
describe('runLoginDeferredHook', () => {
  let scratch: string;
  let fakeBin: string;
  let record: string;
  let base: NodeJS.ProcessEnv;
  const LOGIN = ['-lc', 'exec teamai "$@"', 'teamai'];
  const SESSION_START = ['hook-dispatch', 'session-start', '--tool', 'claude'];
  const stdinOf = (text: string) => () => Readable.from([Buffer.from(text)]);
  const never = () => { throw new Error('stdin opened'); };

  beforeEach(() => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-login-deferred-')));
    fakeBin = path.join(scratch, 'fakebin');
    record = path.join(scratch, 'record');
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(record);
    fs.mkdirSync(path.join(scratch, 'home'));
    fs.writeFileSync(path.join(fakeBin, 'bash'), [
      '#!/bin/sh',
      'if [ -n "$FAKE_READ_STDIN" ]; then cat > "$RECORD/stdin"; fi',
      'printf %s "${TEAMAI_HOOK_LOGIN-unset}" > "$RECORD/marker"',
      'printf %s "$PATH" > "$RECORD/path"',
      'printf \'%s\\n\' "$@" > "$RECORD/argv.part" && mv "$RECORD/argv.part" "$RECORD/argv"',
      'exit 7',
      '',
    ].join('\n'), { mode: 0o755 });
    vi.stubEnv('HOME', path.join(scratch, 'home'));
    base = { HOME: path.join(scratch, 'home'), RECORD: record, PATH: `${fakeBin}:/usr/bin:/bin` };
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  const marked = (env: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ ...base, [LOGIN_DEFERRED_ENV]: 'deferred', ...env });

  /** What the fake bash recorded, once it has, or null when it never ran. */
  async function bashCall(wait: boolean): Promise<{ argv: string[]; marker: string; path: string; stdin: string | null } | null> {
    const deadline = wait ? 10_000 : 0;

    for (let waited = 0; waited < deadline && !fs.existsSync(path.join(record, 'argv')); waited += 25) await new Promise((resolve) => setTimeout(resolve, 25));

    if (!fs.existsSync(path.join(record, 'argv'))) return null;
    const read = (name: string) => fs.readFileSync(path.join(record, name), 'utf8');

    return { argv: read('argv').split('\n').slice(0, -1), marker: read('marker'), path: read('path'), stdin: fs.existsSync(path.join(record, 'stdin')) ? read('stdin') : null };
  }

  it('leaves a command without the marker to the fast path, and one that is not a hook', async () => {
    expect(await runLoginDeferredHook(SESSION_START, { env: base, platform: 'darwin', stdin: never })).toBeNull();
    expect(await runLoginDeferredHook(['pull'], { env: marked(), platform: 'darwin', stdin: never })).toBeNull();
    expect(await bashCall(false)).toBeNull();
  });

  it('skips the hook of a session teamai launched for itself, and starts no shell', async () => {
    expect(await runLoginDeferredHook(READ, { env: marked({ [LAUNCHED_BY_ENV]: 'answer' }), platform: 'darwin', stdin: never })).toBe(0);
    expect(await bashCall(false)).toBeNull();
  });

  it.each([
    { name: 'an argv the fast path never takes', argv: SESSION_START, platform: 'darwin' as const },
    { name: 'any hook on Windows', argv: READ, platform: 'win32' as const },
  ])('hands $name to a login shell in the foreground, without the marker, and returns its status', async ({ argv, platform }) => {
    expect(await runLoginDeferredHook(argv, { env: marked(), platform, stdin: never })).toBe(7);
    expect(await bashCall(false)).toEqual({ argv: [...LOGIN, ...argv], marker: 'unset', path: base.PATH, stdin: null });
  });

  it('returns 127 when no bash is on PATH', async () => {
    expect(await runLoginDeferredHook(SESSION_START, { env: marked({ PATH: path.join(scratch, 'empty') }), platform: 'darwin', stdin: never })).toBe(127);
  });

  it('starts the background pass through a detached login shell with the payload, and returns at once', async () => {
    const payload = JSON.stringify({ session_id: 's-1', tool_name: 'Read' });

    expect(await runLoginDeferredHook(READ, { env: marked({ FAKE_READ_STDIN: '1' }), platform: 'darwin', stdin: stdinOf(payload) })).toBe(0);
    expect(await bashCall(true)).toEqual({ argv: [...LOGIN, ...READ, '--bg-only'], marker: 'unset', path: base.PATH, stdin: payload });
    expect(fs.readFileSync(path.join(scratch, 'home', '.teamai', 'debug.log'), 'utf8')).toContain('[hook-dispatch] post-tool-use/claude fast path');
  });

  it('hands a payload over the pipe limit to the background pass as a file, with an empty stdin', async () => {
    const payload = JSON.stringify({ session_id: 's-1', tool_name: 'Read', tool_response: { content: 'x'.repeat(300 * 1024) } });

    expect(await runLoginDeferredHook(READ, { env: marked({ FAKE_READ_STDIN: '1' }), platform: 'darwin', stdin: stdinOf(payload) })).toBe(0);
    const call = await bashCall(true);
    const file = call?.argv.at(-1) ?? '';

    expect(call).toEqual({ argv: [...LOGIN, ...READ, '--bg-only', '--stdin-file', file], marker: 'unset', path: base.PATH, stdin: '' });
    expect(fs.readFileSync(file, 'utf8')).toBe(payload);
    fs.rmSync(file);
  });

  it('removes the payload file when the background pass cannot be started', async () => {
    const tmp = path.join(scratch, 'tmp');
    fs.mkdirSync(tmp);
    vi.stubEnv('TMPDIR', tmp);
    const payload = JSON.stringify({ session_id: 's-1', tool_name: 'Read', tool_response: { content: 'x'.repeat(300 * 1024) } });

    expect(await runLoginDeferredHook(READ, { env: marked({ PATH: path.join(scratch, 'empty') }), platform: 'darwin', stdin: stdinOf(payload) })).toBe(0);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it('hands a TodoWrite call to a login shell in the foreground with the same stdin, and returns its status', async () => {
    const payload = JSON.stringify({ session_id: 's-1', tool_name: 'TodoWrite' });

    expect(await runLoginDeferredHook(READ, { env: marked({ FAKE_READ_STDIN: '1' }), platform: 'darwin', stdin: stdinOf(payload) })).toBe(7);
    expect(await bashCall(false)).toEqual({ argv: [...LOGIN, ...READ], marker: 'unset', path: base.PATH, stdin: payload });
  });

  // The foreground of this form has no login environment, so it cannot see an endpoint variable the profile or the team
  // env sets: a prompt takes the fast path only on what a pass inside that environment recorded for this session and cwd.
  describe('a prompt', () => {
    const PAYLOAD = JSON.stringify({ session_id: 's-1', cwd: '/work/a', prompt: 'hello' });
    const writeRecord = (cwd: string, enrolled: boolean) => {
      fs.mkdirSync(path.join(scratch, 'home', '.teamai', 'sessions'), { recursive: true });
      fs.writeFileSync(path.join(scratch, 'home', '.teamai', 'sessions', 's-1.http-enrolment.json'), JSON.stringify({ cwd, enrolled }));
    };

    it('takes the fast path when the login environment saw no enrolment for this session and cwd', async () => {
      writeRecord('/work/a', false);

      expect(await runLoginDeferredHook(PROMPT, { env: marked({ FAKE_READ_STDIN: '1' }), platform: 'darwin', stdin: stdinOf(PAYLOAD) })).toBe(0);
      expect(await bashCall(true)).toEqual({ argv: [...LOGIN, ...PROMPT, '--bg-only'], marker: 'unset', path: base.PATH, stdin: PAYLOAD });
    });

    it.each([
      { name: 'with no record', setUp: () => {} },
      { name: 'whose record says enrolled', setUp: () => writeRecord('/work/a', true) },
      { name: 'from another cwd than the record\'s, as after EnterWorktree', setUp: () => writeRecord('/work/b', false) },
      {
        name: 'with a hint waiting for it',
        setUp: () => {
          writeRecord('/work/a', false);
          fs.mkdirSync(path.join(scratch, 'home', '.teamai', 'package-hints'), { recursive: true });
          fs.writeFileSync(path.join(scratch, 'home', '.teamai', 'package-hints', 's-1.pending.json'), '{}');
        },
      },
    ])('hands a prompt $name to a login shell in the foreground with the same stdin', async ({ setUp }) => {
      setUp();

      expect(await runLoginDeferredHook(PROMPT, { env: marked({ FAKE_READ_STDIN: '1' }), platform: 'darwin', stdin: stdinOf(PAYLOAD) })).toBe(7);
      expect(await bashCall(false)).toEqual({ argv: [...LOGIN, ...PROMPT], marker: 'unset', path: base.PATH, stdin: PAYLOAD });
    });
  });
});
