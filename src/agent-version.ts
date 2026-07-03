/**
 * Detect the installed version of AI coding agents.
 *
 * Each agent has its own detection strategy:
 *  - CLI-based agents: run `<binary> --version` and parse stdout.
 *  - Electron apps (macOS): read CFBundleShortVersionString from Info.plist.
 *  - Fallback: return '' when detection fails (best-effort, never throws).
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { log } from './utils/logger.js';

const VERSION_CACHE = new Map<string, string>();

async function execVersion(bin: string, args: string[] = ['--version']): Promise<string> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 5000 }, (err, stdout) => {
      if (err) {
        resolve('');
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function readPlistVersion(appPath: string): Promise<string> {
  const plistPath = path.join(appPath, 'Contents', 'Info.plist');
  try {
    const content = await readFile(plistPath, 'utf-8');
    const match = content.match(
      /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/,
    );
    return match?.[1] ?? '';
  } catch {
    return '';
  }
}

// ─── Per-agent detection ────────────────────────────────

async function detectClaudeVersion(): Promise<string> {
  const raw = await execVersion('claude');
  // "2.1.199 (Claude Code)" → "2.1.199"
  const match = raw.match(/^([\d.]+)/);
  return match?.[1] ?? raw;
}

async function detectCursorVersion(): Promise<string> {
  // cursor --version outputs multiple lines; version is on the first line
  const raw = await execVersion('cursor');
  return raw.split('\n')[0]?.trim() ?? '';
}

async function detectCodebuddyCliVersion(): Promise<string> {
  return execVersion('codebuddy');
}

const CODEBUDDY_IDE_PATHS = [
  '/Applications/CodeBuddy.app',
  '/Applications/CodeBuddy CN.app',
];

async function detectCodebuddyIdeVersion(): Promise<string> {
  for (const appPath of CODEBUDDY_IDE_PATHS) {
    const ver = await readPlistVersion(appPath);
    if (ver) return ver;
  }
  return '';
}

const WORKBUDDY_APP_PATHS = [
  '/Applications/WorkBuddy.app',
];

async function detectWorkbuddyVersion(): Promise<string> {
  for (const appPath of WORKBUDDY_APP_PATHS) {
    const ver = await readPlistVersion(appPath);
    if (ver) return ver;
  }
  return '';
}

// ─── Registry ───────────────────────────────────────────

type VersionDetector = () => Promise<string>;

const DETECTORS: Record<string, VersionDetector> = {
  claude: detectClaudeVersion,
  cursor: detectCursorVersion,
  codebuddy: detectCodebuddyCliVersion,
  'codebuddy-ide': detectCodebuddyIdeVersion,
  workbuddy: detectWorkbuddyVersion,
};

/**
 * Detect the version of a given agent. Returns '' on failure.
 * Results are cached for the process lifetime (version won't change mid-session).
 */
export async function getAgentVersion(agentType: string): Promise<string> {
  if (VERSION_CACHE.has(agentType)) return VERSION_CACHE.get(agentType)!;

  const detector = DETECTORS[agentType];
  let version = '';
  if (detector) {
    try {
      version = await detector();
    } catch {
      // best-effort
    }
  }

  VERSION_CACHE.set(agentType, version);
  log.debug(`[agent-version] ${agentType} → "${version}"`);
  return version;
}

/** Clear the version cache (for testing). */
export function clearVersionCache(): void {
  VERSION_CACHE.clear();
}

/** Exposed for testing: the plist-reading utility. */
export { readPlistVersion as _readPlistVersion };
