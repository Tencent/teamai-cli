// ─── The tail of a stream ───
//
//  A provider streams what a command prints as it comes, and keeps only its end, for the reason a failure names or the
//  answer a command ends with: a command that never stops printing would otherwise grow the runtime without bound, and
//  past V8's longest string, crash it (sandcastle's `boundedTail.ts`).
//

/** How many UTF-16 code units a tail keeps by default: far above any answer a command ends with. */
export const TAIL_CHARS = 64 * 1024;

/** How much of a command's stderr a provider keeps: its last lines, which say why it failed. */
export const STDERR_CHARS = 8000;

export interface BoundedTail {
  push(chunk: string): void;
  /** The newest chunks, joined, at most the tail's budget long, never starting with half a character. */
  text(): string;
}

/** A tail of the last `max` code units: the oldest chunks go first, and of the oldest it still holds part of, its end. */
export function boundedTail(max = TAIL_CHARS): BoundedTail {
  const chunks: string[] = [];
  let length = 0;

  return {
    push(chunk) {
      const kept = chunk.length > max ? chunk.slice(chunk.length - max) : chunk;
      chunks.push(kept);
      length += kept.length;

      while (length > max) {
        const over = length - max;
        const [oldest = ''] = chunks;

        if (oldest.length <= over) {
          chunks.shift();
          length -= oldest.length;
        } else {
          chunks[0] = oldest.slice(over);
          length -= over;
        }
      }
    },
    text() {
      const joined = chunks.join('');
      const first = joined.charCodeAt(0);

      // A low surrogate first is the second half of a character whose first half was cut.
      return first >= 0xdc00 && first <= 0xdfff ? joined.slice(1) : joined;
    },
  };
}

/**
 * The start and the end of a stream: its first `head` code units, and the last `tail` once it outgrew both, a newline
 * between them so the line the cut runs through cannot join another. A reader of JSON lines then finds a tool's first
 * lines (Codex's thread) and its last (the reply), whatever it printed between.
 */
export function boundedEnds({ head, tail }: { head: number; tail: number }): BoundedTail {
  let start = '';
  let pushed = 0;
  const end = boundedTail(tail);

  return {
    push(chunk) {
      pushed += chunk.length;
      const room = head - start.length;

      if (room > 0) start += chunk.slice(0, room);

      if (chunk.length > room) end.push(chunk.slice(Math.max(room, 0)));
    },
    text() {
      return pushed > head + tail ? `${start}\n${end.text()}` : `${start}${end.text()}`;
    },
  };
}
