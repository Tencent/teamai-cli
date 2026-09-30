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
import { envName } from './resources/env-key.js';
import { readFileSafe, writeJsonAtomic } from './utils/fs.js';
import { log } from './utils/logger.js';

const RECORD_FILE = 'env.sh.exports.json';
const KEPT_PER_KEY = 20;

const RecordSchema = z.record(z.string(), z.array(z.string()));

/** Per key, the digests of the values an env.sh exported. */
export type EnvShExports = ReadonlyMap<string, ReadonlySet<string>>;

/** Of the key as the platform compares it (`envName`), so on Windows `token` and `TOKEN` hash alike. */
export function exportDigest(key: string, value: string): string {
  return crypto.createHash('sha256').update(`${envName(key)}=${value}`).digest('hex');
}

/**
 * The variable each env.sh exports beside its own, naming what it exported:
 * `TEAMAI_ENV_SH_<data home hash>=<digest prefix> ...`, one digest prefix per
 * export and per value the record keeps, never a value. The record above is found by scanning known paths,
 * and a non-git project keeps its env.sh at `<dir>/.teamai/`, which no scan
 * reaches; a shell that sourced it carries the marker instead. Named after
 * the data home, so a shell that sourced the user's env.sh and a project's
 * keeps both.
 */
const MARKER_RE = /^TEAMAI_ENV_SH_[0-9a-f]{64}$/i;
const MARKED_DIGEST_LENGTH = 12;

export function isEnvShMarker(key: string): boolean {
  return MARKER_RE.test(key);
}

function markedDigest(key: string, value: string): string {
  return exportDigest(key, value).slice(0, MARKED_DIGEST_LENGTH);
}

/**
 * The marker an env.sh in `dataHome` exports for `exports` and what it
 * `recorded` exporting before, as [name, value]; null when it lists nothing.
 * A shell that sources the rewritten env.sh keeps a value an earlier one
 * exported, while the new marker replaces the old, so it lists both.
 */
export function envShMarker(
  dataHome: string,
  exports: Iterable<readonly [string, string]>,
  recorded: EnvShExports = new Map(),
): [string, string] | null {
  const digests = new Set([...exports].map(([key, value]) => markedDigest(key, value)));
  for (const kept of recorded.values()) for (const digest of kept) digests.add(digest.slice(0, MARKED_DIGEST_LENGTH));
  if (digests.size === 0) return null;
  const name = `TEAMAI_ENV_SH_${crypto.createHash('sha256').update(path.resolve(dataHome)).digest('hex')}`;
  return [name, [...digests].join(' ')];
}

/** Whether a teamai env.sh this environment sourced exported `key=value`, by its markers. */
export function markedAsExported(env: NodeJS.ProcessEnv): (key: string, value: string) => boolean {
  const marked = new Set<string>();
  for (const [name, digests] of Object.entries(env)) {
    if (digests !== undefined && isEnvShMarker(name)) for (const digest of digests.split(' ')) marked.add(digest);
  }
  return (key, value) => marked.has(markedDigest(key, value));
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

/** Add `exports` to the record beside `envShPath`, readable by this user only; answers the record. */
export async function recordEnvShExports(envShPath: string, exports: Iterable<readonly [string, string]>): Promise<EnvShExports> {
  const record = await readRecord(envShPath);
  for (const [key, value] of exports) {
    const digest = exportDigest(key, value);
    const kept = (record.get(key) ?? []).filter((entry) => entry !== digest);
    record.set(key, [...kept, digest].slice(-KEPT_PER_KEY));
  }
  await writeJsonAtomic(recordPath(envShPath), Object.fromEntries(record), { mode: 0o600 });
  return new Map([...record].map(([key, digests]) => [key, new Set(digests)]));
}
