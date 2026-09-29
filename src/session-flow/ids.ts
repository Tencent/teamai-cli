/**
 * ids.ts -- deterministic derivation of target-platform session ids.
 *
 * Source session ids are often not UUIDs (e.g. CodeBuddy IDE's 32-hex
 * `60062279ff104372bc110594720a8016`). If a target adapter falls back to
 * `randomUUID()` in that case, every re-migration of the same session mints a
 * fresh duplicate in the target client.
 *
 * Deriving from sha256(platform + sourceId) yields a stable UUIDv7-shaped id:
 * the same (platform, source session) always maps to the same target id, so a
 * re-migration is an overwrite -- idempotent by construction.
 */

import * as crypto from 'node:crypto';
import { resolveRealCwd } from './fs.js';

/**
 * Derive a deterministic target session id (UUIDv7 shape) from a source id.
 *
 * `targetCwd` participates when known: Cursor/WorkBuddy/Codex key their
 * records globally (one sqlite / threads table for every workspace), so
 * migrating one source session into two workspaces with the same derived id
 * makes the second copy replace the first.
 *
 * Only claude-code and codebuddy omit it: they store each session under
 * `<storageRoot>/<encoded cwd>/<id>.jsonl`, so one id in two workspaces is
 * already two files and nothing is overwritten. Adding cwd there would only
 * move already-migrated sessions to a new id. Note the consequence: a session
 * migrated into a global-key platform before this change gets a different id
 * when re-migrated (the old copy stays, orphaned).
 */
export function deriveTargetSessionId(
  targetPlatform: string,
  sourceId: string,
  targetCwd?: string,
): string {
  // Resolve before hashing: `/tmp/x` and `/private/tmp/x` are one workspace on
  // macOS, and two spellings would derive two ids for the same migration --
  // a re-migration would then add a second copy instead of overwriting.
  const scope = targetCwd ? `:${resolveRealCwd(targetCwd)}` : '';
  const hex = crypto
    .createHash('sha256')
    .update(`teamai:${targetPlatform}${scope}:${sourceId}`)
    .digest('hex');
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  // version nibble is **7**: targets (e.g. Codex's isUuidV7) treat the id as
  // "already a native id" and reuse it. With 8, migrating an already-migrated
  // session (codex->X->codex) would derive a *new* id and break idempotency
  // across chains. The time bits are hash, not a real timestamp -- sorting
  // fields (recency/updated_at) come from session timestamps, not the id.
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `7${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

const UUID_ANY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_SESSION_FILE_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Id to write under `targetPlatform`.
 * Same-platform archives always derive, so the original file is not overwritten.
 * A dashed UUID from another platform is reused. `targetCwd` is hashed for
 * stores that key sessions globally (Cursor, WorkBuddy, Codex).
 */
export function resolveWriteSessionId(
  targetPlatform: string,
  session: { sessionId: string; platform: string },
  targetCwd?: string,
): string {
  if (session.platform === targetPlatform) {
    return deriveTargetSessionId(targetPlatform, session.sessionId, targetCwd);
  }
  if (UUID_ANY_RE.test(session.sessionId)) return session.sessionId;
  return deriveTargetSessionId(targetPlatform, session.sessionId, targetCwd);
}

export function isSafeSessionFileId(sessionId: string): boolean {
  return SAFE_SESSION_FILE_ID_RE.test(sessionId);
}
