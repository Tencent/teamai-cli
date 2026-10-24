import { z } from 'zod';
import YAML from 'yaml';
import { ResourceHandler } from './base.js';
import type { ResourceItem, TeamaiConfig, LocalConfig, McpServerDef } from '../types.js';
import { readFileSafe, writeFile } from '../utils/fs.js';
import { log } from '../utils/logger.js';
import { pushRepoResourceItem, scanRepoResourceForPush } from './repo-resource.js';
import {
  entryFileAbsolutePath, entryFilePath, listEntryFiles, missingTopLevelKeyReason, readEntryFileText, unknownEntryKeys,
  type EntryReader,
} from '../namespaced-entries.js';

// ─── Schema for mcp/mcp.yaml ────────────────────────────────
//
//  Team-declared MCP servers. Transport names are the tool-neutral MCP spec
//  names; each tool's own spelling (the claude/cursor/codebuddy `type` field,
//  Codex's TOML table) is applied at render time by mcp-format.ts.

const TeamMcpServerFields = z
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
    /** Deprecated (0.25.0): members holding one of these role ids. Use mcp/<ns>/mcp.yaml. */
    roles: z.array(z.string()).optional(),
    /** Removed (0.26.0 betas only): kept so it is detected; such a server reaches nobody. */
    projects: z.array(z.string()).optional(),
  });

const TeamMcpServerSchema = TeamMcpServerFields
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

/**
 * An MCP file that is absent (`yaml: null`), parsed, or refused with a reason.
 * The reason is kept because a file that does not parse is not a team without
 * MCP: a check that cannot tell the two apart reports `ok: true` over a team
 * whose MCP is entirely broken (#624 review).
 */
type McpYamlRead =
  | { ok: true; yaml: McpYaml | null; unknownKeys: ReadonlyMap<TeamMcpServer, readonly string[]> }
  | { ok: false; reason: string };

/** Read one MCP file, keeping why it cannot be used; `yaml: null` when absent. */
async function readMcpFile(absolutePath: string): Promise<McpYamlRead> {
  return parseMcpContent(await readFileSafe(absolutePath));
}

/** Parse one MCP file's text; `yaml: null` when it is absent or empty. */
function parseMcpContent(content: string | null): McpYamlRead {
  if (!content) return { ok: true, yaml: null, unknownKeys: new Map() };
  try {
    const raw: unknown = YAML.parse(content);
    const shapeProblem = missingTopLevelKeyReason(raw, McpYamlSchema);
    if (shapeProblem) return { ok: false, reason: shapeProblem };
    const yaml = McpYamlSchema.parse(raw);
    return { ok: true, yaml, unknownKeys: unknownEntryKeys(raw, 'servers', yaml.servers, TeamMcpServerFields) };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

/** The servers one MCP file's text declares, or null when it does not parse: for reading a past revision. */
export function parseTeamMcpServers(content: string): TeamMcpServer[] | null {
  const read = parseMcpContent(content);
  return read.ok ? read.yaml?.servers ?? [] : null;
}

/** How `mcp/mcp.yaml` and `mcp/<ns>/mcp.yaml` are read for delivery. */
export const mcpEntryReader: EntryReader<TeamMcpServer> = {
  type: 'mcp',
  async read(absolutePath, relativePath) {
    const file = await readEntryFileText(absolutePath, relativePath);
    if (!file.ok) return file;
    const read = parseMcpContent(file.text);
    if (!read.ok) return { ok: false, reason: `${relativePath} does not parse: ${read.reason}` };
    return read.yaml === null ? null : { ok: true, entries: read.yaml.servers, unknownKeys: read.unknownKeys };
  },
  nameOf: (server) => server.name,
  scopeOf: (server) => server,
};

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

// ─── Handler ─────────────────────────────────────────────────

export class McpHandler extends ResourceHandler {
  readonly type = 'mcp' as const;

  async scanLocalForPush(teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<ResourceItem[]> {
    return scanRepoResourceForPush('mcp', 'mcp', teamConfig, localConfig);
  }

  /**
   * Every server in every MCP file, the namespaced ones included whether or
   * not they are active here: this is what `remove mcp` searches. A server in
   * `mcp/<ns>/mcp.yaml` carries its namespace, which `remove` uses to name it
   * `<ns>/<name>`.
   */
  async scanTeamForPull(_teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<ResourceItem[]> {
    const repoPath = localConfig.repo.localPath;
    const items: ResourceItem[] = [];
    for (const { namespace, relativePath, absolutePath: sourcePath } of await listEntryFiles(repoPath, 'mcp')) {
      const read = await readMcpFile(sourcePath);
      if (!read.ok) {
        log.warn(`${relativePath} does not parse, so its servers are not listed: ${read.reason}`);
        continue;
      }
      for (const server of read.yaml?.servers ?? []) {
        items.push({
          name: server.name,
          type: 'mcp',
          sourcePath,
          relativePath,
          ...(namespace === null ? {} : { namespace }),
        });
      }
    }
    return items;
  }

  async pushItem(item: ResourceItem, _teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<void> {
    await pushRepoResourceItem(item, localConfig);
  }

  async pullItem(): Promise<void> {
    // No-op — reconcileMcpForConfig() in pull.ts injects across all tools/scopes,
    // bypassing the "Already synced" rev fast-path (same shape as hooks).
  }

  /**
   * Remove a server from one MCP file: `<ns>/<name>` names it in
   * `mcp/<ns>/mcp.yaml`, a bare name in the root file. Local tool configs are
   * cleaned up by the next reconcile, which sees the server vanish from the
   * desired set.
   */
  async removeItem(name: string, _teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<string[]> {
    const slash = name.indexOf('/');
    const namespace = slash === -1 ? null : name.slice(0, slash);
    const serverName = slash === -1 ? name : name.slice(slash + 1);
    const yamlPath = entryFileAbsolutePath(localConfig.repo.localPath, 'mcp', namespace);
    const content = await readFileSafe(yamlPath);
    const read = parseMcpContent(content);
    if (!read.ok) {
      log.warn(`${entryFilePath('mcp', namespace)} does not parse, so "${serverName}" was not removed: ${read.reason}`);
      return [];
    }
    const servers = read.yaml?.servers ?? [];
    const removed = servers.flatMap((s, index) => (s.name === serverName ? [index] : []));
    if (content === null || removed.length === 0) return [];

    // Edit the document rather than write the parsed servers back: the schema
    // drops a key it does not know, and dropping a misspelled `roles:` would
    // install that server for every member (#822).
    const doc = YAML.parseDocument(content);
    for (const index of removed.reverse()) doc.deleteIn(['servers', index]);
    await writeFile(yamlPath, doc.toString());
    await this.addTombstone(serverName, localConfig);
    return [yamlPath];
  }
}
