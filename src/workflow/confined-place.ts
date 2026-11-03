/**
 * The directory a step with `workspace: { confined }` runs in, as the engine checks it each time it leases the step: a
 * directory under the run's `$TEAMAI_RUN_DIR`, not a link, that holds the `confined.json` an earlier step wrote. That
 * file sets the level the step runs at; the workflow file cannot set or loosen it.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { isAgentToolId } from '../tools.js';
import type { LocalConfig } from '../types.js';
import { errnoCode } from '../utils/fs.js';
import type { ConfinedLease } from './lease-wire.js';
import { ConfinedLevelSchema, type DriverCan, type Held } from './requirements.js';
import { chooseStepModel, type StepModel } from './step-model.js';
import type { WorkflowFailure } from './types.js';

const CONFINED_FILE = 'confined.json';

/** `confined.json`: the level the step runs at, the tool to try first, and the reply's JSON Schema, a file in the directory. */
const ConfinedFileSchema = z.object({
  level: ConfinedLevelSchema,
  prefer: z.string().min(1).optional(),
  schema: z.string().min(1).optional(),
}).strict();

type ConfinedFile = z.infer<typeof ConfinedFileSchema>;

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

/**
 * Checks `dir`, the directory step `step` was rendered to, a relative one under `runDir`, the run's `$TEAMAI_RUN_DIR`:
 * it is a directory, not a link, whose real path is under the real `runDir`, and it holds a `confined.json` teamai reads.
 * Every refusal is `confined_invalid`, which fails the step: the next lease would find the same directory.
 */
export async function checkConfinedDir({ step, runDir, dir }: { step: string; runDir: string; dir: string }): Promise<ConfinedDirCheck> {
  const target = path.resolve(runDir, dir);
  const stat = await lstatOf(target);
  const at = `Step "${step}" runs confined to ${target}`;

  if (!stat) return invalid(`${at}, which does not exist. ${HOW}.`);

  if (stat.isSymbolicLink()) return invalid(`${at}, which is a symlink. ${HOW}, not a link to it.`);

  if (!stat.isDirectory()) return invalid(`${at}, which is not a directory. ${HOW}.`);
  const [real, root] = await Promise.all([fs.realpath(target), fs.realpath(runDir)]);

  if (!isInside(root, real)) return invalid(`${at}, which is not under the run's $TEAMAI_RUN_DIR, ${root}. ${HOW}.`);
  const file = path.join(real, CONFINED_FILE);
  const read = await jsonFile(file);

  if (!read.ok) return invalid(`${at}, whose ${CONFINED_FILE} ${read.reason}. Write ${CONFINED_FILE} there with the level the step runs at, such as {"level":"verified"}.`);
  const parsed = ConfinedFileSchema.safeParse(read.value);

  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';

    return invalid(`Step "${step}" reads ${file}, which is not a ${CONFINED_FILE} teamai reads (${where}${issue?.message ?? 'invalid'}). Write {"level": "verified" or "best-effort", "prefer": <tool>, "schema": <a JSON Schema file in the directory>}, prefer and schema optional.`);
  }

  const { schema, ...rest } = parsed.data;

  if (schema === undefined) return { ok: true, place: { ...rest, dir: real } };
  const found = await schemaFile(step, real, schema);

  return found.ok ? { ok: true, place: { ...rest, schema: found.file, dir: real } } : found.check;
}

/**
 * The tools a confined step at `level` may run on, from a driver's `can.confined`: the tools of each offer at that level
 * or stricter, in the order the driver lists them, each once, with `prefer` first when it is among them.
 */
export function confinedCandidates(offers: Offers, { level, prefer }: Pick<ConfinedFile, 'level' | 'prefer'>): string[] {
  const tools = new Set(offers.filter((offer) => offer.level === 'verified' || level === 'best-effort').flatMap((offer) => offer.tools));

  return prefer !== undefined && tools.has(prefer) ? [prefer, ...[...tools].filter((tool) => tool !== prefer)] : [...tools];
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

  if (first === undefined) {
    return { kind: 'hold', held: { step, reason: `step "${step}" runs confined at ${place.level}, which no offer in this driver's can.confined reaches`, missing: ['confined'] } };
  }

  if (model !== undefined || defaultModel !== undefined) {
    const choices = await Promise.all(tools.map((tool) => (isAgentToolId(tool) ? chooseStepModel({ step, tool, model, defaultModel, config }) : undefined)));

    if (!choices.some((choice) => choice?.ok)) {
      const why = choices.find((choice) => choice?.ok === false)?.failure.message;

      return { kind: 'hold', held: { step, reason: `step "${step}" needs a model one of its confined tools resolves, and none of ${tools.join(', ')} does${why === undefined ? '' : `: ${why}`}`, missing: ['model'] } };
    }
  }

  const lease: ConfinedLease = { dir: place.dir, level: place.level, tools: [first, ...rest] };

  if (place.schema !== undefined) lease.schema = place.schema;

  return { kind: 'grant', lease };
}
