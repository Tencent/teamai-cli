import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  detectProjectConfig: vi.fn().mockResolvedValue(null),
  loadLocalConfig: vi.fn(),
  loadTeamConfig: vi.fn(),
}));

vi.mock('@teamai/shared/log', () => ({
  log: {
    debug: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn(), dim: vi.fn(),
  },
  setStderrOnly: vi.fn(),
  isSilent: () => false,
  setSilent: vi.fn(),
}));

import { loadLocalConfig, loadTeamConfig } from '../config.js';
import { clearVersionCache } from '../agent-version.js';
import { buildChecks, resolveDoctorContext, type Check } from '../doctor.js';
import { getDataHome, managedMcpManifestKey, managedMcpManifestPath, type LocalConfig, type TeamaiConfig } from '../types.js';

/**
 * A tool that reads a project's files only once it trusts the project, or
 * starts its servers only once the member approves them: teamai's delivery is
 * on disk and inert until then, so doctor reads the tool's own verdict.
 */
describe('doctor — the tool trusts the project it reads team files from', () => {
  let tempDir: string;
  let homeDir: string;
  let repoPath: string;
  let projectRoot: string;
  let localConfig: LocalConfig;
  let teamConfig: TeamaiConfig;

  async function writeTeamSkill(name: string): Promise<void> {
    await fse.outputFile(path.join(repoPath, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n`);
  }

  /** A copy as pull leaves it in the project. */
  async function deliverSkill(relativeDir: string, name: string): Promise<void> {
    await fse.outputFile(path.join(projectRoot, relativeDir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n`);
  }

  async function check(name: string): Promise<Check | undefined> {
    const ctx = await resolveDoctorContext();
    if (!ctx) throw new Error('expected a resolved doctor context');
    return (await buildChecks(ctx)).find((c) => c.name === name);
  }

  beforeEach(async () => {
    tempDir = await fse.realpath(await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-read-gates-')));
    homeDir = path.join(tempDir, 'home');
    repoPath = path.join(tempDir, 'team-repo');
    projectRoot = path.join(tempDir, 'web-app');
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('PI_CODING_AGENT_DIR', undefined);
    vi.stubEnv('XDG_CONFIG_HOME', undefined);
    vi.stubEnv('COPILOT_HOME', undefined);
    vi.stubEnv('QODER_CONFIG_DIR', undefined);
    vi.stubEnv('QODER_CLI_HOME', undefined);
    await fse.ensureDir(projectRoot);
    await writeTeamSkill('release-notes');

    localConfig = {
      repo: { localPath: repoPath, remote: 'owner/repo' },
      username: 'tester',
      scope: 'project',
      projectRoot,
      additionalRoles: [],
    };
    teamConfig = {
      team: 'test',
      description: '',
      repo: 'owner/repo',
      provider: 'git',
      reviewers: [],
      sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: false } },
      toolPaths: {},
    };
    vi.mocked(loadLocalConfig).mockResolvedValue(localConfig);
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    clearVersionCache();
    vi.clearAllMocks();
    await fse.remove(tempDir);
  });

  // Pi 1.4.0 keeps `{ "<dir>": true | false }` in <agent dir>/trust.json, takes
  // the nearest entry walking up from the directory it starts in, and asks
  // `defaultProjectTrust` (settings.json) when none decides. `pi -p` treats
  // "ask" as untrusted.
  describe('Pi project trust', () => {
    const SKILLS = 'Pi trusts this project, so it loads its team skills';
    const trustFile = (): string => path.join(homeDir, '.pi', 'agent', 'trust.json');

    beforeEach(async () => {
      await fse.ensureDir(path.join(homeDir, '.pi', 'agent'));
      teamConfig.toolPaths = { pi: { skills: '.pi/skills' } };
      await deliverSkill('.pi/skills', 'release-notes');
    });

    it('warns while Pi has no verdict for the project, naming the skills and the line that trusts it', async () => {
      const found = await check(SKILLS);

      expect(await found?.check()).toBe('warn');
      expect(found?.fix).toContain(`${path.join(projectRoot, '.pi', 'skills')} holds team skills (release-notes)`);
      expect(found?.fix).toContain(trustFile());
      expect(found?.fix).toContain(`"${projectRoot}": true`);
    });

    it.each([
      ['the project', (): string => projectRoot],
      ['a folder above it', (): string => tempDir],
    ])('passes once trust.json trusts %s', async (_label, dir) => {
      await fse.outputJson(trustFile(), { [dir()]: true });

      expect(await (await check(SKILLS))?.check()).toBe(true);
    });

    it.skipIf(process.platform === 'win32')('has no verdict to wait for on a Pi older than 0.79.0, which loads project files untrusted', async () => {
      const bin = path.join(tempDir, 'bin');
      await fse.outputFile(path.join(bin, 'pi'), '#!/bin/sh\necho 0.78.1\n', { mode: 0o755 });
      vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
      clearVersionCache();

      expect(await (await check(SKILLS))?.check()).toBe(true);
    });

    it('fails on a nearer false entry, naming it, whatever a folder above says', async () => {
      await fse.outputJson(trustFile(), { [tempDir]: true, [projectRoot]: false });

      const found = await check(SKILLS);
      expect(await found?.check()).toBe(false);
      expect(found?.fix).toContain(`sets "${projectRoot}": false`);
    });

    it.each([
      ['always', true],
      ['never', false],
      ['ask', 'warn'],
    ])('with no entry, defaultProjectTrust "%s" decides', async (value, ok) => {
      await fse.outputJson(path.join(homeDir, '.pi', 'agent', 'settings.json'), { defaultProjectTrust: value });

      expect(await (await check(SKILLS))?.check()).toBe(ok);
    });

    it('reads trust.json from PI_CODING_AGENT_DIR', async () => {
      const agentDir = path.join(tempDir, 'pi-agent');
      vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
      await fse.outputJson(trustFile(), { [projectRoot]: true });

      const found = await check(SKILLS);
      expect(await found?.check()).toBe('warn');
      expect(found?.fix).toContain(path.join(agentDir, 'trust.json'));
    });

    it('says the verdict is unknown when trust.json holds a value Pi rejects', async () => {
      await fse.outputJson(trustFile(), { [projectRoot]: 'yes' });

      const found = await check(SKILLS);
      expect(await found?.check()).toBe(false);
      expect(found?.fix).toContain('whether Pi trusts this project is unknown');
    });

    it('fails, not warns, when trust.json is there but cannot be read', async () => {
      await fse.ensureDir(trustFile());

      const found = await check(SKILLS);
      expect(await found?.check()).toBe(false);
      expect(found?.fix).toContain(`${trustFile()} cannot be read`);
      expect(found?.fix).toContain('whether Pi trusts this project is unknown');
    });

    it('checks the project MCP servers too', async () => {
      teamConfig.toolPaths = { pi: { mcp: '.pi/agent/mcp.json', mcpProject: '.pi/mcp.json' } };
      await fse.outputFile(path.join(repoPath, 'mcp', 'mcp.yaml'), 'servers:\n  - name: issues\n    transport: stdio\n    command: issues-server\n');
      await fse.outputJson(path.join(projectRoot, '.pi', 'mcp.json'), { mcpServers: { issues: { command: 'issues-server' } } });
      await fse.outputJson(managedMcpManifestPath(getDataHome(localConfig), projectRoot), { [managedMcpManifestKey('pi', true)]: [{ name: 'issues', hash: 'h' }] });

      const found = await check('Pi trusts this project, so it loads its team MCP servers');
      expect(await found?.check()).toBe('warn');
      expect(found?.fix).toContain(`${path.join(projectRoot, '.pi', 'mcp.json')} holds team MCP servers (issues)`);
    });
  });

  // Muse Code 1.4.14 keeps `{ "schema_version": 1, "projects": { "<git root>":
  // { "decision": "trusted" | "untrusted" } } }` in $XDG_CONFIG_HOME/muse/trust.json,
  // keyed by the real path of the checkout's own git root, exact match only.
  // `muse exec` runs an undecided workspace untrusted.
  describe('Muse Code workspace trust', () => {
    const SKILLS = 'Muse Code trusts this project, so it loads its team skills';
    const trustFile = (): string => path.join(homeDir, '.config', 'muse', 'trust.json');
    const decided = (dir: string, decision: string): object => ({ schema_version: 1, projects: { [dir]: { decision } } });

    beforeEach(async () => {
      execFileSync('git', ['init', '-q'], { cwd: projectRoot });
      await fse.ensureDir(path.join(homeDir, '.config', 'muse'));
      teamConfig.toolPaths = { muse: { skills: '.agents/skills' } };
      await deliverSkill('.agents/skills', 'release-notes');
    });

    it('warns while Muse has no decision for the project, naming the entry that trusts it', async () => {
      const found = await check(SKILLS);

      expect(await found?.check()).toBe('warn');
      expect(found?.fix).toContain(`${path.join(projectRoot, '.agents', 'skills')} holds team skills (release-notes)`);
      expect(found?.fix).toContain(trustFile());
      expect(found?.fix).toContain(`"${projectRoot}": {"decision": "trusted"}`);
    });

    it('passes once Muse trusts the git root', async () => {
      await fse.outputJson(trustFile(), decided(projectRoot, 'trusted'));

      expect(await (await check(SKILLS))?.check()).toBe(true);
    });

    it('fails on a recorded "untrusted", which Muse never asks about again', async () => {
      await fse.outputJson(trustFile(), decided(projectRoot, 'untrusted'));

      const found = await check(SKILLS);
      expect(await found?.check()).toBe(false);
      expect(found?.fix).toContain('records "untrusted"');
    });

    it('does not count a trusted parent folder', async () => {
      await fse.outputJson(trustFile(), decided(tempDir, 'trusted'));

      expect(await (await check(SKILLS))?.check()).toBe('warn');
    });

    it('wants an entry of its own for a linked worktree', async () => {
      const git = (...args: string[]): void => {
        execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: projectRoot });
      };
      git('commit', '-q', '--allow-empty', '-m', 'init');
      const main = projectRoot;
      const worktree = path.join(tempDir, 'web-app-review');
      git('worktree', 'add', '-q', worktree);
      Object.assign(localConfig, { projectRoot: worktree });
      projectRoot = worktree;
      await deliverSkill('.agents/skills', 'release-notes');
      await fse.outputJson(trustFile(), decided(main, 'trusted'));

      const found = await check(SKILLS);
      expect(await found?.check()).toBe('warn');
      expect(found?.fix).toContain(`"${worktree}": {"decision": "trusted"}`);
    });

    it('reads trust.json under XDG_CONFIG_HOME', async () => {
      const xdg = path.join(tempDir, 'xdg');
      vi.stubEnv('XDG_CONFIG_HOME', xdg);
      await fse.ensureDir(path.join(xdg, 'muse'));
      await fse.outputJson(path.join(xdg, 'muse', 'trust.json'), decided(projectRoot, 'trusted'));

      expect(await (await check(SKILLS))?.check()).toBe(true);
    });

    it('checks the team MCP servers it reads from the project .mcp.json', async () => {
      teamConfig.toolPaths = { claude: { mcp: '.claude.json', mcpProject: '.mcp.json' }, muse: { mcp: '.config/muse/settings.json' } };
      await fse.outputFile(path.join(repoPath, 'mcp', 'mcp.yaml'), 'servers:\n  - name: issues\n    transport: stdio\n    command: issues-server\n');
      await fse.outputJson(path.join(projectRoot, '.mcp.json'), { mcpServers: { issues: { type: 'stdio', command: 'issues-server' } } });
      await fse.outputJson(managedMcpManifestPath(getDataHome(localConfig), projectRoot), { [managedMcpManifestKey('claude', true)]: [{ name: 'issues', hash: 'h' }] });

      const found = await check('Muse Code trusts this project, so it loads its team MCP servers');
      expect(await found?.check()).toBe('warn');
      expect(found?.fix).toContain(`${path.join(projectRoot, '.mcp.json')} holds team MCP servers (issues)`);
    });

    it('asks nothing of a Muse that is not installed, though the project .mcp.json it would read holds team servers', async () => {
      await fse.remove(path.join(homeDir, '.config', 'muse'));
      teamConfig.toolPaths = { claude: { mcp: '.claude.json', mcpProject: '.mcp.json' }, muse: { mcp: '.config/muse/settings.json' } };
      await fse.outputFile(path.join(repoPath, 'mcp', 'mcp.yaml'), 'servers:\n  - name: issues\n    transport: stdio\n    command: issues-server\n');
      await fse.outputJson(path.join(projectRoot, '.mcp.json'), { mcpServers: { issues: { type: 'stdio', command: 'issues-server' } } });
      await fse.outputJson(managedMcpManifestPath(getDataHome(localConfig), projectRoot), { [managedMcpManifestKey('claude', true)]: [{ name: 'issues', hash: 'h' }] });

      expect(await check('Muse Code trusts this project, so it loads its team MCP servers')).toBeUndefined();
    });

    it('checks teamai\'s hooks in a self-mode project\'s .muse/hooks.json', async () => {
      Object.assign(localConfig, { repo: { kind: 'self', localPath: projectRoot, remote: 'owner/repo' } });
      teamConfig.toolPaths = { muse: { settings: '.muse/hooks.json' } };
      const hooksFile = path.join(projectRoot, '.muse', 'hooks.json');
      await fse.outputJson(hooksFile, { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'teamai hook-dispatch session-start' }] }] } });

      const found = await check('Muse Code trusts this project, so it loads its team hooks');
      expect(await found?.check()).toBe('warn');
      expect(found?.fix).toContain(`${hooksFile} holds teamai's hooks`);
    });
  });
  // Copilot CLI 1.0.105 keeps `trustedFolders` (and the older `trusted_folders`)
  // in $COPILOT_HOME/config.json, a JSON file it heads with `//` comment lines.
  // An entry covers its folder and every folder under it, by real path, and a
  // linked worktree takes its main checkout's. Workspace MCP and repo hooks
  // wait for it; `copilot -p` skips them.
  describe('Copilot CLI folder trust', () => {
    const MCP = 'Copilot CLI trusts this folder, so it loads its team MCP servers';
    const configFile = (): string => path.join(homeDir, '.copilot', 'config.json');
    const writeConfig = async (body: object): Promise<void> => {
      await fse.outputFile(configFile(), `// User settings belong in settings.json.\n// This file is managed automatically.\n${JSON.stringify(body, null, 2)}\n`);
    };

    beforeEach(async () => {
      execFileSync('git', ['init', '-q'], { cwd: projectRoot });
      await fse.ensureDir(path.join(homeDir, '.copilot'));
      teamConfig.toolPaths = { copilot: { mcp: '.copilot/mcp-config.json', mcpProject: '.github/mcp.json' } };
      await fse.outputFile(path.join(repoPath, 'mcp', 'mcp.yaml'), 'servers:\n  - name: issues\n    transport: stdio\n    command: issues-server\n');
      await fse.outputJson(path.join(projectRoot, '.github', 'mcp.json'), { mcpServers: { issues: { type: 'local', command: 'issues-server', args: [], tools: ['*'] } } });
      await fse.outputJson(managedMcpManifestPath(getDataHome(localConfig), projectRoot), { [managedMcpManifestKey('copilot', true)]: [{ name: 'issues', hash: 'h' }] });
    });

    it('warns while no trusted folder covers the project, naming the folder to add', async () => {
      await writeConfig({ firstLaunchAt: '2026-11-02T04:32:36.393Z' });

      const found = await check(MCP);
      expect(await found?.check()).toBe('warn');
      expect(found?.fix).toContain(`${path.join(projectRoot, '.github', 'mcp.json')} holds team MCP servers (issues)`);
      expect(found?.fix).toContain(`add "${projectRoot}" to "trustedFolders" in ${configFile()}`);
    });

    it.each([
      ['the project', (): object => ({ trustedFolders: [projectRoot] })],
      ['a folder above it', (): object => ({ trustedFolders: [tempDir] })],
      ['the project, under the older key', (): object => ({ trusted_folders: [projectRoot] })],
    ])('passes once config.json trusts %s', async (_label, body) => {
      await writeConfig(body());

      expect(await (await check(MCP))?.check()).toBe(true);
    });

    it('does not take a sibling folder that shares the name as a prefix', async () => {
      await writeConfig({ trustedFolders: [`${projectRoot}-old`] });

      expect(await (await check(MCP))?.check()).toBe('warn');
    });

    it('passes in a linked worktree whose main checkout is trusted', async () => {
      const git = (...args: string[]): void => {
        execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: projectRoot });
      };
      git('commit', '-q', '--allow-empty', '-m', 'init');
      const main = projectRoot;
      const worktree = path.join(tempDir, 'web-app-review');
      git('worktree', 'add', '-q', worktree);
      Object.assign(localConfig, { projectRoot: worktree });
      await fse.copy(path.join(main, '.github'), path.join(worktree, '.github'));
      await fse.outputJson(managedMcpManifestPath(getDataHome(localConfig), worktree), { [managedMcpManifestKey('copilot', true)]: [{ name: 'issues', hash: 'h' }] });
      await writeConfig({ trustedFolders: [main] });

      expect(await (await check(MCP))?.check()).toBe(true);
    });

    it('reads config.json from COPILOT_HOME', async () => {
      const copilotHome = path.join(tempDir, 'copilot-home');
      vi.stubEnv('COPILOT_HOME', copilotHome);
      await writeConfig({ trustedFolders: [projectRoot] });

      const found = await check(MCP);
      expect(await found?.check()).toBe('warn');
      expect(found?.fix).toContain(path.join(copilotHome, 'config.json'));
    });

    it('says the verdict is unknown when config.json does not parse', async () => {
      await fse.outputFile(configFile(), '{ "trustedFolders": [\n');

      const found = await check(MCP);
      expect(await found?.check()).toBe(false);
      expect(found?.fix).toContain('whether Copilot CLI trusts this project is unknown');
    });

    it.each([
      ['a workspace', { kind: 'git', localPath: '' }],
      ['self mode', { kind: 'self', localPath: '' }],
    ])('checks teamai\'s repo hooks in %s', async (_label, repo) => {
      Object.assign(localConfig, { repo: { ...repo, localPath: repo.kind === 'self' ? projectRoot : repoPath, remote: 'owner/repo' } });
      teamConfig.toolPaths = { copilot: { hooks: '.github/hooks/teamai.json' } };
      const hooksFile = path.join(projectRoot, '.github', 'hooks', 'teamai.json');
      await fse.outputJson(hooksFile, { version: 1, hooks: { sessionStart: [{ type: 'command', bash: 'teamai hook-dispatch session-start' }] } });
      await writeConfig({});

      const found = await check('Copilot CLI trusts this folder, so it loads its team hooks');
      expect(await found?.check()).toBe('warn');
      expect(found?.fix).toContain(`${hooksFile} holds teamai's hooks`);
    });
  });
  // Qoder CLI 1.1.81 ignores a project's .qoder/settings.json (its MCP servers
  // and hooks) in an interactive session until a user-settings
  // `permissions.trustDirectories` entry covers the folder, by real path.
  // `qodercli -p` takes every folder as trusted.
  describe('Qoder CLI folder trust', () => {
    const TRUST = 'Qoder CLI trusts this folder, so it loads its team MCP servers';
    const userSettings = (): string => path.join(homeDir, '.qoder', 'settings.json');

    beforeEach(async () => {
      await fse.ensureDir(path.join(homeDir, '.qoder'));
      teamConfig.toolPaths = { qoder: { mcp: '.qoder/settings.json', mcpProject: '.qoder/settings.json' } };
      await fse.outputFile(path.join(repoPath, 'mcp', 'mcp.yaml'), 'servers:\n  - name: issues\n    transport: stdio\n    command: issues-server\n');
      await fse.outputJson(path.join(projectRoot, '.qoder', 'settings.json'), { mcpServers: { issues: { type: 'stdio', command: 'issues-server' } } });
      await fse.outputJson(managedMcpManifestPath(getDataHome(localConfig), projectRoot), { [managedMcpManifestKey('qoder', true)]: [{ name: 'issues', hash: 'h' }] });
    });

    it('warns while no trusted directory covers the project, naming the entry to add', async () => {
      await fse.outputJson(userSettings(), { permissions: { trustDirectories: [] } });

      const found = await check(TRUST);
      expect(await found?.check()).toBe('warn');
      expect(found?.fix).toContain(`${path.join(projectRoot, '.qoder', 'settings.json')} holds team MCP servers (issues)`);
      expect(found?.fix).toContain(`add "${projectRoot}" to permissions.trustDirectories in ${userSettings()}`);
    });

    it.each([
      ['a trusted folder above it', (): object => ({ permissions: { trustDirectories: [tempDir] } })],
      ['folder trust switched off', (): object => ({ security: { folderTrust: { enabled: false } } })],
    ])('passes with %s', async (_label, body) => {
      await fse.outputJson(userSettings(), body());

      expect(await (await check(TRUST))?.check()).toBe(true);
    });

    // qodercli 1.1.81 strips comments from settings.json before JSON.parse.
    it('reads a commented user settings.json as Qoder CLI does', async () => {
      await fse.outputFile(userSettings(), `{\n  // the member's note\n  "permissions": { "trustDirectories": [${JSON.stringify(projectRoot)}] }\n}\n`);

      expect(await (await check(TRUST))?.check()).toBe(true);
    });

    it('does not take the project\'s own settings as trust', async () => {
      await fse.outputJson(path.join(projectRoot, '.qoder', 'settings.local.json'), { permissions: { trustDirectories: [projectRoot] } });

      expect(await (await check(TRUST))?.check()).toBe('warn');
    });

    it('reads the user settings from QODER_CONFIG_DIR', async () => {
      const qoderHome = path.join(tempDir, 'qoder-home');
      vi.stubEnv('QODER_CONFIG_DIR', qoderHome);
      await fse.outputJson(path.join(qoderHome, 'settings.json'), { permissions: { trustDirectories: [projectRoot] } });

      expect(await (await check(TRUST))?.check()).toBe(true);
    });

    it('checks teamai\'s hooks in a self-mode project\'s .qoder/settings.json', async () => {
      Object.assign(localConfig, { repo: { kind: 'self', localPath: projectRoot, remote: 'owner/repo' } });
      teamConfig.toolPaths = { qoder: { settings: '.qoder/settings.json' } };
      await fse.outputJson(path.join(projectRoot, '.qoder', 'settings.json'), { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'teamai hook-dispatch session-start' }] }] } });

      const found = await check('Qoder CLI trusts this folder, so it loads its team hooks');
      expect(await found?.check()).toBe('warn');
    });

    // Approval is by server name across every project: `mcp.enabledProjectMcpServers`,
    // `mcp.disabledProjectMcpServers` and `mcp.enableAllProjectMcpServers` in the
    // user, project and local settings. A rejected server stays off in `-p` too.
    describe('MCP approval', () => {
      const APPROVAL = 'Qoder CLI approves this project\'s team MCP servers';

      it('warns while the server waits for approval, naming it and the key', async () => {
        await fse.outputJson(userSettings(), { permissions: { trustDirectories: [projectRoot] } });

        const found = await check(APPROVAL);
        expect(await found?.check()).toBe('warn');
        expect(found?.fix).toContain('issues waits for approval');
        expect(found?.fix).toContain(`mcp.enabledProjectMcpServers in ${userSettings()}`);
      });

      it.each([
        ['by name', { enabledProjectMcpServers: ['issues'] }],
        ['all at once', { enableAllProjectMcpServers: true }],
      ])('passes once the user settings approve it %s', async (_label, mcp) => {
        await fse.outputJson(userSettings(), { permissions: { trustDirectories: [projectRoot] }, mcp });

        expect(await (await check(APPROVAL))?.check()).toBe(true);
      });

      it('reads an approval in a commented settings.json', async () => {
        await fse.outputFile(userSettings(), `{\n  /* trusted */ "permissions": { "trustDirectories": [${JSON.stringify(projectRoot)}] },\n  // approved\n  "mcp": { "enabledProjectMcpServers": ["issues"] }\n}\n`);

        expect(await (await check(APPROVAL))?.check()).toBe(true);
      });

      it('fails on a rejection in the project settings, whatever the user settings approve', async () => {
        await fse.outputJson(userSettings(), { mcp: { enableAllProjectMcpServers: true } });
        await fse.outputJson(path.join(projectRoot, '.qoder', 'settings.local.json'), { mcp: { disabledProjectMcpServers: ['issues'] } });

        const found = await check(APPROVAL);
        expect(await found?.check()).toBe(false);
        expect(found?.fix).toContain('issues was rejected');
        expect(found?.fix).toContain('qodercli mcp reset-project-choices');
      });
    });
  });
  // Claude Code 2.1.316 starts a project's .mcp.json server in an interactive
  // session only once it is approved: `disabledMcpjsonServers` in any settings
  // file rejects it; `enabledMcpjsonServers` or `enableAllProjectMcpServers`
  // approves it, from ~/.claude/settings.json always, and from the project's
  // own settings only once ~/.claude.json trusts the main checkout. `claude -p`
  // starts a pending one anyway.
  // Claude Code 2.1.316 runs no hooks while the settings file that decides sets
  // `disableAllHooks`: the checkout's .claude/settings.local.json, then its
  // .claude/settings.json, then the user's. Checked with `claude -p`.
  describe('Claude Code hooks switch', () => {
    const HOOKS = 'Claude Code has not turned hooks off with disableAllHooks';
    const hook = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'teamai hook-dispatch session-start' }] }] } };
    const projectSettings = (): string => path.join(projectRoot, '.claude', 'settings.json');
    const localSettings = (): string => path.join(projectRoot, '.claude', 'settings.local.json');

    beforeEach(async () => {
      await fse.ensureDir(path.join(homeDir, '.claude'));
      Object.assign(localConfig, { repo: { kind: 'self', localPath: projectRoot, remote: 'owner/repo' } });
      teamConfig.toolPaths = { claude: { settings: '.claude/settings.json' } };
      await fse.outputJson(projectSettings(), hook);
    });

    it('passes while no settings file turns hooks off', async () => {
      expect(await (await check(HOOKS))?.check()).toBe(true);
    });

    it('fails while the local settings turn hooks off, naming the file', async () => {
      await fse.outputJson(localSettings(), { disableAllHooks: true });

      const found = await check(HOOKS);
      expect(await found?.check()).toBe(false);
      expect(found?.fix).toContain(`${projectSettings()} holds teamai's hooks`);
      expect(found?.fix).toContain(`Remove "disableAllHooks" from ${localSettings()}`);
    });

    it('takes the local settings over the project\'s', async () => {
      await fse.outputJson(projectSettings(), { ...hook, disableAllHooks: true });
      await fse.outputJson(localSettings(), { disableAllHooks: false });

      expect(await (await check(HOOKS))?.check()).toBe(true);
    });

    it('fails while only the user settings turn hooks off', async () => {
      await fse.outputJson(path.join(homeDir, '.claude', 'settings.json'), { disableAllHooks: true });

      expect(await (await check(HOOKS))?.check()).toBe(false);
    });

    it('checks the team hooks a team-repo project keeps in the user settings, which the project\'s settings can turn off', async () => {
      Object.assign(localConfig, { repo: { localPath: repoPath, remote: 'owner/repo' } });
      teamConfig.toolPaths = { claude: { settings: '.claude/settings.json' } };
      const userSettings = path.join(homeDir, '.claude', 'settings.json');
      await fse.outputJson(userSettings, hook);
      await fse.outputJson(localSettings(), { disableAllHooks: true });

      const found = await check(HOOKS);
      expect(await found?.check()).toBe(false);
      expect(found?.fix).toContain(`${userSettings} holds teamai's hooks`);
    });
  });

  describe('Claude Code MCP approval', () => {
    const APPROVAL = 'Claude Code approves this project\'s team MCP servers';
    const userSettings = (): string => path.join(homeDir, '.claude', 'settings.json');
    const claudeJson = (): string => path.join(homeDir, '.claude.json');
    const trust = async (dir: string): Promise<void> => {
      await fse.outputJson(claudeJson(), { projects: { [dir]: { hasTrustDialogAccepted: true } } });
    };

    beforeEach(async () => {
      execFileSync('git', ['init', '-q'], { cwd: projectRoot });
      await fse.ensureDir(path.join(homeDir, '.claude'));
      teamConfig.toolPaths = { claude: { mcp: '.claude.json', mcpProject: '.mcp.json' } };
      await fse.outputFile(path.join(repoPath, 'mcp', 'mcp.yaml'), 'servers:\n  - name: issues\n    transport: stdio\n    command: issues-server\n');
      await fse.outputJson(path.join(projectRoot, '.mcp.json'), { mcpServers: { issues: { type: 'stdio', command: 'issues-server' } } });
      await fse.outputJson(managedMcpManifestPath(getDataHome(localConfig), projectRoot), { [managedMcpManifestKey('claude', true)]: [{ name: 'issues', hash: 'h' }] });
    });

    it('warns in an untrusted project, naming the trust dialog and the file that approves without it', async () => {
      const found = await check(APPROVAL);

      expect(await found?.check()).toBe('warn');
      expect(found?.fix).toContain(`${path.join(projectRoot, '.mcp.json')} holds team MCP servers (issues)`);
      expect(found?.fix).toContain('issues waits for approval');
      expect(found?.fix).toContain(`${claudeJson()} does not trust ${projectRoot}`);
      expect(found?.fix).toContain(`enabledMcpjsonServers in ${userSettings()}`);
    });

    it('passes once the project is trusted and its local settings approve the server', async () => {
      await trust(projectRoot);
      await fse.outputJson(path.join(projectRoot, '.claude', 'settings.local.json'), { enabledMcpjsonServers: ['issues'] });

      expect(await (await check(APPROVAL))?.check()).toBe(true);
    });

    it('does not take the local settings\' approval while the project is untrusted', async () => {
      await fse.outputJson(path.join(projectRoot, '.claude', 'settings.local.json'), { enableAllProjectMcpServers: true });

      expect(await (await check(APPROVAL))?.check()).toBe('warn');
    });

    it('passes when the user settings approve the server, trusted or not', async () => {
      await fse.outputJson(userSettings(), { enabledMcpjsonServers: ['issues'] });

      expect(await (await check(APPROVAL))?.check()).toBe(true);
    });

    it('fails on a rejection in any settings file, naming it and how to be asked again', async () => {
      await trust(projectRoot);
      await fse.outputJson(userSettings(), { enableAllProjectMcpServers: true });
      const projectSettings = path.join(projectRoot, '.claude', 'settings.json');
      await fse.outputJson(projectSettings, { disabledMcpjsonServers: ['issues'] });

      const found = await check(APPROVAL);
      expect(await found?.check()).toBe(false);
      expect(found?.fix).toContain('issues was rejected');
      expect(found?.fix).toContain(`disabledMcpjsonServers in ${projectSettings}`);
      expect(found?.fix).toContain('claude mcp reset-project-choices');
    });

    it('in a linked worktree, reads the trust and local approval of the main checkout', async () => {
      const git = (...args: string[]): void => {
        execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: projectRoot });
      };
      git('commit', '-q', '--allow-empty', '-m', 'init');
      const main = projectRoot;
      const worktree = path.join(tempDir, 'web-app-review');
      git('worktree', 'add', '-q', worktree);
      Object.assign(localConfig, { projectRoot: worktree });
      await fse.copy(path.join(main, '.mcp.json'), path.join(worktree, '.mcp.json'));
      await fse.outputJson(managedMcpManifestPath(getDataHome(localConfig), worktree), { [managedMcpManifestKey('claude', true)]: [{ name: 'issues', hash: 'h' }] });
      await trust(main);
      await fse.outputJson(path.join(main, '.claude', 'settings.local.json'), { enabledMcpjsonServers: ['issues'] });

      expect(await (await check(APPROVAL))?.check()).toBe(true);
    });

    it('builds no check while the servers go to the local scope in ~/.claude.json', async () => {
      Object.assign(localConfig, { gitExcludeEnabled: true });
      await fse.outputJson(claudeJson(), { projects: { [projectRoot]: { mcpServers: { issues: { type: 'stdio', command: 'issues-server' } } } } });

      expect(await check(APPROVAL)).toBeUndefined();
    });
  });
  // CodeBuddy Code 2.179.1 reads the approval of a project's .mcp.json servers
  // from <session cwd>/.codebuddy/settings.local.json only (or
  // $CODEBUDDY_PROJECT_CONFIG_DIR/settings.local.json), and holds a pending
  // server back in `codebuddy -p` too.
  describe('CodeBuddy Code MCP approval', () => {
    const APPROVAL = 'CodeBuddy Code approves this project\'s team MCP servers';
    const localSettings = (): string => path.join(projectRoot, '.codebuddy', 'settings.local.json');

    beforeEach(async () => {
      vi.stubEnv('CODEBUDDY_CONFIG_DIR', undefined);
      vi.stubEnv('CODEBUDDY_PROJECT_CONFIG_DIR', undefined);
      await fse.ensureDir(path.join(homeDir, '.codebuddy'));
      teamConfig.toolPaths = { codebuddy: { mcp: '.codebuddy/.mcp.json', mcpProject: '.mcp.json' } };
      await fse.outputFile(path.join(repoPath, 'mcp', 'mcp.yaml'), 'servers:\n  - name: issues\n    transport: stdio\n    command: issues-server\n');
      await fse.outputJson(path.join(projectRoot, '.mcp.json'), { mcpServers: { issues: { type: 'stdio', command: 'issues-server' } } });
      await fse.outputJson(managedMcpManifestPath(getDataHome(localConfig), projectRoot), { [managedMcpManifestKey('codebuddy', true)]: [{ name: 'issues', hash: 'h' }] });
    });

    it('warns while the server waits for approval, naming the file that approves it', async () => {
      const found = await check(APPROVAL);

      expect(await found?.check()).toBe('warn');
      expect(found?.fix).toContain(`${path.join(projectRoot, '.mcp.json')} holds team MCP servers (issues)`);
      expect(found?.fix).toContain('issues waits for approval');
      expect(found?.fix).toContain(`enabledMcpjsonServers in ${localSettings()}`);
    });

    it.each([
      ['by name', { enabledMcpjsonServers: ['issues'] }],
      ['all at once', { enableAllProjectMcpServers: true }],
    ])('passes once the project\'s local settings approve it %s', async (_label, settings) => {
      await fse.outputJson(localSettings(), settings);

      expect(await (await check(APPROVAL))?.check()).toBe(true);
    });

    // CodeBuddy Code 2.179.1 reads its settings with jsonc-parser, trailing commas allowed.
    it('reads an approval in a commented settings.local.json', async () => {
      await fse.outputFile(localSettings(), '{\n  // approved by hand\n  "enabledMcpjsonServers": ["issues",],\n}\n');

      expect(await (await check(APPROVAL))?.check()).toBe(true);
    });

    it('fails on a rejection, whatever approves all', async () => {
      await fse.outputJson(localSettings(), { enableAllProjectMcpServers: true, disabledMcpjsonServers: ['issues'] });

      const found = await check(APPROVAL);
      expect(await found?.check()).toBe(false);
      expect(found?.fix).toContain('issues was rejected');
    });

    it('does not take an approval in the user settings, which CodeBuddy ignores for this', async () => {
      await fse.outputJson(path.join(homeDir, '.codebuddy', 'settings.json'), { enabledMcpjsonServers: ['issues'] });

      expect(await (await check(APPROVAL))?.check()).toBe('warn');
    });

    it('reads the approval from CODEBUDDY_PROJECT_CONFIG_DIR, resolved from the project', async () => {
      vi.stubEnv('CODEBUDDY_PROJECT_CONFIG_DIR', 'alt');
      await fse.outputJson(path.join(projectRoot, 'alt', 'settings.local.json'), { enabledMcpjsonServers: ['issues'] });

      expect(await (await check(APPROVAL))?.check()).toBe(true);
    });

    it('builds no check while the servers go to the local scope in ~/.codebuddy.json', async () => {
      Object.assign(localConfig, { gitExcludeEnabled: true });
      await fse.outputJson(path.join(homeDir, '.codebuddy.json'), { projects: { [projectRoot]: { mcpServers: { issues: { type: 'stdio', command: 'issues-server' } } } } });

      expect(await check(APPROVAL)).toBeUndefined();
    });
  });
  // Cursor CLI 2026.10.21 keeps, per project, `mcp-approvals.json` (`<name>-<hash
  // of the parsed server>`) and `mcp-disabled.json` (names it never loads) in
  // ~/.cursor/projects/<real git root, non-alphanumerics as "-">/. The hash
  // covers env values of the shell Cursor runs in, so doctor reads names only.
  describe('Cursor CLI MCP approval', () => {
    const APPROVAL = 'Cursor CLI approves this project\'s team MCP servers';
    const projectDir = (): string => path.join(homeDir, '.cursor', 'projects', projectRoot.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, ''));

    beforeEach(async () => {
      execFileSync('git', ['init', '-q'], { cwd: projectRoot });
      await fse.ensureDir(path.join(homeDir, '.cursor'));
      teamConfig.toolPaths = { cursor: { mcp: '.cursor/mcp.json', mcpProject: '.cursor/mcp.json' } };
      await fse.outputFile(path.join(repoPath, 'mcp', 'mcp.yaml'), 'servers:\n  - name: issues\n    transport: stdio\n    command: issues-server\n');
      await fse.outputJson(path.join(projectRoot, '.cursor', 'mcp.json'), { mcpServers: { issues: { command: 'issues-server' } } });
      await fse.outputJson(managedMcpManifestPath(getDataHome(localConfig), projectRoot), { [managedMcpManifestKey('cursor', true)]: [{ name: 'issues', hash: 'h' }] });
    });

    it('fails while the member declined the server, naming the command that enables it', async () => {
      await fse.outputJson(path.join(projectDir(), 'mcp-disabled.json'), ['issues']);

      const found = await check(APPROVAL);
      expect(await found?.check()).toBe(false);
      expect(found?.fix).toContain('issues was rejected');
      expect(found?.fix).toContain('cursor-agent mcp enable issues');
    });

    it('warns when the CLI approved other servers here and not this one', async () => {
      await fse.outputJson(path.join(projectDir(), 'mcp-approvals.json'), ['docs-9e751cee26e3f96a']);

      const found = await check(APPROVAL);
      expect(await found?.check()).toBe('warn');
      expect(found?.fix).toContain('issues waits for approval');
    });

    // Cursor CLI 2026.10.21 approves `<name>-<16 hex>`: sha256 of JSON.stringify({ path: <project root>, server: <its .cursor/mcp.json entry> }).
    const cursorKey = (name: string, server: object): string =>
      `${name}-${createHash('sha256').update(JSON.stringify({ path: projectRoot, server })).digest('hex').slice(0, 16)}`;

    it('passes once the CLI approved the server as the project defines it now', async () => {
      await fse.outputJson(path.join(projectDir(), 'mcp-approvals.json'), [cursorKey('issues', { command: 'issues-server' })]);

      expect(await (await check(APPROVAL))?.check()).toBe(true);
    });

    it('reads a commented .cursor/mcp.json as the CLI does, so an approved server counts as approved', async () => {
      await fse.outputFile(path.join(projectRoot, '.cursor', 'mcp.json'), '{\n  // the member\'s note\n  "mcpServers": {\n    "issues": { "command": "issues-server", },\n  },\n}\n');
      await fse.outputJson(path.join(projectDir(), 'mcp-approvals.json'), [cursorKey('issues', { command: 'issues-server' })]);

      expect(await (await check(APPROVAL))?.check()).toBe(true);
    });

    it('warns when the approval is for an earlier definition of the server, which the CLI asks about again', async () => {
      await fse.outputJson(path.join(projectDir(), 'mcp-approvals.json'), [cursorKey('issues', { command: 'old-issues-server' })]);

      const found = await check(APPROVAL);
      expect(await found?.check()).toBe('warn');
      expect(found?.fix).toContain('issues waits for approval');
    });

    describe('a server whose definition reads the env, which the CLI hashes resolved', () => {
      const entry = { command: 'issues-server', args: ['--org=${ISSUES_ORG:-acme}'], env: { TOKEN: '${env:ISSUES_TOKEN}' } };

      beforeEach(async () => {
        vi.stubEnv('ISSUES_TOKEN', 'abc');
        vi.stubEnv('ISSUES_ORG', undefined);
        await fse.outputJson(path.join(projectRoot, '.cursor', 'mcp.json'), { mcpServers: { issues: entry } });
      });

      it('passes once the CLI approved it as this env resolves it', async () => {
        const resolved = { command: 'issues-server', args: ['--org=acme'], env: { TOKEN: 'abc' } };
        await fse.outputJson(path.join(projectDir(), 'mcp-approvals.json'), [cursorKey('issues', resolved)]);

        expect(await (await check(APPROVAL))?.check()).toBe(true);
      });

      it('fails on an approval of an earlier definition, naming the env doctor resolved it with', async () => {
        const earlier = { command: 'issues-server', args: [], env: { TOKEN: 'abc' } };
        await fse.outputJson(path.join(projectDir(), 'mcp-approvals.json'), [cursorKey('issues', earlier)]);

        const found = await check(APPROVAL);
        expect(await found?.check()).toBe('warn');
        expect(found?.fix).toContain('issues waits for approval');
        expect(found?.fix).toContain('with the env of this shell');
      });
    });

    it('warns with no approvals for the project once the CLI has run on this machine', async () => {
      await fse.outputJson(path.join(homeDir, '.cursor', 'cli-config.json'), { version: 1 });

      const found = await check(APPROVAL);
      expect(await found?.check()).toBe('warn');
      expect(found?.fix).toContain('issues waits for approval');
    });

    it('passes while the CLI has never run on this machine, as for a member on the Cursor IDE', async () => {
      expect(await (await check(APPROVAL))?.check()).toBe(true);
    });
  });
});
