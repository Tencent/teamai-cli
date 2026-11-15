import { z } from 'zod';
import { answered, failed, jsonLines, reportedTokens, type CallOutput, type CallReading, type LaunchAdapter } from '@teamai/tool-core/launch';


const OpenClawEnvelope = z.object({
  ok: z.boolean(),
  final: z.string().optional(),
  usage: z.object({ input: z.number().optional(), output: z.number().optional() }).optional(),
  error: z.object({ message: z.string() }).optional(),
});

/** `openclaw agent exec --json` prints one envelope: `final` is the answer, `usage` the tokens, `error` the failure. */
function readOpenClawExec({ stdout }: CallOutput): CallReading {
  let candidate: unknown;

  try { candidate = JSON.parse(stdout.trim()); } catch { candidate = jsonLines(stdout).at(-1); }

  const parsed = OpenClawEnvelope.safeParse(candidate);

  if (!parsed.success) return { ok: false };
  const { ok, final, usage, error } = parsed.data;

  if (!ok || !final?.trim()) return failed(error?.message);

  return answered(final.trim(), reportedTokens({ input: usage?.input, output: usage?.output }));
}

/** How teamai launches OpenClaw headless. */
export const launch = {
  // One embedded turn with ephemeral state, so no call leaves a session in the member's conversations (#1308):
  // after calls on OpenClaw 2026.8.1 (the first with `agent exec`) and 2026.10.9, `openclaw sessions --all-agents --json` counts 0.
  openclaw: {
    call: { evidence: 'verified', prompt: 'stdin', args: () => ['agent', 'exec', '--json', '--message-file', '-'], read: readOpenClawExec },
  },
} as const satisfies Record<string, LaunchAdapter>;
