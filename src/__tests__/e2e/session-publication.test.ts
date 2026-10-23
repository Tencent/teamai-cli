import { expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-session-publication-')));
  const home = path.join(root, 'home');
  const archive = path.join(root, 'archive');
  const remote = path.join(root, 'remote.git');
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, FORCE_COLOR: '0',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  delete env.CLAUDE_CONFIG_DIR;
  const git = (args: string[], cwd = root) => {
    const run = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    return run.stdout;
  };
  fs.mkdirSync(home);
  git(['init', '-q', '--bare', '-b', 'main', remote]);
  git(['clone', '-q', remote, archive]);
  const workspace = (n: number) => {
    const cwd = path.join(root, `workspace-${n}`);
    fs.mkdirSync(cwd);
    const id = `b491bc32-9df6-43cc-a90c-85fdf481199${n}`;
    const dir = path.join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), JSON.stringify({ sessionId: id, cwd, type: 'user', uuid: `u${n}`,
      timestamp: '2026-10-23T00:00:00Z', message: { role: 'user', content: `Archive session ${n}.` } }) + '\n');
    return cwd;
  };
  const push = (cwd: string, extra: NodeJS.ProcessEnv = {}) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'session', 'push', '--source', 'claude-code', '--cwd', cwd, '--repo-root', archive, '--scrub', '-y'],
      { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, output }));
  });
  const files = () => fs.readdirSync(archive, { recursive: true }).map(String).filter((p) => p.startsWith('sessions/') && fs.statSync(path.join(archive, p)).isFile());
  return { root, archive, remote, git, workspace, push, files };
}

it.runIf(process.platform !== 'win32')('serializes two archive writes through their Git push', async () => {
  const f = fixture();
  const gate = path.join(f.root, 'release');
  try {
    const a = f.workspace(1);
    const b = f.workspace(2);
    const entered = path.join(f.root, 'entered');
    fs.writeFileSync(path.join(f.remote, 'hooks', 'pre-receive'), `#!/bin/sh\ntouch '${entered}'\nwhile [ ! -f '${gate}' ]; do sleep 0.1; done\n`, { mode: 0o755 });
    const first = f.push(a);
    await expect.poll(() => fs.existsSync(entered), { timeout: 10_000 }).toBe(true);
    const second = f.push(b);
    // Keep the first remote transaction open while the second reaches the
    // same archive. Fixed code waits before changing its files or Git index.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    fs.writeFileSync(gate, 'go');
    const results = await Promise.all([first, second]);
    expect(results.map((r) => r.code), results.map((r) => r.output).join('\n')).toEqual([0, 0]);
    const index = JSON.parse(f.git(['show', 'main:sessions/_unattributed/_index.json'], f.remote));
    expect(index.sessions).toHaveLength(2);
    expect(f.git(['status', '--porcelain'], f.archive)).toBe('');
  } finally {
    fs.writeFileSync(gate, 'go');
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

it('removes an unindexed pair after a failed save and retries without a suffixed duplicate', async () => {
  const f = fixture();
  try {
    const cwd = f.workspace(1);
    const preload = path.join(f.root, 'fail-index.cjs');
    fs.writeFileSync(preload, `const fs=require('node:fs');const rename=fs.renameSync;fs.renameSync=(a,b)=>{if(String(b).endsWith('_index.json'))throw Error('injected index failure');return rename(a,b);};`);
    const failed = await f.push(cwd, { NODE_OPTIONS: `--require=${preload}` });
    expect(failed.code, failed.output).toBe(1);
    expect(failed.output).toContain('injected index failure');
    expect(f.files()).toEqual([]);
    const retry = await f.push(cwd);
    expect(retry.code, retry.output).toBe(0);
    expect(f.files().filter((p) => p.endsWith('.jsonl'))).toHaveLength(1);
    expect(f.files().some((p) => /_1\.(jsonl|meta\.json)$/.test(p))).toBe(false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
