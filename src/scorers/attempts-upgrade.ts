/**
 * What the judge attempts of a teamai before marks, `<scores>/attempts/<entry>/`, leave as marks. Each entry keeps the
 * state main's lease rules gave it: a closed entry stays closed, an open one opens a mark automatic judging starts
 * again, with its lapses counted and its request's 14 days kept. A session that was tried stays closed, as main never
 * judged one again. Read once, on the upgrade; the attempts are left as they are.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { LocalConfig } from '../types.js';
import { readFileSafe } from '../utils/fs.js';
import { scoresDir } from './home.js';
import { JUDGE_FAILURES, RunSubjectSchema, SessionSubjectSchema, type JudgeFailureCode, type ScoreLabel } from './label.js';
import { LabelStore } from './label-store.js';
import type { MarkKey } from './marks.js';
import { Subject } from './subject.js';

/** What an entry leaves: a label, a failed attempt, or open work with the lapses and request it had. */
export type CarriedMark = { kind: 'labelled' } | { kind: 'failed'; code: JudgeFailureCode } | { kind: 'open'; lapses: number; requestedAt?: string };

/** Main's lease rule: the fourth lapse failed an entry. */
const LEASES_LAPSING = 4;

const Attempt = {
  scorer: z.string().min(1),
  rubric: z.object({ sourceHash: z.string().min(1) }),
  status: z.enum(['leased', 'succeeded', 'failed', 'released']),
  code: z.enum(JUDGE_FAILURES).optional(),
  leasedAt: z.string(),
  expiresAt: z.string(),
};

const AttemptSchema = z.union([
  z.object({ ...Attempt, source: z.literal('session'), subject: SessionSubjectSchema }),
  z.object({ ...Attempt, source: z.literal('workflow').optional(), subject: RunSubjectSchema }),
]);

type Attempt = z.infer<typeof AttemptSchema>;

const RequestSchema = z.object({ scorer: z.string().min(1), subject: RunSubjectSchema, requestedAt: z.string() });

interface Facts {
  key: MarkKey;
  attempts: Attempt[];
  modelLabels: string[];
  requestedAt?: string;
}

async function readJson<T>(file: string, schema: z.ZodType<T>): Promise<T | undefined> {
  try {
    const parsed = schema.safeParse(JSON.parse(await readFileSafe(file) ?? 'null'));

    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The key an attempt or a label was written for. */
function keyOf(judged: Attempt | ScoreLabel): MarkKey {
  return judged.source === 'session'
    ? { scorer: judged.scorer, sourceHash: judged.rubric.sourceHash, subject: { kind: 'session', subject: judged.subject } }
    : { scorer: judged.scorer, subject: { kind: 'run', subject: judged.subject } };
}

/** Each entry's facts by key: its attempts, its request, and the times of the model labels written for it. */
async function factsByKey(config: LocalConfig): Promise<Map<string, Facts>> {
  const root = path.join(scoresDir(config), 'attempts');
  const byKey = new Map<string, Facts>();

  const factsOf = (key: MarkKey): Facts => {
    const id = JSON.stringify([key.scorer, key.sourceHash ?? null, Subject.format(key.subject)]);
    const facts = byKey.get(id) ?? { key, attempts: [], modelLabels: [] };
    byKey.set(id, facts);

    return facts;
  };

  for (const entry of (await fs.readdir(root).catch(() => [])).filter((name) => /^s[0-9a-f]{13}$/.test(name)).sort()) {
    const files = (await fs.readdir(path.join(root, entry)).catch(() => [])).filter((name) => /^a[0-9a-f]{8}\.json$/.test(name)).sort();

    for (const attempt of await Promise.all(files.map((name) => readJson(path.join(root, entry, name), AttemptSchema)))) {
      if (attempt) factsOf(keyOf(attempt)).attempts.push(attempt);
    }

    const request = await readJson(path.join(root, entry, 'request.json'), RequestSchema);

    if (request) factsOf({ scorer: request.scorer, subject: { kind: 'run', subject: request.subject } }).requestedAt = request.requestedAt;
  }

  for (const label of await LabelStore.local(config)) {
    if (label.judge.kind === 'model') factsOf(keyOf(label)).modelLabels.push(label.scoredAt);
  }

  return byKey;
}

function isLive(attempt: Attempt, now: string): boolean {
  return attempt.status === 'leased' && attempt.expiresAt > now;
}

/** Why main gave up on an entry that has no label and no live lease: a failed attempt, a session it tried, or a fourth lapse. */
function givenUp(key: MarkKey, attempts: readonly Attempt[], lapses: number): JudgeFailureCode | undefined {
  const failed = attempts.find((attempt) => attempt.status === 'failed')?.code;

  if (failed) return failed;
  const isGivenUp = key.subject.kind !== 'run' || lapses >= LEASES_LAPSING;

  return isGivenUp ? 'lease_expired' : undefined;
}

/** What one entry leaves, by main's rules: a pass's attempts and labels count only from its latest request on. */
function carried({ key, attempts: all, modelLabels, requestedAt }: Facts, now: string): CarriedMark {
  const since = requestedAt ?? '';
  const attempts = all.filter((attempt) => attempt.leasedAt >= since || isLive(attempt, now));

  if (modelLabels.some((at) => at >= since) || attempts.some((attempt) => attempt.status === 'succeeded')) return { kind: 'labelled' };
  const lapses = attempts.filter((attempt) => attempt.status === 'leased' && !isLive(attempt, now)).length;
  const code = attempts.some((attempt) => isLive(attempt, now)) ? undefined : givenUp(key, attempts, lapses);

  if (code) return { kind: 'failed', code };
  const open: CarriedMark = { kind: 'open', lapses };

  if (requestedAt !== undefined) open.requestedAt = requestedAt;

  return open;
}

/** The mark each entry of this data home's attempts, and each model label written without one, leaves at `now`. */
export async function carriedMarks(config: LocalConfig, now: string): Promise<Array<{ key: MarkKey; mark: CarriedMark }>> {
  return [...(await factsByKey(config)).values()].map((facts) => ({ key: facts.key, mark: carried(facts, now) }));
}
