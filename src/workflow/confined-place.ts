/**
 * The directory a step with `workspace: { confined }` runs in, as the engine checks it each time it leases the step: a
 * directory under the run's `$TEAMAI_RUN_DIR`, not a link, that holds the `confined.json` an earlier step wrote. That
 * file sets the level the step runs at; the workflow file cannot set or loosen it.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { agentFormatOf } from '../tool-registry.js';
import type { LocalConfig } from '../types.js';
import { errnoCode } from '../utils/fs.js';
import type { ConfinedLease } from './lease-wire.js';
import { ConfinedLevelSchema, type DriverCan, type Held } from './requirements.js';
import { chooseStepModel, type StepModel } from './step-model.js';
import type { WorkflowFailure } from './types.js';

export const CONFINED_FILE = 'confined.json';

/**
 * `confined.json`: the level the step runs at; the tool to try first, or the tools in the order to try them, or instead
 * `require`, the one tool the step runs on, so a driver that does not offer it holds the step; and the reply's JSON
 * Schema, a file in the directory.
 */
export const ConfinedFileSchema = z.object({
  level: ConfinedLevelSchema,
  prefer: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
  require: z.string().min(1).optional(),
  schema: z.string().min(1).optional(),
}).strict().refine((file) => file.prefer === undefined || file.require === undefined, { message: 'prefer and require exclude each other: require names the one tool the step runs on', path: ['require'] });

export type ConfinedFile = z.infer<typeof ConfinedFileSchema>;

/** A checked confined directory: its real path, and its `confined.json` with `schema` made the real path of that file. */
export type ConfinedDir = ConfinedFile & { dir: string };

export type ConfinedDirCheck = { ok: true; place: ConfinedDir } | { ok: false; failure: WorkflowFailure };

/** The offers of a driver's `can.confined`. */
type Offers = NonNullable<DriverCan['confined']>;

const HOW = 'Write the directory under $TEAMAI_RUN_DIR in a step the confined step needs, with its confined.json';

function invalid(message: string): ConfinedDirCheck {
  return { ok: false, failure: { code: 'confined_invalid', message } };
}

/** Whether `inner`, a real path, is inside `outer`, another, and not `outer` itself. */
function isInside(outer: string, inner: string): boolean {
  const relative = path.relative(outer, inner);

  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function lstatOf(file: string) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    const code = errnoCode(error);

    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw error;
  }
}

/** The JSON in `file`, a regular file, or why it holds none. */
async function jsonFile(file: string): Promise<{ ok: true; value: unknown } | { ok: false; reason: string }> {
  const stat = await lstatOf(file);

  if (!stat?.isFile()) return { ok: false, reason: stat ? 'is not a regular file' : 'does not exist' };

  try {
    return { ok: true, value: JSON.parse(await fs.readFile(file, 'utf8')) };
  } catch (error) {
    return { ok: false, reason: `is not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** The real path of `schema`, a JSON Schema file inside `dir`, or why the step cannot use it. */
async function schemaFile(step: string, dir: string, schema: string): Promise<{ ok: true; file: string } | { ok: false; check: ConfinedDirCheck }> {
  const file = path.resolve(dir, schema);
  const read = await jsonFile(file);
  const why = !isInside(dir, file) ? 'is not inside the directory' : !read.ok ? read.reason : !(read.value instanceof Object) || Array.isArray(read.value) ? 'is not a JSON Schema object' : undefined;

  if (why === undefined) return { ok: true, file };

  return { ok: false, check: invalid(`Step "${step}" names reply schema ${schema} in ${path.join(dir, CONFINED_FILE)}, which ${why}. Write the schema as a JSON object in a file of the directory, and name its path relative to it.`) };
}

/** The real path of `target`, a directory that is no link, under the real `runDir`; or why it is not one, after "which". */
async function realDir(target: string, runDir: string): Promise<{ ok: true; real: string } | { ok: false; why: string }> {
  const stat = await lstatOf(target);

  if (!stat) return { ok: false, why: `does not exist. ${HOW}.` };

  if (stat.isSymbolicLink()) return { ok: false, why: `is a symlink. ${HOW}, not a link to it.` };

  if (!stat.isDirectory()) return { ok: false, why: `is not a directory. ${HOW}.` };
  const [real, root] = await Promise.all([fs.realpath(target), fs.realpath(runDir)]);

  return isInside(root, real) ? { ok: true, real } : { ok: false, why: `is not under the run's $TEAMAI_RUN_DIR, ${root}. ${HOW}.` };
}

/** Why `file`, a `confined.json` that holds JSON, is not one teamai reads: each of `issues`, at its key. */
function unreadConfinedFile(input: { step: string; file: string; issues: z.core.$ZodIssue[] }): ConfinedDirCheck {
  const issues = input.issues.map((issue) => (issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message)).join('; ');

  return invalid(`Step "${input.step}" reads ${input.file}, which is not a ${CONFINED_FILE} teamai reads (${issues}). Write {"level": "verified" or "best-effort", "prefer": <tool, or tools in order>, or "require": <the one tool>, "schema": <a JSON Schema file in the directory>}, prefer, require and schema optional.`);
}

/**
 * Checks `dir`, the directory step `step` was rendered to, a relative one under `runDir`, the run's `$TEAMAI_RUN_DIR`:
 * it is a directory, not a link, whose real path is under the real `runDir`, and it holds a `confined.json` teamai reads.
 * Every refusal is `confined_invalid`, which fails the step: the next lease would find the same directory.
 */
export async function checkConfinedDir({ step, runDir, dir }: { step: string; runDir: string; dir: string }): Promise<ConfinedDirCheck> {
  const target = path.resolve(runDir, dir);
  const found = await realDir(target, runDir);
  const at = `Step "${step}" runs confined to ${target}`;

  if (!found.ok) return invalid(`${at}, which ${found.why}`);
  const { real } = found;
  const file = path.join(real, CONFINED_FILE);
  const read = await jsonFile(file);

  if (!read.ok) return invalid(`${at}, whose ${CONFINED_FILE} ${read.reason}. Write ${CONFINED_FILE} there with the level the step runs at, such as {"level":"verified"}.`);
  const parsed = ConfinedFileSchema.safeParse(read.value);

  if (!parsed.success) return unreadConfinedFile({ step, file, issues: parsed.error.issues });
  const { schema, ...rest } = parsed.data;

  if (schema === undefined) return { ok: true, place: { ...rest, dir: real } };
  const named = await schemaFile(step, real, schema);

  return named.ok ? { ok: true, place: { ...rest, schema: named.file, dir: real } } : named.check;
}

/**
 * The tools a confined step at `level` may run on, from a driver's `can.confined`: the tools of each offer at that level
 * or stricter, in the order the driver lists them, each once, after those of `prefer` that are among them, in its order.
 * With `require`, only that tool, when such an offer has it, else none.
 */
export function confinedCandidates(offers: Offers, { level, prefer, require }: Pick<ConfinedFile, 'level' | 'prefer' | 'require'>): string[] {
  const tools = new Set(offers.filter((offer) => offer.level === 'verified' || level === 'best-effort').flatMap((offer) => offer.tools));

  if (require !== undefined) return tools.has(require) ? [require] : [];

  return [...new Set([...[prefer ?? []].flat().filter((tool) => tools.has(tool)), ...tools])];
}

/** What `next` does with a confined step for the driver asking: lease it with these terms, hold it, or fail it. */
export type ConfinedDecision =
  | { kind: 'grant'; lease: ConfinedLease }
  | { kind: 'hold'; held: Held }
  | { kind: 'fail'; failure: WorkflowFailure };

export interface ConfinedRequest {
  step: string;
  /** The step's `workspace.confined`, rendered. */
  dir: string;
  /** The run's `$TEAMAI_RUN_DIR`. */
  runDir: string;
  /** The driver's `can.confined`. */
  offers: Offers;
  /** The step's model and the `defaults.model` in effect, as the lease carries them. */
  model?: string | StepModel;
  defaultModel?: string;
  /** The scope whose aliases resolve the model. */
  config: LocalConfig;
}

/** The hold of `step` when none of `tools` resolves its model on this machine, with the first tool's reason. */
async function modelHold(input: Pick<ConfinedRequest, 'step' | 'model' | 'defaultModel' | 'config'> & { tools: string[] }): Promise<Held | undefined> {
  const { step, tools, model, defaultModel, config } = input;
  const choices = await Promise.all(tools.map((tool) => (agentFormatOf(tool) === undefined ? undefined : chooseStepModel({ step, tool, model, defaultModel, config }))));

  if (choices.some((choice) => choice?.ok)) return undefined;
  const why = choices.find((choice) => choice?.ok === false)?.failure.message;

  return { step, reason: `step "${step}" needs a model one of its confined tools resolves, and none of ${tools.join(', ')} does${why === undefined ? '' : `: ${why}`}`, missing: ['model'] };
}

/**
 * Decides a confined step for one driver: fails it when its directory breaks a rule, holds it when no offer reaches the
 * level its `confined.json` sets or no tool of those offers resolves its model, and otherwise leases it with every such
 * tool, as the driver tries them in order.
 */
export async function decideConfined(request: ConfinedRequest): Promise<ConfinedDecision> {
  const { step, offers, model, defaultModel, config } = request;
  const checked = await checkConfinedDir(request);

  if (!checked.ok) return { kind: 'fail', failure: checked.failure };
  const { place } = checked;
  const tools = confinedCandidates(offers, place);
  const [first, ...rest] = tools;

  if (first === undefined && place.require !== undefined) {
    return { kind: 'hold', held: { step, reason: `step "${step}" runs confined at ${place.level} on ${place.require} only, which no offer in this driver's can.confined has at that level`, missing: ['confined'] } };
  }

  if (first === undefined) {
    return { kind: 'hold', held: { step, reason: `step "${step}" runs confined at ${place.level}, which no offer in this driver's can.confined reaches`, missing: ['confined'] } };
  }

  const unresolved = model === undefined && defaultModel === undefined ? undefined : await modelHold({ step, tools, model, defaultModel, config });

  if (unresolved) return { kind: 'hold', held: unresolved };
  const lease: ConfinedLease = { dir: place.dir, level: place.level, tools: [first, ...rest] };

  if (place.schema !== undefined) lease.schema = place.schema;

  return { kind: 'grant', lease };
}
