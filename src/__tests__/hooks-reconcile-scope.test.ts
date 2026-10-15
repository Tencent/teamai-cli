import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import YAML from 'yaml';

vi.mock('../utils/git.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../utils/git.js')>(),
  resolveAnchors: vi.fn().mockResolvedValue(null),
  listWorktrees: vi.fn().mockResolvedValue([]),
}));

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), persist: vi.fn() },
}));

import { resolveAnchors, listWorktrees } from '../utils/git.js';
import { resetBundledRuntimeCache } from '../bundled-runtime.js';
import { findOnPath } from '../utils/lookpath.js';
import { execFileSync, spawn } from 'node:child_process';
import { claudeHookOtherHostSkip, reconcileHooks, reconcileHooksToAllTools, reconcileTeamHooksForConfig } from '../hooks.js';
import * as gitHook from '../git-hook.js';
import { readWorkspaceChildren } from '../workspace-children.js';
import { dispatchedCodexHooks } from '../codex-team-hooks.js';
import type { HookDef, LocalConfig, TeamaiConfig } from '../types.js';

let project: string;
let repo: string;
let home: string;

const teamConfig = {
  toolPaths: {
    claude: { settings: '.claude/settings.json' },
    cursor: { settings: '.cursor/hooks.json' },
    codex: { settings: '.codex/hooks.json' },
  },
} as unknown as TeamaiConfig;

function localConfig(): LocalConfig {
  return {
    repo: { localPath: repo, remote: 'x' },
    username: 'u',
    scope: 'project',
    projectRoot: project,
    additionalRoles: [],
  } as unknown as LocalConfig;
}

async function writeYaml(content: string): Promise<void> {
  await fse.ensureDir(path.join(repo, 'hooks'));
  await fse.writeFile(path.join(repo, 'hooks', 'hooks.yaml'), content);
}
// Non-self project scope injects into HOME (#264 / the init↔inject unification):
// ~/.claude always exists so the "installed tool" gate passes, and the dispatch
// runtime resolves the active project by cwd — so settings live under HOME, not
// <projectRoot>. These readers therefore all read from `home`.
function claudeSettings(): Promise<{ hooks: Record<string, Array<{ description?: string; hooks: Array<{ command: string }> }>> }> {
  return fse.readJson(path.join(home, '.claude', 'settings.json'));
}
function cursorSettings(): Promise<{ hooks: Record<string, Array<{ command: string }>> }> {
  return fse.readJson(path.join(home, '.cursor', 'hooks.json'));
}
function codexSettings(): Promise<{ hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string; timeout?: number }> }>> }> {
  return fse.readJson(path.join(home, '.codex', 'hooks.json'));
}
function manifest(): Promise<Record<string, Array<{ id: string }>>> {
  return fse.readJson(path.join(home, '.teamai', 'managed-hooks.json'));
}
// Claude and Codex keep a non-self project's team hooks in the main checkout
// (#955), ungated; the project here is not a git repo, so it is its own main
// checkout, and with no partition its data home is <project>/.teamai.
function claudeLocal(): Promise<{ hooks: Record<string, Array<{ description?: string; hooks: Array<{ command: string }> }>> }> {
  return fse.readJson(path.join(project, '.claude', 'settings.local.json'));
}
function codexProject(): Promise<{ hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string; timeout?: number }> }>> }> {
  return fse.readJson(path.join(project, '.codex', 'hooks.json'));
}
function mainManifest(): Promise<Record<string, Array<{ id: string }>>> {
  return fse.readJson(path.join(project, '.teamai', 'managed-main-checkout-hooks.json'));
}

beforeEach(async () => {
  vi.mocked(resolveAnchors).mockReset().mockResolvedValue(null);
  vi.mocked(listWorktrees).mockReset().mockResolvedValue([]);
  project = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-recon-proj-'));
  repo = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-recon-repo-'));
  home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-recon-home-'));
  // Point HOME at the sandbox so the non-self project scope resolves its hook
  // base dir to this dir rather than the developer's real home.
  vi.stubEnv('HOME', home);
  // Pre-create the tool root dirs under HOME so they are detected as installed.
  await fse.ensureDir(path.join(home, '.claude'));
  await fse.ensureDir(path.join(home, '.cursor'));
  await fse.ensureDir(path.join(home, '.codex'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fse.remove(project);
  await fse.remove(repo);
  await fse.remove(home);
});

describe('reconcileTeamHooksForConfig — pull/init core path', () => {
  it('propagates Git-hook installation failure instead of reporting a successful reconcile', async () => {
    const spy = vi.spyOn(gitHook, 'installGitHook').mockRejectedValueOnce(new Error('EACCES: hooks directory'));
    try {
      await expect(reconcileTeamHooksForConfig(teamConfig, localConfig())).rejects.toThrow('EACCES: hooks directory');
    } finally {
      spy.mockRestore();
    }
  });
  it('still installs the agent hooks when the Git hook cannot be installed', async () => {
    const spy = vi.spyOn(gitHook, 'installGitHook').mockRejectedValueOnce(new Error('EACCES: hooks directory'));
    try {
      await expect(reconcileTeamHooksForConfig(teamConfig, localConfig())).rejects.toThrow(/teamai git hook/);
      expect((await claudeSettings()).hooks.SessionStart).toHaveLength(1);
      expect((await codexSettings()).hooks.SessionStart).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
  it('injects built-in + team hooks into each tool, records the manifest', async () => {
    await writeYaml(`
hooks:
  - id: lint
    description: run lint at stop
    event: Stop
    command: npm run lint
    timeout: 20
`);
    const reconciled = await reconcileTeamHooksForConfig(teamConfig, localConfig());
    expect(reconciled.ok && reconciled.defs).toHaveLength(1);

    // Claude and Codex: built-ins in HOME, the team hook in the main checkout, ungated.
    const claude = await claudeSettings();
    expect(claude.hooks.Stop).toHaveLength(1);
    expect(claude.hooks.Stop[0].description?.startsWith('[teamai] ')).toBe(true);
    const claudeTeam = await claudeLocal();
    expect(claudeTeam.hooks.Stop).toHaveLength(1);
    expect(claudeTeam.hooks.Stop[0].description).toBe('[teamai:hook:lint] run lint at stop');
    expect(claudeTeam.hooks.Stop[0].hooks[0].command).toBe(`${claudeHookOtherHostSkip('Stop', undefined, 'npm run lint')}npm run lint`);
    expect(claudeTeam.hooks.SessionStart).toBeUndefined();

    // Every other tool: built-in + gated team hook in HOME.
    const cursor = await cursorSettings();
    expect(cursor.hooks.stop).toHaveLength(2);
    expect(cursor.hooks.stop.some((h) => h.command.includes('npm run lint'))).toBe(true);

    const codex = await codexSettings();
    expect(codex.hooks.Stop).toHaveLength(1);
    expect(codex.hooks.Stop.some((h) => h.hooks[0].command.includes('npm run lint'))).toBe(false);
    expect((await codexProject()).hooks.Stop.map((h) => h.hooks[0].command)).toEqual(['npm run lint']);

    const m = await manifest();
    expect(m.cursor.map((r) => r.id)).toEqual(['lint']);
    expect(m.claude).toBeUndefined();
    expect(m.codex).toBeUndefined();
    const main = await mainManifest();
    expect(main.claude.map((r) => r.id)).toEqual(['lint']);
    expect(main.codex.map((r) => r.id)).toEqual(['lint']);
  });

  it('keeps project team hooks isolated when projects share HOME', async () => {
    await writeYaml(`
hooks:
  - id: project-a
    description: project a
    event: Stop
    command: echo project-a
`);
    await reconcileTeamHooksForConfig(teamConfig, localConfig());

    const projectB = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-recon-proj-b-'));
    const repoB = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-recon-repo-b-'));
    try {
      await fse.ensureDir(path.join(repoB, 'hooks'));
      await fse.writeFile(path.join(repoB, 'hooks', 'hooks.yaml'), `
hooks:
  - id: project-b
    description: project b
    event: Stop
    command: echo project-b
`);
      const configB = {
        repo: { localPath: repoB, remote: 'x' }, username: 'b', scope: 'project',
        projectRoot: projectB, additionalRoles: [],
      } as unknown as LocalConfig;
      await fse.ensureDir(path.join(projectB, '.claude'));
      await reconcileTeamHooksForConfig(teamConfig, configB);

      const cursor = await cursorSettings();
      const teamCommands = cursor.hooks.stop
        .map((entry) => entry.command)
        .filter((command) => command.includes('echo project-'));
      expect(teamCommands).toHaveLength(2);
      const [rootA, rootB] = [await fse.realpath(project), await fse.realpath(projectB)];
      expect(teamCommands.some((command) => command.includes('echo project-a') && command.includes(rootA))).toBe(true);
      expect(teamCommands.some((command) => command.includes('echo project-b') && command.includes(rootB))).toBe(true);

      const m = await manifest();
      expect(m.cursor).toHaveLength(2);

      // Claude's team hooks live in each project's own checkout.
      expect((await claudeLocal()).hooks.Stop.map((e) => e.hooks[0].command)).toEqual([`${claudeHookOtherHostSkip('Stop', undefined, 'echo project-a')}echo project-a`]);
      const claudeB = await fse.readJson(path.join(projectB, '.claude', 'settings.local.json'));
      expect(claudeB.hooks.Stop.map((e: { hooks: Array<{ command: string }> }) => e.hooks[0].command)).toEqual([`${claudeHookOtherHostSkip('Stop', undefined, 'echo project-b')}echo project-b`]);
    } finally {
      await fse.remove(projectB);
      await fse.remove(repoB);
    }
  });

  it('gates a workspace\'s team hooks for other tools to the workspace without its children (#913)', async () => {
    await writeYaml(`
hooks:
  - id: ws-hook
    description: workspace hook
    event: Stop
    command: echo ws-hook-ran
`);
    const root = await fse.realpath(project);
    const child = path.join(root, 'svc-a');
    await fse.ensureDir(path.join(child, 'src'));
    await fse.ensureDir(path.join(root, 'notes'));
    await reconcileTeamHooksForConfig(teamConfig, {
      ...localConfig(),
      children: {
        children: [{ path: 'svc-a', root: child, anchor: path.join(home, 'svc-a'), selection: { additionalRoles: [], projects: [] } }],
        leftOut: [],
        roots: [child],
        fingerprint: 'f',
      },
    });

    const [command] = (await cursorSettings()).hooks.stop.map((entry) => entry.command).filter((c) => c.includes('ws-hook-ran'));
    const runIn = (cwd: string): string => execFileSync('sh', ['-c', command!], { cwd, encoding: 'utf8' });
    expect(runIn(root)).toBe('ws-hook-ran\n');
    expect(runIn(path.join(root, 'notes'))).toBe('ws-hook-ran\n');
    expect(runIn(child)).toBe('');
    expect(runIn(path.join(child, 'src'))).toBe('');
  });

  it('records a workspace\'s Cursor hook as written, and keeps one copy gated out of a child added later (#913)', async () => {
    await writeYaml(`
hooks:
  - id: ws-hook
    description: workspace hook
    event: Stop
    command: echo ws-hook-ran
`);
    const root = await fse.realpath(project);
    const [svcA, svcB] = [path.join(root, 'svc-a'), path.join(root, 'svc-b')];
    await Promise.all([svcA, svcB].map((dir) => fse.ensureDir(dir)));
    const withChildren = (roots: string[]): LocalConfig => ({
      ...localConfig(),
      children: {
        children: roots.map((dir) => ({ path: path.basename(dir), root: dir, anchor: path.join(home, path.basename(dir)), selection: { additionalRoles: [], projects: [] } })),
        leftOut: [],
        roots,
        fingerprint: roots.join(','),
      },
    });
    const written = async (): Promise<string[]> =>
      (await cursorSettings()).hooks.stop.map((entry) => entry.command).filter((c) => c.includes('ws-hook-ran'));
    const recorded = async (): Promise<string[]> =>
      ((await manifest()).cursor as unknown as Array<{ command: string }>).map((r) => r.command).filter((c) => c.includes('ws-hook-ran'));

    await reconcileTeamHooksForConfig(teamConfig, withChildren([svcA]));
    expect(await recorded()).toEqual(await written());

    await reconcileTeamHooksForConfig(teamConfig, withChildren([svcA, svcB]));

    const commands = await written();
    expect(commands).toHaveLength(1);
    expect(await recorded()).toEqual(commands);
    const runIn = (cwd: string): string => execFileSync('sh', ['-c', commands[0]!], { cwd, encoding: 'utf8', env: { ...process.env, PWD: cwd } });
    expect(runIn(root)).toBe('ws-hook-ran\n');
    expect(runIn(svcB)).toBe('');
  });

  it('gates a workspace\'s team hooks out of every checkout of a child and out of a child it leaves out (#913)', async () => {
    await writeYaml(`
hooks:
  - id: ws-hook
    description: workspace hook
    event: Stop
    command: echo ws-hook-ran
`);
    const root = await fse.realpath(project);
    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
    const { projectDataHome } = await import('../utils/partition.js');
    const setUp = async (dir: string, remote: string): Promise<void> => {
      await fse.ensureDir(dir);
      execFileSync('git', ['init', '-q'], { cwd: dir });
      execFileSync('git', ['commit', '--allow-empty', '-qm', 'init'], { cwd: dir, env: gitEnv });
      await fse.outputFile(path.join(projectDataHome(dir), 'config.yaml'), `scope: workspace\nusername: u\nrepo:\n  remote: ${remote}\n  localPath: ${repo}\n`);
    };
    const child = path.join(root, 'svc-a');
    const worktree = path.join(root, 'svc-a-feature');
    const other = path.join(root, 'other-team');
    await setUp(child, 'x');
    execFileSync('git', ['worktree', 'add', '-q', worktree], { cwd: child, env: gitEnv });
    await setUp(other, 'https://git.example.com/other/team.git');
    const { readWorkspaceChildren } = await import('../workspace-children.js');
    const configured = await readWorkspaceChildren({ ...localConfig(), dataHome: path.join(project, '.teamai') });
    expect(configured.children?.children.map((found) => found.path)).toEqual(['svc-a']);

    await reconcileTeamHooksForConfig(teamConfig, configured);

    const [command] = (await cursorSettings()).hooks.stop.map((entry) => entry.command).filter((c) => c.includes('ws-hook-ran'));
    const runIn = (cwd: string): string => execFileSync('sh', ['-c', command!], { cwd, encoding: 'utf8' });
    expect(runIn(root)).toBe('ws-hook-ran\n');
    expect(runIn(child)).toBe('');
    expect(runIn(worktree)).toBe('');
    expect(runIn(other)).toBe('');
  });

  it('applies hooks.yaml edits on the next reconcile (add/remove), built-in untouched', async () => {
    await writeYaml(`
hooks:
  - id: lint
    description: lint
    event: Stop
    command: npm run lint
`);
    await reconcileTeamHooksForConfig(teamConfig, localConfig());

    // Remove the team hook from the yaml and reconcile again.
    await writeYaml('hooks: []');
    await reconcileTeamHooksForConfig(teamConfig, localConfig());

    const claude = await claudeSettings();
    expect(claude.hooks.Stop).toHaveLength(1); // built-in only
    expect(claude.hooks.Stop[0].description?.startsWith('[teamai] ')).toBe(true);

    const cursor = await cursorSettings();
    expect(cursor.hooks.stop.some((h) => h.command === 'npm run lint')).toBe(false);
    expect(cursor.hooks.stop).toHaveLength(1);

    const codex = await codexSettings();
    expect(codex.hooks.Stop.some((h) => h.hooks[0].command === 'npm run lint')).toBe(false);
    expect(codex.hooks.Stop).toHaveLength(1);
    expect((await claudeLocal()).hooks.Stop).toEqual([]);
    expect((await codexProject()).hooks.Stop).toEqual([]);

    const m = await manifest();
    expect(m.claude).toBeUndefined();
    expect(m.cursor).toBeUndefined();
    expect(m.codex).toBeUndefined();
    expect(await mainManifest()).toEqual({});
  });

  it('a role switch removes the previous role\'s hooks and adds the new role\'s, built-in untouched', async () => {
    await fse.ensureDir(path.join(repo, 'manifest'));
    await fse.writeFile(path.join(repo, 'manifest', 'roles.yaml'), `
version: 1
roles:
  - id: frontend
    description: Frontend
    resources: { knowledge: [common], skills: [common] }
  - id: devops
    description: DevOps
    resources: { knowledge: [common], skills: [common] }
`);
    await writeYaml(`
hooks:
  - id: stylelint
    description: frontend only
    event: Stop
    command: npm run lint:css
    roles: [frontend]
  - id: guard-tf
    description: devops only
    event: Stop
    command: guard-tf.sh
    roles: [devops]
`);
    const asRole = (role: string): LocalConfig => ({ ...localConfig(), primaryRole: role, additionalRoles: [] });

    const stopCommands = async (): Promise<string[]> => (await claudeLocal()).hooks.Stop.map((h) => h.hooks[0].command);

    await reconcileTeamHooksForConfig(teamConfig, asRole('frontend'));
    expect((await stopCommands()).some((c) => c.includes('npm run lint:css'))).toBe(true);
    expect((await stopCommands()).some((c) => c.includes('guard-tf.sh'))).toBe(false);
    expect((await mainManifest()).claude.map((r) => r.id)).toEqual(['stylelint']);

    await reconcileTeamHooksForConfig(teamConfig, asRole('devops'));
    expect((await stopCommands()).some((c) => c.includes('guard-tf.sh'))).toBe(true);
    expect((await stopCommands()).some((c) => c.includes('npm run lint:css'))).toBe(false);
    const claude = await claudeSettings();
    expect(claude.hooks.Stop.filter((h) => h.description?.startsWith('[teamai] '))).toHaveLength(1);
    expect((await mainManifest()).claude.map((r) => r.id)).toEqual(['guard-tf']);

    const cursor = await cursorSettings();
    expect(cursor.hooks.stop.some((h) => h.command.includes('npm run lint:css'))).toBe(false);
    expect(cursor.hooks.stop.some((h) => h.command.includes('guard-tf.sh'))).toBe(true);
  });

  // #707: an invalid file used to reconcile to an empty team set, removing
  // every installed team hook. It now keeps them for the run.
  it('keeps the installed team hooks when hooks.yaml stops parsing', async () => {
    await writeYaml(`
hooks:
  - id: lint
    description: lint
    event: Stop
    command: npm run lint
`);
    await reconcileTeamHooksForConfig(teamConfig, localConfig());
    const before = await claudeLocal();

    await writeYaml('hooks: [unclosed\n');
    const applied = await reconcileTeamHooksForConfig(teamConfig, localConfig());

    expect(applied).toEqual({ ok: false, builtins: 'defaults-where-none' });
    expect(await claudeLocal()).toEqual(before);
    expect((await mainManifest()).claude.map((r) => r.id)).toEqual(['lint']);
  });

  // #822: `hook:` for `hooks:` parsed as "no hooks" and removed every installed
  // team hook, with no warning.
  it('keeps the installed team hooks when hooks.yaml has no top-level hooks: key, and names the file and key', async () => {
    const lint = '\n  - id: lint\n    description: lint\n    event: Stop\n    command: npm run lint\n';
    await writeYaml(`hooks:${lint}`);
    await reconcileTeamHooksForConfig(teamConfig, localConfig());
    const before = await claudeLocal();
    const { log } = await import('../utils/logger.js');
    vi.mocked(log.warn).mockClear();

    await writeYaml(`hook:${lint}`);
    const applied = await reconcileTeamHooksForConfig(teamConfig, localConfig());

    expect(applied).toEqual({ ok: false, builtins: 'defaults-where-none' });
    expect(await claudeLocal()).toEqual(before);
    expect((await mainManifest()).claude.map((r) => r.id)).toEqual(['lint']);
    const warnings = vi.mocked(log.warn).mock.calls.map(([m]) => String(m));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('hooks/hooks.yaml');
    expect(warnings[0]).toContain('`hook`');
    expect(warnings[0]).toContain('`hooks:`');
  });

  it('still applies the hooks of a hooks.yaml that carries an extra top-level key', async () => {
    await writeYaml('version: 1\nhooks:\n  - id: lint\n    description: lint\n    event: Stop\n    command: npm run lint\n');

    const applied = await reconcileTeamHooksForConfig(teamConfig, localConfig());

    expect(applied.ok).toBe(true);
    expect((await mainManifest()).claude.map((r) => r.id)).toEqual(['lint']);
  });

  it('still reads a hooks.yaml that declares only builtin: overrides', async () => {
    await writeYaml('builtin:\n  overrides:\n    Hook dispatch stop: { timeout: 99 }\n');

    const applied = await reconcileTeamHooksForConfig(teamConfig, localConfig());

    expect(applied.ok).toBe(true);
    expect((await codexSettings()).hooks.Stop[0].hooks[0].timeout).toBe(99);
  });

  // #707: a first install whose team hooks do not resolve still gets the
  // built-in hooks, above all the session-start pull that heals the member.
  it('installs the built-in hooks with the root overrides on a first install whose namespaces clash', async () => {
    await fse.outputFile(path.join(repo, 'manifest', 'projects.yaml'),
      'version: 1\nprojects:\n  - id: checkout\n    resources: { hooks: [checkout, billing] }\n');
    await writeYaml('hooks: []\nbuiltin:\n  overrides:\n    Hook dispatch stop: { timeout: 99 }\n');
    const clash = 'hooks:\n  - id: lint\n    description: lint\n    event: Stop\n    command: npm run lint\n';
    await fse.outputFile(path.join(repo, 'hooks', 'checkout', 'hooks.yaml'), clash);
    await fse.outputFile(path.join(repo, 'hooks', 'billing', 'hooks.yaml'), clash);

    const applied = await reconcileTeamHooksForConfig(teamConfig, { ...localConfig(), projects: ['checkout'] });

    expect(applied).toEqual({ ok: false, builtins: 'with-overrides' });
    const claude = await claudeSettings();
    expect(claude.hooks.SessionStart).toHaveLength(1);
    expect(claude.hooks.SessionStart[0].hooks[0].command).toContain('hook-dispatch');
    expect(claude.hooks.Stop.some((h) => h.hooks[0].command.includes('npm run lint'))).toBe(false);
    expect((await codexSettings()).hooks.Stop[0].hooks[0].timeout).toBe(99);
    expect(await fse.pathExists(path.join(home, '.teamai', 'managed-hooks.json'))).toBe(false);
  });

  it('keeps the installed team hooks and still refreshes the built-ins when a namespace file breaks', async () => {
    await fse.outputFile(path.join(repo, 'manifest', 'projects.yaml'),
      'version: 1\nprojects:\n  - id: checkout\n    resources: { hooks: [checkout] }\n');
    await writeYaml('hooks:\n  - id: lint\n    description: lint\n    event: Stop\n    command: npm run lint\n');
    const member = { ...localConfig(), projects: ['checkout'] };
    await reconcileTeamHooksForConfig(teamConfig, member);
    // A built-in entry that went missing (hand-edited, or shipped by an upgrade).
    const settings = await claudeSettings();
    delete settings.hooks.SessionStart;
    await fse.writeJson(path.join(home, '.claude', 'settings.json'), settings);

    await fse.outputFile(path.join(repo, 'hooks', 'checkout', 'hooks.yaml'), 'hooks: [unclosed\n');
    const applied = await reconcileTeamHooksForConfig(teamConfig, member);

    expect(applied).toEqual({ ok: false, builtins: 'with-overrides' });
    const claude = await claudeSettings();
    expect(claude.hooks.SessionStart).toHaveLength(1);
    expect((await claudeLocal()).hooks.Stop.some((h) => h.hooks[0].command.includes('npm run lint'))).toBe(true);
    expect((await cursorSettings()).hooks.stop.some((h) => h.command.includes('npm run lint'))).toBe(true);
    expect((await mainManifest()).claude.map((r) => r.id)).toEqual(['lint']);
  });

  it('installs the built-in hooks with their defaults on a first install whose hooks.yaml does not parse', async () => {
    await writeYaml('hooks: [unclosed\n');

    const applied = await reconcileTeamHooksForConfig(teamConfig, localConfig());

    expect(applied).toEqual({ ok: false, builtins: 'defaults-where-none' });
    expect((await claudeSettings()).hooks.SessionStart).toHaveLength(1);
    expect((await cursorSettings()).hooks.sessionStart).toHaveLength(1);
    expect((await codexSettings()).hooks.SessionStart).toHaveLength(1);
  });

  it('delivers an active namespace hook in place of the root hook with the same id, and back', async () => {
    await fse.outputFile(path.join(repo, 'manifest', 'projects.yaml'),
      'version: 1\nprojects:\n  - id: checkout\n    resources: { hooks: [checkout] }\n  - id: billing\n    resources: {}\n');
    await writeYaml('hooks:\n  - id: lint\n    description: lint\n    event: Stop\n    command: npm run lint\n');
    await fse.outputFile(path.join(repo, 'hooks', 'checkout', 'hooks.yaml'),
      'hooks:\n  - id: lint\n    description: lint\n    event: Stop\n    command: npm run lint:checkout\n');
    const stopCommands = async (): Promise<string[]> => (await claudeLocal()).hooks.Stop.map((h) => h.hooks[0]?.command ?? '');

    await reconcileTeamHooksForConfig(teamConfig, { ...localConfig(), projects: ['checkout'] });
    expect((await stopCommands()).some((c) => c.includes('npm run lint:checkout'))).toBe(true);
    expect((await stopCommands()).some((c) => c.includes('npm run lint') && !c.includes('lint:checkout'))).toBe(false);

    await reconcileTeamHooksForConfig(teamConfig, { ...localConfig(), projects: ['billing'] });
    expect((await stopCommands()).some((c) => c.includes('npm run lint:checkout'))).toBe(false);
    expect((await stopCommands()).some((c) => c.includes('npm run lint'))).toBe(true);
  });

  it('removeAll clears built-in + team hooks', async () => {
    await writeYaml(`
hooks:
  - id: lint
    description: lint
    event: Stop
    command: npm run lint
`);
    await reconcileTeamHooksForConfig(teamConfig, localConfig());
    await reconcileTeamHooksForConfig(teamConfig, localConfig(), { removeAll: true });

    const claude = await claudeSettings();
    for (const entries of Object.values(claude.hooks)) {
      expect(entries).toHaveLength(0);
    }
    const codex = await codexSettings();
    for (const entries of Object.values(codex.hooks)) {
      expect(entries).toHaveLength(0);
    }
  });

  it('applies §4.8 builtin disabled + timeout overrides from hooks.yaml', async () => {
    await writeYaml(`
hooks: []
builtin:
  disabled: [Hook dispatch post-tool-use TodoWrite]
  overrides:
    Hook dispatch stop: { timeout: 99 }
`);
    await reconcileTeamHooksForConfig(teamConfig, localConfig());

    const cursor = await cursorSettings();
    // TodoWrite dropped → 2 built-in postToolUse entries instead of 3.
    expect(cursor.hooks.postToolUse).toHaveLength(2);
    expect(cursor.hooks.postToolUse.some((h) => h.command.includes('TodoWrite'))).toBe(false);
    // Stop timeout overridden.
    expect((cursor.hooks.stop[0] as { timeout?: number }).timeout).toBe(99);
  });

  it('works with no hooks.yaml (built-in self-heal only)', async () => {
    const reconciled = await reconcileTeamHooksForConfig(teamConfig, localConfig());
    expect(reconciled).toEqual({ ok: true, defs: [] });
    const claude = await claudeSettings();
    expect(claude.hooks.SessionStart).toHaveLength(1);
    // No manifest written when there are no team hooks.
    expect(await fse.pathExists(path.join(home, '.teamai', 'managed-hooks.json'))).toBe(false);
  });

  it('self single-repo mode injects into projectRoot, not HOME (committed to main, travels on clone)', async () => {
    // Pre-create the tool root under projectRoot so it counts as installed there.
    await fse.ensureDir(path.join(project, '.claude'));
    const selfConfig = {
      repo: { localPath: repo, remote: 'x', kind: 'self', businessRepoRoot: project },
      username: 'u',
      scope: 'project',
      projectRoot: project,
      additionalRoles: [],
    } as unknown as LocalConfig;

    await reconcileTeamHooksForConfig(teamConfig, selfConfig);

    // Self mode writes to the business repo tree (projectRoot), never HOME.
    const projectClaude = await fse.readJson(path.join(project, '.claude', 'settings.json'));
    expect(projectClaude.hooks.SessionStart).toHaveLength(1);
    expect(await fse.pathExists(path.join(home, '.claude', 'settings.json'))).toBe(false);
  });

  it('keeps the Claude hook a self-mode workspace installed when a child defines it differently (#913)', async () => {
    await fse.ensureDir(path.join(project, '.claude'));
    await fse.outputFile(path.join(repo, 'manifest', 'projects.yaml'),
      YAML.stringify({ version: 1, projects: ['a', 'b'].map((id) => ({ id, resources: { hooks: [id] } })) }));
    for (const namespace of ['a', 'b']) {
      await fse.outputFile(path.join(repo, 'hooks', namespace, 'hooks.yaml'),
        YAML.stringify({ hooks: [{ id: 'held', description: 'held', event: 'Stop', command: `echo ${namespace}`, tools: ['claude'] }] }));
    }
    const selfConfig = {
      repo: { localPath: repo, remote: 'https://git.example.com/team.git', kind: 'self', businessRepoRoot: project },
      username: 'u',
      scope: 'project',
      projectRoot: project,
      projects: ['a'],
      additionalRoles: [],
      enabledAgents: ['claude'],
    } as unknown as LocalConfig;
    const settings = (): Promise<string> => fse.readFile(path.join(project, '.claude', 'settings.json'), 'utf8');
    await reconcileTeamHooksForConfig(teamConfig, selfConfig);
    expect(await settings()).toContain('echo a');
    await fse.outputFile(path.join(project, 'child', '.teamai', 'config.yaml'),
      YAML.stringify({ scope: 'workspace', repo: { localPath: repo, remote: 'https://git.example.com/team.git' }, username: 'u', projects: ['b'] }));
    const withChild = await readWorkspaceChildren(selfConfig);
    expect(withChild.children?.children).toHaveLength(1);

    await reconcileTeamHooksForConfig(teamConfig, withChild);

    expect(await settings()).toContain('echo a');
    expect(await settings()).not.toContain('echo b');

    // The member edits the held entry's command; its marker and its record stay.
    const file = path.join(project, '.claude', 'settings.json');
    const edited = await fse.readJson(file);
    edited.hooks.Stop.find((entry: { description?: string }) => entry.description?.includes('[teamai:hook:held]')).hooks[0].command = 'echo member-held';
    await fse.writeJson(file, edited);

    await reconcileTeamHooksForConfig(teamConfig, withChild);

    expect(await settings()).toContain('echo member-held');
    expect(await settings()).not.toContain('echo b');
    const manifests = async (dir: string): Promise<string[]> => (await fse.readdir(dir, { withFileTypes: true })).reduce<Promise<string[]>>(
      async (found, entry) => [...await found, ...entry.isDirectory() ? await manifests(path.join(dir, entry.name))
        : entry.name === 'managed-hooks.json' ? [path.join(dir, entry.name)] : []], Promise.resolve([]));
    const heldRecords = async (): Promise<string[]> => (await Promise.all([...await manifests(project), ...await manifests(home)]
      .map(async (manifest) => ((await fse.readJson(manifest)).claude ?? []) as Array<{ id: string; command: string }>)))
      .flat().filter((record) => record.id === 'held').map((record) => record.command);
    expect(await heldRecords()).toEqual(['echo member-held']);
  });

  it('moves a held Codex hook between its file and the dispatcher as sharing.gitExclude changes (#913)', async () => {
    await fse.ensureDir(path.join(project, '.codex'));
    await fse.outputFile(path.join(repo, 'manifest', 'projects.yaml'),
      YAML.stringify({ version: 1, projects: ['a', 'b'].map((id) => ({ id, resources: { hooks: [id] } })) }));
    for (const namespace of ['a', 'b']) {
      await fse.outputFile(path.join(repo, 'hooks', namespace, 'hooks.yaml'),
        YAML.stringify({ hooks: [{ id: 'held', description: 'held', event: 'Stop', command: `echo ${namespace}`, tools: ['codex'] }] }));
    }
    const selfConfig = {
      repo: { localPath: repo, remote: 'https://git.example.com/team.git', kind: 'self', businessRepoRoot: project },
      username: 'u',
      scope: 'project',
      projectRoot: project,
      projects: ['a'],
      additionalRoles: [],
      enabledAgents: ['codex'],
    } as unknown as LocalConfig;
    const team = (gitExclude: boolean): TeamaiConfig => ({ ...teamConfig, sharing: { gitExclude: { enabled: gitExclude } } }) as unknown as TeamaiConfig;
    const root = await fse.realpath(project);
    const inFile = async (command: string): Promise<boolean> => (await fse.readFile(path.join(project, '.codex', 'hooks.json'), 'utf8')).includes(command);
    const dispatched = async (): Promise<string[]> => ((await dispatchedCodexHooks(root, root)) ?? []).map((hook) => hook.command);
    await reconcileTeamHooksForConfig(team(false), selfConfig);
    expect(await inFile('echo a')).toBe(true);
    await fse.outputFile(path.join(project, 'child', '.teamai', 'config.yaml'),
      YAML.stringify({ scope: 'workspace', repo: { localPath: repo, remote: 'https://git.example.com/team.git' }, username: 'u', projects: ['b'] }));
    const withChild = await readWorkspaceChildren(selfConfig);
    expect(withChild.children?.children).toHaveLength(1);

    await reconcileTeamHooksForConfig(team(true), withChild);

    expect(await inFile('echo a')).toBe(false);
    expect(await dispatched()).toEqual([expect.stringContaining('echo a')]);

    await reconcileTeamHooksForConfig(team(false), withChild);

    expect(await inFile('echo a')).toBe(true);
    expect(await inFile('echo b')).toBe(false);
    expect(await dispatched()).toEqual([]);
    await reconcileTeamHooksForConfig(team(false), withChild);
    expect(await inFile('echo a')).toBe(true);
  });
});

// ── Legacy <projectRoot> sweep (#370 follow-up) ──────────────
//
// The sweep that clears the pre-#370 <projectRoot> copy must not damage the
// HOME copy the primary pass just wrote. Two ways it did:
//  1. Hermes/OpenCode reconcile through global adapters that ignore baseDir, so
//     a removeAll sweep against <projectRoot> deleted their HOME hooks.
//  2. When projectRoot IS the home dir, "legacy" and "live" are the same file.
// ── Claude and Codex team hooks in the main checkout (#955) ──
//
// One set of ungated entries in the main checkout, shared by every worktree,
// so Codex has one set of trust keys and nothing per checkout to reorder.
describe('reconcileTeamHooksForConfig — team hooks in the main checkout', () => {
  const STOP_LINT = 'hooks:\n  - id: lint\n    description: lint\n    event: Stop\n    command: npm run lint\n';

  it.each(['claude', 'codex'])('preserves unowned marker commands in %s main hooks from a worktree', async (tool) => {
    await writeYaml(STOP_LINT);
    const { main, worktree } = await mainWithWorktree();
    const file = path.join(main, tool === 'claude' ? '.claude/settings.local.json' : '.codex/hooks.json');
    const matcher = tool === 'claude' ? { matcher: '*' } : {};
    const raw = `teamai hook-dispatch session-start --tool ${tool}`;
    const member = { ...matcher, hooks: [{ type: 'command', command: 'teamai pull --silent && ./notify' }] };
    const memberStart = [
      { ...matcher, hooks: [{ type: 'command', command: raw + ' && ./notify' }] },
      { ...matcher, hooks: [{ type: 'command', command: raw }, { type: 'command', command: './notify' }] },
    ];
    await fse.outputJson(file, { hooks: {
      Stop: [member],
      SessionStart: [{ ...matcher, hooks: [{ type: 'command', command: raw }] }, ...memberStart],
    } });
    const cfg = { ...localConfig(), projectRoot: worktree };
    try {
      await reconcileTeamHooksForConfig(teamConfig, cfg);

      expect((await fse.readJson(file)).hooks.Stop[0]).toEqual(member);
      expect((await fse.readJson(file)).hooks.SessionStart).toEqual(memberStart);
      const before = await fse.readFile(file, 'utf8');
      await reconcileTeamHooksForConfig(teamConfig, cfg);
      expect(await fse.readFile(file, 'utf8')).toBe(before);
      await writeYaml(STOP_LINT.replace('npm run lint', 'npm run lint:fix'));
      await reconcileTeamHooksForConfig(teamConfig, cfg);
      expect((await fse.readJson(file)).hooks.Stop).toHaveLength(2);
      expect((await fse.readJson(file)).hooks.Stop[0]).toEqual(member);
      await reconcileTeamHooksForConfig(teamConfig, cfg, { removeAll: true });
      expect((await fse.readJson(file)).hooks.Stop).toEqual([member]);
      expect((await fse.readJson(file)).hooks.SessionStart).toEqual(memberStart);
    } finally {
      await fse.remove(worktree);
    }
  });

  it('preserves a claude member hook sharing the team command with a different definition', async () => {
    await writeYaml(STOP_LINT);
    const { main, worktree } = await mainWithWorktree();
    const file = path.join(main, '.claude/settings.local.json');
    const cfg = { ...localConfig(), projectRoot: worktree };
    try {
      await reconcileTeamHooksForConfig(teamConfig, cfg);
      const generated = (await fse.readJson(file)).hooks.Stop[0];
      const member = { matcher: '*', hooks: [{ type: 'command', command: generated.hooks[0].command, timeout: 30 }], description: 'mine' };
      await fse.outputJson(file, { hooks: { Stop: [member, generated] } });

      await reconcileTeamHooksForConfig(teamConfig, cfg);
      await reconcileTeamHooksForConfig(teamConfig, cfg);

      expect((await fse.readJson(file)).hooks.Stop).toEqual([member, generated]);
      await reconcileTeamHooksForConfig(teamConfig, cfg, { removeAll: true });
      expect((await fse.readJson(file)).hooks.Stop).toEqual([member]);
    } finally {
      await fse.remove(worktree);
    }
  });

  it('uses project toolPaths for main hooks and userScope paths for HOME built-ins', async () => {
    await writeYaml(STOP_LINT);
    const custom = { toolPaths: {
      claude: { settings: '.custom-claude/settings.json', userScope: { settings: '.claude/settings.json' } },
      codex: { settings: '.custom-codex/hooks.json', userScope: { settings: '.codex/hooks.json' } },
    } } as unknown as TeamaiConfig;
    const files = [path.join(project, '.custom-claude', 'settings.local.json'), path.join(project, '.custom-codex', 'hooks.json')];

    await reconcileTeamHooksForConfig(custom, localConfig());

    for (const file of files) {
      expect(await fse.pathExists(file)).toBe(true);
      expect((await fse.readJson(file)).hooks.Stop[0].hooks[0].command).toContain('npm run lint');
      expect(await fse.readFile(file, 'utf8')).not.toContain('$PWD');
    }
    expect((await claudeSettings()).hooks.SessionStart).toHaveLength(1);
    expect((await codexSettings()).hooks.SessionStart).toHaveLength(1);
    expect(await fse.pathExists(path.join(project, '.claude', 'settings.local.json'))).toBe(false);
    expect(await fse.pathExists(path.join(project, '.codex', 'hooks.json'))).toBe(false);
    const before = await Promise.all(files.map((file) => fse.readFile(file, 'utf8')));
    await reconcileTeamHooksForConfig(custom, localConfig());
    expect(await Promise.all(files.map((file) => fse.readFile(file, 'utf8')))).toEqual(before);
    await reconcileTeamHooksForConfig(custom, localConfig(), { removeAll: true });
    for (const file of files) expect((await fse.readJson(file)).hooks.Stop).toEqual([]);
  });

  it('keeps one HOME-gated internal Codex hook per project when their pulls alternate', async () => {
    await writeYaml(STOP_LINT);
    const other = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-internal-other-'));
    const file = path.join(home, '.codex-internal', 'hooks.json');
    await fse.ensureDir(path.dirname(file));
    const internal = { toolPaths: { 'codex-internal': { settings: '.codex-internal/hooks.json' } } } as unknown as TeamaiConfig;
    try {
      for (const root of [project, other, project, other]) {
        await reconcileTeamHooksForConfig(internal, { ...localConfig(), projectRoot: root });
      }
      const commands = (await fse.readJson(file)).hooks.Stop
        .map((entry: { hooks: Array<{ command: string }> }) => entry.hooks[0].command)
        .filter((command: string) => command.includes('$PWD'));
      expect(commands).toHaveLength(2);
      expect(commands.filter((command: string) => command.includes(project))).toHaveLength(1);
      expect(commands.filter((command: string) => command.includes(other))).toHaveLength(1);
    } finally {
      await fse.remove(other);
    }
  });

  async function mainWithWorktree(): Promise<{ main: string; worktree: string }> {
    const main = await fse.realpath(project);
    const worktree = path.join(await fse.realpath(os.tmpdir()), `teamai-recon-wt-${path.basename(main)}`);
    await fse.ensureDir(worktree);
    vi.mocked(resolveAnchors).mockImplementation(async (cwd) => ({ workspaceRoot: cwd ?? main, projectAnchor: main, mainCheckout: main }));
    vi.mocked(listWorktrees).mockResolvedValue([main, worktree]);
    return { main, worktree };
  }

  const gated = (root: string, command: string): string =>
    `if [ "$PWD" = '${root}' ] || case "$PWD" in '${root}'/*) true;; *) false;; esac; then (${command}); fi`;

  it('writes from a linked worktree into the main checkout, not the worktree', async () => {
    await writeYaml(STOP_LINT);
    const { main, worktree } = await mainWithWorktree();
    try {
      await reconcileTeamHooksForConfig(teamConfig, { ...localConfig(), projectRoot: worktree });

      expect((await fse.readJson(path.join(main, '.codex', 'hooks.json'))).hooks.Stop[0].hooks[0].command).toBe('npm run lint');
      expect(await fse.pathExists(path.join(main, '.claude', 'settings.local.json'))).toBe(true);
      expect(await fse.pathExists(path.join(worktree, '.codex', 'hooks.json'))).toBe(false);
      expect(await fse.pathExists(path.join(worktree, '.claude', 'settings.local.json'))).toBe(false);
      // The SessionStart a new Codex worktree runs before it has a `.codex/`.
      expect((await codexSettings()).hooks.SessionStart).toHaveLength(1);
    } finally {
      await fse.remove(worktree);
    }
  });

  it('shares one copy of the main hooks between two worktree installs when the main checkout has none', async () => {
    await writeYaml(STOP_LINT);
    const { main, worktree } = await mainWithWorktree();
    const second = `${worktree}-2`;
    await fse.ensureDir(second);
    vi.mocked(listWorktrees).mockResolvedValue([main, worktree, second]);
    const stops = async () => [
      (await fse.readJson(path.join(main, '.claude', 'settings.local.json'))).hooks.Stop.length,
      (await fse.readJson(path.join(main, '.codex', 'hooks.json'))).hooks.Stop.length,
    ];
    // Detection attaches each worktree's own data home.
    const at = (root: string): LocalConfig => ({ ...localConfig(), projectRoot: root, dataHome: path.join(root, '.teamai') });
    try {
      for (const root of [worktree, second]) await fse.outputFile(path.join(root, '.teamai', 'config.yaml'), '');
      await reconcileTeamHooksForConfig(teamConfig, at(worktree));
      await reconcileTeamHooksForConfig(teamConfig, at(second));
      expect(await stops()).toEqual([1, 1]);

      await reconcileTeamHooksForConfig(teamConfig, at(worktree), { removeAll: true });
      expect(await stops()).toEqual([1, 1]);
      // Second worktree removal clears hooks without needing .teamai removed
      await reconcileTeamHooksForConfig(teamConfig, at(second), { removeAll: true });
      expect(await stops()).toEqual([0, 0]);
    } finally {
      await fse.remove(worktree);
      await fse.remove(second);
    }
  });

  it('keeps shared main hooks when main checkout removes while a linked worktree remains installed', async () => {
    await writeYaml(STOP_LINT);
    const { main, worktree } = await mainWithWorktree();
    const stops = async () => [
      (await fse.readJson(path.join(main, '.claude', '.settings.local.json').replace('.settings.local.json', 'settings.local.json'))).hooks.Stop.length,
      (await fse.readJson(path.join(main, '.codex', 'hooks.json'))).hooks.Stop.length,
    ];
    const at = (root: string): LocalConfig => ({ ...localConfig(), projectRoot: root, dataHome: path.join(root, '.teamai') });
    try {
      for (const root of [main, worktree]) await fse.outputFile(path.join(root, '.teamai', 'config.yaml'), 'scope: project');
      await reconcileTeamHooksForConfig(teamConfig, at(main));
      await reconcileTeamHooksForConfig(teamConfig, at(worktree));
      expect(await stops()).toEqual([1, 1]);

      // Removing from main checkout keeps hooks for the worktree
      await reconcileTeamHooksForConfig(teamConfig, at(main), { removeAll: true });
      expect(await stops()).toEqual([1, 1]);

      // Removing from worktree clears them once no checkouts remain
      await reconcileTeamHooksForConfig(teamConfig, at(worktree), { removeAll: true });
      expect(await stops()).toEqual([0, 0]);
    } finally {
      await fse.remove(worktree);
    }
  });

  it('removes the gated entries an older CLI left for this project, and keeps another project\'s', async () => {
    await writeYaml(STOP_LINT);
    const { main, worktree } = await mainWithWorktree();
    const other = await fse.realpath(await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-recon-other-')));
    const removed = path.join(other, 'removed-worktree');
    try {
      const roots = [main, worktree, removed, other];
      await fse.writeJson(path.join(home, '.codex', 'hooks.json'), {
        hooks: { Stop: roots.map((root) => ({ hooks: [{ type: 'command', command: gated(root, 'npm run lint') }] })) },
      });
      await fse.outputJson(path.join(home, '.teamai', 'managed-hooks.json'), {
        codex: roots.map((root) => ({ id: 'lint', event: 'Stop', command: gated(root, 'npm run lint') })),
      });

      await reconcileTeamHooksForConfig(teamConfig, { ...localConfig(), projectRoot: worktree });

      const stop = (await codexSettings()).hooks.Stop.map((h) => h.hooks[0].command);
      expect(stop.filter((c) => c.startsWith('if [ "$PWD"'))).toEqual([gated(other, 'npm run lint')]);
      expect(((await manifest()).codex as unknown as Array<{ command: string }>).map((r) => r.command)).toEqual([gated(other, 'npm run lint')]);
    } finally {
      await fse.remove(worktree);
      await fse.remove(other);
    }
  });

  it('creates nothing in the business repo when the team has no hooks', async () => {
    await reconcileTeamHooksForConfig(teamConfig, localConfig());

    expect(await fse.pathExists(path.join(project, '.codex'))).toBe(false);
    expect(await fse.pathExists(path.join(project, '.claude', 'settings.local.json'))).toBe(false);
  });

  it.each([
    { target: 'main', removeAll: false },
    { target: 'worktree', removeAll: false },
    { target: 'main', removeAll: true },
    { target: 'worktree', removeAll: true },
  ])('uses pre-#370 ownership before reconciling main hooks %j', async ({ target, removeAll }) => {
    await writeYaml(STOP_LINT);
    const { main, worktree } = await mainWithWorktree();
    const file = path.join(main, '.codex', 'hooks.json');
    const legacyManifest = path.join(main, '.teamai', 'managed-hooks.json');
    const oldCommand = gated(main, 'npm run lint');
    const oldEntry = { hooks: [{ type: 'command', command: oldCommand, timeout: 30 }] };
    // Shares the team's command but is not its render: an exact render is teamai's (#993).
    const member = { hooks: [{ type: 'command', command: 'npm run lint', timeout: 5 }] };
    const cursorRecords = [{ id: 'other', event: 'Stop', command: 'echo cursor' }];
    await fse.outputJson(file, { hooks: { Stop: [member, oldEntry], PreToolUse: [oldEntry] } });
    await fse.outputJson(legacyManifest, {
      codex: [{ id: 'lint', event: 'Stop', command: oldCommand }], cursor: cursorRecords,
    });
    const root = target === 'main' ? main : worktree;
    const cfg = { ...localConfig(), projectRoot: root };
    try {
      await reconcileTeamHooksForConfig(teamConfig, cfg, { removeAll });

      expect((await fse.readJson(file)).hooks.Stop).toEqual(removeAll ? [member] : [
        member, { hooks: [{ type: 'command', command: 'npm run lint' }] },
      ]);
      expect((await fse.readJson(file)).hooks.PreToolUse).toEqual([oldEntry]);
      expect(await fse.readJson(legacyManifest)).toEqual({ cursor: cursorRecords });
      const ownership = await fse.readJson(path.join(main, '.teamai', 'managed-main-checkout-hooks.json'));
      expect((ownership.codex ?? []).map((record: { command: string }) => record.command))
        .toEqual(removeAll ? [] : ['npm run lint']);
      if (!removeAll) {
        const before = await fse.readFile(file, 'utf8');
        await reconcileTeamHooksForConfig(teamConfig, cfg);
        expect(await fse.readFile(file, 'utf8')).toBe(before);
        await reconcileTeamHooksForConfig(teamConfig, cfg, { removeAll: true });
        expect((await fse.readJson(file)).hooks.Stop).toEqual([member]);
      }
    } finally {
      await fse.remove(worktree);
    }
  });

  it('replaces a recorded legacy copy in the main checkout\'s Codex file instead of duplicating it', async () => {
    await writeYaml(STOP_LINT);
    await fse.outputJson(path.join(project, '.codex', 'hooks.json'), {
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'teamai hook-dispatch session-start --tool codex' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'npm run lint' }] }],
      },
    });
    await fse.outputJson(path.join(project, '.teamai', 'managed-main-checkout-hooks.json'), {
      codex: [{ id: 'lint', event: 'Stop', command: 'npm run lint' }],
    });

    await reconcileTeamHooksForConfig(teamConfig, localConfig());

    const file = await codexProject();
    expect(file.hooks.SessionStart).toEqual([]);
    expect(file.hooks.Stop.map((h) => h.hooks[0].command)).toEqual(['npm run lint']);
  });

  it('is a no-op on a second run', async () => {
    await writeYaml(STOP_LINT);
    await reconcileTeamHooksForConfig(teamConfig, localConfig());
    const read = async () => Promise.all([
      fse.readFile(path.join(home, '.codex', 'hooks.json'), 'utf8'),
      fse.readFile(path.join(project, '.codex', 'hooks.json'), 'utf8'),
      fse.readFile(path.join(project, '.claude', 'settings.local.json'), 'utf8'),
    ]);
    const before = await read();

    await reconcileTeamHooksForConfig(teamConfig, localConfig());

    expect(await read()).toEqual(before);
  });

  it.each(['claude', 'codex'])('refreshes existing %s main hooks and restores HOME built-ins when both tool roots are missing', async (tool) => {
    await writeYaml(STOP_LINT);
    const { main, worktree } = await mainWithWorktree();
    const cfg = { ...localConfig(), projectRoot: worktree };
    const file = path.join(main, tool === 'claude' ? '.claude/settings.local.json' : '.codex/hooks.json');
    const homeFile = path.join(home, tool === 'claude' ? '.claude/settings.json' : '.codex/hooks.json');
    try {
      await reconcileTeamHooksForConfig(teamConfig, cfg);
      const member = { hooks: [{ type: 'command', command: 'echo member' }] };
      const json = await fse.readJson(file);
      json.hooks.Stop.push(member);
      await fse.writeJson(file, json);
      await fse.remove(path.join(home, `.${tool}`));
      await writeYaml(STOP_LINT.replace('npm run lint', 'npm run lint:fix'));

      await reconcileTeamHooksForConfig(teamConfig, cfg);

      const entries = (await fse.readJson(file)).hooks.Stop;
      expect(entries).toHaveLength(2);
      expect(entries).toContainEqual(member);
      expect(entries.some((entry: { hooks: Array<{ command: string }> }) => entry.hooks[0].command.includes('npm run lint:fix'))).toBe(true);
      expect((await fse.readJson(homeFile)).hooks.SessionStart).toHaveLength(1);
      expect(await fse.pathExists(path.join(worktree, `.${tool}`))).toBe(false);
      const before = await fse.readFile(file, 'utf8');
      await reconcileTeamHooksForConfig(teamConfig, cfg);
      expect(await fse.readFile(file, 'utf8')).toBe(before);
    } finally {
      await fse.remove(worktree);
    }
  });

  it('does not install absent tools without an existing main-checkout hook file', async () => {
    await writeYaml(STOP_LINT);
    await fse.remove(path.join(home, '.claude'));
    await fse.remove(path.join(home, '.codex'));

    await reconcileTeamHooksForConfig(teamConfig, localConfig());

    for (const root of [home, project]) {
      expect(await fse.pathExists(path.join(root, '.claude'))).toBe(false);
      expect(await fse.pathExists(path.join(root, '.codex'))).toBe(false);
    }
  });

  it('removes main-checkout hooks without recreating missing HOME roots', async () => {
    await writeYaml(STOP_LINT);
    const { main, worktree } = await mainWithWorktree();
    const cfg = { ...localConfig(), projectRoot: worktree };
    try {
      await reconcileTeamHooksForConfig(teamConfig, cfg);
      const files = [path.join(main, '.claude', 'settings.local.json'), path.join(main, '.codex', 'hooks.json')];
      const member = { hooks: [{ type: 'command', command: 'echo member' }] };
      for (const file of files) {
        const json = await fse.readJson(file);
        json.hooks.Stop.push(member);
        await fse.writeJson(file, json);
      }
      await fse.remove(path.join(home, '.claude'));
      await fse.remove(path.join(home, '.codex'));

      await reconcileTeamHooksForConfig(teamConfig, cfg, { removeAll: true });

      for (const file of files) expect((await fse.readJson(file)).hooks.Stop).toEqual([member]);
      for (const root of [home, worktree]) {
        expect(await fse.pathExists(path.join(root, '.claude'))).toBe(false);
        expect(await fse.pathExists(path.join(root, '.codex'))).toBe(false);
      }
    } finally {
      await fse.remove(worktree);
    }
  });

  it('removeAll clears the main checkout\'s team hooks too', async () => {
    await writeYaml(STOP_LINT);
    await reconcileTeamHooksForConfig(teamConfig, localConfig());

    await reconcileTeamHooksForConfig(teamConfig, localConfig(), { removeAll: true });

    expect((await codexProject()).hooks.Stop).toEqual([]);
    expect((await claudeLocal()).hooks.Stop).toEqual([]);
  });

  it.each(['claude', 'codex'])('removeAll releases one duplicated %s main hook per ownership record', async (tool) => {
    await writeYaml(STOP_LINT);
    await reconcileTeamHooksForConfig(teamConfig, localConfig());
    const file = path.join(project, tool === 'claude' ? '.claude/settings.local.json' : '.codex/hooks.json');
    const json = await fse.readJson(file);
    const [entry] = json.hooks.Stop;
    json.hooks.Stop.push(entry);
    await fse.writeJson(file, json);
    expect((await mainManifest())[tool]).toHaveLength(1);

    await reconcileTeamHooksForConfig(teamConfig, localConfig(), { removeAll: true });

    expect((await fse.readJson(file)).hooks.Stop).toEqual([entry]);
  });

  it.each(['claude', 'codex'])('removeAll from main in v0.22 duplicated state releases main entry and preserves worktree entry for %s', async (tool) => {
    const worktreeDir = await fse.mkdtemp(path.join(os.tmpdir(), 'wt-duplicated-'));
    vi.mocked(listWorktrees).mockResolvedValue([project, worktreeDir]);

    try {
      await writeYaml(STOP_LINT);
      await reconcileTeamHooksForConfig(teamConfig, localConfig());
      const file = path.join(project, tool === 'claude' ? '.claude/settings.local.json' : '.codex/hooks.json');
      const json = await fse.readJson(file);
      const [entry] = json.hooks.Stop;
      json.hooks.Stop.push(entry);
      await fse.writeJson(file, json);

      // Simulate worktree having its own manifest from older install
      const wtManifestPath = path.join(worktreeDir, '.teamai', 'managed-main-checkout-hooks.json');
      await fse.outputJson(wtManifestPath, {
        [tool]: [{ id: 'lint', event: 'Stop', command: entry.hooks ? entry.hooks[0].command : entry.command }],
      });
      await fse.outputFile(path.join(worktreeDir, '.teamai', 'config.yaml'), 'scope: project');

      await reconcileTeamHooksForConfig(teamConfig, localConfig(), { removeAll: true });

      // One duplicated entry was released, one remains for the worktree
      expect((await fse.readJson(file)).hooks.Stop).toEqual([entry]);
    } finally {
      await fse.remove(worktreeDir);
    }
  });
});

describe('reconcileTeamHooksForConfig — legacy projectRoot sweep', () => {
  const withOpencodeAndHermes = {
    toolPaths: {
      claude: { settings: '.claude/settings.json' },
      opencode: { skills: '.opencode/skills' },
      hermes: {},
    },
  } as unknown as TeamaiConfig;

  const opencodePlugin = () =>
    path.join(home, '.config', 'opencode', 'plugin', 'teamai-hooks.ts');
  const hermesScript = () => path.join(home, '.hermes', 'hooks', 'teamai-status-report.sh');

  it('keeps the HOME OpenCode plugin and Hermes hook it just installed', async () => {
    vi.stubEnv('HERMES_HOME', path.join(home, '.hermes'));
    await fse.ensureDir(path.join(home, '.config', 'opencode'));
    await fse.ensureDir(path.join(home, '.hermes'));

    await reconcileTeamHooksForConfig(withOpencodeAndHermes, localConfig());

    expect(await fse.pathExists(opencodePlugin())).toBe(true);
    expect(await fse.pathExists(hermesScript())).toBe(true);
  });

  it('still deletes the legacy <projectRoot> OpenCode plugin', async () => {
    await fse.ensureDir(path.join(home, '.config', 'opencode'));
    const legacyPlugin = path.join(project, '.opencode', 'plugin', 'teamai-hooks.ts');
    await fse.ensureDir(path.dirname(legacyPlugin));
    await fse.writeFile(legacyPlugin, '// stale project copy');

    await reconcileTeamHooksForConfig(withOpencodeAndHermes, localConfig());

    expect(await fse.pathExists(legacyPlugin)).toBe(false);
    expect(await fse.pathExists(opencodePlugin())).toBe(true);
  });

  it('sweeps the legacy copy of a tool excluded by filterAgents', async () => {
    // cursor wrote <projectRoot>/.cursor/hooks.json back when it was enabled;
    // disabling it today must not strand that copy.
    await fse.ensureDir(path.join(project, '.cursor'));
    await fse.writeJson(path.join(project, '.cursor', 'hooks.json'), {
      version: 1,
      hooks: { stop: [{ command: 'teamai hook-dispatch stop --tool cursor' }] },
    });

    await reconcileTeamHooksForConfig(teamConfig, localConfig(), { filterAgents: ['claude'] });

    const stale = await fse.readJson(path.join(project, '.cursor', 'hooks.json'));
    expect(stale.hooks.stop ?? []).toHaveLength(0);
  });

  it.each(['enabled', 'disabled', 'selected'])('sweeps only legacy Codex ownership when excluded through %s agents', async (selection) => {
    const legacyCommand = `[ "$PWD" = "${project}" ] && npm run lint`;
    const legacy = { hooks: [{ type: 'command', command: legacyCommand }] };
    const builtin = { hooks: [{ type: 'command', command: 'teamai hook-dispatch session-start --tool codex' }] };
    const member = { hooks: [{ type: 'command', command: 'teamai pull --silent && ./notify' }] };
    const current = { hooks: [{ type: 'command', command: 'echo current' }] };
    await fse.outputJson(path.join(project, '.codex', 'hooks.json'), {
      hooks: { SessionStart: [builtin], Stop: [legacy, member, current] },
    });
    await fse.outputJson(path.join(project, '.teamai', 'managed-hooks.json'), {
      codex: [{ id: 'lint', event: 'Stop', command: legacyCommand }],
    });
    const currentManifest = { codex: [{ id: 'current', event: 'Stop', command: 'echo current' }] };
    await fse.outputJson(path.join(project, '.teamai', 'managed-main-checkout-hooks.json'), currentManifest);
    const cfg = { ...localConfig(),
      ...(selection === 'enabled' ? { enabledAgents: ['claude'] } : {}),
      ...(selection === 'disabled' ? { disabledAgents: ['codex'] } : {}),
    };
    await reconcileTeamHooksForConfig(teamConfig, cfg, selection === 'selected' ? { filterAgents: ['claude'] } : {});

    const after = await codexProject();
    expect(after.hooks.SessionStart).toEqual([]);
    expect(after.hooks.Stop).toEqual([member, current]);
    expect(await fse.readJson(path.join(project, '.teamai', 'managed-hooks.json'))).toEqual({});
    expect(await mainManifest()).toEqual(currentManifest);
    expect(await fse.pathExists(path.join(home, '.codex', 'hooks.json'))).toBe(false);
  });

  it('does not wipe the live hooks when projectRoot IS the home dir', async () => {
    // `teamai init .` run in ~ (dotfiles-style repo): the legacy location and
    // the live HOME target are the same file, so there is nothing to sweep.
    const cfg = {
      repo: { localPath: repo, remote: 'x' },
      username: 'u',
      scope: 'project',
      projectRoot: home,
      additionalRoles: [],
    } as unknown as LocalConfig;

    await reconcileTeamHooksForConfig(teamConfig, cfg);

    const claude = await claudeSettings();
    expect(claude.hooks.SessionStart).toHaveLength(1);
  });
});

// ── Project gate: what it renders, and whether it actually fires ─
//
// Every hook runner is a POSIX shell — CodeBuddy's Git Bash, WorkBuddy's
// bundled PortableGit, `bash -lc` for the rest — so the gate is always the
// POSIX form. A cmd.exe gate would not run there at all: `findstr` errors out
// and the `>nul` redirect leaves a file named `nul` in the project.
//
// On Windows that shell names its cwd `/c/proj`, never the `C:\proj` the root
// resolves to, so the gate carries both spellings. The cases below check the
// shape; the last one runs a rendered gate through a real shell, which is the
// only way a gate that can never match is caught.
describe('project gate — rendering and real-shell execution', () => {
  const codebuddyOnly = {
    toolPaths: { codebuddy: { settings: '.codebuddy/settings.json' } },
  } as unknown as TeamaiConfig;

  async function teamStopCommands(file: string): Promise<string[]> {
    const settings = await fse.readJson(path.join(home, file));
    return (settings.hooks.Stop ?? [])
      .filter((e: { description?: string }) => e.description?.startsWith('[teamai:hook:'))
      .map((e: { hooks: Array<{ command: string }> }) => e.hooks[0].command);
  }

  // findGitBashWindows() reads these off the real environment, so a Git
  // installed on a non-standard drive (or found only via the HKLM registry key)
  // would decide whether these cases run at all. Clear them and stage the one
  // candidate under the mocked home instead, so the gate assertions below are
  // the same on any developer box and on CI. WorkBuddy resolves its own MSYS
  // sh under ~/.workbuddy, which needs no environment at all.
  const winEnvKeys = ['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA'];
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    savedEnv = {};
    for (const key of winEnvKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    resetBundledRuntimeCache();
    await fse.ensureFile(path.join(home, 'AppData', 'Local', 'Programs', 'Git', 'bin', 'bash.exe'));
    await fse.ensureFile(path.join(home, '.workbuddy', 'binaries', 'PortableGit', 'versions', '9.9.9', 'bin', 'sh.exe'));
  });

  afterEach(async () => {
    for (const key of winEnvKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    resetBundledRuntimeCache();
  });

  const telemetryYaml = (tool: string): string => `
hooks:
  - id: telemetry
    description: inject telemetry
    event: Stop
    matcher: "*"
    command: python3 .docs/script/inject-telemetry.py
    tools: [${tool}]
`;

  it('renders the POSIX gate for codebuddy, which runs hooks through Git Bash', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    try {
      await writeYaml(telemetryYaml('codebuddy'));
      await fse.ensureDir(path.join(home, '.codebuddy'));
      await reconcileTeamHooksForConfig(codebuddyOnly, localConfig());

      const [command] = await teamStopCommands('.codebuddy/settings.json');
      expect(command.startsWith('if [ "$PWD" = ')).toBe(true);
      expect(command.endsWith('); fi')).toBe(true);
      // The runner names its cwd the MSYS way: on Windows that is `/c/...`,
      // never the `C:\...` this root resolves to, so the gate must carry both
      // spellings or it silently never fires. A root without a drive letter is
      // already the shell's spelling and the gate carries a single test, which
      // is what the suite's Linux and macOS jobs exercise.
      if (/^[A-Za-z]:[\\/]/.test(project)) {
        expect(command, 'a Windows root is tested in both spellings').toMatch(/\] \|\| \[ "\$PWD" = '\/[a-z]\//);
      } else {
        expect(command, 'a POSIX root needs one spelling').not.toContain(' || [ "$PWD" = ');
      }
      // 0.26.0 rendered a cmd.exe gate here. Git Bash cannot run it: `findstr`
      // errors out, the gate never matches, and the `>nul` redirect leaves a
      // file literally named `nul` in the project.
      expect(command).not.toContain('findstr');
      expect(command).not.toContain('exit /b 0');
    } finally {
      platformSpy.mockRestore();
    }
  });

  it('keeps the POSIX gate for a tool whose runner is not cmd.exe', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    try {
      await writeYaml(telemetryYaml('workbuddy'));
      await fse.ensureDir(path.join(home, '.workbuddy'));
      await reconcileTeamHooksForConfig(
        { toolPaths: { workbuddy: { settings: '.workbuddy/settings.json' } } } as unknown as TeamaiConfig,
        localConfig(),
      );

      const [command] = await teamStopCommands('.workbuddy/settings.json');
      expect(command.startsWith('if [ "$PWD" = ')).toBe(true);
      expect(command.endsWith('); fi')).toBe(true);
    } finally {
      platformSpy.mockRestore();
    }
  });

  /**
   * A real POSIX shell to run the gate with. Deliberately not the placeholder
   * `bash.exe` staged above: that file only has to make
   * `resolveCodebuddyShell()` report a shell and cannot execute anything. This
   * is the MSYS bash the machine actually has on PATH, found through the real
   * environment the staging did not touch.
   */
  const executor = process.platform === 'win32' ? findOnPath('bash') : '/bin/sh';

  /**
   * Where these cases build their directories — deliberately outside
   * `os.tmpdir()`. MSYS mounts the Windows temp directory at `/tmp`, so a root
   * under it is reported as `/tmp/...` and no gate rendered from its native
   * path can ever match it. `node_modules` sits on the workspace drive, which
   * is what a real project looks like, and is never committed.
   */
  const execBase = path.join(process.cwd(), 'node_modules');

  /** Render the gate for `root` and read it back off the tool's settings file. */
  async function renderGate(root: string): Promise<string> {
    // A fresh file per call: entries for another root are kept by design, and
    // this reads back exactly the gate just rendered.
    await fse.remove(path.join(home, '.codebuddy', 'settings.json'));
    await writeYaml(`
hooks:
  - id: gate
    description: gate probe
    event: Stop
    matcher: "*"
    command: echo TEAMAI_GATE_PAYLOAD
    tools: [codebuddy]
`);
    await fse.ensureDir(path.join(home, '.codebuddy'));
    await reconcileTeamHooksForConfig(codebuddyOnly, { ...localConfig(), projectRoot: root } as LocalConfig);
    const [command] = await teamStopCommands('.codebuddy/settings.json');
    expect(command).toBeDefined();
    return command;
  }

  /**
   * Run a rendered hook command the way the runner does: through its shell.
   * Async rather than `spawnSync` because a sandbox can fail the synchronous
   * spawn with EBUSY, which would show up here as an empty stdout — the exact
   * signature of a gate that never matched.
   */
  function runCommand(command: string, cwd: string): Promise<{ status: number | null; stdout: string }> {
    return new Promise((resolve) => {
      const child = spawn(executor!, ['-c', command], { cwd });
      let stdout = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; });
      child.on('close', (status) => resolve({ status, stdout }));
      child.on('error', () => resolve({ status: null, stdout }));
    });
  }

  it.skipIf(!executor)(
    'fires inside the project and stays an exit-0 no-op outside it, under a real shell',
    async () => {
      const execRoot = await fse.mkdtemp(path.join(execBase, '.teamai-gate-'));
      try {
        // `sp&x` and `x&echo CANARY&y` carry the characters that would split the
        // command if the gate did not quote the root; `sp ace` covers the space.
        for (const name of ['plain', 'sp&x', 'sp ace', 'x&echo CANARY&y']) {
          const root = path.join(execRoot, name);
          const sub = path.join(root, 'sub');
          const sibling = path.join(execRoot, `${name}-sibling`);
          await fse.ensureDir(sub);
          await fse.ensureDir(sibling);
          const command = await renderGate(root);

          // Inside: the gate matches and the payload runs. A gate rendered in
          // the native spelling only would silently never do this.
          for (const cwd of [root, sub]) {
            const { status, stdout } = await runCommand(command, cwd);
            expect(stdout, `${name} inside ${cwd}`).toContain('TEAMAI_GATE_PAYLOAD');
            expect(status, `${name} inside ${cwd}`).toBe(0);
            // A `&` in the directory name must never split the gate into
            // commands — the payload's own output is the canary for that.
            expect(stdout, `${name} injection canary`).not.toMatch(/^\s*CANARY\s*$/m);
          }
          // Outside: nothing runs, and the gate still exits 0 — CodeBuddy reads
          // a non-zero hook status as `allowed:false` and would block every
          // prompt typed outside the project.
          for (const cwd of [execRoot, sibling]) {
            const { status, stdout } = await runCommand(command, cwd);
            expect(stdout, `${name} outside ${cwd}`).not.toContain('TEAMAI_GATE_PAYLOAD');
            expect(status, `${name} outside ${cwd}`).toBe(0);
          }
        }
      } finally {
        // Some sandboxes refuse the bulk delete; a leftover empty directory
        // under node_modules is harmless.
        await fse.remove(execRoot).catch(() => {});
      }
    },
    // A Windows runner starts a fresh MSYS bash per call, which is far slower
    // than the cmd.exe the gate used to be tested with.
    60_000,
  );
});

describe('reconcileHooks — a hook a workspace holds back (#913)', () => {
  // Every format a HOME-installed tool's gated team hook is written in.
  it.each(['cursor', 'copilot', 'zcode', 'codebuddy', 'codex-internal'])(
    'gates a held hook in %s\'s file out of a child set up while it is held',
    async (tool) => {
      const root = await fse.realpath(project);
      const [svcA, svcB] = [path.join(root, 'svc-a'), path.join(root, 'svc-b')];
      await Promise.all([svcA, svcB].map((dir) => fse.ensureDir(dir)));
      const file = path.join(home, `${tool}-hooks.json`);
      const manifestPath = path.join(home, `${tool}-managed-hooks.json`);
      const hook: HookDef = { source: 'team', key: 'held-hook', event: 'Stop', command: 'echo held-ran', description: '[teamai:hook:held-hook] held' };
      const reconcile = (defs: HookDef[], childRoots: string[], heldTeamHookIds: string[] = []): Promise<void> =>
        reconcileHooks(file, tool, defs, { manifestPath, teamOnly: true, teamHookProjectRoot: root, teamHookChildRoots: childRoots, heldTeamHookIds });
      // Every string of the file that runs the hook: Copilot keeps it as bash, powershell and command.
      const commands = async (): Promise<string[]> => {
        const strings = (value: unknown): string[] => typeof value === 'string' ? [value]
          : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
        return strings(await fse.readJson(file)).filter((value) => value.includes('echo held-ran'));
      };
      const runIn = (command: string, cwd: string): string => execFileSync('sh', ['-c', command], { cwd, encoding: 'utf8', env: { ...process.env, PWD: cwd } });

      await reconcile([hook], [svcA]);
      const installed = await commands();
      await reconcile([], [svcA, svcB], ['held-hook']);

      const held = await commands();
      expect(held).toHaveLength(installed.length);
      for (const command of held) {
        expect(runIn(command, root)).toBe('held-ran\n');
        expect(runIn(command, svcA)).toBe('');
        expect(runIn(command, svcB)).toBe('');
      }
      // Once the hold ends, the same entry is the one teamai replaces: none is left beside it.
      await reconcile([hook], [svcA, svcB]);
      expect(await commands()).toEqual(held);
    },
  );

  it.each(['cursor', 'copilot', 'zcode', 'codebuddy', 'codex-internal'])(
    'keeps a held hook in %s\'s file whose command runs teamai',
    async (tool) => {
      const root = await fse.realpath(project);
      const file = path.join(home, `${tool}-hooks.json`);
      const manifestPath = path.join(home, `${tool}-managed-hooks.json`);
      const hook: HookDef = { source: 'team', key: 'held-hook', event: 'Stop', command: 'echo before && teamai pull --quiet && echo held-ran', description: '[teamai:hook:held-hook] held' };
      const reconcile = (defs: HookDef[], heldTeamHookIds: string[] = []): Promise<void> =>
        reconcileHooks(file, tool, defs, { manifestPath, teamHookProjectRoot: root, heldTeamHookIds });
      const commands = async (): Promise<string[]> => {
        const strings = (value: unknown): string[] => typeof value === 'string' ? [value]
          : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
        return strings(await fse.readJson(file)).filter((value) => value.includes('echo held-ran'));
      };

      await reconcile([hook]);
      const installed = await commands();
      expect(installed.length).toBeGreaterThan(0);
      await reconcile([], ['held-hook']);

      expect(await commands()).toEqual(installed);
      expect((await fse.readJson(manifestPath))[tool].map((r: { id: string }) => r.id)).toEqual(['held-hook']);
    },
  );

  it.each(['cursor', 'copilot', 'zcode', 'codebuddy', 'codex-internal'].flatMap((tool) => [
    [tool, 'echo before && teamai pull --quiet && echo held-ran', false],
    [tool, 'echo before && teamai pull --quiet && echo held-ran', true],
    [tool, 'echo held-ran', true],
  ] as const))(
    'keeps a held hook in %s\'s file whose record was lost, and records it again (command %j, child set up meanwhile: %s)',
    async (tool, command, childAdded) => {
      const root = await fse.realpath(project);
      const [svcA, svcB] = [path.join(root, 'svc-a'), path.join(root, 'svc-b')];
      await Promise.all([svcA, svcB].map((dir) => fse.ensureDir(dir)));
      const file = path.join(home, `${tool}-hooks.json`);
      const manifestPath = path.join(home, `${tool}-managed-hooks.json`);
      const hook: HookDef = { source: 'team', key: 'held-hook', event: 'Stop', command, description: '[teamai:hook:held-hook] held' };
      const commands = async (): Promise<string[]> => {
        const strings = (value: unknown): string[] => typeof value === 'string' ? [value]
          : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
        return strings(await fse.readJson(file)).filter((value) => value.includes('echo held-ran'));
      };
      const runIn = (shellCommand: string, cwd: string): string => execFileSync('sh', ['-c', shellCommand], { cwd, encoding: 'utf8', env: { ...process.env, PWD: cwd } });
      await reconcileHooks(file, tool, [hook], { manifestPath, teamHookProjectRoot: root, teamHookChildRoots: [svcA] });
      const installed = await commands();
      expect(installed.length).toBeGreaterThan(0);
      await fse.writeJson(manifestPath, {});

      const childRoots = childAdded ? [svcA, svcB] : [svcA];
      await reconcileHooks(file, tool, [], { manifestPath, teamHookProjectRoot: root, teamHookChildRoots: childRoots, heldTeamHookIds: ['held-hook'], teamHookHistory: async () => [hook] });

      const kept = await commands();
      expect(kept).toHaveLength(installed.length);
      if (!childAdded) expect(kept).toEqual(installed);
      // The hook keeps what it runs, and a child set up meanwhile is left out of it.
      for (const keptCommand of kept) {
        expect(keptCommand).toContain(command);
        for (const child of childRoots) expect(runIn(keptCommand, child)).toBe('');
      }
      const records = (await fse.readJson(manifestPath))[tool] as Array<{ id: string; command: string }> | undefined;
      expect(records?.map((r) => r.id)).toEqual(['held-hook']);
      expect(kept).toContain(records![0].command);
    },
  );

  it('keeps one entry for a held hook whose command another hook also had', async () => {
    const root = await fse.realpath(project);
    const file = path.join(home, '.cursor', 'hooks.json');
    const manifestPath = path.join(home, 'managed-hooks.json');
    const hook = (key: string, command: string): HookDef => ({ source: 'team', key, event: 'Stop', command, description: `[teamai:hook:${key}] ${key}` });
    await reconcileHooks(file, 'cursor', [hook('held-hook', 'echo same-command'), hook('other-hook', 'echo same-command')], { manifestPath, teamHookProjectRoot: root });

    await reconcileHooks(file, 'cursor', [hook('other-hook', 'echo changed-command')], { manifestPath, teamHookProjectRoot: root, heldTeamHookIds: ['held-hook'] });

    const commands = (await fse.readJson(file)).hooks.stop.map((entry: { command: string }) => entry.command);
    expect(commands.filter((c: string) => c.includes('echo same-command'))).toHaveLength(1);
    expect(commands.filter((c: string) => c.includes('echo changed-command'))).toHaveLength(1);
  });

  it('stops recording a held hook whose entry the member deleted', async () => {
    const root = await fse.realpath(project);
    const file = path.join(home, '.cursor', 'hooks.json');
    const manifestPath = path.join(home, 'managed-hooks.json');
    const hook: HookDef = { source: 'team', key: 'held-hook', event: 'Stop', command: 'echo held-ran', description: '[teamai:hook:held-hook] held' };
    await reconcileHooks(file, 'cursor', [hook], { manifestPath, teamHookProjectRoot: root });
    const hooksJson = await fse.readJson(file);
    hooksJson.hooks.stop = hooksJson.hooks.stop.filter((entry: { command: string }) => !entry.command.includes('echo held-ran'));
    await fse.writeJson(file, hooksJson);

    await reconcileHooks(file, 'cursor', [], { manifestPath, teamHookProjectRoot: root, heldTeamHookIds: ['held-hook'] });

    expect((await fse.readJson(manifestPath)).cursor).toBeUndefined();
  });

  it('keeps a held hook in DeepSeek Harness\'s bridge file', async () => {
    await fse.ensureDir(path.join(home, '.dsh'));
    const manifestPath = path.join(home, 'managed-hooks.json');
    const bridge = path.join(home, '.teamai', 'dsh', 'hooks.json');
    const hook: HookDef = { source: 'team', key: 'held-hook', event: 'Stop', command: 'echo held-ran', description: '[teamai:hook:held-hook] held' };
    const opts = { scope: 'project' as const, teamHookProjectRoot: await fse.realpath(project) };
    await reconcileHooksToAllTools({ dsh: {} }, home, [hook], manifestPath, opts);
    expect(await fse.readFile(bridge, 'utf8')).toContain('echo held-ran');

    await reconcileHooksToAllTools({ dsh: {} }, home, [], manifestPath, { ...opts, heldTeamHookIds: ['held-hook'] });

    expect(await fse.readFile(bridge, 'utf8')).toContain('echo held-ran');
    expect((await fse.readJson(manifestPath)).dsh.map((r: { id: string }) => r.id)).toEqual(['held-hook']);
  });
});
