/**
 * E2E: a worktree an agent tool creates without any git hook (Codex CLI runs
 * `git worktree add --no-checkout` then `git reset --hard`; Claude Code's
 * EnterWorktree fires none) gets the team's resources from the tool's own
 * hooks: the first tool use there, or a session started there, prepares it as
 * `post-checkout` prepares a new worktree. Real CLI, real git, isolated HOME,
 * local bare team repo behind a synthetic HTTPS URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForDetachedChildren } from '../helpers/detached-processes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');
const FAKE_URL = 'https://git.example.com/team/trigger-team.git';

const versionMatch = /(\d+)\.(\d+)/.exec(execFileSync('git', ['--version'], { encoding: 'utf8' }));
const [gitMajor, gitMinor] = versionMatch ? [Number(versionMatch[1]), Number(versionMatch[2])] : [0, 0];
const configHooks = gitMajor > 2 || (gitMajor === 2 && gitMinor >= 54);

describe.skipIf(!configHooks || process.platform === 'win32')('a worktree created without any git hook gets the team\'s resources from the tool\'s hooks', () => {
  let sandbox: string;
  let home: string;
  let project: string;
  let deployLog: string;

  const env = (): NodeJS.ProcessEnv => {
    const base: NodeJS.ProcessEnv = {
      ...process.env, HOME: home, USERPROFILE: home, FORCE_COLOR: '0',
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
    };
    delete base.CLAUDE_CONFIG_DIR;
    delete base.CODEX_HOME;
    return base;
  };
  const run = (command: string, args: string[], cwd: string): { code: number | null; output: string } => {
    const r = spawnSync(command, args, { cwd, encoding: 'utf8', env: env() });
    return { code: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const gitOk = (args: string[], cwd: string): string => {
    const r = run('git', args, cwd);
    if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.output}`);
    return r.output.trim();
  };
  const teamaiOk = (args: string[], cwd: string): void => {
    const r = run('node', [CLI, ...args], cwd);
    if (r.code !== 0) throw new Error(`teamai ${args.join(' ')} failed: ${r.output}`);
  };
  /** One host hook call, as Claude Code makes it: the payload on stdin, the dispatcher returning before its background pass. */
  const dispatch = (event: string, payload: Record<string, unknown>): Promise<number | null> => new Promise((resolve, reject) => {
    const child = spawn('node', [CLI, 'hook-dispatch', event, '--tool', 'claude'], { cwd: String(payload.cwd), env: env(), stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', reject).on('close', resolve);
    child.stdin.end(JSON.stringify({ session_id: `s-${event}-${Math.random()}`, ...payload }));
  });
  const enterWorktree = (dir: string) => dispatch('post-tool-use', {
    cwd: dir, hook_event_name: 'PostToolUse', tool_name: 'EnterWorktree', tool_input: { name: path.basename(dir) }, tool_response: {},
  });
  /** A worktree made the way Codex CLI makes one: no checkout, so git runs no post-checkout hook. */
  const hooklessWorktree = (name: string): string => {
    const dir = path.join(sandbox, name);
    gitOk(['worktree', 'add', '-q', '--no-checkout', '--detach', dir, 'HEAD'], project);
    gitOk(['reset', '-q', '--hard'], dir);
    return dir;
  };
  const skill = (dir: string) => path.join(dir, '.claude', 'skills', 'team-skill', 'SKILL.md');
  const rule = (dir: string) => path.join(dir, '.claude', 'rules', 'team-rule.md');
  const deploys = (dir: string): number => (fs.existsSync(deployLog) ? fs.readFileSync(deployLog, 'utf8') : '')
    .split('\n').filter((line) => line === dir).length;
  /** What the git hook recorded as failed for doctor, in every partition. */
  const gitHookFailures = (): string => {
    const projectsDir = path.join(home, '.teamai', 'projects');
    return fs.readdirSync(projectsDir).map((d) => path.join(projectsDir, d, 'git-hook-failure.json'))
      .filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f, 'utf8')).join('');
  };

  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-new-checkout-e2e-')));
    home = path.join(sandbox, 'home');
    fs.mkdirSync(home);
    deployLog = path.join(sandbox, 'post-deploy.log');
    const seed = path.join(sandbox, 'seed');
    const remote = path.join(sandbox, 'team.git');
    const write = (rel: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(seed, rel)), { recursive: true });
      fs.writeFileSync(path.join(seed, rel), content);
    };
    write('teamai.yaml', `team: trigger-e2e\nrepo: ${FAKE_URL}\nprovider: git\nreviewers: []\nscripts:\n  postDeploy:\n    path: scripts/post-deploy.mjs\n`);
    write('scripts/post-deploy.mjs', `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(deployLog)}, process.env.TEAMAI_CHECKOUT + '\\n');\n`);
    write('skills/team-skill/SKILL.md', '---\nname: team-skill\ndescription: Team skill fixture\n---\n\n# Team skill\n');
    write('rules/team-rule.md', '# Team rule\n');
    gitOk(['init', '-q', '-b', 'main'], seed);
    gitOk(['add', '-A'], seed);
    gitOk(['commit', '-q', '-m', 'seed'], seed);
    gitOk(['clone', '-q', '--bare', seed, remote], sandbox);
    gitOk(['config', '--global', `url.${remote}.insteadOf`, FAKE_URL], sandbox);

    project = path.join(sandbox, 'project');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, '.gitignore'), '.teamai/\n');
    gitOk(['init', '-q', '-b', 'main'], project);
    gitOk(['add', '-A'], project);
    gitOk(['commit', '-q', '-m', 'project'], project);
    teamaiOk(['init', FAKE_URL, '--scope', 'project', '--force', '--agent', 'claude'], project);
    teamaiOk(['pull'], project);
  }, 60_000);

  afterAll(async () => {
    await waitForDetachedChildren();
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  }, 65_000);

  it('the first tool use in the worktree delivers there and runs postDeploy', async () => {
    const dir = hooklessWorktree('wt-enter');
    expect(fs.existsSync(skill(dir))).toBe(false);

    expect(await enterWorktree(dir)).toBe(0);
    await waitForDetachedChildren();

    expect(fs.existsSync(skill(dir))).toBe(true);
    expect(fs.existsSync(rule(dir))).toBe(true);
    expect(deploys(dir)).toBe(1);
  }, 60_000);

  it('tool uses at once in a new worktree deliver once: one postDeploy, nothing for git to record', async () => {
    const dir = hooklessWorktree('wt-parallel');

    expect(await Promise.all([enterWorktree(dir), enterWorktree(dir), enterWorktree(dir)])).toEqual([0, 0, 0]);
    await waitForDetachedChildren();

    expect(fs.existsSync(skill(dir))).toBe(true);
    expect(deploys(dir)).toBe(1);
    expect(gitHookFailures()).not.toContain('lock-held');
  }, 60_000);

  it('a checkout with a delivery record costs a tool use nothing more', async () => {
    const dir = hooklessWorktree('wt-recorded');
    await enterWorktree(dir);
    await waitForDetachedChildren();
    fs.rmSync(skill(dir));

    await enterWorktree(dir);
    await waitForDetachedChildren();

    expect(fs.existsSync(skill(dir))).toBe(false);
    expect(deploys(dir)).toBe(1);
  }, 60_000);

  it('offline, with a team clone fetched days ago: a tool use delivers from the clone, and postDeploy runs once', async () => {
    const remote = path.join(sandbox, 'team.git');
    const projectsDir = path.join(home, '.teamai', 'projects');
    const stamp = path.join(projectsDir, fs.readdirSync(projectsDir)[0], 'last-fetch.json');
    const fetched = fs.readFileSync(stamp, 'utf8');
    fs.writeFileSync(stamp, JSON.stringify({ lastFetch: new Date(Date.now() - 72 * 3600_000).toISOString() }));
    fs.renameSync(remote, `${remote}.away`);
    try {
      const dir = hooklessWorktree('wt-offline');

      await enterWorktree(dir);
      await waitForDetachedChildren();
      await enterWorktree(dir);
      await waitForDetachedChildren();

      expect(fs.existsSync(skill(dir))).toBe(true);
      expect(deploys(dir)).toBe(1);
    } finally {
      fs.renameSync(`${remote}.away`, remote);
      fs.writeFileSync(stamp, fetched);
    }
  }, 60_000);

  it('a new worktree whose git hook could not fetch runs postDeploy on the delivery a later tool use makes', async () => {
    const remote = path.join(sandbox, 'team.git');
    const projectsDir = path.join(home, '.teamai', 'projects');
    const stamp = path.join(projectsDir, fs.readdirSync(projectsDir)[0], 'last-fetch.json');
    const fetched = fs.readFileSync(stamp, 'utf8');
    const dir = path.join(sandbox, 'wt-unfetched');
    fs.writeFileSync(stamp, JSON.stringify({ lastFetch: new Date(Date.now() - 72 * 3600_000).toISOString() }));
    fs.renameSync(remote, `${remote}.away`);
    try {
      gitOk(['worktree', 'add', '-q', '--detach', dir, 'HEAD'], project);
      await waitForDetachedChildren();
      expect(deploys(dir)).toBe(0);
    } finally {
      fs.renameSync(`${remote}.away`, remote);
      fs.writeFileSync(stamp, fetched);
    }

    await enterWorktree(dir);
    await waitForDetachedChildren();

    expect(fs.existsSync(skill(dir))).toBe(true);
    expect(deploys(dir)).toBe(1);
  }, 60_000);

  it('a new worktree whose git hook could not fetch runs postDeploy in the pull that hook hands over to, once it can', async () => {
    const remote = path.join(sandbox, 'team.git');
    const projectsDir = path.join(home, '.teamai', 'projects');
    const stamp = path.join(projectsDir, fs.readdirSync(projectsDir)[0], 'last-fetch.json');
    const fetched = fs.readFileSync(stamp, 'utf8');
    const dir = path.join(sandbox, 'wt-handover');
    fs.writeFileSync(stamp, JSON.stringify({ lastFetch: new Date(Date.now() - 72 * 3600_000).toISOString() }));
    fs.renameSync(remote, `${remote}.away`);
    try {
      gitOk(['worktree', 'add', '-q', '--detach', dir, 'HEAD'], project);
      await waitForDetachedChildren();
    } finally {
      fs.renameSync(`${remote}.away`, remote);
      fs.writeFileSync(stamp, fetched);
    }
    expect(deploys(dir)).toBe(0);

    // What git's hook starts after `git worktree add` returns, reaching the team repo this time.
    const handover = spawnSync('node', [CLI, 'pull', '--silent'], {
      cwd: dir, encoding: 'utf8', env: { ...env(), TEAMAI_GIT_HOOK: 'post-checkout', TEAMAI_PREPARE_CHECKOUT: 'once' },
    });

    expect(handover.status).toBe(0);
    expect(fs.existsSync(skill(dir))).toBe(true);
    expect(deploys(dir)).toBe(1);
  }, 60_000);

  it('a worktree removed and created again at the same path is prepared again, postDeploy included', async () => {
    const dir = path.join(sandbox, 'wt-again');
    gitOk(['worktree', 'add', '-q', '--detach', dir, 'HEAD'], project);
    await waitForDetachedChildren();
    expect(deploys(dir)).toBe(1);
    gitOk(['worktree', 'remove', '--force', dir], project);

    gitOk(['worktree', 'add', '-q', '--detach', dir, 'HEAD'], project);
    await waitForDetachedChildren();

    expect(fs.existsSync(skill(dir))).toBe(true);
    expect(deploys(dir)).toBe(2);
  }, 60_000);

  it('a session started in the worktree prepares it as a new worktree, postDeploy included', async () => {
    const dir = hooklessWorktree('wt-session');

    expect(await dispatch('session-start', { cwd: dir, hook_event_name: 'SessionStart', source: 'startup' })).toBe(0);
    await waitForDetachedChildren();

    expect(fs.existsSync(skill(dir))).toBe(true);
    expect(deploys(dir)).toBe(1);
  }, 120_000);

  it('git worktree add elsewhere, racing a tool use in a new worktree, returns and records no failure', async () => {
    const dir = hooklessWorktree('wt-race-tool');
    const added = path.join(sandbox, 'wt-race-git');

    const [tool, git] = await Promise.all([
      enterWorktree(dir),
      new Promise<number | null>((resolve) => {
        spawn('git', ['worktree', 'add', '-q', added], { cwd: project, env: env(), stdio: 'ignore' }).on('close', resolve);
      }),
    ]);
    await waitForDetachedChildren();

    expect([tool, git]).toEqual([0, 0]);
    expect(fs.existsSync(skill(dir))).toBe(true);
    expect(fs.existsSync(skill(added))).toBe(true);
    expect([deploys(dir), deploys(added)]).toEqual([1, 1]);
    expect(gitHookFailures()).not.toContain('lock-held');
  }, 120_000);
});
