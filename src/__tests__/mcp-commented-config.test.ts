import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';

vi.mock('@teamai/shared/log', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn(), persist: vi.fn() },
  spinner: vi.fn(() => ({ start: vi.fn().mockReturnThis(), succeed: vi.fn().mockReturnThis(), fail: vi.fn().mockReturnThis() })),
}));

import { reconcileMcpForConfig } from '../mcp-reconcile.js';
import { DEFAULT_TOOL_PATHS, type LocalConfig, type TeamaiConfig, TeamaiConfigSchema } from '../types.js';
import { log } from '../utils/logger.js';
import { parseJsonAs, type JsonSyntax } from '../utils/json.js';

/**
 * A tool that reads its MCP file with comments takes the team's servers when
 * the member comments the file, and the comments stay.
 */
describe('MCP reconcile with a commented config file', () => {
  let tmpDir: string;
  let homeDir: string;
  let repoPath: string;

  const configFor = (tool: string): { teamConfig: TeamaiConfig; localConfig: LocalConfig } => ({
    teamConfig: TeamaiConfigSchema.parse({ team: 't', repo: 'r', toolPaths: { [tool]: DEFAULT_TOOL_PATHS[tool as keyof typeof DEFAULT_TOOL_PATHS] } }),
    localConfig: { repo: { localPath: repoPath, remote: 'r' }, username: 'u', scope: 'user', additionalRoles: [] } as unknown as LocalConfig,
  });

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-mcp-commented-'));
    homeDir = path.join(tmpDir, 'home');
    repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(path.join(homeDir, '.teamai'));
    await fse.outputFile(path.join(repoPath, 'mcp', 'mcp.yaml'), 'servers:\n  - name: team-server\n    transport: http\n    url: https://example.com/mcp\n');
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('XDG_CONFIG_HOME', path.join(homeDir, '.config'));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.mocked(log.warn).mockClear();
    await fse.remove(tmpDir);
  });

  const cases: ReadonlyArray<{ tool: string; file: string; key: string; syntax: JsonSyntax; text: string }> = [
    { tool: 'cursor', file: '.cursor/mcp.json', key: 'mcpServers', syntax: 'jsonc', text: '{\n  // the member\'s note\n  "mcpServers": {\n    "mine": { "command": "x" },\n  },\n}\n' },
    { tool: 'opencode', file: '.config/opencode/opencode.json', key: 'mcp', syntax: 'jsonc', text: '{\n  // the member\'s note\n  "theme": "dark",\n}\n' },
    { tool: 'codebuddy', file: '.codebuddy/mcp.json', key: 'mcpServers', syntax: 'jsonc', text: '{\n  /* the member\'s note */\n  "mcpServers": {},\n}\n' },
    { tool: 'qoder', file: '.qoder/settings.json', key: 'mcpServers', syntax: 'json-comments', text: '{\n  // the member\'s note\n  "theme": "dark"\n}\n' },
  ];

  it.each(cases)('delivers the team server to $tool and keeps the comment', async ({ tool, file, key, syntax, text }) => {
    const target = path.join(homeDir, file);
    await fse.outputFile(target, text);
    const { teamConfig, localConfig } = configFor(tool);

    await reconcileMcpForConfig(teamConfig, localConfig);

    const written = await fse.readFile(target, 'utf8');
    expect(written).toContain('the member\'s note');
    const servers = parseJsonAs(written, syntax);
    expect(JSON.stringify(servers)).toContain('https://example.com/mcp');
    expect(Object.keys(Object(Object(servers)[key]))).toContain('team-server');
  });

  const codebuddyFormer = (): string => path.join(homeDir, '.codebuddy', 'mcp.json');
  const codebuddyLater = (): string => path.join(homeDir, '.codebuddy.json');
  const memberNote = '// member: remember why this server is configured';

  /** Installs the team server into `~/.codebuddy/mcp.json`, the file an earlier teamai created. */
  async function installCodebuddyTeamServer(): Promise<void> {
    await fse.outputFile(codebuddyFormer(), '{\n  "mcpServers": {}\n}\n');
    const { teamConfig, localConfig } = configFor('codebuddy');
    await reconcileMcpForConfig(teamConfig, localConfig);
  }

  it('keeps a commented CodeBuddy mcp.json that holds only the team server when a later lookup file exists', async () => {
    await installCodebuddyTeamServer();
    const installed = await fse.readFile(codebuddyFormer(), 'utf8');
    await fse.writeFile(codebuddyFormer(), `${memberNote}\n${installed}`);
    await fse.writeFile(codebuddyLater(), '{\n  "mcpServers": { "mine": { "command": "x" } }\n}\n');
    const { teamConfig, localConfig } = configFor('codebuddy');

    await reconcileMcpForConfig(teamConfig, localConfig);

    const kept = await fse.readFile(codebuddyFormer(), 'utf8');
    expect(kept).toContain(memberNote);
    expect(kept).toContain('team-server');
    expect(await fse.readFile(codebuddyLater(), 'utf8')).not.toContain('team-server');
  });

  it('keeps the comment in a CodeBuddy mcp.json after the team server leaves it', async () => {
    await installCodebuddyTeamServer();
    const installed = await fse.readFile(codebuddyFormer(), 'utf8');
    await fse.writeFile(codebuddyFormer(), `${memberNote}\n${installed}`);
    await fse.writeFile(codebuddyLater(), '{\n  "mcpServers": { "mine": { "command": "x" } }\n}\n');
    await fse.writeFile(path.join(repoPath, 'mcp', 'mcp.yaml'), 'servers: []\n');
    const { teamConfig, localConfig } = configFor('codebuddy');

    await reconcileMcpForConfig(teamConfig, localConfig);

    const kept = await fse.readFile(codebuddyFormer(), 'utf8');
    expect(kept).toContain(memberNote);
    expect(kept).not.toContain('team-server');
    expect(await fse.readFile(codebuddyLater(), 'utf8')).not.toContain('team-server');
  });

  it('moves a plain CodeBuddy mcp.json that holds only the team server into .codebuddy.json and deletes it', async () => {
    await installCodebuddyTeamServer();
    await fse.writeFile(codebuddyLater(), '{\n  "mcpServers": { "mine": { "command": "x" } }\n}\n');
    const { teamConfig, localConfig } = configFor('codebuddy');

    await reconcileMcpForConfig(teamConfig, localConfig);

    expect(await fse.pathExists(codebuddyFormer())).toBe(false);
    const moved = await fse.readFile(codebuddyLater(), 'utf8');
    expect(moved).toContain('team-server');
    expect(moved).toContain('"mine"');
  });

  it('leaves a commented Claude ~/.claude.json alone: Claude Code 2.1.316 refuses it', async () => {
    const target = path.join(homeDir, '.claude.json');
    const text = '{\n  // note\n  "mcpServers": {}\n}\n';
    await fse.outputFile(target, text);
    await fse.ensureDir(path.join(homeDir, '.claude'));
    const { teamConfig, localConfig } = configFor('claude');

    await reconcileMcpForConfig(teamConfig, localConfig);

    expect(await fse.readFile(target, 'utf8')).toBe(text);
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining(`Could not parse ${target}`));
  });
});
