import path from 'node:path';
import fse from 'fs-extra';
import { z } from 'zod';
import YAML from 'yaml';
import { parseYaml } from '@teamai/shared/yaml';
import { ResourceHandler } from './base.js';
import type { LocalConfig, McpServerDef, ResourceItem, TeamaiConfig } from '../types.js';
import type { JsonValue } from '@teamai/shared/json';
import { listDirs, readFileSafe, writeFile } from '../utils/fs.js';
import { log } from '@teamai/shared/log';
import { pushRepoResourceItem, scanRepoResourceForPush } from './repo-resource.js';
import {
  entryFileAbsolutePath, entryFilePath, listEntryFiles, missingTopLevelKeyReason, readEntryFileText, unknownEntryKeys, type EntryFileRead, type ResolvedEntry,
} from '../namespaced-entries.js';
import { parseMarker, readMarkerFolder, type LayeredEntryType, type PlaceFolderRead } from './layered-entries.js';
import { RESOURCE_LAYOUTS, Resources, type EntryListRead, type ResourceLayout } from './resolver.js';
import { DeliveredFolders, type FolderDelivery, type PlacedFolders } from './delivered-folders.js';
import type { FolderFile } from './folder-files.js';

// ─── Schema for mcp/mcp.yaml ────────────────────────────────
//
//  Team-declared MCP servers. Transport names are the tool-neutral MCP spec
//  names; each tool's own spelling (the claude/cursor/codebuddy `type` field,
//  Codex's TOML table) is applied at render time by mcp-format.ts.

const TeamMcpServerFields = z
  .object({
    name: z.string().regex(RESOURCE_LAYOUTS.mcp.nameRule.pattern, RESOURCE_LAYOUTS.mcp.nameRule.description),
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

/** A team MCP server as the team repo defines it. */
export type TeamMcpDefinition =
  | { readonly kind: 'entry'; readonly server: TeamMcpServer }
  | TeamMcpFolder;

/** A team MCP server folder: its `MCP.yaml`, with the directory's name as name, the files pull delivers, `MCP.yaml` included, and their version (`DeliveredFolders.identify`). */
export type TeamMcpFolder = { readonly kind: 'folder'; readonly server: TeamMcpServer; readonly files: readonly FolderFile[]; readonly version: string };

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
        + `Move it to ${path.posix.dirname(relativePath)}/${folderOnly.name}/${RESOURCE_LAYOUTS.mcp.marker}, beside the files it runs.`,
    };
  }

  return { kind: 'entries', entries: servers.map((server) => ({ name: server.name, entry: { server, unknownKeys: read.unknownKeys.get(server) ?? [] } })) };
}

/** Where team MCP servers live in a team tree: the servers of `mcp.yaml` and the server folders, at the root and in each namespace. */
export const TEAM_MCP: ResourceLayout<McpFileEntry> = {
  ...RESOURCE_LAYOUTS.mcp,
  entryList: { file: 'mcp.yaml', entries: mcpFileEntries },
};

/** Read the server folder at `full` (`folderPath` from the team root, ending in `/`), named `name`. */
export async function readMcpFolder(full: string, folderPath: string, name: string): Promise<PlaceFolderRead<TeamMcpFolder>> {
  const read = await readMarkerFolder({ full, path: folderPath }, RESOURCE_LAYOUTS.mcp.marker, FolderMcpFields);
  const markerPath = `${folderPath}${RESOURCE_LAYOUTS.mcp.marker}`;

  switch (read.kind) {
    case 'undeliverable':
      return { kind: 'invalid', reason: `${folderPath} is not an MCP server folder teamai can deliver: ${read.problems.join(', ')}` };
    case 'invalid':
      return read;
    case 'read': {
      const { fields } = read;

      if (fields.transport !== 'stdio') {
        return {
          kind: 'invalid',
          reason: `${markerPath}: transport ${fields.transport} is refused in a folder, which holds the files of a server teamai starts (stdio). `
            + 'A URL server carries no files: declare it in mcp.yaml.',
        };
      }

      if (!fields.command) return { kind: 'invalid', reason: `${markerPath} does not parse: stdio transport requires \`command\`` };

      const identity = await DeliveredFolders.identify(full, read.files);

      if (!identity.ok) return { kind: 'invalid', reason: `${folderPath} cannot be delivered: ${identity.reason}` };

      return { kind: 'read', definition: { kind: 'folder', server: { ...fields, name }, files: identity.files, version: identity.version }, unknownKeys: read.unknownKeys };
    }

    default: {
      const unhandled: never = read;

      return unhandled;
    }
  }
}

/** How team MCP servers resolve for delivery: `mcp.yaml` servers and folders, in each place of the team tree, through the resolver. */
export const TEAM_MCP_ENTRIES: LayeredEntryType<McpFileEntry, TeamMcpDefinition> = {
  type: 'mcp',
  layout: TEAM_MCP,
  fromEntry: ({ server, unknownKeys }) => ({ definition: { kind: 'entry', server }, unknownKeys }),
  readFolder: async ({ name, full, path: folderPath }) => (
    // A teamai- name only replaces a default (#1787, common rule 5), and teamai ships no MCP server.
    name.startsWith('teamai-')
      ? { kind: 'skipped', note: `${folderPath} is skipped: a teamai- name only replaces a teamai default, and teamai has no MCP server named ${name}. Rename the folder.` }
      : readMcpFolder(full, folderPath, name)
  ),
  scopeOf: (definition) => definition.server,
};

/**
 * Where `localConfig`'s scope delivers the server folder `folder`, in `namespace`: `mcp/[<ns>/]<name>.<version>/`, one
 * directory per version of its files, `MCP.yaml` among them (#1787). Each tool's configuration starts the files it was
 * written with: one the member excluded, or one pull could not rewrite, keeps its own, while the others start the new
 * ones.
 */
export function mcpFolderPath(localConfig: LocalConfig, folder: TeamMcpFolder, namespace: string | null): string {
  return DeliveredFolders.versionedPathOf(localConfig, { type: 'mcp', namespace, name: folder.server.name }, folder.version);
}

/**
 * `resolved` as `localConfig`'s scope gives it to the tools. A folder server's `command`, `args` and `env` name its
 * delivered path where they write `${TEAMAI_MCP_DIR}` (#1787); its `headers` are left as written.
 */
export function teamMcpDef(localConfig: LocalConfig, resolved: ResolvedEntry<TeamMcpDefinition>): McpServerDef {
  const def = teamMcpToDef(resolved.entry.server);

  return resolved.entry.kind === 'entry' ? def : folderServerDef(def, mcpFolderPath(localConfig, resolved.entry, resolved.namespace));
}

/** A folder server's `def` with `${TEAMAI_MCP_DIR}` in its `command`, `args` and `env` naming `dest`. */
function folderServerDef(def: McpServerDef, dest: string): McpServerDef {
  const render = (text: string): string => DeliveredFolders.render(text, { type: 'mcp', dest });

  return {
    ...def,
    command: def.command === undefined ? undefined : render(def.command),
    args: def.args?.map(render),
    env: def.env && Object.fromEntries(Object.entries(def.env).map(([key, value]) => [key, render(value)])),
  };
}

/**
 * The server a committed `MCP.yaml` at `relativePath` (`mcp/[<ns>/]<name>/MCP.yaml`) defined, as `localConfig`'s scope
 * gave it to the tools, so teamai recognises the entries it wrote from an earlier version (#993, #1787). Null for any
 * other path, or a version pull would not have delivered.
 */
export function historicalFolderMcpServer(localConfig: LocalConfig, relativePath: string, content: string): { readonly server: TeamMcpServer; readonly def: McpServerDef } | null {
  const [type, ...rest] = relativePath.split('/');
  const marker = rest.at(-1);
  const name = rest.at(-2);
  const namespace = rest.length === 3 ? rest[0] ?? null : null;
  const { mcp } = RESOURCE_LAYOUTS;

  if (type !== mcp.dir || marker !== mcp.marker || name === undefined || (rest.length !== 2 && rest.length !== 3)) return null;

  if (!mcp.nameRule.pattern.test(name) || name.startsWith('teamai-')) return null;
  const parsed = parseMarker(content, relativePath, FolderMcpFields);

  if (!parsed.ok || parsed.fields.transport !== 'stdio' || !parsed.fields.command) return null;
  const server: TeamMcpServer = { ...parsed.fields, name };

  // The files of that revision are not read: its entries are compared with the version left out (`withoutVersions`).
  return { server, def: folderServerDef(teamMcpToDef(server), DeliveredFolders.anyVersionPathOf(localConfig, { type: 'mcp', namespace, name })) };
}

/** The folders of the resolved servers `entries` that are folders. */
function mcpFolders(localConfig: LocalConfig, entries: ReadonlyArray<ResolvedEntry<TeamMcpDefinition>>): FolderDelivery[] {
  return entries.flatMap((resolved) => (resolved.entry.kind === 'folder'
    // A version's folder holds only its files: a configuration written for other files starts another folder.
    ? [{ dest: mcpFolderPath(localConfig, resolved.entry, resolved.namespace), files: resolved.entry.files, earlierFiles: 'drop' as const }]
    : []));
}

/**
 * Put the folders of the resolved servers `entries` in place (#1787, common rule 9), before any configuration names
 * them. Each version replaced stays aside until the caller commits, once the configurations are written, which also
 * records the folders in the scope's delivery record; or rolls back, when a write fails, so the configurations it
 * restores start the files they started before. The folder of each server in `kept`, whose installed configuration
 * this run leaves as it is, stays as it is too. Throws when a folder cannot be written; the caller then keeps the
 * installed servers, whose folders are left as they were.
 */
export async function deliverMcpFolders(
  localConfig: LocalConfig,
  entries: ReadonlyArray<ResolvedEntry<TeamMcpDefinition>>,
  kept: ReadonlySet<string>,
): Promise<PlacedFolders> {
  const { editDeliveryRecord } = await import('../pull.js');
  const record = await editDeliveryRecord(localConfig);
  const folders = mcpFolders(localConfig, entries.filter((resolved) => !kept.has(resolved.entry.server.name)));
  const placed = await DeliveredFolders.place({ localConfig, type: 'mcp', folders, ledger: record.ledger });

  return {
    commit: async () => {
      await placed.commit();
      await record.save();
    },
    rollback: placed.rollback,
  };
}

/**
 * Remove the scope's server folders that neither the resolved servers `entries` nor an installed configuration names,
 * once every configuration this run writes is in place: a write that fails leaves the folders as they were. A folder
 * whose path one of `installed` (each entry some tool's file still holds, as text) names stays, whatever the team now
 * makes of its server.
 */
export async function pruneMcpFolders(
  localConfig: LocalConfig,
  entries: ReadonlyArray<ResolvedEntry<TeamMcpDefinition>>,
  installed: readonly string[],
): Promise<void> {
  const { editDeliveryRecord } = await import('../pull.js');
  const record = await editDeliveryRecord(localConfig);
  const named = await DeliveredFolders.namedIn({ root: DeliveredFolders.root(localConfig, 'mcp'), type: 'mcp', texts: installed });

  await DeliveredFolders.prune({ localConfig, type: 'mcp', keep: [...mcpFolders(localConfig, entries).map(({ dest }) => dest), ...named], ledger: record.ledger });
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

    // A server folder is listed whether or not its MCP.yaml parses, so a broken one can still be removed.
    const places = [null, ...await listDirs(path.join(repoPath, 'mcp'))];
    const layers = await Promise.all(places.map((namespace) => Resources.layer(RESOURCE_LAYOUTS.mcp, { root: repoPath, namespace })));

    for (const { items: layerItems } of layers) {
      for (const layerItem of layerItems) {
        if (layerItem.source.kind !== 'folder') continue;
        const item: ResourceItem = { name: layerItem.name, type: 'mcp', sourcePath: layerItem.source.full, relativePath: layerItem.source.path.replace(/\/$/, '') };

        if (layerItem.layer === 'namespace') item.namespace = layerItem.namespace;
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
    const removed = [...await removeServerFolder(localConfig.repo.localPath, namespace, serverName), ...await this.removeServerEntry(localConfig, namespace, serverName)];

    if (removed.length > 0) await this.addTombstone(serverName, localConfig);

    return removed;
  }

  /** Remove the server `serverName` from the MCP file of `namespace`; the file's path when it defined it. */
  private async removeServerEntry(localConfig: LocalConfig, namespace: string | null, serverName: string): Promise<string[]> {
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

    return [yamlPath];
  }
}

/** Remove the server folder `serverName` of `namespace` from the team repo, found as pull finds it; its path when there was one. */
async function removeServerFolder(repoPath: string, namespace: string | null, serverName: string): Promise<string[]> {
  const { items } = await Resources.layer(RESOURCE_LAYOUTS.mcp, { root: repoPath, namespace });
  const folder = items.find((item) => item.name === serverName && item.source.kind === 'folder');

  if (folder === undefined) return [];
  // oxlint-disable-next-line teamai/remove-delivered -- the team repo's source, which pull never records
  await fse.remove(folder.source.full);

  return [folder.source.full];
}
