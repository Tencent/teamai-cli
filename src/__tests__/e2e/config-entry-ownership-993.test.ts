/**
 * E2E (#993 bug 12): ownership of entries teamai writes into shared config
 * files, MCP servers and team hook entries, when teamai has no record of them.
 *
 * An unrecorded entry that equals teamai's render of a team server or hook, at
 * the team repo's current revision or an earlier one, is teamai's: it is
 * adopted and updated. Any other unrecorded entry in teamai's way is the
 * member's: kept, named by pull, and listed by doctor.
 *
 * Each case gets its own team remote: a local bare repo reached through a
 * synthetic HTTPS URL (`url.<path>.insteadOf` in the sandbox HOME), so cases
 * can publish team changes without affecting each other.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeCodex } from '../helpers/fake-codex.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

interface Run { code: number | null; output: string }

let sandbox: string;
let home: string;
let fakeCodexDir: string;

function env(): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    ...GIT_ENV,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    CODEX_HOME: path.join(home, '.codex'),
    PATH: `${fakeCodexDir}${path.delimiter}${process.env.PATH ?? ''}`,
    FORCE_COLOR: '0',
  };
  delete base.CLAUDE_CONFIG_DIR;
  return base;
}

function run(command: string, args: string[], cwd: string): Run {
  const r = spawnSync(command, args, { cwd, encoding: 'utf8', env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
  return { code: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function gitOk(args: string[], cwd: string): string {
  const r = run('git', args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.output}`);
  return r.output.trim();
}

const teamai = (args: string[], cwd: string): Run => run(process.execPath, [CLI, ...args], cwd);

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** A team: a seed checkout and the bare remote its synthetic URL reaches. */
interface Team { url: string; seed: string; publish(files: Record<string, string>, message: string): void }

function team(name: string, files: Record<string, string>, sharing: string[] = []): Team {
  const url = `https://git.example.com/team/${name}.git`;
  const seed = path.join(sandbox, `${name}-seed`);
  const remote = path.join(sandbox, `${name}.git`);
  writeFile(path.join(seed, 'teamai.yaml'), [
    `team: ${name}`, `repo: ${url}`, 'provider: git', 'reviewers: []',
    'sharing:', '  mcp:', '    autoApply: true', '  hooks:', '    autoApply: true', '    requireTeamScripts: false', ...sharing, '',
  ].join('\n'));
  gitOk(['init', '-q', '-b', 'main'], seed);
  const publish = (next: Record<string, string>, message: string): void => {
    for (const [rel, content] of Object.entries(next)) writeFile(path.join(seed, rel), content);
    gitOk(['add', '-A'], seed);
    gitOk(['commit', '-q', '-m', message], seed);
    if (fs.existsSync(remote)) gitOk(['push', '-q', remote, 'main'], seed);
  };
  publish(files, 'seed');
  gitOk(['clone', '-q', '--bare', seed, remote], sandbox);
  gitOk(['config', '--global', `url.${remote}.insteadOf`, url], sandbox);
  return { url, seed, publish };
}

/** A git business repo holding `files` before teamai is set up in it. */
function business(name: string, files: Record<string, string> = {}): string {
  const dir = path.join(sandbox, name);
  writeFile(path.join(dir, 'README.md'), '# app\n');
  gitOk(['init', '-q', '-b', 'main'], dir);
  gitOk(['add', '-A'], dir);
  gitOk(['commit', '-q', '-m', 'app'], dir);
  for (const [rel, content] of Object.entries(files)) writeFile(path.join(dir, rel), content);
  return fs.realpathSync.native(dir);
}

function init(t: Team, dir: string, agents: string): Run {
  const started = teamai(['init', t.url, '--provider', 'git', '--agent', agents, '--scope', 'project', '--force'], dir);
  if (started.code !== 0) throw new Error(`teamai init failed: ${started.output}`);
  const pulled = pull(dir);
  return { ...pulled, output: `${started.output}${pulled.output}` };
}

function pull(dir: string, ...args: string[]): Run {
  const r = teamai(['pull', ...args], dir);
  if (r.code !== 0) throw new Error(`teamai pull failed: ${r.output}`);
  return r;
}

const mcpYaml = (url: string): string => `servers:\n  - name: plain-api\n    transport: http\n    url: ${url}\n`;
const hooksYaml = (command: string): string =>
  `hooks:\n  - id: team-stop\n    description: Team stop\n    event: Stop\n    command: ${command}\n`;

const readJson = (file: string): any => JSON.parse(fs.readFileSync(file, 'utf8'));
const mcpServer = (dir: string, name: string): unknown => readJson(path.join(dir, '.mcp.json')).mcpServers?.[name];

/** The Claude Stop entries that carry teamai's marker for `team-stop`. */
const claudeTeamStops = (dir: string): Array<{ hooks: Array<{ command: string }> }> =>
  (readJson(path.join(dir, '.claude', 'settings.local.json')).hooks?.Stop ?? [])
    .filter((e: { description?: string }) => e.description?.startsWith('[teamai:hook:team-stop]'));
/** The commands of the Codex Stop entries. */
const codexStops = (dir: string): string[] =>
  (readJson(path.join(dir, '.codex', 'hooks.json')).hooks?.Stop ?? []).map((e: { hooks: Array<{ command: string }> }) => e.hooks[0].command);

/**
 * Lose every hook manifest under the sandbox HOME's data home: the main
 * checkout's, HOME's, and each checkout's own.
 */
function removeHookManifests(): void {
  const names = new Set(['managed-main-checkout-hooks.json', 'managed-hooks.json']);
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : names.has(e.name) ? [path.join(dir, e.name)] : []);
  const found = walk(path.join(home, '.teamai'));
  expect(found.length).toBeGreaterThan(0);
  for (const file of found) fs.rmSync(file);
}

/** Lose every MCP manifest under the sandbox HOME's data home, as an older release or a restore would. */
function removeMcpManifests(): void {
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : e.name === 'managed-mcp.json' ? [path.join(dir, e.name)] : []);
  const found = walk(path.join(home, '.teamai'));
  expect(found.length).toBeGreaterThan(0);
  for (const file of found) fs.rmSync(file);
}

const twoServersYaml = (url: string): string =>
  `servers:\n  - name: plain-api\n    transport: http\n    url: ${url}\n  - name: other-api\n    transport: http\n    url: https://team.example.com/other\n`;

describe('ownership of unrecorded MCP servers and hook entries (#993 bug 12)', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-entry-ownership-e2e-')));
    home = path.join(sandbox, 'home');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fakeCodexDir = installFakeCodex();
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
    if (fakeCodexDir) fs.rmSync(fakeCodexDir, { recursive: true, force: true });
  });

  it('keeps the member\'s same-name MCP server through init and pull --force, names it, and doctor lists it', () => {
    const t = team('own-server', { 'mcp/mcp.yaml': mcpYaml('https://team.example.com/v1') });
    t.publish({ 'mcp/mcp.yaml': mcpYaml('https://team.example.com/v2') }, 'v2');
    const mine = { type: 'http', url: 'https://mine.example.com/mcp' };
    const dir = business('own-server-biz', { '.mcp.json': JSON.stringify({ mcpServers: { 'plain-api': mine } }) });

    init(t, dir, 'claude');
    expect(mcpServer(dir, 'plain-api')).toEqual(mine);

    const pulled = pull(dir, '--force');
    expect(mcpServer(dir, 'plain-api')).toEqual(mine);
    expect(pulled.output).toContain(`Kept MCP server plain-api in ${path.join(dir, '.mcp.json')}: it is not teamai's`);
    expect(pulled.output).toContain('Rename or delete it, then run teamai pull, to receive the team version.');

    const doctor = teamai(['doctor'], dir);
    expect(doctor.output).toMatch(/not teamai's[^\n]*plain-api|plain-api[^\n]*not teamai's/);
  });

  it('adopts an unrecorded MCP server equal to an older team render, and updates it', () => {
    const t = team('older-server', { 'mcp/mcp.yaml': mcpYaml('https://team.example.com/v1') });
    t.publish({ 'mcp/mcp.yaml': mcpYaml('https://team.example.com/v2') }, 'v2');
    const v1 = { type: 'http', url: 'https://team.example.com/v1' };
    const dir = business('older-server-biz', { '.mcp.json': JSON.stringify({ mcpServers: { 'plain-api': v1 } }) });

    const initRun = init(t, dir, 'claude');
    expect(mcpServer(dir, 'plain-api')).toEqual({ type: 'http', url: 'https://team.example.com/v2' });
    expect(initRun.output).not.toContain('Kept MCP server');
  });

  it('adopts an unrecorded MCP server equal to the current team render, so later team changes reach it', () => {
    const t = team('current-server', { 'mcp/mcp.yaml': mcpYaml('https://team.example.com/v1') });
    const v1 = { type: 'http', url: 'https://team.example.com/v1' };
    const dir = business('current-server-biz', { '.mcp.json': JSON.stringify({ mcpServers: { 'plain-api': v1 } }) });

    init(t, dir, 'claude');
    expect(mcpServer(dir, 'plain-api')).toEqual(v1);

    t.publish({ 'mcp/mcp.yaml': mcpYaml('https://team.example.com/v3') }, 'v3');
    const pulled = pull(dir);
    expect(mcpServer(dir, 'plain-api')).toEqual({ type: 'http', url: 'https://team.example.com/v3' });
    expect(pulled.output).not.toContain('Kept MCP server');
  });

  it('records an adopted MCP server that already equals the current team render, so a team removal reaches it', () => {
    // Nothing to write on adoption: the record alone must still be saved.
    const t = team('noop-adopt', { 'README.md': '# team\n' });
    const dir = business('noop-adopt-biz', { '.claude/.keep': '' });
    init(t, dir, 'claude');
    const v1 = { type: 'http', url: 'https://team.example.com/v1' };
    fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { 'plain-api': v1 } }));
    t.publish({ 'mcp/mcp.yaml': mcpYaml('https://team.example.com/v1') }, 'add');

    // A dry run says it would record the server, and records nothing.
    const preview = pull(dir, '--dry-run');
    expect(preview.output).toContain(`Would record MCP server plain-api in ${path.join(dir, '.mcp.json')} as teamai's`);
    pull(dir);
    expect(mcpServer(dir, 'plain-api')).toEqual(v1);

    t.publish({ 'mcp/mcp.yaml': 'servers: []\n' }, 'drop');
    pull(dir);
    // It was the file's only server: the emptied file goes too.
    expect(fs.existsSync(path.join(dir, '.mcp.json'))).toBe(false);
  });

  it('records an adopted MCP server that already equals the current team render, so uninstall removes it', () => {
    const t = team('noop-adopt-uninstall', { 'mcp/mcp.yaml': mcpYaml('https://team.example.com/v1') });
    const v1 = { type: 'http', url: 'https://team.example.com/v1' };
    const dir = business('noop-adopt-uninstall-biz', { '.mcp.json': JSON.stringify({ mcpServers: { 'plain-api': v1 } }) });
    init(t, dir, 'claude');
    expect(mcpServer(dir, 'plain-api')).toEqual(v1);

    const r = teamai(['uninstall', '--force'], dir);
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(dir, '.mcp.json')) ? mcpServer(dir, 'plain-api') : undefined).toBeUndefined();
  });

  it('removes an unrecorded copy of a server the team deleted, beside servers it still defines', () => {
    const t = team('removed-beside', { 'mcp/mcp.yaml': twoServersYaml('https://team.example.com/v1') });
    const dir = business('removed-beside-biz', { '.claude/.keep': '' });
    init(t, dir, 'claude');
    removeMcpManifests();

    t.publish({ 'mcp/mcp.yaml': `servers:\n  - name: other-api\n    transport: http\n    url: https://team.example.com/other\n` }, 'drop plain-api');
    pull(dir);
    expect(mcpServer(dir, 'plain-api')).toBeUndefined();
    expect(mcpServer(dir, 'other-api')).toEqual({ type: 'http', url: 'https://team.example.com/other' });
  });

  it('removes an unrecorded copy of a server when the team deletes every server, on pull and on uninstall', () => {
    const t = team('removed-all', { 'mcp/mcp.yaml': mcpYaml('https://team.example.com/v1') });
    const pulled = business('removed-all-biz', { '.claude/.keep': '' });
    init(t, pulled, 'claude');
    removeMcpManifests();
    t.publish({ 'mcp/mcp.yaml': 'servers: []\n' }, 'drop');
    const preview = pull(pulled, '--dry-run');
    expect(preview.output).toContain(
      `Would remove MCP server plain-api from ${path.join(pulled, '.mcp.json')}: it equals a server the team has removed.`,
    );
    expect(mcpServer(pulled, 'plain-api')).toEqual({ type: 'http', url: 'https://team.example.com/v1' });
    pull(pulled);
    expect(fs.existsSync(path.join(pulled, '.mcp.json'))).toBe(false);

    const t2 = team('removed-uninstall', { 'mcp/mcp.yaml': mcpYaml('https://team.example.com/v1') });
    const uninstalled = business('removed-uninstall-biz', { '.claude/.keep': '' });
    init(t2, uninstalled, 'claude');
    removeMcpManifests();
    expect(teamai(['uninstall', '--force'], uninstalled).code).toBe(0);
    expect(fs.existsSync(path.join(uninstalled, '.mcp.json')) ? mcpServer(uninstalled, 'plain-api') : undefined).toBeUndefined();
  });

  it('keeps a member\'s server under the name of a server the team deleted', () => {
    const t = team('removed-member', { 'mcp/mcp.yaml': mcpYaml('https://team.example.com/v1') });
    const mine = { type: 'http', url: 'https://mine.example.com/mcp' };
    const dir = business('removed-member-biz', { '.mcp.json': JSON.stringify({ mcpServers: { 'plain-api': mine } }) });
    init(t, dir, 'claude');
    t.publish({ 'mcp/mcp.yaml': 'servers: []\n' }, 'drop');
    pull(dir);
    expect(mcpServer(dir, 'plain-api')).toEqual(mine);
  });

  it('keeps a member\'s server whose name the team history never had', () => {
    const t = team('never-team', { 'mcp/mcp.yaml': mcpYaml('https://team.example.com/v1') });
    const mine = { type: 'http', url: 'https://mine.example.com/mcp' };
    const dir = business('never-team-biz', { '.mcp.json': JSON.stringify({ mcpServers: { 'my-own': mine } }) });
    init(t, dir, 'claude');
    removeMcpManifests();
    t.publish({ 'mcp/mcp.yaml': 'servers: []\n' }, 'drop');
    pull(dir);
    expect(mcpServer(dir, 'plain-api')).toBeUndefined();
    expect(mcpServer(dir, 'my-own')).toEqual(mine);
  });

  it('removes an unrecorded copy of a deleted server from Codex config too', () => {
    const t = team('removed-codex', { 'mcp/mcp.yaml': mcpYaml('https://team.example.com/v1') });
    const dir = business('removed-codex-biz', { '.codex/.keep': '' });
    init(t, dir, 'codex');
    const config = path.join(dir, '.codex', 'config.toml');
    expect(fs.readFileSync(config, 'utf8')).toContain('[mcp_servers.plain-api]');
    removeMcpManifests();
    t.publish({ 'mcp/mcp.yaml': 'servers: []\n' }, 'drop');
    pull(dir);
    expect(fs.existsSync(config) ? fs.readFileSync(config, 'utf8') : '').not.toContain('[mcp_servers.plain-api]');
  });

  it('leaves a Claude settings file that does not parse as it is, and writes its hooks once it parses', () => {
    const t = team('hook-broken', { 'hooks/hooks.yaml': hooksYaml('echo team-stop-v1') });
    const dir = business('hook-broken-biz', { '.claude/.keep': '' });
    init(t, dir, 'claude');
    const homeSettings = path.join(home, '.claude', 'settings.json');
    const localSettings = path.join(dir, '.claude', 'settings.local.json');
    const repaired = { home: fs.readFileSync(homeSettings, 'utf8'), local: fs.readFileSync(localSettings, 'utf8') };
    // The member is mid-edit of both files.
    const broken = '{ "permissions": { "allow": ["Bash(npm test)"] }, \n';
    writeFile(homeSettings, broken);
    writeFile(localSettings, broken);
    t.publish({ 'hooks/hooks.yaml': hooksYaml('echo team-stop-v2') }, 'v2');
    try {
      const pulled = teamai(['pull'], dir);
      expect(fs.readFileSync(homeSettings, 'utf8'), pulled.output).toBe(broken);
      expect(fs.readFileSync(localSettings, 'utf8')).toBe(broken);
      expect(pulled.output).toContain(`${homeSettings} does not parse`);
    } finally {
      writeFile(homeSettings, repaired.home);
      writeFile(localSettings, repaired.local);
    }
    pull(dir);
    expect(claudeTeamStops(dir).map((e) => e.hooks[0].command).join('\n')).toContain('echo team-stop-v2');
  });

  it('keeps the hook records when uninstall cannot read a settings file, so uninstall after the repair removes the hooks', () => {
    const t = team('hook-broken-uninstall', { 'hooks/hooks.yaml': hooksYaml('echo team-stop-v1') });
    const dir = business('hook-broken-uninstall-biz', { '.claude/.keep': '' });
    init(t, dir, 'claude');
    const localSettings = path.join(dir, '.claude', 'settings.local.json');
    const repaired = fs.readFileSync(localSettings, 'utf8');
    expect(repaired).toContain('echo team-stop-v1');
    const broken = `${repaired.trimEnd()}, \n`;
    writeFile(localSettings, broken);
    const first = teamai(['uninstall', '--force'], dir);
    expect(fs.readFileSync(localSettings, 'utf8'), first.output).toBe(broken);
    expect(first.code, first.output).toBe(1);
    expect(first.output).not.toContain('teamai uninstalled');

    writeFile(localSettings, repaired);
    const second = teamai(['uninstall', '--force'], dir);
    expect(second.code, second.output).toBe(0);
    expect(fs.readFileSync(localSettings, 'utf8'), second.output).not.toContain('echo team-stop-v1');
    expect(first.output).toContain(`${localSettings}, which could not be removed`);
  });

  it('a hook an incomplete uninstall left in place syncs nothing back', () => {
    const t = team('hook-broken-resync', {
      'hooks/hooks.yaml': hooksYaml('echo team-stop-v1'),
      'skills/team-skill/SKILL.md': '---\nname: team-skill\ndescription: d\n---\nTeam.\n',
    });
    const dir = business('hook-broken-resync-biz', { '.claude/.keep': '' });
    init(t, dir, 'claude');
    const skill = path.join(dir, '.claude', 'skills', 'team-skill');
    expect(fs.existsSync(skill)).toBe(true);
    const localSettings = path.join(dir, '.claude', 'settings.local.json');
    writeFile(localSettings, `${fs.readFileSync(localSettings, 'utf8').trimEnd()}, \n`);
    const removed = teamai(['uninstall', '--force'], dir);
    expect(removed.code, removed.output).toBe(1);
    expect(fs.existsSync(skill), removed.output).toBe(false);

    // The team moves on, and the retained hook's session start runs its pull (the background pass, inline).
    t.publish({ 'skills/team-skill/SKILL.md': '---\nname: team-skill\ndescription: d\n---\nTeam, v2.\n' }, 'v2');
    const r = spawnSync(process.execPath, [CLI, 'hook-dispatch', 'session-start', '--tool', 'claude', '--stdin', '--bg-only'], {
      cwd: dir, encoding: 'utf8', env: env(), input: JSON.stringify({ cwd: dir, session_id: 's1' }),
    });
    expect(fs.existsSync(skill), `${r.stdout}${r.stderr}`).toBe(false);
  });

  it('excludes the tool when a targeted uninstall cannot remove its hooks', () => {
    const t = team('hook-broken-targeted', { 'hooks/hooks.yaml': hooksYaml('echo team-stop-v1') });
    const dir = business('hook-broken-targeted-biz', { '.claude/.keep': '' });
    init(t, dir, 'claude');
    const localSettings = path.join(dir, '.claude', 'settings.local.json');
    const repaired = fs.readFileSync(localSettings, 'utf8');
    writeFile(localSettings, `${repaired.trimEnd()}, \n`);
    const removed = teamai(['uninstall', '--agent', 'claude', '--force'], dir);
    expect(removed.code, removed.output).toBe(1);
    writeFile(localSettings, repaired);
    // Excluded, so no pull syncs claude back over what is left.
    const projects = path.join(home, '.teamai', 'projects');
    const configs = fs.readdirSync(projects).map((id) => path.join(projects, id, 'config.yaml')).filter((f) => fs.existsSync(f))
      .map((f) => fs.readFileSync(f, 'utf8')).filter((text) => text.includes(dir));
    expect(configs.join('\n'), removed.output).toMatch(/disabledAgents:\s*\n\s*- claude/);
  });

  it('leaves one entry per team hook in Claude and Codex files, with and without the hook manifest', () => {
    // The co-author setting shares settings.local.json with the team hooks (#993 bug 7).
    const t = team('hook-manifest', { 'hooks/hooks.yaml': hooksYaml('echo team-stop-v1') }, ['  coAuthor:', '    enabled: false']);
    const dir = business('hook-manifest-biz', { '.claude/.keep': '' });
    init(t, dir, 'claude,codex');
    expect(claudeTeamStops(dir)).toHaveLength(1);
    expect(codexStops(dir)).toEqual(['echo team-stop-v1']);
    const settings = path.join(dir, '.claude', 'settings.local.json');
    const attribution = { commit: '', pr: '' };
    expect(readJson(settings).attribution).toEqual(attribution);

    // Recorded entries are updated as before.
    t.publish({ 'hooks/hooks.yaml': hooksYaml('echo team-stop-v2') }, 'v2');
    pull(dir);
    expect(claudeTeamStops(dir)).toHaveLength(1);
    expect(claudeTeamStops(dir)[0].hooks[0].command).toMatch(/echo team-stop-v2$/);
    expect(codexStops(dir)).toEqual(['echo team-stop-v2']);

    // The record is lost, and the file rewritten in another layout with another key first: the
    // entries equal today's render and are recognized; the key teamai's hooks do not own stays.
    removeHookManifests();
    const { hooks, ...rest } = readJson(settings);
    fs.writeFileSync(settings, JSON.stringify({ ...rest, hooks }));
    pull(dir, '--force');
    expect(claudeTeamStops(dir)).toHaveLength(1);
    expect(codexStops(dir)).toEqual(['echo team-stop-v2']);
    expect(readJson(settings).attribution).toEqual(attribution);

    // Lost again, and the team changed the hook: the entries equal an older render.
    removeHookManifests();
    t.publish({ 'hooks/hooks.yaml': hooksYaml('echo team-stop-v3') }, 'v3');
    const pulled = pull(dir, '--force');
    expect(claudeTeamStops(dir)).toHaveLength(1);
    expect(claudeTeamStops(dir)[0].hooks[0].command).toMatch(/echo team-stop-v3$/);
    expect(codexStops(dir)).toEqual(['echo team-stop-v3']);
    expect(pulled.output).not.toContain('Kept the');
    expect(readJson(settings).attribution).toEqual(attribution);
  });

  it('keeps and names an unrecorded hook entry that matches no team render, or more than one, and doctor lists it', () => {
    const t = team('hook-foreign', {
      'hooks/hooks.yaml': [
        'hooks:',
        '  - id: team-stop',
        '    description: Team stop',
        '    event: Stop',
        '    command: echo team-stop',
        '  - id: twin-a',
        '    description: Twin A',
        '    event: SessionStart',
        '    command: echo twin',
        '    tools: [codex]',
        '  - id: twin-b',
        '    description: Twin B',
        '    event: SessionStart',
        '    command: echo twin',
        '    tools: [codex]',
        '',
      ].join('\n'),
    });
    const memberStop = { matcher: '*', hooks: [{ type: 'command', command: 'echo my-own-stop' }], description: '[teamai:hook:team-stop] Team stop' };
    const memberTwin = { hooks: [{ type: 'command', command: 'echo twin' }] };
    const dir = business('hook-foreign-biz', {
      '.claude/settings.local.json': JSON.stringify({ hooks: { Stop: [memberStop] } }),
      '.codex/hooks.json': JSON.stringify({ hooks: { SessionStart: [memberTwin] } }),
    });

    const initRun = init(t, dir, 'claude,codex');
    const settings = path.join(dir, '.claude', 'settings.local.json');
    const codexFile = path.join(dir, '.codex', 'hooks.json');
    // The member's entries stay, and the team's are written beside them.
    expect(readJson(settings).hooks.Stop[0]).toEqual(memberStop);
    expect(claudeTeamStops(dir)).toHaveLength(2);
    expect(readJson(codexFile).hooks.SessionStart[0]).toEqual(memberTwin);
    expect(readJson(codexFile).hooks.SessionStart).toHaveLength(3);
    expect(initRun.output).toContain(`Kept the Stop hook entry team-stop in ${settings}: it is not teamai's`);
    expect(initRun.output).toContain(`Kept the SessionStart hook entry in ${codexFile}: it matches more than one team hook (twin-a, twin-b)`);

    const pulled = pull(dir, '--force');
    expect(readJson(settings).hooks.Stop[0]).toEqual(memberStop);
    expect(claudeTeamStops(dir)).toHaveLength(2);
    expect(readJson(codexFile).hooks.SessionStart).toHaveLength(3);
    expect(pulled.output).toContain(`Kept the Stop hook entry team-stop in ${settings}`);

    const doctor = teamai(['doctor'], dir);
    expect(doctor.output).toContain(`Kept the Stop hook entry team-stop in ${settings}`);
    expect(doctor.output).toContain(`Kept the SessionStart hook entry in ${codexFile}`);
  });

  it.each(['cursor', 'copilot', 'zcode'])('leaves one entry for a changed team hook in %s hooks, without the hook manifest', (tool) => {
    fs.mkdirSync(path.join(home, `.${tool}`), { recursive: true });
    const stop = (version: string): string => `hooks:\n  - id: ${tool}-stop\n    description: Stop\n    event: Stop\n    command: echo ${tool}-stop-${version}\n`;
    const t = team(`hook-history-${tool}`, { 'hooks/hooks.yaml': stop('v1') });
    const dir = business(`hook-history-${tool}-biz`);
    init(t, dir, tool);
    const file = hookFiles(dir)[tool];
    expect(entriesMentioning(file, `echo ${tool}-stop-`)).toHaveLength(1);

    removeHookManifests();
    t.publish({ 'hooks/hooks.yaml': stop('v2') }, 'v2');
    const pulled = pull(dir);
    const entries = entriesMentioning(file, `echo ${tool}-stop-`);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain(`echo ${tool}-stop-v2`);
    expect(pulled.output).not.toContain('Kept the');
  });

  it('removes unrecorded team hook entries on uninstall, and keeps the member\'s own entries beside them', () => {
    const tools = ['codex', 'cursor', 'copilot', 'zcode'];
    for (const tool of tools) fs.mkdirSync(path.join(home, `.${tool}`), { recursive: true });
    const t = team('hook-uninstall', {
      'hooks/hooks.yaml': 'hooks:\n  - id: leaving-stop\n    description: Stop\n    event: Stop\n    command: echo leaving-stop\n',
    });
    const dir = business('hook-uninstall-biz');
    init(t, dir, tools.join(','));
    const files = hookFiles(dir);
    for (const tool of tools) expect(entriesMentioning(files[tool], 'echo leaving-stop'), tool).toHaveLength(1);

    // The member adds hooks of their own to the same files.
    const own: Record<string, [string[], unknown]> = {
      codex: [['hooks', 'Stop'], { hooks: [{ type: 'command', command: 'echo my-own-codex' }] }],
      cursor: [['hooks', 'stop'], { command: 'echo my-own-cursor' }],
      copilot: [['hooks', 'Stop'], { type: 'command', bash: 'echo my-own-copilot', command: 'echo my-own-copilot' }],
      zcode: [['hooks', 'events', 'Stop'], { hooks: [{ type: 'process', command: 'bash', args: ['-lc', 'echo my-own-zcode'] }] }],
    };
    for (const [tool, [keys, entry]] of Object.entries(own)) {
      const json = readJson(files[tool]);
      const parent = keys.slice(0, -1).reduce((node, key) => node[key], json);
      parent[keys.at(-1)!].push(entry);
      fs.writeFileSync(files[tool], JSON.stringify(json, null, 2));
    }

    removeHookManifests();
    const r = teamai(['uninstall', '--force'], dir);
    expect(r.code, r.output).toBe(0);
    for (const tool of tools) {
      expect(entriesMentioning(files[tool], 'echo leaving-stop'), tool).toEqual([]);
      expect(entriesMentioning(files[tool], `echo my-own-${tool}`), tool).toHaveLength(1);
    }
  });
});

/** Where a project's hooks for each tool live: Codex in the checkout, Copilot per checkout, the rest in HOME. */
function hookFiles(dir: string): Record<string, string> {
  return {
    codex: path.join(dir, '.codex', 'hooks.json'),
    cursor: path.join(home, '.cursor', 'hooks.json'),
    copilot: path.join(dir, '.github', 'hooks', 'teamai.json'),
    zcode: path.join(home, '.zcode', 'cli', 'config.json'),
  };
}

/** The serialized entries, under any event of a hook file's `hooks`, that mention `needle`. */
function entriesMentioning(file: string, needle: string): string[] {
  if (!fs.existsSync(file)) return [];
  const found: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) if (JSON.stringify(entry).includes(needle)) found.push(JSON.stringify(entry));
    } else if (node && typeof node === 'object') {
      Object.values(node).forEach(visit);
    }
  };
  visit(readJson(file).hooks);
  return found;
}
