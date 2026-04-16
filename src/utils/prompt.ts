/**
 * Shared prompt utilities — single readline interface for the entire session.
 *
 * Fixes the "piped input starvation" bug where each `askQuestion()` created
 * a new `readline.createInterface(process.stdin)`, causing the first instance
 * to consume all buffered data and leaving nothing for subsequent prompts.
 *
 * Non-TTY behaviour:
 *   - `askQuestion(prompt, defaultValue)` → returns defaultValue if provided
 *   - `askQuestion(prompt)` without default → throws (cannot prompt in non-TTY)
 *   - `askConfirmation(prompt, defaultValue)` → returns defaultValue
 */
import readline from 'node:readline';

// ─── Singleton readline ──────────────────────────────────

let _rl: readline.Interface | null = null;

function getReadline(): readline.Interface {
  if (!_rl) {
    _rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    _rl.on('close', () => { _rl = null; });
  }
  return _rl;
}

/** Explicitly close the shared readline (optional — process exit handles it). */
export function closePrompt(): void {
  if (_rl) {
    _rl.close();
    _rl = null;
  }
}

// ─── Internal helpers ───────────────────────────────────

/**
 * Wrap rl.question with ref/unref bookkeeping.
 *
 * While waiting for user input, stdin must be ref()'d so the event loop
 * stays alive.  Once the answer arrives, we unref() so that stdin alone
 * does not prevent the process from exiting when all other async work
 * is done.
 */
function question(rl: readline.Interface, prompt: string): Promise<string> {
  process.stdin.ref();
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      process.stdin.unref();
      resolve(answer.trim());
    });
  });
}

// ─── Public API ──────────────────────────────────────────

/**
 * Ask a question and return the trimmed answer.
 *
 * In non-TTY mode:
 *   - If `defaultValue` is provided, return it immediately.
 *   - Otherwise throw an error (cannot prompt without a terminal).
 */
export function askQuestion(prompt: string, defaultValue?: string): Promise<string> {
  if (!process.stdin.isTTY) {
    if (defaultValue !== undefined) {
      return Promise.resolve(defaultValue);
    }
    return Promise.reject(
      new Error(`Cannot prompt in non-interactive mode: "${prompt.trim()}"`),
    );
  }

  return question(getReadline(), prompt);
}

/**
 * Ask a yes/no confirmation question.
 *
 * In non-TTY mode, returns `defaultValue` (defaults to `false`).
 */
export function askConfirmation(
  prompt: string,
  defaultValue = false,
): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return Promise.resolve(defaultValue);
  }

  return question(getReadline(), prompt)
    .then((answer) => answer.toLowerCase() === 'y');
}

// ─── Multi-select ───────────────────────────────────────

/**
 * Parse a selection string like "1,3,5-7" into 0-based indices.
 * Returns sorted, deduplicated indices, or null if any part is invalid.
 *
 * Supported formats:
 *   "1"        → [0]
 *   "1,3"      → [0, 2]
 *   "1-3"      → [0, 1, 2]
 *   "1-3,5,7"  → [0, 1, 2, 4, 6]
 *
 * @internal — exported for testing
 */
export function parseSelection(input: string, maxItems: number): number[] | null {
  const indices = new Set<number>();
  const parts = input.split(',').map((s) => s.trim()).filter((s) => s.length > 0);

  if (parts.length === 0) return null;

  for (const part of parts) {
    const rangeMatch = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (rangeMatch) {
      const start = Number.parseInt(rangeMatch[1], 10);
      const end = Number.parseInt(rangeMatch[2], 10);
      if (Number.isNaN(start) || Number.isNaN(end) || start < 1 || end > maxItems || start > end) {
        return null;
      }
      for (let i = start; i <= end; i++) indices.add(i - 1);
    } else {
      if (!/^\d+$/.test(part)) return null;
      const num = Number.parseInt(part, 10);
      if (Number.isNaN(num) || num < 1 || num > maxItems) return null;
      indices.add(num - 1);
    }
  }

  return indices.size > 0 ? [...indices].sort((a, b) => a - b) : null;
}

/**
 * Ask user to select items from a numbered list (1-based display).
 *
 * Input formats:
 *   "" / "all"          → select everything (when defaultAll=true)
 *   "none" / "n" / "0"  → cancel
 *   "1,3,5"             → specific items
 *   "1-3"               → range
 *   "1-3,5,7-9"         → mixed ranges and singles
 *
 * Returns 0-based indices of selected items, or null if cancelled/invalid.
 *
 * Non-TTY / non-interactive: returns all indices when defaultAll is true.
 */
export async function askSelection(
  prompt: string,
  itemCount: number,
  defaultAll = false,
): Promise<number[] | null> {
  const allIndices = Array.from({ length: itemCount }, (__, i) => i);

  if (!process.stdin.isTTY) {
    return defaultAll ? allIndices : null;
  }

  const answer = await askQuestion(prompt, defaultAll ? '' : undefined);

  if (!answer || answer.toLowerCase() === 'all') {
    return defaultAll ? allIndices : null;
  }

  if (answer === '0' || answer.toLowerCase() === 'none' || answer.toLowerCase() === 'n') {
    return null;
  }

  return parseSelection(answer, itemCount);
}
