/**
 * E2E (#915): with `sharing.gitExclude` on, Claude Code gets the team's
 * project MCP servers from its local scope, `~/.claude.json` →
 * `projects[<key>].mcpServers`, instead of the project's `.mcp.json`.
 *
 * - The key is the one Claude Code itself files a checkout under: the real
 *   path of the main checkout, for it and for every linked worktree. In a
 *   `--separate-git-dir` repository a linked worktree's key is the git
 *   directory, and in a submodule the checkout itself (a linked worktree of
 *   the submodule: its git directory under the superproject's `.git/modules`).
 * - The team's tracked `.mcp.json` shows no change, and a resolved token
 *   leaves the working tree.
 * - Turning the option on moves teamai's servers out of `.mcp.json`
 *   (recorded, or proven teamai's by the team's history), keeps the member's
 *   own servers and those CodeBuddy still writes there, and deletes a file
 *   only teamai's servers made. Turning it off moves them back.
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

const TOKEN = 'lab-token-value-5e1f';
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
/** What the member already has in `~/.claude.json`: none of it is teamai's. */
const CLAUDE_JSON = {
  userID: 'member-id',
  mcpServers: { 'my-user-server': { type: 'stdio', command: 'my-user-tool', args: [] } },
  projects: { '/elsewhere/project': { allowedTools: ['Bash'], mcpServers: { 'my-other': { type: 'stdio', command: 'other', args: [] } } } },
};

/** One member's machine: a HOME, a team remote holding `files`, and helpers that run git and the built CLI there. */
interface Member {
  home: string;
  git(args: string[], cwd: string): string;
  teamai(args: string[], cwd: string): string;
  url: string;
  teamCommit(files: Record<string, string | null>): void;
  /** Turn the team's `sharing.gitExclude` on or off. */
  gitExclude(on: boolean): void;
  /** A committed business repo at `dir` (`git init` with `initArgs`, `committed` files), set up with teamai in project scope. */
  project(dir: string, opts?: { initArgs?: string[]; agents?: string; committed?: Record<string, string> }): string;
  /** `git worktree add` (its post-checkout hook pulls there), then an explicit pull, as a member opening it would. */
  worktree(repo: string, dir: string, branch?: string): Promise<string>;
  /** `~/.claude.json` as Claude Code reads it. */
  claudeJson(): Record<string, unknown> & { projects?: Record<string, { mcpServers?: Record<string, unknown> }> };
  /** The servers in Claude's local scope for project key `key`. */
  local(key: string): Record<string, unknown> | undefined;
}

function member(name: string, opts: { files?: Record<string, string>; gitExclude?: boolean } = {}): Member {
  const base = fs.mkdtempSync(path.join(sandbox, `${name}-`));
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  write(path.join(home, '.claude.json'), json(CLAUDE_JSON));
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
    delete e.CLAUDE_CONFIG_DIR;
    delete e.CODEX_HOME;
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
  // `git submodule add` of a local path.
  git(['config', '--global', 'protocol.file.allow', 'always'], base);
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
  const claudeJson = () => JSON.parse(read(path.join(home, '.claude.json')));
  return {
    home,
    git,
    teamai,
    url,
    teamCommit,
    gitExclude: (on) => teamCommit({ 'teamai.yaml': teamYaml(on) }),
    project: (dir, popts = {}) => {
      write(path.join(dir, 'README.md'), '# app\n');
      for (const [rel, content] of Object.entries(popts.committed ?? {})) write(path.join(dir, rel), content);
      git(['init', '-q', '-b', 'main', ...popts.initArgs ?? []], dir);
      git(['add', '-A'], dir);
      git(['commit', '-q', '-m', 'app'], dir);
      const real = fs.realpathSync.native(dir);
      teamai(['init', url, '--provider', 'git', '--agent', popts.agents ?? 'claude', '--scope', 'project', '--force'], real);
      return real;
    },
    worktree: async (repo, dir, branch = path.basename(dir)) => {
      git(['worktree', 'add', '-q', dir, '-b', branch], repo);
      await detached.waitForExit();
      const real = fs.realpathSync.native(dir);
      teamai(['pull'], real);
      await detached.waitForExit();
      return real;
    },
    claudeJson,
    local: (key) => claudeJson().projects?.[key]?.mcpServers,
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

/** Everything in `~/.claude.json` but teamai's servers in `key`'s local scope. */
function withoutLocal(data: ReturnType<Member['claudeJson']>, key: string): unknown {
  const copy = structuredClone(data);
  delete copy.projects?.[key];
  return copy;
}

beforeAll(() => {
  if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
  sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-claude-mcp-local-e2e-')));
  detached = trackDetachedProcesses(sandbox);
});

afterAll(async () => {
  if (detached) await detached.waitForExit();
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
}, 65_000);

// The hook scripts are POSIX shell.
describe.skipIf(process.platform === 'win32')('Claude gets the team\'s project MCP servers from its local scope (#915)', () => {
  it('a pull in the main checkout and in a linked worktree fills the main checkout\'s local scope, and writes no .mcp.json', async () => {
    const m = member('main-and-worktree');
    const root = caseDir('main-and-worktree');
    const main = m.project(path.join(root, 'main'));
    const wt = await m.worktree(main, path.join(root, 'wt'));

    const local = m.local(main);
    expect(Object.keys(local ?? {}).sort()).toEqual(['plain-api', 'secret-api']);
    expect(JSON.stringify(local)).toContain(TOKEN);
    expect(Object.keys(m.claudeJson().projects ?? {})).not.toContain(wt);
    // Every other key of the member's file is as it was.
    expect(withoutLocal(m.claudeJson(), main)).toEqual(CLAUDE_JSON);
    for (const dir of [main, wt]) {
      expect(projectServers(dir)).toBeNull();
      expect(status(m, dir)).toEqual([]);
    }
    expect(mcpLines(excludeFileOf(m, main))).toEqual([]);

    // A second pull in the worktree changes nothing.
    const before = read(path.join(m.home, '.claude.json'));
    m.teamai(['pull'], wt);
    expect(read(path.join(m.home, '.claude.json'))).toBe(before);

    // The servers are teamai's in every checkout, whichever pulled them in: old-api, which only the
    // main checkout's pull wrote, goes with a pull in the worktree once the team removes it, even
    // edited by hand, which no team version matches.
    m.teamCommit({ 'mcp/mcp.yaml': servers(SECRET_API, PLAIN_API, OLD_API) });
    m.teamai(['pull'], main);
    const data = m.claudeJson();
    data.projects![main].mcpServers!['old-api'] = { type: 'http', url: 'https://edited.example.com/mcp' };
    write(path.join(m.home, '.claude.json'), json(data));
    m.teamCommit({ 'mcp/mcp.yaml': servers(SECRET_API, PLAIN_API) });
    m.teamai(['pull'], wt);
    expect(Object.keys(m.local(main) ?? {}).sort()).toEqual(['plain-api', 'secret-api']);
  }, 120_000);

  it('leaves the team\'s tracked .mcp.json as it is', () => {
    const m = member('tracked');
    const teamFile = json({ mcpServers: { 'repo-server': { type: 'stdio', command: 'repo-tool', args: [] } } });
    const main = m.project(path.join(caseDir('tracked'), 'main'), { committed: { '.mcp.json': teamFile } });

    expect(read(path.join(main, '.mcp.json'))).toBe(teamFile);
    expect(status(m, main)).toEqual([]);
    expect(Object.keys(m.local(main) ?? {}).sort()).toEqual(['plain-api', 'secret-api']);
  }, 120_000);

  it('turning the option on moves teamai\'s servers out of .mcp.json, deletes the file only they made, and releases its MCP line', () => {
    const m = member('move-out', { gitExclude: false });
    const main = m.project(path.join(caseDir('move-out'), 'main'));
    expect(Object.keys(projectServers(main) ?? {}).sort()).toEqual(['plain-api', 'secret-api']);
    expect(mcpLines(excludeFileOf(m, main))).toEqual(['/.mcp.json']);
    expect(m.local(main)).toBeUndefined();

    m.gitExclude(true);
    m.teamai(['pull'], main);

    expect(fs.existsSync(path.join(main, '.mcp.json'))).toBe(false);
    expect(Object.keys(m.local(main) ?? {}).sort()).toEqual(['plain-api', 'secret-api']);
    expect(mcpLines(excludeFileOf(m, main))).toEqual([]);
    expect(status(m, main)).toEqual([]);

    // And off again: back into .mcp.json, out of the local scope.
    m.gitExclude(false);
    m.teamai(['pull'], main);

    expect(Object.keys(projectServers(main) ?? {}).sort()).toEqual(['plain-api', 'secret-api']);
    expect(m.local(main) ?? {}).toEqual({});
    expect(withoutLocal(m.claudeJson(), main)).toEqual(CLAUDE_JSON);
    expect(mcpLines(excludeFileOf(m, main))).toEqual(['/.mcp.json']);
  }, 120_000);

  it('turning the option on also moves the servers teamai has no record of, removes a removed server\'s copy, and keeps the member\'s', () => {
    const m = member('unrecorded', { gitExclude: false, files: { ...TEAM, 'mcp/mcp.yaml': servers(SECRET_API, PLAIN_API, OLD_API) } });
    const main = m.project(path.join(caseDir('unrecorded'), 'main'));
    const file = path.join(main, '.mcp.json');
    const written = JSON.parse(read(file)) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(written.mcpServers).sort()).toEqual(['old-api', 'plain-api', 'secret-api']);

    // teamai's record of what it wrote is lost; the member adds a server of their own.
    const projects = path.join(m.home, '.teamai', 'projects');
    for (const partition of fs.readdirSync(projects)) {
      fs.rmSync(path.join(projects, partition, 'workspaces'), { recursive: true, force: true });
    }
    const mine = { type: 'stdio', command: 'my-tool', args: [] };
    write(file, json({ mcpServers: { ...written.mcpServers, mine } }));
    // The team removes old-api and turns the option on.
    m.teamCommit({ 'mcp/mcp.yaml': servers(SECRET_API, PLAIN_API) });
    m.gitExclude(true);
    m.teamai(['pull'], main);

    expect(projectServers(main)).toEqual({ mine });
    expect(Object.keys(m.local(main) ?? {}).sort()).toEqual(['plain-api', 'secret-api']);
    expect(read(file)).not.toContain(TOKEN);
  }, 120_000);

  it('turning the option on keeps in .mcp.json, and names, a teamai server the member changed', () => {
    const m = member('edited', { gitExclude: false });
    const main = m.project(path.join(caseDir('edited'), 'main'));
    const file = path.join(main, '.mcp.json');
    const written = JSON.parse(read(file)) as { mcpServers: Record<string, unknown> };
    const edited = { type: 'http', url: 'https://plain.example.com/mcp', headers: { 'X-Mine': 'yes' } };
    write(file, json({ mcpServers: { ...written.mcpServers, 'plain-api': edited } }));

    m.gitExclude(true);
    const out = m.teamai(['pull'], main);

    expect(projectServers(main)).toEqual({ 'plain-api': edited });
    expect(out).toContain(`Kept MCP server plain-api in ${file}: you changed it since teamai wrote it.`);
    expect(Object.keys(m.local(main) ?? {}).sort()).toEqual(['plain-api', 'secret-api']);
    expect(m.local(main)?.['plain-api']).not.toEqual(edited);
    expect(read(file)).not.toContain(TOKEN);

    // It is the member's now: a later pull leaves it, and says nothing more.
    expect(m.teamai(['pull', '--force'], main)).not.toContain('Kept MCP server plain-api');
    expect(projectServers(main)).toEqual({ 'plain-api': edited });
  }, 120_000);

  it('moves the servers Claude and CodeBuddy shared in .mcp.json out of it, to both local scopes', () => {
    const m = member('codebuddy', { gitExclude: false });
    const main = m.project(path.join(caseDir('codebuddy'), 'main'), { agents: 'claude,codebuddy' });
    expect(Object.keys(projectServers(main) ?? {}).sort()).toEqual(['plain-api', 'secret-api']);

    m.gitExclude(true);
    m.teamai(['pull'], main);

    expect(projectServers(main)).toBeNull();
    expect(Object.keys(m.local(main) ?? {}).sort()).toEqual(['plain-api', 'secret-api']);
    const codebuddy = JSON.parse(read(path.join(m.home, '.codebuddy.json'))) as { projects: Record<string, { mcpServers: object }> };
    expect(Object.keys(codebuddy.projects[main].mcpServers).sort()).toEqual(['plain-api', 'secret-api']);
    expect(mcpLines(excludeFileOf(m, main))).toEqual([]);
    expect(status(m, main)).toEqual([]);
  }, 120_000);

  it('uninstall removes exactly teamai\'s servers from the local scope', () => {
    const m = member('uninstall');
    const main = m.project(path.join(caseDir('uninstall'), 'main'));
    // The member adds a server of their own to the same local scope (`claude mcp add`).
    const data = m.claudeJson();
    const mine = { type: 'stdio', command: 'my-local-tool', args: [] };
    data.projects![main].mcpServers = { ...data.projects![main].mcpServers, 'my-local': mine };
    write(path.join(m.home, '.claude.json'), json(data));

    m.teamai(['uninstall', '--force'], main);

    expect(m.local(main)).toEqual({ 'my-local': mine });
    expect(withoutLocal(m.claudeJson(), main)).toEqual(CLAUDE_JSON);
    expect(read(path.join(m.home, '.claude.json'))).not.toContain(TOKEN);
  }, 120_000);

  it('files a --separate-git-dir repository\'s main checkout under its own path, and its linked worktrees under the git directory', async () => {
    const m = member('separate-git-dir');
    const root = fs.realpathSync.native(caseDir('separate-git-dir'));
    const main = m.project(path.join(root, 'main'), { initArgs: [`--separate-git-dir=${path.join(root, 'main.git')}`] });
    const wt = await m.worktree(main, path.join(root, 'wt'));

    expect(Object.keys(m.local(main) ?? {}).sort()).toEqual(['plain-api', 'secret-api']);
    expect(Object.keys(m.local(path.join(root, 'main.git')) ?? {}).sort()).toEqual(['plain-api', 'secret-api']);
    expect(Object.keys(m.claudeJson().projects ?? {})).not.toContain(wt);
    for (const dir of [main, wt]) {
      expect(projectServers(dir)).toBeNull();
      expect(status(m, dir)).toEqual([]);
    }
  }, 120_000);

  describe('a local scope whose checkout is gone: the git directory of a removed linked worktree in a --separate-git-dir repository', () => {
    /** Main checkout and the git directory key its removed linked worktree's servers stay under, holding a server of the member's too. */
    async function orphanedKey(name: string): Promise<{ m: Member; main: string; orphan: string; mine: unknown }> {
      const m = member(name);
      const root = fs.realpathSync.native(caseDir(name));
      const orphan = path.join(root, 'main.git');
      const main = m.project(path.join(root, 'main'), { initArgs: [`--separate-git-dir=${orphan}`] });
      const wt = await m.worktree(main, path.join(root, 'wt'));
      m.git(['worktree', 'remove', '--force', wt], main);
      const data = m.claudeJson();
      const mine = { type: 'stdio', command: 'my-local-tool', args: [] };
      data.projects![orphan].mcpServers = { ...data.projects![orphan].mcpServers, 'my-local': mine };
      write(path.join(m.home, '.claude.json'), json(data));
      expect(Object.keys(m.local(orphan) ?? {}).sort()).toEqual(['my-local', 'plain-api', 'secret-api']);
      return { m, main, orphan, mine };
    }

    it('uninstall removes teamai\'s servers from it', async () => {
      const { m, main, orphan, mine } = await orphanedKey('orphan-uninstall');
      // A pull in between forgets the removed worktree.
      m.teamai(['pull', '--force'], main);

      m.teamai(['uninstall', '--force'], main);

      expect(m.local(orphan)).toEqual({ 'my-local': mine });
      expect(m.local(main) ?? {}).toEqual({});
      expect(read(path.join(m.home, '.claude.json'))).not.toContain(TOKEN);
    }, 120_000);

    it('turning the option off removes teamai\'s servers from it', async () => {
      const { m, main, orphan, mine } = await orphanedKey('orphan-off');

      m.gitExclude(false);
      m.teamai(['pull'], main);

      expect(m.local(orphan)).toEqual({ 'my-local': mine });
      expect(m.local(main) ?? {}).toEqual({});
      expect(Object.keys(projectServers(main) ?? {}).sort()).toEqual(['plain-api', 'secret-api']);
      expect(read(path.join(m.home, '.claude.json'))).not.toContain(TOKEN);
    }, 120_000);
  });

  it('files a submodule under its checkout, and a linked worktree of it under its git directory', async () => {
    const m = member('submodule');
    const root = fs.realpathSync.native(caseDir('submodule'));
    const libSeed = path.join(root, 'lib-seed');
    write(path.join(libSeed, 'README.md'), '# lib\n');
    m.git(['init', '-q', '-b', 'main'], libSeed);
    m.git(['add', '-A'], libSeed);
    m.git(['commit', '-q', '-m', 'lib'], libSeed);
    const superRepo = path.join(root, 'super');
    write(path.join(superRepo, 'README.md'), '# super\n');
    m.git(['init', '-q', '-b', 'main'], superRepo);
    m.git(['add', '-A'], superRepo);
    m.git(['commit', '-q', '-m', 'super'], superRepo);
    m.git(['submodule', 'add', '-q', libSeed, 'lib'], superRepo);
    m.git(['commit', '-q', '-m', 'lib'], superRepo);
    const lib = path.join(superRepo, 'lib');
    m.teamai(['init', m.url, '--provider', 'git', '--agent', 'claude', '--scope', 'project', '--force'], lib);
    const wt = await m.worktree(lib, path.join(root, 'lib-wt'));

    expect(Object.keys(m.local(lib) ?? {}).sort()).toEqual(['plain-api', 'secret-api']);
    expect(Object.keys(m.local(path.join(superRepo, '.git', 'modules', 'lib')) ?? {}).sort()).toEqual(['plain-api', 'secret-api']);
    expect(Object.keys(m.claudeJson().projects ?? {})).not.toContain(superRepo);
    for (const dir of [lib, wt]) {
      expect(projectServers(dir)).toBeNull();
      expect(status(m, dir)).toEqual([]);
    }
  }, 120_000);
});
