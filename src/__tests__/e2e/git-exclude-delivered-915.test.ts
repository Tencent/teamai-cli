/**
 * E2E (#915): with `sharing.gitExclude.enabled` on, or the member's
 * `gitExcludeEnabled` override in the partition config, a pull keeps the
 * skills the skills handler delivered out of `git status`, through teamai's
 * `delivered` block in the clone's `.git/info/exclude`, while a file the member
 * owns stays visible and addable. The setting takes effect on the next pull,
 * fast path included; off, the next pull removes only that block.
 *
 * Every writer of a pull reports what it delivered (rules one file per line,
 * agents, `teamai-context` files, the team hooks in
 * `.claude/settings.local.json` and Copilot's hook file, the co-author entry,
 * the `teamai` skill and the `teamai-recall` rule and agent, source skills,
 * Codex skills in `.agents/skills`), so after init, pull and a session start
 * `git status` shows only an allowlist of paths that stay visible for now, and
 * every file of the member's stays visible and addable. A copy pull keeps
 * because the member changed it, and one no longer delivered, leave the block.
 *
 * teamai never deletes a file the business repo tracks: not in a removal pass,
 * a layout migration, `teamai remove` or `uninstall`.
 *
 * Each case gets its own HOME, team remote (a local bare repo reached through
 * a synthetic HTTPS URL) and business repo.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackDetachedProcesses } from '../helpers/detached-processes.js';
import { renderRuleForTool } from '../../resources/rule-format.js';

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
/** Keeps a retried case off the directories its first attempt left. */
let attempt = 0;
/** The session-start hook leaves a detached pass behind: joined before HOME goes. */
let detached: ReturnType<typeof trackDetachedProcesses>;

function env(home: string): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    ...GIT_ENV,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    FORCE_COLOR: '0',
  };
  delete base.CLAUDE_CONFIG_DIR;
  delete base.CODEX_HOME;
  return base;
}

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const read = (file: string): string => fs.readFileSync(file, 'utf8');

const skillMd = (name: string, body: string): string => `---\nname: ${name}\ndescription: ${name} fixture\n---\n\n${body}\n`;
const MY_SKILL = '---\nname: fe-skill\ndescription: my own skill\n---\nMY OWN CONTENT\n';
const TEAM_SKILLS = {
  'skills/fe-skill/SKILL.md': skillMd('fe-skill', 'Team skill.'),
  'skills/other-skill/SKILL.md': skillMd('other-skill', 'Other skill.'),
};
const ON = 'sharing:\n  gitExclude:\n    enabled: true\n';
const OFF = 'sharing:\n  gitExclude:\n    enabled: false\n';

/** One member's machine: a HOME with Claude Code and Codex installed, a team remote, and a business repo. */
interface Machine {
  dir: string;
  home: string;
  /** The team repo's working clone the fixture commits from, and its bare remote. */
  seed: string;
  remote: string;
  run(args: string[]): Run;
  ok(args: string[]): Run;
  git(args: string[], cwd?: string): string;
  /** `git status --porcelain -uall` of the business repo, one entry per line. */
  status(): string[];
  /** Status entries naming a team skill's delivered copy. */
  teamSkillEntries(): string[];
  partitionConfig(): string;
  statePath(): string;
  excludeFile(): string;
  /** Commit `files` to the team remote, as a teammate would; a null content deletes the file. */
  teamCommit(files: Record<string, string | null>): void;
  /** Commit `files` to source `source`'s remote, as its team would. */
  sourceCommit(source: string, files: Record<string, string | null>): void;
  setOverride(value: boolean | null): void;
  /** A Claude Code session starting in the business repo, with the pass it leaves behind joined. */
  sessionStart(): Promise<Run>;
  /** The lines of teamai's `delivered` block in the clone's exclude file. */
  deliveredLines(): string[];
}

interface MachineOptions {
  team?: string;
  files?: Record<string, string>;
  /** Untracked files in the business repo. */
  business?: Record<string, string>;
  /** Files the business repo commits before teamai is set up. */
  committed?: Record<string, string>;
  /** Source repositories the team lists, by name: their files (a `teamai.yaml` with `publicSkills`, skills). */
  sources?: Record<string, Record<string, string>>;
  agents?: string;
  initArgs?: string[];
  init?: boolean;
  /** Runs in the business repo after its first commit, before `init`. */
  before?: (dir: string) => void;
}

function machine(base: string, opts: MachineOptions = {}): Machine {
  const name = `${base}-${++attempt}`;
  const home = path.join(sandbox, `${name}-home`);
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  const run = (command: string, args: string[], cwd: string): Run => {
    const r = spawnSync(command, args, { cwd, encoding: 'utf8', env: env(home), stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const gitOk = (args: string[], cwd: string): string => {
    const r = run('git', args, cwd);
    if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.output}`);
    return r.output;
  };
  const url = `https://git.example.com/team/${name}.git`;
  const seed = path.join(sandbox, `${name}-seed`);
  const remote = path.join(sandbox, `${name}.git`);
  const sourceSeed = (source: string): string => path.join(sandbox, `${name}-${source}-seed`);
  const sourceRemote = (source: string): string => path.join(sandbox, `${name}-${source}.git`);
  const commitAndPush = (repo: string, files: Record<string, string | null>, remote: string): void => {
    for (const [rel, content] of Object.entries(files)) {
      if (content === null) fs.rmSync(path.join(repo, rel), { force: true });
      else writeFile(path.join(repo, rel), content);
    }
    gitOk(['add', '-A'], repo);
    gitOk(['commit', '-q', '-m', 'team change'], repo);
    gitOk(['push', '-q', remote, 'main'], repo);
  };
  const sources = Object.entries(opts.sources ?? {}).map(([source, files]) => {
    const seedDir = sourceSeed(source);
    const remoteDir = sourceRemote(source);
    const sourceUrl = `https://git.example.com/sources/${name}-${source}.git`;
    for (const [rel, content] of Object.entries(files)) writeFile(path.join(seedDir, rel), content);
    gitOk(['init', '-q', '-b', 'main'], seedDir);
    gitOk(['add', '-A'], seedDir);
    gitOk(['commit', '-q', '-m', 'source'], seedDir);
    gitOk(['clone', '-q', '--bare', seedDir, remoteDir], sandbox);
    gitOk(['config', '--global', `url.${remoteDir}.insteadOf`, sourceUrl], sandbox);
    return `  - name: ${source}\n    repo: ${sourceUrl}`;
  });
  writeFile(path.join(seed, 'teamai.yaml'), [
    `team: ${name}`, `repo: ${url}`, 'provider: git', 'reviewers: []', ...(sources.length > 0 ? ['sources:', ...sources] : []), opts.team ?? '',
  ].join('\n'));
  for (const [rel, content] of Object.entries(opts.files ?? TEAM_SKILLS)) writeFile(path.join(seed, rel), content);
  gitOk(['init', '-q', '-b', 'main'], seed);
  gitOk(['add', '-A'], seed);
  gitOk(['commit', '-q', '-m', 'seed'], seed);
  gitOk(['clone', '-q', '--bare', seed, remote], sandbox);
  gitOk(['config', '--global', `url.${remote}.insteadOf`, url], sandbox);
  gitOk(['remote', 'add', 'origin', remote], seed);
  gitOk(['fetch', '-q', 'origin'], seed);
  gitOk(['branch', '-q', '--set-upstream-to=origin/main', 'main'], seed);

  const dir = path.join(sandbox, `${name}-biz`);
  writeFile(path.join(dir, 'README.md'), '# app\n');
  for (const [rel, content] of Object.entries(opts.committed ?? {})) writeFile(path.join(dir, rel), content);
  gitOk(['init', '-q', '-b', 'main'], dir);
  gitOk(['add', '-A'], dir);
  gitOk(['commit', '-q', '-m', 'app'], dir);
  for (const [rel, content] of Object.entries(opts.business ?? {})) writeFile(path.join(dir, rel), content);
  opts.before?.(dir);
  const realDir = fs.realpathSync.native(dir);

  const teamai = (args: string[]): Run => run(process.execPath, [CLI, ...args], realDir);
  const ok = (args: string[]): Run => {
    const r = teamai(args);
    if (r.code !== 0) throw new Error(`teamai ${args.join(' ')} failed: ${r.output}`);
    return r;
  };
  const partitionDir = (): string => {
    const projects = path.join(home, '.teamai', 'projects');
    const found = fs.readdirSync(projects).map((d) => path.join(projects, d)).filter((d) => fs.existsSync(path.join(d, 'config.yaml')));
    if (found.length !== 1) throw new Error(`expected one partition under ${projects}, found ${found.length}`);
    return found[0];
  };
  const status = (): string[] => gitOk(['status', '--porcelain', '-uall'], realDir).split('\n').filter(Boolean);
  const m: Machine = {
    dir: realDir,
    home,
    seed,
    remote,
    run: teamai,
    ok,
    git: (args, cwd = realDir) => gitOk(args, cwd),
    status,
    teamSkillEntries: () => status().filter((line) => /\/(fe-skill|other-skill)\//.test(line)),
    partitionConfig: () => path.join(partitionDir(), 'config.yaml'),
    statePath: () => path.join(partitionDir(), 'state.json'),
    excludeFile: () => path.join(realDir, '.git', 'info', 'exclude'),
    teamCommit: (files) => commitAndPush(seed, files, 'origin'),
    sourceCommit: (source, files) => commitAndPush(sourceSeed(source), files, sourceRemote(source)),
    setOverride: (value) => {
      const config = m.partitionConfig();
      const lines = read(config).split('\n').filter((line) => !line.startsWith('gitExcludeEnabled:'));
      if (value !== null) lines.splice(lines.length - 1, 0, `gitExcludeEnabled: ${value}`);
      fs.writeFileSync(config, lines.join('\n'));
    },
    sessionStart: async () => {
      const r = spawnSync(process.execPath, [CLI, 'hook-dispatch', 'session-start', '--tool', 'claude'], {
        cwd: realDir,
        encoding: 'utf8',
        env: { ...env(home), NODE_OPTIONS: [process.env.NODE_OPTIONS, detached.nodeOptions].filter(Boolean).join(' ') },
        input: JSON.stringify({ cwd: realDir, session_id: `${name}-session`, hook_event_name: 'SessionStart', source: 'startup' }),
      });
      await detached.waitForExit();
      return { code: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
    },
    deliveredLines: () => {
      const lines = fs.existsSync(m.excludeFile()) ? read(m.excludeFile()).split('\n') : [];
      const start = lines.indexOf('# [teamai:delivered:start]');
      const end = lines.indexOf('# [teamai:delivered:end]');
      return start < 0 || end < start ? [] : lines.slice(start + 1, end);
    },
  };
  if (opts.init !== false) {
    ok(['init', url, '--provider', 'git', '--agent', opts.agents ?? 'claude,codex', '--scope', 'project', '--force', ...opts.initArgs ?? []]);
  }
  return m;
}

/** Drop `gitExcludePaths` from every checkout record, as state an older CLI saved holds none. */
function asOlderCliState(statePath: string): void {
  const state = JSON.parse(read(statePath)) as { lastPullByWorkspace?: Record<string, Record<string, unknown>> };
  for (const record of Object.values(state.lastPullByWorkspace ?? {})) delete record.gitExcludePaths;
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

beforeAll(() => {
  if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
  sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-git-exclude-e2e-')));
  detached = trackDetachedProcesses(sandbox);
});

afterAll(async () => {
  if (detached) await detached.waitForExit();
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('delivered team skills stay out of git (#915)', () => {
  it('with the team setting on, keeps every delivered team skill out of git status, and a member\'s own skill of a team skill\'s name visible and addable', () => {
    const m = machine('team-on', { team: ON, business: { '.claude/skills/fe-skill/SKILL.md': MY_SKILL, 'notes.md': 'mine\n' } });
    expect(fs.existsSync(path.join(m.dir, '.claude', 'skills', 'other-skill', 'SKILL.md'))).toBe(true);

    for (const step of ['init', 'pull']) {
      if (step === 'pull') m.ok(['pull']);
      expect(m.teamSkillEntries(), step).toEqual(['?? .claude/skills/fe-skill/SKILL.md']);
      expect(m.status(), step).toContain('?? notes.md');
    }
    expect(read(path.join(m.dir, '.claude', 'skills', 'fe-skill', 'SKILL.md'))).toBe(MY_SKILL);
    m.git(['add', '-A']);
    const staged = m.git(['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
    expect(staged).toEqual(expect.arrayContaining(['.claude/skills/fe-skill/SKILL.md', 'notes.md']));
    expect(staged.filter((f) => f.includes('other-skill') || /(codex|agents)\/skills\/fe-skill/.test(f))).toEqual([]);
  });

  it('applies the member override on the next pull, fast path included, and off removes only teamai\'s delivered block', () => {
    const m = machine('override');
    const visible = m.teamSkillEntries();
    expect(visible).toEqual(expect.arrayContaining(['?? .claude/skills/fe-skill/SKILL.md', '?? .claude/skills/other-skill/SKILL.md']));
    // Another owner's block, which pull itself never writes here.
    const members = ['mine.log', '# [teamai:local-agent:start]', '/other.md', '# [teamai:local-agent:end]', ''].join('\n');
    writeFile(m.excludeFile(), members);

    m.setOverride(true);
    const on = m.ok(['pull']);
    expect(on.output).toContain('Already synced');
    expect(m.teamSkillEntries(), on.output).toEqual([]);
    expect(read(m.excludeFile())).toContain('# [teamai:delivered:start]');

    m.setOverride(false);
    const off = m.ok(['pull']);
    expect(off.output).toContain('Already synced');
    expect(m.teamSkillEntries()).toEqual(visible);
    expect(read(m.excludeFile())).toBe(members);
  });

  it('keeps every delivered line while git cannot locate a tool folder\'s repository, and says so', () => {
    const m = machine('lost-gitdir', { team: ON });
    expect(m.teamSkillEntries()).toEqual([]);
    const lines = m.deliveredLines();
    expect(lines).toEqual(expect.arrayContaining(['/.claude/skills/fe-skill/SKILL.md']));
    // A tool folder that was a linked checkout or a submodule, its git directory since deleted: git still shows its files here.
    writeFile(path.join(m.dir, '.claude', '.git'), `gitdir: ${path.join(m.dir, 'gone')}\n`);

    const r = m.run(['pull']);

    expect(m.deliveredLines(), r.output).toEqual(lines);
    expect(m.teamSkillEntries(), r.output).toEqual([]);
    expect(r.output.match(/Could not keep \S*\.claude\/skills\/fe-skill\/SKILL\.md out of git/g)).toHaveLength(1);
  });

  it('fails the sync, naming the rule, when a member\'s negation re-includes a file of a delivered skill', () => {
    const m = machine('skill-reincluded', { team: ON });
    expect(m.teamSkillEntries()).toEqual([]);
    writeFile(path.join(m.dir, '.gitignore'), '!*.md\n');

    const r = m.run(['pull']);

    expect(m.deliveredLines(), r.output).toContain('/.claude/skills/fe-skill/SKILL.md');
    expect(r.output).toContain(`git still sees .claude/skills/fe-skill/SKILL.md: \`!*.md\` (${path.join(m.dir, '.gitignore')}:1) re-includes it. Remove that rule.`);
    expect(m.teamSkillEntries()).toEqual(expect.arrayContaining(['?? .claude/skills/fe-skill/SKILL.md']));
  });

  it('replaces a skill directory line an earlier build wrote with the skill\'s file lines on the next full sync', () => {
    const m = machine('skill-dir-line', { team: ON });
    const skill = path.join(m.dir, '.claude', 'skills', 'fe-skill');
    // As an earlier build left them: the skill on the record and in the block as its directory.
    const state = JSON.parse(read(m.statePath())) as { lastPullByWorkspace: Record<string, { gitExcludePaths?: Record<string, string[]> }> };
    for (const record of Object.values(state.lastPullByWorkspace)) {
      const skills = record.gitExcludePaths?.skills;
      if (skills) record.gitExcludePaths!.skills = [...skills.filter((file) => !file.startsWith(`${skill}${path.sep}`)), skill];
    }
    fs.writeFileSync(m.statePath(), `${JSON.stringify(state, null, 2)}\n`);
    writeFile(m.excludeFile(), read(m.excludeFile()).replace('/.claude/skills/fe-skill/SKILL.md\n', '/.claude/skills/fe-skill/\n'));
    writeFile(path.join(skill, 'my-notes.md'), 'mine\n');
    expect(m.status()).not.toContain('?? .claude/skills/fe-skill/my-notes.md');

    m.teamCommit({ 'skills/other-skill/SKILL.md': skillMd('other-skill', 'Other skill, revised.') });
    const r = m.ok(['pull']);

    expect(r.output).not.toContain('Already synced');
    expect(m.deliveredLines()).toContain('/.claude/skills/fe-skill/SKILL.md');
    expect(m.deliveredLines()).not.toContain('/.claude/skills/fe-skill/');
    expect(m.teamSkillEntries(), r.output).toEqual(['?? .claude/skills/fe-skill/my-notes.md']);
  });

  it('applies a team commit that changes only sharing.gitExclude.enabled on that pull, and a later override over it', () => {
    const m = machine('team-commit', { team: OFF });
    expect(m.teamSkillEntries()).not.toEqual([]);

    m.teamCommit({ 'teamai.yaml': read(path.join(m.seed, 'teamai.yaml')).replace(OFF, ON) });
    const pulled = m.ok(['pull']);
    expect(m.teamSkillEntries(), pulled.output).toEqual([]);

    m.setOverride(false);
    m.ok(['pull']);
    expect(m.teamSkillEntries()).not.toEqual([]);
  });

  it.each([['off', OFF], ['on', ON]])('runs a full sync on the first pull after an older CLI saved the state, with the setting %s', (_label, team) => {
    const m = machine(`upgrade-${_label}`, { team });
    expect(m.ok(['pull']).output).toContain('Already synced');

    asOlderCliState(m.statePath());
    const first = m.ok(['pull']);
    expect(first.output).not.toContain('Already synced');
    expect(first.output).toMatch(/Synced/);
    expect(m.ok(['pull']).output).toContain('Already synced');
    expect(m.teamSkillEntries().length === 0).toBe(team === ON);
  });

  it('keeps the lines when the fast path holds an agent for its model and resets the checkout for a full sync', () => {
    const m = machine('held-agent', {
      team: ON,
      files: {
        ...TEAM_SKILLS,
        'models/aliases.yaml': 'aliases:\n  strong:\n    claude: { model: opus }\n    codex: { model: gpt-6-sol }\n',
        'agents/implementer.yaml': 'name: implementer\ndescription: Implements a change\ninstructions: Make the change.\nmodel: strong\n',
      },
    });
    expect(m.teamSkillEntries()).toEqual([]);
    writeFile(path.join(m.home, '.teamai', 'models', 'aliases.yaml'), 'aliases: [broken\n');

    const held = m.ok(['pull']);
    expect(held.output).toContain('Already synced');
    expect(held.output).toContain('Held implementer');
    expect(m.teamSkillEntries(), held.output).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)('keeps a copy\'s line when the full sync that should rewrite it fails', () => {
    const m = machine('failed-writer', { team: ON });
    // The copy is rewritten in place: a directory that refuses new entries fails it.
    const copy = path.join(m.dir, '.claude', 'skills', 'fe-skill');
    expect(m.teamSkillEntries()).toEqual([]);
    fs.chmodSync(copy, 0o555);
    try {
      const pulled = m.ok(['pull', '--force']);
      expect(pulled.output).toContain('Failed to sync skill fe-skill to claude');
      expect(m.teamSkillEntries(), pulled.output).toEqual([]);
    } finally {
      fs.chmodSync(copy, 0o755);
    }
  });

  it('skips the sync while another process holds the scope\'s sync lock, and the next pull applies it', () => {
    const m = machine('contended');
    m.setOverride(true);
    const lock = path.join(path.dirname(m.partitionConfig()), '.sync-lock');
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), owner: 'e2e-holder' }));
    try {
      const skipped = m.ok(['pull']);
      expect(skipped.output).toContain('sync in progress elsewhere');
      expect(m.teamSkillEntries()).not.toEqual([]);
    } finally {
      fs.rmSync(lock, { force: true });
    }
    m.ok(['pull']);
    expect(m.teamSkillEntries()).toEqual([]);
  });

  it('in single-repo mode, applies an uncommitted edit of .teamai/teamai.yaml on the next pull', () => {
    const name = `self-${++attempt}`;
    const home = path.join(sandbox, `${name}-home`);
    const remote = path.join(sandbox, `${name}.git`);
    const projectRoot = path.join(sandbox, name);
    const knowledge = path.join(projectRoot, '.teamai');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const run = (command: string, args: string[]): Run => {
      const r = spawnSync(command, args, { cwd: projectRoot, encoding: 'utf8', env: env(home), stdio: ['ignore', 'pipe', 'pipe'] });
      return { code: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
    };
    const gitOk = (...args: string[]): string => {
      const r = run('git', args);
      if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.output}`);
      return r.output;
    };
    const teamYaml = ['team: self-e2e', 'mode: self', 'repo: https://git.example.com/team/self.git', 'provider: git', ''].join('\n');
    writeFile(path.join(knowledge, 'teamai.yaml'), teamYaml);
    writeFile(path.join(knowledge, '.gitignore'), 'config.yaml\nstate.json\n');
    for (const [rel, content] of Object.entries(TEAM_SKILLS)) writeFile(path.join(knowledge, rel), content);
    spawnSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { env: env(home) });
    gitOk('init', '-q', '-b', 'main');
    gitOk('add', '-A');
    gitOk('commit', '-q', '-m', 'project');
    gitOk('remote', 'add', 'origin', remote);
    gitOk('push', '-q', '-u', 'origin', 'main');
    // The machine config an install leaves in the checkout; the first pull moves it into the partition.
    writeFile(path.join(knowledge, 'config.yaml'), [
      'repo:', `  localPath: ${knowledge}`, `  remote: ${remote}`, '  kind: self', `  businessRepoRoot: ${projectRoot}`,
      'username: ci-915', 'updatePolicy: auto', 'scope: project', `projectRoot: ${projectRoot}`, 'enabledAgents: [claude]', '',
    ].join('\n'));
    // Claude Code in this project: its root, as a session there creates it.
    fs.mkdirSync(path.join(projectRoot, '.claude'));
    const pull = (): Run => {
      const r = run(process.execPath, [CLI, 'pull']);
      if (r.code !== 0) throw new Error(`teamai pull failed: ${r.output}`);
      return r;
    };
    const skillEntries = (): string[] => gitOk('status', '--porcelain', '-uall').split('\n').filter((line) => /\.claude\/skills\/(fe-skill|other-skill)\//.test(line));

    const first = pull();
    expect(skillEntries(), first.output).toEqual(['?? .claude/skills/fe-skill/SKILL.md', '?? .claude/skills/other-skill/SKILL.md']);

    fs.writeFileSync(path.join(knowledge, 'teamai.yaml'), `${teamYaml}${ON}`);
    const on = pull();
    expect(skillEntries(), on.output).toEqual([]);
    expect(gitOk('status', '--porcelain', '-uall')).toContain(' M .teamai/teamai.yaml');

    fs.writeFileSync(path.join(knowledge, 'teamai.yaml'), teamYaml);
    pull();
    expect(skillEntries()).toHaveLength(2);
  });

  it('writes the setting on into a new team\'s teamai.yaml, and never into an existing one\'s', () => {
    const m = machine('existing', { team: '' });
    expect(m.git(['show', 'HEAD:teamai.yaml'], m.remote)).not.toContain('gitExclude');

    const name = `new-team-${++attempt}`;
    const remote = path.join(sandbox, `${name}.git`);
    const url = `https://git.example.com/team/${name}.git`;
    m.git(['init', '-q', '--bare', '-b', 'main', remote], sandbox);
    m.git(['config', '--global', `url.${remote}.insteadOf`, url], sandbox);
    const project = path.join(sandbox, `${name}-biz`);
    writeFile(path.join(project, 'README.md'), '# app\n');
    m.git(['init', '-q', '-b', 'main'], project);
    m.git(['add', '-A'], project);
    m.git(['commit', '-q', '-m', 'app'], project);
    const created = spawnSync(process.execPath, [CLI, 'init', url, '--provider', 'git', '--agent', 'claude', '--scope', 'project', '--force'], {
      cwd: project, encoding: 'utf8', env: env(m.home), stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(created.status, `${created.stdout}${created.stderr}`).toBe(0);
    expect(m.git(['show', 'HEAD:teamai.yaml'], remote)).toMatch(/gitExclude:\n\s+enabled: true/);
  });
});


// ─── Every writer reports what it delivered ─────────────────────────────────

const rule = (title: string): string => `# ${title}\n\n${title} rule.\n`;
const agentYaml = (name: string): string => `name: ${name}\ndescription: ${name} agent\ninstructions: Act as ${name}.\n`;
const FE_SKILL = skillMd('fe-skill', 'Front-end skill.');
const TRACKED_V1 = skillMd('tracked-skill', 'Version one.');
const TRACKED_V2 = skillMd('tracked-skill', 'Version two.');
const ROLES = [
  'version: 1', 'roles:',
  '  - id: fe', '    resources:', '      knowledge: [fe]', '      skills: [fe]', '      agents: [fe]',
  '  - id: be', '    resources:', '      knowledge: [be]', '      skills: [be]', '      agents: [be]', '',
].join('\n');
const PROJECTS = [
  'version: 1', 'projects:',
  '  - id: checkout', '    name: Checkout', '    resources:', '      knowledge: [checkout]', '      skills: [checkout]', '      agents: [checkout]', '',
].join('\n');
const TEAM_HOOKS = 'hooks:\n  - id: team-stop\n    description: Team stop\n    event: Stop\n    command: echo team-stop\n';
/** What a team delivers in project scope: roles, a project, hooks, MCP with and without a resolved value, docs, culture. */
const FULL_TEAM = {
  'manifest/roles.yaml': ROLES,
  'manifest/projects.yaml': PROJECTS,
  'skills/fe/fe-skill/SKILL.md': FE_SKILL,
  'skills/fe/tracked-skill/SKILL.md': TRACKED_V1,
  'skills/be/be-skill/SKILL.md': skillMd('be-skill', 'Back-end skill.'),
  'skills/checkout/checkout-skill/SKILL.md': skillMd('checkout-skill', 'Checkout skill.'),
  'rules/team-rule.md': rule('Team'),
  'rules/fe/fe-rule.md': rule('Front-end'),
  'rules/be/be-rule.md': rule('Back-end'),
  'rules/checkout/checkout-rule.md': rule('Checkout'),
  'agents/reviewer.yaml': agentYaml('reviewer'),
  'agents/fe/fe-agent.yaml': agentYaml('fe-agent'),
  'agents/be/be-agent.yaml': agentYaml('be-agent'),
  'hooks/hooks.yaml': TEAM_HOOKS,
  'mcp/mcp.yaml': [
    'servers:',
    '  - name: plain-api', '    transport: http', '    url: https://plain.example.com/mcp',
    '  - name: secret-api', '    transport: http', '    url: https://api.example.com/mcp',
    '    headers:', '      Authorization: "Bearer ${LAB_TOKEN}"', '',
  ].join('\n'),
  'env/env.yaml': 'variables:\n  - key: LAB_TOKEN\n    value: "lab-token-915"\n',
  'docs/guide.md': '# Guide\n',
  'culture.md': '# Culture\n\nBe kind.\n',
};
const FULL_SHARING = [
  'sharing:', '  gitExclude:', '    enabled: true', '  recall:', '    enabled: true',
  '  mcp:', '    autoApply: true', '  hooks:', '    autoApply: true', '    requireTeamScripts: false', '',
].join('\n');
const EXT_SOURCE = {
  'teamai.yaml': 'team: ext\nrepo: https://git.example.com/sources/ext.git\nprovider: git\nreviewers: []\npublicSkills:\n  - ext-skill\n',
  'skills/ext-skill/SKILL.md': skillMd('ext-skill', 'Source skill.'),
};
/** Copilot and six other agents; Kiro writes namespaced rules flat. */
const AGENTS = 'claude,codex,cursor,codebuddy,opencode,kiro,copilot';
const MEMBERS_CURSOR_RULE = '---\ndescription: mine\nalwaysApply: true\n---\nMY OWN TEAM RULE\n';
/**
 * The member's files: their own, one at the path of a team rule (#993 keeps it), one in Codex's shared skills directory,
 * one inside a skill teamai delivers, one in the docs mirror.
 */
const MEMBERS_FILES = [
  'notes.md', '.cursor/rules/team-rule.mdc', '.agents/skills/my-own/SKILL.md', '.claude/skills/fe-skill/my-notes.md', '.teamai/docs/mine.md',
];

/**
 * What git may still show: paths the delivered block does not cover yet (MCP
 * configs). Nothing the
 * writers above deliver is on it.
 */
const STILL_VISIBLE = [
  /^\.cursor\/mcp\.json$/, /^\.github\/mcp\.json$/, /^\.codex\/config\.toml$/, /^\.kiro\/settings\/mcp\.json$/,
];
/** A delivered path of each writer and kind, as the member's tools read them. */
const DELIVERED = [
  '.claude/rules/fe/fe-rule.md', '.cursor/rules/fe/fe-rule.mdc', '.kiro/steering/fe.fe-rule.md', '.kiro/steering/checkout.checkout-rule.md',
  '.github/instructions/fe/fe-rule.instructions.md', '.codebuddy/rules/team-rule.md',
  '.claude/agents/fe-agent.md', '.codex/agents/reviewer.toml', '.github/agents/reviewer.agent.md',
  '.claude/rules/teamai-context.md', '.cursor/rules/teamai-context.mdc', '.codebuddy/rules/teamai-context.md', '.opencode/teamai-context.md',
  '.github/instructions/teamai-context.instructions.md',
  '.claude/settings.local.json', '.github/hooks/teamai.json',
  '.claude/skills/teamai/SKILL.md', '.claude/rules/teamai-recall.md', '.claude/agents/teamai-recall.md', '.cursor/rules/teamai-recall.mdc',
  '.claude/skills/ext-skill/SKILL.md', '.agents/skills/fe-skill/SKILL.md', '.claude/skills/fe-skill/SKILL.md', '.claude/skills/checkout-skill/SKILL.md',
  '.claude/skills/tracked-skill/extra.md',
  '.teamai/docs/guide.md', '.teamai/.ignore',
];

/** Status entries that are neither the member's files, a tracked file's change, nor on the allowlist. */
function unexpected(m: Machine): string[] {
  return m.status().filter((line) => {
    const file = line.slice(3);
    return !line.startsWith(' M ') && !MEMBERS_FILES.includes(file) && !STILL_VISIBLE.some((visible) => visible.test(file));
  });
}

/** `files` that git does not ignore in `m`'s business repo (`check-ignore`, the rule git applies to them). */
function notIgnored(m: Machine, files: string[]): string[] {
  const ignored = spawnSync('git', ['check-ignore', '--stdin'], {
    cwd: m.dir, encoding: 'utf8', env: env(m.home), input: files.join('\n'),
  }).stdout.split('\n');
  return files.filter((file) => !ignored.includes(file));
}

function fullMachine(base: string, opts: Partial<MachineOptions> = {}): Machine {
  return machine(base, {
    team: FULL_SHARING,
    files: FULL_TEAM,
    sources: { ext: EXT_SOURCE },
    agents: AGENTS,
    initArgs: ['--role', 'fe', '--project', 'checkout'],
    committed: { '.claude/skills/tracked-skill/SKILL.md': TRACKED_V1 },
    business: {
      'notes.md': 'mine\n',
      '.cursor/rules/team-rule.mdc': MEMBERS_CURSOR_RULE,
      '.agents/skills/my-own/SKILL.md': skillMd('my-own', 'Mine.'),
      '.teamai/docs/mine.md': 'my notes\n',
      // A copy of a team skill another teamai run left in Codex's shared directory: Codex's copy goes there.
      '.agents/skills/fe-skill/SKILL.md': FE_SKILL,
    },
    ...opts,
  });
}

describe('every writer keeps what it delivered out of git (#915)', () => {
  it('after init, pull and a session start, git status lists only the allowlist, and every file of the member\'s stays visible and addable', async () => {
    const m = fullMachine('acceptance');
    const steps: Array<[string, () => Promise<Run> | Run | null]> = [
      // After init, the member adds a file of their own to a skill teamai delivered.
      ['init', () => {
        writeFile(path.join(m.dir, '.claude', 'skills', 'fe-skill', 'my-notes.md'), 'my notes on the team skill\n');
        return null;
      }],
      // A newer team version of the skill the business repo committed long ago, with a file it never had.
      ['pull', () => {
        m.teamCommit({ 'skills/fe/tracked-skill/SKILL.md': TRACKED_V2, 'skills/fe/tracked-skill/extra.md': 'Extra.\n' });
        return m.ok(['pull']);
      }],
      ['fast-path pull', () => m.ok(['pull'])],
      ['session start', () => m.sessionStart()],
    ];
    for (const [step, act] of steps) {
      const output = (await act())?.output ?? '';
      expect(unexpected(m), `${step}:\n${m.status().join('\n')}\n${output}`).toEqual([]);
      expect(m.status(), step).toEqual(expect.arrayContaining(MEMBERS_FILES.map((file) => `?? ${file}`)));
      const delivered = DELIVERED.filter((f) => step !== 'init' || !f.endsWith('extra.md'));
      for (const file of delivered) expect(fs.existsSync(path.join(m.dir, file)), `${step}: ${file}`).toBe(true);
      expect(notIgnored(m, delivered), step).toEqual([]);
    }

    // The tracked SKILL.md's change is visible; the file the team added beside it is not.
    expect(m.status()).toContain(' M .claude/skills/tracked-skill/SKILL.md');
    expect(m.git(['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean).sort()).toEqual(
      expect.arrayContaining(MEMBERS_FILES),
    );
    // One line per delivered file, skills and rules alike: never a directory, never `/*`.
    const lines = m.deliveredLines();
    expect(lines).toEqual(expect.arrayContaining([
      '/.cursor/rules/fe/fe-rule.mdc', '/.kiro/steering/fe.fe-rule.md', '/.agents/skills/fe-skill/SKILL.md', '/.claude/skills/fe-skill/SKILL.md',
      '/.claude/skills/tracked-skill/extra.md',
    ]));
    expect(lines.filter((line) => line.endsWith('/*') || line.endsWith('/'))).toEqual([]);
    expect(lines).not.toContain('/.claude/skills/tracked-skill/SKILL.md');

    m.git(['add', '-A']);
    const staged = m.git(['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
    expect(staged.filter((file) => !STILL_VISIBLE.some((visible) => visible.test(file))).sort())
      .toEqual([...MEMBERS_FILES, '.claude/skills/tracked-skill/SKILL.md'].sort());

    // Cleaning the tree leaves teamai's copies where they are.
    m.git(['stash', '-u']);
    expect(DELIVERED.filter((file) => !fs.existsSync(path.join(m.dir, file)))).toEqual([]);
    m.git(['stash', 'pop']);
    m.git(['reset', '-q']);
    m.git(['clean', '-fd']);
    expect(DELIVERED.filter((file) => !fs.existsSync(path.join(m.dir, file)))).toEqual([]);
    expect(fs.existsSync(path.join(m.dir, 'notes.md'))).toBe(false);
  });

  it('drops the old role\'s and project\'s lines on the next pull, and a copy pull keeps for the member\'s edit becomes visible', () => {
    // Without the committed skill and the copy in Codex's shared directory: the
    // switch removes what it no longer delivers, but neither a tracked file's
    // deletion nor a copy left in `.agents/skills` is this case's subject.
    const m = fullMachine('switch', {
      committed: {},
      business: { 'notes.md': 'mine\n', '.cursor/rules/team-rule.mdc': MEMBERS_CURSOR_RULE, '.agents/skills/my-own/SKILL.md': skillMd('my-own', 'Mine.') },
    });
    const listed = (pattern: RegExp): string[] => m.deliveredLines().filter((line) => pattern.test(line));
    expect(listed(/fe-(skill|rule|agent)/)).not.toEqual([]);
    expect(listed(/checkout-(skill|rule)/)).not.toEqual([]);

    m.ok(['roles', 'set', 'be']);
    m.ok(['projects', 'set']);
    const switched = m.ok(['pull']);
    expect(listed(/fe-(skill|rule|agent)|checkout-(skill|rule)/), switched.output).toEqual([]);
    expect(listed(/be-(skill|rule|agent)/)).not.toEqual([]);
    expect(unexpected(m), switched.output).toEqual([]);

    // The member edits one copy of a rule; the team changes the rule, so pull keeps that copy.
    const edited = path.join(m.dir, '.claude', 'rules', 'team-rule.md');
    fs.writeFileSync(edited, `${read(edited)}\nMy note.\n`);
    m.teamCommit({ 'rules/team-rule.md': rule('Team, revised') });
    const kept = m.ok(['pull']);
    expect(kept.output).toContain('team-rule');
    expect(m.status(), kept.output).toContain('?? .claude/rules/team-rule.md');
    expect(notIgnored(m, ['.codebuddy/rules/team-rule.md'])).toEqual([]);
  });

  it('lists .claude/settings.local.json for a co-author choice alone, while teamai\'s entry is in it', () => {
    const m = machine('coauthor', { team: `${ON}  coAuthor:\n    enabled: false\n`, agents: 'claude' });
    const local = path.join(m.dir, '.claude', 'settings.local.json');
    expect(JSON.parse(read(local)).attribution).toEqual({ commit: '', pr: '' });
    expect(m.status().filter((line) => line.includes('settings.local.json'))).toEqual([]);
    // A full sync finds the choice already applied, and reads the file to keep it listed.
    m.ok(['pull', '--force']);
    expect(m.status().filter((line) => line.includes('settings.local.json'))).toEqual([]);

    // Once teamai's entry is gone from it, the file is the member's alone.
    fs.writeFileSync(local, `${JSON.stringify({ model: 'mine' }, null, 2)}\n`);
    m.ok(['pull', '--force']);
    expect(m.status()).toContain('?? .claude/settings.local.json');
  });

  it('keeps listing the hook files whose team entries a pull cannot resolve', () => {
    const m = fullMachine('hooks-unresolved');
    m.teamCommit({ 'hooks/hooks.yaml': 'hooks: [broken\n' });
    const pulled = m.ok(['pull']);
    expect(notIgnored(m, ['.claude/settings.local.json', '.github/hooks/teamai.json']), pulled.output).toEqual([]);
    expect(unexpected(m), pulled.output).toEqual([]);
  });

  it('keeps listing a hook file that does not parse, leaves it as it is, and writes the hooks once the member repairs it', () => {
    const m = machine('hooks-broken', {
      team: `${ON}  hooks:\n    autoApply: true\n    requireTeamScripts: false\n`,
      files: { ...TEAM_SKILLS, 'hooks/hooks.yaml': TEAM_HOOKS },
      agents: 'claude',
    });
    const local = path.join(m.dir, '.claude', 'settings.local.json');
    expect(read(local)).toContain('echo team-stop');
    expect(notIgnored(m, ['.claude/settings.local.json'])).toEqual([]);

    const broken = `${read(local).trimEnd().slice(0, -1)},\n  "model": \n`;
    fs.writeFileSync(local, broken);
    const pulled = m.run(['pull', '--force']);
    expect(pulled.output).toContain(local);
    expect(pulled.output).toContain('does not parse');
    expect(read(local)).toBe(broken);
    expect(notIgnored(m, ['.claude/settings.local.json']), pulled.output).toEqual([]);
    expect(m.status().filter((line) => line.includes('settings.local.json'))).toEqual([]);

    fs.writeFileSync(local, `${JSON.stringify({ model: 'mine' }, null, 2)}\n`);
    const repaired = m.ok(['pull', '--force']);
    expect(read(local)).toContain('echo team-stop');
    expect(JSON.parse(read(local)).model).toBe('mine');
    expect(notIgnored(m, ['.claude/settings.local.json']), repaired.output).toEqual([]);
  });

  it('keeps listing .claude/settings.local.json while it does not parse after a co-author choice, and leaves it as it is', () => {
    const m = machine('coauthor-broken', { team: `${ON}  coAuthor:\n    enabled: false\n`, agents: 'claude' });
    const local = path.join(m.dir, '.claude', 'settings.local.json');
    const written = read(local);
    expect(notIgnored(m, ['.claude/settings.local.json'])).toEqual([]);

    const broken = `${written.trimEnd().slice(0, -1)},\n  "model": \n`;
    fs.writeFileSync(local, broken);
    const pulled = m.run(['pull', '--force']);
    expect(read(local)).toBe(broken);
    expect(notIgnored(m, ['.claude/settings.local.json']), pulled.output).toEqual([]);
    expect(m.status().filter((line) => line.includes('settings.local.json'))).toEqual([]);

    fs.writeFileSync(local, written);
    const repaired = m.ok(['pull', '--force']);
    expect(read(local)).toBe(written);
    expect(notIgnored(m, ['.claude/settings.local.json']), repaired.output).toEqual([]);
  });

  it('keeps listing an agent copy a full sync holds for its model', () => {
    const m = machine('held-full', {
      team: ON,
      files: {
        'models/aliases.yaml': 'aliases:\n  strong:\n    claude: { model: opus }\n    codex: { model: gpt-6-sol }\n',
        'agents/implementer.yaml': 'name: implementer\ndescription: Implements a change\ninstructions: Make the change.\nmodel: strong\n',
        'agents/helper.yaml': agentYaml('helper'),
      },
    });
    const copies = ['.claude/agents/implementer.md', '.codex/agents/implementer.toml', '.claude/agents/helper.md'];
    expect(notIgnored(m, copies)).toEqual([]);
    writeFile(path.join(m.home, '.teamai', 'models', 'aliases.yaml'), 'aliases: [broken\n');

    const held = m.ok(['pull', '--force']);
    expect(held.output).toContain('Held implementer');
    expect(notIgnored(m, copies), held.output).toEqual([]);
  });

  it('a pull with no configured source drops the source lines and leaves the copies visible; a failed source keeps them', () => {
    const m = fullMachine('sources');
    const copy = path.join(m.dir, '.claude', 'skills', 'ext-skill');
    expect(notIgnored(m, ['.claude/skills/ext-skill/SKILL.md'])).toEqual([]);

    if (process.getuid?.() !== 0) {
      // A source that cannot write its copy keeps what it delivered before.
      fs.chmodSync(copy, 0o555);
      try {
        const failed = m.ok(['pull', '--force']);
        expect(failed.output).toContain('[source:ext] Pull failed');
        expect(notIgnored(m, ['.claude/skills/ext-skill/SKILL.md']), failed.output).toEqual([]);
      } finally {
        fs.chmodSync(copy, 0o755);
      }
    }

    // The team withdraws its last source: the copies stay on disk, and are the member's to keep or delete.
    m.teamCommit({ 'teamai.yaml': read(path.join(m.seed, 'teamai.yaml')).replace(/^sources:\n(?: {2}.*\n)+/m, '') });
    const withdrawn = m.ok(['pull']);
    expect(withdrawn.output).not.toContain('[source:ext]');
    expect(fs.existsSync(path.join(copy, 'SKILL.md'))).toBe(true);
    expect(m.status(), withdrawn.output).toContain('?? .claude/skills/ext-skill/SKILL.md');
    m.git(['add', '-A']);
    expect(m.git(['diff', '--cached', '--name-only'])).toContain('.claude/skills/ext-skill/SKILL.md');
  });

  it('lists a skill delivered around a member\'s entry of the other type file by file, and the member\'s entry stays visible', () => {
    const m = machine('blocked-skill', { team: ON, agents: 'claude' });
    const skill = path.join(m.dir, '.claude', 'skills', 'fe-skill');
    fs.writeFileSync(path.join(skill, 'docs'), 'MY DOCS\n');
    m.teamCommit({ 'skills/fe-skill/docs/guide.md': 'TEAM GUIDE\n', 'skills/fe-skill/extra.md': 'TEAM EXTRA\n' });

    const pulled = m.ok(['pull']);
    expect(pulled.output).toContain(`Kept ${path.join(skill, 'docs')}: it is not teamai's`);
    expect(m.deliveredLines(), pulled.output).toEqual(expect.arrayContaining(['/.claude/skills/fe-skill/SKILL.md', '/.claude/skills/fe-skill/extra.md']));
    expect(m.deliveredLines().filter((line) => line === '/.claude/skills/fe-skill/' || line.startsWith('/.claude/skills/fe-skill/docs'))).toEqual([]);
    expect(m.teamSkillEntries(), pulled.output).toEqual(['?? .claude/skills/fe-skill/docs']);

    // Once the member's entry is gone, the whole skill is delivered, and each of its files listed.
    fs.rmSync(path.join(skill, 'docs'));
    const again = m.ok(['pull']);
    expect(read(path.join(skill, 'docs', 'guide.md'))).toBe('TEAM GUIDE\n');
    expect(m.deliveredLines(), again.output).toContain('/.claude/skills/fe-skill/docs/guide.md');
    expect(m.deliveredLines()).not.toContain('/.claude/skills/fe-skill/');
    expect(m.teamSkillEntries(), again.output).toEqual([]);
  });
});

// ─── Copilot's instructions in a file teamai owns ───────────────────────────

const COPILOT_TEAM = {
  ...TEAM_SKILLS,
  'culture.md': '# Culture\n\nCULTURE-915.\n',
  'claudemd/shared.md': 'SHARED-915 instructions.\n',
};
const COPILOT_FILE = '.github/copilot-instructions.md';
const CONTEXT_FILE = '.github/instructions/teamai-context.instructions.md';
const TEAMS_COPILOT_FILE = '# Team Copilot instructions\n\nUse the team style.\n';

describe('Copilot gets the team instructions from a file teamai owns (#915)', () => {
  const at = (m: Machine, file: string): string => path.join(m.dir, file);
  const githubEntries = (m: Machine): string[] => m.status().filter((line) => line.slice(3).startsWith('.github/'));
  const doctor = (m: Machine): Map<string, { ok: boolean; fix?: string }> => {
    const run = spawnSync(process.execPath, [CLI, 'doctor', '--json'], { cwd: m.dir, encoding: 'utf8', env: env(m.home) });
    const report = JSON.parse(run.stdout) as {
      checks: Array<{ name: string; ok: boolean; fix?: string }>;
    };
    return new Map(report.checks.map((check) => [check.name, check]));
  };

  it('with the flag on, writes the blocks to teamai\'s own file applied to every request, leaves the team\'s tracked copilot-instructions.md unchanged, and doctor checks the new file', () => {
    const m = machine('copilot-on', { team: ON, files: COPILOT_TEAM, agents: 'claude,copilot', committed: { [COPILOT_FILE]: TEAMS_COPILOT_FILE } });

    for (const step of ['init', 'pull', 'fast-path pull']) {
      const output = step === 'init' ? '' : m.ok(['pull']).output;
      expect(githubEntries(m), `${step}\n${output}`).toEqual([]);
      expect(m.git(['diff', '--', COPILOT_FILE]), step).toBe('');
      expect(read(at(m, COPILOT_FILE)), step).toBe(TEAMS_COPILOT_FILE);
      const context = read(at(m, CONTEXT_FILE));
      // Exactly `**`: any other glob applies only to requests with a matching file in context.
      expect(context.startsWith('---\napplyTo: "**"\n---\n'), context).toBe(true);
      expect(context).toContain('CULTURE-915');
      expect(context).toContain('SHARED-915');
      expect(m.deliveredLines(), step).toContain(`/${CONTEXT_FILE}`);
      expect(notIgnored(m, [CONTEXT_FILE]), step).toEqual([]);
    }

    const healthy = doctor(m);
    expect(healthy.get('Team instructions are current for copilot')?.ok).toBe(true);
    expect(healthy.get('No team instruction blocks are left in files no tool loads them from')?.ok).toBe(true);

    // A glob other than `**` would make Copilot skip the blocks for a question with no file.
    const blocks = read(at(m, CONTEXT_FILE)).split('\n---\n').slice(1).join('\n---\n');
    fs.writeFileSync(at(m, CONTEXT_FILE), read(at(m, CONTEXT_FILE)).replace('applyTo: "**"', 'applyTo: "src/**"'));
    fs.appendFileSync(at(m, COPILOT_FILE), `\n${blocks}`);
    const broken = doctor(m);
    expect(broken.get('Team instructions are current for copilot')).toMatchObject({ ok: false });
    expect(broken.get('Team instructions are current for copilot')?.fix).toContain(at(m, CONTEXT_FILE));
    expect(broken.get('No team instruction blocks are left in files no tool loads them from')).toMatchObject({ ok: false });
    expect(broken.get('No team instruction blocks are left in files no tool loads them from')?.fix).toContain(at(m, COPILOT_FILE));

    const repaired = m.ok(['pull', '--force']);
    expect(read(at(m, CONTEXT_FILE)).startsWith('---\napplyTo: "**"\n---\n'), repaired.output).toBe(true);
    expect(read(at(m, COPILOT_FILE)), repaired.output).toBe(TEAMS_COPILOT_FILE);
    expect(githubEntries(m)).toEqual([]);

    const uninstalled = m.ok(['uninstall', '--force']);
    expect(fs.existsSync(at(m, CONTEXT_FILE)), uninstalled.output).toBe(false);
    expect(read(at(m, COPILOT_FILE))).toBe(TEAMS_COPILOT_FILE);
  });

  it('with the flag off, writes into copilot-instructions.md as before; turning it on moves the blocks out, and off moves them back', () => {
    const m = machine('copilot-switch', { team: OFF, files: COPILOT_TEAM, agents: 'claude,copilot', committed: { [COPILOT_FILE]: TEAMS_COPILOT_FILE } });
    const before = read(at(m, COPILOT_FILE));
    expect(before.startsWith(TEAMS_COPILOT_FILE.trimEnd())).toBe(true);
    expect(before).toContain('CULTURE-915');
    expect(m.status()).toContain(` M ${COPILOT_FILE}`);
    expect(fs.existsSync(at(m, CONTEXT_FILE))).toBe(false);

    m.setOverride(true);
    const on = m.ok(['pull']);
    expect(read(at(m, COPILOT_FILE)), on.output).toBe(TEAMS_COPILOT_FILE);
    expect(read(at(m, CONTEXT_FILE))).toContain('CULTURE-915');
    expect(githubEntries(m), on.output).toEqual([]);

    m.setOverride(false);
    const off = m.ok(['pull']);
    expect(read(at(m, COPILOT_FILE)), off.output).toBe(before);
    expect(fs.existsSync(at(m, CONTEXT_FILE)), off.output).toBe(false);
    expect(m.status().filter((line) => line.includes('instructions'))).toEqual([` M ${COPILOT_FILE}`]);
  });

  it('deletes a copilot-instructions.md teamai created once the flag is on, and never one the business repo tracks', () => {
    const m = machine('copilot-created', { team: OFF, files: COPILOT_TEAM, agents: 'claude,copilot' });
    expect(m.status()).toContain(`?? ${COPILOT_FILE}`);

    m.setOverride(true);
    const on = m.ok(['pull']);
    expect(fs.existsSync(at(m, COPILOT_FILE)), on.output).toBe(false);
    expect(githubEntries(m), on.output).toEqual([]);

    // The member commits the file teamai created while the flag was off.
    m.setOverride(false);
    m.ok(['pull']);
    m.git(['add', COPILOT_FILE]);
    m.git(['commit', '-q', '-m', 'copilot instructions']);
    m.setOverride(true);
    const tracked = m.ok(['pull']);
    expect(fs.existsSync(at(m, COPILOT_FILE)), tracked.output).toBe(true);
    expect(read(at(m, COPILOT_FILE))).not.toContain('[teamai:');
    expect(read(at(m, CONTEXT_FILE))).toContain('CULTURE-915');
  });
});

// ─── Removals keep tracked copies and sweep Codex's shared skills ──────────

const ROOT_SKILL = skillMd('root-skill', 'Root skill.');
/** Roles `fe` and `be`, each with a skill, a rule and an agent, and a root skill roles do not deliver. */
const SWITCH_TEAM = {
  'manifest/roles.yaml': ROLES,
  'skills/fe/fe-skill/SKILL.md': FE_SKILL,
  'skills/be/be-skill/SKILL.md': skillMd('be-skill', 'Back-end skill.'),
  'skills/root-skill/SKILL.md': ROOT_SKILL,
  'rules/fe/fe-rule.md': rule('Front-end'),
  'agents/fe/fe-agent.yaml': agentYaml('fe-agent'),
};

/** What pull says about a copy it keeps because the business repo tracks it. */
function trackedKept(m: Machine, rel: string): string {
  const file = path.join(m.dir, rel);
  return `Kept ${file}: this repository tracks it, so teamai does not delete it. Run \`git rm -r ${file}\` and commit if the repository no longer needs it.`;
}

const times = (output: string, line: string): number => output.split(line).length - 1;
const deletions = (m: Machine): string[] => m.status().filter((line) => line.startsWith(' D') || line.startsWith('D '));

describe('removals keep the copies the business repo tracks, and sweep Codex\'s shared skills directory (#915)', () => {
  it('a role switch keeps every copy the business repo tracks, names each once per pull, and still removes the untracked ones', () => {
    const m = machine('tracked-switch', {
      team: ON,
      files: SWITCH_TEAM,
      initArgs: ['--role', 'fe'],
      // A root skill the repository committed long ago: with roles set, pull does not deliver it.
      committed: { '.claude/skills/root-skill/SKILL.md': ROOT_SKILL },
      // teamai's copy in Codex's shared directory: Codex's copy goes there.
      business: { '.agents/skills/fe-skill/SKILL.md': FE_SKILL },
    });
    expect(deletions(m)).toEqual([]);
    expect(fs.existsSync(path.join(m.dir, '.claude', 'skills', 'root-skill', 'SKILL.md'))).toBe(true);

    // The repository commits the copies teamai delivered, as they are.
    const tracked = ['.claude/skills/fe-skill', '.agents/skills/fe-skill', '.claude/rules/fe/fe-rule.md', '.claude/agents/fe-agent.md'];
    for (const rel of tracked) expect(fs.existsSync(path.join(m.dir, rel)), rel).toBe(true);
    m.git(['add', '-f', ...tracked]);
    m.git(['commit', '-q', '-m', 'commit the delivered copies']);

    m.ok(['roles', 'set', 'be']);
    // The switch, then a later full sync that proves each copy teamai's again.
    for (const args of [['pull'], ['pull', '--force']]) {
      const pulled = m.ok(args);
      expect(deletions(m), pulled.output).toEqual([]);
      for (const rel of [...tracked, '.claude/skills/root-skill']) {
        expect(fs.existsSync(path.join(m.dir, rel)), `${args.join(' ')}: ${rel}`).toBe(true);
        expect(times(pulled.output, trackedKept(m, rel)), `${args.join(' ')}: ${rel}\n${pulled.output}`).toBe(1);
      }
      // The untracked copies of the old role go, as before.
      expect(fs.existsSync(path.join(m.dir, '.codex', 'agents', 'fe-agent.toml')), pulled.output).toBe(false);
      expect(m.status().filter((line) => line.includes('fe-')), pulled.output).toEqual([]);
      expect(fs.existsSync(path.join(m.dir, '.claude', 'skills', 'be-skill', 'SKILL.md'))).toBe(true);
    }
  });

  it('a role switch removes teamai\'s untracked copy in .agents/skills, leaving no ??, and keeps a member\'s own and an edited copy there visible', () => {
    const shared = (name: string): string => `.agents/skills/${name}/SKILL.md`;
    const m = machine('shared-sweep', {
      team: ON,
      files: {
        ...SWITCH_TEAM,
        'skills/fe/fe-edit/SKILL.md': skillMd('fe-edit', 'Edit me.'),
        'skills/fe/fe-mine/SKILL.md': skillMd('fe-mine', 'Team version.'),
      },
      initArgs: ['--role', 'fe'],
      business: {
        // teamai's copies, so Codex's copies go there.
        [shared('fe-skill')]: FE_SKILL,
        [shared('fe-edit')]: skillMd('fe-edit', 'Edit me.'),
        // The member's own skill of a team skill's name.
        [shared('fe-mine')]: skillMd('fe-mine', 'MY OWN.'),
      },
    });
    expect(m.status()).not.toContain(`?? ${shared('fe-skill')}`);
    fs.appendFileSync(path.join(m.dir, shared('fe-edit')), '\nMy note.\n');

    m.ok(['roles', 'set', 'be']);
    const switched = m.ok(['pull']);
    expect(fs.existsSync(path.join(m.dir, '.agents', 'skills', 'fe-skill')), switched.output).toBe(false);
    expect(m.status().filter((line) => line.includes('fe-skill')), switched.output).toEqual([]);
    expect(read(path.join(m.dir, shared('fe-mine')))).toContain('MY OWN.');
    expect(read(path.join(m.dir, shared('fe-edit')))).toContain('My note.');
    expect(m.status(), switched.output).toEqual(expect.arrayContaining([`?? ${shared('fe-mine')}`, `?? ${shared('fe-edit')}`]));
    expect(switched.output).toContain(`Kept ${path.join(m.dir, '.agents', 'skills', 'fe-edit')}: `);
    expect(switched.output).toContain(`Kept ${path.join(m.dir, '.agents', 'skills', 'fe-mine')}: `);
    m.git(['add', '-A']);
    expect(m.git(['diff', '--cached', '--name-only']).split('\n')).toEqual(expect.arrayContaining([shared('fe-mine'), shared('fe-edit')]));
  });

  it('keeps a tracked copy of a skill or rule the team removed, and of a skill its source stopped sharing, and removes the untracked ones', () => {
    const source = {
      'teamai.yaml': EXT_SOURCE['teamai.yaml'].replace('  - ext-skill\n', '  - ext-skill\n  - ext-two\n'),
      'skills/ext-skill/SKILL.md': EXT_SOURCE['skills/ext-skill/SKILL.md'],
      'skills/ext-two/SKILL.md': skillMd('ext-two', 'Second source skill.'),
    };
    const m = machine('tracked-removed', {
      team: ON,
      files: { ...TEAM_SKILLS, 'rules/team-rule.md': rule('Team'), 'rules/keep-rule.md': rule('Keep') },
      sources: { ext: source },
      // teamai's copy in Codex's shared directory: Codex's copy goes there.
      business: { '.agents/skills/other-skill/SKILL.md': TEAM_SKILLS['skills/other-skill/SKILL.md'] },
    });
    const tracked = ['.claude/skills/fe-skill', '.claude/skills/ext-skill', '.claude/rules/team-rule.md'];
    for (const rel of tracked) expect(fs.existsSync(path.join(m.dir, rel)), rel).toBe(true);
    m.git(['add', '-f', ...tracked]);
    m.git(['commit', '-q', '-m', 'commit the delivered copies']);

    // The team removes both its skills and its rule; the source stops sharing ext-skill.
    m.teamCommit({
      'skills/fe-skill/SKILL.md': null, 'skills/other-skill/SKILL.md': null, 'skills/.removed': 'fe-skill\nother-skill\n', 'rules/team-rule.md': null,
    });
    m.sourceCommit('ext', { 'teamai.yaml': source['teamai.yaml'].replace('  - ext-skill\n', '') });
    // A source is fetched once a day, or on --force.
    const pulled = m.ok(['pull', '--force']);
    expect(deletions(m), pulled.output).toEqual([]);
    for (const rel of tracked) {
      expect(fs.existsSync(path.join(m.dir, rel)), rel).toBe(true);
      expect(times(pulled.output, trackedKept(m, rel)), `${rel}\n${pulled.output}`).toBe(1);
    }
    // The untracked copies go, Codex's in the shared directory too.
    for (const rel of ['.claude/skills/other-skill', '.agents/skills/other-skill', '.codex/skills/fe-skill']) {
      expect(fs.existsSync(path.join(m.dir, rel)), `${rel}\n${pulled.output}`).toBe(false);
    }
    expect(m.status().filter((line) => /(fe|other|ext)-skill/.test(line)), pulled.output).toEqual([]);
    expect(fs.existsSync(path.join(m.dir, '.claude', 'skills', 'ext-two', 'SKILL.md'))).toBe(true);
  });
});

// ─── Explicit commands and layout migrations keep tracked copies too ───────

/** The tracked-copy line for a path teamai now writes elsewhere: the resource lives at `movedTo`. */
function trackedMoved(m: Machine, rel: string, movedTo: string): string {
  return `${trackedKept(m, rel)} The resource now lives at ${path.join(m.dir, movedTo)}, and the tool may load both until the repository removes this copy.`;
}

describe('explicit commands and layout migrations never delete a file the business repo tracks (#915)', () => {
  it('teamai remove keeps a committed copy of the removed skill and rule, names each, and removes the untracked copies', () => {
    const m = machine('tracked-remove', {
      team: ON,
      files: { ...TEAM_SKILLS, 'rules/team-rule.md': rule('Team'), 'rules/keep-rule.md': rule('Keep') },
    });
    const tracked = ['.claude/skills/fe-skill', '.claude/rules/team-rule.md'];
    for (const rel of tracked) expect(fs.existsSync(path.join(m.dir, rel)), rel).toBe(true);
    m.git(['add', '-f', ...tracked]);
    m.git(['commit', '-q', '-m', 'commit the delivered copies']);

    const skill = m.ok(['remove', 'skills', 'fe-skill', '--force']);
    const ruleRemoved = m.ok(['remove', 'rules', 'team-rule', '--force']);
    expect(deletions(m), `${skill.output}\n${ruleRemoved.output}`).toEqual([]);
    expect(times(skill.output, trackedKept(m, '.claude/skills/fe-skill')), skill.output).toBe(1);
    expect(times(ruleRemoved.output, trackedKept(m, '.claude/rules/team-rule.md')), ruleRemoved.output).toBe(1);
    for (const rel of tracked) expect(fs.existsSync(path.join(m.dir, rel)), rel).toBe(true);
    // Codex's untracked copy of the skill goes.
    expect(fs.existsSync(path.join(m.dir, '.codex', 'skills', 'fe-skill')), skill.output).toBe(false);
  });

  it('uninstall keeps a committed rule copy, names it and counts it as kept (tracked), and removes the rest', () => {
    const m = machine('tracked-uninstall', {
      team: ON,
      files: { ...TEAM_SKILLS, 'rules/team-rule.md': rule('Team') },
    });
    const ruleCopy = '.claude/rules/team-rule.md';
    m.git(['add', '-f', ruleCopy]);
    m.git(['commit', '-q', '-m', 'commit the delivered rule']);

    const uninstalled = m.ok(['uninstall', '--force']);
    expect(deletions(m), uninstalled.output).toEqual([]);
    expect(fs.existsSync(path.join(m.dir, ruleCopy)), uninstalled.output).toBe(true);
    expect(times(uninstalled.output, trackedKept(m, ruleCopy)), uninstalled.output).toBe(1);
    expect(uninstalled.output).toContain(`Kept (tracked): 1 path this repository tracks, which uninstall does not delete:\n     ${path.join(m.dir, ruleCopy)}`);
    // Everything else teamai delivered is gone.
    expect(fs.existsSync(path.join(m.dir, '.claude', 'skills', 'fe-skill')), uninstalled.output).toBe(false);
    expect(m.status().filter((line) => line.includes('.claude/')), uninstalled.output).toEqual([]);
  });

  it('a layout migration keeps the tracked old copy, writes the new path, and says the tool may load both', () => {
    const legacy = '.cursor/rules/team-rule.md';
    const m = machine('tracked-migration', {
      team: ON,
      files: { ...TEAM_SKILLS, 'rules/team-rule.md': rule('Team') },
      agents: 'claude,cursor',
      // The verbatim copy an older layout wrote for Cursor, which reads only .mdc now.
      committed: { [legacy]: rule('Team') },
    });
    const pulled = m.ok(['pull', '--force']);
    expect(deletions(m), pulled.output).toEqual([]);
    expect(read(path.join(m.dir, legacy))).toBe(rule('Team'));
    expect(fs.existsSync(path.join(m.dir, '.cursor', 'rules', 'team-rule.mdc')), pulled.output).toBe(true);
    expect(times(pulled.output, trackedMoved(m, legacy, '.cursor/rules/team-rule.mdc')), pulled.output).toBe(1);
  });

  it('teamai source remove keeps a committed copy of the source\'s skill, names it once, and removes the untracked copies', () => {
    const m = machine('tracked-source-remove', { team: ON, sources: { ext: EXT_SOURCE } });
    const copy = '.claude/skills/ext-skill';
    expect(fs.existsSync(path.join(m.dir, copy, 'SKILL.md'))).toBe(true);
    m.git(['add', '-f', copy]);
    m.git(['commit', '-q', '-m', 'commit the source skill copy']);

    const removed = m.ok(['source', 'remove', 'ext']);
    expect(deletions(m), removed.output).toEqual([]);
    expect(fs.existsSync(path.join(m.dir, copy, 'SKILL.md')), removed.output).toBe(true);
    expect(times(removed.output, trackedKept(m, copy)), removed.output).toBe(1);
    expect(fs.existsSync(path.join(m.dir, '.codex', 'skills', 'ext-skill')), removed.output).toBe(false);
  });

  // Each row: the business repo commits the copy a migration or a removal pass
  // would delete, the trigger runs, and the copy stays, named once.
  interface TrackedRow {
    name: string;
    opts: MachineOptions;
    /** Writes and commits the old copy (and anything else the trigger needs). */
    setup(m: Machine): void;
    trigger(m: Machine): string;
    kept: string;
    /** Where the resource lives now, for a layout migration. */
    movedTo?: string;
  }
  const commit = (m: Machine, files: Record<string, string>, also: string[] = []): void => {
    for (const [rel, content] of Object.entries(files)) writeFile(path.join(m.dir, rel), content);
    m.git(['add', '-f', ...Object.keys(files), ...also]);
    m.git(['commit', '-q', '-m', 'commit an old copy']);
  };
  const legacyAgent = '---\nname: fe-agent\ndescription: fe-agent agent\n---\n\nAct as fe-agent.\n';
  const retiredReference = read(path.join(ROOT, 'src', '__tests__', 'fixtures', 'packaged-skills', 'teamai', 'references', 'uninstall.md'));
  const rows: TrackedRow[] = [
    {
      // The namespaced copy beside the rule this machine pushed to the rules root.
      name: 'a superseded rule copy',
      opts: { files: { 'manifest/roles.yaml': ROLES, 'rules/fe/my-rule.md': rule('Mine') }, initArgs: ['--role', 'fe'] },
      setup: (m) => {
        commit(m, {}, ['.claude/rules/fe/my-rule.md']);
        // Written by hand: a real push records placedRules only after its PR merges.
        const state = JSON.parse(read(m.statePath())) as Record<string, unknown>;
        fs.writeFileSync(m.statePath(), JSON.stringify({ ...state, placedRules: { 'my-rule': 'rules/fe/my-rule.md' } }, null, 2));
      },
      trigger: (m) => m.ok(['pull', '--force']).output,
      kept: '.claude/rules/fe/my-rule.md',
      movedTo: '.claude/rules/my-rule.md',
    },
    {
      // The nested copy an older release wrote for Kiro, which reads only the top of its steering directory.
      name: 'a moved nested rule copy',
      opts: { files: { 'manifest/roles.yaml': ROLES, 'rules/fe/style.md': rule('Style') }, agents: 'claude,kiro', initArgs: ['--role', 'fe'] },
      setup: (m) => {
        commit(m, { '.kiro/steering/fe/style.md': rule('Style') });
        fs.rmSync(path.join(m.dir, '.kiro', 'steering', 'fe.style.md'));
      },
      trigger: (m) => m.ok(['pull']).output,
      kept: '.kiro/steering/fe/style.md',
      movedTo: '.kiro/steering/fe.style.md',
    },
    {
      // Codex never read the .md rule copies an older release wrote there.
      name: 'a copy in a legacy rules directory',
      opts: { files: { ...TEAM_SKILLS, 'rules/team-rule.md': rule('Team') } },
      setup: (m) => commit(m, { '.codex/rules/team-rule.md': rule('Team') }),
      trigger: (m) => m.ok(['pull', '--force']).output,
      kept: '.codex/rules/team-rule.md',
    },
    {
      // The team turned its legacy .md agent into a spec, which Codex gets as .toml.
      name: 'an agent\'s copy in another format',
      opts: { files: { ...TEAM_SKILLS, 'agents/fe-agent.md': legacyAgent } },
      setup: (m) => {
        commit(m, { '.codex/agents/fe-agent.md': legacyAgent });
        m.teamCommit({ 'agents/fe-agent.md': null, 'agents/fe-agent.yaml': agentYaml('fe-agent') });
      },
      trigger: (m) => m.ok(['pull']).output,
      kept: '.codex/agents/fe-agent.md',
      movedTo: '.codex/agents/fe-agent.toml',
    },
    {
      // teamai's copy in the shared .agents/skills makes Codex's configured copy a duplicate.
      name: 'Codex\'s duplicate of a skill in .agents/skills',
      opts: {},
      setup: (m) => {
        commit(m, {}, ['.codex/skills/fe-skill']);
        writeFile(path.join(m.dir, '.agents', 'skills', 'fe-skill', 'SKILL.md'), TEAM_SKILLS['skills/fe-skill/SKILL.md']);
      },
      trigger: (m) => m.ok(['pull', '--force']).output,
      kept: '.codex/skills/fe-skill',
      movedTo: '.agents/skills/fe-skill',
    },
    {
      // An older release's teamai-recall agent for Codex, which reads .toml.
      name: 'the recall agent in its old format',
      opts: { team: `${ON}  recall:\n    enabled: true\n` },
      setup: (m) => commit(m, { '.codex/agents/teamai-recall.md': '---\nname: teamai-recall\n---\n\nOld recall agent.\n' }),
      trigger: (m) => m.ok(['pull', '--force']).output,
      kept: '.codex/agents/teamai-recall.md',
      movedTo: '.codex/agents/teamai-recall.toml',
    },
    {
      // Switching roles swaps one team version of a skill for another of the same name.
      name: 'a file of another team version of a skill',
      opts: {
        files: {
          'manifest/roles.yaml': ROLES,
          'skills/fe/dup/SKILL.md': skillMd('dup', 'Front-end version.'),
          'skills/be/dup/SKILL.md': skillMd('dup', 'Back-end version.'),
          'skills/be/dup/extra.md': '# Extra\n\nOnly the back-end version has it.\n',
        },
        initArgs: ['--role', 'be'],
      },
      setup: (m) => commit(m, {}, ['.claude/skills/dup']),
      trigger: (m) => `${m.ok(['roles', 'set', 'fe']).output}${m.ok(['pull']).output}`,
      kept: '.claude/skills/dup/extra.md',
    },
    // An earlier release's copy of a team rule named teamai-context, where nothing rewrites that path:
    // OpenCode's instruction file is .opencode/teamai-context.md, and Kiro takes none.
    ...([
      ['opencode', '.opencode/rules/teamai-context.md'],
      ['kiro', '.kiro/steering/teamai-context.md'],
    ] as const).map(([tool, kept]): TrackedRow => ({
      name: `${tool}'s teamai-context rule copy`,
      opts: { files: { ...TEAM_SKILLS, 'rules/teamai-context.md': rule('Context') }, agents: `claude,${tool}` },
      setup: (m) => commit(m, { [kept]: renderRuleForTool(tool, rule('Context')) }),
      trigger: (m) => m.ok(['pull', '--force']).output,
      kept,
    })),
    {
      // A reference file an earlier release shipped in the teamai skill, which the package no longer ships.
      name: 'a retired file of the packaged teamai skill',
      opts: {},
      setup: (m) => commit(m, { '.claude/skills/teamai/references/uninstall.md': retiredReference }),
      trigger: (m) => m.ok(['pull', '--force']).output,
      kept: '.claude/skills/teamai/references/uninstall.md',
    },
  ];

  it.each(rows)('keeps $name the business repo tracks, and names it once', (row) => {
    const m = machine(`tracked-${row.kept.replace(/[^a-z]+/gi, '-')}`, { team: ON, ...row.opts });
    row.setup(m);
    expect(deletions(m)).toEqual([]);
    const output = row.trigger(m);
    expect(deletions(m), output).toEqual([]);
    expect(fs.existsSync(path.join(m.dir, row.kept)), output).toBe(true);
    const line = row.movedTo === undefined ? trackedKept(m, row.kept) : trackedMoved(m, row.kept, row.movedTo);
    expect(times(output, line), output).toBe(1);
  });

  it('removes the copies of the team\'s last rule once the team deletes it, and keeps the member\'s own rule visible', () => {
    const mine = '.claude/rules/my-rule.md';
    const m = machine('last-rule', { team: ON, files: { ...TEAM_SKILLS, 'rules/only-rule.md': rule('Only') }, business: { [mine]: rule('Mine') } });
    const copy = path.join(m.dir, '.claude', 'rules', 'only-rule.md');
    expect(fs.existsSync(copy)).toBe(true);
    m.teamCommit({ 'rules/only-rule.md': null });
    const pulled = m.ok(['pull']);
    expect(fs.existsSync(copy), pulled.output).toBe(false);
    expect(m.status().filter((line) => line.includes('only-rule')), pulled.output).toEqual([]);
    expect(read(path.join(m.dir, mine))).toBe(rule('Mine'));
    expect(m.status()).toContain(`?? ${mine}`);
  });
});

const DOCS_TOKEN = 'ZQX-DOCS-7731';
const TEAM_DOCS = {
  ...TEAM_SKILLS,
  'docs/guide.md': `# Guide\n\nThe payment router id is ${DOCS_TOKEN}.\n`,
  'docs/sub/deep.md': `# Deep\n\n${DOCS_TOKEN} again.\n`,
  'docs/dir-doc.md': '# A doc the member has a directory in place of\n',
  'docs/link-doc.md': '# A doc the member has a link in place of\n',
  'docs/linked/inside.md': '# A doc under a directory the member has a link in place of\n',
};
/** What the member keeps in the docs mirror: a file of their own, a directory and a link at a doc's path, a link in place of a doc directory. */
const MEMBERS_DOCS = ['.teamai/docs/dir-doc.md/notes.md', '.teamai/docs/link-doc.md', '.teamai/docs/linked', '.teamai/docs/mine.md'];
const DOCS_ON = 'sharing:\n  gitExclude:\n    enabled: true\n';
const MEMBERS_DOCS_FILES = { '.teamai/docs/mine.md': 'my notes\n', '.teamai/docs/dir-doc.md/notes.md': 'my directory\n' };

function docsMachine(base: string, opts: Partial<MachineOptions> = {}): Machine {
  return machine(base, {
    team: DOCS_ON,
    files: TEAM_DOCS,
    // The member's links point at the business repo's own, committed content.
    committed: { 'vendor-docs/readme.md': 'vendor\n' },
    business: MEMBERS_DOCS_FILES,
    before: (dir) => {
      fs.symlinkSync('../../README.md', path.join(dir, '.teamai', 'docs', 'link-doc.md'));
      fs.symlinkSync('../../vendor-docs', path.join(dir, '.teamai', 'docs', 'linked'));
    },
    ...opts,
  });
}

/** The agents' grep tools run ripgrep with `--hidden`; without it on PATH, the search check is skipped. */
const HAS_RG = spawnSync('rg', ['--version'], { encoding: 'utf8' }).status === 0;
if (!HAS_RG) console.warn('Skipping the docs search check: ripgrep (rg) is not on PATH.');

/** The files `rg --hidden` finds holding `token`, searching `m`'s business repo from its root. */
function rgFind(m: Machine, token: string): string[] {
  const r = spawnSync('rg', ['-l', '--hidden', '--no-config', '--glob', '!.git', token, '.'], { cwd: m.dir, encoding: 'utf8', env: env(m.home) });
  return r.stdout.split('\n').filter(Boolean).map((file) => file.replace(/^\.\//, '')).sort();
}

/** Status entries under `.teamai/`. */
const teamaiEntries = (m: Machine): string[] => m.status().filter((line) => line.slice(3).startsWith('.teamai/'));

describe('the docs mirror stays out of git (#915)', () => {
  it('lists one line per delivered doc and the docs search whitelist, and keeps every entry of the member\'s in the mirror visible and addable', () => {
    const m = docsMachine('docs-default');

    expect(fs.existsSync(path.join(m.dir, '.teamai', 'docs', 'sub', 'deep.md'))).toBe(true);
    expect(teamaiEntries(m)).toEqual(MEMBERS_DOCS.map((file) => `?? ${file}`));
    // Never the whole mirror, and nothing of the member's or under a link of theirs.
    expect(m.deliveredLines().filter((line) => line.startsWith('/.teamai/')).sort())
      .toEqual(['/.teamai/.ignore', '/.teamai/docs/guide.md', '/.teamai/docs/sub/deep.md']);
    expect(read(path.join(m.dir, '.teamai', '.ignore'))).toBe('# [teamai:delivered:start]\n!/docs/**\n# [teamai:delivered:end]\n');

    m.git(['add', '-A']);
    const staged = m.git(['diff', '--cached', '--name-only']).split('\n').filter((file) => file.startsWith('.teamai/'));
    expect(staged.sort()).toEqual(MEMBERS_DOCS);
  });

  it.skipIf(!HAS_RG)('lets a ripgrep search from the repository root find the excluded docs, which it skips without the whitelist', () => {
    const m = docsMachine('docs-rg');
    expect(teamaiEntries(m).filter((line) => /guide|deep/.test(line))).toEqual([]);

    expect(rgFind(m, DOCS_TOKEN)).toEqual(['.teamai/docs/guide.md', '.teamai/docs/sub/deep.md']);
    fs.renameSync(path.join(m.dir, '.teamai', '.ignore'), path.join(m.dir, 'ignore.bak'));
    expect(rgFind(m, DOCS_TOKEN)).toEqual([]);
  });

  it('adds the whitelist to a member\'s own .teamai/.ignore, which stays visible, and removes only its block when the setting goes off', () => {
    const mine = '# my search settings\r\n!/notes/\r\n';
    const ignore = (m: Machine): string => path.join(m.dir, '.teamai', '.ignore');
    const m = docsMachine('docs-own-ignore', { business: { ...MEMBERS_DOCS_FILES, '.teamai/.ignore': mine } });

    expect(read(ignore(m))).toBe(`${mine}# [teamai:delivered:start]\r\n!/docs/**\r\n# [teamai:delivered:end]\r\n`);
    expect(m.deliveredLines()).not.toContain('/.teamai/.ignore');
    expect(m.deliveredLines()).toContain('/.teamai/docs/guide.md');
    expect(m.status()).toContain('?? .teamai/.ignore');

    m.setOverride(false);
    m.ok(['pull']);
    expect(read(ignore(m))).toBe(mine);
    expect(m.status()).toEqual(expect.arrayContaining(['?? .teamai/.ignore', '?? .teamai/docs/guide.md']));
  });

  it('removes the whitelist file it created when the setting goes off, and writes it again when it comes back on, fast path included', () => {
    // Nothing of the member's in the mirror: an entry pull keeps makes every pull a full sync.
    const m = docsMachine('docs-flag', { business: {}, before: undefined });
    const ignore = path.join(m.dir, '.teamai', '.ignore');
    expect(fs.existsSync(ignore)).toBe(true);

    m.setOverride(false);
    const preview = m.ok(['pull', '--dry-run']);
    expect(preview.output).toContain(`[dry-run] Would remove teamai's docs search whitelist from ${ignore}`);
    expect(fs.existsSync(ignore)).toBe(true);
    const off = m.ok(['pull']);
    expect(off.output).toContain('Already synced');
    expect(fs.existsSync(ignore), off.output).toBe(false);
    expect(teamaiEntries(m)).toEqual(expect.arrayContaining(['?? .teamai/docs/guide.md', '?? .teamai/docs/sub/deep.md']));

    m.setOverride(true);
    m.ok(['pull']);
    expect(read(ignore)).toBe('# [teamai:delivered:start]\n!/docs/**\n# [teamai:delivered:end]\n');
    expect(teamaiEntries(m)).toEqual([]);
  });

  it('a doc the member edits leaves the block on the next full sync, visible and addable', () => {
    const m = docsMachine('docs-edited', { business: {}, before: undefined });
    fs.appendFileSync(path.join(m.dir, '.teamai', 'docs', 'guide.md'), 'My note.\n');
    m.teamCommit({ 'docs/new.md': '# New\n' });

    const pulled = m.ok(['pull']);

    expect(read(path.join(m.dir, '.teamai', 'docs', 'guide.md')), pulled.output).toContain('My note.');
    expect(m.deliveredLines()).toEqual(expect.arrayContaining(['/.teamai/docs/new.md', '/.teamai/docs/sub/deep.md']));
    expect(m.deliveredLines()).not.toContain('/.teamai/docs/guide.md');
    expect(teamaiEntries(m)).toEqual(['?? .teamai/docs/guide.md']);
  });

  it('with the docs elsewhere, lists one line per delivered doc there, writes no .teamai/.ignore, and keeps the member\'s file there visible', () => {
    const m = docsMachine('docs-elsewhere', {
      team: `${DOCS_ON}  docs:\n    localDir: "~/team-docs"\n`,
      business: { 'team-docs/mine.md': 'my notes\n' },
      before: undefined,
    });

    expect(fs.existsSync(path.join(m.dir, 'team-docs', 'guide.md'))).toBe(true);
    expect(fs.existsSync(path.join(m.dir, '.teamai', '.ignore'))).toBe(false);
    expect(m.deliveredLines().filter((line) => line.includes('docs')).sort()).toEqual([
      '/team-docs/dir-doc.md', '/team-docs/guide.md', '/team-docs/link-doc.md', '/team-docs/linked/inside.md', '/team-docs/sub/deep.md',
    ]);
    expect(m.status().filter((line) => line.includes('docs'))).toEqual(['?? team-docs/mine.md']);
  });

  it('leaves a .teamai/.ignore the repository tracks as committed, through pull and uninstall', () => {
    const committed = '!/notes/\n';
    const m = docsMachine('docs-tracked-ignore', {
      committed: { 'vendor-docs/readme.md': 'vendor\n', '.teamai/.ignore': committed }, business: {}, before: undefined,
    });
    const ignore = path.join(m.dir, '.teamai', '.ignore');

    expect(read(ignore)).toBe(committed);
    expect(m.deliveredLines()).not.toContain('/.teamai/.ignore');
    expect(m.deliveredLines()).toContain('/.teamai/docs/guide.md');
    expect(teamaiEntries(m)).toEqual([]);

    m.ok(['uninstall', '--force']);
    expect(read(ignore)).toBe(committed);
  });

  it('uninstall removes the whitelist: the file it created, and only its block from a member\'s own', () => {
    const created = docsMachine('docs-uninstall', { business: {}, before: undefined });
    const own = docsMachine('docs-uninstall-own', { business: { '.teamai/.ignore': '!/notes/\n' }, before: undefined });
    expect(read(path.join(own.dir, '.teamai', '.ignore'))).toContain('!/docs/**');

    for (const m of [created, own]) {
      const plan = m.ok(['uninstall', '--dry-run']);
      expect(plan.output).toContain(path.join(m.dir, '.teamai', '.ignore'));
      m.ok(['uninstall', '--force']);
    }

    expect(fs.existsSync(path.join(created.dir, '.teamai', '.ignore'))).toBe(false);
    expect(read(path.join(own.dir, '.teamai', '.ignore'))).toBe('!/notes/\n');
  });
});
