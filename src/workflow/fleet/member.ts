/**
 * A fleet member's side (`teamai workflow resume --next --pool [name]`): it takes the oldest attempt its pool offers for
 * this checkout's business repository, runs it here, pushes its work to the attempt's ref, and writes how it ended. It
 * keeps no run file: only the run's lock and the attempt's directory, in its own data home. While the step runs it
 * commits and pushes what the step did so far and writes that it is still there, so the owner can tell a gone member
 * from a slow one.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { HandoffOwner } from '../snapshot.js';
import type { LocalConfig } from '../../types.js';
import { errnoCode } from '../../utils/fs.js';
import { log } from '@teamai/shared/log';
import { shellArgv, startGroupedCommand, STOPPED_EXIT_CODE, type GroupedCommand, type GroupedCommandExit } from '../shell-command.js';
import { attemptHoldingSession, attemptRun, attemptRuntimePath } from '../runtimes/attempt.js';
import { stopCancelledAttempts, stopLeftAttempt, stopLeftInProcess } from '../runtimes/cancelled.js';
import { isSkillRunnerHolding } from '../drivers/skill/skill-driver.js';
import type { OpenedDriver } from '../runtimes/sources.js';
import { RUN_DIR_ENV } from '@teamai/runtime-protocol';
import type { StepRuntime } from '@teamai/runtime-protocol/step-runtime';
import type { DriverCan } from '../requirements.js';
import { teamCommitReach, type PinnedFolder } from '../cache.js';
import { WorkflowFolder } from '../folder.js';
import { loadTeamConfig } from '../../config.js';
import { resolveRetention, retentionEnds, type Retention } from '../retention.js';
import { retryCommand } from '../runtimes/retry-command.js';
import { answerCancel, attemptRef, claimAttempt, finishAttempt, fleetFailure, leaveOffer, leaseEnv, leaseInputs, leasePrompt, listRecords, memberRecordsAmong, noteHeldFolders, offersAmong, readAttemptRecord, recordProgress, isHeld, type Cancelling, type FleetRecord, type HeldAttempt, type Offered, type FleetError, type FleetLease, type FleetResult } from './record.js';
import type { ExecAnswer, ExecQuestion } from '@teamai/runtime-protocol/step-runtime';
import { definitionsOf, type Definitions } from '../handoff.js';
import { createRun } from '../engine.js';
import { runLocalDriver, type DriverRuntimes } from '../drivers/local/local-driver.js';
import { cancelRun, endRunsPartOf } from '../run-controls.js';
import { knownSecrets, resolveWorkflowEnv, type WorkflowEnv } from '../../env-resolution.js';
import { sameEnvName } from '../../resources/env-key.js';
import { runCopyBranch } from '../workspace.js';
import { wholeFit, wholeRunDefinition, type WholeRun } from '../whole-workflow.js';
import { spentUsage } from '../limits.js';
import { budgeted, type TokenUsage } from '@teamai/tool-core/stdout';
import { gateQuestions } from './gate.js';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { commandOutputs } from '../protocol.js';
import { parseStepPath } from '../step-path.js';
import { attemptEnv, commandStepEnv } from '../attempt-marker.js';
import { attemptDir, attemptOutDir, attemptResultPath, keepAttemptStdout, readRun, runFilePath, RunIdSchema, runRemovalRefusal, takeRunLock, type AttemptId, type RunId, type RunLock } from '../store.js';
import { isWorkflowFile, stepWorkflow, workflowRunBy, type RunState, type WorkflowDefinition, type WorkflowEnvelope, type WorkflowFailure, type WorkflowStep } from '../types.js';
import { envAdvice, envScopeOf, lackedLabels, lacksTool, mergeRequirements, requiredEnvKeys, type EnvScope, type InEffect, type TurnLimits } from '../requirements.js';
import { launchToolFor, promptOfferOf, promptRuntimeOn, runPromptStep, type PromptOffer, type StagedLease } from '../steps/prompt.js';
import { memberTools } from '../member-tools.js';
import { launchExecutableOf } from '../../launch-registry.js';
import { driverIdentity } from '../../driver-identity.js';
import { stepEnvironment, withRunningCli } from '../../env-exec.js';
import { resolveRunMode, WORKFLOW_DIR_ENV } from '../../launch-context.js';
import { archiveSessions, openSessionArchive } from '../../session-flow/archive.js';
import { AgentSession } from '../../session-flow/agent-session.js';
import { JsonValueSchema, type JsonValue, isJsonObject } from '@teamai/shared/json';
import { git, gitAnswer, hostGitEnv, keptOriginUrl, pushTargets, readMemberConfig, remoteGit, untrustedGit, type MemberConfig } from '../worktree.js';
import { readRegularFile, writeRegularFile } from '@teamai/shared/regular-file';

/** How often a member reads its claim's record for a cancel, when its beats come less often than that. */
const CANCEL_READ_MS = 30_000;

/** How often a member whose whole workflow waits at a gate reads its claim's record for the owner's answer. */
const ANSWER_READ_MS = 1_000;

/** The last characters of a step's stderr a member keeps. */
const STDERR_KEPT = 4_000;

/** Where a member runs a step: here, as `--driver local` does, or on a step runtime of its own driver. */
type RuntimePlace = { kind: 'runtime'; driver: string; use: string; runtime: StepRuntime<DriverCan>; labels?: readonly string[]; tools?: string[] };

/** A step runtime of the member's driver that runs prompt steps, with what a prompt there needs of its offer. */
type PromptRuntimePlace = RuntimePlace & { offer: PromptOffer };

/**
 * Where the member's driver runs each kind of step: a command step's command, a prompt step's tool, and a whole
 * workflow's steps, which its local loop drives as a nested run, here or on the runtimes of its driver. A kind with no
 * place is one the member takes no attempt of.
 */
export type MemberPlace = {
  command?: { kind: 'here' } | RuntimePlace;
  prompt?: { kind: 'here' } | PromptRuntimePlace;
  workflow?: { kind: 'here' } | { kind: 'driver'; runtimes: DriverRuntimes };
};

/**
 * Where the member's driver `opened` runs each kind of step, as the local loop picks a runtime: its first runtime that
 * runs commands, and its first that runs prompts, each here when that is `local` or the member gave no driver. A fleet
 * entry of its own is passed over: the member would offer the attempt again instead of running it.
 */
export function memberPlace(opened: OpenedDriver | undefined): MemberPlace | { refused: string } {
  if (opened === undefined) return { command: { kind: 'here' }, prompt: { kind: 'here' }, workflow: { kind: 'here' } };
  const place: MemberPlace = {};
  // A whole workflow's steps go to the runtimes of the member's own driver, but for a fleet entry of its own.
  const [first, ...rest] = opened.runtimes.filter((entry) => entry.kind === 'tools' || entry.use !== 'fleet');

  if (first !== undefined) place.workflow = { kind: 'driver', runtimes: { driver: opened.driver.name, asked: opened.asked, runtimes: [first, ...rest] } };

  for (const entry of opened.runtimes) {
    if (entry.kind === 'tools') {
      place.command ??= { kind: 'here' };
      place.prompt ??= { kind: 'here' };
      break;
    }

    if (entry.use === 'fleet') continue;

    const runtime: RuntimePlace = {
      kind: 'runtime', driver: opened.driver.name, use: entry.use, runtime: entry.runtime, ...(entry.can.labels && { labels: entry.can.labels }), ...(entry.can.tools && { tools: entry.can.tools }),
    };

    // A runtime runs commands, and prompts, unless it says it does not.
    if (entry.can.exec !== false) place.command ??= runtime;

    if (entry.can.prompt !== false) {
      place.prompt ??= { ...runtime, offer: promptOfferOf(entry) };
    }
  }

  if (place.command === undefined && place.prompt === undefined) return { refused: `Driver ${opened.asked} has no runtime that runs command or prompt steps, so this member can take no attempt on it. Use a driver with one, such as --driver local.` };

  return place;
}

/**
 * The labels where `at` runs a step declare, and what declares them: this machine's `workflows.labels` on the host, a
 * runtime's own `labels` elsewhere, and for a whole workflow on the member's driver, its runtimes' together.
 */
function declaredLabels(config: LocalConfig, at: NonNullable<MemberPlace[keyof MemberPlace]>) {
  const host = config.workflows?.labels ?? [];

  switch (at.kind) {
    case 'here': return { labels: host, where: 'workflows.labels on this machine' };
    case 'runtime': return { labels: at.labels ?? [], where: `runtime ${at.use} of driver ${at.driver}` };
    case 'driver': return { labels: at.runtimes.runtimes.flatMap((entry) => (entry.kind === 'tools' ? host : entry.can.labels ?? [])), where: `driver ${at.runtimes.driver}` };
    default: {
      const unhandled: never = at;

      return unhandled;
    }
  }
}

/**
 * What keeps this member from the step `offer` leases where `at` would run it, as its own copy of the team's workflows
 * defines the step, never as the record says: a label not declared there, env its policy does not allow, or for a prompt
 * step, one inside a whole workflow too, a tool its setup does not have where it would run it. A whole workflow is judged step by step on the steps the one fit rule
 * (`wholeFit`) gives, as the owner's negotiation judged them, or the run's definitions, which this member does not find
 * (another member's copy may hold them). Undefined when nothing does.
 */
async function lackedFor(config: LocalConfig, offer: Offered, at: NonNullable<MemberPlace[keyof MemberPlace]>): Promise<string | undefined> {
  const found = await teamDefinitions(config, offer);

  if ('refused' in found) return `it finds no definition of the run here: ${found.refused.replace(/\.$/, '')}`;
  const defined = definedStep(found.definitions, offer.lease.step);

  if (defined.kind !== 'step') return undefined;
  const runs = runsOf(offer.lease.kind, defined, found.definitions);

  if ('unfit' in runs) return `its step does not run whole here: ${runs.unfit}`;
  const declared = declaredLabels(config, at);
  const lacked = [...new Set([defined.requires, ...runs.map(({ requires }) => requires)].flatMap((requires) => lackedLabels(requires, declared.labels)))];

  if (lacked.length > 0) return `its step requires labels ${lacked.join(', ')}, which ${declared.where} does not declare`;
  // The member's own policy holds a step as the local driver's negotiation does, each step of a whole workflow too.
  const allowed = config.workflows?.allow?.env;

  for (const { step, requires } of allowed === undefined ? [] : runs) {
    const denied = envScopeOf(requires.env ?? [], { ...(requires.floor && { floor: requires.floor }), guarded: [] }).provide.filter((key) => sameEnvName(allowed ?? [], key) === undefined);
    const which = offer.lease.kind === 'workflow' ? `its step "${step.id}"` : 'its step';

    if (denied.length > 0) return `${which} requires env ${denied.join(', ')}, which workflows.allow.env on this machine does not allow`;
  }

  // The member gives each key its value from its own team env, as it scopes the step (`scopedStep`), whatever the owner has.
  const required = runs.map(({ step, requires }) => ({ step, keys: envScopeOf(requires.env ?? [], { ...(requires.floor && { floor: requires.floor }), guarded: [] }).provide }));
  const { facts } = required.some(({ keys }) => keys.length > 0) ? await resolveWorkflowEnv(config) : { facts: undefined };

  for (const { step, keys } of required) {
    const absent = facts === undefined ? [] : facts.unreadable === undefined ? keys.filter((key) => sameEnvName(facts.present, key) === undefined) : keys;

    if (facts === undefined || absent.length === 0) continue;
    const which = offer.lease.kind === 'workflow' ? `its step "${step.id}"` : 'its step';

    return facts.unreadable === undefined
      ? `${which} requires env ${absent.join(', ')}, which has no value here: ${envAdvice(absent, facts.declared)}`
      : `${which} requires env ${absent.join(', ')}, and the team env cannot be read here: ${facts.unreadable}`;
  }

  switch (offer.lease.kind) {
    case 'command': return undefined;
    case 'prompt': return at.kind === 'driver' ? undefined : promptToolLack(config, defined.step, at);
    case 'workflow': {
      // A whole workflow's nested run runs here, or on the runtimes of the member's driver.
      if (at.kind === 'runtime') return undefined;

      for (const { step, executor } of runs) {
        const lack = executor === 'prompt' ? await wholePromptToolLack(config, step, at) : undefined;

        if (lack !== undefined) return lack;
      }

      return undefined;
    }

    default: {
      const unhandled: never = offer.lease;

      return unhandled;
    }
  }
}

/**
 * The steps a member runs for a lease of `kind` on step `defined`: the step itself, or for a whole workflow, the steps
 * of its workflow that run something, as the one fit rule gives them, or why it does not run whole.
 */
function runsOf(kind: FleetLease['kind'], defined: Extract<ReturnType<typeof definedStep>, { kind: 'step' }>, definitions: Definitions): WholeRun[] | { unfit: string } {
  switch (kind) {
    case 'command':
    case 'prompt':
      return [{ step: defined.step, executor: kind, requires: defined.requires }];
    case 'workflow': {
      const fit = wholeFit(defined.step, workflowRunBy(definitions, defined.step, ''), defined);

      return 'unfit' in fit ? fit : fit.runs;
    }

    default: {
      const unhandled: never = kind;

      return unhandled;
    }
  }
}

/** Where a prompt step's tool is looked for: on PATH here, or among the tools a step runtime offers, with its default tool. */
type ToolPlace = { kind: 'here' } | { kind: 'runtime'; driver: string; use: string; tools?: string[]; defaultTool?: string };

/**
 * Why the member's setup has no tool for prompt step `step` (named `which` in the answer) where `at` runs it, as the
 * local driver locates the tool: the step's own `tool`, else `workflows.tools` and the member's AI tool, then on PATH
 * here, or among the tools runtime `at` offers. Undefined when it has one.
 */
async function promptToolLack(config: LocalConfig, step: Pick<WorkflowStep, 'agent' | 'tool'>, at: ToolPlace, which = 'its prompt step'): Promise<string | undefined> {
  const choice = launchToolFor(step, config, {}, await memberTools(config), at.kind === 'runtime' ? at.defaultTool : undefined);

  if (!choice.ok) return `${which} has no tool here: ${choice.failure.message.replace(/\.$/, '')}`;
  const { name } = choice.target;

  if (at.kind === 'here') return launchExecutableOf(choice.target) === null ? `${which} runs on ${name}, which is not on PATH here` : undefined;

  return lacksTool(name, { tools: at.tools }) ? `${which} runs on ${name}, which runtime ${at.use} of driver ${at.driver} does not offer` : undefined;
}

/**
 * Why the member's setup has no tool for prompt step `step` of a whole workflow where its nested run would run it: here,
 * or on any runtime of the member's driver that runs prompt steps. Undefined when one of them has it.
 */
async function wholePromptToolLack(config: LocalConfig, step: WorkflowStep, at: NonNullable<MemberPlace['workflow']>): Promise<string | undefined> {
  const which = `its step "${step.id}"`;

  if (at.kind === 'here') return promptToolLack(config, step, at, which);
  const { driver, runtimes } = at.runtimes;

  const places = runtimes.flatMap((entry): ToolPlace[] => {
    if (entry.kind === 'tools') return [{ kind: 'here' }];

    return entry.can.prompt === false ? [] : [{ kind: 'runtime', driver, use: entry.use, ...(entry.can.tools && { tools: entry.can.tools }), ...(entry.can.default_tool !== undefined && { defaultTool: entry.can.default_tool }) }];
  });

  if (places.length === 0) return `${which} is a prompt step, which no runtime of driver ${driver} runs`;
  const lacks = await Promise.all(places.map(async (place) => promptToolLack(config, step, place, which)));

  return lacks.every((lack) => lack !== undefined) ? lacks[0] : undefined;
}

/**
 * Takes and runs the oldest attempt pool `pool` offers for `repository` that another member did not claim first, from
 * checkout `root`. A member that starts first stops the commands its earlier runs left running, then finishes a claim it
 * still holds, as a member killed mid-step leaves one. Answers `{ ran: { run, attempt, step, exit_code } }`,
 * `{ cancelled: { run, attempt, step } }` when the owner cancelled the attempt meanwhile, or `{ idle: { offered } }`
 * when it took none.
 */
export async function takeFleetAttempt(config: LocalConfig, input: { pool: string; repository: string; root: string; member: HandoffOwner; secrets: Record<string, string>; place: MemberPlace }): Promise<WorkflowEnvelope> {
  const { pool, repository, root, member, secrets, place } = input;
  // One listing for the pass: a record of another format is warned about once.
  const records = await listRecords(config);
  const finished = await finishLeftClaims(config, records, { repository, root, member, secrets, place });

  if (finished) return finished;
  const offers: Offered[] = [];

  // An offer of a kind of step this member's driver does not run, or that needs a label where it would run it does not
  // declare, is another member's to take. One of a run whose record this data home holds is its owner's, as one of its
  // own id is: what a claim keeps of the attempt here, such as its runtime record, is the owner's too.
  for (const offer of offersAmong(records, { pool, repository })) {
    const at = place[offer.lease.kind];

    if (offer.owner.id === member.id || at === undefined || await holdsRunRecord(config, offer.run)) continue;
    const lacks = await lackedFor(config, offer, at);

    if (lacks !== undefined) {
      log.info(`Left attempt ${offer.attempt} of run ${offer.run} for another member: ${lacks}.`);
      const said = await leaveOffer(config, offer, { member, why: lacks, secrets });

      // An offer that changed meanwhile is read again at the next take, which says the reason over it then.
      if (!said.ok && said.error.code !== 'state_moved') log.warn(`Attempt ${offer.attempt} of run ${offer.run} does not say why this member left it: ${said.error.message}`);
      continue;
    }

    offers.push(offer);
  }

  let moved = 0;

  for (const offer of offers) {
    // The run's lock comes first: a claim this machine could not run at once would wait for nobody until stale_after.
    const held = await takeRunLock(config, offer.run, async (lock): Promise<WorkflowEnvelope | 'moved'> => {
      const claimed = await claimAttempt(config, offer, member);

      if (claimed.ok) return runClaim(config, { lock, claim: claimed.value, root, secrets, member, place });

      return claimed.error.code === 'state_moved' ? 'moved' : { error: fleetFailure(claimed.error) };
    }, { waitMs: 0 }).catch(runRemovalRefusal);

    if (!('kind' in held)) return held;

    if (held.kind === 'busy') {
      log.info(`Left attempt ${offer.attempt} of run ${offer.run} for another member: ${held.error.message}`);
      continue;
    }

    if (held.value === 'moved') {
      moved += 1;
      continue;
    }

    return held.value;
  }

  return { data: { idle: { offered: offers.length - moved } } };
}

/**
 * What an earlier run of this member left: each command it started that may still run, which it stops, and the claim it
 * still holds, which it finishes from the work it pushed, or, when the owner cancelled it meanwhile, answers. A run of
 * this install that is still live holds the run's lock, so what it runs is left alone. Undefined when it held no claim.
 */
async function finishLeftClaims(config: LocalConfig, records: FleetRecord[], { repository, root, member, secrets, place }: { repository: string; root: string; member: HandoffOwner; secrets: Record<string, string>; place: MemberPlace }): Promise<WorkflowEnvelope | undefined> {
  let resolved: Promise<Retention> | undefined;
  const retention = (): Promise<Retention> => (resolved ??= loadTeamConfig(config.repo.localPath, config).then((team) => resolveRetention(config, team)));

  for (const record of await memberRecordsAmong(config, records, { member, repository })) {
    const held = await takeRunLock(config, record.run, async (lock): Promise<WorkflowEnvelope | undefined> => {
      // A member killed mid-step leaves its command's process group running, or its exec on a step runtime: nothing
      // else stops either. One that may still run keeps the claim, so no second copy of the step runs beside it. What ran
      // in its own process, such as a Codex judge, also left its login held: that is written back and released.
      const stopped = await stopLeftInProcess(config, record.run, record.attempt);
      // A run its killed step's process started and drove is part of that attempt, which ended with that process.
      await endRunsPartOf(config, { run: record.run, attempt: record.attempt });
      const isEnded = !isHeld(record) && record.state !== 'cancelling';
      const isLeftRunning = stopped.kind !== 'ended' && stopped.left.length > 0;

      // An attempt whose record ended runs nothing of its step again, so only a claim still held waits on what it left.
      if (!isEnded && isLeftRunning) {
        return { error: { code: 'runtime_lost', message: `teamai could not confirm that process ${stopped.left.join(', ')}, which its killed run of step "${record.lease.step}" started, ended, so the claim is kept and the step does not run again beside it. Once that process has ended, run teamai workflow resume --next --pool ${record.pool} again.` } };
      }

      // A whole workflow's nested run leaves its steps' commands under attempts of its own, and its state running.
      const nestedRun = await endLeftNestedRun(config, record.run, record.attempt);

      if (nestedRun.kind === 'running') return { error: { code: 'runtime_lost', message: nestedRun.message } };
      const stillRuns = await stopLeftAttempt(config, record.run, record.attempt, root);

      if (stillRuns !== undefined) return { error: { code: 'runtime_lost', message: `The step it ran on a step runtime may still run there: ${stillRuns}` } };
      // Its place there is closed: a run of the attempt starts again with a place and an exec of its own.
      await fs.rm(attemptRuntimePath(config, record.run, record.attempt), { force: true });

      // What the member kept of an ended attempt, such as the log a failure named, goes with its claim marker once nothing
      // it left may still run and `workflows.retention` passed since it ended, as what a run leaves does.
      if (isEnded) {
        const removedAt = retentionEnds(endedAt(record), await retention());

        if (!isLeftRunning && removedAt !== undefined && removedAt <= Date.now()) await removeEndedAttempt(config, record.run, record.attempt);

        return undefined;
      }

      const ref = attemptRef(record.run, record.attempt);
      // Only this member pushes to the attempt's ref, so its tip is the last work it saved. Another member process in this
      // checkout may fetch meanwhile, so the tip comes from origin's listing, never from FETCH_HEAD.
      const listed = await git(root, ['ls-remote', '--quiet', 'origin', ref]);
      const saved = listed.stdout.split('\t')[0]?.trim() ?? '';
      const fetched = listed.code === 0 && saved !== '' ? await git(root, ['fetch', '--quiet', 'origin', ref]) : listed;
      const savedHere = fetched.code === 0 ? gitAnswer(await git(root, ['cat-file', '-e', `${saved}^{commit}`])) : undefined;

      if (savedHere?.said !== 'yes') return { error: { code: 'fetch_failed', message: `The member could not fetch ${ref}, where the claim it holds keeps its work: ${(savedHere?.result ?? fetched).stderr.trim() || 'origin does not hold it'}` } };

      if (record.state === 'cancelling') return answered(config, record, saved, nestedRun.spent);
      log.info(`Finishing attempt ${record.attempt} of run ${record.run}, which this member claimed and left: step "${record.lease.step}" runs again from the work it pushed.`);

      return runClaim(config, { lock, claim: record, root, secrets, member, place, from: saved, ...(nestedRun.spent && { spent: nestedRun.spent }) });
    }, { waitMs: 0 });

    if (held.kind !== 'held' || !held.value) continue;

    // A claim it cannot finish, such as one whose ref is gone, keeps the member from no other work: the owner gives
    // it up after stale_after.
    if ('error' in held.value) {
      log.warn(`Left attempt ${record.attempt} of run ${record.run}, which this member claimed before: ${held.value.error.message}`);
      continue;
    }

    return held.value;
  }

  return undefined;
}

/** When the record of an attempt that ended says it ended. */
function endedAt(record: Extract<FleetRecord, { state: 'finished' | 'expired' | 'cancelled' }>): string {
  switch (record.state) {
    case 'finished':
      return record.finishedAt;
    case 'expired':
      return record.expiredAt;
    case 'cancelled':
      return record.cancelledAt;
    default: {
      const unhandled: never = record;

      return unhandled;
    }
  }
}

/**
 * Whether this data home holds run `run`'s record, as the data home of the run's owner does. A record that cannot be
 * read for another reason than its absence counts as held, so the member leaves the run alone.
 */
async function holdsRunRecord(config: LocalConfig, run: RunId): Promise<boolean> {
  try {
    await fs.lstat(runFilePath(config, run));

    return true;
  } catch (error) {
    return errnoCode(error) !== 'ENOENT';
  }
}

/**
 * Removes the directory a member kept attempt `attempt` of run `run` in, with the run's own folders once they hold
 * nothing else: a member holds no record of the run, so nothing else ends them. A member never claims a run whose
 * record its data home holds, and a record that reached it since, as a takeover into it brings one, owns the folder.
 */
async function removeEndedAttempt(config: LocalConfig, run: RunId, attempt: AttemptId): Promise<void> {
  if (await holdsRunRecord(config, run)) return;
  const dir = attemptDir(config, run, attempt);
  await fs.rm(dir, { recursive: true, force: true });

  for (const parent of [path.dirname(dir), path.dirname(path.dirname(dir))]) {
    try {
      await fs.rmdir(parent);
    } catch {
      // Not empty, or already gone: another attempt of the run, or the run's own record, is still there.
      return;
    }
  }
}

/** Answers the cancel of claim `cancelling` with the work up to `pushed`: the step stopped. */
async function answered(config: LocalConfig, cancelling: Cancelling, pushed: string, tokens?: TokenUsage): Promise<WorkflowEnvelope> {
  const written = await answerCancel(config, cancelling, pushed, tokens);
  const { run, attempt, lease } = cancelling;

  if (!written.ok) return { error: fleetFailure(written.error) };

  return { data: { cancelled: { run, attempt, step: lease.step } } };
}

/**
 * Runs claim `claim` in a clone of `root` at `from`, the attempt's start commit unless a restarted member goes on from
 * the work it pushed, then pushes its work and writes how it ended. A cancel of the claim stops the step: its work is
 * pushed, and the member answers the cancel. `spent`: what the nested run a killed run of the claim left spent.
 */
async function runClaim(config: LocalConfig, { lock, claim, root, secrets, member, place, from = claim.start, spent }: { lock: RunLock; claim: HeldAttempt; root: string; secrets: Record<string, string>; member: HandoffOwner; place: MemberPlace; from?: string; spent?: Required<TokenUsage> }): Promise<WorkflowEnvelope> {
  const { run, attempt, lease } = claim;
  const ref = attemptRef(run, attempt);
  const dir = attemptDir(config, run, attempt);
  const work = path.join(dir, 'work');
  let latest: HeldAttempt = claim;
  // The gates the nested run of a whole workflow asks the owner: the one asked is written with each progress until its
  // answer comes.
  const gates = gateQuestions();

  const finish = async (result: FleetResult): Promise<WorkflowEnvelope> => {
    const written = await finishAttempt(config, latest, result, secrets);

    // The owner cancelled the claim as the step ended: the member answers the cancel with the work it pushed.
    if (!written.ok && written.error.code === 'state_moved') {
      const now = await readAttemptRecord(config, run, attempt);

      if (now.ok && now.value !== 'absent' && now.value.state === 'cancelling' && now.value.member.id === member.id) return answered(config, now.value, result.to ?? latest.pushed, result.tokens);
    }

    if (!written.ok) return { error: fleetFailure(written.error) };
    const ended = written.value.state === 'finished' ? written.value.result : result;

    return { data: { ran: { run, attempt, step: lease.step, exit_code: ended.exitCode } } };
  };

  const trusted = await trustedLease(config, claim);

  if ('refused' in trusted) {
    const next = trusted.next ?? `Once the owner ran teamai pull, ${retryCommand({ run, step: lease.step })} offers it again.`;

    return finish({ exitCode: 1, stderr: `The member did not run step "${lease.step}": ${trusted.refused} ${next}` });
  }

  const runsHere = place[trusted.kind];

  if (runsHere === undefined) return finish({ exitCode: 1, stderr: `The member did not run step "${lease.step}": its driver runs no ${trusted.kind} step. ${retryCommand({ run, step: lease.step })} offers it again.` });
  // A whole workflow's nested run scopes each of its steps' env itself, as the local driver does.
  const ready = trusted.kind === 'workflow' ? trusted : await scopedStep(config, trusted);

  if (ready.kind === 'failed') return finish({ exitCode: 1, stderr: ready.failure.message, failure: ready.failure });

  const fetched = await git(root, ['fetch', '--quiet', 'origin', ref]);

  if (fetched.code !== 0) return finish({ exitCode: 1, stderr: `The member could not fetch ${ref}: ${fetched.stderr.trim()}` });
  const read = await readMemberConfig(root);

  if ('error' in read) return finish({ exitCode: 1, stderr: `The member could not read the git config of its checkout: ${read.error}` });
  const memberConfig: MemberConfig = new Set(read);
  // The step runs in a clone of its own, which shares the checkout's objects but not its config: a worktree would let the
  // step write the checkout's .git/config, which every later git command there reads. No git runs in the checkout once
  // the step started.
  await fs.rm(work, { recursive: true, force: true });
  const cloned = await git(root, ['clone', '--quiet', '--shared', '--no-checkout', root, work]);

  // The clone's origin is the checkout; the step sees the origin the checkout names, as it would there.
  const originUrl = keptOriginUrl(memberConfig);

  // A whole workflow's nested run would push the branches of its copies to the origin it sees: it sees none, and only
  // the attempt's ref leaves this machine.
  const named = cloned.code !== 0 ? cloned
    : trusted.kind === 'workflow' ? await git(work, ['remote', 'remove', 'origin'])
      : originUrl !== undefined ? await git(work, ['remote', 'set-url', 'origin', originUrl]) : cloned;

  const added = named.code === 0 ? await git(work, ['checkout', '--quiet', '--detach', from]) : named;

  if (added.code !== 0) return finish({ exitCode: 1, stderr: `The member could not check out ${from}: ${added.stderr.trim()}` });
  // Each save is a commit on the one before, so the ref only moves forward.
  let tip = from;

  const save = async (message: string): Promise<{ to: string } | { error: string }> => {
    const saved = await pushWork({ work, ref, message, memberConfig, parent: tip, index: path.join(dir, 'snapshot.index') });

    // A commit one push URL took is where the next save goes on from, so every URL still takes it fast-forward.
    if ('to' in saved) tip = saved.to;
    else if (saved.taken !== undefined) tip = saved.taken;

    return saved;
  };

  let gone: string | undefined;
  let cancelling: Cancelling | undefined;
  let beating: Promise<void> | undefined;
  let stopCommand = async (): Promise<void> => {};

  // A write of the claim that answered state_moved: the owner cancelled it, which the member answers once the step
  // stopped, or gave it up, after which nothing the member does counts. Either way the step stops.
  // A claimed or asking record naming this member is a write of its own that landed though it could not tell, as when
  // origin took the push and its answer was lost: only the claim's member writes one over a claim. An answered one is
  // the owner's answer to the gate it asks, which only the owner writes over its question.
  const moved = async (error: FleetError): Promise<void> => {
    if (gone !== undefined || cancelling !== undefined) return;
    const now = await readAttemptRecord(config, run, attempt);

    // A read that could not reach teamai-reports shows nothing of what landed: the next beat reads again. A record this
    // teamai cannot parse, such as a newer teamai's, no later read parses either, so the step stops.
    if (!now.ok && now.error.code === 'reports_unreachable') return;
    const record = now.ok && now.value !== 'absent' && 'member' in now.value && now.value.member.id === member.id ? now.value : undefined;

    if (record?.state === 'claimed' || record?.state === 'asking') {
      latest = record;

      return;
    }

    if (record?.state === 'answered') {
      // The owner's answer to a question of this member's, which only the owner writes over it, so the next progress
      // goes over it. It is handed once, and only to the question it answers.
      latest = record;
      gates.take(record);

      return;
    }

    if (record?.state === 'cancelling') cancelling = record;
    else gone = error.message;
    await stopCommand();
  };

  // Reads the record for a cancel, or the owner's answer, unless it is the member's own last write.
  const readRecord = async (): Promise<void> => {
    const now = await readAttemptRecord(config, run, attempt);

    if (now.ok && now.value !== 'absent' && now.value.write !== latest.write) await moved({ code: 'state_moved', message: `Attempt ${attempt} of run ${run} changed on teamai-reports meanwhile.` });
  };

  // Writes progress naming `pushed`, with the question the member asks while it waits for the owner's answer.
  const progress = async (pushed: string): Promise<void> => {
    const question = gates.asking;
    const progressed = await recordProgress(config, latest, pushed, question && { question, secrets });

    if (progressed.ok) latest = progressed.value;
    // A record it cannot parse is one another teamai wrote over its own, as a moved one is.
    else if (progressed.error.code === 'state_moved' || progressed.error.code === 'fleet_record_newer' || progressed.error.code === 'fleet_record_unreadable') await moved(progressed.error);
    // A question the record cannot carry reaches nobody: the gate fails with why, and progress goes on without it.
    else if (progressed.error.code === 'fleet_unpublishable' && question !== undefined) gates.refuse(progressed.error.message);
  };

  // One read or write of the record at a time: the beat's, or the question's. Each waits for the one before.
  const inTurn = async (task: () => Promise<void>): Promise<void> => {
    await beating;
    beating = task().finally(() => {
      beating = undefined;
    });
    await beating;
  };

  // The question goes out at once, after any beat still writing, and is read for its answer every ANSWER_READ_MS.
  const askOwner = async (question: ExecQuestion, signal: AbortSignal): Promise<ExecAnswer> => {
    const answer = gates.ask(question);
    await inTurn(async () => progress(latest.pushed));

    for (;;) {
      const given = await Promise.race([answer, sleep(ANSWER_READ_MS, undefined, { signal }).then(() => undefined, () => undefined)]);

      if (given !== undefined) return given;

      // A question that ends unanswered is no longer written with the claim's progress.
      if (signal.aborted) gates.refuse('The question closed before the owner answered it.');
      else if (gone !== undefined || cancelling !== undefined) gates.refuse('The owner stopped the attempt before it answered.');
      else if (beating === undefined) await inTurn(readRecord);
    }
  };

  // A command step gets what the local driver gives it: a run folder, its marker and the run mode. The folder is the
  // attempt's own: the run's folder on this home may be its owner's, holding what earlier steps left for later ones.
  const runDir = path.join(attemptDir(config, run, attempt), 'run');
  const marked = ready.kind === 'command' ? { ...attemptEnv(config, run, attempt, resolveRunMode(process.env)), [RUN_DIR_ENV]: runDir } : {};

  if (ready.kind === 'command') await fs.mkdir(runDir, { recursive: true });

  try {
    const command = ready.kind === 'workflow'
      ? workflowRun(config, { claim, trusted: ready, place: place.workflow ?? { kind: 'here' }, work, from, secrets, ask: askOwner, ...(spent && { spent }) })
      : ready.kind === 'prompt'
      ? promptRun(config, { lock, claim, trusted: ready, place: place.prompt ?? { kind: 'here' }, work, root, secrets })
      : commandRun(config, { run, attempt, step: lease.step, secrets }, place.command?.kind === 'runtime'
        ? runtimeCommand(config, { run, attempt, place: place.command, work, runDir, command: ready.command, env: { ...providedEnv(ready.scoped), ...ready.env, ...marked }, unset: ready.scoped.scope?.withhold ?? [] })
        : startGroupedCommand({ command: ready.command, cwd: work, env: { ...ready.scoped.env, ...ready.env, ...commandStepEnv(config, run, attempt, resolveRunMode(process.env)), [RUN_DIR_ENV]: runDir }, detached: process.platform !== 'win32', group: dir }));

    stopCommand = command.stop;

    // Progress comes three times per `stale_after`, so one late write does not make the member look gone. A beat still
    // writing skips the next, and the result waits for it, so each write replaces the one before. Between beats further
    // apart than CANCEL_READ_MS, the member reads the record for a cancel.
    const beatMs = Math.max(1_000, Math.floor(claim.staleAfterMs / 3));
    // Ticks divide a beat evenly, so beats come every beatMs, not at the next whole tick after it.
    const tickMs = Math.ceil(beatMs / Math.ceil(beatMs / CANCEL_READ_MS));
    let sinceBeat = 0;

    const beat = setInterval(() => {
      if (beating) return;
      sinceBeat += tickMs;
      const isBeat = sinceBeat >= beatMs;

      if (isBeat) sinceBeat = 0;
      beating = (async () => {
        if (!isBeat) return readRecord();
        const saved = await save(`[teamai] ${lease.step} so far (run ${run}, attempt ${attempt})`);

        await progress('to' in saved ? saved.to : latest.pushed);
      })().finally(() => {
        beating = undefined;
      });
    }, tickMs);

    let ran: FleetResult;

    // A step that fails instead of ending still ends its claim, so its owner need not wait out stale_after to retry it.
    try {
      ran = await command.exit;
    } catch (error) {
      const cause = (error instanceof Error ? error.message : String(error)).slice(0, 300).replace(/[.\s]*$/, '.');
      ran = { exitCode: 1, stderr: `The member's run of step "${lease.step}" failed before the step ended: ${cause} ${retryCommand({ run, step: lease.step })} offers it again.` };
    } finally {
      clearInterval(beat);
    }

    await beating;

    if (gone !== undefined) return { error: { code: 'state_moved', message: `The owner of run ${run} gave up attempt ${attempt} of step "${lease.step}" while this member ran it, so its result was not written. ${gone}` } };
    const saved = await save(`[teamai] ${lease.step} (run ${run}, attempt ${attempt})`);

    if (cancelling) return answered(config, cancelling, 'to' in saved ? saved.to : latest.pushed, ran.tokens);

    // A prompt's owner reads its end from `failure`, not the exit code.
    if ('error' in saved) return finish({ ...ran, exitCode: ran.exitCode === 0 ? 1 : ran.exitCode, stderr: saved.error, failure: { code: 'push_failed', message: saved.error } });

    // A restarted member goes on from work its killed run pushed, which is the step's work even when this run adds none.
    return finish(saved.to === claim.start ? ran : { ...ran, to: saved.to });
  } finally {
    // However the step ended, a run its command's process started and drove ends with it.
    await endRunsPartOf(config, { run, attempt });
    await Promise.all([fs.rm(work, { recursive: true, force: true }), fs.rm(runDir, { recursive: true, force: true })]);
  }
}

/** A step the member runs: how it ended, as the record writes it, and how to stop it. */
type StepRun = { exit: Promise<FleetResult>; stop: () => Promise<void> };

/**
 * A command the member runs, ending as the local loop reports a command: its exit code, the JSON its stdout held, and
 * the start of its stderr. What else it printed on stdout stays on this machine, in the attempt's stdout.log, as the
 * local driver keeps it.
 */
function commandRun(config: LocalConfig, { run, attempt, step, secrets }: { run: RunId; attempt: AttemptId; step: string; secrets: Record<string, string> }, command: GroupedCommand): StepRun {
  const exit = command.exit.then(async (exited): Promise<FleetResult> => {
    const outputs = commandOutputs(exited.stdout);
    const kept = outputs === undefined ? await keepAttemptStdout(config, { run, attempt, stdout: exited.stdout, secrets }) : undefined;

    if (kept !== undefined) log.info(`Step "${step}" printed text on stdout, which is not its outputs: its last lines are in ${kept}.`);

    return { exitCode: exited.exitCode, stderr: exited.stderr.trim().slice(0, 400), ...(outputs !== undefined && { outputs }) };
  });

  return {
    exit,
    stop: async () => {
      await command.stop();
    },
  };
}

/**
 * Prompt step `trusted` of claim `claim`, run in clone `work` as this member runs a prompt step itself: its own tool,
 * model and login, here or on the step runtime `place` of its own driver, on a lease rebuilt from its own definitions.
 * It ends as the member's report says: success or failure, the output, the tool and its usage.
 */
function promptRun(config: LocalConfig, { lock, claim, trusted, place, work, root, secrets }: {
  lock: RunLock; claim: HeldAttempt; trusted: Extract<Trusted, { kind: 'prompt' }> & { scoped: ScopedEnv }; place: NonNullable<MemberPlace['prompt']>; work: string; root: string; secrets: Record<string, string>;
}): StepRun {
  const { run, attempt } = claim;
  const { step } = trusted;
  const stopping = new AbortController();
  const running = place.kind === 'runtime' ? attemptRun({ config, run, attempt, runtime: place.runtime, driver: place.driver }) : undefined;

  const exit = (async (): Promise<FleetResult> => {
    await fs.mkdir(path.dirname(attemptResultPath(config, run, attempt)), { recursive: true });
    const { scope, env: processEnv, teamEnv } = trusted.scoped;

    // The lease the engine would have sent this member, from its own copy of the step: the record names only its values.
    const lease: StagedLease = {
      attempt, revision: 0, step: claim.lease.step, prompt: trusted.prompt, env: trusted.env, cwd: work, processEnv, ...(scope && { envScope: scope }),
      ...(step.agent !== undefined && { agent: step.agent }),
      ...(step.tool !== undefined && { tool: step.tool }),
      ...(step.permissions === 'unattended' && { permissions: 'unattended' as const }),
      ...(step.model instanceof Object ? { model: step.model } : trusted.model !== undefined && { model: trusted.model }),
      ...(trusted.defaultModel !== undefined && { defaultModel: trusted.defaultModel }),
      ...(step.output !== undefined && { output: step.output }),
      ...(trusted.limits !== undefined && { limits: trusted.limits }),
    };

    const body = await runPromptStep({
      config, lock, driver: driverIdentity('local', root), lease, archive: openSessionArchive(config), signal: stopping.signal, mode: resolveRunMode(process.env),
      secrets: { ...teamEnv.secrets, ...secrets },
      ...(running && place.kind === 'runtime' && { onRuntime: promptRuntimeOn({ run: running, offered: place.offer, teamEnv }) }),
    });

    const unclosed = await running?.close();

    if (unclosed) log.warn(unclosed.message);
    const outputs = JsonValueSchema.safeParse(body.outputs);

    if (body.tool !== undefined && body.session !== undefined) await archiveSession(config, { run, attempt, root, session: { tool: body.tool, id: body.session } });

    return {
      exitCode: body.exitCode ?? (body.outcome === 'success' ? 0 : 1), stderr: (body.message ?? '').slice(0, 400),
      ...(body.outputs !== undefined && outputs.success && { outputs: outputs.data }),
      ...(body.tool !== undefined && { tool: body.tool }),
      ...(body.session !== undefined && { session: body.session }),
      ...(body.model !== undefined && { model: body.model }),
      ...(body.tokens !== undefined && { tokens: body.tokens }),
      ...(body.failure !== undefined && { failure: { code: body.failure.code, message: body.failure.message } }),
    };
  })();

  return {
    exit,
    stop: async () => {
      stopping.abort();
      await exit;
    },
  };
}

/** What a nested run's local loop answers once the run ended. */
const NestedDoneSchema = z.object({
  done: z.object({ outcome: z.string(), end: z.string().min(1).optional(), failure: z.object({ code: z.string(), message: z.string() }).optional(), outputs: z.record(z.string(), JsonValueSchema).optional() }),
});

/**
 * Whole workflow `trusted` of claim `claim`, run in clone `work` as a nested run of its own: the sub-graph from this
 * member's own copy of the team's workflows, started with the inputs the offer's values render, and driven by its local
 * loop on the runtimes of its driver (`place`). Its steps work in one copy of the run, as they would in the copy of the
 * workflow step on the owner; once it ends, the clone takes that copy's last commit, which the member pushes to the
 * attempt's ref. It ends as the run did: its outcome, end and outputs. `spent`, what the nested run a killed run of
 * the claim left spent, comes out of its budget and joins what it returns as spent.
 */
function workflowRun(config: LocalConfig, { claim, trusted, place, work, from, secrets, ask, spent }: {
  claim: HeldAttempt; trusted: Extract<Trusted, { kind: 'workflow' }>; place: NonNullable<MemberPlace['workflow']>; work: string; from: string; secrets: Record<string, string>;
  ask: (question: ExecQuestion, signal: AbortSignal) => Promise<ExecAnswer>; spent?: Required<TokenUsage>;
}): StepRun {
  const { definition: offered } = claim;
  let nested: RunId | undefined;
  // Why the owner gave no answer to a gate, which then fails the run.
  let refused: string | undefined;
  // A stop that comes before the nested run exists stops it once it does.
  let isStopped = false;

  // A gate of the nested run goes to the owner, whose person answers it: the local loop applies the answer as typed.
  const question = async ({ step, kind, message, options, required, default: preset }: ExecQuestion, signal: AbortSignal): Promise<string> => {
    const answer = await ask({ step, kind, message, options, required, ...(preset !== undefined && { default: preset }) }, signal);

    if ('refused' in answer) {
      refused = answer.refused;
      throw new Error(answer.refused);
    }

    return answer.note === undefined ? answer.choice : `${answer.choice} ${answer.note}`;
  };

  const failed = (failure: { code: string; message: string }): FleetResult => ({ exitCode: 1, stderr: failure.message.slice(0, 400), failure });

  const exit = (async (): Promise<FleetResult> => {
    const teamEnv = await resolveWorkflowEnv(config);
    const known = { ...teamEnv.secrets, ...secrets };
    const { budget } = trusted.child;

    // A private run publishes no record of its own: it is the owner's step.
    const definition: WorkflowDefinition = {
      ...trusted.child, private: true, ...(!trusted.isReadOnly && { workspace: 'new' as const }),
      ...(budget && spent && { budget: { tokens: Math.max(0, budget.tokens - budgeted(spent)) } }),
    };

    const created = await createRun(config, {
      name: definition.name, inputs: isJsonObject(trusted.inputs) ? trusted.inputs : undefined, sourceHash: offered.sourceHash, teamRevision: offered.teamRevision,
      runMode: resolveRunMode(process.env), definition, workflows: {}, folder: trusted.folder, folders: trusted.folders, base: { commit: from }, checkout: work, origin: offered.origin ?? { source: 'team' }, secrets: known, nestedIn: claim.run,
    });

    if (!('data' in created)) return failed(created.error);
    const id = RunIdSchema.safeParse(created.data.run);

    if (!id.success) return failed({ code: 'run_unreadable', message: `The nested run of step "${claim.lease.step}" started with no run id this teamai reads.` });
    nested = id.data;
    // Recorded before any of its steps starts, so a restart of this member finds it and stops what it left.
    await writeRegularFile(nestedRunPath(config, claim.run, claim.attempt), nested);

    if (isStopped) {
      await endNestedRun(config, nested, STOPPED_NESTED);

      return failed({ code: 'cancelled', message: `The owner stopped the fleet attempt before its nested run ${nested} started.` });
    }

    const driven = await runLocalDriver(config, nested, work, { hitl: true, question, autoApprove: false, ...(place.kind === 'driver' && { runtimes: place.runtimes }) });
    const ended = 'data' in driven ? NestedDoneSchema.safeParse(driven.data) : undefined;

    // The gate the owner refused fails the run, which no longer waits at it.
    if (refused !== undefined) await endNestedRun(config, nested, refused);
    const state = await readRun(config, id.data);
    const isRead = state !== 'missing' && state !== 'corrupt';
    // What its steps spent, which the owner counts against the budgets around the step, whatever its end.
    const usage = totalUsage(isRead ? spentUsage(state) : undefined, spent);
    const tokens = usage !== undefined && usage.input + usage.output + usage.cachedInput > 0 ? { tokens: usage } : {};

    if (refused !== undefined) return { ...failed({ code: 'hitl_required', message: refused }), ...tokens };

    if (!ended?.success) return { ...failed('error' in driven ? driven.error : { code: 'run_unreadable', message: `The nested run ${nested} of step "${claim.lease.step}" did not say how it ended.` }), ...tokens };
    const { outcome, end, failure, outputs } = ended.data.done;
    const copied = isRead ? state.copies?.[runCopyBranch(state.id)]?.commit : undefined;
    // The clone takes the copy's work, which the member then pushes as the attempt's.
    const taken = copied === undefined || copied === from ? undefined : await git(work, ['checkout', '--quiet', '--detach', copied]);

    if (taken && taken.code !== 0) return failed({ code: 'workspace_base', message: `The member could not take the work of its nested run ${nested}: ${taken.stderr.trim()}` });
    const isSucceeded = outcome === 'succeeded';

    return {
      exitCode: isSucceeded ? 0 : 1, stderr: (failure?.message ?? '').slice(0, 400),
      ...(outputs !== undefined && { outputs }), ...(end !== undefined && { end }), ...tokens,
      ...(!isSucceeded && { failure: failure ?? { code: 'runtime_failed', message: `The nested run ${nested} of step "${claim.lease.step}" ended ${outcome}.` } }),
    };
  })();

  return {
    exit,
    stop: async () => {
      isStopped = true;

      // Its local loop, still live, stops what it runs once it reads the cancel.
      if (nested !== undefined) await cancelRun(config, nested, await knownSecrets(config), undefined, { code: 'cancelled', message: STOPPED_NESTED });
      await exit;
    },
  };
}

const STOPPED_NESTED = 'Cancelled: the owner cancelled the fleet attempt that runs it';

/** Where the member keeps the id of the nested run a whole workflow attempt started. */
function nestedRunPath(config: LocalConfig, run: RunId, attempt: AttemptId): string {
  return path.join(attemptDir(config, run, attempt), 'nested-run');
}

/**
 * Ends nested run `nested`, whose local loop is not live, as `teamai workflow cancel` ends a run with no live driver:
 * cancelled with `message` under its lock, then what its steps left running stopped. Why it could not, if it could not.
 */
async function endNestedRun(config: LocalConfig, nested: RunId, message: string): Promise<string | undefined> {
  const taken = await takeRunLock(config, nested, async (lock) => {
    const cancelled = await cancelRun(config, nested, await knownSecrets(config), undefined, { code: 'cancelled', message });

    // A run that already ended may still have left what a cancelled attempt of it started.
    if ('error' in cancelled && cancelled.error.code !== 'run_settled') return cancelled.error.message;
    await stopCancelledAttempts(config, lock, { isRunnerHolding: isSkillRunnerHolding });

    return undefined;
  }, { waitMs: 0 });

  return taken.kind === 'busy' ? taken.error.message : taken.value;
}

/**
 * Ends the nested run an earlier run of this member started for attempt `attempt` of run `run` and left, as a member
 * killed during a whole workflow leaves it, and what that run spent, which the run of the step again counts. One it
 * could not end may still run: the claim is kept, so no second nested run of the step runs beside it.
 */
async function endLeftNestedRun(config: LocalConfig, run: RunId, attempt: AttemptId): Promise<LeftNestedRun> {
  const file = nestedRunPath(config, run, attempt);
  // Only a record that is not there says no nested run is left: one that cannot be read may name a run still running.
  let text: string | null;

  try {
    text = await readRegularFile(file, 'utf8');
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') text = null;
    else return { kind: 'running', message: `The nested run of the whole workflow it ran may still run: its id in ${file} could not be read (${error instanceof Error ? error.message : String(error)}). Make the file readable, then run the step again.` };
  }

  if (text === null) return { kind: 'ended' };
  const left = RunIdSchema.safeParse(text.trim());

  if (!left.success) return { kind: 'running', message: `The nested run of the whole workflow it ran may still run: ${file} does not hold a run id. Stop that run with teamai workflow cancel, remove the file, then run the step again.` };
  const failed = await endNestedRun(config, left.data, 'Cancelled: the fleet member that ran it stopped, and runs its step again');

  if (failed !== undefined) return { kind: 'running', message: `The nested run ${left.data} of the whole workflow it ran may still run: ${failed}` };
  const state = await readRun(config, left.data);
  await fs.rm(file, { force: true });

  return state === 'missing' || state === 'corrupt' ? { kind: 'ended' } : { kind: 'ended', spent: spentUsage(state) };
}

/** What a killed run of this member left of a whole workflow's nested run: one that may still run, or one ended, with what it spent. */
type LeftNestedRun = { kind: 'running'; message: string } | { kind: 'ended'; spent?: Required<TokenUsage> };

/** `first` and `second` together, by kind. */
function totalUsage(first: Required<TokenUsage> | undefined, second: Required<TokenUsage> | undefined): Required<TokenUsage> | undefined {
  if (first === undefined || second === undefined) return first ?? second;

  return { input: first.input + second.input, output: first.output + second.output, cachedInput: first.cachedInput + second.cachedInput };
}

/**
 * Pushes the session a prompt step ran on this member to the team session archive, filed under the business repository
 * of checkout `root`, so the owner's later step continues it, as `publish --sessions` does. The tool's store is the one
 * `root`'s config records, as the step's clone has no config of its own. The files the step left in its attempt's
 * `out/` go beside it. A session that does not reach the archive leaves the step's end as it is: a later step that
 * continues it starts a new session and says why.
 */
async function archiveSession(config: LocalConfig, { run, attempt, root, session }: { run: RunId; attempt: AttemptId; root: string; session: { tool: string; id: string } }): Promise<void> {
  const platform = AgentSession.platformForTool(session.tool);

  if (!platform) return;
  const holding = await attemptHoldingSession(config, run, session);
  const archived = await archiveSessions(config, [[{ platform, sessionId: session.id, evidenceDir: attemptOutDir(config, run, attempt), ...(holding && { storeDir: holding.storeDir }) }]], { run, checkout: root });

  if (archived.status === 'failed') log.warn(`The ${session.tool} session ${session.id} of run ${run} did not reach the team session archive, so a later step that continues it starts a new session: ${archived.message}`);
}

/**
 * Command `command` in clone `work` on the member's step runtime `place`: open a place on `work`, one exec of the shell,
 * bring the place's work back into `work`, close it. The runtime gets the step's env alone, never this process's. A
 * failure of the runtime ends it as a failed command whose stderr says why, so the member writes it as the step's end.
 */
function runtimeCommand(config: LocalConfig, { run, attempt, place, work, runDir, command, env, unset }: { run: RunId; attempt: AttemptId; place: RuntimePlace; work: string; runDir: string; command: string; env: Record<string, string>; unset: readonly string[] }): GroupedCommand {
  const running = attemptRun({ config, run, attempt, runtime: place.runtime, driver: place.driver });
  let output = '';
  let stderr = '';
  // A stop while the place opens finds no exec to cancel, so the exec is not sent.
  let isStopRequested = false;
  const failed = (message: string): GroupedCommandExit => ({ exitCode: 1, stdout: '', stderr: `${stderr}${message} (step runtime "${place.use}")`, output });

  const exit = (async (): Promise<GroupedCommandExit> => {
    const result = path.dirname(attemptResultPath(config, run, attempt));
    await Promise.all([fs.mkdir(result, { recursive: true }), fs.mkdir(runDir, { recursive: true })]);
    const folder = WorkflowFolder.named(config, env[WORKFLOW_DIR_ENV]);
    const opened = await running.open({ worktree: work, readonly: [path.join(work, '.git'), ...folder === undefined ? [] : [folder]], result, runDir, toolHome: {} });

    if (!opened.ok) return failed(opened.failure.message);

    if (isStopRequested) {
      const unclosed = await running.close();

      if (unclosed) log.warn(unclosed.message);

      return { exitCode: STOPPED_EXIT_CODE, stdout: '', stderr, output };
    }

    let end: Awaited<ReturnType<typeof running.exec>>;

    // A command runs no tool, so it gets none of the runtime's credentials.
    try {
      end = await running.exec({ argv: shellArgv(command), env, unset: [...unset], credentials: {}, cwd: work }, {
        onOutput: (stream, data) => {
          output += data;

          if (stream === 'stderr') stderr = `${stderr}${data}`.slice(-STDERR_KEPT);
        },
      }, 'command');
    } catch (error) {
      // An exec that fails instead of ending still closes its place, so a retry is the only one open.
      const unclosed = await running.close();

      if (unclosed) log.warn(unclosed.message);
      throw error;
    }

    const uncollected = await running.collect();
    const unclosed = await running.close();

    if (uncollected) return failed(uncollected.message);

    if (unclosed) log.warn(unclosed.message);

    switch (end.kind) {
      case 'exited': return { exitCode: end.code, stdout: end.stdout, stderr, output: output || end.stdout };
      case 'cancelled': return { exitCode: STOPPED_EXIT_CODE, stdout: '', stderr, output };
      case 'failed':
      case 'lost': return failed(end.failure.message);
      case 'interrupted':
      case 'left': return failed('teamai stopped while the step ran.');
      default: {
        const unhandled: never = end;

        return unhandled;
      }
    }
  })();

  let stopping: Promise<GroupedCommandExit> | undefined;

  return {
    exit,
    stop: () => {
      isStopRequested = true;
      stopping ??= running.cancel().then(() => exit);

      return stopping;
    },
  };
}

/** What the env of a step's processes is scoped from: its `requires` in effect, and the `requires.env` keys of the whole run. */
type StepScope = { requires: InEffect; runEnvKeys: readonly string[] };

/**
 * The env a step's processes run with, as the local driver scopes a lease: the keys its `requires.env` names, from the
 * member's team store, and none of the team's other keys or, under a strict sandbox, the forge tokens. The team env it
 * read, or the failure of a required key with no value here.
 */
async function scopedStep<T extends Exclude<Trusted, { kind: 'workflow' }>>(config: LocalConfig, trusted: T): Promise<(T & { scoped: ScopedEnv }) | { kind: 'failed'; failure: WorkflowFailure }> {
  const { requires, runEnvKeys } = trusted.scope;
  const teamEnv = await resolveWorkflowEnv(config);
  const scope = envScopeOf(requires.env ?? [], { ...(requires.floor && { floor: requires.floor }), guarded: [...teamEnv.facts.declared, ...runEnvKeys] });

  if (scope.provide.length === 0 && scope.withhold.length === 0) return { ...trusted, scoped: { env: withRunningCli(process.env), teamEnv } };
  const built = await stepEnvironment(teamEnv, scope);

  return built.ok ? { ...trusted, scoped: { scope, env: built.env, teamEnv } } : { kind: 'failed', failure: built.failure };
}

/** The env of a step's processes here, the scope it was built from when the step has one, and the team env it read. */
type ScopedEnv = { scope?: EnvScope; env: NodeJS.ProcessEnv; teamEnv: WorkflowEnv };

/** The keys `scoped` provides, with their values, which a step runtime sets over its own environment. */
function providedEnv({ scope, env }: ScopedEnv): Record<string, string> {
  return Object.fromEntries((scope?.provide ?? []).flatMap((key) => (env[key] === undefined ? [] : [[key, env[key]]])));
}

/** What a member runs for a claim, as its own copy of the team's workflow defines it: a command, or a prompt step. */
type Trusted =
  | { kind: 'command'; command: string; env: Record<string, string>; scope: StepScope }
  | { kind: 'prompt'; step: WorkflowStep; prompt: string; model?: string; defaultModel?: string; env: Record<string, string>; limits?: TurnLimits; scope: StepScope }
  | { kind: 'workflow'; child: WorkflowDefinition; inputs: JsonValue; isReadOnly: boolean } & Pick<RunState, 'folder' | 'folders'>;

/**
 * The team's workflows the run of `offered` runs, as this member finds them: at the team commit the offer pins when the
 * member would run that commit itself, else its own copy, which must match. Or why it finds none.
 */
async function teamDefinitions(config: LocalConfig, { run, definition }: Pick<Offered, 'run' | 'definition'>): Promise<{ definitions: Definitions } | { refused: string }> {
  const { teamRevision, ...named } = definition;
  // A team commit the member would not run itself names no definitions: without it, only its own copy can match.
  const isTrusted = teamRevision !== undefined && (await teamCommitReach(config, teamRevision)).kind === 'member';
  const found = await definitionsOf(config, { run, ...named, ...(isTrusted && { teamRevision }) });

  if (!found.ok && teamRevision !== undefined && !isTrusted) {
    return { refused: `workflow "${definition.name}" comes from team commit ${teamRevision}, which neither this member's team checkout nor the team's default branch holds, and this member's copy of it differs. Merge it to the default branch.` };
  }

  return found.ok ? { definitions: found.value } : { refused: found.error.message };
}

/**
 * What the team's workflow defines for the step `claim` offers, its texts rendered from the offer's values, or why this
 * member does not run it. Anyone who can write to teamai-reports can write a record, so the member runs only what the
 * definitions the run executes say, read from its own team repository, as a claimer of a published run does; a lease
 * that says otherwise is refused, not corrected. Every team commit the record names counts only when this member would
 * run that commit itself: `definition.teamRevision` is the only one a record carries.
 */
async function trustedLease(config: LocalConfig, claim: HeldAttempt): Promise<Trusted | { refused: string; next?: string }> {
  const { run, lease, definition, values } = claim;
  const found = await teamDefinitions(config, claim);

  if ('refused' in found) return found;
  const { kind } = lease;
  const defined = definedStep(found.definitions, lease.step);

  switch (defined.kind) {
    case 'step': break;
    case 'admitted':
      return {
        refused: `in workflow "${definition.name}", step "${defined.by}" runs the workflow step "${defined.from}" wrote, which no workflow of the team defines, so a member cannot check what it runs.`,
        next: `Route the steps of that workflow to a runtime besides the fleet.`,
      };
    case 'none': return { refused: `workflow "${definition.name}" has no ${kind} step at ${lease.step}.` };
    default: {
      const unhandled: never = defined;

      return unhandled;
    }
  }

  const { step, defaultModel, requires, around } = defined;
  const scope: StepScope = { requires, runEnvKeys: [...requiredEnvKeys([found.definitions.definition, ...Object.values(found.definitions.workflows)])] };
  const rendered = leaseEnv(step, values, run);

  if ('error' in rendered) return { refused: `workflow "${definition.name}" ${rendered.error}.` };
  const names = [...new Set([...Object.keys(rendered.env), ...Object.keys(lease.env)])];
  const differs = names.filter((name) => rendered.env[name] !== lease.env[name]).sort();

  if (differs.length > 0) return { refused: `the offer's env ${differs.join(', ')} differs from what workflow "${definition.name}" renders from the offer's values.` };

  switch (lease.kind) {
    case 'workflow': {
      if (step.workflow === undefined) return { refused: `workflow "${definition.name}" has no workflow step at ${lease.step}.` };
      // A member runs only the sub-graph it was offered whole, as its own copy of the team's workflows defines it.
      const runs = workflowRunBy(found.definitions, step, '');
      const fit = wholeFit(step, runs, defined);

      if ('unfit' in fit || runs === undefined) return { refused: `in workflow "${definition.name}", step "${lease.step}" does not run whole here: ${'unfit' in fit ? fit.unfit : 'it runs no workflow'}.` };
      const inputs = leaseInputs(step, runs, values, run);

      if ('error' in inputs) return { refused: `workflow "${definition.name}" step "${lease.step}" ${inputs.error}.` };

      if (!isDeepStrictEqual(inputs.inputs, lease.inputs)) return { refused: `the offer's inputs differ from what workflow "${definition.name}" renders from the offer's values for step "${lease.step}".` };

      const folders = await pinnedFolders(config, claim, found.definitions, isWorkflowFile(runs) ? runs.name : around);

      return { kind: 'workflow', child: wholeRunDefinition(step, fit.child, { defaultModel, budgetLeft: lease.budget?.tokens }), inputs: inputs.inputs, isReadOnly: step.workspace === 'read-only', ...folders };
    }

    case 'command': {
      if (step.command === undefined) return { refused: `workflow "${definition.name}" has no command step at ${lease.step}.` };

      if (step.command !== lease.command) return { refused: `the offer's command differs from the one workflow "${definition.name}" defines for it.` };

      return { kind: 'command', command: step.command, env: { ...rendered.env, ...await folderEnv(config, claim, found.definitions, around) }, scope };
    }

    case 'prompt': {
      if (step.prompt === undefined || step.answer !== undefined) return { refused: `workflow "${definition.name}" has no prompt step at ${lease.step}.` };
      const texts = leasePrompt(step, values, run);

      if ('error' in texts) return { refused: `workflow "${definition.name}" ${texts.error}.` };

      if (texts.prompt !== lease.prompt) return { refused: `the offer's prompt differs from what workflow "${definition.name}" renders from the offer's values.` };

      return {
        kind: 'prompt', step, prompt: texts.prompt, env: { ...rendered.env, ...await folderEnv(config, claim, found.definitions, around) }, scope,
        ...(texts.model !== undefined && texts.model !== '' && { model: texts.model }),
        // A model that rendered empty asks for the tool's default, so the defaults' model does not stand in for it.
        ...(defaultModel !== undefined && texts.model !== '' && { defaultModel }),
        ...(lease.limits !== undefined && { limits: lease.limits }),
      };
    }

    default: {
      const unhandled: never = lease;

      return unhandled;
    }
  }
}

/** The folder the workflow file `name` of `definitions` is written as; none for a single file. */
function folderOfFile({ definition, folder, folders }: Definitions, name: string): PinnedFolder | undefined {
  return name === definition.name ? folder : folders[name];
}

/**
 * What a step of the workflow file `around` gets to read its folder, as the owner's steps do: the folder kept in this
 * member's data home, written there first. Nothing for a single file.
 */
async function folderEnv(config: LocalConfig, claim: HeldAttempt, definitions: Definitions, around: string): Promise<Record<string, string>> {
  const folder = folderOfFile(definitions, around);

  if (folder === undefined) return {};
  await noteHeldFolders(config, claim, [folder.sourceHash]);
  await WorkflowFolder.pin(config, folder);

  return WorkflowFolder.env(config, folder.sourceHash);
}

/**
 * The folders a nested run of the workflow file `top` reads, kept in this member's data home first: its own, and those
 * of the workflows of `definitions` it may run by name, as a run records them.
 */
async function pinnedFolders(config: LocalConfig, claim: HeldAttempt, definitions: Definitions, top: string): Promise<Pick<RunState, 'folder' | 'folders'>> {
  const own = folderOfFile(definitions, top);
  const pinned = [...own ? [own] : [], ...Object.values(definitions.folders)];
  await noteHeldFolders(config, claim, pinned.map((folder) => folder.sourceHash));
  await Promise.all(pinned.map((folder) => WorkflowFolder.pin(config, folder)));
  const named = Object.entries(definitions.folders);

  return { ...own && { folder: own.sourceHash }, ...named.length > 0 && { folders: Object.fromEntries(named.map(([name, folder]) => [name, folder.sourceHash])) } };
}

/**
 * The step at instance path `stepPath` in `definitions`, as `locateStep` finds it in a run: a `finally` step at the top, and
 * nested workflows inline or by name. A workflow a `from` step admitted is in no definition: `admitted` names the step
 * `by` that runs it and the step `from` that wrote it.
 */
function definedStep({ definition, workflows }: Definitions, stepPath: string):
  | { kind: 'step'; step: WorkflowStep; defaultModel?: string; requires: InEffect; around: string } | { kind: 'admitted'; by: string; from: string } | { kind: 'none' } {
  const segments = parseStepPath(stepPath);
  let steps = definition.finally?.some((step) => step.id === segments[0]?.id) ? definition.finally : definition.steps;
  // The `defaults.model` in effect, a nested workflow's over the one it runs in, as the engine's scope keeps it.
  let defaultModel = definition.defaults?.model;
  // The `requires` in effect, which add up level by level as the engine's scope merges them.
  let requires = mergeRequirements(definition.defaults?.requires);
  // The workflow file the step is in, an inline workflow's steps being steps of the file it is written in.
  let around = definition.name;

  for (const [index, segment] of segments.entries()) {
    const step = steps.find((item) => item.id === segment.id);

    if (!step) return { kind: 'none' };

    if (index === segments.length - 1) return { kind: 'step', step, requires: mergeRequirements(requires, step.requires), around, ...(defaultModel !== undefined && { defaultModel }) };
    const runs = stepWorkflow(step);

    if (runs?.kind === 'from') return { kind: 'admitted', by: step.id, from: runs.step };
    const child = workflowRunBy({ workflows }, step, '');

    if (!child) return { kind: 'none' };
    steps = child.steps;
    defaultModel = ('defaults' in child ? child.defaults?.model : undefined) ?? defaultModel;
    requires = mergeRequirements(requires, step.requires, 'defaults' in child ? child.defaults?.requires : undefined);
    around = isWorkflowFile(child) ? child.name : around;
  }

  return { kind: 'none' };
}

/**
 * Snapshots what the step has in `work` as a commit on `parent` and pushes it to `ref`: the commit `ref` then holds. It
 * stages into `index`, a file of its own, so the step's own HEAD and index stay as the step left them while it still
 * runs. The step ran there, so only the programs of `memberConfig` that its config names run.
 */
async function pushWork({ work, ref, message, memberConfig, parent, index }: { work: string; ref: string; message: string; memberConfig: MemberConfig; parent: string; index: string }): Promise<{ to: string } | { error: string; taken?: string }> {
  await fs.rm(index, { force: true });
  const snapshotGit = untrustedGit({ ...hostGitEnv(), GIT_INDEX_FILE: index }, undefined, memberConfig);
  const read = await snapshotGit(work, ['read-tree', parent]);
  const added = read.code === 0 ? await snapshotGit(work, ['add', '-A']) : read;
  const tree = added.code === 0 ? await snapshotGit(work, ['write-tree']) : added;

  if (tree.code !== 0) return { error: `The member could not commit the step's work: ${tree.stderr.trim()}` };
  const unchanged = gitAnswer(await snapshotGit(work, ['diff-tree', '--quiet', parent, tree.stdout.trim()]));

  if (unchanged.said === 'yes') return { to: parent };

  if (unchanged.said === 'nothing') return { error: `The member could not commit the step's work: ${unchanged.result.stderr.trim()}` };
  const committed = await snapshotGit(work, ['-c', 'user.name=TeamAI', '-c', 'user.email=teamai@localhost', 'commit-tree', tree.stdout.trim(), '-p', parent, '-m', message]);

  if (committed.code !== 0) return { error: `The member could not commit the step's work: ${committed.stderr.trim()}` };
  const to = committed.stdout.trim();
  // The origin this checkout named before the step, never the one the step's copy names now.
  const targets = pushTargets(memberConfig);

  if (targets.length === 0) return { error: `The member could not push the step's work to ${ref}: its checkout names no origin.` };

  const failed: string[] = [];

  for (const target of targets) {
    const pushed = await remoteGit(work, { kept: target.kept, env: hostGitEnv() }, ['push', '--quiet', target.url, `${to}:${ref}`], snapshotGit);

    if (pushed.code !== 0) failed.push(pushed.stderr.trim());
  }

  if (failed.length === 0) return { to };
  const error = `The member could not push the step's work to ${ref}: ${failed.join('; ')}`;

  // Saved only once every push URL holds it, as the owner fetches from its own origin.
  return failed.length < targets.length ? { error, taken: to } : { error };
}
