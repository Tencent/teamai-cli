import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

vi.mock('../utils/git.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../utils/git.js')>(),
  resolveAnchors: vi.fn().mockResolvedValue(null),
  listWorktrees: vi.fn().mockResolvedValue([]),
}));

vi.mock('@teamai/shared/log', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), persist: vi.fn(), dim: vi.fn() },
}));

import { reconcileTeamHooksForConfig, releaseRemovedCheckoutHooks, teamHookHistory } from '../hooks.js';
import { resetWarnOnce } from '../utils/warn-once.js';
import { writeWorkspaceRoot } from '../utils/partition.js';
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

/** `text` matched literally in a regular expression. */
const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The version in the name of a hook folder, `<id>.<version>`, as a regular expression: one directory per command. */
const VERSION = '\\.[0-9a-f]{8}';

/** The folder delivered for hook `id` in `hooks`, a scope's `hooks/` directory: the one directory `<id>.<version>`. */
async function hookDir(hooks: string, id: string): Promise<string> {
  const names = (await fse.readdir(hooks)).filter((name) => new RegExp(`^${id}${VERSION}$`).test(name));
  expect(names).toHaveLength(1);

  return path.join(hooks, names[0] ?? '');
}

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
  it('is delivered to ~/.teamai/hooks/<id>.<version>/, and the tool runs its script from there', async () => {
    await write({ 'hooks/block-secrets/HOOK.yaml': BLOCK_SECRETS, 'hooks/block-secrets/scan.sh': 'echo scanning\n' });

    await reconcileTeamHooksForConfig(teamConfig, member());

    const delivered = await hookDir(path.join(home, '.teamai', 'hooks'), 'block-secrets');

    expect([await fse.readFile(path.join(delivered, 'scan.sh'), 'utf8'), await claudeCommands('PreToolUse')])
      .toEqual(['echo scanning\n', [expect.stringContaining(`bash "${forward(delivered)}/scan.sh"`)]]);
  });

  it('moves the entry to a new version when only a script of the folder changes, and removes the earlier one', async () => {
    await write({ 'hooks/block-secrets/HOOK.yaml': BLOCK_SECRETS, 'hooks/block-secrets/scan.sh': 'echo v1\n' });
    await reconcileTeamHooksForConfig(teamConfig, member());
    const before = await hookDir(path.join(home, '.teamai', 'hooks'), 'block-secrets');

    await write({ 'hooks/block-secrets/scan.sh': 'echo v2\n' });
    await reconcileTeamHooksForConfig(teamConfig, member());

    const delivered = await hookDir(path.join(home, '.teamai', 'hooks'), 'block-secrets');

    expect([delivered === before, await claudeCommands('PreToolUse'), await fse.readFile(path.join(delivered, 'scan.sh'), 'utf8')])
      .toEqual([false, [expect.stringContaining(`bash "${forward(delivered)}/scan.sh"`)], 'echo v2\n']);
  });

  it('keeps running the script a tool installed while its entry cannot be rewritten, when only that script changes', async () => {
    await write({ 'hooks/block-secrets/HOOK.yaml': BLOCK_SECRETS, 'hooks/block-secrets/scan.sh': 'echo v1\n' });
    await reconcileTeamHooksForConfig(teamConfig, member());
    const installed = await claudeCommands('PreToolUse');

    await write({ 'hooks/block-secrets/scan.sh': 'echo v2\n' });
    const settings = path.join(home, '.claude', 'settings.json');
    await fse.chmod(settings, 0o444);
    await reconcileTeamHooksForConfig(teamConfig, member()).finally(() => fse.chmod(settings, 0o644));
    const script = /bash "([^"]+)"/.exec(installed[0] ?? '')?.[1] ?? '';

    expect([await claudeCommands('PreToolUse'), await fse.readFile(script, 'utf8')]).toEqual([installed, 'echo v1\n']);
  });

  it('is removed, with its entry, once the team repo drops it', async () => {
    await write({ 'hooks/block-secrets/HOOK.yaml': BLOCK_SECRETS, 'hooks/block-secrets/scan.sh': 'echo v1\n' });
    await reconcileTeamHooksForConfig(teamConfig, member());

    await fse.remove(path.join(repo, 'hooks', 'block-secrets'));
    await reconcileTeamHooksForConfig(teamConfig, member());

    expect([await fse.readdir(path.join(home, '.teamai', 'hooks')), await claudeCommands('PreToolUse')]).toEqual([[], []]);
  });

  it('stays, once the team repo drops it, while a tool the member excluded keeps the entry that runs it', async () => {
    await write({ 'hooks/block-secrets/HOOK.yaml': BLOCK_SECRETS, 'hooks/block-secrets/scan.sh': 'echo v1\n' });
    await reconcileTeamHooksForConfig(teamConfig, member());
    const installed = await claudeCommands('PreToolUse');

    await fse.remove(path.join(repo, 'hooks', 'block-secrets'));
    await reconcileTeamHooksForConfig(teamConfig, { ...member(), disabledAgents: ['claude', 'tclaude'] });

    expect([await claudeCommands('PreToolUse'), await fse.readFile(path.join(await hookDir(path.join(home, '.teamai', 'hooks'), 'block-secrets'), 'scan.sh'), 'utf8')]).toEqual([installed, 'echo v1\n']);
  });

  it('keeps running the files of the command a tool installed while its entry cannot be rewritten for a new one', async () => {
    await write({ 'hooks/block-secrets/HOOK.yaml': BLOCK_SECRETS.replace('scan.sh"', 'scan.sh" --v1'), 'hooks/block-secrets/scan.sh': 'echo v1\n' });
    await reconcileTeamHooksForConfig(teamConfig, member());
    const installed = await claudeCommands('PreToolUse');

    await write({ 'hooks/block-secrets/HOOK.yaml': BLOCK_SECRETS.replace('scan.sh"', 'scan.sh" --v2'), 'hooks/block-secrets/scan.sh': 'echo v2\n' });
    const settings = path.join(home, '.claude', 'settings.json');
    await fse.chmod(settings, 0o444);
    await reconcileTeamHooksForConfig(teamConfig, member()).finally(() => fse.chmod(settings, 0o644));
    const script = /bash "([^"]+)" --v1/.exec(installed[0] ?? '')?.[1] ?? '';

    expect([await claudeCommands('PreToolUse'), await fse.readFile(script, 'utf8')]).toEqual([installed, 'echo v1\n']);
  });
});

describe('a team hook folder whose HOOK.yaml changes how a tool runs it, but not its command', () => {
  it('keeps the files of the timeout a tool installed while its entry cannot be rewritten for a new one', async () => {
    await write({ 'hooks/block-secrets/HOOK.yaml': BLOCK_SECRETS.replace('timeout: 15', 'timeout: 1'), 'hooks/block-secrets/scan.sh': 'echo fast\n' });
    await reconcileTeamHooksForConfig(teamConfig, member());
    const installed = await claudeCommands('PreToolUse');

    await write({ 'hooks/block-secrets/HOOK.yaml': BLOCK_SECRETS.replace('timeout: 15', 'timeout: 5'), 'hooks/block-secrets/scan.sh': 'sleep 2; echo slow\n' });
    const settings = path.join(home, '.claude', 'settings.json');
    await fse.chmod(settings, 0o444);
    await reconcileTeamHooksForConfig(teamConfig, member()).finally(() => fse.chmod(settings, 0o644));
    const script = /bash "([^"]+)"/.exec(installed[0] ?? '')?.[1] ?? '';

    expect([await claudeCommands('PreToolUse'), await fse.readFile(script, 'utf8')]).toEqual([installed, 'echo fast\n']);
  });
});

describe('a team hook folder in a workspace with a team repo, whose Claude Code entries sit in the main checkout', () => {
  it('keeps running the files of the command Claude Code installed while settings.local.json cannot be rewritten for a new one', async () => {
    const project = path.join(home, 'shop');
    const dataHome = path.join(home, '.teamai', 'projects', 'shop');
    const teamRepo = path.join(dataHome, 'repo');
    execFileSync('git', ['init', '-q', project]);
    await fse.ensureDir(path.join(project, '.claude'));
    const workspace: LocalConfig = {
      repo: { localPath: teamRepo, remote: 'acme/shop' }, username: 'tester', additionalRoles: [], scope: 'project', projectRoot: project, dataHome, enabledAgents: ['claude'],
    };
    const version = async (flag: string): Promise<void> => {
      await fse.outputFile(path.join(teamRepo, 'hooks', 'block-secrets', 'HOOK.yaml'), BLOCK_SECRETS.replace('scan.sh"', `scan.sh" ${flag}`));
      await fse.outputFile(path.join(teamRepo, 'hooks', 'block-secrets', 'scan.sh'), `echo ${flag}\n`);
    };
    const settings = path.join(project, '.claude', 'settings.local.json');
    const scripts = async (): Promise<string[]> => {
      const file: { hooks?: Record<string, Array<{ hooks: Array<{ command: string }> }>> } = await fse.readJson(settings);

      return (file.hooks?.PreToolUse ?? []).flatMap((entry) => entry.hooks.flatMap((hook) => [.../bash "([^"]+)" --v\d/.exec(hook.command) ?? []].slice(1)));
    };

    await version('--v1');
    await reconcileTeamHooksForConfig(teamConfig, workspace);
    const installed = await scripts();
    await version('--v2');
    await fse.chmod(settings, 0o444);
    await reconcileTeamHooksForConfig(teamConfig, workspace).finally(() => fse.chmod(settings, 0o644));

    expect([await scripts(), await Promise.all(installed.map((script) => fse.readFile(script, 'utf8')))]).toEqual([installed, ['echo --v1\n']]);
  });
});

describe('the team hook history', () => {
  it('holds every committed HOOK.yaml version, named after its directory and rendered with the current scope\'s path at any version', async () => {
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

    // teamai does not read the files of an earlier revision, so it compares what a tool holds with the version left out.
    expect(history.map((def) => [def.key, def.command]).sort())
      .toEqual([['audit', `bash "${dest}.<version>/v1.sh"`], ['audit', `bash "${dest}.<version>/v2.sh"`]]);
  });
});

describe('a team hook folder in a worktree in self mode', () => {
  let project: string;
  let team: string;
  let self: LocalConfig;

  beforeEach(async () => {
    project = path.join(home, 'shop');
    team = path.join(project, '.teamai');
    execFileSync('git', ['init', '-q', project]);
    await fse.ensureDir(path.join(project, '.claude'));
    await fse.outputFile(path.join(team, 'hooks', 'block-secrets', 'HOOK.yaml'), BLOCK_SECRETS);
    await fse.outputFile(path.join(team, 'hooks', 'block-secrets', 'scan.sh'), 'echo scanning\n');

    self = {
      repo: { kind: 'self', localPath: team, remote: 'acme/shop', businessRepoRoot: project },
      username: 'tester', additionalRoles: [], scope: 'project', projectRoot: project, enabledAgents: ['claude'],
    };
  });

  it('is kept out of git by its own exclude block, with sharing.gitExclude off too', async () => {
    const gitExcludeOff = { ...teamConfig, sharing: { gitExclude: false } } as unknown as TeamaiConfig;

    await reconcileTeamHooksForConfig(gitExcludeOff, self);

    const untracked = execFileSync('git', ['-C', project, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' });

    expect([await fse.readFile(path.join(project, '.git', 'info', 'exclude'), 'utf8'), untracked.includes('.teamai/delivered/')])
      .toEqual([expect.stringContaining('# [teamai:delivered-folders:start]\n/.teamai/delivered/\n# [teamai:delivered-folders:end]\n'), false]);
  });

  it('is delivered in the worktree\'s .teamai/delivered/, and Claude Code names it through $CLAUDE_PROJECT_DIR', async () => {
    await reconcileTeamHooksForConfig(teamConfig, self);

    const commands = [];

    for (const file of ['settings.json', 'settings.local.json']) {
      const settings: { hooks?: Record<string, Array<{ hooks: Array<{ command: string }> }>> } = await fse.readJson(path.join(project, '.claude', file)).catch(() => ({}));
      commands.push(...(settings.hooks?.PreToolUse ?? []).flatMap((entry) => entry.hooks.map((hook) => hook.command)));
    }

    expect([await fse.readFile(path.join(await hookDir(path.join(team, 'delivered', 'hooks'), 'block-secrets'), 'scan.sh'), 'utf8'), commands])
      .toEqual(['echo scanning\n', [expect.stringMatching(new RegExp(`bash "\\$CLAUDE_PROJECT_DIR/\\.teamai/delivered/hooks/block-secrets${VERSION}/scan\\.sh"`))]]);
  });
});

describe('a team hook folder in two worktrees of a repo in self mode, with a tool that keeps team hooks in HOME', () => {
  const LINT = 'description: Lint\nevent: Stop\ncommand: bash "${TEAMAI_HOOK_DIR}/lint.sh"\n';
  const zcodeTeam = { toolPaths: { zcode: { settings: '.zcode/cli/config.json' } } } as unknown as TeamaiConfig;
  let main: string;
  let feature: string;
  let dataHome: string;

  const checkout = (root: string): LocalConfig => ({
    repo: { kind: 'self', localPath: path.join(root, '.teamai'), remote: 'acme/shop', businessRepoRoot: root },
    username: 'tester', additionalRoles: [], scope: 'project', projectRoot: root, dataHome, enabledAgents: ['zcode'],
  });

  const git = (cwd: string, ...args: string[]): void => {
    execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { stdio: 'ignore' });
  };

  /** A pull of `root`: it records the checkout in the data home, takes back the hooks of removed checkouts, then reconciles the team hooks. */
  const pull = async (root: string): Promise<void> => {
    await writeWorkspaceRoot(dataHome, root);
    await releaseRemovedCheckoutHooks(zcodeTeam, checkout(root));
    await reconcileTeamHooksForConfig(zcodeTeam, checkout(root));
  };

  /** The commands of ZCode's Stop entries in HOME that run a delivered hook folder. */
  const zcodeFolderCommands = async (): Promise<string[]> => {
    const config: { hooks?: { events?: Record<string, Array<{ hooks: Array<{ args?: string[] }> }>> } } = await fse.readJson(path.join(home, '.zcode', 'cli', 'config.json'));
    const commands = (config.hooks?.events?.Stop ?? []).flatMap((entry) => entry.hooks.flatMap((hook) => hook.args?.slice(1) ?? []));

    return commands.filter((command) => command.includes('/.teamai/delivered/hooks/'));
  };

  beforeEach(async () => {
    main = path.join(home, 'shop');
    feature = path.join(home, 'feature-wt');
    dataHome = path.join(home, '.teamai', 'projects', 'shop');
    await fse.ensureDir(path.join(home, '.zcode', 'cli'));
    execFileSync('git', ['init', '-q', '-b', 'main', main]);
    await fse.outputFile(path.join(main, '.teamai', 'hooks', 'lint', 'HOOK.yaml'), LINT);
    await fse.outputFile(path.join(main, '.teamai', 'hooks', 'lint', 'lint.sh'), 'echo lint v1\n');
    git(main, 'add', '-A');
    git(main, 'commit', '-q', '-m', 'lint v1');
    git(main, 'worktree', 'add', '-q', '-b', 'feature', feature);
  });

  it('leaves no entry pointing into a worktree once it is removed, after the next pull of another one', async () => {
    await pull(main);
    await pull(feature);
    git(main, 'worktree', 'remove', '--force', feature);

    await pull(main);

    expect(await zcodeFolderCommands()).toEqual([expect.stringMatching(new RegExp(`bash "${literal(forward(main))}/\\.teamai/delivered/hooks/lint${VERSION}/lint\\.sh"`))]);
  });
});

describe('a hook folder of one id in two workspaces bound to different teams, with a tool that keeps team hooks in HOME', () => {
  const LINT = 'description: Lint\nevent: Stop\ncommand: bash "${TEAMAI_HOOK_DIR}/lint.sh"\n';
  const zcodeTeam = { toolPaths: { zcode: { settings: '.zcode/cli/config.json' } } } as unknown as TeamaiConfig;

  /** A project bound to the team `team`, whose `hooks/lint/lint.sh` prints `echo`. */
  const workspace = async (team: string, echo: string): Promise<LocalConfig> => {
    const projectRoot = await fse.realpath(home).then((real) => path.join(real, team));
    const dataHome = path.join(home, '.teamai', 'projects', team);
    const teamRepo = path.join(dataHome, 'repo');
    execFileSync('git', ['init', '-q', projectRoot]);
    await fse.outputFile(path.join(teamRepo, 'hooks', 'lint', 'HOOK.yaml'), LINT);
    await fse.outputFile(path.join(teamRepo, 'hooks', 'lint', 'lint.sh'), `echo ${echo}\n`);

    return { repo: { localPath: teamRepo, remote: `acme/${team}` }, username: 'tester', additionalRoles: [], scope: 'project', projectRoot, dataHome, enabledAgents: ['zcode'] };
  };

  /** What ZCode's `lint` entries in HOME print when a session in `cwd` stops: each runs where its gate matches. */
  const stopAt = async (cwd: string): Promise<string> => {
    const config: { hooks?: { events?: Record<string, Array<{ hooks: Array<{ args?: string[] }> }>> } } = await fse.readJson(path.join(home, '.zcode', 'cli', 'config.json'));
    const commands = (config.hooks?.events?.Stop ?? []).flatMap((entry) => entry.hooks.flatMap((hook) => hook.args?.slice(1) ?? []));

    // teamai's own Stop hook is left out: it would start the teamai on PATH.
    return commands.filter((command) => new RegExp(`/hooks/lint${VERSION}/lint\\.sh`).test(command))
      .map((command) => spawnSync('bash', ['-c', command], { cwd, encoding: 'utf8' }).stdout).join('');
  };

  it('runs, in each workspace, the script of its own team', async () => {
    await fse.ensureDir(path.join(home, '.zcode', 'cli'));
    const one = await workspace('one', 'lint from team one');
    const two = await workspace('two', 'lint from team two');

    await reconcileTeamHooksForConfig(zcodeTeam, one);
    await reconcileTeamHooksForConfig(zcodeTeam, two);

    expect([await stopAt(one.projectRoot ?? ''), await stopAt(two.projectRoot ?? '')]).toEqual(['lint from team one\n', 'lint from team two\n']);
  });
});

describe('a hook folder of one id in the user scope and in a workspace that inherits the user scope', () => {
  const LINT = 'description: Lint\nevent: Stop\ncommand: bash "${TEAMAI_HOOK_DIR}/lint.sh"\n';

  /** What Claude Code's `lint` entries print when a session in `cwd` stops: the user file's, then the project's. */
  const stopAt = async (cwd: string): Promise<string> => {
    const files = [path.join(home, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json')];
    const commands: string[] = [];

    for (const file of files) {
      const settings: { hooks?: Record<string, Array<{ hooks: Array<{ command: string }> }>> } = await fse.readJson(file).catch(() => ({}));
      commands.push(...(settings.hooks?.Stop ?? []).flatMap((entry) => entry.hooks.map((hook) => hook.command)));
    }

    // teamai's own Stop hook is left out: it would start the teamai on PATH.
    return commands.filter((command) => new RegExp(`/hooks/lint${VERSION}/lint\\.sh`).test(command))
      .map((command) => spawnSync('bash', ['-c', command], { cwd, encoding: 'utf8' }).stdout).join('');
  };

  it('runs the user scope\'s script from the user data home, and the workspace\'s from its own', async () => {
    await write({ 'hooks/lint/HOOK.yaml': LINT, 'hooks/lint/lint.sh': 'echo lint from the user scope\n' });
    // The user scope's entries come from a user-scope pull; a workspace pull delivers its own hooks only.
    await reconcileTeamHooksForConfig(teamConfig, member());

    const project = path.join(home, 'shop');
    const dataHome = path.join(home, '.teamai', 'projects', 'shop');
    const projectRepo = path.join(dataHome, 'repo');
    execFileSync('git', ['init', '-q', project]);
    await fse.ensureDir(path.join(project, '.claude'));
    await fse.outputFile(path.join(projectRepo, 'hooks', 'lint', 'HOOK.yaml'), LINT);
    await fse.outputFile(path.join(projectRepo, 'hooks', 'lint', 'lint.sh'), 'echo lint from the workspace\n');
    const workspace: LocalConfig = {
      repo: { localPath: projectRepo, remote: 'acme/shop' }, username: 'tester', additionalRoles: [],
      scope: 'project', projectRoot: project, dataHome, inheritUserScope: true, enabledAgents: ['claude'],
    };

    await reconcileTeamHooksForConfig(teamConfig, workspace, { auto: true, filterAgents: workspace.enabledAgents });

    expect(await stopAt(project)).toBe('lint from the user scope\nlint from the workspace\n');
  });
});

describe('an entry teamai wrote for an earlier version of a hook folder', () => {
  it.each(['', 'payments', 'research tools', '研发'])('is recognised from the team repo\'s history and replaced in namespace "%s", with no record of it left', async (namespace) => {
    const folder = ['hooks', namespace, 'lint'].filter(Boolean).join('/');
    const delivered = path.join(home, '.teamai', 'hooks', namespace);
    const localConfig = { ...member(), primaryRole: 'dev' };
    const git = (...args: string[]): void => {
      execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { stdio: 'ignore' });
    };
    const codexTeam = { toolPaths: { codex: { settings: '.codex/hooks.json' } } } as unknown as TeamaiConfig;
    const lintCommands = async (): Promise<string[]> => {
      const file: { hooks?: Record<string, Array<{ hooks: Array<{ command: string }> }>> } = await fse.readJson(path.join(home, '.codex', 'hooks.json'));

      return (file.hooks?.Stop ?? []).flatMap((entry) => entry.hooks.map((hook) => hook.command)).filter((command) => command.includes(`${forward(delivered)}/lint.`));
    };

    await fse.ensureDir(path.join(home, '.codex'));
    await fse.ensureDir(repo);
    git('init', '-q');
    await write({ 'manifest/roles.yaml': JSON.stringify({ version: 1, roles: [{ id: 'dev', resources: { knowledge: [], skills: [], hooks: namespace ? [namespace] : [] } }] }) });
    await write({ [`${folder}/HOOK.yaml`]: 'description: Lint\nevent: Stop\ncommand: bash "${TEAMAI_HOOK_DIR}/v1.sh"\n', [`${folder}/v1.sh`]: 'echo v1\n' });
    git('add', '-A');
    git('commit', '-q', '-m', 'v1');
    await reconcileTeamHooksForConfig(codexTeam, localConfig);
    // The record of what teamai wrote is lost, as after a manual cleanup of ~/.teamai.
    await fse.remove(path.join(home, '.teamai', 'managed-hooks.json'));

    await write({ [`${folder}/HOOK.yaml`]: 'description: Lint\nevent: Stop\ncommand: bash "${TEAMAI_HOOK_DIR}/v2.sh"\n', [`${folder}/v2.sh`]: 'echo v2\n' });
    git('add', '-A');
    git('commit', '-q', '-m', 'v2');
    await reconcileTeamHooksForConfig(codexTeam, localConfig);

    expect(await lintCommands()).toEqual([expect.stringContaining('/v2.sh"')]);
    expect(await lintCommands()).toEqual([`bash "${forward(await hookDir(delivered, 'lint'))}/v2.sh"`]);
  });
});
