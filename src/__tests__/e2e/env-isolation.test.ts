import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
// The setup makes the sandbox HOME and its bin in the worker's temporary
// directory, and gives this file a temporary directory of its own beside them.
const TMP = fs.realpathSync.native(path.dirname(os.tmpdir()));

// Fixture `git` runs the hooks teamai installs, and they call
// `PATH="$HOME/.teamai/bin:$PATH" teamai hook-dispatch ...`. Before the e2e
// setup isolated HOME and the binary, that ran the developer's installed teamai
// against the real ~/.teamai, so local runs diverged from CI.
describe('e2e environment', () => {
  it('runs with a sandboxed HOME and without the system git config', () => {
    expect(process.env.HOME?.startsWith(TMP)).toBe(true);
    expect(process.env.HOME).not.toBe(os.userInfo().homedir);
    expect(os.homedir()).toBe(process.env.HOME);
    expect(process.env.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(process.env.XDG_CONFIG_HOME).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('resolves a git hook\'s `teamai` to the dist under test', () => {
    const hookShell = (cmd: string) =>
      execFileSync('sh', ['-c', `PATH="$HOME/.teamai/bin:$PATH" ${cmd}`], { encoding: 'utf-8' }).trim();
    expect(hookShell('command -v teamai').startsWith(TMP)).toBe(true);
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as { version: string };
    expect(hookShell('teamai --version')).toContain(pkg.version);
  });

  it('gives fixture commits a git identity without the real ~/.gitconfig', () => {
    const name = execFileSync('git', ['config', '--global', 'user.name'], { encoding: 'utf-8' }).trim();
    expect(name).toBe('TeamAI E2E');
  });
});
