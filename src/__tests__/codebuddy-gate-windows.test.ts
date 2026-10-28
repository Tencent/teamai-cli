/**
 * #1446: CodeBuddy on Windows reads one `command` string from cmd.exe (IDE)
 * and Git Bash (Code). A POSIX project gate is a syntax error in cmd.exe, so a
 * project-scope team hook must run from a script both shells can launch.
 *
 * These tests force `process.platform` to win32, then drive the real
 * reconcile path with real files: the rendered command is the explicit Git
 * Bash launcher, the script holds the POSIX gate, and running it with bash
 * gates on cwd, passes stdin/stdout through and keeps exit 2.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { reconcileHooks } from '../hooks.js';
import type { HookDef } from '../types.js';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

function teamDef(over: Partial<HookDef> = {}): HookDef {
  return {
    source: 'team',
    key: 'lint',
    event: 'PostToolUse',
    matcher: 'Bash',
    command: 'printf "ran\\n"; exit 2',
    timeout: 15,
    description: '[teamai:hook:lint] run lint after bash',
    ...over,
  };
}

/** The team command this render wrote, wherever the format put it. */
function teamCommand(settings: string): string {
  const written = JSON.parse(fs.readFileSync(settings, 'utf8')) as {
    hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
  };
  for (const entries of Object.values(written.hooks)) {
    for (const entry of entries) {
      for (const hook of entry.hooks ?? []) {
        if (hook.command.includes('codebuddy-gates')) return hook.command;
      }
    }
  }
  throw new Error(`no codebuddy-gates command in ${settings}`);
}

describe('CodeBuddy project gate on Windows (#1446)', () => {
  let home = '';
  let project = '';

  beforeEach(() => {
    home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-codebuddy-gate-')));
    project = path.join(home, 'project');
    fs.mkdirSync(project);
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform);
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('renders a launcher both cmd.exe and Git Bash can run, and the script gates on cwd', async () => {
    const settings = path.join(home, '.codebuddy', 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, '{}');
    const manifest = path.join(home, '.teamai', 'managed-hooks.json');

    await reconcileHooks(settings, 'codebuddy', [teamDef()], {
      manifestPath: manifest,
      teamHookProjectRoot: project,
    });

    const command = teamCommand(settings);
    const launcher = /^bash "([^"]+[\\/]codebuddy-gates[\\/]lint-PostToolUse-[0-9a-f]{8}\.sh)"$/.exec(command);
    expect(launcher, command).not.toBeNull();
    expect(command).not.toContain('if [ "$PWD"');

    const script = fs.readFileSync(launcher![1], 'utf8');
    expect(script.startsWith('# teamai codebuddy project gate\n')).toBe(true);
    expect(script).toContain(`if [ "$PWD" = '${project}' ]`);
    expect(script).toContain('printf "ran\\n"; exit 2');

    // Inside the project: stdout and the blocking exit 2 reach CodeBuddy.
    const inside = spawnSync('/bin/bash', [launcher![1]], { cwd: project, encoding: 'utf8', input: '{"payload":1}' });
    expect(inside.stdout).toBe('ran\n');
    expect(inside.status).toBe(2);

    // Outside it: nothing runs and nothing blocks.
    const outsideDir = path.join(home, 'elsewhere');
    fs.mkdirSync(outsideDir);
    const outside = spawnSync('/bin/bash', [launcher![1]], { cwd: outsideDir, encoding: 'utf8', input: '{}' });
    expect(outside.stdout).toBe('');
    expect(outside.status).toBe(0);
  });

  it('re-renders into the same script and removes the entry with its record', async () => {
    const settings = path.join(home, '.codebuddy', 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, '{}');
    const manifest = path.join(home, '.teamai', 'managed-hooks.json');
    const opts = { manifestPath: manifest, teamHookProjectRoot: project };

    await reconcileHooks(settings, 'codebuddy', [teamDef()], opts);
    const firstCommand = teamCommand(settings);

    // A changed command keeps the hook's file name, so re-renders do not
    // accumulate one script per edit.
    await reconcileHooks(settings, 'codebuddy', [teamDef({ command: 'printf "changed\\n"' })], opts);
    expect(teamCommand(settings)).toBe(firstCommand);
    const file = /^bash "([^"]+)"$/.exec(firstCommand)![1];
    expect(fs.readFileSync(file, 'utf8')).toContain('printf "changed\\n"');

    await reconcileHooks(settings, 'codebuddy', [], opts);
    expect(fs.readFileSync(settings, 'utf8')).not.toContain('codebuddy-gates');
  });
});
