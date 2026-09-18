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

describe('dashboard workspace scoping (offline)', () => {
  it('partitions sessions by installed project scope and linked worktree; unmatched go to unassigned', async () => {
    sandbox = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-scoping-e2e-')));
    const home = path.join(sandbox, 'home'), teamHome = path.join(home, '.teamai');
    await fs.mkdir(path.join(teamHome, 'dashboard'), { recursive: true });
    // User-scope config (so the user workspace resolves).
    await fs.writeFile(path.join(teamHome, 'config.yaml'), YAML.stringify({ username: 'fixture', scope: 'user' }));

    // A real git project + a linked worktree.
    const proj = path.join(sandbox, 'proj');
    await fs.mkdir(path.join(proj, '.teamai'), { recursive: true });
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }, stdio: 'pipe' });
    git(proj, 'init', '-b', 'main'); git(proj, 'config', 'user.name', 'T'); git(proj, 'config', 'user.email', 't@e.invalid');
    await fs.writeFile(path.join(proj, 'README.md'), '# proj\n');
    git(proj, 'add', '.'); git(proj, 'commit', '-m', 'init');
    const feat = path.join(sandbox, 'proj-feat');
    git(proj, 'worktree', 'add', feat, '-b', 'feat');

    // Project-scope config in the partition, keyed by an anchor file (dashboardWorkspaces reads projects/*/anchor).
    // Self mode: repo.localPath/businessRepoRoot are persisted pointing at the MAIN checkout, and
    // readConfigFrom must rebind them to the resolved projectRoot (PR #604 review #1).
    const partition = path.join(teamHome, 'projects', 'proj-partition');
    await fs.mkdir(partition, { recursive: true });
    await fs.writeFile(path.join(partition, 'anchor'), proj + '\n');
    await fs.writeFile(path.join(partition, 'config.yaml'), YAML.stringify({
      repo: { kind: 'self', localPath: path.join(proj, '.teamai'), remote: '', businessRepoRoot: proj },
      username: 'fixture', scope: 'project', projectRoot: proj,
    }));

    // Events: one session inside the project, one inside its linked worktree, one outside any project.
    const now = Date.now(), stamp = (o: number) => new Date(now + o).toISOString();
    const mk = (sid: string, cwd: string) => [
      { type: 'session_start', sessionId: sid, tool: 'claude', cwd, timestamp: stamp(-60_000) },
      { type: 'prompt_submit', sessionId: sid, tool: 'claude', cwd, promptSummary: `work in ${sid}`, timestamp: stamp(-59_000) },
    ];
    const events = [
      ...mk('in-project', path.join(proj, 'src')),
      ...mk('in-worktree', path.join(feat, 'src')),
      ...mk('outside', path.join(sandbox, 'elsewhere')),
    ];
    const eventsPath = path.join(teamHome, 'dashboard', 'events.jsonl');
    await fs.writeFile(eventsPath, events.map(e => JSON.stringify(e)).join('\n') + '\n');

    const port = await freePort(), base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [cli, 'dashboard', '--port', String(port)], { cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' }, stdio: 'pipe' });
    let output = ''; child.stdout?.on('data', b => output += b); child.stderr?.on('data', b => output += b);
    const deadline = Date.now() + 15000;
    while (!output.includes('Dashboard running') && Date.now() < deadline) { if (child.exitCode !== null) throw Error(output); await new Promise(r => setTimeout(r, 50)); }
    expect(output).toContain('Dashboard running');

    const workspaces: Array<{ id: string; scope: string; label: string }> = await (await fetch(base + '/api/workspaces')).json();
    const scopes = workspaces.map(w => w.scope).sort();
    expect(scopes).toContain('project');
    expect(scopes).toContain('unassigned');
    const projectWs = workspaces.find(w => w.scope === 'project')!;
    const userWs = workspaces.find(w => w.scope === 'user')!;
    const unassignedWs = workspaces.find(w => w.scope === 'unassigned')!;

    const sessionIds = async (id: string) =>
      ((await (await fetch(`${base}/api/sessions?workspace=${id}`)).json()) as Array<{ sessionId: string }>)
        .map(s => s.sessionId).sort();

    // Project scope owns both the in-project session AND the linked-worktree session.
    expect(await sessionIds(projectWs.id)).toEqual(['in-project', 'in-worktree']);
    // The outside session lands in unassigned, not in user scope.
    expect(await sessionIds(unassignedWs.id)).toEqual(['outside']);
    expect(await sessionIds(userWs.id)).toEqual([]);
    // Unknown workspace id is rejected.
    expect((await fetch(`${base}/api/sessions?workspace=does-not-exist`)).status).toBe(400);
  });
});
