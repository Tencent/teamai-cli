import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// ─── MCP uninstall end-to-end ─────────────────────────────────
//
// Offline fixture (no TEAMAI_TEST_TOKEN). Drives the real CLI binary:
//   mcp inject          → servers land in ~/.claude.json
//   mcp remove --dry-run → previews removal without changing config or manifest
//   uninstall           → teamai-managed servers are removed; hand-added ones stay
//
// Catches the order bug where removeAll ran after ~/.teamai/ (and thus
// managed-mcp.json) had already been deleted.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

interface RunResult {
  code: number | null;
  output: string;
}

function runCLI(args: string[], env: Record<string, string>, cwd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      env: { ...process.env, FORCE_COLOR: '0', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { out += d.toString(); });
    child.stdin.end();
    child.on('close', (code) => resolve({ code, output: out }));
  });
}

const TEAM_YAML = [
  'team: mcp-uninstall-e2e',
  'repo: https://example.com/mcp-e2e.git',
  'provider: tgit',
  'toolPaths:',
  '  claude:',
  '    skills: .claude/skills',
  '    rules: .claude/rules',
  '    settings: .claude/settings.json',
  '    claudemd: .claude/CLAUDE.md',
  '    mcp: .claude.json',
  '    mcpProject: .mcp.json',
].join('\n');

const MCP_YAML = [
  'servers:',
  '  - name: team-mcp',
  '    transport: http',
  '    url: https://example.com/api/mcp',
  '    tools: [claude]',
].join('\n');

describe('MCP uninstall (e2e)', () => {
  let sandbox: string;
  let homeDir: string;
  let claudeJson: string;
  let teamaiHome: string;

  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    }

    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-mcp-uninstall-e2e-'));
    homeDir = path.join(sandbox, 'home');
    teamaiHome = path.join(homeDir, '.teamai');
    claudeJson = path.join(homeDir, '.claude.json');

    fs.mkdirSync(path.join(homeDir, '.claude', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(homeDir, '.claude', 'rules'), { recursive: true });

    // Local team-repo (no git remote needed — inject/uninstall only read files).
    const repoLocal = path.join(teamaiHome, 'team-repo');
    fs.mkdirSync(path.join(repoLocal, 'mcp'), { recursive: true });
    fs.writeFileSync(path.join(repoLocal, 'teamai.yaml'), TEAM_YAML);
    fs.writeFileSync(path.join(repoLocal, 'mcp', 'mcp.yaml'), MCP_YAML);

    fs.writeFileSync(
      path.join(teamaiHome, 'config.yaml'),
      [
        'repo:',
        `  localPath: ${repoLocal}`,
        '  remote: https://example.com/mcp-e2e.git',
        'username: e2e-user',
        'updatePolicy: auto',
        'scope: user',
      ].join('\n'),
    );

    // Hand-added server that uninstall must leave alone.
    fs.writeFileSync(
      claudeJson,
      JSON.stringify({ mcpServers: { 'my-own': { command: 'my-server' } } }, null, 2),
    );
  }, 30_000);

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('injects a team MCP server, then uninstall removes it and keeps user servers', async () => {
    const env = { HOME: homeDir };

    const inject = await runCLI(['mcp', 'inject'], env, homeDir);
    expect(inject.code).toBe(0);
    expect(inject.output).toMatch(/added\s+claude\/team-mcp/);

    const afterInject = JSON.parse(fs.readFileSync(claudeJson, 'utf-8'));
    expect(afterInject.mcpServers['team-mcp']).toEqual({
      type: 'http',
      url: 'https://example.com/api/mcp',
    });
    expect(afterInject.mcpServers['my-own']).toEqual({ command: 'my-server' });
    const manifestPath = path.join(teamaiHome, 'managed-mcp.json');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const configBeforePreview = fs.readFileSync(claudeJson);
    const manifestBeforePreview = fs.readFileSync(manifestPath);
    const preview = await runCLI(['mcp', 'remove', '--dry-run'], env, homeDir);
    expect(preview.code).toBe(0);
    expect(preview.output).toContain('MCP remove (dry run):');
    expect(preview.output).toMatch(/removed\s+claude\/team-mcp/);
    expect(fs.readFileSync(claudeJson)).toEqual(configBeforePreview);
    expect(fs.readFileSync(manifestPath)).toEqual(manifestBeforePreview);

    const uninstall = await runCLI(['uninstall', '--force'], env, homeDir);
    expect(uninstall.code).toBe(0);
    expect(uninstall.output).toMatch(/MCP server/i);

    const afterUninstall = JSON.parse(fs.readFileSync(claudeJson, 'utf-8'));
    expect(afterUninstall.mcpServers['team-mcp']).toBeUndefined();
    expect(afterUninstall.mcpServers['my-own']).toEqual({ command: 'my-server' });
    expect(fs.existsSync(teamaiHome)).toBe(false);
  }, 60_000);
});

describe('MCP uninstall with a config that does not parse (e2e)', () => {
  const API = { type: 'http', url: 'https://example.com/api/mcp' };
  const MINE = { command: 'my-server' };
  const sandboxes: string[] = [];

  afterAll(() => {
    for (const sandbox of sandboxes) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it.each([
    { tool: 'claude', file: '.claude.json', key: 'mcpServers' },
    // An earlier release's ZCode record notes no file: its server is under mcpServers in the retired ~/.agents/mcp.json.
    { tool: 'zcode', file: '.agents/mcp.json', key: 'mcpServers' },
  ])('keeps the data home and the record of $tool while ~/$file does not parse, and removes the server once it is repaired', async ({ tool, file, key }) => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-mcp-uninstall-unparsable-'));
    sandboxes.push(sandbox);
    const homeDir = path.join(sandbox, 'home');
    const teamaiHome = path.join(homeDir, '.teamai');
    const config = path.join(homeDir, file);
    const repoLocal = path.join(teamaiHome, 'team-repo');
    fs.mkdirSync(path.join(repoLocal, 'mcp'), { recursive: true });
    fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(homeDir, '.zcode', 'cli'), { recursive: true });
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(path.join(repoLocal, 'teamai.yaml'), 'team: mcp-uninstall-e2e\nrepo: https://example.com/mcp-e2e.git\nprovider: git\n');
    fs.writeFileSync(path.join(repoLocal, 'mcp', 'mcp.yaml'), 'servers:\n  - name: team-mcp\n    transport: http\n    url: https://example.com/api/mcp\n');
    fs.writeFileSync(path.join(teamaiHome, 'config.yaml'), [
      'repo:', `  localPath: ${repoLocal}`, '  remote: https://example.com/mcp-e2e.git',
      'username: e2e-user', 'updatePolicy: auto', 'scope: user', `enabledAgents: [${tool}]`,
    ].join('\n'));
    const hash = createHash('sha1').update(JSON.stringify(API)).digest('hex').slice(0, 16);
    fs.writeFileSync(path.join(teamaiHome, 'managed-mcp.json'), JSON.stringify({ [tool]: [{ name: 'team-mcp', hash }] }));
    const repaired = JSON.stringify({ [key]: { 'team-mcp': API, 'my-own': MINE } }, null, 2);
    fs.writeFileSync(config, `{ "${key}": {`);
    const env = { HOME: homeDir };

    const first = await runCLI(['uninstall', '--force'], env, homeDir);

    expect(first.code).toBe(1);
    expect(first.output).toContain('Uninstall incomplete');
    expect(first.output).toContain(config);
    expect(JSON.parse(fs.readFileSync(path.join(teamaiHome, 'managed-mcp.json'), 'utf-8'))[tool]).toEqual([expect.objectContaining({ name: 'team-mcp', hash })]);

    fs.writeFileSync(config, repaired);
    const second = await runCLI(['uninstall', '--force'], env, homeDir);

    expect(second.code).toBe(0);
    expect(JSON.parse(fs.readFileSync(config, 'utf-8'))).toEqual({ [key]: { 'my-own': MINE } });
    expect(fs.existsSync(teamaiHome)).toBe(false);
  }, 60_000);
});
