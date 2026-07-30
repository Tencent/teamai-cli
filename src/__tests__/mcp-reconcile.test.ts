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
import type { TeamaiConfig, LocalConfig } from '../types.js';

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
