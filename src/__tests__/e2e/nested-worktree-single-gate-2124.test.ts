/**
 * E2E: a nested git worktree that a CodeBuddy or Cursor session registers as a
 * second workspace of the same project must not double the team hooks in the
 * user-level settings (#2124).
 *
 * The background pull `hook-dispatch session-start` runs writes a gate per
 * registered workspace into `~/.codebuddy/settings.json`; the parent's gate
 * must exclude the nested worktree, or both prefixes match there and every
 * team hook fires twice.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { entriesUnder } from '@teamai/shared/entries-under';
import { waitForDetachedChildren } from '../helpers/detached-processes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const FAKE_URL = 'https://git.example.com/team/nested-workspace.git';

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

describe('a nested worktree registered as a workspace keeps user-level team hooks single (#2124)', () => {
  let sandbox: string;
  let home: string;
  let remote: string;
  let project: string;
  let worktree: string;

  const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
    const base: NodeJS.ProcessEnv = { ...process.env, ...GIT_ENV, HOME: home, USERPROFILE: home, FORCE_COLOR: '0', ...extra };
    delete base.CLAUDE_CONFIG_DIR;
    delete base.CODEX_HOME;
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
  const teamai = (args: string[], cwd: string, extra: Record<string, string> = {}): Run => run('node', [CLI, ...args], cwd, extra);

  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);

    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-nested-workspace-')));
    home = path.join(sandbox, 'home');
    remote = path.join(sandbox, 'team.git');
    const seed = path.join(sandbox, 'seed');
    fs.mkdirSync(home);
    const write = (rel: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(seed, rel)), { recursive: true });
      fs.writeFileSync(path.join(seed, rel), content);
    };
    write('teamai.yaml', `team: nested-ws-e2e\nrepo: ${FAKE_URL}\nprovider: git\nreviewers: []\nsharing:\n  hooks:\n    autoApply: true\n    requireTeamScripts: false\n`);
    write('hooks/hooks.yaml', 'hooks:\n  - id: startup-guard\n    description: Startup hook fixture\n    event: SessionStart\n    command: echo team-hook-v1\n');
    gitOk(['init', '-q', '-b', 'main'], seed);
    gitOk(['add', '-A'], seed);
    gitOk(['commit', '-q', '-m', 'seed'], seed);
    gitOk(['clone', '-q', '--bare', seed, remote], sandbox);
    gitOk(['config', '--global', `url.${remote}.insteadOf`, FAKE_URL], sandbox);

    project = path.join(sandbox, 'project');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, '.gitignore'), '.teamai/\nworktree/\n');
    gitOk(['init', '-q', '-b', 'main'], project);
    gitOk(['add', '-A'], project);
    gitOk(['commit', '-q', '-m', 'project'], project);
    const init = teamai(['init', FAKE_URL, '--scope', 'project', '--force', '--agent', 'codebuddy'], project);
    if (init.code !== 0) throw new Error(`teamai init failed: ${init.output}`);
    const pulled = teamai(['pull'], project);
    if (pulled.code !== 0) throw new Error(`teamai pull failed: ${pulled.output}`);

    worktree = path.join(project, 'worktree', 'feature-a');
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    gitOk(['worktree', 'add', '-q', worktree, '-b', 'feature-a'], project);
    fs.writeFileSync('/tmp/wb2124-sandbox.txt', sandbox);
  }, 60_000);

  afterAll(async () => {
    await waitForDetachedChildren();
    // keep sandbox for debugging
  });

  const codebuddySettings = (): string => path.join(home, '.codebuddy', 'settings.json');

  /** The gate commands the settings hold. */
  const gates = (): string[] => {
    const file = codebuddySettings();

    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> };
    const out: string[] = [];

    for (const entries of Object.values(parsed.hooks ?? {})) {
      for (const entry of entries ?? []) {
        for (const hook of entry.hooks ?? []) {
          const command = hook.command ?? '';

          if (command.includes('team-hook-v1')) out.push(command);
        }
      }
    }

    return out;
  };

  /** How many gates fire for a session whose `$PWD` is `dir` — the report's double-execution. */
  const firesFor = (dir: string): number => {
    let fired = 0;

    for (const gate of gates()) {
      const r = spawnSync('/bin/bash', ['-c', gate], { cwd: dir, encoding: 'utf8' });

      if (r.status === 0 && r.stdout.includes('team-hook-v1')) fired += 1;
    }

    return fired;
  };

  it('the worktree session registers a second workspace, not a second set of gates', async () => {
    // The session-start background pull the way a CodeBuddy session runs it:
    // hook-dispatch in the worktree cwd.
    const dispatched = teamai(['hook-dispatch', 'session-start', '--tool', 'codebuddy'], worktree);
    expect(dispatched.code, dispatched.output).toBe(0);

    // Give the detached background pull a moment to settle.
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const teamaiPull = teamai(['pull', '--silent'], worktree);
    expect(teamaiPull.code, teamaiPull.output).toBe(0);

    // Both the main checkout and the worktree prefix match a worktree cwd, so
    // an unexcluded parent gate plus the worktree's own gate double every hook.
    const settings = fs.readFileSync(codebuddySettings(), 'utf8');
    const projectGate = settings.includes(project);
    const worktreeGate = settings.includes(worktree);

    // The worktree is registered as a workspace of the same project.
    const projects = path.join(home, '.teamai', 'projects');
    const registeredRoots = entriesUnder(projects)
      .filter(({ relative }) => relative.endsWith('root'))
      .map(({ relative }) => fs.readFileSync(path.join(projects, relative), 'utf8').trim());
    expect(registeredRoots.some((r) => fs.realpathSync(r) === fs.realpathSync(worktree)), 'worktree registered as a workspace').toBe(true);

    // Exactly one gate may fire for any `$PWD` (#2124): the worktree session runs
    // each team hook once, and so does a session in the main checkout.
    expect(firesFor(worktree), `gates firing in the worktree (projectGate=${projectGate}, worktreeGate=${worktreeGate})`).toBe(1);
    expect(firesFor(project), 'gates firing in the main checkout').toBe(1);
  }, 120_000);
});
