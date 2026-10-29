/** JSON responses shared by session and scoring commands. */
export type CommandEnvelope = { data: Record<string, unknown> } | { error: { code: string; message: string; labels?: Array<Record<string, unknown>> } };
export function error(code: string, message: string): Extract<CommandEnvelope, { error: unknown }> { return { error: { code, message } }; }
export function ok(data: Record<string, unknown>): CommandEnvelope { return { data }; }
