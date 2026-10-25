/**
 * `runs/<run>/journal.jsonl`, beside skill.json: a line for each `--driver skill` call a session makes on a run, and
 * one for each dispatch or person action the first turn that shows it asks for, so what the agents did can be read
 * back after the run. It holds ids, answer codes and choices: never an env value, an input or a session id. No turn
 * prints it. A describe, a start the protocol refused, and a runner's report have no line: the first two have no run,
 * and a runner is TeamAI's own process, whose work shows as skill.json's events.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { readFileSafe } from '../../../utils/fs.js';
import { redactJson } from '../../../utils/redact.js';
import { AttemptIdSchema, skillStatePath, type RunId } from '../../store.js';
import type { SkillCall, SkillContext } from './skill-driver.js';
import { readSkillState } from './skill-state.js';
import { TICK_LOCK_WAIT_MS } from './tick.js';
import type { Action, SkillAnswer } from './turn.js';

const CallLineSchema = z.object({
  at: z.string(),
  kind: z.literal('call'),
  /** The call: `poll` is `next --wait`, `unavailable` is `report --model-unavailable`. */
  call: z.enum(['start', 'resume', 'next', 'poll', 'takeover', 'choose', 'ack', 'adopt', 'respond', 'report', 'unavailable']),
  /** `orchestrator`: the session that drives the run made it; `session`: another session; `none`: a host that names no session. */
  by: z.enum(['orchestrator', 'session', 'none']),
  /** Whether it ran from the checkout the run started in, as the orchestrator does: a child that shares its session runs from its own place. */
  inCheckout: z.boolean(),
  attempt: AttemptIdSchema.optional(),
  step: z.string().optional(),
  /** The host question's option, or the gate's. */
  choice: z.string().optional(),
  /** The error code; for an ack `acked`, for a report what its runner answer says (`reported`, `repeated`, ...); else `ok`. */
  answer: z.string(),
});
const AskedDispatchSchema = z.object({ at: z.string(), kind: z.literal('asked'), action: z.literal('dispatch'), attempt: AttemptIdSchema, step: z.string() });
const AskedApprovalSchema = z.object({ at: z.string(), kind: z.literal('asked'), action: z.literal('approval'), step: z.string(), pass: z.number().int() });
const AskedHandoffSchema = z.object({ at: z.string(), kind: z.literal('asked'), action: z.literal('handoff') });
const JournalLineSchema = z.union([CallLineSchema, AskedDispatchSchema, AskedApprovalSchema, AskedHandoffSchema]);
type JournalLine = z.infer<typeof JournalLineSchema>;
type CallLine = z.infer<typeof CallLineSchema>;
type AskedLine = Exclude<JournalLine, CallLine>;

function journalPath(context: SkillContext, run: RunId): string {
  return path.join(path.dirname(skillStatePath(context.config, run)), 'journal.jsonl');
}

/** What identifies an asked action, so a later turn that shows it again adds no line. */
function askedKey(line: AskedLine): string {
  switch (line.action) {
    case 'dispatch':
      return `dispatch ${line.attempt}`;
    case 'approval':
      return `approval ${line.step} ${line.pass}`;
    case 'handoff':
      return 'handoff';
    default: {
      const unhandled: never = line;
      return unhandled;
    }
  }
}

function askedOf(action: Action, at: string): AskedLine | undefined {
  switch (action.kind) {
    case 'dispatch':
      return { at, kind: 'asked', action: 'dispatch', attempt: action.attempt, step: action.step };
    case 'person':
      return action.why === 'approval' ? { at, kind: 'asked', action: 'approval', step: action.step, pass: action.pass } : { at, kind: 'asked', action: 'handoff' };
    case 'choose':
    case 'stop':
    case 'place':
    case 'done':
      return undefined;
    default: {
      const unhandled: never = action;
      return unhandled;
    }
  }
}

/** The line of `call`, or none for a call that journals none. */
function callLine(call: SkillCall, answer: SkillAnswer, input: Pick<CallLine, 'at' | 'by' | 'inCheckout'>): CallLine | undefined {
  const base = { ...input, kind: 'call' as const };
  const code = 'error' in answer ? answer.error.code : undefined;
  switch (call.kind) {
    case 'describe':
      return undefined;
    case 'start':
    case 'resume':
    case 'takeover':
      return { ...base, call: call.kind, answer: code ?? 'ok' };
    case 'next':
      return { ...base, call: call.wait ? 'poll' : 'next', answer: code ?? 'ok' };
    case 'choose':
      return { ...base, call: 'choose', choice: call.choice, answer: code ?? 'ok' };
    case 'ack':
      return { ...base, call: 'ack', attempt: call.attempt, answer: code ?? 'acked' };
    case 'adopt':
      return { ...base, call: 'adopt', attempt: call.attempt, answer: code ?? 'ok' };
    case 'respond':
      return { ...base, call: 'respond', step: call.step, choice: call.choice, answer: code ?? 'ok' };
    case 'report': {
      if (call.role === 'runner') return undefined;
      const status = 'data' in answer && 'runner' in answer.data ? answer.data.runner.status : 'ok';
      return { ...base, call: call.modelUnavailable ? 'unavailable' : 'report', attempt: call.attempt, answer: code ?? status };
    }
    default: {
      const unhandled: never = call;
      return unhandled;
    }
  }
}

/** The keys of the actions the journal at `file` records as asked already. */
async function askedKeys(file: string): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const text of (await readFileSafe(file))?.split('\n') ?? []) {
    if (text.trim() === '') continue;
    try {
      const line = JournalLineSchema.safeParse(JSON.parse(text));
      if (line.success && line.data.kind === 'asked') keys.add(askedKey(line.data));
    } catch {
      // A torn last line from a process that died mid-append records nothing.
    }
  }
  return keys;
}

/** The journal lines of `entries`, masked with `secrets`: a rejected argument may hold a secret value. */
const lines = (entries: JournalLine[], secrets: Record<string, string>): string => entries.map((entry) => `${JSON.stringify(redactJson(entry, secrets))}\n`).join('');

/**
 * Appends the line of `call`, then a line for each dispatch or person action `answer`'s turn shows that the journal
 * has not asked for yet. Only a run with skill.json has a journal. Under the run lock, so two calls that show the same
 * new action record it once; when the lock stays busy, only the call's line is written, and the next turn that shows
 * the action records it.
 */
export async function journalCall(context: SkillContext, call: SkillCall, answer: SkillAnswer): Promise<void> {
  const run = call.kind === 'start' ? ('data' in answer && 'turn' in answer.data ? answer.data.turn.run : undefined) : call.kind === 'describe' ? undefined : call.run;
  if (run === undefined) return;
  const read = await readSkillState(context.config, run);
  if (read.kind !== 'found') return;
  const { state } = read;
  const at = context.now().toISOString();
  const by = context.session === undefined ? 'none' : state.orchestrator.session === context.session ? 'orchestrator' : 'session';
  const inCheckout = path.resolve(context.cwd) === state.driver.workspace;
  const line = callLine(call, answer, { at, by, inCheckout });
  if (line === undefined) return;
  const file = journalPath(context, run);
  const actions = 'data' in answer && 'turn' in answer.data ? answer.data.turn.actions : [];
  const taken = await context.locks.take(run, async () => {
    const asked = await askedKeys(file);
    const fresh = actions.flatMap((action) => {
      const entry = askedOf(action, at);
      if (entry === undefined || asked.has(askedKey(entry))) return [];
      asked.add(askedKey(entry));
      return [entry];
    });
    await fs.appendFile(file, lines([line, ...fresh], context.env.secrets));
  }, TICK_LOCK_WAIT_MS);
  switch (taken.kind) {
    case 'held':
      return;
    case 'busy':
      await fs.appendFile(file, lines([line], context.env.secrets));
      return;
    default: {
      const unhandled: never = taken;
      return unhandled;
    }
  }
}
