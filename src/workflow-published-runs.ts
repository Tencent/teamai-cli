/**
 * The running runs published on `teamai-reports`, which another install can continue: offered to whoever takes one next, or held by the
 * install that claimed it. `workflow resume` lists them beside this machine's running runs, `workflow resume --next`
 * takes one, and the dashboard shows them. This module reads the reports checkout as the caller's last refresh left it,
 * and claims nothing.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { WorkflowEnv } from './env-resolution.js';
import { log } from './utils/logger.js';
import { getReportsDir, usesBranchWorktree, type LocalConfig } from './types.js';
import { describeWorkflow } from './workflow/describe.js';
import { canFor, ceilingOf, localReason, stepNeeds } from './workflow/drivers/skill/skill-driver.js';
import { definitionsOf, settledSteps } from './workflow/handoff.js';
import { invokeRefusal, type InvokeCaller } from './workflow/protocol.js';
import { parseSnapshot, SNAPSHOTS_DIR, snapshotPath, type HandoffOwner, type RunSnapshot } from './workflow/snapshot.js';
import { installOwner, readRuns, RunIdSchema, type RunId } from './workflow/store.js';
import type { RunState, RunStatus, WorkflowFailure } from './workflow/types.js';

/**
 * Who would take an offered run: the calling process, as `invoke` judges it, the driver it would drive the run with, and
 * whether a person answers what the run asks them, as that driver finds out.
 */
export interface Taker {
  caller: InvokeCaller;
  driver: 'local' | 'skill';
  hasPerson: boolean;
}

/** An offered run, as `taker` would find it. */
export interface Offer {
  at: string;
  /** What in the steps the run has not settled for good needs a person, a clause each; empty when a runner can finish it. */
  needs: string[];
  /** Why `taker` may not take it at all: its `invoke` refuses the caller, it needs the local driver, or its workflows cannot be read here. */
  refusal?: WorkflowFailure;
}

/** A running run some install published: offered while `offer` is set, else held by `owner`, who drives it. */
export interface PublishedRun {
  run: RunId;
  workflow: string;
  owner: HandoffOwner;
  ownedAt: string;
  /** The business repository it works in, as `host/owner/repo`; unknown for a run published before teamai recorded it. */
  repository?: string;
  offer?: Offer;
}

/**
 * A run `workflow resume` can continue in a checkout: one another install offers for its business repository, or one of
 * this machine's running runs, as teamai-reports shows it: held here, claimed by another install since, or ended there.
 */
export type ResumableRun =
  | { kind: 'offered'; published: PublishedRun & { offer: Offer } }
  | { kind: 'here'; run: RunState; isOffered: boolean }
  | { kind: 'claimed'; run: RunState; owner: HandoffOwner; ownedAt: string }
  | { kind: 'ended'; run: RunState; owner: HandoffOwner; status: Exclude<RunStatus, 'running'> };

/**
 * Every running run on this machine's reports checkout, offered ones first, oldest offer first, then held ones, the
 * latest claim first. Each offered one says what holds it back from `taker`. A snapshot this teamai cannot read is left
 * out. Reads no network; reads the team commit a run's workflows came from when this machine's cache differs.
 */
async function list(config: LocalConfig, { taker, env }: { taker: Taker; env: WorkflowEnv }): Promise<PublishedRun[]> {
  if (!usesBranchWorktree(config)) return [];
  const root = path.join(getReportsDir(config), SNAPSHOTS_DIR);
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const snapshots = await Promise.all(entries.flatMap((entry) => {
    const run = RunIdSchema.safeParse(entry.name);
    return entry.isDirectory() && run.success ? [readSnapshot(config, run.data)] : [];
  }));
  const running = snapshots.filter((snapshot): snapshot is RunSnapshot => snapshot?.status === 'running');
  const runs = await Promise.all(running.map(async (snapshot): Promise<PublishedRun> => ({
    run: RunIdSchema.parse(snapshot.run),
    workflow: snapshot.name,
    owner: snapshot.owner,
    ownedAt: snapshot.ownedAt,
    ...(snapshot.repository !== undefined ? { repository: snapshot.repository } : {}),
    ...(snapshot.offered ? { offer: await offerOf(config, snapshot, snapshot.offered.at, { taker, env }) } : {}),
  })));
  const offered = runs.filter((run) => run.offer).sort((left, right) => (left.offer?.at ?? '').localeCompare(right.offer?.at ?? ''));
  const held = runs.filter((run) => !run.offer).sort((left, right) => right.ownedAt.localeCompare(left.ownedAt));
  return [...offered, ...held];
}

async function readSnapshot(config: LocalConfig, run: RunId): Promise<RunSnapshot | undefined> {
  const text = await fs.readFile(path.join(getReportsDir(config), snapshotPath(run)), 'utf8').catch(() => undefined);
  if (text === undefined) return undefined;
  const parsed = parseSnapshot(text, run);
  if (parsed.ok) return parsed.value;
  log.debug(`[workflow] left out run ${run} from teamai-reports: ${parsed.error.message}`);
  return undefined;
}

/**
 * Offered run `snapshot` as `taker` finds it, judged from the run's own workflows by the rules a resume applies: the
 * steps the run has not settled for good that need a person, as the skill driver's unattended resume counts them; the
 * run's `invoke` for the caller; and, for the skill driver, a local route.
 */
async function offerOf(config: LocalConfig, snapshot: RunSnapshot, at: string, { taker, env }: { taker: Taker; env: WorkflowEnv }): Promise<Offer> {
  const definitions = await definitionsOf(config, snapshot);
  if (!definitions.ok) return { at, needs: [], refusal: { code: definitions.error.code, message: definitions.error.message } };
  const { definition, workflows } = definitions.value;
  const description = describeWorkflow({
    definition, workflows, ceiling: ceilingOf(config), can: canFor(undefined), allow: config.workflows?.allow ?? {}, env: env.facts,
  });
  const needs = stepNeeds(description, new Set(settledSteps({ definition, workflows, steps: snapshot.steps })));
  const local = taker.driver === 'skill' ? localReason(description) : undefined;
  const refusal = invokeRefusal(definition, taker.caller, { kind: 'continue', run: RunIdSchema.parse(snapshot.run) })
    ?? (local !== undefined ? { code: 'needs_local_driver', message: local } : undefined);
  return { at, needs, ...(refusal ? { refusal } : {}) };
}

/**
 * The runs `workflow resume --next` tries, in order, from `runs` as `list` gave them: offered by an install other than
 * `self`, in business repository `repository`, refused by nothing, and, unless `hasPerson`, with no step left that needs
 * a person, since `--auto-approve` answers none of them.
 */
function candidates(runs: readonly PublishedRun[], { repository, hasPerson, self }: { repository: string | undefined; hasPerson: boolean; self: string }): PublishedRun[] {
  return runs.filter(({ offer, owner, repository: of }) => offer !== undefined && owner.id !== self && repository !== undefined && of === repository
    && offer.refusal === undefined && (hasPerson || offer.needs.length === 0));
}

/**
 * The runs a checkout of business repository `repository` can resume, a run once: the ones other installs offer for it,
 * oldest offer first, then this machine's running runs, newest first. A run of this machine that another install
 * claimed and offers again is listed as offered. No run is offered to a checkout whose repository is unknown, since
 * `--next` takes none there.
 */
async function resumable(config: LocalConfig, { taker, env, repository }: { taker: Taker; env: WorkflowEnv; repository: string | undefined }): Promise<ResumableRun[]> {
  const [published, self, runs] = await Promise.all([list(config, { taker, env }), installOwner(config), readRuns(config)]);
  const local = runs.filter((run) => run.status === 'running').sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const mine = await Promise.all(local.map(async (run): Promise<Exclude<ResumableRun, { kind: 'offered' }> | undefined> => {
    const read = run.publication === undefined || !usesBranchWorktree(config) ? undefined : await readSnapshot(config, RunIdSchema.parse(run.id));
    const snapshot = read?.createdAt === run.createdAt ? read : undefined;
    if (snapshot === undefined || snapshot.owner.id === self.id) return { kind: 'here', run, isOffered: snapshot?.offered !== undefined };
    if (snapshot.status !== 'running') return { kind: 'ended', run, owner: snapshot.owner, status: snapshot.status };
    return snapshot.offered === undefined ? { kind: 'claimed', run, owner: snapshot.owner, ownedAt: snapshot.ownedAt } : undefined;
  }));
  const held = mine.filter((row) => row !== undefined);
  const here = new Set(held.map((row) => row.run.id));
  const offered = published.flatMap((run): ResumableRun[] => (run.offer !== undefined && run.owner.id !== self.id && repository !== undefined
    && run.repository === repository && !here.has(run.run) ? [{ kind: 'offered', published: { ...run, offer: run.offer } }] : []));
  return [...offered, ...held];
}

export const PublishedRuns = { list, candidates, resumable } as const;
