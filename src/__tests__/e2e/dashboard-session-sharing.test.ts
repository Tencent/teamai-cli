import { afterEach, describe, expect, it } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import YAML from 'yaml';
import { encodeCwdClaude } from '../../session-flow/fs.js';

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
async function startDashboard(home: string): Promise<string> {
  const port = await freePort();
  child = spawn(process.execPath, [cli, 'dashboard', '--port', String(port)], { cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' }, stdio: 'pipe' });
  let output = ''; child.stdout?.on('data', b => output += b); child.stderr?.on('data', b => output += b);
  const deadline = Date.now() + 15000;
  while (!output.includes('Dashboard running') && Date.now() < deadline) { if (child.exitCode !== null) throw Error(output); await new Promise(r => setTimeout(r, 50)); }
  expect(output).toContain('Dashboard running');
  return `http://localhost:${port}`;
}

const PROMPT = 'Rotate the PROMPT-SECRET-7 key';
const ANSWER = 'Rotated it as ANSWER-SECRET-9.';

/** A Claude session in `cwd`, captured in the user data home of `home` in `runMode`, idle for `idleHours`. */
async function captured(home: string, cwd: string, sessionId: string, runMode: 'attended' | 'unattended', idleHours: number): Promise<void> {
  const project = path.join(home, '.claude', 'projects', encodeCwdClaude(cwd));
  await fs.mkdir(project, { recursive: true });
  const file = path.join(project, `${sessionId}.jsonl`);
  await fs.writeFile(file, [
    { type: 'user', uuid: 'u1', parentUuid: null, cwd, sessionId, timestamp: '2026-10-20T10:00:00.000Z', message: { role: 'user', content: PROMPT } },
    { type: 'assistant', uuid: 'u2', parentUuid: 'u1', cwd, sessionId, timestamp: '2026-10-20T10:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: ANSWER }] } },
  ].map((line) => `${JSON.stringify(line)}\n`).join(''));
  const idleSince = new Date(Date.now() - idleHours * 60 * 60 * 1000);
  await fs.utimes(file, idleSince, idleSince);
  const dir = path.join(home, '.teamai', 'sessions', 'captures', 'claude-code', sessionId);
  await fs.mkdir(dir, { recursive: true });
  const captureId = `0b6f2a52-5d7e-4c7e-9a43-${sessionId.slice(-12)}`;
  await fs.writeFile(path.join(dir, `${captureId}.json`), JSON.stringify({ captureId, platform: 'claude-code', sessionId,
    capturedAt: idleSince.toISOString(), runMode, agent: { v: 1, tool: { name: 'claude' }, teamai: '1.0.0', driver: 'session' }, sessionFile: file }));
}

// The Session sharing panel (#1385) through the real CLI: its route answers a workspace with counts and setting
// names, and never with the text of the sessions it counts.
describe('dashboard session sharing (offline)', () => {
  it('answers whether the sessions of the workspace are published and scored, and what waits for which drain', async () => {
    sandbox = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-session-sharing-')));
    const home = path.join(sandbox, 'home'), teamHome = path.join(home, '.teamai'), repo = path.join(teamHome, 'team-repo');
    await fs.mkdir(path.join(teamHome, 'dashboard'), { recursive: true });
    await fs.mkdir(repo, { recursive: true });
    await fs.writeFile(path.join(repo, 'teamai.yaml'), 'team: sharing\nrepo: https://example.invalid/team.git\n');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: 'pipe' });
    git('init', '-b', 'main'); git('config', 'user.name', 'Sharing Test'); git('config', 'user.email', 'test@example.invalid'); git('add', '.'); git('commit', '-m', 'fixture');
    await fs.writeFile(path.join(teamHome, 'config.yaml'), YAML.stringify({
      repo: { kind: 'git', localPath: repo, remote: 'https://example.invalid/team.git' }, username: 'fixture', scope: 'user', enabledAgents: ['claude', 'pi'],
    }));
    const app = path.join(sandbox, 'app');
    await captured(home, app, '7c1e0000-0000-4000-8000-000000000001', 'attended', 7);
    await captured(home, app, '7c1e0000-0000-4000-8000-000000000002', 'unattended', 1);

    const base = await startDashboard(home);
    const response = await fetch(`${base}/api/session-sharing?workspace=user`);
    const served = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(served)).toMatchObject({
      configured: true,
      runMode: { mode: 'attended', source: 'default' },
      archive: 'teamai-reports',
      publish: { attended: { policy: 'ask' }, unattended: { policy: 'auto' } },
      unreadTools: ['pi'],
      captured: { attended: { active: 0, finished: 1 }, unattended: { waitingForDrain: 1 } },
      next: [{ mode: 'unattended', command: 'TEAMAI_MODE=unattended teamai score --drain' }],
    });
    for (const secret of [PROMPT, ANSWER, 'PROMPT-SECRET', '7c1e0000-0000-4000-8000', app, home]) expect(served).not.toContain(secret);
    expect(await (await fetch(`${base}/api/session-sharing?workspace=unassigned-missing`)).json()).toEqual({ error: 'Unknown workspace' });
  }, 60_000);
});
