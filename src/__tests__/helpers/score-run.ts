import { z } from 'zod';
import { knownSecrets } from '../../env-resolution.js';
import { ScoreVerbs, type ScoreVerbAnswer, type ScoreVerbContext } from '../../score-verbs.js';
import type { LocalConfig } from '../../types.js';
import { attemptEnv } from '../../workflow/attempt-marker.js';
import { leaseNext, reportAttempt, startRun } from '../../workflow/engine.js';
import type { ConfinedRunReport } from '../../workflow/step-state.js';
import type { DriverIdentity, WorkflowEnvelope } from '../../workflow/types.js';
import { TryScorer } from '../../scorers/try-scorer.js';
import { TRY_SCORER_WORKFLOW } from '../../scorers/judging-workflows.js';
import type { SessionDemand } from '../../session-flow/scoring.js';
import { confinedOffers } from '../../tool-launch/confined.js';
import { runConfinedStep } from '../../workflow/confined-step.js';
import { RunIdSchema } from '../../workflow/store.js';
import { LeaseWireSchema } from '../../workflow/lease-wire.js';
import { log } from '../../utils/logger.js';

const external: DriverIdentity = { kind: 'external', machine: 'judge', workspace: '/judge' };
const LeaseSchema = z.object({ attempt: z.string(), revision: z.number(), step: z.string(), prompt: z.string().optional() });
const GroupsSchema = z.object({ groups: z.array(z.object({ scorers: z.string() })) });

function dataOf(envelope: WorkflowEnvelope): Record<string, unknown> {
  if ('error' in envelope) throw new Error(JSON.stringify(envelope.error));
  return envelope.data;
}

/** The attempt the engine leases next in teamai-score run `runId`, which must be of step `step`, as a verb's context. */
async function taken(config: LocalConfig, runId: string, step: string): Promise<{ attempt: string; revision: number; ctx: ScoreVerbContext }> {
  const lease = await leased(config, runId);
  if (lease.step !== step) throw new Error(`teamai-score leased ${lease.step}, not ${step}`);
  return lease;
}

/** What a driver offers a teamai-score run: a confined judge on Claude, and the team workspace publish runs in. */
const JUDGING = { confined: [{ level: 'verified' as const, access: 'read' as const, tools: ['claude'] }], workspace: ['team' as const] };

/** What the judge step's confined run measured, as a driver reports it. */
const JUDGED: ConfinedRunReport = { tool: 'claude', model: { requested: 'claude-x' }, usage: { inputTokens: 10, outputTokens: 2 }, isolation: 'verified', access: 'read' };

async function leased(config: LocalConfig, runId: string): Promise<{ step: string; attempt: string; revision: number; prompt?: string; ctx: ScoreVerbContext }> {
  const answer = dataOf(await leaseNext(config, runId, external, { can: JUDGING }));
  if (answer.lease === undefined) throw new Error(`teamai-score run ${runId} leased nothing: ${JSON.stringify(answer)}`);
  const lease = LeaseSchema.parse(answer.lease);
  return { ...lease, ctx: { env: attemptEnv(config, runId, lease.attempt, 'unattended'), current: config, now: new Date().toISOString() } };
}

async function startScore(config: LocalConfig, subject: string, scorers: readonly string[]): Promise<string> {
  const inputs = { subject, scorers, label: '', batch: false, demand: 'named' };
  return String(dataOf(await startRun(config, 'teamai-score', inputs, { secrets: await knownSecrets(config), startedBy: 'cli' })).run);
}

/**
 * What `teamai score evidence` answers for the first group of a teamai-score run a person started on `subject` with
 * `scorers` named: the directory a judge reads, or why it has none.
 */
export async function scoreEvidence(config: LocalConfig, subject: string, scorers: readonly string[]): Promise<ScoreVerbAnswer> {
  const runId = await startScore(config, subject, scorers);
  const plan = await taken(config, runId, 'plan');
  const planned = await ScoreVerbs.plan({ subject, scorers: JSON.stringify(scorers), batch: 'false', demand: 'named' }, plan.ctx);
  if (!planned.ok) return planned;
  dataOf(await reportAttempt(config, runId, { attempt: plan.attempt, revision: plan.revision, outcome: 'success', driver: external, outputs: planned.output }));
  const [group] = GroupsSchema.parse(planned.output).groups;
  if (!group) throw new Error(`teamai-score planned no group for ${subject}`);
  const evidence = await taken(config, runId, 'score[0].evidence');
  return ScoreVerbs.evidence({ subject, scorers: group.scorers }, evidence.ctx);
}

/** The directory `teamai score evidence` writes for `subject`, failing the test when it writes none. */
export async function scoreEvidenceDir(config: LocalConfig, subject: string, scorers: readonly string[]): Promise<string> {
  const answer = await scoreEvidence(config, subject, scorers);
  if (!answer.ok) throw new Error(`${answer.code}: ${answer.message}`);
  return z.object({ dir: z.string() }).parse(answer.output).dir;
}

/**
 * Drives the first group of a teamai-score run a person started on `subject` with `scorers` named, each step by its
 * verb and the judge step by `answer`, until `teamai score write` has written its labels, and answers what write said.
 */
export async function scoreWrite(config: LocalConfig, subject: string, scorers: readonly string[], answer: unknown): Promise<ScoreVerbAnswer> {
  return driveScore(config, subject, scorers, answer, 'write');
}

/** The prompt the judge step of a teamai-score run a person started on `subject` with `scorers` named is leased with. */
export async function scoreJudgePrompt(config: LocalConfig, subject: string, scorers: readonly string[]): Promise<string> {
  const judged = await driveScore(config, subject, scorers, null, 'judge');
  if (!judged.ok) throw new Error(`${judged.code}: ${judged.message}`);
  return z.object({ prompt: z.string() }).parse(judged.output).prompt;
}

async function driveScore(config: LocalConfig, subject: string, scorers: readonly string[], answer: unknown, until: 'judge' | 'write'): Promise<ScoreVerbAnswer> {
  const runId = await startScore(config, subject, scorers);
  const answers = new Map<string, ScoreVerbAnswer>();
  const outputOf = (step: string) => {
    const found = answers.get(step);
    return found?.ok ? found.output : {};
  };
  for (;;) {
    const lease = await leased(config, runId);
    const id = /^score\[0\]\.(.+)$/u.exec(lease.step)?.[1] ?? lease.step;
    if (id === 'judge' && until === 'judge') return { ok: true, output: { prompt: lease.prompt ?? '' } };
    const [group] = GroupsSchema.parse({ groups: [], ...outputOf('plan') }).groups;
    const dir = z.object({ dir: z.string().optional() }).parse(outputOf('score[0].evidence')).dir;
    const verb: ScoreVerbAnswer = id === 'plan'
      ? await ScoreVerbs.plan({ subject, scorers: JSON.stringify(scorers), batch: 'false', demand: 'named' }, lease.ctx)
      : id === 'evidence' ? await ScoreVerbs.evidence({ subject, scorers: group?.scorers }, lease.ctx)
        : id === 'judge' ? { ok: true, output: { answer: z.json().parse(answer) } }
          : id === 'label' ? await ScoreVerbs.label({ evidence: dir, answer: JSON.stringify(answer), judge: 'success' }, lease.ctx)
            : id === 'write' ? await ScoreVerbs.write({ evidence: dir }, lease.ctx)
              : await ScoreVerbs.stage({ stage: id, evidence: dir, wait: '2h' }, lease.ctx);
    if (id === 'write' || !verb.ok) return verb;
    answers.set(lease.step, verb);
    dataOf(await reportAttempt(config, runId, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: external, outputs: verb.output, ...(id === 'judge' ? { confined: JUDGED } : {}) }));
  }
}

/** The `teamai score` verb a command step of a teamai-score or teamai-try-scorer run calls, given the env it was leased with. */
async function verbOf(id: string, env: Record<string, string>, ctx: ScoreVerbContext): Promise<ScoreVerbAnswer> {
  switch (id) {
    case 'plan': return ScoreVerbs.plan({ subject: env.SUBJECT, scorers: env.SCORERS, batch: env.BATCH, demand: env.DEMAND }, ctx);
    case 'evidence': return ScoreVerbs.evidence({ subject: env.SUBJECT, scorers: env.GROUP }, ctx);
    case 'check': case 'ci': case 'protected': return ScoreVerbs.stage({ stage: id, evidence: env.DIR, wait: '2h' }, ctx);
    case 'label': return ScoreVerbs.label({ evidence: env.DIR, answer: env.ANSWER, judge: env.JUDGE }, ctx);
    case 'write': return ScoreVerbs.write({ evidence: env.DIR }, ctx);
    case 'settle': return ScoreVerbs.settle({ subject: env.SUBJECT, scorers: env.GROUP }, ctx);
    case 'report': return ScoreVerbs.report({ labels: env.LABELS, control: env.CONTROL }, ctx);
    default: throw new Error(`no teamai score verb runs step ${id}`);
  }
}

const TriedEndSchema = z.object({ done: z.object({ outputs: z.object({
  answer: z.union([z.object({ data: z.record(z.string(), z.unknown()) }), z.object({ error: z.object({ code: z.string(), message: z.string() }) })]),
  text: z.string(),
}) }) });

/**
 * What `teamai score --session --scorer <file>` answers, driven here: the teamai-try-scorer run it starts, each command
 * step by its verb and each judge on the confined tools found on PATH, as the local driver runs them. A judge no tool
 * resolves ends it `confined_pending`, as the local driver stops on it; a run that ends with no report answers its end.
 */
export async function tryScorer(from: LocalConfig, demand: SessionDemand): Promise<WorkflowEnvelope> {
  const prepared = await TryScorer.prepare(from, demand);
  if (!prepared.ok) return { error: { code: prepared.code, message: prepared.message } };
  const { config } = prepared;
  const secrets = await knownSecrets(config);
  const runId = RunIdSchema.parse(dataOf(await startRun(config, TRY_SCORER_WORKFLOW, prepared.inputs, { secrets, startedBy: 'person' })).run);
  const can = { confined: await confinedOffers(), workspace: ['team' as const] };
  for (;;) {
    const answer = await leaseNext(config, runId, external, { can });
    if ('error' in answer) return answer;
    const held = z.object({ wait: z.object({ reason: z.string() }) }).safeParse(answer.data);
    // The local driver stops on a judge no tool here can take, and says why.
    if (held.success) return { error: { code: 'confined_pending', message: held.data.wait.reason } };
    if (answer.data.lease === undefined) {
      const tried = TriedEndSchema.safeParse(answer.data);
      if (!tried.success) return answer;
      // The lines `teamai score` prints of the run's report.
      for (const line of tried.data.done.outputs.text.split('\n').filter(Boolean)) log.info(line);
      return tried.data.done.outputs.answer;
    }
    const lease = LeaseWireSchema.parse(answer.data.lease);
    const id = { attempt: lease.attempt, revision: lease.revision, driver: external };
    if (lease.confined) {
      const ended = await runConfinedStep({ config, run: runId, lease: { ...lease, confined: lease.confined }, secrets });
      if (ended.kind === 'unresolved') return { error: { code: 'confined_pending', message: ended.reason } };
      dataOf(await reportAttempt(config, runId, { ...id, ...ended.report }));
      continue;
    }
    const ctx = { env: attemptEnv(config, runId, lease.attempt, 'unattended'), current: config, now: new Date().toISOString() };
    const verb = await verbOf(lease.step.split('.').at(-1) ?? lease.step, lease.env ?? {}, ctx);
    dataOf(await reportAttempt(config, runId, verb.ok ? { ...id, outcome: 'success', outputs: verb.output } : { ...id, outcome: 'failed', message: verb.message, failure: { code: verb.code, message: verb.message } }));
  }
}
