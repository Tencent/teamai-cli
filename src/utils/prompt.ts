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
    // Prevent readline from keeping the process alive
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

  const rl = getReadline();
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer.trim());
    });
  });
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

  const rl = getReadline();
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}
