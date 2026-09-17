import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: mockSpawn,
}));

const { parseStdin, trySpawnDetachedViaWmi } = await import('../hook-dispatch-cli.js');
const { log } = await import('../utils/logger.js');

describe('parseStdin', () => {
  it('degrades malformed JSON to an empty object instead of null', () => {
    // RED BASELINE: before the fix this returns null (short-circuiting all
    // dispatch). After the fix it degrades to {} so non-stdin-dependent
    // background handlers still run, and records diagnostics to debug.log.
    const result = parseStdin('{broken', 'stop');
    expect(result).not.toBeNull();
    expect(result).toBeTypeOf('object');
    expect(result.hook_event_name).toBe('Stop');
  });

  it('returns an empty object (plus event name) for blank STDIN', () => {
    const result = parseStdin('', 'stop');
    expect(result).toEqual({ hook_event_name: 'Stop' });
  });

  it('parses well-formed JSON and keeps its fields (regression)', () => {
    const result = parseStdin('{"transcript_path":"/x"}', 'stop');
    expect(result.transcript_path).toBe('/x');
    expect(result.hook_event_name).toBe('Stop');
  });

  it('maps lower-case event aliases to their canonical hook names', () => {
    const result = parseStdin('', 'session-start');
    expect(result.hook_event_name).toBe('SessionStart');
  });

  it('degrades JSON `null` to {} instead of throwing', () => {
    // RED BASELINE: before the fix, JSON.parse('null') returns null, and the
    // subsequent `stdin.hook_event_name` access throws TypeError in ESM strict
    // mode, short-circuiting all dispatch (the very failure mode the original
    // malformed-JSON fix was meant to prevent).
    const result = parseStdin('null', 'stop');
    expect(Array.isArray(result)).toBe(false);
    expect(result.hook_event_name).toBe('Stop');
  });

  it('degrades JSON number to {} instead of throwing', () => {
    // RED BASELINE: before the fix, JSON.parse('123') returns 123, and
    // assigning a property on a number primitive throws TypeError in ESM
    // strict mode.
    const result = parseStdin('123', 'stop');
    expect(Array.isArray(result)).toBe(false);
    expect(result.hook_event_name).toBe('Stop');
  });

  it('degrades JSON array to a plain object (arrays are not records)', () => {
    // RED BASELINE: before the fix, JSON.parse('[1,2]') returns an array,
    // which is typeof 'object' but not a plain record — downstream handlers
    // indexing string keys would misbehave.
    const result = parseStdin('[1,2]', 'stop');
    expect(Array.isArray(result)).toBe(false);
    expect(result).toEqual({ hook_event_name: 'Stop' });
  });

  it('salvages identity fields from a payload mangled at its multi-byte section', () => {
    // Simulates the Windows VBS launcher's ANSI-codepage round trip: the UTF-8
    // payload breaks at the first multi-byte sequence (quote swallowed, tail
    // lost), but the ASCII head is intact. The degraded dispatch must still be
    // linked to the right session and tool.
    const mangled =
      '{"cwd":"D:\\\\proj","hookEventName":"PostToolUse","sessionId":"sess_abc-123"' +
      ',"toolName":"Bash","tool_response":{"content":"经验';
    const result = parseStdin(mangled, 'post-tool-use');
    expect(result.sessionId).toBe('sess_abc-123');
    expect(result.toolName).toBe('Bash');
    expect(result.cwd).toBe('D:\\proj');
    expect(result.hook_event_name).toBe('PostToolUse');
  });

  it('skips salvage fields whose value itself was truncated mid-string', () => {
    // The quote that closes transcript_path was swallowed by the codepage
    // round trip, so no intact value exists — the field must be absent rather
    // than garbage.
    const mangled = '{"sessionId":"sess_ok","transcript_path":"C:\\\\logs\\u4e2d';
    const result = parseStdin(mangled, 'stop');
    expect(result.sessionId).toBe('sess_ok');
    expect(result.transcript_path).toBeUndefined();
    expect(result.hook_event_name).toBe('Stop');
  });
});
/** A child that reports the given outcome once its listeners are attached. */
function fakePowerShell(code: number | null, error?: Error, output = '') {
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  let scheduled = false;
  const fire = (event: string, arg: unknown) => handlers.get(event)?.forEach((cb) => cb(arg));
  const stream = {
    on(event: string, cb: (chunk: Buffer) => void) {
      if (event === 'data' && output) setTimeout(() => cb(Buffer.from(output)), 0);
      return stream;
    },
  };
  const child = {
    stdout: stream,
    stderr: stream,
    on(event: string, cb: (...args: unknown[]) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), cb]);
      if (!scheduled) {
        scheduled = true;
        setTimeout(() => (error ? fire('error', error) : fire('close', code)), 5);
      }
      return child;
    },
  };
  return child;
}

/** Pull the payload path the helper appended to the WMI command line. */
function payloadFileOf(script: string): string | undefined {
  return /--stdin-file ([^',\s]+)/.exec(script)?.[1];
}

beforeEach(() => {
  mockSpawn.mockReset().mockReturnValue(fakePowerShell(0));
  // keep the shared debug.log free of test noise
  vi.spyOn(log, 'debug').mockImplementation(() => {});
});

/** Payload files this test created, so cleanup never touches anyone else's. */
const createdPayloads: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const f of createdPayloads.splice(0)) fs.rmSync(f, { force: true });
});

describe('trySpawnDetachedViaWmi', () => {
  it('creates the child through Win32_Process, hidden, with the payload as a file', async () => {
    await expect(trySpawnDetachedViaWmi(
      'C:\\node\\node.exe',
      ['C:\\cli\\index.js', 'hook-dispatch', '--matcher', 'a b'],
      { cwd: process.cwd(), stdin: '{"session_id":"abc"}', platform: 'win32' },
    )).resolves.toBe(true);

    const [command, argv, options] = mockSpawn.mock.calls[0] as [string, string[], { windowsHide?: boolean }];
    // absolute when the filesystem has one: the hook's PATH is the host's, not ours
    expect(command).toMatch(/powershell\.exe$/);
    expect(options.windowsHide).toBe(true);

    const script = argv[argv.length - 1];
    expect(script).toContain("[wmiclass]'Win32_Process'");
    expect(script).toContain('ShowWindow = [uint16]0');
    // the command line is one string, so args with spaces are quoted for CreateProcess…
    expect(script).toContain('"a b"');
    // …while the working directory is a plain (PowerShell-literal) path argument
    expect(script).toContain(`'${process.cwd()}'`);

    const file = payloadFileOf(script);
    expect(file).toBeTruthy();
    createdPayloads.push(file!);
    expect(fs.readFileSync(file!, 'utf8')).toBe('{"session_id":"abc"}');
  });

  it('substitutes a working directory when the payload has none', async () => {
    // An empty CurrentDirectory is ReturnValue 21 at the provider, and a
    // session-start payload often carries no cwd at all.
    await expect(trySpawnDetachedViaWmi('node', ['cli.js'], { platform: 'win32' })).resolves.toBe(true);

    const script = (mockSpawn.mock.calls[0][1] as string[]).at(-1)!;
    expect(script).toContain(`'${os.tmpdir()}'`);
  });

  it('reports failure and cleans up when the provider refuses (caller then falls back)', async () => {
    // Exit 3 is the provider refusing the call, which is definitive: no second attempt.
    mockSpawn.mockReturnValue(fakePowerShell(3, undefined, 'ReturnValue=21'));

    await expect(trySpawnDetachedViaWmi('node', ['cli.js'], { platform: 'win32', stdin: '{}' })).resolves.toBe(false);

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const script = (mockSpawn.mock.calls[0][1] as string[]).at(-1)!;
    const file = payloadFileOf(script);
    expect(file).toBeTruthy();
    createdPayloads.push(file!);
    expect(fs.existsSync(file!)).toBe(false);
  });

  it('retries with the cmdlet form when the script never reached the provider', async () => {
    // No ReturnValue in the output = the accelerator itself was rejected, which
    // is what a locked-down host looks like. The retry succeeds.
    mockSpawn
      .mockReturnValueOnce(fakePowerShell(1, undefined, "'[wmiclass]' is not recognized"))
      .mockReturnValueOnce(fakePowerShell(0));

    await expect(trySpawnDetachedViaWmi('node', ['cli.js'], { platform: 'win32' })).resolves.toBe(true);

    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect((mockSpawn.mock.calls[1][1] as string[]).at(-1)).toContain('Invoke-CimMethod');
  });

  it('reports failure when PowerShell itself cannot be started', async () => {
    // The realistic shape of a missing binary: an 'error' event, not a throw.
    // Fresh instance per attempt — each one reports its outcome exactly once.
    mockSpawn.mockImplementation(() => fakePowerShell(null, new Error('spawn powershell.exe ENOENT')));

    await expect(trySpawnDetachedViaWmi('node', ['cli.js'], { platform: 'win32' })).resolves.toBe(false);

    expect(mockSpawn).toHaveBeenCalledTimes(2); // both attempts tried
  });
});
