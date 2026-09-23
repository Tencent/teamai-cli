import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
  },
  spinner: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
  })),
}));

import { reconcileMcpForConfig, resolveMcpTargets, spliceCodexBlock, codexServerNames } from '../mcp-reconcile.js';
import { TeamaiConfigSchema, type TeamaiConfig, type LocalConfig } from '../types.js';

const TOOL_PATHS = {
  claude: { skills: '.claude/skills', settings: '.claude/settings.json', mcp: '.claude.json', mcpProject: '.mcp.json' },
  cursor: { skills: '.cursor/skills', settings: '.cursor/hooks.json', mcp: '.cursor/mcp.json', mcpProject: '.cursor/mcp.json' },
  codebuddy: { skills: '.codebuddy/skills', settings: '.codebuddy/settings.json', mcp: '.codebuddy/mcp.json', mcpProject: '.codebuddy/mcp.json' },
  codex: { skills: '.codex/skills', settings: '.codex/hooks.json', mcp: '.codex/config.toml' },
  tclaude: { skills: '.tclaude/skills', settings: '.tclaude/settings.json', mcp: '.tclaude/.claude.json' },
};

describe('MCP reconcile', () => {
  let tmpDir: string;
  let homeDir: string;
  let repoPath: string;
  let teamConfig: TeamaiConfig;
  let localConfig: LocalConfig;

  async function writeMcpYaml(body: string): Promise<void> {
    await fse.ensureDir(path.join(repoPath, 'mcp'));
    await fse.writeFile(path.join(repoPath, 'mcp', 'mcp.yaml'), body);
  }

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-mcp-test-'));
    homeDir = path.join(tmpDir, 'home');
    repoPath = path.join(tmpDir, 'team-repo');

    // Only claude + cursor are "installed".
    await fse.ensureDir(path.join(homeDir, '.claude', 'skills'));
    await fse.ensureDir(path.join(homeDir, '.cursor', 'skills'));
    await fse.ensureDir(path.join(homeDir, '.teamai'));

    vi.stubEnv('HOME', homeDir);

    teamConfig = {
      team: 't',
      description: '',
      repo: 'r',
      provider: 'tgit',
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: '~/.teamai/docs' },
        env: { injectShellProfile: false },
      },
      toolPaths: TOOL_PATHS,
    } as unknown as TeamaiConfig;

    localConfig = {
      repo: { localPath: repoPath, remote: 'r' },
      username: 'u',
      scope: 'user',
      additionalRoles: [],
    } as unknown as LocalConfig;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('preserves every unrelated key in ~/.claude.json', async () => {
    const claudeJson = path.join(homeDir, '.claude.json');
    const original = {
      oauthAccount: { emailAddress: 'me@example.com', accountUuid: 'abc-123' },
      projects: { '/some/project': { trustLevel: 'trusted', allowedTools: ['Bash'] } },
      numStartups: 42,
      mcpServers: { 'my-own': { command: 'my-server' } },
    };
    await fse.writeJson(claudeJson, original);

    await writeMcpYaml(`
servers:
  - name: team-server
    transport: http
    url: https://example.com/mcp
`);

    await reconcileMcpForConfig(teamConfig, localConfig);

    const after = await fse.readJson(claudeJson);
    expect(after.oauthAccount).toEqual(original.oauthAccount);
    expect(after.projects).toEqual(original.projects);
    expect(after.numStartups).toBe(42);
    // User's own server survives alongside the team one.
    expect(after.mcpServers['my-own']).toEqual({ command: 'my-server' });
    expect(after.mcpServers['team-server']).toEqual({
      type: 'http',
      url: 'https://example.com/mcp',
    });
  });

  it('is idempotent — a second run does not rewrite the file', async () => {
    await writeMcpYaml(`
servers:
  - name: s1
    transport: http
    url: https://example.com/mcp
`);

    const first = await reconcileMcpForConfig(teamConfig, localConfig);
    expect(first.wrote).toBe(true);

    const claudeJson = path.join(homeDir, '.claude.json');
    const mtimeBefore = (await fse.stat(claudeJson)).mtimeMs;

    const second = await reconcileMcpForConfig(teamConfig, localConfig);
    expect(second.wrote).toBe(false);
    expect((await fse.stat(claudeJson)).mtimeMs).toBe(mtimeBefore);
  });

  it('does not overwrite a user-owned server with a colliding name', async () => {
    const cursorMcp = path.join(homeDir, '.cursor', 'mcp.json');
    await fse.writeJson(cursorMcp, { mcpServers: { shared: { url: 'https://mine.example/mcp' } } });

    await writeMcpYaml(`
servers:
  - name: shared
    transport: http
    url: https://team.example/mcp
    tools: [cursor]
`);

    const { changes } = await reconcileMcpForConfig(teamConfig, localConfig);

    const after = await fse.readJson(cursorMcp);
    expect(after.mcpServers.shared.url).toBe('https://mine.example/mcp');
    expect(changes).toContainEqual(
      expect.objectContaining({ tool: 'cursor', server: 'shared', action: 'skipped' }),
    );
  });

  it('skips a server whose ${VAR} cannot be resolved instead of injecting it broken', async () => {
    // Every tool resolves ${VAR} onto disk now, so an unresolvable var skips the
    // server everywhere; scoped to claude here just to keep the assertion focused.
    await writeMcpYaml(`
servers:
  - name: needs-token
    transport: http
    url: https://example.com/mcp
    headers:
      Authorization: Bearer \${DEFINITELY_UNSET_TOKEN_XYZ}
    tools: [claude]
`);

    const { changes } = await reconcileMcpForConfig(teamConfig, localConfig);

    expect(await fse.pathExists(path.join(homeDir, '.claude.json'))).toBe(false);
    expect(changes.every((c) => c.action === 'skipped')).toBe(true);
    expect(changes[0].reason).toContain('DEFINITELY_UNSET_TOKEN_XYZ');
  });

  it('resolves ${VAR} from the team env file', async () => {
    await fse.writeFile(path.join(homeDir, '.teamai', 'env'), 'TEAM_TOKEN=s3cret\n');
    await writeMcpYaml(`
servers:
  - name: with-token
    transport: http
    url: https://example.com/mcp
    headers:
      Authorization: Bearer \${TEAM_TOKEN}
    tools: [claude]
`);

    await reconcileMcpForConfig(teamConfig, localConfig);

    const after = await fse.readJson(path.join(homeDir, '.claude.json'));
    expect(after.mcpServers['with-token'].headers.Authorization).toBe('Bearer s3cret');
  });

  it('removes a server once it disappears from mcp.yaml', async () => {
    await writeMcpYaml(`
servers:
  - name: temp
    transport: http
    url: https://example.com/mcp
    tools: [claude]
`);
    await reconcileMcpForConfig(teamConfig, localConfig);
    expect((await fse.readJson(path.join(homeDir, '.claude.json'))).mcpServers.temp).toBeDefined();

    await writeMcpYaml('servers: []\n');
    await reconcileMcpForConfig(teamConfig, localConfig);

    const after = await fse.readJson(path.join(homeDir, '.claude.json'));
    expect(after.mcpServers.temp).toBeUndefined();
  });

  describe('roles filter', () => {
    const ROLES_YAML = `
version: 1
roles:
  - id: frontend
    description: Frontend
    resources: { knowledge: [common], skills: [common] }
  - id: devops
    description: DevOps
    resources: { knowledge: [common], skills: [common] }
`;
    const SCOPED_YAML = `
servers:
  - name: playwright
    transport: http
    url: https://example.com/playwright
    roles: [frontend]
  - name: gpu
    transport: http
    url: https://example.com/gpu
    roles: [devops, data]
  - name: shared
    transport: http
    url: https://example.com/shared
`;
    async function writeRolesYaml(): Promise<void> {
      await fse.ensureDir(path.join(repoPath, 'manifest'));
      await fse.writeFile(path.join(repoPath, 'manifest', 'roles.yaml'), ROLES_YAML);
    }
    async function claudeServers(): Promise<Record<string, unknown>> {
      return (await fse.readJson(path.join(homeDir, '.claude.json'))).mcpServers ?? {};
    }

    it('installs a server only for members whose active roles it lists', async () => {
      await writeRolesYaml();
      await writeMcpYaml(SCOPED_YAML);

      await reconcileMcpForConfig(teamConfig, { ...localConfig, primaryRole: 'frontend', additionalRoles: [] });
      expect(Object.keys(await claudeServers()).sort()).toEqual(['playwright', 'shared']);
    });

    it('counts additional roles as active', async () => {
      await writeRolesYaml();
      await writeMcpYaml(SCOPED_YAML);

      await reconcileMcpForConfig(teamConfig, { ...localConfig, primaryRole: 'frontend', additionalRoles: ['devops'] });
      expect(Object.keys(await claudeServers()).sort()).toEqual(['gpu', 'playwright', 'shared']);
    });

    it('removes a server once the member switches to a role it does not list', async () => {
      await writeRolesYaml();
      await writeMcpYaml(SCOPED_YAML);
      await reconcileMcpForConfig(teamConfig, { ...localConfig, primaryRole: 'frontend', additionalRoles: [] });
      expect(await claudeServers()).toHaveProperty('playwright');

      const { changes } = await reconcileMcpForConfig(teamConfig, { ...localConfig, primaryRole: 'devops', additionalRoles: [] });
      expect(Object.keys(await claudeServers()).sort()).toEqual(['gpu', 'shared']);
      expect(changes.some((c) => c.server === 'playwright' && c.action === 'removed')).toBe(true);
    });

    it('installs every server when no role is configured (legacy member)', async () => {
      await writeRolesYaml();
      await writeMcpYaml(SCOPED_YAML);

      await reconcileMcpForConfig(teamConfig, localConfig);
      expect(Object.keys(await claudeServers()).sort()).toEqual(['gpu', 'playwright', 'shared']);
    });

    it('skips silently, without a change record, like the tools filter', async () => {
      await writeRolesYaml();
      await writeMcpYaml(SCOPED_YAML);

      const { changes } = await reconcileMcpForConfig(teamConfig, { ...localConfig, primaryRole: 'frontend', additionalRoles: [] });
      expect(changes.some((c) => c.server === 'gpu')).toBe(false);
    });

    it('warns once about a role id that is not in roles.yaml and still applies the rest', async () => {
      await writeRolesYaml();
      await writeMcpYaml(`
servers:
  - name: typo
    transport: http
    url: https://example.com/typo
    roles: [frontned]
  - name: shared
    transport: http
    url: https://example.com/shared
`);
      const { log } = await import('../utils/logger.js');
      vi.mocked(log.warn).mockClear();

      await reconcileMcpForConfig(teamConfig, { ...localConfig, primaryRole: 'frontend', additionalRoles: [] });

      expect(Object.keys(await claudeServers())).toEqual(['shared']);
      const warnings = vi.mocked(log.warn).mock.calls.map(([m]) => String(m)).filter((m) => /frontned/.test(m));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/unknown role id "frontned".*mcp\.yaml.*"typo"/);
    });
  });

  describe('projects filter', () => {
    const PROJECTS_YAML = `
version: 1
projects:
  - id: checkout
    resources: {}
  - id: billing
    resources: {}
`;
    const ROLES_YAML = `
version: 1
roles:
  - id: frontend
    description: Frontend
    resources: { knowledge: [common], skills: [common] }
  - id: devops
    description: DevOps
    resources: { knowledge: [common], skills: [common] }
`;
    const SCOPED_YAML = `
servers:
  - name: checkout-db
    transport: http
    url: https://example.com/checkout
    projects: [checkout]
  - name: billing-db
    transport: http
    url: https://example.com/billing
    projects: [billing, legacy]
  - name: shared
    transport: http
    url: https://example.com/shared
`;
    async function writeManifests(): Promise<void> {
      await fse.ensureDir(path.join(repoPath, 'manifest'));
      await fse.writeFile(path.join(repoPath, 'manifest', 'projects.yaml'), PROJECTS_YAML);
      await fse.writeFile(path.join(repoPath, 'manifest', 'roles.yaml'), ROLES_YAML);
    }
    async function claudeServers(): Promise<Record<string, unknown>> {
      return (await fse.readJson(path.join(homeDir, '.claude.json'))).mcpServers ?? {};
    }

    it('installs a server only for directories bound to a project it lists', async () => {
      await writeManifests();
      await writeMcpYaml(SCOPED_YAML);

      await reconcileMcpForConfig(teamConfig, { ...localConfig, projects: ['checkout'] });
      expect(Object.keys(await claudeServers()).sort()).toEqual(['checkout-db', 'shared']);
    });

    it('counts every project the directory is bound to', async () => {
      await writeManifests();
      await writeMcpYaml(SCOPED_YAML);

      await reconcileMcpForConfig(teamConfig, { ...localConfig, projects: ['checkout', 'billing'] });
      expect(Object.keys(await claudeServers()).sort()).toEqual(['billing-db', 'checkout-db', 'shared']);
    });

    it('installs every server when the directory is bound to no project (legacy config)', async () => {
      await writeManifests();
      await writeMcpYaml(SCOPED_YAML);

      await reconcileMcpForConfig(teamConfig, localConfig);
      expect(Object.keys(await claudeServers()).sort()).toEqual(['billing-db', 'checkout-db', 'shared']);
    });

    it('removes a server once the directory stops being bound to its project', async () => {
      await writeManifests();
      await writeMcpYaml(SCOPED_YAML);
      await reconcileMcpForConfig(teamConfig, { ...localConfig, projects: ['checkout'] });
      expect(await claudeServers()).toHaveProperty('checkout-db');

      const { changes } = await reconcileMcpForConfig(teamConfig, { ...localConfig, projects: ['billing'] });
      expect(Object.keys(await claudeServers()).sort()).toEqual(['billing-db', 'shared']);
      expect(changes.some((c) => c.server === 'checkout-db' && c.action === 'removed')).toBe(true);
    });

    it('skips silently, without a change record, like the roles filter', async () => {
      await writeManifests();
      await writeMcpYaml(SCOPED_YAML);

      const { changes } = await reconcileMcpForConfig(teamConfig, { ...localConfig, projects: ['checkout'] });
      expect(changes.some((c) => c.server === 'billing-db')).toBe(false);
    });

    it('requires both axes when a server scopes roles and projects (AND, not OR)', async () => {
      await writeManifests();
      await writeMcpYaml(`
servers:
  - name: fe-checkout
    transport: http
    url: https://example.com/fe-checkout
    roles: [frontend]
    projects: [checkout]
`);
      const base = { ...localConfig, additionalRoles: [] };

      await reconcileMcpForConfig(teamConfig, { ...base, primaryRole: 'frontend', projects: ['checkout'] });
      expect(Object.keys(await claudeServers())).toEqual(['fe-checkout']);

      await reconcileMcpForConfig(teamConfig, { ...base, primaryRole: 'frontend', projects: ['billing'] });
      expect(Object.keys(await claudeServers())).toEqual([]);

      await reconcileMcpForConfig(teamConfig, { ...base, primaryRole: 'devops', projects: ['checkout'] });
      expect(Object.keys(await claudeServers())).toEqual([]);
    });

    it('warns once about a project id that is not in projects.yaml and still applies the rest', async () => {
      await writeManifests();
      await writeMcpYaml(`
servers:
  - name: typo
    transport: http
    url: https://example.com/typo
    projects: [chekout]
  - name: shared
    transport: http
    url: https://example.com/shared
`);
      const { log } = await import('../utils/logger.js');
      vi.mocked(log.warn).mockClear();

      await reconcileMcpForConfig(teamConfig, { ...localConfig, projects: ['checkout'] });

      expect(Object.keys(await claudeServers())).toEqual(['shared']);
      const warnings = vi.mocked(log.warn).mock.calls.map(([m]) => String(m)).filter((m) => /chekout/.test(m));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/unknown project id "chekout".*mcp\.yaml.*"typo"/);
    });

    it('reports that project ids cannot be checked when the team has no projects manifest', async () => {
      await fse.ensureDir(path.join(repoPath, 'manifest'));
      await fse.writeFile(path.join(repoPath, 'manifest', 'roles.yaml'), ROLES_YAML);
      await writeMcpYaml(SCOPED_YAML);
      const { log } = await import('../utils/logger.js');
      vi.mocked(log.warn).mockClear();

      await reconcileMcpForConfig(teamConfig, localConfig);

      // Inert key: with no manifest every member's projects axis is null, so all ship.
      expect(Object.keys(await claudeServers()).sort()).toEqual(['billing-db', 'checkout-db', 'shared']);
      const warnings = vi.mocked(log.warn).mock.calls.map(([m]) => String(m)).filter((m) => /cannot be checked/.test(m));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('manifest/projects.yaml');
    });

    it('still filters by projects when the manifest is missing, for a directory that is bound to one', async () => {
      // A directory's active projects come from its own config.yaml, not from the
      // manifest. So a missing manifest means the ids cannot be VALIDATED — not
      // that the key stops restricting, which only holds for a directory bound to
      // no project.
      await fse.ensureDir(path.join(repoPath, 'manifest'));
      await fse.writeFile(path.join(repoPath, 'manifest', 'roles.yaml'), ROLES_YAML);
      await writeMcpYaml(SCOPED_YAML);

      await reconcileMcpForConfig(teamConfig, { ...localConfig, projects: ['billing'] });
      expect(Object.keys(await claudeServers()).sort()).toEqual(['billing-db', 'shared']);
    });
  });

  it('does not prune managed servers in http mode (install_mcp survives second sync)', async () => {
    // First, inject a server as a git-mode team would, so managed-mcp.json and
    // the tool config both record it (stands in for an install_mcp write).
    await writeMcpYaml(`
servers:
  - name: clawpro
    transport: http
    url: https://clawpro.example.com/mcp
    tools: [claude]
`);
    await reconcileMcpForConfig(teamConfig, localConfig);
    const claudeJson = path.join(homeDir, '.claude.json');
    expect((await fse.readJson(claudeJson)).mcpServers.clawpro).toBeDefined();

    // Now the team is HTTP-backed with an empty desired set (no repo tree). A
    // session-start reconcile must NOT delete the previously managed server.
    await writeMcpYaml('servers: []\n');
    const httpConfig = { ...localConfig, repo: { ...localConfig.repo, kind: 'http' } } as typeof localConfig;
    const { changes } = await reconcileMcpForConfig(teamConfig, httpConfig);

    expect(changes).toEqual([]);
    expect((await fse.readJson(claudeJson)).mcpServers.clawpro).toBeDefined();
  });

  it('still removes managed servers in http mode when removeAll is set (uninstall teardown)', async () => {
    await writeMcpYaml(`
servers:
  - name: clawpro
    transport: http
    url: https://clawpro.example.com/mcp
    tools: [claude]
`);
    await reconcileMcpForConfig(teamConfig, localConfig);
    const claudeJson = path.join(homeDir, '.claude.json');
    expect((await fse.readJson(claudeJson)).mcpServers.clawpro).toBeDefined();

    const httpConfig = { ...localConfig, repo: { ...localConfig.repo, kind: 'http' } } as typeof localConfig;
    const { changes } = await reconcileMcpForConfig(teamConfig, httpConfig, { removeAll: true });

    expect(changes.some((c) => c.action === 'removed' && c.server === 'clawpro')).toBe(true);
    expect((await fse.readJson(claudeJson)).mcpServers.clawpro).toBeUndefined();
  });

  // tclaude relocates Claude Code's user data dir via customUserDataDir, so its
  // MCP file is ~/.tclaude/.claude.json — a nested path, not ~/.tclaude.json.
  it('writes tclaude servers to ~/.tclaude/.claude.json in claude format', async () => {
    const tclaudeJson = path.join(homeDir, '.tclaude', '.claude.json');
    await fse.ensureDir(path.join(homeDir, '.tclaude', 'skills'));
    await fse.writeJson(tclaudeJson, { numStartups: 7, projects: { '/p': { trustLevel: 'trusted' } } });

    await writeMcpYaml(`
servers:
  - name: gpu
    transport: http
    url: https://example.com/mcp
    tools: [tclaude]
`);

    await reconcileMcpForConfig(teamConfig, localConfig);

    const after = await fse.readJson(tclaudeJson);
    expect(after.mcpServers.gpu).toEqual({ type: 'http', url: 'https://example.com/mcp' });
    // Pre-existing tclaude state survives.
    expect(after.numStartups).toBe(7);
    expect(after.projects).toEqual({ '/p': { trustLevel: 'trusted' } });
    // The sibling path must not be created by mistake.
    expect(await fse.pathExists(path.join(homeDir, '.tclaude.json'))).toBe(false);
  });

  it('detects tclaude as installed from its skills dir, not its MCP file', async () => {
    // ~/.tclaude exists but .claude.json does not yet — a fresh install.
    await fse.ensureDir(path.join(homeDir, '.tclaude', 'skills'));

    await writeMcpYaml(`
servers:
  - name: gpu
    transport: http
    url: https://example.com/mcp
    tools: [tclaude]
`);

    const { changes } = await reconcileMcpForConfig(teamConfig, localConfig);
    expect(changes).toContainEqual(
      expect.objectContaining({ tool: 'tclaude', server: 'gpu', action: 'added' }),
    );
    expect(await fse.pathExists(path.join(homeDir, '.tclaude', '.claude.json'))).toBe(true);
  });

  // Regression: project scope used to fall back to the user-scope path, which
  // put files where codex/tclaude would never look for them.
  it('never falls back to the user-scope path in project scope', async () => {
    const projectRoot = path.join(tmpDir, 'proj');
    for (const d of ['.claude', '.cursor', '.codebuddy', '.tclaude', '.codex']) {
      await fse.ensureDir(path.join(projectRoot, d, 'skills'));
    }
    const projectConfig = {
      ...localConfig,
      scope: 'project',
      projectRoot,
    } as unknown as LocalConfig;

    await writeMcpYaml(`
servers:
  - name: s1
    transport: stdio
    command: echo
`);

    const targets = await resolveMcpTargets(teamConfig, projectConfig);
    const byTool = Object.fromEntries(targets.map((t) => [t.tool, t.file]));

    expect(byTool.claude).toBe(path.join(projectRoot, '.mcp.json'));
    expect(byTool.cursor).toBe(path.join(projectRoot, '.cursor', 'mcp.json'));
    expect(byTool.codebuddy).toBe(path.join(projectRoot, '.codebuddy', 'mcp.json'));
    // No project-scope MCP support: codex has no such concept, and tclaude reads
    // the <root>/.mcp.json that the claude target already writes.
    expect(byTool.codex).toBeUndefined();
    expect(byTool.tclaude).toBeUndefined();

    await reconcileMcpForConfig(teamConfig, projectConfig);
    expect(await fse.pathExists(path.join(projectRoot, '.codex', 'config.toml'))).toBe(false);
    expect(await fse.pathExists(path.join(projectRoot, '.tclaude', '.claude.json'))).toBe(false);
    expect(await fse.pathExists(path.join(projectRoot, '.mcp.json'))).toBe(true);
  });

  it('uses CodeBuddy project defaults without changing user scope or personal servers', async () => {
    const projectRoot = path.join(tmpDir, 'codebuddy-project');
    await fse.ensureDir(path.join(projectRoot, '.codebuddy'));
    await fse.ensureDir(path.join(projectRoot, '.workbuddy'));
    await fse.ensureDir(path.join(homeDir, '.codebuddy'));
    const projectFile = path.join(projectRoot, '.mcp.json');
    const userFile = path.join(homeDir, '.codebuddy', 'mcp.json');
    const personal = { mcpServers: { personal: { command: 'my-server' } }, custom: true };
    await fse.writeJson(projectFile, personal);
    await fse.writeJson(userFile, personal);
    const defaults = TeamaiConfigSchema.parse({ team: 't', repo: 'r', provider: 'git' });
    const projectConfig: LocalConfig = { ...localConfig, scope: 'project', projectRoot };
    await writeMcpYaml(`
servers:
  - name: team-codebuddy
    transport: http
    url: https://example.com/mcp
    tools: [codebuddy]
`);

    const targets = await resolveMcpTargets(defaults, projectConfig);
    expect(targets.find((target) => target.tool === 'codebuddy')?.file).toBe(projectFile);
    expect(targets.find((target) => target.tool === 'workbuddy')?.file)
      .toBe(path.join(projectRoot, '.workbuddy', 'mcp.json'));
    const userTargets = await resolveMcpTargets(defaults, localConfig);
    expect(userTargets.find((target) => target.tool === 'codebuddy')?.file).toBe(userFile);

    await reconcileMcpForConfig(defaults, projectConfig);
    expect(await fse.readJson(projectFile)).toEqual({
      ...personal,
      mcpServers: {
        ...personal.mcpServers,
        'team-codebuddy': { type: 'http', url: 'https://example.com/mcp' },
      },
    });
    expect(await fse.pathExists(path.join(projectRoot, '.codebuddy', 'mcp.json'))).toBe(false);
    expect(await fse.readJson(userFile)).toEqual(personal);
    expect((await reconcileMcpForConfig(defaults, projectConfig)).wrote).toBe(false);

    await reconcileMcpForConfig(defaults, projectConfig, { removeAll: true });
    expect(await fse.readJson(projectFile)).toEqual(personal);
    expect(await fse.readJson(userFile)).toEqual(personal);
  });

  it('resolves a project secret to plaintext in every tool, keyed off `type`', async () => {
    const projectRoot = path.join(tmpDir, 'proj2');
    for (const d of ['.claude', '.cursor', '.codebuddy']) {
      await fse.ensureDir(path.join(projectRoot, d, 'skills'));
    }
    const projectConfig = { ...localConfig, scope: 'project', projectRoot } as unknown as LocalConfig;
    process.env.SECRET_TOKEN = 'super-secret-value';

    await writeMcpYaml(`
servers:
  - name: with-secret
    transport: http
    url: https://example.com/mcp
    headers:
      Authorization: Bearer \${SECRET_TOKEN}
  - name: no-secret
    transport: http
    url: https://example.com/open
`);

    await reconcileMcpForConfig(teamConfig, projectConfig);

    // teamai resolves every secret to plaintext rather than relying on any tool's
    // own ${VAR} expansion, which is fragile (GUI IDEs never inherit shell exports,
    // so a placeholder resolves to empty and the server 401s). Each remote server
    // keys its transport off `type`, not the ignored `transportType`.
    const claudeDoc = await fse.readJson(path.join(projectRoot, '.mcp.json'));
    expect(claudeDoc.mcpServers['with-secret'].headers.Authorization).toBe('Bearer super-secret-value');

    const buddyDoc = await fse.readJson(path.join(projectRoot, '.codebuddy', 'mcp.json'));
    expect(buddyDoc.mcpServers['with-secret'].type).toBe('http');
    expect(buddyDoc.mcpServers['with-secret'].headers.Authorization).toBe('Bearer super-secret-value');

    const cursorDoc = await fse.readJson(path.join(projectRoot, '.cursor', 'mcp.json'));
    expect(cursorDoc.mcpServers['with-secret'].type).toBe('http');
    expect(cursorDoc.mcpServers['with-secret'].headers.Authorization).toBe('Bearer super-secret-value');
    expect(cursorDoc.mcpServers['no-secret']).toBeDefined();

    delete process.env.SECRET_TOKEN;
  });

  it('skips tools that are not installed', async () => {
    await writeMcpYaml(`
servers:
  - name: s1
    transport: http
    url: https://example.com/mcp
`);
    await reconcileMcpForConfig(teamConfig, localConfig);

    // codebuddy has no ~/.codebuddy directory in this fixture.
    expect(await fse.pathExists(path.join(homeDir, '.codebuddy', 'mcp.json'))).toBe(false);
  });

  it('leaves installed tools outside enabledAgents or in disabledAgents alone', async () => {
    // Same gate as skills, rules, agents, hooks and builtin deploy: cursor is
    // installed here, but the member only opted in to claude.
    await writeMcpYaml(`
servers:
  - name: s1
    transport: http
    url: https://example.com/mcp
`);
    await reconcileMcpForConfig(teamConfig, { ...localConfig, enabledAgents: ['claude'] });

    expect((await fse.readJson(path.join(homeDir, '.claude.json'))).mcpServers.s1).toBeDefined();
    expect(await fse.pathExists(path.join(homeDir, '.cursor', 'mcp.json'))).toBe(false);

    // `uninstall --agent cursor` records the tool here; pull must not bring its
    // MCP servers back either.
    await reconcileMcpForConfig(teamConfig, { ...localConfig, disabledAgents: ['cursor'] });
    expect(await fse.pathExists(path.join(homeDir, '.cursor', 'mcp.json'))).toBe(false);
  });

  it('keeps writing <root>/.mcp.json for a tclaude-only whitelist in project scope', async () => {
    // tclaude has no project-scope MCP file of its own; it reads the one the
    // claude target writes, so excluding claude must not drop that file.
    const projectRoot = path.join(tmpDir, 'tclaude-proj');
    await fse.ensureDir(path.join(projectRoot, '.claude', 'skills'));
    await fse.ensureDir(path.join(projectRoot, '.tclaude', 'skills'));
    await writeMcpYaml(`
servers:
  - name: s1
    transport: http
    url: https://example.com/mcp
`);
    await reconcileMcpForConfig(teamConfig, {
      ...localConfig,
      scope: 'project',
      projectRoot,
      enabledAgents: ['tclaude'],
    } as unknown as LocalConfig);

    expect(await fse.pathExists(path.join(projectRoot, '.mcp.json'))).toBe(true);
  });

  it('rejects a requires entry with shell metacharacters instead of running it', async () => {
    const marker = path.join(tmpDir, 'requires-injection-proof');
    await writeMcpYaml(`
servers:
  - name: evil
    transport: stdio
    command: echo
    requires:
      - "echo; touch ${marker}"
`);

    const { changes } = await reconcileMcpForConfig(teamConfig, localConfig);

    // The injected command must never have executed.
    expect(await fse.pathExists(marker)).toBe(false);

    // The server is skipped with an invalid-name reason, not installed.
    const skipped = changes.find((c) => c.server === 'evil' && c.action === 'skipped');
    expect(skipped?.reason).toMatch(/invalid name/);
    expect(changes.some((c) => c.server === 'evil' && c.action === 'added')).toBe(false);
  });

  it('injects a server whose requires binary is on PATH', async () => {
    const binDir = path.join(tmpDir, 'bin');
    await fse.ensureDir(binDir);
    const bin = path.join(binDir, 'teamai-req-bin-539');
    await fse.writeFile(bin, '#!/bin/sh\nexit 0\n');
    await fse.chmod(bin, 0o755);
    vi.stubEnv('PATH', `${binDir}${path.delimiter}${process.env.PATH ?? ''}`);

    await writeMcpYaml(`
servers:
  - name: needs-bin
    transport: stdio
    command: teamai-req-bin-539
    requires: [teamai-req-bin-539]
`);

    const { changes } = await reconcileMcpForConfig(teamConfig, localConfig);
    const skipped = changes.filter((c) => c.server === 'needs-bin' && c.action === 'skipped');
    expect(skipped.some((c) => /not found on PATH/.test(c.reason ?? ''))).toBe(false);
    expect(changes.some((c) => c.server === 'needs-bin' && c.action === 'added')).toBe(true);
  });

  it('skips a server whose requires binary is absent from PATH', async () => {
    await writeMcpYaml(`
servers:
  - name: needs-missing
    transport: stdio
    command: teamai-missing-bin-539
    requires: [teamai-missing-bin-539]
`);

    const { changes } = await reconcileMcpForConfig(teamConfig, localConfig);
    const skipped = changes.filter((c) => c.server === 'needs-missing' && c.action === 'skipped');
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped.every((c) => /not found on PATH/.test(c.reason ?? ''))).toBe(true);
    expect(changes.some((c) => c.server === 'needs-missing' && c.action === 'added')).toBe(false);
  });

  it('treats uvx.exe as satisfying requires: [uvx] on Windows', async () => {
    const binDir = path.join(tmpDir, 'win-bin');
    await fse.ensureDir(binDir);
    await fse.writeFile(path.join(binDir, 'uvx.exe'), '');

    await writeMcpYaml(`
servers:
  - name: volces-search
    transport: stdio
    command: uvx
    requires: [uvx]
`);

    const { changes } = await reconcileMcpForConfig(teamConfig, localConfig, {
      lookPath: {
        platform: 'win32',
        pathEnv: binDir,
        pathExt: '.EXE;.CMD',
      },
    });
    const skipped = changes.filter((c) => c.server === 'volces-search' && c.action === 'skipped');
    expect(skipped.some((c) => /not found on PATH/.test(c.reason ?? ''))).toBe(false);
    expect(changes.some((c) => c.server === 'volces-search' && c.action === 'added')).toBe(true);
  });

  // Verified against codex-cli 0.142.5: it speaks streamable HTTP. Secrets are
  // resolved to plaintext like every other tool — codex's env-var naming
  // (`bearer_token_env_var`) is not used, so the token is present regardless of
  // how codex is launched.
  it('writes an http server into codex config.toml with the token resolved to plaintext', async () => {
    await fse.ensureDir(path.join(homeDir, '.codex', 'skills'));
    process.env.REMOTE_TOKEN = 'super-secret-value';
    await writeMcpYaml(`
servers:
  - name: remote
    transport: http
    url: https://example.com/mcp
    headers:
      Authorization: Bearer \${REMOTE_TOKEN}
      X-Trace: \${TRACE_ID}
      X-Team: literal-value
    timeout: 600000
    tools: [codex]
`);
    process.env.TRACE_ID = 'trace-1';

    await reconcileMcpForConfig(teamConfig, localConfig);
    const toml = await fse.readFile(path.join(homeDir, '.codex', 'config.toml'), 'utf-8');

    expect(toml).toContain('url = "https://example.com/mcp"');
    // All headers resolve to plaintext and land in http_headers; no env-var naming.
    expect(toml).not.toContain('bearer_token_env_var');
    expect(toml).not.toContain('env_http_headers');
    expect(toml).toContain('"Authorization" = "Bearer super-secret-value"');
    expect(toml).toContain('"X-Trace" = "trace-1"');
    expect(toml).toContain('"X-Team" = "literal-value"');
    expect(toml).toContain('startup_timeout_sec = 600');
    delete process.env.REMOTE_TOKEN;
    delete process.env.TRACE_ID;
  });

  it('resolves a codex placeholder inside the url to plaintext', async () => {
    await fse.ensureDir(path.join(homeDir, '.codex', 'skills'));
    process.env.REGION = 'eu';
    await writeMcpYaml(`
servers:
  - name: regional
    transport: http
    url: https://\${REGION}.example.com/mcp
    tools: [codex]
`);

    await reconcileMcpForConfig(teamConfig, localConfig);
    const toml = await fse.readFile(path.join(homeDir, '.codex', 'config.toml'), 'utf-8');
    expect(toml).toContain('url = "https://eu.example.com/mcp"');
    delete process.env.REGION;
  });

  it('still skips sse for codex, which has no such transport', async () => {
    await fse.ensureDir(path.join(homeDir, '.codex', 'skills'));
    await writeMcpYaml(`
servers:
  - name: streamy
    transport: sse
    url: https://example.com/sse
    tools: [codex]
`);

    const { changes } = await reconcileMcpForConfig(teamConfig, localConfig);
    expect(changes).toContainEqual(
      expect.objectContaining({ tool: 'codex', server: 'streamy', action: 'skipped' }),
    );
    expect(await fse.pathExists(path.join(homeDir, '.codex', 'config.toml'))).toBe(false);
  });

  it('writes a stdio server into codex config.toml without destroying user comments', async () => {
    await fse.ensureDir(path.join(homeDir, '.codex', 'skills'));
    const configToml = path.join(homeDir, '.codex', 'config.toml');
    await fse.writeFile(
      configToml,
      '# my important comment\nmodel = "gpt-5"\n\n[projects."/x"]\ntrust_level = "trusted"\n',
    );

    await writeMcpYaml(`
servers:
  - name: local-tool
    transport: stdio
    command: my-mcp
    args: ['--flag']
    tools: [codex]
`);

    await reconcileMcpForConfig(teamConfig, localConfig);

    const after = await fse.readFile(configToml, 'utf-8');
    expect(after).toContain('# my important comment');
    expect(after).toContain('trust_level = "trusted"');
    expect(after).toContain('[mcp_servers.local-tool]');
    expect(after).toContain('command = "my-mcp"');
  });

  it('leaves an unparseable config file alone rather than clobbering it', async () => {
    const claudeJson = path.join(homeDir, '.claude.json');
    await fse.writeFile(claudeJson, '{ this is not valid json');

    await writeMcpYaml(`
servers:
  - name: s1
    transport: http
    url: https://example.com/mcp
    tools: [claude]
`);

    await reconcileMcpForConfig(teamConfig, localConfig);
    expect(await fse.readFile(claudeJson, 'utf-8')).toBe('{ this is not valid json');
  });

  it('enforces the allowedHosts policy', async () => {
    teamConfig.sharing.mcp = { autoApply: true, allowedCommands: [], allowedHosts: ['*.trusted.com'] };
    await writeMcpYaml(`
servers:
  - name: sketchy
    transport: http
    url: https://evil.example/mcp
    tools: [claude]
`);

    const { changes } = await reconcileMcpForConfig(teamConfig, localConfig);
    expect(changes[0]).toMatchObject({ action: 'skipped' });
    expect(changes[0].reason).toContain('allowedHosts');
  });

  // issue #374 P1-2C: the partition is shared by every linked worktree, so each
  // worktree now gets its OWN managed-mcp.json under
  // <partition>/workspaces/<id>/. One worktree's reconcile can never see or
  // overwrite another worktree's ownership.
  it('reconciling from worktree B does not claim/overwrite B\'s own same-name MCP that A manages', async () => {
    const { managedMcpManifestPath } = await import('../types.js');
    const sharedDataHome = path.join(tmpDir, 'partition');
    await fse.ensureDir(sharedDataHome);
    const wtA = path.join(tmpDir, 'wtA');
    const wtB = path.join(tmpDir, 'wtB');
    for (const wt of [wtA, wtB]) {
      for (const d of ['.claude', '.cursor', '.codebuddy']) {
        await fse.ensureDir(path.join(wt, d, 'skills'));
      }
    }
    const cfgA = { ...localConfig, scope: 'project', projectRoot: wtA, dataHome: sharedDataHome } as unknown as LocalConfig;
    const cfgB = { ...localConfig, scope: 'project', projectRoot: wtB, dataHome: sharedDataHome } as unknown as LocalConfig;

    // 1. Team defines `shared`; worktree A reconciles → A owns it in ITS OWN file.
    await writeMcpYaml(`
servers:
  - name: shared
    transport: http
    url: https://team-v1.example/mcp
`);
    await reconcileMcpForConfig(teamConfig, cfgA);
    expect((await fse.readJson(path.join(wtA, '.mcp.json'))).mcpServers.shared.url)
      .toBe('https://team-v1.example/mcp');

    // 2. Worktree B independently has a USER-OWNED same-name `shared`.
    await fse.writeJson(path.join(wtB, '.mcp.json'), {
      mcpServers: { shared: { type: 'http', url: 'https://mine.example/mcp' } },
    });

    // 3. Reconcile FROM worktree B (team def v2). B reads its OWN (empty) manifest,
    //    so `shared` is unmanaged from B's view → left untouched, reported skipped.
    await writeMcpYaml(`
servers:
  - name: shared
    transport: http
    url: https://team-v2.example/mcp
`);
    const { changes } = await reconcileMcpForConfig(teamConfig, cfgB);

    expect((await fse.readJson(path.join(wtB, '.mcp.json'))).mcpServers.shared.url)
      .toBe('https://mine.example/mcp');
    const claudeShared = changes.find((c) => c.tool === 'claude' && c.server === 'shared');
    expect(claudeShared?.action).toBe('skipped');
    expect((await fse.readJson(path.join(wtA, '.mcp.json'))).mcpServers.shared.url)
      .toBe('https://team-v1.example/mcp');

    // Each worktree has its OWN manifest file; A's owns `shared`, B's does not.
    const aManifest = await fse.readJson(managedMcpManifestPath(sharedDataHome, wtA));
    expect(aManifest['claude:project'].some((r: { name: string }) => r.name === 'shared')).toBe(true);
    const bPath = managedMcpManifestPath(sharedDataHome, wtB);
    const bManifest = (await fse.pathExists(bPath)) ? await fse.readJson(bPath) : {};
    expect((bManifest['claude:project'] ?? []).some((r: { name: string }) => r.name === 'shared')).toBe(false);
    // The two files are at distinct per-worktree paths.
    expect(managedMcpManifestPath(sharedDataHome, wtA)).not.toBe(bPath);
  });

  it('migrates a legacy shared `<tool>:project` manifest into this worktree\'s own file', async () => {
    const { managedMcpManifestPath } = await import('../types.js');
    // Legacy layout: data home IS <projectRoot>/.teamai, ownership under the bare
    // `claude:project` key in the SHARED file written by an old CLI.
    const projectRoot = path.join(tmpDir, 'legacyproj');
    for (const d of ['.claude', '.cursor', '.codebuddy']) {
      await fse.ensureDir(path.join(projectRoot, d, 'skills'));
    }
    const legacyDataHome = path.join(projectRoot, '.teamai');
    await fse.ensureDir(legacyDataHome);
    const cfg = { ...localConfig, scope: 'project', projectRoot, dataHome: legacyDataHome } as unknown as LocalConfig;

    await fse.writeJson(path.join(projectRoot, '.mcp.json'), {
      mcpServers: { shared: { type: 'http', url: 'https://team-v1.example/mcp' } },
    });
    // Old shared file at <dataHome>/managed-mcp.json.
    await fse.writeJson(path.join(legacyDataHome, 'managed-mcp.json'), {
      'claude:project': [{ name: 'shared', hash: 'stale' }],
    });

    await writeMcpYaml(`
servers:
  - name: shared
    transport: http
    url: https://team-v2.example/mcp
`);
    const { changes } = await reconcileMcpForConfig(teamConfig, cfg);

    expect((await fse.readJson(path.join(projectRoot, '.mcp.json'))).mcpServers.shared.url)
      .toBe('https://team-v2.example/mcp');
    const claudeShared = changes.find((c) => c.tool === 'claude' && c.server === 'shared');
    expect(claudeShared?.action).toBe('updated');

    // Ownership migrated INTO this worktree's own file, under the bare key.
    const wtManifest = await fse.readJson(managedMcpManifestPath(legacyDataHome, projectRoot));
    expect(wtManifest['claude:project'].some((r: { name: string }) => r.name === 'shared')).toBe(true);
    // The legacy shared file no longer owns it (claimed key removed).
    const shared = await fse.readJson(path.join(legacyDataHome, 'managed-mcp.json'));
    expect(shared['claude:project']).toBeUndefined();
  });

  it('concurrent reconcile of two worktrees keeps BOTH ownership records (no lost update)', async () => {
    const { managedMcpManifestPath } = await import('../types.js');
    // Two worktrees sharing one partition data home — the exact concurrency the
    // reviewer flagged. Per-worktree files mean simultaneous reconciles touch
    // disjoint files, so neither can clobber the other's ownership record.
    const sharedDataHome = path.join(tmpDir, 'cc-partition');
    await fse.ensureDir(sharedDataHome);
    const wtA = path.join(tmpDir, 'ccA');
    const wtB = path.join(tmpDir, 'ccB');
    for (const wt of [wtA, wtB]) {
      for (const d of ['.claude', '.cursor', '.codebuddy']) {
        await fse.ensureDir(path.join(wt, d, 'skills'));
      }
    }
    const cfgA = { ...localConfig, scope: 'project', projectRoot: wtA, dataHome: sharedDataHome } as unknown as LocalConfig;
    const cfgB = { ...localConfig, scope: 'project', projectRoot: wtB, dataHome: sharedDataHome } as unknown as LocalConfig;

    await writeMcpYaml(`
servers:
  - name: shared
    transport: http
    url: https://team.example/mcp
`);

    // Reconcile both worktrees simultaneously.
    await Promise.all([
      reconcileMcpForConfig(teamConfig, cfgA),
      reconcileMcpForConfig(teamConfig, cfgB),
    ]);

    // BOTH ownership records survive — each in its own per-worktree file.
    const aManifest = await fse.readJson(managedMcpManifestPath(sharedDataHome, wtA));
    const bManifest = await fse.readJson(managedMcpManifestPath(sharedDataHome, wtB));
    expect(aManifest['claude:project'].some((r: { name: string }) => r.name === 'shared')).toBe(true);
    expect(bManifest['claude:project'].some((r: { name: string }) => r.name === 'shared')).toBe(true);
    // And both workspace files got the server.
    expect((await fse.readJson(path.join(wtA, '.mcp.json'))).mcpServers.shared).toBeDefined();
    expect((await fse.readJson(path.join(wtB, '.mcp.json'))).mcpServers.shared).toBeDefined();
  });

  it('project-wide uninstall clears every worktree — no sibling left "server present, ownership missing"', async () => {
    const { managedMcpManifestPath } = await import('../types.js');
    // Two worktrees sharing one partition, both with `shared` installed. This is
    // what `teamai uninstall` (project scope) must handle: it now runs a
    // removeAll reconcile for EVERY worktree before deleting the shared partition,
    // so no sibling is left with an injected server whose ownership record is gone.
    const sharedDataHome = path.join(tmpDir, 'un-partition');
    await fse.ensureDir(sharedDataHome);
    const wtA = path.join(tmpDir, 'unA');
    const wtB = path.join(tmpDir, 'unB');
    for (const wt of [wtA, wtB]) {
      for (const d of ['.claude', '.cursor', '.codebuddy']) {
        await fse.ensureDir(path.join(wt, d, 'skills'));
      }
    }
    const cfgA = { ...localConfig, scope: 'project', projectRoot: wtA, dataHome: sharedDataHome } as unknown as LocalConfig;
    const cfgB = { ...localConfig, scope: 'project', projectRoot: wtB, dataHome: sharedDataHome } as unknown as LocalConfig;

    await writeMcpYaml(`
servers:
  - name: shared
    transport: http
    url: https://team.example/mcp
`);
    await reconcileMcpForConfig(teamConfig, cfgA);
    await reconcileMcpForConfig(teamConfig, cfgB);

    // Project-wide uninstall: removeAll reconcile for BOTH worktrees (mirrors the
    // loop uninstall now runs before deleting the partition).
    await reconcileMcpForConfig(teamConfig, cfgA, { removeAll: true });
    await reconcileMcpForConfig(teamConfig, cfgB, { removeAll: true });

    // Neither worktree ends in the invalid "server present, ownership missing"
    // state: the server is gone from both .mcp.json files.
    for (const [wt, cfg] of [[wtA, cfgA], [wtB, cfgB]] as const) {
      const doc = await fse.readJson(path.join(wt, '.mcp.json'));
      expect(doc.mcpServers?.shared).toBeUndefined();
      // ownership record also cleared for each worktree's own manifest.
      const mfPath = managedMcpManifestPath(sharedDataHome, cfg.projectRoot);
      const mf = (await fse.pathExists(mfPath)) ? await fse.readJson(mfPath) : {};
      expect((mf['claude:project'] ?? []).some((r: { name: string }) => r.name === 'shared')).toBe(false);
    }
  });

  it('migrates ownership from the TRUE old path <workspace>/.teamai/managed-mcp.json (partition install)', async () => {
    const { managedMcpManifestPath } = await import('../types.js');
    // A PARTITION install whose pre-#374 MCP manifest was written to the ORIGINAL
    // workspace path (not the partition). Data home is the partition, but the old
    // ownership lives at <projectRoot>/.teamai/managed-mcp.json.
    const partition = path.join(tmpDir, 'p1-partition');
    const projectRoot = path.join(tmpDir, 'p1-proj');
    for (const d of ['.claude', '.cursor', '.codebuddy']) {
      await fse.ensureDir(path.join(projectRoot, d, 'skills'));
    }
    await fse.ensureDir(partition);
    const cfg = { ...localConfig, scope: 'project', projectRoot, dataHome: partition } as unknown as LocalConfig;

    // Old on-disk state: injected v1 in .mcp.json + ownership at the REAL old path.
    await fse.writeJson(path.join(projectRoot, '.mcp.json'), {
      mcpServers: { shared: { type: 'http', url: 'https://team-v1.example/mcp' } },
    });
    await fse.outputJson(path.join(projectRoot, '.teamai', 'managed-mcp.json'), {
      'claude:project': [{ name: 'shared', hash: 'stale' }],
    });
    // The partition shared file has nothing — the bug read only here.
    await fse.outputJson(path.join(partition, 'managed-mcp.json'), {});

    await writeMcpYaml(`
servers:
  - name: shared
    transport: http
    url: https://team-v2.example/mcp
`);
    const { changes } = await reconcileMcpForConfig(teamConfig, cfg);

    // Ownership recognized → the team server is UPDATED (not skipped as unmanaged).
    expect((await fse.readJson(path.join(projectRoot, '.mcp.json'))).mcpServers.shared.url)
      .toBe('https://team-v2.example/mcp');
    expect(changes.find((c) => c.tool === 'claude' && c.server === 'shared')?.action).toBe('updated');

    // Ownership migrated into this worktree's per-worktree file under the partition.
    const wt = await fse.readJson(managedMcpManifestPath(partition, projectRoot));
    expect(wt['claude:project'].some((r: { name: string }) => r.name === 'shared')).toBe(true);
    // The true old path no longer owns it.
    const oldFile = await fse.readJson(path.join(projectRoot, '.teamai', 'managed-mcp.json'));
    expect(oldFile['claude:project']).toBeUndefined();
  });
});

describe('MCP reconcile — OpenCode', () => {
  let tmpDir: string;
  let homeDir: string;
  let repoPath: string;
  let teamConfig: TeamaiConfig;
  let localConfig: LocalConfig;

  const OPENCODE_TOOL_PATHS = {
    opencode: {
      skills: '.opencode/skills',
      rules: '.opencode/rules',
      agents: '.opencode/agents',
      mcp: '.config/opencode/opencode.json',
      mcpProject: 'opencode.json',
      userScope: { skills: '.config/opencode/skills', rules: '.config/opencode/rules', agents: '.config/opencode/agents' },
    },
  };

  async function writeMcpYaml(body: string): Promise<void> {
    await fse.ensureDir(path.join(repoPath, 'mcp'));
    await fse.writeFile(path.join(repoPath, 'mcp', 'mcp.yaml'), body);
  }

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-mcp-oc-test-'));
    homeDir = path.join(tmpDir, 'home');
    repoPath = path.join(tmpDir, 'team-repo');
    // OpenCode "installed" at user scope lives under ~/.config/opencode.
    await fse.ensureDir(path.join(homeDir, '.config', 'opencode', 'skills'));
    await fse.ensureDir(path.join(homeDir, '.teamai'));
    vi.stubEnv('HOME', homeDir);

    teamConfig = {
      team: 't', description: '', repo: 'r', provider: 'tgit', reviewers: [],
      sharing: {
        skills: {}, rules: { enforced: [] }, docs: { localDir: '~/.teamai/docs' },
        env: { injectShellProfile: false }, mcp: { autoApply: true, allowedCommands: [], allowedHosts: [] },
      },
      toolPaths: OPENCODE_TOOL_PATHS,
    } as unknown as TeamaiConfig;

    localConfig = {
      repo: { localPath: repoPath, remote: 'r' },
      username: 'u', scope: 'user', additionalRoles: [],
    } as unknown as LocalConfig;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  const ocConfig = () => path.join(homeDir, '.config', 'opencode', 'opencode.json');

  it('writes servers under the `mcp` key, not `mcpServers`, in local shape', async () => {
    await writeMcpYaml(`
servers:
  - name: local-srv
    transport: stdio
    command: my-server
    args: ["--port", "3000"]
    env:
      FOO: bar
`);
    await reconcileMcpForConfig(teamConfig, localConfig);

    const doc = await fse.readJson(ocConfig());
    expect(doc.mcpServers).toBeUndefined();
    expect(doc.mcp['local-srv']).toEqual({
      type: 'local',
      command: ['my-server', '--port', '3000'],
      environment: { FOO: 'bar' },
      enabled: true,
    });
  });

  it('renders a remote (http) server with url + headers', async () => {
    await writeMcpYaml(`
servers:
  - name: remote-srv
    transport: http
    url: https://example.com/mcp
    headers:
      Authorization: Bearer tok
`);
    await reconcileMcpForConfig(teamConfig, localConfig);

    const doc = await fse.readJson(ocConfig());
    expect(doc.mcp['remote-srv']).toEqual({
      type: 'remote',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer tok' },
      enabled: true,
    });
  });

  it('preserves unrelated keys (instructions) and the user\'s own mcp entries', async () => {
    await fse.ensureDir(path.dirname(ocConfig()));
    await fse.writeJson(ocConfig(), {
      $schema: 'https://opencode.ai/config.json',
      instructions: ['.opencode/rules/*.md'],
      mcp: { mine: { type: 'local', command: ['x'], enabled: true } },
    });
    await writeMcpYaml(`
servers:
  - name: team-srv
    transport: http
    url: https://team.example/mcp
`);
    await reconcileMcpForConfig(teamConfig, localConfig);

    const doc = await fse.readJson(ocConfig());
    expect(doc.$schema).toBe('https://opencode.ai/config.json');
    expect(doc.instructions).toEqual(['.opencode/rules/*.md']);
    expect(doc.mcp.mine).toEqual({ type: 'local', command: ['x'], enabled: true });
    expect(doc.mcp['team-srv'].type).toBe('remote');
  });

  it('removes a dropped team server from the mcp key on a later run', async () => {
    await writeMcpYaml(`
servers:
  - name: temp
    transport: http
    url: https://example.com/mcp
`);
    await reconcileMcpForConfig(teamConfig, localConfig);
    expect((await fse.readJson(ocConfig())).mcp.temp).toBeDefined();

    await writeMcpYaml(`servers: []\n`);
    await reconcileMcpForConfig(teamConfig, localConfig);
    expect((await fse.readJson(ocConfig())).mcp.temp).toBeUndefined();
  });
});

describe('spliceCodexBlock', () => {
  it('replaces a block and its nested env sub-table, leaving neighbours intact', () => {
    const src = [
      '# header comment',
      'model = "gpt-5"',
      '',
      '[mcp_servers.a]',
      'command = "old"',
      '',
      '[mcp_servers.a.env]',
      'OLD = "1"',
      '',
      '[projects."/x"]',
      'trust_level = "trusted"',
      '',
    ].join('\n');

    const out = spliceCodexBlock(src, 'a', '[mcp_servers.a]\ncommand = "new"\n');

    expect(out).toContain('# header comment');
    expect(out).toContain('command = "new"');
    expect(out).not.toContain('OLD = "1"');
    expect(out).toContain('[projects."/x"]');
    expect(out).toContain('trust_level = "trusted"');
  });

  it('deletes a block when passed null', () => {
    const src = '[mcp_servers.a]\ncommand = "x"\n\n[projects."/y"]\ntrust_level = "trusted"\n';
    const out = spliceCodexBlock(src, 'a', null);
    expect(out).not.toContain('mcp_servers.a');
    expect(out).toContain('[projects."/y"]');
  });

  // Regression: the end-of-input branch was originally written as \z, which JS
  // reads as a literal "z", so a trailing block could never be matched.
  it('deletes a block sitting at end-of-file', () => {
    const src = 'model = "gpt-5"\n\n[mcp_servers.last]\ncommand = "x"\n';
    const out = spliceCodexBlock(src, 'last', null);
    expect(out).not.toContain('mcp_servers.last');
    expect(out).toContain('model = "gpt-5"');
  });

  it('deletes a trailing block including its env sub-table', () => {
    const src = '[projects."/y"]\nt = 1\n\n[mcp_servers.last]\ncommand = "x"\n\n[mcp_servers.last.env]\nA = "1"\n';
    const out = spliceCodexBlock(src, 'last', null);
    expect(out).not.toContain('mcp_servers.last');
    expect(out).not.toContain('A = "1"');
    expect(out).toContain('[projects."/y"]');
  });

  it('replaces a trailing block in place', () => {
    const src = 'model = "x"\n\n[mcp_servers.last]\ncommand = "old"\n';
    const out = spliceCodexBlock(src, 'last', '[mcp_servers.last]\ncommand = "new"\n');
    expect(out).toContain('command = "new"');
    expect(out).not.toContain('command = "old"');
  });

  it('appends when the block is absent', () => {
    const src = 'model = "gpt-5"\n';
    const out = spliceCodexBlock(src, 'newone', '[mcp_servers.newone]\ncommand = "x"\n');
    expect(out).toContain('model = "gpt-5"');
    expect(out).toContain('[mcp_servers.newone]');
  });

  it('lists existing server names', () => {
    const src = '[mcp_servers.a]\n\n[mcp_servers.b]\n\n[mcp_servers.b.env]\nX = "1"\n';
    expect(codexServerNames(src).sort()).toEqual(['a', 'b']);
  });
});
