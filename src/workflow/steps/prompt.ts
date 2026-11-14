/**
 * A prompt step, as a driver runs it once its place is staged: it picks the step's tool on this machine, loads its agent,
 * model and session, holds the login a step runtime brings, launches the tool here or on the step's runtime, and answers
 * the report the engine takes. The local driver runs every prompt step through it, and a fleet member runs the prompt
 * an owner offered through it, on a lease it rebuilt from its own definitions.
 */
import fs from 'node:fs/promises';
import { toolExtrasFor, type AgentSpec } from '../../resources/agent-format.js';
import { observeLaunch, type ToolLaunch, type Used } from '../../agent-observation.js';
import { detectProjectConfig, resolveMemberToolRoots } from '../../config.js';
import { type WorkflowEnv } from '../../env-resolution.js';
import { launchEnv, workflowLaunch, type RunMode } from '../../launch-context.js';
import type { LocalConfig, TeamaiConfig } from '../../types.js';
import { writeJsonAtomic } from '../../utils/fs.js';
import { keptLocksNotice, settleGitLocks, type GitLockPlace } from './git-locks.js';
import { log } from '@teamai/shared/log';
import { AgentSession, type AgentSessionRef } from '../../session-flow/agent-session.js';
import { type SessionArchive } from '../../session-flow/archive.js';
import { deliveredTeamSkills, usedSkills } from '../../skill-use.js';
import { attemptEnv, withoutOuterSessionMarkers } from '../attempt-marker.js';
import { AttemptResult } from '../attempt-result.js';
import { type ReportInput } from '../engine.js';
import { type LeaseWire } from '../lease-wire.js';
import { setsLimit } from '../requirements.js';
import { idleLimit } from '../limits.js';
import { budgeted } from '@teamai/tool-core/stdout';
import type { Unmeasured } from '@teamai/tool-core/step-usage';
import { stepLauncher, type StepLauncher, type StepRun, type StepRunResult } from '@teamai/runtime-tools';
import { expectedOutput } from '../output.js';
import { placeView, runtimeLauncher, runtimePrompter, runtimeSetup, runtimeStepEnv } from './runtime-steps.js';
import { attemptHoldingSession, attemptToolHome, EXEC_RUNTIME_TOOLS, isExecRuntimeTool, recordInProcessSessionHome, seedMemberModel, seedToolHome, toolHomeVariable, type AttemptRun, type HeldPlace } from '../runtimes/attempt.js';
import { endLogin, ensureLogin, holdLogin, loginWaitFile, type LoginTool } from '../runtimes/login.js';
import { credentialsForTool, toolsLaunchDeps, type OpenedRuntime } from '../runtimes/sources.js';
import { withRetry } from '../runtimes/retry-command.js';
import { storeDirOf } from '../../session-flow/adapters/index.js';
import { attemptDir, attemptResultPath, type RunLock } from '../store.js';
import { abandonPlace, cloneDelivery, cloneHead, preparedClone, cloneRoleProblem, roleNotDeliveredFailure, runPlaceSetup, worktreeRoleProblem, type StepEnd } from '../place/place.js';
import { memberTools, type MemberTool } from '../member-tools.js';
import { acceptToolCommand } from '../../tool-instances.js';
import { instanceHomeDir, toolHome as memberToolHome } from '../../tool-home.js';
import { LAUNCH_ORDER, LAUNCH_TOOLS, launchAdapterIdOf, launchTargetOf, toolCommandEnv, type LaunchTarget, type LaunchTool } from '../../launch-registry.js';
import { chooseStepModel, loadDeployedAgent, type StepModel } from '../step-model.js';
import type { DriverIdentity, WorkflowFailure, WorkflowStep } from '../types.js';
import { contractClone, type SessionRef } from '../workspace.js';


/** Puts a prompt step's own question to the person at the terminal: their line, or none once `signal` aborts it. */
export type AskPerson = (question: string, signal: AbortSignal) => Promise<string | undefined>;


/** A lease as a driver runs it: what the engine sent, and what staging it adds. A step staged after `expiresAt` does not start. */
export interface StagedLease extends LeaseWire {
  /** The lease named a workspace this driver cannot read. The step fails instead of running in the active checkout. */
  unreadableWorkspace?: true;
  /** The environment the step's command or tool runs with, built from `envScope` when the lease is staged. */
  processEnv?: NodeJS.ProcessEnv;
  /** Set once the step has a directory to run in. */
  cwd?: string;
}


/**
 * The tool a prompt step runs on: the step's own `tool`, then `--tools`, then `workflows.tools`, the agent's entry before
 * the default (`--tools default=` holds the driver definition's `tool` under the one given), then `runtimeDefault`, the
 * default of the app the runtime that takes the step drives (`can.default_tool`), then the member's own AI tool:
 * TEAMAI_AI_TOOL before `workflows.tools.default`, and `ai.tool`, the project's before the machine's, after it. A
 * member's tool that teamai does not launch fails the step; one that runs no workflow step gives way to the next rung,
 * which `warnings` says.
 */
function stepTool({ agent, tool }: Pick<WorkflowStep, 'agent' | 'tool'>, config: LocalConfig, flags: Record<string, string>, members: MemberTool[], runtimeDefault: string | undefined): { ok: true; tool: string | undefined; warnings: string[] } | { ok: false; failure: WorkflowFailure } {
  const configured = config.workflows?.tools ?? {};
  const member = ({ setting, tool: named }: MemberTool) => ({ source: setting, named, member: true });

  const rungs = [
    { source: 'tool', named: tool, member: false },
    { source: '--tools', named: agent ? flags[agent] : undefined, member: false },
    { source: `workflows.tools.${agent}`, named: agent ? configured[agent] : undefined, member: false },
    { source: '--tools', named: flags.default, member: false },
    { source: 'can.default_tool', named: runtimeDefault, member: false },
    ...members.flatMap((memberTool) => (memberTool.source === 'TEAMAI_AI_TOOL' ? [member(memberTool)] : [])),
    { source: 'workflows.tools.default', named: configured.default, member: false },
    ...members.flatMap((memberTool) => (memberTool.source !== 'TEAMAI_AI_TOOL' ? [member(memberTool)] : [])),
  ];

  const passed: { source: string; named: string }[] = [];

  for (const { source, named, member: isMember } of rungs) {
    if (!named) continue;

    if (isMember && !launchTargetOf(named)) {
      if (!LAUNCH_ORDER.some((launched) => launched === named)) {
        return { ok: false, failure: { code: 'tool_unsupported', message: `${source} is "${named}", which is not a tool teamai launches. Set it to one of: ${LAUNCH_TOOLS.join(', ')}.` } };
      }

      passed.push({ source, named });
      continue;
    }

    return { ok: true, tool: named, warnings: passed.map((skipped) => `${skipped.source} is "${skipped.named}", which cannot run a workflow step. Using ${source} (${named}) instead.`) };
  }

  return { ok: true, tool: undefined, warnings: passed.map((skipped) => `${skipped.source} is "${skipped.named}", which cannot run a workflow step.`) };
}

/** The tool a prompt step launches here, with the warnings its pick logs, or why it launches none. */
export type LaunchChoice = { ok: true; tool: LaunchTool; target: LaunchTarget; warnings: string[] } | { ok: false; failure: WorkflowFailure; tool?: string; warnings: string[] };

/**
 * The tool teamai launches for prompt step `step` here, as {@link stepTool} picks it with `--tools` `flags`, or why
 * none: no tool is configured, or the one picked is not one teamai launches, which `tool` then names. `warnings` says
 * which of the member's tools gave way, for the step that launches to log.
 */
export function launchToolFor(step: Pick<WorkflowStep, 'agent' | 'tool'>, config: LocalConfig, flags: Record<string, string>, members: MemberTool[], runtimeDefault?: string): LaunchChoice {
  const choice = stepTool(step, config, flags, members, runtimeDefault);

  if (!choice.ok) return { ...choice, warnings: [] };
  const { tool: selected, warnings } = choice;

  if (!selected) return { ok: false, failure: { code: 'tool_unconfigured', message: 'This prompt step names no tool, and none is set for it. Name one with the step\'s tool:, with --tools default=<tool>, or with ai.tool in your teamai config' }, warnings };

  const target = launchTargetOf(selected);

  if (!target) return { ok: false, failure: { code: 'tool_unsupported', message: `The local workflow tool "${selected}" is not supported` }, tool: selected, warnings };

  return { ok: true, tool: target.tool, target, warnings };
}

function ignoredCodexSettings(agent: AgentSpec): string[] {
  const extras = Object.keys(agent.tool_extras?.codex ?? {});

  return agent.tools?.length ? ['tools', ...extras] : extras;
}

function definitionRun(tool: LaunchTool, name: string, agent: AgentSpec): NonNullable<StepRun['agent']> {
  const settings = launchAdapterIdOf(tool) === 'opencode' ? toolExtrasFor(agent, 'opencode') : undefined;

  const run: NonNullable<StepRun['agent']> = { name, instructions: agent.instructions };

  if (agent.model) run.model = agent.model;

  if (settings) run.settings = settings;

  return run;
}

/** The model a launch passes on argv, and its effort. */
type LaunchModel = { model: string; effort?: string };

/** The fields of a report that say the attempt failed, and why. */
type FailedReport = { outcome: 'failed'; message: string; failure: WorkflowFailure };

export function failureReport(failure: WorkflowFailure): FailedReport {
  return { outcome: 'failed', message: failure.message, failure };
}



/**
 * The session the step's tool resumes, and the lease session it continues: the lease's session, else each earlier one it
 * continued, newest first. Each is tried on this machine, then as a copy in this tool, then as a copy of the one the team
 * session archive holds. OpenCode has no flag to resume one, so its step starts a new session. `held` answers whether
 * an earlier attempt of the run keeps the session where the step's runtime resumes it by id, such as the home a
 * runtime that launches agents its own way reported it in.
 */
async function resumeSession(archive: SessionArchive, lease: StagedLease, target: LaunchTarget, cwd: string, held?: (session: SessionRef) => Promise<boolean>): Promise<{ id: string; resumed: SessionRef } | undefined> {
  const to = AgentSession.platformForTool(target.name);

  if (!lease.session || !to) return undefined;
  const resumes = launchAdapterIdOf(target.tool) !== 'opencode';
  const misses: string[] = [];

  for (const session of [lease.session, ...(lease.session.earlier ?? [])]) {
    const from = AgentSession.platformForTool(session.tool);

    if (!from) continue;
    const resumed = { tool: session.tool, id: session.id };

    // One platform is one store: a tool that shares the format but keeps its own home, as an instance does, gets a copy.
    if (from === to && resumes) {
      if (await held?.(resumed)) return { id: session.id, resumed };
      const found = await AgentSession.find({ platform: from, sessionId: session.id }, { scrub: false });

      if (found.status === 'done') return { id: session.id, resumed };
      misses.push(found.failure.message);
    } else {
      const copied = await AgentSession.copy({ from: { platform: from, sessionId: session.id }, to: { platform: to, cwd } });

      if (copied.status === 'done') return resumes ? { id: copied.sessionId, resumed } : undefined;
      misses.push(copied.failure.message);
    }

    const restored = await archive.restore({ platform: from, sessionId: session.id }, { platform: to, cwd });

    if (restored.status !== 'fresh') return resumes ? { id: restored.sessionId, resumed } : undefined;
    misses.push(restored.reason);
  }

  if (misses.length > 0) log.warn(`Step "${lease.step}" starts a new ${target.name} session: ${misses.join(' ')}`);

  return undefined;
}


/**
 * The team skills the pass's session and its subagents loaded since `launchedAt`, credited by `teamSkills`, what its
 * checkout held as delivered at launch. A load before it, by a pass whose session this one resumes, is that pass's.
 * Undefined when the session cannot be read.
 */
async function usedInSession(tool: string, sessionId: string, cwd: string, teamSkills: Record<string, string[]>, launchedAt: number, storeDir?: string): Promise<Used | undefined> {
  const platform = AgentSession.platformForTool(tool);

  if (!platform) return undefined;
  const ref: AgentSessionRef = { platform, sessionId, cwd };

  if (storeDir !== undefined) ref.storeDir = storeDir;
  const found = await AgentSession.find(ref, { subagents: true }).catch(() => undefined);
  const atOrAfterLaunch = (timestamp: string | undefined): boolean => timestamp === undefined || !(Date.parse(timestamp) < launchedAt);

  return found?.status === 'done'
    ? { skills: usedSkills(AgentSession.toolForPlatform(platform), found, (timestamp) => atOrAfterLaunch(timestamp) ? teamSkills : {}) }
    : undefined;
}

/**
 * The home at `dir` the tool of a prompt through another runtime keeps its session in, in the outer's place: made, and
 * started on the member's model choices from `memberHome`, as an exec runtime's is. None for a tool no step runtime
 * execs, or with no `variable` to read a home from.
 */
async function outerToolHome({ dir, tool, variable, memberHome }: { dir: string; tool: string; variable: string | undefined; memberHome: () => string }): Promise<string | undefined> {
  if (variable === undefined || !isExecRuntimeTool(tool)) return undefined;
  await fs.mkdir(dir, { recursive: true });
  await seedMemberModel({ tool, dir, memberHome: memberHome() });

  return dir;
}


/** A prompt step's step runtime, as the driver that runs it opened it: none runs the step's tool on this machine. */
export type PromptRuntime = {
  run: AttemptRun; logins: readonly LoginTool[]; launchesAgents: boolean; credentials: Record<string, string>; found: readonly string[]; defaultTool?: string; teamEnv: WorkflowEnv;
  isThrough?: true;
  /** It runs a prompt's tool in the attempt's tool home (`Initialized.runsOnToolHome`), as a runtime that execs the tool does. */
  runsOnToolHome?: true;
  /** The runtime picks the tool, model and login where it runs the step (`StepRuntime.isToolPickedThere`). */
  isToolPickedThere?: true;
  /**
   * The conversation an earlier attempt launched on this runtime, held open for a later step, for the first of
   * `sessions` it holds (`HeldPlace.conversationOf`). Absent on a runtime where none is held, such as one through another.
   */
  conversationHeld?: (sessions: readonly SessionRef[]) => ReturnType<typeof HeldPlace.conversationOf>;
};

/** What a prompt step's runtime offered when its driver opened it: its `PromptRuntime` but for the attempt's run, team env and held conversation. */
export type PromptOffer = Omit<PromptRuntime, 'run' | 'teamEnv' | 'conversationHeld'>;

/** A step runtime as its driver opened it, as far as a prompt there reads it: the local driver's slot or a fleet member's entry. */
type OpenedForPrompt = Pick<Extract<OpenedRuntime, { kind: 'external' }>, 'runtime' | 'can' | 'launchesAgents' | 'engine' | 'credentials' | 'isThrough' | 'runsOnToolHome'> & { found: readonly string[] };

/**
 * What `opened` offers a prompt step. The one place that reads each offered fact: every key of `PromptOffer` is named
 * here, so a new one fails the type check until it is read, rather than being dropped by one of the drivers.
 */
export function promptOfferOf(opened: OpenedForPrompt): PromptOffer {
  return {
    logins: opened.engine.logins, launchesAgents: opened.launchesAgents, credentials: opened.credentials, found: opened.found, defaultTool: opened.can.default_tool,
    isThrough: opened.isThrough, runsOnToolHome: opened.runsOnToolHome, isToolPickedThere: opened.runtime.isToolPickedThere === true ? true : undefined,
  } satisfies { [Key in keyof Required<PromptOffer>]: PromptOffer[Key] };
}

/** The step runtime a prompt runs on: what its runtime offered, with the attempt's run on it and the team env. */
export function promptRuntimeOn({ run, offered, teamEnv, conversationHeld }: { run: AttemptRun; offered: PromptOffer; teamEnv: WorkflowEnv; conversationHeld?: PromptRuntime['conversationHeld'] }): PromptRuntime {
  return { ...offered, run, teamEnv, ...(conversationHeld && { conversationHeld }) };
}

/**
 * Runs prompt step `lease`, staged in its place, and answers the report a driver sends the engine for it: the tool it
 * picks here (`staged`, else the step's own, `tools`, then the member's), on this machine through `adapter`, the
 * `tools` runtime's launcher, or on the step runtime `onRuntime`. A failure before the launch gives the place up and reports the step failed. `secrets` are
 * the values its output is masked of; `askPerson` asks the person at the terminal, when one answers.
 */
export async function runPromptStep({ config, lock, driver, lease, adapter = stepLauncher(toolsLaunchDeps()), tools = {}, toolPaths, archive, signal, mode, staged, secrets, askPerson, onRuntime }: {
  config: LocalConfig;
  lock: RunLock;
  driver: DriverIdentity;
  lease: StagedLease;
  adapter?: StepLauncher;
  /** The `--tools` flags, by agent and `default`. */
  tools?: Record<string, string>;
  toolPaths?: TeamaiConfig['toolPaths'];
  archive: SessionArchive;
  signal: AbortSignal;
  mode: RunMode;
  staged?: LaunchChoice;
  secrets: Record<string, string>;
  askPerson?: AskPerson;
  onRuntime?: PromptRuntime;
}): Promise<ReportInput> {
  const giveUp = async (failure: WorkflowFailure, tool?: string): Promise<ReportInput> => {
    const unrestored = await abandonPlace({ config, lock, attempt: lease.attempt });
    const reported = unrestored ? { ...failure, message: `${failure.message.replace(/\.?$/, '.')} ${unrestored}` } : failure;

    const body: ReportInput = { attempt: lease.attempt, revision: lease.revision, driver, ...failureReport(reported) };

    if (tool) body.tool = tool;

    return body;
  };

  if (onRuntime?.isToolPickedThere) return promptPickedThere({ config, lock, driver, lease, onRuntime, signal, mode, secrets });

  // A role lease's place was staged for its launch tool, which launches it; others pick theirs now.
  const choice = staged ?? launchToolFor({ agent: lease.agent, tool: lease.tool }, config, tools, await memberTools(config), onRuntime?.defaultTool);

  for (const warning of choice.warnings) log.warn(warning);

  if (!choice.ok) return giveUp(choice.failure, choice.tool);
  const selected = choice.tool;
  // The name the step runs its tool by, an instance's own: its report, delivery and sessions are credited to it.
  const { target } = choice;
  const launched = target.name;
  const idle = idleLimit(config);

  if ('failure' in idle) return giveUp(idle.failure, launched);

  // A team instance's own command runs only once a person accepted it here.
  if (target.instance) {
    const accepted = await acceptToolCommand(target.instance, { ask: askPerson && ((question) => askPerson(question, signal)) });

    if (!accepted.ok) return giveUp({ code: accepted.code, message: accepted.message }, launched);
  }

  // A worktree has its own pull record, so the tool launched there is observed and bound as that checkout. A clone has
  // its own install, never the member's config, and none when its place installs no team.
  const contract = lease.workspace;
  const clone = contractClone(contract) ? contract?.branch : undefined;
  const prepared = clone !== undefined ? await preparedClone(config, lock.run, clone) : undefined;

  // The copy was checked as it was prepared; it is checked again right before launch, as something may have pulled since.
  if (lease.role !== undefined) {
    const { role, step } = lease;

    const refused = clone !== undefined
      ? prepared?.install
        ? await cloneRoleProblem({ install: prepared.install, step, role, tools: [launched] })
        : roleNotDeliveredFailure({ role, step, notDelivered: { copy: 'clone', gap: { kind: 'no_install' } } })
      : lease.cwd !== undefined
        ? await worktreeRoleProblem({ dir: lease.cwd, step, role, tools: [launched] })
        : roleNotDeliveredFailure({ role, step, notDelivered: { copy: 'none' } });

    if (refused !== undefined) return giveUp(refused, launched);
  }

  const teamConfig = clone !== undefined
    ? prepared?.install
    : contract && lease.cwd ? await detectProjectConfig(lease.cwd) ?? config : config;

  const stepConfig = teamConfig ?? config;
  const loaded = lease.agent && teamConfig ? await loadDeployedAgent({ tool: launched, name: lease.agent, config: teamConfig, toolPaths }) : undefined;
  const agent = loaded?.spec;

  if (lease.agent && !agent) {
    return giveUp({
      code: 'agent_unavailable',
      message: `Agent "${lease.agent}" is not available for ${launched}. Run teamai pull and try again.`,
    }, launched);
  }

  const chosen = await chooseStepModel({
    step: lease.step, tool: launched, model: lease.model, defaultModel: lease.defaultModel, agent: agent ?? undefined, config: stepConfig,
    passesAgentFile: !onRuntime?.launchesAgents,
  });

  if (!chosen.ok) return giveUp(chosen.failure, launched);

  if (agent && launchAdapterIdOf(selected) === 'codex') {
    const ignored = ignoredCodexSettings(agent);

    if (ignored.length > 0) {
      log.warn(`Agent "${agent.name}" on ${selected} does not apply ${ignored.join(', ')} from the deployed agent file. codex exec still has a shell. The step is not blocked.`);
    }
  }

  const cwd = lease.cwd ?? driver.workspace;
  const resultFile = attemptResultPath(config, lock.run, lease.attempt);
  // On a step runtime that execs the tool, or one that launches agents and runs them on the attempt's tool home, the
  // tool keeps its session in a home of the attempt's, under the variable it reads: an instance's own `home.env`, else
  // the one of the tool it extends. Any other runtime that launches agents its own way gives the tool its own home,
  // where the member's sessions are found.
  const execs = onRuntime && !onRuntime.launchesAgents ? onRuntime : undefined;
  const homed = onRuntime && (!onRuntime.launchesAgents || onRuntime.runsOnToolHome === true) ? onRuntime : undefined;
  const homeVariable = target.instance?.home?.env ?? toolHomeVariable(selected);
  const variable = homed ? homeVariable : undefined;
  const memberHome = () => (target.instance?.home ? instanceHomeDir({ name: target.instance.name, home: target.instance.home }) : memberToolHome(selected));

  if (homed && (variable === undefined || !isExecRuntimeTool(selected))) {
    return giveUp({
      code: 'tool_unsupported',
      message: `A step runtime runs prompt steps on ${EXEC_RUNTIME_TOOLS.join(', ')}, and step "${lease.step}" runs on ${selected}. Name one of them with the step's tool or --tools, or run the step with --driver local.`,
    }, selected);
  }

  if (execs && lease.interactive) {
    return giveUp({ code: 'tool_unsupported', message: `Step "${lease.step}" is interactive, and a step runtime runs only headless prompts. Run the step with --driver local.` }, selected);
  }

  // An instance reaches a runtime that execs its tool only when the runtime lists it, so its command is there. Its
  // home, and the sessions there, are its own.
  const toolHome = homed && variable !== undefined ? { tool: selected, dir: attemptToolHome(config, lock.run, lease.attempt, launched) } : undefined;
  let resume: { id: string; resumed: SessionRef } | undefined;

  // A runtime that launches agents continues, as a new turn, the conversation an earlier attempt launched on it, in the
  // place teamai held open for it, when that conversation ran on the tool this step launches.
  const conversation = lease.session && onRuntime?.conversationHeld
    ? await onRuntime.conversationHeld([lease.session, ...lease.session.earlier ?? []].filter((session) => session.tool === launched))
    : undefined;

  if (toolHome) {
    await fs.mkdir(toolHome.dir, { recursive: true });
    const seeded = lease.session ? await seedToolHome({ config, run: lock.run, attempt: lease.attempt, tool: launched, sessions: [lease.session, ...lease.session.earlier ?? []] }) : undefined;

    // The tool starts on the member's own model choices, from their home of it, or of the instance.
    if (isExecRuntimeTool(selected)) await seedMemberModel({ tool: selected, dir: toolHome.dir, memberHome: memberHome() });

    if (seeded) resume = { id: seeded.id, resumed: { tool: seeded.tool, id: seeded.id } };
  } else if (conversation) {
    resume = { id: conversation.session.id, resumed: conversation.session };
  } else {
    // A runtime that launches agents resumes a session by id in the home it reported it in.
    const held = onRuntime?.launchesAgents ? async (session: SessionRef) => (await attemptHoldingSession(config, lock.run, session)) !== undefined : undefined;
    resume = await resumeSession(archive, lease, target, cwd, held);
  }

  // A login the runtime brings is held by this attempt alone, on the whole machine, from before the place opens until
  // it is written back: another attempt waits for it here, naming the attempt that holds it.
  // An instance keeps its own sign-in in its own home, so a login of the tool it extends is not copied there.
  const login = toolHome ? homed?.logins.find((tool) => tool === launched) : undefined;

  if (login && toolHome) {
    // The first attended step that needs the login creates it for the member; an unattended one says how.
    const missing = await ensureLogin(login, { step: { run: lock.run, id: lease.step }, canAsk: mode === 'attended' && process.stdin.isTTY && process.stderr.isTTY });

    if (missing) return giveUp(missing, selected);
    const waitFile = loginWaitFile(attemptDir(config, lock.run, lease.attempt));

    const held = await holdLogin({
      tool: login, run: lock.run, attempt: lease.attempt, toolHome: toolHome.dir, signal,
      onWait: async (wait) => {
        if (!wait) return fs.rm(waitFile, { force: true });
        log.info(`Step "${lease.step}" waits for the ${wait.tool} login teamai keeps, which attempt ${wait.holder.attempt} of run ${wait.holder.run} holds. It goes on once that attempt ends; teamai workflow cancel ${wait.holder.run} releases it.`);
        await writeJsonAtomic(waitFile, wait);
      },
    });

    await fs.rm(waitFile, { force: true });

    if (!held.ok) return giveUp(held.failure, selected);
  }

  const launchModel = (model: StepModel): LaunchModel => {
    const named: LaunchModel = { model: model.name };

    if (model.effort) named.effort = model.effort;

    return named;
  };

  const definitionModel = chosen.model && chosen.by === 'definition' ? launchModel(chosen.model) : {};

  const { teamDelivery } = await import('../../pull.js');

  const delivery = prepared?.install
    ? await cloneDelivery({ install: prepared.install, without: prepared.without }, launched)
    : teamConfig ? await teamDelivery(teamConfig, launched).catch(() => undefined) : undefined;

  const observing: ToolLaunch = { config: stepConfig, tool: launched, cwd, delivery: delivery ?? null };

  // In a clone, git reads its head without the names the place withholds, which setup could have handed a hook.
  if (clone !== undefined) observing.head = await cloneHead(config, lock.run, clone, { withhold: lease.envScope?.withhold ?? [], expiresAt: lease.expiresAt });

  if (lease.agent && loaded) observing.definition = { stem: lease.agent, file: loaded.file, ...definitionModel };

  if (chosen.model && chosen.by !== 'definition') observing.chosen = { ...launchModel(chosen.model), alias: chosen.alias || undefined };

  const [observed, launch, teamSkills] = await Promise.all([
    observeLaunch(observing),
    teamConfig ? workflowLaunch(teamConfig, launched) : undefined,
    delivery?.record?.delivered ? deliveredTeamSkills(stepConfig, cwd, delivery.record.delivered, delivery.record.rev).then((found) => found.teamSkills, () => undefined) : undefined,
  ]);

  // Only headless Claude and CodeBuddy have a turn limit, and a runtime that launches agents its own way keeps the cap it
  // offered; any other launch reports the cap as not enforced. One that runs the tool on the attempt's tool home launches
  // it as teamai does, so only those tools' caps hold there.
  const family = launchAdapterIdOf(selected);
  const launchesOwnWay = onRuntime?.launchesAgents === true && onRuntime.runsOnToolHome !== true;
  const capsTurns = lease.maxTurns !== undefined && !lease.interactive && (launchesOwnWay || family === 'claude' || family === 'codebuddy');
  // A turn is ended only at the limits its tool is known to keep and report: Codex states its usage only as it ends, and
  // CodeBuddy's turn cap and per-message usage are untried, so the rest list as unenforced.
  const { limits } = lease;
  const endsAtTurns = limits?.maxTurns !== undefined && !lease.interactive && family === 'claude' ? limits.maxTurns : undefined;
  // A runtime that launches agents its own way states usage only once the prompt ends, so the budget is checked then. One
  // that runs the tool on the attempt's tool home launches it as teamai does, so it holds Claude and OpenCode to it.
  const budget = limits?.budget !== undefined && !launchesOwnWay && (family === 'claude' || family === 'opencode') ? limits.budget.tokens : undefined;
  const launchedAt = Date.now();

  if (lease.interactive && !onRuntime) log.info(`Step "${lease.step}" opens ${launched} here for interactive work.`);

  const inherited = lease.processEnv ?? process.env;
  const toolRoots = stepConfig.toolRoots ?? await resolveMemberToolRoots(cwd);
  const delivered = toolCommandEnv(target.name, { kind: 'delivered', inherited, toolRoots });

  const input: StepRun = {
    prompt: lease.prompt!,
    cwd,
    resultPath: resultFile,
    secrets,
    expected: expectedOutput(lease.output),
    // The lease `env` is set over the step's environment, as a command's is.
    env: { ...withoutOuterSessionMarkers(inherited), ...(delivered.kind === 'ready' && delivered.env), ...lease.env, ...attemptEnv(config, lock.run, lease.attempt, mode) },
  };

  let launcher = adapter;

  // Setup runs on the step's runtime once the place is open there, before the tool.
  const setUp = async (): Promise<WorkflowFailure | undefined> => (onRuntime ? runPlaceSetup({ config, run: lock.run, attempt: lease.attempt, mode, env: onRuntime.teamEnv, signal, on: runtimeSetup(onRuntime.run) }) : undefined);

  // On a step runtime the tool gets only the names its lease provides, over the runtime's own, and its home.
  if (onRuntime?.launchesAgents) {
    const scoped = runtimeStepEnv(lease, lease.processEnv ?? {}, { config, run: lock.run, mode });
    input.env = scoped.env;
    // Through another runtime, the app's tool runs in the outer's place, on a home of the attempt's, as an exec runtime's does.
    const throughHome = onRuntime.isThrough !== true ? undefined : await outerToolHome({ dir: attemptToolHome(config, lock.run, lease.attempt, launched), tool: selected, variable: homeVariable, memberHome });
    const isThroughOuter = onRuntime.isThrough === true;
    const viewHome = throughHome ?? toolHome?.dir;
    launcher = runtimePrompter(onRuntime.run, {
      view: await placeView(config, lock.run, lease, cwd, viewHome === undefined ? undefined : toolCommandEnv(launched, { kind: 'at', dir: viewHome })), runId: lock.run, step: lease.step, provided: scoped.provided, unset: scoped.unset,
      credentials: credentialsForTool(onRuntime.credentials, onRuntime.found, launched), setUp, tool: launched, isThroughOuter, ...(conversation && { continues: { handle: conversation.handle, op: conversation.op } }),
      ...(toolHome && { toolHome: { tool: toolHome.tool, dir: toolHome.dir } }),
    });
  } else if (onRuntime && toolHome) {
    const scoped = runtimeStepEnv(lease, lease.processEnv ?? {}, { config, run: lock.run, mode });
    const homeEnv = toolCommandEnv(launched, { kind: 'at', dir: toolHome.dir });
    input.env = { ...scoped.env, ...homeEnv };
    const view = await placeView(config, lock.run, lease, cwd, homeEnv);
    const start = runtimeLauncher(onRuntime.run, { view, tool: launched, toolHome: { tool: toolHome.tool, dir: toolHome.dir }, unset: scoped.unset, credentials: credentialsForTool(onRuntime.credentials, onRuntime.found, toolHome.tool), setUp });
    // The runtime finds the command where it runs it, and a resumed step attaches there to the tool it left running.
    launcher = stepLauncher(toolsLaunchDeps(), { start, canReattach: true, resolveTool: (command) => command, resolveInstanceCommand: (command) => command });
  } else if (delivered.kind === 'home_gone') {
    // Started here, the tool reads the delivered home; delivery skips a tool whose recorded home is gone, and so does its step.
    return giveUp({ code: 'tool_unavailable', message: delivered.message }, launched);
  }

  if (launch) input.launchEnv = launchEnv(launch);

  if (resume) input.resume = resume.id;

  if (agent) input.agent = definitionRun(selected, lease.agent!, agent);

  if (chosen.model) input.model = chosen.model;

  if (capsTurns) input.maxTurns = lease.maxTurns;
  else if (endsAtTurns !== undefined) input.maxTurns = endsAtTurns;

  if (budget !== undefined) input.budget = budget;
  // A runtime that launches agents its own way is asked to stop the tool at the budget (`limits`); the budget is checked
  // once its prompt ends all the same.
  else if (onRuntime?.launchesAgents && limits?.budget !== undefined) input.budget = limits.budget.tokens;

  if (limits?.timeoutMs !== undefined) input.timeoutMs = limits.timeoutMs;

  if (idle.ms !== undefined) input.idleTimeoutMs = idle.ms;

  if (lease.permissions === 'unattended') input.unattended = true;

  if (target.instance) input.instance = { name: launched, ...(target.instance.command && { command: target.instance.command }) };

  // In teamai's process the tool keeps its session in the home the step's environment names, such as a CODEX_HOME
  // outside HOME, which teamai does not record as the tool's root: the attempt's record says where, for scoring. An
  // instance's own home is where teamai looks already, and the variable of the tool it extends never moves it.
  const ranHome = !onRuntime && !target.instance?.home && homeVariable !== undefined ? input.env?.[homeVariable] : undefined;

  if (ranHome) await recordInProcessSessionHome(config, lock.run, lease.attempt, { tool: selected, dir: ranHome });
  const sessionHome = toolHome?.dir ?? ranHome;
  const storeDir = sessionHome ? storeDirOf(AgentSession.platformForTool(launched) ?? '', { kind: 'tool-home', dir: sessionHome }) : undefined;

  const { result, durationMs } = await timedLaunch({
    launch: lease.interactive ? launcher.runInteractive.bind(launcher) : launcher.run.bind(launcher),
    tool: selected,
    input,
    signal,
    unfinished: `${launched} could not complete the workflow step`,
    lockPlace: lease.cwd === undefined || !contract ? 'member' : contractClone(contract) || contract.mode === 'team' ? 'clone' : 'worktree',
  });

  const end: StepEnd = { outcome: result.exitCode === 0 && !result.failure ? 'success' : 'failed' };

  if (end.outcome === 'failed' && result.failure) {
    // A runtime that launches agents its own way ended its prompt's failure with the retry already (runtimePrompter).
    const failure = onRuntime?.launchesAgents ? result.failure : { ...result.failure, message: withRetry(result.failure, { run: lock.run, step: lease.step }) };
    end.message = failure.message;
    end.failure = failure;
  }

  // A runtime lost while the tool ran may still run it, refreshing the login: the attempt keeps it, and closing its
  // place says how to free it.
  if (login && toolHome && result.failure?.code !== 'runtime_lost') {
    // A runtime that failed may not have brought the tool home back, so what is there says nothing of the login.
    const collected = !(result.failure?.code.startsWith('runtime_') === true && result.failure.code !== 'runtime_interrupted');
    const { notBack } = await endLogin(login, { run: lock.run, attempt: lease.attempt, toolHome: toolHome.dir, isCollected: collected });

    if (notBack && end.outcome === 'success') {
      end.outcome = 'failed';
      end.message = notBack.message;
      end.failure = notBack;
    } else if (notBack) {
      log.warn(notBack.message);
    }
  }

  const ran = result.started ? result : undefined;
  const used = ran?.session && teamSkills ? await usedInSession(launched, ran.session, cwd, teamSkills, launchedAt, storeDir || undefined) : undefined;
  // A tool held to no budget that stated it spent more still ended its turn there: the budget names it.
  const passedBudget = limits?.budget !== undefined && budget === undefined && budgeted(ran?.tokens) > limits.budget.tokens;
  const stoppedBy = ran?.stoppedBy ?? (passedBudget ? 'budget' : undefined);
  const limit = limits && stoppedBy && setsLimit(limits, stoppedBy) ? stoppedBy : undefined;

  const unenforced = [
    ...((lease.maxTurns !== undefined && !capsTurns) || (limits?.maxTurns !== undefined && endsAtTurns === undefined) ? ['max_turns' as const] : []),
    ...(limits?.budget !== undefined && budget === undefined ? ['budget' as const] : []),
  ];

  const body: ReportInput = { attempt: lease.attempt, revision: lease.revision, driver, tool: launched, outcome: end.outcome };

  if (ran?.model) body.model = ran.model;

  if (ran?.session) body.session = ran.session;

  // A runtime that launches agents its own way says whether it continued the session; one that says nothing did not.
  if (ran && resume && !ran.startedFresh) body.resumed = resume.resumed;

  if (ran) body.durationMs = durationMs;

  if (ran?.tokens) body.tokens = ran.tokens;
  else if (ran?.unmeasured) body.unmeasured = warnUnmeasured(lease.step, ran.unmeasured);

  if (ran?.cost) body.cost = ran.cost;

  if (ran?.output !== undefined) body.outputs = ran.output;

  // How the definition was handed over is known only once the launch resolved its tool: OpenCode's depends on its major.
  if (ran) body.agent = ran.applied ? { ...observed, definition: { applied: ran.applied } } : observed;

  if (used) body.used = used;

  if (unenforced.length > 0) body.unenforced = unenforced;
  body.exitCode = result.exitCode;

  if (limit) {
    body.outcome = 'success';
    body.limit = limit;
  } else if (end.failure) {
    Object.assign(body, failureReport(end.failure));
  } else if (end.message) {
    body.message = end.message;
  }

  return body;
}


/**
 * Why the runtime of `step`, which offers tokens, read none for it, said to the person as the step ends: the cause only,
 * since a step under no budget succeeded all the same, and a budget that cannot count it fails it with the next step.
 */
function warnUnmeasured(step: string, why: Unmeasured): Unmeasured {
  log.warn(`teamai did not measure the tokens of step "${step}": ${why.cause}`);

  return why;
}

/**
 * Prompt step `lease` on a runtime that picks its tool, model and login where it runs the step, and renders its prompt
 * there (`isToolPickedThere`), as a fleet member does: teamai picks none of them here. It sets the place up, sends the
 * step, and reports the tool the runtime ran it on, the result its agent wrote and its usage. The session stays where
 * the runtime ran it, so none is reported.
 */
async function promptPickedThere({ config, lock, driver, lease, onRuntime, signal, mode, secrets }: {
  config: LocalConfig; lock: RunLock; driver: DriverIdentity; lease: StagedLease; onRuntime: PromptRuntime; signal: AbortSignal; mode: RunMode; secrets: Record<string, string>;
}): Promise<ReportInput> {
  const { run } = onRuntime;
  const failed = (failure: WorkflowFailure, tool?: string): ReportInput => ({ attempt: lease.attempt, revision: lease.revision, driver, ...(tool !== undefined && { tool }), ...failureReport(failure) });
  const cwd = lease.cwd ?? driver.workspace;
  const result = attemptResultPath(config, lock.run, lease.attempt);
  const opened = await run.open(await placeView(config, lock.run, lease, cwd));

  if (!opened.ok) return failed(opened.failure);
  const unready = await runPlaceSetup({ config, run: lock.run, attempt: lease.attempt, mode, env: onRuntime.teamEnv, signal, on: runtimeSetup(run) });

  if (unready) return failed(unready);
  const scoped = runtimeStepEnv(lease, lease.processEnv ?? {}, { config, run: lock.run, mode });

  const stop = (): void => {
    void run.cancel();
  };

  signal.addEventListener('abort', stop, { once: true });

  if (signal.aborted) stop();

  // The step's own tool, else the default of whoever runs it: the runtime renders the prompt and picks from its own copy of the step.
  const end = await run.prompt({
    lease: { step: lease.step, tool: lease.tool ?? 'default', prompt: lease.prompt ?? '', result, permissions: lease.permissions === 'unattended' ? 'unattended' : 'approval-required', interactive: false },
    env: scoped.env, provided: scoped.provided, unset: scoped.unset, credentials: {}, cwd,
  }, {});

  signal.removeEventListener('abort', stop);
  const uncollected = await run.collect();

  switch (end.kind) {
    case 'finished': {
      await AttemptResult.write(result, end.result, secrets);
      const tool = end.session.tool;
      const body: ReportInput = { attempt: lease.attempt, revision: lease.revision, driver, tool, session: end.session.id, outcome: 'success', exitCode: 0 };

      if ('output' in end.result) body.outputs = end.result.output;

      if (end.usage) body.tokens = end.usage;
      else if (end.unmeasured) body.unmeasured = warnUnmeasured(lease.step, end.unmeasured);
      const failure = uncollected ?? end.result.failure;

      return failure ? { ...body, ...failureReport(failure) } : body;
    }

    case 'cancelled':
      return failed({ code: 'tool_failed', message: `Step "${lease.step}" was stopped before its runtime finished it.` });
    case 'failed':
    case 'lost':
      return failed(end.failure);
    default: {
      const unhandled: never = end;

      return unhandled;
    }
  }
}


/**
 * Runs a prompt's tool, timed around the tool's run alone. A launch that throws fails `tool_failed` with `unfinished`.
 * The adapter returns once the tool's process group is gone, so when a limit or the engine stopped it, no lock git left
 * where it ran is held any more: they are settled for `lockPlace`, and the ones kept are named with how to remove them.
 */
async function timedLaunch({ launch, tool, input, signal, unfinished, lockPlace }: {
  launch: StepLauncher['run'];
  tool: LaunchTool;
  input: StepRun;
  signal: AbortSignal;
  unfinished: string;
  lockPlace: GitLockPlace;
}): Promise<{ result: StepRunResult; durationMs: number }> {
  const started = performance.now();
  let result: StepRunResult;

  try {
    result = await launch(tool, input, signal);
  } catch {
    result = { started: false, exitCode: 1, failure: { code: 'tool_failed', message: unfinished } };
  }

  const durationMs = Math.round(performance.now() - started);
  const isStopped = result.started && result.stopUnconfirmed !== true && (result.stoppedBy === 'timeout' || result.stoppedBy === 'budget' || signal.aborted);
  const kept = isStopped ? await settleGitLocks({ cwd: input.cwd, place: lockPlace }) : [];

  if (kept.length > 0) {
    const notice = keptLocksNotice(kept, tool);
    // The engine closed a step it stopped, so its record takes no failure from here: the warning is where it shows.
    log.warn(notice);

    if (result.failure) result = { ...result, failure: { ...result.failure, message: `${result.failure.message}. ${notice}` } };
  }

  return { result, durationMs };
}
