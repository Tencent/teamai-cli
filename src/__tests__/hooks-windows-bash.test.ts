import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

import { getDispatchCommand, _resetShellCache } from '../builtin-hooks.js';
import { findGitBashWindows } from '../bundled-runtime.js';
import { getHookStatus, injectHooks, reconcileHooks } from '../hooks.js';
import type { HookDef } from '../types.js';

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
  beforeEach(() => _resetShellCache());

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

// Cursor's hooks.json has a single `command`, and the Windows desktop app runs
// that string through PowerShell. Inbox Windows PowerShell rejects `||`
// (`InvalidEndOfLine`); every PowerShell also needs `&` before a quoted path.
// Without the rewrite, bash and teamai never start. Copilot already stores this
// in a separate `powershell` field; Cursor has to put it in `command` itself.

type CursorHooksFile = {
  hooks: Record<string, Array<{ command: string; matcher?: string; timeout?: number }>>;
};

function cursorCommands(parsed: CursorHooksFile): string[] {
  return Object.values(parsed.hooks).flatMap((entries) => entries.map((entry) => entry.command));
}

describe('Cursor hook command on Windows PowerShell', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-cursor-ps-'));
    _resetShellCache();
  });

  afterEach(() => {
    _resetShellCache();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function stubWindows(git: 'found' | 'absent'): string | null {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.stubEnv('HOME', tmp);
    if (git === 'absent') {
      vi.stubEnv('ProgramFiles', tmp);
      vi.stubEnv('ProgramFiles(x86)', tmp);
      vi.stubEnv('LOCALAPPDATA', tmp);
      _resetShellCache();
      return null;
    }
    const exe = makeFakeGit(tmp);
    vi.stubEnv('ProgramFiles', path.join(tmp, 'missing-pf'));
    vi.stubEnv('ProgramFiles(x86)', path.join(tmp, 'missing-pf86'));
    vi.stubEnv('LOCALAPPDATA', tmp);
    _resetShellCache();
    return exe;
  }

  it('rewrites every builtin with the call operator when Git Bash is installed', async () => {
    const exe = stubWindows('found');
    const hooksPath = path.join(tmp, 'hooks.json');
    await injectHooks(hooksPath, 'cursor');
    const parsed = JSON.parse(fs.readFileSync(hooksPath, 'utf8')) as CursorHooksFile;
    const bashExe = exe!.split(path.sep).join('/');
    const commands = cursorCommands(parsed);

    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command).toMatch(
        new RegExp(`^& "${bashExe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" -lc "teamai hook-dispatch \\S+ --tool cursor(?: --matcher \\S+)? 2>/dev/null"; exit 0$`),
      );
      expect(command).not.toContain('||');
    }
    expect(parsed.hooks.beforeSubmitPrompt).toEqual([{
      command: `& "${bashExe}" -lc "teamai hook-dispatch prompt-submit --tool cursor 2>/dev/null"; exit 0`,
      timeout: 10,
    }]);
    expect(parsed.hooks.postToolUse[1]).toMatchObject({ matcher: 'TodoWrite', timeout: 3 });
    expect(await getHookStatus(hooksPath, 'cursor')).toBe('installed');

    const again = fs.readFileSync(hooksPath, 'utf8');
    await injectHooks(hooksPath, 'cursor');
    expect(fs.readFileSync(hooksPath, 'utf8')).toBe(again);
  });

  it('calls teamai directly when Git Bash cannot be found', async () => {
    stubWindows('absent');
    const hooksPath = path.join(tmp, 'hooks.json');
    await injectHooks(hooksPath, 'cursor');
    const parsed = JSON.parse(fs.readFileSync(hooksPath, 'utf8')) as CursorHooksFile;
    const commands = cursorCommands(parsed);

    expect(parsed.hooks.beforeSubmitPrompt[0].command).toBe(
      'teamai hook-dispatch prompt-submit --tool cursor 2>$null; exit 0',
    );
    for (const command of commands) {
      expect(command).toMatch(/^teamai hook-dispatch \S+ --tool cursor(?: --matcher \S+)? 2>\$null; exit 0$/);
      expect(command).not.toContain('||');
      expect(command).not.toContain('-lc');
      expect(command).not.toContain('bash');
    }
    expect(await getHookStatus(hooksPath, 'cursor')).toBe('installed');
  });

  it('replaces a previously injected PowerShell-invalid command instead of appending', async () => {
    const exe = stubWindows('found');
    const bashExe = exe!.split(path.sep).join('/');
    const legacy = (event: string, matcher?: string) =>
      `"${bashExe}" -lc "teamai hook-dispatch ${event} --tool cursor${matcher ? ` --matcher ${matcher}` : ''} 2>/dev/null" || true`;
    const hooksPath = path.join(tmp, 'hooks.json');
    fs.writeFileSync(hooksPath, JSON.stringify({
      version: 1,
      hooks: {
        sessionStart: [{ command: legacy('session-start'), timeout: 15 }],
        stop: [{ command: legacy('stop'), timeout: 15 }],
        postToolUse: [
          { command: legacy('post-tool-use'), timeout: 10 },
          { command: legacy('post-tool-use', 'TodoWrite'), timeout: 3, matcher: 'TodoWrite' },
        ],
        beforeSubmitPrompt: [{ command: legacy('prompt-submit'), timeout: 10 }],
      },
    }));

    expect(await getHookStatus(hooksPath, 'cursor')).toBe('missing');
    await injectHooks(hooksPath, 'cursor');
    const parsed = JSON.parse(fs.readFileSync(hooksPath, 'utf8')) as CursorHooksFile;

    expect(parsed.hooks.beforeSubmitPrompt).toHaveLength(1);
    expect(parsed.hooks.postToolUse).toHaveLength(2);
    expect(parsed.hooks.beforeSubmitPrompt[0].command).toBe(
      `& "${bashExe}" -lc "teamai hook-dispatch prompt-submit --tool cursor 2>/dev/null"; exit 0`,
    );
    expect(cursorCommands(parsed).some((command) => command.includes('||'))).toBe(false);
    expect(await getHookStatus(hooksPath, 'cursor')).toBe('installed');
  });

  it('leaves a team-authored command unchanged, including one that itself contains ||', async () => {
    stubWindows('found');
    const hooksPath = path.join(tmp, 'hooks.json');
    const team: HookDef = {
      source: 'team',
      key: 'echo-ok',
      event: 'Stop',
      command: 'echo hello || true',
      description: '[teamai:hook:echo-ok] echo',
    };
    await reconcileHooks(hooksPath, 'cursor', [team]);
    const parsed = JSON.parse(fs.readFileSync(hooksPath, 'utf8')) as CursorHooksFile;
    const stop = parsed.hooks.stop.map((entry) => entry.command);

    expect(stop).toContain('echo hello || true');
    expect(stop.some((command) => command.startsWith('& ') && command.includes('hook-dispatch stop --tool cursor'))).toBe(true);
  });

  it('keeps the bash fail-open form when Cursor is injected on POSIX', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    _resetShellCache();
    const hooksPath = path.join(tmp, 'hooks.json');
    await injectHooks(hooksPath, 'cursor');
    const parsed = JSON.parse(fs.readFileSync(hooksPath, 'utf8')) as CursorHooksFile;
    expect(parsed.hooks.beforeSubmitPrompt[0].command).toBe(
      'bash -lc "teamai hook-dispatch prompt-submit --tool cursor 2>/dev/null" || true',
    );
  });
});
