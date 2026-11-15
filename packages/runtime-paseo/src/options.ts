import type { RuntimeFailure, RuntimeOptions } from '@teamai/runtime-protocol';
import { z } from 'zod';
import { isPaseoTool } from './providers.js';

const OptionsSchema = z.object({
  /** The daemon's WebSocket address, for a daemon Paseo's own config on this machine does not name (`daemonUrl`). */
  url: z.string().regex(/^(?:wss?|ws\+unix):\/\/\S+$/, 'The Paseo url is a ws://, wss:// or ws+unix:// address, such as ws://127.0.0.1:6767/ws').optional(),
  /**
   * The Paseo mode each tool's agents start in, over Paseo's default. A mode that never asks, such as Claude's
   * bypassPermissions, is the member's explicit opt-in to full access, which init reports in `permissions`.
   */
  mode: z.record(z.string().refine(isPaseoTool, 'mode maps claude, codex or opencode to a Paseo mode'), z.string().min(1)).optional(),
  /**
   * The Paseo provider id a tool or a team instance runs on, over the one the runtime finds: for an instance, the custom
   * provider that runs its command, or for one with only a home, its tool in that home.
   */
  providers: z.record(z.string().min(1), z.string().min(1)).optional(),
}).strict();

export type PaseoOptions = z.infer<typeof OptionsSchema>;

/** Parses a definition's options, or says which key is wrong and why. */
export function parseOptions(raw: RuntimeOptions): { ok: true; options: PaseoOptions } | { ok: false; failure: RuntimeFailure } {
  const parsed = OptionsSchema.safeParse(raw);

  if (parsed.success) return { ok: true, options: parsed.data };
  const issue = parsed.error.issues[0];
  // The option a nested issue sits under, else the unknown option itself.
  const key = issue?.path[0] ?? (issue?.code === 'unrecognized_keys' ? issue.keys[0] : undefined);

  return {
    ok: false,
    failure: { code: 'bad_option', message: `teamai-runtime-paseo takes options url, mode and providers only: ${issue?.message ?? 'bad options'}`, ...(key !== undefined && { key: String(key) }) },
  };
}
