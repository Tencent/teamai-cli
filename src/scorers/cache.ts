import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { getBusinessRoot, getDataHome, getKnowledgeDir, isSelfMode, managedMcpWorkspaceId, type LocalConfig } from '../types.js';
import { readFileSafe, remove, writeJsonAtomic } from '../utils/fs.js';
import { log } from '../utils/logger.js';
import { isSafeNamespaceSegment, NAMESPACE_RULE } from '../manifest-schema.js';
import { resolveNamespacedItems, type NamespaceCandidate } from '../namespace-resolver.js';
import { isNamespaceDir, resolveResourceNamespaces, type NamespaceDeclarations } from '../resource-namespaces.js';
import { remotelyReachableRevision, revisionHoldsSources, withoutStaleTeamRevision, type ReachableRevision } from '../utils/team-revision.js';
import { formatScorerDiagnostic, parseScorer, type ScorerDefinition, type ScorerDiagnostic } from './definition.js';
import type { PinnedScorer } from './pin.js';

export type SyncScorerOptions = { scopeLabel?: string } & (
  | { dryRun?: boolean; everyNamespace?: undefined }
  /** `review --branch` has no member to resolve namespaces for: every file of every namespace is checked on its own. */
  | { dryRun: true; everyNamespace: true }
);

export interface SyncScorerResult {
  /** The names of the valid scorers, which steps may list. */
  cached: string[];
  invalid: ScorerDiagnostic[];
  /** The files of the valid scorers that ask for a `verified` judge, sorted. */
  verified: string[];
}

/** The cache stores the file's text and parses it again on load, so a cached definition is always one this teamai reads. */
const CacheEntrySchema = z.object({
  relativePath: z.string(),
  sourceHash: z.string(),
  teamRevision: z.string().optional(),
  content: z.string(),
  validatedAt: z.string(),
});

type CacheEntry = z.infer<typeof CacheEntrySchema>;

export type CachedScorer = Omit<CacheEntry, 'content'> & { definition: ScorerDefinition };

/** The team's scoring settings beside the scorers (`scorers/settings.ts`): not a scorer. */
export const SCORING_FILE = 'scoring.yaml';

const NOT_A_SCORER = 'not a scorer file; scorers/ holds <name>.md and <namespace>/<name>.md scorers, scoring.yaml settings and an optional README.md';

function cacheDir(config: LocalConfig): string {
  const home = getDataHome(config);
  // Self mode shares one data home across checkouts, and each checkout has its own scorers/.
  if (isSelfMode(config)) {
    return path.join(home, 'workspaces', managedMcpWorkspaceId(getBusinessRoot(config)), 'scorers', 'cache');
  }
  return path.join(home, 'scorers', 'cache');
}

function cachePath(config: LocalConfig, name: string): string {
  return path.join(cacheDir(config), `${name}.json`);
}

async function readCache(config: LocalConfig, name: string): Promise<CacheEntry | null> {
  const raw = await readFileSafe(cachePath(config, name));
  if (raw === null) return null;
  try {
    const entry = CacheEntrySchema.safeParse(JSON.parse(raw));
    return entry.success ? entry.data : null;
  } catch {
    return null;
  }
}

/** The scorer `name` as the last sync cached it, or null when it has no valid version. */
export async function loadCachedScorer(config: LocalConfig, name: string): Promise<CachedScorer | null> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return null;
  const entry = await readCache(config, name);
  const parsed = entry ? parseScorer(entry.relativePath, entry.content) : undefined;
  if (!entry || !parsed?.ok || parsed.definition.name !== name) return null;
  const { content: _content, ...rest } = entry;
  return { ...rest, definition: parsed.definition };
}

/** The names of the scorers with a valid cached version, sorted. */
export async function cachedScorerNames(config: LocalConfig): Promise<string[]> {
  const files = await fs.readdir(cacheDir(config)).catch(() => []);
  const names = files.filter((file) => file.endsWith('.json')).map((file) => file.slice(0, -'.json'.length)).sort();
  const valid = await Promise.all(names.map(async (name) => (await loadCachedScorer(config, name)) !== null));
  return names.filter((_, index) => valid[index]);
}

/** The scorers among `names` that have a valid cached version, pinned as they are cached now. A name without one is left out (D19). */
export async function pinScorers(config: LocalConfig, names: Iterable<string>): Promise<Record<string, PinnedScorer>> {
  const pins: Record<string, PinnedScorer> = {};
  for (const name of new Set(names)) {
    const entry = await readCache(config, name);
    if (!entry || !(await loadCachedScorer(config, name))) continue;
    pins[name] = { sourceHash: entry.sourceHash, ...(entry.teamRevision ? { teamRevision: entry.teamRevision } : {}), relativePath: entry.relativePath, content: entry.content };
  }
  return pins;
}

/** What a directory of `scorers/` holds, or nothing when it is missing, a symlink, or cannot be listed. */
async function scorerEntries(dir: string): Promise<Dirent[]> {
  try {
    const stat = await fs.lstat(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return [];
    return (await fs.readdir(dir, { withFileTypes: true })).sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  } catch {
    return [];
  }
}

/** The `<name>.md` files of `scorers/` and of each `scorers/<ns>/`, and every other entry as a diagnostic. */
async function scorerCandidates(dir: string): Promise<{ candidates: NamespaceCandidate<string>[]; invalid: ScorerDiagnostic[] }> {
  const candidates: NamespaceCandidate<string>[] = [];
  const invalid: ScorerDiagnostic[] = [];
  const walk = async (at: string, namespace: string | null): Promise<void> => {
    for (const entry of await scorerEntries(at)) {
      if (entry.name === 'README.md' || (entry.isFile() && entry.name === SCORING_FILE)) continue;
      const source = `scorers/${namespace === null ? '' : `${namespace}/`}${entry.name}`;
      if (entry.isFile() && entry.name.endsWith('.md')) {
        candidates.push({ name: entry.name.slice(0, -'.md'.length), source, namespace, value: path.join(at, entry.name) });
      } else if (namespace === null && entry.isDirectory() && isSafeNamespaceSegment(entry.name)) {
        await walk(path.join(at, entry.name), entry.name);
      } else if (namespace === null && entry.isDirectory()) {
        invalid.push({ file: source, message: `not a scorer namespace; ${NAMESPACE_RULE}` });
      } else {
        invalid.push({ file: source, message: NOT_A_SCORER });
      }
    }
  };
  await walk(dir, null);
  return { candidates, invalid };
}

function namespacesOf(candidates: readonly NamespaceCandidate<string>[]): string[] {
  return [...new Set(candidates.flatMap((candidate) => candidate.namespace ?? []))];
}

/**
 * How each of `dirs` under `scorers/` reaches this member: a namespace (`isNamespaceDir`) is `active` when this member
 * has it and withheld otherwise, and any other dir is `shared` like `scorers/` itself. With no role and no project to
 * filter by, every dir is active; when the manifest cannot be read, none is, as for prompts.
 */
export async function scorerNamespaces(config: LocalConfig, dirs: readonly string[]): Promise<{ active: string[]; shared: string[] }> {
  if (dirs.length === 0) return { active: [], shared: [] };
  const resolved = await resolveResourceNamespaces(config).catch(() => undefined);
  if (resolved === undefined) return { active: [], shared: [] };
  if (resolved === null) return { active: [...dirs], shared: [] };
  const active = resolved.activeNamespaces.scorers ?? [];
  const declared = new Set([...active, ...resolved.inactiveScorersNamespaces]);
  const declarations: NamespaceDeclarations = { manifestFree: false, declares: (_axis, dir) => declared.has(dir) };
  return {
    active: dirs.filter((dir) => active.includes(dir)),
    shared: dirs.filter((dir) => !isNamespaceDir('scorers', dir, declarations)),
  };
}

async function dropUnsettled(config: LocalConfig, settled: Set<string>): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(cacheDir(config));
  } catch {
    return;
  }
  for (const name of names) {
    const stem = name.replace(/\.json$/, '');
    if (stem !== name && !settled.has(stem)) await remove(cachePath(config, stem));
  }
}

/**
 * Validate each `scorers/<name>.md` and `scorers/<dir>/<name>.md` this member receives, and cache only the files that
 * pass. A namespace scorer replaces the root scorer of its name; one name in two active namespaces, or twice among the
 * shared scorers, caches neither.
 * `README.md` is not a scorer and is skipped; any other file is reported. The cache then holds only the scorers this
 * sync found valid. With `everyNamespace`, no file replaces or conflicts with another. Nothing here fails the caller.
 */
export async function syncScorerDefinitions(config: LocalConfig, options: SyncScorerOptions = {}): Promise<SyncScorerResult> {
  const knowledgeRoot = getKnowledgeDir(config);
  const { candidates, invalid } = await scorerCandidates(path.join(knowledgeRoot, 'scorers'));
  const result: SyncScorerResult = { cached: [], invalid, verified: [] };
  const { active, shared } = options.everyNamespace ? { active: namespacesOf(candidates), shared: [] } : await scorerNamespaces(config, namespacesOf(candidates));
  const files: Array<{ relativePath: string; full: string }> = [];
  const byName = new Map<string, NamespaceCandidate<string>[]>();
  for (const candidate of candidates) {
    const key = options.everyNamespace ? candidate.source : candidate.name;
    const placed = candidate.namespace !== null && shared.includes(candidate.namespace) ? { ...candidate, namespace: null } : candidate;
    byName.set(key, [...byName.get(key) ?? [], placed]);
  }
  for (const group of byName.values()) {
    const resolution = resolveNamespacedItems(group, active);
    if (resolution.kind === 'conflict') {
      const { name, first, second } = resolution;
      result.invalid.push({
        file: first.source,
        message: resolution.reason === 'duplicate'
          ? `scorer "${name}" is shared twice (${first.source} and ${second.source}), so neither is used`
          : `scorer "${name}" is in two active namespaces (${first.source} and ${second.source}), so neither is used`,
      });
      continue;
    }
    files.push(...resolution.items.map((item) => ({ relativePath: item.source, full: item.value })));
  }
  // Asked on the first valid file: a team without scorers starts no git here.
  let reachable: Promise<ReachableRevision | undefined> | undefined;
  let wrote = 0;
  for (const { relativePath, full } of files) {
    const content = await readFileSafe(full);
    if (content === null) {
      result.invalid.push({ file: relativePath, message: 'could not be read' });
      continue;
    }
    const parsed = parseScorer(relativePath, content);
    if (!parsed.ok) {
      result.invalid.push(...parsed.diagnostics);
      continue;
    }
    const { name } = parsed.definition;
    if (parsed.definition.isolation === 'verified') result.verified.push(relativePath);
    const sourceHash = createHash('sha256').update(content).digest('hex');
    const revision = await (reachable ??= remotelyReachableRevision(knowledgeRoot));
    const holds = await revisionHoldsSources(knowledgeRoot, revision, [{ path: relativePath, content }]);
    const previous = await withoutStaleTeamRevision(knowledgeRoot, await readCache(config, name));
    const sameSource = previous?.sourceHash === sourceHash && previous.relativePath === relativePath;
    const teamRevision = (holds ? revision?.revision : undefined) ?? (sameSource ? previous.teamRevision : undefined);
    if (!result.cached.includes(name)) result.cached.push(name);
    if (options.dryRun || (sameSource && previous.teamRevision === teamRevision)) continue;
    await writeJsonAtomic(cachePath(config, name), {
      relativePath,
      sourceHash,
      ...(teamRevision ? { teamRevision } : {}),
      content,
      validatedAt: new Date().toISOString(),
    } satisfies CacheEntry);
    wrote += 1;
  }
  if (!options.dryRun) await dropUnsettled(config, new Set(result.cached));
  result.invalid.sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0));
  result.verified.sort();

  for (const diagnostic of result.invalid) log.warn(`[scorers] ${formatScorerDiagnostic(diagnostic)}`);
  const scope = options.scopeLabel ?? config.scope;
  if (options.dryRun && result.cached.length > 0) {
    log.info(`[${scope}] [dry-run] Would cache ${result.cached.length} scorer${result.cached.length === 1 ? '' : 's'}`);
  } else if (wrote > 0) {
    log.success(`[${scope}] Synced ${wrote} scorer${wrote === 1 ? '' : 's'}`);
  }
  return result;
}
