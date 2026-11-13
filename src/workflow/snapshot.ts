import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { RunOriginSchema } from '../default-workflows.js';
import { RunModeSchema } from '../launch-context.js';
import { canonicalJson } from '../utils/canonical-json.js';
import { redact } from '@teamai/shared/redact';
import type { JsonValue } from '../types.js';
import { isRecord } from './expression.js';
import { CommitIdSchema, DeliveryReceiptSchema, UnresolvedCreateSchema } from './delivery-schema.js';
import { privateSteps } from './scope.js';
import {
  ArchivedPassSchema, LimitsFromSchema, ReleasedTokensSchema, SessionContinuationSchema, StepCheckpointSchema, type ArchivedPass, type HitlAnswer, type StepPass, type StepState,
} from './step-state.js';
import { TeamPinSchema } from './store.js';
import { DriverNameSchema } from './driver-name.js';
import { STARTED_BY, type Finalizing, type RunState, type StepLease, type WorkflowDefinition, type WorkflowFailure } from './types.js';

/**
 * The run state one install hands to another, at `workflows/runs/<id>/state.json` on `teamai-reports`. It carries what
 * the steps did and what expressions read, never this machine's driver identities, paths, or the workflow definitions.
 */

/** The install that owns a published run: a random id kept under its data home, and the member's team username for messages. */
const OwnerSchema = z.object({ id: z.string().min(1), user: z.string() });

export type HandoffOwner = z.infer<typeof OwnerSchema>;

const ReportedCommitsSchema = z.object({
  changes: z.object({ base: CommitIdSchema, from: CommitIdSchema, to: CommitIdSchema, commits: z.array(CommitIdSchema) }).optional(),
  read: z.object({ base: CommitIdSchema, commit: CommitIdSchema }).optional(),
});

const StepCommitsSchema = ReportedCommitsSchema.extend({ passes: z.array(ReportedCommitsSchema).optional() });

/** `schema`, with the commits a step or pass reports parsed as commit ids; the local run file accepts any string there. */
function withCommitIds<T extends z.ZodType>(schema: T): T {
  return schema.superRefine((value, ctx) => {
    const reported = StepCommitsSchema.safeParse(value);

    if (!reported.success) for (const issue of reported.error.issues) ctx.addIssue({ code: z.ZodIssueCode.custom, path: issue.path, message: issue.message });
  });
}

const BodySchema = z.object({
  schemaVersion: z.literal('v1alpha1'),
  name: z.string(),
  alias: z.string().optional(),
  revision: z.number().int(),
  status: z.enum(['running', 'succeeded', 'failed', 'cancelled']),
  end: z.string().optional(),
  failure: z.object({ code: z.string(), message: z.string() }).optional(),
  finalizing: z.object({
    outcome: z.enum(['succeeded', 'failed', 'cancelled']), end: z.string().optional(),
    failure: z.object({ code: z.string(), message: z.string() }).optional(), since: z.string(), until: z.string(),
  }).optional(),
  timeout: z.number().int().positive().optional(),
  inputs: z.record(z.string(), z.unknown()).optional(),
  sourceHash: z.string(),
  definitionHash: z.string(),
  teamRevision: CommitIdSchema.optional(),
  /** The team pin as the run started it. Its patch stays on the machine that started the run, so a pin with one is read nowhere else. */
  teamPin: TeamPinSchema.optional(),
  runMode: RunModeSchema.optional(),
  origin: RunOriginSchema.optional(),
  startedBy: z.enum(STARTED_BY).optional(),
  awaits: z.object({ driver: DriverNameSchema }).optional(),
  settledCount: z.number().int(),
  cancelledAttempts: z.array(z.string()),
  archive: z.array(withCommitIds(ArchivedPassSchema)),
  round: z.number().int().optional(),
  base: z.object({ ref: z.string().optional(), commit: CommitIdSchema }).optional(),
  /** The run's workspaces by branch, with the commit each was last reported at. Which driver holds one stays local. */
  copies: z.record(z.string(), z.object({ commit: CommitIdSchema.optional(), from: z.string().optional() })),
  deliveries: z.array(DeliveryReceiptSchema).optional(),
  /** The requests a claimer looks up before anything opens another: the machine that handed the run over may have opened them. */
  creating: z.array(UnresolvedCreateSchema).optional(),
  sessionContinuations: z.array(SessionContinuationSchema).optional(),
  releasedTokens: z.array(ReleasedTokensSchema).optional(),
  createdAt: z.string(),
  limitsFrom: LimitsFromSchema.optional(),
  updatedAt: z.string(),
  retainedUntil: z.string().optional(),
  steps: z.array(withCommitIds(StepCheckpointSchema)),
});

export type SnapshotBody = z.infer<typeof BodySchema>;

/**
 * What a publish says of the run beside its state: the business repository it works in, as `host/owner/repo`, and, while
 * it runs, that its owner offers it to whoever takes it next with `teamai workflow resume --next`. A claim drops the offer.
 */
const HandoffSchema = z.object({
  repository: z.string().min(1).optional(),
  offered: z.object({ at: z.string() }).optional(),
});

export type Handoff = z.infer<typeof HandoffSchema>;

// Header first, `write` on its own line: two writes of one snapshot then always conflict when git rebases one onto the other.
const SnapshotSchema = z.object({
  snapshot: z.literal(1),
  run: z.string(),
  owner: OwnerSchema,
  ownedAt: z.string(),
  ...HandoffSchema.shape,
  stateRevision: z.number().int().positive(),
  write: z.string().min(1),
}).merge(BodySchema).superRefine((snapshot, ctx) => {
  // A claim hands each copy's branch to git, so a snapshot never names a branch outside its own run.
  for (const [branch, copy] of Object.entries(snapshot.copies)) {
    if (!branch.startsWith(`teamai/${snapshot.run}/`)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['copies', branch], message: 'is not a branch of this run' });

    // A pull request from the copy may target the branch it started from.
    if (copy.from !== undefined && !copy.from.startsWith(`teamai/${snapshot.run}/`)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['copies', branch, 'from'], message: 'is not a branch of this run' });
    }
  }
});

export type RunSnapshot = z.infer<typeof SnapshotSchema>;

export type SnapshotError =
  | { code: 'snapshot_unsupported'; field: string; message: string }
  | { code: 'secret_detected'; step?: string; field: string; label: string; message: string }
  | { code: 'local_path_detected'; step?: string; field: string; message: string };

type Parsed<T> = { ok: true; value: T } | { ok: false; error: SnapshotError };

/** Where on `teamai-reports` the snapshots are, one directory per run. */
export const SNAPSHOTS_DIR = 'workflows/runs';

export function snapshotPath(runId: string): string {
  return `${SNAPSHOTS_DIR}/${runId}/state.json`;
}

/** The text a snapshot is written as: two-space JSON, one field per line, ending in a newline. */
export function snapshotText(snapshot: RunSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

/** Identifies the parsed definitions a run executes, whatever file layout produced them. */
export function definitionHash(definition: WorkflowDefinition, workflows: Record<string, WorkflowDefinition> = {}): string {
  return createHash('sha256').update(canonicalJson({ definition, workflows })).digest('hex');
}

/** The body of a snapshot without its header, as compared to decide whether a publish changes anything. */
export function snapshotBody(snapshot: RunSnapshot): SnapshotBody {
  const { snapshot: _format, run: _run, owner: _owner, ownedAt: _ownedAt, repository: _repository, offered: _offered, stateRevision: _revision, write: _write, ...body } = snapshot;

  return body;
}

/**
 * Parses a snapshot read from `teamai-reports`. A field this version does not know refuses rather than being dropped:
 * the run would continue without it on this machine and lose it on the next publish.
 */
export function parseSnapshot(text: string, runId: string): Parsed<RunSnapshot> {
  let value: JsonValue;

  try {
    value = JSON.parse(text);
  } catch {
    return unsupported(runId, 'snapshot', 'is not JSON');
  }

  if (!isRecord(value) || value.snapshot !== 1) return unsupported(runId, 'snapshot', 'has a format version this teamai cannot read');
  const parsed = SnapshotSchema.safeParse(value);

  if (!parsed.success) {
    const issue = parsed.error.issues[0];

    return unsupported(
      runId,
      issue ? fieldPath(issue.path) : 'snapshot',
      'is not valid',
      `Update teamai, or publish the run again from the machine that owns it: teamai workflow publish ${runId}`,
    );
  }

  const unknown = droppedField(value, parsed.data, []);

  if (unknown !== undefined) return unsupported(runId, unknown, 'is a field this teamai does not know');

  if (parsed.data.run !== runId) return unsupported(runId, 'run', `names run ${parsed.data.run}`);

  return { ok: true, value: parsed.data };
}

function unsupported(runId: string, field: string, problem: string, next = 'Update teamai and try again.'): Parsed<never> {
  return {
    ok: false,
    error: {
      code: 'snapshot_unsupported',
      field,
      message: `The snapshot of run ${runId} on teamai-reports cannot be read: "${field}" ${problem}. ${next}`,
    },
  };
}

/** The first field of `input` that parsing left out of `output`, as a path. */
function droppedField<Output>(input: JsonValue | undefined, output: Output, at: Array<string | number>): string | undefined {
  if (Array.isArray(input)) {
    if (!Array.isArray(output)) return fieldPath(at);

    for (const [index, item] of input.entries()) {
      const dropped = droppedField(item, output[index], [...at, index]);

      if (dropped !== undefined) return dropped;
    }

    return undefined;
  }

  if (!isRecord(input)) return undefined;

  if (!isRecord(output)) return fieldPath(at);

  for (const [key, item] of Object.entries(input)) {
    if (!(key in output)) return fieldPath([...at, key]);
    const dropped = droppedField(item, output[key], [...at, key]);

    if (dropped !== undefined) return dropped;
  }

  return undefined;
}

function fieldPath(at: ReadonlyArray<PropertyKey>): string {
  return at.map((part, index) => (Number.isInteger(part) ? `[${String(part)}]` : index === 0 ? String(part) : `.${String(part)}`)).join('') || 'snapshot';
}

/** Replaces every failure message: it is free text from a tool or the engine, and no expression reads it. */
const HANDED_FAILURE_MESSAGE = 'The details stay on the machine that ran this step.';

/** Every key of every member of a union, so a field only some step statuses have is classified too. */
type KeysOfUnion<T> = T extends unknown ? keyof T : never;

/**
 * How a snapshot carries each field of `T`: `publish` copies the value as it is, `drop` keeps it on this machine, and
 * `rewrite` carries what the field's handler in a {@link Rewrites} table builds instead. Every key must be listed, so a
 * field added to one of these types does not compile until someone decides here whether it may leave the machine. A
 * published value's own type is what the snapshot schema parses, and every string in it is checked for secrets.
 */
type FieldRules<T> = { readonly [K in KeysOfUnion<T>]-?: 'publish' | 'drop' | 'rewrite' };

/** A handler for every field `R` marks `rewrite`, and for no other: what the snapshot carries in that field's place. */
type Rewrites<T, R> = { readonly [K in keyof R as R[K] extends 'rewrite' ? K : never]: (value: T) => Partial<Record<string, JsonValue>> };

const RUN_RULES = {
  schemaVersion: 'publish', id: 'rewrite', name: 'publish', alias: 'publish', revision: 'publish', status: 'publish', driver: 'drop',
  end: 'publish', failure: 'rewrite', finalizing: 'rewrite', timeout: 'publish', inputs: 'publish', sourceHash: 'publish', teamRevision: 'publish', teamPin: 'publish', runMode: 'publish', origin: 'publish',
  startedBy: 'publish', awaits: 'publish', definition: 'rewrite', workflows: 'rewrite', folder: 'drop', folders: 'drop', admitted: 'drop', steps: 'rewrite', settledAttempts: 'rewrite', settledCount: 'rewrite',
  endRecordQueued: 'drop', cancelledAttempts: 'rewrite', archive: 'rewrite', round: 'publish', base: 'publish',
  checkout: 'drop', driveOptions: 'drop', copies: 'rewrite', deliveries: 'publish', creating: 'publish', sessionContinuations: 'publish', releasedTokens: 'publish',
  stoppedAttempts: 'drop', publication: 'drop', leftovers: 'drop', createdAt: 'publish', limitsFrom: 'publish', updatedAt: 'publish', retainedUntil: 'publish',
} satisfies FieldRules<RunState>;

const STEP_RULES = {
  id: 'publish', pass: 'publish', passes: 'rewrite', answer: 'rewrite', item: 'publish', inputs: 'publish',
  iteration: 'publish', round: 'publish', status: 'publish', attempt: 'publish', lease: 'rewrite', outcome: 'publish',
  outputs: 'publish', end: 'publish', results: 'publish', pr: 'publish', settledAt: 'publish', exitCode: 'publish', message: 'drop',
  tool: 'publish', model: 'publish', session: 'publish', tokens: 'publish', changes: 'publish', read: 'publish',
  agent: 'publish', used: 'publish', installId: 'publish', loopFinal: 'publish', failure: 'rewrite', delivery: 'publish', unenforced: 'publish',
  runMode: 'publish', expiresAt: 'publish', limitsFrom: 'publish', allowanceSpent: 'publish', outcomes: 'publish', limit: 'publish', durationMs: 'publish', cost: 'publish',
  confined: 'publish', progress: 'drop',
} satisfies FieldRules<StepState>;

const PASS_RULES = {
  pass: 'publish', attempt: 'publish', outcome: 'publish', outputs: 'publish', end: 'publish', results: 'publish', pr: 'publish',
  failure: 'rewrite', exitCode: 'publish', message: 'drop', tool: 'publish', model: 'publish', session: 'publish',
  tokens: 'publish', changes: 'publish', read: 'publish', agent: 'publish', used: 'publish', installId: 'publish', answer: 'rewrite',
  delivery: 'publish', unenforced: 'publish', runMode: 'publish', outcomes: 'publish', limit: 'publish', durationMs: 'publish', cost: 'publish',
  confined: 'publish', progress: 'drop',
} satisfies FieldRules<StepPass>;

const ARCHIVED_RULES = { ...PASS_RULES, step: 'publish', within: 'publish', item: 'publish' } satisfies FieldRules<ArchivedPass>;

// What a step of a private workflow produced stays on the machine that ran it, with the item and inputs built from it;
// the step that runs that workflow publishes only the outputs the workflow declares.
const PRIVATE_STEP_RULES = { ...STEP_RULES, item: 'drop', inputs: 'drop', outputs: 'drop', results: 'drop' } satisfies FieldRules<StepState>;
const PRIVATE_PASS_RULES = { ...PASS_RULES, outputs: 'drop', results: 'drop' } satisfies FieldRules<StepPass>;
const PRIVATE_ARCHIVED_RULES = { ...ARCHIVED_RULES, item: 'drop', outputs: 'drop', results: 'drop' } satisfies FieldRules<ArchivedPass>;

const ANSWER_RULES = {
  choice: 'publish', note: 'publish', at: 'publish', channel: 'publish', agent: 'publish', driver: 'drop',
} satisfies FieldRules<HitlAnswer>;

// A person's note on a private step may say what the step keeps on this machine.
const PRIVATE_ANSWER_RULES = { ...ANSWER_RULES, note: 'drop' } satisfies FieldRules<HitlAnswer>;

// Quoted so the records test that collects every failure code literal in src/workflow does not read this rule as one.
const FAILURE_RULES = { 'code': 'publish', message: 'rewrite' } satisfies FieldRules<WorkflowFailure>;

// A lease another machine held is released when the run is handed over, so the session it offered stays here.
const LEASE_RULES = { attempt: 'publish', revision: 'publish', driver: 'rewrite', session: 'drop', unenforced: 'drop', expiresAt: 'drop', leasedAt: 'drop', runMode: 'drop', limits: 'drop', confined: 'drop' } satisfies FieldRules<StepLease>;

// An isolated run, the only one with a clone, is never published. A team copy is delivered only where it ran: another
// machine reads its branch as a run branch, which the project's origin does not have, so its delivery fails.
const COPY_RULES = { owner: 'drop', commit: 'publish', from: 'publish', used: 'drop', kind: 'drop', base: 'drop' } satisfies FieldRules<NonNullable<RunState['copies']>[string]>;

const FINALIZING_RULES = { outcome: 'publish', end: 'publish', failure: 'rewrite', since: 'publish', until: 'publish' } satisfies FieldRules<Finalizing>;

const FAILURE_REWRITES = {
  message: () => ({ message: HANDED_FAILURE_MESSAGE }),
} satisfies Rewrites<WorkflowFailure, typeof FAILURE_RULES>;

const FINALIZING_REWRITES = {
  failure: (finalizing) => (finalizing.failure ? { failure: handed(finalizing.failure, FAILURE_RULES, FAILURE_REWRITES) } : {}),
} satisfies Rewrites<Finalizing, typeof FINALIZING_RULES>;

const LEASE_REWRITES = {
  driver: (lease) => ({ driverKind: lease.driver.kind }),
} satisfies Rewrites<StepLease, typeof LEASE_RULES>;

const PASS_REWRITES = {
  failure: (pass) => (pass.failure ? { failure: handed(pass.failure, FAILURE_RULES, FAILURE_REWRITES) } : {}),
  answer: (pass) => (pass.answer ? { answer: handed(pass.answer, ANSWER_RULES, {}) } : {}),
} satisfies Rewrites<StepPass, typeof PASS_RULES>;

const PRIVATE_PASS_REWRITES = {
  ...PASS_REWRITES,
  answer: (pass) => (pass.answer ? { answer: handed(pass.answer, PRIVATE_ANSWER_RULES, {}) } : {}),
} satisfies Rewrites<StepPass, typeof PRIVATE_PASS_RULES>;

const STEP_REWRITES = {
  passes: (step) => (step.passes ? { passes: step.passes.map((pass) => handed(pass, PASS_RULES, PASS_REWRITES)) } : {}),
  answer: (step) => (step.answer ? { answer: handed(step.answer, ANSWER_RULES, {}) } : {}),
  lease: (step) => (step.status === 'leased' ? { lease: handed(step.lease, LEASE_RULES, LEASE_REWRITES) } : {}),
  failure: (step) => ('failure' in step && step.failure ? { failure: handed(step.failure, FAILURE_RULES, FAILURE_REWRITES) } : {}),
} satisfies Rewrites<StepState, typeof STEP_RULES>;

const PRIVATE_STEP_REWRITES = {
  ...STEP_REWRITES,
  passes: (step) => (step.passes ? { passes: step.passes.map((pass) => handed(pass, PRIVATE_PASS_RULES, PRIVATE_PASS_REWRITES)) } : {}),
  answer: (step) => (step.answer ? { answer: handed(step.answer, PRIVATE_ANSWER_RULES, {}) } : {}),
} satisfies Rewrites<StepState, typeof PRIVATE_STEP_RULES>;

const RUN_REWRITES = {
  // The snapshot header names the run.
  id: () => ({}),
  definition: (run) => ({ definitionHash: definitionHash(run.definition, run.workflows) }),
  workflows: () => ({}),
  failure: (run) => (run.failure ? { failure: handed(run.failure, FAILURE_RULES, FAILURE_REWRITES) } : {}),
  finalizing: (run) => (run.finalizing ? { finalizing: handed(run.finalizing, FINALIZING_RULES, FINALIZING_REWRITES) } : {}),
  steps: (run) => {
    const isPrivate = privateSteps(run);

    return { steps: run.steps.map((step) => (isPrivate(step.id) ? handed(step, PRIVATE_STEP_RULES, PRIVATE_STEP_REWRITES) : handed(step, STEP_RULES, STEP_REWRITES))) };
  },
  // settledAttempts only dedups reports on this machine; the engine counts from it when settledCount is absent.
  settledAttempts: () => ({}),
  settledCount: (run) => ({ settledCount: run.settledCount ?? run.settledAttempts.length }),
  cancelledAttempts: (run) => ({ cancelledAttempts: run.cancelledAttempts ?? [] }),
  archive: (run) => {
    const isPrivate = privateSteps(run);

    return { archive: (run.archive ?? []).map((pass) => (isPrivate(pass.step) ? handed(pass, PRIVATE_ARCHIVED_RULES, PRIVATE_PASS_REWRITES) : handed(pass, ARCHIVED_RULES, PASS_REWRITES))) };
  },
  copies: (run) => ({ copies: Object.fromEntries(Object.entries(run.copies ?? {}).map(([branch, copy]) => [branch, handed(copy, COPY_RULES, {})])) }),
} satisfies Rewrites<RunState, typeof RUN_RULES>;

/** `value` as a snapshot carries it under `rules`, with each rewritten field replaced by what its handler builds. */
function handed<T extends object, R extends FieldRules<T>>(value: T, rules: R, rewrites: Rewrites<T, R>): Record<string, JsonValue> {
  const entries: Array<[string, unknown]> = Object.entries(rules);
  const builders: Array<(value: T) => Partial<Record<string, JsonValue>>> = Object.values(rewrites);
  // A run's fields are what its JSON file holds, so each published one is a JSON value.
  const fields = new Map<string, JsonValue | undefined>(Object.entries(value));

  const kept = entries.flatMap(([key, rule]) => {
    const field = fields.get(key);

    return rule === 'publish' && field !== undefined ? [[key, field] as const] : [];
  });

  return Object.assign(Object.fromEntries(kept), ...builders.map((build) => build(value)));
}

/**
 * The snapshot body of `run`, or why it cannot leave this machine. Every string and key it would publish is checked
 * against the secret patterns, the values of `secrets` keyed by their names, and the shapes of an absolute path of this
 * machine, and a hit names where, never the value.
 */
export function projectRun(run: RunState, secrets: Record<string, string>): Parsed<SnapshotBody> {
  const projected = handed(run, RUN_RULES, RUN_REWRITES);
  const unfit = firstUnpublishable(run.id, projected, secrets);

  if (unfit) return { ok: false, error: unfit };
  const parsed = BodySchema.safeParse(projected);

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue ? fieldPath(issue.path) : 'run';

    return { ok: false, error: { code: 'snapshot_unsupported', field, message: `Run ${run.id} cannot be published: its "${field}" is not valid.` } };
  }

  // A field the rules publish but the snapshot format has no place for would vanish on the machine that claims the run.
  const lost = droppedField(projected, parsed.data, []);

  if (lost !== undefined) {
    return { ok: false, error: { code: 'snapshot_unsupported', field: lost, message: `Run ${run.id} cannot be published: the snapshot format has no place for its "${lost}".` } };
  }

  return { ok: true, value: parsed.data };
}

const PLACEHOLDER = /<REDACTED:([^>]+)>/;

/** A path from the root of a drive or share, from a home directory, or as a file URL: none means anything on another machine. */
const ROOTED_PATH = /(?<![\w\\])(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+\\)|(?<![\w.~\-/\\])~[\\/]|\bfile:\/\//i;

/** A `/` that starts a path rather than continuing a word, a URL, or another path, with the path's first directory. */
const SLASH_PATH = /(?<![\w.~\-/\\])\/(?!\/)([^/\s"'`)<>\]}|,;]+)/g;

/**
 * Whether `text` holds an absolute path of this machine. A `/` path counts when its first directory exists at this
 * machine's root, as `/Users` or `/home` does, so a route such as `/api/v1` does not.
 */
function holdsLocalPath(text: string): boolean {
  return ROOTED_PATH.test(text) || [...text.matchAll(SLASH_PATH)].some(([, first]) => first !== undefined && fs.existsSync(path.join('/', first)));
}

type Unfit = { kind: 'secret'; label: string } | { kind: 'path' };

function firstUnpublishable(runId: string, body: Record<string, JsonValue>, envSecrets: Record<string, string>): SnapshotError | undefined {
  const labelOf = (text: string): string | undefined => {
    const redacted = redact(text, { envSecrets });

    return redacted === text ? undefined : PLACEHOLDER.exec(redacted)?.[1] ?? 'secret';
  };

  const unfitOf = (text: string): Unfit | undefined => {
    const label = labelOf(text);

    if (label !== undefined) return { kind: 'secret', label };

    return holdsLocalPath(text) ? { kind: 'path' } : undefined;
  };

  const found = (step: string | undefined, at: ReadonlyArray<string | number>, unfit: Unfit): SnapshotError => {
    const field = fieldPath(at);
    const where = step === undefined ? `field "${field}"` : `step "${step}" field "${field}"`;
    const named: { step?: string; field: string } = step === undefined ? { field } : { step, field };

    switch (unfit.kind) {
      case 'secret':
        return {
          code: 'secret_detected',
          ...named,
          label: unfit.label,
          message: `Run ${runId} was not published: ${where} holds what looks like a secret (${unfit.label}). Publishing would copy it to teamai-reports; the run stays on this machine.`,
        };
      case 'path':
        return {
          code: 'local_path_detected',
          ...named,
          message: `Run ${runId} was not published: ${where} holds an absolute path of this machine, which another machine cannot use, so the run stays here. Continue it on this machine, or start it again with paths relative to the repository.`,
        };
      default: {
        const unhandled: never = unfit;

        return unhandled;
      }
    }
  };

  const search = (value: JsonValue | undefined, step: string | undefined, at: Array<string | number>): SnapshotError | undefined => {
    if (value === null || value === undefined) return undefined;

    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        const hit = search(item, step, [...at, index]);

        if (hit) return hit;
      }

      return undefined;
    }

    if (!isRecord(value)) {
      const unfit = unfitOf(String(value));

      return unfit === undefined ? undefined : found(step, at, unfit);
    }

    for (const [key, item] of Object.entries(value)) {
      const unfit = unfitOf(key);

      if (unfit !== undefined) return found(step, at, unfit);
      const hit = search(item, step, [...at, key]);

      if (hit) return hit;
    }

    return undefined;
  };

  for (const [key, value] of Object.entries(body)) {
    const items = key === 'steps' || key === 'archive' ? value : undefined;

    if (!Array.isArray(items)) {
      const hit = search(value, undefined, [key]);

      if (hit) return hit;
      continue;
    }

    for (const [index, item] of items.entries()) {
      const step = isRecord(item) ? String(key === 'steps' ? item.id : item.step) : undefined;
      // A step whose id itself looks like a secret is named by its place in the list instead.
      const hit = step !== undefined && labelOf(step) === undefined ? search(item, step, []) : search(item, undefined, [key, index]);

      if (hit) return hit;
    }
  }

  return undefined;
}
