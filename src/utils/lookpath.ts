/**
 * PATH presence check that does not spawn a shell or execute the binary.
 *
 * MCP `requires` used to call `command -v` under `/bin/sh`, which ENOENTs on
 * Windows (no /bin/sh) even when `uvx.exe` is on PATH. Scanning PATH (and
 * PATHEXT on win32) matches what `where uvx` finds, and is injectable so the
 * Windows `uvx` ↔ `uvx.exe` case can be asserted on macOS/Linux CI.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface LookPathOptions {
  platform?: NodeJS.Platform;
  /** PATH-equivalent string. Defaults to `process.env.PATH`. */
  pathEnv?: string;
  /** PATHEXT-equivalent string. Defaults to `process.env.PATHEXT`. */
  pathExt?: string;
  /** PATH directory separator. Defaults to `path.delimiter`. */
  delimiter?: string;
}

const DEFAULT_WIN_PATHEXT = '.EXE;.CMD;.BAT;.COM';

/** Bare executable name — no path separators or shell metacharacters. */
export const SAFE_BIN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function stripQuotes(dir: string): string {
  if (
    (dir.startsWith('"') && dir.endsWith('"')) ||
    (dir.startsWith("'") && dir.endsWith("'"))
  ) {
    return dir.slice(1, -1);
  }
  return dir;
}

function candidateNames(
  bin: string,
  platform: NodeJS.Platform,
  pathExt: string | undefined,
): string[] {
  if (platform !== 'win32') return [bin];
  const raw = pathExt?.trim() ? pathExt : DEFAULT_WIN_PATHEXT;
  const names = new Set<string>([bin]);
  for (const ext of raw.split(';')) {
    const trimmed = ext.trim();
    if (!trimmed) continue;
    const withDot = trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
    names.add(bin + withDot);
    names.add(bin + withDot.toLowerCase());
    names.add(bin + withDot.toUpperCase());
  }
  return [...names];
}

function isPresent(candidate: string, requireExecute: boolean): boolean {
  try {
    const st = fs.statSync(candidate);
    if (!st.isFile()) return false;
    if (requireExecute) fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * PATH split into the directories the presence check scans: unquoted, trimmed,
 * empties dropped. Windows PATH entries do arrive quoted, so this — not a raw
 * `split` — is the view to compare directories against.
 */
export function pathDirs(options: LookPathOptions = {}): string[] {
  const delimiter = options.delimiter ?? path.delimiter;
  const pathEnv = options.pathEnv ?? process.env.PATH ?? process.env.Path ?? '';
  return pathEnv.split(delimiter).map(stripQuotes).map(dir => dir.trim()).filter(Boolean);
}

/**
 * True when `bin` names a file on PATH.
 *
 * Empty PATH entries are skipped so a Windows-style implicit cwd search never
 * runs. On win32, `uvx` also matches `uvx.exe` / `uvx.cmd` via PATHEXT.
 */
export function isOnPath(bin: string, options: LookPathOptions = {}): boolean {
  if (!SAFE_BIN_RE.test(bin)) return false;
  const platform = options.platform ?? process.platform;
  const names = candidateNames(bin, platform, options.pathExt ?? process.env.PATHEXT);
  const requireExecute = platform !== 'win32';

  for (const dir of pathDirs(options)) {
    for (const name of names) {
      if (isPresent(path.join(dir, name), requireExecute)) return true;
    }
  }
  return false;
}
