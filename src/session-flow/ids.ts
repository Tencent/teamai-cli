/**
 * ids.ts -- the id a session gets when TeamAI writes it into a tool.
 *
 * Every target id is derived: sha256 over the target platform, the canonical
 * target workspace and the source session id, shaped as a UUIDv7, or on
 * OpenCode as an OpenCode id. No source id is ever reused, for any platform:
 *
 * - Reusing a source UUID wrote the copy over whatever already had that id in
 *   the target, and a same-platform CodeBuddy IDE copy replaced the live
 *   conversation.
 * - The workspace is part of the key for every platform. Claude Code resumes by
 *   id across all project directories, and a rollback without a workspace
 *   deletes the id everywhere, so one id in two workspaces is not two sessions.
 *
 * The same request (platform, workspace, source) always names the same target.
 * Copies written by an older TeamAI kept the source UUID, or (Claude Code and
 * CodeBuddy) left the workspace out of the hash, so they carry other ids;
 * `legacyTargetSessionIds` names them so a re-copy finds them.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sessionPlatformFacts } from './adapters/platform-facts.js';

/**
 * Derive the id to write a session under in `targetPlatform` at `targetCwd`.
 *
 * Throws before anything is written when `targetCwd` is not absolute: a
 * relative path or a placeholder such as `md5:<hash>` would resolve against
 * the directory the command runs in, so both the id and the file would move
 * with it.
 *
 * `platform` names the OS whose path rules apply; only a test passes another one, since no
 * Windows CI runs.
 */
export function deriveTargetSessionId(
  target: {
    targetPlatform: string;
    targetCwd: string;
    sourceSessionId: string;
    /** The source session's creation time (ISO 8601). Only an OpenCode id carries it. */
    sourceCreatedAt?: string;
  },
  platform: NodeJS.Platform = process.platform,
): string {
  const { targetPlatform, targetCwd, sourceSessionId } = target;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (!paths.isAbsolute(targetCwd)) {
    throw new Error(
      `Target workspace "${targetCwd}" is not an absolute path, so the session was not written. ` +
        'Pass an absolute directory (--target-cwd for `session migrate`, --cwd for `session resume`).',
    );
  }
  const key = `teamai:${targetPlatform}:${canonicalWorkspace(targetCwd, paths)}:${sourceSessionId}`;
  if (sessionPlatformFacts(targetPlatform)?.idFormat === 'opencode') {
    const time =
      OPENCODE_SESSION_TIME.exec(sourceSessionId)?.[1] ?? opencodeTime(opencodeClock(createdMs(target.sourceCreatedAt)), 'descending');
    return `ses_${time}${base62Suffix(key)}`;
  }
  return uuidV7Shaped(key);
}

/**
 * The ids of the messages TeamAI writes into the OpenCode session `sessionId`, one per creation
 * time (epoch ms), in order. A copy needs its own message ids: OpenCode refuses a message id it
 * already has, so two copies of one source cannot share them. Each id sorts after the one before,
 * as OpenCode's own do, even when two messages share a time.
 */
export function deriveOpencodeMessageIds(sessionId: string, createdTimes: number[]): string[] {
  let previous = -1n;
  return createdTimes.map((ms, index) => {
    const clock = opencodeClock(ms);
    previous = clock > previous ? clock : previous + 1n;
    return `msg_${opencodeTime(previous, 'ascending')}${base62Suffix(`${sessionId}:${index}`)}`;
  });
}

/**
 * OpenCode ids: a prefix, 12 hex of time, 14 base62 characters. OpenCode encodes the creation
 * time so that session ids sort newest first and message ids oldest first, and a copy keeps that:
 * the time part of an OpenCode source, or the time encoded the way OpenCode 2 encodes it, followed
 * by a suffix derived like every other target id. OpenCode only checks the prefix.
 */
const OPENCODE_SESSION_TIME = /^ses_([0-9a-f]{12})/;
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** OpenCode 2 counts ids within one millisecond: `ms * 4096 + counter`, the first counter being 1. */
const opencodeClock = (ms: number): bigint => BigInt(ms) * 4096n + 1n;

/** OpenCode 2's time part: the low 48 bits of the clock, inverted for descending ids. */
function opencodeTime(clock: bigint, order: 'ascending' | 'descending'): string {
  const bits = (order === 'descending' ? ~clock : clock) & 0xffff_ffff_ffffn;
  return bits.toString(16).padStart(12, '0');
}

/** A time OpenCode can encode; a missing or unparseable one sorts first. */
function createdMs(iso: string | undefined): number {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

function base62Suffix(key: string): string {
  const bytes = crypto.createHash('sha256').update(key).digest();
  return Array.from(bytes.subarray(0, 14), (byte) => BASE62[byte % 62]).join('');
}

/** Platforms whose copies an older TeamAI derived without the workspace: per-project stores. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Ids an older TeamAI wrote a copy of this source under, in the target workspace:
 *
 * - the source id itself, when it is a UUID and the target is another platform;
 * - for Claude Code and CodeBuddy, the id derived without the workspace.
 *
 * Workspace-keyed stores (Codex, Cursor, WorkBuddy, CodeBuddy IDE) already
 * hashed the workspace the way `deriveTargetSessionId` does for a correctly
 * spelled path, so their derived id is the same.
 */
export function legacyTargetSessionIds(target: {
  sourcePlatform: string;
  targetPlatform: string;
  sourceSessionId: string;
}): string[] {
  const { sourcePlatform, targetPlatform, sourceSessionId } = target;
  const ids: string[] = [];
  if (sourcePlatform !== targetPlatform && UUID_RE.test(sourceSessionId)) ids.push(sourceSessionId);
  if (sessionPlatformFacts(targetPlatform)?.legacyIdWithoutWorkspace) ids.push(uuidV7Shaped(`teamai:${targetPlatform}:${sourceSessionId}`));
  return ids;
}

function uuidV7Shaped(key: string): string {
  const hex = crypto.createHash('sha256').update(key).digest('hex');
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  // Version nibble 7 keeps the UUIDv7 shape Codex expects of a thread id. The
  // time bits are hash, not a timestamp: sorting comes from session timestamps.
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `7${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

/**
 * One spelling per workspace: the native real path. It resolves symlinks
 * (`/tmp/x` and `/private/tmp/x` on macOS) and, on case-insensitive file
 * systems, letter case (`/Users/me/Repo` and `/users/me/repo`), so a retry
 * from another spelling names the same target. A path that does not exist yet
 * is only resolved, so its id can change once the directory is created through
 * another spelling. On Windows, resolving also turns `/` into `\` and drops a
 * trailing separator, and the drive letter is upper-cased: `c:\` (what VS Code
 * terminals type) and `C:\` are one drive, even for a folder not created yet.
 */
function canonicalWorkspace(cwd: string, paths: path.PlatformPath): string {
  const resolved = paths.resolve(cwd);
  let real: string;
  try {
    real = fs.realpathSync.native(resolved);
  } catch {
    real = resolved;
  }
  return paths === path.win32 ? real.replace(/^[a-z]:/, (drive) => drive.toUpperCase()) : real;
}

const SAFE_SESSION_FILE_ID_RE = /^[A-Za-z0-9_-]+$/;

export function isSafeSessionFileId(sessionId: string): boolean {
  return SAFE_SESSION_FILE_ID_RE.test(sessionId);
}

/**
 * Reject a session id that is not one path segment.
 * Rollback concatenates the id into a file path; `../` would unlink outside
 * the platform's storage directory.
 */
export function assertSafeSessionFileId(sessionId: string): void {
  if (!isSafeSessionFileId(sessionId)) {
    throw new Error('Refusing to delete a session id that is not a single path segment.');
  }
}
