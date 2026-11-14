/**
 * What each AI tool's sessions spent: tokens, the model of each request, and
 * the cost a tool reported. A tool names the format it writes in its `TOOLS`
 * entry (`tokens`); `readTokenUsage` reads a session in that format, and
 * `priceTokens` (./pricing.ts) prices its requests.
 */
import { BUILT_IN_TOOLS } from '@teamai/tool-definitions';
import { HOST_PROCESSES } from '@teamai/shared/exec';
import type { TokenFormat, TokenReading, TokenSource } from '@teamai/tool-core/tokens';
import { sessionStoreDir } from '../locate.js';

const FORMATS = {
  'claude-jsonl': BUILT_IN_TOOLS.claude.tokens['claude-jsonl'],
  'codex-rollout': BUILT_IN_TOOLS.codex.tokens['codex-rollout'],
  codebuddy: BUILT_IN_TOOLS.codebuddy.tokens.codebuddy,
  'muse-session': BUILT_IN_TOOLS.muse.tokens['muse-session'],
  // agy keeps usage in its store's conversation logs, so the format reads the member's store.
  'agy-transcript': (source, processes) => BUILT_IN_TOOLS.agy.tokens['agy-transcript']({ ...source, storeDir: sessionStoreDir('agy', undefined) }, processes),
  'pi-session': BUILT_IN_TOOLS.pi.tokens['pi-session'],
  // OpenCode keeps usage in its database, so the format reads the member's store.
  'opencode-db': (source, processes) => BUILT_IN_TOOLS.opencode.tokens['opencode-db']({ ...source, storeDir: sessionStoreDir('opencode', undefined) }, processes),
} satisfies Record<string, TokenFormat>;

/** A transcript format teamai reads token usage from. */
export type TokenFormatId = keyof typeof FORMATS;

export function isTokenFormatId(format: string): format is TokenFormatId {
  return Object.hasOwn(FORMATS, format);
}

/** Read a session's token usage in `format`. A source that is missing or unreadable reads as no usage. */
export function readTokenUsage(format: TokenFormatId, source: TokenSource): Promise<TokenReading> {
  return FORMATS[format](source, HOST_PROCESSES);
}
