import path from 'node:path';
import { z } from 'zod';
import { getDataHome, managedMcpManifestPath, type LocalConfig } from './types.js';
import { readFileSafe } from './utils/fs.js';
import { updateFileLocked, type ExcludeUpdate } from './mcp-git-exclude.js';

// ─── Project MCP configs teamai wrote a resolved value to ────
//
//  managed-mcp.json records server names per tool, not paths, so a file an
//  earlier pull wrote under a toolPaths mapping the team has since changed is
//  no longer anyone's target, and a record rebuilt after it was lost cannot
//  tell teamai's stale entries from the member's own (#882). This file, next
//  to the worktree's managed-mcp.json, remembers both: each project MCP config
//  a pull wrote a resolved value to, by absolute path, with the tools it wrote
//  it for, and the servers it found there when it rebuilt a lost record. It
//  also says whether a pull has read the files earlier revisions of the team's
//  teamai.yaml mapped, which a teamai from before this file wrote to without
//  recording them. Nothing depends on it to keep a line: missing or unreadable,
//  it reads as empty and the rules without it apply.

export interface ResolvedMcpFile {
  /** The tools whose MCP format the file was written in. */
  tools: string[];
  /** Servers in the file when teamai rebuilt its lost record: teamai may have written them. */
  unverified?: string[];
}

export interface ResolvedMcpFiles {
  version: 1;
  /** Keyed by the file's absolute path. */
  files: Record<string, ResolvedMcpFile>;
  /** A pull has read the project MCP configs earlier revisions of teamai.yaml mapped. */
  earlierMappingsRead?: true;
}

/** What a command found in a project MCP config, for `settleResolvedMcpFiles`. */
export interface McpFileObservation {
  file: string;
  tool: string;
  state: { kind: 'missing' } | { kind: 'unparsable' } | { kind: 'parsed'; servers: readonly string[] };
  /** It may hold a value teamai resolved (resolvedValueEvidence). */
  holding: boolean;
  /** The server names managed-mcp.json records for it now. */
  owned: string[];
}

// Fields a later teamai adds are carried through a rewrite.
const FileSchema = z.object({ tools: z.array(z.string()), unverified: z.array(z.string()).optional() }).passthrough();
const SidecarSchema = z.object({ version: z.literal(1), files: z.record(z.unknown()) }).passthrough();

type Sidecar = z.infer<typeof SidecarSchema> & { files: Record<string, z.infer<typeof FileSchema>> };

/** `<dataHome>/workspaces/<id>/managed-mcp-files.json`, or null outside project scope. */
export function resolvedMcpFilesPath(cfg: LocalConfig): string | null {
  if (cfg.scope !== 'project' || !cfg.projectRoot) return null;
  return path.join(path.dirname(managedMcpManifestPath(getDataHome(cfg), cfg.projectRoot)), 'managed-mcp-files.json');
}

/** Missing, not JSON, of another shape or version: no files. An entry of the wrong shape, or under a relative path, is left out. */
function parse(content: string): Sidecar {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    data = null;
  }
  const parsed = SidecarSchema.safeParse(data);
  if (!parsed.success) return { version: 1, files: {} };
  const files: Sidecar['files'] = {};
  for (const [file, value] of Object.entries(parsed.data.files)) {
    const entry = FileSchema.safeParse(value);
    if (entry.success && path.isAbsolute(file)) files[file] = entry.data;
  }
  return { ...parsed.data, files };
}

/** The files this worktree's pulls wrote a resolved value to. Never throws. */
export async function readResolvedMcpFiles(cfg: LocalConfig): Promise<ResolvedMcpFiles> {
  const file = resolvedMcpFilesPath(cfg);
  const content = file === null ? null : await readFileSafe(file).catch(() => null);
  if (content === null) return { version: 1, files: {} };
  const sidecar = parse(content);
  return { version: 1, files: sidecar.files, ...sidecar.earlierMappingsRead === true ? { earlierMappingsRead: true } : {} };
}

/**
 * Apply `edit` to the record under its lock (re-read, atomic write, 0600).
 * `edit` returns false to leave it as it is. One that does not parse is
 * rewritten from empty.
 */
export function updateResolvedMcpFiles(cfg: LocalConfig, edit: (files: Record<string, ResolvedMcpFile>) => boolean): Promise<ExcludeUpdate> {
  return updateSidecar(cfg, (sidecar) => edit(sidecar.files));
}

async function updateSidecar(cfg: LocalConfig, edit: (sidecar: Sidecar) => boolean): Promise<ExcludeUpdate> {
  const file = resolvedMcpFilesPath(cfg);
  if (file === null) return 'unchanged';
  return updateFileLocked(file, (content) => {
    const sidecar = parse(content);
    return edit(sidecar) ? `${JSON.stringify(sidecar, null, 2)}\n` : null;
  }, { mode: 0o600 });
}

/** Record each file as written with a resolved value, for its tool. */
export function trackResolvedMcpFiles(cfg: LocalConfig, targets: Array<{ tool: string; file: string }>): Promise<ExcludeUpdate> {
  return updateResolvedMcpFiles(cfg, (files) => {
    let changed = false;
    for (const { tool, file } of targets) {
      const entry = files[file];
      if (entry?.tools.includes(tool)) continue;
      files[file] = entry ? { ...entry, tools: [...entry.tools, tool] } : { tools: [tool] };
      changed = true;
    }
    return changed;
  });
}

/** Take back what `trackResolvedMcpFiles` recorded for a file it was not written to after all. */
export function untrackResolvedMcpFiles(cfg: LocalConfig, targets: Array<{ tool: string; file: string }>): Promise<ExcludeUpdate> {
  return updateResolvedMcpFiles(cfg, (files) => {
    let changed = false;
    for (const { tool, file } of targets) {
      const entry = files[file];
      if (!entry?.tools.includes(tool)) continue;
      const tools = entry.tools.filter((t) => t !== tool);
      if (tools.length > 0) files[file] = { ...entry, tools };
      else delete files[file];
      changed = true;
    }
    return changed;
  });
}

/**
 * Note `names`, servers found in a file whose lost record teamai rebuilt, as
 * possibly teamai's: only for a file already recorded as holding a resolved value.
 */
export function recordUnverifiedMcpServers(cfg: LocalConfig, found: Array<{ file: string; names: string[] }>): Promise<ExcludeUpdate> {
  return updateResolvedMcpFiles(cfg, (files) => {
    let changed = false;
    for (const { file, names } of found) {
      const entry = files[file];
      const added = names.filter((name) => !entry?.unverified?.includes(name));
      if (!entry || added.length === 0) continue;
      entry.unverified = [...entry.unverified ?? [], ...added];
      changed = true;
    }
    return changed;
  });
}

/**
 * Bring the record up to date with what the files hold: forget a file that is
 * gone or holds no server, record one holding a resolved value it did not
 * list (written by an older teamai), and drop a noted server that left its
 * file or that teamai owns again. A file that does not parse stays as it is.
 * `earlierMappingsRead`: the observations cover the files earlier revisions
 * of teamai.yaml mapped, which later pulls need not read again.
 */
export function settleResolvedMcpFiles(
  cfg: LocalConfig,
  observations: McpFileObservation[],
  options: { earlierMappingsRead?: boolean } = {},
): Promise<ExcludeUpdate> {
  return updateSidecar(cfg, (sidecar) => {
    const { files } = sidecar;
    let changed = options.earlierMappingsRead === true && sidecar.earlierMappingsRead !== true;
    if (changed) sidecar.earlierMappingsRead = true;
    for (const { file, tool, state, holding, owned } of observations) {
      const entry = files[file];
      if (state.kind === 'missing' || (state.kind === 'parsed' && state.servers.length === 0)) {
        if (entry) delete files[file];
        changed ||= entry !== undefined;
        continue;
      }
      if (!entry) {
        if (holding) files[file] = { tools: [tool] };
        changed ||= holding;
        continue;
      }
      if (state.kind !== 'parsed' || !entry.unverified) continue;
      const unverified = entry.unverified.filter((name) => state.servers.includes(name) && !owned.includes(name));
      if (unverified.length === entry.unverified.length) continue;
      if (unverified.length > 0) entry.unverified = unverified;
      else delete entry.unverified;
      changed = true;
    }
    return changed;
  });
}
