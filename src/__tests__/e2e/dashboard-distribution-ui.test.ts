import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
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
async function startDashboard(home: string): Promise<string> {
  const port = await freePort();
  child = spawn(process.execPath, [cli, 'dashboard', '--port', String(port)], { cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' }, stdio: 'pipe' });
  let output = ''; child.stdout?.on('data', b => output += b); child.stderr?.on('data', b => output += b);
  const deadline = Date.now() + 15000;
  while (!output.includes('Dashboard running') && Date.now() < deadline) { if (child.exitCode !== null) throw Error(output); await new Promise(r => setTimeout(r, 50)); }
  expect(output).toContain('Dashboard running');
  return `http://localhost:${port}`;
}

// The Distribution page (#1028): the served HTML ships the page, and its data
// route answers a configured workspace with the shape the page renders.
describe('dashboard distribution page (offline)', () => {
  it('serves the page wired to the distribution routes over a configured read', async () => {
    sandbox = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-distribution-ui-')));
    const home = path.join(sandbox, 'home'), teamHome = path.join(home, '.teamai');
    await fs.mkdir(path.join(teamHome, 'dashboard'), { recursive: true });
    const repo = path.join(sandbox, 'team-repo');
    const write = async (rel: string, content: string) => {
      await fs.mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
      await fs.writeFile(path.join(repo, rel), content);
    };
    await write('teamai.yaml', 'team: test\nrepo: owner/repo\n');
    await write('skills/frontend/ui-kit/SKILL.md', '# ui-kit\n');
    await write('manifest/roles.yaml', YAML.stringify({ version: 1, roles: [
      { id: 'frontend', description: 'Frontend delivery', resources: { knowledge: ['frontend'], skills: ['frontend'] } },
    ] }));
    await write('manifest/projects.yaml', YAML.stringify({ version: 1, projects: [{ id: 'pay', name: 'Payments', resources: { skills: ['payment'] } }] }));
    await fs.writeFile(path.join(teamHome, 'config.yaml'), YAML.stringify({
      repo: { localPath: repo, remote: 'owner/repo' }, username: 'tester', scope: 'user', primaryRole: 'frontend', additionalRoles: [], projects: [],
    }));

    const base = await startDashboard(home);

    const html = await (await fetch(base)).text();
    // The page exists, talks to the landed routes, and gates saving on a preview.
    expect(html).toContain("distribution: 'Distribution'");
    expect(html).toContain("'/api/distribution/preview'");
    expect(html).toContain('data-role-primary');
    expect(html).toContain('data-project');
    expect(html).toContain("(saving||!preview?' disabled':'')");
    expect(html).toContain('Saved. Takes effect on the next pull.');

    const read = await (await fetch(`${base}/api/distribution?workspace=user`)).json() as {
      configured: boolean; roles: { state: string; items?: Array<{ id: string; description?: string }> };
      projects: { state: string; items?: Array<{ id: string; name?: string }> };
      effective: { namespaces: Record<string, string[]> | null; skills: string[]; rules: string[] };
    };
    expect(read.configured).toBe(true);
    expect(read.roles.items?.map(role => role.id)).toEqual(['frontend']);
    expect(read.projects.items?.map(project => project.id)).toEqual(['pay']);
    // The page's effective card renders from these: the filtered namespaces and the delivered counts.
    expect(read.effective.namespaces?.skills).toEqual(['frontend']);
    expect(read.effective.skills).toEqual(['ui-kit']);
  }, 60_000);
});
