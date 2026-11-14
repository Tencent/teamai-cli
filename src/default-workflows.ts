import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { getCurrentVersion, packageRoot } from './package-info.js';
import { RESOURCE_LAYOUTS, Resources, type ShippedFile, type TeamaiLayer } from './resources/resolver.js';
import { SCORE_WORKFLOW } from './scorers/judging-workflows.js';
import { ScoreOverride, type ScoreOverrideCode } from './scorers/score-override.js';
import type { LocalConfig } from './types.js';
import { WorkflowFolder } from './workflow/folder.js';
import { formatDiagnostic, parseWorkflow, resolveFolderFiles } from './workflow/parse.js';
import type { CachedWorkflow, ResolvedWorkflow, WorkflowDefinition, WorkflowDiagnostic, WorkflowSource } from './workflow/types.js';

// ─── Default workflows (#1388) ───────────────────────────
//
//  The CLI ships workflows a team gets without writing them,
//  as workflows/<name>.yaml or a folder workflows/<name>/
//  with its WORKFLOW.yaml in the npm package: the teamai
//  layer the resolver (src/resources/resolver.ts) reads below
//  the team's files. A team file of the same name replaces
//  one. The workflow cache resolves them (loadCachedWorkflow,
//  listCachedWorkflows) only while no team version of that
//  name runs; they are never written to the cache or the team
//  repo. A run records which one it ran (originOf), and a
//  handoff refuses a default run whose shipped file differs on
//  the other machine.
//

/** Every default's name starts with this, so its generated skill, named after it, is one prune and uninstall look at. */
const PREFIX = 'teamai-';

/** The default that shares what a session taught, then the session: the one the friction reminder offers. */
const SHARE_LEARNINGS = 'teamai-share-learnings';

const parsedDefaults = new Map<string, CachedWorkflow>();

/**
 * A default as the package ships it, parsed once, so each lookup returns the same definition. A shipped file that does
 * not parse, or whose name lacks `PREFIX`, is a teamai bug, so it throws.
 */
function readDefault({ relativePath, content, folder }: ShippedFile): CachedWorkflow {
  const known = parsedDefaults.get(relativePath);

  if (known) return known;
  const read = folder ? WorkflowFolder.shipped(folder) : undefined;

  if (read?.kind === 'invalid') throw new Error(`teamai's default ${relativePath} is not a valid workflow folder: ${read.problem}`);
  const executable = read?.files.filter((file) => file.executable).map((file) => file.path) ?? [];

  if (executable.length === 1) {
    throw new Error(`teamai's default ${relativePath} ships ${executable.join(', ')} as an executable file. An npm install on Windows drops the bit, `
      + 'so the folder would hash differently there and a run of it could not be claimed across systems. Clear the bit, and run the file through its interpreter, such as sh.');
  }

  if (executable.length > 1) {
    throw new Error(`teamai's default ${relativePath} ships ${executable.join(', ')} as executable files. An npm install on Windows drops the bit, `
      + 'so the folder would hash differently there and a run of it could not be claimed across systems. Clear the bit, and run the files through their interpreter, such as sh.');
  }

  const parsed = parseWorkflow(relativePath, content);

  if (!parsed.ok) throw new Error(`teamai's default ${relativePath} does not parse: ${parsed.diagnostics.map(formatDiagnostic).join('; ')}`);

  if (!parsed.definition.name.startsWith(PREFIX)) throw new Error(`teamai's default ${relativePath} is named ${parsed.definition.name}, which does not start with ${PREFIX}`);

  const resolved = read
    ? resolveFolderFiles(relativePath, parsed.definition, parsed.promptFileLocations, { path: `${path.posix.dirname(relativePath)}/`, files: read.files })
    : parsed;

  if (!resolved.ok) throw new Error(`teamai's default ${relativePath} does not read its files: ${resolved.diagnostics.map(formatDiagnostic).join('; ')}`);

  const shipped: CachedWorkflow = {
    relativePath,
    sourceHash: read ? WorkflowFolder.hash(read.files) : createHash('sha256').update(content).digest('hex'),
    content,
    definition: resolved.definition,
    validatedAt: new Date(0).toISOString(),
  };

  if (read) shipped.files = read.files;

  parsedDefaults.set(relativePath, shipped);

  return shipped;
}

/** teamai's default workflows, the bottom layer of a tree `Resources` resolves workflows in: `{ teamai: layer }` alone. */
const layer: TeamaiLayer<CachedWorkflow> = { root: packageRoot(), read: readDefault };

/**
 * Where the definition a run executes came from: the team's files, or the default the teamai that started it ships, by
 * version, since another version may ship other bytes and no team commit holds them. A team folder that took files from
 * the default of its name records both: the team commit holds its own files, the teamai version the others.
 */
export const RunOriginSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('team'), teamRevision: z.string().min(1).optional(), teamaiVersion: z.string().min(1).optional() }),
  z.object({ source: z.literal('default'), teamaiVersion: z.string().min(1) }),
]);

export type RunOrigin = z.infer<typeof RunOriginSchema>;

/** The origin a run of `resolved` records. */
function originOf(resolved: ResolvedWorkflow): RunOrigin {
  if (resolved.source === 'default') return { source: 'default', teamaiVersion: getCurrentVersion() };

  if (resolved.inherited === undefined) return { source: 'team' };
  const { teamaiVersion } = resolved.inherited;

  return resolved.teamRevision === undefined ? { source: 'team', teamaiVersion } : { source: 'team', teamRevision: resolved.teamRevision, teamaiVersion };
}

/** The source of a run's definition: a run started before origins were recorded ran the team's, as only those existed. */
function sourceOfRun(run: { origin?: RunOrigin }): WorkflowSource {
  return run.origin?.source ?? 'team';
}

/** The defaults a team file replaces only by keeping what their module says it must, by name. */
const CONTRACTS = new Map([[SCORE_WORKFLOW, ScoreOverride]]);

/**
 * Why pull refuses a team file over a default's contract: `default_override_alias` for a file that takes a guarded name
 * as its alias, `judging_scored` for a step that runs a judging default and lists scorers, and each contract's own.
 */
export type ContractCode = 'default_override_alias' | 'judging_scored' | ScoreOverrideCode;

/**
 * Why pull refuses `definition`, the team file at `file` in the tree `config` syncs: it takes the name of a default with
 * a contract and breaks it, takes that name as its alias, which would replace the default with no check, or has a step
 * that runs a default as its contract refuses. Coded, so no older version runs.
 */
async function overrideProblems(file: string, definition: WorkflowDefinition, config: LocalConfig): Promise<WorkflowDiagnostic[]> {
  const { alias } = definition;

  const aliased: WorkflowDiagnostic[] = alias !== undefined && CONTRACTS.has(alias) ? [{
    file, line: 1, column: 1, field: 'alias', code: 'default_override_alias',
    message: `alias "${alias}" would replace teamai's default ${alias}, which only a team file named ${alias} replaces, once pull checked it. Remove the alias, or name the file ${alias}`,
  }] : [];

  const contract = CONTRACTS.get(definition.name);
  const found = contract ? await Resources.resolve(RESOURCE_LAYOUTS.workflows, definition.name, { teamai: layer }) : undefined;
  const shipped = found?.kind === 'resolved' && found.item.layer === 'teamai' ? found.item.shipped : undefined;

  return [
    ...aliased,
    ...(contract && shipped ? await contract.problems({ team: definition, shipped: shipped.definition, file, config }) : []),
    ...[...CONTRACTS.values()].flatMap((guarded) => guarded.callerProblems(file, definition)),
  ];
}

/** Whether teamai's default `name` has a contract a team file that replaces it must keep. */
function isGuarded(name: string): boolean {
  return CONTRACTS.has(name);
}

/** What pull warns about in a step of `definition`, at `file`, that runs a default with a contract. */
function callerWarnings(file: string, definition: WorkflowDefinition): string[] {
  return [...CONTRACTS.values()].flatMap((contract) => contract.callerWarnings(file, definition));
}

export const DefaultWorkflows = { PREFIX, SHARE_LEARNINGS, layer, originOf, sourceOfRun, overrideProblems, callerWarnings, isGuarded } as const;
