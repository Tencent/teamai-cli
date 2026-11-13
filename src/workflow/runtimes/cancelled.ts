import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveRunMode } from '../../launch-context.js';
import type { LocalConfig } from '../../types.js';
import { log } from '@teamai/shared/log';
import type { RunStatus, WorkflowFailure } from '../types.js';
import { existingCheckout } from '../run-location.js';
import { errnoCode } from '../../utils/fs.js';
import { attemptDir, AttemptIdSchema, attemptsDir, attemptsDirIn, readRun, RunIdSchema, type AttemptId, type RunId, type RunLock } from '../store.js';
import { knownSecrets } from '../../env-resolution.js';
import { attemptRun, attemptRuntimeFile, attemptRuntimePath, attemptToolHome, HeldPlace, isPlaceLeftOpen, maskAttemptResults, readAttemptPlacement, readAttemptPlacementAt, releaseAttemptRuntime, type AttemptPlacement, type AttemptRuntimeRecord } from './attempt.js';
import { endLogin, LOGIN_TOOLS, loginHolder, type LoginTool } from './login.js';
import { disposeDriver, openDriver } from './sources.js';
import { retryCommand } from './retry-command.js';
import { CANCEL_FAILED } from '@teamai/runtime-protocol';
import type { StepRuntime } from '@teamai/runtime-protocol/step-runtime';
import type { DriverCan } from '../requirements.js';
import { stopRecordedGroup } from '@teamai/shared/process-group';

// ─── What cancelled attempts left on their step runtimes ─
//
//  A driver killed while its attempt ran leaves the tool running on the step runtime, and the attempt's login held.
//  `teamai workflow cancel`, holding the run's lock so no local driver of it is live, stops each such attempt the way
//  its driver would have: it cancels the exec, brings the place's work back, closes the place, and only then writes
//  the login back and releases it (`endLogin`). An attempt it cannot stop keeps its place, its records and its
//  login, so no second copy runs beside it, and the next `teamai workflow cancel` of the run tries again. Each
//  runtime is opened in `recover` mode for this, and for new work only when it refuses that mode (sources.ts).
//
//  A skill driver's runner works outside that lock, and stops its own attempt, ending what it holds, once it sees the
//  cancel. The cancel leaves an attempt whose runner still runs to it, so its process group and its login never have
//  two owners; one whose runner is gone it stops as any other.
//

/**
 * Whether a skill runner on this machine holds an attempt, running or just spawned (`isSkillRunnerHolding` of the skill
 * driver, which imports this module and so is passed in).
 */
export type RunnerHolding = (config: LocalConfig, run: RunId, attempt: AttemptId) => Promise<boolean>;

/**
 * Stops what each cancelled attempt of the locked run left open on its step runtime, and each other attempt whose place
 * a runtime still holds, such as one whose stop or close failed before, then releases the logins of the attempts that
 * no longer run. A cancelled attempt whose skill runner still runs is left to that runner, which stops it itself. Says what it released, and which login stays held and how to free it. Attempt `release` goes through
 * the same stop, and what its runtime cannot confirm, such as a close it can never clear, does not hold it: the person
 * checked that nothing of it still runs, so teamai writes its login back and lets it go. Answers the run's status and
 * the attempts whose place it closed or let go.
 */
export async function stopCancelledAttempts(config: LocalConfig, lock: RunLock, { isRunnerHolding, release }: { isRunnerHolding: RunnerHolding; release?: AttemptId | undefined }): Promise<StoppedAttempts | undefined> {
  const { run } = lock;
  const state = await readRun(config, run);

  if (state === 'missing' || state === 'corrupt') return undefined;
  const leased = new Set(state.steps.flatMap((step) => (step.status === 'leased' ? [step.lease.attempt] : [])));
  const stillRunning = new Set<string>();

  const cancelled = (state.cancelledAttempts ?? []).flatMap((id) => {
    const attempt = AttemptIdSchema.safeParse(id);

    return attempt.success ? [attempt.data] : [];
  });

  const runnerOwned = new Set<AttemptId>();
  const keptLogins = new Set<AttemptId>();

  // What a killed driver of this install started for a cancelled attempt, which its record reaches, and the login one
  // in teamai's process held, written back; what one runs on a step runtime, the fleet's member included, its runtime
  // stops below.
  for (const attempt of cancelled) {
    if (!await isRunnerHolding(config, run, attempt)) {
      if ((await stopLeftInProcess(config, run, attempt)).kind === 'kept') keptLogins.add(attempt);
      continue;
    }

    runnerOwned.add(attempt);
    log.info(`Attempt ${attempt} of run ${run} runs in the skill driver's runner on this machine, which stops it and releases what it holds once it sees the cancel. If that runner (teamai workflow report ${run} --driver skill --attempt ${attempt}) still runs in a minute, stop it; once it has ended, teamai workflow cancel ${run} again releases what it left.`);
  }

  const left = new Set([...cancelled, ...await placesLeftOpen(config, run, leased)].filter((attempt) => !runnerOwned.has(attempt)));

  const stopped: StoppedAttempts = { status: state.status, closed: [], released: [] };
  // Each runtime starts in the run's checkout, or, once that folder is gone, where this cancel runs.
  const checkout = await existingCheckout(state) ?? process.cwd();

  // What an agent wrote itself into an attempt's result file was never masked by a driver killed before it read it.
  const masks: Record<string, string> = {};

  for (const attempt of left) {
    // A step that failed because its stop was not confirmed can run again once it is.
    const lost = state.steps.find((step) => step.status === 'failed' && step.attempt === attempt && (step.failure?.code === 'runtime_lost' || step.failure?.code === CANCEL_FAILED));
    const { ended, masked } = await stopAttempt(config, run, attempt, { isReleased: attempt === release, checkout, ...(lost && { retry: { run, step: lost.id } }) });
    Object.assign(masks, masked);

    if (ended === 'running') stillRunning.add(attempt);
    else if (ended !== 'none') stopped[ended].push(attempt);
  }

  await maskAttemptResults(config, run, { ...await knownSecrets(config), ...masks });

  for (const tool of LOGIN_TOOLS) {
    const holder = await loginHolder(tool);

    if (holder?.run !== run || runnerOwned.has(holder.attempt) || leased.has(holder.attempt)) continue;

    // The person checked that nothing of a released attempt still runs.
    if (keptLogins.has(holder.attempt) && holder.attempt !== release) continue;

    // One that failed rather than run again beside what a killed driver left of it keeps its login while that may run.
    if (holder.attempt !== release && !left.has(holder.attempt) && (await stopLeftInProcess(config, run, holder.attempt)).kind !== 'on_runtime') continue;

    if (stillRunning.has(holder.attempt)) {
      log.warn(`The ${tool} login teamai keeps stays held by attempt ${holder.attempt} of run ${run}, whose tool may still run. Stop that tool on its step runtime, then run teamai workflow cancel ${run} --release ${holder.attempt}, which lets the attempt go and ends its login.`);
      continue;
    }

    // An attempt no longer open holds a login only because nothing ended it, as one whose record cannot be read.
    if (await endLeftLogin(config, tool, { run, attempt: holder.attempt }) && holder.attempt === release && !stopped.released.includes(release)) stopped.released.push(release);
  }

  if (release !== undefined && !left.has(release) && !runnerOwned.has(release) && !stopped.released.includes(release)) log.warn(`Attempt ${release} of run ${run} holds no place on a step runtime and no login, so there is nothing to release.`);

  return stopped;
}

/** What a cancel stopped of a run: its status, and the attempts whose place it closed, or let go as the person asked. */
export interface StoppedAttempts {
  status: RunStatus;
  closed: AttemptId[];
  released: AttemptId[];
}

/** How a stop of an attempt ended: its place closed or let go, nothing left to stop, or its work may still run. */
type AttemptStop = 'closed' | 'released' | 'none' | 'running';

/** How `stopAttempt` ended: still `running`, with why, or done; `masked` holds the values its runtime's messages are masked with. */
type Stopped = ({ ended: Exclude<AttemptStop, 'running'> } | { ended: 'running'; why: string }) & { masked?: Record<string, string> };

/** Why a step runtime may still hold an attempt's place: its record says it is open, or cannot be read. */
export type HeldPlace = { held: 'open'; record: AttemptRuntimeRecord } | { held: 'unreadable'; why: string };

/** An attempt whose place a step runtime may still hold: its record says `open`, or cannot be read. */
export type PlaceMaybeHeld = { run: RunId; attempt: AttemptId } & HeldPlace;

/**
 * Whether a step runtime may still hold the place of the attempt whose record reads `placement`, and why; undefined when
 * none does. The one test of "a place still open" that `teamai uninstall` refuses with: fails closed on a record it
 * cannot read, which may be one that is open.
 */
export function heldPlaceOf(placement: AttemptPlacement): HeldPlace | undefined {
  if (isPlaceLeftOpen(placement)) return { held: 'open', record: placement.record };

  return placement.kind === 'unreadable' ? { held: 'unreadable', why: placement.why } : undefined;
}

/**
 * Each attempt of the runs directory `runs` (`runsDir`, or `runsDirIn` of a data home) whose place a step runtime may
 * still hold, whether its run still goes or was left: `teamai workflow cancel <run>` closes them, and only while the
 * run's records are there. Fails closed: a folder there but unreadable throws, and an unreadable record is listed.
 */
export async function placesMaybeHeld(runs: string): Promise<PlaceMaybeHeld[]> {
  const held: PlaceMaybeHeld[] = [];

  for (const name of await namesIn(runs)) {
    const run = RunIdSchema.safeParse(name);

    if (!run.success) continue;
    const attempts = attemptsDirIn(runs, run.data);

    for (const entry of await namesIn(attempts)) {
      const attempt = AttemptIdSchema.safeParse(entry);

      if (!attempt.success) continue;
      const place = heldPlaceOf(await readAttemptPlacementAt(attemptRuntimeFile(path.join(attempts, attempt.data))));

      if (place !== undefined) held.push({ run: run.data, attempt: attempt.data, ...place });
    }
  }

  return held;
}

/** The names in `dir`, sorted, none when it is not there; throws when it is there but cannot be read. */
async function namesIn(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).sort();
  } catch (cause) {
    if (errnoCode(cause) === 'ENOENT') return [];
    throw cause;
  }
}

/** The attempts of `run` that no lease runs, whose record says a step runtime still holds their place. */
async function placesLeftOpen(config: LocalConfig, run: RunId, leased: ReadonlySet<string>): Promise<AttemptId[]> {
  const names = await fs.readdir(attemptsDir(config, run)).catch(() => []);
  const open: AttemptId[] = [];

  for (const name of names.sort()) {
    const attempt = AttemptIdSchema.safeParse(name);

    if (!attempt.success || leased.has(attempt.data)) continue;
    // One in teamai's process holds no place: the cancel stops its process group instead. An unreadable record names
    // no place to stop.
    const placement = await readAttemptPlacement(config, run, attempt.data);

    if (isPlaceLeftOpen(placement)) open.push(attempt.data);
  }

  return open;
}

/** How a close tells the runtime the person let the attempt go. */
const RELEASE = { release: true } as const;

/**
 * How `stopLeftInProcess` left an attempt: each process it recorded ended and its logins were let go; `left` names the
 * pid of each process no stop confirmed ended, whose logins it kept; or the attempt runs on a step runtime, which keeps
 * its login until it closes the place, with `left` as well.
 */
export type LeftInProcess = { kind: 'ended' } | { kind: 'kept'; left: readonly number[] } | { kind: 'on_runtime'; left: readonly number[] };

/**
 * Stops what a killed teamai left running of attempt `attempt` in its own process, then writes back and releases the
 * logins it held, as a Codex judge holds one: nothing of it runs any more to use them. While a process it left may still
 * run, it keeps them, says so, and answers `kept`; a later stop ends them. One on a step runtime keeps its login until
 * that runtime closes its place (`stopOnRecordedDriver`), and answers `on_runtime`.
 */
export async function stopLeftInProcess(config: LocalConfig, run: RunId, attempt: AttemptId): Promise<LeftInProcess> {
  const left = await stopRecordedGroup(attemptDir(config, run, attempt));
  const placement = await readAttemptPlacement(config, run, attempt);

  if (placement.kind !== 'in_process' && placement.kind !== 'unrecorded') return { kind: 'on_runtime', left };

  if (left.length === 0) {
    await endLeftLogins(config, run, attempt);

    return { kind: 'ended' };
  }

  for (const tool of LOGIN_TOOLS) {
    const holder = await loginHolder(tool);

    if (holder?.run !== run || holder.attempt !== attempt) continue;
    log.warn(`Kept the ${tool} login attempt ${attempt} of run ${run} holds: teamai could not confirm that process ${left.join(', ')}, which that attempt left, ended, `
      + `so its ${tool} may still use the login. Once that process has ended, the next resume or cancel of the run releases the login; `
      + `if teamai still cannot tell, teamai workflow cancel ${run} --release ${attempt} lets it go.`);
  }

  return { kind: 'kept', left };
}

/**
 * Ends each login attempt `attempt` of run `run` holds, nothing of which runs any more (`endLogin`): writes it back,
 * then releases it, and says so; warns of one not written back. `toolHome` is the tool home its step runtime recorded and
 * `isCollected` whether that runtime brought it back; one in teamai's process had its tool keep the login in the
 * attempt's own tool home.
 */
export async function endLeftLogins(config: LocalConfig, run: RunId, attempt: AttemptId, placed: { toolHome?: AttemptRuntimeRecord['toolHome']; isCollected?: boolean } = {}): Promise<void> {
  for (const tool of LOGIN_TOOLS) await endLeftLogin(config, tool, { run, attempt, ...placed });
}

/** Ends the `tool` login attempt `attempt` of run `run` held, if it held one: answers whether it did. */
async function endLeftLogin(config: LocalConfig, tool: LoginTool, { run, attempt, toolHome, isCollected = true }: { run: RunId; attempt: AttemptId; toolHome?: AttemptRuntimeRecord['toolHome']; isCollected?: boolean }): Promise<boolean> {
  const ended = await endLogin(tool, { run, attempt, toolHome: toolHome?.tool === tool ? toolHome.dir : attemptToolHome(config, run, attempt, tool), isCollected });

  if (!ended.wasHeld) return false;

  if (ended.notBack) log.warn(ended.notBack.message);
  log.info(`Released the ${tool} login teamai keeps, which attempt ${attempt} of run ${run} held.`);

  return true;
}

/**
 * Closes each place of run `run` held open for a conversation (`HeldPlace`) that `continued` no longer names in its
 * workspace, or, without it, every one: on the runtime `live` gives for its record, else through the driver its record
 * names, as a killed teamai's are. Answers why each place it could not close stays open.
 */
export async function releaseHeldPlaces(config: LocalConfig, run: RunId, { checkout, continued, live }: {
  checkout: string;
  continued?: Parameters<typeof HeldPlace.toRelease>[2];
  /** The runtime a driver still has open for the place `record` names, which closes it without opening the driver again. */
  live?: (record: AttemptRuntimeRecord) => StepRuntime<DriverCan> | undefined;
}): Promise<WorkflowFailure[]> {
  const kept: WorkflowFailure[] = [];

  for (const { attempt, record } of await HeldPlace.toRelease(config, run, continued)) {
    const runtime = live?.(record);
    const notClosed = runtime ? await attemptRun({ config, run, attempt, runtime, driver: record.driver }).close() : await stopOnRecordedDriver(config, run, attempt, { checkout });

    if (notClosed) kept.push(notClosed);
  }

  return kept;
}

/**
 * Closes every place of run `run` held here for a conversation before an offer of it, since the machine that takes the
 * run cannot reach one. Answers, as a clause, why the run is not to be offered while one stays open, so it stays here,
 * where a resume still reaches it; undefined once none is held.
 */
export async function closedForOffer(config: LocalConfig, run: RunId, options: { checkout: string; live?: Parameters<typeof releaseHeldPlaces>[2]['live'] }): Promise<string | undefined> {
  const kept = await releaseHeldPlaces(config, run, options);

  return kept.length === 0 ? undefined : `a place held here for a conversation could not be closed, and a machine that took the run could not reach it: ${kept.map((failure) => failure.message.replace(/\.$/u, '')).join('; ')}`;
}

/**
 * Stops what a killed teamai left of attempt `attempt` on the step runtime its record names, through the driver recorded
 * for it, as `teamai workflow cancel` does, and closes its place there, before a driver without that runtime runs the
 * attempt's step again, and releases the login it held once its place closed. Answers why the stop or the close is not
 * confirmed, so the place is kept, or undefined once it is closed, or when the attempt holds no place open there.
 */
export async function stopOnRecordedDriver(config: LocalConfig, run: RunId, attempt: AttemptId, { checkout }: { checkout: string }): Promise<WorkflowFailure | undefined> {
  const placement = await readAttemptPlacement(config, run, attempt);
  const stopped = await stopAttempt(config, run, attempt, { isReleased: false, checkout, isQuiet: true });

  if (stopped.ended !== 'running' || placement.kind !== 'external') return undefined;
  const { record } = placement;

  return {
    code: 'runtime_lost',
    message: `Attempt ${attempt} ran on step runtime "${record.runtime}" of driver "${record.driver}", which could not stop what ran there, so it may still run: ${stopped.why} Resume the run with --driver ${record.driver}.`,
  };
}

/**
 * Stops attempt `attempt` on the step runtime its record names, or says why it could not (`running`, with `why`). A
 * released attempt the runtime cannot stop or close is let go instead, as the person asked. `isQuiet` leaves the warning
 * to the caller, which reports `why` itself.
 */
async function stopAttempt(config: LocalConfig, run: RunId, attempt: AttemptId, { isReleased, checkout, retry, isQuiet = false }: { isReleased: boolean; checkout: string; retry?: { run: string; step: string }; isQuiet?: boolean }): Promise<Stopped> {
  const placement = await readAttemptPlacement(config, run, attempt);

  // One in teamai's process holds no place on a step runtime, and an unreadable record names none.
  if (placement.kind !== 'external' || placement.record.phase === 'closed') return { ended: 'none' };
  const { record } = placement;

  const cannot = async (why: string): Promise<Stopped> => {
    if (isReleased) return { ended: await releaseAttempt(config, run, attempt, why, record) };

    if (!isQuiet) log.warn(`Could not stop attempt ${attempt} of run ${run} on step runtime "${record.runtime}" of driver "${record.driver}": ${why}`);

    return { ended: 'running', why };
  };

  const opened = await openDriver(config, record.driver, { personal: true, mode: resolveRunMode(process.env), canAsk: false, purpose: 'stop', checkout });

  if (!opened.ok) return cannot(opened.failure.message);

  try {
    const entry = opened.opened.runtimes.find((one) => one.kind === 'external' && one.use === record.runtime);

    if (entry?.kind !== 'external') return cannot(`driver "${record.driver}" no longer uses that runtime.`);
    const masked = entry.masks;
    const placed = attemptRun({ config, run, attempt, runtime: entry.runtime, driver: record.driver });

    const notStopped = await placed.stopLeftOperation();

    // Nothing is brought back or closed while what ran may still write the place. A person who released the attempt
    // checked that nothing of it runs, so the runtime is still told to forget the place before teamai lets it go.
    if (notStopped && isReleased) await placed.close(RELEASE);

    if (notStopped) return cannot(`its exec or prompt may still run, since the runtime did not confirm it stopped (${notStopped.code}): ${notStopped.message}`);
    // A place whose work already came back is not brought back again.
    const notCollected = record.phase === 'collected' ? undefined : await placed.collect();

    if (notCollected) log.warn(notCollected.message);
    const notClosed = await placed.close(isReleased ? RELEASE : undefined);

    if (!notClosed) {
      // Nothing of the attempt runs there any more, and the attempt runs again elsewhere, if at all.
      await endLeftLogins(config, run, attempt, { toolHome: record.toolHome, isCollected: notCollected === undefined });
      const then = retry ? ` Then run: ${retryCommand(retry)}` : '';

      if (record.closeFailed) log.info(`Closed the place of attempt ${attempt} of run ${run} on step runtime "${record.runtime}", which an earlier close had kept.${then}`);
      else log.info(`Stopped attempt ${attempt} of run ${run} on step runtime "${record.runtime}" and closed its place.${then}`);

      return { ended: 'closed', masked };
    }

    return isReleased ? { ended: await releaseAttempt(config, run, attempt, notClosed.message, record), masked } : cannot(`${notClosed.message} Once you checked that nothing of it still runs there, run teamai workflow cancel ${run} --release ${attempt}.`);
  } catch (error) {
    return cannot(error instanceof Error ? error.message : String(error));
  } finally {
    await disposeDriver(opened.opened);
  }
}

/**
 * Stops what attempt `attempt` of run `run` left on its step runtime, as `workflow cancel` does for a cancelled attempt,
 * from `checkout`: undefined once nothing of it runs there, else why it may still run.
 */
export async function stopLeftAttempt(config: LocalConfig, run: RunId, attempt: AttemptId, checkout: string): Promise<string | undefined> {
  const stopped = await stopAttempt(config, run, attempt, { isReleased: false, checkout });

  return stopped.ended === 'running' ? stopped.why : undefined;
}

/**
 * Lets attempt `attempt` go though its runtime could not confirm its stop or close (`why`), as the person asked: ends
 * the login it holds, written back when its tool home came back, and records its place as no longer teamai's to close.
 * `before` is its record as the cancel found it open; the release's own close may have closed it since.
 */
async function releaseAttempt(config: LocalConfig, run: RunId, attempt: AttemptId, why: string, before: AttemptRuntimeRecord): Promise<'released'> {
  const now = await readAttemptPlacement(config, run, attempt);
  const record = now.kind === 'external' ? now.record : before;
  await endLeftLogins(config, run, attempt, { toolHome: record.toolHome, isCollected: record.phase === 'collected' });

  if (record.phase !== 'closed') await releaseAttemptRuntime(config, run, attempt, record);
  log.info(`Released attempt ${attempt} of run ${run} on step runtime "${record.runtime}" without its confirmation, as asked. What ran in its place may still be there, since the runtime did not confirm its end: ${why}`);

  return 'released';
}

/**
 * Closes again one place each step runtime closed for each run of `runs`, whose clone or team folder teamai removed
 * outside the drive that ran it, such as at the start of a later drive: the runtime sees the folder gone at a close,
 * the verb it cleans up at (T3 removes a project it added there). A close of a handle already closed answers `closed`.
 * Each definition is opened in `recover` mode, as a cancel opens it; what fails is only logged.
 */
export async function closeAfterSweep(config: LocalConfig, runs: readonly RunId[]): Promise<void> {
  for (const run of runs) {
    const state = await readRun(config, run);
    // The place each runtime of each definition closed last, by definition: the record written last.
    const closed = new Map<string, Map<string, { handle: string; at: number }>>();

    for (const name of await fs.readdir(attemptsDir(config, run)).catch((): string[] => [])) {
      const attempt = AttemptIdSchema.safeParse(name);
      const placement = attempt.success ? await readAttemptPlacement(config, run, attempt.data) : undefined;
      const record = placement?.kind === 'external' ? placement.record : undefined;

      if (!attempt.success || record?.phase !== 'closed' || record.open.handle === undefined) continue;
      const at = (await fs.stat(attemptRuntimePath(config, run, attempt.data))).mtimeMs;
      const byRuntime = closed.get(record.driver) ?? new Map<string, { handle: string; at: number }>();

      if ((byRuntime.get(record.runtime)?.at ?? -1) < at) byRuntime.set(record.runtime, { handle: record.open.handle, at });
      closed.set(record.driver, byRuntime);
    }

    const checkout = (state === 'missing' ? undefined : await existingCheckout(state)) ?? process.cwd();

    for (const [driver, handles] of closed) {
      const opened = await openDriver(config, driver, { personal: true, mode: resolveRunMode(process.env), canAsk: false, purpose: 'stop', checkout });

      if (!opened.ok) {
        log.debug(`Driver "${driver}" did not open to close again the places of run ${run} after teamai removed its clone: ${opened.failure.message}`);
        continue;
      }

      try {
        for (const entry of opened.opened.runtimes) {
          const handle = entry.kind === 'external' ? handles.get(entry.use)?.handle : undefined;
          const again = entry.kind === 'external' && handle !== undefined ? await entry.runtime.close(handle) : undefined;

          if (again && !again.ok) log.debug(`Runtime ${entry.use} did not close ${handle} again after teamai removed a clone of run ${run}: ${again.failure.message}`);
        }
      } finally {
        await disposeDriver(opened.opened);
      }
    }
  }
}
