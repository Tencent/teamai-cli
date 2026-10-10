import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectHomeInstalledAgents, KNOWN_AGENTS } from '../known-agents.js';
import { mcpTargetExcluded, reconcileMcpForConfig, resolveMcpTargets } from '../mcp-reconcile.js';
import { isToolInstalledForConfig } from '../resources/base.js';
import { ALL_SUPPORTED_TOOLS } from '../resources/agent-format.js';
import { detectMcpFormat } from '../resources/mcp-format.js';
import { ruleFileExtensionForTool, ruleFormatForTool, usesMdcRules } from '../resources/rule-format.js';
import { RulesHandler } from '../resources/rules.js';
import { openLedger } from '../resources/delivered-copies.js';
import { loadStateForScope, saveStateForScope } from '../config.js';
import { checkoutKey } from '../pull.js';
import { getDataHome, managedMcpManifestKey, managedMcpManifestPath, TeamaiConfigSchema, scopedToolPaths } from '../types.js';
import type { LocalConfig } from '../types.js';

describe('Trae support', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('ships Trae resource paths with user rules under user_rules', () => {
    const config = TeamaiConfigSchema.parse({ team: 'test', repo: 'test/repo' });

    expect(config.toolPaths.trae).toEqual({
      skills: '.trae/skills',
      rules: '.trae/rules',
      mcpProject: '.trae/mcp.json',
      userScope: { rules: '.trae/user_rules' },
    });
    // Only the user directory differs on the CN build; project paths stay
    // shared with the international one (the qoder-cn split), the project
    // MCP file included — under one shared ownership record.
    expect(config.toolPaths['trae-cn']).toEqual({
      skills: '.trae/skills',
      rules: '.trae/rules',
      mcpProject: '.trae/mcp.json',
      userScope: {
        skills: '.trae-cn/skills',
        rules: '.trae-cn/user_rules',
      },
    });
  });

  it('maps Trae user rules to ~/.trae/user_rules and Trae CN to ~/.trae-cn', () => {
    const config = TeamaiConfigSchema.parse({ team: 'test', repo: 'test/repo' });

    const userScoped = scopedToolPaths(config, { scope: 'user' });
    // Trae names its user rules directory `user_rules`, not `rules`.
    expect(userScoped.trae).toMatchObject({
      skills: '.trae/skills',
      rules: '.trae/user_rules',
    });
    // The CN build reads ~/.trae-cn for every user-scope resource.
    expect(userScoped['trae-cn']).toMatchObject({
      skills: '.trae-cn/skills',
      rules: '.trae-cn/user_rules',
    });

    // Project scope leaves the top-level fields alone (the `userScope` block
    // itself stays on the entry; only a user scope splices it in): both
    // builds share <root>/.trae/, the MCP file included.
    const projectScoped = scopedToolPaths(config, { scope: 'project' });
    const traeProject = projectScoped.trae as Record<string, string>;
    const cnProject = projectScoped['trae-cn'] as Record<string, string>;
    for (const key of ['skills', 'rules', 'mcpProject']) {
      expect(cnProject[key]).toBe(traeProject[key]);
      expect(traeProject[key]).toMatch(/^\.trae\//);
    }
  });

  it('registers both builds for discovery and Markdown rules, without subagent sync', () => {
    expect(KNOWN_AGENTS.find((agent) => agent.id === 'trae')).toMatchObject({
      displayName: 'Trae',
      skillsPath: '.trae/skills',
    });
    expect(KNOWN_AGENTS.find((agent) => agent.id === 'trae-cn')).toMatchObject({
      displayName: 'Trae CN',
      skillsPath: '.trae-cn/skills',
    });
    for (const id of ['trae', 'trae-cn']) {
      // Trae has no subagents directory, so it is not in ALL_SUPPORTED_TOOLS.
      expect(ALL_SUPPORTED_TOOLS).not.toContain(id);
      expect(ruleFileExtensionForTool(id)).toBe('.md');
      expect(usesMdcRules(id)).toBe(false);
      expect(ruleFormatForTool(id)?.scopeFields).toEqual(['globs', 'alwaysApply']);
    }
  });

  it('uses the mcpServers JSON format and only a project-scope MCP file', async () => {
    expect(detectMcpFormat('trae')).toBe('claude');
    expect(detectMcpFormat('trae-cn')).toBe('claude');
    // Trae keeps user-level MCP next to its user settings (a platform-specific
    // path teamai cannot express), so no `mcp` field is configured and a
    // user-scope pull writes no MCP file for either build.
    const config = TeamaiConfigSchema.parse({ team: 'test', repo: 'test/repo' });
    expect(config.toolPaths.trae.mcp).toBeUndefined();
    expect(config.toolPaths['trae-cn'].mcp).toBeUndefined();

    const home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-trae-user-mcp-'));
    try {
      await fse.ensureDir(path.join(home, '.trae', 'skills'));
      await fse.ensureDir(path.join(home, '.trae-cn', 'skills'));
      vi.stubEnv('HOME', home);
      const localConfig = {
        repo: { localPath: path.join(home, 'team-repo'), remote: 'test/repo' },
        username: 'test',
        scope: 'user',
        additionalRoles: [],
      } as unknown as LocalConfig;

      const targets = await resolveMcpTargets(config, localConfig);
      expect(targets.filter((t) => t.tool === 'trae' || t.tool === 'trae-cn')).toEqual([]);
    } finally {
      await fse.remove(home);
    }
  });

  it('resolves both installed builds to the same shared .trae/mcp.json', async () => {
    const tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-trae-mcp-'));
    try {
      const home = path.join(tmp, 'home');
      const projectRoot = path.join(tmp, 'project');
      await fse.ensureDir(path.join(home, '.trae', 'skills'));
      await fse.ensureDir(path.join(home, '.trae-cn', 'skills'));
      await fse.ensureDir(path.join(projectRoot, '.trae', 'skills'));
      vi.stubEnv('HOME', home);
      const config = TeamaiConfigSchema.parse({ team: 'test', repo: 'test/repo' });
      const localConfig = {
        repo: { localPath: path.join(home, 'team-repo'), remote: 'test/repo' },
        username: 'test',
        scope: 'project',
        projectRoot,
        additionalRoles: [],
      } as unknown as LocalConfig;

      // Both editions' targets map one file; one shared ownership record
      // (managedMcpManifestKey) makes either the other's equal there.
      const targets = await resolveMcpTargets(config, localConfig);
      expect(targets).toContainEqual({
        tool: 'trae',
        format: 'claude',
        file: path.join(projectRoot, '.trae', 'mcp.json'),
        projectScope: true,
      });
      expect(targets).toContainEqual({
        tool: 'trae-cn',
        format: 'claude',
        file: path.join(projectRoot, '.trae', 'mcp.json'),
        projectScope: true,
      });
      expect(managedMcpManifestKey('trae-cn', true)).toBe('trae:project');
    } finally {
      await fse.remove(tmp);
    }
  });

  it('keeps the shared .trae/mcp.json current through either build, under one ownership record', async () => {
    const tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-trae-owner-'));
    try {
      const home = path.join(tmp, 'home');
      const projectRoot = path.join(tmp, 'project');
      const repoPath = path.join(tmp, 'repo');
      await fse.ensureDir(path.join(home, '.trae', 'skills'));
      await fse.ensureDir(path.join(home, '.trae-cn', 'skills'));
      await fse.ensureDir(path.join(projectRoot, '.trae', 'skills'));
      await fse.outputFile(
        path.join(repoPath, 'mcp', 'mcp.yaml'),
        'servers:\n  - name: team-demo\n    transport: stdio\n    command: node\n    args: ["server.mjs"]\n',
      );
      vi.stubEnv('HOME', home);
      const config = TeamaiConfigSchema.parse({ team: 'test', repo: 'test/repo' });
      const localConfig = (enabledAgents: string[]) => ({
        repo: { localPath: repoPath, remote: 'test/repo' },
        username: 'test',
        scope: 'project',
        projectRoot,
        additionalRoles: [],
        enabledAgents,
      }) as unknown as LocalConfig;
      const mcpFile = path.join(projectRoot, '.trae', 'mcp.json');

      await reconcileMcpForConfig(config, localConfig(['trae', 'trae-cn']));
      expect(JSON.parse(await fse.readFile(mcpFile, 'utf8')).mcpServers).toHaveProperty('team-demo');
      // One shared record claims the server for the pair: no separate
      // trae-cn key the CN-only pull below would skip as foreign.
      const manifestPath = managedMcpManifestPath(getDataHome(localConfig(['trae', 'trae-cn'])), projectRoot);
      const manifest = await fse.readJson(manifestPath);
      expect(manifest['trae:project']).toMatchObject([{ name: 'team-demo' }]);
      expect(manifest['trae-cn:project']).toBeUndefined();

      // The team drops the server and only Trae CN stays enabled: its own
      // target owns the shared file through the shared record and removes
      // the entry, instead of leaving it stale.
      await fse.writeFile(path.join(repoPath, 'mcp', 'mcp.yaml'), 'servers: []\n');
      await reconcileMcpForConfig(config, localConfig(['trae-cn']));
      expect(JSON.parse(await fse.readFile(mcpFile, 'utf8')).mcpServers).toEqual({});
    } finally {
      await fse.remove(tmp);
    }
  });

  it('counts each build installed by its own HOME root or an explicit --agent entry, never the shared .trae/', async () => {
    const tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-trae-phantom-'));
    try {
      const home = path.join(tmp, 'home');
      const projectRoot = path.join(tmp, 'project');
      // No edition's HOME root yet: the shared project root alone installs
      // neither build.
      await fse.ensureDir(path.join(projectRoot, '.trae', 'skills'));
      vi.stubEnv('HOME', home);
      const localConfig = (enabledAgents?: string[]) => ({
        repo: { localPath: path.join(tmp, 'repo'), remote: 'test/repo' },
        username: 'test',
        scope: 'project',
        projectRoot,
        additionalRoles: [],
        ...(enabledAgents ? { enabledAgents } : {}),
      }) as unknown as LocalConfig;

      expect(await isToolInstalledForConfig('trae', '.trae/skills', localConfig())).toBe(false);
      expect(await isToolInstalledForConfig('trae-cn', '.trae/skills', localConfig())).toBe(false);

      // An explicit --agent entry bootstraps the edition its app has not run
      // for yet, exactly as the copilot probe treats its whitelist.
      expect(await isToolInstalledForConfig('trae-cn', '.trae/skills', localConfig(['trae-cn']))).toBe(true);
      expect(await isToolInstalledForConfig('trae', '.trae/skills', localConfig(['trae-cn']))).toBe(false);

      // And each build's own HOME root installs it, symmetrically.
      await fse.ensureDir(path.join(home, '.trae', 'skills'));
      expect(await isToolInstalledForConfig('trae', '.trae/skills', localConfig())).toBe(true);
      await fse.ensureDir(path.join(home, '.trae-cn', 'skills'));
      expect(await isToolInstalledForConfig('trae-cn', '.trae/skills', localConfig())).toBe(true);

      // No sibling clause remains: an excluded trae target is excluded, and
      // an enabled Trae CN delivers MCP through its own target instead.
      const target = { tool: 'trae', format: 'claude', file: path.join(projectRoot, '.trae', 'mcp.json'), projectScope: true } as const;
      expect(mcpTargetExcluded({ disabledAgents: ['trae'] } as LocalConfig, target)).toBe(true);
    } finally {
      await fse.remove(tmp);
    }
  });

  it('rejects a toolPaths that maps the Trae builds to different MCP files', () => {
    // Their MCP servers live under one shared ownership record, which holds
    // only while both targets map the same file (#904).
    const split = TeamaiConfigSchema.safeParse({
      team: 'test',
      repo: 'test/repo',
      toolPaths: {
        trae: { skills: '.trae/skills', mcpProject: '.trae/mcp.json' },
        'trae-cn': { skills: '.trae/skills', mcpProject: '.trae-cn/mcp.json' },
      },
    });
    expect(split.success).toBe(false);
    expect(split.success === false && split.error.issues[0]?.message).toContain('one shared ownership record');

    const shared = TeamaiConfigSchema.safeParse({
      team: 'test',
      repo: 'test/repo',
      toolPaths: {
        trae: { skills: '.trae/skills', mcpProject: '.trae/mcp.json' },
        'trae-cn': { skills: '.trae/skills', mcpProject: '.trae/mcp.json' },
      },
    });
    expect(shared.success).toBe(true);
  });

  it('keeps a tools-filtered server in the shared file while either edition targets it', async () => {
    const tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-trae-filtered-'));
    try {
      const home = path.join(tmp, 'home');
      const projectRoot = path.join(tmp, 'project');
      const repoPath = path.join(tmp, 'repo');
      await fse.ensureDir(path.join(home, '.trae', 'skills'));
      await fse.ensureDir(path.join(home, '.trae-cn', 'skills'));
      await fse.ensureDir(path.join(projectRoot, '.trae', 'skills'));
      await fse.outputFile(
        path.join(repoPath, 'mcp', 'mcp.yaml'),
        'servers:\n'
          + '  - name: team-all\n    transport: stdio\n    command: node\n'
          + '  - name: team-intl\n    transport: stdio\n    command: node\n    tools: [trae]\n',
      );
      vi.stubEnv('HOME', home);
      const config = TeamaiConfigSchema.parse({ team: 'test', repo: 'test/repo' });
      const localConfig = {
        repo: { localPath: repoPath, remote: 'test/repo' },
        username: 'test',
        scope: 'project',
        projectRoot,
        additionalRoles: [],
        enabledAgents: ['trae', 'trae-cn'],
      } as unknown as LocalConfig;
      const mcpFile = path.join(projectRoot, '.trae', 'mcp.json');

      // The trae-cn target's own desired set excludes team-intl; sharing one
      // ownership record must not let its pass remove what trae's wrote.
      await reconcileMcpForConfig(config, localConfig);
      const servers = JSON.parse(await fse.readFile(mcpFile, 'utf8')).mcpServers;
      expect(servers).toHaveProperty('team-all');
      expect(servers).toHaveProperty('team-intl');

      // Dropping both removes both through either target.
      await fse.writeFile(path.join(repoPath, 'mcp', 'mcp.yaml'), 'servers: []\n');
      await reconcileMcpForConfig(config, localConfig);
      expect(JSON.parse(await fse.readFile(mcpFile, 'utf8')).mcpServers).toEqual({});
    } finally {
      await fse.remove(tmp);
    }
  });

  it('detects .trae and .trae-cn independently when probing HOME', async () => {
    const home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-trae-probe-'));
    try {
      vi.stubEnv('HOME', home);

      await fse.ensureDir(path.join(home, '.trae-cn', 'skills'));
      expect(await detectHomeInstalledAgents(['trae', 'trae-cn'])).toEqual(['trae-cn']);

      // The international install must not be reported for the CN directory,
      // and vice versa — the two roots are separate opt-ins.
      await fse.ensureDir(path.join(home, '.trae', 'skills'));
      expect(await detectHomeInstalledAgents(['trae', 'trae-cn'])).toEqual(['trae', 'trae-cn']);
    } finally {
      await fse.remove(home);
    }
  });
});

describe('Trae rules delivery', () => {
  let tmp: string;
  let homeDir: string;
  let repoPath: string;
  let localConfig: LocalConfig;
  const handler = new RulesHandler();
  const teamConfig = TeamaiConfigSchema.parse({ team: 'test', repo: 'test/repo' });

  const NS = 'Namespaced rule.\n';
  const TRAE_NS = '---\nalwaysApply: true\n---\n\nNamespaced rule.\n';
  const userRules = () => path.join(homeDir, '.trae/user_rules');

  beforeEach(async () => {
    tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-trae-rules-'));
    homeDir = path.join(tmp, 'home');
    repoPath = path.join(tmp, 'repo');
    await fse.outputFile(path.join(repoPath, 'rules', 'fe', 'style.md'), NS);
    await fse.ensureDir(path.join(homeDir, '.trae'));
    vi.stubEnv('HOME', homeDir);
    localConfig = {
      repo: { localPath: repoPath, remote: 'test/repo' },
      username: 'test',
      scope: 'user',
      additionalRoles: [],
      enabledAgents: ['trae'],
    } as unknown as LocalConfig;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmp);
  });

  it('writes namespaced rules under ~/.trae/user_rules, keeping the directory shape', async () => {
    await handler.pullAllRules(teamConfig, localConfig);

    expect(await fse.readFile(path.join(userRules(), 'fe', 'style.md'), 'utf8')).toBe(TRAE_NS);
  });

  it('writes namespaced rules under .trae/rules in project scope', async () => {
    const projectRoot = path.join(tmp, 'project');
    await fse.ensureDir(path.join(projectRoot, '.trae'));
    localConfig.scope = 'project';
    localConfig.projectRoot = projectRoot;

    await handler.pullAllRules(teamConfig, localConfig);

    expect(await fse.readFile(path.join(projectRoot, '.trae', 'rules', 'fe', 'style.md'), 'utf8')).toBe(TRAE_NS);
  });

  it('pushes an edit of the user copy back into rules/fe/style.md, without the Trae frontmatter', async () => {
    // As a pull does: the delivery record proves the copy is teamai's.
    const ledger = openLedger({});
    await handler.pullAllRules(teamConfig, localConfig, undefined, [], ledger);
    await saveStateForScope({
      ...await loadStateForScope(localConfig),
      lastPullByWorkspace: { [await checkoutKey(homeDir)]: { rev: 'r1', targets: [], delivered: ledger.hashes } },
    }, localConfig);
    const copy = path.join(userRules(), 'fe', 'style.md');
    await fse.writeFile(copy, TRAE_NS.replace('Namespaced rule.', 'Edited namespaced rule.'));

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    expect(items).toMatchObject([
      { name: 'fe/style', status: 'modified', sourcePath: copy, relativePath: 'rules/fe/style.md', namespace: 'fe' },
    ]);
    await handler.pushItem(items[0], teamConfig, localConfig);

    expect(await fse.readFile(path.join(repoPath, 'rules', 'fe', 'style.md'), 'utf8')).toBe('Edited namespaced rule.\n');
  });
});
