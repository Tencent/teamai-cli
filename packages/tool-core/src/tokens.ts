import fs from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import readline from 'node:readline';
import { openRegularFile } from '@teamai/shared/regular-file';
import type { Processes } from '@teamai/shared/exec';
import type { JsonValue } from '@teamai/shared/json';
import { log } from '@teamai/shared/log';

/**
 * Token usage breakdown for a session/user. Claude Code and CodeBuddy usage is
 * summed per request. Codex uses a thread-level cumulative snapshot when available;
 * legacy rollout-scoped snapshots are summed once per transcript. All fields are
 * cumulative token counts; tools without token records leave these at zero.
 */
export interface TokenUsage {
  /** Sum of usage.input_tokens. */
  input: number;
  /** Sum of usage.output_tokens. */
  output: number;
  /** Sum of usage.cache_read_input_tokens. */
  cacheRead: number;
  /** Sum of usage.cache_creation_input_tokens. */
  cacheCreation: number;
}

/** Scope of a cumulative token snapshot captured from an agent transcript. */
export type TokenSnapshotScope = 'session' | 'transcript';

/** A fresh zeroed TokenUsage. */
export function emptyTokenUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
}

/** Grand total of all token buckets (input + output + cache read + cache creation). */
export function totalTokens(t: TokenUsage | undefined): number {
  if (!t) return 0;

  return t.input + t.output + t.cacheRead + t.cacheCreation;
}

/** Add two TokenUsage values field-by-field (does not mutate inputs). */
export function addTokenUsage(a: TokenUsage | undefined, b: TokenUsage | undefined): TokenUsage {
  return {
    input: (a?.input ?? 0) + (b?.input ?? 0),
    output: (a?.output ?? 0) + (b?.output ?? 0),
    cacheRead: (a?.cacheRead ?? 0) + (b?.cacheRead ?? 0),
    cacheCreation: (a?.cacheCreation ?? 0) + (b?.cacheCreation ?? 0),
  };
}

/** Fast mode (Claude's `speed: "fast"`, Codex's priority tier) bills at the model's fast rates, Codex's flex tier at its flex rates. */
export type TokenSpeed = 'standard' | 'fast' | 'flex';

/**
 * Where a session's usage is: the transcript its Stop hook names, and the
 * session id for stores looked up by id. `settled`: the tool is done writing,
 * so a format that waits for usage written just after Stop reads once.
 */
export type TokenSource = {
  transcriptPath?: string;
  sessionId: string;
  settled?: boolean;
  /** The platform's session store, for a format that reads the store rather than one transcript, as OpenCode's database. */
  storeDir?: string;
};

/** One model request. */
export type TokenRequest = {
  /** Unique within its transcript, so repeated lines and later reads count the request once. */
  key: string;
  /** ISO time of the request; empty when the tool records none. */
  timestamp: string;
  /** Empty when the tool records none, so no price applies. */
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
  /** The session's requests, each priced by its model when it names one. */
  requests: TokenRequest[];
};

/**
 * Reads a session's token usage in one transcript format, starting a process only through `processes`. A source that is
 * missing or unreadable reads as no usage.
 */
export type TokenFormat = (source: TokenSource, processes: Processes) => Promise<TokenReading>;

/** Max bytes to scan from a transcript when counting interventions (guards huge files). */
export const INTERVENTION_SCAN_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Stream a JSONL transcript, handing each parsed line that contains one of
 * `markers` to `visit`. Missing, unreadable, empty and oversized files visit
 * nothing; unparseable lines are skipped.
 */
export async function forEachJsonLine(
  file: string,
  markers: readonly string[],
  visit: (entry: JsonValue) => void,
): Promise<void> {
  let size: number;

  try {
    size = (await fs.promises.stat(file)).size;
  } catch {
    return;
  }

  if (size > INTERVENTION_SCAN_MAX_BYTES) {
    log.warn(`token-usage: transcript too large to read (${size} bytes): ${file}`);

    return;
  }

  let handle: FileHandle;

  try {
    handle = await openRegularFile(file);
  } catch (e) {
    log.warn(`token-usage: could not read ${file}: ${e instanceof Error ? e.message : String(e)}`);

    return;
  }

  const lines = readline.createInterface({ input: handle.createReadStream({ encoding: 'utf-8' }), crlfDelay: Infinity });

  try {
    for await (const line of lines) {
      if (!markers.some((marker) => line.includes(marker))) continue;
      let entry: JsonValue;

      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      visit(entry);
    }
  } catch (e) {
    // A transcript that cannot be read leaves usage unknown; the Stop is still recorded.
    log.warn(`token-usage: could not read ${file}: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await handle.close();
  }
}
