/** The run's delivery receipts and unresolved requests, independent of locks and network calls. */
import type { PrUrl } from './pr-url.js';
import type { DeliveryKey, UnresolvedCreate } from './delivery-schema.js';
import { deliveryFailure, type DeliveryJob, type DeliveryOutcome, type findDelivered } from './pr-delivery.js';
import { delivered, deliveryFailed, type DeliveringStep } from './step-state.js';
import type { RunState } from './types.js';
import { branchName, childWorkOff, deliveryTarget } from './workspace.js';

/** The delivery of `step`, as the drain and the outcome it applies name it. */
function deliveryKey(step: DeliveringStep): DeliveryKey {
  return { step: step.id, pass: step.pass ?? 1, settledAt: step.settledAt, branch: step.delivery.branch, head: step.delivery.head };
}

/** Whether `a` and `b` name one delivery: the same pass of the same step, settled at the same revision, of one commit. */
function sameKey(a: DeliveryKey, b: DeliveryKey): boolean {
  return a.step === b.step && a.pass === b.pass && a.settledAt === b.settledAt && a.branch === b.branch && a.head === b.head;
}

/** The step `key` names, while it still delivers that pass of that commit. */
export function deliveringStep(run: RunState, key: DeliveryKey): DeliveringStep | undefined {
  return run.steps.find((item): item is DeliveringStep => item.status === 'delivering' && sameKey(deliveryKey(item), key));
}

/**
 * The first delivery to run, after what reports and controls left pending is applied, so a step an end or a cancel
 * stopped is not delivered. One in `waiting`, whose branch this drain found ahead of the recorded commit, waits for a
 * later drain, and so does one whose branch a leased step writes, since that step's next push would enter its pull
 * request unchecked. Undefined when nothing delivers, or when the run settles, which the locked body of `next` finishes.
 */
export function nextDelivery(
  run: RunState, reconcile: (run: RunState) => object, writerLeased: (run: RunState, branch: string) => boolean, waiting: readonly DeliveryKey[],
): DeliveryJob | undefined {
  if (run.status !== 'running') return undefined;
  const settledRun = reconcile(run);
  if ('unreadable' in settledRun || 'outcome' in settledRun) return undefined;
  for (const step of run.steps) {
    if (step.status !== 'delivering') continue;
    const key = deliveryKey(step);
    if (waiting.some((ahead) => sameKey(ahead, key)) || writerLeased(run, key.branch)) continue;
    const target = deliveryTarget(run, key.branch);
    if (!run.checkout || !run.base || target === undefined) {
      deliveryFailed(step, deliveryFailure({ runId: run.id, key }, { kind: 'no_checkout' }));
      continue;
    }
    return {
      key, runId: run.id, runName: run.name, checkout: run.checkout, base: run.base.commit, target,
      recordedHead: run.copies?.[key.branch]?.commit, childWork: childWorkOff(run, step, key.branch),
      openedBy: run.steps.find((item) => item !== step && branchName(run.id, item.id, item.pass ?? 1) === key.branch)?.id,
      ...(step.delivery.reported ? { reported: step.delivery.reported } : {}),
    };
  }
  return undefined;
}

/** The first request in `run.creating` that this drain has not looked up yet. */
export function unresolvedCreate(run: RunState, tried: readonly Omit<UnresolvedCreate, 'lookups'>[]): { create: UnresolvedCreate; checkout: string } | undefined {
  const { checkout } = run;
  const create = run.creating?.find((listed) => !tried.some((done) => sameCreate(done, listed)));
  return create && checkout ? { create, checkout } : undefined;
}

export function sameCreate(a: Omit<UnresolvedCreate, 'lookups'>, b: Omit<UnresolvedCreate, 'lookups'>): boolean {
  return sameKey(a, b) && a.target === b.target;
}

/** Drops `create` from the requests the run has no receipt for. */
function forgetCreate(run: RunState, create: Omit<UnresolvedCreate, 'lookups'>): void {
  const left = run.creating?.filter((listed) => !sameCreate(listed, create));
  if (left?.length) run.creating = left;
  else delete run.creating;
}

/** Lists `url` as what `key` delivered into `target`, once; true when the run had no receipt for it yet. */
function recordReceipt(run: RunState, key: DeliveryKey, target: string, url: PrUrl): boolean {
  if (run.deliveries?.some((receipt) => receipt.url === url)) return false;
  (run.deliveries ??= []).push({ url, branch: key.branch, base: target, step: key.step, pass: key.pass });
  return true;
}

/**
 * Applies a delivery's outcome to the job it was picked as. A pull request gets its receipt whatever became of the step
 * meanwhile: one opened while a cancel landed cannot be taken back, so the run says it exists. The receipt settles the
 * job's listed request; a failed delivery leaves it listed, since a create that failed may still have opened one. The
 * step settles only while it still delivers what `job` delivered, at the revision its agent's report settled it. Origin's
 * branch ahead of the recorded commit fails it only once no report of that tip can come: no step that writes the branch
 * is leased, and no report recorded another commit on it since the job was picked. Until then a pull request settles
 * nothing either, and one the job did not open gets no receipt: a later call checks the branch again and finds it.
 * `requeueEnd` is set when the receipt reached a run that already ended, whose end record must go out again to list it.
 */
export function completeDelivery(
  run: RunState, job: DeliveryJob, outcome: DeliveryOutcome,
  reconcile: (run: RunState) => unknown, writerLeased: (run: RunState, branch: string) => boolean,
): { requeueEnd: boolean } {
  const create = { ...job.key, target: job.target };
  const unchecked = (): boolean => writerLeased(run, job.key.branch) || run.copies?.[job.key.branch]?.commit !== job.recordedHead;
  const settles = !unchecked();
  // A request this job opened gets its receipt whatever became of the branch; one it found or was told of waits.
  const taken = settles || run.creating?.some((listed) => sameCreate(listed, create)) === true;
  const receipted = outcome.ok && taken && recordReceipt(run, job.key, job.target, outcome.pr);
  if (outcome.ok && taken) forgetCreate(run, create);
  if (run.status === 'running') reconcile(run);
  const step = deliveringStep(run, job.key);
  const awaited = !outcome.ok && outcome.fault.kind === 'branch_ahead' && unchecked();
  if (step && outcome.ok && settles) delivered(step);
  else if (step && !outcome.ok && !awaited) deliveryFailed(step, deliveryFailure(job, outcome.fault));
  return { requeueEnd: receipted && run.status !== 'running' };
}

/**
 * Applies what a lookup said of a request in `run.creating`, and touches no step. One the host holds gets its receipt,
 * and unsafe URLs are dropped. Empty and failed answers stay until the second empty or third failed lookup.
 */
export function resolveCreate(run: RunState, create: UnresolvedCreate, found: Awaited<ReturnType<typeof findDelivered>>): { requeueEnd: boolean } {
  const listed = run.creating?.find((item) => sameCreate(item, create));
  if (!listed) return { requeueEnd: false };
  const lookups = listed.lookups ?? { total: 0, none: 0, failed: 0 };
  listed.lookups = {
    total: lookups.total + 1,
    none: lookups.none + (found.kind === 'none' ? 1 : 0),
    failed: lookups.failed + (found.kind === 'failed' ? 1 : 0),
  };
  const receipted = found.kind === 'found' && recordReceipt(run, create, create.target, found.pr);
  if (found.kind === 'found' || found.kind === 'unsafe' || listed.lookups.none >= 2 || listed.lookups.failed >= 3) forgetCreate(run, create);
  return { requeueEnd: receipted && run.status !== 'running' };
}
