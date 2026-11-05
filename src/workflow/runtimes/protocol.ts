import { z } from 'zod';
import { CanSchema } from '../requirements.js';
import type { RunMode } from '../../launch-context.js';
import { OpIdSchema, OpStateSchema, RuntimeFailureSchema, RuntimeHandleSchema, type ExecRequest, type OpenRequest, type OpId, type RuntimeOptions } from './step-runtime.js';

// ─── Runtime protocol 1 ──────────────────────────────────
//
//  JSON lines over stdio between teamai and an external step runtime. teamai writes requests to the runtime's stdin,
//  one per line ({"type":"init"|"open"|"exec"|"cancel"|"collect"|"reattach"|"close", ...}); the runtime writes replies
//  and events to its stdout. This module parses what the runtime writes. Any line that does not parse fails the runtime.
//
//    > {"type":"init","protocol":1,"mode":"unattended","options":{...}}
//    < {"type":"init","ok":true,"can":{...}}
//    > {"type":"open","op":"op-7f2a…","run":"r…","attempt":"a…","view":{...},"credentials":{}}
//    < {"op":"op-7f2a…","event":"accepted","handle":"toy-r…-a…"}
//    < {"op":"op-7f2a…","event":"ready"}
//    > {"type":"exec","op":"op-8b10…","handle":"…","argv":[...],"env":{...},"unset":[...],"cwd":"…"}
//    < {"op":"op-8b10…","event":"accepted"}
//    < {"op":"op-8b10…","event":"output","stream":"stdout","data":"…"}
//    < {"op":"op-8b10…","event":"exited","code":0,"stdout":"…complete stdout…"}
//    > {"type":"collect","handle":"…"}              < {"event":"collected","handle":"…"}
//    > {"type":"reattach","handle":"…"}             < {"event":"alive","handle":"…","ops":[...]} or {"event":"gone",…}
//    > {"type":"close","handle":"…"}                < {"event":"closed","handle":"…"}
//    > {"type":"cancel","op":"op-8b10…"}            the exec then ends {"op":"op-8b10…","event":"cancelled"}
//

export const RUNTIME_PROTOCOL = 1;

/** A request teamai writes to a runtime's stdin. */
export type RuntimeRequest =
  | { type: 'init'; protocol: typeof RUNTIME_PROTOCOL; mode: RunMode; options: RuntimeOptions }
  | ({ type: 'open' } & OpenRequest)
  | ({ type: 'exec' } & ExecRequest)
  | { type: 'cancel'; op: OpId }
  | { type: 'collect' | 'reattach' | 'close'; handle: string };

const InitReplySchema = z.discriminatedUnion('ok', [
  z.object({ type: z.literal('init'), ok: z.literal(true), can: CanSchema }),
  z.object({ type: z.literal('init'), ok: z.literal(false), error: RuntimeFailureSchema }),
]);

const OpEventSchema = z.discriminatedUnion('event', [
  z.object({ op: OpIdSchema, event: z.literal('accepted'), handle: RuntimeHandleSchema.optional() }),
  z.object({ op: OpIdSchema, event: z.literal('ready') }),
  z.object({ op: OpIdSchema, event: z.literal('failed'), failure: RuntimeFailureSchema }),
  z.object({ op: OpIdSchema, event: z.literal('output'), stream: z.enum(['stdout', 'stderr']), data: z.string() }),
  z.object({ op: OpIdSchema, event: z.literal('exited'), code: z.number().int(), stdout: z.string() }),
  z.object({ op: OpIdSchema, event: z.literal('cancelled') }),
]);

export type OpEvent = z.infer<typeof OpEventSchema>;

const HandleEventSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('collected'), handle: RuntimeHandleSchema }),
  z.object({ event: z.literal('collect_failed'), handle: RuntimeHandleSchema, failure: RuntimeFailureSchema }),
  z.object({ event: z.literal('alive'), handle: RuntimeHandleSchema, ops: z.array(OpStateSchema) }),
  z.object({ event: z.literal('gone'), handle: RuntimeHandleSchema }),
  z.object({ event: z.literal('closed'), handle: RuntimeHandleSchema }),
]);

export type HandleEvent = z.infer<typeof HandleEventSchema>;

/** A line a runtime wrote: a reply to `init`, an event of an operation, a reply about a handle, or a protocol error. */
export const RuntimeMessageSchema = z.union([
  InitReplySchema,
  OpEventSchema,
  HandleEventSchema,
  z.object({ event: z.literal('error'), message: z.string() }),
]);

export type RuntimeMessage = z.infer<typeof RuntimeMessageSchema>;

/** Parses one line a runtime wrote, or says why it does not parse. */
export function parseRuntimeLine(line: string): { ok: true; message: RuntimeMessage } | { ok: false; reason: string } {
  let raw: unknown;

  try {
    raw = JSON.parse(line);
  } catch {
    return { ok: false, reason: `it wrote a line that is not JSON: ${line.slice(0, 200)}` };
  }

  const parsed = RuntimeMessageSchema.safeParse(raw);

  return parsed.success ? { ok: true, message: parsed.data } : { ok: false, reason: `it wrote a message protocol ${RUNTIME_PROTOCOL} does not have: ${line.slice(0, 200)}` };
}
