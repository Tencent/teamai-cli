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
import { resolveResourceNamespaces } from '../resource-namespaces.js';
import { resolveNamespacedItems, type NamespaceCandidate } from '../namespace-resolver.js';

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

interface WorkflowCandidateFile {
  relativePath: string;
  fullPath: string;
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

  // Scan root workflows and namespaced workflows
  const candidates: Array<NamespaceCandidate<WorkflowCandidateFile>> = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.yaml')) {
        const name = entry.name.replace(/\.yaml$/, '');
        const relativePath = `workflows/${entry.name}`;
        candidates.push({
          name,
          source: relativePath,
          namespace: null,
          value: { relativePath, fullPath: path.join(dir, entry.name) },
        });
      } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
        const subDir = path.join(dir, entry.name);
        try {
          const subEntries = await fs.readdir(subDir, { withFileTypes: true });
          for (const sub of subEntries) {
            if (sub.isFile() && sub.name.endsWith('.yaml')) {
              const name = sub.name.replace(/\.yaml$/, '');
              const relativePath = `workflows/${entry.name}/${sub.name}`;
              candidates.push({
                name,
                source: relativePath,
                namespace: entry.name,
                value: { relativePath, fullPath: path.join(subDir, sub.name) },
              });
            }
          }
        } catch {
          // ignore unreadable subdir
        }
      }
    }
  } catch {
    return result;
  }

  // Resolve against active namespaces
  const nsContext = await resolveResourceNamespaces(config);
  const activeNs = nsContext ? (nsContext.activeNamespaces.skills ?? []) : [];
  const resolution = resolveNamespacedItems(candidates, activeNs);

  if (resolution.kind === 'conflict') {
    const diagnostic: WorkflowDiagnostic = {
      file: resolution.first.source,
      line: 1,
      column: 1,
      field: '(namespace)',
      message: `workflow "${resolution.name}" conflicts between ${resolution.first.source} and ${resolution.second.source}`,
    };
    result.invalid.push(diagnostic);
    log.warn(`[workflows] ${formatDiagnostic(diagnostic)}`);
    return result;
  }

  const resolvedItems = resolution.items;

  // First pass: parse each workflow file
  const parsedByWorkflow = new Map<string, {
    item: typeof resolvedItems[number];
    definition: WorkflowDefinition;
    content: string;
    promptFileLocations: Record<number, { line: number; column: number }>;
  }>();

  for (const item of resolvedItems) {
    const { relativePath, fullPath } = item.value;
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(fullPath);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) continue;
    const content = await readFileSafe(fullPath);
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
      if (parsed.diagnostics.some((d) => d.code === 'unknown_key')) {
        if (!options.dryRun) await remove(cachePath(config, item.name));
        result.unrunnable.push(relativePath);
        log.warn(`[workflows] ${relativePath} has no runnable version`);
        continue;
      }
      const previous = await readCache(config, item.name);
      if (previous) {
        result.kept.push(item.name);
        log.warn(`[workflows] Kept the last valid version of ${item.name}; this revision was not cached`);
      } else {
        result.unrunnable.push(relativePath);
        log.warn(`[workflows] ${relativePath} has no runnable version`);
      }
      continue;
    }

    parsedByWorkflow.set(item.name, {
      item,
      definition: parsed.definition,
      content,
      promptFileLocations: parsed.promptFileLocations,
    });
  }

  // Cross-file validation: sub-workflow existence and recursion
  const subWorkflowDeps = new Map<string, string[]>();
  for (const [name, entry] of parsedByWorkflow) {
    const deps: string[] = [];
    for (const [stepIndex, step] of entry.definition.steps.entries()) {
      if (typeof step.workflow === 'string') {
        const target = step.workflow;
        deps.push(target);
        // Check if target workflow exists in parsed files or cached files
        const exists = parsedByWorkflow.has(target) || (await readCache(config, target)) !== null;
        if (!exists) {
          const diag: WorkflowDiagnostic = {
            file: entry.item.source,
            line: 1,
            column: 1,
            field: `steps[${stepIndex}].workflow`,
            message: `referenced sub-workflow "${target}" does not exist`,
          };
          result.invalid.push(diag);
          log.warn(`[workflows] ${formatDiagnostic(diag)}`);
        }
      }
    }
    subWorkflowDeps.set(name, deps);
  }

  // Detect recursion cycles across file sub-workflows
  const recursionCycles = new Set<string>();
  function checkSubWorkflowRecursion(start: string, current: string, callPath: string[]): boolean {
    const deps = subWorkflowDeps.get(current) ?? [];
    for (const dep of deps) {
      if (dep === start) {
        callPath.push(dep);
        return true;
      }
      if (!callPath.includes(dep)) {
        callPath.push(dep);
        if (checkSubWorkflowRecursion(start, dep, callPath)) return true;
        callPath.pop();
      }
    }
    return false;
  }

  for (const [name, entry] of parsedByWorkflow) {
    const pathTrace = [name];
    if (checkSubWorkflowRecursion(name, name, pathTrace)) {
      const cycleKey = pathTrace.join(' -> ');
      if (!recursionCycles.has(cycleKey)) {
        recursionCycles.add(cycleKey);
        const stepIndex = entry.definition.steps.findIndex((s) => s.workflow === pathTrace[1] || s.workflow === name);
        const diag: WorkflowDiagnostic = {
          file: entry.item.source,
          line: 1,
          column: 1,
          field: stepIndex >= 0 ? `steps[${stepIndex}].workflow` : 'steps',
          message: `sub-workflow forms a recursion cycle: ${cycleKey}`,
        };
        result.invalid.push(diag);
        log.warn(`[workflows] ${formatDiagnostic(diag)}`);
      }
    }
  }

  // Filter out any workflows that had cross-file diagnostics
  const invalidFiles = new Set(result.invalid.map((d) => d.file));

  let wrote = 0;
  for (const [name, entry] of parsedByWorkflow) {
    if (invalidFiles.has(entry.item.source)) {
      const previous = await readCache(config, name);
      if (previous) {
        result.kept.push(name);
        log.warn(`[workflows] Kept the last valid version of ${name}; this revision was not cached`);
      } else {
        result.unrunnable.push(entry.item.source);
        log.warn(`[workflows] ${entry.item.source} has no runnable version`);
      }
      continue;
    }

    const resolved = await resolvePromptFiles(config, entry.definition, entry.promptFileLocations, entry.item.source);
    if (!resolved.ok) {
      result.invalid.push(...resolved.diagnostics);
      for (const diagnostic of resolved.diagnostics) log.warn(`[workflows] ${formatDiagnostic(diagnostic)}`);
      const previous = await readCache(config, name);
      if (previous) {
        result.kept.push(name);
        log.warn(`[workflows] Kept the last valid version of ${name}; this revision was not cached`);
      } else {
        result.unrunnable.push(entry.item.source);
        log.warn(`[workflows] ${entry.item.source} has no runnable version`);
      }
      continue;
    }

    const hash = createHash('sha256').update(entry.content);
    for (const source of resolved.sources) {
      hash.update('\0').update(source.path).update('\0').update(source.content);
    }
    const sourceHash = hash.digest('hex');
    const previous = await readCache(config, name);
    result.cached.push(name);
    if (options.dryRun || previous?.sourceHash === sourceHash) continue;
    await writeJsonAtomic(cachePath(config, name), {
      relativePath: entry.item.source,
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
      assertWithinRoot(path.join(root, 'prompts'), target);
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
        message: `prompt_file "${step.promptFile}" must be a readable, non-symlink file under prompts/`,
      });
      continue;
    }
    sources.push({ path: step.promptFile, content: prompt });
    steps[index] = { ...step, prompt };
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, definition: { ...definition, steps }, sources };
}
