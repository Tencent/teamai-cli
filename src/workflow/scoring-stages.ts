/**
 * What decides a delivered pass before its judge (#1247), as a benchmark grades with its check before any judge
 * (#1180): the scorer's `check` on the delivered commit, then the delivered pull request's CI once it finished, then
 * the delivery's protected-path refusal (#1090). The first stage that fails decides the label; one that passes or has
 * nothing to say hands the pass on, and the judge runs only once every stage did.
 */
import type { ScorerDefinition, ScorerLabel } from '../scorers/definition.js';
import type { Decider, RunSubject } from '../scorers/label.js';
import { log } from '../utils/logger.js';
import { runPasses } from './loop.js';
import { deliveredCi } from './pr-delivery.js';
import { stepDefinitions } from './scope.js';
import { agentPassOf, type StepPass } from './step-state.js';
import type { RunState } from './types.js';

/** What the stages say of a pass: a stage decided it, with the reasoning its label keeps locally, or the judge decides. */
export type StageVerdict =
  | { kind: 'decided'; by: Exclude<Decider, 'judge'>; reasoning: string }
  | { kind: 'judge' };

/** Whether `subject` is a pass of a `deliver: pr` step, the only passes the stages decide. */
export function isDelivered(run: RunState, subject: RunSubject): boolean {
  return stepDefinitions(run)(subject.step)?.deliver === 'pr';
}

/**
 * The label a stage that fails gives: the scorer's highest-scoring label below `passingScore`, the first listed on a
 * tie. A stage knows the work does not pass, never by how much, so it gives the most the work could still be worth.
 * parseScorer guarantees one.
 */
export function failingLabel(definition: Pick<ScorerDefinition, 'labels' | 'passingScore'>): ScorerLabel {
  const below = definition.labels.filter((label) => label.score < definition.passingScore);
  return below.reduce((best, label) => (label.score > best.score ? label : best));
}

const passOf = (run: RunState, subject: RunSubject): StepPass | undefined =>
  runPasses(run, agentPassOf).find((each) => each.step === subject.step && each.pass === subject.pass);

/**
 * The CI of the pull request the pass delivered, read once: a failed one decides; a pending one, none, or a host whose
 * CI TeamAI does not read says nothing, and neither does a host that did not answer, which is warned of.
 */
async function ciStage(run: RunState, subject: RunSubject, pass: StepPass | undefined): Promise<StageVerdict> {
  const receipt = run.deliveries?.find((each) => each.step === subject.step && each.pass === subject.pass);
  const head = pass?.delivery?.head;
  if (!receipt || !head || !run.checkout) return { kind: 'judge' };
  const ci = await deliveredCi(run.checkout, head);
  if (ci.kind === 'unanswered') log.warn(`The CI of ${receipt.url} could not be read, so the judge of step "${subject.step}" decides without it: ${ci.reason}`);
  if (ci.kind !== 'read' || ci.status !== 'failed') return { kind: 'judge' };
  return { kind: 'decided', by: 'ci', reasoning: `Decided by CI, before any judge: the checks of commit ${head} on ${receipt.url} failed.` };
}

/** The delivery's own refusal of the pass, recorded when it changed a path no pull request TeamAI opens may change. */
function protectedStage(pass: StepPass | undefined): StageVerdict {
  if (pass?.failure?.code !== 'protected_path') return { kind: 'judge' };
  return { kind: 'decided', by: 'protected', reasoning: `Decided by protected paths, before any judge: ${pass.failure.message}` };
}

/** What decides delivered pass `subject` before its judge, stage by stage in order. */
export async function decideBeforeJudge(run: RunState, subject: RunSubject): Promise<StageVerdict> {
  const pass = passOf(run, subject);
  for (const stage of [() => ciStage(run, subject, pass), async () => protectedStage(pass)]) {
    const verdict = await stage();
    if (verdict.kind !== 'judge') return verdict;
  }
  return { kind: 'judge' };
}
