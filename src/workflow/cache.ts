import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { log } from '../utils/logger.js';
import { pathExists, readFileSafe, remove, writeJsonAtomic } from '../utils/fs.js';
import {
  getBusinessRoot,
  getDataHome,
  getKnowledgeDir,
  isSelfMode,
  managedMcpWorkspaceId,
  type LocalConfig,
} from '../types.js';
import { formatDiagnostic, parseWorkflow } from './parse.js';
import type { CachedWorkflow, WorkflowDefinition, WorkflowDiagnostic } from './types.js';
import { assertSafePath, assertWithinRoot } from '../utils/path-safety.js';

export interface SyncWorkflowOptions {
  dryRun?: boolean;
  scopeLabel?: string;
}

export interface SyncWorkflowResult {
  cached: string[];
  kept: string[];
  invalid: WorkflowDiagnostic[];
  unrunnable: string[];
}

function cacheDir(config: LocalConfig): string {
  const home = getDataHome(config);
  // Self mode shares one data home across checkouts, and each checkout has its own workflows/.
  if (isSelfMode(config)) {
    return path.join(home, 'workspaces', managedMcpWorkspaceId(getBusinessRoot(config)), 'workflows', 'cache');
  }
  return path.join(home, 'workflows', 'cache');
}

function cachePath(config: LocalConfig, name: string): string {
  return path.join(cacheDir(config), `${name}.json`);
}

async function readCache(config: LocalConfig, name: string): Promise<CachedWorkflow | null> {
  const raw = await readFileSafe(cachePath(config, name));
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const cached = value as CachedWorkflow;
    if (cached.definition?.schemaVersion !== 'v1alpha1' || cached.definition.name !== name) return null;
    return cached;
  } catch {
    return null;
  }
}

/** The last validated definition for `name`, or null when this file has never been valid. */
export async function loadCachedWorkflow(config: LocalConfig, name: string): Promise<CachedWorkflow | null> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return null;
  return readCache(config, name);
}

async function dropCachesForMissingFiles(config: LocalConfig): Promise<void> {
  const dir = cacheDir(config);
  if (!await pathExists(dir)) return;
  const knowledge = path.resolve(getKnowledgeDir(config));
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const cached = await readCache(config, name.replace(/\.json$/, ''));
    if (!cached) continue;
    const source = path.resolve(knowledge, cached.relativePath);
    const inside = source === knowledge || source.startsWith(`${knowledge}${path.sep}`);
    if (!inside || !await pathExists(source)) await remove(cachePath(config, cached.definition.name));
  }
}

/**
 * Validate each `workflows/*.yaml` on its own and cache only files that pass.
 * An invalid file keeps its last cached definition; a file that was never valid
 * stays unrunnable. Nothing here fails the caller.
 */
export async function syncWorkflowDefinitions(
  config: LocalConfig,
  options: SyncWorkflowOptions = {},
): Promise<SyncWorkflowResult> {
  const result: SyncWorkflowResult = { cached: [], kept: [], invalid: [], unrunnable: [] };
  const dir = path.join(getKnowledgeDir(config), 'workflows');
  if (!options.dryRun) await dropCachesForMissingFiles(config);
  let dirStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    dirStat = await fs.lstat(dir);
  } catch {
    return result;
  }
  // readdir follows a directory symlink, so reject the directory itself before listing it.
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return result;

  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((name) => name.endsWith('.yaml')).sort();
  } catch {
    return result;
  }

  let wrote = 0;
  for (const name of names) {
    const relativePath = `workflows/${name}`;
    const full = path.join(dir, name);
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(full);
    } catch {
      continue;
    }
    // A symlink is not a workflow file, even when the target is a YAML file outside this directory.
    if (stat.isSymbolicLink() || !stat.isFile()) continue;
    const content = await readFileSafe(full);
    if (content === null) {
      const diagnostic: WorkflowDiagnostic = {
        file: relativePath,
        line: 1,
        column: 1,
        field: '(root)',
        message: 'workflow file could not be read',
      };
      result.invalid.push(diagnostic);
      log.warn(`[workflows] ${formatDiagnostic(diagnostic)}`);
      continue;
    }
    const parsed = parseWorkflow(relativePath, content);
    if (!parsed.ok) {
      result.invalid.push(...parsed.diagnostics);
      for (const diagnostic of parsed.diagnostics) log.warn(`[workflows] ${formatDiagnostic(diagnostic)}`);
      const stem = name.replace(/\.yaml$/, '');
      const previous = await readCache(config, stem);
      if (previous) {
        result.kept.push(stem);
        log.warn(`[workflows] Kept the last valid version of ${stem}; this revision was not cached`);
      } else {
        result.unrunnable.push(relativePath);
        log.warn(`[workflows] ${relativePath} has no runnable version`);
      }
      continue;
    }
    const resolved = await resolvePromptFiles(config, parsed.definition, parsed.promptFileLocations, relativePath);
    if (!resolved.ok) {
      result.invalid.push(...resolved.diagnostics);
      for (const diagnostic of resolved.diagnostics) log.warn(`[workflows] ${formatDiagnostic(diagnostic)}`);
      const previous = await readCache(config, parsed.definition.name);
      if (previous) {
        result.kept.push(parsed.definition.name);
        log.warn(`[workflows] Kept the last valid version of ${parsed.definition.name}; this revision was not cached`);
      } else {
        result.unrunnable.push(relativePath);
        log.warn(`[workflows] ${relativePath} has no runnable version`);
      }
      continue;
    }
    const hash = createHash('sha256').update(content);
    for (const source of resolved.sources) {
      hash.update('\0').update(source.path).update('\0').update(source.content);
    }
    const sourceHash = hash.digest('hex');
    const previous = await readCache(config, parsed.definition.name);
    result.cached.push(parsed.definition.name);
    if (options.dryRun || previous?.sourceHash === sourceHash) continue;
    await writeJsonAtomic(cachePath(config, parsed.definition.name), {
      relativePath,
      sourceHash,
      definition: resolved.definition,
      validatedAt: new Date().toISOString(),
    } satisfies CachedWorkflow);
    wrote += 1;
  }

  const scope = options.scopeLabel ?? config.scope;
  if (options.dryRun && result.cached.length > 0) {
    log.info(`[${scope}] [dry-run] Would cache ${result.cached.length} workflow${result.cached.length === 1 ? '' : 's'}`);
  } else if (wrote > 0) {
    log.success(`[${scope}] Synced ${wrote} workflow${wrote === 1 ? '' : 's'}`);
  }
  return result;
}

async function resolvePromptFiles(
  config: LocalConfig,
  definition: WorkflowDefinition,
  locations: Record<number, { line: number; column: number }>,
  workflowFile: string,
): Promise<
  | { ok: true; definition: WorkflowDefinition; sources: Array<{ path: string; content: string }> }
  | { ok: false; diagnostics: WorkflowDiagnostic[] }
> {
  const root = path.resolve(config.repo.localPath);
  const diagnostics: WorkflowDiagnostic[] = [];
  const sources: Array<{ path: string; content: string }> = [];
  const steps = [...definition.steps];
  for (const [index, step] of definition.steps.entries()) {
    if (!step.promptFile) continue;
    const target = path.resolve(root, step.promptFile);
    const location = locations[index] ?? { line: 1, column: 1 };
    let prompt: string | null = null;
    try {
      assertWithinRoot(root, target);
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('not a regular file');
      assertSafePath(target, [root]);
      prompt = await readFileSafe(target);
      if (prompt === null) throw new Error('unreadable');
    } catch {
      diagnostics.push({
        file: workflowFile,
        line: location.line,
        column: location.column,
        field: `steps[${index}].prompt_file`,
        message: `prompt_file "${step.promptFile}" must be a readable, non-symlink file inside the team repo`,
      });
      continue;
    }
    sources.push({ path: step.promptFile, content: prompt });
    steps[index] = { ...step, prompt };
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, definition: { ...definition, steps }, sources };
}
