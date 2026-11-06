/**
 * The verbs of `teamai score` that the steps of a `teamai-score` run call: plan, evidence, stage, label, write, publish,
 * settle and subjects, and report, which a `teamai-try-scorer` run calls. Each prints one JSON object, the step's outputs, on stdout; a refusal prints `{"error":…}` and exits 1.
 */
import path from 'node:path';
import { z } from 'zod';
import { autoDetectInit, NotInitializedError } from './config.js';
import { STAGES } from './scorers/definition.js';
import { EvidenceDir, type GroupRecord } from './scorers/evidence-dir.js';
import { DEMANDS } from './scorers/marks.js';
import { ScoreAttempt } from './scorers/score-attempt.js';
import { LabelStore } from './scorers/label-store.js';
import { ScoreLabels } from './scorers/score-labels.js';
import { planGroups } from './scorers/score-plan.js';
import { ScoreSubjects } from './scorers/score-subjects.js';
import { ScoreStage } from './scorers/score-stage.js';
import { Subject } from './scorers/subject.js';
import { TRY_SCORER_WORKFLOW } from './scorers/judging-workflows.js';
import { TryScorer } from './scorers/try-scorer.js';
import type { JsonObject, LocalConfig } from './types.js';
import { isSameRealPath } from './utils/fs.js';
import { createGit } from './utils/git.js';
import { log, setStderrOnly } from './utils/logger.js';
import { durationMs } from './workflow/parse.js';
import { isIsolated } from './workflow/workspace.js';

/** Where a verb runs: the process's environment, the scope of its directory, and the time it reads as now. */
export interface ScoreVerbContext {
  env: NodeJS.ProcessEnv;
  current: LocalConfig | undefined;
  now: string;
  /** The directory the verb runs in: publish stages there. */
  cwd?: string;
}

export type ScoreVerbAnswer = { ok: true; output: JsonObject } | Refused;

type Refused = { ok: false; code: string; message: string };

function refused(code: string, message: string): Refused {
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

export interface EvidenceOptions {
  subject?: string;
  scorers?: string;
}

/** The attempt a verb on a subject runs in, that subject, and the scorers `--scorers` names. */
async function subjectAt(verb: string, options: EvidenceOptions, ctx: ScoreVerbContext): Promise<{ ok: true; attempt: ScoreAttempt; subject: Subject; scorers: string[] } | Refused> {
  const read = await ScoreAttempt.read(verb, ctx.env, ctx.current);

  if (!read.ok) return read;
  const subject = Subject.parse(options.subject ?? '');

  if (!subject.ok) return subject;
  const scorers = scorersOf(options.scorers);

  if (!scorers) return refused('invalid_arguments', `--scorers ${options.scorers ?? ''} is neither a JSON array of scorer names nor names joined by ",".`);

  return { ok: true, attempt: read.attempt, subject: subject.subject, scorers };
}

export interface PlanOptions extends EvidenceOptions {
  batch?: string;
  demand?: string;
}

const BatchSchema = z.enum(['true', 'false']).default('false');

async function plan(options: PlanOptions, ctx: ScoreVerbContext): Promise<ScoreVerbAnswer> {
  const at = await subjectAt('plan', options, ctx);

  if (!at.ok) return at;
  const demand = DEMANDS.find((value) => value === (options.demand ?? 'auto'));

  if (!demand) return refused('invalid_arguments', `--demand ${options.demand ?? ''} is neither auto nor named.`);
  const batch = BatchSchema.safeParse(options.batch);

  if (!batch.success) return refused('invalid_arguments', `--batch=${options.batch ?? ''} is neither true nor false.`);
  const planned = await planGroups({ attempt: at.attempt, subject: at.subject, scorers: at.scorers, label: at.attempt.hand, batch: batch.data === 'true', demand, now: ctx.now });

  return planned.ok ? { ok: true, output: { groups: planned.groups.map((group) => ({ ...group })) } } : planned;
}

async function evidence(options: EvidenceOptions, ctx: ScoreVerbContext): Promise<ScoreVerbAnswer> {
  const at = await subjectAt('evidence', options, ctx);

  if (!at.ok) return at;
  const written = await EvidenceDir.write(at.attempt, { subject: at.subject, scorers: at.scorers, hand: at.attempt.hand !== '' });

  return written.ok ? { ok: true, output: { ...written.output } } : written;
}

/** The attempt a verb on a group's evidence runs in, and that group as `score evidence` wrote it in a directory of this run's. */
async function groupAt(verb: string, dir: string | undefined, ctx: ScoreVerbContext): Promise<{ ok: true; attempt: ScoreAttempt; dir: string; group: GroupRecord } | Refused> {
  const read = await ScoreAttempt.read(verb, ctx.env, ctx.current);

  if (!read.ok) return read;
  const runDir = path.dirname(read.attempt.dir);
  const at = path.resolve(dir ?? '');
  const inRun = path.dirname(at) === runDir;

  if (!inRun) return { ok: false, code: 'evidence_unreadable', message: `--evidence ${dir ?? ''} is not an evidence directory of run ${read.attempt.run.id}, which are under ${runDir}. Pass the dir its evidence step printed.` };
  const group = await EvidenceDir.read(at);

  return group.ok ? { ok: true, attempt: read.attempt, dir: at, group: group.group } : group;
}

export interface StageOptions {
  stage: string;
  evidence?: string;
  wait?: string;
}

async function stage(options: StageOptions, ctx: ScoreVerbContext): Promise<ScoreVerbAnswer> {
  const at = await groupAt(`stage ${options.stage}`, options.evidence, ctx);

  if (!at.ok) return at;
  const known = STAGES.find((each) => each === options.stage);

  if (!known) return refused('invalid_arguments', `${options.stage} is not a stage. Run teamai score stage check, ci or protected.`);
  const waitMs = options.wait === undefined ? 0 : durationMs(options.wait);

  if (waitMs === undefined) return refused('invalid_arguments', `--wait ${options.wait ?? ''} is not a duration such as 30m or 2h.`);
  const ran = await ScoreStage.run(at.attempt, at.dir, at.group, known, { waitMs, now: ctx.now });

  return ran.ok ? { ok: true, output: { ...ran.output } } : ran;
}

export interface LabelOptions {
  evidence?: string;
  answer?: string;
  judge?: string;
}

async function label(options: LabelOptions, ctx: ScoreVerbContext): Promise<ScoreVerbAnswer> {
  const at = await groupAt('label', options.evidence, ctx);

  if (!at.ok) return at;
  const labelled = await ScoreLabels.label(at.attempt, at.dir, at.group, { answer: options.answer, judged: options.judge, now: ctx.now });

  return labelled.ok ? { ok: true, output: { labels: labelled.labels.map((entry) => ({ ...entry })) } } : labelled;
}

export interface WriteOptions {
  evidence?: string;
}

async function write(options: WriteOptions, ctx: ScoreVerbContext): Promise<ScoreVerbAnswer> {
  const at = await groupAt('write', options.evidence, ctx);

  if (!at.ok) return at;
  const written = await ScoreLabels.write(at.attempt, at.dir, at.group, { now: ctx.now });

  return written.ok ? { ok: true, output: { written: written.written.length, labels: written.written } } : written;
}

/**
 * Stages this member's pending labels in the checkout of teamai-reports the verb runs in, which its step's `deliver:
 * publish` publishes. Outside such a checkout, as when the step's place could not be made, and inside an isolated run,
 * such as a benchmark, whose work stays off the team's, it stages nothing.
 */
async function publish(ctx: ScoreVerbContext): Promise<ScoreVerbAnswer> {
  const read = await ScoreAttempt.read('publish', ctx.env, ctx.current);

  if (!read.ok) return read;

  if (isIsolated(read.attempt.run)) {
    log.info(`Run ${read.attempt.run.id} is isolated, so it publishes no label; pending labels wait for teamai score --push.`);

    return { ok: true, output: { staged: 0 } };
  }

  const dir = path.resolve(ctx.cwd ?? process.cwd());
  const top = await createGit(dir).revparse(['--show-toplevel']).then((out) => out.trim(), () => '');

  if (top === '' || !await isSameRealPath(top, dir)) {
    log.info(`${dir} is no checkout of teamai-reports, so no label was staged; they stay pending.`);

    return { ok: true, output: { staged: 0 } };
  }

  const staged = await LabelStore.stage(read.attempt.config, dir);

  if (staged.reason) log.info(staged.reason);

  if (staged.files.length > 0) await createGit(dir).raw(['--literal-pathspecs', 'add', '--', ...staged.files]);

  return { ok: true, output: { staged: staged.labels } };
}

async function settle(options: EvidenceOptions, ctx: ScoreVerbContext): Promise<ScoreVerbAnswer> {
  const at = await subjectAt('settle', options, ctx);

  if (!at.ok) return at;
  const settled = await ScoreLabels.settle(at.attempt, at.subject, at.scorers, { now: ctx.now });

  return settled.ok ? { ok: true, output: { settled: settled.settled } } : settled;
}

export interface SubjectsOptions {
  run?: string;
  step?: string;
  lapsed?: boolean;
}

async function subjects(options: SubjectsOptions, ctx: ScoreVerbContext): Promise<ScoreVerbAnswer> {
  if (options.lapsed) {
    if (options.run !== undefined || options.step !== undefined) return refused('invalid_arguments', '--lapsed lists this machine\'s subjects and takes no --run or --step.');

    if (!ctx.current) return refused('not_initialized', 'teamai is not set up in this directory, so it has no marks to read. Run teamai init.');

    return { ok: true, output: { list: await ScoreSubjects.lapsed(ctx.current, ctx.now) } };
  }

  if (options.run === undefined) return refused('invalid_arguments', 'Pass --run <id>, the run whose passes to list, or --lapsed.');
  const listed = await ScoreSubjects.ofRun(ctx.current, ctx.env, { runId: options.run, step: options.step });

  return listed.ok ? { ok: true, output: { list: listed.list } } : listed;
}

export interface ReportOptions {
  /** The `labels` output of the teamai-score step that judged the session. */
  labels?: string;
  /** The `labels` output of the teamai-score step that judged its control. */
  control?: string;
}

async function report(options: ReportOptions, ctx: ScoreVerbContext): Promise<ScoreVerbAnswer> {
  const at = await ScoreAttempt.leased('report', TRY_SCORER_WORKFLOW, ctx.env, ctx.current);

  if (!at.ok) return at;
  const reported = await TryScorer.report({ config: at.leased.config, runDir: path.dirname(at.leased.dir), ...options });

  return reported.ok ? { ok: true, output: { answer: reported.answer, text: reported.text, warnings: reported.warnings } } : reported;
}

export const ScoreVerbs = { plan, evidence, stage, label, write, publish, settle, subjects, report } as const;

/** The scope of this directory: none where teamai is not set up, and a refusal with why when its config does not load. */
async function currentConfig(): Promise<{ ok: true; config: LocalConfig | undefined } | Refused> {
  try {
    // oxlint-disable-next-line teamai/config-load-options -- a verb runs in a step's process, which has no preview mode
    return { ok: true, config: (await autoDetectInit()).localConfig };
  } catch (e) {
    return e instanceof NotInitializedError ? { ok: true, config: undefined } : refused('not_initialized', e instanceof Error ? e.message : String(e));
  }
}

/** Runs one verb in this process and prints its answer. */
export async function scoreVerbCommand(verb: (ctx: ScoreVerbContext) => Promise<ScoreVerbAnswer>): Promise<void> {
  setStderrOnly(true);
  const current = await currentConfig();
  const answer = current.ok ? await verb({ env: process.env, current: current.config, now: new Date().toISOString(), cwd: process.cwd() }) : current;

  if (answer.ok) {
    process.stdout.write(`${JSON.stringify(answer.output)}\n`);

    return;
  }

  process.stdout.write(`${JSON.stringify({ error: { code: answer.code, message: answer.message } })}\n`);
  // A failed step keeps its command's stderr and drops its stdout, so the run that called the verb says why it refused.
  process.stderr.write(`${answer.code}: ${answer.message}\n`);
  process.exitCode = 1;
}
