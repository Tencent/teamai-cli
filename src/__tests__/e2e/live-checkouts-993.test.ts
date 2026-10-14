/**
 * E2E (#993 bug 1): a pull in a linked worktree never treats another live
 * checkout as removed.
 *
 * Each checkout has a delivery record in state.json and a `workspaces/<id>/`
 * directory in the project's data home; a full pull drops those of removed
 * checkouts (#808, #812). In a repo created with `git init --separate-git-dir`,
 * and in a submodule, `git worktree list` names the git directory instead of
 * the main checkout, so a pull in a linked worktree used to drop the main
 * checkout's directory and record. Its next pull then overwrote a rule the
 * member had edited there, without a word.
 *
 * The team remote is a local bare repo reached through a synthetic HTTPS URL
 * (`url.<path>.insteadOf` in the sandbox HOME), as in git-hook-new-worktree.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackDetachedProcesses } from '../helpers/detached-processes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const FAKE_URL = 'https://git.example.com/team/live-checkouts.git';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

interface Run {
  code: number | null;
  output: string;
}

// The git wrapper and the hook scripts are POSIX shell.
describe.skipIf(process.platform === 'win32')('live checkouts are probed, not inferred from the worktree list (#993)', () => {
  let sandbox: string;
  let home: string;
  let detached: ReturnType<typeof trackDetachedProcesses>;
  /** PATH for git before 2.36, set in beforeAll. */
  let oldGit: Record<string, string>;

  const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
    const base: NodeJS.ProcessEnv = {
      ...process.env,
      ...GIT_ENV,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      GIT_CONFIG_NOSYSTEM: '1',
      FORCE_COLOR: '0',
      ...extra,
    };
    delete base.CLAUDE_CONFIG_DIR;
    delete base.CODEX_HOME;
    base.NODE_OPTIONS = [base.NODE_OPTIONS, detached.nodeOptions].filter(Boolean).join(' ');
    return base;
  };
  const run = (command: string, args: string[], cwd: string, extra: Record<string, string> = {}): Run => {
    const r = spawnSync(command, args, { cwd, encoding: 'utf8', env: env(extra) });
    return { code: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const gitOk = (args: string[], cwd: string): string => {
    const r = run('git', args, cwd);
    if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.output}`);
    return r.output.trim();
  };
  const teamaiOk = (args: string[], cwd: string, extra: Record<string, string> = {}): string => {
    const r = run('node', [CLI, ...args], cwd, extra);
    expect(r.code, r.output).toBe(0);
    return r.output;
  };

  /** A committed git checkout at `dir` holding only a `.gitignore`. */
  const commitApp = (dir: string, initArgs: string[] = []): void => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.gitignore'), '.teamai/\n');
    gitOk(['init', '-q', '-b', 'main', ...initArgs], dir);
    gitOk(['add', '-A'], dir);
    gitOk(['commit', '-q', '-m', 'app'], dir);
  };

  /**
   * Initialize teamai (project scope, Claude) in the checkout `dir`, and wait
   * for the pulls it hands to detached processes.
   */
  const initTeamai = async (dir: string): Promise<void> => {
    teamaiOk(['init', FAKE_URL, '--scope', 'project', '--force', '--agent', 'claude'], dir);
    teamaiOk(['pull'], dir);
    await detached.waitForExit();
  };

  /** A business repo whose git directory lives outside it (`git init --separate-git-dir`). */
  const separateGitDirProject = async (name: string): Promise<string> => {
    const dir = path.join(sandbox, name);
    fs.mkdirSync(path.join(sandbox, `${name}-git`));
    commitApp(dir, [`--separate-git-dir=${path.join(sandbox, `${name}-git`, 'proj.git')}`]);
    await initTeamai(dir);
    return dir;
  };

  /**
   * `git worktree add`, whose post-checkout hook pulls in the new worktree.
   * The explicit pull makes sure a full sync ran there even where git runs no
   * hook; after the hook's pull it is the fast path.
   */
  const addWorktree = async (repo: string, name: string): Promise<string> => {
    const dir = path.join(sandbox, name);
    gitOk(['worktree', 'add', '-q', dir, '-b', name], repo);
    await detached.waitForExit();
    teamaiOk(['pull'], dir);
    await detached.waitForExit();
    expect(fs.existsSync(rule(dir)), `${dir} did not receive the team rule`).toBe(true);
    return dir;
  };

  /** The project data home (partition) `init` created for the checkout at `root`. */
  const partitionOf = (root: string): string => {
    const projectsDir = path.join(home, '.teamai', 'projects');
    const found = fs.readdirSync(projectsDir).map((d) => path.join(projectsDir, d)).find((d) => {
      const config = path.join(d, 'config.yaml');
      return fs.existsSync(config) && fs.readFileSync(config, 'utf8').includes(`projectRoot: ${root}`);
    });
    if (!found) throw new Error(`No project partition for ${root}`);
    return found;
  };
  /** A checkout's id: its directory under `<partition>/workspaces/`, and its records' key prefix (managedMcpWorkspaceId). */
  const workspaceId = (checkout: string): string => createHash('sha1').update(checkout).digest('hex').slice(0, 12);
  const workspaceDir = (partition: string, checkout: string): string =>
    path.join(partition, 'workspaces', workspaceId(checkout));
  const statePath = (partition: string): string => path.join(partition, 'state.json');
  /** The keys of the partition's per-checkout delivery records that belong to `checkout`. */
  const recordKeys = (partition: string, checkout: string): string[] => {
    const records = JSON.parse(fs.readFileSync(statePath(partition), 'utf8')).lastPullByWorkspace ?? {};
    return Object.keys(records).filter((key) => key === workspaceId(checkout) || key.startsWith(`${workspaceId(checkout)}-`));
  };
  /** What the checkout's directory and record look like to a full pull in another checkout. */
  const tracked = (partition: string, checkout: string) => ({
    directory: fs.existsSync(workspaceDir(partition, checkout)),
    record: recordKeys(partition, checkout).length > 0,
  });
  const KEPT = { directory: true, record: true };
  const DROPPED = { directory: false, record: false };

  const rule = (checkout: string): string => path.join(checkout, '.claude', 'rules', 'team-rule.md');

  /** Edit the delivered rule in `checkout`, then expect a forced full sync there to keep it and say so. */
  const expectEditKept = (checkout: string): void => {
    fs.appendFileSync(rule(checkout), 'member edit\n');
    const edited = fs.readFileSync(rule(checkout), 'utf8');
    const output = teamaiOk(['pull', '--force'], checkout);
    expect(output).toContain(`Kept ${rule(checkout)}: you changed it since teamai delivered it.`);
    expect(fs.readFileSync(rule(checkout), 'utf8')).toBe(edited);
  };

  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);

    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-live-checkouts-e2e-')));
    detached = trackDetachedProcesses(sandbox);
    home = path.join(sandbox, 'home');
    fs.mkdirSync(home);
    const remote = path.join(sandbox, 'team.git');
    const seed = path.join(sandbox, 'seed');
    const write = (rel: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(seed, rel)), { recursive: true });
      fs.writeFileSync(path.join(seed, rel), content);
    };
    write('teamai.yaml', `team: live-checkouts-e2e\nrepo: ${FAKE_URL}\nprovider: git\nreviewers: []\n`);
    write('skills/team-skill/SKILL.md', '---\nname: team-skill\ndescription: Team skill fixture\n---\n\n# Team skill\n');
    write('rules/team-rule.md', '# Team rule\n');
    gitOk(['init', '-q', '-b', 'main'], seed);
    gitOk(['add', '-A'], seed);
    gitOk(['commit', '-q', '-m', 'seed'], seed);
    gitOk(['clone', '-q', '--bare', seed, remote], sandbox);
    gitOk(['config', '--global', `url.${remote}.insteadOf`, FAKE_URL], sandbox);
    // `git submodule add` of a local path.
    gitOk(['config', '--global', 'protocol.file.allow', 'always'], sandbox);

    // A git that refuses `-z` on `worktree list`, as git before 2.36 does, and runs everything else.
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    const bin = path.join(sandbox, 'old-git-bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'git'), [
      '#!/bin/sh',
      'worktree=; list=; z=',
      'for arg in "$@"; do',
      '  case "$arg" in worktree) worktree=1 ;; list) list=1 ;; -z) z=1 ;; esac',
      'done',
      'if [ -n "$worktree" ] && [ -n "$list" ] && [ -n "$z" ]; then',
      '  echo "error: unknown switch \\`z\'" >&2',
      '  exit 129',
      'fi',
      `exec ${JSON.stringify(realGit)} "$@"`,
      '',
    ].join('\n'), { mode: 0o755 });
    oldGit = { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` };
  }, 60_000);

  afterAll(async () => {
    if (detached) await detached.waitForExit();
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  }, 65_000);

  describe('a --separate-git-dir repo', () => {
    let main: string;
    let partition: string;

    beforeAll(async () => {
      main = await separateGitDirProject('sep');
      partition = partitionOf(main);
    }, 60_000);

    it('keeps the main checkout\'s directory and record when a new worktree pulls, so its edited rule survives', async () => {
      const worktree = await addWorktree(main, 'sep-wt');

      expect(tracked(partition, main)).toEqual(KEPT);
      expect(tracked(partition, worktree)).toEqual(KEPT);
      expectEditKept(main);
    });

    it('still drops the directory and record of a removed worktree, and of one deleted without git', async () => {
      const removed = path.join(sandbox, 'sep-wt');
      const deleted = await addWorktree(main, 'sep-deleted');
      gitOk(['worktree', 'remove', '--force', removed], main);
      // Left for `git worktree prune`: git lists it as prunable.
      fs.rmSync(deleted, { recursive: true, force: true });
      expect(tracked(partition, removed)).toEqual(KEPT);
      expect(tracked(partition, deleted)).toEqual(KEPT);

      teamaiOk(['pull', '--force'], main);

      expect(tracked(partition, removed)).toEqual(DROPPED);
      expect(tracked(partition, deleted)).toEqual(DROPPED);
      expect(tracked(partition, main)).toEqual(KEPT);
    });

    it('keeps a removed worktree\'s directory without a root, since the worktree list does not name the main checkout', async () => {
      const removed = await addWorktree(main, 'sep-rootless');
      fs.rmSync(path.join(workspaceDir(partition, removed), 'root'));
      gitOk(['worktree', 'remove', '--force', removed], main);

      teamaiOk(['pull', '--force'], main);

      expect(tracked(partition, removed)).toEqual({ directory: true, record: false });
      expect(tracked(partition, main)).toEqual(KEPT);
    });

    it('keeps a record and directory an older teamai left without a root until their own checkout writes one', async () => {
      // As teamai 0.22 left them: no `root` in the main checkout's record or
      // directory, and a directory of a checkout long gone.
      const state = JSON.parse(fs.readFileSync(statePath(partition), 'utf8'));
      for (const record of Object.values(state.lastPullByWorkspace) as Array<{ root?: string }>) delete record.root;
      fs.writeFileSync(statePath(partition), JSON.stringify(state, null, 2));
      fs.rmSync(path.join(workspaceDir(partition, main), 'root'));
      const gone = path.join(partition, 'workspaces', 'aaaaaaaaaaaa');
      fs.mkdirSync(gone);
      fs.writeFileSync(path.join(gone, 'search-index.json'), '{}');

      const worktree = await addWorktree(main, 'sep-legacy');
      teamaiOk(['pull', '--force'], worktree);

      expect(tracked(partition, main)).toEqual(KEPT);
      expect(fs.existsSync(gone)).toBe(true);
      expectEditKept(main);
      // The main checkout's own pull wrote its root, and the long-gone directory stays.
      expect(fs.readFileSync(path.join(workspaceDir(partition, main), 'root'), 'utf8')).toBe(main);
      expect(fs.existsSync(gone)).toBe(true);
    });
  });

  it('judges a directory without a root by the worktree list, for checkouts reached through a symlink', async () => {
    // contribute, recall, viz, the MCP writers and the local agent create a
    // checkout's directory before its first full pull writes `root`. In a
    // plain repo `git worktree list` names every checkout, so it proves such a
    // directory's checkout live or gone.
    fs.mkdirSync(path.join(sandbox, 'link-target'));
    fs.symlinkSync(path.join(sandbox, 'link-target'), path.join(sandbox, 'link'));
    const viaLink = path.join(sandbox, 'link');
    const real = fs.realpathSync(viaLink);
    commitApp(path.join(viaLink, 'plain'));
    await initTeamai(path.join(viaLink, 'plain'));
    const main = path.join(real, 'plain');
    const partition = partitionOf(main);
    for (const name of ['plain-live', 'plain-removed']) {
      gitOk(['worktree', 'add', '-q', path.join(viaLink, name), '-b', name], path.join(viaLink, 'plain'));
      await detached.waitForExit();
      teamaiOk(['pull'], path.join(viaLink, name));
      await detached.waitForExit();
    }
    const live = path.join(real, 'plain-live');
    const removed = path.join(real, 'plain-removed');
    for (const checkout of [live, removed]) fs.rmSync(path.join(workspaceDir(partition, checkout), 'root'));
    gitOk(['worktree', 'remove', '--force', removed], main);

    teamaiOk(['pull', '--force'], path.join(viaLink, 'plain'));

    expect(tracked(partition, live)).toEqual(KEPT);
    expect(tracked(partition, removed)).toEqual(DROPPED);
    expect(tracked(partition, main)).toEqual(KEPT);
  });

  it('keeps a submodule\'s main checkout when its linked worktree pulls', async () => {
    const libSeed = path.join(sandbox, 'lib-seed');
    commitApp(libSeed);
    const libRemote = path.join(sandbox, 'lib.git');
    gitOk(['clone', '-q', '--bare', libSeed, libRemote], sandbox);
    const superRepo = path.join(sandbox, 'super');
    commitApp(superRepo);
    gitOk(['submodule', 'add', '-q', libRemote, 'lib'], superRepo);
    gitOk(['commit', '-q', '-m', 'lib'], superRepo);
    const lib = path.join(superRepo, 'lib');
    await initTeamai(lib);
    const partition = partitionOf(lib);

    const worktree = await addWorktree(lib, 'lib-wt');

    expect(tracked(partition, lib)).toEqual(KEPT);
    expect(tracked(partition, worktree)).toEqual(KEPT);
    expectEditKept(lib);
  });

  it('probes recorded roots when git has no `worktree list -z` (before 2.36)', async () => {
    const main = await separateGitDirProject('old-git');
    const partition = partitionOf(main);
    const live = await addWorktree(main, 'old-git-live');
    const removed = await addWorktree(main, 'old-git-removed');
    gitOk(['worktree', 'remove', '--force', removed], main);
    expect(run('git', ['worktree', 'list', '--porcelain', '-z'], main, oldGit).code).toBe(129);

    teamaiOk(['pull', '--force'], main, oldGit);
    teamaiOk(['pull', '--force'], live, oldGit);

    expect(tracked(partition, main)).toEqual(KEPT);
    expect(tracked(partition, live)).toEqual(KEPT);
    expect(tracked(partition, removed)).toEqual(DROPPED);
  });

  it('keeps the shared .git/info/exclude line while a sibling worktree\'s MCP config holds a resolved value, on git before 2.36', async () => {
    // Fresh paths, so the runner's retry does not trip over the first try's fixtures.
    const base = fs.mkdtempSync(path.join(sandbox, 'mcp-'));
    const name = path.basename(base);
    // A team whose one MCP server sends a value resolved from env.yaml.
    const url = `https://git.example.com/team/${name}.git`;
    const token = 'live-checkouts-token-7c2d';
    const seed = path.join(base, 'seed');
    const write = (rel: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(seed, rel)), { recursive: true });
      fs.writeFileSync(path.join(seed, rel), content);
    };
    write('teamai.yaml', `team: live-checkouts-mcp\nrepo: ${url}\nprovider: git\nreviewers: []\nsharing:\n  mcp:\n    autoApply: true\n`);
    write('rules/team-rule.md', '# Team rule\n');
    write('mcp/mcp.yaml', [
      'servers:', '  - name: secret-api', '    transport: http', '    url: https://api.example.com/mcp',
      '    headers:', '      Authorization: "Bearer ${LAB_TOKEN}"', '',
    ].join('\n'));
    write('env/env.yaml', `variables:\n  - key: LAB_TOKEN\n    value: "${token}"\n`);
    gitOk(['init', '-q', '-b', 'main'], seed);
    gitOk(['add', '-A'], seed);
    gitOk(['commit', '-q', '-m', 'seed'], seed);
    const remote = path.join(base, 'team.git');
    gitOk(['clone', '-q', '--bare', seed, remote], sandbox);
    gitOk(['config', '--global', `url.${remote}.insteadOf`, url], sandbox);

    const main = path.join(base, 'main');
    commitApp(main);
    teamaiOk(['init', url, '--scope', 'project', '--force', '--agent', 'claude'], main);
    teamaiOk(['pull'], main);
    await detached.waitForExit();
    const sibling = await addWorktree(main, `${name}/sibling`);
    const mcpJson = (checkout: string): string => fs.readFileSync(path.join(checkout, '.mcp.json'), 'utf8');
    const excludeLines = (): string[] => fs.readFileSync(path.join(main, '.git', 'info', 'exclude'), 'utf8').split('\n');
    /** What `git add -A` in the sibling would pick up of its MCP config. */
    const siblingStatus = (): string => gitOk(['status', '--porcelain', '--untracked-files=all', '--', '.mcp.json'], sibling);
    expect(mcpJson(sibling)).toContain(token);
    expect(excludeLines()).toContain('/.mcp.json');

    // The team drops the server; only the main checkout pulls that.
    write('mcp/mcp.yaml', 'servers: []\n');
    gitOk(['commit', '-q', '-am', 'drop secret-api'], seed);
    gitOk(['push', '-q', remote, 'main'], seed);

    teamaiOk(['pull', '--force'], main, oldGit);

    // The main checkout's config held only the team's server: the emptied file goes.
    expect(fs.existsSync(path.join(main, '.mcp.json'))).toBe(false);
    expect(mcpJson(sibling)).toContain(token);
    expect(excludeLines()).toContain('/.mcp.json');
    expect(siblingStatus()).toBe('');

    teamaiOk(['uninstall', '--force'], main, oldGit);

    // Uninstall reaches the sibling: it takes teamai's server out there before it drops the line.
    expect(mcpJson(sibling)).not.toContain(token);
    expect(excludeLines()).not.toContain('/.mcp.json');
  });
});
