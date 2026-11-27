import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
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

/** Start the built dashboard with an isolated HOME; returns its base URL. */
async function startDashboard(home: string): Promise<string> {
  const port = await freePort();
  child = spawn(process.execPath, [cli, 'dashboard', '--port', String(port)], { cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' }, stdio: 'pipe' });
  let output = ''; child.stdout?.on('data', b => output += b); child.stderr?.on('data', b => output += b);
  const deadline = Date.now() + 15000;
  while (!output.includes('Dashboard running') && Date.now() < deadline) { if (child.exitCode !== null) throw Error(output); await new Promise(r => setTimeout(r, 50)); }
  expect(output).toContain('Dashboard running');
  return `http://localhost:${port}`;
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('dashboard distribution routes (offline)', () => {
  it('answers an unconfigured workspace, serializes saves, and never quotes an invalid manifest', async () => {
    sandbox = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-distribution-e2e-')));
    const home = path.join(sandbox, 'home'), teamHome = path.join(home, '.teamai');
    await fs.mkdir(path.join(teamHome, 'dashboard'), { recursive: true });
    const repo = path.join(sandbox, 'team-repo');
    const write = async (rel: string, content: string) => {
      await fs.mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
      await fs.writeFile(path.join(repo, rel), content);
    };
    await write('teamai.yaml', 'team: test\nrepo: owner/repo\n');
    await write('skills/frontend/ui-kit/SKILL.md', '# ui-kit\n');
    await write('skills/backend/api-kit/SKILL.md', '# api-kit\n');
    await write('manifest/roles.yaml', YAML.stringify({ version: 1, roles: [
      { id: 'frontend', resources: { knowledge: ['frontend'], skills: ['frontend'] } },
      { id: 'backend', resources: { knowledge: ['backend'], skills: ['backend'] } },
    ] }));
    await write('manifest/projects.yaml', YAML.stringify({ version: 1, projects: [{ id: 'pay', resources: { skills: ['payment'] } }] }));

    const base = await startDashboard(home);

    // Every write, on any route, must come from the dashboard page; a preflight is refused too.
    const foreign = { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' };
    expect((await fetch(`${base}/api/distribution/roles?workspace=user`, foreign)).status).toBe(403);
    expect((await fetch(`${base}/api/any-later-write-route`, foreign)).status).toBe(403);
    expect((await fetch(`${base}/api/distribution/roles?workspace=user`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } })).status).toBe(403);

    // Reads carry prompts and paths: no other origin may read them, and a DNS-rebound Host is refused.
    const sessions = await fetch(`${base}/api/sessions`, { headers: { Origin: 'https://evil.example' } });
    expect(sessions.status).toBe(200);
    expect(sessions.headers.get('access-control-allow-origin')).toBeNull();
    const rebound = await new Promise<number>((resolve, reject) => {
      http.get(`${base}/api/sessions`, { headers: { Host: `evil.example:${new URL(base).port}` } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }).on('error', reject);
    });
    expect(rebound).toBe(403);

    // No user config yet: the user workspace is unconfigured.
    expect(await (await fetch(`${base}/api/distribution?workspace=user`)).json()).toEqual({ configured: false });
    expect((await post(`${base}/api/distribution/roles?workspace=user`, { revision: 'x', primaryRole: 'backend' })).status).toBe(400);

    const configPath = path.join(teamHome, 'config.yaml');
    await fs.writeFile(configPath, YAML.stringify({
      repo: { localPath: repo, remote: 'owner/repo' }, username: 'tester', scope: 'user', primaryRole: 'frontend', additionalRoles: [], projects: [],
    }));
    const { revision } = await (await fetch(`${base}/api/distribution?workspace=user`)).json() as { revision: string };

    // Two saves from one preview: the second must see the first's change and be refused.
    const [roles, projects] = await Promise.all([
      post(`${base}/api/distribution/roles?workspace=user`, { revision, primaryRole: 'backend' }),
      post(`${base}/api/distribution/projects?workspace=user`, { revision, projects: ['pay'] }),
    ]);
    expect([roles.status, projects.status].sort()).toEqual([200, 409]);
    const saved = YAML.parse(await fs.readFile(configPath, 'utf8'));
    // Only the save that won is on disk; the refused one changed nothing.
    expect({ primaryRole: saved.primaryRole, projects: saved.projects })
      .toEqual(roles.status === 200 ? { primaryRole: 'backend', projects: [] } : { primaryRole: 'frontend', projects: ['pay'] });

    // An invalid manifest is reported without its contents.
    await write('manifest/roles.yaml', 'version: 1\ninternalNote: [INTERNAL-ONLY-MARKER\nroles: []\n');
    const read = await (await fetch(`${base}/api/distribution?workspace=user`)).text();
    expect(read).toContain('"state":"invalid"');
    expect(read).not.toContain('INTERNAL-ONLY-MARKER');
    const preview = await post(`${base}/api/distribution/preview?workspace=user`, { primaryRole: 'frontend' });
    expect(preview.status).toBe(409);
    expect(await preview.text()).not.toContain('INTERNAL-ONLY-MARKER');
  }, 60_000);
});
