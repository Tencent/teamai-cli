import path from 'node:path';
import { readJson, writeJson, ensureDir, pathExists } from './utils/fs.js';
import { log } from './utils/logger.js';

interface McpConfig {
  mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
}

const MCP_CONFIG_PATHS: Record<string, string> = {
  claude: '.claude/mcp.json',
  codebuddy: '.codebuddy/mcp.json',
  cursor: '.cursor/mcp.json',
};

export async function registerMcpServer(baseDir?: string): Promise<number> {
  const home = baseDir ?? (process.env.HOME ?? '');
  let registered = 0;

  for (const [tool, relPath] of Object.entries(MCP_CONFIG_PATHS)) {
    const configPath = path.join(home, relPath);
    const configDir = path.dirname(configPath);

    if (!await pathExists(configDir)) {
      log.debug(`MCP register: skipping ${tool} (directory not found)`);
      continue;
    }

    try {
      await ensureDir(configDir);
      const existing: McpConfig = await readJson(configPath) ?? { mcpServers: {} };
      if (!existing.mcpServers) existing.mcpServers = {};

      const current = existing.mcpServers['teamai'];
      const desired = { command: 'teamai', args: ['mcp'], env: {} };

      if (current?.command === desired.command && JSON.stringify(current?.args) === JSON.stringify(desired.args)) {
        log.debug(`MCP register: ${tool} already configured`);
        continue;
      }

      existing.mcpServers['teamai'] = desired;
      await writeJson(configPath, existing);
      registered++;
      log.debug(`MCP register: registered teamai server in ${tool}`);
    } catch (e) {
      log.warn(`MCP register: failed for ${tool}: ${(e as Error).message}`);
    }
  }

  return registered;
}

export async function unregisterMcpServer(baseDir?: string): Promise<void> {
  const home = baseDir ?? (process.env.HOME ?? '');

  for (const [tool, relPath] of Object.entries(MCP_CONFIG_PATHS)) {
    const configPath = path.join(home, relPath);
    try {
      const existing: McpConfig | null = await readJson(configPath);
      if (existing?.mcpServers?.['teamai']) {
        delete existing.mcpServers['teamai'];
        await writeJson(configPath, existing);
        log.debug(`MCP unregister: removed teamai from ${tool}`);
      }
    } catch {
      // File doesn't exist or can't be read — that's fine
    }
  }
}
