/**
 * E2E (#915): in a single-repo (self) team with
 * `sharing.gitExclude.enabled` on, `init .` and every pull leave `git status`
 * clean for Claude and Copilot. The built-in hooks stay in the committed
 * `.claude/settings.json`, so a fresh clone still gets them; the team's hooks
 * go to each checkout's own `.claude/settings.local.json`, kept out of git with
 * Copilot's `.github/hooks/teamai.json` and the copies pull delivers from
 * `.teamai/` into tool folders. `.teamai/` itself is never kept out of git.
 * With the setting off, the team hooks stay in (and move back into) the
 * tracked settings, as before.
 *
 * Each case gets its own HOME and business repo. `init .` only parses the
 * origin, so it is an https URL on a closed local port (`url.insteadOf` would
 * make init reject the rewritten local path).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { trackDetachedProcesses } from '../helpers/detached-processes.js';
import { projectSlug } from '../../utils/partition.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

const TEAM_HOOKS = 'hooks:\n  - id: team-stop\n    description: Team stop\n    event: Stop\n    command: echo team-stop\n';
const TEAM_SKILL = '---\nname: team-skill\ndescription: team skill fixture\n---\n\nTeam skill.\n';
const TEAM_HOOK_COMMAND = 'echo team-stop';
const SETTINGS = '.claude/settings.json';
const LOCAL_SETTINGS = '.claude/settings.local.json';
const COPILOT_HOOKS = '.github/hooks/teamai.json';
const MEMBER_FILES = { 'notes.md': 'mine\n', '.github/hooks/mine.json': '{"version":1,"hooks":{}}\n' };
const MEMBER_STATUS = ['?? .github/hooks/mine.json', '?? notes.md'];

interface Run { code: number | null; output: string }

let sandbox: string;
let attempt = 0;
let detached: ReturnType<typeof trackDetachedProcesses>;

interface Member {
  dir: string;
  home: string;
  ok(args: string[], cwd?: string): Run;
  git(args: string[], cwd?: string): string;
  /** `git status --porcelain -uall`, one entry per line, sorted. */
  status(cwd?: string): string[];
  /** Paths among `rels` that git does not ignore. */
  notIgnored(rels: string[], cwd?: string): string[];
  /** What `git add -A` would stage. */
  wouldAdd(cwd?: string): string[];
  deliveredLines(): string[];
  /** Set (or with null, drop) the member's `gitExcludeEnabled` in the partition config. */
  setOverride(value: boolean | null): void;
}

/**
 * A business repo with the team's hooks and a skill committed under `.teamai/`
 * (and `teamaiYaml` when the team already exists), the member's own untracked
 * files, and a HOME with Claude Code and Copilot installed.
 */
function member(base: string, opts: { teamaiYaml?: string; committed?: Record<string, string> } = {}): Member {
  const name = `${base}-${++attempt}`;
  const home = path.join(sandbox, `${name}-home`);
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.copilot'), { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...GIT_ENV,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    FORCE_COLOR: '0',
    NODE_OPTIONS: [process.env.NODE_OPTIONS, detached.nodeOptions].filter(Boolean).join(' '),
  };
  delete env.GIT_CONFIG_GLOBAL;
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  const run = (command: string, args: string[], cwd: string): Run => {
    const r = spawnSync(command, args, { cwd, encoding: 'utf8', env, input: '' });
    return { code: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const gitOk = (args: string[], cwd: string): string => {
    const r = run('git', args, cwd);
    if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.output}`);
    return r.output;
  };
  const dir = path.join(sandbox, `${name}-biz`);
  const files: Record<string, string> = {
    'README.md': '# app\n',
    '.teamai/hooks/hooks.yaml': TEAM_HOOKS,
    '.teamai/skills/team-skill/SKILL.md': TEAM_SKILL,
    ...(opts.teamaiYaml ? { '.teamai/teamai.yaml': opts.teamaiYaml } : {}),
    ...opts.committed,
  };
  for (const [rel, content] of Object.entries(files)) writeFile(path.join(dir, rel), content);
  gitOk(['init', '-q', '-b', 'main'], dir);
  gitOk(['add', '-A'], dir);
  gitOk(['commit', '-q', '-m', 'app'], dir);
  gitOk(['remote', 'add', 'origin', `https://127.0.0.1:9/team/${name}.git`], dir);
  for (const [rel, content] of Object.entries(MEMBER_FILES)) writeFile(path.join(dir, rel), content);
  const realDir = fs.realpathSync.native(dir);
  const excludeFile = path.join(realDir, '.git', 'info', 'exclude');
  const m: Member = {
    dir: realDir,
    home,
    ok: (args, cwd = realDir) => {
      const r = run(process.execPath, [CLI, ...args], cwd);
      if (r.code !== 0) throw new Error(`teamai ${args.join(' ')} failed: ${r.output}`);
      return r;
    },
    git: (args, cwd = realDir) => gitOk(args, cwd),
    status: (cwd = realDir) => gitOk(['status', '--porcelain', '-uall'], cwd).split('\n').filter(Boolean).sort(),
    notIgnored: (rels, cwd = realDir) => rels.filter((rel) => run('git', ['check-ignore', '-q', rel], cwd).code !== 0),
    wouldAdd: (cwd = realDir) => gitOk(['add', '-A', '--dry-run'], cwd).split('\n').filter(Boolean).sort(),
    deliveredLines: () => {
      const lines = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, 'utf8').split('\n') : [];
      const start = lines.indexOf('# [teamai:delivered:start]');
      const end = lines.indexOf('# [teamai:delivered:end]');
      return start < 0 || end < start ? [] : lines.slice(start + 1, end);
    },
    setOverride: (value) => {
      const config = path.join(home, '.teamai', 'projects', projectSlug(realDir), 'config.yaml');
      const lines = fs.readFileSync(config, 'utf8').split('\n').filter((line) => !line.startsWith('gitExcludeEnabled:'));
      if (value !== null) lines.splice(lines.length - 1, 0, `gitExcludeEnabled: ${value}`);
      fs.writeFileSync(config, lines.join('\n'));
    },
  };
  return m;
}

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** The commands of the hook entries in a Claude settings file. */
function hookCommands(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  const settings = JSON.parse(fs.readFileSync(file, 'utf8')) as { hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> };
  return Object.values(settings.hooks ?? {}).flat().flatMap((entry) => (entry.hooks ?? []).map((h) => h.command ?? ''));
}

const hasTeamHook = (commands: string[]): boolean => commands.some((c) => c.includes(TEAM_HOOK_COMMAND));
const hasSessionStart = (commands: string[]): boolean => commands.some((c) => c.includes('hook-dispatch session-start'));

beforeAll(() => {
  if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
  sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-self-git-exclude-')));
  detached = trackDetachedProcesses(sandbox);
});

afterAll(async () => {
  if (detached) await detached.waitForExit();
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('a single-repo team keeps what teamai delivers out of git (#915)', () => {
  it('init . turns the setting on and leaves git status clean right away; pull keeps it clean; a fresh clone gets the built-in hooks', () => {
    const m = member('self-on');

    const init = m.ok(['init', '.', '--provider', 'git', '--agent', 'claude,copilot']);

    const teamYaml = YAML.parse(fs.readFileSync(path.join(m.dir, '.teamai', 'teamai.yaml'), 'utf8'));
    expect(teamYaml.sharing?.gitExclude?.enabled, init.output).toBe(true);
    for (const step of ['init', 'pull', 'pull again']) {
      if (step !== 'init') m.ok(['pull']);
      // Right after init, before any pull: the hook files init wrote are already out of git.
      expect(m.status(), step).toEqual(MEMBER_STATUS);
      expect(m.wouldAdd(), step).toEqual(["add '.github/hooks/mine.json'", "add 'notes.md'"]);
      const committed = m.git(['show', `HEAD:${SETTINGS}`]);
      expect(committed, step).toContain('hook-dispatch session-start');
      expect(committed, step).not.toContain(TEAM_HOOK_COMMAND);
      expect(hasTeamHook(hookCommands(path.join(m.dir, LOCAL_SETTINGS))), step).toBe(true);
      expect(hasTeamHook(hookCommands(path.join(m.dir, SETTINGS))), step).toBe(false);
      expect(fs.existsSync(path.join(m.dir, COPILOT_HOOKS)), step).toBe(true);
      expect(m.notIgnored([LOCAL_SETTINGS, COPILOT_HOOKS], m.dir), step).toEqual([]);
      expect(m.deliveredLines().filter((line) => line.startsWith('/.teamai')), step).toEqual([]);
      expect(fs.existsSync(path.join(m.dir, '.teamai', '.ignore')), step).toBe(false);
    }
    // The copies pull delivers from .teamai/ into tool folders are out of git; .teamai/ is not.
    expect(fs.existsSync(path.join(m.dir, '.claude', 'skills', 'team-skill', 'SKILL.md'))).toBe(true);
    expect(m.notIgnored(['.claude/skills/team-skill/SKILL.md'])).toEqual([]);
    expect(m.notIgnored(['.teamai/skills/team-skill/SKILL.md', '.teamai/hooks/hooks.yaml'])).toHaveLength(2);

    const clone = path.join(sandbox, `self-on-clone-${attempt}`);
    m.git(['clone', '-q', m.dir, clone], sandbox);
    const cloned = hookCommands(path.join(clone, SETTINGS));
    expect(hasSessionStart(cloned)).toBe(true);
    expect(hasTeamHook(cloned)).toBe(false);
  });

  it('removes the docs search whitelist a project kept before it switched to single-repo mode', () => {
    const m = member('self-whitelist', { committed: { '.teamai/docs/guide.md': '# Guide\n' } });
    m.ok(['init', '.', '--provider', 'git', '--agent', 'claude,copilot']);
    // What the git-mode project's pulls left in its .teamai/ before the switch.
    writeFile(path.join(m.dir, '.teamai', '.ignore'), '# [teamai:delivered:start]\n!/docs/**\n# [teamai:delivered:end]\n');

    m.ok(['pull']);

    expect(fs.existsSync(path.join(m.dir, '.teamai', '.ignore'))).toBe(false);
    expect(m.status()).toEqual(MEMBER_STATUS);
    expect(m.deliveredLines().filter((line) => line.startsWith('/.teamai'))).toEqual([]);
  });

  it('keeps a Copilot hook file the repository tracks visible', () => {
    const m = member('self-tracked', { committed: { [COPILOT_HOOKS]: '{"version":1,"hooks":{}}\n' } });

    m.ok(['init', '.', '--provider', 'git', '--agent', 'claude,copilot']);

    expect(m.status()).toEqual([` M ${COPILOT_HOOKS}`, ...MEMBER_STATUS].sort());
    expect(m.deliveredLines()).not.toContain(`/${COPILOT_HOOKS}`);
    expect(m.notIgnored([LOCAL_SETTINGS])).toEqual([]);
  });

  it('with the setting off, team hooks stay in the tracked settings; on moves them out, and off moves them back', () => {
    const teamaiYaml = 'team: self-off\nmode: self\nrepo: https://127.0.0.1:9/team/self-off.git\nprovider: git\n';
    const m = member('self-off', { teamaiYaml });

    // An existing team: init does not turn the setting on, and writes as before.
    m.ok(['init', '.', '--provider', 'git', '--agent', 'claude,copilot']);
    expect(m.status()).toEqual(MEMBER_STATUS.concat(`?? ${COPILOT_HOOKS}`).sort());
    expect(hasTeamHook(hookCommands(path.join(m.dir, SETTINGS)))).toBe(true);
    expect(m.git(['show', `HEAD:${SETTINGS}`])).toContain(TEAM_HOOK_COMMAND);
    expect(fs.existsSync(path.join(m.dir, LOCAL_SETTINGS))).toBe(false);
    expect(m.deliveredLines()).toEqual([]);

    // The team turns it on: the next pull moves the team hooks out of the
    // tracked settings once, and the team commits that.
    writeFile(path.join(m.dir, '.teamai', 'teamai.yaml'), `${teamaiYaml}sharing:\n  gitExclude:\n    enabled: true\n`);
    m.git(['commit', '-q', '-am', 'turn on git exclude']);
    const on = m.ok(['pull']);
    expect(m.status(), on.output).toEqual([` M ${SETTINGS}`, ...MEMBER_STATUS].sort());
    expect(hasTeamHook(hookCommands(path.join(m.dir, SETTINGS)))).toBe(false);
    expect(hasSessionStart(hookCommands(path.join(m.dir, SETTINGS)))).toBe(true);
    expect(hasTeamHook(hookCommands(path.join(m.dir, LOCAL_SETTINGS)))).toBe(true);
    m.git(['commit', '-q', '-m', 'team hooks out of the tracked settings', SETTINGS]);
    m.ok(['pull']);
    expect(m.status()).toEqual(MEMBER_STATUS);

    // The member turns it off: the team hooks go back into the tracked settings.
    m.setOverride(false);
    const off = m.ok(['pull']);
    expect(hasTeamHook(hookCommands(path.join(m.dir, SETTINGS))), off.output).toBe(true);
    expect(hasTeamHook(hookCommands(path.join(m.dir, LOCAL_SETTINGS)))).toBe(false);
    expect(fs.existsSync(path.join(m.dir, LOCAL_SETTINGS))).toBe(false);
    expect(m.deliveredLines()).toEqual([]);
    // Nothing is kept out of git: the tracked settings show the team hooks, and every delivered copy shows.
    expect(m.status()).toEqual(expect.arrayContaining([` M ${SETTINGS}`, '?? .claude/skills/team-skill/SKILL.md', `?? ${COPILOT_HOOKS}`, ...MEMBER_STATUS]));

    // And on again.
    m.setOverride(null);
    m.ok(['pull']);
    expect(m.status()).toEqual(MEMBER_STATUS);
    expect(hasTeamHook(hookCommands(path.join(m.dir, LOCAL_SETTINGS)))).toBe(true);
  });

  it.each([['hooks', 'remove'], ['uninstall', '--force']])('teamai %s %s removes the team hooks from settings.local.json too', (...args: string[]) => {
    const m = member('self-remove');
    m.ok(['init', '.', '--provider', 'git', '--agent', 'claude,copilot']);
    expect(hasTeamHook(hookCommands(path.join(m.dir, LOCAL_SETTINGS)))).toBe(true);

    const removed = m.ok(args);

    expect(hasTeamHook(hookCommands(path.join(m.dir, LOCAL_SETTINGS))), removed.output).toBe(false);
    expect(hasSessionStart(hookCommands(path.join(m.dir, SETTINGS))), removed.output).toBe(false);
  });

  it('a linked worktree keeps the team hooks in its own settings.local.json, out of git', () => {
    const m = member('self-wt');
    m.ok(['init', '.', '--provider', 'git', '--agent', 'claude,copilot']);
    const wt = path.join(sandbox, `self-wt-linked-${attempt}`);

    m.git(['worktree', 'add', '-q', wt]);
    m.ok(['pull'], wt);

    expect(hasTeamHook(hookCommands(path.join(wt, LOCAL_SETTINGS)))).toBe(true);
    expect(hasTeamHook(hookCommands(path.join(wt, SETTINGS)))).toBe(false);
    expect(m.notIgnored([LOCAL_SETTINGS], wt)).toEqual([]);
    expect(m.status(wt)).toEqual([]);
  });

  it('each worktree gives Claude its own branch\'s MCP servers, out of git, though Claude files every worktree under one key', async () => {
    const server = (name: string): string => `  - name: ${name}\n    transport: http\n    url: https://${name}.example.com/mcp\n`;
    const m = member('self-mcp', { committed: { '.teamai/mcp/mcp.yaml': `servers:\n${server('main-api')}` } });
    m.ok(['init', '.', '--provider', 'git', '--agent', 'claude']);
    const wt = path.join(sandbox, `self-mcp-linked-${attempt}`);
    m.git(['worktree', 'add', '-q', '-b', 'feature', wt]);
    // Its post-checkout hook pulls there in the background: let it finish, or the next pull finds the lock held.
    await detached.waitForExit();
    writeFile(path.join(wt, '.teamai', 'mcp', 'mcp.yaml'), `servers:\n${server('main-api')}${server('feature-api')}`);
    m.git(['commit', '-q', '-am', 'feature server'], wt);
    /** The servers Claude Code reads in `checkout`: its `.mcp.json` and the local scope of the key every worktree shares. */
    const claudeServers = (checkout: string): string[] => {
      const mcpJson = path.join(checkout, '.mcp.json');
      const tree = fs.existsSync(mcpJson) ? JSON.parse(fs.readFileSync(mcpJson, 'utf8')).mcpServers ?? {} : {};
      const claudeJson = path.join(m.home, '.claude.json');
      const projects = fs.existsSync(claudeJson) ? JSON.parse(fs.readFileSync(claudeJson, 'utf8')).projects ?? {} : {};
      return [...Object.keys(tree), ...Object.keys(projects[m.dir]?.mcpServers ?? {})].sort();
    };

    for (const step of ['first', 'second']) {
      m.ok(['pull'], wt);
      await detached.waitForExit();
      m.ok(['pull']);
      await detached.waitForExit();
      expect(claudeServers(m.dir), step).toEqual(['main-api']);
      expect(claudeServers(wt), step).toEqual(['feature-api', 'main-api']);
      expect(m.status(), step).toEqual(MEMBER_STATUS);
      expect(m.status(wt), step).toEqual([]);
    }
  });
});
