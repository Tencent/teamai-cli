/**
 * What decides a delivered pass before its judge (#1247), as a benchmark grades with its check before any judge
 * (#1180): the scorer's `check` on the delivered commit, then the delivered pull request's CI once it finished, then
 * the delivery's protected-path refusal (#1090). The first stage that fails decides the label; one that passes or has
 * nothing to say hands the pass on, and the judge runs only once every stage did.
 */
import type { ScorerDefinition, ScorerLabel } from './definition.js';
import type { Decider, RunSubject } from './label.js';
import { log } from '../utils/logger.js';
import { runCheckAt } from './check-run.js';
import { runPasses } from '../workflow/loop.js';
import { deliveredCi } from '../workflow/pr-delivery.js';
import { evidencePlan } from './scoring-evidence.js';
import { agentPassOf, type StepPass } from '../workflow/step-state.js';
import type { RunState } from '../workflow/types.js';

/**
 * What the stages say of a pass: a stage decided it, with the reasoning its label keeps locally; the scorer's check
 * could not run, which settles its entry unscored; or the judge decides.
 */
export type StageVerdict =
  | { kind: 'decided'; by: Exclude<Decider, 'judge'>; reasoning: string }
  | { kind: 'unrunnable'; message: string }
  | { kind: 'judge' };

/** What the CI of a delivered pass says: a stage verdict, or that it has not finished on commit `head`. */
export type CiVerdict = StageVerdict | { kind: 'pending'; head: string };

/**
 * The label a stage that fails gives: the scorer's highest-scoring label below `passingScore`, the first listed on a
 * tie. A stage knows the work does not pass, never by how much, so it gives the most the work could still be worth.
 * parseScorer guarantees one.
 */
export function failingLabel(definition: Pick<ScorerDefinition, 'labels' | 'passingScore'>): ScorerLabel {
  const below = definition.labels.filter((label) => label.score < definition.passingScore);

  return below.reduce((best, label) => (label.score > best.score ? label : best));
}

export const passOf = (run: RunState, subject: RunSubject): StepPass | undefined =>
  runPasses(run, agentPassOf).find((each) => each.step === subject.step && each.pass === subject.pass);

/**
 * The CI of the pull request the pass delivered, read once: a failed one decides; a pending one says it
 * has not finished; none, or a host whose CI TeamAI does not read, says nothing, and neither does a host that did not
 * answer, which is warned of.
 */
export async function ciStage(run: RunState, subject: RunSubject, pass: StepPass | undefined): Promise<CiVerdict> {
  const delivered = deliveredCommit(run, subject, pass);

  if (!delivered) return { kind: 'judge' };
  const { url, head } = delivered;
  const ci = await deliveredCi({ checkout: delivered.checkout, commit: head });

  if (ci.kind === 'unanswered') log.warn(`The CI of ${url} could not be read, so the judge of step "${subject.step}" decides without it: ${ci.reason}`);

  if (ci.kind === 'read' && ci.status === 'pending') return { kind: 'pending', head };

  if (ci.kind !== 'read' || ci.status !== 'failed') return { kind: 'judge' };

  return { kind: 'decided', by: 'ci', reasoning: `Decided by CI, before any judge: the checks of commit ${head} on ${url} failed.` };
}

/** The pull request the pass delivered and its commit, with the checkout it was made from, when it delivered one. */
function deliveredCommit(run: RunState, subject: RunSubject, pass: StepPass | undefined): { url: string; head: string; checkout: string } | undefined {
  const receipt = run.deliveries?.find((each) => each.step === subject.step && each.pass === subject.pass);
  const head = pass?.delivery?.head;

  return receipt && head && run.checkout ? { url: receipt.url, head, checkout: run.checkout } : undefined;
}

/** The delivery's own refusal of the pass, recorded when it changed a path no pull request TeamAI opens may change. */
export function protectedStage(pass: StepPass | undefined): StageVerdict {
  if (pass?.failure?.code !== 'protected_path') return { kind: 'judge' };

  return { kind: 'decided', by: 'protected', reasoning: `Decided by protected paths, before any judge: ${pass.failure.message}` };
}

/**
 * The scorer's check, run as a benchmark trial's (#1180) in a fresh clone of the delivered commit, with its protected
 * paths put back as the commit the delivered work started from has them, until `expiresAt`. Its pass hands the pass on.
 */
export async function checkStage(run: RunState, subject: RunSubject, pass: StepPass | undefined, { scorer, check, expiresAt }: StageCheck): Promise<StageVerdict> {
  const head = pass?.delivery?.head;

  // A pass that changed nothing delivered no commit: the check has nothing of it to say, as CI has not.
  if (!head) return { kind: 'judge' };
  const startingCommit = evidencePlan(run, subject).diff?.from ?? run.base?.commit;

  if (!startingCommit || !run.checkout) {
    return { kind: 'unrunnable', message: `The check of scorer ${scorer} cannot run on commit ${head} of step "${subject.step}": the run recorded no commit its work started from, or no checkout.` };
  }

  const ran = await runCheckAt({ commit: head, startingCommit, command: check.run, protect: check.protect, sources: [run.checkout], expiresAt });

  if (ran.kind === 'error') return { kind: 'unrunnable', message: `The check of scorer ${scorer} could not be set up on commit ${head}: ${ran.failure.message}` };
  const { verdict } = ran;

  switch (verdict.verdict) {
    case 'passed':
      return { kind: 'judge' };
    case 'failed':
      return {
        kind: 'decided', by: 'check',
        reasoning: `Decided by the scorer's check, before any judge: \`${check.run}\` exited ${verdict.exitCode} on commit ${head}, with ${check.protect.join(', ')} as ${startingCommit} has them.`,
      };
    case 'could_not_run':
      return { kind: 'unrunnable', message: `The check of scorer ${scorer}, \`${check.run}\`, could not run on commit ${head} (${verdict.cause}${verdict.detail ? `: ${verdict.detail}` : ''}).` };
    default: {
      const unhandled: never = verdict;

      return unhandled;
    }
  }
}

/** The check of the one scorer a check stage runs, and when it must stop. */
export interface StageCheck { scorer: string; check: NonNullable<ScorerDefinition['check']>; expiresAt: string }
