import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { COPILOT_RUNS_ENTRIES_SOURCE, claudeHookOtherHostSkip, claudeHookUsesPowerShell, copilotRunsEntries } from '../claude-hook-host.js';

// The shell guard runs COPILOT_RUNS_ENTRIES_SOURCE; the CLI runs copilotRunsEntries.
const guardRuns = new Function(`return ${COPILOT_RUNS_ENTRIES_SOURCE};`)() as (data: unknown) => unknown;

const hook = (fields: Record<string, unknown>) => ({ type: 'command', ...fields });

const FILES: Array<[string, unknown]> = [
  ['null', null],
  ['a non-object', 'hooks'],
  ['version 2', { version: 2, hooks: { sessionStart: [hook({ bash: 'a' })] } }],
  ['a version string', { version: '1', hooks: { sessionStart: [hook({ bash: 'a' })] } }],
  ['disableAllHooks', { version: 1, disableAllHooks: true, hooks: { sessionStart: [hook({ bash: 'a' })] } }],
  ['no hooks', { version: 1 }],
  ['hooks that are not an object', { version: 1, hooks: 'a' }],
  ['an event that is not an array', { version: 1, hooks: { sessionStart: { bash: 'a' } } }],
  ['a hook that is not a command', { version: 1, hooks: { sessionStart: [{ type: 'prompt', bash: 'a' }] } }],
  ['a null hook', { version: 1, hooks: { sessionStart: [null, hook({ bash: 'a' })] } }],
  ['every command field', { version: 1, hooks: { preToolUse: [hook({ bash: 'b', powershell: 'p', command: 'c', matcher: 'Bash' })] } }],
  ['a non-string command', { version: 1, hooks: { sessionStart: [hook({ bash: 1, command: 'c' })] } }],
  ['several events', {
    version: 1,
    hooks: { sessionStart: [hook({ bash: 'a' })], stop: [hook({ command: 'b', matcher: '*' }), hook({ powershell: 'c' })] },
  }],
];

describe('COPILOT_RUNS_ENTRIES_SOURCE', () => {
  it.each(FILES)('reads %s as copilotRunsEntries does', (_name, file) => {
    expect(guardRuns(file)).toEqual(copilotRunsEntries(file));
  });
});


describe('claudeHookOtherHostSkip on native Windows shells', () => {
  it('selects the shell Claude will use on Windows', () => {
    expect(claudeHookUsesPowerShell('win32', 'C:/Program Files/Git/bin/bash.exe')).toBe(false);
    expect(claudeHookUsesPowerShell('win32', null)).toBe(true);
    expect(claudeHookUsesPowerShell('linux', null)).toBe(false);
  });

  it('uses PowerShell guards instead of bash syntax for native PowerShell', () => {
    const guard = claudeHookOtherHostSkip('Stop', undefined, 'echo RAN', 'win32', null);
    expect(guard).toContain('$env:CURSOR_VERSION');
    expect(guard).toContain('Select-String');
    expect(guard).toContain('-Encoding UTF8');
    expect(guard).not.toContain('grep -q');
    expect(guard).not.toContain('2>/dev/null');
  });

  it('keeps the POSIX guard off Windows', () => {
    const guard = claudeHookOtherHostSkip('Stop', undefined, 'echo RAN', 'linux', null);
    expect(guard).toContain('grep -q');
    expect(guard).toContain('2>/dev/null');
    expect(guard).not.toContain('$env:CURSOR_VERSION');
  });

  const runNativeGuard = (shell: string) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-hook-powershell-'));
    try {
      const home = path.join(root, 'home');
      const project = path.join(root, 'project');
      fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
      fs.mkdirSync(path.join(project, '.github', 'hooks'), { recursive: true });
      fs.writeFileSync(path.join(home, '.cursor', 'hooks.json'), JSON.stringify({ hooks: { stop: [{ command: '--tool cursor' }] } }));
      const env = { ...process.env, HOME: home, USERPROFILE: home, CURSOR_VERSION: '1', COPILOT_PROJECT_DIR: project };
      const run = (event: string | undefined, extra: Record<string, string> = {}) => execFileSync(shell, ['-NoLogo', '-NoProfile', '-Command', `${claudeHookOtherHostSkip(event, undefined, 'Write-Output RAN', 'win32', null)}Write-Output RAN`], { env: { ...env, ...extra }, encoding: 'utf8' });
      expect(run('Stop')).toBe('');
      fs.rmSync(path.join(home, '.cursor', 'hooks.json'));
      expect(run(undefined)).toBe('RAN\r\n');

      // Match the CLI predicate: malformed version and non-array event values
      // must not suppress Claude's hook.
      fs.writeFileSync(path.join(project, '.github', 'hooks', 'teamai.json'), JSON.stringify({ version: '1', hooks: { Stop: { type: 'command', powershell: 'Write-Output RAN' } } }));
      expect(run('Stop', { CURSOR_VERSION: '' })).toBe('RAN\r\n');
      fs.writeFileSync(path.join(project, '.github', 'hooks', 'teamai.json'), JSON.stringify({ version: 1, hooks: { Stop: [{ type: 'command', powershell: 'Write-Output RAN' }] } }));
      expect(run('Stop', { CURSOR_VERSION: '' })).toBe('');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };

  for (const shell of ['powershell.exe', 'pwsh.exe']) {
    it.skipIf(spawnSync(shell, ['-NoLogo', '-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' }).status !== 0)(
      `runs the native ${shell} guard when available`,
      () => runNativeGuard(shell),
    );
  }
});
