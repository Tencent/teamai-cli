import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import type { Ora } from 'ora';
import { getUserHome } from './home.js';

let verboseEnabled = false;
let silentMode = false;
let stderrMode = false;

// ─── File transport ─────────────────────────────────────
//
//  All log.debug(), log.error() and log.persist() calls are persisted to
//  ~/.teamai/debug.log via synchronous append.  This ensures
//  hook processes (short-lived, stdout swallowed by Claude Code)
//  leave a durable trace for troubleshooting.
//
//  Rotation: when debug.log exceeds MAX_LOG_BYTES it is
//  renamed to debug.log.1 (overwriting any previous backup)
//  and a fresh debug.log is started.  Total disk ≤ 2 × limit.

/** Maximum size (bytes) before rotating debug.log. */
export const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5 MB

/** Resolved debug.log path (lazy-initialized). */
let _logFilePath: string | null = null;

/** Whether the parent directory has been ensured this process. */
let _dirEnsured = false;

function defaultLogFilePath(): string {
  return path.join(getUserHome(), '.teamai', 'debug.log');
}

/** Whether the parent directory existed when this process started. */
let _dirExistedAtStart = fs.existsSync(path.dirname(defaultLogFilePath()));

/** Re-entrant guard: true while writeToFile is executing. */
let _writing = false;

function getLogFilePath(): string {
  if (!_logFilePath) {
    _logFilePath = defaultLogFilePath();
  }
  return _logFilePath;
}

/**
 * Ensure the parent directory of debug.log exists.
 * Called once per process; silently skips on failure.
 */
function ensureLogDir(): void {
  if (_dirEnsured) return;
  const dir = path.dirname(getLogFilePath());
  // An uninstall removed the TeamAI home while this process ran; logging must not bring it back.
  if (_dirExistedAtStart && !fs.existsSync(dir)) {
    _dirEnsured = true;
    return;
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // best-effort — if we can't create the dir, writes will fail silently
  }
  _dirEnsured = true;
}

/**
 * Rotate debug.log when it exceeds MAX_LOG_BYTES.
 * Renames current → debug.log.1 (overwrites previous backup).
 */
function maybeRotate(): void {
  try {
    const stat = fs.statSync(getLogFilePath());
    if (stat.size >= MAX_LOG_BYTES) {
      fs.renameSync(getLogFilePath(), getLogFilePath() + '.1');
    }
  } catch {
    // file may not exist yet or stat/rename failed — ignore
  }
}

/**
 * Append a timestamped line to debug.log.
 * Synchronous to guarantee delivery in short-lived hook processes.
 * Silently fails — never throws, never recurses into log.
 */
function writeToFile(level: string, msg: string): void {
  if (_writing) return; // prevent recursion
  _writing = true;
  try {
    ensureLogDir();
    maybeRotate();
    const ts = new Date().toISOString();
    const line = `${ts} [${level}] ${msg}\n`;
    fs.appendFileSync(getLogFilePath(), line, 'utf-8');
  } catch {
    // silent — file I/O must never disrupt the main flow
  } finally {
    _writing = false;
  }
}

// ─── Test helpers (not exported in production API) ──────

/** Override the log file path (for testing only). */
export function _setLogFilePath(p: string): void {
  _logFilePath = p;
  _dirEnsured = false;
  _dirExistedAtStart = fs.existsSync(path.dirname(p));
}

/** Reset internal state (for testing only). */
export function _resetState(): void {
  _logFilePath = null;
  _dirEnsured = false;
  _dirExistedAtStart = fs.existsSync(path.dirname(defaultLogFilePath()));
  _writing = false;
}

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

/** Write a "non-error" log line. Goes to stderr in hook mode, stdout otherwise. */
function writeInfoLine(line: string): void {
  if (stderrMode) {
    console.error(line);
  } else {
    console.log(line);
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
  return ora({ text, color: 'cyan', discardStdin: false });
}
