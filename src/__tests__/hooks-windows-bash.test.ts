import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

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

type ClaudeHooksFile = {
  hooks: Record<string, Array<{ description?: string; hooks: Array<{ command: string; shell?: string }> }>>;
};

function cursorCommands(parsed: CursorHooksFile): string[] {
  return Object.values(parsed.hooks).flatMap((entries) => entries.map((entry) => entry.command));
}

describe('Claude team-hook shell on Windows', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-claude-shell-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const team: HookDef = {
    source: 'team',
    key: 'bash-command',
    event: 'SessionStart',
    command: 'if [ -f README.md ]; then echo RAN; fi',
    description: '[teamai:hook:bash-command] bash command',
  };

  const shellFor = async (git: 'found' | 'absent'): Promise<{ command: string; shell?: string }> => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.stubEnv('HOME', tmp);
    if (git === 'found') makeFakeGit(tmp);
    vi.stubEnv('ProgramFiles', path.join(tmp, 'missing-pf'));
    vi.stubEnv('ProgramFiles(x86)', path.join(tmp, 'missing-pf86'));
    vi.stubEnv('LOCALAPPDATA', git === 'found' ? tmp : path.join(tmp, 'missing-local'));
    const hooksPath = path.join(tmp, `${git}.json`);
    await reconcileHooks(hooksPath, 'claude', [team]);
    const parsed = JSON.parse(fs.readFileSync(hooksPath, 'utf8')) as ClaudeHooksFile;
    const entry = parsed.hooks.SessionStart.find((matcher) => matcher.description === team.description)?.hooks[0];
    if (!entry) throw new Error('missing team hook');
    return entry;
  };

  it('keeps Git Bash commands POSIX when Git Bash is installed', async () => {
    const entry = await shellFor('found');
    expect(entry.command).toContain('if [ -f README.md ]; then echo RAN; fi');
    expect(entry.command).toContain('grep -q');
    expect(entry.shell).toBeUndefined();
  });

  it('pins the PowerShell guard only when Git Bash is unavailable', async () => {
    await expect(shellFor('absent')).resolves.toMatchObject({
      command: expect.stringContaining('if [ -f README.md ]; then echo RAN; fi'),
      shell: 'powershell',
    });
    await expect(shellFor('absent')).resolves.toMatchObject({ command: expect.stringContaining('$env:CURSOR_VERSION') });
  });

  it('uses and executes a PowerShell project gate when Git Bash is unavailable', async () => {
    const hostPlatform = process.platform;
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.stubEnv('HOME', tmp);
    vi.stubEnv('ProgramFiles', path.join(tmp, 'missing-pf'));
    vi.stubEnv('ProgramFiles(x86)', path.join(tmp, 'missing-pf86'));
    vi.stubEnv('LOCALAPPDATA', path.join(tmp, 'missing-local'));
    const projectRoot = path.join(tmp, 'project');
    const childRoot = path.join(projectRoot, 'child');
    const laterChildRoot = path.join(projectRoot, 'later-child');
    fs.mkdirSync(childRoot, { recursive: true });
    const hooksPath = path.join(tmp, 'project-gated.json');
    const manifestPath = path.join(tmp, 'managed-hooks.json');
    const powershellTeam: HookDef = {
      ...team,
      command: 'Write-Output TEAMAI_POWERSHELL_GATE',
    };
    const readEntry = (): { command: string; shell?: string } => {
      const parsed = JSON.parse(fs.readFileSync(hooksPath, 'utf8')) as ClaudeHooksFile;
      const entry = parsed.hooks.SessionStart.find((matcher) => matcher.description === team.description)?.hooks[0];
      if (!entry) throw new Error('missing project-gated team hook');
      return entry;
    };

    await reconcileHooks(hooksPath, 'claude', [powershellTeam], {
      manifestPath,
      teamHookProjectRoot: projectRoot,
      teamHookChildRoots: [childRoot],
    });
    let entry = readEntry();
    expect(entry.shell).toBe('powershell');
    expect(entry.command).toContain('$teamaiPwd = $PWD.Path; if (');
    expect(entry.command).toContain('Write-Output TEAMAI_POWERSHELL_GATE');
    expect(entry.command).not.toContain('if [ "$PWD"');
    expect(entry.command).toContain('child');

    // A held entry can outlive its manifest record. Re-gating it for a later
    // workspace child must preserve the PowerShell form instead of appending a
    // POSIX wrapper that Claude cannot parse.
    fs.mkdirSync(laterChildRoot, { recursive: true });
    fs.writeFileSync(manifestPath, '{}');
    await reconcileHooks(hooksPath, 'claude', [], {
      manifestPath,
      teamHookProjectRoot: projectRoot,
      teamHookChildRoots: [childRoot, laterChildRoot],
      heldTeamHookIds: [powershellTeam.key],
      teamHookHistory: async () => [powershellTeam],
    });
    entry = readEntry();
    expect(entry.shell).toBe('powershell');
    expect(entry.command).toContain('later-child');
    expect(entry.command).not.toContain('if [ "$PWD"');

    if (hostPlatform === 'win32') {
      const probe = spawnSync('powershell.exe', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' });
      if (!probe.error) {
        const inside = spawnSync('powershell.exe', ['-NoProfile', '-Command', entry.command], { cwd: projectRoot, encoding: 'utf8' });
        const child = spawnSync('powershell.exe', ['-NoProfile', '-Command', entry.command], { cwd: childRoot, encoding: 'utf8' });
        const laterChild = spawnSync('powershell.exe', ['-NoProfile', '-Command', entry.command], { cwd: laterChildRoot, encoding: 'utf8' });
        expect(inside.error).toBeUndefined();
        expect(inside.status).toBe(0);
        expect(inside.stdout).toContain('TEAMAI_POWERSHELL_GATE');
        expect(child.error).toBeUndefined();
        expect(child.status).toBe(0);
        expect(child.stdout).not.toContain('TEAMAI_POWERSHELL_GATE');
        expect(laterChild.error).toBeUndefined();
        expect(laterChild.status).toBe(0);
        expect(laterChild.stdout).not.toContain('TEAMAI_POWERSHELL_GATE');
      }
    }
  });

  it('retains PowerShell-gated manifest records outside a project scope', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.stubEnv('HOME', tmp);
    vi.stubEnv('ProgramFiles', path.join(tmp, 'missing-pf'));
    vi.stubEnv('ProgramFiles(x86)', path.join(tmp, 'missing-pf86'));
    vi.stubEnv('LOCALAPPDATA', path.join(tmp, 'missing-local'));
    const projectRoot = path.join(tmp, 'project');
    const hooksPath = path.join(tmp, 'retained-project-gate.json');
    const manifestPath = path.join(tmp, 'managed-hooks.json');
    fs.mkdirSync(projectRoot, { recursive: true });

    await reconcileHooks(hooksPath, 'claude', [team], { manifestPath, teamHookProjectRoot: projectRoot });
    const before = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { claude?: Array<{ command: string }> };
    expect(before.claude).toHaveLength(1);
    expect(before.claude?.[0]?.command?.startsWith('$teamaiPwd = $PWD.Path; if (')).toBe(true);

    // A later shared-HOME reconciliation has no project root. It must retain
    // this existing project record just as it retains the POSIX gate form.
    await reconcileHooks(hooksPath, 'claude', [], { manifestPath });
    const after = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { claude?: Array<{ command: string }> };
    expect(after.claude).toEqual(before.claude);
  });
});

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
