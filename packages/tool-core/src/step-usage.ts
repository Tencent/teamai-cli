import fs from 'node:fs';
import { cannotReadBecause, FsFailureSchema, isMissing } from '@teamai/shared/fs-failure';
import { NotRegularFileError, openRegularFile } from '@teamai/shared/regular-file';
import { readClaudeJsonl } from './formats/claude-jsonl.js';
import { readCodexRollout } from './formats/codex-rollout.js';
import type { TokenUsage as ReportedTokens } from './stdout.js';
import { addTokenUsage, INTERVENTION_SCAN_MAX_BYTES, type TokenReading, type TokenSource, type TokenUsage } from './tokens.js';

/**
 * The transcript formats a runtime reads a step's tokens from, each with its reader and the tokens as the tool's own
 * end-of-run usage reports them, which is what a step that runs the tool on this machine reports. Claude Code reports no
 * tokens written to the prompt cache; Codex counts cached input inside its input tokens.
 */
const STEP_FORMATS = {
  'claude-jsonl': { read: readClaudeJsonl, reported: (tokens) => ({ input: tokens.input, output: tokens.output, cachedInput: tokens.cacheRead }) },
  'codex-rollout': { read: readCodexRollout, reported: (tokens) => ({ input: tokens.input + tokens.cacheRead + tokens.cacheCreation, output: tokens.output, cachedInput: tokens.cacheRead }) },
} satisfies Record<string, { read(source: TokenSource): Promise<TokenReading>; reported(tokens: TokenUsage): ReportedTokens }>;

export type StepTokenFormat = keyof typeof STEP_FORMATS;

/**
 * Why teamai read no tokens for a step: the cause, which is all a step that succeeded under no budget is told, and the
 * next step, which a budget that cannot count the step adds.
 */
export type Unmeasured = { cause: string; next: string };

/** The tokens a step billed, as the tool's own end-of-run usage reports them, or why teamai read none. */
export type StepUsage = { kind: 'measured'; usage: ReportedTokens } | { kind: 'unmeasured'; why: Unmeasured };

/** A turn journaled before it carried its send time, which cannot be told from the earlier steps' requests. */
export const UNTIMED_TURN: StepUsage = {
  kind: 'unmeasured',
  why: { cause: 'Its turn was sent by a teamai that did not record when it sends one, so teamai cannot tell its requests from the earlier steps\'.', next: 'Retry the step.' },
};

/** Why `transcriptPath` cannot be read whole, or undefined when it can. */
async function unreadable(transcriptPath: string): Promise<Unmeasured | undefined> {
  const transcript = `${transcriptPath}, the transcript of the step's session`;

  try {
    if ((await fs.promises.stat(transcriptPath)).size > INTERVENTION_SCAN_MAX_BYTES) {
      return { cause: `${transcript}, is over the ${INTERVENTION_SCAN_MAX_BYTES / 1024 / 1024} MiB teamai reads.`, next: 'Run the step in a new session rather than continue one this long.' };
    }

    await (await openRegularFile(transcriptPath)).close();
  } catch (error) {
    if (error instanceof NotRegularFileError) return { cause: `${error.message}.`, next: 'Retry the step.' };
    const failure = FsFailureSchema.safeParse(error);

    if (!failure.success) throw error;

    if (isMissing(failure.data)) return { cause: `teamai found no transcript at ${transcriptPath}, where the tool keeps the step's session.`, next: 'Retry the step.' };

    return { cause: `teamai cannot read ${transcript}, because ${cannotReadBecause(failure.data)}.`, next: `Let the user teamai runs as read ${transcriptPath}, then retry the step.` };
  }

  return undefined;
}

/**
 * The tokens a step billed in session `sessionId`, whose transcript in `format` is `transcriptPath`, as the tool's own
 * end-of-run usage reports them: every request of the session for a step that started it, and only those at or after
 * `turnSentAt` for a turn the step sent to an earlier step's conversation, whose session holds that step's requests too.
 * None, never zero, when the transcript cannot be read whole or records no request in that span, or, for a turn,
 * records a request without the time that would place it in or out of the turn: then why.
 */
export async function stepUsage({ format, transcriptPath, sessionId, turnSentAt }: { format: StepTokenFormat; transcriptPath: string; sessionId: string; turnSentAt?: number }): Promise<StepUsage> {
  const why = await unreadable(transcriptPath);

  if (why !== undefined) return { kind: 'unmeasured', why };
  const { read, reported } = STEP_FORMATS[format];
  // A Codex turn's usage may land just after the tool shows the turn ended, so the read waits for it as for a Stop hook.
  const { requests } = await read({ transcriptPath, sessionId, settled: false });
  const billed = requests.map((request) => ({ tokens: request.tokens, at: Date.parse(request.timestamp) }));
  const transcript = `${transcriptPath}, the transcript of the step's session`;

  if (turnSentAt !== undefined && billed.some(({ at }) => Number.isNaN(at))) {
    return { kind: 'unmeasured', why: { cause: `${transcript}, records a request with no time, so teamai cannot tell this turn's requests from the earlier steps'.`, next: 'Run the step in a new session rather than continue this one.' } };
  }

  const own = billed.filter(({ at }) => turnSentAt === undefined || at >= turnSentAt).map(({ tokens }) => tokens);

  if (own.length === 0) {
    return { kind: 'unmeasured', why: { cause: `${transcript}, records no request since the step ${turnSentAt === undefined ? 'started' : 'sent its turn'}, as when the tool writes a turn's usage only after it ends.`, next: 'Retry the step.' } };
  }

  return { kind: 'measured', usage: reported(own.reduce((sum, tokens) => addTokenUsage(sum, tokens))) };
}
