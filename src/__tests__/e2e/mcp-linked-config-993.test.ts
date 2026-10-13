/**
 * E2E (#993): a member's MCP config that is a symlink, e.g. into a dotfiles
 * repository.
 *
 * The file is the member's, so teamai edits its entries at the file the link
 * points to and leaves the link in place. A value teamai resolves from a
 * `${VAR}` lands in that target, so the target's own repository decides
 * whether it can be kept out of git (#886): a target that repository tracks
 * gets no value, and one it does not track is listed in its `info/exclude`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeCodex } from '../helpers/fake-codex.js';
import { trackDetachedProcesses } from '../helpers/detached-processes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};
const TOKEN = 'linked-token-value-7c2d';

interface Run { code: number | null; output: string }

let sandbox: string;
let home: string;
let fakeCodexDir: string;
let detached: ReturnType<typeof trackDetachedProcesses>;

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
    NODE_OPTIONS: [process.env.NODE_OPTIONS, detached.nodeOptions].filter(Boolean).join(' '),
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
interface Team { url: string; publish(files: Record<string, string>, message: string): void }

function team(name: string, files: Record<string, string>): Team {
  // Fresh paths on every call, so the runner's retry rebuilds the fixture instead of failing on the first try's.
  const root = fs.mkdtempSync(path.join(sandbox, `${name}-`));
  const url = `https://git.example.com/team/${path.basename(root)}.git`;
  const seed = path.join(root, 'seed');
  const remote = path.join(root, 'team.git');
  writeFile(path.join(seed, 'teamai.yaml'), [
    `team: ${name}`, `repo: ${url}`, 'provider: git', 'reviewers: []', 'sharing:', '  mcp:', '    autoApply: true', '',
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
  return { url, publish };
}

/** A git repository holding `files`, those in `commit` committed; its real path. */
function repo(name: string, files: Record<string, string>, commit: string[] = []): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(sandbox, `${name}-`)));
  writeFile(path.join(dir, 'README.md'), '# repo\n');
  gitOk(['init', '-q', '-b', 'main'], dir);
  for (const [rel, content] of Object.entries(files)) writeFile(path.join(dir, rel), content);
  gitOk(['add', 'README.md', ...commit], dir);
  gitOk(['commit', '-q', '-m', 'seed'], dir);
  return dir;
}

/** Make `link` a symlink to `target`. */
function link(link: string, target: string): void {
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target, link);
}

function init(t: Team, dir: string, agents: string): Run {
  const started = teamai(['init', t.url, '--provider', 'git', '--agent', agents, '--scope', 'project', '--force'], dir);
  if (started.code !== 0) throw new Error(`teamai init failed: ${started.output}`);
  const pulled = pull(dir);
  return { ...pulled, output: `${started.output}${pulled.output}` };
}

function pull(dir: string): Run {
  const r = teamai(['pull'], dir);
  if (r.code !== 0) throw new Error(`teamai pull failed: ${r.output}`);
  return r;
}

const plainYaml = (url: string): string => `servers:\n  - name: plain-api\n    transport: http\n    url: ${url}\n`;
const secretFiles = {
  'mcp/mcp.yaml': 'servers:\n  - name: secret-api\n    transport: http\n    url: https://api.example.com/mcp\n'
    + '    headers:\n      Authorization: "Bearer ${LAB_TOKEN}"\n',
  'env/env.yaml': `variables:\n  - key: LAB_TOKEN\n    value: "${TOKEN}"\n`,
};

const readJson = (file: string): any => JSON.parse(fs.readFileSync(file, 'utf8'));
const memberServer = { type: 'http', url: 'https://mine.example.com/mcp' };

interface CheckResult { name: string; ok: boolean; fix?: string }
function doctorCheck(dir: string, name: string): CheckResult {
  const r = spawnSync(process.execPath, [CLI, 'doctor', '--json'], { cwd: dir, encoding: 'utf8', env: env() });
  const checks = (JSON.parse(r.stdout) as { checks: CheckResult[] }).checks;
  const found = checks.find((c) => c.name === name);
  if (!found) throw new Error(`no check named ${name} in: ${checks.map((c) => c.name).join(', ')}`);
  return found;
}

describe('an MCP config that is a symlink (#993)', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-mcp-linked-e2e-')));
    home = path.join(sandbox, 'home');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fakeCodexDir = installFakeCodex();
    detached = trackDetachedProcesses(sandbox);
  });

  afterAll(async () => {
    if (detached) await detached.waitForExit();
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
    if (fakeCodexDir) fs.rmSync(fakeCodexDir, { recursive: true, force: true });
  });

  it('keeps linked .mcp.json and .codex/config.toml as links, and writes changed entries to their targets', () => {
    const t = team('linked', { 'mcp/mcp.yaml': plainYaml('https://team.example.com/v1') });
    const dotfiles = fs.realpathSync.native(fs.mkdtempSync(path.join(sandbox, 'dotfiles-')));
    const jsonTarget = path.join(dotfiles, 'claude', 'mcp.json');
    const tomlTarget = path.join(dotfiles, 'codex', 'config.toml');
    writeFile(jsonTarget, JSON.stringify({ mcpServers: { mine: memberServer } }, null, 2));
    writeFile(tomlTarget, 'model = "member-model"\n');
    const dir = repo('linked-biz', {});
    link(path.join(dir, '.mcp.json'), jsonTarget);
    link(path.join(dir, '.codex', 'config.toml'), tomlTarget);

    init(t, dir, 'claude,codex');
    t.publish({ 'mcp/mcp.yaml': plainYaml('https://team.example.com/v2') }, 'v2');
    pull(dir);

    for (const [file, target] of [[path.join(dir, '.mcp.json'), jsonTarget], [path.join(dir, '.codex', 'config.toml'), tomlTarget]]) {
      expect(fs.lstatSync(file).isSymbolicLink(), file).toBe(true);
      expect(fs.readlinkSync(file)).toBe(target);
    }
    expect(readJson(jsonTarget).mcpServers).toEqual({ mine: memberServer, 'plain-api': { type: 'http', url: 'https://team.example.com/v2' } });
    const toml = fs.readFileSync(tomlTarget, 'utf8');
    expect(toml).toContain('model = "member-model"');
    expect(toml).toContain('[mcp_servers.plain-api]');
    expect(toml).toContain('https://team.example.com/v2');
    expect(toml).not.toContain('https://team.example.com/v1');
  });

  it('keeps linked OpenCode configs as links when a pull writes rule instructions and MCP servers into them, and through uninstall', () => {
    const rule = (text: string): string => `---\ndescription: Team rule\n---\n${text}\n`;
    const t = team('linked-opencode', { 'mcp/mcp.yaml': plainYaml('https://team.example.com/v1'), 'rules/team-rule.md': rule('v1') });
    const dotfiles = fs.realpathSync.native(fs.mkdtempSync(path.join(sandbox, 'dotfiles-')));
    const rootTarget = path.join(dotfiles, 'opencode-root.json');
    const projectTarget = path.join(dotfiles, 'opencode-project.json');
    writeFile(rootTarget, JSON.stringify({ theme: 'member-root' }, null, 2));
    // Only the `$schema` OpenCode adds: uninstall deletes such a file teamai created, never a link.
    const schema = { $schema: 'https://opencode.ai/config.json' };
    writeFile(projectTarget, JSON.stringify(schema, null, 2));
    const dir = repo('linked-opencode-biz', {});
    const rootLink = path.join(dir, 'opencode.json');
    const projectLink = path.join(dir, '.opencode', 'opencode.json');
    link(rootLink, rootTarget);
    link(projectLink, projectTarget);

    init(t, dir, 'opencode');
    t.publish({ 'mcp/mcp.yaml': plainYaml('https://team.example.com/v2'), 'rules/other-rule.md': rule('other') }, 'v2');
    pull(dir);

    for (const [file, target] of [[rootLink, rootTarget], [projectLink, projectTarget]]) {
      expect(fs.lstatSync(file).isSymbolicLink(), file).toBe(true);
      expect(fs.readlinkSync(file)).toBe(target);
    }
    expect(readJson(rootTarget)).toMatchObject({ theme: 'member-root', mcp: { 'plain-api': { url: 'https://team.example.com/v2' } } });
    expect(readJson(projectTarget)).toEqual({ ...schema, instructions: ['.opencode/rules/**/*.md'] });

    const uninstall = teamai(['uninstall', '--force'], dir);

    expect(uninstall.code, uninstall.output).toBe(0);
    for (const [file, target] of [[rootLink, rootTarget], [projectLink, projectTarget]]) {
      expect(fs.lstatSync(file).isSymbolicLink(), file).toBe(true);
      expect(fs.readlinkSync(file)).toBe(target);
    }
    expect(readJson(projectTarget)).toEqual(schema);
    expect(readJson(rootTarget).mcp?.['plain-api']).toBeUndefined();
  });

  it('withholds a resolved value from a link into a repository that tracks its target, naming the target', () => {
    const t = team('tracked-target', secretFiles);
    const original = JSON.stringify({ mcpServers: { mine: memberServer } }, null, 2);
    const dotfiles = repo('tracked-dotfiles', { 'claude/mcp.json': original }, ['claude/mcp.json']);
    const target = path.join(dotfiles, 'claude', 'mcp.json');
    const dir = repo('tracked-biz', {});
    link(path.join(dir, '.mcp.json'), target);

    const initRun = init(t, dir, 'claude');
    const pulled = pull(dir);

    expect(fs.lstatSync(path.join(dir, '.mcp.json')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe(original);
    for (const output of [initRun.output, pulled.output]) {
      expect(output).toContain(`Did not write claude's MCP servers to ${path.join(dir, '.mcp.json')}`);
      expect(output).toContain(`git already tracks ${target}`);
      expect(output).not.toContain(TOKEN);
    }
    expect(fs.existsSync(path.join(dotfiles, '.git', 'info', 'exclude'))
      ? fs.readFileSync(path.join(dotfiles, '.git', 'info', 'exclude'), 'utf8') : '').not.toContain('teamai:mcp-exclude');
  });

  it('lists the target in its own repository\'s info/exclude, writes the resolved value there, and uninstall takes both out', () => {
    const t = team('untracked-target', secretFiles);
    const dotfiles = repo('untracked-dotfiles', { 'claude/mcp.json': JSON.stringify({ mcpServers: {} }) });
    const target = path.join(dotfiles, 'claude', 'mcp.json');
    const dir = repo('untracked-biz', {});
    link(path.join(dir, '.mcp.json'), target);

    const initRun = init(t, dir, 'claude');

    expect(initRun.output).not.toMatch(/Did not write claude's MCP servers/);
    expect(fs.lstatSync(path.join(dir, '.mcp.json')).isSymbolicLink()).toBe(true);
    expect(readJson(target).mcpServers).toMatchObject({ 'secret-api': { headers: { Authorization: `Bearer ${TOKEN}` } } });
    expect(fs.readFileSync(path.join(dotfiles, '.git', 'info', 'exclude'), 'utf8'))
      .toMatch(/\[teamai:mcp-exclude:start][^\n]*\n\/claude\/mcp\.json\n# \[teamai:mcp-exclude:end]/);
    expect(gitOk(['status', '--porcelain', '--untracked-files=all'], dotfiles)).toBe('');
    expect(doctorCheck(dir, 'MCP servers delivered to claude').ok).toBe(true);

    const uninstall = teamai(['uninstall', '--force'], dir);

    expect(uninstall.code, uninstall.output).toBe(0);
    expect(fs.lstatSync(path.join(dir, '.mcp.json')).isSymbolicLink()).toBe(true);
    expect(readJson(target).mcpServers).toEqual({});
    expect(fs.readFileSync(path.join(dotfiles, '.git', 'info', 'exclude'), 'utf8')).not.toContain('teamai:mcp-exclude');
  });
});
