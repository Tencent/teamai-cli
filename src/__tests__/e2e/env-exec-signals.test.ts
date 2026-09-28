/**
 * E2E (#875, #879 S8): `teamai env exec` passes signals through as a direct
 * run would. A terminal's Ctrl-C (SIGINT) or Ctrl-\ (SIGQUIT) reaches the
 * whole foreground process group, so the command already has it: teamai must
 * not send it a second one, and must wait for the command to end. A signal
 * sent to teamai alone (SIGTERM) is passed on. A command that dies of a signal
 * Node survives (SIGPIPE) still gives 128 + its number.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, '..', '..', '..', 'dist', 'index.js');

/** Counts `argv[2]` signals and exits with the count 500 ms after the first. */
const COUNTER = [
  'let n = 0;',
  'process.on(process.argv[2], () => { if (++n === 1) setTimeout(() => process.exit(n), 500); });',
  'require("fs").writeFileSync(process.argv[1], "ready");',
  'setInterval(() => {}, 1000);',
].join('\n');

type Ended = { code: number | null; signal: NodeJS.Signals | null; stderr: string };

describe.skipIf(process.platform === 'win32')('teamai env exec: signals', () => {
  let tmpDir: string;
  let home: string;

  const cliEnv = (): NodeJS.ProcessEnv => {
    const { CLAUDE_CONFIG_DIR: _ignored, ...env } = process.env;
    return { ...env, HOME: home, USERPROFILE: home, FORCE_COLOR: '0', NO_COLOR: '1' };
  };

  /** Run `env exec -- <command>` as the leader of its own process group, as a terminal's foreground job. */
  function start(command: string[]): { pid: number; ended: Promise<Ended> } {
    const child = spawn('node', [CLI, 'env', 'exec', '--', ...command], {
      cwd: tmpDir, env: cliEnv(), detached: true, stdio: ['ignore', 'ignore', 'pipe'],
    });
    if (child.pid === undefined) throw new Error('teamai did not start');
    let stderr = '';
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
    const ended = new Promise<Ended>((resolve) => { child.on('close', (code, signal) => resolve({ code, signal, stderr })); });
    return { pid: child.pid, ended };
  }

  async function counting(signal: NodeJS.Signals): Promise<{ pid: number; ended: Promise<Ended> }> {
    const ready = path.join(tmpDir, `${signal}.ready`);
    const run = start([process.execPath, '-e', COUNTER, ready, signal]);
    for (let waited = 0; !fs.existsSync(ready); waited += 50) {
      if (waited > 20_000) throw new Error('the command did not start within 20 s');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return run;
  }

  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-env-exec-signals-')));
    home = path.join(tmpDir, 'home');
    fs.mkdirSync(home);
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it.each(['SIGINT', 'SIGQUIT'] as const)('a %s to the process group reaches the command once, and teamai exits with it', async (signal) => {
    const run = await counting(signal);

    process.kill(-run.pid, signal);

    expect(await run.ended).toMatchObject({ code: 1, signal: null });
  });

  it('passes a SIGTERM sent to teamai alone on to the command, once', async () => {
    const run = await counting('SIGTERM');

    process.kill(run.pid, 'SIGTERM');

    expect(await run.ended).toMatchObject({ code: 1, signal: null });
  });

  it('exits 141 when the command dies of SIGPIPE', async () => {
    const { ended } = start(['sh', '-c', 'kill -PIPE $$']);

    expect(await ended).toMatchObject({ code: 141, signal: null });
  });
});
