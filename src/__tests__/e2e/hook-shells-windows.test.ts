import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findGitBashWindows } from '../../bundled-runtime.js';
import { builtinHookDefs } from '../../builtin-hooks.js';
import { getUserHome } from '../../utils/home.js';

/** The SessionStart command teamai writes for `tool` on this machine. */
function sessionStartCommand(tool: string): string {
  const hook = builtinHookDefs(tool).find((def) => def.event === 'SessionStart');
  if (hook === undefined) throw new Error(`teamai writes no SessionStart hook for ${tool}`);
  return hook.command;
}

/** Whether the dispatcher logged that it ran `session-start` for `tool`. */
function dispatched(tool: string): boolean {
  const debugLog = path.join(getUserHome(), '.teamai', 'debug.log');
  return fs.existsSync(debugLog) && fs.readFileSync(debugLog, 'utf8').includes(`[hook-dispatch] session-start/${tool} `);
}

/**
 * One real `teamai hook-dispatch session-start` per Windows hook shell, with
 * the command the writers render. Proves the shell starts the CLI with the
 * dispatch arguments intact; not which field a tool reads from the reply.
 */
describe.runIf(process.platform === 'win32')('hook shells on Windows: session-start', () => {
  // The detached background pass starts in the payload's cwd, and Windows cannot
  // remove a process's cwd: the temp dir outlives the sandbox HOME.
  const input = JSON.stringify({ cwd: os.tmpdir(), session_id: 'hook-shells-windows' });

  it('Git Bash runs the bash form, as Claude Code does', () => {
    const gitBash = findGitBashWindows();
    if (gitBash === null) throw new Error('Git Bash is not installed on this runner');

    const run = spawnSync(gitBash, ['-c', sessionStartCommand('claude')], { input, encoding: 'utf8' });

    expect(run.status).toBe(0);
    expect(dispatched('claude')).toBe(true);
  });

  it('Windows PowerShell runs the PowerShell form, as DSH does', () => {
    const run = spawnSync('powershell.exe', ['-NoProfile', '-Command', sessionStartCommand('dsh')], { input, encoding: 'utf8' });

    expect(run.status).toBe(0);
    expect(dispatched('dsh')).toBe(true);
  });

  it('node runs teamai.cmd through a shell, as the Pi extension does', () => {
    const run = spawnSync('teamai.cmd', ['hook-dispatch', 'session-start', '--tool', 'pi'], { input, encoding: 'utf8', shell: true });

    expect(run.status).toBe(0);
    expect(dispatched('pi')).toBe(true);
  });
});
