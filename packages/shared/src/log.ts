import chalk from 'chalk';
import type { Ora } from 'ora';
import { writeToFile } from './debug-log.js';

let verboseEnabled = false;
let silentMode = false;
let stderrMode = false;

// ─── Public API ─────────────────────────────────────────

export function setVerbose(v: boolean): void {
  verboseEnabled = v;
}

export function setSilent(s: boolean): void {
  silentMode = s;
}

export function isSilent(): boolean {
  return silentMode;
}

/**
 * Route non-error log output to stderr. Used by hook-dispatch commands to
 * keep stdout as a clean JSON channel for the AI tool. Returns the previous
 * mode, so a caller that needs it for one step can put it back.
 */
export function setStderrOnly(s: boolean): boolean {
  const previous = stderrMode;
  stderrMode = s;

  return previous;
}

/**
 * Set by the local driver for a command step. Its stderr is the step's progress, which a shortcut shows: in stderr-only
 * mode each line meant for stdout then starts with {@link STDOUT_MARK}, so the shortcut prints it on stdout again, and
 * an unmarked line, an error's or a spinner's, stays on stderr.
 */
export const PROGRESS_STREAMS_ENV = 'TEAMAI_PROGRESS_STREAMS';

const STDOUT_MARK = '\u001e';

/** The stream a line of a step's stderr was meant for, and its text without the mark. */
export function streamOfLine(line: string): { stream: 'stdout' | 'stderr'; text: string } {
  return line.startsWith(STDOUT_MARK) ? { stream: 'stdout', text: line.slice(STDOUT_MARK.length) } : { stream: 'stderr', text: line };
}

/** A step's stderr as a person reads it: without the marks that say which lines were meant for stdout. */
export function withoutStreamMarks(text: string): string {
  return text.replaceAll(STDOUT_MARK, '');
}

/** Write a line of the command's output: stdout, or stderr in stderr-only mode, marked when a step's progress keeps streams. */
export function writeInfoLine(line: string): void {
  if (!stderrMode) {
    console.log(line);
  } else if (process.env[PROGRESS_STREAMS_ENV] === '1') {
    console.error(line.split('\n').map((part) => `${STDOUT_MARK}${part}`).join('\n'));
  } else {
    console.error(line);
  }
}

export const log = {
  info(msg: string): void {
    if (silentMode) return;
    writeInfoLine(`${chalk.blue('ℹ')} ${msg}`);
  },
  success(msg: string): void {
    if (silentMode) return;
    writeInfoLine(`${chalk.green('✔')} ${msg}`);
  },
  warn(msg: string): void {
    if (silentMode) return;
    writeInfoLine(`${chalk.yellow('⚠')} ${msg}`);
  },
  /**
   * Record a failure in debug.log only, never on the console: for a warning
   * already shown where a detached hook process (stdout and stderr discarded,
   * silent) would lose it, without printing it twice under --verbose.
   */
  persist(msg: string): void {
    writeToFile('WARN', msg);
  },
  error(msg: string): void {
    console.error(chalk.red('✖'), msg);
    writeToFile('ERROR', msg);
  },
  debug(msg: string): void {
    writeToFile('DEBUG', msg);

    if (!verboseEnabled || silentMode) return;
    writeInfoLine(`${chalk.gray('  [debug]')} ${msg}`);
  },
  dim(msg: string): void {
    if (silentMode) return;
    writeInfoLine(chalk.dim(msg));
  },
};

/**
 * Loads ora on first use: imported up front, it ran string-width's setup (an
 * Intl.Segmenter and a Unicode-property regex) in every command, hooks included.
 */
export async function spinner(text: string): Promise<Ora> {
  const { default: ora } = await import('ora');

  if (silentMode) {
    // return a no-op spinner in silent mode
    return ora({ text, isSilent: true });
  }

  // ora clears its line in rows of the terminal's width, so a terminal that reports none, such as a 0x0 pty, makes
  // that clear endless: it writes without pause and the process never runs its SIGTERM handler. Print the plain lines.
  const hasWidth = (process.stderr.columns ?? 0) > 0;

  return ora({ text, color: 'cyan', discardStdin: false, ...(!hasWidth && { isEnabled: false }) });
}
