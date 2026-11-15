import type { RuntimeFailure, RuntimeOptions } from '@teamai/runtime-protocol';
import { z } from 'zod';
import { STEP_MODES } from './t3.js';

// ─── Options, as a driver definition passes them at `init` ───
//
//  A `bad_option` message ends without a period: teamai quotes it inside its own sentence.
//
//    runtimes:
//      - use: t3
//        options:
//          environment: local               # the T3 Code server on this machine
//          instance: claude-work            # optional: every prompt on this provider instance
//          instances: { acme-claude: acme-claude-t3 }   # optional: the provider instance of a tool or tool instance
//          runtime_mode: auto-accept-edits  # optional: auto, auto-accept-edits, approval-required or full-access
//
//  teamai reads `credentials` and `max_parallel` itself and never passes them here.
//

const OptionsSchema = z.object({
  /**
   * The T3 environment the threads run in: `local`, the T3 Code server on this machine, and no other, since a step's first
   * message names this machine's paths (`firstMessage` in conversation.ts).
   */
  environment: z.literal('local'),
  /** A T3 provider instance to run every prompt on, by its id in T3 Settings → Providers; the tool's default one otherwise. */
  instance: z.string().min(1).optional(),
  /** The T3 provider instance that runs each teamai tool or tool instance, by name; a tool instance is otherwise found by its Binary path. */
  instances: z.record(z.string().min(1), z.string().min(1)).optional(),
  /**
   * The mode every step thread runs in, in place of the member's T3 default. `full-access` is the member's explicit
   * opt-in: threads run without asking, the sign-in asks for Full access, and every tool offered is reported so.
   */
  runtime_mode: z.enum(STEP_MODES).optional(),
}).strict();

export type T3Options = z.infer<typeof OptionsSchema>;

/** Parses a definition's options, or says which key is wrong and why. */
export function parseOptions(raw: RuntimeOptions): { ok: true; options: T3Options } | { ok: false; failure: RuntimeFailure } {
  const parsed = OptionsSchema.safeParse(raw);

  if (parsed.success) return { ok: true, options: parsed.data };
  const issue = parsed.error.issues[0];
  const key = issue?.code === 'unrecognized_keys' ? issue.keys[0] : issue?.path[0]?.toString();

  const message = key === 'runtime_mode'
    ? `runtime_mode ${JSON.stringify(raw['runtime_mode'])} is not one runtime t3 takes. A step thread runs in the member's T3 default mode, or auto, never full access unless runtime_mode says so; runtime_mode sets it to auto, auto-accept-edits, approval-required or full-access. Remove it, or set one of those four`
    : key === 'environment' && raw['environment'] !== undefined
      ? `environment ${JSON.stringify(raw['environment'])} is not one runtime t3 runs steps in. It launches a step's thread only in environment: local, the T3 Code on this machine, because the thread's first message names this machine's paths, such as the run's scratch directory and the workflow's folder, which a linked environment does not have. Set environment: local, or offer the step to another machine with a fleet entry whose wake uses t3`
      : `Runtime t3 takes { environment: local, instance?, instances?, runtime_mode? }: ${issue?.message ?? 'bad options'}`;

  return { ok: false, failure: { code: 'bad_option', message, ...(key && { key }) } };
}
