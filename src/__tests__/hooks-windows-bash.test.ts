import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// A developer machine may have a real Git for Windows InstallPath in HKLM, so
// the default registry locator would succeed and defeat the negative case.
// Replace execFileSync at the module boundary (builtin-hooks imports it as a
// named binding, which a bare spyOn on the default export cannot intercept);
// the registry-success path is instead covered by injecting a fake locator.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const boom = (() => { throw new Error('registry unreadable'); }) as unknown as typeof actual.execFileSync;
  return { ...actual, default: actual, execFileSync: boom };
});

import { getDispatchCommand, findGitBashWindows, _resetShellCache } from '../builtin-hooks.js';

// Windows resolves a bare `bash` to System32's WSL launcher before any PATH
// entry, and the WSL side has a different $HOME and no npm-global teamai — the
// hook then dies inside `2>/dev/null || true` with nothing logged. The
// injector must instead name Git Bash with an absolute path.

function makeFakeGit(root: string, relative: string[] = ['Programs', 'Git']): string {
  const bin = path.join(root, ...relative, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'bash.exe'), '');
  return path.join(bin, 'bash.exe');
}

const noRegistry = () => {
  throw new Error('unreachable in tests');
};

describe('findGitBashWindows', () => {
  it('finds Git under the LOCALAPPDATA candidate', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-gitbash-'));
    const exe = makeFakeGit(root);
    expect(findGitBashWindows({ LOCALAPPDATA: root }, path.join(root, 'nohome'), noRegistry)).toBe(exe);
  });

  it('finds Git under the machine-wide ProgramFiles candidate', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-gitbash-'));
    const exe = makeFakeGit(path.join(root, 'PF'), ['Git']);
    expect(findGitBashWindows({ ProgramFiles: path.join(root, 'PF') }, path.join(root, 'nohome'), noRegistry)).toBe(exe);
  });

  it('falls back to the registry InstallPath when no candidate exists', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-gitbash-'));
    const exe = makeFakeGit(root, ['Git']);
    const installDir = path.dirname(path.dirname(exe));
    const read = () => installDir;
    expect(
      findGitBashWindows(
        { ProgramFiles: path.join(root, 'm1'), 'ProgramFiles(x86)': path.join(root, 'm2'), LOCALAPPDATA: path.join(root, 'm3') },
        path.join(root, 'nohome'),
        read,
      ),
    ).toBe(exe);
  });

  it('returns null when neither candidates nor registry find Git', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-gitbash-empty-'));
    expect(
      findGitBashWindows({ ProgramFiles: root, 'ProgramFiles(x86)': root, LOCALAPPDATA: root }, root, () => null),
    ).toBeNull();
  });
});

describe('getDispatchCommand shell resolution', () => {
  afterEach(() => {
    _resetShellCache();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('POSIX keeps the bare bash form (golden-fixture compatibility)', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    expect(getDispatchCommand('stop', 'claude')).toBe(
      'bash -lc "teamai hook-dispatch stop --tool claude 2>/dev/null" || true',
    );
  });

  it('Windows names Git Bash by absolute, quoted, forward-slash path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-gitbash-'));
    const exe = makeFakeGit(root);
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.stubEnv('HOME', root);
    vi.stubEnv('ProgramFiles', path.join(root, 'missing-pf'));
    vi.stubEnv('ProgramFiles(x86)', path.join(root, 'missing-pf86'));
    vi.stubEnv('LOCALAPPDATA', root);
    const cmd = getDispatchCommand('stop', 'qoder');
    expect(cmd).toBe(
      '"' + exe.split(path.sep).join('/') + '" -lc "teamai hook-dispatch stop --tool qoder 2>/dev/null" || true',
    );
  });

  it('Windows keeps bare bash when Git Bash cannot be found', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-gitbash-empty-'));
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.stubEnv('HOME', root);
    vi.stubEnv('ProgramFiles', root);
    vi.stubEnv('ProgramFiles(x86)', root);
    vi.stubEnv('LOCALAPPDATA', root);
    // No execFileSync stub: the registry probe really runs, and no machine
    // records InstallPath under a freshly-created temp dir, so the locator
    // exhausts every source and the command must degrade to bare `bash`.
    expect(getDispatchCommand('stop', 'claude')).toBe(
      'bash -lc "teamai hook-dispatch stop --tool claude 2>/dev/null" || true',
    );
  });
});
