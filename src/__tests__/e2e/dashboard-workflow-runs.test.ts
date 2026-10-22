import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveProjectDataHome } from '../../config.js';
import type { RunState, WorkflowEnvelope } from '../../workflow/types.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../dist/index.js');
let dashboard: ChildProcess | undefined;
let repo = '';
afterEach(async () => {
  if (dashboard && dashboard.exitCode === null) { const exited = once(dashboard, 'exit'); dashboard.kill('SIGTERM'); await exited; }
  dashboard = undefined;
  if (repo) fs.rmSync(repo, { recursive: true, force: true });
});

function cli(args: string[]): Record<string, unknown> {
  const stdout = execFileSync(process.execPath, [CLI, ...args], { cwd: repo, env: { ...process.env, FORCE_COLOR: '0' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const envelope = JSON.parse(stdout.trim().split('\n').filter((line) => line.startsWith('{')).at(-1) ?? '{}') as WorkflowEnvelope;
  if ('error' in envelope) throw new Error(envelope.error.message);
  return envelope.data;
}
async function freePort(): Promise<number> {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve())); return port;
}
async function startDashboard(): Promise<string> {
  const port = await freePort();
  dashboard = spawn(process.execPath, [CLI, 'dashboard', '--port', String(port)], { cwd: repo, env: { ...process.env, NO_COLOR: '1' }, stdio: 'pipe' });
  let output = ''; dashboard.stdout?.on('data', (b: Buffer) => { output += b.toString(); }); dashboard.stderr?.on('data', (b: Buffer) => { output += b.toString(); });
  const deadline = Date.now() + 15000;
  while (!output.includes('Dashboard running') && Date.now() < deadline) { if (dashboard.exitCode !== null) throw Error(output); await new Promise((r) => setTimeout(r, 50)); }
  expect(output).toContain('Dashboard running');
  return `http://localhost:${port}`;
}

// The Workflow Runs page (#1088) through the real CLI: a run started and
// polled by `teamai workflow`, shown and answered by `teamai dashboard`.
describe('dashboard workflow runs', () => {
  it('shows a run waiting on a required approval and records the answer the page sends', async () => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-dashboard-runs-')));
    fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
    for (const args of [['init', '-q', '-b', 'main'], ['add', 'README.md'], ['commit', '-qm', 'initial'], ['remote', 'add', 'origin', 'http://127.0.0.1:9/team/workflow.git']]) execFileSync('git', args, { cwd: repo });
    execFileSync(process.execPath, [CLI, 'init', '--self', '--agent', 'claude', '--force'], { cwd: repo, stdio: 'ignore' });
    fs.mkdirSync(path.join(repo, '.teamai/workflows'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.teamai/workflows/ship.yaml'), [
      'schemaVersion: v1alpha1', 'name: ship', 'description: Ship a ticket.', 'inputs: { ticket: string }', 'steps:',
      '  - id: ship', '    approve: { message: "Ship {{ inputs.ticket }}?", required: true }', '    command: echo shipped',
    ].join('\n'));
    execFileSync(process.execPath, [CLI, 'pull'], { cwd: repo, stdio: 'ignore' });
    const run = String(cli(['workflow', 'start', 'ship', '--inputs', '{"ticket":"TICKET-SECRET-42"}']).run);
    const driver = { kind: 'local', machine: os.hostname(), workspace: repo, can: { hitl: true } };
    expect(cli(['workflow', 'next', run, '--json', JSON.stringify({ driver })])).toMatchObject({ hitl: { step: 'ship', pass: 1, required: true } });

    const base = await startDashboard();
    const html = await (await fetch(base)).text();
    expect(html).toContain("workflows: 'Workflow Runs'");
    expect(html).toContain("'/api/workflows/respond'");

    const workspaces = await (await fetch(`${base}/api/workspaces`)).json() as Array<{ id: string; scope: string; root: string }>;
    const workspace = workspaces.find((w) => w.scope === 'project' && w.root === repo)?.id;
    expect(workspace).toEqual(expect.any(String));
    const list = async () => await (await fetch(`${base}/api/workflows?workspace=${workspace}`)).text();
    const listed = await list();
    expect(JSON.parse(listed)).toMatchObject({ configured: true, local: [{ run, workflow: 'ship', status: 'running', waiting: ['ship'] }], reported: { state: 'ok' } });
    const detail = await (await fetch(`${base}/api/workflows/run?workspace=${workspace}&source=local&id=${run}`)).text();
    expect(JSON.parse(detail)).toMatchObject({ steps: [{ step: 'ship', pass: 1, status: 'waiting', gate: { kind: 'approve', required: true } }] });
    for (const served of [listed, detail, html]) expect(served).not.toMatch(/TICKET-SECRET-42|echo shipped|Ship \{\{/);

    const respond = (body: unknown, headers: Record<string, string>) => fetch(`${base}/api/workflows/respond?workspace=${workspace}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const answer = { run, step: 'ship', pass: 1, choice: 'yes' };
    const json = { 'Content-Type': 'application/json' };
    expect((await respond(answer, { ...json, Origin: 'https://evil.example' })).status).toBe(403);
    expect((await respond(answer, { 'Content-Type': 'text/plain', Origin: base })).status).toBe(403);
    expect((await respond(answer, json)).status).toBe(403);
    const stale = await respond({ ...answer, pass: 2 }, { ...json, Origin: base });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: expect.stringContaining('pass 2 was answered or replaced') });

    const answered = await respond(answer, { ...json, Origin: base });
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual({ answered: { step: 'ship', pass: 1, choice: 'yes', channel: 'dashboard' } });
    const state = JSON.parse(fs.readFileSync(path.join(await resolveProjectDataHome(repo), 'workflows/runs', `${run}.json`), 'utf8')) as RunState;
    expect(state.steps[0]?.answer).toMatchObject({ choice: 'yes', channel: 'dashboard', agent: false });
    expect(JSON.parse(await list())).toMatchObject({ local: [{ run, waiting: [] }] });
    expect(cli(['workflow', 'next', run, '--json', JSON.stringify({ driver })])).toMatchObject({ lease: { step: 'ship' } });
  }, 60_000);
});
