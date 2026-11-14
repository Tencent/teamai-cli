import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../../utils/canonical-json.js';
import type { DriverDefinition, ResolvedDriver } from './definitions.js';

/**
 * Which entry of a driver definition a step runtime was opened from, as each attempt on it records it. `name` is the
 * runtime as records and messages name it (`use`, or `use through through`). `digest` is the sha256 of the entry as it
 * runs: its `use`, `through`, `sandbox` and options, with the member's `workflows.drivers.<driver>.runtimes` for each
 * runtime it names over them. Two entries with one digest start the same runtime on the same options, which answers for
 * the same handles, so either reaches a place the other opened. `sameName`: the entry is the `at`th of the `of` entries
 * of the definition with that name, so only the digest tells which of them holds a place once `of` is more than 1.
 */
export interface RuntimeEntryIdentity {
  name: string;
  digest: string;
  sameName: SameName;
}

/**
 * Where an entry stood among the definition's entries of its runtime name: the `at`th (from 1) of `of`. Each attempt
 * records it beside the digest, so a later teamai knows whether the name alone told the entry apart when the attempt ran.
 */
export const SameNameSchema = z.object({ at: z.number().int().positive(), of: z.number().int().positive() });

type SameName = z.infer<typeof SameNameSchema>;

/**
 * What an attempt's runtime record says of where its place is: the runtime's name, and, once recorded, the entry's digest
 * and where it stood among the entries of that name.
 */
interface RecordedEntry {
  runtime: string;
  entry?: string | undefined;
  sameName?: SameName | undefined;
}

type DefinitionEntry = DriverDefinition['runtimes'][number];

/** The name the engine gives `inner` through `outer`, in its records and messages. */
export function composedName(inner: string, outer: string): string {
  return `${inner} through ${outer}`;
}

const nameOf = (entry: DefinitionEntry): string => (entry.through === undefined ? entry.use : composedName(entry.use, entry.through));

/** The identity of `entry`, one of `driver`'s runtimes, as it runs on this machine. */
function of(driver: ResolvedDriver, entry: DefinitionEntry): RuntimeEntryIdentity {
  const member = driver.config.workflows?.drivers?.[driver.name]?.runtimes;

  const runs = {
    use: entry.use, through: entry.through, sandbox: entry.sandbox, options: entry.options,
    member: { [entry.use]: member?.[entry.use], ...(entry.through !== undefined && { [entry.through]: member?.[entry.through] }) },
  };

  const name = nameOf(entry);
  const named = driver.definition.runtimes.filter((other) => nameOf(other) === name);

  return {
    name,
    digest: createHash('sha256').update(canonicalJson(runs)).digest('hex'),
    sameName: { at: named.indexOf(entry) + 1, of: named.length },
  };
}

/** Whether no other entry of the definition had the attempt's runtime name when it ran; a record from before says nothing. */
const wasNameAlone = (record: RecordedEntry): boolean => record.sameName === undefined || record.sameName.of === 1;

/**
 * Whether the place `record` names is on the runtime of `entry`: by the entry's digest, or by the runtime's name while no
 * other entry of the definition shares it now and none shared it when the attempt ran. The name alone still reaches an
 * entry whose options changed since, as when the member fixed them to stop what ran there, and a record written before
 * records named the entry. It never reaches the entry left once another of the name, which may be the one that ran the
 * attempt, was removed.
 */
function holds(record: RecordedEntry, entry: RuntimeEntryIdentity): boolean {
  return record.entry === entry.digest || (record.runtime === entry.name && entry.sameName.of === 1 && wasNameAlone(record));
}

/**
 * Whether `entry` holds the place `record` names by the runtime's name alone, its digest differing from the one recorded:
 * the entry changed since the attempt ran, so its runtime may run on other options than the one that made the place, and
 * its answer that it knows no such place proves nothing of that place. A record written before records named the entry
 * has no digest to differ.
 */
function isByNameOnly(record: RecordedEntry, entry: RuntimeEntryIdentity): boolean {
  return record.entry !== undefined && record.entry !== entry.digest && holds(record, entry);
}

/**
 * The one of `candidates`, the runtimes driver `driver` opened, that holds the place `record` names, or why none does.
 * None is taken for another of the same name: a stop sent there would find nothing and close nothing it ran.
 */
function find<TCandidate extends { entry: RuntimeEntryIdentity }>(record: RecordedEntry, candidates: readonly TCandidate[], driver: string): { ok: true; found: TCandidate } | { ok: false; why: string } {
  const found = candidates.find((candidate) => holds(record, candidate.entry));

  if (found) return { ok: true, found };
  const named = candidates.filter((candidate) => candidate.entry.name === record.runtime);

  if (named.length === 0) return { ok: false, why: `driver "${driver}" no longer uses that runtime.` };

  if (record.sameName !== undefined && record.sameName.of > 1) return { ok: false, why: `the attempt ran on entry ${record.sameName.at} of the ${record.sameName.of} that driver "${driver}" listed for runtime "${record.runtime}", which is no longer there as it ran: it changed or was removed since, in the definition or in your workflows.drivers.${driver}.runtimes, so teamai cannot tell which entry holds the place. Put that entry back as it was.` };

  if (record.entry !== undefined) return { ok: false, why: `driver "${driver}" lists runtime "${record.runtime}" more than once, and the entry that ran it changed since, in the definition or in your workflows.drivers.${driver}.runtimes, so teamai cannot tell which of them ran it. Put the entry back as it was.` };

  return { ok: false, why: `driver "${driver}" lists runtime "${record.runtime}" more than once, and the attempt's record, which an earlier teamai wrote, does not say which entry ran it.` };
}

/** Which entry of a driver definition each attempt's place is on, and the one test of whether a runtime holds it. */
export const RuntimeEntryIdentity = { of, holds, isByNameOnly, find } as const;
