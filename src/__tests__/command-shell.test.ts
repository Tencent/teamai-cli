import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { startGroupedCommand } from '../tool-launch/process-stop.js';
import { runShellCommand } from '../workflow/shell-command.js';

const dirs: string[] = [];
const VALUE = 'quoted "words" & echo injected > marker | %PATH% $HOME `id`';
const PRINT_VALUE = `"${process.execPath}" -e "process.stdout.write(process.argv[1])" "$VALUE"`;

function workdir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-command-shell-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('a team command reads "$NAME" from its env, on Windows too', () => {
  it('lets Git access a local file URL from a team command', async () => {
    const cwd = workdir();
    const repo = path.join(cwd, 'team repo.git');
    execFileSync('git', ['init', '--bare', '--quiet', repo]);
    const ran = await runShellCommand({ command: `git ls-remote "${pathToFileURL(repo).href}"`, cwd, env: { ...process.env } });

    expect(ran.exit, ran.output).toEqual({ kind: 'exited', code: 0 });
  });

  it('in a check or benchmark judge', async () => {
    const cwd = workdir();
    const ran = await runShellCommand({ command: PRINT_VALUE, cwd, env: { ...process.env, VALUE } });

    expect(ran.exit).toEqual({ kind: 'exited', code: 0 });
    expect(ran.output).toBe(VALUE);
    expect(fs.existsSync(path.join(cwd, 'marker'))).toBe(false);
  });

  it('in a workflow command step', async () => {
    const cwd = workdir();
    const ran = await startGroupedCommand({ command: PRINT_VALUE, cwd, env: { ...process.env, VALUE }, detached: false, group: path.join(cwd, 'group') }).exit;

    expect(ran.exitCode).toBe(0);
    expect(ran.stdout).toBe(VALUE);
    expect(fs.existsSync(path.join(cwd, 'marker'))).toBe(false);
  });
});
