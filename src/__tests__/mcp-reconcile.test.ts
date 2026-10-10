import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import { execFileSync } from 'node:child_process';

vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
    persist: vi.fn(),
  },
  spinner: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
  })),
}));

// What .git/info/exclude held at the moment each JSON config was written (#882).
const excludeAtWrite = vi.hoisted(() => new Map<string, string | null>());
// Runs just before each JSON config write, as a concurrent command would.
const beforeJsonWrite = vi.hoisted(() => ({ run: null as null | ((file: string) => Promise<void>) }));
vi.mock('../utils/fs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/fs.js')>();
  return {
    ...actual,
    writeJsonAtomic: async (...args: Parameters<typeof actual.writeJsonAtomic>) => {
      const [file] = args;
      await beforeJsonWrite.run?.(String(file));
      const gitDir = path.join(path.dirname(String(file)), '.git');
      if (await fse.pathExists(gitDir)) {
        excludeAtWrite.set(String(file), await actual.readFileSafe(path.join(gitDir, 'info', 'exclude')));
      }
      return actual.writeJsonAtomic(...args);
    },
  };
});

import { reconcileMcpForConfig, releaseCleanMcpGitExcludes, resolveMcpTargets, spliceCodexBlock, codexServerNames, writeCodexAtomic } from '../mcp-reconcile.js';
import { acquireLock, releaseLock } from '../update.js';
import { log } from '../utils/logger.js';
import { resetWarnOnce } from '../utils/warn-once.js';
import { TeamaiConfigSchema, type TeamaiConfig, type LocalConfig } from '../types.js';

const TOOL_PATHS = {
  claude: { skills: '.claude/skills', settings: '.claude/settings.json', mcp: '.claude.json', mcpProject: '.mcp.json' },
  cursor: { skills: '.cursor/skills', settings: '.cursor/hooks.json', mcp: '.cursor/mcp.json', mcpProject: '.cursor/mcp.json' },
  codebuddy: { skills: '.codebuddy/skills', settings: '.codebuddy/settings.json', mcp: '.codebuddy/mcp.json', mcpProject: '.codebuddy/mcp.json' },
  codex: { skills: '.codex/skills', settings: '.codex/hooks.json', mcp: '.codex/config.toml' },
  tclaude: { skills: '.tclaude/skills', settings: '.tclaude/settings.json', mcp: '.tclaude/.claude.json' },
};
// CodeBuddy at its built-in .mcp.json, beside Claude. TOOL_PATHS moves it, which makes .mcp.json a location of
// CodeBuddy's that no record of it describes: any server there that Claude's records don't own holds a line (#882).
const UNMOVED_TOOL_PATHS = { ...TOOL_PATHS, codebuddy: { ...TOOL_PATHS.codebuddy, mcpProject: '.mcp.json' } };

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
    resetWarnOnce();
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

  it('removeAll on a config narrowed to one tool leaves the other tools\' servers and manifest rows alone', async () => {
    // `teamai init` releases only Claude's MCP file when the Claude root moves;
    // it hands the reconciler a team config whose toolPaths hold Claude alone.
    await writeMcpYaml(`
servers:
  - name: team-server
    transport: http
    url: https://example.com/mcp
`);
    await reconcileMcpForConfig(teamConfig, localConfig);
    const cursorFile = path.join(homeDir, TOOL_PATHS.cursor.mcp!);
    expect((await fse.readJson(cursorFile)).mcpServers['team-server']).toBeDefined();

    const claudeOnly = { ...teamConfig, toolPaths: { claude: TOOL_PATHS.claude } } as TeamaiConfig;
    const { changes } = await reconcileMcpForConfig(claudeOnly, localConfig, { removeAll: true });

    expect(changes.map((c) => `${c.tool}:${c.action}`)).toEqual(['claude:removed']);
    expect((await fse.readJson(path.join(homeDir, '.claude.json'))).mcpServers?.['team-server']).toBeUndefined();
    expect((await fse.readJson(cursorFile)).mcpServers['team-server']).toBeDefined();
    const manifest = await fse.readJson(path.join(homeDir, '.teamai', 'managed-mcp.json'));
    expect(Object.keys(manifest).some((k) => k.startsWith('cursor'))).toBe(true);
    expect(Object.keys(manifest).some((k) => k.startsWith('claude'))).toBe(false);
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

  it('resolves ${VAR} from the team env variables this member receives', async () => {
    await fse.outputFile(path.join(repoPath, 'env', 'env.yaml'), 'variables:\n  - key: TEAM_TOKEN\n    value: s3cret\n');
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

  it('resolves ${VAR} from an active namespace env file that overrides the root one', async () => {
    await fse.outputFile(path.join(repoPath, 'manifest', 'projects.yaml'),
      'version: 1\nprojects:\n  - id: checkout\n    resources: { env: [checkout] }\n');
    await fse.outputFile(path.join(repoPath, 'env', 'env.yaml'), 'variables:\n  - key: API_BASE\n    value: https://api.example.com\n');
    await fse.outputFile(path.join(repoPath, 'env', 'checkout', 'env.yaml'), 'variables:\n  - key: API_BASE\n    value: https://checkout.example.com\n');
    // A stale installed backup must not win over the resolved set.
    await fse.writeFile(path.join(homeDir, '.teamai', 'env'), 'API_BASE=https://stale.example.com\n');
    await writeMcpYaml(`
servers:
  - name: api
    transport: http
    url: \${API_BASE}/mcp
    tools: [claude]
`);

    await reconcileMcpForConfig(teamConfig, { ...localConfig, projects: ['checkout'] });

    const after = await fse.readJson(path.join(homeDir, '.claude.json'));
    expect(after.mcpServers.api.url).toBe('https://checkout.example.com/mcp');
  });

  it('falls back to the installed env values while the team env cannot be resolved', async () => {
    // Pull keeps env.sh as it is in that case, so MCP sees what the shell sees.
    await fse.outputFile(path.join(repoPath, 'env', 'env.yaml'), 'variables: [unclosed\n');
    await fse.writeFile(path.join(homeDir, '.teamai', 'env'), 'TEAM_TOKEN=installed\n');
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
    expect(after.mcpServers['with-token'].headers.Authorization).toBe('Bearer installed');
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

  // #822: `server:` for `servers:` parsed as "no servers" and uninstalled every
  // team server for every member, with no warning.
  it('keeps every installed server when mcp.yaml has no top-level servers: key, and names the file and key', async () => {
    const temp = `
  - name: temp
    transport: http
    url: https://example.com/mcp
    tools: [claude]
`;
    await writeMcpYaml(`servers:${temp}`);
    await reconcileMcpForConfig(teamConfig, localConfig);
    const { log } = await import('../utils/logger.js');
    vi.mocked(log.warn).mockClear();

    await writeMcpYaml(`server:${temp}`);
    const { changes } = await reconcileMcpForConfig(teamConfig, localConfig);

    expect(changes).toEqual([]);
    expect((await fse.readJson(path.join(homeDir, '.claude.json'))).mcpServers.temp).toBeDefined();
    const warnings = vi.mocked(log.warn).mock.calls.map(([m]) => String(m));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('mcp/mcp.yaml');
    expect(warnings[0]).toContain('`server`');
    expect(warnings[0]).toContain('`servers:`');
  });

  it('still installs the servers of an mcp.yaml that carries an extra top-level key', async () => {
    await writeMcpYaml(`
version: 1
servers:
  - name: temp
    transport: http
    url: https://example.com/mcp
    tools: [claude]
`);
    await reconcileMcpForConfig(teamConfig, localConfig);

    expect((await fse.readJson(path.join(homeDir, '.claude.json'))).mcpServers.temp).toBeDefined();
  });

  // roles: on a server shipped in 0.25.0 and keeps filtering for one minor
  // release (#707); the warning names the namespace file it belongs in.
  describe('deprecated roles filter', () => {
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

    it('warns once per server, naming the namespace file, and still applies the rest', async () => {
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
      await reconcileMcpForConfig(teamConfig, { ...localConfig, primaryRole: 'frontend', additionalRoles: [] });

      const warnings = vi.mocked(log.warn).mock.calls.map(([m]) => String(m)).filter((m) => /frontned/.test(m));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('mcp/mcp.yaml: server "typo" is scoped with per-entry `roles:`, which is deprecated');
      // No such role, so no declared namespace: the warning says what to declare.
      expect(warnings[0]).toContain('mcp/frontned/mcp.yaml (declare mcp: [frontned] for role frontned in manifest/roles.yaml)');
    });
  });

  describe('namespaces (#707)', () => {
    const PROJECTS_YAML = `
version: 1
projects:
  - id: checkout
    resources: { mcp: [checkout] }
  - id: billing
    resources: { mcp: [billing] }
`;
    async function claudeServers(): Promise<Record<string, { url?: string }>> {
      return (await fse.readJson(path.join(homeDir, '.claude.json'))).mcpServers ?? {};
    }
    async function writeNamespaceMcp(namespace: string, body: string): Promise<void> {
      await fse.outputFile(path.join(repoPath, 'mcp', namespace, 'mcp.yaml'), body);
    }
    beforeEach(async () => {
      await fse.outputFile(path.join(repoPath, 'manifest', 'projects.yaml'), PROJECTS_YAML);
      await writeMcpYaml(`
servers:
  - name: db
    transport: http
    url: https://example.com/db
  - name: shared
    transport: http
    url: https://example.com/shared
`);
      await writeNamespaceMcp('checkout', `
servers:
  - name: db
    transport: http
    url: https://checkout.example.com/db
  - name: orders
    transport: http
    url: https://checkout.example.com/orders
`);
    });

    it('installs an active namespace server in place of the root server of the same name', async () => {
      await reconcileMcpForConfig(teamConfig, { ...localConfig, projects: ['checkout'] });

      const servers = await claudeServers();
      expect(Object.keys(servers).sort()).toEqual(['db', 'orders', 'shared']);
      expect(servers.db?.url).toBe('https://checkout.example.com/db');
    });

    it('restores the root server and removes namespace-only ones once the namespace deactivates', async () => {
      await reconcileMcpForConfig(teamConfig, { ...localConfig, projects: ['checkout'] });
      const { changes } = await reconcileMcpForConfig(teamConfig, { ...localConfig, projects: ['billing'] });

      const servers = await claudeServers();
      expect(Object.keys(servers).sort()).toEqual(['db', 'shared']);
      expect(servers.db?.url).toBe('https://example.com/db');
      expect(changes.some((c) => c.server === 'orders' && c.action === 'removed')).toBe(true);
    });

    it('keeps every installed server when two active namespaces define the same name', async () => {
      await reconcileMcpForConfig(teamConfig, { ...localConfig, projects: ['checkout'] });
      const before = await claudeServers();
      await writeNamespaceMcp('billing', `
servers:
  - name: orders
    transport: http
    url: https://billing.example.com/orders
`);
      const { log } = await import('../utils/logger.js');
      vi.mocked(log.warn).mockClear();
      resetWarnOnce();

      const { changes } = await reconcileMcpForConfig(teamConfig, { ...localConfig, projects: ['checkout', 'billing'] });

      expect(changes).toEqual([]);
      expect(await claudeServers()).toEqual(before);
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(
        'server "orders" is defined in both mcp/checkout/mcp.yaml and mcp/billing/mcp.yaml',
      ));
    });

    it('keeps every installed server when an active file does not parse (no longer reconciles to empty)', async () => {
      await reconcileMcpForConfig(teamConfig, { ...localConfig, projects: ['checkout'] });
      const before = await claudeServers();
      await writeNamespaceMcp('checkout', 'servers: [unclosed\n');

      const { changes } = await reconcileMcpForConfig(teamConfig, { ...localConfig, projects: ['checkout'] });

      expect(changes).toEqual([]);
      expect(await claudeServers()).toEqual(before);
    });

    it('keeps every installed server when the root file names a server twice', async () => {
      await reconcileMcpForConfig(teamConfig, { ...localConfig, projects: ['checkout'] });
      const before = await claudeServers();
      await writeMcpYaml(`
servers:
  - name: shared
    transport: http
    url: https://example.com/shared
  - name: shared
    transport: http
    url: https://example.com/shared-again
`);
      const { log } = await import('../utils/logger.js');
      resetWarnOnce();

      await reconcileMcpForConfig(teamConfig, { ...localConfig, projects: ['checkout'] });

      expect(await claudeServers()).toEqual(before);
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('mcp/mcp.yaml defines server "shared" more than once'));
    });

    it('keeps a 0.25 file that repeats one server under different roles: working as 0.25 did', async () => {
      // 0.25.0 kept the last copy that passed the role filter; a member with no
      // role passes every copy.
      await writeMcpYaml(`
servers:
  - name: db
    transport: http
    url: https://example.com/frontend-db
    roles: [frontend]
  - name: db
    transport: http
    url: https://example.com/devops-db
    roles: [devops]
`);

      await reconcileMcpForConfig(teamConfig, { ...localConfig, projects: ['billing'] });

      expect((await claudeServers()).db?.url).toBe('https://example.com/devops-db');
    });

    it('installs no server that carries the removed projects key', async () => {
      await writeMcpYaml(`
servers:
  - name: checkout-db
    transport: http
    url: https://example.com/checkout
    projects: [checkout]
  - name: shared
    transport: http
    url: https://example.com/shared
`);
      const { log } = await import('../utils/logger.js');
      resetWarnOnce();

      await reconcileMcpForConfig(teamConfig, { ...localConfig, projects: ['billing'] });

      expect(Object.keys(await claudeServers()).sort()).toEqual(['shared']);
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(
        'mcp/mcp.yaml: server "checkout-db" is scoped with per-entry `projects:`, which this version no longer reads, '
        + 'so it reaches nobody. Move it to mcp/checkout/mcp.yaml and drop the key.',
      ));
    });

    // A typo of a scoping key (#822) must not widen who gets the server.
    const warningsAbout = async (file: string, server: string): Promise<string[]> => {
      const { log } = await import('../utils/logger.js');
      return vi.mocked(log.warn).mock.calls.map(([m]) => String(m))
        .filter((m) => m.includes(file) && m.includes(`"${server}"`));
    };

    it('installs no server that carries a key MCP does not know, and names the file, server and key', async () => {
      await writeMcpYaml(`
servers:
  - name: fe-db
    transport: http
    url: https://example.com/fe-db
    role: [frontend]
  - name: shared
    transport: http
    url: https://example.com/shared
`);
      const { log } = await import('../utils/logger.js');
      vi.mocked(log.warn).mockClear();
      resetWarnOnce();

      await reconcileMcpForConfig(teamConfig, { ...localConfig, projects: ['billing'] });

      expect(Object.keys(await claudeServers()).sort()).toEqual(['shared']);
      const warnings = await warningsAbout('mcp/mcp.yaml', 'fe-db');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/\brole\b/);
    });

    it('keeps the root server when the active namespace copy of it carries an unknown key', async () => {
      await writeNamespaceMcp('checkout', `
servers:
  - name: db
    transport: http
    url: https://checkout.example.com/db
    role: [frontend]
`);
      const { log } = await import('../utils/logger.js');
      vi.mocked(log.warn).mockClear();
      resetWarnOnce();

      await reconcileMcpForConfig(teamConfig, { ...localConfig, projects: ['checkout'] });

      expect((await claudeServers()).db?.url).toBe('https://example.com/db');
      const warnings = await warningsAbout('mcp/checkout/mcp.yaml', 'db');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/\brole\b/);
    });

    it('installs a server with every key MCP knows, with no warning beyond the roles: deprecation', async () => {
      await writeMcpYaml(`
servers:
  - name: full
    description: every known key
    transport: stdio
    command: node
    args: [server.js]
    url: https://example.com/unused
    headers: { X-Team: t }
    env: { LEVEL: debug }
    timeout: 30
    requires: [node]
    tools: [claude]
    roles: [frontend]
`);
      const { log } = await import('../utils/logger.js');
      vi.mocked(log.warn).mockClear();
      resetWarnOnce();

      await reconcileMcpForConfig(teamConfig, { ...localConfig, projects: ['billing'] });

      expect(Object.keys(await claudeServers())).toEqual(['full']);
      const warnings = await warningsAbout('mcp/mcp.yaml', 'full');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('is scoped with per-entry `roles:`, which is deprecated');
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
    // No `mcpProject` in this map means no project target: codex here is
    // mapped without one, and tclaude reads the <root>/.mcp.json that the
    // claude target already writes.
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

  // #954: Codex reads <project>/.codex/config.toml once the project is trusted.
  it('writes team servers to the Codex project config by default, and removes only its own block', async () => {
    const projectRoot = path.join(tmpDir, 'codex-project');
    await fse.ensureDir(path.join(projectRoot, '.codex', 'skills'));
    const projectFile = path.join(projectRoot, '.codex', 'config.toml');
    const own = '# project settings\nmodel = "gpt-5"\n';
    await fse.writeFile(projectFile, own);
    const defaults = TeamaiConfigSchema.parse({ team: 't', repo: 'r', provider: 'git' });
    const projectConfig: LocalConfig = { ...localConfig, scope: 'project', projectRoot };
    await writeMcpYaml('servers:\n  - name: team-docs\n    transport: stdio\n    command: docs-server\n');

    const targets = await resolveMcpTargets(defaults, projectConfig);
    expect(targets.find((target) => target.tool === 'codex')?.file).toBe(projectFile);

    await reconcileMcpForConfig(defaults, projectConfig);
    const written = await fse.readFile(projectFile, 'utf-8');
    expect(written.startsWith(own)).toBe(true);
    expect(codexServerNames(written)).toEqual(['team-docs']);
    expect(await fse.pathExists(path.join(homeDir, '.codex', 'config.toml'))).toBe(false);

    await writeMcpYaml('servers: []\n');
    await reconcileMcpForConfig(defaults, projectConfig);
    expect(codexServerNames(await fse.readFile(projectFile, 'utf-8'))).toEqual([]);
    expect(await fse.readFile(projectFile, 'utf-8')).toContain(own.trimEnd());
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

  describe('project MCP configs holding a resolved value stay out of git (#882)', () => {
    let projectRoot: string;
    let projectConfig: LocalConfig;
    const git = (cwd: string, ...args: string[]): string =>
      execFileSync('git', args, { cwd, encoding: 'utf-8' });
    const excludeOf = (root: string): Promise<string> =>
      fse.readFile(path.join(root, '.git', 'info', 'exclude'), 'utf-8');
    const withSecret = `
servers:
  - name: with-secret
    transport: http
    url: https://example.com/mcp
    headers:
      Authorization: Bearer \${SECRET_TOKEN}
`;

    beforeEach(async () => {
      projectRoot = path.join(tmpDir, 'business-repo');
      for (const d of ['.claude', '.cursor']) await fse.ensureDir(path.join(projectRoot, d, 'skills'));
      git(projectRoot, 'init', '-q');
      projectConfig = { ...localConfig, scope: 'project', projectRoot } as unknown as LocalConfig;
      vi.stubEnv('SECRET_TOKEN', 'super-secret-value');
    });
    const unmovedConfig = (): TeamaiConfig => ({ ...teamConfig, toolPaths: UNMOVED_TOOL_PATHS } as TeamaiConfig);
    // A worktree an earlier pull ran in, holding nothing of teamai's. With no managed-mcp.json at all,
    // any server in a config may be one teamai wrote, and the pull notes it (#882).
    const pulledBefore = async (): Promise<void> => {
      const { getDataHome, managedMcpManifestPath } = await import('../types.js');
      await fse.outputJson(managedMcpManifestPath(getDataHome(projectConfig), projectRoot), { 'claude:project': [], 'cursor:project': [] });
    };

    it('lists again the config of a tool whose record alone is lost, while it holds a server no record claims', async () => {
      await writeMcpYaml(withSecret);
      await reconcileMcpForConfig(teamConfig, projectConfig);
      expect(await fse.readFile(path.join(projectRoot, '.cursor', 'mcp.json'), 'utf-8')).toContain('super-secret-value');
      const { getDataHome, managedMcpManifestPath } = await import('../types.js');
      const manifestFile = managedMcpManifestPath(getDataHome(projectConfig), projectRoot);
      const manifest = await fse.readJson(manifestFile) as Record<string, unknown>;
      delete manifest['cursor:project'];
      await fse.writeJson(manifestFile, manifest);
      await fse.writeFile(path.join(projectRoot, '.git', 'info', 'exclude'), '');
      await writeMcpYaml('servers:\n  - name: open\n    transport: http\n    url: https://example.com/open\n');
      vi.stubEnv('SECRET_TOKEN', '');

      await reconcileMcpForConfig(teamConfig, { ...projectConfig, disabledAgents: ['cursor'] } as LocalConfig);

      expect(await fse.readFile(path.join(projectRoot, '.cursor', 'mcp.json'), 'utf-8')).toContain('super-secret-value');
      expect(await excludeOf(projectRoot)).toMatch(/^\/\.cursor\/mcp\.json$/m);
    });

    it('lists again the config an uninstalled tool left, its record lost, while it holds a server no record claims', async () => {
      // OpenCode's config sits outside its root: uninstalled (.opencode gone), opencode.json stays.
      const withOpencode = { ...teamConfig, toolPaths: { ...TOOL_PATHS, opencode: { skills: '.opencode/skills', mcp: '.config/opencode/opencode.json', mcpProject: 'opencode.json' } } } as TeamaiConfig;
      await fse.ensureDir(path.join(projectRoot, '.opencode', 'skills'));
      // Claude's record stays: only OpenCode's is lost.
      await writeMcpYaml(`${withSecret}    tools: [opencode]\n  - name: open\n    transport: http\n    url: https://example.com/open\n    tools: [claude]\n`);
      await reconcileMcpForConfig(withOpencode, projectConfig);
      const opencodeFile = path.join(projectRoot, 'opencode.json');
      expect(await fse.readFile(opencodeFile, 'utf-8')).toContain('super-secret-value');
      const { getDataHome, managedMcpManifestPath } = await import('../types.js');
      const manifestFile = managedMcpManifestPath(getDataHome(projectConfig), projectRoot);
      const manifest = await fse.readJson(manifestFile) as Record<string, unknown>;
      delete manifest['opencode:project'];
      await fse.writeJson(manifestFile, manifest);
      const { resolvedMcpFilesPath } = await import('../mcp-resolved-files.js');
      await fse.remove(resolvedMcpFilesPath(projectConfig) ?? '');
      await fse.remove(path.join(projectRoot, '.opencode'));
      await fse.writeFile(path.join(projectRoot, '.git', 'info', 'exclude'), '');
      await writeMcpYaml('servers:\n  - name: open\n    transport: http\n    url: https://example.com/open\n');
      vi.stubEnv('SECRET_TOKEN', '');

      await reconcileMcpForConfig(withOpencode, projectConfig);

      expect(await fse.readFile(opencodeFile, 'utf-8')).toContain('super-secret-value');
      expect(await excludeOf(projectRoot)).toMatch(/^\/opencode\.json$/m);
    });

    it('keeps suspect a tool managed-mcp-files.json lists as a writer, uninstalled since, though an installed tool maps the file', async () => {
      const unmoved = { ...teamConfig, toolPaths: UNMOVED_TOOL_PATHS } as TeamaiConfig;
      await fse.ensureDir(path.join(projectRoot, '.codebuddy', 'skills'));
      await writeMcpYaml(`${withSecret}    tools: [codebuddy]\n  - name: open\n    transport: http\n    url: https://example.com/open\n    tools: [claude]\n`);
      await reconcileMcpForConfig(unmoved, projectConfig);
      expect(await fse.readFile(path.join(projectRoot, '.mcp.json'), 'utf-8')).toContain('super-secret-value');
      const { getDataHome, managedMcpManifestPath } = await import('../types.js');
      const manifestFile = managedMcpManifestPath(getDataHome(projectConfig), projectRoot);
      const manifest = await fse.readJson(manifestFile) as Record<string, unknown>;
      delete manifest['codebuddy:project'];
      await fse.writeJson(manifestFile, manifest);
      await fse.remove(path.join(projectRoot, '.codebuddy'));
      await fse.writeFile(path.join(projectRoot, '.git', 'info', 'exclude'), '');
      await writeMcpYaml('servers:\n  - name: open\n    transport: http\n    url: https://example.com/open\n    tools: [claude]\n');
      vi.stubEnv('SECRET_TOKEN', '');

      await reconcileMcpForConfig(unmoved, projectConfig);

      expect(await fse.readFile(path.join(projectRoot, '.mcp.json'), 'utf-8')).toContain('super-secret-value');
      expect(await excludeOf(projectRoot)).toMatch(/^\/\.mcp\.json$/m);
    });

    it('never lets a tool that maps a moved tool\'s file today claim its stale server under another key', async () => {
      const opencode = { skills: '.opencode/skills', mcp: '.config/opencode/opencode.json', mcpProject: '.mcp.json' };
      const before = { ...teamConfig, toolPaths: { ...TOOL_PATHS, cursor: { ...TOOL_PATHS.cursor, mcpProject: '.mcp.json' }, opencode } } as TeamaiConfig;
      const after = { ...teamConfig, toolPaths: { ...TOOL_PATHS, opencode } } as TeamaiConfig;
      await fse.ensureDir(path.join(projectRoot, '.opencode', 'skills'));
      const open = '  - name: open\n    transport: http\n    url: https://example.com/open\n    tools: [claude]\n';
      await writeMcpYaml(`servers:\n  - name: x\n    transport: http\n    url: https://example.com/x\n    headers:\n      Authorization: Bearer \${SECRET_TOKEN}\n    tools: [cursor]\n${open}`);
      await reconcileMcpForConfig(before, projectConfig);
      expect(await fse.readFile(path.join(projectRoot, '.mcp.json'), 'utf-8')).toContain('super-secret-value');
      // Cursor moves back to .cursor/mcp.json; OpenCode, on .mcp.json, now owns a literal x under `mcp`.
      await writeMcpYaml(`servers:\n  - name: x\n    transport: http\n    url: https://example.com/x\n    tools: [opencode]\n${open}`);
      vi.stubEnv('SECRET_TOKEN', '');
      await fse.writeFile(path.join(projectRoot, '.git', 'info', 'exclude'), '');

      await reconcileMcpForConfig(after, projectConfig);

      expect(await fse.readFile(path.join(projectRoot, '.mcp.json'), 'utf-8')).toContain('super-secret-value');
      expect(await excludeOf(projectRoot)).toMatch(/^\/\.mcp\.json$/m);
    });

    it('never lets a tool that maps a moved Copilot\'s file today claim its stale bare server by the name it owns under mcpServers', async () => {
      const copilot = { skills: '.github/skills', mcp: '.copilot/mcp-config.json' };
      const before = { ...teamConfig, toolPaths: { ...TOOL_PATHS, copilot: { ...copilot, mcpProject: '.mcp.json' } } } as TeamaiConfig;
      const after = { ...teamConfig, toolPaths: { ...TOOL_PATHS, copilot: { ...copilot, mcpProject: '.github/mcp.json' } } } as TeamaiConfig;
      await fse.ensureDir(path.join(projectRoot, '.github', 'skills'));
      // An empty file reads as Copilot's bare map: its write stays bare.
      await fse.writeFile(path.join(projectRoot, '.mcp.json'), '');
      await writeMcpYaml(`${withSecret}    tools: [copilot]\n`);
      await reconcileMcpForConfig(before, projectConfig);
      expect((await fse.readJson(path.join(projectRoot, '.mcp.json')) as Record<string, unknown>)['with-secret']).toBeDefined();
      // Copilot moves to .github/mcp.json; Claude, on .mcp.json, now owns a literal with-secret under mcpServers.
      await writeMcpYaml(`${withSecret.replace('${SECRET_TOKEN}', 'published-literal')}    tools: [claude]\n`);
      vi.stubEnv('SECRET_TOKEN', '');
      await fse.writeFile(path.join(projectRoot, '.git', 'info', 'exclude'), '');

      await reconcileMcpForConfig(after, projectConfig);

      const doc = await fse.readJson(path.join(projectRoot, '.mcp.json')) as Record<string, unknown>;
      expect((doc.mcpServers as Record<string, unknown>)['with-secret']).toBeDefined();
      expect(JSON.stringify(doc['with-secret'])).toContain('super-secret-value');
      expect(await excludeOf(projectRoot)).toMatch(/^\/\.mcp\.json$/m);
    });

    it('never lets a tool whose MCP path links to another tool\'s file adopt the server that tool\'s record claims', async () => {
      const shared = { ...teamConfig, toolPaths: TOOL_PATHS } as TeamaiConfig;
      await fse.ensureDir(path.join(projectRoot, '.cursor', 'skills'));
      await fse.writeJson(path.join(projectRoot, '.mcp.json'), {});
      await fse.symlink('../.mcp.json', path.join(projectRoot, '.cursor', 'mcp.json'));
      await writeMcpYaml('servers:\n  - name: x\n    transport: http\n    url: https://example.com/x\n    tools: [claude, cursor]\n');
      await reconcileMcpForConfig(shared, projectConfig);
      const { getDataHome, managedMcpManifestPath } = await import('../types.js');
      const manifestFile = managedMcpManifestPath(getDataHome(projectConfig), projectRoot);
      const manifest = await fse.readJson(manifestFile) as Record<string, Array<{ name: string }>>;
      expect(manifest['claude:project'].map((r) => r.name)).toEqual(['x']);
      // Cursor's record is lost: the x in the file it reads through the link is Claude's.
      delete manifest['cursor:project'];
      await fse.writeJson(manifestFile, manifest);

      await reconcileMcpForConfig(shared, projectConfig);

      const after = await fse.readJson(manifestFile) as Record<string, Array<{ name: string }> | undefined>;
      expect((after['cursor:project'] ?? []).map((r) => r.name)).not.toContain('x');
      expect(Object.keys((await fse.readJson(path.join(projectRoot, '.mcp.json')) as { mcpServers: object }).mcpServers)).toEqual(['x']);
    });

    it('restores a file two tools write through linked paths to what it was before the run, when ownership cannot be saved', async () => {
      const shared = { ...teamConfig, toolPaths: TOOL_PATHS } as TeamaiConfig;
      await fse.ensureDir(path.join(projectRoot, '.cursor', 'skills'));
      await fse.writeJson(path.join(projectRoot, '.mcp.json'), {});
      await fse.symlink('../.mcp.json', path.join(projectRoot, '.cursor', 'mcp.json'));
      await writeMcpYaml('servers:\n  - name: x\n    transport: http\n    url: https://example.com/x\n    tools: [claude, cursor]\n');
      await reconcileMcpForConfig(shared, projectConfig);
      const before = await fse.readFile(path.join(projectRoot, '.mcp.json'), 'utf8');
      const { getDataHome, managedMcpManifestPath } = await import('../types.js');
      const manifestDir = path.dirname(managedMcpManifestPath(getDataHome(projectConfig), projectRoot));
      await writeMcpYaml('servers:\n  - name: x\n    transport: http\n    url: https://example.com/x2\n    tools: [claude, cursor]\n'
        + '  - name: y\n    transport: http\n    url: https://example.com/y\n    tools: [cursor]\n');
      await fse.chmod(manifestDir, 0o555);
      try {
        await expect(reconcileMcpForConfig(shared, projectConfig)).rejects.toThrow();
      } finally {
        await fse.chmod(manifestDir, 0o755);
      }
      expect(await fse.readFile(path.join(projectRoot, '.mcp.json'), 'utf8')).toBe(before);
    });

    it('never lets one format\'s record claim a server of the same name under another format\'s key', async () => {
      const toolPaths = {
        ...UNMOVED_TOOL_PATHS,
        cursor: { ...TOOL_PATHS.cursor, mcpProject: '.mcp.json' },
        opencode: { skills: '.opencode/skills', mcp: '.config/opencode/opencode.json', mcpProject: '.mcp.json' },
      };
      const shared = { ...teamConfig, toolPaths } as TeamaiConfig;
      await fse.ensureDir(path.join(projectRoot, '.opencode', 'skills'));
      // Cursor owns x under mcpServers, now a literal; OpenCode's x under mcp still holds a token, its record lost.
      await writeMcpYaml('servers:\n  - name: x\n    transport: http\n    url: https://example.com/x\n    tools: [cursor]\n');
      await reconcileMcpForConfig(shared, projectConfig);
      const doc = await fse.readJson(path.join(projectRoot, '.mcp.json')) as Record<string, unknown>;
      await fse.writeJson(path.join(projectRoot, '.mcp.json'), {
        ...doc, mcp: { x: { type: 'remote', url: 'https://example.com/x', headers: { Authorization: 'Bearer stale-token-value' } } },
      });
      await fse.writeFile(path.join(projectRoot, '.git', 'info', 'exclude'), '');

      await reconcileMcpForConfig(shared, projectConfig);

      expect(await excludeOf(projectRoot)).toMatch(/^\/\.mcp\.json$/m);
    });

    it('notes the unclaimed servers under each format of a file tools of different formats share', async () => {
      const toolPaths = {
        ...UNMOVED_TOOL_PATHS,
        cursor: { ...TOOL_PATHS.cursor, mcpProject: '.mcp.json' },
        opencode: { skills: '.opencode/skills', mcp: '.config/opencode/opencode.json', mcpProject: '.mcp.json' },
      };
      const shared = { ...teamConfig, toolPaths } as TeamaiConfig;
      await fse.ensureDir(path.join(projectRoot, '.opencode', 'skills'));
      await fse.writeJson(path.join(projectRoot, '.mcp.json'), {
        mcpServers: { 'stale-cursor': { type: 'http', url: 'https://a.example/mcp' } },
        mcp: { 'stale-opencode': { type: 'remote', url: 'https://b.example/mcp' } },
      });
      await writeMcpYaml('servers:\n  - name: open\n    transport: http\n    url: https://example.com/open\n    tools: [claude]\n');

      await reconcileMcpForConfig(shared, projectConfig);

      const { readResolvedMcpFiles } = await import('../mcp-resolved-files.js');
      const unverified = (await readResolvedMcpFiles(projectConfig)).files[path.join(projectRoot, '.mcp.json')]?.unverified ?? [];
      expect(unverified).toEqual(expect.arrayContaining(['stale-cursor', 'stale-opencode']));
    });

    it('keeps the line of a file tools of different formats share while a stale entry sits under any of their keys', async () => {
      // Cursor (mcpServers) and OpenCode (mcp) both on .mcp.json, OpenCode last: judged in one format, the other hides.
      const toolPaths = {
        ...UNMOVED_TOOL_PATHS,
        cursor: { ...TOOL_PATHS.cursor, mcpProject: '.mcp.json' },
        opencode: { skills: '.opencode/skills', mcp: '.config/opencode/opencode.json', mcpProject: '.mcp.json' },
      };
      const shared = { ...teamConfig, toolPaths } as TeamaiConfig;
      await writeMcpYaml(`${withSecret}    tools: [cursor]\n  - name: open\n    transport: http\n    url: https://example.com/open\n    tools: [claude]\n`);
      await reconcileMcpForConfig(shared, projectConfig);
      expect(await fse.readFile(path.join(projectRoot, '.mcp.json'), 'utf-8')).toContain('super-secret-value');
      await writeMcpYaml('servers:\n  - name: open\n    transport: http\n    url: https://example.com/open\n    tools: [claude]\n');
      vi.stubEnv('SECRET_TOKEN', '');

      await reconcileMcpForConfig(shared, { ...projectConfig, disabledAgents: ['cursor'] } as LocalConfig);

      expect(await fse.readFile(path.join(projectRoot, '.mcp.json'), 'utf-8')).toContain('super-secret-value');
      expect(await excludeOf(projectRoot)).toMatch(/^\/\.mcp\.json$/m);
    });

    // No pull writes an HTTP team's servers, but one lists what an older local agent's install_mcp left unlisted.
    describe('for an HTTP-backed team, a config an older local agent wrote a credential into', () => {
      let httpConfig: LocalConfig;
      const file = (): string => path.join(projectRoot, '.mcp.json');
      const written = { mcpServers: { clawpro: { type: 'http', url: 'https://clawpro.example.com/mcp', headers: { Authorization: 'Bearer bmcp-old-token' } } } };

      beforeEach(async () => {
        httpConfig = { ...projectConfig, repo: { ...projectConfig.repo, kind: 'http', url: 'https://teamai.example' } } as LocalConfig;
        await fse.writeJson(file(), written);
        const { getDataHome, managedMcpManifestPath } = await import('../types.js');
        // Without the `resolved` note an install on this version adds.
        await fse.outputJson(managedMcpManifestPath(getDataHome(httpConfig), projectRoot), { 'claude:project': [{ name: 'clawpro', hash: 'h' }] });
      });

      it('lists it in .git/info/exclude on a pull, and records it in managed-mcp-files.json', async () => {
        await reconcileMcpForConfig(teamConfig, httpConfig);

        expect(await excludeOf(projectRoot)).toMatch(/^\/\.mcp\.json$/m);
        expect(git(projectRoot, 'status', '--porcelain', '--untracked-files=all', '--', '.mcp.json')).toBe('');
        const { readResolvedMcpFiles } = await import('../mcp-resolved-files.js');
        expect((await readResolvedMcpFiles(httpConfig)).files).toEqual({ [file()]: { tools: ['claude'] } });
        expect(await fse.readJson(file())).toEqual(written);
      });

      it('writes nothing on a dry run', async () => {
        await reconcileMcpForConfig(teamConfig, httpConfig, { dryRun: true });

        expect(await excludeOf(projectRoot)).not.toMatch(/\.mcp\.json/);
        const { resolvedMcpFilesPath } = await import('../mcp-resolved-files.js');
        expect(await fse.pathExists(resolvedMcpFilesPath(httpConfig) ?? '')).toBe(false);
      });
    });

    describe('a bare Copilot config another tool then writes mcpServers into (Copilot and Claude on .mcp.json)', () => {
      const shared = (): TeamaiConfig => ({
        ...teamConfig,
        toolPaths: { ...TOOL_PATHS, copilot: { skills: '.github/skills', mcp: '.copilot/mcp-config.json', mcpProject: '.mcp.json' } },
      } as TeamaiConfig);
      const open = 'servers:\n  - name: open\n    transport: http\n    url: https://example.com/open\n    tools: [claude]\n';

      beforeEach(async () => {
        await fse.ensureDir(path.join(projectRoot, '.github', 'skills'));
        // An empty file reads as Copilot's bare map: its first write stays bare.
        await fse.writeFile(path.join(projectRoot, '.mcp.json'), '');
        await writeMcpYaml(`${withSecret}    tools: [copilot]\n`);
        await reconcileMcpForConfig(shared(), projectConfig);
        const first = await fse.readJson(path.join(projectRoot, '.mcp.json')) as Record<string, unknown>;
        expect(first['with-secret']).toEqual(expect.objectContaining({ headers: { Authorization: 'Bearer super-secret-value' } }));
        expect(first.mcpServers).toBeUndefined();
      });

      it('does not infer bare ownership from an unchanged entry with a legacy record', async () => {
        const { getDataHome, managedMcpManifestPath } = await import('../types.js');
        const manifestFile = managedMcpManifestPath(getDataHome(projectConfig), projectRoot);
        const manifest = await fse.readJson(manifestFile);
        delete manifest['copilot:project'][0].bare;
        await fse.writeJson(manifestFile, manifest);
        const bare = (await fse.readJson(path.join(projectRoot, '.mcp.json')))['with-secret'];

        await reconcileMcpForConfig(shared(), projectConfig);
        expect((await fse.readJson(manifestFile))['copilot:project'][0].bare).toBeUndefined();
        await writeMcpYaml(open);
        await reconcileMcpForConfig(shared(), { ...projectConfig, disabledAgents: ['copilot'] } as LocalConfig);
        await reconcileMcpForConfig(shared(), projectConfig);

        expect((await fse.readJson(path.join(projectRoot, '.mcp.json')))['with-secret']).toEqual(bare);
      });

      it.each(['update', 'drop', 'remove', 'missing-secret'] as const)('preserves a member-owned keyed Copilot entry after a bare write during %s', async (action) => {
        const file = path.join(projectRoot, '.mcp.json');
        const mine = { type: 'http', tools: ['*'], url: 'https://member.example/mcp' };
        const doc = await fse.readJson(file);
        await fse.writeJson(file, { ...doc, mcpServers: { 'with-secret': mine } });
        if (action === 'update') await writeMcpYaml(`${withSecret.replace('${SECRET_TOKEN}', 'new-team-value')}    tools: [copilot]\n`);
        if (action === 'drop') await writeMcpYaml('servers: []\n');
        if (action === 'missing-secret') {
          await fse.outputFile(path.join(repoPath, 'env', 'secrets.yaml'), 'secrets:\n  - key: SECRET_TOKEN\n');
          vi.stubEnv('SECRET_TOKEN', '');
        }

        const result = await reconcileMcpForConfig(shared(), projectConfig, action === 'remove' ? { removeAll: true } : {});
        if (action === 'update') await reconcileMcpForConfig(shared(), projectConfig);

        expect((await fse.readJson(file)).mcpServers['with-secret']).toEqual(mine);
        if (action === 'update') {
          expect(result.changes).toContainEqual(expect.objectContaining({ tool: 'copilot', server: 'with-secret', action: 'skipped' }));
          expect((await fse.readJson(file))['with-secret']).toEqual(doc['with-secret']);
        }
        if (action === 'drop' || action === 'remove') expect((await fse.readJson(file))['with-secret']).toBeUndefined();
      });

      it.each([['update', false], ['remove', false], ['update', true], ['remove', true]] as const)('preserves a keyed member entry with an unmarked bare record during %s, identical=%s', async (action, identical) => {
        const { getDataHome, managedMcpManifestPath } = await import('../types.js');
        const manifestFile = managedMcpManifestPath(getDataHome(projectConfig), projectRoot);
        const manifest = await fse.readJson(manifestFile);
        delete manifest['copilot:project'][0].bare;
        await fse.writeJson(manifestFile, manifest);
        const file = path.join(projectRoot, '.mcp.json');
        const doc = await fse.readJson(file);
        const mine = identical ? doc['with-secret'] : { type: 'http', tools: ['*'], url: 'https://member.example/mcp' };
        await fse.writeJson(file, { ...doc, mcpServers: { 'with-secret': mine } });
        if (action === 'update') await writeMcpYaml(`${withSecret.replace('${SECRET_TOKEN}', 'new-team-value')}    tools: [copilot]\n`);

        const result = await reconcileMcpForConfig(shared(), projectConfig, action === 'remove' ? { removeAll: true } : {});

        expect((await fse.readJson(file)).mcpServers['with-secret']).toEqual(mine);
        expect((await fse.readJson(file))['with-secret']).toEqual(doc['with-secret']);
        if (action === 'update') expect(result.changes).toContainEqual(expect.objectContaining({ tool: 'copilot', server: 'with-secret', action: 'skipped' }));
      });

      it.each(['legacy bare', 'legacy keyed', 'proven keyed', 'bare migration'] as const)(
        'restores %s after a manifest write fails so update and removal can be retried', async (source) => {
        const { getDataHome, managedMcpManifestPath } = await import('../types.js');
        const manifestFile = managedMcpManifestPath(getDataHome(projectConfig), projectRoot);
        const manifest = await fse.readJson(manifestFile);
        const file = path.join(projectRoot, '.mcp.json');
        const doc = await fse.readJson(file);
        if (source.endsWith('keyed')) {
          await fse.writeJson(file, { mcpServers: doc });
          manifest['copilot:project'][0].bare = false;
        }
        if (source.startsWith('legacy')) delete manifest['copilot:project'][0].bare;
        if (source === 'bare migration') await fse.writeJson(file, { ...doc, mcpServers: { mine: { command: 'member-server' } } });
        await fse.writeJson(manifestFile, manifest);
        const original = await fse.readJson(file);
        await writeMcpYaml(`${withSecret.replace('${SECRET_TOKEN}', 'replacement')}    tools: [copilot]\n`);
        beforeJsonWrite.run = async (target) => {
          if (target.endsWith('/managed-mcp.json')) throw new Error('simulated manifest write failure');
        };

        await expect(reconcileMcpForConfig(shared(), projectConfig)).rejects.toThrow('simulated manifest write failure');
        beforeJsonWrite.run = null;

        expect(await fse.readJson(manifestFile)).toEqual(manifest);
        expect(await fse.readJson(file)).toEqual(original);
        expect(git(projectRoot, 'status', '--porcelain', '--untracked-files=all', '--', '.mcp.json')).toBe('');
        await reconcileMcpForConfig(shared(), projectConfig);
        expect(await fse.readFile(file, 'utf-8')).not.toContain('super-secret-value');
        await reconcileMcpForConfig(shared(), projectConfig, { removeAll: true });
        const removed = await fse.readJson(file);
        expect(removed['with-secret']).toBeUndefined();
        expect(removed.mcpServers?.['with-secret']).toBeUndefined();
        if (source === 'bare migration') expect(removed.mcpServers.mine).toEqual({ command: 'member-server' });
      });

      it('restores the first write when a second tool fails on the same config', async () => {
        const { getDataHome, managedMcpManifestPath } = await import('../types.js');
        const manifestFile = managedMcpManifestPath(getDataHome(projectConfig), projectRoot);
        const file = path.join(projectRoot, '.mcp.json');
        const original = await fse.readJson(file);
        const manifest = await fse.readJson(manifestFile);
        await writeMcpYaml(`${withSecret.replace('${SECRET_TOKEN}', 'replacement')}    tools: [copilot]\n${open.replace('servers:\n', '')}`);
        let writes = 0;
        beforeJsonWrite.run = async (target) => {
          if (target === file && ++writes === 2) throw new Error('simulated second config write failure');
        };

        await expect(reconcileMcpForConfig(shared(), projectConfig)).rejects.toThrow('simulated second config write failure');
        beforeJsonWrite.run = null;

        expect(await fse.readJson(file)).toEqual(original);
        expect(await fse.readJson(manifestFile)).toEqual(manifest);
        await reconcileMcpForConfig(shared(), projectConfig);
        expect(await fse.readFile(file, 'utf-8')).not.toContain('super-secret-value');
      });

      it('keeps its line, pull after pull, while Copilot\'s bare entry holds the value beside the mcpServers Claude wrote', async () => {
        await writeMcpYaml(`${withSecret}    tools: [copilot]\n${open.replace('servers:\n', '')}`);
        // No longer set: only the entry, not a scan for the value, says what the file holds.
        vi.stubEnv('SECRET_TOKEN', '');

        await reconcileMcpForConfig(shared(), { ...projectConfig, disabledAgents: ['copilot'] } as LocalConfig);
        await reconcileMcpForConfig(shared(), { ...projectConfig, disabledAgents: ['copilot'] } as LocalConfig);

        const after = await fse.readJson(path.join(projectRoot, '.mcp.json')) as Record<string, unknown>;
        expect(after.mcpServers).toEqual({ open: expect.objectContaining({ url: 'https://example.com/open' }) });
        expect(JSON.stringify(after)).toContain('super-secret-value');
        expect(await excludeOf(projectRoot)).toMatch(/^\/\.mcp\.json$/m);
      });

      it('replaces Copilot\'s bare entry when it writes that server again under the mcpServers Claude added', async () => {
        await writeMcpYaml(`${withSecret}    tools: [copilot]\n${open.replace('servers:\n', '')}`);
        await reconcileMcpForConfig(shared(), projectConfig);
        expect((await fse.readJson(path.join(projectRoot, '.mcp.json')) as Record<string, unknown>).mcpServers).toBeDefined();
        await writeMcpYaml(`${withSecret.replace('${SECRET_TOKEN}', 'published-literal')}    tools: [copilot]\n${open.replace('servers:\n', '')}`);
        vi.stubEnv('SECRET_TOKEN', '');

        await reconcileMcpForConfig(shared(), projectConfig);

        const after = await fse.readJson(path.join(projectRoot, '.mcp.json')) as Record<string, unknown>;
        expect(JSON.stringify(after)).not.toContain('super-secret-value');
        expect(after['with-secret']).toBeUndefined();
        expect((after.mcpServers as Record<string, unknown>)['with-secret']).toEqual(expect.objectContaining({ headers: { Authorization: 'Bearer published-literal' } }));
      });

      it('never removes a bare server of the member\'s own that shares a name with one teamai writes under mcpServers', async () => {
        const mine = { type: 'http', tools: ['*'], url: 'https://jira.example/mcp' };
        const doc = await fse.readJson(path.join(projectRoot, '.mcp.json')) as Record<string, unknown>;
        await fse.writeJson(path.join(projectRoot, '.mcp.json'), { ...doc, jira: mine });
        const jira = '  - name: jira\n    transport: http\n    url: https://jira.example/mcp\n    tools: [copilot]\n';
        await writeMcpYaml(`${withSecret}    tools: [copilot]\n${open.replace('servers:\n', '')}${jira}`);
        await reconcileMcpForConfig(shared(), projectConfig);
        await reconcileMcpForConfig(shared(), projectConfig);
        await writeMcpYaml(`${withSecret}    tools: [copilot]\n${open.replace('servers:\n', '')}`);
        await reconcileMcpForConfig(shared(), projectConfig);

        expect((await fse.readJson(path.join(projectRoot, '.mcp.json')) as Record<string, unknown>).jira).toEqual(mine);
      });

      it('keeps its line while a stale bare copy differs from the entry of that name under mcpServers', async () => {
        const stale = (await fse.readJson(path.join(projectRoot, '.mcp.json')) as Record<string, unknown>)['with-secret'];
        await fse.writeJson(path.join(projectRoot, '.mcp.json'), {
          'with-secret': stale,
          mcpServers: { 'with-secret': { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer published-literal' } } },
        });
        await fse.writeFile(path.join(projectRoot, '.git', 'info', 'exclude'), '');
        vi.stubEnv('SECRET_TOKEN', '');

        await reconcileMcpForConfig(shared(), { ...projectConfig, disabledAgents: ['copilot'] } as LocalConfig);

        expect(JSON.stringify(await fse.readJson(path.join(projectRoot, '.mcp.json')))).toContain('super-secret-value');
        expect(await excludeOf(projectRoot)).toMatch(/^\/\.mcp\.json$/m);
      });

      it('removes Copilot\'s bare entry once the team drops it, leaving the mcpServers Claude wrote', async () => {
        await writeMcpYaml(open);
        vi.stubEnv('SECRET_TOKEN', '');

        await reconcileMcpForConfig(shared(), projectConfig);

        const after = await fse.readJson(path.join(projectRoot, '.mcp.json')) as Record<string, unknown>;
        expect(after).toEqual({ mcpServers: { open: expect.objectContaining({ url: 'https://example.com/open' }) } });
      });
    });

    describe('a config two tools share (Claude and CodeBuddy on .mcp.json)', () => {
      const shared = { ...teamConfig, toolPaths: { ...TOOL_PATHS, codebuddy: { ...TOOL_PATHS.codebuddy, mcpProject: '.mcp.json' } } } as TeamaiConfig;
      const open = '  - name: open\n    transport: http\n    url: https://example.com/open\n';

      it('keeps its line while a tool that wrote a resolved value there has lost its record, though the other tool\'s is intact', async () => {
        await fse.ensureDir(path.join(projectRoot, '.codebuddy', 'skills'));
        await writeMcpYaml(`${withSecret}    tools: [codebuddy]\n${open}    tools: [claude]\n`);
        await reconcileMcpForConfig(shared, projectConfig);
        expect(await fse.readFile(path.join(projectRoot, '.mcp.json'), 'utf-8')).toContain('super-secret-value');
        const { getDataHome, managedMcpManifestPath } = await import('../types.js');
        const manifestFile = managedMcpManifestPath(getDataHome(projectConfig), projectRoot);
        const manifest = await fse.readJson(manifestFile) as Record<string, unknown>;
        delete manifest['codebuddy:project'];
        await fse.writeJson(manifestFile, manifest);
        await writeMcpYaml(`servers:\n${open}    tools: [claude]\n`);
        vi.stubEnv('SECRET_TOKEN', '');

        await reconcileMcpForConfig(shared, projectConfig);

        expect(await fse.readFile(path.join(projectRoot, '.mcp.json'), 'utf-8')).toContain('super-secret-value');
        expect(await excludeOf(projectRoot)).toMatch(/^\/\.mcp\.json$/m);
      });

      it('releases its line once clean when only one of them ever wrote a resolved value there', async () => {
        await writeMcpYaml(`${withSecret}    tools: [claude]\n${open}`);
        await reconcileMcpForConfig(shared, projectConfig);
        expect(await excludeOf(projectRoot)).toMatch(/^\/\.mcp\.json$/m);
        await writeMcpYaml(`servers:\n${open}`);

        await reconcileMcpForConfig(shared, projectConfig);

        expect(await fse.readFile(path.join(projectRoot, '.mcp.json'), 'utf-8')).not.toContain('super-secret-value');
        expect(await excludeOf(projectRoot)).not.toMatch(/^\/\.mcp\.json$/m);
      });

      describe('without managed-mcp-files.json, as an install from before it has none', () => {
        const withoutSidecar = async (): Promise<void> => {
          const { resolvedMcpFilesPath } = await import('../mcp-resolved-files.js');
          await fse.remove(resolvedMcpFilesPath(projectConfig) ?? '');
        };

        it('keeps its line while a tool that wrote a resolved value there has lost its record, though the other tool\'s is intact', async () => {
          await fse.ensureDir(path.join(projectRoot, '.codebuddy', 'skills'));
          await writeMcpYaml(`${withSecret}    tools: [codebuddy]\n${open}    tools: [claude]\n`);
          await reconcileMcpForConfig(shared, projectConfig);
          const { getDataHome, managedMcpManifestPath } = await import('../types.js');
          const manifestFile = managedMcpManifestPath(getDataHome(projectConfig), projectRoot);
          const manifest = await fse.readJson(manifestFile) as Record<string, unknown>;
          delete manifest['codebuddy:project'];
          await fse.writeJson(manifestFile, manifest);
          await withoutSidecar();
          await writeMcpYaml(`servers:\n${open}    tools: [claude]\n`);
          vi.stubEnv('SECRET_TOKEN', '');

          await reconcileMcpForConfig(shared, projectConfig);

          expect(await fse.readFile(path.join(projectRoot, '.mcp.json'), 'utf-8')).toContain('super-secret-value');
          expect(await excludeOf(projectRoot)).toMatch(/^\/\.mcp\.json$/m);
        });

        // Nothing says which of the two wrote there, so a tool mapping it with no record at all holds it too.
        it('keeps its line while a tool mapping it has no record, until a pull records the file', async () => {
          await writeMcpYaml(`${withSecret}    tools: [claude]\n${open}`);
          await reconcileMcpForConfig(shared, projectConfig);
          await withoutSidecar();
          await writeMcpYaml(`servers:\n${open}`);

          await reconcileMcpForConfig(shared, projectConfig);

          expect(await fse.readFile(path.join(projectRoot, '.mcp.json'), 'utf-8')).not.toContain('super-secret-value');
          expect(await excludeOf(projectRoot)).toMatch(/^\/\.mcp\.json$/m);
        });
      });
    });

    it('adds every such config to .git/info/exclude once, inside a teamai block', async () => {
      await writeMcpYaml(withSecret);

      await reconcileMcpForConfig(teamConfig, projectConfig);
      await reconcileMcpForConfig(teamConfig, projectConfig, { force: true });

      const exclude = await excludeOf(projectRoot);
      expect(exclude.match(/^\/\.mcp\.json$/gm)).toHaveLength(1);
      expect(exclude.match(/^\/\.cursor\/mcp\.json$/gm)).toHaveLength(1);
      expect(exclude).toContain('# [teamai:mcp-exclude:start]');
      expect(git(projectRoot, 'status', '--porcelain', '--untracked-files=all')).not.toMatch(/ (\.mcp\.json|\.cursor\/)/);
      expect(await fse.pathExists(path.join(projectRoot, '.gitignore'))).toBe(false);
    });

    it('adds nothing for a config that carries no resolved value', async () => {
      await writeMcpYaml('servers:\n  - name: open\n    transport: http\n    url: https://example.com/open\n');

      await reconcileMcpForConfig(teamConfig, projectConfig);

      expect(await excludeOf(projectRoot)).not.toContain('teamai');
    });

    it('adds nothing for a path git already ignores, and leaves .gitignore as it is', async () => {
      await fse.writeFile(path.join(projectRoot, '.gitignore'), '.mcp.json\n.cursor/\n');
      await writeMcpYaml(withSecret);

      await reconcileMcpForConfig(teamConfig, projectConfig);

      expect(await excludeOf(projectRoot)).not.toContain('teamai');
      expect(await fse.readFile(path.join(projectRoot, '.gitignore'), 'utf-8')).toBe('.mcp.json\n.cursor/\n');
    });

    it('writes to the repository git dir from a linked worktree', async () => {
      git(projectRoot, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
      const worktree = path.join(tmpDir, 'business-wt');
      git(projectRoot, 'worktree', 'add', '-q', worktree);
      for (const d of ['.claude', '.cursor']) await fse.ensureDir(path.join(worktree, d, 'skills'));
      await writeMcpYaml(withSecret);

      await reconcileMcpForConfig(teamConfig, { ...projectConfig, projectRoot: worktree } as LocalConfig);

      expect(await excludeOf(projectRoot)).toMatch(/^\/\.mcp\.json$/m);
      expect(git(worktree, 'status', '--porcelain', '--untracked-files=all')).not.toMatch(/ (\.mcp\.json|\.cursor\/)/);
    });

    describe('a config an earlier pull wrote is protected even when this pull delivers nothing to it', () => {
      beforeEach(async () => {
        await writeMcpYaml(withSecret);
        await reconcileMcpForConfig(teamConfig, projectConfig);
        // As if written before this release: the token is on disk, nothing excludes it.
        await fse.writeFile(path.join(projectRoot, '.git', 'info', 'exclude'), '');
      });

      it('when its tool is disabled', async () => {
        await reconcileMcpForConfig(teamConfig, { ...projectConfig, disabledAgents: ['cursor'] } as LocalConfig);

        expect(await excludeOf(projectRoot)).toMatch(/^\/\.cursor\/mcp\.json$/m);
      });

      it('when the team turned automatic MCP delivery off', async () => {
        const manual = { ...teamConfig, sharing: { ...teamConfig.sharing, mcp: { autoApply: false } } } as TeamaiConfig;

        await reconcileMcpForConfig(manual, projectConfig);

        expect(await excludeOf(projectRoot)).toMatch(/^\/\.mcp\.json$/m);
        expect(await excludeOf(projectRoot)).toMatch(/^\/\.cursor\/mcp\.json$/m);
      });

      it('when its tool is no longer detected', async () => {
        await fse.remove(path.join(projectRoot, '.claude'));

        await reconcileMcpForConfig(teamConfig, projectConfig);

        expect(await excludeOf(projectRoot)).toMatch(/^\/\.mcp\.json$/m);
      });

      it.skipIf(process.getuid?.() === 0)('when writing another tool\'s config fails', async () => {
        await writeMcpYaml(`${withSecret}  - name: added-later\n    transport: http\n    url: https://example.com/later\n`);
        await fse.chmod(path.join(projectRoot, '.cursor'), 0o555);

        await expect(reconcileMcpForConfig(teamConfig, projectConfig)).rejects.toThrow();
        await fse.chmod(path.join(projectRoot, '.cursor'), 0o755);

        expect(await excludeOf(projectRoot)).toMatch(/^\/\.mcp\.json$/m);
        expect(await excludeOf(projectRoot)).toMatch(/^\/\.cursor\/mcp\.json$/m);
      });

      it('when its ownership manifest is gone', async () => {
        const { getDataHome, managedMcpManifestPath } = await import('../types.js');
        await fse.remove(managedMcpManifestPath(getDataHome(projectConfig), projectRoot));

        await reconcileMcpForConfig(teamConfig, projectConfig);

        expect(await excludeOf(projectRoot)).toMatch(/^\/\.mcp\.json$/m);
      });

      it('when its server has left mcp.yaml and its tool is disabled', async () => {
        await writeMcpYaml('servers:\n  - name: open\n    transport: http\n    url: https://example.com/open\n');
        vi.stubEnv('SECRET_TOKEN', '');

        await reconcileMcpForConfig(teamConfig, { ...projectConfig, disabledAgents: ['cursor'] } as LocalConfig);

        expect(await excludeOf(projectRoot)).toMatch(/^\/\.cursor\/mcp\.json$/m);
        // Claude's copy was cleaned by this pull, so nothing of teamai's is left to protect there.
        expect(await excludeOf(projectRoot)).not.toMatch(/^\/\.mcp\.json$/m);
      });

      it.each([
        ['drops the tool', { claude: TOOL_PATHS.claude }],
        ['moves its project MCP file', { ...TOOL_PATHS, cursor: { ...TOOL_PATHS.cursor, mcpProject: '.cursor/team-mcp.json' } }],
      ])('when the team %s', async (_label, toolPaths) => {
        await reconcileMcpForConfig({ ...teamConfig, toolPaths } as TeamaiConfig, projectConfig);

        expect(await excludeOf(projectRoot)).toMatch(/^\/\.cursor\/mcp\.json$/m);
      });

      it('when the team\'s mcp.yaml does not parse', async () => {
        await writeMcpYaml('servers: [unclosed\n');

        await reconcileMcpForConfig(teamConfig, projectConfig);

        expect(await excludeOf(projectRoot)).toMatch(/^\/\.mcp\.json$/m);
      });

      describe('when its server\'s ${VAR} has since become a literal and the variable is gone', () => {
        beforeEach(async () => {
          await writeMcpYaml(withSecret.replace('${SECRET_TOKEN}', 'published-literal'));
          vi.stubEnv('SECRET_TOKEN', '');
        });

        it('and its tool is disabled', async () => {
          await reconcileMcpForConfig(teamConfig, { ...projectConfig, disabledAgents: ['cursor'] } as LocalConfig);

          expect(await fse.readFile(path.join(projectRoot, '.cursor', 'mcp.json'), 'utf-8')).toContain('super-secret-value');
          expect(await excludeOf(projectRoot)).toMatch(/^\/\.cursor\/mcp\.json$/m);
          // Claude's copy now holds the literal: nothing resolved is left there.
          expect(await excludeOf(projectRoot)).not.toMatch(/^\/\.mcp\.json$/m);
        });

        it('and the team turned automatic MCP delivery off', async () => {
          const manual = { ...teamConfig, sharing: { ...teamConfig.sharing, mcp: { autoApply: false } } } as TeamaiConfig;

          await reconcileMcpForConfig(manual, projectConfig);

          expect(await excludeOf(projectRoot)).toMatch(/^\/\.cursor\/mcp\.json$/m);
          expect(await excludeOf(projectRoot)).toMatch(/^\/\.mcp\.json$/m);
        });

        it('and its tool is disabled, recorded by an older teamai that did not note resolved values', async () => {
          const { getDataHome, managedMcpManifestPath } = await import('../types.js');
          const manifestFile = managedMcpManifestPath(getDataHome(projectConfig), projectRoot);
          const manifest = await fse.readJson(manifestFile) as Record<string, Array<Record<string, unknown>>>;
          await fse.writeJson(manifestFile, Object.fromEntries(Object.entries(manifest).map(([key, records]) =>
            [key, records.map(({ name, hash }) => ({ name, hash }))])));

          await reconcileMcpForConfig(teamConfig, { ...projectConfig, disabledAgents: ['cursor'] } as LocalConfig);

          expect(await excludeOf(projectRoot)).toMatch(/^\/\.cursor\/mcp\.json$/m);
        });
      });
    });

    describe('a config an earlier pull wrote under a custom mcpProject the team has since changed', () => {
      const custom = { ...TOOL_PATHS, cursor: { ...TOOL_PATHS.cursor, mcpProject: '.cursor/team-mcp.json' } };
      const customFile = (): string => path.join(projectRoot, '.cursor', 'team-mcp.json');
      const sidecar = async (): Promise<Record<string, unknown>> => {
        const { readResolvedMcpFiles } = await import('../mcp-resolved-files.js');
        return (await readResolvedMcpFiles(projectConfig)).files;
      };

      beforeEach(async () => {
        await writeMcpYaml(withSecret);
        await reconcileMcpForConfig({ ...teamConfig, toolPaths: custom } as TeamaiConfig, projectConfig);
        expect(await fse.readFile(customFile(), 'utf-8')).toContain('super-secret-value');
      });

      it.each([
        ['restores the built-in path', TOOL_PATHS],
        ['drops the tool', { claude: TOOL_PATHS.claude }],
        ['moves it again', { ...TOOL_PATHS, cursor: { ...TOOL_PATHS.cursor, mcpProject: '.cursor/other-mcp.json' } }],
      ])('is listed again when the team %s', async (_label, toolPaths) => {
        // As if written before this release, or listed and since dropped: nothing excludes it.
        await fse.writeFile(path.join(projectRoot, '.git', 'info', 'exclude'), '');

        await reconcileMcpForConfig({ ...teamConfig, toolPaths } as TeamaiConfig, projectConfig);

        expect(await fse.readFile(customFile(), 'utf-8')).toContain('super-secret-value');
        expect(await excludeOf(projectRoot)).toMatch(/^\/\.cursor\/team-mcp\.json$/m);
        expect(git(projectRoot, 'status', '--porcelain', '--untracked-files=all')).not.toMatch(/team-mcp\.json/);
      });

      it('keeps its line while it holds a server of the member\'s own', async () => {
        await fse.writeJson(customFile(), { mcpServers: { mine: { type: 'http', url: 'https://mine.example/mcp' } } });

        await reconcileMcpForConfig(teamConfig, projectConfig);

        expect(await excludeOf(projectRoot)).toMatch(/^\/\.cursor\/team-mcp\.json$/m);
      });

      it.each([
        ['it is deleted', () => fse.remove(customFile())],
        ['it holds no server', () => fse.writeJson(customFile(), { mcpServers: {} })],
      ])('lets its line go, and forgets it, once %s', async (_label, arrange) => {
        await arrange();

        await reconcileMcpForConfig(teamConfig, projectConfig);

        expect(await excludeOf(projectRoot)).not.toMatch(/team-mcp\.json/);
        expect(Object.keys(await sidecar())).not.toContain(customFile());
      });

      it('lets its line go when `teamai mcp remove` finds it holding no server', async () => {
        await fse.writeJson(customFile(), { mcpServers: {} });

        await releaseCleanMcpGitExcludes(teamConfig, projectConfig);

        expect(await excludeOf(projectRoot)).not.toMatch(/team-mcp\.json/);
        expect(Object.keys(await sidecar())).not.toContain(customFile());
      });
    });

    it('keeps excluding a config whose entry a pull kept for a missing declared secret', async () => {
      await fse.outputFile(path.join(repoPath, 'env', 'secrets.yaml'), 'secrets:\n  - key: SECRET_TOKEN\n');
      await writeMcpYaml(withSecret);
      await reconcileMcpForConfig(teamConfig, projectConfig);
      await fse.writeFile(path.join(projectRoot, '.git', 'info', 'exclude'), '');
      vi.stubEnv('SECRET_TOKEN', undefined);
      await writeMcpYaml(`${withSecret}  - name: open\n    transport: http\n    url: https://example.com/open\n`);

      await reconcileMcpForConfig(teamConfig, { ...projectConfig, disabledAgents: ['cursor'] } as LocalConfig);

      expect(await fse.readFile(path.join(projectRoot, '.mcp.json'), 'utf-8')).toContain('super-secret-value');
      expect(await fse.readFile(path.join(projectRoot, '.mcp.json'), 'utf-8')).toContain('https://example.com/open');
      const { getDataHome, managedMcpManifestPath } = await import('../types.js');
      const manifest = await fse.readJson(managedMcpManifestPath(getDataHome(projectConfig), projectRoot));
      expect(manifest['claude:project']).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'with-secret', resolved: true })]));
      expect(await excludeOf(projectRoot)).toMatch(/^\/\.mcp\.json$/m);
      expect(await excludeOf(projectRoot)).toMatch(/^\/\.cursor\/mcp\.json$/m);
    });

    it('adds nothing for a disabled tool\'s config whose server never held a resolved value, after its definition changed', async () => {
      await writeMcpYaml('servers:\n  - name: open\n    transport: http\n    url: https://example.com/open\n');
      await reconcileMcpForConfig(teamConfig, projectConfig);
      await writeMcpYaml('servers:\n  - name: open\n    transport: http\n    url: https://example.com/v2\n');

      await reconcileMcpForConfig(teamConfig, { ...projectConfig, disabledAgents: ['cursor'] } as LocalConfig);

      expect(await fse.readFile(path.join(projectRoot, '.cursor', 'mcp.json'), 'utf-8')).toContain('https://example.com/open');
      expect(await excludeOf(projectRoot)).not.toContain('teamai');
    });

    it('keeps listing a Codex project config after its server\'s ${VAR} became a literal and Codex was disabled', async () => {
      const withCodex = { ...teamConfig, toolPaths: { ...TOOL_PATHS, codex: { ...TOOL_PATHS.codex, mcpProject: '.codex/config.toml' } } } as TeamaiConfig;
      await fse.ensureDir(path.join(projectRoot, '.codex', 'skills'));
      await writeMcpYaml(`${withSecret}    tools: [codex]\n`);
      await reconcileMcpForConfig(withCodex, projectConfig);
      expect(await fse.readFile(path.join(projectRoot, '.codex', 'config.toml'), 'utf-8')).toContain('super-secret-value');
      await fse.writeFile(path.join(projectRoot, '.git', 'info', 'exclude'), '');
      await writeMcpYaml(`${withSecret.replace('${SECRET_TOKEN}', 'published-literal')}    tools: [codex]\n`);
      vi.stubEnv('SECRET_TOKEN', '');

      await reconcileMcpForConfig(withCodex, { ...projectConfig, disabledAgents: ['codex'] } as LocalConfig);

      expect(await excludeOf(projectRoot)).toMatch(/^\/\.codex\/config\.toml$/m);
    });

    it('withholds a resolved value from a symlinked Codex project config whose target git tracks, and keeps the link', async () => {
      const withCodex = { ...teamConfig, toolPaths: { ...TOOL_PATHS, codex: { ...TOOL_PATHS.codex, mcpProject: '.codex/config.toml' } } } as TeamaiConfig;
      const tracked = path.join(projectRoot, 'config', 'codex.toml');
      const link = path.join(projectRoot, '.codex', 'config.toml');
      await fse.outputFile(tracked, 'model = "gpt-5"\n');
      git(projectRoot, 'add', 'config/codex.toml');
      git(projectRoot, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'codex');
      await fse.ensureDir(path.join(projectRoot, '.codex', 'skills'));
      await fse.symlink(path.join('..', 'config', 'codex.toml'), link);
      await writeMcpYaml(`${withSecret}    tools: [codex]\n`);

      await reconcileMcpForConfig(withCodex, projectConfig);

      expect(await fse.readFile(tracked, 'utf-8')).toBe('model = "gpt-5"\n');
      expect((await fse.lstat(link)).isSymbolicLink()).toBe(true);
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(`git already tracks ${path.join(await fse.realpath(projectRoot), 'config', 'codex.toml')}`));
    });

    it('writes a resolved value into the untracked target of a symlinked Codex project config, and lists the target', async () => {
      const withCodex = { ...teamConfig, toolPaths: { ...TOOL_PATHS, codex: { ...TOOL_PATHS.codex, mcpProject: '.codex/config.toml' } } } as TeamaiConfig;
      const target = path.join(projectRoot, 'config', 'codex.toml');
      const link = path.join(projectRoot, '.codex', 'config.toml');
      await fse.outputFile(target, 'model = "gpt-5"\n');
      await fse.ensureDir(path.join(projectRoot, '.codex', 'skills'));
      await fse.symlink(path.join('..', 'config', 'codex.toml'), link);
      await writeMcpYaml(`${withSecret}    tools: [codex]\n`);

      await reconcileMcpForConfig(withCodex, projectConfig);

      expect((await fse.lstat(link)).isSymbolicLink()).toBe(true);
      expect(await fse.readFile(target, 'utf-8')).toContain('model = "gpt-5"');
      expect(await fse.readFile(target, 'utf-8')).toContain('super-secret-value');
      expect(await excludeOf(projectRoot)).toMatch(/^\/config\/codex\.toml$/m);
    });

    describe('a config an older teamai wrote under a mapping an earlier teamai.yaml made', () => {
      const custom = { ...TOOL_PATHS, cursor: { ...TOOL_PATHS.cursor, mcpProject: '.cursor/team-mcp.json' } };
      const customFile = (): string => path.join(projectRoot, '.cursor', 'team-mcp.json');
      const commitTeamYaml = async (toolPaths: object, cwd = repoPath): Promise<void> => {
        // JSON is YAML.
        await fse.writeFile(path.join(cwd, 'teamai.yaml'), JSON.stringify({ team: 't', toolPaths }));
        git(cwd, 'add', '-A');
        git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'toolPaths');
      };
      const ledger = async (cfg = projectConfig): Promise<{ files: Record<string, unknown>; earlierMappingsRead?: true }> => {
        const { readResolvedMcpFiles } = await import('../mcp-resolved-files.js');
        return readResolvedMcpFiles(cfg);
      };
      // What a teamai from before managed-mcp-files.json leaves: no record of the path, nothing in the exclude.
      const asOlderTeamai = async (): Promise<void> => {
        const { resolvedMcpFilesPath } = await import('../mcp-resolved-files.js');
        const { getDataHome, managedMcpManifestPath } = await import('../types.js');
        await fse.remove(resolvedMcpFilesPath(projectConfig) ?? '');
        await fse.writeFile(path.join(projectRoot, '.git', 'info', 'exclude'), '');
        const manifestFile = managedMcpManifestPath(getDataHome(projectConfig), projectRoot);
        const manifest = await fse.readJson(manifestFile) as Record<string, Array<Record<string, unknown>>>;
        await fse.writeJson(manifestFile, Object.fromEntries(Object.entries(manifest).map(([key, records]) =>
          [key, records.map(({ name, hash }) => ({ name, hash }))])));
      };

      beforeEach(async () => {
        await writeMcpYaml(withSecret);
        git(repoPath, 'init', '-q');
        await commitTeamYaml(custom);
        await reconcileMcpForConfig({ ...teamConfig, toolPaths: custom } as TeamaiConfig, projectConfig);
        expect(await fse.readFile(customFile(), 'utf-8')).toContain('super-secret-value');
        await commitTeamYaml(TOOL_PATHS);
        await asOlderTeamai();
      });

      it('is listed and recorded by the first pull on this version', async () => {
        await reconcileMcpForConfig(teamConfig, projectConfig);

        expect(await excludeOf(projectRoot)).toMatch(/^\/\.cursor\/team-mcp\.json$/m);
        expect(git(projectRoot, 'status', '--porcelain', '--untracked-files=all')).not.toMatch(/team-mcp\.json/);
        expect((await ledger()).files[customFile()]).toEqual({ tools: ['cursor'] });
      });

      it('keeps its line on the pulls after, from the record', async () => {
        await reconcileMcpForConfig(teamConfig, projectConfig);
        await fse.writeFile(path.join(projectRoot, '.git', 'info', 'exclude'), '');

        await reconcileMcpForConfig(teamConfig, projectConfig);

        expect(await excludeOf(projectRoot)).toMatch(/^\/\.cursor\/team-mcp\.json$/m);
      });

      it('reads the team repo\'s history once per worktree', async () => {
        await reconcileMcpForConfig(teamConfig, projectConfig);
        expect((await ledger()).earlierMappingsRead).toBe(true);
        const { updateResolvedMcpFiles } = await import('../mcp-resolved-files.js');
        await updateResolvedMcpFiles(projectConfig, (files) => delete files[customFile()]);
        await fse.writeFile(path.join(projectRoot, '.git', 'info', 'exclude'), '');

        await reconcileMcpForConfig(teamConfig, projectConfig);

        expect(await excludeOf(projectRoot)).not.toMatch(/team-mcp\.json/);
      });

      it.each([
        ['removed its server', async () => {
          await writeMcpYaml('servers:\n  - name: open\n    transport: http\n    url: https://example.com/open\n');
        }],
        ['renamed its server, whose variable is no longer set', async () => {
          await writeMcpYaml(withSecret.replace('with-secret', 'renamed'));
          vi.stubEnv('SECRET_TOKEN', '');
        }],
      ])('is listed and recorded when the team also %s', async (_label, arrange) => {
        await arrange();

        await reconcileMcpForConfig(teamConfig, projectConfig);

        expect(await fse.readFile(customFile(), 'utf-8')).toContain('super-secret-value');
        expect(await excludeOf(projectRoot)).toMatch(/^\/\.cursor\/team-mcp\.json$/m);
        expect((await ledger()).files[customFile()]).toEqual({ tools: ['cursor'] });
        await fse.writeFile(path.join(projectRoot, '.git', 'info', 'exclude'), '');

        await reconcileMcpForConfig(teamConfig, projectConfig);

        expect(await excludeOf(projectRoot)).toMatch(/^\/\.cursor\/team-mcp\.json$/m);
      });

      // No record describes that path any more, so a server of the member's own cannot be told from an older teamai's.
      it('lists and records a file holding only a server of the member\'s own', async () => {
        await fse.writeJson(customFile(), { mcpServers: { mine: { type: 'http', url: 'https://mine.example/mcp' } } });

        await reconcileMcpForConfig(teamConfig, projectConfig);

        expect(await excludeOf(projectRoot)).toMatch(/^\/\.cursor\/team-mcp\.json$/m);
        expect((await ledger()).files[customFile()]).toEqual({ tools: ['cursor'] });
      });

      it('lists nothing for a file git tracks, and records it as tracked: an exclude line does nothing for it', async () => {
        await fse.writeJson(customFile(), { mcpServers: { mine: { type: 'http', url: 'https://mine.example/mcp' } } });
        git(projectRoot, 'add', '-f', '.cursor/team-mcp.json');
        git(projectRoot, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'mine');
        vi.mocked(log.warn).mockClear();

        await reconcileMcpForConfig(teamConfig, projectConfig);
        await reconcileMcpForConfig(teamConfig, projectConfig);

        expect(await excludeOf(projectRoot)).not.toMatch(/team-mcp\.json/);
        expect((await ledger()).files[customFile()]).toEqual({ tools: ['cursor'], tracked: true });
        expect(vi.mocked(log.warn).mock.calls.flat().join('\n')).not.toMatch(/team-mcp\.json/);
        expect((await ledger()).earlierMappingsRead).toBe(true);
      });

      describe('once git tracks it', () => {
        const commitIt = (): void => {
          git(projectRoot, 'add', '-f', '.cursor/team-mcp.json');
          git(projectRoot, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'old');
        };

        it('is listed and recorded as any other on the first pull after the member stops git tracking it', async () => {
          commitIt();
          await reconcileMcpForConfig(teamConfig, projectConfig);
          git(projectRoot, 'rm', '-q', '--cached', '.cursor/team-mcp.json');

          await reconcileMcpForConfig(teamConfig, projectConfig);

          expect(await fse.readFile(customFile(), 'utf-8')).toContain('super-secret-value');
          expect(await excludeOf(projectRoot)).toMatch(/^\/\.cursor\/team-mcp\.json$/m);
          expect(git(projectRoot, 'status', '--porcelain', '--untracked-files=all')).not.toMatch(/\?\? .*team-mcp\.json/);
          expect((await ledger()).files[customFile()]).toEqual({ tools: ['cursor'] });
        });

        // A checkout brings back what git holds, so only a file gone from both is forgotten.
        it('keeps its record while git tracks it, whatever the file holds, and forgets it once it is gone from git and disk', async () => {
          commitIt();
          await reconcileMcpForConfig(teamConfig, projectConfig);
          await fse.writeJson(customFile(), { mcpServers: {} });
          await reconcileMcpForConfig(teamConfig, projectConfig);
          await fse.remove(customFile());
          await reconcileMcpForConfig(teamConfig, projectConfig);
          expect((await ledger()).files[customFile()]).toEqual({ tools: ['cursor'], tracked: true });
          git(projectRoot, 'rm', '-q', '--cached', '.cursor/team-mcp.json');

          await reconcileMcpForConfig(teamConfig, projectConfig);

          expect(Object.keys((await ledger()).files)).not.toContain(customFile());
          expect(await excludeOf(projectRoot)).not.toMatch(/team-mcp\.json/);
        });
      });

      it('leaves a file that holds no server alone', async () => {
        await fse.writeJson(customFile(), { mcpServers: {} });

        await reconcileMcpForConfig(teamConfig, projectConfig);

        expect(await excludeOf(projectRoot)).not.toMatch(/team-mcp\.json/);
        expect(Object.keys((await ledger()).files)).not.toContain(customFile());
      });

      it('also finds one under a built-in default teamai has since changed (CodeBuddy\'s .codebuddy/mcp.json)', async () => {
        const today = { ...TOOL_PATHS, codebuddy: { ...TOOL_PATHS.codebuddy, mcpProject: '.mcp.json' } };
        await fse.remove(path.join(repoPath, '.git'));
        git(repoPath, 'init', '-q');
        await commitTeamYaml(today);
        const oldDefault = path.join(projectRoot, '.codebuddy', 'mcp.json');
        await fse.outputFile(oldDefault, await fse.readFile(customFile(), 'utf-8'));

        await reconcileMcpForConfig({ ...teamConfig, toolPaths: today } as TeamaiConfig, projectConfig);

        expect(await excludeOf(projectRoot)).toMatch(/^\/\.codebuddy\/mcp\.json$/m);
        expect((await ledger()).files[oldDefault]).toEqual({ tools: ['codebuddy'] });
      });

      it('leaves a mapped path outside the project root alone', async () => {
        const outside = path.join(tmpDir, 'outside', 'mcp.json');
        await fse.outputFile(outside, await fse.readFile(customFile(), 'utf-8'));
        await commitTeamYaml({ ...TOOL_PATHS, cursor: { ...TOOL_PATHS.cursor, mcpProject: '../outside/mcp.json' } });
        await commitTeamYaml(TOOL_PATHS);
        await fse.remove(customFile());

        await reconcileMcpForConfig(teamConfig, projectConfig);

        expect(Object.keys((await ledger()).files)).not.toContain(outside);
        expect(await excludeOf(projectRoot)).not.toMatch(/outside/);
      });

      it.each([
        ['the team repo is a shallow clone without that revision', true, async (): Promise<LocalConfig> => {
          const shallow = path.join(tmpDir, 'team-shallow');
          execFileSync('git', ['clone', '-q', '--depth', '1', `file://${repoPath}`, shallow]);
          return { ...projectConfig, repo: { ...projectConfig.repo, localPath: shallow } } as LocalConfig;
        }],
        ['teamai.yaml was never committed', true, async (): Promise<LocalConfig> => {
          await fse.remove(path.join(repoPath, '.git'));
          git(repoPath, 'init', '-q');
          git(repoPath, 'add', 'mcp');
          git(repoPath, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'mcp');
          return projectConfig;
        }],
        ['the team repo has no commits', false, async (): Promise<LocalConfig> => {
          await fse.remove(path.join(repoPath, '.git'));
          git(repoPath, 'init', '-q');
          return projectConfig;
        }],
        ['the team repo is not a git repository', false, async (): Promise<LocalConfig> => {
          await fse.remove(path.join(repoPath, '.git'));
          return projectConfig;
        }],
        ['git fails reading it', false, async (): Promise<LocalConfig> => {
          await fse.emptyDir(path.join(repoPath, '.git', 'objects'));
          return projectConfig;
        }],
      ])('protects as before when %s', async (_label, read, arrange) => {
        const cfg = await arrange();

        await expect(reconcileMcpForConfig(teamConfig, cfg)).resolves.toBeDefined();

        expect(await excludeOf(projectRoot)).not.toMatch(/team-mcp\.json/);
        expect(await excludeOf(projectRoot)).toMatch(/^\/\.mcp\.json$/m);
        // Read as far as git could: a failure is tried again on the next pull.
        expect((await ledger(cfg)).earlierMappingsRead).toBe(read ? true : undefined);
      });
    });

    describe('a config written for a tool the team has since moved, that another tool\'s mapping still reaches', () => {
      const shared = { ...TOOL_PATHS, cursor: { ...TOOL_PATHS.cursor, mcpProject: '.mcp.json' } };
      const mcpJson = (): string => path.join(projectRoot, '.mcp.json');
      const ledger = async (): Promise<Record<string, unknown>> => {
        const { readResolvedMcpFiles } = await import('../mcp-resolved-files.js');
        return (await readResolvedMcpFiles(projectConfig)).files;
      };
      const setServers = async (servers: Record<string, unknown>): Promise<void> => {
        const doc = await fse.readJson(mcpJson()) as { mcpServers: Record<string, unknown> };
        await fse.writeJson(mcpJson(), { mcpServers: { open: doc.mcpServers.open, ...servers } });
      };

      beforeEach(async () => {
        // Cursor's own server, with the token, lands in the file Claude maps too.
        await writeMcpYaml(`${withSecret}    tools: [cursor]\n  - name: open\n    transport: http\n    url: https://example.com/open\n    tools: [claude]\n`);
        await reconcileMcpForConfig({ ...teamConfig, toolPaths: shared } as TeamaiConfig, projectConfig);
        expect(await fse.readFile(mcpJson(), 'utf-8')).toContain('super-secret-value');
        // Then the team moves Cursor back to its own file and drops that server; the token is no longer set.
        await writeMcpYaml('servers:\n  - name: open\n    transport: http\n    url: https://example.com/open\n    tools: [claude]\n');
        vi.stubEnv('SECRET_TOKEN', '');
      });

      it('keeps its line while the file holds that tool\'s server', async () => {
        await reconcileMcpForConfig(teamConfig, projectConfig);

        expect(await fse.readFile(mcpJson(), 'utf-8')).toContain('super-secret-value');
        expect(await excludeOf(projectRoot)).toMatch(/^\/\.mcp\.json$/m);
        expect(git(projectRoot, 'status', '--porcelain', '--untracked-files=all')).not.toMatch(/\.mcp\.json/);
      });

      // As for any recorded file: nothing tells the member's server from one teamai wrote there for Cursor.
      it('keeps it while the file holds a server of the member\'s own', async () => {
        await reconcileMcpForConfig(teamConfig, projectConfig);
        await setServers({ mine: { type: 'http', url: 'https://mine.example/mcp' } });

        await reconcileMcpForConfig(teamConfig, projectConfig);

        expect(await excludeOf(projectRoot)).toMatch(/^\/\.mcp\.json$/m);
      });

      it('lets the line go, and takes that tool off the record, once only servers the tools mapping it own are left', async () => {
        await reconcileMcpForConfig(teamConfig, projectConfig);
        await setServers({});

        await reconcileMcpForConfig(teamConfig, projectConfig);

        expect(await excludeOf(projectRoot)).not.toMatch(/^\/\.mcp\.json$/m);
        expect(Object.keys(await ledger())).not.toContain(mcpJson());
      });

      describe('written by an older teamai, under a mapping only an earlier teamai.yaml made', () => {
        const commitTeamYaml = (toolPaths: object): void => {
          // JSON is YAML.
          fse.writeFileSync(path.join(repoPath, 'teamai.yaml'), JSON.stringify({ team: 't', toolPaths }));
          git(repoPath, 'add', '-A');
          git(repoPath, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'toolPaths');
        };
        const sidecarState = async (): Promise<{ files: Record<string, unknown>; earlierMappingsRead?: true }> => {
          const { readResolvedMcpFiles } = await import('../mcp-resolved-files.js');
          return readResolvedMcpFiles(projectConfig);
        };

        beforeEach(async () => {
          git(repoPath, 'init', '-q');
          commitTeamYaml(shared);
          commitTeamYaml(TOOL_PATHS);
          // What a teamai from before managed-mcp-files.json leaves: no record of the path, nothing in the exclude.
          // The manifest keeps its resolved notes, so only the moved tool's server can hold the line.
          const { resolvedMcpFilesPath } = await import('../mcp-resolved-files.js');
          await fse.remove(resolvedMcpFilesPath(projectConfig) ?? '');
          await fse.writeFile(path.join(projectRoot, '.git', 'info', 'exclude'), '');
        });

        it('is listed, and recorded for that tool, by the first pull on this version', async () => {
          await reconcileMcpForConfig(unmovedConfig(), projectConfig);

          expect(await fse.readFile(mcpJson(), 'utf-8')).toContain('super-secret-value');
          expect(await excludeOf(projectRoot)).toMatch(/^\/\.mcp\.json$/m);
          expect(git(projectRoot, 'status', '--porcelain', '--untracked-files=all')).not.toMatch(/\.mcp\.json/);
          expect((await sidecarState()).files[mcpJson()]).toEqual({ tools: ['cursor'] });
        });

        it('keeps its line on the pulls after, from the record', async () => {
          await reconcileMcpForConfig(teamConfig, projectConfig);
          await fse.writeFile(path.join(projectRoot, '.git', 'info', 'exclude'), '');

          await reconcileMcpForConfig(teamConfig, projectConfig);

          expect(await excludeOf(projectRoot)).toMatch(/^\/\.mcp\.json$/m);
        });

        it('adds that tool to the record the file already has', async () => {
          const { trackResolvedMcpFiles } = await import('../mcp-resolved-files.js');
          await trackResolvedMcpFiles(projectConfig, [{ tool: 'claude', file: mcpJson() }]);

          await reconcileMcpForConfig(unmovedConfig(), projectConfig);

          expect((await sidecarState()).files[mcpJson()]).toEqual({ tools: ['claude', 'cursor'] });
          expect(await excludeOf(projectRoot)).toMatch(/^\/\.mcp\.json$/m);
        });

        it('leaves it to the tools mapping it when only their servers are left', async () => {
          await setServers({});

          await reconcileMcpForConfig(teamConfig, projectConfig);

          expect(await excludeOf(projectRoot)).not.toMatch(/^\/\.mcp\.json$/m);
          expect(Object.keys((await sidecarState()).files)).not.toContain(mcpJson());
          expect((await sidecarState()).earlierMappingsRead).toBe(true);
        });

        it('leaves a file the same tool still maps to that tool\'s own rules', async () => {
          const { earlierMappedMcpTargets } = await import('../mcp-reconcile.js');
          const today = { ...teamConfig, toolPaths: shared } as TeamaiConfig;

          const found = await earlierMappedMcpTargets(projectConfig, await resolveMcpTargets(today, projectConfig, { includeUndetected: true }));

          expect(found?.map((target) => target.file)).not.toContain(mcpJson());
          const moved = await earlierMappedMcpTargets(projectConfig, await resolveMcpTargets(teamConfig, projectConfig, { includeUndetected: true }));
          expect(moved?.map(({ tool, file }) => ({ tool, file }))).toContainEqual({ tool: 'cursor', file: mcpJson() });
        });
      });
    });

    describe('a tool\'s built-in location, once the team moves or drops the tool', () => {
      const moved = { ...teamConfig, toolPaths: { ...TOOL_PATHS, cursor: { ...TOOL_PATHS.cursor, mcpProject: '.cursor/team-mcp.json' } } } as TeamaiConfig;
      const dropped = { ...teamConfig, toolPaths: { claude: TOOL_PATHS.claude, codebuddy: TOOL_PATHS.codebuddy } } as TeamaiConfig;
      const cursorJson = (): string => path.join(projectRoot, '.cursor', 'mcp.json');
      const open = 'servers:\n  - name: open\n    transport: http\n    url: https://example.com/open\n';
      const ledger = async (): Promise<Record<string, unknown>> => {
        const { readResolvedMcpFiles } = await import('../mcp-resolved-files.js');
        return (await readResolvedMcpFiles(projectConfig)).files;
      };
      // What a teamai from before managed-mcp-files.json leaves: no record of the path, nothing in the exclude.
      const asOlderTeamai = async (): Promise<void> => {
        const { resolvedMcpFilesPath } = await import('../mcp-resolved-files.js');
        const { getDataHome, managedMcpManifestPath } = await import('../types.js');
        await fse.remove(resolvedMcpFilesPath(projectConfig) ?? '');
        await fse.writeFile(path.join(projectRoot, '.git', 'info', 'exclude'), '');
        const manifestFile = managedMcpManifestPath(getDataHome(projectConfig), projectRoot);
        const manifest = await fse.readJson(manifestFile) as Record<string, Array<Record<string, unknown>>>;
        await fse.writeJson(manifestFile, Object.fromEntries(Object.entries(manifest).map(([key, records]) =>
          [key, records.map(({ name, hash }) => ({ name, hash }))])));
      };

      beforeEach(async () => {
        await writeMcpYaml(withSecret);
        await reconcileMcpForConfig(teamConfig, projectConfig);
        expect(await fse.readFile(cursorJson(), 'utf-8')).toContain('super-secret-value');
        // Then the team drops that server; the token is no longer set.
        await writeMcpYaml(open);
        vi.stubEnv('SECRET_TOKEN', '');
      });

      // The pull that writes the moved file replaces Cursor's records: from the next one they describe that file.
      it('keeps the line a pull on this version added when the team moves the tool', async () => {
        await reconcileMcpForConfig(moved, projectConfig);
        await reconcileMcpForConfig(moved, projectConfig);

        expect(await fse.readFile(cursorJson(), 'utf-8')).toContain('super-secret-value');
        expect(await excludeOf(projectRoot)).toMatch(/^\/\.cursor\/mcp\.json$/m);
        expect(git(projectRoot, 'status', '--porcelain', '--untracked-files=all')).not.toMatch(/\.cursor\/mcp\.json/);
      });

      it('is listed and recorded by the first pull on this version when an older teamai wrote it', async () => {
        await asOlderTeamai();

        await reconcileMcpForConfig(moved, projectConfig);

        expect(await excludeOf(projectRoot)).toMatch(/^\/\.cursor\/mcp\.json$/m);
        expect(git(projectRoot, 'status', '--porcelain', '--untracked-files=all')).not.toMatch(/\.cursor\/mcp\.json/);
        expect((await ledger())[cursorJson()]).toEqual({ tools: ['cursor'] });
      });

      it('keeps its line on the pulls after, from the record', async () => {
        await asOlderTeamai();
        await reconcileMcpForConfig(moved, projectConfig);
        await fse.writeFile(path.join(projectRoot, '.git', 'info', 'exclude'), '');

        await reconcileMcpForConfig(moved, projectConfig);

        expect(await excludeOf(projectRoot)).toMatch(/^\/\.cursor\/mcp\.json$/m);
      });

      it('keeps its line when the team then drops the tool', async () => {
        await asOlderTeamai();
        await reconcileMcpForConfig(moved, projectConfig);
        await asOlderTeamai();

        await reconcileMcpForConfig(dropped, projectConfig);

        expect(await excludeOf(projectRoot)).toMatch(/^\/\.cursor\/mcp\.json$/m);
      });

      // No record describes that path any more, so a server of the member's own cannot be told from an older teamai's.
      it.each([
        ['moves', moved],
        ['drops', dropped],
      ])('lists and records it while it holds only a server of the member\'s own, when the team %s the tool', async (_label, config) => {
        await reconcileMcpForConfig(moved, projectConfig);
        await fse.writeJson(cursorJson(), { mcpServers: { mine: { type: 'http', url: 'https://mine.example/mcp' } } });
        await asOlderTeamai();

        await reconcileMcpForConfig(config, projectConfig);

        expect(await excludeOf(projectRoot)).toMatch(/^\/\.cursor\/mcp\.json$/m);
        expect((await ledger())[cursorJson()]).toEqual({ tools: ['cursor'] });
      });

      it('lets its line go, and forgets it, once it holds no server', async () => {
        await reconcileMcpForConfig(moved, projectConfig);
        await fse.writeJson(cursorJson(), { mcpServers: {} });

        await reconcileMcpForConfig(moved, projectConfig);

        expect(await excludeOf(projectRoot)).not.toMatch(/\.cursor\/mcp\.json/);
        expect(Object.keys(await ledger())).not.toContain(cursorJson());
      });

    });

    // CodeBuddy's built-in location is .mcp.json, which Claude maps; TOOL_PATHS moves CodeBuddy to .codebuddy/mcp.json.
    describe('a tool\'s built-in location another tool maps today, once the team moves or drops the tool', () => {
      const builtin = (): TeamaiConfig => ({ ...teamConfig, toolPaths: { ...TOOL_PATHS, codebuddy: { ...TOOL_PATHS.codebuddy, mcpProject: '.mcp.json' } } } as TeamaiConfig);
      const dropped = (): TeamaiConfig => ({ ...teamConfig, toolPaths: { claude: TOOL_PATHS.claude, cursor: TOOL_PATHS.cursor } } as TeamaiConfig);
      const mcpJson = (): string => path.join(projectRoot, '.mcp.json');
      const open = '  - name: open\n    transport: http\n    url: https://example.com/open\n    tools: [claude]\n';
      const ledger = async (): Promise<Record<string, unknown>> => {
        const { readResolvedMcpFiles } = await import('../mcp-resolved-files.js');
        return (await readResolvedMcpFiles(projectConfig)).files;
      };
      // An older teamai: no record of the path, nothing in the exclude; and CodeBuddy's record is lost.
      const asOlderTeamai = async (): Promise<void> => {
        const { resolvedMcpFilesPath } = await import('../mcp-resolved-files.js');
        const { getDataHome, managedMcpManifestPath } = await import('../types.js');
        await fse.remove(resolvedMcpFilesPath(projectConfig) ?? '');
        await fse.writeFile(path.join(projectRoot, '.git', 'info', 'exclude'), '');
        const manifestFile = managedMcpManifestPath(getDataHome(projectConfig), projectRoot);
        const manifest = await fse.readJson(manifestFile) as Record<string, unknown>;
        delete manifest['codebuddy:project'];
        await fse.writeJson(manifestFile, manifest);
      };
      const setServers = async (servers: Record<string, unknown>): Promise<void> => {
        const doc = await fse.readJson(mcpJson()) as { mcpServers: Record<string, unknown> };
        await fse.writeJson(mcpJson(), { mcpServers: { open: doc.mcpServers.open, ...servers } });
      };

      beforeEach(async () => {
        // CodeBuddy's server, with the token, lands in .mcp.json beside Claude's.
        await fse.ensureDir(path.join(projectRoot, '.codebuddy', 'skills'));
        await writeMcpYaml(`${withSecret}    tools: [codebuddy]\n${open}`);
        await reconcileMcpForConfig(builtin(), projectConfig);
        expect(await fse.readFile(mcpJson(), 'utf-8')).toContain('super-secret-value');
        // Then the team drops that server; the token is no longer set.
        await writeMcpYaml(`servers:\n${open}`);
        vi.stubEnv('SECRET_TOKEN', '');
      });

      it.each([
        ['moves', () => teamConfig],
        ['drops', dropped],
      ])('lists it, and records it for that tool, when an older teamai wrote it and the team %s the tool', async (_label, config) => {
        await asOlderTeamai();

        await reconcileMcpForConfig(config(), projectConfig);

        expect(await fse.readFile(mcpJson(), 'utf-8')).toContain('super-secret-value');
        expect(await excludeOf(projectRoot)).toMatch(/^\/\.mcp\.json$/m);
        expect(git(projectRoot, 'status', '--porcelain', '--untracked-files=all')).not.toMatch(/\.mcp\.json/);
        expect((await ledger())[mcpJson()]).toEqual({ tools: ['codebuddy'] });
      });

      it('keeps its line on the pulls after, from the record', async () => {
        await asOlderTeamai();
        await reconcileMcpForConfig(teamConfig, projectConfig);
        await fse.writeFile(path.join(projectRoot, '.git', 'info', 'exclude'), '');

        await reconcileMcpForConfig(teamConfig, projectConfig);

        expect(await excludeOf(projectRoot)).toMatch(/^\/\.mcp\.json$/m);
      });

      // The accepted cost: nothing tells a member's own server there from one teamai wrote for CodeBuddy.
      it('keeps a line while it holds a server of the member\'s own', async () => {
        await setServers({ mine: { type: 'http', url: 'https://mine.example/mcp' } });
        await asOlderTeamai();

        await reconcileMcpForConfig(teamConfig, projectConfig);

        expect(await excludeOf(projectRoot)).toMatch(/^\/\.mcp\.json$/m);
        expect((await ledger())[mcpJson()]).toEqual({ tools: ['codebuddy'] });
      });

      it('leaves it to the tools mapping it once only their servers are left', async () => {
        await reconcileMcpForConfig(teamConfig, projectConfig);
        await setServers({});

        await reconcileMcpForConfig(teamConfig, projectConfig);

        expect(await excludeOf(projectRoot)).not.toMatch(/^\/\.mcp\.json$/m);
        expect(Object.keys(await ledger())).not.toContain(mcpJson());
      });
    });

    it('lists the config in .git/info/exclude before writing the value into it', async () => {
      await writeMcpYaml(withSecret);

      await reconcileMcpForConfig(teamConfig, projectConfig);

      expect(excludeAtWrite.get(path.join(projectRoot, '.mcp.json'))).toMatch(/^\/\.mcp\.json$/m);
      expect(await fse.readFile(path.join(projectRoot, '.mcp.json'), 'utf-8')).toContain('super-secret-value');
    });

    describe('the line of a config left without a resolved value goes', () => {
      const mcpJson = (): string => path.join(projectRoot, '.mcp.json');
      const claudeOnly = (): LocalConfig => ({ ...projectConfig, disabledAgents: ['cursor'] } as LocalConfig);
      const open = 'servers:\n  - name: open\n    transport: http\n    url: https://example.com/open\n';

      beforeEach(() => {
        vi.mocked(log.info).mockClear();
        vi.mocked(log.debug).mockClear();
      });

      afterEach(() => {
        beforeJsonWrite.run = null;
      });

      it.each([
        ['it does not parse', () => fse.writeFile(mcpJson(), '{ "mcpServers": ')],
        ['it holds a server of the member\'s own under the team\'s name', () => fse.writeJson(mcpJson(), {
          mcpServers: { 'with-secret': { type: 'http', url: 'https://mine.example/mcp' } },
        })],
      ])('when this pull listed it and then wrote nothing, as %s', async (_label, arrange) => {
        await pulledBefore();
        await arrange();
        await writeMcpYaml(withSecret);

        await reconcileMcpForConfig(unmovedConfig(), claudeOnly());

        expect(await fse.readFile(mcpJson(), 'utf-8')).not.toContain('super-secret-value');
        expect(await excludeOf(projectRoot)).not.toContain('teamai');
        // The member never saw the line go in, so its rollback is not news.
        expect(vi.mocked(log.info).mock.calls.flat().join('\n')).not.toMatch(/Removed/);
        expect(vi.mocked(log.debug).mock.calls.flat().join('\n')).toMatch(/\/\.mcp\.json/);
      });

      it.each([false, true])('handles a failed ownership write after adding a credential, restoration fails=%s', async (restoreFails) => {
        // Shorter than eight characters: no scan of the file can find it again.
        vi.stubEnv('SECRET_TOKEN', 'short');
        await writeMcpYaml(withSecret);
        beforeJsonWrite.run = async (file) => {
          if (path.basename(file) === 'managed-mcp.json') throw new Error('disk full');
        };

        const rm = fs.promises.rm;
        const spy = vi.spyOn(fs.promises, 'rm').mockImplementation(async (file, ...args) => {
          if (restoreFails && String(file) === mcpJson()) throw new Error('simulated restoration failure');
          return rm(file, ...args);
        });
        await expect(reconcileMcpForConfig(teamConfig, claudeOnly())).rejects.toThrow(restoreFails ? /restoring configs failed.*simulated restoration failure/ : 'disk full');
        spy.mockRestore();

        if (restoreFails) {
          expect(await fse.readFile(mcpJson(), 'utf-8')).toContain('Bearer short');
          expect(await excludeOf(projectRoot)).toMatch(/^\/\.mcp\.json$/m);
        } else {
          expect(await fse.pathExists(mcpJson())).toBe(false);
          expect(await excludeOf(projectRoot)).not.toMatch(/^\/\.mcp\.json$/m);
          const { readResolvedMcpFiles } = await import('../mcp-resolved-files.js');
          expect((await readResolvedMcpFiles(claudeOnly())).files[mcpJson()]).toBeUndefined();
        }
      });

      it('but one an earlier pull listed stays while the config cannot be proven clean', async () => {
        await writeMcpYaml(withSecret);
        await reconcileMcpForConfig(teamConfig, claudeOnly());
        const { getDataHome, managedMcpManifestPath } = await import('../types.js');
        await fse.remove(managedMcpManifestPath(getDataHome(projectConfig), projectRoot));
        await fse.writeFile(mcpJson(), '{ "mcpServers": ');
        vi.stubEnv('SECRET_TOKEN', 'rotated-secret-value');

        await reconcileMcpForConfig(teamConfig, claudeOnly());

        expect(await excludeOf(projectRoot)).toMatch(/^\/\.mcp\.json$/m);
      });

      it('but one an earlier pull listed stays when this pull rewrote the manifest it had lost', async () => {
        await writeMcpYaml(withSecret);
        await reconcileMcpForConfig(teamConfig, claudeOnly());
        const { getDataHome, managedMcpManifestPath } = await import('../types.js');
        await fse.remove(managedMcpManifestPath(getDataHome(projectConfig), projectRoot));
        await writeMcpYaml(open);
        vi.stubEnv('SECRET_TOKEN', '');

        await reconcileMcpForConfig(teamConfig, claudeOnly());

        expect(await fse.readFile(mcpJson(), 'utf-8')).toContain('super-secret-value');
        expect(await fse.pathExists(managedMcpManifestPath(getDataHome(projectConfig), projectRoot))).toBe(true);
        expect(await excludeOf(projectRoot)).toMatch(/^\/\.mcp\.json$/m);
      });

      it('and every pull after the one that rewrote the manifest it had lost', async () => {
        await writeMcpYaml(withSecret);
        await reconcileMcpForConfig(teamConfig, claudeOnly());
        const { getDataHome, managedMcpManifestPath } = await import('../types.js');
        await fse.remove(managedMcpManifestPath(getDataHome(projectConfig), projectRoot));
        await writeMcpYaml(open);
        vi.stubEnv('SECRET_TOKEN', '');
        await reconcileMcpForConfig(teamConfig, claudeOnly());

        await reconcileMcpForConfig(teamConfig, claudeOnly());
        await reconcileMcpForConfig(teamConfig, claudeOnly());

        expect(await fse.readFile(mcpJson(), 'utf-8')).toContain('super-secret-value');
        expect(await excludeOf(projectRoot)).toMatch(/^\/\.mcp\.json$/m);
      });

      it('and every pull after one that rewrote the manifest it had lost while another command held managed-mcp-files.json', async () => {
        await writeMcpYaml(withSecret);
        await reconcileMcpForConfig(teamConfig, claudeOnly());
        const { getDataHome, managedMcpManifestPath } = await import('../types.js');
        const { resolvedMcpFilesPath } = await import('../mcp-resolved-files.js');
        await fse.remove(managedMcpManifestPath(getDataHome(projectConfig), projectRoot));
        await writeMcpYaml(open);
        vi.stubEnv('SECRET_TOKEN', '');
        const lock = `${resolvedMcpFilesPath(projectConfig)}.teamai-lock`;
        expect(await acquireLock(lock)).toBe(true);
        try {
          await reconcileMcpForConfig(teamConfig, claudeOnly());
          expect(await fse.readJson(mcpJson())).toMatchObject({ mcpServers: { open: expect.anything() } });
          // Still held: the note is still missing, and so the line stays.
          await reconcileMcpForConfig(teamConfig, claudeOnly());
          expect(await excludeOf(projectRoot)).toMatch(/^\/\.mcp\.json$/m);
        } finally {
          await releaseLock(lock);
        }

        await reconcileMcpForConfig(teamConfig, claudeOnly());
        await reconcileMcpForConfig(teamConfig, claudeOnly());

        expect(await fse.readFile(mcpJson(), 'utf-8')).toContain('super-secret-value');
        expect(await excludeOf(projectRoot)).toMatch(/^\/\.mcp\.json$/m);

        // Noted at last: once the member takes the stale server out, the line goes.
        const doc = await fse.readJson(mcpJson()) as { mcpServers: Record<string, unknown> };
        delete doc.mcpServers['with-secret'];
        await fse.writeJson(mcpJson(), doc);
        await reconcileMcpForConfig(teamConfig, claudeOnly());
        expect(await excludeOf(projectRoot)).not.toContain('teamai');
      }, 30_000);

      describe.each([
        ['empty', ''],
        ['truncated', '{ "claude:project": [ { "name": "with-sec'],
        ['recording nothing for this tool', '{ "cursor:project": [ { "name": "with-secret", "hash": "h" } ] }'],
      ])('but one an earlier pull listed stays while managed-mcp.json is %s', (_label, content) => {
        beforeEach(async () => {
          await writeMcpYaml(withSecret);
          await reconcileMcpForConfig(teamConfig, claudeOnly());
          const { getDataHome, managedMcpManifestPath } = await import('../types.js');
          await fse.writeFile(managedMcpManifestPath(getDataHome(projectConfig), projectRoot), content);
          vi.stubEnv('SECRET_TOKEN', '');
        });

        it('and a pull finds its server gone from mcp.yaml', async () => {
          await writeMcpYaml(open);

          await reconcileMcpForConfig(teamConfig, claudeOnly());

          expect(await fse.readFile(mcpJson(), 'utf-8')).toContain('super-secret-value');
          expect(await excludeOf(projectRoot)).toMatch(/^\/\.mcp\.json$/m);
        });

        it('and `teamai mcp remove` runs after its server left mcp.yaml', async () => {
          await writeMcpYaml('servers: []\n');

          await reconcileMcpForConfig(teamConfig, claudeOnly(), { removeAll: true });
          await releaseCleanMcpGitExcludes(teamConfig, claudeOnly());

          expect(await fse.readFile(mcpJson(), 'utf-8')).toContain('super-secret-value');
          expect(await excludeOf(projectRoot)).toMatch(/^\/\.mcp\.json$/m);
        });

        it('and a later pull runs after one rebuilt the record for another server', async () => {
          await writeMcpYaml(open);
          await reconcileMcpForConfig(teamConfig, claudeOnly());

          await reconcileMcpForConfig(teamConfig, claudeOnly());

          expect(await fse.readFile(mcpJson(), 'utf-8')).toContain('super-secret-value');
          expect(await excludeOf(projectRoot)).toMatch(/^\/\.mcp\.json$/m);
        });

        it('and `teamai mcp remove` runs after a pull rebuilt the record for another server', async () => {
          await writeMcpYaml(open);
          await reconcileMcpForConfig(teamConfig, claudeOnly());

          await reconcileMcpForConfig(teamConfig, claudeOnly(), { removeAll: true });
          await releaseCleanMcpGitExcludes(teamConfig, claudeOnly());

          expect(await fse.readFile(mcpJson(), 'utf-8')).toContain('super-secret-value');
          expect(await excludeOf(projectRoot)).toMatch(/^\/\.mcp\.json$/m);
        });

        it('until the member takes that server out of the config', async () => {
          await writeMcpYaml(open);
          await reconcileMcpForConfig(teamConfig, claudeOnly());
          const doc = await fse.readJson(mcpJson()) as { mcpServers: Record<string, unknown> };
          delete doc.mcpServers['with-secret'];
          await fse.writeJson(mcpJson(), doc);

          await reconcileMcpForConfig(teamConfig, claudeOnly());

          expect(await excludeOf(projectRoot)).not.toContain('teamai');
        });
      });

      it('when a server of the member\'s own was in the config before teamai first wrote to it', async () => {
        await pulledBefore();
        await fse.writeJson(mcpJson(), { mcpServers: { mine: { type: 'http', url: 'https://mine.example/mcp' } } });
        await writeMcpYaml(withSecret);
        await reconcileMcpForConfig(unmovedConfig(), claudeOnly());
        await writeMcpYaml(open);

        await reconcileMcpForConfig(unmovedConfig(), claudeOnly());

        expect(await fse.readJson(mcpJson())).toEqual({
          mcpServers: { mine: { type: 'http', url: 'https://mine.example/mcp' }, open: expect.anything() },
        });
        expect(await excludeOf(projectRoot)).not.toContain('teamai');
      });

      it('when `teamai mcp remove` takes teamai\'s servers out of a config that also holds the member\'s own', async () => {
        await pulledBefore();
        await fse.writeJson(mcpJson(), { mcpServers: { mine: { type: 'http', url: 'https://mine.example/mcp' } } });
        await writeMcpYaml(withSecret);
        await reconcileMcpForConfig(unmovedConfig(), claudeOnly());

        await reconcileMcpForConfig(unmovedConfig(), claudeOnly(), { removeAll: true });
        await releaseCleanMcpGitExcludes(unmovedConfig(), claudeOnly());

        expect(await fse.readJson(mcpJson())).toEqual({ mcpServers: { mine: { type: 'http', url: 'https://mine.example/mcp' } } });
        expect(await excludeOf(projectRoot)).not.toContain('teamai');
      });

      it('when the last server with a resolved value leaves mcp.yaml', async () => {
        await writeMcpYaml(`${withSecret}  - name: open\n    transport: http\n    url: https://example.com/open\n`);
        await reconcileMcpForConfig(teamConfig, claudeOnly());
        await fse.appendFile(path.join(projectRoot, '.git', 'info', 'exclude'), 'mine/\n');
        await writeMcpYaml(open);

        await reconcileMcpForConfig(teamConfig, claudeOnly());

        expect(await fse.readFile(mcpJson(), 'utf-8')).toContain('https://example.com/open');
        expect(await excludeOf(projectRoot)).not.toContain('teamai');
        expect(await excludeOf(projectRoot)).toMatch(/^mine\/$/m);
        expect(log.info).toHaveBeenCalledWith(expect.stringMatching(/^Removed \/\.mcp\.json from /));
      });

      it('when `teamai mcp remove` takes teamai\'s servers out', async () => {
        await writeMcpYaml(withSecret);
        await reconcileMcpForConfig(teamConfig, claudeOnly());

        await reconcileMcpForConfig(teamConfig, claudeOnly(), { removeAll: true });
        await releaseCleanMcpGitExcludes(teamConfig, claudeOnly());

        expect(await excludeOf(projectRoot)).not.toContain('teamai');
      });

      it('when `teamai mcp remove` finds a nested repository\'s linked worktree holding no server', async () => {
        const cursorDir = path.join(projectRoot, '.cursor');
        git(cursorDir, 'init', '-q');
        git(cursorDir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
        const linked = path.join(tmpDir, 'cursor-linked');
        git(cursorDir, 'worktree', 'add', '-q', linked);
        await fse.writeJson(path.join(linked, 'mcp.json'), { mcpServers: {} });
        await fse.writeFile(path.join(cursorDir, '.git', 'info', 'exclude'), [
          '# [teamai:mcp-exclude:start] project MCP configs holding resolved ${VAR} values',
          '/mcp.json',
          '# [teamai:mcp-exclude:end]',
          '',
        ].join('\n'));
        await writeMcpYaml(withSecret);

        await releaseCleanMcpGitExcludes(teamConfig, projectConfig);

        expect(await excludeOf(cursorDir)).not.toContain('teamai');
      });

      it('but not while another worktree\'s copy of the config still holds one', async () => {
        git(projectRoot, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
        const worktree = path.join(await fse.realpath(tmpDir), 'business-wt');
        git(projectRoot, 'worktree', 'add', '-q', worktree);
        await fse.ensureDir(path.join(worktree, '.claude', 'skills'));
        const { resolveProjectDataHome } = await import('../config.js');
        const other = { ...claudeOnly(), projectRoot: worktree, dataHome: await resolveProjectDataHome(worktree) } as LocalConfig;
        await writeMcpYaml(withSecret);
        await reconcileMcpForConfig(teamConfig, claudeOnly());
        await reconcileMcpForConfig(teamConfig, other);
        await writeMcpYaml(open);

        await reconcileMcpForConfig(teamConfig, claudeOnly());

        expect(await fse.readFile(path.join(worktree, '.mcp.json'), 'utf-8')).toContain('super-secret-value');
        expect(await excludeOf(projectRoot)).toMatch(/^\/\.mcp\.json$/m);
      });

      describe('after a server\'s ${VAR} became a literal, judged from another worktree', () => {
        const literal = withSecret.replace('${SECRET_TOKEN}', 'published-literal');
        let worktree: string;

        beforeEach(async () => {
          git(projectRoot, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
          // As git lists it (macOS /var is a symlink), so its manifest is found under the same key.
          worktree = path.join(await fse.realpath(tmpDir), 'business-wt');
          git(projectRoot, 'worktree', 'add', '-q', worktree);
          await fse.ensureDir(path.join(worktree, '.claude', 'skills'));
          const { resolveProjectDataHome } = await import('../config.js');
          const other = { ...claudeOnly(), projectRoot: worktree, dataHome: await resolveProjectDataHome(worktree) } as LocalConfig;
          await writeMcpYaml(withSecret);
          await reconcileMcpForConfig(teamConfig, claudeOnly());
          await reconcileMcpForConfig(teamConfig, other);
          await writeMcpYaml(literal);
          vi.stubEnv('SECRET_TOKEN', '');
        });

        it('keeps the shared line while that worktree\'s config still holds the stale entry', async () => {
          await reconcileMcpForConfig(teamConfig, claudeOnly());

          expect(await fse.readFile(mcpJson(), 'utf-8')).toContain('published-literal');
          expect(await fse.readFile(path.join(worktree, '.mcp.json'), 'utf-8')).toContain('super-secret-value');
          expect(await excludeOf(projectRoot)).toMatch(/^\/\.mcp\.json$/m);
          expect(git(worktree, 'status', '--porcelain', '--untracked-files=all')).not.toMatch(/\.mcp\.json/);
        });

        it('removes the line once that worktree\'s config is gone', async () => {
          await fse.remove(path.join(worktree, '.mcp.json'));

          await reconcileMcpForConfig(teamConfig, claudeOnly());

          expect(await excludeOf(projectRoot)).not.toContain('teamai');
        });
      });
    });

    it('lists the config again when a concurrent uninstall drops its line between the check and the write', async () => {
      const { findMcpGitExcludes, removeMcpGitExclude } = await import('../mcp-git-exclude.js');
      beforeJsonWrite.run = async () => {
        for (const [excludeFile, entries] of await findMcpGitExcludes([projectRoot])) {
          await removeMcpGitExclude(excludeFile, entries.map((entry) => entry.pattern));
        }
      };
      await writeMcpYaml(withSecret);

      try {
        await reconcileMcpForConfig(teamConfig, { ...projectConfig, disabledAgents: ['cursor'] } as LocalConfig);
      } finally {
        beforeJsonWrite.run = null;
      }

      expect(excludeAtWrite.get(path.join(projectRoot, '.mcp.json'))).not.toContain('teamai');
      expect(await excludeOf(projectRoot)).toMatch(/^\/\.mcp\.json$/m);
    });

    describe('when the config cannot be kept out of git first', () => {
      const mcpJson = (): string => path.join(projectRoot, '.mcp.json');
      const infoDir = (): string => path.join(projectRoot, '.git', 'info');
      const claudeOnly = (): LocalConfig => ({ ...projectConfig, disabledAgents: ['cursor'] } as LocalConfig);

      beforeEach(() => {
        vi.mocked(log.warn).mockClear();
      });

      afterEach(async () => {
        await fse.chmod(infoDir(), 0o755);
        await fse.chmod(path.join(infoDir(), 'exclude'), 0o644);
      });

      it.skipIf(process.getuid?.() === 0).each([
        ['.git/info/exclude is read-only', () => fse.chmod(path.join(infoDir(), 'exclude'), 0o444)],
        ['.git/info is read-only', () => fse.chmod(infoDir(), 0o555)],
      ])('writes no value when %s, and warns with the fix', async (_label, lockDown) => {
        await writeMcpYaml(withSecret);
        await lockDown();

        const { changes } = await reconcileMcpForConfig(teamConfig, claudeOnly());

        expect(await fse.pathExists(mcpJson())).toBe(false);
        expect(changes).toContainEqual(expect.objectContaining({ tool: 'claude', server: 'with-secret', action: 'skipped' }));
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(mcpJson()));
        expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/not writable[\s\S]*teamai pull/));
      });

      it.skipIf(process.getuid?.() === 0)('writes no value when .git/info/exclude exists but cannot be read, and keeps the member\'s lines (#915)', async () => {
        await fse.outputFile(path.join(infoDir(), 'exclude'), 'scratch/\n');
        await writeMcpYaml(withSecret);
        await fse.chmod(path.join(infoDir(), 'exclude'), 0o200);

        const { changes } = await reconcileMcpForConfig(teamConfig, claudeOnly());

        expect(await fse.pathExists(mcpJson())).toBe(false);
        expect(changes).toContainEqual(expect.objectContaining({ tool: 'claude', server: 'with-secret', action: 'skipped' }));
        expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/cannot be read[\s\S]*readable[\s\S]*teamai pull/));
        await fse.chmod(path.join(infoDir(), 'exclude'), 0o644);
        expect(await fse.readFile(path.join(infoDir(), 'exclude'), 'utf-8')).toBe('scratch/\n');
      });

      it.skipIf(process.getuid?.() === 0)('keeps an earlier entry as it was', async () => {
        await writeMcpYaml(withSecret);
        await reconcileMcpForConfig(teamConfig, claudeOnly());
        await fse.writeFile(path.join(infoDir(), 'exclude'), '');
        const before = await fse.readFile(mcpJson(), 'utf-8');
        await writeMcpYaml(withSecret.replace('https://example.com/mcp', 'https://example.com/v2'));
        vi.stubEnv('SECRET_TOKEN', 'rotated-secret-value');
        await fse.chmod(infoDir(), 0o555);

        await reconcileMcpForConfig(teamConfig, claudeOnly());

        expect(await fse.readFile(mcpJson(), 'utf-8')).toBe(before);
      });

      it('writes no value when git cannot confirm it ignores the config after listing it (#915)', async () => {
        const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
        const bin = path.join(tmpDir, 'bin');
        await fse.outputFile(
          path.join(bin, 'git'),
          `#!/bin/sh\nif [ "$1" = check-ignore ]; then echo 'fatal: cannot check' >&2; exit 128; fi\nexec '${realGit}' "$@"\n`,
          { mode: 0o755 },
        );
        vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
        await writeMcpYaml(withSecret);

        const { changes } = await reconcileMcpForConfig(teamConfig, claudeOnly());

        expect(await fse.pathExists(mcpJson())).toBe(false);
        expect(changes).toContainEqual(expect.objectContaining({ tool: 'claude', server: 'with-secret', action: 'skipped' }));
        expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/could not confirm that it ignores[\s\S]*teamai pull/));
      });

      it('writes no value while another command holds the exclude file\'s lock', async () => {
        const lock = path.join(infoDir(), 'exclude.teamai-lock');
        expect(await acquireLock(lock)).toBe(true);
        await writeMcpYaml(withSecret);

        try {
          await reconcileMcpForConfig(teamConfig, claudeOnly());
        } finally {
          await releaseLock(lock);
        }

        expect(await fse.pathExists(mcpJson())).toBe(false);
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(mcpJson()));
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('teamai pull'));
      });

      it('writes no value into a file git already tracks, names the fix once, and still writes an untracked config', async () => {
        await fse.writeJson(mcpJson(), { mcpServers: {} });
        git(projectRoot, 'add', '.mcp.json');
        await writeMcpYaml(withSecret);

        const { changes } = await reconcileMcpForConfig(teamConfig, projectConfig);

        expect(await fse.readFile(mcpJson(), 'utf-8')).not.toContain('super-secret-value');
        expect(changes).toContainEqual(expect.objectContaining({
          tool: 'claude', server: 'with-secret', action: 'skipped', reason: expect.stringContaining(`git already tracks ${mcpJson()}`),
        }));
        const warnings = vi.mocked(log.warn).mock.calls.map(([line]) => String(line)).filter((line) => line.includes(mcpJson()));
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatch(new RegExp(`git already tracks[\\s\\S]*git rm --cached ${mcpJson()}[\\s\\S]*rotate`));
        expect((await fse.readJson(path.join(projectRoot, '.cursor', 'mcp.json'))).mcpServers['with-secret'].headers.Authorization)
          .toBe('Bearer super-secret-value');
        expect(await excludeOf(projectRoot)).toMatch(/^\/\.cursor\/mcp\.json$/m);
      });

      it('keeps the entry an earlier pull wrote to a file git now tracks, and updates it once the file is untracked (#879)', async () => {
        await writeMcpYaml(withSecret);
        await reconcileMcpForConfig(teamConfig, claudeOnly());
        git(projectRoot, 'add', '-f', '.mcp.json');
        const before = await fse.readFile(mcpJson(), 'utf-8');
        vi.stubEnv('SECRET_TOKEN', 'rotated-secret-value');

        await reconcileMcpForConfig(teamConfig, claudeOnly());
        expect(await fse.readFile(mcpJson(), 'utf-8')).toBe(before);

        git(projectRoot, 'rm', '-q', '--cached', '.mcp.json');
        const { changes } = await reconcileMcpForConfig(teamConfig, claudeOnly());
        expect(changes).toContainEqual({ tool: 'claude', server: 'with-secret', action: 'updated' });
        expect(await fse.readFile(mcpJson(), 'utf-8')).toContain('rotated-secret-value');
      });

      it('still writes a config that carries no resolved value', async () => {
        await fse.chmod(infoDir(), 0o555);
        await writeMcpYaml('servers:\n  - name: open\n    transport: http\n    url: https://example.com/open\n');

        await reconcileMcpForConfig(teamConfig, claudeOnly());

        expect(await fse.readFile(mcpJson(), 'utf-8')).toContain('https://example.com/open');
      });
    });

    it('leaves .git/info/exclude alone on a dry run', async () => {
      await writeMcpYaml(withSecret);

      await reconcileMcpForConfig(teamConfig, projectConfig, { dryRun: true });

      expect(await excludeOf(projectRoot)).not.toContain('teamai');
      const { resolvedMcpFilesPath } = await import('../mcp-resolved-files.js');
      expect(await fse.pathExists(resolvedMcpFilesPath(projectConfig) ?? '')).toBe(false);
    });

    // The appliers replace the file itself but follow its directories (#886).
    describe('a config under a symlinked directory is judged where the write lands', () => {
      const cursorOnly = (): LocalConfig => ({ ...projectConfig, disabledAgents: ['claude'] } as LocalConfig);
      const landed = async (): Promise<string> => path.join(await fse.realpath(projectRoot), 'config', 'mcp.json');

      beforeEach(async () => {
        vi.mocked(log.warn).mockClear();
        await fse.remove(path.join(projectRoot, '.cursor'));
        await fse.outputFile(path.join(projectRoot, 'config', 'skills', 'README.md'), 'cursor skills\n');
        await fse.symlink('config', path.join(projectRoot, '.cursor'), 'dir');
      });

      it('withholds the servers from a file git tracks there, naming both paths', async () => {
        await fse.writeJson(path.join(projectRoot, 'config', 'mcp.json'), { mcpServers: {} });
        git(projectRoot, 'add', 'config', '.cursor');
        git(projectRoot, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'cursor config');
        await writeMcpYaml(withSecret);

        await reconcileMcpForConfig(teamConfig, cursorOnly());

        expect(await fse.readFile(path.join(projectRoot, 'config', 'mcp.json'), 'utf-8')).not.toContain('super-secret-value');
        const warning = vi.mocked(log.warn).mock.calls.map(([m]) => String(m)).find((m) => m.includes('git already tracks'));
        expect(warning).toContain(path.join(projectRoot, '.cursor', 'mcp.json'));
        expect(warning).toContain(`git rm --cached ${await landed()}\``);
      });

      it('lists the file it lands in, and releases that line once it holds no resolved value', async () => {
        git(projectRoot, 'add', 'config', '.cursor');
        git(projectRoot, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'cursor config');
        await writeMcpYaml(withSecret);

        await reconcileMcpForConfig(teamConfig, cursorOnly());

        expect(await fse.readFile(await landed(), 'utf-8')).toContain('super-secret-value');
        expect(await excludeOf(projectRoot)).toMatch(/^\/config\/mcp\.json$/m);
        expect(await excludeOf(projectRoot)).not.toContain('/.cursor/');
        expect(git(projectRoot, 'status', '--porcelain', '--untracked-files=all')).not.toContain('config/mcp.json');

        await writeMcpYaml('servers:\n  - name: open\n    transport: http\n    url: https://example.com/open\n');
        await reconcileMcpForConfig(teamConfig, cursorOnly());

        expect(await fse.readFile(await landed(), 'utf-8')).not.toContain('super-secret-value');
        expect(await excludeOf(projectRoot)).not.toContain('/config/mcp.json');
      });

      it('writes, listing nothing and warning of nothing, when the directory links outside any repository', async () => {
        const outside = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-no-repo-'));
        await fse.copy(path.join(projectRoot, 'config'), outside);
        await fse.remove(path.join(projectRoot, '.cursor'));
        await fse.symlink(outside, path.join(projectRoot, '.cursor'), 'dir');
        await writeMcpYaml(withSecret);

        try {
          await reconcileMcpForConfig(teamConfig, cursorOnly());

          expect(await fse.readFile(path.join(outside, 'mcp.json'), 'utf-8')).toContain('super-secret-value');
          expect(log.warn).not.toHaveBeenCalled();
          expect(await excludeOf(projectRoot)).not.toContain('/.cursor/');
        } finally {
          await fse.remove(outside);
        }
      });
    });

    it('records each config it writes a resolved value to, by path, before writing it', async () => {
      const { readResolvedMcpFiles, resolvedMcpFilesPath } = await import('../mcp-resolved-files.js');
      const sidecarAtWrite = new Map<string, boolean>();
      beforeJsonWrite.run = async (file) => {
        sidecarAtWrite.set(file, file in (await readResolvedMcpFiles(projectConfig)).files);
      };
      await writeMcpYaml(withSecret);

      try {
        await reconcileMcpForConfig(unmovedConfig(), projectConfig);
      } finally {
        beforeJsonWrite.run = null;
      }

      expect(sidecarAtWrite.get(path.join(projectRoot, '.mcp.json'))).toBe(true);
      expect((await readResolvedMcpFiles(projectConfig)).files).toEqual({
        [path.join(projectRoot, '.mcp.json')]: { tools: ['claude'] },
        [path.join(projectRoot, '.cursor', 'mcp.json')]: { tools: ['cursor'] },
      });
      expect((await fse.stat(resolvedMcpFilesPath(projectConfig) ?? '')).mode & 0o777).toBe(0o600);
    });

    // An empty record says teamai owns nothing left in the file, which a pull that could not read it cannot say.
    it('keeps a tool\'s record as it was when this pull could not read its config, so a stale entry keeps its line once repaired', async () => {
      const cursorJson = path.join(projectRoot, '.cursor', 'mcp.json');
      await writeMcpYaml(withSecret);
      await reconcileMcpForConfig(teamConfig, projectConfig);
      const repaired = await fse.readFile(cursorJson, 'utf-8');
      await writeMcpYaml('servers:\n  - name: open\n    transport: http\n    url: https://example.com/open\n');
      await fse.writeFile(cursorJson, '{ "mcpServers": ');
      vi.stubEnv('SECRET_TOKEN', '');
      await reconcileMcpForConfig(teamConfig, projectConfig);

      await fse.writeFile(cursorJson, repaired);
      await reconcileMcpForConfig(teamConfig, { ...projectConfig, disabledAgents: ['cursor'] } as LocalConfig);

      expect(await fse.readFile(cursorJson, 'utf-8')).toContain('super-secret-value');
      expect(await excludeOf(projectRoot)).toMatch(/^\/\.cursor\/mcp\.json$/m);
      expect(git(projectRoot, 'status', '--porcelain', '--untracked-files=all')).not.toMatch(/\.cursor\/mcp\.json/);
    });

    it('takes back a tool it recorded before a write it then skipped, in a file another tool wrote this pull', async () => {
      const { readResolvedMcpFiles } = await import('../mcp-resolved-files.js');
      const mcpJson = path.join(projectRoot, '.mcp.json');
      await fse.ensureDir(path.join(projectRoot, '.codebuddy', 'skills'));
      await writeMcpYaml(withSecret);

      // Claude writes with-secret first; CodeBuddy finds it there, not its own, and skips it.
      const result = await reconcileMcpForConfig(unmovedConfig(), projectConfig);

      expect(result.changes).toContainEqual(expect.objectContaining({ tool: 'codebuddy', server: 'with-secret', action: 'skipped' }));
      expect((await readResolvedMcpFiles(projectConfig)).files[mcpJson]).toEqual({ tools: ['claude'] });
    });

    it('keeps a tool it records again whose entry with a resolved value is already in the file, with no write', async () => {
      const { readResolvedMcpFiles, resolvedMcpFilesPath } = await import('../mcp-resolved-files.js');
      const mcpJson = path.join(projectRoot, '.mcp.json');
      await fse.ensureDir(path.join(projectRoot, '.codebuddy', 'skills'));
      await writeMcpYaml(`${withSecret}    tools: [codebuddy]\n${withSecret.replace('servers:\n', '').replace('with-secret', 'other-secret')}    tools: [claude]\n`);
      await reconcileMcpForConfig(unmovedConfig(), projectConfig);
      expect((await readResolvedMcpFiles(projectConfig)).files[mcpJson]?.tools.sort()).toEqual(['claude', 'codebuddy']);
      await fse.writeJson(resolvedMcpFilesPath(projectConfig) ?? '', { version: 1, files: { [mcpJson]: { tools: ['claude'] } } });

      const result = await reconcileMcpForConfig(unmovedConfig(), projectConfig);

      expect(result.wrote).toBe(false);
      expect((await readResolvedMcpFiles(projectConfig)).files[mcpJson]?.tools.sort()).toEqual(['claude', 'codebuddy']);
    });

    it('takes back a tool it recorded before a write that did not happen, in a file another tool recorded', async () => {
      const { readResolvedMcpFiles } = await import('../mcp-resolved-files.js');
      const mcpJson = path.join(projectRoot, '.mcp.json');
      await writeMcpYaml(`${withSecret}    tools: [claude]\n`);
      await reconcileMcpForConfig(unmovedConfig(), projectConfig);
      expect((await readResolvedMcpFiles(projectConfig)).files[mcpJson]).toEqual({ tools: ['claude'] });
      await fse.ensureDir(path.join(projectRoot, '.codebuddy', 'skills'));
      await writeMcpYaml(withSecret);
      await fse.writeFile(mcpJson, '{ "mcpServers": ');

      await reconcileMcpForConfig(unmovedConfig(), projectConfig);

      expect((await readResolvedMcpFiles(projectConfig)).files[mcpJson]).toEqual({ tools: ['claude'] });
    });

    describe('forgets a config it recorded before a write that did not happen', () => {
      const custom = { ...TOOL_PATHS, cursor: { ...TOOL_PATHS.cursor, mcpProject: '.cursor/team-mcp.json' } };
      const customFile = (): string => path.join(projectRoot, '.cursor', 'team-mcp.json');
      const mine = { mcpServers: { mine: { type: 'http', url: 'https://mine.example/mcp' } } };

      afterEach(async () => {
        await fse.chmod(path.join(projectRoot, '.cursor'), 0o755);
      });

      // Root writes into a read-only directory.
      it.skipIf(process.getuid?.() === 0).each([
        ['its write fails', async () => {
          await fse.writeJson(customFile(), mine);
          await fse.chmod(path.join(projectRoot, '.cursor'), 0o555);
          await expect(reconcileMcpForConfig({ ...teamConfig, toolPaths: custom } as TeamaiConfig, projectConfig)).rejects.toThrow();
          await fse.chmod(path.join(projectRoot, '.cursor'), 0o755);
        }],
        ['it does not parse', async () => {
          await fse.writeFile(customFile(), '{ "mcpServers": ');
          await reconcileMcpForConfig({ ...teamConfig, toolPaths: custom } as TeamaiConfig, projectConfig);
          await fse.writeJson(customFile(), mine);
        }],
      ])('so a config of the member\'s own there is not kept listed once the mapping changes, when %s', async (_label, arrange) => {
        await pulledBefore();
        await writeMcpYaml(withSecret);
        await arrange();
        expect(await fse.readJson(customFile())).toEqual(mine);

        await reconcileMcpForConfig(teamConfig, projectConfig);

        expect(await excludeOf(projectRoot)).not.toMatch(/team-mcp\.json/);
        const { readResolvedMcpFiles } = await import('../mcp-resolved-files.js');
        expect(Object.keys((await readResolvedMcpFiles(projectConfig)).files)).not.toContain(customFile());
      });
    });

    describe('without a usable managed-mcp-files.json, as before it existed', () => {
      const mcpJson = (): string => path.join(projectRoot, '.mcp.json');
      const claudeOnly = (): LocalConfig => ({ ...projectConfig, disabledAgents: ['cursor'] } as LocalConfig);
      const open = 'servers:\n  - name: open\n    transport: http\n    url: https://example.com/open\n';
      const sidecarFile = async (): Promise<string> => {
        const { resolvedMcpFilesPath } = await import('../mcp-resolved-files.js');
        return resolvedMcpFilesPath(projectConfig) ?? '';
      };
      const loseManifest = async (): Promise<void> => {
        const { getDataHome, managedMcpManifestPath } = await import('../types.js');
        await fse.remove(managedMcpManifestPath(getDataHome(projectConfig), projectRoot));
      };

      it('keeps the line of a config under a changed mapping it can no longer find, even holding no server', async () => {
        const custom = { ...TOOL_PATHS, cursor: { ...TOOL_PATHS.cursor, mcpProject: '.cursor/team-mcp.json' } };
        await writeMcpYaml(withSecret);
        await reconcileMcpForConfig({ ...teamConfig, toolPaths: custom } as TeamaiConfig, projectConfig);
        await fse.remove(await sidecarFile());
        await fse.writeJson(path.join(projectRoot, '.cursor', 'team-mcp.json'), { mcpServers: {} });

        await reconcileMcpForConfig(teamConfig, projectConfig);

        // No tool reads it any more, and nothing says teamai wrote it: the line stays, as before.
        expect(await excludeOf(projectRoot)).toMatch(/^\/\.cursor\/team-mcp\.json$/m);
      });

      it('rewrites one that does not parse', async () => {
        await fse.outputFile(await sidecarFile(), '{ "version": 1, "files": ');
        await writeMcpYaml(withSecret);

        await reconcileMcpForConfig(teamConfig, claudeOnly());

        const { readResolvedMcpFiles } = await import('../mcp-resolved-files.js');
        expect(Object.keys((await readResolvedMcpFiles(projectConfig)).files)).toEqual([mcpJson()]);
      });

      it('still writes the config while another command holds its lock, and records it on the next pull', async () => {
        const { readResolvedMcpFiles } = await import('../mcp-resolved-files.js');
        const lock = `${await sidecarFile()}.teamai-lock`;
        await fse.ensureDir(path.dirname(lock));
        expect(await acquireLock(lock)).toBe(true);
        await writeMcpYaml(withSecret);
        try {
          await reconcileMcpForConfig(teamConfig, claudeOnly());
        } finally {
          await releaseLock(lock);
        }
        expect(await fse.readFile(mcpJson(), 'utf-8')).toContain('super-secret-value');
        expect(await excludeOf(projectRoot)).toMatch(/^\/\.mcp\.json$/m);
        expect((await readResolvedMcpFiles(projectConfig)).files).toEqual({});

        await reconcileMcpForConfig(teamConfig, claudeOnly());

        expect(Object.keys((await readResolvedMcpFiles(projectConfig)).files)).toEqual([mcpJson()]);
      }, 30_000);

      // Cursor's file: CodeBuddy's built-in location is Claude's .mcp.json, which TOOL_PATHS moves CodeBuddy off.
      describe('while this worktree has no managed-mcp.json at all either', () => {
        const cursorJson = (): string => path.join(projectRoot, '.cursor', 'mcp.json');
        const lost = async (): Promise<void> => {
          await loseManifest();
          await fse.remove(await sidecarFile());
          await fse.writeFile(path.join(projectRoot, '.git', 'info', 'exclude'), '');
        };

        beforeEach(async () => {
          await writeMcpYaml(withSecret);
          await reconcileMcpForConfig(teamConfig, projectConfig);
          await lost();
          vi.stubEnv('SECRET_TOKEN', '');
        });

        it.each([
          ['still delivers to it', open],
          ['delivers nothing to it', `${open}    tools: [claude]\n`],
        ])('lists a config holding a stale entry, and keeps it on the pulls after, when the team %s', async (_label, yaml) => {
          await writeMcpYaml(yaml);

          await reconcileMcpForConfig(teamConfig, projectConfig);
          expect(await excludeOf(projectRoot)).toMatch(/^\/\.cursor\/mcp\.json$/m);
          await reconcileMcpForConfig(teamConfig, projectConfig);
          await reconcileMcpForConfig(teamConfig, projectConfig);

          expect(await fse.readFile(cursorJson(), 'utf-8')).toContain('super-secret-value');
          expect(await excludeOf(projectRoot)).toMatch(/^\/\.cursor\/mcp\.json$/m);
          expect(git(projectRoot, 'status', '--porcelain', '--untracked-files=all')).not.toMatch(/\.cursor\/mcp\.json/);
        });

        it('keeps the line of a config holding a stale entry on the pulls after one that could not note it, and notes it once it can', async () => {
          const { readResolvedMcpFiles } = await import('../mcp-resolved-files.js');
          await writeMcpYaml(open);
          const lock = `${await sidecarFile()}.teamai-lock`;
          await fse.ensureDir(path.dirname(lock));
          expect(await acquireLock(lock)).toBe(true);
          try {
            await reconcileMcpForConfig(teamConfig, projectConfig);
          } finally {
            await releaseLock(lock);
          }
          expect(await excludeOf(projectRoot)).toMatch(/^\/\.cursor\/mcp\.json$/m);

          await reconcileMcpForConfig(teamConfig, projectConfig);
          await reconcileMcpForConfig(teamConfig, projectConfig);

          expect(await fse.readFile(cursorJson(), 'utf-8')).toContain('super-secret-value');
          expect(await excludeOf(projectRoot)).toMatch(/^\/\.cursor\/mcp\.json$/m);
          expect((await readResolvedMcpFiles(projectConfig)).files[cursorJson()]?.unverified).toEqual(['with-secret']);
          const doc = await fse.readJson(cursorJson()) as { mcpServers: Record<string, unknown> };
          delete doc.mcpServers['with-secret'];
          await fse.writeJson(cursorJson(), doc);
          await reconcileMcpForConfig(teamConfig, projectConfig);
          expect(await excludeOf(projectRoot)).not.toMatch(/\.cursor\/mcp\.json/);
        }, 30_000);

        it('keeps that line through a pull that rewrites the record while the note still cannot land', async () => {
          const { readResolvedMcpFiles } = await import('../mcp-resolved-files.js');
          await writeMcpYaml(open);
          const lock = `${await sidecarFile()}.teamai-lock`;
          await fse.ensureDir(path.dirname(lock));
          expect(await acquireLock(lock)).toBe(true);
          try {
            await reconcileMcpForConfig(teamConfig, projectConfig);
            await writeMcpYaml(`${open}  - name: more\n    transport: http\n    url: https://example.com/more\n`);
            await reconcileMcpForConfig(teamConfig, projectConfig);
          } finally {
            await releaseLock(lock);
          }

          await reconcileMcpForConfig(teamConfig, projectConfig);
          await reconcileMcpForConfig(teamConfig, projectConfig);

          expect(await fse.readFile(cursorJson(), 'utf-8')).toContain('super-secret-value');
          expect(await excludeOf(projectRoot)).toMatch(/^\/\.cursor\/mcp\.json$/m);
          expect((await readResolvedMcpFiles(projectConfig)).files[cursorJson()]?.unverified).toEqual(['with-secret']);
        }, 30_000);

        it('keeps that line through a pull that empties the record while the note still cannot land', async () => {
          await writeMcpYaml(open);
          const lock = `${await sidecarFile()}.teamai-lock`;
          await fse.ensureDir(path.dirname(lock));
          expect(await acquireLock(lock)).toBe(true);
          try {
            await reconcileMcpForConfig(teamConfig, projectConfig);
            await writeMcpYaml(`${open}    tools: [claude]\n`);
            await reconcileMcpForConfig(teamConfig, projectConfig);
          } finally {
            await releaseLock(lock);
          }

          await reconcileMcpForConfig(teamConfig, projectConfig);
          await reconcileMcpForConfig(teamConfig, projectConfig);

          expect(await fse.readFile(cursorJson(), 'utf-8')).toContain('super-secret-value');
          expect(await excludeOf(projectRoot)).toMatch(/^\/\.cursor\/mcp\.json$/m);
        }, 30_000);

        // The cost: a first pull in a new worktree cannot tell a member's own server from a stale one of teamai's.
        it('lists a config holding only a server of the member\'s own at the first pull in a worktree, until it leaves', async () => {
          await fse.writeJson(cursorJson(), { mcpServers: { mine: { type: 'http', url: 'https://mine.example/mcp' } } });
          await writeMcpYaml(open);

          await reconcileMcpForConfig(teamConfig, projectConfig);
          await reconcileMcpForConfig(teamConfig, projectConfig);
          expect(await excludeOf(projectRoot)).toMatch(/^\/\.cursor\/mcp\.json$/m);
          const doc = await fse.readJson(cursorJson()) as { mcpServers: Record<string, unknown> };
          delete doc.mcpServers.mine;
          await fse.writeJson(cursorJson(), doc);
          await reconcileMcpForConfig(teamConfig, projectConfig);

          expect(await excludeOf(projectRoot)).not.toMatch(/\.cursor\/mcp\.json/);
        });

        it('lets the line go once the member takes the stale entry out', async () => {
          await writeMcpYaml(open);
          await reconcileMcpForConfig(teamConfig, projectConfig);
          const doc = await fse.readJson(cursorJson()) as { mcpServers: Record<string, unknown> };
          delete doc.mcpServers['with-secret'];
          await fse.writeJson(cursorJson(), doc);

          await reconcileMcpForConfig(teamConfig, projectConfig);

          expect(await excludeOf(projectRoot)).not.toMatch(/\.cursor\/mcp\.json/);
        });

        it('leaves one git tracks as it is, and says nothing', async () => {
          git(projectRoot, 'add', '.cursor/mcp.json');
          vi.mocked(log.warn).mockClear();
          await writeMcpYaml(open);

          await reconcileMcpForConfig(teamConfig, projectConfig);

          expect(await excludeOf(projectRoot)).not.toMatch(/\.cursor\/mcp\.json/);
          expect(vi.mocked(log.warn).mock.calls.flat().join('\n')).not.toContain(cursorJson());
        });
      });

      // Cursor's file, as above; Claude's record keeps managed-mcp.json from being empty.
      describe('while one tool has no record in managed-mcp.json', () => {
        const cursorJson = (): string => path.join(projectRoot, '.cursor', 'mcp.json');
        const manifestFile = async (): Promise<string> => {
          const { getDataHome, managedMcpManifestPath } = await import('../types.js');
          return managedMcpManifestPath(getDataHome(projectConfig), projectRoot);
        };

        it('lists a config holding a stale entry, and keeps it on the pulls after the one that rebuilds that tool\'s record', async () => {
          const { readResolvedMcpFiles } = await import('../mcp-resolved-files.js');
          await writeMcpYaml(withSecret);
          await reconcileMcpForConfig(teamConfig, projectConfig);
          const manifest = await fse.readJson(await manifestFile()) as Record<string, unknown>;
          delete manifest['cursor:project'];
          await fse.writeJson(await manifestFile(), manifest);
          const sidecar = await fse.readJson(await sidecarFile()) as { files: Record<string, unknown> };
          delete sidecar.files[cursorJson()];
          await fse.writeJson(await sidecarFile(), sidecar);
          await writeMcpYaml(open);
          vi.stubEnv('SECRET_TOKEN', '');

          await reconcileMcpForConfig(teamConfig, projectConfig);
          await reconcileMcpForConfig(teamConfig, projectConfig);
          await reconcileMcpForConfig(teamConfig, projectConfig);

          expect(await fse.readFile(cursorJson(), 'utf-8')).toContain('super-secret-value');
          expect(await excludeOf(projectRoot)).toMatch(/^\/\.cursor\/mcp\.json$/m);
          expect((await readResolvedMcpFiles(projectConfig)).files[cursorJson()]?.unverified).toEqual(['with-secret']);
        });

        // The cost, as with no managed-mcp.json at all: a tool's first delivery cannot tell a member's own server from a stale one.
        it('lists a config holding only a server of the member\'s own at that tool\'s first delivery, until it leaves', async () => {
          await fse.outputJson(await manifestFile(), { 'claude:project': [] });
          await fse.writeJson(cursorJson(), { mcpServers: { mine: { type: 'http', url: 'https://mine.example/mcp' } } });
          await writeMcpYaml(open);

          await reconcileMcpForConfig(teamConfig, projectConfig);
          await reconcileMcpForConfig(teamConfig, projectConfig);
          expect(await excludeOf(projectRoot)).toMatch(/^\/\.cursor\/mcp\.json$/m);
          const doc = await fse.readJson(cursorJson()) as { mcpServers: Record<string, unknown> };
          delete doc.mcpServers.mine;
          await fse.writeJson(cursorJson(), doc);
          await reconcileMcpForConfig(teamConfig, projectConfig);

          expect(await excludeOf(projectRoot)).not.toMatch(/\.cursor\/mcp\.json/);
        });
      });

      // Cursor's file: CodeBuddy's built-in location is Claude's .mcp.json, which TOOL_PATHS moves CodeBuddy off.
      describe('releases the line of a stale entry whose value is no longer set', () => {
        const cursorJson = (): string => path.join(projectRoot, '.cursor', 'mcp.json');
        const cursorOnly = (): LocalConfig => ({ ...projectConfig, disabledAgents: ['claude', 'tclaude'] } as LocalConfig);

        it.each([
          ['it is deleted after a pull rebuilt the lost record', async () => {
            await writeMcpYaml(withSecret);
            await reconcileMcpForConfig(teamConfig, cursorOnly());
            await loseManifest();
            await writeMcpYaml(open);
            vi.stubEnv('SECRET_TOKEN', '');
            await reconcileMcpForConfig(teamConfig, cursorOnly());
            await fse.remove(await sidecarFile());
          }],
          ['an older teamai, which kept none, wrote the config and rebuilt the lost record', async () => {
            await writeMcpYaml(`${withSecret}${open.replace('servers:\n', '')}`);
            await reconcileMcpForConfig(teamConfig, cursorOnly());
            await fse.remove(await sidecarFile());
            // Its rebuild records what it wrote, open, and notes nothing else.
            const { getDataHome, managedMcpManifestPath } = await import('../types.js');
            const manifestFile = managedMcpManifestPath(getDataHome(projectConfig), projectRoot);
            const manifest = await fse.readJson(manifestFile) as Record<string, Array<{ name: string }>>;
            await fse.writeJson(manifestFile, { 'cursor:project': manifest['cursor:project'].filter((record) => record.name === 'open') });
            await writeMcpYaml(open);
            vi.stubEnv('SECRET_TOKEN', '');
          }],
        ])('when %s', async (_label, arrange) => {
          await arrange();

          await reconcileMcpForConfig(teamConfig, cursorOnly());

          // The documented limit: without the note, the stale entry looks like the member's own.
          expect(await fse.readFile(cursorJson(), 'utf-8')).toContain('super-secret-value');
          expect(await excludeOf(projectRoot)).not.toContain('teamai');
        });
      });
    });

    it('records a config an older teamai wrote a resolved value to on the first pull that finds it', async () => {
      const { readResolvedMcpFiles, resolvedMcpFilesPath } = await import('../mcp-resolved-files.js');
      await writeMcpYaml(withSecret);
      await reconcileMcpForConfig(teamConfig, projectConfig);
      await fse.remove(resolvedMcpFilesPath(projectConfig) ?? '');

      await reconcileMcpForConfig(teamConfig, { ...projectConfig, disabledAgents: ['cursor'] } as LocalConfig);

      expect((await readResolvedMcpFiles(projectConfig)).files[path.join(projectRoot, '.cursor', 'mcp.json')]).toEqual({ tools: ['cursor'] });
    });
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

  // #879: a resolved ${VAR} may be a team secret, so the file holding it is the member's alone.
  describe.skipIf(process.platform === 'win32')('file modes', () => {
    let previousUmask: number;
    const mode = async (file: string): Promise<number> => (await fse.stat(file)).mode & 0o777;
    const SECRET_SERVER = `
servers:
  - name: with-secret
    transport: http
    url: https://example.com/mcp
    headers:
      Authorization: Bearer \${SECRET_TOKEN}
`;
    beforeEach(() => {
      previousUmask = process.umask(0o022);
      vi.stubEnv('SECRET_TOKEN', 'super-secret-value');
    });
    afterEach(() => {
      process.umask(previousUmask);
      vi.restoreAllMocks();
    });

    it('writes an existing 0644 .mcp.json and ~/.claude.json 0600 once they hold a resolved value', async () => {
      const projectRoot = path.join(tmpDir, 'proj-mode');
      await fse.ensureDir(path.join(projectRoot, '.claude', 'skills'));
      const projectFile = path.join(projectRoot, '.mcp.json');
      const userFile = path.join(homeDir, '.claude.json');
      for (const file of [projectFile, userFile]) {
        await fse.writeFile(file, '{}\n');
        await fse.chmod(file, 0o644);
      }
      await writeMcpYaml(SECRET_SERVER);

      await reconcileMcpForConfig(teamConfig, { ...localConfig, scope: 'project', projectRoot } as unknown as LocalConfig);
      await reconcileMcpForConfig(teamConfig, localConfig);

      for (const file of [projectFile, userFile]) {
        expect((await fse.readJson(file)).mcpServers['with-secret'].headers.Authorization).toBe('Bearer super-secret-value');
        expect(await mode(file)).toBe(0o600);
      }
    });

    it('tightens a 0644 project config it protects without writing, as for a disabled tool', async () => {
      const projectRoot = path.join(tmpDir, 'proj-mode-disabled');
      for (const d of ['.claude', '.cursor']) await fse.ensureDir(path.join(projectRoot, d, 'skills'));
      execFileSync('git', ['init', '-q'], { cwd: projectRoot });
      const project = { ...localConfig, scope: 'project', projectRoot } as unknown as LocalConfig;
      await writeMcpYaml(SECRET_SERVER);
      await reconcileMcpForConfig(teamConfig, project);
      const cursorFile = path.join(projectRoot, '.cursor', 'mcp.json');
      expect(await fse.readFile(cursorFile, 'utf-8')).toContain('super-secret-value');
      await fse.chmod(cursorFile, 0o644);

      await reconcileMcpForConfig(teamConfig, { ...project, disabledAgents: ['cursor'] } as LocalConfig);

      expect(await fse.readFile(cursorFile, 'utf-8')).toContain('super-secret-value');
      expect(await mode(cursorFile)).toBe(0o600);
    });

    it('keeps the mode of an existing config whose servers hold no resolved value', async () => {
      const userFile = path.join(homeDir, '.claude.json');
      await fse.writeFile(userFile, '{}\n');
      await fse.chmod(userFile, 0o644);
      await writeMcpYaml('servers:\n  - name: open\n    transport: http\n    url: https://example.com/open\n');

      await reconcileMcpForConfig(teamConfig, localConfig);

      expect((await fse.readJson(userFile)).mcpServers.open).toBeDefined();
      expect(await mode(userFile)).toBe(0o644);
    });

    it('tightens a 0644 config whose managed entry holds a resolved value, though nothing changed', async () => {
      await fse.ensureDir(path.join(homeDir, '.codex', 'skills'));
      await writeMcpYaml(SECRET_SERVER);
      // Twice: the second pull pads the Codex block it appended last with a blank line.
      await reconcileMcpForConfig(teamConfig, localConfig);
      await reconcileMcpForConfig(teamConfig, localConfig);
      const files = [path.join(homeDir, '.claude.json'), path.join(homeDir, '.codex', 'config.toml')];
      const contents: string[] = [];
      for (const file of files) {
        await fse.chmod(file, 0o644);
        contents.push(await fse.readFile(file, 'utf-8'));
      }

      await reconcileMcpForConfig(teamConfig, localConfig, { dryRun: true });
      for (const file of files) expect(await mode(file)).toBe(0o644);

      const { wrote, changes } = await reconcileMcpForConfig(teamConfig, localConfig);

      expect(changes).toEqual([]);
      expect(wrote).toBe(false);
      for (const [i, file] of files.entries()) {
        expect(await fse.readFile(file, 'utf-8')).toBe(contents[i]);
        expect(await mode(file)).toBe(0o600);
      }
    });

    it('tightens a 0644 config whose kept entry holds an earlier resolved value', async () => {
      await fse.outputFile(path.join(repoPath, 'env', 'secrets.yaml'), 'secrets:\n  - key: SECRET_TOKEN\n');
      await writeMcpYaml(SECRET_SERVER);
      await reconcileMcpForConfig(teamConfig, localConfig);
      const userFile = path.join(homeDir, '.claude.json');
      await fse.chmod(userFile, 0o644);
      vi.stubEnv('SECRET_TOKEN', undefined);

      await reconcileMcpForConfig(teamConfig, localConfig);

      expect((await fse.readJson(userFile)).mcpServers['with-secret']).toBeDefined();
      expect(await mode(userFile)).toBe(0o600);
    });

    it('keeps the mode of an unchanged config whose servers hold no resolved value', async () => {
      await writeMcpYaml('servers:\n  - name: open\n    transport: http\n    url: https://example.com/open\n');
      await reconcileMcpForConfig(teamConfig, localConfig);
      const userFile = path.join(homeDir, '.claude.json');
      await fse.chmod(userFile, 0o644);

      await reconcileMcpForConfig(teamConfig, localConfig);

      expect(await mode(userFile)).toBe(0o644);
    });

    it('never lets the Codex config temp file be wider than 0600, and names it at random', async () => {
      await fse.ensureDir(path.join(homeDir, '.codex', 'skills'));
      await writeMcpYaml(`${SECRET_SERVER}    tools: [codex]\n`);
      const isCodexTemp = (file: string): boolean => path.basename(file).startsWith('config.toml.');
      const renamed: { file: string; mode: number }[] = [];
      const rename = fs.promises.rename.bind(fs.promises);
      vi.spyOn(fs.promises, 'rename').mockImplementation(async (from: fs.PathLike, to: fs.PathLike) => {
        if (typeof from === 'string' && isCodexTemp(from)) renamed.push({ file: from, mode: await mode(from) });
        return rename(from, to);
      });
      const created: number[] = [];
      const writeFile = fs.promises.writeFile.bind(fs.promises);
      vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (...args: Parameters<typeof fs.promises.writeFile>) => {
        await writeFile(...args);
        const [file] = args;
        if (typeof file === 'string' && isCodexTemp(file)) created.push(await mode(file));
      });
      const configToml = path.join(homeDir, '.codex', 'config.toml');

      await reconcileMcpForConfig(teamConfig, localConfig);
      await writeCodexAtomic(configToml, 'model = "gpt-5"\n');

      expect(created).toHaveLength(2);
      expect(created.every((m) => (m & 0o077) === 0)).toBe(true);
      expect(renamed.map((r) => path.basename(r.file))).toEqual([
        expect.stringMatching(/^config\.toml\.\d+\.[0-9a-f]{12}\.tmp$/),
        expect.stringMatching(/^config\.toml\.\d+\.[0-9a-f]{12}\.tmp$/),
      ]);
      expect(renamed.every((r) => r.mode === 0o600)).toBe(true);
      expect(await mode(configToml)).toBe(0o600);
    });
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

  // #875: the session-start pull inherits the agent's environment, which often
  // lacks the member's shell export, so a declared secret is there for one
  // pull and gone for the next. Removing the entry then would undo the pull
  // that found it.
  describe('a missing declared secret (#875)', () => {
    const GITHUB = `
  - name: github
    transport: http
    url: https://api.example.com/mcp
    headers:
      Authorization: Bearer \${GITHUB_TOKEN}
`;
    const DOCS = `
  - name: docs
    transport: http
    url: https://docs.example.com/mcp
`;
    const claudeJson = () => path.join(homeDir, '.claude.json');
    const codexToml = () => path.join(homeDir, '.codex', 'config.toml');
    const manifestNames = async (key: string): Promise<string[]> => {
      const manifest = await fse.readJson(path.join(homeDir, '.teamai', 'managed-mcp.json'));
      return (manifest[key] ?? []).map((r: { name: string }) => r.name).sort();
    };

    beforeEach(async () => {
      await fse.ensureDir(path.join(homeDir, '.codex', 'skills'));
      await fse.outputFile(path.join(repoPath, 'env', 'secrets.yaml'), 'secrets:\n  - key: GITHUB_TOKEN\n');
    });

    it('keeps the entry an earlier pull wrote, in a JSON config and in Codex', async () => {
      await writeMcpYaml(`servers:${GITHUB}`);
      vi.stubEnv('GITHUB_TOKEN', 'first-token');
      await reconcileMcpForConfig(teamConfig, localConfig);
      const jsonBefore = (await fse.readJson(claudeJson())).mcpServers.github;
      const tomlBefore = await fse.readFile(codexToml(), 'utf-8');
      expect(tomlBefore).toContain('Bearer first-token');

      vi.stubEnv('GITHUB_TOKEN', undefined);
      const { changes } = await reconcileMcpForConfig(teamConfig, localConfig);

      expect(changes.filter((c) => c.action !== 'skipped')).toEqual([]);
      expect((await fse.readJson(claudeJson())).mcpServers.github).toEqual(jsonBefore);
      expect(await fse.readFile(codexToml(), 'utf-8')).toBe(tomlBefore);
    });

    it('keeps its ownership record when another server is written in the same pull', async () => {
      await writeMcpYaml(`servers:${GITHUB}`);
      vi.stubEnv('GITHUB_TOKEN', 'first-token');
      await reconcileMcpForConfig(teamConfig, localConfig);

      vi.stubEnv('GITHUB_TOKEN', undefined);
      await writeMcpYaml(`servers:${GITHUB}${DOCS}`);
      const { wrote } = await reconcileMcpForConfig(teamConfig, localConfig);
      expect(wrote).toBe(true);
      expect(await manifestNames('claude')).toEqual(['docs', 'github']);
      expect(await manifestNames('codex')).toEqual(['docs', 'github']);

      // Still teamai's: a later pull that finds a new value updates it rather
      // than treating it as a server the member added.
      vi.stubEnv('GITHUB_TOKEN', 'second-token');
      const { changes } = await reconcileMcpForConfig(teamConfig, localConfig);
      expect(changes.filter((c) => c.server === 'github').map((c) => `${c.tool}:${c.action}`).sort())
        .toEqual(['claude:updated', 'codex:updated', 'cursor:updated']);
      expect((await fse.readJson(claudeJson())).mcpServers.github.headers.Authorization).toBe('Bearer second-token');
      expect(await fse.readFile(codexToml(), 'utf-8')).toContain('Bearer second-token');
    });

    it('skips a server no pull has written yet', async () => {
      vi.stubEnv('GITHUB_TOKEN', undefined);
      await writeMcpYaml(`servers:${GITHUB}${DOCS}`);

      const { changes } = await reconcileMcpForConfig(teamConfig, localConfig);

      expect(changes.filter((c) => c.server === 'github').map((c) => `${c.tool}:${c.action}`).sort())
        .toEqual(['claude:skipped', 'codex:skipped', 'cursor:skipped']);
      expect((await fse.readJson(claudeJson())).mcpServers.github).toBeUndefined();
      expect(await fse.readFile(codexToml(), 'utf-8')).not.toContain('[mcp_servers.github]');
      expect(await manifestNames('claude')).toEqual(['docs']);
    });

    it('removes a kept server once it leaves mcp.yaml', async () => {
      await writeMcpYaml(`servers:${GITHUB}`);
      vi.stubEnv('GITHUB_TOKEN', 'first-token');
      await reconcileMcpForConfig(teamConfig, localConfig);
      vi.stubEnv('GITHUB_TOKEN', undefined);
      await reconcileMcpForConfig(teamConfig, localConfig);

      await writeMcpYaml('servers: []\n');
      await reconcileMcpForConfig(teamConfig, localConfig);

      expect((await fse.readJson(claudeJson())).mcpServers.github).toBeUndefined();
      expect(await fse.readFile(codexToml(), 'utf-8')).not.toContain('[mcp_servers.github]');
    });

    it('keeps every managed server as it is while the declarations cannot be read', async () => {
      await writeMcpYaml(`servers:${GITHUB}${DOCS}`);
      vi.stubEnv('GITHUB_TOKEN', 'first-token');
      await reconcileMcpForConfig(teamConfig, localConfig);
      const jsonBefore = await fse.readFile(claudeJson(), 'utf-8');
      const tomlBefore = await fse.readFile(codexToml(), 'utf-8');

      vi.stubEnv('GITHUB_TOKEN', undefined);
      await fse.outputFile(path.join(repoPath, 'env', 'secrets.yaml'), 'secrets: [unclosed\n');
      await writeMcpYaml(`servers:${GITHUB}`);
      const { changes, wrote, unresolved } = await reconcileMcpForConfig(teamConfig, localConfig);

      expect({ changes, wrote, unresolved }).toEqual({ changes: [], wrote: false, unresolved: true });
      expect(await fse.readFile(claudeJson(), 'utf-8')).toBe(jsonBefore);
      expect(await fse.readFile(codexToml(), 'utf-8')).toBe(tomlBefore);
      const { log } = await import('../utils/logger.js');
      expect(vi.mocked(log.warn).mock.calls.map(([m]) => String(m)).join('\n')).toContain('env/secrets.yaml');
    });

    it('still removes a server whose missing variable is not declared as a secret', async () => {
      await writeMcpYaml(`
servers:
  - name: plain
    transport: http
    url: https://plain.example.com/mcp
    headers:
      X-Key: \${PLAIN_KEY}
`);
      vi.stubEnv('PLAIN_KEY', 'k');
      await reconcileMcpForConfig(teamConfig, localConfig);
      expect((await fse.readJson(claudeJson())).mcpServers.plain).toBeDefined();

      vi.stubEnv('PLAIN_KEY', undefined);
      await reconcileMcpForConfig(teamConfig, localConfig);

      expect((await fse.readJson(claudeJson())).mcpServers.plain).toBeUndefined();
      expect(await fse.readFile(codexToml(), 'utf-8')).not.toContain('[mcp_servers.plain]');
    });

    it('still removes a server that also misses a variable not declared as a secret', async () => {
      await writeMcpYaml(`
servers:
  - name: both
    transport: http
    url: https://both.example.com/mcp
    headers:
      Authorization: Bearer \${GITHUB_TOKEN}
      X-Key: \${PLAIN_KEY}
    tools: [claude]
`);
      vi.stubEnv('GITHUB_TOKEN', 't');
      vi.stubEnv('PLAIN_KEY', 'k');
      await reconcileMcpForConfig(teamConfig, localConfig);

      vi.stubEnv('GITHUB_TOKEN', undefined);
      vi.stubEnv('PLAIN_KEY', undefined);
      await reconcileMcpForConfig(teamConfig, localConfig);

      expect((await fse.readJson(claudeJson())).mcpServers.both).toBeUndefined();
    });

    it('removeAll removes a kept server, while the declarations cannot be read too', async () => {
      await writeMcpYaml(`servers:${GITHUB}`);
      vi.stubEnv('GITHUB_TOKEN', 'first-token');
      await reconcileMcpForConfig(teamConfig, localConfig);
      vi.stubEnv('GITHUB_TOKEN', undefined);
      await reconcileMcpForConfig(teamConfig, localConfig);
      await fse.outputFile(path.join(repoPath, 'env', 'secrets.yaml'), 'secrets: [unclosed\n');

      const { changes } = await reconcileMcpForConfig(teamConfig, localConfig, { removeAll: true });

      expect(changes.map((c) => `${c.tool}:${c.action}`).sort()).toEqual(['claude:removed', 'codex:removed', 'cursor:removed']);
      expect((await fse.readJson(claudeJson())).mcpServers.github).toBeUndefined();
      expect(await fse.readFile(codexToml(), 'utf-8')).not.toContain('[mcp_servers.github]');
    });
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

  it.each(['http', 'sse'])('renders a remote (%s) server with url + headers', async (transport) => {
    await writeMcpYaml(`
servers:
  - name: remote-srv
    transport: ${transport}
    url: https://example.com/mcp
    headers:
      Authorization: Bearer tok
`);
    const result = await reconcileMcpForConfig(teamConfig, localConfig);
    expect(result.changes).toContainEqual({ tool: 'opencode', server: 'remote-srv', action: 'added' });

    const doc = await fse.readJson(ocConfig());
    expect(doc.mcp['remote-srv']).toEqual({
      type: 'remote',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer tok' },
      enabled: true,
    });
    expect((await reconcileMcpForConfig(teamConfig, localConfig)).wrote).toBe(false);
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
