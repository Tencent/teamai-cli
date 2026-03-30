import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import ora, { type Ora } from 'ora';

let verboseEnabled = false;
let silentMode = false;

// ─── File transport ─────────────────────────────────────
//
//  All log.debug() and log.error() calls are persisted to
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

/** Re-entrant guard: true while writeToFile is executing. */
let _writing = false;

function getLogFilePath(): string {
  if (!_logFilePath) {
    _logFilePath = path.join(process.env.HOME ?? '/tmp', '.teamai', 'debug.log');
  }
  return _logFilePath;
}

/**
 * Ensure the parent directory of debug.log exists.
 * Called once per process; silently skips on failure.
 */
function ensureLogDir(): void {
  if (_dirEnsured) return;
  try {
    fs.mkdirSync(path.dirname(getLogFilePath()), { recursive: true });
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
}

/** Reset internal state (for testing only). */
export function _resetState(): void {
  _logFilePath = null;
  _dirEnsured = false;
  _writing = false;
}

// ─── Public API ─────────────────────────────────────────

export function setVerbose(v: boolean): void {
  verboseEnabled = v;
}

export function setSilent(s: boolean): void {
  silentMode = s;
}

export const log = {
  info(msg: string): void {
    if (silentMode) return;
    console.log(chalk.blue('ℹ'), msg);
  },
  success(msg: string): void {
    if (silentMode) return;
    console.log(chalk.green('✔'), msg);
  },
  warn(msg: string): void {
    if (silentMode) return;
    console.log(chalk.yellow('⚠'), msg);
  },
  error(msg: string): void {
    console.error(chalk.red('✖'), msg);
    writeToFile('ERROR', msg);
  },
  debug(msg: string): void {
    writeToFile('DEBUG', msg);
    if (!verboseEnabled || silentMode) return;
    console.log(chalk.gray('  [debug]'), msg);
  },
  dim(msg: string): void {
    if (silentMode) return;
    console.log(chalk.dim(msg));
  },
};

export function spinner(text: string): Ora {
  if (silentMode) {
    // return a no-op spinner in silent mode
    return ora({ text, isSilent: true });
  }
  return ora({ text, color: 'cyan' });
}
