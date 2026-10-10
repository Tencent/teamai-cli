/**
 * E2E (#915): with the workspace's git exclude flag on, the HTTP local agent
 * installs a project's MCP servers in the tool's local scope, as a pull does,
 * instead of the project's `.mcp.json`:
 *
 * - Claude: `~/.claude.json` → `projects[<main checkout>].mcpServers`;
 * - CodeBuddy: `~/.codebuddy.json` → `projects[<worktree root>].mcpServers`.
 *
 * `uninstall_mcp` and `teamai uninstall` take out exactly what it installed
 * there, and so does an uninstall that finds no configuration, which keeps
 * teamai's home while a server stays in a file it cannot read. A server it
 * installed in `.mcp.json` earlier moves at its next sync;
 * a copy the member changed stays, and is named. `git status` never shows an
 * MCP file.
 *
 * Runs the built CLI against an in-process mock backend, so the CLI is spawned
 * asynchronously. Each case gets its own HOME and repository.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackDetachedProcesses } from '../helpers/detached-processes.js';
import { startMockServer, type MockCommand, type MockServerHandle } from '../helpers/mock-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, '..', '..', '..', 'dist', 'index.js');
const API_KEY = 'e2e-http-key';
const TOKEN = 'local-agent-token-915';
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};
const MY_LOCAL = { type: 'http', url: 'https://mine.example.com/mcp' };
const ELSEWHERE = { '/elsewhere/project': { mcpServers: { 'my-other': { type: 'stdio', command: 'other', args: [] } } } };

interface Run { code: number | null; output: string }
type ToolJson = Record<string, unknown> & { projects?: Record<string, { mcpServers?: Record<string, { url?: string }> }> };

let sandbox: string;
let detached: ReturnType<typeof trackDetachedProcesses>;
let server: MockServerHandle;

beforeAll(async () => {
  sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-local-agent-mcp-915-')));
  detached = trackDetachedProcesses(sandbox);
  server = await startMockServer({ apiKey: API_KEY });
});

afterAll(async () => {
  await detached?.waitForExit();
  await server?.close();
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

function machine(name: string) {
  const base = fs.mkdtempSync(path.join(sandbox, `${name}-`));
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  const claudeJson = path.join(home, '.claude.json');
  const codebuddyJson = path.join(home, '.codebuddy.json');
  const env: NodeJS.ProcessEnv = {
    ...process.env, ...GIT_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1', SHELL: '/bin/bash', FORCE_COLOR: '0',
    NODE_OPTIONS: [process.env.NODE_OPTIONS, detached.nodeOptions].filter(Boolean).join(' '),
  };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEBUDDY_CONFIG_DIR;
  delete env.TEAMAI_API_TOKEN;
  delete env.TEAMAI_API_KEY;
  const git = (args: string[], cwd: string): { code: number | null; out: string } => {
    const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  // Spawned asynchronously: the mock backend runs in this process.
  const cli = (args: string[], cwd: string, input?: string): Promise<Run> => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { output += String(chunk); });
    child.on('close', (code) => resolve({ code, output }));
    child.stdin.end(input ?? '');
  });
  const readJson = (file: string): ToolJson => JSON.parse(fs.readFileSync(file, 'utf8')) as ToolJson;
  return {
    base,
    home,
    git,
    cli,
    claudeJson,
    codebuddyJson,
    readJson,
    status: (cwd: string): string[] => git(['status', '--porcelain', '-uall'], cwd).out.split('\n').filter(Boolean),
    /** A committed repository with teamai initialized in HTTP mode, project scope, where Claude and CodeBuddy are set up. */
    async project(dir: string): Promise<string> {
      const root = path.join(base, dir);
      fs.mkdirSync(root);
      fs.writeFileSync(path.join(root, 'README.md'), `# ${dir}\n`);
      git(['init', '-q', '-b', 'main'], root);
      git(['add', '-A'], root);
      git(['commit', '-q', '-m', dir], root);
      const real = fs.realpathSync.native(root);
      // HTTP mode delivers nothing to a tool with no root in the project.
      fs.mkdirSync(path.join(real, '.claude'));
      fs.mkdirSync(path.join(real, '.codebuddy'));
      const init = await cli(['init', '--http', server.url, '--token', API_KEY, '--scope', 'project', '--agent', 'claude,codebuddy', '--force'], real);
      expect(init.code, init.output).toBe(0);
      // What the member already has in both tools' local scopes: none of it is teamai's.
      for (const file of [claudeJson, codebuddyJson]) {
        fs.writeFileSync(file, JSON.stringify({ numStartups: 3, projects: { ...ELSEWHERE, [real]: { allowedTools: [], mcpServers: { 'my-local': MY_LOCAL } } } }, null, 2));
      }
      return real;
    },
    /** The member's git exclude override in the project's partition config. */
    setFlag(project: string, on: boolean): void {
      const projects = path.join(home, '.teamai', 'projects');
      const config = fs.readdirSync(projects).map((d) => path.join(projects, d, 'config.yaml'))
        .find((file) => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(`projectRoot: ${project}\n`));
      if (!config) throw new Error(`no partition config for ${project}`);
      const lines = fs.readFileSync(config, 'utf8').split('\n').filter((line) => !line.startsWith('gitExcludeEnabled:'));
      fs.writeFileSync(config, [...lines.filter(Boolean), `gitExcludeEnabled: ${on}`, ''].join('\n'));
    },
    async sessionStart(cwd: string, tool: 'claude' | 'codebuddy', commands: MockCommand[]): Promise<Run> {
      server.seedCommands(commands);
      const run = await cli(['hook-dispatch', 'session-start', '--tool', tool], cwd,
        JSON.stringify({ cwd, session_id: `s-${path.basename(cwd)}`, hook_event_name: 'SessionStart', source: 'startup' }));
      await detached.waitForExit();
      expect(run.code, run.output).toBe(0);
      return run;
    },
  };
}

/** An HTTP server carrying a credential, or a stdio one with nothing that may be one (no URL, argument or env value). */
const installMcp = (id: number, slug: string, workspace: string, credential = true): MockCommand => ({
  id, type: 'install_mcp', scope: 'workspace', workspace_path: workspace, slug, version: '1.0.0',
  mcp_config: credential
    ? { transport: 'http', url: `https://${slug}.example.com/mcp`, headers: { Authorization: `Bearer ${TOKEN}` } }
    : { transport: 'stdio', command: `${slug}-server` },
});
const uninstallMcp = (id: number, slug: string, workspace: string): MockCommand => ({
  id, type: 'uninstall_mcp', scope: 'workspace', workspace_path: workspace, slug, version: '1.0.0',
});
const ackStatus = (ids: number[]): string[] => server.acks.filter(({ id }) => ids.includes(id))
  .map(({ body }) => { const ack = body as { status: string; error?: string }; return ack.error ? `${ack.status}: ${ack.error}` : ack.status; });
const servers = (doc: ToolJson, key: string): Record<string, { url?: string }> | undefined => doc.projects?.[key]?.mcpServers;
const mcpFiles = (status: string[]): string[] => status.filter((line) => /mcp\.json/.test(line));

describe.skipIf(process.platform === 'win32')('the HTTP local agent installs a project\'s MCP servers in the tool\'s local scope (#915)', () => {
  it('installs for Claude and CodeBuddy in their local scopes, and uninstall_mcp and teamai uninstall take out exactly its servers', async () => {
    const m = machine('install');
    const app = await m.project('app');
    m.setFlag(app, true);

    await m.sessionStart(app, 'claude', [installMcp(1, 'claude-api', app), installMcp(2, 'second-api', app)]);
    expect(ackStatus([1, 2])).toEqual(['success', 'success']);
    const claude = m.readJson(m.claudeJson);
    expect(Object.keys(servers(claude, app) ?? {}).sort()).toEqual(['claude-api', 'my-local', 'second-api']);
    expect(servers(claude, app)?.['claude-api']?.url).toBe('https://claude-api.example.com/mcp');
    expect(JSON.stringify(servers(claude, app)?.['claude-api'])).toContain(TOKEN);
    expect(claude.numStartups).toBe(3);
    expect(claude.projects?.['/elsewhere/project']).toEqual(ELSEWHERE['/elsewhere/project']);
    expect(fs.existsSync(path.join(app, '.mcp.json'))).toBe(false);
    expect(m.status(app)).toEqual([]);

    await m.sessionStart(app, 'codebuddy', [installMcp(3, 'buddy-api', app)]);
    expect(ackStatus([3])).toEqual(['success']);
    expect(Object.keys(servers(m.readJson(m.codebuddyJson), app) ?? {}).sort()).toEqual(['buddy-api', 'my-local']);
    expect(fs.existsSync(path.join(app, '.mcp.json'))).toBe(false);
    expect(m.status(app)).toEqual([]);

    // A session start with nothing to do changes nothing.
    const before = [fs.readFileSync(m.claudeJson, 'utf8'), fs.readFileSync(m.codebuddyJson, 'utf8')];
    await m.sessionStart(app, 'claude', []);
    expect([fs.readFileSync(m.claudeJson, 'utf8'), fs.readFileSync(m.codebuddyJson, 'utf8')]).toEqual(before);
    expect(m.status(app)).toEqual([]);

    await m.sessionStart(app, 'claude', [uninstallMcp(4, 'second-api', app)]);
    expect(ackStatus([4])).toEqual(['success']);
    expect(Object.keys(servers(m.readJson(m.claudeJson), app) ?? {}).sort()).toEqual(['claude-api', 'my-local']);
    expect(m.status(app)).toEqual([]);

    const out = await m.cli(['uninstall', '--force'], app);

    expect(out.code, out.output).toBe(0);
    for (const file of [m.claudeJson, m.codebuddyJson]) {
      const doc = m.readJson(file);
      expect(doc.projects?.[app], file).toEqual({ allowedTools: [], mcpServers: { 'my-local': MY_LOCAL } });
      expect(doc.projects?.['/elsewhere/project'], file).toEqual(ELSEWHERE['/elsewhere/project']);
      expect(doc.numStartups, file).toBe(3);
      expect(fs.readFileSync(file, 'utf8'), file).not.toContain(TOKEN);
    }
    expect(mcpFiles(m.status(app))).toEqual([]);
  }, 180_000);

  it('moves a server it installed in .mcp.json to Claude\'s local scope at its next sync, and keeps and names a copy the member changed', async () => {
    const m = machine('move');
    const app = await m.project('app');
    const mcpJson = path.join(app, '.mcp.json');

    // With the flag off, the servers go to .mcp.json, as every earlier local agent put them.
    await m.sessionStart(app, 'claude', [installMcp(11, 'old-api', app, false), installMcp(12, 'edited-api', app, false)]);
    expect(ackStatus([11, 12])).toEqual(['success', 'success']);
    const installed = JSON.parse(fs.readFileSync(mcpJson, 'utf8')) as { mcpServers: Record<string, { command?: string }> };
    expect(Object.keys(installed.mcpServers).sort()).toEqual(['edited-api', 'old-api']);
    // The member changes one of them, and adds a server of their own.
    installed.mcpServers['edited-api'].command = 'my-edited-server';
    installed.mcpServers.mine = { command: 'my-server' };
    fs.writeFileSync(mcpJson, JSON.stringify(installed, null, 2));

    m.setFlag(app, true);
    const doctor = await m.cli(['doctor'], app);
    expect(doctor.output).toMatch(/teamai's MCP servers for claude from the local agent \(edited-api, old-api\) are still in .*\.mcp\.json/);

    const run = await m.sessionStart(app, 'claude', []);

    expect(servers(m.readJson(m.claudeJson), app)).toEqual({ 'my-local': MY_LOCAL, 'old-api': installed.mcpServers['old-api'] });
    expect(JSON.parse(fs.readFileSync(mcpJson, 'utf8'))).toEqual({
      mcpServers: { 'edited-api': installed.mcpServers['edited-api'], mine: installed.mcpServers.mine },
    });
    expect(run.output).toContain(`Kept MCP server edited-api in ${mcpJson}: you changed it since teamai installed it`);
    expect((await m.cli(['doctor'], app)).output).not.toContain('from the local agent');
    // The member's file stays theirs: visible to git.
    expect(m.status(app)).toEqual(['?? .mcp.json']);

    // Moved once: the next sync finds nothing to move, and names nothing again.
    const again = await m.sessionStart(app, 'claude', []);
    expect(again.output).not.toContain('edited-api');
    expect(servers(m.readJson(m.claudeJson), app)).toEqual({ 'my-local': MY_LOCAL, 'old-api': installed.mcpServers['old-api'] });
  }, 180_000);

  it('moves a server it installed in .mcp.json to CodeBuddy\'s local scope, and deletes the file that held nothing else', async () => {
    const m = machine('move-buddy');
    const app = await m.project('app');
    await m.sessionStart(app, 'codebuddy', [installMcp(21, 'buddy-old', app, false)]);
    expect(ackStatus([21])).toEqual(['success']);
    expect(mcpFiles(m.status(app))).toEqual(['?? .mcp.json']);
    const entry = (JSON.parse(fs.readFileSync(path.join(app, '.mcp.json'), 'utf8')) as { mcpServers: Record<string, unknown> }).mcpServers['buddy-old'];

    m.setFlag(app, true);
    await m.sessionStart(app, 'codebuddy', []);

    expect(servers(m.readJson(m.codebuddyJson), app)).toEqual({ 'my-local': MY_LOCAL, 'buddy-old': entry });
    expect(fs.existsSync(path.join(app, '.mcp.json'))).toBe(false);
    expect(m.status(app)).toEqual([]);

    // It is recorded there now: uninstall_mcp takes it out.
    await m.sessionStart(app, 'codebuddy', [uninstallMcp(22, 'buddy-old', app)]);
    expect(ackStatus([22])).toEqual(['success']);
    expect(servers(m.readJson(m.codebuddyJson), app)).toEqual({ 'my-local': MY_LOCAL });
    expect(m.status(app)).toEqual([]);
  }, 180_000);

  it('files a linked worktree\'s servers under the main checkout for Claude, and under the worktree for CodeBuddy', async () => {
    const m = machine('worktree');
    const app = await m.project('app');
    m.setFlag(app, true);
    const added = m.git(['worktree', 'add', '-q', path.join(path.dirname(app), 'app-wt'), '-b', 'wt'], app);
    expect(added.code, added.out).toBe(0);
    await detached.waitForExit();
    const wt = fs.realpathSync.native(path.join(path.dirname(app), 'app-wt'));
    fs.mkdirSync(path.join(wt, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(wt, '.codebuddy'), { recursive: true });

    await m.sessionStart(app, 'claude', [installMcp(31, 'shared-api', app)]);
    // The worktree's install of the same server is the one Claude already has under the main checkout's key.
    await m.sessionStart(wt, 'claude', [installMcp(32, 'shared-api', wt)]);
    await m.sessionStart(wt, 'codebuddy', [installMcp(33, 'wt-api', wt)]);

    expect(ackStatus([31, 32, 33])).toEqual(['success', 'success', 'success']);
    const claude = m.readJson(m.claudeJson);
    expect(Object.keys(servers(claude, app) ?? {}).sort()).toEqual(['my-local', 'shared-api']);
    expect(claude.projects?.[wt]).toBeUndefined();
    const codebuddy = m.readJson(m.codebuddyJson);
    expect(servers(codebuddy, wt)).toEqual({ 'wt-api': expect.objectContaining({ url: 'https://wt-api.example.com/mcp' }) });
    expect(servers(codebuddy, app)).toEqual({ 'my-local': MY_LOCAL });
    expect(m.status(app)).toEqual([]);
    expect(m.status(wt)).toEqual([]);

    // From the worktree, uninstall_mcp takes the server out of the key it shares with the main checkout.
    await m.sessionStart(wt, 'claude', [uninstallMcp(34, 'shared-api', wt)]);
    expect(ackStatus([34])).toEqual(['success']);
    expect(servers(m.readJson(m.claudeJson), app)).toEqual({ 'my-local': MY_LOCAL });
  }, 180_000);

  it.each([true, false])('project uninstall keeps edited servers and removes unchanged servers with git exclude %s', async (enabled) => {
    const m = machine('project-edited');
    const app = await m.project('app');
    m.setFlag(app, enabled);
    const offset = enabled ? 0 : 10;
    await m.sessionStart(app, 'claude', [installMcp(61 + offset, 'edited-api', app, false), installMcp(62 + offset, 'unchanged-api', app, false)]);
    await m.sessionStart(app, 'codebuddy', [installMcp(63 + offset, 'buddy-edited', app, false), installMcp(64 + offset, 'buddy-unchanged', app, false)]);
    expect(ackStatus([61, 62, 63, 64].map((id) => id + offset))).toEqual(['success', 'success', 'success', 'success']);
    const files = enabled ? [m.claudeJson, m.codebuddyJson] : [path.join(app, '.mcp.json')];
    for (const file of files) {
      const doc = m.readJson(file);
      const entries = (enabled ? servers(doc, app)! : doc.mcpServers) as Record<string, unknown>;
      for (const name of ['edited-api', 'buddy-edited']) if (entries[name]) entries[name] = { type: 'stdio', command: `my-${name}` };
      entries['my-local'] = MY_LOCAL;
      fs.writeFileSync(file, JSON.stringify(doc, null, 2));
    }
    const out = await m.cli(['uninstall', '--force'], app);
    expect(out.code, out.output).toBe(0);
    for (const file of files) {
      const doc = m.readJson(file);
      const entries = (enabled ? servers(doc, app)! : doc.mcpServers) as Record<string, unknown>;
      expect(entries).not.toHaveProperty('unchanged-api');
      expect(entries).not.toHaveProperty('buddy-unchanged');
      expect(entries['my-local']).toEqual(MY_LOCAL);
      const name = file === m.codebuddyJson ? 'buddy-edited' : 'edited-api';
      expect(entries[name], out.output).toEqual({ type: 'stdio', command: `my-${name}` });
      expect(out.output).toContain(`Kept MCP server ${name} in ${file}`);
      expect(out.output).toContain('you changed it since teamai wrote it');
      if (!enabled) expect(entries['buddy-edited']).toEqual({ type: 'stdio', command: 'my-buddy-edited' });
    }
  }, 180_000);

  it.each([true, false])('uninstall in a workspace without project config reaches its local MCP records with user config %s', async (configured) => {
    const m = machine('workspace-uninstall');
    const user = await m.cli(['init', '--http', server.url, '--token', API_KEY, '--scope', 'user', '--agent', 'claude', '--force'], m.home);
    expect(user.code, user.output).toBe(0);
    const userConfig = path.join(m.home, '.teamai', 'config.yaml');
    fs.appendFileSync(userConfig, 'gitExcludeEnabled: true\n');
    const app = fs.realpathSync.native(fs.mkdtempSync(path.join(m.base, 'workspace-')));
    m.git(['init', '-q', '-b', 'main'], app);
    const id = configured ? 81 : 91;
    await m.sessionStart(app, 'claude', [installMcp(id, 'workspace-api', app)]);
    expect(ackStatus([id])).toEqual(['success']);
    const records = path.join(app, '.teamai', 'managed-local-mcp.json');
    expect(fs.existsSync(records)).toBe(true);
    if (!configured) fs.rmSync(userConfig);
    const good = fs.readFileSync(m.claudeJson, 'utf8');
    fs.writeFileSync(m.claudeJson, '{ broken json');
    const failed = await m.cli(['uninstall', '--force'], app);
    expect(failed.code, failed.output).toBe(1);
    expect(failed.output).toContain(m.claudeJson);
    expect(fs.existsSync(records)).toBe(true);
    fs.writeFileSync(m.claudeJson, good);
    const out = await m.cli(['uninstall', '--force'], app);
    expect(out.code, out.output).toBe(0);
    expect(Object.keys(servers(m.readJson(m.claudeJson), app) ?? {}), out.output).toEqual([]);
    expect(fs.readFileSync(m.claudeJson, 'utf8')).not.toContain(TOKEN);
  }, 180_000);

  it('an uninstall that finds no configuration, after remove-http, takes its servers out of both local scopes, and keeps the member\'s and an edited copy, named', async () => {
    const m = machine('home-only');
    const app = await m.project('app');
    m.setFlag(app, true);
    await m.sessionStart(app, 'claude', [installMcp(41, 'claude-api', app), installMcp(42, 'edited-api', app)]);
    await m.sessionStart(app, 'codebuddy', [installMcp(43, 'buddy-api', app)]);
    expect(ackStatus([41, 42, 43])).toEqual(['success', 'success', 'success']);
    // The member changes one of teamai's servers.
    const claude = m.readJson(m.claudeJson);
    const edited = { ...servers(claude, app)?.['edited-api'], url: 'https://mine.example.com/edited' };
    servers(claude, app)!['edited-api'] = edited;
    fs.writeFileSync(m.claudeJson, JSON.stringify(claude, null, 2));
    // Removing the HTTP source leaves the servers, and their records.
    const removed = await m.cli(['source', 'remove-http'], app);
    expect(removed.code, removed.output).toBe(0);
    expect(Object.keys(servers(m.readJson(m.claudeJson), app) ?? {}).sort()).toEqual(['claude-api', 'edited-api', 'my-local']);

    // Outside the project, no configuration applies.
    const out = await m.cli(['uninstall', '--force'], m.base);

    expect(out.code, out.output).toBe(0);
    expect(out.output).toContain('home directory only');
    expect(fs.existsSync(path.join(m.home, '.teamai')), out.output).toBe(false);
    expect(servers(m.readJson(m.claudeJson), app), out.output).toEqual({ 'my-local': MY_LOCAL, 'edited-api': edited });
    expect(out.output).toContain(`Kept MCP server edited-api in ${m.claudeJson} (projects[${JSON.stringify(app)}]): you changed it since teamai wrote it`);
    expect(servers(m.readJson(m.codebuddyJson), app), out.output).toEqual({ 'my-local': MY_LOCAL });
    for (const file of [m.claudeJson, m.codebuddyJson]) {
      expect(m.readJson(file).projects?.['/elsewhere/project'], file).toEqual(ELSEWHERE['/elsewhere/project']);
      expect(m.readJson(file).numStartups, file).toBe(3);
    }
    expect(fs.readFileSync(m.codebuddyJson, 'utf8')).not.toContain(TOKEN);
  }, 180_000);

  it('an uninstall that finds no configuration keeps teamai\'s home while a local scope it holds servers in does not parse, and removes them once it does', async () => {
    const m = machine('home-only-broken');
    const app = await m.project('app');
    m.setFlag(app, true);
    await m.sessionStart(app, 'claude', [installMcp(51, 'claude-api', app)]);
    expect(ackStatus([51])).toEqual(['success']);
    const good = fs.readFileSync(m.claudeJson, 'utf8');
    fs.writeFileSync(m.claudeJson, `${good}\n{ not json`);
    const records = (): string[] => {
      const projects = path.join(m.home, '.teamai', 'projects');
      if (!fs.existsSync(projects)) return [];
      return fs.readdirSync(projects).map((dir) => path.join(projects, dir, 'managed-local-mcp.json')).filter((file) => fs.existsSync(file));
    };
    expect(records()).toHaveLength(1);

    const out = await m.cli(['uninstall', '--force'], m.base);

    expect(out.code, out.output).toBe(1);
    expect(out.output).toContain('Uninstall incomplete');
    expect(out.output).toContain(m.claudeJson);
    expect(records(), out.output).toHaveLength(1);

    // Repaired, the same uninstall removes the server and the home.
    fs.writeFileSync(m.claudeJson, good);
    const retry = await m.cli(['uninstall', '--force'], m.base);
    expect(retry.code, retry.output).toBe(0);
    expect(servers(m.readJson(m.claudeJson), app), retry.output).toEqual({ 'my-local': MY_LOCAL });
    expect(fs.readFileSync(m.claudeJson, 'utf8')).not.toContain(TOKEN);
    expect(fs.existsSync(path.join(m.home, '.teamai')), retry.output).toBe(false);
  }, 180_000);
});
