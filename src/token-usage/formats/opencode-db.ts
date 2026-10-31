import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { sessionStoreDir } from '../../locate.js';
import { isSafeSessionFileId } from '../../session-flow/ids.js';
import { findSqlite3 } from '../../session-flow/sqlite.js';
import { emptyTokenUsage } from '../../types.js';
import { execCommand } from '../../utils/exec.js';
import { log } from '../../utils/logger.js';
import type { TokenReading, TokenRequest, TokenSource } from '../index.js';

const Count = z.number().finite().nonnegative().catch(0).default(0);
/** An assistant message's data as OpenCode stores it: `modelID` before 2.x, `model.id` after. */
const Message = z.object({
  modelID: z.string().min(1).optional(),
  model: z.object({ id: z.string().min(1) }).optional().catch(undefined),
  cost: z.number().finite().nonnegative().catch(0).default(0),
  time: z.object({ created: z.number().finite().nonnegative() }).optional().catch(undefined),
  tokens: z.object({
    input: Count,
    output: Count,
    reasoning: Count,
    cache: z.object({ read: Count, write: Count }).catch({ read: 0, write: 0 }).default({ read: 0, write: 0 }),
  }),
});
/** OpenCode 2 keeps a message's role in the `type` column; older `message` rows keep it as `data.role`. */
const Row = z.object({ id: z.string().min(1), type: z.string().nullable(), data: z.string() });
const Role = z.object({ role: z.string() }).catch({ role: '' });

/**
 * OpenCode's assistant messages for `sessionId`, from `opencode.db` in its
 * data directory. OpenCode 2 writes them to `session_message` and older
 * versions to `message`; a message in both is read once. Reasoning tokens
 * are billed as output, and the cost OpenCode reports is kept when above zero.
 */
export async function readOpencodeDb(source: TokenSource): Promise<TokenReading> {
  const tokens = emptyTokenUsage();
  const requests: TokenRequest[] = [];
  const db = path.join(sessionStoreDir('opencode', undefined), 'opencode.db');
  // A safe id is a single path segment of letters, digits, `-` and `_`, so it cannot break out of the quotes.
  if (!isSafeSessionFileId(source.sessionId) || !fs.existsSync(db)) return { tokens, requests };
  const sqlite3 = findSqlite3();
  if (!sqlite3) {
    log.warn(`token-usage: sqlite3 not found, so OpenCode token usage in ${db} is not read`);
    return { tokens, requests };
  }
  const tables = (await execCommand(sqlite3, ['-readonly', db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('message', 'session_message');"], { timeoutMs: 30_000 }))
    .stdout.split('\n').map((name) => name.trim()).filter(Boolean);
  if (!tables.length) return { tokens, requests };
  const sql = tables
    .map((table) => `SELECT id, ${table === 'session_message' ? 'type' : 'NULL AS type'}, data FROM ${table} WHERE session_id = '${source.sessionId}'`)
    .join(' UNION ALL ') + ';';
  const result = await execCommand(sqlite3, ['-readonly', '-json', db, sql], { timeoutMs: 30_000 });
  if (result.code !== 0) {
    log.warn(`token-usage: sqlite3 could not read ${db}: ${result.stderr.trim() || `exit ${result.code}`}`);
    return { tokens, requests };
  }
  if (!result.stdout.trim()) return { tokens, requests };
  const counted = new Set<string>();
  for (const raw of z.array(z.unknown()).catch([]).parse(JSON.parse(result.stdout))) {
    const row = Row.safeParse(raw);
    if (!row.success || counted.has(row.data.id)) continue;
    let data: unknown;
    try {
      data = JSON.parse(row.data.data);
    } catch {
      continue;
    }
    if ((row.data.type ?? Role.parse(data).role) !== 'assistant') continue;
    const message = Message.safeParse(data);
    if (!message.success) continue;
    counted.add(row.data.id);
    const { tokens: used, cost, time } = message.data;
    const usage = { input: used.input, output: used.output + used.reasoning, cacheRead: used.cache.read, cacheCreation: used.cache.write };
    tokens.input += usage.input;
    tokens.output += usage.output;
    tokens.cacheRead += usage.cacheRead;
    tokens.cacheCreation += usage.cacheCreation;
    const model = message.data.model?.id ?? message.data.modelID;
    if (!model) continue;
    requests.push({
      key: row.data.id,
      timestamp: time ? new Date(time.created).toISOString() : '',
      model,
      tokens: usage,
      speed: 'standard',
      reportedCostMicros: cost > 0 ? Math.round(cost * 1_000_000) : undefined,
    });
  }
  return { tokens, requests };
}
