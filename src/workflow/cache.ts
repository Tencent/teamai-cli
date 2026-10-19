import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { log } from '../utils/logger.js';
import { readFileSafe, remove, writeJsonAtomic } from '../utils/fs.js';
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

interface ReachableRevision {
  repositoryRoot: string;
  revision: string;
}

const TEAM_REMOTE_REFS = 'refs/remotes/origin/';

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

async function isTeamRemoteRevision(root: string, revision: string): Promise<boolean> {
  try {
    const refs = await createGit(root).raw([
      'for-each-ref', `--contains=${revision}`, '--format=%(refname)', TEAM_REMOTE_REFS,
    ]);
    return refs.trim() !== '';
  } catch {
    return false;
  }
}

/** The checked-out commit, only when the team remote can reach it. */
async function remotelyReachableRevision(root: string): Promise<ReachableRevision | undefined> {
  try {
    const git = createGit(root);
    const revision = (await git.revparse(['HEAD'])).trim();
    if (!await isTeamRemoteRevision(root, revision)) return undefined;
    return {
      repositoryRoot: await fs.realpath((await git.revparse(['--show-toplevel'])).trim()),
      revision,
    };
  } catch {
    return undefined;
  }
}

async function withoutStaleTeamRevision(root: string, cached: CachedWorkflow | null): Promise<CachedWorkflow | null> {
  if (!cached?.teamRevision || await isTeamRemoteRevision(root, cached.teamRevision)) return cached;
  const next = { ...cached };
  delete next.teamRevision;
  return next;
}

/** Whether `revision` stores every source byte exactly as the cache read it. */
async function revisionHoldsSources(
  knowledgeRoot: string,
  reachable: ReachableRevision | undefined,
  sources: Array<{ path: string; content: string }>,
): Promise<boolean> {
  if (!reachable) return false;
  const git = createGit(knowledgeRoot);
  try {
    for (const source of sources) {
      const absolute = path.resolve(knowledgeRoot, source.path);
      const relative = path.relative(reachable.repositoryRoot, await fs.realpath(absolute)).split(path.sep).join('/');
      if (relative === '..' || relative.startsWith('../')) return false;
      if (await git.show([`${reachable.revision}:${relative}`]) !== source.content) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate each `workflows/*.yaml` on its own and cache only files that pass.
 * An invalid file keeps its last cached definition; a file that was never valid
 * stays unrunnable. The cache then holds only what this sync settled, so start
 * finds no version that was not checked against the others. Nothing here fails the caller.
 */
export async function syncWorkflowDefinitions(
  config: LocalConfig,
  options: SyncWorkflowOptions = {},
): Promise<SyncWorkflowResult> {
  const result: SyncWorkflowResult = { cached: [], kept: [], invalid: [], unrunnable: [] };
  const dir = path.join(getKnowledgeDir(config), 'workflows');
  const knowledgeRoot = getKnowledgeDir(config);
  const reachable = await remotelyReachableRevision(knowledgeRoot);
  const checked: Checked[] = [];
  for (const name of await workflowFileNames(dir)) {
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
    const stem = name.replace(/\.yaml$/, '');
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
    const resolved = await resolvePromptFiles(config, parsed.definition, parsed.promptFileLocations, relativePath);
    if (!resolved.ok) {
      checked.push({ stem, relativePath, diagnostics: resolved.diagnostics });
      continue;
    }
    const hash = createHash('sha256').update(content);
    for (const source of resolved.sources) {
      hash.update('\0').update(source.path).update('\0').update(source.content);
    }
    const sources = [{ path: relativePath, content }, ...resolved.sources];
    const teamRevision = await revisionHoldsSources(knowledgeRoot, reachable, sources)
      ? reachable?.revision
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
    const previous = await readCache(config, file.definition.name);
    result.cached.push(file.definition.name);
    if (options.dryRun || (previous?.sourceHash === file.sourceHash && previous.teamRevision === file.teamRevision)) continue;
    await writeJsonAtomic(cachePath(config, file.definition.name), {
      relativePath: file.relativePath,
      sourceHash: file.sourceHash,
      ...(file.teamRevision ? { teamRevision: file.teamRevision } : {}),
      content: file.content,
      definition: file.definition,
      validatedAt: new Date().toISOString(),
    } satisfies CachedWorkflow);
    wrote += 1;
  }
  if (!options.dryRun) await dropUnsettled(config, new Set([...result.cached, ...result.kept]));

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
      const target = path.resolve(root, step.promptFile);
      const location = locations[field] ?? { line: 1, column: 1 };
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
      sources.push({ path: step.promptFile, content: prompt });
      steps[index] = { ...step, prompt };
    }
    return steps;
  };
  const steps = await resolveSteps(definition.steps, []);
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, definition: { ...definition, steps }, sources };
}
