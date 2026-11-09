import path from 'node:path';
import { z } from 'zod';
import YAML from 'yaml';
import { parseYaml } from '../utils/yaml.js';
import { ResourceHandler } from './base.js';
import { isJsonObject, type JsonValue, type LocalConfig, type McpServerDef, type ResourceItem, type TeamaiConfig } from '../types.js';
import { readFileSafe, writeFile } from '../utils/fs.js';
import { log } from '../utils/logger.js';
import { pushRepoResourceItem, scanRepoResourceForPush } from './repo-resource.js';
import {
  entryFileAbsolutePath, entryFilePath, listEntryFiles, missingTopLevelKeyReason, readEntryFileText, unknownEntryKeys,
  type EntryFileRead, type EntryPlaceReader, type ResolvedEntry,
} from '../namespaced-entries.js';
import { RESOURCE_LAYOUTS, Resources, type EntryListRead, type ResourceLayout } from './resolver.js';
import { DeliveredFolders } from './delivered-folders.js';
import { FolderFiles, type FolderFile } from './folder-files.js';

// ─── Schema for mcp/mcp.yaml ────────────────────────────────
//
//  Team-declared MCP servers. Transport names are the tool-neutral MCP spec
//  names; each tool's own spelling (the claude/cursor/codebuddy `type` field,
//  Codex's TOML table) is applied at render time by mcp-format.ts.

const TeamMcpServerFields = z
  .object({
    name: z.string().regex(RESOURCE_LAYOUTS.mcp.nameRule.pattern, 'name must be alphanumeric with - or _'),
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
    const raw: JsonValue = parseYaml(content);
    const topLevelProblem = missingTopLevelKeyReason(raw, McpYamlSchema);

    if (topLevelProblem) return { ok: false, reason: topLevelProblem };
    const yaml = McpYamlSchema.parse(raw);

    return { ok: true, yaml, unknownKeys: unknownEntryKeys(raw, 'servers', yaml.servers, TeamMcpServerFields) };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** The servers one MCP file's text declares, or null when it does not parse: for reading a past revision. */
export function parseTeamMcpServers(content: string): TeamMcpServer[] | null {
  const read = parseMcpContent(content);

  return read.ok ? read.yaml?.servers ?? [] : null;
}

/** One MCP file's servers, or why it cannot be used; null when it does not exist. */
export async function readTeamMcpFile(absolutePath: string, relativePath: string): Promise<EntryFileRead<TeamMcpServer> | null> {
  const file = await readEntryFileText(absolutePath, relativePath);

  if (!file.ok) return file;
  const read = parseMcpContent(file.text);

  if (!read.ok) return { ok: false, reason: `${relativePath} does not parse: ${read.reason}` };

  return read.yaml === null ? null : { ok: true, entries: read.yaml.servers, unknownKeys: read.unknownKeys };
}

/** `mcp/[<ns>/]<name>/MCP.yaml`: an mcp.yaml server without its name, which is the directory's, and without roles or projects. */
const FolderMcpFields = TeamMcpServerFields.omit({ name: true, roles: true, projects: true });

/** The marker of an MCP server folder. */
const MCP_MARKER = 'MCP.yaml';

/** A team MCP server as the team repo defines it. */
export type TeamMcpDefinition =
  | { readonly kind: 'entry'; readonly server: TeamMcpServer }
  /** A folder: its `MCP.yaml`, with the directory's name as name, and every file it holds, `MCP.yaml` included. */
  | { readonly kind: 'folder'; readonly server: TeamMcpServer; readonly files: readonly FolderFile[] };

/** One server of an MCP file, with the keys it was written with that the schema does not know. */
interface McpFileEntry {
  readonly server: TeamMcpServer;
  readonly unknownKeys: readonly string[];
}

/** Every text of `server` a `${VAR}` may stand in. */
function serverTexts(server: TeamMcpServer): string[] {
  return [server.command, server.url, ...server.args ?? [], ...Object.values(server.env ?? {}), ...Object.values(server.headers ?? {})]
    .flatMap((text) => (text === undefined ? [] : [text]));
}

/**
 * An MCP file's servers for the resolver. A server naming `${TEAMAI_MCP_DIR}` makes the file invalid: only a folder has
 * a directory (#1787, common rule 8).
 */
function mcpFileEntries(content: string, relativePath: string): EntryListRead<McpFileEntry> {
  const read = parseMcpContent(content);

  if (!read.ok) return { kind: 'invalid', message: `${relativePath} does not parse: ${read.reason}` };
  const servers = read.yaml?.servers ?? [];
  const folderOnly = servers.find((server) => serverTexts(server).some((text) => DeliveredFolders.mentions(text, 'mcp')));

  if (folderOnly) {
    return {
      kind: 'invalid',
      message: `${relativePath}: server "${folderOnly.name}" uses \${TEAMAI_MCP_DIR}, which only an MCP server folder has. `
        + `Move it to ${path.posix.dirname(relativePath)}/${folderOnly.name}/${MCP_MARKER}, beside the files it runs.`,
    };
  }

  return { kind: 'entries', entries: servers.map((server) => ({ name: server.name, entry: { server, unknownKeys: read.unknownKeys.get(server) ?? [] } })) };
}

/** Where team MCP servers live in a team tree: the servers of `mcp.yaml` and the server folders, at the root and in each namespace. */
export const TEAM_MCP: ResourceLayout<McpFileEntry> = {
  ...RESOURCE_LAYOUTS.mcp,
  entryList: { file: 'mcp.yaml', entries: mcpFileEntries },
};

/** A folder's `MCP.yaml` (at `markerPath`) as the server named `name`, or why it cannot be used. */
function parseMcpMarker(content: string, markerPath: string, name: string): { ok: true; server: TeamMcpServer; unknownKeys: readonly string[] } | { ok: false; reason: string } {
  try {
    const raw: JsonValue = parseYaml(content);
    const parsed = FolderMcpFields.safeParse(raw);

    if (!parsed.success) {
      return { ok: false, reason: `${markerPath} does not parse: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}` };
    }

    if (parsed.data.transport !== 'stdio') {
      return {
        ok: false,
        reason: `${markerPath}: transport ${parsed.data.transport} is refused in a folder, which holds the files of a server teamai starts (stdio). `
          + 'A URL server carries no files: declare it in mcp.yaml.',
      };
    }

    if (!parsed.data.command) return { ok: false, reason: `${markerPath} does not parse: stdio transport requires \`command\`` };
    const known = Object.keys(FolderMcpFields.shape);
    const unknownKeys = isJsonObject(raw) ? Object.keys(raw).filter((key) => !known.includes(key)) : [];

    return { ok: true, server: { ...parsed.data, name }, unknownKeys };
  } catch (e) {
    return { ok: false, reason: `${markerPath} does not parse: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** A server folder read: its definition and the keys its `MCP.yaml` has that the schema does not know, or why it cannot be used. */
type McpFolderRead =
  | { readonly ok: true; readonly definition: TeamMcpDefinition; readonly unknownKeys: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/** Read the server folder at `full` (`folderPath` from the team root, ending in `/`), named `name`. */
export async function readMcpFolder(full: string, folderPath: string, name: string): Promise<McpFolderRead> {
  const read = await FolderFiles.read(full);

  if (read.kind === 'invalid') {
    return { ok: false, reason: `${folderPath} is not an MCP server folder teamai can deliver: ${read.problems.map(FolderFiles.describe).join(', ')}` };
  }

  const marker = read.files.find((file) => file.path === MCP_MARKER);
  const parsed = parseMcpMarker(marker?.bytes.toString('utf8') ?? '', `${folderPath}${MCP_MARKER}`, name);

  if (!parsed.ok) return parsed;

  return { ok: true, definition: { kind: 'folder', server: parsed.server, files: read.files }, unknownKeys: parsed.unknownKeys };
}

/** How team MCP servers are read for delivery: each place of the team tree through the resolver, `mcp.yaml` servers and folders. */
export const mcpEntryReader: EntryPlaceReader<TeamMcpDefinition> = {
  type: 'mcp',
  async readPlace(repoPath, dir) {
    const { items, diagnostics } = await Resources.layer(TEAM_MCP, { root: repoPath, namespace: dir });
    const invalid = diagnostics.find((diagnostic) => diagnostic.kind === 'invalid');

    if (invalid) return { ok: false, source: invalid.path, reason: invalid.message };
    const unknownKeys = new Map<TeamMcpDefinition, readonly string[]>();
    const notes = diagnostics.map(({ message }) => message);
    const entries: Array<{ entry: TeamMcpDefinition; source: string }> = [];

    for (const { name, source } of items) {
      // The MCP layout reads no file on its own.
      if (source.kind === 'file') continue;

      if (source.kind === 'entry') {
        const definition: TeamMcpDefinition = { kind: 'entry', server: source.entry.server };

        if (source.entry.unknownKeys.length > 0) unknownKeys.set(definition, source.entry.unknownKeys);
        entries.push({ entry: definition, source: source.path });
        continue;
      }

      // A teamai- name only replaces a default (#1787, common rule 5), and teamai ships no MCP server.
      if (name.startsWith('teamai-')) {
        notes.push(`${source.path} is skipped: a teamai- name only replaces a teamai default, and teamai has no MCP server named ${name}. Rename the folder.`);
        continue;
      }

      const read = await readMcpFolder(source.full, source.path, name);

      if (!read.ok) return { ok: false, source: source.path, reason: read.reason };

      if (read.unknownKeys.length > 0) unknownKeys.set(read.definition, read.unknownKeys);
      entries.push({ entry: read.definition, source: source.path });
    }

    return { ok: true, entries, notes, unknownKeys };
  },
  nameOf: (definition) => definition.server.name,
  scopeOf: (definition) => definition.server,
};

/** Where `localConfig`'s scope delivers the server folder `resolved` defines. */
function mcpFolderPath(localConfig: LocalConfig, resolved: ResolvedEntry<TeamMcpDefinition>): string {
  return DeliveredFolders.pathOf(localConfig, { type: 'mcp', namespace: resolved.namespace, name: resolved.name });
}

/**
 * `resolved` as `localConfig`'s scope gives it to the tools. A folder server's `command`, `args` and `env` name its
 * delivered path where they write `${TEAMAI_MCP_DIR}` (#1787); its `headers` are left as written.
 */
export function teamMcpDef(localConfig: LocalConfig, resolved: ResolvedEntry<TeamMcpDefinition>): McpServerDef {
  const def = teamMcpToDef(resolved.entry.server);

  if (resolved.entry.kind === 'entry') return def;
  const dest = mcpFolderPath(localConfig, resolved);
  const render = (text: string): string => DeliveredFolders.render(text, { type: 'mcp', dest });

  return {
    ...def,
    command: def.command === undefined ? undefined : render(def.command),
    args: def.args?.map(render),
    env: def.env && Object.fromEntries(Object.entries(def.env).map(([key, value]) => [key, render(value)])),
  };
}

/**
 * Deliver the folders of the resolved servers `entries`, recorded in the scope's delivery record, then, with `prune`,
 * remove the scope's server folders the team dropped (#1787, common rule 9). Throws when a folder cannot be written;
 * the caller then keeps the installed servers, whose folders are left as they were.
 */
export async function deliverMcpFolders(
  localConfig: LocalConfig,
  entries: ReadonlyArray<ResolvedEntry<TeamMcpDefinition>>,
  opts: { readonly prune: boolean },
): Promise<void> {
  const folders = entries.flatMap((resolved) => (resolved.entry.kind === 'folder' ? [{ dest: mcpFolderPath(localConfig, resolved), files: resolved.entry.files }] : []));
  const { editDeliveryRecord } = await import('../pull.js');
  const record = await editDeliveryRecord(localConfig);

  await DeliveredFolders.sync({ localConfig, type: 'mcp', folders, ledger: record.ledger, prune: opts.prune });
  await record.save();
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
        const item: ResourceItem = {
          name: server.name,
          type: 'mcp',
          sourcePath,
          relativePath,
        };

        if (namespace !== null) item.namespace = namespace;
        items.push(item);
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

    for (const index of removed.toReversed()) doc.deleteIn(['servers', index]);
    await writeFile(yamlPath, doc.toString());
    await this.addTombstone(serverName, localConfig);

    return [yamlPath];
  }
}
