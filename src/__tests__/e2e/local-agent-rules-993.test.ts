import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Real-CLI coverage for #993: the local agent of an HTTP-mode team removes the
// rule copy it installed, whose resource cache has no history and whose pull
// keeps no record, and keeps a member's file at that path.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

function runCLI(args: string[], env: Record<string, string>, cwd: string, stdin = '', onOutput?: (output: string) => void): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      env: { ...process.env, FORCE_COLOR: '0', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
    });
    let output = '';
    const append = (data: Buffer) => { output += data.toString(); onOutput?.(output); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.stdin.end(stdin);
    child.on('close', (code) => resolve({ code, output }));
  });
}

/** Bindings enrolling `dir`, as `teamai bind-project` there does: the local agent stays silent in a workspace without one. */
const enrolled = (dir: string) => ({ [dir]: { projectId: 0, projectName: '__pending__', boundAt: '2026-01-01T00:00:00.000Z' } });

describe('local-agent rules (#993)', () => {
  const sandboxes: string[] = [];
  beforeAll(() => {
    if (!fs.existsSync(CLI)) execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'pipe' });
  });
  afterEach(() => {
    for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  /**
   * An HTTP source in `home` whose `operation` (a Stop hook sync or plugin reconciliation)
   * has loaded its config and is paused on the server's reply until `release`. The
   * hook sync's reply asks it to install `late-rule` into CodeBuddy.
   */
  async function pausedHttpOperation(home: string, sandbox: string, operation: string, env: Record<string, string>) {
    const agentDir = path.join(home, '.teamai', 'local-agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(path.join(home, '.codebuddy'), { recursive: true });
    // A fresh update check keeps the Stop hook's update handler off the npm registry,
    // whose late reply would write ~/.teamai/state.json after an uninstall removed it.
    const statePath = path.join(home, '.teamai', 'state.json');
    const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
    fs.writeFileSync(statePath, JSON.stringify({ ...state, lastUpdateCheck: new Date().toISOString(), availableUpdate: null }));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    let endpoint = '';
    const server = createServer(async (request, response) => {
      if (request.url === '/late-rule.md') {
        response.end('# Team rule\n');
        return;
      }
      response.setHeader('Content-Type', 'application/json');
      if (request.url?.endsWith(operation === 'hook sync' ? '/local-agent/sync' : '/local-agent/get-config')) {
        started();
        await gate;
        response.end(JSON.stringify(operation === 'plugin reconciliation' ? { plugins: [] } : { ok: true, cmds: [{
          id: 1, type: 'install_rule', handle_type: 'rule', slug: 'late-rule', version: '1',
          scope: 'user', download_url: `${endpoint}/late-rule.md`,
        }] }));
        return;
      }
      response.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    fs.writeFileSync(path.join(agentDir, 'config.json'), JSON.stringify({ endpoint, createdAt: 'x', workspaceBindings: enrolled(sandbox) }));
    const run = runCLI(operation === 'plugin reconciliation' ? ['source', 'reconcile-plugins']
      : ['hook-dispatch', 'stop', '--tool', 'workbuddy', '--bg-only'], env, sandbox,
      JSON.stringify({ cwd: sandbox, hook_event_name: 'Stop', session_id: 'http-shutdown' }));
    return {
      agentDir, run, ready, release,
      close: async () => {
        release();
        await run;
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      },
    };
  }

  /** Run `args`, resolving `waiting` once it waits for the HTTP source lock. */
  function runWaitingForLock(args: string[], env: Record<string, string>, cwd: string) {
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    const run = runCLI(args, env, cwd, '', (output) => {
      if (output.includes('Waiting for the HTTP source sync')) started();
    });
    return { run, waiting };
  }

  it.each(['hook sync', 'plugin reconciliation'])('remove-http waits for in-flight %s before clearing source state', async (operation) => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-993-http-shutdown-')));
    sandboxes.push(sandbox);
    const home = path.join(sandbox, 'home');
    const env = { HOME: home };
    const sync = await pausedHttpOperation(home, sandbox, operation, env);
    let removal: ReturnType<typeof runCLI> | undefined;
    try {
      await sync.ready;
      const remove = runWaitingForLock(['source', 'remove-http'], env, sandbox);
      removal = remove.run;
      // Release the response after removal finishes or starts waiting for the active operation.
      await Promise.race([removal, remove.waiting]);
      sync.release();
      const [synced, removed] = await Promise.all([sync.run, removal]);
      expect(synced.code, synced.output).toBe(0);
      expect(removed.code, removed.output).toBe(0);
      expect(fs.existsSync(path.join(home, '.codebuddy', 'rules', 'late-rule.md')), `${synced.output}\n${removed.output}`).toBe(false);
      expect(JSON.parse(fs.readFileSync(path.join(sync.agentDir, 'config.json'), 'utf8'))).toEqual({ disabled: true });
      expect(fs.readdirSync(sync.agentDir), `${synced.output}\n${removed.output}`).toEqual(['config.json']);
    } finally {
      await Promise.all([sync.close(), removal]);
    }
  });

  /** A full user-scope git team install for WorkBuddy, whose uninstall plans from the team config. */
  async function installUserScopeTeam(sandbox: string, home: string, env: Record<string, string>) {
    const url = 'https://git.example.com/team/http-uninstall.git';
    const seed = path.join(sandbox, 'seed');
    const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, env: { ...process.env, ...env }, stdio: 'pipe' });
    fs.mkdirSync(seed, { recursive: true });
    fs.mkdirSync(path.join(home, '.workbuddy'), { recursive: true });
    fs.writeFileSync(path.join(seed, 'teamai.yaml'), `team: http-uninstall\nrepo: ${url}\nprovider: git\nreviewers: []\n`);
    git(['init', '-q', '-b', 'main'], seed);
    git(['add', '-A'], seed);
    git(['-c', 'user.email=e2e@example.com', '-c', 'user.name=e2e', 'commit', '-q', '-m', 'seed'], seed);
    git(['clone', '-q', '--bare', seed, path.join(sandbox, 'team.git')], sandbox);
    git(['config', '--global', `url.${path.join(sandbox, 'team.git')}.insteadOf`, url], sandbox);
    const init = await runCLI(['init', url, '--provider', 'git', '--agent', 'workbuddy', '--scope', 'user', '--force'], env, sandbox);
    expect(init.code, init.output).toBe(0);
  }

  it('a hook sync runs a server-pushed uninstall of the last tool, which holds the sync\'s lock', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-993-pushed-uninstall-')));
    sandboxes.push(sandbox);
    const home = path.join(sandbox, 'home');
    const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), GIT_CONFIG_NOSYSTEM: '1' };
    await installUserScopeTeam(sandbox, home, env);
    const agentDir = path.join(home, '.teamai', 'local-agent');
    fs.mkdirSync(agentDir, { recursive: true });
    const acks: Array<{ status: string; error: string }> = [];
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      response.setHeader('Content-Type', 'application/json');
      if (request.url?.endsWith('/ack')) acks.push(JSON.parse(body));
      response.end(JSON.stringify(request.url?.endsWith('/local-agent/sync') ? { ok: true, cmds: [{
        id: 1, type: 'uninstall_teamai', cmd: 'teamai uninstall --force --agent workbuddy',
      }] } : { ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    fs.writeFileSync(path.join(agentDir, 'config.json'), JSON.stringify({ endpoint, createdAt: 'x', workspaceBindings: enrolled(sandbox) }));
    try {
      const startedAt = Date.now();
      const synced = await runCLI(['hook-dispatch', 'stop', '--tool', 'workbuddy', '--bg-only'], env, sandbox,
        JSON.stringify({ cwd: sandbox, hook_event_name: 'Stop', session_id: 'pushed-uninstall' }));
      expect(synced.code, synced.output).toBe(0);
      expect(acks, synced.output).toEqual([expect.objectContaining({ status: 'success' })]);
      // The uninstall did not wait out the lock its own sync holds.
      expect(Date.now() - startedAt).toBeLessThan(20_000);
      expect(fs.existsSync(path.join(home, '.teamai', 'config.yaml')), synced.output).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it.each(['HTTP-only', 'user-scope team'])('uninstall of an %s install waits for an in-flight hook sync and leaves nothing it installed', async (install) => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-993-uninstall-http-')));
    sandboxes.push(sandbox);
    const home = path.join(sandbox, 'home');
    const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), GIT_CONFIG_NOSYSTEM: '1' };
    if (install === 'user-scope team') await installUserScopeTeam(sandbox, home, env);
    const sync = await pausedHttpOperation(home, sandbox, 'hook sync', env);
    let uninstall: ReturnType<typeof runCLI> | undefined;
    try {
      await sync.ready;
      const remove = runWaitingForLock(['uninstall', '--force'], env, sandbox);
      uninstall = remove.run;
      await Promise.race([uninstall, remove.waiting]);
      sync.release();
      const [synced, uninstalled] = await Promise.all([sync.run, uninstall]);
      const outputs = `${synced.output}\n${uninstalled.output}`;
      expect(synced.code, synced.output).toBe(0);
      expect(uninstalled.code, uninstalled.output).toBe(0);
      expect(uninstalled.output).toContain('teamai uninstalled');
      expect(fs.existsSync(path.join(home, '.codebuddy', 'rules', 'late-rule.md')), outputs).toBe(false);
      expect(fs.existsSync(path.join(home, '.teamai')), outputs).toBe(false);
    } finally {
      await Promise.all([sync.close(), uninstall]);
    }
  });

  it('remove-http disables the source after failed hook cleanup and removes the hook on retry', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-993-remove-http-')));
    sandboxes.push(sandbox);
    const home = path.join(sandbox, 'home');
    const agentDir = path.join(home, '.teamai', 'local-agent');
    const settingsPath = path.join(home, '.claude', 'settings.json');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const hook = { description: '[teamai:agent-hook:retry]', matcher: '*', hooks: [{ type: 'command', command: 'echo retry' }] };
    const repaired = JSON.stringify({ hooks: { SessionStart: [hook] }, personal: true });
    const broken = `${repaired},\n`;
    fs.writeFileSync(settingsPath, broken);
    fs.writeFileSync(path.join(agentDir, 'agent-hooks.json'), JSON.stringify({
      retry: { tool: 'claude', event: 'SessionStart', command: 'echo retry' },
    }));
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const env = { HOME: home, TEAMAI_HTTP_ENDPOINT: endpoint };
    fs.writeFileSync(path.join(agentDir, 'config.json'), JSON.stringify({ endpoint, token: 'fixture-token', createdAt: 'x', workspaceBindings: enrolled(sandbox) }));
    // Older HTTP installations can restore config.json from this file.
    fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), [
      'username: tester', 'updatePolicy: skip', 'repo:', '  kind: http', `  url: ${endpoint}`,
      `  localPath: ${path.join(home, '.teamai', 'team-repo')}`, `  remote: ${endpoint}`, '',
    ].join('\n'));
    const dispatch = () => runCLI(['hook-dispatch', 'stop', '--tool', 'claude', '--bg-only'], env, sandbox,
      JSON.stringify({ cwd: sandbox, hook_event_name: 'Stop', session_id: 'remove-http-retry' }));
    try {
      expect((await dispatch()).code).toBe(0);
      expect(requests).toBeGreaterThan(0);
      const removed = await runCLI(['source', 'remove-http'], env, sandbox);
      expect(removed.code, removed.output).toBe(1);
      expect(removed.output).toContain('HTTP source disabled, but removal is incomplete');
      expect(fs.readFileSync(settingsPath, 'utf8')).toBe(broken);
      expect(JSON.parse(fs.readFileSync(path.join(agentDir, 'agent-hooks.json'), 'utf8')).retry).toBeDefined();
      const beforeDispatch = requests;
      expect((await dispatch()).code).toBe(0);
      expect(requests).toBe(beforeDispatch);

      fs.writeFileSync(settingsPath, repaired);
      const retried = await runCLI(['source', 'remove-http'], env, sandbox);
      expect(retried.code, retried.output).toBe(0);
      expect(retried.output).toContain('HTTP source removed');
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      expect(settings.personal).toBe(true);
      expect(JSON.stringify(settings)).not.toContain('[teamai:agent-hook:retry]');
      expect(fs.existsSync(path.join(agentDir, 'agent-hooks.json'))).toBe(false);
      const afterRetry = requests;
      expect((await dispatch()).code).toBe(0);
      expect(requests).toBe(afterRetry);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('uninstall_rule removes the copy the local agent installed and keeps a member\'s file at that path', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-993-local-agent-rules-')));
    sandboxes.push(sandbox);
    const home = path.join(sandbox, 'home');
    const project = path.join(sandbox, 'project');
    fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    // Holds each detached worker's output open until it exits, so a run's close joins the sync it spawned.
    const workers = path.join(sandbox, 'workers');
    fs.mkdirSync(workers);
    const preload = path.join(sandbox, 'capture-workers.cjs');
    fs.writeFileSync(preload, [
      "const fs = require('node:fs');",
      "const cp = require('node:child_process');",
      `const workers = ${JSON.stringify(workers)};`,
      'const spawn = cp.spawn;',
      'cp.spawn = (command, args, options) => {',
      "  if (options?.detached) options = { ...options, stdio: [Array.isArray(options.stdio) ? options.stdio[0] : 'ignore', 'inherit', 'inherit'] };",
      '  const child = spawn(command, args, options);',
      "  if (options?.detached && child.pid) fs.writeFileSync(workers + '/' + child.pid + '.started', '');",
      '  return child;',
      '};',
      "require('node:module').syncBuiltinESMExports();",
      "process.on('exit', () => fs.writeFileSync(workers + '/' + process.pid + '.done', ''));",
    ].join('\n'));

    let endpoint = '';
    let phase: 'install' | 'uninstall' = 'install';
    const acks: Array<{ status: string }> = [];
    const rule = (id: number, action: string, slug: string) => ({
      id, type: `${action}_rule`, handle_type: 'rule', slug, version: '1',
      scope: 'workspace', workspace_path: project, download_url: `${endpoint}/${slug}.md`,
    });
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      request.on('end', () => {
        if (request.url?.endsWith('.md')) {
          response.end(`# ${path.basename(request.url, '.md')}\n\nTeam rule body.\n`);
          return;
        }
        response.setHeader('Content-Type', 'application/json');
        if (request.url?.endsWith('/commands/ack')) acks.push(JSON.parse(body));
        if (!request.url?.endsWith('/local-agent/sync')) {
          response.end(JSON.stringify({ ok: true }));
          return;
        }
        const cmds = phase === 'install'
          ? [rule(1, 'install', 'team-style'), rule(2, 'install', 'mine')]
          : [rule(3, 'uninstall', 'team-style'), rule(4, 'uninstall', 'mine')];
        response.end(JSON.stringify({ ok: true, cmds }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const env = { HOME: home, NODE_OPTIONS: `--require ${JSON.stringify(preload)}` };
    const sessionStart = () => runCLI(['hook-dispatch', 'session-start', '--tool', 'claude'], env, project,
      JSON.stringify({ cwd: project, session_id: `993-${phase}`, hook_event_name: 'SessionStart', source: 'startup' }));
    try {
      const agentDir = path.join(home, '.teamai', 'local-agent');
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, 'config.json'), JSON.stringify({ endpoint, token: 'fixture-token',
        localAgentId: 'fixture', createdAt: '2026-01-01T00:00:00.000Z', workspaceBindings: enrolled(project),
      }));
      const teamStyle = path.join(project, '.claude', 'rules', 'team-style.md');
      const mine = path.join(project, '.claude', 'rules', 'mine.md');

      const installed = await sessionStart();
      expect(installed.code, installed.output).toBe(0);
      expect(acks.map((ack) => ack.status), installed.output).toEqual(['success', 'success']);
      expect(fs.readFileSync(teamStyle, 'utf8')).toContain('Team rule body.');
      // The member replaces one copy with a file of their own.
      fs.writeFileSync(mine, '# Mine\n\nMy own rule.\n');

      phase = 'uninstall';
      const uninstalled = await sessionStart();
      expect(uninstalled.code, uninstalled.output).toBe(0);
      expect(acks.slice(2).map((ack) => ack.status), uninstalled.output).toEqual(['success', 'success']);
      expect(fs.existsSync(teamStyle)).toBe(false);
      expect(fs.readFileSync(mine, 'utf8')).toBe('# Mine\n\nMy own rule.\n');
      for (const file of fs.readdirSync(workers).filter((name) => name.endsWith('.started'))) {
        expect(fs.existsSync(path.join(workers, file.replace('.started', '.done'))), `Worker ${file} must exit before fixture cleanup`).toBe(true);
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
