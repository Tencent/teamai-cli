import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

const { mockSpawnSync } = vi.hoisted(() => ({ mockSpawnSync: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawnSync: mockSpawnSync,
}));

const { trySpawnDetachedViaWmi } = await import('../hook-dispatch-cli.js');

const isWindows = process.platform === 'win32';

/** Pull the payload path the helper appended to the WMI command line. */
function payloadFileOf(script: string): string | undefined {
  return /--stdin-file ([^',\s]+)/.exec(script)?.[1];
}

beforeEach(() => {
  mockSpawnSync.mockReset().mockReturnValue({ status: 0 });
});

afterEach(() => vi.restoreAllMocks());

describe.runIf(isWindows)('trySpawnDetachedViaWmi', () => {
  it('creates the child through Win32_Process, hidden, with the payload as a file', () => {
    expect(trySpawnDetachedViaWmi(
      'C:\\node\\node.exe',
      ['C:\\cli\\index.js', 'hook-dispatch', '--matcher', 'a b'],
      'C:\\work dir',
      '{"session_id":"abc"}',
    )).toBe(true);

    const [command, argv, options] = mockSpawnSync.mock.calls[0] as [string, string[], { windowsHide?: boolean }];
    expect(command).toBe('powershell.exe');
    expect(options.windowsHide).toBe(true);

    const script = argv[argv.length - 1];
    expect(script).toContain("[wmiclass]'Win32_Process'");
    expect(script).toContain('ShowWindow = 0');
    // the command line is one string, so args with spaces are quoted for CreateProcess…
    expect(script).toContain('"a b"');
    // …while the working directory is a plain (PowerShell-literal) path argument
    expect(script).toContain("'C:\\work dir'");

    const file = payloadFileOf(script);
    expect(file).toBeTruthy();
    expect(fs.readFileSync(file!, 'utf8')).toBe('{"session_id":"abc"}');
    fs.rmSync(file!, { force: true });
  });

  it('reports failure and cleans up when the provider refuses (caller then falls back)', () => {
    mockSpawnSync.mockReturnValue({ status: 1 });

    expect(trySpawnDetachedViaWmi('node', ['cli.js'], undefined, '{}')).toBe(false);

    const script = (mockSpawnSync.mock.calls[0][1] as string[]).at(-1)!;
    const file = payloadFileOf(script);
    expect(file).toBeTruthy();
    expect(fs.existsSync(file!)).toBe(false);
  });

  it('reports failure when PowerShell itself cannot be started', () => {
    mockSpawnSync.mockImplementation(() => {
      throw new Error('spawnSync powershell.exe ENOENT');
    });

    expect(trySpawnDetachedViaWmi('node', ['cli.js'], undefined, '{}')).toBe(false);
  });
});
