/** The workflow protocol in process: the calls behind `workflow start`, `next`, `report`, `respond`, `retry` and `cancel`, for every driver. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ReportedAgent } from '../agent-observation.js';
import { DefaultWorkflows } from '../default-workflows.js';
import { driverIdentity, sameDriver } from '../driver-identity.js';
import type { WorkflowEnv } from '../env-resolution.js';
import { scoringUnavailable, startedByPasses, verifiedScorers } from '../scorers/engine-hooks.js';
import { resolveRunMode, type RunMode } from '../launch-context.js';
import { stopRecordedGroup } from '../tool-launch/process-stop.js';
import type { JsonValue, LocalConfig } from '../types.js';
import { attemptEnv, nestedWorkflowError, type AgentEvidence } from './attempt-marker.js';
import { loadCachedWorkflow, loadWorkflowTree } from './cache.js';
import { describeWorkflow, type WorkflowDescription } from './describe.js';
import { ConfinedLeaseSchema, LeaseIdSchema, LeaseWireSchema } from './lease-wire.js';
import { carriedRun, claimOffered, offerToPerson, reconcileTakenCopies, resumeRun, settledSteps } from './handoff.js';
import { leaseNext, parseNextPayload, parseReport, parseResponsePayload, reportable, reportAttempt, startRun, withIgnored, type NextOptions, type PersonHandoff, type ReportInput } from './engine.js';
import {
  abandonPlace, adoptedPlaceOf, finishPlace, placeHeldBy, placeLeaseOf, placeOf, placeRecorded, preparedClone, preparedCopyTeam, preparePlace, refuseDirtyAdoptedCommand, releasePlace, runPlaceSetup, stagePassEvidence, sweepClones, type PlaceLease,
  type PlacePrepared,
  type StepEnd,
} from './place/place.js';
import { cancelRun, respondProvenance, respondToHitl, retryStep, type CallerProvenance, type Via } from './run-controls.js';
import { isUnder } from './loop.js';
import { stepDefinitions } from './scope.js';
import { StepModelSchema } from './step-model.js';
import { attemptDir, AttemptIdSchema, readRun, RunIdSchema, withRunLock, type AttemptId, type RunId, type RunLock } from './store.js';
import type { DriverCan } from './requirements.js';
import { isWorkflowError, type DriverIdentity, type RunState, type RunStatus, type WorkflowDefinition, type WorkflowEnvelope, type WorkflowFailure } from './types.js';
import { cloneBranchOf, confinedOf, deliveryProblem, runCopyToMerge, stepRoleOf } from './workspace.js';
import { headCommit } from './worktree.js';

export type { PersonHandoff };

export { refuseDirtyAdoptedCommand };

/**
 * A run that a pass a report settled started, which the driver of the reported run drives as it drives that run: its
 * recorded driver is that run's, so its `next` is no claim. Every report answers each such run that has not ended, so
 * a driver that lost one finds it again on its next report.
 */
export const StartedRunSchema = z.object({ run: RunIdSchema, step: z.string(), pass: z.number().int().positive(), scorers: z.array(z.string()) });

export type StartedRun = z.infer<typeof StartedRunSchema>;

/**
 * Who sent an answer: a process, with the driver UI its `--json` payload declares the person answered in, or the run's
 * skill driver, which carries the agent's answer.
 */
export type RespondVia =
  | { kind: 'process'; caller: CallerProvenance; json?: unknown }
  /** `queued`: as `next`'s, the skill driver's open leases that wait for their place. */
  | Extract<Via, { kind: 'skill' }> & { queued: readonly string[] };

/**
 * What an engine `done` answers from: a run file's status; its revision, which each settled report and each retry bumps;
 * how many pull request receipts it lists, which a delivery adds without a bump; whether a create it started is still
 * unresolved, which only an engine `next` looks up; and `branch`, the run's own copy a person merges (`runCopyToMerge`).
 */
export interface RunVersion {
  status: RunState['status'];
  revision: number;
  receipts: number;
  creating: boolean;
  branch?: string;
}

/**
 * The protocol as one client, in process or through the built CLI. A report made with the run's `RunLock` does not take
 * the lock again; made without one, it takes the lock to finish the attempt's place.
 */
export interface WorkflowClient {
  /**
   * Describes workflow or alias `name` from the cache, with every workflow it runs, for the caller's driver, which
   * declares `can` and runs at most `ceiling` steps at once, as a run started from `checkout` would go. `tool` is the
   * tool of the caller's coding session, whose confined judge would judge the scored steps here. `undeliverable`: why
   * a start from `checkout` would be refused for its delivery (`deliveryProblem`).
   */
  describe: (name: string, options: { ceiling: number; can: DriverCan; checkout?: string; tool?: string }) => Promise<DescribedWorkflow | { error: WorkflowFailure }>;
  /**
   * Prepares the place of `lease`, the lease `next` answered with, in the checkout the run started from, or in the place
   * the host made for its branch, while that passes the adopt checks. `busy` when another attempt the run leased holds
   * that place.
   */
  // oxlint-disable-next-line teamai/no-unknown-parameters -- the skill driver passes the lease of an envelope it has not parsed; LeaseWireSchema parses it here
  prepare(lock: RunLock, lease: unknown): Promise<PlacePrepared | PlaceBusy>;
  /**
   * Prepares the place of `lease` in a place its host made, when the lease commits to a branch, and as `prepare` does
   * when it does not. `host` asks for the place the last attempt to finish on the branch was prepared in, while it
   * passes the adopt checks, and is `busy` while another open attempt holds it. `adopt` asks for the place at `dir`.
   */
  // oxlint-disable-next-line teamai/no-unknown-parameters -- the skill driver passes the lease of an envelope it has not parsed; LeaseWireSchema parses it here
  prepareHostPlace(lock: RunLock, lease: unknown, request: HostPlaceRequest): Promise<HostPlacePrepared>;
  /**
   * Runs the setup of the place `prepare` made for `attempt`, outside the run lock, in the run's `mode`, until it ends
   * or `signal` stops it. Nothing for a place without setup.
   */
  setup(run: RunId, attempt: AttemptId, mode: RunMode, signal?: AbortSignal): Promise<WorkflowFailure | undefined>;
  /**
   * Starts `name` with `inputs`, from `checkout` when given: the run's workspaces start from its HEAD. A `caller`
   * inside a workflow attempt starts none, `nested_workflow`, and an agent one only a workflow whose `invoke` lets it:
   * `invoke_denied` for `deny`, and `confirm_needed` for `ask` without `confirmed`. `alone`: what the local driver,
   * the run's only driver, gives strict requirements; a step it could never take refuses the start, `requirement_unmet`.
   * The run records an agent as its starter when `caller` has agent evidence, else `startedBy`: `cli` for one of the
   * CLI's own automatic starts, `person` for a start a person asked for. `driver`: the driver the run is recorded for
   * from its start. `awaits`: the driver `workflows.driver` names, which this machine does not run.
   */
  start(name: string, options: { inputs?: unknown; checkout?: string; caller: InvokeCaller; timeout?: number; alone?: DriverCan; startedBy: 'person' | 'cli'; driver?: DriverIdentity; awaits?: RunState['awaits']; instead?: string }): Promise<WorkflowEnvelope>;
  /**
   * Asks the run what to do. With `prepare`, a lease comes with `cwd`, its place in the checkout the run started from,
   * made under the run's lock, and a prepare that fails settles the attempt `failed` with its own code.
   */
  // oxlint-disable-next-line teamai/no-unknown-parameters -- the payload as a driver sent it; parseNextPayload in engine.ts parses it, and the skill driver passes typed requests
  next(runId: string, body: unknown, options?: { prepare?: NextPrepare; handoff?: PersonHandoff }): Promise<WorkflowEnvelope>;
  /**
   * Offers run `runId` on teamai-reports, published from `checkout`, for a person to claim, as a driver nobody attends
   * hands a step only a person can take to one: `offers`, or `unoffered` with why it could not.
   */
  offer(runId: RunId, checkout: string): Promise<PersonHandoff>;
  /** What the run file of `runId` says now, or undefined while this machine cannot read it. */
  runVersion(runId: RunId): Promise<RunVersion | undefined>;
  /**
   * Reports an attempt. A prepared one is finished first: its `changes` or `read` come from its place.
   * `changed`: paths the skill child's result reported, supplied in process. Absent on a report from the CLI, which
   * commits an adopted writer's tree as it stands.
   */
  // oxlint-disable-next-line teamai/no-unknown-parameters -- the payload as a driver sent it; parseReport in engine.ts parses it, and the skill driver's tick.ts passes typed reports
  report(runId: string, body: unknown, options?: { lock?: RunLock; changed?: readonly string[] }): Promise<WorkflowEnvelope>;
  /** Records an answer, with the provenance decided from the process or driver `via` names. A process inside a workflow attempt answers none: `nested_workflow`. */
  respond(runId: string, step: string, choice: string, options: { note?: string; pass?: number; via: RespondVia }): Promise<WorkflowEnvelope>;
  /** Reopens the target step's dependency cone. */
  retry(runId: string, step: string): Promise<WorkflowEnvelope>;
  /** Stops the run or the named step. */
  cancel(runId: string, step?: string): Promise<WorkflowEnvelope>;
  /**
   * Gives up held steps the calling driver can never take: cancels, for each, the nearest step above it that sets
   * `continue_on_failure`, so the run goes on without it. Only a step confined to a directory is given up, since its
   * driver's confined offers stay as they were for the run. `not_cancellable`, and nothing cancelled, when one is not
   * confined or has no such step above it.
   */
  giveUp(runId: string, steps: readonly string[]): Promise<WorkflowEnvelope>;
  /**
   * Readies run `runId` for a driver of this machine as `workflow resume` does, under the caller's run `lock`, and brings
   * the branches of a run taken over to the commits it recorded. `claim` says which runs it takes from teamai-reports,
   * as {@link ResumeClaim} reads, or `none`, no run. A lease this machine's
   * local driver still holds is released, as that driver would on its way out: it drives only while it holds the run
   * lock, so it is gone. Describes the run's own definition as `describe` does.
   */
  resume(runId: RunId, options: { lock: RunLock; claim: 'none' | ResumeClaim; checkout: string; ceiling: number; can: DriverCan; tool?: string }): Promise<RunReadied>;
  /**
   * Run `runId` as it stands before `resume` changes anything, as `resumeRefusal` reads it: its own definition described
   * as `describe` does, and its status. Undefined when this machine cannot read it.
   */
  carried(runId: RunId, options: { published: boolean; claim: boolean; ceiling: number; can: DriverCan }): Promise<{ description: WorkflowDescription; status: RunStatus } | undefined>;
  /** Why `caller` may not continue run `runId`, by a resume or a takeover, as `resumeRefusal` decides it. */
  resumeRefusal(runId: RunId, options: { caller: InvokeCaller; published: boolean }): Promise<WorkflowFailure | undefined>;
}

/**
 * Which runs a resume takes from teamai-reports: `lacking`, a run this machine lacks; `any`, also one another install
 * owns (`--claim`); `offered`, a run only while teamai-reports still offers it (`--next`).
 */
export type ResumeClaim = 'lacking' | 'any' | 'offered';

/** Readies run `runId` here as `claim` says: claimed only while offered, claimed whoever owns it, or resumed as it is. */
function readiedHere(config: LocalConfig, runId: RunId, claim: 'none' | ResumeClaim, checkout: string): ReturnType<typeof resumeRun> {
  switch (claim) {
    case 'offered':
      return claimOffered(config, runId, { checkout });
    case 'any':
      return resumeRun(config, runId, { claim: true, checkout });
    case 'lacking':
    case 'none':
      return resumeRun(config, runId, { claim: false, checkout });
    default: {
      const unhandled: never = claim;

      return unhandled;
    }
  }
}

/**
 * What `resume` made of a run: ready to drive here, with `installed` true when the published state replaced this
 * machine's; not on this machine, when nothing was to be claimed; owned by `owner`, another install, since `since`; or
 * refused for `failure`.
 */
export type RunReadied =
  | { kind: 'ready'; installed: boolean; description: WorkflowDescription; status: RunStatus; judging: Judging }
  | { kind: 'not-here' }
  | { kind: 'not-owner'; owner: string; since: string }
  | { kind: 'failed'; failure: WorkflowFailure };

/**
 * The process that asks to start or continue a run: the evidence it carries that an agent runs it, whether it passed
 * `--confirmed`, an agent's word that the person agreed, which teamai cannot verify, and its run mode: in an unattended
 * one no person is there to agree.
 */
export interface InvokeCaller {
  evidence: AgentEvidence;
  confirmed: boolean;
  mode: RunMode;
}

/**
 * What a caller asks of a workflow: to start a run; to continue run `run`, by `workflow resume` or a takeover; or to
 * claim it with a `next` payload, which has no field for the person's yes. A start a shortcut command makes may say, in
 * `instead`, what the person and the agent run in its place, for an `invoke: deny` refusal.
 */
export type InvokeAct = { kind: 'start'; instead?: string } | { kind: 'continue'; run: RunId } | { kind: 'claim'; run: RunId };

/** What shows an agent runs the calling process, as the clause the `invoke` refusals end their first sentence with. */
function agentClause(evidence: Exclude<AgentEvidence, { kind: 'none' }>): string {
  switch (evidence.kind) {
    case 'session':
      return `this command runs inside an agent session (${evidence.variable} is set)`;
    case 'attempt':
      return `this command runs inside workflow attempt ${evidence.attempt}`;
    case 'skill-driver':
      return 'this command uses --driver skill, which only a coding agent drives';
    default: {
      const unhandled: never = evidence;

      return unhandled;
    }
  }
}

/** Why an agent, as `evidence` shows it, may not `act` on workflow `name`, whose definition has `invoke: deny`. */
export function invokeDeniedMessage(name: string, evidence: Exclude<AgentEvidence, { kind: 'none' }>, act: InvokeAct): string {
  switch (act.kind) {
    case 'start':
      return `Workflow "${name}" has invoke: deny, so no coding agent starts it, with any driver, and ${agentClause(evidence)}. ${act.instead
        ?? `The person can start it from their own terminal with teamai workflow start ${name} --driver local. To let agents start it, the team sets invoke: allow, or invoke: ask for a start after the person agrees, in workflows/${name}.yaml.`}`;
    case 'continue':
    case 'claim':
      return `Workflow "${name}" has invoke: deny, so no coding agent continues it, with any driver, and ${agentClause(evidence)}. The person can continue it from their own terminal with teamai workflow resume ${act.run}. To let agents continue it, the team sets invoke: allow, or invoke: ask for a resume after the person agrees, in workflows/${name}.yaml.`;
    default: {
      const unhandled: never = act;

      return unhandled;
    }
  }
}

/** What `invoke: ask` needs, as an unattended run's refusal lists it. */
export const INVOKE_ASK_NEED = 'the team asks that a person agree before it starts (invoke: ask)';

/** Why an unattended run cannot `act` on workflow `name`, start it or continue a run of it: `needs`, the list of what needs a person. */
export function unattendedReason(name: string, needs: string, act: 'start' | 'continue'): string {
  return act === 'start'
    ? `Workflow ${name} needs a person, and this run is unattended (TEAMAI_MODE or CI says so): ${needs}. Start it from a session a person attends, or set TEAMAI_MODE=attended where one does.`
    : `Workflow ${name} needs a person, and this run is unattended (TEAMAI_MODE or CI says so): ${needs}. Continue it from a session a person attends, or set TEAMAI_MODE=attended where one does.`;
}

/**
 * Why `caller` may not `act` on `definition`: inside a workflow attempt nothing starts, and from an agent session
 * `invoke: deny` refuses every start or continue, and `invoke: ask` one without the person's yes, and every one in an
 * unattended run, where `--confirmed` vouches for a person who is not there. Undefined for a process without agent
 * evidence, such as the person's terminal or CI, and for a session's start of a workflow the cache lacks, which the start
 * answers.
 */
export function invokeRefusal(definition: WorkflowDefinition | undefined, caller: InvokeCaller, act: InvokeAct): WorkflowFailure | undefined {
  const { evidence } = caller;

  switch (evidence.kind) {
    case 'none':
      return undefined;
    case 'attempt':
      return nestedWorkflowError({ kind: 'marker', attempt: evidence.attempt });
    case 'session':
    case 'skill-driver': {
      if (definition === undefined) return undefined;
      const { name } = definition;
      const invoke = definition.invoke ?? 'deny';

      if (invoke === 'allow' || (invoke === 'ask' && caller.confirmed && caller.mode !== 'unattended')) return undefined;

      if (invoke === 'deny') return { code: 'invoke_denied', message: invokeDeniedMessage(name, evidence, act) };

      switch (act.kind) {
        case 'start':
          return caller.mode === 'unattended'
            ? { code: 'unattended_denied', message: unattendedReason(name, INVOKE_ASK_NEED, 'start') }
            : { code: 'confirm_needed', message: `Workflow "${name}" has invoke: ask, so a coding agent starts it only after the person agrees, and ${agentClause(evidence)}. Ask the person whether to start ${name}; once they agree, run the same command with --confirmed.` };
        case 'continue':
        case 'claim':
          if (caller.mode === 'unattended') {
            return { code: 'unattended_denied', message: unattendedReason(name, 'the team asks that a person agree before an agent continues it (invoke: ask)', 'continue') };
          }

          return act.kind === 'continue'
            ? { code: 'confirm_needed', message: `Workflow "${name}" has invoke: ask, so a coding agent continues it only after the person agrees, and ${agentClause(evidence)}. Ask the person whether to continue ${name}; once they agree, run the same command with --confirmed.` }
            : { code: 'confirm_needed', message: `Workflow "${name}" has invoke: ask, so a coding agent continues it only after the person agrees, and ${agentClause(evidence)}. A next payload cannot say the person agreed. Ask the person whether to continue ${name}; once they agree, run teamai workflow resume ${act.run} --claim --confirmed.` };
        default: {
          const unhandled: never = act;

          return unhandled;
        }
      }
    }

    default: {
      const unhandled: never = evidence;

      return unhandled;
    }
  }
}

/**
 * Why `caller` may not continue run `runId`, by `workflow resume` or a takeover, or, with `act: 'claim'`, by a `next`
 * payload's claim: the check `start` makes, of the definition the run carries rather than the cache's, before anything
 * claims or changes the run. `--driver skill` counts as an agent's, as it does for a start; the caller skips this check
 * for the session that drives the run. `published` reads a run this machine lacks from teamai-reports, as a resume that
 * claims it does. Reads nothing for a caller without agent evidence.
 */
export async function resumeRefusal(
  config: LocalConfig,
  runId: RunId,
  caller: InvokeCaller,
  { published, act = 'continue' }: { published: boolean; act?: 'continue' | 'claim' },
): Promise<WorkflowFailure | undefined> {
  if (caller.evidence.kind === 'none') return undefined;
  const carried = await carriedRun(config, runId, { published });

  if (!carried.ok) return { code: carried.error.code, message: carried.error.message };

  return invokeRefusal(carried.value?.definition, caller, { kind: act, run: runId });
}

/** The failure a call answers when the cache holds no unambiguous runnable version of workflow or alias `name`. */
/**
 * Starts `name` as one of the CLI's own automatic starts, in run mode `mode`: with no agent evidence, so no agent gave its
 * inputs, and recorded as started by `cli`, which hand labels and policy overrides never trust as a person.
 */
export function startAsCli(client: Pick<WorkflowClient, 'start'>, name: string, { mode, ...options }: Omit<Parameters<WorkflowClient['start']>[1], 'caller' | 'startedBy' | 'instead'> & { mode: RunMode }): Promise<WorkflowEnvelope> {
  return client.start(name, { ...options, caller: { evidence: { kind: 'none' }, confirmed: false, mode }, startedBy: 'cli' });
}

export function workflowNotFound(name: string): WorkflowFailure {
  return { code: 'workflow_not_found', message: `Workflow or alias ${name} has no unambiguous runnable version` };
}

/**
 * Who judges a run's scored steps, and runs its confined prompt steps, as the skill driver drives it: no step is scored
 * or confined; the confined tool of `tool`, the session's tool, here; the session itself with `tool`, at best-effort,
 * in a fresh child, since this machine has no verified confined run of it, for `reason`, leaving open the work of the
 * `verified` scorers that ask for more; or nobody on this machine, for `reason`.
 */
/** A workflow as `describe` answers it: what it does, who judges it here, and why it cannot deliver, when it cannot. */
export type DescribedWorkflow = { description: WorkflowDescription; judging: Judging; undeliverable?: WorkflowFailure };

export type Judging =
  | { kind: 'none' }
  | { kind: 'here'; tool: string }
  | { kind: 'session'; tool: string; reason: string; verified?: string[] }
  | { kind: 'elsewhere'; reason: string };

/**
 * Who judges `description`'s scored steps, as the confined runs `offers` of the driver asking say: its `verified`
 * judge, the session at `best-effort`, or nobody here. `tool` is the session's. The scorers of `run`, once it has
 * started, are read at its team pin, and only when this line needs them.
 */
async function judgingOf(config: LocalConfig, description: WorkflowDescription, { tool, offers }: { tool: string | undefined; offers: NonNullable<DriverCan['confined']> }, run?: RunState): Promise<Judging> {
  const { scored, confined } = description.facts;

  if (scored.length === 0 && confined.length === 0) return { kind: 'none' };
  const unavailable = scored.length > 0 ? scoringUnavailable(config) : undefined;

  if (unavailable) return { kind: 'elsewhere', reason: unavailable };

  if (tool === undefined) return { kind: 'elsewhere', reason: 'This coding session names no tool.' };
  const [verifiedTool] = offers.find((offer) => offer.level === 'verified')?.tools ?? [];

  if (verifiedTool !== undefined) return { kind: 'here', tool: verifiedTool };
  const [sessionTool] = offers.find((offer) => offer.level === 'best-effort')?.tools ?? [];

  if (sessionTool === undefined) return { kind: 'elsewhere', reason: 'This session\'s driver offers no confined judge.' };
  const scorers = [...new Set(scored.flatMap((step) => step.scorers))];
  const verified = await verifiedScorers(config, scorers, run);
  const reason = `This session's driver offers no verified judge of ${sessionTool}.`;

  if (!verified.ok) return { kind: 'elsewhere', reason: `${reason} ${verified.reason}` };

  // A confined step whose confined.json asks for best-effort is still the session's to run.
  if (confined.length === 0 && verified.scorers.length === scorers.length) return { kind: 'elsewhere', reason: verifiedLeftOpen(verified.scorers) };

  const session: Extract<Judging, { kind: 'session' }> = { kind: 'session', tool: sessionTool, reason };

  if (verified.scorers.length > 0) session.verified = verified.scorers;

  return session;
}

/** That `scorers`, which ask for verified isolation, stay open for a driver that offers a verified judge. */
export function verifiedLeftOpen(scorers: readonly string[]): string {
  const many = scorers.length > 1;
  const named = many ? `${scorers.slice(0, -1).join(', ')} and ${scorers.slice(-1).join('')}` : scorers.join('');

  return `${named} ${many ? 'need' : 'needs'} a verified judge, which this session's driver does not offer; ${many ? 'their' : 'its'} runs stay open for a driver that does.`;
}

/** Where the host made the place of a lease: `host`, the place an earlier attempt adopted for its branch; `adopt`, `dir`. */
export type HostPlaceRequest = { kind: 'host' } | { kind: 'adopt'; dir: string };

/** Another open attempt of the run holds the place a lease would get: `behind` is that attempt, and `dir` the place. */
type PlaceBusy = { kind: 'busy'; behind: AttemptId; dir: string };

/**
 * `needs-place` when the host must make the place: a worktree of the checkout's repository named `name`, on `branch`
 * from commit `start`. `refused` says why the place the request named was not prepared.
 */
export type HostPlacePrepared =
  | Exclude<PlacePrepared, { kind: 'refused' }>
  | PlaceBusy
  | { kind: 'needs-place'; name: string; branch: string; start: string; refused?: string };

/** A lease as the run leases it now, with the checkout its place goes in and the run's other leased attempts. */
/** `mode`: the run mode the lease keeps, as its driver's `next` sent it. */
type Leased = { kind: 'leased'; lease: PlaceLease; root: string; others: AttemptId[]; mode?: RunMode };

/**
 * `report` with what teamai knows of a prompt it prepared a copy for, whatever the driver says of it: in a clone, the team
 * revision and project commit it observed of the clone, and the exact model and effort the step asked for; in a worktree
 * copy that runs with a role, the team it delivered there. So the step records what its tool ran on. Unchanged when the
 * report names no tool, or the attempt runs in no such copy this machine prepared.
 */
async function withPreparedCopy(config: LocalConfig, runId: RunId, report: ReportInput): Promise<ReportInput> {
  const tool = report.tool ?? report.agent?.tool?.name;

  if (tool === undefined) return report;
  const run = await readRun(config, runId);

  if (run === 'missing' || run === 'corrupt') return report;
  const leased = run.steps.find((step) => step.status === 'leased' && step.attempt === report.attempt);
  const branch = leased ? cloneBranchOf(run, leased.id) : undefined;
  // A worktree copy that runs with a role: the team is what teamai delivered there, whatever role the driver names.
  const attempt = AttemptIdSchema.safeParse(report.attempt);

  if (leased && branch === undefined && attempt.success) {
    const stepRole = stepRoleOf(run, leased.id);
    const { team: _reported, ...sent } = report.agent ?? {};

    switch (stepRole.kind) {
      case 'role': {
        const team = await preparedCopyTeam({ config, run: runId, attempt: attempt.data, tool });
        const agent: NonNullable<ReportInput['agent']> = { ...sent };

        if (team) agent.team = team;

        return { ...report, agent };
      }

      case 'none':
        break;
      case 'unrenderable':
        // teamai cannot tell the role, and the driver's team would read as the member's, so the pass records none.
        return { ...report, agent: sent };
      default: {
        const unhandled: never = stepRole;

        return unhandled;
      }
    }
  }

  const made = branch === undefined ? undefined : await preparedClone(config, runId, branch);

  if (!leased || !made) return report;
  const { team, project } = made.prepared;
  const asked = stepDefinitions(run)(leased.id)?.model;
  const model = StepModelSchema.safeParse(asked).data;
  const sent = report.agent;
  const agent: ReportedAgent = { ...sent };

  if (team) agent.team = team;

  if (project) agent.project = project;

  if (model) agent.model = { ...sent?.model, requested: model.name };

  if (model?.effort) agent.effort = { ...sent?.effort, requested: model.effort };

  return { ...report, agent };
}

export function unreadablePlace(run: RunId): WorkflowFailure {
  return { code: 'workspace_base', message: `Run ${run} leased a place this teamai cannot read. Update teamai.` };
}

/** The directory a confined lease reads alone, where it is prepared: no place of the checkout is made, set up or snapshotted for it. */
// oxlint-disable-next-line teamai/no-unknown-parameters -- the skill driver passes the lease of an envelope it has not parsed; ConfinedLeaseSchema parses it here
function confinedDirOf(raw: unknown): string | undefined {
  const lease = z.object({ confined: ConfinedLeaseSchema }).safeParse(raw);

  return lease.success ? lease.data.confined.dir : undefined;
}

/** The lease `raw` names, as the run leases it now. */
// oxlint-disable-next-line teamai/no-unknown-parameters -- the skill driver passes the lease of an envelope it has not parsed; LeaseWireSchema parses it here
async function leasedPlace(config: LocalConfig, lock: RunLock, raw: unknown): Promise<Leased | { kind: 'failed'; failure: WorkflowFailure }> {
  const wire = LeaseWireSchema.safeParse(raw);

  if (!wire.success) return { kind: 'failed', failure: unreadablePlace(lock.run) };
  const lease = placeLeaseOf(wire.data);
  const run = await readRun(config, lock.run);

  if (run === 'missing' || run === 'corrupt') return { kind: 'failed', failure: { code: 'run_unreadable', message: `Run ${lock.run} cannot be read, so attempt ${lease.attempt} has no place to run in` } };
  const leased = run.steps.find((step) => step.status === 'leased' && step.lease.attempt === lease.attempt);

  if (leased?.status !== 'leased') return { kind: 'failed', failure: { code: 'wrong_attempt', message: `Attempt ${lease.attempt} is not the leased attempt` } };

  if (run.checkout === undefined) return { kind: 'failed', failure: noCheckout(lock.run, lease.attempt) };
  const { driver, runMode } = leased.lease;

  const placed: Leased = { kind: 'leased', lease: { ...lease, step: leased.id }, root: run.checkout, others: otherLeases(run, { attempt: lease.attempt, driver }) };

  if (runMode) placed.mode = runMode;

  return placed;
}

/**
 * Prepares the place of `leased`, in the place the host made at `adopt` when given, unless another open attempt of the
 * run holds it (`placeHeldBy`). Every prepare of a lease goes through here.
 */
async function placeLeased(config: LocalConfig, lock: RunLock, leased: Leased, adopt?: string): Promise<PlacePrepared | PlaceBusy> {
  const { lease, root, others } = leased;

  const held = await placeHeldBy({ config, run: lock.run, root, lease, others, adopt });

  if (held) return { kind: 'busy', ...held };

  return preparePlace({ config, lock, root, lease, adopt });
}

/**
 * The attempts `run` leases besides `attempt`, and those it stopped while `driver`, the driver of `attempt`, held them:
 * what one of those started may still run in its place, until the driver's report abandons the place. Another driver's
 * stopped attempt holds nothing, as that driver may be gone and never report it.
 */
function otherLeases(run: RunState, { attempt, driver }: { attempt: AttemptId; driver: DriverIdentity }): AttemptId[] {
  const leased = run.steps.flatMap((step) => (step.status === 'leased' ? [step.lease.attempt] : []));
  const stopped = (run.stoppedAttempts ?? []).flatMap((entry) => (sameDriver(entry.driver, driver) ? [entry.attempt] : []));

  return [...leased, ...stopped].flatMap((candidate) => {
    const other = candidate !== attempt ? AttemptIdSchema.safeParse(candidate) : undefined;

    return other?.success ? [other.data] : [];
  });
}

/** Why `attempt` was not prepared in `dir`, the place of `behind`, another open attempt of `run`: as every adopt refuses it. */
function heldPlaceRefusal(input: { dir: string; behind: AttemptId; run: RunId; attempt: AttemptId }): string {
  return `${input.dir} is the place of attempt ${input.behind} of run ${input.run}, which is still open, so attempt ${input.attempt} was not prepared there. Make another place for it, then adopt that one.`;
}

/**
 * What `next` prepares: with `true`, the lease it answers with; else `attempt`, which the run already leased to the
 * caller, in a place TeamAI creates, or in the one the host made at `adopt`.
 */
export type NextPrepare = true | { attempt: AttemptId; adopt?: string };

/** The client whose calls run in this process, against `config`, masking with `env`. */
export function inProcessClient({ config, env }: { config: LocalConfig; env: WorkflowEnv }): WorkflowClient {
  return {
    describe: async (name, { ceiling, can, checkout, tool }) => {
      const cached = await loadCachedWorkflow(config, name);

      if (!cached) return { error: workflowNotFound(name) };
      const tree = await loadWorkflowTree(config, cached);

      if ('failed' in tree) return { error: tree.failed };
      const head = checkout === undefined ? undefined : await headCommit(checkout);

      const description = describeWorkflow({
        definition: cached.definition, source: cached.source, workflows: tree.workflows, ceiling, can, allow: config.workflows?.allow ?? {}, env: env.facts, base: head?.ref,
      });

      const undeliverable = deliveryProblem(cached.definition, tree.workflows, head);

      const described: DescribedWorkflow = { description, judging: await judgingOf(config, description, { tool, offers: can.confined ?? [] }) };

      if (undeliverable) described.undeliverable = undeliverable;

      return described;
    },
    prepare: async (lock, raw) => {
      const dir = confinedDirOf(raw);

      if (dir !== undefined) return { kind: 'prepared', dir };
      const leased = await leasedPlace(config, lock, raw);

      return leased.kind === 'leased' ? placeLeased(config, lock, leased) : leased;
    },
    prepareHostPlace: async (lock, raw, request) => {
      const leased = await leasedPlace(config, lock, raw);

      if (leased.kind === 'failed') return leased;
      const { lease, root } = leased;
      const { workspace } = lease;

      // A clone is teamai's to make, never the host's.
      if ((workspace?.mode !== 'new' && workspace?.mode !== 'continue') || workspace.clone !== undefined) {
        const placed = await placeLeased(config, lock, leased);

        return placed.kind === 'refused' ? { kind: 'failed', failure: placed.failure } : placed;
      }

      const ask = { kind: 'needs-place' as const, name: path.basename(placeOf(lease, root)), branch: workspace.branch, start: workspace.start.commit };
      const adopt = request.kind === 'adopt' ? request.dir : await adoptedPlaceOf({ config, run: lock.run, branch: workspace.branch });

      if (adopt === undefined) return ask;
      const placed = await placeLeased(config, lock, leased, adopt);

      if (placed.kind === 'busy' && request.kind === 'adopt') return { ...ask, refused: heldPlaceRefusal({ ...placed, run: lock.run, attempt: lease.attempt }) };

      if (placed.kind !== 'refused') return placed;

      // The place an earlier attempt adopted no longer passes the checks, so the host makes another.
      return request.kind === 'adopt' ? { ...ask, refused: placed.failure.message } : ask;
    },
    setup: (run, attempt, mode, signal) => runPlaceSetup({ config, run, attempt, mode, env, signal }),
    start: (name, options) => startNamed({ config, secrets: env.secrets }, name, options),
    runVersion: async (runId) => {
      const run = await readRun(config, runId);

      if (run === 'missing' || run === 'corrupt') return undefined;
      const version: RunVersion = { status: run.status, revision: run.revision, receipts: run.deliveries?.length ?? 0, creating: (run.creating?.length ?? 0) > 0 };
      const branch = runCopyToMerge(run);

      if (branch !== undefined) version.branch = branch;

      return version;
    },
    offer: async (runId, checkout) => {
      const unoffered = await offerToPerson(config, runId, checkout);

      return unoffered === undefined ? { kind: 'offers' } : { kind: 'unoffered', reason: unoffered };
    },
    next: async (runId, body, options) => {
      const parsed = parseNextPayload(body);

      if (isRefusal(parsed)) return { error: { code: 'invalid_json', message: parsed } };
      const { driver, ...request } = parsed.request;
      const next = options?.handoff === undefined ? request : { ...request, handoff: options.handoff };
      const lease = (): Promise<WorkflowEnvelope> => leaseNext(config, runId, driver, { ...next, env });
      const run = RunIdSchema.safeParse(runId);
      const prepare = options?.prepare;

      const started = { config, runId, secrets: env.secrets };

      if (prepare === undefined || !run.success) return withIgnored(await withStarted(started, withAttemptEnv(config, runId, next.runMode, await lease())), parsed.ignored);

      return withIgnored(await withRunLock(config, run.data, async (lock) => {
        const answer = prepare === true ? await prepareLeased({ config, lock, driver, env, answer: await leaseNext(config, runId, driver, { ...next, env, prepare: true }) })
            : await prepareAttempt({ config, lock, driver, env, next, ...prepare });

        // A clone whose steps all settled is not needed any more.
        await sweepClones(config, lock.run);

        return withStarted(started, withAttemptEnv(config, runId, next.runMode, answer));
      }, { waitMs: 0 }), parsed.ignored);
    },
    report: async (runId, body, options) => {
      const parsed = parseReport(body);

      if (isRefusal(parsed)) return { error: { code: 'invalid_report', message: parsed } };
      const run = RunIdSchema.safeParse(runId);
      const report = run.success ? await withPreparedCopy(config, run.data, parsed.report) : parsed.report;

      return withIgnored(await managedReport({ config, runId, report, secrets: env.secrets, lock: options?.lock, changed: options?.changed }), parsed.ignored);
    },
    respond: async (runId, step, choice, { via, ...answer }) => {
      if (via.kind === 'skill') {
        return respondToHitl(config, runId, env.secrets, { step, choice, ...answer, provenance: respondProvenance(via), queued: { driver: via.driver, attempts: via.queued } });
      }

      const { evidence } = via.caller;

      if (evidence.kind === 'attempt') return { error: nestedWorkflowError({ kind: 'marker', attempt: evidence.attempt }) };
      const declared = via.json !== undefined ? parseResponsePayload(via.json) : undefined;

      if (declared !== undefined && isRefusal(declared)) return { error: { code: 'invalid_json', message: declared } };
      const provenance = respondProvenance(declared ? { kind: 'driver-json', driver: declared.driver, caller: via.caller } : { kind: 'terminal', caller: via.caller });

      return withIgnored(await respondToHitl(config, runId, env.secrets, { step, choice, ...answer, provenance }), declared?.ignored ?? []);
    },
    retry: (runId, step) => retryStep(config, runId, env.secrets, step),
    cancel: (runId, step) => cancelRun(config, runId, env.secrets, step),
    giveUp: async (runId, steps) => {
      const run = await readRun(config, runId);

      if (run === 'missing' || run === 'corrupt') return { error: { code: 'run_unreadable', message: `Run ${runId} cannot be read, so no held step was given up` } };
      const definitionOf = stepDefinitions(run);
      const above = new Map<string, string>();

      for (const step of steps) {
        const definition = definitionOf(step);
        // The nearest one first: a longer path that holds the step sits deeper.
        const surviving = run.steps.map((state) => state.id).filter((id) => isUnder(id)(step)).sort((left, right) => right.length - left.length).find((id) => definitionOf(id)?.continueOnFailure);

        if (!definition || confinedOf(definition) === undefined || surviving === undefined) {
          return { error: { code: 'not_cancellable', message: `Step "${step}" of run ${runId} is not a confined step under one that sets continue_on_failure, so the run waits for a driver that can take it` } };
        }

        above.set(surviving, step);
      }

      const cancelled: string[] = [];

      for (const [surviving, step] of above) {
        const answer = await cancelRun(config, runId, env.secrets, surviving, `Cancelled: no driver of this run can take step "${step}", which is confined to a directory, and continue_on_failure lets the run go on without it`);

        if ('error' in answer) return answer;
        cancelled.push(surviving);
      }

      return { data: { cancelled } };
    },
    resume: async (runId, { lock, claim, checkout, ceiling, can, tool }) => {
      if (claim === 'none' && await readRun(config, runId) === 'missing') return { kind: 'not-here' };
      const resumed = await readiedHere(config, runId, claim, checkout);

      if (!resumed.ok) {
        const { error } = resumed;

        return error.code === 'not_owner'
          ? { kind: 'not-owner', owner: `${error.owner.user} (install ${error.owner.id})`, since: error.ownedAt }
          : { kind: 'failed', failure: { code: error.code, message: error.message } };
      }

      const run = await readRun(config, runId);

      if (run === 'missing' || run === 'corrupt') return { kind: 'failed', failure: { code: 'run_unreadable', message: `Run ${runId} cannot be read` } };
      const { machine } = driverIdentity('local', checkout);

      for (const step of run.steps) {
        if (step.status !== 'leased' || step.lease.driver.kind !== 'local' || step.lease.driver.machine !== machine) continue;
        const { attempt, revision, driver } = step.lease;
        // That driver is gone, but the setup or command it detached may not be: it is stopped before the step is leased
        // again. An attempt id no lease could carry has no group recorded.
        const left = AttemptIdSchema.safeParse(attempt);

        if (left.success) await stopRecordedGroup(attemptDir(config, runId, left.data));
        const released = await managedReport({ config, runId, report: { attempt, revision, outcome: 'released', driver }, secrets: env.secrets, lock });

        if (isWorkflowError(released)) return { kind: 'failed', failure: released.error };
      }

      // An attempt of that driver the run already stopped, cancelled or expired, holds no lease, but what it detached may
      // still run beside the step's next attempt.
      for (const stopped of run.stoppedAttempts ?? []) {
        if (stopped.driver.kind !== 'local' || stopped.driver.machine !== machine) continue;
        const left = AttemptIdSchema.safeParse(stopped.attempt);

        if (left.success) await stopRecordedGroup(attemptDir(config, runId, left.data));
      }

      const unreconciled = await reconcileTakenCopies(config, runId, run.checkout ?? checkout);

      if (unreconciled) return { kind: 'failed', failure: unreconciled };

      const description = describeWorkflow({
        definition: run.definition, source: DefaultWorkflows.sourceOfRun(run), workflows: run.workflows ?? {}, ceiling, can, allow: config.workflows?.allow ?? {}, env: env.facts,
      });

      return { kind: 'ready', installed: resumed.value?.ownership === 'claimed', description, settled: settledSteps(run), status: run.status, judging: await judgingOf(config, description, { tool, offers: can.confined ?? [] }, run) };
    },
    carried: async (runId, { published, claim, ceiling, can }) => {
      const carried = await carriedRun(config, runId, { published, claim });

      if (!carried.ok || carried.value === undefined) return undefined;
      const { definition, workflows, source, status } = carried.value;

      return { description: describeWorkflow({ definition, source, workflows, ceiling, can, allow: config.workflows?.allow ?? {}, env: env.facts }), status };
    },
    resumeRefusal: (runId, { caller, published }) => resumeRefusal(config, runId, caller, { published }),
  };
}

const CommandLeaseSchema = z.object({ attempt: z.string(), command: z.string(), env: z.record(z.string(), z.string()).optional() }).passthrough();

/**
 * A command lease with the env every process of its attempt gets, after the step's own, so a command any driver runs
 * with `lease.env` alone finds its attempt and `$TEAMAI_RUN_DIR`, and changes no run. The mode is the one the driver
 * sent, else this process's, as for setup.
 */
function withAttemptEnv(config: LocalConfig, runId: string, mode: RunMode | undefined, answer: WorkflowEnvelope): WorkflowEnvelope {
  if (!('data' in answer)) return answer;
  const lease = CommandLeaseSchema.safeParse(answer.data.lease);

  if (!lease.success) return answer;

  return { data: { ...answer.data, lease: { ...lease.data, env: { ...lease.data.env, ...attemptEnv(config, runId, lease.data.attempt, mode ?? resolveRunMode(process.env)) } } } };
}

function noCheckout(run: string, attempt: string): WorkflowFailure {
  return { code: 'workspace_base', message: `Run ${run} records no checkout it started from, so attempt ${attempt} has no place to run in. Drive it with teamai workflow resume ${run}.` };
}

/**
 * Prepares `attempt`, which the run already leased to `driver`, holding the run's lock, as `prepareLeased` prepares a
 * new lease, in the place the host made at `adopt` when given. Every other lease of the run is listed as running, so
 * the engine hands this one back and leases nothing new. `wrong_attempt` when the run no longer leases it to `driver`,
 * or released it just now for a `can` that no longer covers its step.
 */
async function prepareAttempt(input: {
  config: LocalConfig; lock: RunLock; driver: DriverIdentity; env: WorkflowEnv; next: Omit<NextOptions, 'env'>; attempt: AttemptId; adopt?: string;
}): Promise<WorkflowEnvelope> {
  const { config, lock, driver, env, next, attempt, adopt } = input;
  const run = await readRun(config, lock.run);

  if (run === 'missing' || run === 'corrupt') return { error: { code: 'run_unreadable', message: `Run ${lock.run} cannot be read, so attempt ${attempt} was not prepared` } };
  const running = run.steps.flatMap((step) => (step.status === 'leased' && step.lease.attempt !== attempt ? [step.lease.attempt] : []));
  const answer = await leaseNext(config, lock.run, driver, { ...next, env, running, canTakeLease: false, prepare: true });

  if (!('data' in answer) || answer.data.done !== undefined) return answer;
  const leased = LeaseIdSchema.safeParse(answer.data.lease);

  if (!leased.success || leased.data.attempt !== attempt) {
    // The engine gives up a lease it would hand back to a driver whose can no longer covers the step, which waits again.
    const step = run.steps.find((candidate) => candidate.status === 'leased' && candidate.lease.attempt === attempt);
    const after = step ? await readRun(config, lock.run) : undefined;

    if (step && after !== undefined && after !== 'missing' && after !== 'corrupt' && after.steps.find((candidate) => candidate.id === step.id)?.status === 'pending') {
      return { error: { code: 'wrong_attempt', message: `Run ${lock.run} released attempt ${attempt} of step "${step.id}" when this driver asked for it back, since the can this next declares no longer covers the step, so it was not prepared. Call next without --attempt: the run leases the step again to a driver whose can covers it.` } };
    }

    return { error: { code: 'wrong_attempt', message: `Run ${lock.run} does not lease attempt ${attempt} to this driver, so it was not prepared. Prepare an attempt next leased this driver, or call next without --attempt.` } };
  }

  return prepareLeased({ config, lock, driver, env, answer, adopt });
}

/**
 * Prepares the place of the lease `answer` carries, holding the run's lock, and runs its setup: a lease with a
 * workspace contract gets its worktree set up, or adopts the place the host made at `adopt`. A prepare that fails
 * reports the attempt `failed` with its own code, and answers with that failure; an adopt the place does not pass, or
 * another open attempt holds, answers `adopt_mismatch`, and any other place that one holds answers `busy`, and the
 * attempt stays leased.
 */
async function prepareLeased(input: { config: LocalConfig; lock: RunLock; driver: DriverIdentity; env: WorkflowEnv; answer: WorkflowEnvelope; adopt?: string }): Promise<WorkflowEnvelope> {
  const { config, lock, driver, env, answer, adopt } = input;

  if (!('data' in answer) || answer.data.lease === undefined) return answer;
  // What names the lease is read first, so a lease whose place this teamai cannot read is still reported.
  const named = LeaseIdSchema.passthrough().safeParse(answer.data.lease);

  if (!named.success) return { error: { code: 'run_unreadable', message: `Run ${lock.run} returned a lease this teamai cannot read` } };
  const { attempt, revision } = named.data;

  const failed = async (failure: WorkflowFailure): Promise<WorkflowEnvelope> => {
    await reportAttempt(config, lock.run, { attempt, revision, driver, outcome: 'failed', message: failure.message, failure }, env.secrets);

    return { error: failure };
  };

  const confined = confinedDirOf(named.data);

  if (confined !== undefined) return { data: { ...answer.data, lease: { ...named.data, cwd: confined } } };
  const leased = await leasedPlace(config, lock, answer.data.lease);
  const placed = leased.kind === 'leased' ? await placeLeased(config, lock, leased, adopt) : leased;

  if (placed.kind === 'refused') return { error: placed.failure };

  if (placed.kind === 'busy') {
    if (adopt !== undefined) return { error: { code: 'adopt_mismatch', message: heldPlaceRefusal({ ...placed, run: lock.run, attempt }) } };

    return { error: { code: 'busy', message: `Attempt ${attempt} of run ${lock.run} runs in ${placed.dir}, the place of attempt ${placed.behind}, which is still open, so it was not prepared. Report attempt ${placed.behind}, then prepare this one with next --prepare --attempt ${attempt}.` } };
  }

  if (placed.kind === 'failed') return failed(placed.failure);
  // Setup runs in the mode the lease keeps, else in the mode of the process that prepares the attempt; never in the
  // mode the run started in, since a run another machine claimed can run its passes in another mode.
  const mode = (leased.kind === 'leased' ? leased.mode : undefined) ?? resolveRunMode(process.env);
  const failure = await runPlaceSetup({ config, run: lock.run, attempt, mode, env });

  if (failure) return failed(failure);

  const lease: { cwd: string; prompt?: string } & typeof named.data = { ...named.data, cwd: placed.dir };

  if (placed.prompt !== undefined) lease.prompt = placed.prompt;

  return { data: { ...answer.data, lease } };
}

/** `WorkflowClient.start`: starts workflow `name` when its `invoke` lets `caller` start it. */
async function startNamed({ config, secrets }: { config: LocalConfig; secrets: Record<string, string> }, name: string, options: Parameters<WorkflowClient['start']>[1]): Promise<WorkflowEnvelope> {
  const { inputs, checkout, caller, timeout, alone, startedBy, driver, awaits, instead } = options;
  const cached = await loadCachedWorkflow(config, name);
  const refused = invokeRefusal(cached?.definition, caller, { kind: 'start', instead });

  if (refused) return { error: refused };
  const base = checkout === undefined ? undefined : await headCommit(checkout);

  return startRun(config, name, inputs ?? {}, {
    secrets, runMode: caller.mode, startedBy: caller.evidence.kind === 'none' ? startedBy : 'agent', awaits, driver, checkout, base, timeout, alone,
  });
}

/** Reports an attempt as `placedReport` does, with the runs its settled passes started (`withStarted`). Every driver reports through it. */
export async function managedReport(input: { config: LocalConfig; runId: string; report: ReportInput; secrets: Record<string, string>; lock: RunLock | undefined; changed?: readonly string[] }): Promise<WorkflowEnvelope> {
  return withStarted(input, await placedReport(input));
}

/**
 * `answer` with `started`: the runs the settled passes of run `runId` started and that have not ended, which the driver
 * that asked drives. A report settles a prompt step's pass, and a `next` a `workflow` step's, so both answer it.
 */
async function withStarted({ config, runId, secrets }: { config: LocalConfig; runId: string; secrets: Record<string, string> }, answer: WorkflowEnvelope): Promise<WorkflowEnvelope> {
  if (!('data' in answer)) return answer;
  const run = await readRun(config, runId);

  if (run === 'missing' || run === 'corrupt') return answer;
  const mode = run.runMode ?? resolveRunMode(process.env);
  const started = await startedByPasses(config, runId, { client: { start: (name, options) => startNamed({ config, secrets }, name, options) }, mode });

  return started.length === 0 ? answer : { data: { ...answer.data, started } };
}

/**
 * Reports an attempt, after finishing the place `prepare` gave it, under the run's lock, and removes that place once the
 * engine answers `cleanup`. An attempt without a place is reported as it is. A report
 * the run would refuse is sent as it is, and a cancelled one leaves the place as prepare found it; so does a
 * `released` attempt.
 */
async function placedReport(input: { config: LocalConfig; runId: string; report: ReportInput; secrets: Record<string, string>; lock: RunLock | undefined; changed?: readonly string[] }): Promise<WorkflowEnvelope> {
  const { config, runId, report, secrets, lock } = input;
  const attempt = AttemptIdSchema.safeParse(report.attempt);
  const run = RunIdSchema.safeParse(runId);

  if (!attempt.success || !run.success) return reportAttempt(config, runId, report, secrets);

  if (!await placeRecorded({ config, run: run.data, attempt: attempt.data })) return reportAttempt(config, runId, report, secrets);
  const settle = (held: RunLock): Promise<WorkflowEnvelope> => settleManaged({ config, lock: held, attempt: attempt.data, report, secrets, changed: input.changed });

  return lock ? settle(lock) : withRunLock(config, run.data, settle, { waitMs: 0 });
}

/** What an accepted report answers of the step it settled. */
const AcceptedSchema = z.object({ step: z.object({ outcome: z.string() }) });

async function settleManaged(input: { config: LocalConfig; lock: RunLock; attempt: AttemptId; report: ReportInput; secrets: Record<string, string>; changed?: readonly string[] }): Promise<WorkflowEnvelope> {
  const { config, lock, attempt, report, secrets } = input;

  // Checked first, so finishing the place does not commit for an attempt the run would refuse.
  if (!await reportable(config, lock.run, report)) {
    const answer = await reportAttempt(config, lock.run, report, secrets);

    if (isWorkflowError(answer) && answer.error.code === 'lease_cancelled') await abandonPlace({ config, lock, attempt });

    return answer;
  }

  if (report.changes || report.read) return { error: { code: 'invalid_report', message: 'Prepared workspace reports fill changes/read automatically; omit those fields' } };

  if (report.outcome === 'released') {
    await abandonPlace({ config, lock, attempt });

    return reportAttempt(config, lock.run, report, secrets);
  }

  const end: StepEnd = { outcome: report.outcome };

  if (report.message !== undefined) end.message = report.message;

  if (report.failure) end.failure = report.failure;
  const finished = await finishPlace({ config, lock, attempt, end, secrets, changed: input.changed });
  // A limit goes only with a step that succeeded: a failure to keep its work replaces both.
  const { limit, ...unlimited } = report;
  const body: ReportInput = { ...unlimited, ...finished };

  if (limit !== undefined && finished.outcome === 'success') body.limit = limit;
  const staged = await stagePassEvidence({ config, lock, attempt, report: body });
  const answer = await reportAttempt(config, lock.run, body, secrets);
  const outcome = AcceptedSchema.safeParse('data' in answer ? answer.data : undefined).data?.step.outcome;

  // No judge reads the evidence of a pass that did not succeed, and nothing else removes it.
  if (staged !== undefined && outcome !== 'success') await fs.rm(staged, { recursive: true, force: true, maxRetries: 3 });

  if ('data' in answer && answer.data.cleanup === true) await releasePlace({ config, lock, attempt });

  return answer;
}

/**
 * The status a command exits with when its input is wrong, `EX_DATAERR` of sysexits.h: running it again with the same
 * input fails the same way, so its step fails `input_rejected`.
 */
export const INPUT_REJECTED_EXIT = 65;

/** How a command step that exited with `exitCode` failed, before any of its stderr. */
export function commandExitMessage(exitCode: number): string {
  return `command exited with status ${exitCode}`;
}

/** How a command step ended, as its report carries it. */
export interface CommandEnd {
  outcome: 'success' | 'failed';
  exitCode: number;
  message?: string;
  failure?: WorkflowFailure;
  outputs?: JsonValue;
}

/**
 * What a command step reports once it exited: `success` on status 0, else `failed` with its status and the start of
 * its stderr, as `input_rejected` on {@link INPUT_REJECTED_EXIT} and `command_failed` on any other status; and its whole
 * stdout as its outputs, when that is JSON.
 */
export function commandEnd(result: { exitCode: number; stdout: string; stderr: string }): CommandEnd {
  const { exitCode } = result;
  const outputs = commandOutputs(result.stdout);
  const snippet = result.stderr.trim().slice(0, 400);
  const end: CommandEnd = { outcome: exitCode === 0 ? 'success' : 'failed', exitCode };

  if (exitCode !== 0) {
    const message = snippet === '' ? commandExitMessage(exitCode) : `${commandExitMessage(exitCode)}: ${snippet}`;
    end.message = message;

    end.failure = { code: exitCode === INPUT_REJECTED_EXIT ? 'input_rejected' : 'command_failed', message };
  }

  if (outputs !== undefined) end.outputs = outputs;

  return end;
}

/** Whether an engine payload parser refused its payload: it answers the parsed payload, or the refusal as text. */
export function isRefusal<TParsed extends object>(parsed: TParsed | string): parsed is string {
  return !(parsed instanceof Object);
}

/** The outputs a command step reports: its whole stdout, when that is JSON. */
export function commandOutputs(stdout: string): JsonValue | undefined {
  const trimmed = stdout.trim();

  if (trimmed === '') return undefined;

  try {
    const outputs: JsonValue = JSON.parse(trimmed);

    return outputs;
  } catch {
    return undefined;
  }
}
