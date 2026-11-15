import { WAKE_COMMAND, type OpId, type RuntimeFailure, type RuntimeMessage, type WakeRequest } from '@teamai/runtime-protocol';
import { threadLink } from './conversation.js';
import type { Serving, Session } from './runtime.js';
import { DRIVER_NAMES, toolOf } from './sessions.js';
import { T3Error, type EnvironmentLink, type Launch, type Project, type StepMode, type T3 } from './t3.js';
import { repositoryKey } from '@teamai/runtime-kit/repository';
import { codexWakeLine } from '@teamai/runtime-kit/wake';

// ─── Waking a fleet member ───
//
//  A wake launches a thread on another machine linked to this T3 Code: the first linked environment that answers and
//  has a project of the run's repository. The thread's first message is teamai's command to take one attempt of the
//  pool, then to end. The runtime launches it and forgets it: the person finds it in that machine's T3 Code, and stops
//  it there. The launch names the thread the run started in, when it did, as `delegatedFrom`; T3 Code 0.1.8 takes it
//  and records no parent for the woken thread.
//

/** What every woken member is told last, so its thread ends once its one attempt is done. */
export const END_OF_WAKE = 'When that one attempt is done, or nothing is left to claim, end: take no other work in this thread.';

/** What the person adds so a wake finds a machine. */
const NEXT_STEP = 'Link a machine in T3 Code, and add the repository there as a project.';

/** What the person does while T3 Code has linked environments off, which they are until turned on in its Labs settings. */
const TURN_ON = 'Turn on Linked environments in T3 Code\'s Labs settings, link the machine, and add the repository there as a project.';

/** The Claude permission rule that lets a member run teamai's wake command without asking: a prefix rule on it. */
const RESUME_ALLOW_RULE = `Bash(${WAKE_COMMAND}:*)`;

/** The mode a woken member launches in, and the line its message starts with, when that mode asks first. */
type MemberMode = { runtimeMode: StepMode; firstLine: string | undefined };

/**
 * How a woken member runs, and the line its message starts with. Never full access: nobody chose it for that machine.
 * In Auto, T3 runs teamai's command without asking; a stricter mode asks first, so the line says what to approve. Codex
 * runs it in its sandbox in every mode, which teamai's command cannot work in, so its line says to run it outside.
 */
function memberMode(mode: StepMode | undefined, { tool, pool }: { tool: string | undefined; pool: string }): MemberMode {
  const codex = tool === 'codex' ? codexWakeLine(pool) : undefined;

  switch (mode) {
    case undefined:
    case 'auto':
    case 'full-access':
      return { runtimeMode: 'auto', firstLine: codex };
    case 'approval-required':
      return { runtimeMode: mode, firstLine: codex ?? asksFirst('Supervised') };
    case 'auto-accept-edits':
      return { runtimeMode: mode, firstLine: codex ?? asksFirst('Auto-accept edits') };
    default: {
      const unhandled: never = mode;

      return unhandled;
    }
  }
}

function asksFirst(label: string): string {
  return `This thread runs in ${label} mode, so it asks before it runs teamai's command below: approve that command, or allow it on this machine with the permission rule ${RESUME_ALLOW_RULE} in this checkout's .claude/settings.local.json.`;
}

/** Whether `project` is a checkout of the repository `key`. */
function isOf(project: Project, key: string): boolean {
  return !project.deletedAt && project.repositoryIdentity?.canonicalKey.toLowerCase() === key;
}

/**
 * Whether `init` offers `wake`: this T3 Code has linked environments, on or off in its Labs settings. With them off, a
 * wake fails saying how to turn them on, when the person uses it.
 */
export async function canWake(t3: T3): Promise<boolean> {
  try {
    await t3.environmentLinks();

    return true;
  } catch (error) {
    return error instanceof T3Error && error.linkedEnvironmentsOff;
  }
}

/**
 * The model a member starts on in `project` of `link`: the project's default, else the first model of a tool this
 * runtime runs; and the teamai tool its provider instance is, when teamai can tell.
 */
async function memberModel(t3: T3, link: EnvironmentLink, project: Project): Promise<{ modelSelection: Launch['modelSelection']; tool: string | undefined } | undefined> {
  // With the project's default, the providers only say which tool it is: a machine that cannot list them still wakes.
  const providers = project.defaultModelSelection ? await t3.providers(link.environmentId).catch(() => []) : await t3.providers(link.environmentId);

  const toolOfInstance = (instanceId: string): string | undefined => {
    // T3 names each provider instance it ships after its driver, so an unlisted one is still known by its id.
    const driver = providers.find((one) => one.providerInstanceId === instanceId)?.driverKind ?? instanceId;

    return toolOf(driver);
  };

  if (project.defaultModelSelection) return { modelSelection: project.defaultModelSelection, tool: toolOfInstance(project.defaultModelSelection.instanceId) };

  for (const driver of DRIVER_NAMES) {
    const provider = providers.find((one) => one.driverKind === driver && (one.constraints ?? []).length === 0);
    const model = provider?.models[0]?.id;

    if (provider && model) return { modelSelection: { instanceId: provider.providerInstanceId, model }, tool: toolOf(driver) };
  }

  return undefined;
}

/** How a wake ended: its thread launched, why not, or cancelled by teamai before the launch went out. */
type Ended = { kind: 'woken'; message: Extract<RuntimeMessage, { event: 'woken' }> } | { kind: 'failed'; failure: RuntimeFailure } | { kind: 'cancelled' };

/** A wake under way in this process: still looking for a machine, its launch sent, or cancelled by teamai before that. */
interface Waking { state: 'looking' | 'launched' | 'cancelled' }

/** Whether teamai cancelled `waking`, which a cancel may do while the wake awaits T3. */
const isCancelled = (waking: Waking): boolean => waking.state === 'cancelled';

/** The wakes of a runtime process: each launches one thread at most, and a cancel ends one that has not launched. */
export function wakes({ serving }: { serving: Serving }) {
  const { options, ledger, write, fail } = serving;
  const under = new Map<OpId, Waking>();
  /** How each wake of this process ended, which a repeated op is answered with again. */
  const ends = new Map<OpId, Ended>();

  const unavailable = (message: string): RuntimeFailure => ({ code: 'wake_unavailable', message });

  /** The environment and project the member runs in, or why no linked machine can run it. */
  const where = async (t3: T3, request: WakeRequest): Promise<{ ok: true; link: EnvironmentLink; project: Project } | { ok: false; failure: RuntimeFailure }> => {
    const key = repositoryKey(request.repository);

    if (!key) return { ok: false, failure: unavailable(`teamai cannot tell which repository ${request.repository} names, so it cannot find a machine that has it.`) };
    let links: EnvironmentLink[];

    try {
      links = await t3.environmentLinks();
    } catch (error) {
      if (error instanceof T3Error && error.linkedEnvironmentsOff) return { ok: false, failure: unavailable(`Linked environments is off in T3 Code, so it reaches no other machine. ${TURN_ON}`) };

      return { ok: false, failure: unavailable(`T3 Code did not list the machines linked to it (${(error instanceof Error ? error.message : String(error)).replace(/\.$/, '')}). ${NEXT_STEP}`) };
    }

    const checked: string[] = [];

    for (const link of links) {
      if (link.status !== 'reachable') {
        checked.push(`${link.label} is ${link.status}`);
        continue;
      }

      const project = await t3.projects(link.environmentId).then((listed) => listed.find((one) => isOf(one, key)), () => undefined);

      if (project) return { ok: true, link, project };
      checked.push(`${link.label} has no project of it`);
    }

    const seen = checked.length > 0 ? ` (${checked.join('; ')})` : ', since none is linked';

    return { ok: false, failure: unavailable(`No machine linked to T3 Code has ${request.repository} as a project${seen}. ${NEXT_STEP}`) };
  };

  /** The thread the run started in, as T3 shows a thread delegated from it, when it can read its title. */
  const delegatedFrom = async (s: Session): Promise<Launch['delegatedFrom']> => {
    if (!options.startedFrom) return undefined;
    const { startedFrom } = options;
    const title = await s.t3.thread(startedFrom).then((thread) => thread.title, () => undefined);

    return title === undefined ? undefined : { environmentId: s.environment.environmentId, threadId: startedFrom, title };
  };

  const launch = async (s: Session, request: WakeRequest, waking: Waking): Promise<Ended> => {
    const found = await where(s.t3, request);

    if (isCancelled(waking)) return { kind: 'cancelled' };

    if (!found.ok) return { kind: 'failed', failure: found.failure };
    const { link, project } = found;
    // Either fails the wake as a whole.
    const [member, from] = await Promise.all([memberModel(s.t3, link, project), delegatedFrom(s)]);

    if (!member) return { kind: 'failed', failure: unavailable(`${link.label} runs no Claude or Codex provider instance a member can start on. Enable one in T3 Code there, under Settings → Providers.`) };
    const title = request.title.includes(request.pool) ? request.title : `${request.title} · ${request.pool}`;

    if (isCancelled(waking)) return { kind: 'cancelled' };
    waking.state = 'launched';

    const { modelSelection } = member;
    const { runtimeMode, firstLine } = memberMode(s.runtimeMode, { tool: member.tool, pool: request.pool });
    const message = [firstLine, request.message, END_OF_WAKE].filter((line) => line !== undefined).join('\n\n');

    let launched: Awaited<ReturnType<T3['launch']>>;

    try {
      launched = await s.t3.launch({
        title, message, projectId: project.id, workspace: { type: 'root' }, environmentId: link.environmentId,
        modelSelection, runtimeMode, clientRequestId: request.op, ...(from && { delegatedFrom: from }),
      });
    } catch (error) {
      // Only a check a new launch runs proves T3 launched nothing.
      if (error instanceof T3Error && error.launchedNothing) throw error;

      // The call timed out, its reply was lost, or T3 failed it after the launch may have gone out: a thread may run there now.
      return { kind: 'failed', failure: unavailable(`T3 Code may have launched the member on ${link.label} before the call failed: ${(error instanceof Error ? error.message : String(error)).replace(/\.$/, '')}. Check the thread list of ${link.label} in T3 Code for "${title}" before waking again.`) };
    }

    return {
      kind: 'woken',
      message: {
        op: request.op, event: 'woken', where: link.label,
        display: { label: title.slice(0, 80), url: threadLink(link, launched.threadId), fields: { thread: launched.threadId.slice(0, 200), environment: link.label } },
      },
    };
  };

  /** Writes how `op`'s wake ended, as often as teamai asks. */
  const answer = (op: OpId, ended: Ended): void => {
    switch (ended.kind) {
      case 'woken':
        return write(ended.message);
      case 'failed':
        return fail(op, ended.failure);
      case 'cancelled':
        return ledger.end({ op, state: 'cancelled' });
      default: {
        const unhandled: never = ended;

        return unhandled;
      }
    }
  };

  const wake = async (request: WakeRequest): Promise<void> => {
    write({ op: request.op, event: 'accepted' });
    const ended = ends.get(request.op);

    // A wake this process answered, or one it runs, launched or launches its one thread.
    if (ended) return answer(request.op, ended);

    if (under.has(request.op)) return;
    const session = serving.session();

    if (!session) return fail(request.op, { code: 'runtime_protocol', message: 'wake came before a successful init.' });
    const waking: Waking = { state: 'looking' };
    under.set(request.op, waking);
    let outcome: Ended;

    try {
      outcome = await launch(session, request, waking);
    } catch (error) {
      // A cancel ended it already: its end stands.
      outcome = isCancelled(waking) ? { kind: 'cancelled' } : { kind: 'failed', failure: unavailable(`T3 Code did not launch the member on the linked machine: ${(error instanceof Error ? error.message : String(error)).replace(/\.$/, '')}. ${NEXT_STEP}`) };
    } finally {
      under.delete(request.op);
    }

    // A cancel ended it already, whatever the lookup it cut short found.
    if (ends.get(request.op)?.kind === 'cancelled') return;
    ends.set(request.op, outcome);
    answer(request.op, outcome);
  };

  /**
   * Ends a wake of this process that has not launched cancelled, answers one that ended with its end again, and says
   * whether `op` is a wake here. A wake whose launch went out ends with that launch.
   */
  const cancel = (op: OpId): boolean => {
    const waking = under.get(op);
    const ended = ends.get(op);

    if (ended) {
      answer(op, ended);

      return true;
    }

    if (!waking) return false;

    if (waking.state === 'looking') {
      waking.state = 'cancelled';
      ends.set(op, { kind: 'cancelled' });
      ledger.end({ op, state: 'cancelled' });
    }

    return true;
  };

  return { wake, cancel };
}
