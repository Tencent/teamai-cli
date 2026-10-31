/**
 * What each AI tool's sessions spent: tokens, the model of each request, and
 * the cost a tool reported. A tool names the format it writes in its `TOOLS`
 * entry (`tokens`); `readTokenUsage` reads a session in that format, and
 * `priceTokens` (./pricing.ts) prices its requests.
 */
import type { TokenSnapshotScope, TokenUsage } from '../types.js';
import { readClaudeJsonl } from './formats/claude-jsonl.js';
import type { TokenSpeed } from './pricing.js';

export type { TokenSpeed } from './pricing.js';

/** Where a session's usage is: the transcript its Stop hook names, and the session id for stores looked up by id. */
export type TokenSource = { transcriptPath?: string; sessionId: string };

/** One model request. */
export type TokenRequest = {
  /** Unique within its transcript, so repeated lines and later reads count the request once. */
  key: string;
  /** ISO time of the request; empty when the tool records none. */
  timestamp: string;
  model: string;
  tokens: TokenUsage;
  speed: TokenSpeed;
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
} satisfies Record<string, (source: TokenSource) => Promise<TokenReading>>;

/** A transcript format teamai reads token usage from. */
export type TokenFormatId = keyof typeof FORMATS;

/** Read a session's token usage in `format`. A source that is missing or unreadable reads as no usage. */
export function readTokenUsage(format: TokenFormatId, source: TokenSource): Promise<TokenReading> {
  return FORMATS[format](source);
}
