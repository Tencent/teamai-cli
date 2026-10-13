/**
 * E2E: a new worktree gets the team's resources before `git worktree add`
 * returns. `teamai init` (project scope) installs a named hook in the
 * repository's git config; real git runs it on `post-checkout`, and it calls
 * the real CLI's dispatcher, which creates the tool roots and pulls into the
 * new worktree. `git pull` (`post-merge`, `post-rewrite`, or a fast-forward rebase's `post-checkout`) brings the team's change the same way.
 *
 * The team remote is a local bare repo reached through a synthetic HTTPS URL
 * (`url.<path>.insteadOf` in the sandbox HOME), as in init-project-all.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackDetachedProcesses } from '../helpers/detached-processes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const FAKE_URL = 'https://git.example.com/team/hook-team.git';
const ZERO_OID = '0'.repeat(40);

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

const versionMatch = /(\d+)\.(\d+)/.exec(execFileSync('git', ['--version'], { encoding: 'utf8' }));
const [gitMajor, gitMinor] = versionMatch ? [Number(versionMatch[1]), Number(versionMatch[2])] : [0, 0];
const configHooks = gitMajor > 2 || (gitMajor === 2 && gitMinor >= 54);
const eventDisable = gitMajor > 2 || (gitMajor === 2 && gitMinor >= 55);

interface Run {
  code: number | null;
  output: string;
}

describe.skipIf(!configHooks)('git hook: a new worktree gets the team\'s resources (git worktree add)', () => {
  let sandbox: string;
  let home: string;
  let remote: string;
  let claudeProject: string;
  let detached: ReturnType<typeof trackDetachedProcesses>;

  const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
    const base: NodeJS.ProcessEnv = { ...process.env, ...GIT_ENV, HOME: home, USERPROFILE: home, FORCE_COLOR: '0', ...extra };
    delete base.CLAUDE_CONFIG_DIR;
    delete base.CODEX_HOME;
    base.NODE_OPTIONS = [base.NODE_OPTIONS, detached.nodeOptions].filter(Boolean).join(' ');
    return base;
  };

  const run = (command: string, args: string[], cwd: string, extra: Record<string, string> = {}): Run => {
    const r = spawnSync(command, args, { cwd, encoding: 'utf8', env: env(extra) });
    return { code: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const git = (args: string[], cwd: string, extra: Record<string, string> = {}): Run => run('git', args, cwd, extra);
  const gitOk = (args: string[], cwd: string): string => {
    const r = git(args, cwd);
    if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.output}`);
    return r.output.trim();
  };
  const teamai = (args: string[], cwd: string, extra: Record<string, string> = {}): Run => run('node', [CLI, ...args], cwd, extra);

  /** A business repo with one commit, `teamai init`-ed in project scope. */
  const project = (name: string, initArgs: string[]): string => {
    const dir = path.join(sandbox, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, '.gitignore'), '.teamai/\n');
    gitOk(['init', '-q', '-b', 'main'], dir);
    gitOk(['add', '-A'], dir);
    gitOk(['commit', '-q', '-m', 'project'], dir);
    const init = teamai(['init', FAKE_URL, '--scope', 'project', '--force', ...initArgs], dir);
    if (init.code !== 0) throw new Error(`teamai init failed: ${init.output}`);
    const pulled = teamai(['pull'], dir);
    if (pulled.code !== 0) throw new Error(`teamai pull failed: ${pulled.output}`);
    return dir;
  };

  const worktreeAdd = (repo: string, name: string, extra: Record<string, string> = {}): { dir: string } & Run => {
    const dir = path.join(sandbox, name);
    return { dir, ...git(['worktree', 'add', '-q', dir], repo, extra) };
  };

  const delivered = (dir: string) => {
    const main = path.dirname(gitOk(['rev-parse', '--path-format=absolute', '--git-common-dir'], dir));
    const teamHooks = path.join(main, '.claude', 'settings.local.json');
    return {
      skill: fs.existsSync(path.join(dir, '.claude', 'skills', 'team-skill', 'SKILL.md')),
      agent: fs.existsSync(path.join(dir, '.claude', 'agents', 'team-agent.md')),
      hook: fs.existsSync(teamHooks)
        && fs.readFileSync(teamHooks, 'utf8').includes('echo team-hook-v1'),
      rule: fs.existsSync(path.join(dir, '.claude', 'rules', 'team-rule.md')),
      mcp: fs.existsSync(path.join(dir, '.mcp.json')) && fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8').includes('team-api'),
    };
  };
  const ALL = { skill: true, agent: true, hook: true, rule: true, mcp: true };
  const NOTHING = { skill: false, agent: false, hook: false, rule: false, mcp: false };

  /** The project partition (data home) `init` created for the repo at `root`. */
  const partitionOf = (root: string): string => {
    const projectsDir = path.join(home, '.teamai', 'projects');
    const found = fs.readdirSync(projectsDir).map((d) => path.join(projectsDir, d)).find((d) => {
      const config = path.join(d, 'config.yaml');
      return fs.existsSync(config) && fs.readFileSync(config, 'utf8').includes(`projectRoot: ${root}`);
    });
    if (!found) throw new Error(`No project partition for ${root}`);
    return found;
  };

  /** Entries the worktree has beyond what the branch tracks. */
  const untracked = (dir: string) =>
    fs.readdirSync(dir).filter((entry) => entry !== '.git' && entry !== '.gitignore').sort();

  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);

    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-git-hook-e2e-')));
    detached = trackDetachedProcesses(sandbox);
    home = path.join(sandbox, 'home');
    remote = path.join(sandbox, 'team.git');
    const seed = path.join(sandbox, 'seed');
    fs.mkdirSync(home);
    const write = (rel: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(seed, rel)), { recursive: true });
      fs.writeFileSync(path.join(seed, rel), content);
    };
    write('teamai.yaml', `team: git-hook-e2e\nrepo: ${FAKE_URL}\nprovider: git\nreviewers: []\nsharing:\n  mcp:\n    autoApply: true\n  hooks:\n    autoApply: true\n    requireTeamScripts: false\n`);
    write('skills/team-skill/SKILL.md', '---\nname: team-skill\ndescription: Team skill fixture\n---\n\n# Team skill\n');
    write('rules/team-rule.md', '# Team rule\n');
    write('agents/team-agent.yaml', 'name: team-agent\ndescription: Startup agent fixture\ninstructions: Team agent v1\n');
    write('hooks/hooks.yaml', 'hooks:\n  - id: startup-guard\n    description: Startup hook fixture\n    event: SessionStart\n    command: echo team-hook-v1\n');
    write('mcp/mcp.yaml', 'servers:\n  - name: team-api\n    transport: http\n    url: https://team.example.com/mcp\n');
    gitOk(['init', '-q', '-b', 'main'], seed);
    gitOk(['add', '-A'], seed);
    gitOk(['commit', '-q', '-m', 'seed'], seed);
    gitOk(['clone', '-q', '--bare', seed, remote], sandbox);
    gitOk(['config', '--global', `url.${remote}.insteadOf`, FAKE_URL], sandbox);

    claudeProject = project('claude-project', ['--agent', 'claude']);
  }, 60_000);

  afterAll(async () => {
    // The parent hook exits before its child finishes. Join every child before
    // deleting HOME; a moment without a sync lock does not mean it has exited.
    if (detached) await detached.waitForExit();
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  }, 65_000);

  it('init installs one named hook per git event in the repository config', () => {
    expect(gitOk(['hook', 'list', 'post-checkout'], claudeProject)).toBe('teamai-post-checkout');
    expect(gitOk(['hook', 'list', 'post-merge'], claudeProject)).toBe('teamai-post-merge');
    expect(gitOk(['hook', 'list', 'post-rewrite'], claudeProject)).toBe('teamai-post-rewrite');
  });

  it('delivers skills, agents, rules, MCP and team hooks for enabledAgents before git worktree add returns, silently', () => {
    const wt = worktreeAdd(claudeProject, 'wt-claude');

    expect(wt.code).toBe(0);
    expect(wt.output).toBe('');
    expect(delivered(wt.dir)).toEqual(ALL);
    expect(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).toContain('teamai hook-dispatch');
    expect(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).not.toContain('echo team-hook-v1');
    expect(fs.existsSync(path.join(wt.dir, '.claude', 'settings.local.json'))).toBe(false);
    expect(fs.existsSync(path.join(wt.dir, '.codex'))).toBe(false);
  });

  it('does the same for a worktree an app creates from a script, without a login PATH or a session', () => {
    // Only git on PATH: teamai is found through the wrapper in ~/.teamai/bin.
    const onlyGit = path.join(sandbox, 'only-git');
    fs.mkdirSync(onlyGit, { recursive: true });
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    if (!fs.existsSync(path.join(onlyGit, 'git'))) fs.symlinkSync(realGit, path.join(onlyGit, 'git'));
    const dir = path.join(sandbox, 'wt-app');
    const script = path.join(sandbox, 'app.sh');
    fs.writeFileSync(script, `#!/bin/sh\ncd "$1" && git worktree add -q "$2"\n`, { mode: 0o755 });

    const r = run('/bin/sh', [script, claudeProject, dir], sandbox, { PATH: `${onlyGit}:/usr/bin:/bin` });

    expect(r.code, r.output).toBe(0);
    expect(r.output).toBe('');
    expect(delivered(dir)).toEqual(ALL);
  });

  it('a branch switch in an existing checkout triggers no sync', () => {
    const wt = worktreeAdd(claudeProject, 'wt-switch');
    expect(delivered(wt.dir)).toEqual(ALL);
    fs.rmSync(path.join(wt.dir, '.claude'), { recursive: true, force: true });

    const r = git(['checkout', '-q', '-b', 'feature-switch'], wt.dir);

    expect(r.code, r.output).toBe(0);
    expect(r.output).toBe('');
    expect(fs.existsSync(path.join(wt.dir, '.claude'))).toBe(false);
  });

  it('runs beside an existing .git/hooks/post-checkout script', () => {
    const marker = path.join(sandbox, 'hooks-dir-ran');
    const hookFile = path.join(claudeProject, '.git', 'hooks', 'post-checkout');
    fs.writeFileSync(hookFile, `#!/bin/sh\necho "$1" > "${marker}"\n`, { mode: 0o755 });
    try {
      const wt = worktreeAdd(claudeProject, 'wt-hooks-dir');

      expect(wt.code, wt.output).toBe(0);
      expect(fs.readFileSync(marker, 'utf8').trim()).toBe(ZERO_OID);
      expect(delivered(wt.dir)).toEqual(ALL);
    } finally {
      fs.rmSync(hookFile, { force: true });
    }
  });

  it('runs beside a core.hooksPath hook manager', () => {
    const marker = path.join(sandbox, 'hooks-path-ran');
    const managerDir = path.join(sandbox, 'manager-hooks');
    fs.mkdirSync(managerDir, { recursive: true });
    fs.writeFileSync(path.join(managerDir, 'post-checkout'), `#!/bin/sh\necho "$1" > "${marker}"\n`, { mode: 0o755 });
    gitOk(['config', '--local', 'core.hooksPath', managerDir], claudeProject);
    try {
      const wt = worktreeAdd(claudeProject, 'wt-hooks-path');

      expect(wt.code, wt.output).toBe(0);
      expect(fs.readFileSync(marker, 'utf8').trim()).toBe(ZERO_OID);
      expect(delivered(wt.dir)).toEqual(ALL);
    } finally {
      gitOk(['config', '--local', '--unset', 'core.hooksPath'], claudeProject);
    }
  });

  it('prints nothing and exits 0 when the pull fails', () => {
    const away = `${remote}.away`;
    fs.renameSync(remote, away);
    try {
      const wt = worktreeAdd(claudeProject, 'wt-offline');

      expect(wt.code).toBe(0);
      expect(wt.output).toBe('');
      expect(fs.existsSync(path.join(wt.dir, '.gitignore'))).toBe(true);
    } finally {
      fs.renameSync(away, remote);
    }
  });

  it('an unreadable project config means no sync', () => {
    const config = path.join(partitionOf(claudeProject), 'config.yaml');
    const original = fs.readFileSync(config, 'utf8');
    fs.writeFileSync(config, 'repo: [unclosed\n');
    try {
      const wt = worktreeAdd(claudeProject, 'wt-unreadable');

      expect(wt.code).toBe(0);
      expect(wt.output).toBe('');
      expect(fs.existsSync(path.join(wt.dir, '.claude'))).toBe(false);
    } finally {
      fs.writeFileSync(config, original);
    }
  });

  it('a repository without teamai config does nothing with a hook left behind', () => {
    const other = path.join(sandbox, 'no-teamai');
    fs.mkdirSync(other);
    gitOk(['init', '-q', '-b', 'main'], other);
    gitOk(['commit', '-q', '--allow-empty', '-m', 'init'], other);
    gitOk(['config', '--local', 'hook.teamai-post-checkout.command',
      gitOk(['config', '--local', '--get', 'hook.teamai-post-checkout.command'], claudeProject)], other);
    gitOk(['config', '--local', 'hook.teamai-post-checkout.event', 'post-checkout'], other);
    fs.mkdirSync(path.join(other, '.claude'));

    const wt = worktreeAdd(other, 'wt-no-teamai');

    expect(wt.code).toBe(0);
    expect(wt.output).toBe('');
    expect(untracked(wt.dir)).toEqual([]);
  });

  it('a worktree teamai creates under its own data home is left alone', () => {
    const dir = path.join(partitionOf(claudeProject), 'own-worktree');

    const r = git(['worktree', 'add', '-q', '--detach', dir], claudeProject);

    expect(r.code, r.output).toBe(0);
    expect(fs.existsSync(path.join(dir, '.claude'))).toBe(false);
  });

  it('clears the repository Git exports to the hook before running git', () => {
    // A worktree created with the hook off, then the dispatcher run the way git
    // runs it for `git --git-dir=... worktree add`: GIT_DIR names the business
    // repo, and the team clone's pull must not act on it.
    const dir = path.join(sandbox, 'wt-git-dir');
    gitOk(['-c', 'hook.teamai-post-checkout.enabled=false', 'worktree', 'add', '-q', dir], claudeProject);
    // Team hooks are shared from the main checkout before this worktree is prepared.
    expect(delivered(dir)).toEqual({ ...NOTHING, hook: true });
    const head = gitOk(['rev-parse', 'HEAD'], dir);

    const r = teamai(['hook-dispatch', 'post-checkout', '--tool', 'git', ZERO_OID, head, '1'], dir, {
      GIT_DIR: path.join(claudeProject, '.git'),
      GIT_WORK_TREE: claudeProject,
    });

    expect(r.code).toBe(0);
    expect(r.output).toBe('');
    expect(delivered(dir)).toEqual(ALL);
  });

  const stampOf = (root: string) => path.join(partitionOf(root), 'last-fetch.json');
  /** Commit a new skill to the team remote; returns its name. */
  const pushSkill = (name: string): void => {
    const work = path.join(sandbox, `push-${name}`);
    gitOk(['clone', '-q', remote, work], sandbox);
    fs.mkdirSync(path.join(work, 'skills', name), { recursive: true });
    fs.writeFileSync(path.join(work, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\n`);
    gitOk(['add', '-A'], work);
    gitOk(['commit', '-q', '-m', name], work);
    gitOk(['push', '-q', 'origin', 'HEAD:main'], work);
  };
  const hasSkill = (dir: string, name: string) => fs.existsSync(path.join(dir, '.claude', 'skills', name, 'SKILL.md'));
  const waitFor = async (check: () => boolean, ms = 30_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (check()) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return check();
  };
  /**
   * Wait for the detached pulls of the project to finish: no partition lock
   * for a full second (one may not have taken it yet).
   */
  const settle = async (root: string) => {
    const lock = path.join(partitionOf(root), '.sync-lock');
    let freeSince = Date.now();
    await waitFor(() => {
      if (fs.existsSync(lock)) freeSince = Date.now();
      return Date.now() - freeSince >= 1000;
    });
  };

  describe('inline pass reads the team clone, the detached pull fetches the rest', () => {
    it('a clone fetched within the TTL: no fetch while the hook runs; the detached pull fetches afterwards', async () => {
      const repo = project('fresh-project', ['--agent', 'claude']);
      await settle(repo);
      expect(fs.existsSync(stampOf(repo))).toBe(true);
      pushSkill('late-skill');
      const trace = path.join(sandbox, 'fresh-trace.log');

      const wt = worktreeAdd(repo, 'wt-fresh', { GIT_TRACE: trace });

      expect(wt.code, wt.output).toBe(0);
      expect(wt.output).toBe('');
      expect(delivered(wt.dir)).toEqual(ALL);
      expect(hasSkill(wt.dir, 'late-skill')).toBe(false);
      const traced = fs.readFileSync(trace, 'utf8');
      expect(traced).toMatch(/hook-dispatch post-checkout/);
      expect(traced).not.toMatch(/\b(fetch|upload-pack|pull)\b/);

      expect(await waitFor(() => hasSkill(wt.dir, 'late-skill'))).toBe(true);
      await settle(repo);
    });

    it('a clone fetched more than 24 h ago: the hook fetches the team repo before delivering', async () => {
      const repo = project('stale-project', ['--agent', 'claude']);
      await settle(repo);
      fs.writeFileSync(stampOf(repo), JSON.stringify({ lastFetch: new Date(Date.now() - 25 * 3600_000).toISOString() }));
      pushSkill('stale-skill');

      const wt = worktreeAdd(repo, 'wt-stale');

      expect(wt.code, wt.output).toBe(0);
      expect(hasSkill(wt.dir, 'stale-skill')).toBe(true);
      await settle(repo);
    });

    it('delivers what a full pull delivers at the same team revision', async () => {
      const repo = project('equal-project', ['--agent', 'claude']);
      await settle(repo);
      const tree = (dir: string): string[] => {
        const out: string[] = [];
        const walk = (rel: string) => {
          for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
            const r = path.join(rel, e.name);
            if (e.isDirectory()) walk(r);
            else out.push(`${r}:${fs.readFileSync(path.join(dir, r), 'utf8')}`);
          }
        };
        for (const top of ['.claude', '.mcp.json']) {
          if (!fs.existsSync(path.join(dir, top))) continue;
          if (fs.statSync(path.join(dir, top)).isDirectory()) walk(top);
          else out.push(`${top}:${fs.readFileSync(path.join(dir, top), 'utf8')}`);
        }
        return out.sort();
      };
      const hooked = worktreeAdd(repo, 'wt-equal-hook');
      const snapshot = tree(hooked.dir);
      await settle(repo);
      const manual = path.join(sandbox, 'wt-equal-pull');
      gitOk(['-c', 'hook.teamai-post-checkout.enabled=false', 'worktree', 'add', '-q', manual], repo);
      fs.mkdirSync(path.join(manual, '.claude')); // the root the hook creates; pull skips a tool without one
      const pulled = teamai(['pull', '--silent'], manual);
      expect(pulled.code, pulled.output).toBe(0);

      expect(snapshot.length).toBeGreaterThan(0);
      expect(snapshot).toEqual(tree(manual));
    });
  });

  describe('git pull brings the team\'s change before the next session', () => {
    /** Give `root` an origin a teammate pushes to; returns a function that pushes one commit. */
    const withOrigin = (root: string): (() => void) => {
      const bare = `${root}.git`;
      gitOk(['clone', '-q', '--bare', root, bare], sandbox);
      gitOk(['remote', 'add', 'origin', bare], root);
      gitOk(['fetch', '-q', 'origin'], root);
      gitOk(['branch', '-q', '-u', 'origin/main'], root);
      const mate = `${root}-mate`;
      gitOk(['clone', '-q', bare, mate], sandbox);
      let n = 0;
      return () => {
        fs.writeFileSync(path.join(mate, `change-${++n}.txt`), `${n}\n`);
        gitOk(['add', '-A'], mate);
        gitOk(['commit', '-q', '-m', `change ${n}`], mate);
        gitOk(['push', '-q', 'origin', 'HEAD:main'], mate);
      };
    };

    it('amending a commit does not fetch or sync pending team resources', async () => {
      const repo = project('amend-project', ['--agent', 'claude']);
      await settle(repo);
      pushSkill('amend-only-skill');
      const trace = path.join(sandbox, 'amend-trace.log');

      const r = git(['commit', '--amend', '-q', '--no-edit'], repo, { GIT_TRACE: trace });

      expect(r.code, r.output).toBe(0);
      expect(r.output).toBe('');
      expect(hasSkill(repo, 'amend-only-skill')).toBe(false);
      const traced = fs.readFileSync(trace, 'utf8');
      const fromHook = traced.slice(traced.indexOf('hook-dispatch post-rewrite'));
      expect(fromHook).toContain('hook-dispatch post-rewrite');
      expect(fromHook).not.toMatch(/\b(fetch|upload-pack|ls-remote|push|pull)\b/);
      await detached.waitForExit();
      expect(hasSkill(repo, 'amend-only-skill')).toBe(false);
    });

    it.each(['merge', 'rebase'])('separate team repo: published resources are delivered before git pull with %s returns', async (mode) => {
      const repo = project(`published-${mode}-project`, ['--agent', 'claude']);
      const businessChange = withOrigin(repo);
      await settle(repo);
      const skill = `published-${mode}-skill`;
      pushSkill(skill);
      const version = mode === 'merge' ? 'v2' : 'v3';
      const teamChange = path.join(sandbox, `push-${skill}`);
      fs.writeFileSync(path.join(teamChange, 'agents', 'team-agent.yaml'), `name: team-agent\ndescription: Startup agent fixture\ninstructions: Team agent ${version}\n`);
      fs.writeFileSync(path.join(teamChange, 'rules', 'team-rule.md'), `# Team rule ${version}\n`);
      fs.writeFileSync(path.join(teamChange, 'mcp', 'mcp.yaml'), `servers:\n  - name: team-api\n    transport: http\n    url: https://team-${version}.example.com/mcp\n`);
      fs.writeFileSync(path.join(teamChange, 'hooks', 'hooks.yaml'), `hooks:\n  - id: startup-guard\n    description: Startup hook fixture\n    event: SessionStart\n    command: echo team-hook-${version}\n`);
      gitOk(['add', '-A'], teamChange);
      gitOk(['commit', '-q', '-m', 'update all startup resources'], teamChange);
      gitOk(['push', '-q', 'origin', 'HEAD:main'], teamChange);
      businessChange();
      if (mode === 'rebase') {
        fs.writeFileSync(path.join(repo, 'local.txt'), 'local\n');
        gitOk(['add', 'local.txt'], repo);
        gitOk(['commit', '-q', '-m', 'local change'], repo);
      }

      const r = git(['pull', '-q', ...(mode === 'rebase' ? ['--rebase'] : [])], repo);

      expect(r.code, r.output).toBe(0);
      expect(r.output).toBe('');
      expect(fs.existsSync(path.join(repo, 'change-1.txt'))).toBe(true);
      expect(hasSkill(repo, skill)).toBe(true);
      expect(fs.readFileSync(path.join(repo, '.claude', 'agents', 'team-agent.md'), 'utf8')).toContain(`Team agent ${version}`);
      expect(fs.readFileSync(path.join(repo, '.claude', 'rules', 'team-rule.md'), 'utf8')).toContain(`Team rule ${version}`);
      expect(fs.readFileSync(path.join(repo, '.mcp.json'), 'utf8')).toContain(`https://team-${version}.example.com/mcp`);
      expect(fs.readFileSync(path.join(repo, '.claude', 'settings.local.json'), 'utf8')).toContain(`echo team-hook-${version}`);
      await settle(repo);
    });

    it('separate team repo unreachable: git pull returns within the cap and exits as git would', async () => {
      const repo = project('hang-project', ['--agent', 'claude']);
      const businessChange = withOrigin(repo);
      await settle(repo);
      businessChange();
      // A team remote that accepts the connection and never answers.
      const sockets: net.Socket[] = [];
      const server = net.createServer((socket) => { sockets.push(socket); });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as net.AddressInfo).port;
      const rewrite = `url.${remote}.insteadOf`;
      gitOk(['config', '--global', '--unset', rewrite], sandbox);
      gitOk(['config', '--global', `url.http://127.0.0.1:${port}/team.git.insteadOf`, FAKE_URL], sandbox);
      try {
        const started = Date.now();
        const r = git(['pull', '-q'], repo);
        const elapsed = Date.now() - started;

        expect(r.code, r.output).toBe(0);
        expect(r.output).toBe('');
        expect(fs.existsSync(path.join(repo, 'change-1.txt'))).toBe(true);
        expect(elapsed).toBeGreaterThanOrEqual(4_000); // the fetch really hung until the cap
        expect(elapsed).toBeLessThan(10_000);
      } finally {
        gitOk(['config', '--global', '--unset', `url.http://127.0.0.1:${port}/team.git.insteadOf`], sandbox);
        gitOk(['config', '--global', rewrite, FAKE_URL], sandbox);
        server.close();
        for (const socket of sockets) socket.destroy();
      }
      await settle(repo);
    });

    // Fast-forward with autostash: Git 2.33+ merges (post-merge); Git 2.14–2.32 runs
    // `git rebase` under the pull's GIT_REFLOG_ACTION, which only checks out the
    // upstream (post-checkout). The legacy mode runs that step as old Git does.
    it.each(['merge', 'rebase', 'configured-rebase', 'conflicting-rebase', 'autostash-fast-forward', 'legacy-autostash-fast-forward'])('self mode: git pull with %s delivers a changed rule without hook network', async (mode) => {
      const repo = path.join(sandbox, `self-project-${mode}`);
      fs.mkdirSync(repo);
      fs.writeFileSync(path.join(repo, 'README'), 'x\n');
      gitOk(['init', '-q', '-b', 'main'], repo);
      gitOk(['add', '-A'], repo);
      gitOk(['commit', '-q', '-m', 'project'], repo);
      // init parses the origin as a provider URL; the pull itself uses a local remote.
      gitOk(['remote', 'add', 'origin', 'http://127.0.0.1:9/team/self.git'], repo);
      const init = teamai(['init', '--self', '--agent', 'claude', '--force'], repo);
      expect(init.code, init.output).toBe(0);
      gitOk(['remote', 'remove', 'origin'], repo);
      withOrigin(repo);
      const mate = `${repo}-mate`;
      fs.mkdirSync(path.join(mate, '.teamai', 'rules'), { recursive: true });
      fs.writeFileSync(path.join(mate, '.teamai', 'rules', 'self-rule.md'), '# Self rule\n');
      if (mode === 'conflicting-rebase') fs.writeFileSync(path.join(mate, 'README'), 'remote\n');
      gitOk(['add', '-A'], mate);
      gitOk(['commit', '-q', '-m', 'rule'], mate);
      gitOk(['push', '-q', 'origin', 'HEAD:main'], mate);
      const fastForward = mode.endsWith('autostash-fast-forward');
      if (fastForward) fs.writeFileSync(path.join(repo, 'README'), 'dirty\n');
      if (mode !== 'merge' && !fastForward) {
        const localFile = mode === 'conflicting-rebase' ? 'README' : 'local.txt';
        fs.writeFileSync(path.join(repo, localFile), 'local\n');
        gitOk(['add', localFile], repo);
        gitOk(['commit', '-q', '-m', 'local change'], repo);
      }
      if (mode === 'configured-rebase') gitOk(['config', 'pull.rebase', 'true'], repo);
      if (mode === 'autostash-fast-forward') gitOk(['config', 'rebase.autoStash', 'true'], repo);
      if (mode === 'legacy-autostash-fast-forward') gitOk(['fetch', '-q', 'origin'], repo);
      const trace = path.join(sandbox, `self-trace-${mode}.log`);

      let r = mode === 'legacy-autostash-fast-forward'
        ? git(['rebase', '-q', '--autostash', 'origin/main'], repo, { GIT_TRACE: trace, GIT_REFLOG_ACTION: 'pull --rebase --autostash' })
        : git(['pull', '-q', ...(['rebase', 'conflicting-rebase', 'autostash-fast-forward'].includes(mode) ? ['--rebase'] : [])], repo, { GIT_TRACE: trace });
      if (mode === 'conflicting-rebase') {
        expect(r.code).not.toBe(0);
        expect(fs.existsSync(path.join(repo, '.claude', 'rules', 'self-rule.md'))).toBe(false);
        fs.writeFileSync(path.join(repo, 'README'), 'resolved\n');
        gitOk(['add', 'README'], repo);
        r = git(['rebase', '--continue'], repo, { GIT_TRACE: trace, GIT_EDITOR: 'true' });
      }

      expect(r.code, r.output).toBe(0);
      // Autostash and a resolved conflict print git's own lines; the hook still prints nothing.
      if (mode === 'conflicting-rebase' || fastForward) expect(r.output).not.toContain('teamai');
      else expect(r.output).toBe('');
      if (fastForward) expect(fs.readFileSync(path.join(repo, 'README'), 'utf8')).toBe('dirty\n');
      expect(fs.readFileSync(path.join(repo, '.claude', 'rules', 'self-rule.md'), 'utf8')).toContain('# Self rule');
      const traced = fs.readFileSync(trace, 'utf8');
      const event = mode === 'legacy-autostash-fast-forward' ? 'post-checkout'
        : ['merge', 'autostash-fast-forward'].includes(mode) ? 'post-merge' : 'post-rewrite';
      const fromHook = traced.slice(traced.indexOf(`hook-dispatch ${event}`));
      expect(fromHook).toContain(`hook-dispatch ${event}`);
      expect(fromHook).not.toMatch(/\b(fetch|upload-pack|ls-remote|push|pull)\b/);
    });
  });

  describe('a failure inside the hook is visible', () => {
    /** Make the next post-checkout fetch the team repo, and fail doing it (with the detached retry). */
    const failNextHook = (repo: string): (() => void) => {
      fs.writeFileSync(stampOf(repo), JSON.stringify({ lastFetch: new Date(Date.now() - 25 * 3600_000).toISOString() }));
      const away = `${remote}.away`;
      fs.renameSync(remote, away);
      return () => fs.renameSync(away, remote);
    };

    it('doctor reports the hook installed, and missing with the reason', () => {
      const repo = project('doctor-hook-project', ['--agent', 'claude']);
      expect(teamai(['doctor'], repo).output).toContain('✔ Git hook syncs new worktrees and git pull');

      gitOk(['config', '--local', '--unset', 'hook.teamai-post-checkout.command'], repo);
      const missing = teamai(['doctor'], repo).output;

      expect(missing).toContain('✖ Git hook syncs new worktrees and git pull');
      expect(missing).toMatch(/not in this repository's git config.*Run `teamai pull`/);
    });

    it.each(['hook.teamai-post-checkout.enabled', 'hook.post-checkout.enabled'].filter(key => key.includes('teamai-') || eventDisable))('doctor reports %s disabled; pull preserves it; reactivation restores delivery', async (key) => {
      const repo = project(`doctor-disabled-${key}`, ['--agent', 'claude']);
      await settle(repo);
      gitOk(['config', '--local', key, 'false'], repo);
      const disabled = teamai(['doctor'], repo).output;
      expect(disabled).toContain('✖ Git hook syncs new worktrees and git pull');
      expect(disabled).toContain(`${key}=false`);
      expect(disabled).toContain(`git config --local ${key} true`);
      const pull = teamai(['pull'], repo);
      expect(pull.code, pull.output).toBe(0);
      expect(gitOk(['config', '--get', key], repo)).toBe('false');
      const off = worktreeAdd(repo, `disabled-wt-${key}`);
      expect(off.code, off.output).toBe(0);
      expect(fs.existsSync(path.join(off.dir, '.claude'))).toBe(false);

      gitOk(['config', '--local', key, 'true'], repo);
      expect(teamai(['doctor'], repo).output).toContain('✔ Git hook syncs new worktrees and git pull');
      const on = worktreeAdd(repo, `reactivated-wt-${key}`);
      expect(on.code, on.output).toBe(0);
      expect(hasSkill(on.dir, 'team-skill')).toBe(true);
      expect(fs.existsSync(path.join(on.dir, '.claude', 'rules', 'team-rule.md'))).toBe(true);
      await settle(repo);
    });

    it('git worktree add exits 0; doctor names the failure; the next interactive pull mentions it once', async () => {
      const repo = project('fail-project', ['--agent', 'claude']);
      await settle(repo);
      const restore = failNextHook(repo);
      let wt: { dir: string } & Run;
      try {
        wt = worktreeAdd(repo, 'wt-fail');
        expect(wt.code).toBe(0);
        expect(wt.output).toBe('');
        await settle(repo);
      } finally {
        restore();
      }

      const doctor = teamai(['doctor'], repo).output;
      expect(doctor).toMatch(/✖ Last git hook run failed: post-checkout could not fetch the team repo/);
      expect(doctor).toMatch(/→ .*teamai pull/);

      const first = teamai(['pull'], wt.dir);
      expect(first.output).toMatch(/Last git hook run failed: post-checkout could not fetch the team repo/);
      const second = teamai(['pull'], wt.dir);
      expect(second.output).not.toMatch(/git hook run failed/);
      expect(teamai(['doctor'], repo).output).toContain('✔ No git hook failure recorded');
    });

    it('an interactive pull that fails too keeps the recorded failure for doctor', async () => {
      const repo = project('fail-again-project', ['--agent', 'claude']);
      await settle(repo);
      const restore = failNextHook(repo);
      try {
        const wt = worktreeAdd(repo, 'wt-fail-again');
        await settle(repo);
        expect(teamai(['pull'], wt.dir).output).toMatch(/Last git hook run failed/);
      } finally {
        restore();
      }
      expect(teamai(['doctor'], repo).output).toMatch(/✖ Last git hook run failed/);
    });

    it.each(['merge', 'rebase'])('a partition lock another pull holds: %s waits no longer than its cap and records why it skipped', async (mode) => {
      const repo = project(`locked-${mode}-project`, ['--agent', 'claude']);
      const bare = `${repo}.git`;
      gitOk(['clone', '-q', '--bare', repo, bare], sandbox);
      gitOk(['remote', 'add', 'origin', bare], repo);
      gitOk(['fetch', '-q', 'origin'], repo);
      gitOk(['branch', '-q', '-u', 'origin/main'], repo);
      const mate = `${repo}-mate`;
      gitOk(['clone', '-q', bare, mate], sandbox);
      fs.writeFileSync(path.join(mate, 'change.txt'), '1\n');
      gitOk(['add', '-A'], mate);
      gitOk(['commit', '-q', '-m', 'change'], mate);
      gitOk(['push', '-q', 'origin', 'HEAD:main'], mate);
      if (mode === 'rebase') gitOk(['commit', '-q', '--allow-empty', '-m', 'local change'], repo);
      await settle(repo);
      // A live holder: this test process.
      const lock = path.join(partitionOf(repo), '.sync-lock');
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), owner: 'e2e' }));
      try {
        const started = Date.now();
        const r = git(['pull', '-q', ...(mode === 'rebase' ? ['--rebase'] : [])], repo);
        const elapsed = Date.now() - started;

        expect(r.code, r.output).toBe(0);
        expect(r.output).toBe('');
        expect(elapsed).toBeLessThan(15_000);
        // The detached pull it hands over to meets the same lock and skips.
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      } finally {
        fs.rmSync(lock, { force: true });
      }

      const doctor = teamai(['doctor'], repo).output;
      const event = mode === 'merge' ? 'post-merge' : 'post-rewrite';
      expect(doctor).toContain(`✖ Last git hook run failed: ${event} skipped its sync: another teamai process held the project's sync lock`);
    }, 60_000);

    it('a successful hook run clears the recorded failure', async () => {
      const repo = project('recover-project', ['--agent', 'claude']);
      await settle(repo);
      const restore = failNextHook(repo);
      try {
        worktreeAdd(repo, 'wt-recover-fail');
        await settle(repo);
      } finally {
        restore();
      }
      expect(teamai(['doctor'], repo).output).toMatch(/✖ Last git hook run failed/);

      const wt = worktreeAdd(repo, 'wt-recover-ok');
      expect(wt.code).toBe(0);
      await settle(repo);

      expect(teamai(['doctor'], repo).output).toContain('✔ No git hook failure recorded');
    });
  });

  it('pull --dry-run names a missing hook without writing it; uninstall removes only teamai\'s hooks', async () => {
    const repo = project('uninstall-project', ['--agent', 'claude']);
    await settle(repo);
    gitOk(['config', '--local', 'hook.mine.command', 'echo mine'], repo);
    gitOk(['config', '--local', 'hook.mine.event', 'post-checkout'], repo);
    gitOk(['config', '--local', '--remove-section', 'hook.teamai-post-checkout'], repo);
    const before = gitOk(['config', '--local', '--list'], repo);

    const dry = teamai(['pull', '--dry-run'], repo);
    expect(dry.output).toContain('Would install or update the teamai git hook');
    expect(gitOk(['config', '--local', '--list'], repo)).toBe(before);

    const r = teamai(['uninstall', '--force'], repo);
    expect(r.code, r.output).toBe(0);
    expect(gitOk(['config', '--get-regexp', '^hook\\.'], repo).split('\n'))
      .toEqual(['hook.mine.command echo mine', 'hook.mine.event post-checkout']);
  });

  it('with no enabledAgents, creates the tool roots the main checkout has, and only those', () => {
    // Earlier fixtures installed HOME roots. Start with no installed tools so
    // init does not create main-checkout hooks before the explicit Codex seed.
    for (const root of ['.claude', '.codex']) fs.rmSync(path.join(home, root), { recursive: true, force: true });
    const codexProject = project('codex-project', []);
    fs.mkdirSync(path.join(codexProject, '.codex'));

    const wt = worktreeAdd(codexProject, 'wt-codex');

    expect(wt.code).toBe(0);
    expect(wt.output).toBe('');
    expect(fs.statSync(path.join(wt.dir, '.codex')).isDirectory()).toBe(true);
    expect(untracked(wt.dir).filter((entry) => entry.startsWith('.') && fs.statSync(path.join(wt.dir, entry)).isDirectory()))
      .toEqual(['.codex']);
  });
});
