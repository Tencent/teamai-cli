import type { PaseoAgentConfig } from '@getpaseo/client';
import { WAKE_COMMAND, type OpId, type RuntimeFailure, type RuntimeMessage, type WakeRequest } from '@teamai/runtime-protocol';
import { agentIdOf } from './conversation.js';
import type { Daemon } from './daemon/connect.js';
import type { Host } from './daemon/host.js';
import type { ProcessState } from './process-state.js';
import type { PaseoTool } from './providers.js';
import { repositoryKey } from '@teamai/runtime-kit/repository';
import { codexWakeLine } from '@teamai/runtime-kit/wake';

// ─── Waking a fleet member ───────────────────────────────
//
//  A wake starts an agent on another machine's Paseo: the first host the member saved on this daemon (`paseo host add`)
//  that answers and has a workspace of the run's repository. The agent's first prompt is teamai's command to take one
//  attempt of the pool, then to end. The runtime starts it and forgets it: the person finds it in that host's Paseo,
//  titled with the run and the pool, and stops it there.
//

/** What every woken member is told last, so its agent ends once its one attempt is done. */
export const END_OF_WAKE = 'When that one attempt is done, or nothing is left to claim, end: take no other work in this agent.';

/**
 * What a woken agent may run without asking, in the mode Paseo starts it in: teamai's command, by the tool's own rule,
 * and nothing else. Claude's default mode and OpenCode's asked before running it (recorded). Codex takes no rule for one
 * command, and runs it in its sandbox, so its first prompt tells it to run the command outside (`codexWakeLine`).
 */
const WAKE_ALLOWS: Readonly<Record<PaseoTool, PaseoAgentConfig['options']>> = {
  claude: { allowedTools: [`Bash(${WAKE_COMMAND}:*)`] },
  codex: undefined,
  opencode: { permission: { bash: { [`${WAKE_COMMAND} *`]: 'allow' } } },
};

/** What the person adds so a wake finds a machine. */
const NEXT_STEP = 'Add the machine with `paseo host add <host:port>`, and open a checkout of the repository in Paseo there.';

/** How a wake ended: its agent started, why not, or cancelled by teamai before the start went out. */
type Ended = { kind: 'woken'; message: Extract<RuntimeMessage, { event: 'woken' }> } | { kind: 'failed'; failure: RuntimeFailure } | { kind: 'cancelled' };

/** A wake under way in this process: still looking for a host, its create sent, or cancelled by teamai before that. */
interface Waking { state: 'looking' | 'launched' | 'cancelled' }

/** Whether teamai cancelled `waking`, which a cancel may do while the wake awaits Paseo. */
const isCancelled = (waking: Waking): boolean => waking.state === 'cancelled';

const unavailable = (message: string): RuntimeFailure => ({ code: 'wake_unavailable', message });

/** The wakes of a runtime process: each starts one agent at most, and a cancel ends one that has not started it. */
export function wakes({ ledger, write, fail }: Pick<ProcessState, 'ledger' | 'write' | 'fail'>) {
  const under = new Map<OpId, Waking>();
  /** How each wake of this process ended, which a repeated op is answered with again. */
  const ends = new Map<OpId, Ended>();

  /** Starts the member on the first saved host that has the repository, or says why none could take it. */
  const launch = async (live: Daemon, request: WakeRequest, waking: Waking): Promise<Ended> => {
    const key = repositoryKey(request.repository);

    if (!key) return { kind: 'failed', failure: unavailable(`teamai cannot tell which repository ${request.repository} names, so it cannot find a machine that has it.`) };
    const checked: string[] = [];

    for (const saved of await live.hosts()) {
      if (isCancelled(waking)) return { kind: 'cancelled' };

      if (saved.status !== 'online' || saved.serverId === null) {
        checked.push(`${saved.label} is ${saved.status}`);
        continue;
      }

      let host: Host | undefined;

      try {
        host = await live.host(saved.serverId);
        const workspace = await host.checkoutOf((origin) => repositoryKey(origin) === key);

        if (!workspace) {
          checked.push(`${saved.label} has no workspace of it`);
          continue;
        }

        const member = await host.memberProvider();

        if (!member) {
          checked.push(`${saved.label} runs none of Claude, Codex or OpenCode`);
          continue;
        }

        if (isCancelled(waking)) return { kind: 'cancelled' };
        const title = request.title.includes(request.pool) ? request.title : `${request.title} · ${request.pool}`;
        const agentId = agentIdOf(request.op);
        waking.state = 'launched';
        const options = WAKE_ALLOWS[member.tool];
        const prompt = `${member.tool === 'codex' ? `${codexWakeLine(request.pool)}\n\n` : ''}${request.message}\n\n${END_OF_WAKE}`;
        await host.launch({ workspace, agentId, title, prompt, provider: member.provider, options, labels: { 'teamai-pool': request.pool } });

        return {
          kind: 'woken',
          message: { op: request.op, event: 'woken', where: saved.label, display: { label: title.slice(0, 80), url: host.link(agentId), fields: { agent: agentId, host: saved.label } } },
        };
      } catch (error) {
        const why = (error instanceof Error ? error.message : String(error)).replace(/\.$/, '');

        // One whose start went out may have started the member: no other host gets a second one.
        if (waking.state === 'launched') return { kind: 'failed', failure: unavailable(`Paseo on ${saved.label} did not confirm the member's agent (${why}); look for it in Paseo there before the run wakes another.`) };
        checked.push(`${saved.label} did not answer (${why})`);
      } finally {
        await host?.close().catch(() => {});
      }
    }

    const seen = checked.length > 0 ? ` (${checked.join('; ')})` : ', since none is saved';

    return { kind: 'failed', failure: unavailable(`No Paseo host saved on this machine has a workspace of ${request.repository}${seen}. ${NEXT_STEP}`) };
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

  /** Answers a wake on the daemon `live`: once per op in this process, and again with how it ended for a repeat. */
  const wake = async (live: Daemon, request: WakeRequest): Promise<void> => {
    write({ op: request.op, event: 'accepted' });
    const ended = ends.get(request.op);

    if (ended) return answer(request.op, ended);

    if (under.has(request.op)) return;
    const waking: Waking = { state: 'looking' };
    under.set(request.op, waking);
    let outcome: Ended;

    try {
      outcome = await launch(live, request, waking);
    } catch (error) {
      const why = (error instanceof Error ? error.message : String(error)).replace(/\.$/, '');
      outcome = { kind: 'failed', failure: unavailable(`This Paseo daemon did not list the hosts saved on it (${why}). ${NEXT_STEP}`) };
    } finally {
      under.delete(request.op);
    }

    // A cancel ended it already.
    if (ends.get(request.op)?.kind === 'cancelled') return;
    ends.set(request.op, outcome);
    answer(request.op, outcome);
  };

  /**
   * Ends a wake of this process that has not started its agent cancelled, answers one that ended with its end again, and
   * says whether `op` is a wake here. A wake whose start went out ends with that start.
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
