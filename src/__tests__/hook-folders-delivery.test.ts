import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

vi.mock('../utils/git.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../utils/git.js')>(),
  resolveAnchors: vi.fn().mockResolvedValue(null),
  listWorktrees: vi.fn().mockResolvedValue([]),
}));

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), persist: vi.fn(), dim: vi.fn() },
}));

import { reconcileTeamHooksForConfig, teamHookHistory } from '../hooks.js';
import { resetWarnOnce } from '../utils/warn-once.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

// A team hook folder is delivered to the data home of the scope that owns it,
// and the tool's entry runs the script from there (#1787).

let home: string;
let repo: string;

const teamConfig = { toolPaths: { claude: { settings: '.claude/settings.json' } } } as unknown as TeamaiConfig;

const BLOCK_SECRETS = [
  'description: Scan for secrets before a commit',
  'event: PreToolUse',
  'matcher: Bash',
  'command: bash "${TEAMAI_HOOK_DIR}/scan.sh"',
  'timeout: 15',
  '',
].join('\n');

function member(): LocalConfig {
  return { repo: { localPath: repo, remote: 'acme/team' }, username: 'tester', scope: 'user', additionalRoles: [] };
}

async function write(files: Record<string, string>): Promise<void> {
  for (const [file, content] of Object.entries(files)) await fse.outputFile(path.join(repo, ...file.split('/')), content);
}

/** The commands of Claude Code's `event` entries in HOME. */
async function claudeCommands(event: string): Promise<string[]> {
  const settings: { hooks?: Record<string, Array<{ hooks: Array<{ command: string }> }>> } = await fse.readJson(path.join(home, '.claude', 'settings.json'));

  return (settings.hooks?.[event] ?? []).flatMap((entry) => entry.hooks.map((hook) => hook.command));
}

const forward = (dir: string): string => dir.split(path.sep).join('/');

beforeEach(async () => {
  home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-hook-delivery-home-'));
  repo = path.join(home, '.teamai', 'repo');
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  await fse.ensureDir(path.join(home, '.claude'));
  resetWarnOnce();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fse.remove(home);
});

describe('a team hook folder in the user scope', () => {
  it('is delivered to ~/.teamai/hooks/<id>/, and the tool runs its script from there', async () => {
    await write({ 'hooks/block-secrets/HOOK.yaml': BLOCK_SECRETS, 'hooks/block-secrets/scan.sh': 'echo scanning\n' });

    await reconcileTeamHooksForConfig(teamConfig, member());

    const delivered = path.join(home, '.teamai', 'hooks', 'block-secrets');

    expect([await fse.readFile(path.join(delivered, 'scan.sh'), 'utf8'), await claudeCommands('PreToolUse')])
      .toEqual(['echo scanning\n', [expect.stringContaining(`bash "${forward(delivered)}/scan.sh"`)]]);
  });

  it('keeps one entry with the same command when the folder changes, and runs the new version', async () => {
    await write({ 'hooks/block-secrets/HOOK.yaml': BLOCK_SECRETS, 'hooks/block-secrets/scan.sh': 'echo v1\n' });
    await reconcileTeamHooksForConfig(teamConfig, member());
    const before = await claudeCommands('PreToolUse');

    await write({ 'hooks/block-secrets/HOOK.yaml': BLOCK_SECRETS.replace('timeout: 15', 'timeout: 20'), 'hooks/block-secrets/scan.sh': 'echo v2\n' });
    await reconcileTeamHooksForConfig(teamConfig, member());

    const delivered = path.join(home, '.teamai', 'hooks', 'block-secrets');

    expect([await claudeCommands('PreToolUse'), await fse.readFile(path.join(delivered, 'scan.sh'), 'utf8')]).toEqual([before, 'echo v2\n']);
  });

  it('is removed, with its entry, once the team repo drops it', async () => {
    await write({ 'hooks/block-secrets/HOOK.yaml': BLOCK_SECRETS, 'hooks/block-secrets/scan.sh': 'echo v1\n' });
    await reconcileTeamHooksForConfig(teamConfig, member());

    await fse.remove(path.join(repo, 'hooks', 'block-secrets'));
    await reconcileTeamHooksForConfig(teamConfig, member());

    expect([await fse.pathExists(path.join(home, '.teamai', 'hooks', 'block-secrets')), await claudeCommands('PreToolUse')]).toEqual([false, []]);
  });
});

describe('the team hook history', () => {
  it('holds every committed HOOK.yaml version, named after its directory and rendered with the current scope\'s path', async () => {
    const git = (...args: string[]): void => {
      execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { stdio: 'ignore' });
    };

    await fse.ensureDir(repo);
    git('init', '-q');
    await write({ 'hooks/payments/audit/HOOK.yaml': 'description: Audit\nevent: Stop\ncommand: bash "${TEAMAI_HOOK_DIR}/v1.sh"\n' });
    git('add', '-A');
    git('commit', '-q', '-m', 'v1');
    await write({ 'hooks/payments/audit/HOOK.yaml': 'description: Audit\nevent: Stop\ncommand: bash "${TEAMAI_HOOK_DIR}/v2.sh"\n' });
    git('commit', '-q', '-am', 'v2');

    const dest = forward(path.join(home, '.teamai', 'hooks', 'payments', 'audit'));
    const history = await teamHookHistory(member())();

    expect(history.map((def) => [def.key, def.command]).sort()).toEqual([['audit', `bash "${dest}/v1.sh"`], ['audit', `bash "${dest}/v2.sh"`]]);
  });
});

describe('a team hook folder in a single-repo worktree', () => {
  it('is delivered in the worktree\'s .teamai/delivered/, and Claude Code names it through $CLAUDE_PROJECT_DIR', async () => {
    const project = path.join(home, 'shop');
    const team = path.join(project, '.teamai');
    execFileSync('git', ['init', '-q', project]);
    await fse.ensureDir(path.join(project, '.claude'));
    await fse.outputFile(path.join(team, 'hooks', 'block-secrets', 'HOOK.yaml'), BLOCK_SECRETS);
    await fse.outputFile(path.join(team, 'hooks', 'block-secrets', 'scan.sh'), 'echo scanning\n');

    const self: LocalConfig = {
      repo: { kind: 'self', localPath: team, remote: 'acme/shop', businessRepoRoot: project },
      username: 'tester', additionalRoles: [], scope: 'project', projectRoot: project, enabledAgents: ['claude'],
    };

    await reconcileTeamHooksForConfig(teamConfig, self);

    const commands = [];

    for (const file of ['settings.json', 'settings.local.json']) {
      const settings: { hooks?: Record<string, Array<{ hooks: Array<{ command: string }> }>> } = await fse.readJson(path.join(project, '.claude', file)).catch(() => ({}));
      commands.push(...(settings.hooks?.PreToolUse ?? []).flatMap((entry) => entry.hooks.map((hook) => hook.command)));
    }

    expect([await fse.readFile(path.join(team, 'delivered', 'hooks', 'block-secrets', 'scan.sh'), 'utf8'), commands])
      .toEqual(['echo scanning\n', [expect.stringContaining('bash "$CLAUDE_PROJECT_DIR/.teamai/delivered/hooks/block-secrets/scan.sh"')]]);
  });
});
