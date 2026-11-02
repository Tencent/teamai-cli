/**
 * Benchmark suites as a member receives them: `syncTeamDefinitions` syncs the team's scorers and workflows, then parses
 * each suite under benchmarks/ and caches the valid ones, where `loadCachedSuite` reads them back. A suite's
 * diagnostics and the scorers it lists that do not exist join the workflows' own.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { isModelAlias, loadTeamModelAliases } from '../models/aliases.js';
import { resolveNamespacedItems, type NamespaceCandidate } from '../namespace-resolver.js';
import { loadProjectsManifest } from '../projects.js';
import { resolveResourceNamespaces } from '../resource-namespaces.js';
import { loadRolesManifestIfPresent } from '../roles.js';
import { getBusinessRoot, getDataHome, getKnowledgeDir, isSelfMode, managedMcpWorkspaceId, type LocalConfig } from '../types.js';
import { readFileSafe, remove, writeJsonAtomic } from '../utils/fs.js';
import { log } from '../utils/logger.js';
import {
  dropsKeptVersion, formatUnknownScorer, syncWorkflowDefinitions, workflowFileNames,
  type SyncWorkflowOptions, type SyncWorkflowResult, type UnknownScorer,
} from '../workflow/cache.js';
import { formatDiagnostic } from '../workflow/parse.js';
import type { WorkflowDiagnostic } from '../workflow/types.js';
import { checkFilesNamed, parseSuite, type SourceFile, type Suite, type SuiteFile } from './suite.js';
import { BENCHMARK_NAME } from './terms.js';

export interface SyncTeamResult extends SyncWorkflowResult {
  /** The valid benchmark suites of the same tree. Their diagnostics are in `invalid`. */
  benchmarks: Suite[];
}

/**
 * `syncWorkflowDefinitions`, then the suites of the same tree: their diagnostics join `invalid`, and the scorers they
 * list that the sync did not cache join `unknownScorers`. Nothing here fails the caller.
 */
export async function syncTeamDefinitions(config: LocalConfig, options: SyncWorkflowOptions = {}): Promise<SyncTeamResult> {
  const result: SyncTeamResult = { ...await syncWorkflowDefinitions(config, options), benchmarks: [] };
  await syncSuites(config, options, result);
  return result;
}

/**
 * The cache stores a suite's files and parses them again on load, so a cached suite is always one this teamai reads. The
 * files its check.add entries name are bytes, so a check reads them as they were when they were cached.
 */
const SourceFileSchema = z.object({ relativePath: z.string(), content: z.string() });
const SuiteFileSchema = z.object({ relativePath: z.string(), base64: z.string(), mode: z.enum(['100644', '100755']) }) satisfies z.ZodType<SuiteFile>;
const SuiteCacheSchema = z.object({ suite: SourceFileSchema, tasks: z.array(SourceFileSchema), files: z.array(SuiteFileSchema).default([]), validatedAt: z.string() });

/**
 * The files of the suite directory `dir`, which team files name `relativeDir`, that `tasks`' check.add entries name: a
 * file, or every file under a directory but its dot entries, as bytes with its executable bit. Read the way workflow
 * files are: a symlink is not a file, and a path through a symlinked directory names none, so nothing outside `dir` is
 * read.
 */
export async function readSuiteFiles(dir: string, relativeDir: string, tasks: readonly SourceFile[]): Promise<SuiteFile[]> {
  const root = await fs.realpath(dir).catch(() => undefined);
  if (root === undefined) return [];
  const files: SuiteFile[] = [];
  const visit = async (relative: string): Promise<void> => {
    const full = path.join(dir, ...relative.split('/'));
    // realpath resolves every link on the way, so a path that is one, or goes through one, is not the path itself.
    if (await fs.realpath(full).catch(() => undefined) !== path.join(root, ...relative.split('/'))) return;
    const stat = await fs.lstat(full).catch(() => undefined);
    if (stat?.isFile()) {
      const bytes = await fs.readFile(full).catch(() => undefined);
      if (bytes) files.push({ relativePath: `${relativeDir}/${relative}`, base64: bytes.toString('base64'), mode: (stat.mode & 0o100) !== 0 ? '100755' : '100644' });
    } else if (stat?.isDirectory()) {
      // Dot entries, such as .DS_Store or an editor's swap file, differ from machine to machine.
      for (const name of await fs.readdir(full).catch((): string[] => [])) if (!name.startsWith('.')) await visit(`${relative}/${name}`);
    }
  };
  for (const from of checkFilesNamed(tasks)) await visit(from);
  return files;
}

function suiteCacheDir(config: LocalConfig): string {
  const home = getDataHome(config);
  // Self mode shares one data home across checkouts, and each checkout has its own benchmarks/.
  if (isSelfMode(config)) {
    return path.join(home, 'workspaces', managedMcpWorkspaceId(getBusinessRoot(config)), 'benchmarks', 'cache');
  }
  return path.join(home, 'benchmarks', 'cache');
}

function suiteCachePath(config: LocalConfig, name: string): string {
  return path.join(suiteCacheDir(config), `${name}.json`);
}

/** The last valid version of suite `name` this member received, or null when it has none. */
export async function loadCachedSuite(config: LocalConfig, name: string): Promise<Suite | null> {
  if (!BENCHMARK_NAME.test(name)) return null;
  const raw = await readFileSafe(suiteCachePath(config, name));
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const entry = SuiteCacheSchema.safeParse(value);
  if (!entry.success) return null;
  const parsed = parseSuite(entry.data);
  return parsed.ok && parsed.suite.name === name ? parsed.suite : null;
}

/**
 * Which `benchmarks/<dir>/` are namespaces, and which of those this sync reads. A directory is a namespace only where a
 * role or project declares it under `resources.benchmarks`; any other holds a shared suite. With no role and no project
 * to filter by, or with `everyNamespace`, every declared namespace is read. Undefined when a manifest cannot be read.
 */
async function suiteNamespaces(config: LocalConfig, everyNamespace: boolean): Promise<{ declared: ReadonlySet<string>; active: string[] } | undefined> {
  try {
    const root = getKnowledgeDir(config);
    const [roles, projects] = await Promise.all([loadRolesManifestIfPresent(root), loadProjectsManifest(root)]);
    const declared = new Set([...roles?.roles ?? [], ...projects?.projects ?? []].flatMap((owner) => owner.resources.benchmarks ?? []));
    if (everyNamespace || declared.size === 0) return { declared, active: [...declared] };
    const resolved = await resolveResourceNamespaces(config);
    return { declared, active: resolved === null ? [...declared] : resolved.activeNamespaces.benchmarks ?? [] };
  } catch {
    return undefined;
  }
}

/**
 * The files of each suite under benchmarks/ this member receives, read the way workflow files are: symlinks are not
 * files. A namespace suite replaces the shared suite of its name; one name in two active namespaces reads neither.
 */
async function suiteSources(config: LocalConfig, everyNamespace: boolean): Promise<{
  sources: Array<{ suite: SourceFile; tasks: SourceFile[]; files: SuiteFile[] }>;
  invalid: WorkflowDiagnostic[];
}> {
  const root = getKnowledgeDir(config);
  const read = async (relativePath: string): Promise<SourceFile | undefined> => {
    const full = path.join(root, relativePath);
    const stat = await fs.lstat(full).catch(() => undefined);
    if (!stat?.isFile()) return undefined;
    const content = await readFileSafe(full);
    return content === null ? undefined : { relativePath, content };
  };
  const directories = async (relativePath: string): Promise<string[]> => {
    const full = path.join(root, relativePath);
    const stat = await fs.lstat(full).catch(() => undefined);
    if (!stat?.isDirectory()) return [];
    return (await fs.readdir(full, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  };
  const invalid: WorkflowDiagnostic[] = [];
  const dirs = await directories('benchmarks');
  // Read the manifests only for a tree with suites, as for workflows: push syncs before its pull refreshes them.
  const namespaces = dirs.length > 0 ? await suiteNamespaces(config, everyNamespace) : undefined;
  if (namespaces === undefined) return { sources: [], invalid };
  const candidates: NamespaceCandidate<SourceFile>[] = [];
  for (const dir of dirs) {
    const own = await read(`benchmarks/${dir}/suite.yaml`);
    if (!namespaces.declared.has(dir)) {
      if (own) candidates.push({ name: dir, source: own.relativePath, namespace: null, value: own });
      continue;
    }
    if (!namespaces.active.includes(dir)) continue;
    if (own) {
      invalid.push({ file: own.relativePath, line: 1, column: 1, field: '(file)', message: `benchmarks/${dir} is a namespace; put the suite in benchmarks/${dir}/<suite>/` });
    }
    for (const name of await directories(`benchmarks/${dir}`)) {
      const suite = await read(`benchmarks/${dir}/${name}/suite.yaml`);
      if (suite) candidates.push({ name, source: suite.relativePath, namespace: dir, value: suite });
    }
  }
  const byName = new Map<string, NamespaceCandidate<SourceFile>[]>();
  for (const candidate of candidates) {
    const key = everyNamespace ? candidate.source : candidate.name;
    byName.set(key, [...byName.get(key) ?? [], candidate]);
  }
  const sources: Array<{ suite: SourceFile; tasks: SourceFile[]; files: SuiteFile[] }> = [];
  for (const group of byName.values()) {
    const resolution = resolveNamespacedItems(group, namespaces.active);
    if (resolution.kind === 'conflict') {
      const { name, first, second } = resolution;
      invalid.push({
        file: first.source,
        line: 1,
        column: 1,
        field: '(root)',
        code: 'benchmark_namespace_conflict',
        message: `Suite "${name}" is defined in two active namespaces (${first.source} and ${second.source}); neither runs`,
      });
      continue;
    }
    for (const { value: suite } of resolution.items) {
      const dir = path.posix.dirname(suite.relativePath);
      const tasks = (await Promise.all((await workflowFileNames(path.join(root, dir, 'tasks'))).map((name) => read(`${dir}/tasks/${name}`)))).flatMap((task) => (task ? [task] : []));
      sources.push({ suite, tasks, files: await readSuiteFiles(path.join(root, dir), dir, tasks) });
    }
  }
  return { sources, invalid };
}

/**
 * Parse each suite this member receives, cache the valid ones, and keep the last valid version of a suite this revision
 * breaks, unless a diagnostic has a code. Suites this sync settled nothing for leave the cache.
 */
async function syncSuites(config: LocalConfig, options: SyncWorkflowOptions, result: SyncTeamResult): Promise<void> {
  const { sources, invalid } = await suiteSources(config, options.everyNamespace === true);
  result.invalid.push(...invalid);
  for (const diagnostic of invalid) log.warn(`[benchmarks] ${formatDiagnostic(diagnostic)}`);
  const aliases = sources.length > 0 ? await loadTeamModelAliases(config).catch(() => undefined) : undefined;
  const isAlias = aliases?.ok ? (model: string) => isModelAlias(aliases, model) : undefined;
  const settled = new Set<string>();
  for (const source of sources) {
    const parsed = parseSuite({ ...source, ...(isAlias ? { isAlias } : {}) });
    result.invalid.push(...parsed.diagnostics);
    for (const diagnostic of parsed.diagnostics) log.warn(`[benchmarks] ${formatDiagnostic(diagnostic)}`);
    const name = path.posix.basename(path.posix.dirname(source.suite.relativePath));
    if (parsed.ok) {
      for (const warning of parsed.warnings) log.warn(`[benchmarks] ${formatDiagnostic(warning)}`);
      for (const scorer of parsed.suite.scorers.filter((listed) => !result.scorers.cached.includes(listed))) {
        const unknown: UnknownScorer = { kind: 'suite', file: source.suite.relativePath, suite: parsed.suite.name, scorer };
        result.unknownScorers.push(unknown);
        log.warn(`[benchmarks] ${formatUnknownScorer(unknown)}`);
      }
      result.benchmarks.push(parsed.suite);
      settled.add(name);
      if (!options.dryRun) {
        await writeJsonAtomic(suiteCachePath(config, name), { ...source, validatedAt: new Date().toISOString() } satisfies z.infer<typeof SuiteCacheSchema>);
      }
      continue;
    }
    if (!dropsKeptVersion(parsed.diagnostics) && await loadCachedSuite(config, name)) {
      settled.add(name);
      log.warn(`[benchmarks] Kept the last valid version of ${name}; this revision was not cached`);
    } else {
      log.warn(`[benchmarks] ${source.suite.relativePath} has no runnable version`);
    }
  }
  if (options.dryRun) return;
  let cached: string[];
  try {
    cached = await fs.readdir(suiteCacheDir(config));
  } catch {
    return;
  }
  for (const file of cached) {
    const name = file.replace(/\.json$/, '');
    if (name !== file && !settled.has(name)) await remove(suiteCachePath(config, name));
  }
}
