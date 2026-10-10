/**
 * E2E (#915): with `sharing.gitExclude` on, CodeBuddy gets the team's project
 * MCP servers from its local scope, `${CODEBUDDY_CONFIG_DIR:-~}/.codebuddy.json`
 * → `projects[<key>].mcpServers`, instead of the project's `.mcp.json`.
 *
 * - CodeBuddy keys its local scope by the directory it runs in, so every
 *   checkout gets its own key: the real path of that worktree's root. A pull
 *   writes it, and so does the pull git runs when it creates a worktree.
 * - The next pull drops teamai's servers from the key of a worktree that is
 *   gone, and leaves the member's own there.
 * - The team's tracked `.mcp.json` shows no change.
 * - Turning the option on moves teamai's servers out of `.mcp.json` (recorded,
 *   or proven teamai's by the team's history), keeps the member's own, and
 *   deletes a file only teamai's servers made. Turning it off moves them back.
 * - Uninstall removes exactly teamai's servers from the local scope.
 *
 * Each case gets its own HOME, team remote (a local bare repo reached through
 * a synthetic HTTPS URL) and business repo. Fixture git calls that fire
 * teamai's git hooks run with the member's HOME.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

interface Run { code: number | null; output: string }

let sandbox: string;
let detached: ReturnType<typeof trackDetachedProcesses>;

const write = (file: string, content: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const read = (file: string): string => fs.readFileSync(file, 'utf8');
const json = (value: unknown): string => JSON.stringify(value, null, 2) + '\n';

const TOKEN = 'lab-token-value-7c3a';
const SECRET_API = [
  '  - name: secret-api', '    transport: http', '    url: https://api.example.com/mcp',
  '    headers:', '      Authorization: "Bearer ${LAB_TOKEN}"',
];
const PLAIN_API = ['  - name: plain-api', '    transport: http', '    url: https://plain.example.com/mcp'];
const OLD_API = ['  - name: old-api', '    transport: http', '    url: https://old.example.com/mcp'];
const servers = (...defs: string[][]): string => ['servers:', ...defs.flat(), ''].join('\n');
const TEAM = {
  'rules/team-rule.md': '# Team\n\nTeam rule.\n',
  'mcp/mcp.yaml': servers(SECRET_API, PLAIN_API),
  'env/env.yaml': `variables:\n  - key: LAB_TOKEN\n    value: "${TOKEN}"\n`,
};
const sharing = (gitExclude: boolean): string =>
  `sharing:\n  gitExclude:\n    enabled: ${gitExclude}\n  mcp:\n    autoApply: true\n`;
/** What the member already has in `.codebuddy.json`: none of it is teamai's. */
const CODEBUDDY_JSON = {
  mcpServers: { 'my-user-server': { type: 'stdio', command: 'my-user-tool', args: [] } },
  disabledMcpServers: [],
  projects: { '/elsewhere/project': { mcpServers: { 'my-other': { type: 'stdio', command: 'other', args: [] } }, disabledMcpServers: [] } },
};
const TEAM_SERVERS = ['plain-api', 'secret-api'];

type CodebuddyJson = Record<string, unknown> & { projects?: Record<string, { mcpServers?: Record<string, unknown> }> };

/** One member's machine: a HOME, a team remote holding `files`, and helpers that run git and the built CLI there. */
interface Member {
  home: string;
  /** The `.codebuddy.json` CodeBuddy reads. */
  configFile: string;
  git(args: string[], cwd: string): string;
  teamai(args: string[], cwd: string): string;
  teamCommit(files: Record<string, string | null>): void;
  /** Turn the team's `sharing.gitExclude` on or off. */
  gitExclude(on: boolean): void;
  /** A committed business repo at `dir`, set up with teamai in project scope for `agents`. */
  project(dir: string, opts?: { agents?: string; committed?: Record<string, string> }): string;
  /** `git worktree add`, whose post-checkout hook prepares it with a pull; `pull` also pulls there, as a member opening it would. */
  worktree(repo: string, dir: string, opts?: { pull?: boolean }): Promise<string>;
  codebuddyJson(): CodebuddyJson;
  /** The servers in CodeBuddy's local scope for project key `key`. */
  local(key: string): Record<string, unknown> | undefined;
}

function member(name: string, opts: { files?: Record<string, string>; gitExclude?: boolean; configDir?: string } = {}): Member {
  const base = fs.mkdtempSync(path.join(sandbox, `${name}-`));
  const home = path.join(base, 'home');
  const configDir = opts.configDir ? path.join(base, opts.configDir) : home;
  const configFile = path.join(configDir, '.codebuddy.json');
  fs.mkdirSync(home, { recursive: true });
  write(configFile, json(CODEBUDDY_JSON));
  const env = (): NodeJS.ProcessEnv => {
    const e: NodeJS.ProcessEnv = {
      ...process.env,
      ...GIT_ENV,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      GIT_CONFIG_NOSYSTEM: '1',
      FORCE_COLOR: '0',
    };
    delete e.CODEBUDDY_CONFIG_DIR;
    if (opts.configDir) e.CODEBUDDY_CONFIG_DIR = configDir;
    delete e.LAB_TOKEN;
    e.NODE_OPTIONS = [e.NODE_OPTIONS, detached.nodeOptions].filter(Boolean).join(' ');
    return e;
  };
  const run = (command: string, args: string[], cwd: string): Run => {
    const r = spawnSync(command, args, { cwd, encoding: 'utf8', env: env() });
    return { code: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const git = (args: string[], cwd: string): string => {
    const r = run('git', args, cwd);
    if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.output}`);
    return r.output;
  };
  const teamai = (args: string[], cwd: string): string => {
    const r = run(process.execPath, [CLI, ...args], cwd);
    if (r.code !== 0) throw new Error(`teamai ${args.join(' ')} failed in ${cwd}: ${r.output}`);
    return r.output;
  };
  const url = `https://git.example.com/team/${path.basename(base)}.git`;
  const seed = path.join(base, 'seed');
  const remote = path.join(base, 'team.git');
  const teamYaml = (on: boolean): string =>
    [`team: ${path.basename(base)}`, `repo: ${url}`, 'provider: git', 'reviewers: []', sharing(on)].join('\n');
  write(path.join(seed, 'teamai.yaml'), teamYaml(opts.gitExclude ?? true));
  for (const [rel, content] of Object.entries(opts.files ?? TEAM)) write(path.join(seed, rel), content);
  git(['init', '-q', '-b', 'main'], seed);
  git(['add', '-A'], seed);
  git(['commit', '-q', '-m', 'seed'], seed);
  git(['clone', '-q', '--bare', seed, remote], base);
  git(['config', '--global', `url.${remote}.insteadOf`, url], base);
  git(['remote', 'add', 'origin', remote], seed);

  const teamCommit = (changes: Record<string, string | null>): void => {
    for (const [rel, content] of Object.entries(changes)) {
      if (content === null) fs.rmSync(path.join(seed, rel), { force: true });
      else write(path.join(seed, rel), content);
    }
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'team change'], seed);
    git(['push', '-q', 'origin', 'main'], seed);
  };
  const codebuddyJson = (): CodebuddyJson => JSON.parse(read(configFile)) as CodebuddyJson;
  return {
    home,
    configFile,
    git,
    teamai,
    teamCommit,
    gitExclude: (on) => teamCommit({ 'teamai.yaml': teamYaml(on) }),
    project: (dir, popts = {}) => {
      write(path.join(dir, 'README.md'), '# app\n');
      for (const [rel, content] of Object.entries(popts.committed ?? {})) write(path.join(dir, rel), content);
      git(['init', '-q', '-b', 'main'], dir);
      git(['add', '-A'], dir);
      git(['commit', '-q', '-m', 'app'], dir);
      const real = fs.realpathSync.native(dir);
      teamai(['init', url, '--provider', 'git', '--agent', popts.agents ?? 'codebuddy', '--scope', 'project', '--force'], real);
      return real;
    },
    worktree: async (repo, dir, wopts = {}) => {
      git(['worktree', 'add', '-q', dir, '-b', path.basename(dir)], repo);
      await detached.waitForExit();
      const real = fs.realpathSync.native(dir);
      if (wopts.pull !== false) {
        teamai(['pull'], real);
        await detached.waitForExit();
      }
      return real;
    },
    codebuddyJson,
    local: (key) => codebuddyJson().projects?.[key]?.mcpServers,
  };
}

/** A base directory for one case's repositories. */
const caseDir = (name: string): string => fs.mkdtempSync(path.join(sandbox, `${name}-`));

const status = (m: Member, dir: string): string[] =>
  m.git(['status', '--porcelain', '-uall'], dir).split('\n').filter(Boolean);

/** The exclude file git reads in `dir`'s checkout. */
const excludeFileOf = (m: Member, dir: string): string =>
  path.resolve(dir, m.git(['rev-parse', '--git-path', 'info/exclude'], dir).trim());

/** The lines of the MCP block in `file`, whose start marker carries a description. */
function mcpLines(file: string): string[] {
  const lines = fs.existsSync(file) ? read(file).split('\n') : [];
  const start = lines.findIndex((line) => line.startsWith('# [teamai:mcp-exclude:start]'));
  const end = lines.indexOf('# [teamai:mcp-exclude:end]');
  return start < 0 || end < start ? [] : lines.slice(start + 1, end);
}

/** The servers of a project's `.mcp.json`, or null when there is none. */
function projectServers(dir: string): Record<string, unknown> | null {
  const file = path.join(dir, '.mcp.json');
  return fs.existsSync(file) ? (JSON.parse(read(file)) as { mcpServers?: Record<string, unknown> }).mcpServers ?? {} : null;
}

/** Everything in `.codebuddy.json` but the local scopes of `keys`. */
function withoutLocal(data: CodebuddyJson, ...keys: string[]): unknown {
  const copy = structuredClone(data);
  for (const key of keys) delete copy.projects?.[key];
  return copy;
}

const names = (servers: Record<string, unknown> | null | undefined): string[] => Object.keys(servers ?? {}).sort();

beforeAll(() => {
  if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
  sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-codebuddy-mcp-local-e2e-')));
  detached = trackDetachedProcesses(sandbox);
});

afterAll(async () => {
  if (detached) await detached.waitForExit();
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
}, 65_000);

// The hook scripts are POSIX shell.
describe.skipIf(process.platform === 'win32')('CodeBuddy gets the team\'s project MCP servers from its local scope (#915)', () => {
  it('fills the local scope of the main checkout and of a linked worktree, each under its own path, and writes no .mcp.json', async () => {
    const m = member('two-worktrees');
    const root = caseDir('two-worktrees');
    const main = m.project(path.join(root, 'main'));
    const wt = await m.worktree(main, path.join(root, 'wt'));

    for (const key of [main, wt]) {
      expect(names(m.local(key))).toEqual(TEAM_SERVERS);
      expect(JSON.stringify(m.local(key))).toContain(TOKEN);
    }
    // Every other key of the member's file is as it was.
    expect(withoutLocal(m.codebuddyJson(), main, wt)).toEqual(CODEBUDDY_JSON);
    for (const dir of [main, wt]) {
      expect(projectServers(dir)).toBeNull();
      expect(status(m, dir)).toEqual([]);
    }
    expect(mcpLines(excludeFileOf(m, main))).toEqual([]);

    // A second pull changes nothing.
    const before = read(m.configFile);
    m.teamai(['pull'], wt);
    m.teamai(['pull'], main);
    expect(read(m.configFile)).toBe(before);
  }, 120_000);

  it('gives a new worktree its servers through the pull git runs when it creates it', async () => {
    const m = member('prepared');
    const root = caseDir('prepared');
    const main = m.project(path.join(root, 'main'));
    const wt = await m.worktree(main, path.join(root, 'wt'), { pull: false });

    expect(names(m.local(wt))).toEqual(TEAM_SERVERS);
    expect(projectServers(wt)).toBeNull();
    expect(status(m, wt)).toEqual([]);
  }, 120_000);

  it('drops teamai\'s servers from the local scope of a worktree that is gone on the next pull, and keeps the member\'s', async () => {
    const m = member('removed');
    const root = caseDir('removed');
    const main = m.project(path.join(root, 'main'));
    const wt = await m.worktree(main, path.join(root, 'wt'));
    // The member adds a server of their own to the worktree's local scope (`codebuddy mcp add`).
    const mine = { type: 'stdio', command: 'my-local-tool', args: [] };
    const data = m.codebuddyJson();
    data.projects![wt].mcpServers = { ...data.projects![wt].mcpServers, 'my-local': mine };
    write(m.configFile, json(data));

    m.git(['worktree', 'remove', '--force', wt], main);
    const out = m.teamai(['pull'], main);

    expect(out).toContain(`(projects[${JSON.stringify(wt)}]): that worktree is gone.`);
    expect(m.local(wt)).toEqual({ 'my-local': mine });
    expect(names(m.local(main))).toEqual(TEAM_SERVERS);
    expect(withoutLocal(m.codebuddyJson(), main, wt)).toEqual(CODEBUDDY_JSON);
  }, 120_000);

  it('leaves the team\'s tracked .mcp.json as it is', () => {
    const m = member('tracked');
    const teamFile = json({ mcpServers: { 'repo-server': { type: 'stdio', command: 'repo-tool', args: [] } } });
    const main = m.project(path.join(caseDir('tracked'), 'main'), { committed: { '.mcp.json': teamFile } });

    expect(read(path.join(main, '.mcp.json'))).toBe(teamFile);
    expect(status(m, main)).toEqual([]);
    expect(names(m.local(main))).toEqual(TEAM_SERVERS);
  }, 120_000);

  it('turning the option on moves teamai\'s servers out of .mcp.json and releases its MCP line; turning it off moves them back', () => {
    const m = member('move-out', { gitExclude: false });
    const main = m.project(path.join(caseDir('move-out'), 'main'));
    expect(names(projectServers(main))).toEqual(TEAM_SERVERS);
    expect(mcpLines(excludeFileOf(m, main))).toEqual(['/.mcp.json']);
    expect(m.local(main)).toBeUndefined();

    m.gitExclude(true);
    m.teamai(['pull'], main);

    expect(fs.existsSync(path.join(main, '.mcp.json'))).toBe(false);
    expect(names(m.local(main))).toEqual(TEAM_SERVERS);
    expect(mcpLines(excludeFileOf(m, main))).toEqual([]);
    expect(status(m, main)).toEqual([]);

    m.gitExclude(false);
    m.teamai(['pull'], main);

    expect(names(projectServers(main))).toEqual(TEAM_SERVERS);
    expect(m.local(main)).toBeUndefined();
    expect(m.codebuddyJson()).toEqual(CODEBUDDY_JSON);
    expect(mcpLines(excludeFileOf(m, main))).toEqual(['/.mcp.json']);
  }, 120_000);

  it('turning the option on also moves the servers teamai has no record of, removes a removed server\'s copy, and keeps the member\'s', () => {
    const m = member('unrecorded', { gitExclude: false, files: { ...TEAM, 'mcp/mcp.yaml': servers(SECRET_API, PLAIN_API, OLD_API) } });
    const main = m.project(path.join(caseDir('unrecorded'), 'main'));
    const file = path.join(main, '.mcp.json');
    const written = JSON.parse(read(file)) as { mcpServers: Record<string, unknown> };
    expect(names(written.mcpServers)).toEqual(['old-api', ...TEAM_SERVERS]);

    // teamai's record of what it wrote is lost; the member adds a server of their own.
    const projects = path.join(m.home, '.teamai', 'projects');
    for (const partition of fs.readdirSync(projects)) {
      fs.rmSync(path.join(projects, partition, 'workspaces'), { recursive: true, force: true });
    }
    const mine = { type: 'stdio', command: 'my-tool', args: [] };
    write(file, json({ mcpServers: { ...written.mcpServers, mine } }));
    m.teamCommit({ 'mcp/mcp.yaml': servers(SECRET_API, PLAIN_API) });
    m.gitExclude(true);
    m.teamai(['pull'], main);

    expect(projectServers(main)).toEqual({ mine });
    expect(names(m.local(main))).toEqual(TEAM_SERVERS);
    expect(read(file)).not.toContain(TOKEN);
  }, 120_000);

  it('turning the option on keeps in .mcp.json, and names, a teamai server the member changed', () => {
    const m = member('edited', { gitExclude: false });
    const main = m.project(path.join(caseDir('edited'), 'main'));
    const file = path.join(main, '.mcp.json');
    const written = JSON.parse(read(file)) as { mcpServers: Record<string, unknown> };
    const edited = { ...written.mcpServers['plain-api'] as object, headers: { 'X-Mine': 'yes' } };
    write(file, json({ mcpServers: { ...written.mcpServers, 'plain-api': edited } }));

    m.gitExclude(true);
    const out = m.teamai(['pull'], main);

    expect(projectServers(main)).toEqual({ 'plain-api': edited });
    expect(out).toContain(`Kept MCP server plain-api in ${file}: you changed it since teamai wrote it.`);
    expect(names(m.local(main))).toEqual(TEAM_SERVERS);
    expect(read(file)).not.toContain(TOKEN);
  }, 120_000);

  it('uninstall removes exactly teamai\'s servers from the local scope of every worktree', async () => {
    const m = member('uninstall');
    const root = caseDir('uninstall');
    const main = m.project(path.join(root, 'main'));
    const wt = await m.worktree(main, path.join(root, 'wt'));
    const mine = { type: 'stdio', command: 'my-local-tool', args: [] };
    const data = m.codebuddyJson();
    data.projects![main].mcpServers = { ...data.projects![main].mcpServers, 'my-local': mine };
    write(m.configFile, json(data));

    m.teamai(['uninstall', '--force'], main);

    expect(m.local(main)).toEqual({ 'my-local': mine });
    expect(m.local(wt)).toBeUndefined();
    expect(withoutLocal(m.codebuddyJson(), main)).toEqual(CODEBUDDY_JSON);
    expect(read(m.configFile)).not.toContain(TOKEN);
  }, 120_000);

  it('writes to the .codebuddy.json in CODEBUDDY_CONFIG_DIR when it is set', () => {
    const m = member('config-dir', { configDir: 'codebuddy-config' });
    const main = m.project(path.join(caseDir('config-dir'), 'main'));

    expect(m.configFile).not.toBe(path.join(m.home, '.codebuddy.json'));
    expect(names(m.local(main))).toEqual(TEAM_SERVERS);
    expect(fs.existsSync(path.join(m.home, '.codebuddy.json'))).toBe(false);
    expect(projectServers(main)).toBeNull();
  }, 120_000);
});
