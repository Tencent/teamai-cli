/**
 * E2E (#915): `teamai uninstall` and teamai's git exclude blocks.
 *
 * - A full uninstall deletes the files first, then removes every teamai block
 *   from the exclude files it holds blocks in: the project's own, and those of
 *   other repositories (a tool folder that is a nested clone). A file a member
 *   creates afterwards at a path teamai delivered is visible to git again. The
 *   block another project keeps in a shared repository stays.
 * - teamai's MCP servers go from every checkout of the repository, also the
 *   main checkout of a `--separate-git-dir` repo seen from a linked worktree;
 *   a line for an MCP config that may still hold a resolved value stays, with
 *   #886's warning, judged in each of them.
 * - `uninstall --agent <tool>` drops that tool's lines from every checkout's
 *   list and syncs the blocks again, keeping a path another tool in use reads
 *   (CodeBuddy and WorkBuddy share `.codebuddy/rules`).
 * - `uninstall --dry-run` lists the blocks per owner and file, and writes nothing.
 * - A read-only exclude file is left as it is, with the lines to delete by
 *   hand, and the uninstall is incomplete: it keeps the records and exits 1,
 *   so a retry removes the block; an exclude file whose repository is gone is
 *   skipped.
 * - In HTTP mode (an in-process mock backend), uninstall removes every skill
 *   the local agent installed, also one installed under its SKILL.md name,
 *   and keeps a member's skill the local agent has no record of.
 *
 * Each case gets its own HOME, team remote (a local bare repo reached through
 * a synthetic HTTPS URL) and business repo. Fixture git calls that fire
 * teamai's git hooks run with the member's HOME.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackDetachedProcesses } from '../helpers/detached-processes.js';
import { startMockServer, type MockServerHandle } from '../helpers/mock-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};
const TOKEN = 'lab-token-value-5e1f';
const isRoot = process.getuid?.() === 0;

interface Run { code: number | null; output: string }

let sandbox: string;
let detached: ReturnType<typeof trackDetachedProcesses>;

const write = (file: string, content: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const read = (file: string): string => fs.readFileSync(file, 'utf8');
const skillMd = (name: string): string => `---\nname: ${name}\ndescription: ${name} fixture\n---\n\n${name} body.\n`;

const TEAM = {
  'manifest/roles.yaml': [
    'version: 1', 'roles:',
    '  - id: fe', '    resources:', '      knowledge: [fe]', '      skills: [fe]', '',
  ].join('\n'),
  'skills/fe/fe-skill/SKILL.md': skillMd('fe-skill'),
  'rules/team-rule.md': '# Team\n\nTeam rule.\n',
};
const ON = 'sharing:\n  gitExclude:\n    enabled: true\n';
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

interface Member {
  home: string;
  run(command: string, args: string[], cwd: string): Run;
  git(args: string[], cwd: string): string;
  teamai(args: string[], cwd: string): string;
  url: string;
  /** A committed business repo at `dir` (`git init` with `initArgs`), set up with teamai in project scope. */
  project(dir: string, opts?: { initArgs?: string[]; agents?: string; before?: (dir: string) => void }): string;
  /** `git worktree add` (its post-checkout hook pulls there), then an explicit pull. */
  worktree(repo: string, dir: string): Promise<string>;
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
      SHELL: '/bin/bash',
      FORCE_COLOR: '0',
    };
    delete e.CLAUDE_CONFIG_DIR;
    delete e.CODEX_HOME;
    e.NODE_OPTIONS = [e.NODE_OPTIONS, detached.nodeOptions].filter(Boolean).join(' ');
    return e;
  };
  const run = (command: string, args: string[], cwd: string): Run => {
    const r = spawnSync(command, args, { cwd, encoding: 'utf8', env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
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

  return {
    home,
    run,
    git,
    teamai,
    url,
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
    worktree: async (repo, dir) => {
      git(['worktree', 'add', '-q', dir, '-b', path.basename(dir)], repo);
      await detached.waitForExit();
      const real = fs.realpathSync.native(dir);
      teamai(['pull'], real);
      await detached.waitForExit();
      return real;
    },
  };
}

const caseDir = (name: string): string => fs.mkdtempSync(path.join(sandbox, `${name}-`));

const status = (m: Member, dir: string): string[] =>
  m.git(['status', '--porcelain', '-uall'], dir).split('\n').filter(Boolean);

/** What git offers to add in `dir`: untracked files its ignore rules leave visible. */
const visible = (m: Member, dir: string): string[] =>
  m.git(['ls-files', '--others', '--exclude-standard'], dir).split('\n').filter(Boolean);

const excludeFileOf = (m: Member, dir: string): string =>
  path.resolve(dir, m.git(['rev-parse', '--git-path', 'info/exclude'], dir).trim());

/** The lines of `owner`'s block in `file`. */
function blockLines(file: string, owner = 'delivered'): string[] {
  const lines = fs.existsSync(file) ? read(file).split('\n') : [];
  const start = lines.findIndex((line) => line.startsWith(`# [teamai:${owner}:start]`));
  const end = lines.findIndex((line) => line === `# [teamai:${owner}:end]`);
  return start < 0 || end < start ? [] : lines.slice(start + 1, end);
}

/** The owners of the teamai blocks in `file`. */
const owners = (file: string): string[] => (fs.existsSync(file) ? read(file).split('\n') : [])
  .flatMap((line) => /^# \[teamai:([a-z0-9/_%-]+):start\]/.exec(line)?.[1] ?? []);

const partitionDirs = (m: Member): string[] => {
  const projects = path.join(m.home, '.teamai', 'projects');
  return fs.existsSync(projects) ? fs.readdirSync(projects).map((d) => path.join(projects, d)) : [];
};

beforeAll(() => {
  if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
  sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-git-exclude-uninstall-e2e-')));
  detached = trackDetachedProcesses(sandbox);
});

afterAll(async () => {
  if (detached) await detached.waitForExit();
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
}, 65_000);

// The hook scripts are POSIX shell.
describe.skipIf(process.platform === 'win32')('uninstall and teamai\'s git exclude blocks (#915)', () => {
  it('leaves no teamai block in the project\'s exclude file or a nested clone\'s, so a member\'s new file at a delivered path is visible', () => {
    const m = member('full');
    const root = caseDir('full');
    const app = m.project(path.join(root, 'app'), {
      agents: 'claude,cursor',
      before: (dir) => {
        write(path.join(dir, '.cursor', 'README.md'), '# my cursor config\n');
        m.git(['init', '-q', '-b', 'main'], path.join(dir, '.cursor'));
        m.git(['add', '-A'], path.join(dir, '.cursor'));
        m.git(['commit', '-q', '-m', 'mine'], path.join(dir, '.cursor'));
        fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), '/.cursor/\n');
      },
    });
    const cursor = path.join(app, '.cursor');
    const appExclude = excludeFileOf(m, app);
    const cursorExclude = excludeFileOf(m, cursor);
    expect(blockLines(appExclude)).toContain('/.claude/skills/fe-skill/SKILL.md');
    expect(owners(cursorExclude)).toEqual([expect.stringMatching(/^delivered\/[0-9a-f]{16}$/)]);
    // Another owner's block in the same file goes too.
    fs.appendFileSync(appExclude, '# [teamai:local-agent:start]\n/.claude/skills/http-skill/\n# [teamai:local-agent:end]\n');

    const out = m.teamai(['uninstall', '--force'], app);

    expect(out).toContain('teamai uninstalled');
    expect(read(appExclude)).not.toContain('# [teamai:');
    expect(read(cursorExclude)).not.toContain('# [teamai:');
    // The member's own line stays.
    expect(read(appExclude).split('\n')).toContain('/.cursor/');
    // Files the member creates where teamai delivered are the member's, and git sees them.
    write(path.join(app, '.claude/skills/fe-skill/SKILL.md'), 'mine\n');
    write(path.join(app, '.claude/rules/team-rule.md'), 'mine\n');
    write(path.join(cursor, 'rules/team-rule.mdc'), 'mine\n');
    expect(visible(m, app)).toEqual(expect.arrayContaining(['.claude/rules/team-rule.md', '.claude/skills/fe-skill/SKILL.md']));
    expect(status(m, app)).toEqual(expect.arrayContaining(['?? .claude/rules/team-rule.md', '?? .claude/skills/fe-skill/SKILL.md']));
    expect(visible(m, cursor)).toContain('rules/team-rule.mdc');
  }, 120_000);

  it('keeps the line of a hook file an incomplete uninstall left, and removes it on the retry', () => {
    const m = member('hook-left', {
      ...TEAM,
      'hooks/hooks.yaml': 'hooks:\n  - id: team-stop\n    description: Team stop\n    event: Stop\n    command: echo team-stop\n',
    });
    const app = m.project(path.join(caseDir('hook-left'), 'app'));
    const exclude = excludeFileOf(m, app);
    const settings = path.join(app, '.claude', 'settings.local.json');
    expect(blockLines(exclude)).toEqual(expect.arrayContaining(['/.claude/settings.local.json', '/.claude/skills/fe-skill/SKILL.md']));
    const repaired = read(settings);
    write(settings, `${repaired.trimEnd()}, \n`);

    const first = m.run(process.execPath, [CLI, 'uninstall', '--force'], app);

    expect(first.code, first.output).toBe(1);
    expect(first.output).toContain('Uninstall incomplete');
    // The skill is gone and so is its line; the settings file is still there, hidden as before.
    expect(blockLines(exclude), first.output).toEqual(['/.claude/settings.local.json']);
    expect(status(m, app)).toEqual([]);

    write(settings, repaired);
    const second = m.teamai(['uninstall', '--force'], app);
    expect(second).toContain('teamai uninstalled');
    expect(read(exclude)).not.toContain('# [teamai:');
  }, 120_000);

  it.skipIf(isRoot)('keeps the line and the records of a rule an incomplete uninstall could not delete, and removes them on the retry', () => {
    const m = member('rule-left');
    const app = m.project(path.join(caseDir('rule-left'), 'app'));
    const exclude = excludeFileOf(m, app);
    const rules = path.join(app, '.claude', 'rules');
    expect(blockLines(exclude)).toContain('/.claude/rules/team-rule.md');
    fs.chmodSync(rules, 0o555);
    let first: ReturnType<Member['run']>;
    try {
      first = m.run(process.execPath, [CLI, 'uninstall', '--force'], app);
    } finally {
      fs.chmodSync(rules, 0o755);
    }

    expect(first.code, first.output).toBe(1);
    expect(first.output).toContain('Uninstall incomplete');
    expect(fs.existsSync(path.join(rules, 'team-rule.md'))).toBe(true);
    // The rule is still there, hidden as before; the skill is gone and so is its line.
    expect(blockLines(exclude), first.output).toContain('/.claude/rules/team-rule.md');
    expect(blockLines(exclude)).not.toContain('/.claude/skills/fe-skill/SKILL.md');
    expect(status(m, app)).toEqual([]);
    expect(partitionDirs(m)).not.toEqual([]);

    const second = m.teamai(['uninstall', '--force'], app);
    expect(second).toContain('teamai uninstalled');
    expect(fs.existsSync(path.join(rules, 'team-rule.md'))).toBe(false);
    expect(read(exclude)).not.toContain('# [teamai:');
  }, 120_000);

  it('keeps the line and the records of an instruction file whose block uninstall could not remove, and removes them on the retry', () => {
    const m = member('context-left', { ...TEAM, 'culture.md': '# Culture\n\nShip small changes.\n' });
    const app = m.project(path.join(caseDir('context-left'), 'app'));
    const exclude = excludeFileOf(m, app);
    const context = path.join(app, '.claude', 'rules', 'teamai-context.md');
    expect(blockLines(exclude)).toContain('/.claude/rules/teamai-context.md');
    const intact = read(context);
    const end = intact.split('\n').find((line) => /^<!-- \[teamai:[a-z-]+:end\] -->$/.test(line));
    expect(end).toBeDefined();
    write(context, intact.replace(`${end}\n`, ''));

    const first = m.run(process.execPath, [CLI, 'uninstall', '--force'], app);

    expect(first.code, first.output).toBe(1);
    expect(first.output).toContain('Uninstall incomplete');
    expect(blockLines(exclude), first.output).toContain('/.claude/rules/teamai-context.md');
    expect(status(m, app)).toEqual([]);
    expect(partitionDirs(m)).not.toEqual([]);

    write(context, intact);
    const second = m.teamai(['uninstall', '--force'], app);
    expect(second).toContain('teamai uninstalled');
    expect(fs.existsSync(context)).toBe(false);
    expect(read(exclude)).not.toContain('# [teamai:');
  }, 120_000);

  it('keeps the copies, their lines and the records while git cannot read the index, and removes them on the retry', () => {
    const m = member('index-left');
    const app = m.project(path.join(caseDir('index-left'), 'app'));
    const exclude = excludeFileOf(m, app);
    const index = path.join(app, '.git', 'index');
    const intact = fs.readFileSync(index);
    expect(blockLines(exclude)).toEqual(expect.arrayContaining(['/.claude/rules/team-rule.md', '/.claude/skills/fe-skill/SKILL.md']));
    fs.writeFileSync(index, 'not an index\n');

    const first = m.run(process.execPath, [CLI, 'uninstall', '--force'], app);
    fs.writeFileSync(index, intact);

    expect(first.code, first.output).toBe(1);
    expect(first.output).toContain('Uninstall incomplete');
    expect(fs.existsSync(path.join(app, '.claude', 'rules', 'team-rule.md'))).toBe(true);
    expect(blockLines(exclude), first.output).toEqual(expect.arrayContaining(['/.claude/rules/team-rule.md', '/.claude/skills/fe-skill/SKILL.md']));
    expect(status(m, app)).toEqual([]);
    expect(partitionDirs(m)).not.toEqual([]);

    const second = m.teamai(['uninstall', '--force'], app);
    expect(second).toContain('teamai uninstalled');
    expect(fs.existsSync(path.join(app, '.claude', 'rules', 'team-rule.md'))).toBe(false);
    expect(read(exclude)).not.toContain('# [teamai:');
    expect(status(m, app)).toEqual([]);
  }, 120_000);

  it('keeps the block another project holds in a tool home under version control', () => {
    const m = member('tool-home');
    fs.mkdirSync(path.join(m.home, '.hermes'), { recursive: true });
    m.git(['init', '-q', '-b', 'main'], m.home);
    const root = caseDir('tool-home');
    const first = m.project(path.join(root, 'first'), { agents: 'claude,hermes' });
    m.project(path.join(root, 'second'), { agents: 'claude,hermes' });
    const homeExclude = excludeFileOf(m, m.home);
    const before = owners(homeExclude);
    expect(before).toHaveLength(2);

    m.teamai(['uninstall', '--force'], first);

    const left = owners(homeExclude);
    expect(left).toHaveLength(1);
    expect(before).toContain(left[0]);
    expect(blockLines(homeExclude, left[0])).toContain('/.hermes/skills/fe-skill/SKILL.md');
  }, 120_000);

  it('uninstall --dry-run lists the blocks by owner and file, and writes nothing', () => {
    const m = member('dry-run');
    const app = m.project(path.join(caseDir('dry-run'), 'app'));
    const appExclude = excludeFileOf(m, app);
    const content = read(appExclude);
    const infoDir = path.dirname(appExclude);
    const infoBefore = fs.readdirSync(infoDir).sort();
    const partitionsBefore = partitionDirs(m).map((dir) => [dir, fs.readdirSync(dir).sort()]);

    const out = m.teamai(['uninstall', '--dry-run'], app);

    expect(out).toContain('Git exclude blocks (teamai\'s):');
    expect(out).toContain(`delivered in ${appExclude}`);
    expect(out).not.toContain('Git exclude entries for MCP configs');
    expect(read(appExclude)).toBe(content);
    expect(fs.readdirSync(infoDir).sort()).toEqual(infoBefore);
    expect(partitionDirs(m).map((dir) => [dir, fs.readdirSync(dir).sort()])).toEqual(partitionsBefore);
  }, 120_000);

  it.skipIf(isRoot)('leaves a read-only exclude file as it is, naming the lines to delete, keeps the records for the retry, and skips a repository that is gone', () => {
    const m = member('read-only');
    const app = m.project(path.join(caseDir('read-only'), 'app'), {
      agents: 'claude,cursor',
      before: (dir) => {
        write(path.join(dir, '.cursor', 'README.md'), '# my cursor config\n');
        m.git(['init', '-q', '-b', 'main'], path.join(dir, '.cursor'));
        m.git(['add', '-A'], path.join(dir, '.cursor'));
        m.git(['commit', '-q', '-m', 'mine'], path.join(dir, '.cursor'));
        fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), '/.cursor/\n');
      },
    });
    const appExclude = excludeFileOf(m, app);
    const cursorExclude = excludeFileOf(m, path.join(app, '.cursor'));
    expect(owners(cursorExclude)).toHaveLength(1);
    // The nested clone's repository is deleted; its working files stay.
    fs.rmSync(path.join(app, '.cursor', '.git'), { recursive: true, force: true });
    const content = read(appExclude);
    fs.chmodSync(appExclude, 0o444);
    const partitions = partitionDirs(m);
    expect(partitions).toHaveLength(1);
    try {
      const first = m.run(process.execPath, [CLI, 'uninstall', '--force'], app);

      expect(first.code, first.output).toBe(1);
      expect(read(appExclude)).toBe(content);
      expect(first.output).toContain(appExclude);
      expect(first.output).toContain('/.claude/skills/fe-skill/SKILL.md');
      expect(first.output).not.toContain(cursorExclude);
      expect(first.output).toContain('Uninstall incomplete');
      expect(first.output).not.toContain('teamai uninstalled');
      // The record of the exclude files stays, so the retry finds the block.
      expect(partitionDirs(m)).toEqual(partitions);
    } finally {
      fs.chmodSync(appExclude, 0o644);
    }

    const second = m.teamai(['uninstall', '--force'], app);
    expect(second).toContain('teamai uninstalled');
    expect(read(appExclude)).not.toContain('# [teamai:');
    write(path.join(app, '.claude/skills/fe-skill/SKILL.md'), 'mine\n');
    expect(visible(m, app)).toContain('.claude/skills/fe-skill/SKILL.md');
  }, 120_000);

  it('uninstall --agent codex drops Codex\'s lines from every checkout\'s list and keeps the others', async () => {
    const m = member('agent-codex');
    const root = caseDir('agent-codex');
    const main = m.project(path.join(root, 'main'), { agents: 'claude,codex' });
    // teamai's copy in Codex's shared directory, so Codex's copy goes there.
    write(path.join(main, '.agents', 'skills', 'fe-skill', 'SKILL.md'), skillMd('fe-skill'));
    m.teamai(['pull', '--force'], main);
    const wt = await m.worktree(main, path.join(root, 'wt'));
    const exclude = excludeFileOf(m, main);
    const codexLines = (): string[] => blockLines(exclude).filter((line) => line.startsWith('/.agents/') || line.startsWith('/.codex/'));
    expect(codexLines()).toEqual(expect.arrayContaining(['/.agents/skills/fe-skill/SKILL.md', '/.codex/skills/fe-skill/SKILL.md']));

    m.teamai(['uninstall', '--agent', 'codex', '--force'], main);

    expect(codexLines()).toEqual([]);
    expect(blockLines(exclude)).toContain('/.claude/skills/fe-skill/SKILL.md');
    // The worktree's own Codex copy stays on disk, and is no longer hidden.
    expect(status(m, wt)).toContain('?? .codex/skills/fe-skill/SKILL.md');
    write(path.join(main, '.agents/skills/fe-skill/SKILL.md'), 'mine\n');
    expect(status(m, main)).toContain('?? .agents/skills/fe-skill/SKILL.md');
    // The worktree's list lost them too: its pull does not bring the lines back.
    m.teamai(['pull'], wt);
    expect(codexLines()).toEqual([]);
    expect(blockLines(exclude)).toContain('/.claude/skills/fe-skill/SKILL.md');
  }, 120_000);

  // WorkBuddy reads CodeBuddy's `.codebuddy/rules` in a project: one copy, one line, for both.
  it.each([
    { uninstalled: 'codebuddy', remaining: 'workbuddy', gone: '/.codebuddy/skills/fe-skill/SKILL.md', stays: '/.workbuddy/skills/fe-skill/SKILL.md' },
    { uninstalled: 'workbuddy', remaining: 'codebuddy', gone: '/.workbuddy/skills/fe-skill/SKILL.md', stays: '/.codebuddy/skills/fe-skill/SKILL.md' },
  ])('uninstall --agent $uninstalled keeps the .codebuddy/rules lines $remaining still reads', ({ uninstalled, gone, stays }) => {
    const m = member(`agent-${uninstalled}`);
    const root = caseDir(`agent-${uninstalled}`);
    const app = m.project(path.join(root, 'app'), { agents: 'codebuddy,workbuddy' });
    const exclude = excludeFileOf(m, app);
    const ruleLines = (): string[] => blockLines(exclude).filter((line) => line.startsWith('/.codebuddy/rules/'));
    expect(ruleLines()).toContain('/.codebuddy/rules/team-rule.md');
    const rulesBefore = ruleLines();
    expect(blockLines(exclude)).toEqual(expect.arrayContaining([gone, stays]));

    m.teamai(['uninstall', '--agent', uninstalled, '--force'], app);

    expect(ruleLines()).toEqual(rulesBefore);
    expect(fs.existsSync(path.join(app, '.codebuddy/rules/team-rule.md'))).toBe(true);
    expect(blockLines(exclude)).not.toContain(gone);
    expect(blockLines(exclude)).toContain(stays);
    expect(status(m, app)).toEqual([]);
    // The next pull agrees.
    m.teamai(['pull'], app);
    expect(ruleLines()).toEqual(rulesBefore);
    expect(status(m, app)).toEqual([]);
  }, 120_000);

  it('removes teamai\'s server and its resolved value from the main checkout of a --separate-git-dir repo, then its MCP line, uninstalling from a linked worktree', async () => {
    const m = member('mcp-separate', MCP_TEAM, MCP_OFF);
    const root = caseDir('mcp-separate');
    // sharing.gitExclude off: with it on, Claude and CodeBuddy take the servers from their local scopes, and
    // nothing writes .mcp.json. The MCP line does not depend on it.
    const main = m.project(path.join(root, 'main'), { initArgs: [`--separate-git-dir=${path.join(root, 'main.git')}`], agents: 'codebuddy' });
    expect(read(path.join(main, '.mcp.json'))).toContain(TOKEN);
    const wt = await m.worktree(main, path.join(root, 'wt'));
    const exclude = excludeFileOf(m, wt);
    expect(blockLines(exclude, 'mcp-exclude')).toContain('/.mcp.json');

    const out = m.teamai(['uninstall', '--force'], wt);

    const config = (dir: string): string => fs.existsSync(path.join(dir, '.mcp.json')) ? read(path.join(dir, '.mcp.json')) : '';
    expect(config(wt)).not.toContain(TOKEN);
    expect(config(main)).not.toContain(TOKEN);
    expect(config(main)).not.toContain('secret-api');
    // Clean in every checkout, so the line goes with the rest of the block.
    expect(blockLines(exclude, 'mcp-exclude')).toEqual([]);
    expect(out).not.toContain('Kept `/.mcp.json`');
  }, 120_000);

  it('uninstalls right after `git worktree remove` in a --separate-git-dir repo, with no pull in between', async () => {
    const m = member('removed-worktree');
    const root = caseDir('removed-worktree');
    const main = m.project(path.join(root, 'main'), { initArgs: [`--separate-git-dir=${path.join(root, 'main.git')}`] });
    const wt = await m.worktree(main, path.join(root, 'wt'));
    m.git(['worktree', 'remove', '--force', wt], main);

    const out = m.run(process.execPath, [CLI, 'uninstall', '--force'], main);

    expect(out.code, out.output).toBe(0);
    expect(out.output).toContain('teamai uninstalled');
    expect(owners(excludeFileOf(m, main)), out.output).toEqual([]);
    expect(visible(m, main).filter((file) => file.startsWith('.claude/')), out.output).toEqual([]);
  }, 120_000);
});

describe.skipIf(process.platform === 'win32')('uninstall in HTTP mode (#915)', () => {
  let server: MockServerHandle | undefined;
  afterAll(async () => { await server?.close(); });

  it('removes every skill the local agent installed and keeps a member\'s skill it has no record of', async () => {
    const API_KEY = 'e2e-http-key';
    server = await startMockServer({ apiKey: API_KEY, skillNames: { 'renamed-slug': 'renamed-skill' } });
    const base = fs.mkdtempSync(path.join(sandbox, 'http-'));
    const home = path.join(base, 'home');
    fs.mkdirSync(home);
    const env: NodeJS.ProcessEnv = {
      ...process.env, ...GIT_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
      GIT_CONFIG_NOSYSTEM: '1', SHELL: '/bin/bash', FORCE_COLOR: '0',
      NODE_OPTIONS: [process.env.NODE_OPTIONS, detached.nodeOptions].filter(Boolean).join(' '),
    };
    delete env.CLAUDE_CONFIG_DIR;
    delete env.TEAMAI_API_TOKEN;
    delete env.TEAMAI_API_KEY;
    // Spawned asynchronously: the mock backend runs in this process.
    const cli = (args: string[], cwd: string, input?: string): Promise<Run> => new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (chunk) => { output += String(chunk); });
      child.stderr.on('data', (chunk) => { output += String(chunk); });
      child.on('close', (code) => resolve({ code, output }));
      child.stdin.end(input ?? '');
    });
    const project = path.join(base, 'app');
    write(path.join(project, 'README.md'), '# app\n');
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: project, env });
    const app = fs.realpathSync.native(project);
    const initRun = await cli(['init', '--http', server.url, '--token', API_KEY, '--scope', 'project', '--agent', 'claude', '--force'], app);
    expect(initRun.code, initRun.output).toBe(0);

    const install = (id: number, slug: string) => ({
      id, type: 'install_skill', skill_slug: slug, skill_version: '1.0.0',
      download_url: `${server!.url}/download?slug=${slug}`, scope: 'workspace', workspace_path: app,
    });
    server.seedCommands([install(1, 'http-skill'), install(2, 'renamed-slug')] as never);
    const session = await cli(['hook-dispatch', 'session-start', '--tool', 'claude'], app,
      JSON.stringify({ cwd: app, session_id: 'http-session', hook_event_name: 'SessionStart', source: 'startup' }));
    await detached.waitForExit();
    expect(session.code, session.output).toBe(0);
    const skills = path.join(app, '.claude', 'skills');
    expect(fs.existsSync(path.join(skills, 'http-skill', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(skills, 'renamed-skill', 'SKILL.md'))).toBe(true);
    write(path.join(skills, 'my-skill', 'SKILL.md'), skillMd('my-skill'));

    const out = await cli(['uninstall', '--force'], app);

    expect(out.code, out.output).toBe(0);
    expect(fs.existsSync(path.join(skills, 'http-skill'))).toBe(false);
    expect(fs.existsSync(path.join(skills, 'renamed-skill'))).toBe(false);
    expect(read(path.join(skills, 'my-skill', 'SKILL.md'))).toBe(skillMd('my-skill'));
  }, 120_000);
});
