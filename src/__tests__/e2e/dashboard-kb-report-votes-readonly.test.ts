import { afterEach, describe, expect, it } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import YAML from 'yaml';

const cli = path.resolve('dist/index.js');
let child: ChildProcess | undefined;
let sandbox = '';
afterEach(async () => {
  if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
  child = undefined;
  if (sandbox) await fs.rm(sandbox, { recursive: true, force: true });
});
async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve())); return port;
}

// The KB health report (viz) only aggregates votes, but it read them through
// loadUserVotes, which persists the v1 → v2 upgrade: opening the report
// rewrote every v1 votes file in the reports checkout (#972).
describe('dashboard /kb-report leaves v1 votes files alone (#972)', () => {
  it('serves the report from v1 votes without rewriting them', async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-kb-report-votes-'));
    const home = path.join(sandbox, 'home'), teamHome = path.join(home, '.teamai'), repo = path.join(teamHome, 'team-repo');
    await fs.mkdir(path.join(repo, 'docs'), { recursive: true });
    await fs.writeFile(path.join(repo, 'teamai.yaml'), YAML.stringify({ team: 'kb-votes', repo: 'https://example.invalid/team.git', provider: 'git' }));
    await fs.writeFile(path.join(repo, 'docs', 'guide.md'), '---\ntitle: Guide\n---\nTeam knowledge.\n');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: 'pipe' });
    git('init', '-b', 'main'); git('config', 'user.name', 'KB Test'); git('config', 'user.email', 'test@example.invalid'); git('add', '.'); git('commit', '-m', 'fixture');
    git('branch', 'teamai-reports'); git('worktree', 'add', path.join(teamHome, 'reports-wt'), 'teamai-reports');
    const votesFile = path.join(teamHome, 'reports-wt', 'votes', 'alice.yaml');
    await fs.mkdir(path.dirname(votesFile), { recursive: true });
    const v1 = 'votes:\n  guide:\n    at: 2026-06-01T00:00:00Z\n';
    await fs.writeFile(votesFile, v1);
    await fs.writeFile(path.join(teamHome, 'config.yaml'), YAML.stringify({ repo: { kind: 'git', localPath: repo, remote: 'https://example.invalid/team.git' }, username: 'alice', scope: 'user' }));

    const port = await freePort();
    child = spawn(process.execPath, [cli, 'dashboard', '--port', String(port)], { cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' }, stdio: 'pipe' });
    let output = ''; child.stdout?.on('data', b => output += b); child.stderr?.on('data', b => output += b);
    const deadline = Date.now() + 15000;
    while (!output.includes('Dashboard running') && Date.now() < deadline) { if (child.exitCode !== null) throw Error(output); await new Promise(r => setTimeout(r, 50)); }
    expect(output).toContain('Dashboard running');

    const res = await fetch(`http://127.0.0.1:${port}/kb-report`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Knowledge Base');
    expect(await fs.readFile(votesFile, 'utf-8')).toBe(v1);
  }, 30000);
});
