import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));
const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function runCLI(home: string, args: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'mcp', ...args], {
      cwd: home,
      env: { ...process.env, HOME: home, USERPROFILE: home, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}

describe('MCP command failures (real CLI)', () => {
  it.each(['inject', 'remove'])('%s reports partial failure, preserves the broken config and retries after repair', async (command) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-mcp-command-errors-'));
    sandboxes.push(home);
    // No fixture may inherit the contributor checkout as its git root.
    execFileSync('git', ['init', '-q', home]);
    const dataHome = path.join(home, '.teamai');
    const repo = path.join(dataHome, 'team-repo');
    fs.mkdirSync(path.join(repo, 'mcp'), { recursive: true });
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'teamai.yaml'), 'team: mcp-errors\nrepo: https://example.com/mcp-errors.git\nprovider: git\n');
    const definition = (url: string) => `servers:\n  - name: team-mcp\n    transport: http\n    url: ${url}\n    tools: [claude, cursor]\n`;
    fs.writeFileSync(path.join(repo, 'mcp', 'mcp.yaml'), definition('https://example.com/original'));
    fs.writeFileSync(path.join(dataHome, 'config.yaml'), [
      'repo:', `  localPath: ${repo}`, '  remote: https://example.com/mcp-errors.git',
      'username: e2e-user', 'scope: user', 'enabledAgents: [claude, cursor]',
    ].join('\n'));
    const claude = path.join(home, '.claude.json');
    const cursor = path.join(home, '.cursor', 'mcp.json');
    const manifest = path.join(dataHome, 'managed-mcp.json');

    const initial = await runCLI(home, ['inject']);
    expect(initial.code, initial.output).toBe(0);
    const repaired = fs.readFileSync(claude, 'utf8');
    const recordsBefore = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    expect(recordsBefore.claude).toEqual([expect.objectContaining({ name: 'team-mcp' })]);
    const broken = '{ "mcpServers": {';
    fs.writeFileSync(claude, broken);
    if (command === 'inject') fs.writeFileSync(path.join(repo, 'mcp', 'mcp.yaml'), definition('https://example.com/updated'));

    const cursorBefore = fs.readFileSync(cursor);
    const manifestBefore = fs.readFileSync(manifest);
    const preview = await runCLI(home, [command, '--dry-run']);
    expect(preview.code, preview.output).toBe(1);
    expect(preview.output).toContain('incomplete');
    expect(fs.readFileSync(cursor)).toEqual(cursorBefore);
    expect(fs.readFileSync(manifest)).toEqual(manifestBefore);
    expect(fs.readFileSync(claude, 'utf8')).toBe(broken);

    const partial = await runCLI(home, [command]);
    expect(partial.code, partial.output).toBe(1);
    expect(partial.output).toContain(`teamai mcp ${command}`);
    expect(partial.output).toContain('cursor/team-mcp');
    expect(partial.output).not.toContain(command === 'inject' ? 'MCP servers updated.' : 'teamai-managed MCP servers removed.');
    expect(fs.readFileSync(claude, 'utf8')).toBe(broken);
    expect(JSON.parse(fs.readFileSync(manifest, 'utf8')).claude).toEqual(recordsBefore.claude);
    const cursorServer = JSON.parse(fs.readFileSync(cursor, 'utf8')).mcpServers['team-mcp'];
    if (command === 'inject') expect(cursorServer.url).toBe('https://example.com/updated');
    else expect(cursorServer).toBeUndefined();

    const unchanged = await runCLI(home, [command]);
    expect(unchanged.code, unchanged.output).toBe(1);
    expect(unchanged.output).not.toContain(command === 'inject' ? 'Already up to date.' : 'Nothing to remove.');

    fs.writeFileSync(claude, repaired);
    const retried = await runCLI(home, [command]);
    expect(retried.code, retried.output).toBe(0);
    const claudeServer = JSON.parse(fs.readFileSync(claude, 'utf8')).mcpServers['team-mcp'];
    if (command === 'inject') expect(claudeServer.url).toBe('https://example.com/updated');
    else expect(claudeServer).toBeUndefined();
  });
});
