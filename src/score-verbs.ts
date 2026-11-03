/**
 * The verbs of `teamai score` that the steps of a `teamai-score` run call: plan, evidence, stage, label, write, settle
 * and subjects. Each prints one JSON object, the step's outputs, on stdout; a refusal prints `{"error":…}` and exits 1.
 */
import { z } from 'zod';
import { autoDetectInit } from './config.js';
import { EvidenceDir } from './scorers/evidence-dir.js';
import { DEMANDS } from './scorers/marks.js';
import { ScoreAttempt } from './scorers/score-attempt.js';
import { planGroups } from './scorers/score-plan.js';
import { Subject } from './scorers/subject.js';
import type { JsonObject, LocalConfig } from './types.js';
import { setStderrOnly } from './utils/logger.js';

/** Where a verb runs: the process's environment, the scope of its directory, and the time it reads as now. */
export interface ScoreVerbContext {
  env: NodeJS.ProcessEnv;
  current: LocalConfig | undefined;
  now: string;
}

export type ScoreVerbAnswer = { ok: true; output: JsonObject } | { ok: false; code: string; message: string };

function refused(code: string, message: string): ScoreVerbAnswer {
  return { ok: false, code, message };
}

const ScorersSchema = z.array(z.string().min(1));

/** `--scorers`, a JSON array as the run's `scorers` input renders, or names joined by `,` as a group's `scorers` is. */
function scorersOf(value: string | undefined): string[] | undefined {
  const text = (value ?? '').trim();

  if (text === '') return [];

  if (!text.startsWith('[')) return text.split(',').map((name) => name.trim()).filter((name) => name !== '');

  try {
    const parsed = ScorersSchema.safeParse(JSON.parse(text));

    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export interface PlanOptions {
  subject?: string;
  scorers?: string;
  label?: string;
  batch?: string;
  demand?: string;
}

async function plan(options: PlanOptions, ctx: ScoreVerbContext): Promise<ScoreVerbAnswer> {
  const read = await ScoreAttempt.read('plan', ctx.env, ctx.current);

  if (!read.ok) return read;
  const subject = Subject.parse(options.subject ?? '');

  if (!subject.ok) return subject;
  const scorers = scorersOf(options.scorers);

  if (!scorers) return refused('invalid_arguments', `--scorers ${options.scorers ?? ''} is neither a JSON array of scorer names nor names joined by ",".`);
  const demand = DEMANDS.find((value) => value === (options.demand ?? 'auto'));

  if (!demand) return refused('invalid_arguments', `--demand ${options.demand ?? ''} is neither auto nor named.`);

  if (options.batch !== undefined && options.batch !== 'true' && options.batch !== 'false') return refused('invalid_arguments', `--batch=${options.batch} is neither true nor false.`);
  const planned = await planGroups({ attempt: read.attempt, subject: subject.subject, scorers, label: options.label ?? '', batch: options.batch === 'true', demand, now: ctx.now });

  return planned.ok ? { ok: true, output: { groups: planned.groups.map((group) => ({ ...group })) } } : planned;
}

export interface EvidenceOptions {
  subject?: string;
  scorers?: string;
}

async function evidence(options: EvidenceOptions, ctx: ScoreVerbContext): Promise<ScoreVerbAnswer> {
  const read = await ScoreAttempt.read('evidence', ctx.env, ctx.current);

  if (!read.ok) return read;
  const subject = Subject.parse(options.subject ?? '');

  if (!subject.ok) return subject;
  const scorers = scorersOf(options.scorers);

  if (!scorers) return refused('invalid_arguments', `--scorers ${options.scorers ?? ''} is neither a JSON array of scorer names nor names joined by ",".`);
  const written = await EvidenceDir.write(read.attempt, { subject: subject.subject, scorers, hand: read.attempt.hand !== '' });

  return written.ok ? { ok: true, output: { ...written.output } } : written;
}

export const ScoreVerbs = { plan, evidence } as const;

export type ScoreVerb = keyof typeof ScoreVerbs;

async function currentConfig(): Promise<LocalConfig | undefined> {
  try {
    // oxlint-disable-next-line teamai/config-load-options -- a verb runs in a step's process, which has no preview mode
    return (await autoDetectInit()).localConfig;
  } catch {
    return undefined;
  }
}

/** Runs one verb in this process and prints its answer. */
export async function scoreVerbCommand<Verb extends ScoreVerb>(verb: Verb, options: Parameters<(typeof ScoreVerbs)[Verb]>[0]): Promise<void> {
  setStderrOnly(true);
  const answer = await ScoreVerbs[verb](options, { env: process.env, current: await currentConfig(), now: new Date().toISOString() });

  if (answer.ok) {
    process.stdout.write(`${JSON.stringify(answer.output)}\n`);

    return;
  }

  process.stdout.write(`${JSON.stringify({ error: { code: answer.code, message: answer.message } })}\n`);
  process.exitCode = 1;
}
