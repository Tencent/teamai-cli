/**
 * scrub.ts -- redact a session before migration.
 *
 * `session migrate --scrub` passes the whole IR through `utils/redact`:
 * text, thinking, tool-call arguments and tool results are all covered.
 * Secret-shaped values -- and values matching secrets found in the current
 * environment -- are replaced with `<REDACTED:...>` placeholders.
 *
 * Why this lives in the migration path: the target of a migration is another
 * agent's local store, whose content may later be archived into a
 * team-readable repo via `session push`. Redacting at migration time keeps
 * sensitive values from travelling with the session.
 *
 * `utils/redact` is reused (the same engine `session save` uses) so the rules
 * stay consistent instead of forking a second set of patterns.
 *
 * Note: redact() is best-effort (pattern matching, not a guarantee). Review
 * the result before archiving; this matches the caveat on `session save`.
 */

import type { Session, Message, ContentBlock } from './ir.js';
import { redactWithEnv } from '../utils/redact.js';

export interface ScrubResult {
  session: Session;
  /** Number of replaced secret-looking values (counted per replacement). */
  redactedCount: number;
}

const REDACTED_MARKER = '<REDACTED:';

/** Count how many replacements happened between before/after strings. */
function countRedactions(before: string, after: string): number {
  if (before === after) return 0;
  let count = 0;
  let idx = after.indexOf(REDACTED_MARKER);
  while (idx >= 0) {
    count++;
    idx = after.indexOf(REDACTED_MARKER, idx + REDACTED_MARKER.length);
  }
  return count;
}

function scrubBlock(block: ContentBlock): { block: ContentBlock; count: number } {
  switch (block.type) {
    case 'text': {
      const next = redactWithEnv(block.text);
      return {
        block: next === block.text ? block : { type: 'text', text: next },
        count: countRedactions(block.text, next),
      };
    }
    case 'thinking': {
      const next = redactWithEnv(block.text);
      return {
        block: next === block.text ? block : { ...block, text: next },
        count: countRedactions(block.text, next),
      };
    }
    case 'tool_call': {
      // Arguments are structured: serialize, redact as a whole, then parse
      // back so string fields are covered too, not just top-level strings.
      const raw = JSON.stringify(block.arguments ?? {});
      const next = redactWithEnv(raw);
      const count = countRedactions(raw, next);
      if (count === 0) return { block, count: 0 };
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(next) as Record<string, unknown>;
      } catch {
        // Redaction broke the JSON (placeholder landed in a key name): keep
        // the original arguments rather than writing something unparsable.
        return { block, count: 0 };
      }
      return { block: { ...block, arguments: parsed }, count };
    }
    case 'tool_result': {
      const next = redactWithEnv(block.content);
      return {
        block: next === block.content ? block : { ...block, content: next },
        count: countRedactions(block.content, next),
      };
    }
    case 'image':
      // Image payloads do not participate in text redaction (binary/URL
      // shapes carry no secret-shaped text).
      return { block, count: 0 };
  }
}

/**
 * Redact a session (pure function; the input is not mutated).
 *
 * The title is scrubbed too: the first prompt often carries a token, and the
 * title is what shows up in the target client's session list.
 */
export function scrubSession(session: Session): ScrubResult {
  let redactedCount = 0;

  const messages: Message[] = session.messages.map((msg) => {
    let contentChanged = false;
    const content = msg.content.map((block) => {
      const { block: next, count } = scrubBlock(block);
      redactedCount += count;
      if (next !== block) contentChanged = true;
      return next;
    });
    return contentChanged ? { ...msg, content } : msg;
  });

  const title = redactWithEnv(session.title);

  return {
    session: { ...session, title, messages },
    redactedCount,
  };
}
