import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  CANCEL_FAILED, PromptResultSchema, PromptSessionSchema, type PromptUsageSchema, RUN_DIR_ENV, WORKFLOW_DIR_ENV, type OpId, type OpState, type PromptResult, type RuntimeDisplay,
  type RuntimeFailure, type RuntimeRequest,
} from '@teamai/runtime-protocol';
import type { OpEnd } from '@teamai/runtime-kit/ledger';
import { registerThrough, type Registration } from '@teamai/runtime-kit/outer';
import { cannotReadBecause, FsFailureSchema, isMissing } from '@teamai/shared/fs-failure';
import { NotRegularFileError, readRegularFileSync } from '@teamai/shared/regular-file';
import { UNTIMED_TURN, type Unmeasured } from '@teamai/tool-core/step-usage';
import { isUsageLimitText } from '@teamai/tool-core/usage-limit';
import { JsonValueSchema } from '@teamai/shared/json';
import { extractReply } from '@teamai/tool-core/reply';
import type { z } from 'zod';
import { isOnThisMachine } from './daemon/address.js';
import type { Creation, Daemon, Model, Target, WaitEnd } from './daemon/connect.js';
import { resolvedDir, type AgentCreate, type AgentPrompt, type Conversation, type Place, type PromptRecord } from './journal.js';
import { notOffered } from './offer.js';
import type { Following, ProcessState } from './process-state.js';
import { isPaseoTool, type EnsureProvider, type PaseoTool } from './providers.js';
import { handOver, throughOf, type Through } from './sandbox.js';
import { readsTokens, sessionUsage } from './usage.js';

// ─── One Paseo agent's life ──────────────────────────────
//
//  A prompt's agent from its acceptance: created once on one of its tool's models, followed until it ends, and stopped
//  by a cancel. Each prompt ends once, as its record or this process holds it.
//

/** A worktree place Paseo opened as a workspace. */
export type WorktreePlace = Extract<Place, { kind: 'worktree' }> & { workspace: NonNullable<Place['workspace']> };

/** How a prompt's agent is launched: in which place and mode, with what prompt and options, and where its answer comes from. */
export interface Launch {
  place: Place;
  /** Absent: the mode Paseo starts the tool in when it sets no default for it. */
  modeId: string | undefined;
  prompt: string;
  options?: AgentCreate['config']['options'];
  env?: AgentCreate['env'];
  answer: AgentPrompt['answer'];
  cwd: string;
  /** The Paseo agent the run was started from, which labels this one. */
  parent?: string;
}

/** How long an attended step waits between looks at a permission request a person has not answered yet. */
const PERMISSION_POLL_MS = 1000;

/** How often an interactive step's agent is looked at while it idles with no result: the person may still be in it. */
const IDLE_POLL_MS = 2_000;

/** What an interactive step's agent is told before teamai's prompt: the person works through the step with it. */
const INTERACTIVE_BRIEF = 'This step is interactive: work through it with the person in this Paseo agent. Write the result file only once they say the step is done.';

/** How long a wait the daemon dropped, as a restart does, waits before it asks again. */
const RECONNECT_MS = 500;

/**
 * How long a cancel or a close may take to confirm its agents stopped, from the moment it is read: Paseo forces a stop
 * after 2 s, and teamai waits 15 s for a cancel's outcome.
 */
export const STOP_SETTLE_MS = 10_000;

/** How often a stopping agent is looked at. */
export const STOP_POLL_MS = 250;

/** Whether an agent is stopped: gone, or no longer running. A lookup that failed or came late does not count as stopped. */
export const isStopped = (agent: Awaited<ReturnType<Daemon['agent']>> | 'late' | undefined): boolean => agent === null || (agent !== undefined && agent !== 'late' && agent.status !== 'running' && agent.status !== 'initializing');

/** Resolves `late` once `deadline` passes, without keeping the process alive for it. */
export const late = (deadline: number): Promise<'late'> => new Promise((resolve) => {
  setTimeout(() => resolve('late'), Math.max(0, deadline - Date.now())).unref();
});

/**
 * Whether the agent still runs at `deadline`. Paseo may answer what stops it before the agent's turn ends, so the work
 * counts as stopped only once Paseo reports the agent no longer running, or gone.
 */
export async function isStillRunning(live: Daemon, agentId: string, deadline: number): Promise<boolean> {
  for (;;) {
    if (isStopped(await Promise.race([live.agent(agentId).catch(() => undefined), late(deadline)]))) return false;

    if (Date.now() >= deadline) return true;
    await delay(STOP_POLL_MS);
  }
}

/** Whether an op ended in a stop that may not have stopped it, which a later cancel tries again. */
export const isFailedStop = (outcome: OpState | undefined): boolean => outcome?.state === 'failed' && outcome.failure.code === CANCEL_FAILED;

/** The agent id a prompt's agent gets: a UUID derived from its op, so a restarted runtime finds the same agent. */
export function agentIdOf(op: OpId): string {
  const hex = createHash('sha256').update(`teamai-runtime-paseo/${op}`).digest('hex');

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * What a step's agent may write without asking besides its worktree: the directory of teamai's result file, where the
 * step also leaves its evidence, as teamai's own launch allows it on a POSIX host, and the run's scratch directory, which
 * the place gives read-write at its own path. Claude's default mode asks before any write, so those two are allowed,
 * and only they. Codex's `auto` sandbox writes the worktree, so the result file's directory and the run directory are
 * added to it. OpenCode asks before it touches a directory outside its project (`external_directory: ask`), so the same
 * two are allowed by OpenCode's own rule, which Paseo sets on the agent's session.
 */
function stepGrant(tool: PaseoTool, result: string, runDir: string): AgentCreate['config']['options'] {
  switch (tool) {
    case 'claude':
      return { allowedTools: [`Edit(/${path.dirname(result)}/**)`, `Edit(/${runDir}/**)`] };

    case 'codex':
      return { sandbox_workspace_write: { writable_roots: [path.dirname(result), runDir] } };

    case 'opencode':
      return { permission: { external_directory: { [`${path.dirname(result)}/*`]: 'allow', [`${runDir}/*`]: 'allow' } } };

    default: {
      const unhandled: never = tool;

      return unhandled;
    }
  }
}

/** The failure of an agent that ended with no session in Paseo: teamai records and scores a pass by its session. */
const noSession = (tool: string): RuntimeFailure => ({
  code: 'tool_failed', message: `Paseo reported no session for the ${tool} agent, so teamai cannot record or score its pass. Run \`teamai workflow retry\` to run it again.`,
});

/**
 * The failure of an agent that stopped on its tool's usage limit, saying what the tool said, or undefined when it did
 * not: the tool's own line starts the text, so a reply that only mentions a limit is not one.
 */
function usageLimited(tool: string, said: string | null | undefined): RuntimeFailure | undefined {
  const text = said?.trim();

  return text && isUsageLimitText(text) ? { code: 'usage_limited', message: `The ${tool} agent hit its usage limit in Paseo: ${text}` } : undefined;
}

/**
 * The failure of an agent whose last message is its tool's usage-limit line, or undefined. The tool writes that line
 * alone, so a message that goes on past its first line is the agent's own, as when it reports a limit it hit elsewhere.
 */
function usageLimitedReply(tool: string, said: string | null | undefined): RuntimeFailure | undefined {
  return said?.trim().includes('\n') ? undefined : usageLimited(tool, said);
}

/** The result the agent wrote; why teamai cannot read what it left at the result file; or none, when it wrote no workflow result. */
function readResult(file: string): { kind: 'result'; result: PromptResult } | { kind: 'unreadable'; why: string } | { kind: 'none' } {
  let text: string;

  try {
    text = readRegularFileSync(file, 'utf8');
  } catch (error) {
    if (error instanceof NotRegularFileError) return { kind: 'unreadable', why: `left ${error.kind} at the result file ${file}, not a regular file, so teamai did not read it` };
    const parsed = FsFailureSchema.safeParse(error);

    if (!parsed.success) throw error;
    const failure = parsed.data;

    if (isMissing(failure)) return { kind: 'none' };

    return { kind: 'unreadable', why: `wrote the result file ${file}, which teamai cannot read because ${cannotReadBecause(failure)}. Let the user teamai runs as read ${file}, then retry the step` };
  }

  try {
    const parsed = PromptResultSchema.safeParse(JSON.parse(text));

    return parsed.success ? { kind: 'result', result: parsed.data } : { kind: 'none' };
  } catch {
    return { kind: 'none' };
  }
}

export const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Where a write to `file` lands: its deepest part that exists, resolved through its links, with the rest after it.
 * Undefined for a link whose target is gone, which a write would create wherever it points.
 */
function resolvedFile(file: string): string | undefined {
  const rest: string[] = [];

  for (let at = file; ; at = path.dirname(at)) {
    const found = fs.lstatSync(at, { throwIfNoEntry: false });

    if (found) return found.isSymbolicLink() && !fs.existsSync(at) ? undefined : path.join(fs.realpathSync(at), ...rest);

    if (path.dirname(at) === at) return undefined;
    rest.unshift(path.basename(at));
  }
}

/**
 * Whether a permission request asks to write or edit a file under one of `dirs`: what a step's grant allows without
 * asking (`stepGrant`), which an agent created for an earlier step was not given for this step's result file. Paseo
 * gives every provider's file write the same detail.
 */
function isGranted(asked: NonNullable<WaitEnd['final']>['pendingPermissions'][number], { cwd, dirs }: { cwd: string; dirs: string[] }): boolean {
  const { detail } = asked;

  if (detail?.type !== 'write' && detail?.type !== 'edit') return false;
  const file = resolvedFile(path.resolve(cwd, detail.filePath));

  if (file === undefined) return false;

  return dirs.some((dir) => {
    const inside = path.relative(resolvedDir(dir), file);

    return inside !== '' && !inside.startsWith('..') && !path.isAbsolute(inside);
  });
}

/**
 * How an agent created for an earlier prompt differs from what `create` asks, for the notice of a prompt that starts a
 * new agent instead: its provider and model, its effort, or its mode. Undefined: it runs as `create` would.
 */
function differs(agentId: string, earlier: AgentCreate['config'], wanted: AgentCreate['config']): string | undefined {
  if (earlier.provider !== wanted.provider) return `agent ${agentId} runs ${earlier.provider}, and this step runs ${wanted.provider}`;

  if (earlier.thinkingOptionId !== wanted.thinkingOptionId) {
    return `agent ${agentId} thinks at effort ${earlier.thinkingOptionId ?? 'the model\'s default'}, and this step at effort ${wanted.thinkingOptionId ?? 'the model\'s default'}`;
  }

  if (earlier.modeId !== wanted.modeId) return `agent ${agentId} runs in Paseo mode ${earlier.modeId ?? 'unset'}, and this step in mode ${wanted.modeId ?? 'unset'}`;

  return undefined;
}

/** How long a step waits for the daemon to show the agent its run was started from, before naming it by its id alone. */
const PARENT_LOOKUP_MS = 5_000;

/**
 * How a step's first line names Paseo agent `parent`, which the run was started from: its link when the daemon holds it.
 * An agent this daemon does not know, or does not show within 5 s, is named by its id alone, never linked to a server
 * that does not hold it.
 */
async function parentNamed(live: Daemon, parent: string): Promise<string> {
  const known = await Promise.race([live.agent(parent), delay(PARENT_LOOKUP_MS).then(() => null)]).catch(() => null);

  return known ? live.link(parent) : parent;
}

/** Why a stop cannot be done with no daemon: its connection's own failure, or, with none, that no daemon is reached. */
export const withoutDaemon = (failure: RuntimeFailure | undefined, cannot: string, then: string): RuntimeFailure => (failure
  ? { code: failure.code, message: `${failure.message} Until then teamai-runtime-paseo cannot ${cannot}; ${then}.` }
  : { code: 'daemon_unreachable', message: `teamai-runtime-paseo reaches no Paseo daemon, so it cannot ${cannot}. Start the daemon with \`paseo start\`, then ${then}.` });

/** The workflow folder's path a step of a workflow folder gets, so its agent's shell finds the folder's files; none for a single file. */
function folderEnv(env: Readonly<Record<string, string>>): Partial<Record<typeof WORKFLOW_DIR_ENV, string>> {
  const folder = env[WORKFLOW_DIR_ENV];

  return folder === undefined ? {} : { [WORKFLOW_DIR_ENV]: folder };
}

/** The create a new prompt sends, on one of `models`, in `how`'s mode with its prompt and options, or the failure that keeps it from being sent. */
function createFor(live: Daemon, request: Extract<RuntimeRequest, { type: 'prompt' }>, { name: tool, provider }: Target, models: Model[], how: Launch): AgentCreate | RuntimeFailure {
  const { place } = how;
  const { lease } = request;
  const offered = models.map((candidate) => candidate.id).join(', ') || 'none';
  // The step's model, or the agent definition's, which teamai sends as the lease's; else the tool's default. A step that
  // names a model runs on it, or fails: it never runs on the default instead.
  const model = lease.model ? models.find((candidate) => candidate.id === lease.model?.name) : models.find((candidate) => candidate.isDefault) ?? models[0];

  if (!model) {
    return { code: 'model_unavailable', message: `The Paseo daemon at ${live.url} has no ${tool} model${lease.model ? ` ${lease.model.name}` : ''}. It offers: ${offered}.` };
  }

  const effort = lease.model?.effort;

  if (effort && !model.efforts.includes(effort)) {
    return { code: 'model_unavailable', message: `The Paseo daemon at ${live.url} has no effort ${effort} for ${tool} model ${model.id}. It offers: ${model.efforts.join(', ') || 'none'}.` };
  }

  return {
    agentId: agentIdOf(request.op),
    idempotencyKey: request.op,
    title: `teamai ${lease.step} · ${place.run}`,
    prompt: how.prompt,
    // `paseo ls --label teamai-run=<run>` lists a run's agents, and `teamai-step` one step's.
    // `teamai-parent` lists the step and judge agents of runs started from that Paseo agent.
    labels: { 'teamai-attempt': `${place.run}/${place.attempt}`, 'teamai-run': place.run, 'teamai-step': lease.step, ...(how.parent && { 'teamai-parent': how.parent }) },
    ...(how.env && { env: how.env }),
    config: { provider: `${provider}/${model.id}`, ...(how.modeId !== undefined && { modeId: how.modeId }), ...(effort && { thinkingOptionId: effort }), ...(how.options && { options: how.options }) },
  };
}

/** The prompts of this process: each from its acceptance to its one end. */
export function conversations(state: ProcessState, { ensureProvider }: { ensureProvider: EnsureProvider }) {
  const { journal, ledger, write, fail, startedFrom, waiting, stopping, closeStops, creates, offers, targets, modeIds, sessionHomes, homeDirs, providerHomes } = state;

  /** An outcome a prompt ended with, which only a prompt still running is not. */
  const endOf = (outcome: OpState): OpEnd => {
    if (outcome.state === 'running') throw new Error(`A Paseo prompt's record says ${outcome.op} still runs, where it says how it ended`);

    return outcome;
  };

  /** Answers how `outcome`'s prompt ended, as its record or this process holds it. */
  const send = (outcome: OpState): void => ledger.end(endOf(outcome));
  /** The prompt each conversation takes its turn for in this process, by the conversation's op, until that prompt ends. */
  const turning = new Map<OpId, OpId>();

  /** Follows a prompt from here on: a cancel and a close find it, and wait for its create. */
  const track = (op: OpId): Following => {
    let stop = (): void => {};

    const stopped = new Promise<'stopped'>((resolve) => {
      stop = () => resolve('stopped');
    });

    let resolve = (): void => {};

    const creating = new Promise<void>((settled) => {
      resolve = settled;
    });

    creates.set(op, creating);

    const landed = (): void => {
      resolve();

      if (creates.get(op) === creating) creates.delete(op);
    };

    const following: Following = { stop, stopped, created: false, landed };
    waiting.set(op, following);

    return following;
  };

  /**
   * Records how a prompt ended and tells teamai, once. A prompt's own launch or follow, its `owner`, ends it only while it
   * still holds it in `waiting`: a cancel that took it over ends it instead.
   */
  const settle = (op: OpId, outcome: OpState, owner?: Following): void => {
    if (owner && waiting.get(op) !== owner) return;
    const record = journal.prompt(op);

    if (!record || record.kind === 'refused') return;

    // Another process ended it first, as a recover-mode cancel does: a prompt this one follows ends as that one recorded.
    if (record.outcome) {
      if (waiting.delete(op)) send(record.outcome);

      return;
    }

    // An end the record cannot keep is answered all the same, and this process remembers it until the place closes.
    waiting.delete(op);
    void ledger.settle(endOf(outcome), () => journal.savePrompt(op, { ...record, outcome }));
  };

  /** Records whether a prompt sent its create, on its record as it stands: one a close removed is not written again. */
  const dispatch = (op: OpId, dispatched: AgentPrompt['dispatched']): void => {
    const current = journal.prompt(op);

    if (current?.kind === 'agent' && current.dispatched !== dispatched) journal.savePrompt(op, { ...current, dispatched });
  };

  /**
   * Cancels a prompt's agent in Paseo and confirms it stopped by `deadline`, or says why it may still run, since the
   * agent may then still change the worktree.
   */
  const cancelAgent = async (live: Daemon, record: AgentPrompt, deadline = Date.now() + STOP_SETTLE_MS): Promise<RuntimeFailure | undefined> => {
    const cancelling = (async (): Promise<{ refused?: string }> => {
      try {
        await live.cancel(record.create.agentId);

        return {};
      } catch (error) {
        return { refused: error instanceof Error ? error.message : String(error) };
      }
    })();

    const answered = await Promise.race([cancelling, late(deadline)]);

    if (answered === 'late') {
      return {
        code: 'cancel_failed',
        message: `Paseo did not answer the cancel of the ${record.tool} agent ${record.create.agentId} within ${STOP_SETTLE_MS / 1000} s. It may still run in the worktree; stop it in the Paseo app.`,
      };
    }

    if (answered.refused !== undefined) {
      return {
        code: 'cancel_failed',
        message: `Paseo did not cancel the ${record.tool} agent ${record.create.agentId}: ${answered.refused}. It may still run in the worktree; stop it in the Paseo app.`,
      };
    }

    if (!(await isStillRunning(live, record.create.agentId, deadline))) return undefined;

    return {
      code: 'cancel_failed',
      message: `Paseo cancelled the ${record.tool} agent ${record.create.agentId}, but it still ran ${STOP_SETTLE_MS / 1000} s later. It may still change the worktree; stop it in the Paseo app.`,
    };
  };

  /**
   * A finished prompt's session: its tool and id, and the home it lives in when the runtime can tell. `createdAt`: when
   * Paseo created its agent.
   */
  const sessionOf = (live: Daemon, { tool, id, createdAt, through }: { tool: string; id: string; createdAt: string | undefined; through: Through | undefined }): z.infer<typeof PromptSessionSchema> => {
    const target = targets.get(tool);
    const created = createdAt === undefined ? Number.NaN : Date.parse(createdAt);
    const since = Number.isNaN(created) ? undefined : created;
    // Through a sandbox, the tool keeps its sessions in the attempt's tool home.
    const home = through?.home ?? (target && live.sessionHome(target.tool, id, { claudeHome: sessionHomes.get(tool), providerHome: providerHomes.get(tool), homeDir: homeDirs.get(tool) ?? '.codex', since }));

    return { tool, id, ...(home !== undefined && { home }) };
  };

  /**
   * A finished prompt's session, and the tokens its step billed there, which the runtime reads only on a daemon on this
   * machine, where the session's home is. A turn sent to an agent that already ran counts from its send on, as journaled
   * just before the send; one journaled without that time cannot be told from the earlier steps' requests, and reports none.
   */
  const finishedOf = async (live: Daemon, op: OpId, record: AgentPrompt, ended: { id: string; createdAt: string | undefined; through: Through | undefined }): Promise<{ session: z.infer<typeof PromptSessionSchema>; usage?: z.infer<typeof PromptUsageSchema>; unmeasured?: Unmeasured }> => {
    const session = sessionOf(live, { tool: record.tool, ...ended });
    const target = targets.get(record.tool);
    const kept = journal.prompt(op);
    const turn = kept?.kind === 'agent' ? kept.turn : record.turn;

    if (!target || !isOnThisMachine(live.url) || !readsTokens(target.tool)) return { session };

    const measured = session.home === undefined
      ? { kind: 'unmeasured' as const, why: { cause: `teamai found no home of ${target.tool} on this machine that holds session ${session.id}, where it reads the step's tokens.`, next: 'Retry the step.' } }
      : turn && turn.sentAt === undefined
        ? UNTIMED_TURN
        : await sessionUsage({ tool: target.tool, toolHome: session.home, cwd: record.cwd, sessionId: session.id, ...(turn?.sentAt !== undefined && { turnSentAt: turn.sentAt }) });

    if (measured === undefined) return { session };

    if (measured.kind === 'measured') return { session, usage: measured.usage };

    return state.offersTokens ? { session, unmeasured: measured.why } : { session };
  };

  /** What the run's details show of a prompt's agent: its title, a link that opens it in Paseo, and where it runs. */
  const agentDisplay = (record: AgentPrompt, workspace: string | undefined, live: Daemon): RuntimeDisplay => ({
    label: record.create.title.slice(0, 80),
    url: live.link(record.create.agentId),
    fields: { agent: record.create.agentId, ...(workspace && { workspace }), model: record.create.config.provider },
  });

  /** What the run's details show of a prompt's agent, once it exists. */
  const shownOf = (record: AgentPrompt, live: Daemon): RuntimeDisplay | undefined => {
    const place = journal.place(record.handle);

    return place && agentDisplay(record, place.workspace?.id, live);
  };

  /** Accepts a prompt, showing its agent when that is known to exist; one still to be created is shown once it is. */
  const accept = (op: OpId, record: PromptRecord, live: Daemon, { exists }: { exists: boolean }): void => {
    const display = exists && record.kind === 'agent' && shownOf(record, live);
    write({ op, event: 'accepted', ...(display && { display }) });
  };

  /**
   * Accepts a new prompt before Paseo is asked anything, which may take long: a model listing alone may take 90 s, and
   * teamai waits 15 s for the acceptance. It is journaled pending and followed from here, so a cancel or a close finds it.
   */
  const begin = (op: OpId, handle: string): Following => {
    journal.savePrompt(op, { kind: 'pending', handle });
    const following = track(op);
    write({ op, event: 'accepted' });

    return following;
  };

  /**
   * Whether a prompt whose create is not sent yet goes on to send it: not once teamai went away, nor once it was
   * cancelled, here or by another process, or its place closes, which ends it cancelled with no agent.
   */
  const goesOn = (op: OpId, following: Following): boolean => {
    if (state.closing || waiting.get(op) !== following) return false;

    if (!journal.isCancelled(op)) return true;
    settle(op, { op, state: 'cancelled' }, following);

    return false;
  };

  /** The tool's models, or why Paseo did not list them, or `stopped` once the prompt is stopped: a listing changes nothing in Paseo, so no stop waits for it. */
  const listModels = async (live: Daemon, provider: string, following: Following): Promise<Model[] | RuntimeFailure | 'stopped'> => {
    try {
      return await Promise.race([live.models(provider), following.stopped]);
    } catch (error) {
      return { code: 'paseo_failed', message: `Paseo failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  };

  /**
   * The conversation a lease continues, by its id, when this prompt can send it its turn: one this runtime holds for a
   * place still open, whose agent was created as `create` would be, in this place's Paseo workspace, and idle there; or
   * why not, for the notice. A place that runs through a sandbox never continues one: each prompt there runs in an agent
   * its registration names. A conversation takes one turn at a time: the prompt it answers for holds it, in this process,
   * until that prompt ends.
   */
  async function continuable(live: Daemon, { op, earlier, create, place }: { op: OpId; earlier: { handle: string; op: OpId }; create: AgentCreate; place: Place }): Promise<Conversation | { why: string }> {
    const conversation = journal.conversation(earlier.op);
    const at = conversation && journal.place(conversation.handle);

    if (conversation?.handle !== earlier.handle || !at) return { why: 'this runtime no longer holds its agent' };
    const { agentId } = conversation.create;

    if (throughOf(at) || throughOf(place)) return { why: 'a place that runs through a sandbox runs each prompt in an agent of its own' };
    const other = differs(agentId, conversation.create.config, create.config);

    if (other) return { why: other };

    if (at.workspace?.id !== place.workspace?.id) return { why: `agent ${agentId} works in Paseo workspace ${at.workspace?.name ?? 'none'}, and this step works in ${place.workspace?.name ?? 'none'}` };

    try {
      const agent = await live.agent(agentId);

      if (!agent) return { why: `Paseo no longer shows agent ${agentId}` };

      if (agent.archivedAt) return { why: `Paseo archived agent ${agentId}` };

      if (agent.status === 'running' || agent.status === 'initializing') return { why: `agent ${agentId} is still running a turn` };
    } catch (error) {
      return { why: `Paseo did not show agent ${agentId} (${error instanceof Error ? error.message : String(error)})` };
    }

    // Read and taken with no wait between, so two prompts that continue it at once never both send it a turn.
    const turn = turning.get(earlier.op);

    if (turn !== undefined && turn !== op && ledger.endsOf(turn) === 0) return { why: `agent ${agentId} runs the turn of ${turn}` };
    turning.set(earlier.op, op);

    return conversation;
  }

  /**
   * The turn sent to an earlier prompt's agent: `prompt`, after this step's workflow folder when that agent's shell names
   * another, as a step of a named child workflow that goes on from the step beside its enclosing one finds it.
   */
  function goingOn(earlier: AgentCreate, wanted: AgentCreate, prompt: string): string {
    const folder = wanted.env?.[WORKFLOW_DIR_ENV];

    if (earlier.env?.[WORKFLOW_DIR_ENV] === folder) return prompt;
    const named = folder === undefined ? 'this step has no workflow folder' : `this step's workflow folder is ${folder}`;

    return `This agent goes on from an earlier step, so its shell's ${WORKFLOW_DIR_ENV} is that step's: ${named}.\n\n${prompt}`;
  }

  /**
   * The agent Paseo imports for session `session`, which a new prompt's lease resumes, set to run as `create` would, and
   * the turn it is sent; or why it was not imported, for the notice. Paseo imports a session it does not hold all the
   * same and fails its first turn, so only one it lists in the place's directory is imported. An import runs nothing
   * until the turn is sent, so one a stop overtakes leaves an idle agent, never work in the worktree.
   */
  async function imported(live: Daemon, { session, create, provider, how }: { session: string; create: AgentCreate; provider: string; how: Launch }): Promise<{ create: AgentCreate; turn: NonNullable<AgentPrompt['turn']> } | { why: string }> {
    const { place } = how;

    if (place.kind !== 'worktree' || !place.workspace) return { why: 'its place has no Paseo workspace' };


    try {
      if (!(await live.sessions(how.cwd, provider)).includes(session)) return { why: `Paseo lists no ${provider} session of that id in ${how.cwd}` };
    } catch (error) {
      return { why: `Paseo did not list its sessions in ${how.cwd} (${error instanceof Error ? error.message : String(error)})` };
    }

    let agentId: string;

    try {
      agentId = await live.importSession({ provider, session, cwd: how.cwd, workspaceId: place.workspace.id, labels: create.labels });
    } catch (error) {
      return { why: `Paseo did not import it (${error instanceof Error ? error.message : String(error)})` };
    }

    const { modeId, thinkingOptionId } = create.config;

    try {
      await live.configure(agentId, { model: create.config.provider.slice(provider.length + 1), ...(modeId !== undefined && { modeId }), ...(thinkingOptionId !== undefined && { thinkingOptionId }) });
    } catch (error) {
      return { why: `Paseo did not set the agent ${agentId} it imported to run as the step asks (${error instanceof Error ? error.message : String(error)}), so that agent stays idle` };
    }

    // An import carries no env, so the turn names the paths the agent's shell does not.
    const folder = create.env?.[WORKFLOW_DIR_ENV];

    const scratch = folder === undefined
      ? `This agent resumes an earlier session, so its shell has no ${RUN_DIR_ENV}: the run's scratch directory is ${place.runDir}.`
      : `This agent resumes an earlier session, so its shell has no ${RUN_DIR_ENV} or ${WORKFLOW_DIR_ENV}: the run's scratch directory is ${place.runDir}, and the workflow's folder ${folder}.`;

    return { create: { ...create, agentId }, turn: { prompt: `${scratch}\n\n${how.prompt}`, of: { session } } };
  }

  /**
   * Creates a pending prompt's agent on one of the tool's models, and follows it, or sends its turn to the agent of the
   * earlier prompt it continues, or to the one Paseo imported for the session it resumes. Its agent record is journaled before
   * the cancel marker is read, so a cancel, here or in another process, either finds that record and stops the agent, or
   * is seen here, and no create is sent.
   */
  async function launch(live: Daemon, request: Extract<RuntimeRequest, { type: 'prompt' }>, following: Following, target: Target, how: Launch): Promise<void> {
    const { op } = request;
    const through = throughOf(how.place);
    // Accepted already: a provider no open added yet for a team instance is added now, which may wait on another runtime.
    // A cancel or a close meanwhile ends the prompt at once; the add goes on for the instance's later steps. Through a
    // sandbox, the tool runs on the wrapper's provider, which the open added.
    const unadded = through ? undefined : await Promise.race([ensureProvider(live, target.name, op), following.stopped]);

    if (!goesOn(op, following) || unadded === 'stopped') return;

    if (unadded) {
      settle(op, { op, state: 'failed', failure: unadded }, following);

      return;
    }

    const known = targets.get(target.name) ?? target;
    const on = through ? { ...known, provider: through.provider } : known;
    const models = await listModels(live, on.provider, following);

    if (!goesOn(op, following) || models === 'stopped') return;
    const create = 'code' in models ? models : createFor(live, request, on, models, how);

    if ('code' in create) {
      settle(op, { op, state: 'failed', failure: create }, following);

      return;
    }

    const earlier = request.lease.continue;
    const continued = earlier && (await continuable(live, { op, earlier, create, place: how.place }));

    if (!goesOn(op, following)) return;

    // A session another driver ran, or an earlier pass whose place is gone, is imported when no conversation goes on.
    const { resume } = request.lease;
    const goesOnInEarlier = continued !== undefined && !('why' in continued);
    const resumed = !goesOnInEarlier && resume !== undefined && !through ? await imported(live, { session: resume, create, provider: on.provider, how }) : undefined;

    if (!goesOn(op, following)) return;
    // One notice for the op, naming each way on it could not take: the conversation it continues, then the session it resumes.
    const { step } = request.lease;
    const notImported = resume !== undefined && resumed && 'why' in resumed ? { session: resume, why: resumed.why } : undefined;

    if (earlier && continued && 'why' in continued) {
      write({
        op,
        event: 'notice',
        message: notImported
          ? `teamai-runtime-paseo starts a new agent for step "${step}" rather than continue the conversation of ${earlier.op}: ${continued.why}; nor could it resume session ${notImported.session}: ${notImported.why}.`
          : `teamai-runtime-paseo starts a new agent for step "${step}" rather than continue the conversation of ${earlier.op}: ${continued.why}.`,
      });
    } else if (notImported) {
      write({ op, event: 'notice', message: `teamai-runtime-paseo starts a new agent for step "${step}" rather than resume session ${notImported.session}: ${notImported.why}.` });
    }

    const base = { kind: 'agent', handle: request.handle, tool: target.name, answer: how.answer, cwd: how.cwd } as const;

    // A turn of the earlier agent: Paseo already shows it, and its create stays the earlier prompt's.
    const record: AgentPrompt = earlier && continued && !('why' in continued)
      ? { ...base, create: continued.create, dispatched: 'confirmed', turn: { prompt: goingOn(continued.create, create, how.prompt), of: { op: earlier.op } } }
      : resumed && !('why' in resumed)
        ? { ...base, create: resumed.create, dispatched: 'confirmed', turn: resumed.turn }
        : { ...base, create };

    journal.savePrompt(op, record);

    // A conversation this prompt started is this place's, which a later prompt may continue; a turn starts none.
    if (record.answer.kind === 'result-file' && (!record.turn || 'session' in record.turn.of)) journal.saveConversation(op, { handle: request.handle, tool: record.tool, create: record.create });

    if (!goesOn(op, following)) return;
    await follow(live, op, record, following);
  }

  /** Records a prompt refused before any agent was created, so a repeated id ends the same, and says why. */
  const refuse = (op: OpId, handle: string, failure: RuntimeFailure): void => {
    journal.savePrompt(op, { kind: 'refused', handle, outcome: { op, state: 'failed', failure } });
    fail(op, failure);
  };

  /** How a step's first line names the Paseo agent the run was started from, once looked up. */
  let parent: Promise<string> | undefined;

  /** A workflow prompt step: an agent in the worktree, in the tool's default mode, that writes teamai's result file. */
  async function work(live: Daemon, request: Extract<RuntimeRequest, { type: 'prompt' }>, place: WorktreePlace): Promise<void> {
    const { op, lease } = request;
    const { tool } = lease;

    if (!isPaseoTool(tool) && !offers.has(tool)) {
      fail(op, { code: 'tool_unavailable', message: `teamai-runtime-paseo runs claude, codex, opencode and the team's instances of them, not ${tool}.` });

      return;
    }

    const unoffered = notOffered(offers, tool, false);
    const target = targets.get(tool);

    if (unoffered || !target) {
      refuse(op, request.handle, unoffered ?? { code: 'tool_unavailable', message: `teamai-runtime-paseo did not offer ${tool}.` });

      return;
    }

    const following = begin(op, request.handle);

    try {
      // Looked up once per process; a stop meanwhile does not wait for it, and the launch then ends the prompt.
      parent ??= startedFrom === undefined ? undefined : parentNamed(live, startedFrom);
      const named = parent && await Promise.race([parent, following.stopped]);
      const origin = named && named !== 'stopped' ? `This agent runs step "${lease.step}" of teamai workflow run ${place.run}, started from the Paseo agent ${named}.` : undefined;
      const brief = [origin, lease.interactive && INTERACTIVE_BRIEF, lease.prompt].filter(Boolean).join('\n\n');

      await launch(live, request, following, target, {
        place, modeId: modeIds.get(tool), prompt: brief, env: { [RUN_DIR_ENV]: place.runDir, ...folderEnv(request.env) }, ...(startedFrom && { parent: startedFrom }),
        options: stepGrant(target.tool, lease.result, place.runDir), answer: { kind: 'result-file', file: lease.result, ...(lease.interactive && { interactive: true }) }, cwd: place.cwd,
      });
    } finally {
      following.landed();
    }
  }

  /** Makes sure the prompt's agent exists, then waits for it to end, and settles the prompt. */
  async function follow(live: Daemon, op: OpId, record: AgentPrompt, following: Following): Promise<void> {
    const through = throughOf(journal.place(record.handle));

    if (!through) {
      await followAgent(live, op, record, following, undefined);

      return;
    }

    // Registered before Paseo can start the agent's wrapper, and again by each runtime that follows the prompt.
    const registered = await registerThrough({ outer: through.outer, agent: record.create.agentId });
    const sent = journal.prompt(op);

    // With no registration the sandbox serves no wrapper of this agent, so a prompt not sent yet never is; one sent
    // before is followed still, since its tool was granted already.
    if (!registered.ok && !(sent?.kind === 'agent' && sent.sent)) {
      following.landed();
      settle(op, { op, state: 'failed', failure: { code: 'isolation_unproven', message: `teamai could not register the ${record.tool} agent on the attempt's sandbox (${registered.why}), so it started no agent there. Run the step again; if the sandbox runtime stopped, resume the run.` } }, following);

      return;
    }

    try {
      await followAgent(live, op, record, following, { through, registration: registered.ok ? registered : undefined });
    } finally {
      if (registered.ok) registered.close();
    }
  }

  /**
   * `follow`, with what the place runs through and the agent's registration there, when it runs through a sandbox: none
   * only for a prompt already sent, whose registration a restarted sandbox runtime could not take.
   */
  async function followAgent(live: Daemon, op: OpId, record: AgentPrompt, following: Following, sandboxed: { through: Through; registration: Registration | undefined } | undefined): Promise<void> {
    const through = sandboxed?.through;
    const { create } = record;
    const { stopped } = following;

    try {
      // A turn of an agent the prompt did not create creates none: one Paseo no longer shows ends the prompt, which sent
      // it nothing the agent could still run, or whose turn ended with the agent.
      if (record.turn && !(await live.agent(create.agentId))) {
        settle(op, {
          op, state: 'failed',
          failure: { code: 'tool_failed', message: `Paseo no longer shows the ${record.tool} agent ${create.agentId}, whose conversation this step goes on with. Run \`teamai workflow retry\` to run the step in a new agent.` },
        }, following);

        return;
      }

      // The agent of a repeated prompt is found by its id; a create a runtime died before sending is sent again. A lookup
      // that fails throws: an earlier runtime may have created the agent.
      let creation: Creation = { outcome: 'created' };

      if (!record.turn && !(await live.agent(create.agentId))) {
        // Journaled before it is sent, and kept until Paseo shows the agent: a create that failed may still start it.
        dispatch(op, 'unconfirmed');
        creation = await live.create(record.cwd, create, { isIdle: sandboxed !== undefined });
      }

      // Only a create never sent, by this process or an earlier one, proves no agent started.
      if (creation.outcome === 'unsent' && record.dispatched === undefined) {
        dispatch(op, undefined);
        settle(op, { op, state: 'failed', failure: { code: 'agent_create_failed', message: `Paseo could not create the ${record.tool} agent: ${creation.cause}` } }, following);

        return;
      }

      // Paseo may have created the agent though the create failed, as when its answer was lost: one it shows is followed,
      // and one it does not show may still start.
      if (creation.outcome !== 'created' && !(await live.agent(create.agentId).catch(() => null))) {
        settle(op, {
          op, state: 'failed',
          failure: { code: CANCEL_FAILED, message: `Paseo could not create the ${record.tool} agent ${create.agentId} (${creation.cause}), and does not show it, though it may still start. It may still run in the worktree; stop it in the Paseo app.` },
        }, following);

        return;
      }

      dispatch(op, 'confirmed');
      following.created = true;
    } finally {
      following.landed();
    }

    const display = shownOf(record, live);

    if (display) write({ op, event: 'display', display });

    // A cancel that came to a runtime since killed is sent now that the agent exists; one this process reads stops it itself.
    if (journal.isCancelled(op) && !stopping.has(op)) {
      const refused = await cancelAgent(live, record);
      settle(op, refused ? { op, state: 'failed', failure: refused } : { op, state: 'cancelled' }, following);

      return;
    }

    // Through a sandbox, the agent gets its prompt once its wrapper connected, and only once: a stop meanwhile is
    // handled below.
    const current = journal.prompt(op);

    if (sandboxed?.registration && !(current?.kind === 'agent' && current.sent)) {
      const markSent = (): void => {
        const latest = journal.prompt(op);

        if (latest?.kind === 'agent') journal.savePrompt(op, { ...latest, sent: true });
      };

      // A cancel marks the prompt before it stops the agent, and a close of its place marks it before it stops its agents.
      const isStillOurs = (): boolean => !journal.isCancelled(op) && !closeStops.has(op) && waiting.get(op) === following;
      const handed = await handOver(live, { record, provider: sandboxed.through.provider, registration: sandboxed.registration, stopped, isStillOurs, markSent });

      if (handed !== 'sent' && handed !== 'stopped') {
        settle(op, { op, state: 'failed', failure: handed }, following);

        return;
      }
    }

    // A turn of an agent the prompt did not create is sent once, unless a stop came first: its record says so before it is sent.
    if (record.turn && current?.kind === 'agent' && !current.sent && !journal.isCancelled(op) && !closeStops.has(op) && waiting.get(op) === following) {
      journal.savePrompt(op, { ...current, sent: true, turn: { ...record.turn, sentAt: Date.now() } });

      try {
        await live.send(create.agentId, record.turn.prompt);
      } catch (error) {
        settle(op, {
          op, state: 'failed',
          failure: { code: CANCEL_FAILED, message: `Paseo did not take this step's turn for the ${record.tool} agent ${create.agentId} (${error instanceof Error ? error.message : String(error)}), though it may still run it in the worktree; stop it in the Paseo app.` },
        }, following);

        return;
      }
    }

    for (;;) {
      // teamai went away, or a cancel took the prompt over and ended it.
      if (state.closing || waiting.get(op) !== following) return;

      if (closeStops.has(op)) {
        await Promise.race([delay(STOP_POLL_MS), stopped]);
        continue;
      }

      // Whoever runs the stop settles the prompt once it is confirmed or refused: this process, or another one, such as
      // a recover-mode cancel, whose outcome this one waits to read. A cancel marker alone proves nothing stopped.
      if (journal.isCancelled(op)) {
        if (stopping.has(op)) return;
        const ended = journal.prompt(op);

        if (ended?.kind === 'agent' && ended.outcome) {
          settle(op, ended.outcome, following);

          return;
        }

        await Promise.race([delay(STOP_POLL_MS), stopped]);
        continue;
      }

      const end = await Promise.race([live.wait(create.agentId).catch(() => ({ dropped: true })), stopped]);

      if (end === 'stopped') continue;

      if ('dropped' in end) {
        await delay(RECONNECT_MS);
        continue;
      }

      if (journal.isCancelled(op) || closeStops.has(op)) continue;

      switch (end.status) {
        case 'timeout':
          continue;
        case 'permission': {
          const pending = end.final?.pendingPermissions ?? [];
          const place = journal.place(record.handle);
          const grant = record.answer.kind === 'result-file' && place?.kind === 'worktree' ? { cwd: record.cwd, dirs: [path.dirname(record.answer.file), place.runDir] } : undefined;

          // A write the step's grant allows, which an agent created for an earlier step, or by an import, was not given:
          // allowed as the grant would, and the turn goes on.
          if (grant && pending.length > 0 && pending.every((request) => isGranted(request, grant))) {
            await Promise.all(pending.map((request) => live.allow(create.agentId, request.id)));
            await Promise.race([delay(PERMISSION_POLL_MS), stopped]);
            continue;
          }

          const asked = pending[0];
          const inMode = create.config.modeId === undefined ? 'in the mode Paseo starts it in' : `in Paseo mode ${create.config.modeId}`;

          if (record.answer.kind === 'reply') {
            const refused = await cancelAgent(live, record);
            settle(op, {
              op, state: 'failed',
              failure: {
                // A stop that is not confirmed is the one failure whose agent may still run.
                code: refused ? 'cancel_failed' : 'tool_failed',
                message: `The ${record.tool} agent asked for permission${asked ? ` (${asked.title ?? asked.name})` : ''} ${inMode}. A confined prompt only reads its directory, so it ends rather than ask.${refused ? ` ${refused.message}` : ''}`,
              },
            }, following);

            return;
          }

          if (state.mode === 'attended') {
            // A person answers it in the Paseo app; the turn goes on once they do.
            await Promise.race([delay(PERMISSION_POLL_MS), stopped]);
            continue;
          }

          const refused = await cancelAgent(live, record);
          settle(op, {
            op, state: 'failed',
            failure: {
              code: refused ? 'cancel_failed' : 'tool_failed',
              message: `The ${record.tool} agent asked for permission${asked ? ` (${asked.title ?? asked.name})` : ''} ${inMode}, which asks before it runs what it does not allow, and an unattended run has nobody to answer. Run the workflow attended to answer it in the Paseo app, or run this step on a runtime that offers unattended.${refused ? ` ${refused.message}` : ''}`,
            },
          }, following);

          return;
        }

        case 'error':
          settle(op, { op, state: 'failed', failure: usageLimited(record.tool, end.error) ?? { code: 'tool_failed', message: `The ${record.tool} agent failed in Paseo: ${end.error ?? 'no error given'}` } }, following);

          return;
        case 'idle': {
          const session = end.final?.runtimeInfo?.sessionId;

          if (record.answer.kind === 'reply') {
            const output = end.lastMessage ? extractReply(end.lastMessage, JsonValueSchema) : undefined;

            if (end.final?.status === 'closed' && output === undefined) {
              settle(op, {
                op, state: 'failed',
                failure: { code: 'daemon_restarted', message: `The Paseo daemon at ${live.url} stopped while the ${record.tool} agent answered the confined prompt, before it replied.` },
              }, following);

              return;
            }

            if (output === undefined) {
              settle(op, { op, state: 'failed', failure: usageLimitedReply(record.tool, end.lastMessage) ?? { code: 'tool_failed', message: `The ${record.tool} agent replied with no JSON value.` } }, following);

              return;
            }

            if (!session) {
              settle(op, { op, state: 'failed', failure: noSession(record.tool) }, following);

              return;
            }

            settle(op, { op, state: 'finished', ...(await finishedOf(live, op, record, { id: session, createdAt: end.final?.createdAt, through })), result: { output }, confined: record.answer.kept }, following);

            return;
          }

          const read = readResult(record.answer.file);

          if (end.final?.status === 'closed' && read.kind === 'none') {
            settle(op, {
              op, state: 'failed',
              failure: { code: 'daemon_restarted', message: `The Paseo daemon at ${live.url} stopped while the ${record.tool} agent worked, before it wrote a workflow result. Its work is kept in the worktree.` },
            }, following);

            return;
          }

          // An interactive step ends once the person said it is done and the agent wrote the result; until then the agent
          // idles between their turns. A result file it wrote that is not a workflow result fails the step, as any step.
          if (read.kind === 'none' && record.answer.interactive && !fs.existsSync(record.answer.file)) {
            await Promise.race([delay(IDLE_POLL_MS), stopped]);
            continue;
          }

          if (read.kind !== 'result') {
            // A tool that stopped on its usage limit says so in its last message, and writes no result.
            const failure = read.kind === 'unreadable'
              ? { code: 'tool_failed' as const, message: `${record.tool} ${read.why}` }
              : usageLimitedReply(record.tool, end.lastMessage) ?? { code: 'tool_failed' as const, message: `${record.tool} did not write a valid workflow result` };

            settle(op, { op, state: 'failed', failure }, following);

            return;
          }

          if (!session) {
            settle(op, { op, state: 'failed', failure: noSession(record.tool) }, following);

            return;
          }

          settle(op, { op, state: 'finished', ...(await finishedOf(live, op, record, { id: session, createdAt: end.final?.createdAt, through })), result: read.result, ...(record.turn && { resumed: true }) }, following);

          return;
        }

        default: {
          const unhandled: never = end.status;
          throw new Error(`Unknown wait status ${String(unhandled)}`);
        }
      }
    }
  }

  async function cancel(op: OpId): Promise<void> {
    const deadline = Date.now() + STOP_SETTLE_MS;
    // A prompt that already ended, as one whose end teamai lost, answers that end again and stops nothing. Only a stop that
    // failed is tried again; until it is confirmed or fails again, reattach reports the prompt running.
    const unrecorded = ledger.unkept(op);

    if (unrecorded) {
      ledger.end(unrecorded);

      return;
    }

    const found = journal.prompt(op);

    if (!found) return;
    const { outcome } = found;

    if (found.kind === 'refused' || (outcome && !isFailedStop(outcome))) {
      if (outcome) send(outcome);

      return;
    }

    if (outcome) journal.savePrompt(op, { ...found, outcome: undefined });
    journal.cancel(op);
    const following = waiting.get(op);
    const endsBefore = ledger.endsOf(op);
    stopping.add(op);

    try {
      // A prompt that has not sent its create sees the cancel, and sends none. One whose agent is still being created is
      // stopped once it exists, within the same deadline: past it, the agent may still start.
      following?.stop();
      const creating = creates.get(op);
      const joined = creating && (await Promise.race([creating, late(deadline)]));
      const record = journal.prompt(op);

      // It ended meanwhile: a create Paseo refused, or a prompt that saw the cancel before it sent a create.
      if (!record || record.kind === 'refused' || record.outcome) return;

      // No create was sent, and none will be: whoever launches it reads the cancel after it journals the agent.
      if (record.kind === 'pending') {
        settle(op, { op, state: 'cancelled' });

        return;
      }

      if (joined === 'late') {
        settle(op, {
          op, state: 'failed',
          failure: { code: CANCEL_FAILED, message: `Paseo did not finish creating the ${record.tool} agent ${record.create.agentId} within ${STOP_SETTLE_MS / 1000} s, so it may still start in the worktree; cancel the run again.` },
        });

        return;
      }

      const live = await state.reachBy(deadline);

      const refused = live && !('code' in live)
        ? await cancelAgent(live, record, deadline)
        : { ...withoutDaemon(live, `cancel the ${record.tool} agent ${record.create.agentId}, which may still run in the worktree`, 'cancel the run again'), code: 'cancel_failed' };

      settle(op, refused ? { op, state: 'failed', failure: refused } : { op, state: 'cancelled' });
    } finally {
      stopping.delete(op);
      // Another process recorded its end while this one cancelled it, as the runtime a prompt was resent to does when it
      // sees the agent stop: this cancel answers with that end, since teamai waits for one, and the follow here sends none.
      const recorded = ledger.endsOf(op) === endsBefore ? journal.prompt(op) : undefined;

      if (recorded && recorded.kind !== 'refused' && recorded.outcome) {
        waiting.delete(op);
        send(recorded.outcome);
      }
    }

    following?.stop();
  }

  return { send, track, settle, dispatch, cancelAgent, agentDisplay, shownOf, accept, begin, goesOn, launch, refuse, work, follow, cancel };
}

export type Conversations = ReturnType<typeof conversations>;
