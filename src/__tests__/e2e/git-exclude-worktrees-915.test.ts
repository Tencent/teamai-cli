/**
 * E2E (#915): one `delivered` git exclude block serves every live
 * checkout of a clone, and paths in other repositories are kept out of git
 * where git reads them.
 *
 * - The block in an exclude file is the union of the lists of the live
 *   checkouts whose paths route to it, so a pull in one worktree keeps another
 *   worktree's lines, also in a `--separate-git-dir` repo and in a project that
 *   is a submodule. A removed or pruned worktree's lines go on the next pull.
 * - A delivered path that exists in another live checkout without being in
 *   that checkout's list (a member's file there) gets no line, since the line
 *   would hide that file too; pull names it. The member's own
 *   `.claude/settings.local.json` in a linked worktree is never such a file.
 * - A pull keeps the shared MCP line while any checkout's config, the main
 *   checkout of a `--separate-git-dir` repo included, still holds a value
 *   teamai resolved; that checkout's own pull cleans it and releases the line.
 * - A tool folder that is a submodule or a nested clone gets its lines in that
 *   repository's exclude file, in this project's own `delivered/<id>` block.
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
const skillMd = (name: string): string => `---\nname: ${name}\ndescription: ${name} fixture\n---\n\n${name} body.\n`;
const rule = (title: string): string => `# ${title}\n\n${title} rule.\n`;

/**
 * Two roles, so two checkouts' lists can differ: a role switch pulled in one
 * checkout removes the old role's copies there and leaves them in the others.
 */
const TEAM = {
  'manifest/roles.yaml': [
    'version: 1', 'roles:',
    '  - id: fe', '    resources:', '      knowledge: [fe]', '      skills: [fe]',
    '  - id: be', '    resources:', '      knowledge: [be]', '      skills: [be]', '',
  ].join('\n'),
  'skills/fe/fe-skill/SKILL.md': skillMd('fe-skill'),
  'skills/be/be-skill/SKILL.md': skillMd('be-skill'),
  'rules/team-rule.md': rule('Team'),
};
const ON = 'sharing:\n  gitExclude:\n    enabled: true\n';
const TOKEN = 'lab-token-value-5e1f';
/** One MCP server whose header teamai resolves into the project's `.mcp.json`. */
const MCP_TEAM = {
  ...TEAM,
  'mcp/mcp.yaml': [
    'servers:', '  - name: secret-api', '    transport: http', '    url: https://api.example.com/mcp',
    '    headers:', '      Authorization: "Bearer ${LAB_TOKEN}"', '',
  ].join('\n'),
  'env/env.yaml': `variables:\n  - key: LAB_TOKEN\n    value: "${TOKEN}"\n`,
};
const MCP_OFF = 'sharing:\n  gitExclude:\n    enabled: false\n  mcp:\n    autoApply: true\n';
const HOOKS_ON = [
  'sharing:', '  gitExclude:', '    enabled: true', '  hooks:', '    autoApply: true', '    requireTeamScripts: false', '',
].join('\n');

/** One member's machine: a HOME, a team remote holding `files`, and helpers that run git and the built CLI there. */
interface Member {
  home: string;
  run(command: string, args: string[], cwd: string): Run;
  git(args: string[], cwd: string): string;
  teamai(args: string[], cwd: string): string;
  url: string;
  teamCommit(files: Record<string, string | null>): void;
  /** A committed business repo at `dir` (`git init` with `initArgs`), set up with teamai in project scope. */
  project(dir: string, opts?: { initArgs?: string[]; agents?: string; before?: (dir: string) => void }): string;
  /** `git worktree add` (its post-checkout hook pulls there), then an explicit pull, as a member opening it would. */
  worktree(repo: string, dir: string, branch?: string): Promise<string>;
}

function member(name: string, files: Record<string, string> = TEAM, sharing = ON): Member {
  const base = fs.mkdtempSync(path.join(sandbox, `${name}-`));
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
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
  write(path.join(seed, 'teamai.yaml'), [`team: ${path.basename(base)}`, `repo: ${url}`, 'provider: git', 'reviewers: []', sharing].join('\n'));
  for (const [rel, content] of Object.entries(files)) write(path.join(seed, rel), content);
  git(['init', '-q', '-b', 'main'], seed);
  git(['add', '-A'], seed);
  git(['commit', '-q', '-m', 'seed'], seed);
  git(['clone', '-q', '--bare', seed, remote], base);
  git(['config', '--global', `url.${remote}.insteadOf`, url], base);
  // `git submodule add` of a local path.
  git(['config', '--global', 'protocol.file.allow', 'always'], base);
  git(['remote', 'add', 'origin', remote], seed);

  return {
    home,
    run,
    git,
    teamai,
    url,
    teamCommit: (changes) => {
      for (const [rel, content] of Object.entries(changes)) {
        if (content === null) fs.rmSync(path.join(seed, rel), { force: true });
        else write(path.join(seed, rel), content);
      }
      git(['add', '-A'], seed);
      git(['commit', '-q', '-m', 'team change'], seed);
      git(['push', '-q', 'origin', 'main'], seed);
    },
    project: (dir, opts = {}) => {
      write(path.join(dir, 'README.md'), '# app\n');
      git(['init', '-q', '-b', 'main', ...opts.initArgs ?? []], dir);
      opts.before?.(dir);
      git(['add', '-A'], dir);
      git(['commit', '-q', '-m', 'app'], dir);
      const real = fs.realpathSync.native(dir);
      teamai(['init', url, '--provider', 'git', '--agent', opts.agents ?? 'claude', '--scope', 'project', '--role', 'fe', '--force'], real);
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
  };
}

/** A base directory for one case's repositories. */
const caseDir = (name: string): string => fs.mkdtempSync(path.join(sandbox, `${name}-`));

const status = (m: Member, dir: string, ...args: string[]): string[] =>
  m.git(['status', '--porcelain', '-uall', ...args], dir).split('\n').filter(Boolean);

/** The exclude file git reads in `dir`'s checkout. */
const excludeFileOf = (m: Member, dir: string): string =>
  path.resolve(dir, m.git(['rev-parse', '--git-path', 'info/exclude'], dir).trim());

/** The lines of `owner`'s block (`delivered`, or a `delivered/` prefix when `owner` ends in `/`) in `file`. */
function blockLines(file: string, owner = 'delivered'): string[] {
  const lines = fs.existsSync(file) ? read(file).split('\n') : [];
  const marker = (kind: string) => (line: string) => owner.endsWith('/')
    ? line.startsWith(`# [teamai:${owner}`) && line.endsWith(`:${kind}]`)
    : line === `# [teamai:${owner}:${kind}]`;
  const start = lines.findIndex(marker('start'));
  const end = lines.findIndex(marker('end'));
  return start < 0 || end < start ? [] : lines.slice(start + 1, end);
}

/** The lines of the MCP block in `file`, whose start marker carries a description. */
function mcpLines(file: string): string[] {
  const lines = fs.existsSync(file) ? read(file).split('\n') : [];
  const start = lines.findIndex((line) => line.startsWith('# [teamai:mcp-exclude:start]'));
  const end = lines.indexOf('# [teamai:mcp-exclude:end]');
  return start < 0 || end < start ? [] : lines.slice(start + 1, end);
}

/** What `git add -A` would stage in `dir` (dry run). */
const addable = (m: Member, dir: string): string[] =>
  m.git(['add', '-A', '--dry-run'], dir).split('\n').filter(Boolean).map((line) => line.replace(/^add '(.*)'$/, '$1'));

beforeAll(() => {
  if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
  sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-git-exclude-worktrees-e2e-')));
  detached = trackDetachedProcesses(sandbox);
});

afterAll(async () => {
  if (detached) await detached.waitForExit();
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
}, 65_000);

// The hook scripts and git wrapper are POSIX shell.
describe.skipIf(process.platform === 'win32')('one delivered block serves every live checkout (#915)', () => {
  it('a pull in either of two worktrees keeps the other checkout\'s lines, and the member\'s files stay visible', async () => {
    const m = member('two-worktrees');
    const root = caseDir('two-worktrees');
    const main = m.project(path.join(root, 'main'));
    const wt = await m.worktree(main, path.join(root, 'wt'));
    for (const checkout of [main, wt]) write(path.join(checkout, 'notes.md'), 'mine\n');

    // The member switches role and pulls in the worktree only: the main checkout keeps its fe copies.
    m.teamai(['roles', 'set', 'be'], wt);
    m.teamai(['pull'], wt);
    expect(fs.existsSync(path.join(wt, '.claude/skills/fe-skill'))).toBe(false);
    expect(fs.existsSync(path.join(main, '.claude/skills/fe-skill/SKILL.md'))).toBe(true);
    expect(status(m, main)).toEqual(['?? notes.md']);
    expect(status(m, wt)).toEqual(['?? notes.md']);

    // And the other way round: switched back, the main checkout pulls; the worktree keeps its be copies.
    m.teamai(['roles', 'set', 'fe'], main);
    m.teamai(['pull'], main);
    expect(fs.existsSync(path.join(wt, '.claude/skills/be-skill/SKILL.md'))).toBe(true);
    expect(status(m, wt)).toEqual(['?? notes.md']);
    expect(status(m, main)).toEqual(['?? notes.md']);
    expect(addable(m, wt)).toEqual(['notes.md']);
  }, 120_000);

  it('keeps the main checkout\'s lines when a linked worktree of a --separate-git-dir repo pulls', async () => {
    const m = member('separate-git-dir');
    const root = caseDir('separate-git-dir');
    const main = m.project(path.join(root, 'main'), { initArgs: [`--separate-git-dir=${path.join(root, 'main.git')}`] });
    const wt = await m.worktree(main, path.join(root, 'wt'));
    expect(excludeFileOf(m, main)).toBe(path.join(fs.realpathSync.native(root), 'main.git', 'info', 'exclude'));

    m.teamai(['roles', 'set', 'be'], wt);
    m.teamai(['pull'], wt);

    expect(fs.existsSync(path.join(main, '.claude/skills/fe-skill/SKILL.md'))).toBe(true);
    expect(status(m, main)).toEqual([]);
    expect(status(m, wt)).toEqual([]);
  }, 120_000);

  it('keeps the MCP line while the main checkout of a --separate-git-dir repo holds the resolved value a linked worktree\'s pull dropped, until the main checkout pulls', async () => {
    const m = member('mcp-separate', MCP_TEAM, MCP_OFF);
    const root = caseDir('mcp-separate');
    // sharing.gitExclude off: with it on, Claude and CodeBuddy take the servers from their local scopes, and
    // nothing writes .mcp.json. The MCP line does not depend on it.
    const main = m.project(path.join(root, 'main'), { initArgs: [`--separate-git-dir=${path.join(root, 'main.git')}`], agents: 'codebuddy' });
    const wt = await m.worktree(main, path.join(root, 'wt'));
    const exclude = excludeFileOf(m, wt);
    expect(read(path.join(main, '.mcp.json'))).toContain(TOKEN);
    expect(read(path.join(wt, '.mcp.json'))).toContain(TOKEN);
    expect(mcpLines(exclude)).toEqual(['/.mcp.json']);

    // The server leaves the team; only the linked worktree pulls.
    m.teamCommit({ 'mcp/mcp.yaml': 'servers: []\n' });
    const out = m.teamai(['pull'], wt);

    expect(read(path.join(wt, '.mcp.json'))).not.toContain(TOKEN);
    // The main checkout's own pull cleans its config; until then git must not see it.
    expect(read(path.join(main, '.mcp.json'))).toContain(TOKEN);
    expect(mcpLines(exclude)).toEqual(['/.mcp.json']);
    expect(out).not.toContain('Removed /.mcp.json');
    expect(status(m, main).filter((line) => line.endsWith('.mcp.json'))).toEqual([]);

    const mainOut = m.teamai(['pull'], main);

    expect(read(path.join(main, '.mcp.json'))).not.toContain(TOKEN);
    expect(mcpLines(exclude)).toEqual([]);
    expect(mainOut).toContain(`Removed /.mcp.json from ${exclude}`);
  }, 120_000);

  it('keeps the main checkout\'s lines when a linked worktree of a project that is a submodule pulls', async () => {
    const m = member('submodule-project');
    const root = caseDir('submodule-project');
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
    const lib = fs.realpathSync.native(path.join(superRepo, 'lib'));
    m.teamai(['init', m.url, '--provider', 'git', '--agent', 'claude', '--scope', 'project', '--role', 'fe', '--force'], lib);
    const wt = await m.worktree(lib, path.join(root, 'lib-wt'));

    m.teamai(['roles', 'set', 'be'], wt);
    m.teamai(['pull'], wt);

    expect(fs.existsSync(path.join(lib, '.claude/skills/fe-skill/SKILL.md'))).toBe(true);
    expect(status(m, lib)).toEqual([]);
    expect(status(m, wt)).toEqual([]);
  }, 120_000);

  it('drops a removed or pruned worktree\'s lines on the next pull, fast path included', async () => {
    const m = member('removed-worktrees');
    const root = caseDir('removed-worktrees');
    const main = m.project(path.join(root, 'main'));
    // Inside the main checkout, so what a gone worktree leaves behind would still route into its exclude file.
    fs.appendFileSync(excludeFileOf(m, main), '/.worktrees/\n');
    const removed = await m.worktree(main, path.join(main, '.worktrees', 'removed'));
    const pruned = await m.worktree(main, path.join(main, '.worktrees', 'pruned'));
    m.teamai(['roles', 'set', 'be'], main);
    m.teamai(['pull'], removed);
    m.teamai(['pull'], pruned);
    m.teamai(['roles', 'set', 'fe'], main);
    m.teamai(['pull'], main);
    const beLines = (): string[] => blockLines(excludeFileOf(m, main)).filter((line) => line.includes('be-skill'));
    // Both worktrees hold the be skill, and list it.
    expect(beLines()).toEqual(['/.claude/skills/be-skill/SKILL.md']);

    m.git(['worktree', 'remove', '--force', removed], main);
    expect(m.teamai(['pull'], main)).toContain('Already synced');
    expect(beLines()).toEqual(['/.claude/skills/be-skill/SKILL.md']);

    // Its `.git` link deleted, then pruned: a directory git no longer knows as a checkout, files and all.
    fs.rmSync(path.join(pruned, '.git'));
    m.git(['worktree', 'prune'], main);
    expect(m.teamai(['pull'], main)).toContain('Already synced');
    expect(beLines()).toEqual([]);
    expect(blockLines(excludeFileOf(m, main))).toContain('/.claude/skills/fe-skill/SKILL.md');
  }, 120_000);

  it('gives a member\'s rule at a delivered path in one worktree no line, names it, and keeps both copies visible and addable', async () => {
    const m = member('foreign');
    const root = caseDir('foreign');
    const main = m.project(path.join(root, 'main'));
    const wt = await m.worktree(main, path.join(root, 'wt'));
    const membersRule = '# Mine\n\nMy own rule.\n';
    write(path.join(wt, '.claude/rules/new-rule.md'), membersRule);
    m.teamCommit({ 'rules/new-rule.md': rule('New') });

    // A checkout without a list yet (state an older CLI saved) cannot say which of its files are teamai's:
    // a file there at a delivered path holds the line back until that checkout's first full sync.
    const statePath = path.join(m.home, '.teamai', 'projects', fs.readdirSync(path.join(m.home, '.teamai', 'projects'))[0], 'state.json');
    const state = JSON.parse(read(statePath)) as { lastPullByWorkspace: Record<string, { root?: string; gitExcludePaths?: unknown }> };
    for (const record of Object.values(state.lastPullByWorkspace)) if (record.root === wt) delete record.gitExcludePaths;
    write(statePath, JSON.stringify(state, null, 2));
    const first = m.teamai(['pull'], main);
    expect(first).toContain(`Left .claude/rules/new-rule.md visible to git in every checkout until \`teamai pull\` runs in ${wt}`);
    expect(blockLines(excludeFileOf(m, main))).not.toContain('/.claude/rules/new-rule.md');
    expect(status(m, wt)).toContain('?? .claude/rules/new-rule.md');

    // Its first full sync keeps the member's rule, and from then on it is foreign there.
    const inWorktree = m.teamai(['pull'], wt);
    expect(read(path.join(wt, '.claude/rules/new-rule.md'))).toBe(membersRule);
    const inMain = m.teamai(['pull'], main);
    for (const output of [inWorktree, inMain]) {
      expect(output).toContain(`Left .claude/rules/new-rule.md visible to git in every checkout: ${path.join(wt, '.claude/rules/new-rule.md')} is not a copy teamai delivered there, and a git exclude line would hide it too.`);
    }
    const lines = blockLines(excludeFileOf(m, main));
    expect(lines).not.toContain('/.claude/rules/new-rule.md');
    expect(lines).toContain('/.claude/rules/team-rule.md');
    expect(status(m, main)).toEqual(['?? .claude/rules/new-rule.md']);
    expect(status(m, wt)).toEqual(['?? .claude/rules/new-rule.md']);
    expect(addable(m, main)).toEqual(['.claude/rules/new-rule.md']);
    expect(addable(m, wt)).toEqual(['.claude/rules/new-rule.md']);
  }, 120_000);

  it('holds a line back while a worktree teamai has no record of holds a file at that path', async () => {
    const m = member('unrecorded');
    const root = caseDir('unrecorded');
    const main = m.project(path.join(root, 'main'));
    const wt = await m.worktree(main, path.join(root, 'wt'));
    const membersRule = '# Mine\n\nMy own rule.\n';
    write(path.join(wt, '.claude/rules/new-rule.md'), membersRule);
    m.teamCommit({ 'rules/new-rule.md': rule('New') });
    // A worktree created before teamai was set up: no record of it at all.
    const statePath = path.join(m.home, '.teamai', 'projects', fs.readdirSync(path.join(m.home, '.teamai', 'projects'))[0], 'state.json');
    const state = JSON.parse(read(statePath)) as { lastPullByWorkspace: Record<string, { root?: string }> };
    for (const [key, record] of Object.entries(state.lastPullByWorkspace)) if (record.root === wt) delete state.lastPullByWorkspace[key];
    write(statePath, JSON.stringify(state, null, 2));

    const out = m.teamai(['pull'], main);

    expect(out).toContain(`Left .claude/rules/new-rule.md visible to git in every checkout until \`teamai pull\` runs in ${wt}`);
    expect(blockLines(excludeFileOf(m, main))).not.toContain('/.claude/rules/new-rule.md');
    expect(status(m, wt)).toContain('?? .claude/rules/new-rule.md');
    expect(read(path.join(wt, '.claude/rules/new-rule.md'))).toBe(membersRule);
  }, 120_000);

  it('keeps the main checkout\'s settings.local.json line while a linked worktree holds the member\'s own', async () => {
    const m = member('settings-local', TEAM, HOOKS_ON);
    const root = caseDir('settings-local');
    const main = m.project(path.join(root, 'main'));
    const wt = await m.worktree(main, path.join(root, 'wt'));
    write(path.join(wt, '.claude/settings.local.json'), '{\n  "permissions": { "allow": [] }\n}\n');

    // The team adds hooks; only the main checkout pulls them, into its own settings.local.json.
    m.teamCommit({ 'hooks/hooks.yaml': 'hooks:\n  - id: team-stop\n    description: Team stop\n    event: Stop\n    command: echo team-stop\n' });
    m.teamai(['pull'], main);
    expect(read(path.join(main, '.claude/settings.local.json'))).toContain('team-stop');
    expect(blockLines(excludeFileOf(m, main))).toContain('/.claude/settings.local.json');
    expect(status(m, main)).toEqual([]);

    m.teamai(['pull'], wt);
    m.teamai(['pull'], main);
    expect(blockLines(excludeFileOf(m, main))).toContain('/.claude/settings.local.json');
    expect(status(m, main)).toEqual([]);
  }, 120_000);

  it('lists a path tracked in one worktree and untracked in another, so only the tracking checkout sees it', async () => {
    const m = member('tracked');
    const root = caseDir('tracked');
    const main = m.project(path.join(root, 'main'));
    const wt = await m.worktree(main, path.join(root, 'wt'));
    m.git(['add', '-f', '.claude/rules/team-rule.md'], wt);
    m.git(['commit', '-q', '-m', 'track the team rule'], wt);

    m.teamai(['pull'], main);
    m.teamai(['pull'], wt);

    expect(blockLines(excludeFileOf(m, main))).toContain('/.claude/rules/team-rule.md');
    expect(status(m, main)).toEqual([]);
    fs.appendFileSync(path.join(wt, '.claude/rules/team-rule.md'), 'edit\n');
    expect(status(m, wt)).toEqual([' M .claude/rules/team-rule.md']);
  }, 120_000);

  it('lists the paths in a tool folder that is a submodule or a nested clone in that repository\'s exclude file', () => {
    const m = member('tool-folders');
    const root = caseDir('tool-folders');
    const claudeSeed = path.join(root, 'claude-seed');
    write(path.join(claudeSeed, 'settings.json'), '{}\n');
    m.git(['init', '-q', '-b', 'main'], claudeSeed);
    m.git(['add', '-A'], claudeSeed);
    m.git(['commit', '-q', '-m', 'shared claude config'], claudeSeed);
    const app = m.project(path.join(root, 'app'), {
      agents: 'claude,cursor',
      before: (dir) => {
        m.git(['submodule', 'add', '-q', claudeSeed, '.claude'], dir);
        write(path.join(dir, '.cursor', 'README.md'), '# my cursor config\n');
        m.git(['init', '-q', '-b', 'main'], path.join(dir, '.cursor'));
        m.git(['add', '-A'], path.join(dir, '.cursor'));
        m.git(['commit', '-q', '-m', 'mine'], path.join(dir, '.cursor'));
        fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), '/.cursor/\n');
      },
    });
    const claude = path.join(app, '.claude');
    const cursor = path.join(app, '.cursor');
    expect(fs.existsSync(path.join(claude, 'skills/fe-skill/SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(cursor, 'rules/team-rule.mdc'))).toBe(true);

    // The superproject no longer shows the submodule modified; each repository hides what teamai put in it.
    expect(m.git(['status', '--porcelain'], app).split('\n').filter(Boolean)).toEqual([]);
    expect(status(m, claude)).toEqual([]);
    expect(status(m, cursor)).toEqual([]);
    expect(blockLines(excludeFileOf(m, claude), 'delivered/')).toContain('/skills/fe-skill/SKILL.md');
    expect(blockLines(excludeFileOf(m, cursor), 'delivered/')).toContain('/rules/team-rule.mdc');
    expect(blockLines(excludeFileOf(m, app)).filter((line) => line.startsWith('/.claude/') || line.startsWith('/.cursor/'))).toEqual([]);

    // The member's own files there stay visible.
    write(path.join(claude, 'notes.md'), 'mine\n');
    write(path.join(cursor, 'rules/my-rule.mdc'), 'mine\n');
    expect(status(m, claude)).toEqual(['?? notes.md']);
    expect(status(m, cursor)).toEqual(['?? rules/my-rule.mdc']);

    // Off removes this project's block from those repositories too.
    const config = path.join(m.home, '.teamai', 'projects', fs.readdirSync(path.join(m.home, '.teamai', 'projects'))[0], 'config.yaml');
    fs.appendFileSync(config, 'gitExcludeEnabled: false\n');
    m.teamai(['pull'], app);
    expect(read(excludeFileOf(m, claude))).not.toContain('# [teamai:');
    expect(read(excludeFileOf(m, cursor))).not.toContain('# [teamai:');
  }, 120_000);

  it('lists what two projects deliver into a tool home under version control in their own blocks there, and one turned off drops only its own', () => {
    const m = member('tool-home');
    // A HOME kept in git (dotfiles); Hermes reads its skills from there, whichever project delivers them.
    fs.mkdirSync(path.join(m.home, '.hermes'), { recursive: true });
    m.git(['init', '-q', '-b', 'main'], m.home);
    const root = caseDir('tool-home');
    const first = m.project(path.join(root, 'first'), { agents: 'claude,hermes' });
    const second = m.project(path.join(root, 'second'), { agents: 'claude,hermes' });
    expect(fs.existsSync(path.join(m.home, '.hermes/skills/fe-skill/SKILL.md'))).toBe(true);
    const homeExclude = excludeFileOf(m, m.home);
    /** The `delivered/<id>` blocks in HOME's exclude file, by owner. */
    const homeBlocks = (): Record<string, string[]> => Object.fromEntries(read(homeExclude).split('\n')
      .flatMap((line) => /^# \[teamai:(delivered\/[0-9a-f]{16}):start\]$/.exec(line)?.[1] ?? [])
      .map((owner) => [owner, blockLines(homeExclude, owner)]));

    const both = homeBlocks();
    expect(Object.keys(both)).toHaveLength(2);
    for (const lines of Object.values(both)) expect(lines).toContain('/.hermes/skills/fe-skill/SKILL.md');
    expect(blockLines(homeExclude)).toEqual([]);
    expect(status(m, m.home, '--', '.hermes/skills')).toEqual([]);
    expect(status(m, first)).toEqual([]);

    const partitions = path.join(m.home, '.teamai', 'projects');
    const firstConfig = fs.readdirSync(partitions).map((d) => path.join(partitions, d, 'config.yaml'))
      .find((config) => fs.existsSync(config) && read(config).includes(`projectRoot: ${first}`));
    fs.appendFileSync(firstConfig!, 'gitExcludeEnabled: false\n');
    m.teamai(['pull'], first);

    const left = homeBlocks();
    expect(Object.keys(left)).toHaveLength(1);
    expect(Object.values(left)[0]).toContain('/.hermes/skills/fe-skill/SKILL.md');
    expect(status(m, m.home, '--', '.hermes/skills')).toEqual([]);
    expect(status(m, second)).toEqual([]);
  }, 120_000);
});
