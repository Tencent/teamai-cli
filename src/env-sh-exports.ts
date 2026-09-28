/**
 * What each scope's env.sh has exported (#879 Conflict 10), kept beside it in
 * `env.sh.exports.json`. A shell opened before a pull rewrote env.sh still
 * carries the values it exported then, in every command it runs afterwards,
 * and those are the team's values, not the member's: without a record, the
 * next command would read an old team token as the member's own.
 *
 * Each entry is a SHA-256 of `KEY=VALUE`, never the value, so the record adds
 * no copy of a team value or token to the machine. It keeps the latest
 * `KEPT_PER_KEY` per key: a shell older than that many changes of one key is
 * not expected.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { readFileSafe, writeJsonAtomic } from './utils/fs.js';
import { log } from './utils/logger.js';

const RECORD_FILE = 'env.sh.exports.json';
const KEPT_PER_KEY = 20;

const RecordSchema = z.record(z.string(), z.array(z.string()));

/** Per key, the digests of the values an env.sh exported. */
export type EnvShExports = ReadonlyMap<string, ReadonlySet<string>>;

export function exportDigest(key: string, value: string): string {
  return crypto.createHash('sha256').update(`${key}=${value}`).digest('hex');
}

function recordPath(envShPath: string): string {
  return path.join(path.dirname(envShPath), RECORD_FILE);
}

async function readRecord(envShPath: string): Promise<Map<string, string[]>> {
  const file = recordPath(envShPath);
  const content = await readFileSafe(file);
  if (content === null) return new Map();
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    raw = null;
  }
  const parsed = RecordSchema.safeParse(raw);
  if (parsed.success) return new Map(Object.entries(parsed.data));
  // The next env.sh write replaces it; until then an old export may count as the member's.
  log.debug(`${file} is not a record of env.sh exports; ignoring it until the next pull rewrites it.`);
  return new Map();
}

/** What the env.sh at `envShPath` has exported, as digests. */
export async function readEnvShExports(envShPath: string): Promise<EnvShExports> {
  return new Map([...await readRecord(envShPath)].map(([key, digests]) => [key, new Set(digests)]));
}

/** Add `exports` to the record beside `envShPath`, readable by this user only. */
export async function recordEnvShExports(envShPath: string, exports: Iterable<readonly [string, string]>): Promise<void> {
  const record = await readRecord(envShPath);
  for (const [key, value] of exports) {
    const digest = exportDigest(key, value);
    const kept = (record.get(key) ?? []).filter((entry) => entry !== digest);
    record.set(key, [...kept, digest].slice(-KEPT_PER_KEY));
  }
  await writeJsonAtomic(recordPath(envShPath), Object.fromEntries(record), { mode: 0o600 });
}
