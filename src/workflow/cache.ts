import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { syncScorerDefinitions, type SyncScorerOptions, type SyncScorerResult } from '../scorers/cache.js';
import { log } from '../utils/logger.js';
import { pathExists, readFileSafe, remove, writeJsonAtomic } from '../utils/fs.js';
import { isSafeNamespaceSegment } from '../manifest-schema.js';
import { resolveResourceNamespaces } from '../resource-namespaces.js';
import { resolveNamespacedItems, type NamespaceCandidate } from '../namespace-resolver.js';
import {
  getBusinessRoot,
  getDataHome,
  getKnowledgeDir,
  isSelfMode,
  managedMcpWorkspaceId,
  type LocalConfig,
} from '../types.js';
import { formatDiagnostic, parseWorkflow, promptFileDiagnostics, stepField } from './parse.js';
import type { WorkflowFiles } from './parse-context.js';
import type { CachedWorkflow, WorkflowDefinition, WorkflowDiagnostic, WorkflowStep } from './types.js';
import { assertSafePath, assertWithinRoot } from '../utils/path-safety.js';
import { createGit } from '../utils/git.js';
import {
  remotelyReachableRevision, revisionHoldsSources, withoutStaleTeamRevision, type ReachableRevision,
} from '../utils/team-revision.js';

export type SyncWorkflowOptions = SyncScorerOptions;

export interface SyncWorkflowResult {
  cached: string[];
  kept: string[];
  invalid: WorkflowDiagnostic[];
  unrunnable: string[];
  /** The scorers of the same tree, synced first. */
  scorers: SyncScorerResult;
  /** Scorers a step lists that `scorers` has no valid version of. The workflow still runs; the step runs without them. */
  unknownScorers: UnknownScorer[];
}

export interface UnknownScorer {
  file: string;
  /** The step's path, such as `check.review`. */
  step: string;
  scorer: string;
}

export function formatUnknownScorer({ file, step, scorer }: UnknownScorer): string {
  return `${file}: step "${step}" lists scorer "${scorer}", which has no valid scorers/${scorer}.md; the step runs without it`;
}

/** The scorers a definition's steps list, including inside its inline workflows, with each step's path. */
function scorersListedBy(definition: { steps: WorkflowStep[] }, prefix = ''): Array<{ step: string; scorer: string }> {
  return definition.steps.flatMap((step) => [
    ...(step.scorers?.names ?? []).map((scorer) => ({ step: `${prefix}${step.id}`, scorer })),
    ...(typeof step.workflow === 'object' ? scorersListedBy(step.workflow, `${prefix}${step.id}.`) : []),
  ]);
}

/** One version of a file, as its reference checks read it: this revision, or the copy the cache keeps. */
interface Version {
  relativePath: string;
  content: string;
  definition: WorkflowDefinition;
  promptFileLocations: Record<string, { line: number; column: number }>;
}

/** A file that passed its own checks, before the workflows it runs are checked. */
interface Candidate extends Version {
  stem: string;
  sourceHash: string;
  teamRevision?: string;
}

/** What a file runs after this sync, and why the versions it did not pick cannot run. */
interface Settled {
  /** This revision, else the kept copy, or null when neither can run. */
  definition: WorkflowDefinition | null;
  /** The reference problems of this revision. Empty when it has none or failed its own checks. */
  revision: WorkflowDiagnostic[];
  /** Why the kept copy cannot run either. Empty when it runs or was never checked. */
  kept: WorkflowDiagnostic[];
}

type Checked = Candidate | { stem: string; relativePath: string; diagnostics: WorkflowDiagnostic[] };

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

/** Removes every cached workflow this sync did not settle to a version, missing files included. */
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

/** The `*.yaml` files in workflows/, or none when it is missing, a symlink, or cannot be listed. */
async function workflowFileNames(dir: string): Promise<string[]> {
  try {
    // readdir follows a directory symlink, so reject the directory itself before listing it.
    const stat = await fs.lstat(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return [];
    return (await fs.readdir(dir)).filter((name) => name.endsWith('.yaml')).sort();
  } catch {
    return [];
  }
}

/**
 * Validate `scorers/` first, then each `workflows/*.yaml` on its own, and cache only files that pass.
 * An invalid file keeps its last cached definition; a file that was never valid
 * stays unrunnable. The cache then holds only what this sync settled, so start
 * finds no version that was not checked against the others. Nothing here fails the caller.
 */
export async function syncWorkflowDefinitions(
  config: LocalConfig,
  options: SyncWorkflowOptions = {},
): Promise<SyncWorkflowResult> {
  const scorers = await syncScorerDefinitions(config, options);
  const result: SyncWorkflowResult = { cached: [], kept: [], invalid: [], unrunnable: [], scorers, unknownScorers: [] };
  const dir = path.join(getKnowledgeDir(config), 'workflows');
  const knowledgeRoot = getKnowledgeDir(config);
  // Asked on the first valid file: a team without workflows starts no git here.
  let reachable: Promise<ReachableRevision | undefined> | undefined;
  const checked: Checked[] = [];
  const rawCandidates: Array<{ stem: string; relativePath: string; full: string; namespace: string | null }> = [];
  for (const name of await workflowFileNames(dir)) {
    rawCandidates.push({
      stem: name.replace(/\.yaml$/, ''),
      relativePath: `workflows/${name}`,
      full: path.join(dir, name),
      namespace: null,
    });
  }

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
      if (!isSafeNamespaceSegment(entry.name)) continue;
      const ns = entry.name;
      const nsDir = path.join(dir, ns);
      for (const name of await workflowFileNames(nsDir)) {
        rawCandidates.push({
          stem: name.replace(/\.yaml$/, ''),
          relativePath: `workflows/${ns}/${name}`,
          full: path.join(nsDir, name),
          namespace: ns,
        });
      }
    }
  } catch {
    // dir missing or unreadable
  }

  // Resolve namespaces when namespaced candidates exist on disk — workflows
  // OR prompts. A root-only tree needs no manifest read, and an unconditional
  // read here would fire before the push's pull refreshes the clone — the
  // stale mapping the #649 review forbids. A manifest that cannot be read
  // resolves to an empty namespace set (conservative), while a manifest-free
  // team discovers prompt namespaces from disk below.
  let hasNamespaced = rawCandidates.some((c) => c.namespace !== null);
  if (!hasNamespaced) {
    // Prompt namespaces are independent of workflow layout: a root-only
    // workflows/ tree with prompts/<ns>/ still needs resolution.
    try {
      const promptsDir = path.join(knowledgeRoot, 'prompts');
      for (const entry of await fs.readdir(promptsDir, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.isSymbolicLink() && isSafeNamespaceSegment(entry.name)) {
          hasNamespaced = true;
          break;
        }
      }
    } catch {
      // prompts dir missing or unreadable
    }
  }
  let resourceNamespaces: Awaited<ReturnType<typeof resolveResourceNamespaces>> = null;
  if (hasNamespaced) {
    try {
      resourceNamespaces = await resolveResourceNamespaces(config);
    } catch {
      // A manifest exists but cannot be read: be conservative. Treating
      // every on-disk namespace as active (the null fallback) would cache
      // an inactive namespace's workflow as runnable for this member.
      // An empty resolution means "no namespace is active".
      resourceNamespaces = { activeNamespaces: {} } as Awaited<ReturnType<typeof resolveResourceNamespaces>>;
    }
  }
  const activeWorkflows = resourceNamespaces?.activeNamespaces.workflows ?? (resourceNamespaces ? [] : null);
  const activePrompts = resourceNamespaces?.activeNamespaces.prompts ?? (resourceNamespaces ? [] : null);
  // Manifest-free: discover prompt namespaces from disk so a namespaced
  // prompt directory is still found even without a roles/projects manifest.
  let effectiveActivePrompts: readonly string[] | null = activePrompts;
  if (effectiveActivePrompts === null) {
    const discovered = new Set<string>();
    try {
      const promptsDir = path.join(knowledgeRoot, 'prompts');
      for (const entry of await fs.readdir(promptsDir, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.isSymbolicLink() && isSafeNamespaceSegment(entry.name)) {
          discovered.add(entry.name);
        }
      }
    } catch { /* prompts dir missing */ }
    effectiveActivePrompts = discovered.size > 0 ? [...discovered] : null;
  }
  const effectiveActiveWorkflows = activeWorkflows ?? [
    ...new Set(rawCandidates.flatMap((candidate) => (
      candidate.namespace === null ? [] : [candidate.namespace]
    ))),
  ];

  const byStem = new Map<string, Array<{ stem: string; relativePath: string; full: string; namespace: string | null }>>();
  for (const cand of rawCandidates) {
    const group = byStem.get(cand.stem) ?? [];
    group.push(cand);
    byStem.set(cand.stem, group);
  }

  const toCheck: Array<{ stem: string; relativePath: string; full: string }> = [];

  for (const [stem, group] of byStem) {
    const namespaceCandidatesList: NamespaceCandidate<{ stem: string; relativePath: string; full: string }>[] = group.map((c) => ({
      name: c.stem,
      source: c.relativePath,
      namespace: c.namespace,
      value: c,
    }));

    const resolution = resolveNamespacedItems(namespaceCandidatesList, effectiveActiveWorkflows);
    if (resolution.kind === 'conflict') {
      checked.push({
        stem,
        relativePath: resolution.first.source,
        diagnostics: [{
          file: resolution.first.source,
          line: 1,
          column: 1,
          field: '(root)',
          code: 'workflow_namespace_conflict',
          message: `Workflow "${stem}" is defined in multiple active namespaces (${resolution.first.source} and ${resolution.second.source}); conflicting workflows have no runnable version`,
        }],
      });
      continue;
    }

    if (resolution.items.length > 0) {
      toCheck.push(resolution.items[0].value);
    }
  }

  for (const { stem, relativePath, full } of toCheck) {
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
      checked.push({ stem, relativePath, diagnostics: [{ file: relativePath, line: 1, column: 1, field: '(root)', message: 'workflow file could not be read' }] });
      continue;
    }
    const parsed = parseWorkflow(relativePath, content);
    if (!parsed.ok) {
      checked.push({ stem, relativePath, diagnostics: parsed.diagnostics });
      continue;
    }
    const resolved = await resolvePromptFiles(config, parsed.definition, parsed.promptFileLocations, relativePath, effectiveActivePrompts);
    if (!resolved.ok) {
      checked.push({ stem, relativePath, diagnostics: resolved.diagnostics });
      continue;
    }
    const hash = createHash('sha256').update(content);
    for (const source of resolved.sources) {
      hash.update('\0').update(source.path).update('\0').update(source.content);
    }
    const sources = [{ path: relativePath, content }, ...resolved.sources];
    const revision = await (reachable ??= remotelyReachableRevision(knowledgeRoot));
    const teamRevision = await revisionHoldsSources(knowledgeRoot, revision, sources)
      ? revision?.revision
      : undefined;
    checked.push({
      stem, relativePath, content, definition: resolved.definition, sourceHash: hash.digest('hex'),
      ...(teamRevision ? { teamRevision } : {}), promptFileLocations: parsed.promptFileLocations,
    });
  }

  const kept = new Map<string, CachedWorkflow | null>();
  for (const file of checked) {
    const dropped = 'diagnostics' in file && dropsKeptVersion(file.diagnostics);
    const cached = dropped ? null : await readCache(config, file.stem);
    const reachableCache = await withoutStaleTeamRevision(knowledgeRoot, cached);
    kept.set(file.stem, reachableCache);
    if (!options.dryRun && cached?.teamRevision && !reachableCache?.teamRevision) {
      await writeJsonAtomic(cachePath(config, file.stem), reachableCache);
    }
  }
  const settle = checkReferences(checked, kept);

  const reject = ({ stem, relativePath }: Checked, diagnostics: WorkflowDiagnostic[]): void => {
    result.invalid.push(...diagnostics);
    for (const diagnostic of diagnostics) log.warn(`[workflows] ${formatDiagnostic(diagnostic)}`);
    const settled = settle(stem);
    // The kept copy's line numbers point into a revision the file no longer has, so only the message is shown.
    for (const problem of settled.kept) log.warn(`[workflows] Dropped the last valid version of ${stem}: ${problem.message}`);
    if (settled.definition) {
      result.kept.push(stem);
      log.warn(`[workflows] Kept the last valid version of ${stem}; this revision was not cached`);
    } else {
      result.unrunnable.push(relativePath);
      log.warn(`[workflows] ${relativePath} has no runnable version`);
    }
  };
  let wrote = 0;
  for (const file of checked) {
    if ('diagnostics' in file) {
      reject(file, file.diagnostics);
      continue;
    }
    const problems = settle(file.stem).revision;
    if (problems.length > 0) {
      reject(file, problems);
      continue;
    }
    const previous = kept.get(file.stem);
    result.cached.push(file.definition.name);
    // Equal bytes are still stored at the earlier entry's revision; the loop that filled `kept` dropped it if origin no longer reaches it.
    const teamRevision = file.teamRevision ?? (previous?.sourceHash === file.sourceHash ? previous.teamRevision : undefined);
    if (options.dryRun || (previous?.sourceHash === file.sourceHash && previous.teamRevision === teamRevision)) continue;
    await writeJsonAtomic(cachePath(config, file.definition.name), {
      relativePath: file.relativePath,
      sourceHash: file.sourceHash,
      ...(teamRevision ? { teamRevision } : {}),
      content: file.content,
      definition: file.definition,
      validatedAt: new Date().toISOString(),
    } satisfies CachedWorkflow);
    wrote += 1;
  }
  if (!options.dryRun) await dropUnsettled(config, new Set([...result.cached, ...result.kept]));
  const valid = new Set(scorers.cached);
  for (const file of checked) {
    const definition = settle(file.stem).definition;
    for (const { step, scorer } of definition ? scorersListedBy(definition) : []) {
      if (!valid.has(scorer)) result.unknownScorers.push({ file: file.relativePath, step, scorer });
    }
  }
  for (const unknown of result.unknownScorers) log.warn(`[workflows] ${formatUnknownScorer(unknown)}`);

  const scope = options.scopeLabel ?? config.scope;
  if (options.dryRun && result.cached.length > 0) {
    log.info(`[${scope}] [dry-run] Would cache ${result.cached.length} workflow${result.cached.length === 1 ? '' : 's'}`);
  } else if (wrote > 0) {
    log.success(`[${scope}] Synced ${wrote} workflow${wrote === 1 ? '' : 's'}`);
  }
  return result;
}

/**
 * An invalid revision keeps the last valid version, unless a diagnostic has a code:
 * a code changes what the file means, so the previous definition must not keep running.
 */
function dropsKeptVersion(diagnostics: WorkflowDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.code !== undefined);
}

/**
 * The workflow files a definition runs by name, in step order, including from inside its inline workflows,
 * with the path of the step that runs each one, such as `group.run-b`.
 * Every walk across files, at pull and at start, follows references through here.
 */
export function workflowsRunBy(definition: { steps: WorkflowStep[] }, prefix = ''): Array<{ step: string; workflow: string }> {
  return definition.steps.flatMap((step) => (typeof step.workflow === 'object' ? workflowsRunBy(step.workflow, `${prefix}${step.id}.`)
    : step.workflow === undefined ? [] : [{ step: `${prefix}${step.id}`, workflow: step.workflow }]));
}

/** The workflows a cached workflow runs, by name, and one hash over its sources and theirs. */
export interface WorkflowTree {
  workflows: Record<string, WorkflowDefinition>;
  sourceHash: string;
  /** The team commit that stores every one of those sources, when one does. */
  teamRevision?: string;
}

type TreeFailure = { code: 'workflow_recursion' | 'workflow_not_found'; message: string };

/** Every workflow `cached` runs through its steps, directly or not, from the cache, and one hash over all of their sources. */
export async function loadWorkflowTree(
  config: LocalConfig,
  cached: CachedWorkflow,
): Promise<WorkflowTree | { failed: TreeFailure }> {
  const workflows: Record<string, WorkflowDefinition> = {};
  const hashes: Array<[string, string]> = [];
  const revisions: Array<string | undefined> = [cached.teamRevision];
  const visit = async (definition: WorkflowDefinition, through: string[]): Promise<TreeFailure | undefined> => {
    for (const { step, workflow } of workflowsRunBy(definition)) {
      if (through.includes(workflow)) {
        const cycle = [...through.slice(through.indexOf(workflow)), workflow].join(' -> ');
        return { code: 'workflow_recursion', message: `Workflow "${cached.definition.name}" cannot start: its sub-workflows run in a cycle: ${cycle}` };
      }
      if (Object.hasOwn(workflows, workflow)) continue;
      const child = await loadCachedWorkflow(config, workflow);
      if (!child) {
        return { code: 'workflow_not_found', message: `Workflow "${definition.name}" step "${step}" runs workflow "${workflow}", which has no runnable version. Check workflows/${workflow}.yaml and pull again.` };
      }
      workflows[workflow] = child.definition;
      hashes.push([workflow, child.sourceHash]);
      revisions.push(child.teamRevision);
      const failed = await visit(child.definition, [...through, workflow]);
      if (failed) return failed;
    }
    return undefined;
  };
  const failed = await visit(cached.definition, [cached.definition.name]);
  if (failed) return { failed };
  const teamRevision = cached.teamRevision !== undefined && revisions.every((revision) => revision === cached.teamRevision)
    ? cached.teamRevision
    : undefined;
  if (hashes.length === 0) return { workflows, sourceHash: cached.sourceHash, ...(teamRevision ? { teamRevision } : {}) };
  const hash = createHash('sha256').update(cached.sourceHash);
  for (const [name, sourceHash] of hashes.sort(([left], [right]) => left.localeCompare(right))) {
    hash.update('\0').update(name).update('\0').update(sourceHash);
  }
  return { workflows, sourceHash: hash.digest('hex'), ...(teamRevision ? { teamRevision } : {}) };
}

/** A workflow, every workflow it runs, and one hash over all of their sources. */
export interface WorkflowBundle {
  definition: WorkflowDefinition;
  workflows: Record<string, WorkflowDefinition>;
  sourceHash: string;
}

export async function loadWorkflowBundle(config: LocalConfig, name: string): Promise<WorkflowBundle | { failed: string }> {
  const cached = await loadCachedWorkflow(config, name);
  if (!cached) return { failed: `workflow "${name}" has no runnable version` };
  const tree = await loadWorkflowTree(config, cached);
  if ('failed' in tree) return { failed: tree.failed.message };
  return { definition: cached.definition, workflows: tree.workflows, sourceHash: tree.sourceHash };
}

/**
 * Workflow `name` and the workflows it runs as team commit `revision` stores them, synced from a `--shared` clone at that
 * commit into a cache of its own, so this member's checkout and cache stay as they are. Only a fetch of origin, when the
 * team repo lacks the commit, touches the member's repository.
 */
export async function loadWorkflowBundleAt(config: LocalConfig, name: string, revision: string): Promise<WorkflowBundle | { failed: string }> {
  const repoRoot = isSelfMode(config) ? getBusinessRoot(config) : config.repo.localPath;
  const git = createGit(repoRoot);
  const present = (): Promise<boolean> => git.raw(['cat-file', '-e', `${revision}^{commit}`]).then(() => true, () => false);
  if (!await present()) {
    const fetched = await git.fetch(['origin']).then(() => '', (error: unknown) => (error instanceof Error ? error.message.trim() : String(error)));
    if (!await present()) {
      return { failed: `the team repo at ${repoRoot} does not have it, even after fetching origin${fetched ? ` (${fetched})` : ''}` };
    }
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-revision-'));
  try {
    const clone = path.join(dir, 'team');
    await git.raw(['clone', '--quiet', '--shared', '--no-checkout', repoRoot, clone]);
    await createGit(clone).raw(['checkout', '--quiet', '--detach', revision]);
    const knowledge = path.join(clone, path.relative(repoRoot, config.repo.localPath));
    const at: LocalConfig = {
      ...config,
      repo: isSelfMode(config) ? { ...config.repo, localPath: knowledge, businessRepoRoot: clone } : { ...config.repo, localPath: knowledge },
      dataHome: path.join(dir, 'data'),
    };
    await syncWorkflowDefinitions(at, { scopeLabel: `team commit ${revision.slice(0, 7)}` });
    return await loadWorkflowBundle(at, name);
  } catch (error) {
    return { failed: error instanceof Error ? error.message.trim() : String(error) };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * Settles what each file runs after this sync, checking every version only against the versions the others settle to.
 * Each file starts at this revision when it passed its own checks, else at the kept copy unless a code dropped it.
 * A version that fails falls back (revision, then kept copy, then nothing) and every version is checked again, until none fails.
 * A failing version waits while a workflow it runs, directly or not, still fails, since that one may fall back to a version
 * that fits. When every failing version waits, they run each other in a cycle: the revisions on it fall back first, because
 * a kept copy taken out of a cycle only leaves the file that runs it with nothing to run.
 */
function checkReferences(checked: Checked[], kept: Map<string, CachedWorkflow | null>): (stem: string) => Settled {
  const candidates = new Map(checked.flatMap((file) => ('definition' in file ? [[file.stem, file] as const] : [])));
  // The version each file is at; a file with no version left is not in the map.
  const chosen = new Map(checked.flatMap(({ stem }): Array<[string, 'revision' | 'kept']> => (
    candidates.has(stem) ? [[stem, 'revision']] : kept.get(stem) ? [[stem, 'kept']] : [])));
  const revisionProblems = new Map<string, WorkflowDiagnostic[]>();
  const keptProblems = new Map<string, WorkflowDiagnostic[]>();
  const runs = (workflow: string): WorkflowDefinition | null => {
    const version = chosen.get(workflow);
    if (version === 'revision') return candidates.get(workflow)?.definition ?? null;
    return version === 'kept' ? kept.get(workflow)?.definition ?? null : null;
  };
  // Every workflow a file runs at its version, directly or not; the file itself when it runs in a cycle.
  const reach = (stem: string): Set<string> => {
    const found = new Set<string>();
    const visit = (definition: WorkflowDefinition | null): void => {
      for (const { workflow } of definition ? workflowsRunBy(definition) : []) {
        if (found.has(workflow)) continue;
        found.add(workflow);
        visit(runs(workflow));
      }
    };
    visit(runs(stem));
    return found;
  };
  const cycleBack = (from: string, to: string): string[] | undefined => {
    const seen = new Set<string>();
    const walk = (workflow: string, through: string[]): string[] | undefined => {
      if (workflow === to) return [...through, workflow];
      if (seen.has(workflow)) return undefined;
      seen.add(workflow);
      const definition = runs(workflow);
      for (const { workflow: next } of definition ? workflowsRunBy(definition) : []) {
        const cycle = walk(next, [...through, workflow]);
        if (cycle) return cycle;
      }
      return undefined;
    };
    return walk(from, [to]);
  };
  const check = (stem: string, version: Version): WorkflowDiagnostic[] => {
    const files: WorkflowFiles = { runnable: runs, cycle: (workflow) => cycleBack(workflow, stem) };
    const parsed = parseWorkflow(version.relativePath, version.content, files);
    const diagnostics = parsed.ok ? [] : parsed.diagnostics;
    const promptFiles = (steps: WorkflowStep[], trail: number[]): void => steps.forEach((step, index) => {
      if (typeof step.workflow === 'object') promptFiles(step.workflow.steps, [...trail, index]);
      if (step.promptFile === undefined || step.prompt === undefined) return;
      const at = version.promptFileLocations[stepField([...trail, index])] ?? { line: 1, column: 1 };
      diagnostics.push(...promptFileDiagnostics(version.relativePath, version.definition, [...trail, index], step.prompt, at, files));
    });
    promptFiles(version.definition.steps, []);
    return diagnostics;
  };
  // A kept copy was checked against the workflows it ran then. Those may have changed since, so it is checked again.
  const checkKept = (stem: string, cached: CachedWorkflow): WorkflowDiagnostic[] => {
    if (workflowsRunBy(cached.definition).length === 0) return [];
    if (cached.content === undefined) {
      return [{ file: cached.relativePath, line: 1, column: 1, field: '(root)', message: 'it was cached without its source, so it cannot be checked against the workflows it runs' }];
    }
    const parsed = parseWorkflow(cached.relativePath, cached.content);
    if (!parsed.ok) return parsed.diagnostics;
    const { relativePath, content, definition } = cached;
    return check(stem, { relativePath, content, definition, promptFileLocations: parsed.promptFileLocations });
  };
  const problemsAt = (stem: string): WorkflowDiagnostic[] => {
    const candidate = candidates.get(stem);
    const cached = kept.get(stem);
    if (chosen.get(stem) === 'revision' && candidate) return check(stem, candidate);
    return cached ? checkKept(stem, cached) : [];
  };
  for (;;) {
    const failing = [...chosen.keys()].flatMap((stem) => {
      const problems = problemsAt(stem);
      return problems.length > 0 ? [{ stem, problems, through: reach(stem) }] : [];
    });
    if (failing.length === 0) break;
    const stems = new Set(failing.map(({ stem }) => stem));
    const ready = failing.filter(({ through }) => ![...through].some((workflow) => stems.has(workflow)));
    const onCycle = failing.filter(({ stem, through }) => through.has(stem));
    const revisionsOnCycle = onCycle.filter(({ stem }) => chosen.get(stem) === 'revision');
    // Nothing ready means a failing version runs itself through the others, so onCycle is never empty here.
    for (const { stem, problems } of ready.length > 0 ? ready : revisionsOnCycle.length > 0 ? revisionsOnCycle : onCycle) {
      if (chosen.get(stem) === 'revision') {
        revisionProblems.set(stem, problems);
        if (kept.get(stem) && !dropsKeptVersion(problems)) chosen.set(stem, 'kept');
        else chosen.delete(stem);
      } else {
        keptProblems.set(stem, problems);
        chosen.delete(stem);
      }
    }
  }
  return (stem) => ({ definition: runs(stem), revision: revisionProblems.get(stem) ?? [], kept: keptProblems.get(stem) ?? [] });
}

/** Resolves every `prompt_file`, including those inside inline workflows. */
async function resolvePromptFiles(
  config: LocalConfig,
  definition: WorkflowDefinition,
  locations: Record<string, { line: number; column: number }>,
  workflowFile: string,
  activePromptsNamespaces: readonly string[] | null = null,
): Promise<
  | { ok: true; definition: WorkflowDefinition; sources: Array<{ path: string; content: string }> }
  | { ok: false; diagnostics: WorkflowDiagnostic[] }
> {
  const root = path.resolve(config.repo.localPath);
  const diagnostics: WorkflowDiagnostic[] = [];
  const sources: Array<{ path: string; content: string }> = [];
  const resolveSteps = async (given: WorkflowStep[], trail: number[]): Promise<WorkflowStep[]> => {
    const steps = [...given];
    for (const [index, step] of given.entries()) {
      const field = stepField([...trail, index]);
      if (typeof step.workflow === 'object') {
        steps[index] = { ...step, workflow: { ...step.workflow, steps: await resolveSteps(step.workflow.steps, [...trail, index]) } };
        continue;
      }
      if (!step.promptFile) continue;

      let promptPath = step.promptFile;
      const location = locations[field] ?? { line: 1, column: 1 };

      const promptRelative = promptPath.replace(/^[\\/]/, '');
      if (promptRelative.startsWith('prompts/') && activePromptsNamespaces && activePromptsNamespaces.length > 0) {
        const leaf = promptRelative.slice('prompts/'.length);
        // Namespace lookup works for any leaf depth — a nested path like
        // prompts/topic/note.md resolves to prompts/<ns>/topic/note.md
        // just as a flat prompts/note.md resolves to prompts/<ns>/note.md.
        //
        // A leaf whose first segment is already an active namespace is explicit
        // and resolved as written: prepending another namespace would look up
        // prompts/<other>/ops/note.md and load that file instead.
        const lead = leaf.split('/')[0];
        const alreadyNamespaced = lead !== undefined && activePromptsNamespaces.includes(lead);
        const found = alreadyNamespaced ? [] : (await Promise.all(
          activePromptsNamespaces.map(async (ns) => {
            const candidate = path.join(root, 'prompts', ns, ...leaf.split('/'));
            return (await pathExists(candidate)) ? `prompts/${ns}/${leaf}` : null;
          }),
        )).filter((p): p is string => p !== null);

        if (found.length === 1) {
          promptPath = found[0];
        } else if (found.length > 1) {
          diagnostics.push({
            file: workflowFile,
            line: location.line,
            column: location.column,
            field: `${field}.prompt_file`,
            code: 'prompt_namespace_conflict',
            message: `prompt_file "${step.promptFile}" is ambiguous between active namespaces (${found.join(', ')}); fix the conflict or specify the prompt path explicitly`,
          });
          continue;
        }
      }

      const target = path.resolve(root, promptPath);
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
          field: `${field}.prompt_file`,
          message: `prompt_file "${step.promptFile}" must be a readable, non-symlink file under prompts/`,
        });
        continue;
      }
      diagnostics.push(...promptFileDiagnostics(workflowFile, definition, [...trail, index], prompt, location));
      sources.push({ path: promptPath, content: prompt });
      steps[index] = { ...step, prompt };
    }
    return steps;
  };
  const steps = await resolveSteps(definition.steps, []);
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, definition: { ...definition, steps }, sources };
}
