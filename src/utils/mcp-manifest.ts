import path from 'node:path';
import {
  managedMcpManifestPath,
  legacyManagedMcpManifestPath,
  managedMcpWorkspaceId,
  type ManagedMcpManifest,
  type ManagedMcpRecord,
} from '../types.js';
import { readJson, writeJsonAtomic, expandHome } from './fs.js';

/**
 * Load a project worktree's own managed-MCP manifest, migrating this worktree's
 * ownership records out of any pre-#374 shared file on first read.
 *
 * Each worktree now has its OWN file at
 * `<dataHome>/workspaces/<workspaceId>/managed-mcp.json` (see
 * managedMcpManifestPath). This removes the two hazards of a single shared file
 * in the partition: cross-worktree ownership bleed and lost updates under
 * concurrent read-modify-write.
 *
 * Compatibility: older installs kept everything in the shared
 * `<dataHome>/managed-mcp.json`, keyed by `<tool>:project` (or the interim
 * `<tool>:project:<id>`). When this worktree has no per-worktree file yet, we lift
 * the records belonging to THIS worktree out of the shared file:
 *  - a bare `<tool>:project` key is claimed only when the data home is
 *    workspace-local (legacy `<workspaceRoot>/.teamai`), where it is unambiguous;
 *  - a `<tool>:project:<thisWorkspaceId>` key is always this worktree's.
 *
 * Migration is made DURABLE here, independent of the caller: we first atomically
 * write the per-worktree destination file, and only AFTER that succeeds do we
 * best-effort remove the claimed keys from the shared file. Persisting inside the
 * loader (rather than relying on the caller to save) is required because callers
 * may be read-only (report) or may skip their write when nothing changed
 * (`reconcile` with `wrote === false`) — removing the source first in those cases
 * would orphan the records. Ordering (destination first, source second) means a
 * crash between the two leaves the records readable in BOTH files, never neither.
 *
 * `dryRun` suppresses all writes (preview): the migrated records are returned in
 * memory but neither file is touched.
 *
 * Returns the per-worktree manifest path plus its loaded contents. Callers mutate
 * `manifest` and persist with `saveProjectMcpManifest`.
 */
export async function loadProjectMcpManifest(
  dataHome: string,
  workspaceRoot: string,
  options: { dryRun?: boolean } = {},
): Promise<{ manifestPath: string; manifest: ManagedMcpManifest }> {
  const manifestPath = managedMcpManifestPath(dataHome, workspaceRoot);
  const existing = (await readJson<ManagedMcpManifest>(expandHome(manifestPath))) ?? null;
  if (existing) return { manifestPath, manifest: existing };

  // No per-worktree file yet — attempt one-time migration from any legacy source.
  // Two legacy locations must both be checked:
  //  1. `<dataHome>/managed-mcp.json` — the interim shared partition file (rounds
  //     before the per-worktree split), keyed `<tool>:project:<id>` or bare.
  //  2. `<workspaceRoot>/.teamai/managed-mcp.json` — the ORIGINAL pre-partition
  //     path. Even a partition install (data home under ~/.teamai) wrote the MCP
  //     manifest into the workspace's .teamai before this PR, so a plain
  //     `<dataHome>/managed-mcp.json` read misses it and the old ownership is
  //     lost on upgrade (uninstall then leaves the injected server behind).
  // When the two paths are the same file (legacy workspace-local data home) we
  // read it once.
  const manifest: ManagedMcpManifest = {};
  const sources: Array<{ path: string; workspaceLocal: boolean }> = [];
  const partitionShared = expandHome(legacyManagedMcpManifestPath(dataHome));
  const workspaceShared = expandHome(path.join(workspaceRoot, '.teamai', 'managed-mcp.json'));
  sources.push({ path: partitionShared, workspaceLocal: dataHome === path.join(workspaceRoot, '.teamai') });
  if (workspaceShared !== partitionShared) {
    // The original workspace-local path belongs unambiguously to THIS worktree.
    sources.push({ path: workspaceShared, workspaceLocal: true });
  }

  const cleanup: Array<{ path: string; shared: ManagedMcpManifest; keys: string[] }> = [];
  for (const src of sources) {
    const shared = (await readJson<ManagedMcpManifest>(src.path)) ?? null;
    if (!shared) continue;
    const migratedFrom: string[] = [];
    for (const [key, records] of Object.entries(shared)) {
      if (!Array.isArray(records)) continue;
      if (claimsThisWorkspace(key, workspaceRoot, src.workspaceLocal)) {
        const tool = key.split(':')[0];
        // Merge (a worktree could have records split across both sources).
        const destKey = `${tool}:project`;
        manifest[destKey] = mergeRecords(manifest[destKey], records);
        migratedFrom.push(key);
      }
    }
    if (migratedFrom.length > 0) cleanup.push({ path: src.path, shared, keys: migratedFrom });
  }
  if (cleanup.length > 0 && !options.dryRun) {
    // An existing destination ends migration on the next load. Publish all
    // sources together so a failed write cannot leave a partial migration.
    await writeJsonAtomic(expandHome(manifestPath), manifest);
    for (const src of cleanup) {
      for (const key of src.keys) delete src.shared[key];
      await writeJsonAtomic(src.path, src.shared).catch(() => {});
    }
  }
  return { manifestPath, manifest };
}

/** Merge two record lists by name (later wins), keeping ownership de-duplicated. */
function mergeRecords(a: ManagedMcpRecord[] | undefined, b: ManagedMcpRecord[]): ManagedMcpRecord[] {
  const byName = new Map<string, ManagedMcpRecord>();
  for (const r of a ?? []) byName.set(r.name, r);
  for (const r of b) byName.set(r.name, r);
  return Array.from(byName.values());
}

/** True when a shared-file key belongs to this worktree (see loadProjectMcpManifest). */
function claimsThisWorkspace(key: string, workspaceRoot: string, workspaceLocal: boolean): boolean {
  const parts = key.split(':');
  if (parts.length === 2 && parts[1] === 'project') return workspaceLocal; // bare `<tool>:project`
  if (parts.length === 3 && parts[1] === 'project') {
    return parts[2] === managedMcpWorkspaceId(workspaceRoot); // interim `<tool>:project:<id>`
  }
  return false;
}

/** Persist a per-worktree project manifest (atomic), pruning empty ownership keys. */
export async function saveProjectMcpManifest(
  manifestPath: string,
  manifest: ManagedMcpManifest,
): Promise<void> {
  for (const [key, records] of Object.entries(manifest)) {
    if (!Array.isArray(records) || records.length === 0) delete manifest[key];
  }
  await writeJsonAtomic(expandHome(manifestPath), manifest);
}

export type { ManagedMcpRecord };
