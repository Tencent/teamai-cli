import path from 'node:path';
import { z } from 'zod';
import { RUN_DIR_ENV } from '@teamai/runtime-protocol';
import { attemptMarker } from './launch-context.js';
import type { SearchIndex } from './types.js';
import { appendJsonl, readJsonl } from './utils/jsonl-store.js';

const Revision = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);

export const IndexProvenance = z.object({
  teamRevision: Revision.optional(),
  // Null means known absent; omission means unknown.
  learningsRevision: Revision.nullable().optional(),
}).strict();

export type IndexProvenance = z.infer<typeof IndexProvenance>;

export const RecallObservation = z.object({
  queried: z.boolean().nullable(),
  unavailable: z.boolean(),
  indexes: z.array(IndexProvenance),
}).strict();

export type RecallObservation = z.infer<typeof RecallObservation>;

export const RECALL_TRACE_ENV = 'TEAMAI_BENCHMARK_RECALL_TRACE';

function traceFile(dir: string, attempt: string): string {
  return path.join(dir, 'recall-provenance', `${attempt}.jsonl`);
}

/** One line per query; never records query text, index entries or paths. */
export async function recordRecallIndexes(env: NodeJS.ProcessEnv, indexes: readonly SearchIndex[]): Promise<void> {
  const [, attempt] = attemptMarker(env)?.match(/^r(?:[0-9a-f]{8}|[0-9a-f]{16})\/(a[0-9a-f]{8})$/) ?? [];
  const dir = env[RUN_DIR_ENV];

  if (env[RECALL_TRACE_ENV] !== '1' || !dir || !attempt) return;
  await appendJsonl(traceFile(dir, attempt), {
    indexes: indexes.map(({ provenance }) => IndexProvenance.safeParse(provenance).data ?? null),
  });
}

export function mergeRecallObservations(observed: readonly RecallObservation[]): RecallObservation {
  const revisions = observed.flatMap(({ indexes }) => indexes);
  const key = ({ teamRevision, learningsRevision }: IndexProvenance): string => JSON.stringify([teamRevision ?? null, learningsRevision === undefined ? false : learningsRevision]);
  const unique = new Map(revisions.map((revision) => [key(revision), revision]));

  const queried = observed.some((one) => one.queried === true) ? true
    : observed.some((one) => one.queried === null) ? null : false;

  return { queried, unavailable: observed.some(({ unavailable }) => unavailable), indexes: [...unique.values()] };
}

export async function readRecallObservation(dir: string, attempt: string): Promise<RecallObservation> {
  const rows = await readJsonl(traceFile(dir, attempt));
  const indexes = rows.flatMap((row) => z.array(IndexProvenance.nullable()).safeParse(row.indexes).data ?? [null]);

  return mergeRecallObservations([{
    queried: rows.length > 0,
    unavailable: rows.some((row) => Array.isArray(row.indexes) && row.indexes.length === 0)
      || indexes.some((index) => !index?.teamRevision || index.learningsRevision === undefined),
    indexes: indexes.filter((index): index is IndexProvenance => index !== null),
  }]);
}
