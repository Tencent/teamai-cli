import { RUNTIME_PROTOCOL, RuntimeDisplaySchema, runtimeMessageSchemas, type RuntimeDisplay } from '@teamai/runtime-protocol';
import { z } from 'zod';

// ─── Runtime protocol 1, as teamai reads it ──────────────
//
//  The protocol is @teamai/runtime-protocol's: the requests teamai writes and the lines a runtime writes back, and the
//  offer a runtime makes at `init`, which teamai reads as its driver `can`. This module reads those lines with teamai's
//  own rules: a display is read apart from its event. Any line that does not parse fails the runtime.
//

/** What a runtime showed of a place: nothing, a display, or one the run's details do not show, and why. */
export type Shown = { kind: 'none' } | { kind: 'shown'; display: RuntimeDisplay } | { kind: 'dropped'; reason: string };

/** A display is read apart from its event, so a runtime that gets it wrong loses only its display. */
const ShownSchema = z.unknown().optional().transform((raw): Shown => {
  if (raw === undefined) return { kind: 'none' };
  const parsed = RuntimeDisplaySchema.safeParse(raw);

  return parsed.success ? { kind: 'shown', display: parsed.data } : { kind: 'dropped', reason: parsed.error.issues[0]?.message ?? 'it does not parse' };
});

const { OpEvent, HandleEvent, Message } = runtimeMessageSchemas({ display: ShownSchema });

export type OpEvent = z.infer<typeof OpEvent>;

export type HandleEvent = z.infer<typeof HandleEvent>;

export type RuntimeMessage = z.infer<typeof Message>;

/** Parses one line a runtime wrote, or says why it does not parse. */
export function parseRuntimeLine(line: string): { ok: true; message: RuntimeMessage } | { ok: false; reason: string } {
  let raw: unknown;

  try {
    raw = JSON.parse(line);
  } catch {
    return { ok: false, reason: `it wrote a line that is not JSON: ${line.slice(0, 200)}` };
  }

  const parsed = Message.safeParse(raw);

  if (parsed.success) return { ok: true, message: parsed.data };
  const surplus = unknownKeys(parsed.error.issues);

  return { ok: false, reason: surplus.length > 0
    ? `it wrote ${surplus.map((key) => `"${key}"`).join(', ')}, which protocol ${RUNTIME_PROTOCOL} does not have: ${line.slice(0, 200)}`
    : `it wrote a message protocol ${RUNTIME_PROTOCOL} does not have: ${line.slice(0, 200)}` };
}

/** The keys a strict message refused, wherever the union of messages reported them. */
function unknownKeys(issues: readonly z.core.$ZodIssue[]): string[] {
  return [...new Set(issues.flatMap((issue) => {
    if (issue.code === 'unrecognized_keys') return issue.keys;

    return issue.code === 'invalid_union' ? issue.errors.flatMap((branch) => unknownKeys(branch)) : [];
  }))];
}
