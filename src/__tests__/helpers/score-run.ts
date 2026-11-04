import { z } from 'zod';
import { knownSecrets } from '../../env-resolution.js';
import { ScoreVerbs, type ScoreVerbAnswer, type ScoreVerbContext } from '../../score-verbs.js';
import type { LocalConfig } from '../../types.js';
import { attemptEnv } from '../../workflow/attempt-marker.js';
import { leaseNext, reportAttempt, startRun } from '../../workflow/engine.js';
import type { ConfinedRunReport } from '../../workflow/step-state.js';
import type { DriverIdentity, WorkflowEnvelope } from '../../workflow/types.js';

const external: DriverIdentity = { kind: 'external', machine: 'judge', workspace: '/judge' };
const LeaseSchema = z.object({ attempt: z.string(), revision: z.number(), step: z.string() });
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

async function leased(config: LocalConfig, runId: string): Promise<{ step: string; attempt: string; revision: number; ctx: ScoreVerbContext }> {
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
  const runId = await startScore(config, subject, scorers);
  const answers = new Map<string, ScoreVerbAnswer>();
  const outputOf = (step: string) => {
    const found = answers.get(step);
    return found?.ok ? found.output : {};
  };
  for (;;) {
    const lease = await leased(config, runId);
    const id = /^score\[0\]\.(.+)$/u.exec(lease.step)?.[1] ?? lease.step;
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
