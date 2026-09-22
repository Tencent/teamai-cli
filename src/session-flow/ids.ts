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

/** Derive a deterministic target session id (UUIDv7 shape) from a source id. */
export function deriveTargetSessionId(targetPlatform: string, sourceId: string): string {
  const hex = crypto
    .createHash('sha256')
    .update(`teamai:${targetPlatform}:${sourceId}`)
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
