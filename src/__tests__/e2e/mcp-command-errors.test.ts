import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';

const CLI = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));
const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function runCLI(home: string, args: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'mcp', ...args], {
      cwd: home,
      env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'), FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}

describe.each([
  { label: 'claude', tool: 'claude', initial: '' },
  { label: 'codex', tool: 'codex', initial: '' },
  { label: 'codex with a UTF-8 BOM and CRLF', tool: 'codex', initial: '\uFEFF# member settings\r\nmodel = "gpt-5"\r\n' },
])('MCP command failures for $label (real CLI)', ({ tool, initial: initialConfig }) => {
  it.each(['inject', 'remove'])('%s reports partial failure, preserves the broken config and retries after repair', async (command) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-mcp-command-errors-'));
    sandboxes.push(home);
    // No fixture may inherit the contributor checkout as its git root.
    execFileSync('git', ['init', '-q', home]);
    const dataHome = path.join(home, '.teamai');
    const repo = path.join(dataHome, 'team-repo');
    fs.mkdirSync(path.join(repo, 'mcp'), { recursive: true });
    fs.mkdirSync(path.join(home, `.${tool}`), { recursive: true });
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'teamai.yaml'), 'team: mcp-errors\nrepo: https://example.com/mcp-errors.git\nprovider: git\n');
    const definition = (url: string) => `servers:\n  - name: team-mcp\n    transport: http\n    url: ${url}\n    tools: [${tool}, cursor]\n`;
    fs.writeFileSync(path.join(repo, 'mcp', 'mcp.yaml'), definition('https://example.com/original'));
    fs.writeFileSync(path.join(dataHome, 'config.yaml'), [
      'repo:', `  localPath: ${repo}`, '  remote: https://example.com/mcp-errors.git',
      'username: e2e-user', 'scope: user', `enabledAgents: [${tool}, cursor]`,
    ].join('\n'));
    const toolConfig = tool === 'claude' ? path.join(home, '.claude.json') : path.join(home, '.codex', 'config.toml');
    const cursor = path.join(home, '.cursor', 'mcp.json');
    const manifest = path.join(dataHome, 'managed-mcp.json');
    if (initialConfig) {
      fs.writeFileSync(toolConfig, initialConfig);
      const preview = await runCLI(home, ['inject', '--dry-run']);
      expect(preview.code, preview.output).toBe(0);
      expect(fs.readFileSync(toolConfig, 'utf8')).toBe(initialConfig);
      expect(fs.existsSync(manifest)).toBe(false);
    }

    const initial = await runCLI(home, ['inject']);
    expect(initial.code, initial.output).toBe(0);
    const repaired = fs.readFileSync(toolConfig, 'utf8');
    expect(repaired.startsWith(initialConfig)).toBe(true);
    const recordsBefore = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    expect(recordsBefore[tool]).toEqual([expect.objectContaining({ name: 'team-mcp' })]);
    const broken = tool === 'claude' ? '{ "mcpServers": {' : 'model = [\n' + repaired;
    fs.writeFileSync(toolConfig, broken);
    if (command === 'inject') fs.writeFileSync(path.join(repo, 'mcp', 'mcp.yaml'), definition('https://example.com/updated'));

    const cursorBefore = fs.readFileSync(cursor);
    const manifestBefore = fs.readFileSync(manifest);
    const preview = await runCLI(home, [command, '--dry-run']);
    expect(preview.code, preview.output).toBe(1);
    expect(preview.output).toContain('incomplete');
    expect(fs.readFileSync(cursor)).toEqual(cursorBefore);
    expect(fs.readFileSync(manifest)).toEqual(manifestBefore);
    expect(fs.readFileSync(toolConfig, 'utf8')).toBe(broken);

    const partial = await runCLI(home, [command]);
    expect(partial.code, partial.output).toBe(1);
    expect(partial.output).toContain(`teamai mcp ${command}`);
    expect(partial.output).toContain('cursor/team-mcp');
    expect(partial.output).not.toContain(command === 'inject' ? 'MCP servers updated.' : 'teamai-managed MCP servers removed.');
    expect(fs.readFileSync(toolConfig, 'utf8')).toBe(broken);
    expect(JSON.parse(fs.readFileSync(manifest, 'utf8'))[tool]).toEqual(recordsBefore[tool]);
    const cursorServer = JSON.parse(fs.readFileSync(cursor, 'utf8')).mcpServers['team-mcp'];
    if (command === 'inject') expect(cursorServer.url).toBe('https://example.com/updated');
    else expect(cursorServer).toBeUndefined();

    const unchanged = await runCLI(home, [command]);
    expect(unchanged.code, unchanged.output).toBe(1);
    expect(unchanged.output).not.toContain(command === 'inject' ? 'Already up to date.' : 'Nothing to remove.');

    fs.writeFileSync(toolConfig, repaired);
    const retried = await runCLI(home, [command]);
    expect(retried.code, retried.output).toBe(0);
    const content = fs.readFileSync(toolConfig, 'utf8');
    expect(content.startsWith(initialConfig)).toBe(true);
    const servers = tool === 'claude' ? JSON.parse(content).mcpServers : parseToml(content.replace(/^\uFEFF/, '')).mcp_servers;
    if (command === 'inject') expect(servers['team-mcp'].url).toBe('https://example.com/updated');
    else expect(servers?.['team-mcp']).toBeUndefined();
  });
});

describe('removing a Codex MCP server (real CLI)', () => {
  it.each(['remove', 'inject'])('%s keeps the member\'s multiline instructions and other servers', async (command) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-codex-mcp-whitespace-'));
    sandboxes.push(home);
    execFileSync('git', ['init', '-q', home]);
    const dataHome = path.join(home, '.teamai');
    const repo = path.join(dataHome, 'team-repo');
    const file = path.join(home, '.codex', 'config.toml');
    fs.mkdirSync(path.join(repo, 'mcp'), { recursive: true });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(path.join(repo, 'teamai.yaml'), 'team: mcp-test\nrepo: https://example.com/team.git\nprovider: git\n');
    const definitions = path.join(repo, 'mcp', 'mcp.yaml');
    fs.writeFileSync(definitions, 'servers:\n  - name: team-mcp\n    transport: http\n    url: https://example.com/mcp\n    tools: [codex]\n');
    fs.writeFileSync(path.join(dataHome, 'config.yaml'), [
      'repo:', `  localPath: ${repo}`, '  remote: https://example.com/team.git',
      'username: e2e-user', 'scope: user', 'enabledAgents: [codex]',
    ].join('\n'));
    const original = 'developer_instructions = """first\n\n\nlast"""\n\n[mcp_servers.personal]\ncommand = "member-server"\n\n';
    fs.writeFileSync(file, original);

    const injected = await runCLI(home, ['inject']);
    expect(injected.code, injected.output).toBe(0);
    const installed = fs.readFileSync(file, 'utf8');
    expect(parseToml(installed)).toMatchObject({ mcp_servers: { 'team-mcp': { url: 'https://example.com/mcp' } } });
    if (command === 'inject') fs.writeFileSync(definitions, 'servers: []\n');

    const removed = await runCLI(home, [command]);
    expect(removed.code, removed.output).toBe(0);
    expect(removed.output).toMatch(/removed\s+codex\/team-mcp/);
    const result = fs.readFileSync(file, 'utf8');
    expect(result).toBe(original);
    expect(parseToml(result)).toMatchObject({
      developer_instructions: 'first\n\n\nlast',
      mcp_servers: { personal: { command: 'member-server' } },
    });
  });
});

describe('indented Codex TOML tables (real CLI)', () => {
  function fixture(): { home: string; file: string; definitions: string } {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-codex-mcp-indent-'));
    sandboxes.push(home);
    execFileSync('git', ['init', '-q', home]);
    const dataHome = path.join(home, '.teamai');
    const repo = path.join(dataHome, 'team-repo');
    const file = path.join(home, '.codex', 'config.toml');
    const definitions = path.join(repo, 'mcp', 'mcp.yaml');
    fs.mkdirSync(path.dirname(definitions), { recursive: true });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(path.join(repo, 'teamai.yaml'), 'team: mcp-test\nrepo: https://example.com/team.git\nprovider: git\n');
    fs.writeFileSync(definitions, 'servers:\n  - name: team-mcp\n    transport: http\n    url: https://example.com/mcp\n    tools: [codex]\n');
    fs.writeFileSync(path.join(dataHome, 'config.yaml'), [
      'repo:', `  localPath: ${repo}`, '  remote: https://example.com/team.git',
      'username: e2e-user', 'scope: user', 'enabledAgents: [codex]',
    ].join('\n'));
    return { home, file, definitions };
  }

  it('keeps an indented personal server with the same name', async () => {
    const { home, file } = fixture();
    const original = '\t[mcp_servers.team-mcp]\ncommand = "personal-server"\n';
    fs.writeFileSync(file, original);

    const result = await runCLI(home, ['inject']);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toMatch(/skipped\s+codex\/team-mcp/);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(parseToml(original)).toMatchObject({ mcp_servers: { 'team-mcp': { command: 'personal-server' } } });
  });

  it('keeps an indented example in instructions when adding and updating a server', async () => {
    const { home, file, definitions } = fixture();
    const instructions = 'developer_instructions = """\nExample:\n  [mcp_servers.team-mcp]\n  command = "sample"\n"""\n\n';
    fs.writeFileSync(file, instructions);

    const installed = await runCLI(home, ['inject']);
    expect(installed.code, installed.output).toBe(0);
    fs.writeFileSync(definitions, 'servers:\n  - name: team-mcp\n    transport: http\n    url: https://example.com/updated\n    tools: [codex]\n');
    const updated = await runCLI(home, ['inject']);

    expect(updated.code, updated.output).toBe(0);
    expect(updated.output).toMatch(/updated\s+codex\/team-mcp/);
    const result = fs.readFileSync(file, 'utf8');
    expect(result.startsWith(instructions)).toBe(true);
    expect(parseToml(result)).toMatchObject({ mcp_servers: { 'team-mcp': { url: 'https://example.com/updated' } } });
  });

  it.each(['remove', 'inject'])('%s keeps an indented table after the managed server', async (command) => {
    const { home, file, definitions } = fixture();
    fs.writeFileSync(file, 'model = "gpt-5"\n');
    const installed = await runCLI(home, ['inject']);
    expect(installed.code, installed.output).toBe(0);
    fs.appendFileSync(file, '\n  [projects."/work"]\ntrust_level = "trusted"\n');
    if (command === 'inject') fs.writeFileSync(definitions, 'servers: []\n');

    const result = await runCLI(home, [command]);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toMatch(/removed\s+codex\/team-mcp/);
    const remaining = fs.readFileSync(file, 'utf8');
    expect(remaining).toContain('  [projects."/work"]\ntrust_level = "trusted"\n');
    expect(parseToml(remaining)).toMatchObject({ model: 'gpt-5', projects: { '/work': { trust_level: 'trusted' } } });
  });
});
