/**
 * What each AI tool's sessions spent: tokens, the model of each request, and
 * the cost a tool reported. A tool names the format it writes in its `TOOLS`
 * entry (`tokens`); `readTokenUsage` reads a session in that format, and
 * `priceTokens` (./pricing.ts) prices its requests.
 */
import type { TokenSnapshotScope, TokenUsage } from '../types.js';
import { readAgyTranscript } from './formats/agy-transcript.js';
import { readClaudeJsonl } from './formats/claude-jsonl.js';
import { readCodebuddy } from './formats/codebuddy.js';
import { readCodexRollout } from './formats/codex-rollout.js';
import { readMuseSession } from './formats/muse-session.js';
import { readOpencodeDb } from './formats/opencode-db.js';
import { readPiSession } from './formats/pi-session.js';
import type { TokenSpeed } from './pricing.js';

export type { TokenSpeed } from './pricing.js';

/**
 * Where a session's usage is: the transcript its Stop hook names, and the
 * session id for stores looked up by id. `settled`: the tool is done writing,
 * so a format that waits for usage written just after Stop reads once.
 */
export type TokenSource = { transcriptPath?: string; sessionId: string; settled?: boolean };

/** One model request. */
export type TokenRequest = {
  /** Unique within its transcript, so repeated lines and later reads count the request once. */
  key: string;
  /** ISO time of the request; empty when the tool records none. */
  timestamp: string;
  model: string;
  tokens: TokenUsage;
  /** The part of `tokens.cacheCreation` written to a one-hour cache, which costs more than a five-minute one. */
  cacheCreation1h?: number;
  speed: TokenSpeed;
  /** The totals of several calls, as Copilot writes per model: priced without long-prompt rates. */
  combinesCalls?: true;
  /** What the tool says the request cost, in micro-dollars. */
  reportedCostMicros?: number;
};

export type TokenReading = {
  /** The session's tokens so far. */
  tokens: TokenUsage;
  /** For a tool that writes cumulative totals: whether they cover the session or this transcript file. */
  scope?: TokenSnapshotScope;
  /** The requests a model name is known for; the ones that can be priced. */
  requests: TokenRequest[];
};

const FORMATS = {
  'claude-jsonl': readClaudeJsonl,
  'codex-rollout': readCodexRollout,
  codebuddy: readCodebuddy,
  'muse-session': readMuseSession,
  'agy-transcript': readAgyTranscript,
  'pi-session': readPiSession,
  'opencode-db': readOpencodeDb,
} satisfies Record<string, (source: TokenSource) => Promise<TokenReading>>;

/** A transcript format teamai reads token usage from. */
export type TokenFormatId = keyof typeof FORMATS;

export function isTokenFormatId(format: string): format is TokenFormatId {
  return Object.hasOwn(FORMATS, format);
}

/** Read a session's token usage in `format`. A source that is missing or unreadable reads as no usage. */
export function readTokenUsage(format: TokenFormatId, source: TokenSource): Promise<TokenReading> {
  return FORMATS[format](source);
}
