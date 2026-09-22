/**
 * ids.ts — 目标平台会话 id 的确定性派生。
 *
 * 源会话 id 常常不是 UUID（如 CodeBuddy IDE 的 32 位 hex `60062279ff104372bc110594720a8016`）。
 * 目标适配器若在这种情况下 `randomUUID()`，同一会话每次迁移都会生成一个新副本：
 * 目标客户端里出现多条重复会话，且无法按源 id 回滚。
 *
 * 这里用 sha256(platform + sourceId) 派生出稳定的 UUID v8 形状 id：
 * 同一 (平台, 源会话) 永远得到同一个目标 id → 重迁移 = 覆盖，天然幂等。
 */

import * as crypto from 'node:crypto';

/** 由源会话 id 确定性派生目标平台 session id（UUID v8 形状）。 */
export function deriveTargetSessionId(targetPlatform: string, sourceId: string): string {
  const hex = crypto
    .createHash('sha256')
    .update(`teamai:${targetPlatform}:${sourceId}`)
    .digest('hex');
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  // version nibble 用 **7**：目标端（如 Codex 的 isUuidV7）据此判定"已是本平台的 id"
  // 并直接沿用。若用 8，已迁移会话做二次迁移（codex→X→codex）会再派生出一个新 id，
  // 幂等性跨链路失效。时间位仍是 hash（非真实时间戳），但只影响形状不影响排序字段
  // （recency/updated_at 都取自会话时间戳）。
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `7${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}
