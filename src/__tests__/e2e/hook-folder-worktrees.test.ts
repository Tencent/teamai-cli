/**
 * E2E (#1787): a self-mode repo's hook folder in two worktrees, with ZCode, which keeps a project's team hooks in HOME
 * behind a `$PWD` gate. Each worktree's entry runs the script its own branch delivered in its `.teamai/delivered/`,
 * and once a worktree is removed, the next pull of the other one, or `doctor --fix`, leaves no entry naming it.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { waitForDetachedChildren } from '../helpers/detached-processes.js';

const CLI = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));

const LINT = 'description: Lint\nevent: Stop\ncommand: bash "${TEAMAI_HOOK_DIR}/lint.sh"\n';

interface Repo {
  home: string;
  env: NodeJS.ProcessEnv;
  main: string;
  feature: string;
  teamai: (args: string[], cwd: string) => string;
  git: (cwd: string, ...args: string[]) => void;
}

const sandboxes: string[] = [];

/**
 * A business repo in self mode for ZCode, with a hook folder `lint` committed on main (`echo lint v1`), and a
 * worktree on branch `feature` that commits `echo lint v2`. Both checkouts are pulled.
 */
async function twoWorktrees(): Promise<Repo> {
  const sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-hook-folder-worktrees-')));
  sandboxes.push(sandbox);
  const home = path.join(sandbox, 'home');
  const main = path.join(sandbox, 'shop');
  const feature = path.join(sandbox, 'feature-wt');
  fs.mkdirSync(path.join(home, '.zcode', 'cli'), { recursive: true });
  fs.mkdirSync(main);

  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid', FORCE_COLOR: '0',
  };

  const git = (cwd: string, ...args: string[]): void => {
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    expect(result.status, `git ${args.join(' ')}: ${result.stdout}${result.stderr}`).toBe(0);
  };

  const teamai = (args: string[], cwd: string): string => {
    const result = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8', timeout: 60_000 });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, `teamai ${args.join(' ')}: ${output}`).toBe(0);
    expect(output).not.toContain('holds the lock');

    return output;
  };

  git(main, 'init', '-q', '-b', 'main');
  git(main, 'commit', '-q', '--allow-empty', '-m', 'shop');
  git(main, 'remote', 'add', 'origin', 'https://127.0.0.1:9/acme/shop.git');
  teamai(['init', '.', '--provider', 'git', '--agent', 'zcode', '--force'], main);

  const teamFile = path.join(main, '.teamai', 'teamai.yaml');
  const team = YAML.parse(fs.readFileSync(teamFile, 'utf8'));
  team.sharing = { ...team.sharing, hooks: { requireTeamScripts: false, autoApply: true } };
  fs.writeFileSync(teamFile, YAML.stringify(team));
  fs.mkdirSync(path.join(main, '.teamai', 'hooks', 'lint'), { recursive: true });
  fs.writeFileSync(path.join(main, '.teamai', 'hooks', 'lint', 'HOOK.yaml'), LINT);
  fs.writeFileSync(path.join(main, '.teamai', 'hooks', 'lint', 'lint.sh'), 'echo lint v1\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'lint v1');
  teamai(['pull'], main);

  git(main, 'worktree', 'add', '-q', '-b', 'feature', feature);
  // The worktree's post-checkout hook pulls into it in the background.
  await waitForDetachedChildren();
  fs.writeFileSync(path.join(feature, '.teamai', 'hooks', 'lint', 'lint.sh'), 'echo lint v2\n');
  git(feature, 'commit', '-q', '-am', 'lint v2');
  teamai(['pull'], feature);

  return { home, env, main, feature, teamai, git };
}

/** The commands of ZCode's Stop entries in HOME that run a delivered hook folder. */
function folderCommands(repo: Repo): string[] {
  const config: { hooks?: { events?: Record<string, Array<{ hooks: Array<{ args?: string[] }> }>> } } = JSON.parse(fs.readFileSync(path.join(repo.home, '.zcode', 'cli', 'config.json'), 'utf8'));
  const commands = (config.hooks?.events?.Stop ?? []).flatMap((entry) => entry.hooks.flatMap((hook) => hook.args?.slice(1) ?? []));

  return commands.filter((command) => command.includes('/.teamai/delivered/hooks/'));
}

/** What ZCode's folder entries print when a session in `cwd` stops: each runs where its gate matches. */
function runAt(repo: Repo, cwd: string): string {
  return folderCommands(repo).map((command) => spawnSync('bash', ['-c', command], { cwd, encoding: 'utf8' }).stdout).join('');
}

describe('a hook folder in two worktrees of a repo in self mode, with ZCode', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
  });

  afterEach(async () => {
    await waitForDetachedChildren();
    for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('runs, in each worktree, the script of its own branch', async () => {
    const repo = await twoWorktrees();

    expect([runAt(repo, repo.main), runAt(repo, repo.feature)]).toEqual(['lint v1\n', 'lint v2\n']);
  }, 120_000);

  it('leaves no entry naming a removed worktree after a full pull of the other one', async () => {
    const repo = await twoWorktrees();
    repo.git(repo.main, 'worktree', 'remove', '--force', repo.feature);
    fs.writeFileSync(path.join(repo.main, '.teamai', 'hooks', 'lint', 'lint.sh'), 'echo lint v3\n');
    repo.git(repo.main, 'commit', '-q', '-am', 'lint v3');

    const pulled = repo.teamai(['pull'], repo.main);

    expect([pulled.includes('Already synced'), folderCommands(repo).filter((command) => command.includes(repo.feature)), runAt(repo, repo.main)])
      .toEqual([false, [], 'lint v3\n']);
  }, 120_000);

  it('leaves no entry naming a removed worktree after doctor --fix', async () => {
    const repo = await twoWorktrees();
    repo.git(repo.main, 'worktree', 'remove', '--force', repo.feature);

    // Doctor exits non-zero for the checks this sandbox fails (no origin to reach), so only its effect is checked.
    spawnSync(process.execPath, [CLI, 'doctor', '--fix'], { cwd: repo.main, env: repo.env, encoding: 'utf8', timeout: 60_000 });

    expect([folderCommands(repo).filter((command) => command.includes(repo.feature)), runAt(repo, repo.main)]).toEqual([[], 'lint v1\n']);
  }, 120_000);
});
