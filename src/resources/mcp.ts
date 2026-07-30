import path from 'node:path';
import { z } from 'zod';
import YAML from 'yaml';
import { ResourceHandler } from './base.js';
import type { ResourceItem, TeamaiConfig, LocalConfig, McpServerDef } from '../types.js';
import { pathExists, readFileSafe } from '../utils/fs.js';
import { log } from '../utils/logger.js';

// ─── Schema for mcp/mcp.yaml ────────────────────────────────
//
//  Team-declared MCP servers. Transport names are the tool-neutral MCP spec
//  names; each tool's own spelling (the claude/cursor/codebuddy `type` field,
//  Codex's TOML table) is applied at render time by mcp-format.ts.

const TeamMcpServerSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9_-]+$/, 'name must be alphanumeric with - or _'),
    description: z.string().optional(),
    transport: z.enum(['stdio', 'http', 'sse']),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    timeout: z.number().int().positive().optional(),
    requires: z.array(z.string()).optional(),
    tools: z.array(z.string()).optional(),
  })
  .refine((s) => (s.transport === 'stdio' ? !!s.command : true), {
    message: 'stdio transport requires `command`',
  })
  .refine((s) => (s.transport === 'stdio' ? true : !!s.url), {
    message: 'http/sse transport requires `url`',
  });

export const McpYamlSchema = z.object({
  servers: z.array(TeamMcpServerSchema).default([]),
});

export type TeamMcpServer = z.infer<typeof TeamMcpServerSchema>;
export type McpYaml = z.infer<typeof McpYamlSchema>;

/** Absolute path of a team repo's mcp/mcp.yaml. */
export function teamMcpYamlPath(repoPath: string): string {
  return path.join(repoPath, 'mcp', 'mcp.yaml');
}

/**
 * Parse mcp/mcp.yaml into the validated structure. Returns null when the file is
 * absent or fails validation, so callers never act on a half-broken server set.
 */
export async function parseMcpYaml(repoPath: string): Promise<McpYaml | null> {
  const content = await readFileSafe(teamMcpYamlPath(repoPath));
  if (!content) return null;
  try {
    return McpYamlSchema.parse(YAML.parse(content));
  } catch (e) {
    log.warn(`Invalid mcp.yaml format: ${(e as Error).message} — skipping team MCP servers this run`);
    return null;
  }
}

/** Convert one validated team server into the tool-neutral def model. */
export function teamMcpToDef(s: TeamMcpServer): McpServerDef {
  return {
    name: s.name,
    description: s.description,
    transport: s.transport,
    command: s.command,
    args: s.args,
    url: s.url,
    headers: s.headers,
    env: s.env,
    timeout: s.timeout,
    requires: s.requires,
    tools: s.tools,
  };
}

/** Parse the team repo's mcp/mcp.yaml into defs. Returns [] when absent or invalid. */
export async function parseTeamMcpServers(repoPath: string): Promise<McpServerDef[]> {
  const parsed = await parseMcpYaml(repoPath);
  if (!parsed) return [];
  return parsed.servers.map(teamMcpToDef);
}

// ─── Handler ─────────────────────────────────────────────────

export class McpHandler extends ResourceHandler {
  readonly type = 'mcp' as const;

  /**
   * MCP servers are contributed by editing mcp/mcp.yaml directly (same as hooks),
   * so there is nothing to discover on the local side for push.
   */
  async scanLocalForPush(): Promise<ResourceItem[]> {
    return [];
  }

  async scanTeamForPull(_teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<ResourceItem[]> {
    const yamlPath = teamMcpYamlPath(localConfig.repo.localPath);
    if (!await pathExists(yamlPath)) return [];
    const servers = await parseTeamMcpServers(localConfig.repo.localPath);
    return servers.map((s) => ({
      name: s.name,
      type: 'mcp' as const,
      sourcePath: yamlPath,
      relativePath: path.join('mcp', 'mcp.yaml'),
    }));
  }

  async pushItem(): Promise<void> {
    // Servers live in a single mcp.yaml committed directly; nothing per-item to copy.
  }

  async pullItem(): Promise<void> {
    // No-op — reconcileMcpForConfig() in pull.ts injects across all tools/scopes,
    // bypassing the "Already synced" rev fast-path (same shape as hooks).
  }

  /**
   * Remove a server from the team repo's mcp.yaml. Local tool configs are cleaned
   * up by the next reconcile, which sees the server vanish from the desired set.
   */
  async removeItem(name: string, _teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<string[]> {
    const yamlPath = teamMcpYamlPath(localConfig.repo.localPath);
    const parsed = await parseMcpYaml(localConfig.repo.localPath);
    if (!parsed) return [];
    const remaining = parsed.servers.filter((s) => s.name !== name);
    if (remaining.length === parsed.servers.length) return [];

    const { writeFile } = await import('../utils/fs.js');
    await writeFile(yamlPath, YAML.stringify({ servers: remaining }));
    await this.addTombstone(name, localConfig);
    return [yamlPath];
  }
}
