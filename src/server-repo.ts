/**
 * Git-free team repo backed by the TeamAI management backend (issue #341).
 *
 * `repo.kind === 'server'`: the backend is the source of truth; this module logs
 * the machine in with the OAuth device flow, binds the workspace to projects,
 * pulls a full snapshot (content by sha256, 304 when unchanged) and materializes
 * it into `localPath` in the same layout a git clone would have. Everything
 * downstream (ResourceHandlers, hooks, recall) is unchanged.
 *
 * Local state:
 *   ~/.teamai/server-credentials.json   access + refresh token, machine id (0600)
 *   ~/.teamai/blobs/<sha256>            content-addressed cache
 *   <localPath>/.server-journal.json    what we wrote, for conflict detection
 *   <localPath>/.server-snapshot.json   last snapshot (used by push/contribute)
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { ensureDir, pathExists, readJson, writeJsonAtomic } from './utils/fs.js';
import { getUserHome } from './utils/home.js';
import { log } from './utils/logger.js';
import type { LocalConfig } from './types.js';
import { renderSnapshot, type ServerSnapshot } from './server-format.js';

const require = createRequire(import.meta.url);
const { version: CLI_VERSION } = require('../package.json') as { version: string };

export const JOURNAL_FILE = '.server-journal.json';
export const SNAPSHOT_FILE = '.server-snapshot.json';

export interface ServerCredentials {
  server: string;
  accessToken: string;
  refreshToken: string;
  machineId: string;
}

export interface Journal {
  revision: string;
  files: Record<string, string>; // relative path → sha256 hex
}

export interface ServerProject {
  id: string;
  slug: string;
  name: string;
  archived?: boolean;
}

export class ServerError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(`${status} ${code}: ${message}`);
  }
}

// ── local state ──────────────────────────────────────────────

export function getCredentialsPath(): string {
  return path.join(getUserHome(), '.teamai', 'server-credentials.json');
}

function blobCacheDir(): string {
  return path.join(getUserHome(), '.teamai', 'blobs');
}

export async function loadCredentials(): Promise<ServerCredentials | null> {
  return readJson<ServerCredentials>(getCredentialsPath());
}

export async function saveCredentials(c: ServerCredentials): Promise<void> {
  await ensureDir(path.dirname(getCredentialsPath()));
  await fs.promises.writeFile(getCredentialsPath(), JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
  await fs.promises.chmod(getCredentialsPath(), 0o600);
}

export async function clearCredentials(): Promise<void> {
  try { await fs.promises.unlink(getCredentialsPath()); } catch { /* absent */ }
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Stable id of this workspace on this machine; never leaves the machine as a path. */
export function workspaceId(dir: string): string {
  return sha256Hex(dir).slice(0, 32);
}

function fingerprint(): string {
  return sha256Hex(`${os.hostname()}|${getUserHome()}`).slice(0, 32);
}

// ── HTTP ─────────────────────────────────────────────────────

async function readError(res: Response): Promise<ServerError> {
  let code = 'HTTP_ERROR';
  let message = res.statusText;
  try {
    const body = await res.json() as { error?: { code?: string; message?: string } };
    code = body.error?.code ?? code;
    message = body.error?.message ?? message;
  } catch { /* not json */ }
  return new ServerError(res.status, code, message);
}

export async function serverFetch(
  server: string,
  token: string | null,
  method: string,
  route: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const h: Record<string, string> = { 'X-Client-Version': CLI_VERSION, ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload: BodyInit | undefined;
  if (body instanceof Buffer) {
    payload = new Blob([new Uint8Array(body)]);
    h['Content-Type'] = h['Content-Type'] ?? 'application/octet-stream';
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    h['Content-Type'] = 'application/json';
  }
  return fetch(`${server}${route}`, { method, headers: h, body: payload });
}

async function refresh(creds: ServerCredentials): Promise<void> {
  const res = await serverFetch(creds.server, null, 'POST', '/v1/auth/token', { refresh_token: creds.refreshToken });
  if (!res.ok) throw await readError(res);
  const tok = await res.json() as { access_token: string; refresh_token: string };
  creds.accessToken = tok.access_token;
  creds.refreshToken = tok.refresh_token;
  await saveCredentials(creds);
}

/** Authenticated call with one transparent token refresh on 401. */
export async function apiCall<T = unknown>(
  creds: ServerCredentials,
  method: string,
  route: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; data: T; etag: string | null }> {
  let res = await serverFetch(creds.server, creds.accessToken, method, route, body, headers);
  if (res.status === 401) {
    await refresh(creds); // throws when the device was revoked → caller shows "re-login"
    res = await serverFetch(creds.server, creds.accessToken, method, route, body, headers);
  }
  if (res.status === 304) return { status: 304, data: undefined as T, etag: res.headers.get('etag') };
  if (!res.ok) throw await readError(res);
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : undefined) as T, etag: res.headers.get('etag') };
}

// ── onboarding ───────────────────────────────────────────────

export interface Capabilities {
  version: string;
  api_version?: string;
  min_client_version?: string;
  auth: string[];
}

export async function fetchCapabilities(server: string): Promise<Capabilities> {
  const res = await serverFetch(server, null, 'GET', '/v1/capabilities');
  if (!res.ok) throw await readError(res);
  const caps = await res.json() as Capabilities;
  if (caps.api_version && caps.api_version !== 'v1') {
    throw new Error(`Server speaks API ${caps.api_version}; this CLI supports v1.`);
  }
  return caps;
}

export interface DeviceLoginResult {
  credentials: ServerCredentials;
  enrollmentProjectIds: string[];
}

/**
 * OAuth device flow: print a short code, let the member approve it in the
 * browser (or an admin's enrollment code pre-approves the project scope), poll
 * until the server hands back tokens. No git, no API key to copy around.
 */
export async function deviceLogin(
  server: string,
  opts: { enrollmentCode?: string; onCode?: (userCode: string, url: string) => void; sleep?: (ms: number) => Promise<void> } = {},
): Promise<DeviceLoginResult> {
  const start = await serverFetch(server, null, 'POST', '/v1/auth/device/start', {
    fingerprint: fingerprint(),
    hostname: os.hostname(),
    os: process.platform,
    enrollment_code: opts.enrollmentCode ?? '',
  });
  if (!start.ok) throw await readError(start);
  const s = await start.json() as { device_code: string; user_code: string; verification_url: string; interval?: number };
  (opts.onCode ?? ((code, url) => log.info(`Open ${url} and enter code: ${code}`)))(s.user_code, s.verification_url);

  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const interval = Math.max(s.interval ?? 2, 2) * 1000;
  for (;;) {
    await sleep(interval);
    const res = await serverFetch(server, null, 'POST', '/v1/auth/device/poll', { device_code: s.device_code });
    if (res.ok) {
      const tok = await res.json() as { access_token: string; refresh_token: string; machine_id: string; enrollment_project_ids?: string[] };
      const credentials = { server, accessToken: tok.access_token, refreshToken: tok.refresh_token, machineId: tok.machine_id };
      await saveCredentials(credentials);
      return { credentials, enrollmentProjectIds: tok.enrollment_project_ids ?? [] };
    }
    const err = await readError(res);
    if (err.code === 'AUTHORIZATION_PENDING') continue;
    throw err;
  }
}

export async function listProjects(creds: ServerCredentials): Promise<ServerProject[]> {
  const { data } = await apiCall<{ items: ServerProject[] }>(creds, 'GET', '/v1/projects');
  return (data.items ?? []).filter((p) => !p.archived);
}

export async function createBinding(
  creds: ServerCredentials,
  dir: string,
  projectIds: string[],
): Promise<string> {
  const { data } = await apiCall<{ id: string }>(creds, 'POST', '/v1/bindings', {
    workspace_id: workspaceId(dir),
    display_name: path.basename(dir),
    project_ids: projectIds,
  });
  return data.id;
}

export async function deleteBinding(creds: ServerCredentials, bindingId: string): Promise<void> {
  try {
    await apiCall(creds, 'DELETE', `/v1/bindings/${bindingId}`);
  } catch (e) {
    if (!(e instanceof ServerError && e.status === 404)) throw e;
  }
}

export async function revokeDevice(creds: ServerCredentials): Promise<void> {
  await apiCall(creds, 'POST', '/v1/auth/revocations', { machine_id: creds.machineId });
}

// ── blobs ────────────────────────────────────────────────────

export async function readBlob(creds: ServerCredentials, sha: string): Promise<Buffer> {
  const hex = sha.replace(/^sha256:/, '');
  const cached = path.join(blobCacheDir(), hex);
  try {
    const b = await fs.promises.readFile(cached);
    if (sha256Hex(b) === hex) return b;
  } catch { /* miss */ }
  let res = await serverFetch(creds.server, creds.accessToken, 'GET', `/v1/blobs/${sha}`);
  if (res.status === 401) {
    await refresh(creds);
    res = await serverFetch(creds.server, creds.accessToken, 'GET', `/v1/blobs/${sha}`);
  }
  if (!res.ok) throw await readError(res);
  const b = Buffer.from(await res.arrayBuffer());
  if (sha256Hex(b) !== hex) throw new Error(`blob ${sha} failed integrity check`);
  await ensureDir(blobCacheDir());
  await fs.promises.writeFile(cached, b);
  return b;
}

// ── journal + materialize ────────────────────────────────────

export async function loadJournal(localPath: string): Promise<Journal> {
  const j = await readJson<Journal>(path.join(localPath, JOURNAL_FILE));
  return { revision: j?.revision ?? '', files: j?.files ?? {} };
}

async function saveJournal(localPath: string, j: Journal): Promise<void> {
  await writeJsonAtomic(path.join(localPath, JOURNAL_FILE), j);
}

export async function loadSnapshot(localPath: string): Promise<ServerSnapshot | null> {
  return readJson<ServerSnapshot>(path.join(localPath, SNAPSHOT_FILE));
}

export interface ApplyResult {
  kind: string;
  name: string;
  action: 'installed' | 'updated' | 'removed' | 'conflict_skipped' | 'failed';
}

async function writeAtomic(abs: string, content: Buffer): Promise<void> {
  await ensureDir(path.dirname(abs));
  const tmp = `${abs}.server-tmp`;
  await fs.promises.writeFile(tmp, content);
  await fs.promises.rename(tmp, abs);
}

async function removeEmptyParents(root: string, file: string): Promise<void> {
  let dir = path.dirname(file);
  while (dir !== root && dir.startsWith(root)) {
    try { await fs.promises.rmdir(dir); } catch { return; }
    dir = path.dirname(dir);
  }
}

/** Reverse-map a rendered path to (kind, name) for the sync report. */
export function classify(rel: string): { kind: string; name: string } {
  const parts = rel.split('/');
  if (parts[0] === 'skills' && parts.length >= 2) return { kind: 'skill', name: parts[1] };
  if (parts[0] === 'rules' && parts.length === 2) return { kind: 'rule', name: parts[1].replace(/\.md$/, '') };
  if (parts[0] === 'docs' && parts.length >= 2) return { kind: 'doc', name: rel.slice('docs/'.length) };
  if (parts[0] === 'agents' && parts.length === 2) return { kind: 'agent', name: parts[1].replace(/\.yaml$/, '') };
  if (parts[0] === 'claudemd' && parts.length === 3) return { kind: 'claudemd', name: parts[2].replace(/\.md$/, '') };
  if (parts[0] === 'learnings' && parts.length === 2) return { kind: 'learning', name: parts[1].replace(/\.md$/, '') };
  if (rel === 'env/env.yaml') return { kind: 'env', name: 'env.yaml' };
  if (parts[0] === 'hooks') return { kind: 'hook', name: rel.slice('hooks/'.length) };
  if (rel === 'mcp/mcp.yaml') return { kind: 'mcp', name: 'mcp.yaml' };
  if (rel === 'culture.md') return { kind: 'culture', name: 'culture' };
  if (rel === 'teamai.yaml' || rel === 'tags.yaml') return { kind: 'policy', name: rel };
  return { kind: 'doc', name: rel };
}

/**
 * Write rendered files under localPath, honouring local edits.
 *
 * Per file: absent → write (installed); on disk == journal hash → overwrite
 * (updated); on disk differs from both → the member edited it → conflict_skipped,
 * left untouched. Files in the previous journal but not in this render are
 * removed only when still byte-identical to what we wrote.
 */
export async function applyFiles(
  localPath: string,
  files: Map<string, Buffer>,
  previous: Journal,
): Promise<{ results: ApplyResult[]; journal: Journal }> {
  const results: ApplyResult[] = [];
  const journal: Journal = { revision: '', files: {} };

  for (const rel of [...files.keys()].sort()) {
    const content = files.get(rel)!;
    const want = sha256Hex(content);
    const abs = path.join(localPath, ...rel.split('/'));
    const { kind, name } = classify(rel);
    let current: Buffer | null = null;
    try { current = await fs.promises.readFile(abs); } catch { /* absent */ }

    if (current === null) {
      try { await writeAtomic(abs, content); results.push({ kind, name, action: 'installed' }); }
      catch { results.push({ kind, name, action: 'failed' }); continue; }
    } else if (sha256Hex(current) === want) {
      // already the target content
    } else if (previous.files[rel] === sha256Hex(current)) {
      try { await writeAtomic(abs, content); results.push({ kind, name, action: 'updated' }); }
      catch { results.push({ kind, name, action: 'failed' }); continue; }
    } else {
      // The member edited this file: it is theirs now. Deliberately NOT recorded in
      // the journal, so a later removal pass can never treat it as ours and delete it.
      results.push({ kind, name, action: 'conflict_skipped' });
      continue;
    }
    journal.files[rel] = want;
  }

  for (const [rel, sum] of Object.entries(previous.files)) {
    if (files.has(rel)) continue;
    const abs = path.join(localPath, ...rel.split('/'));
    const { kind, name } = classify(rel);
    let current: Buffer | null = null;
    try { current = await fs.promises.readFile(abs); } catch { continue; }
    if (sha256Hex(current) !== sum) {
      results.push({ kind, name, action: 'conflict_skipped' });
      continue;
    }
    await fs.promises.unlink(abs);
    await removeEmptyParents(localPath, abs);
    results.push({ kind, name, action: 'removed' });
  }
  return { results, journal };
}

// ── sync ─────────────────────────────────────────────────────

export interface SyncOutcome {
  revision: string;
  changed: boolean;
  results: ApplyResult[];
  conflicts: Array<{ kind: string; name: string }>;
}

/**
 * Pull the binding's snapshot and materialize it. Returns `changed: false` on
 * 304 (nothing to do). Sync results are reported back best-effort; a failed
 * report never blocks the local update and is retried on the next sync.
 */
export async function syncServerRepo(
  localConfig: LocalConfig,
  opts: { force?: boolean } = {},
): Promise<SyncOutcome> {
  const creds = await loadCredentials();
  if (!creds) throw new Error('Not logged in to the team server. Run `teamai init --server <url>` again.');
  const bindingId = localConfig.repo.bindingId;
  if (!bindingId) throw new Error('This directory is not bound to any project. Run `teamai init --server <url>` here.');
  const localPath = localConfig.repo.localPath;
  await ensureDir(localPath);
  const previous = await loadJournal(localPath);

  const headers: Record<string, string> = {};
  if (previous.revision && !opts.force) headers['If-None-Match'] = `"${previous.revision}"`;
  let snapRes: { status: number; data: ServerSnapshot };
  try {
    snapRes = await apiCall<ServerSnapshot>(creds, 'GET', `/v1/bindings/${bindingId}/snapshot`, undefined, headers);
  } catch (e) {
    if (e instanceof ServerError && e.status === 401) {
      throw new Error('This device was revoked or the login expired. Run `teamai init --server <url>` to log in again.');
    }
    throw e;
  }
  if (snapRes.status === 304) {
    return { revision: previous.revision, changed: false, results: [], conflicts: [] };
  }
  const snap = snapRes.data;

  const files = await renderSnapshot(snap, (sha) => readBlob(creds, sha), creds.server);
  const { results, journal } = await applyFiles(localPath, files, previous);
  journal.revision = snap.revision;
  await saveJournal(localPath, journal);
  await writeJsonAtomic(path.join(localPath, SNAPSHOT_FILE), snap);

  try {
    await apiCall(creds, 'POST', `/v1/bindings/${bindingId}/sync-results`, {
      applied_revision: snap.revision,
      results: results.map((r) => ({ kind: r.kind, name: r.name, action: r.action })),
    });
  } catch (e) {
    log.debug(`sync-results report failed (will retry next sync): ${(e as Error).message}`);
  }

  const conflicts = snap.resources.filter((e) => e.status === 'conflict').map((e) => ({ kind: e.kind, name: e.name }));
  return { revision: snap.revision, changed: true, results, conflicts };
}

/** Remove everything the journal says we wrote and that the member never edited. */
export async function purgeOwned(localPath: string): Promise<number> {
  const journal = await loadJournal(localPath);
  let n = 0;
  for (const [rel, sum] of Object.entries(journal.files)) {
    const abs = path.join(localPath, ...rel.split('/'));
    try {
      const cur = await fs.promises.readFile(abs);
      if (sha256Hex(cur) !== sum) continue;
      await fs.promises.unlink(abs);
      await removeEmptyParents(localPath, abs);
      n++;
    } catch { /* absent */ }
  }
  for (const f of [JOURNAL_FILE, SNAPSHOT_FILE]) {
    if (await pathExists(path.join(localPath, f))) await fs.promises.unlink(path.join(localPath, f));
  }
  return n;
}

// ── write direction ──────────────────────────────────────────

export interface ChangeOp {
  op: 'put' | 'delete';
  level: 'org' | 'team' | 'project';
  team_id?: string;
  project_id?: string;
  kind: string;
  name: string;
  files?: Array<{ path: string; sha256: string; size: number }>;
  expected_prev_version?: number;
}

export interface ChangesetResp {
  id: string;
  state: string;
  title: string;
  etag: string;
  ops: ChangeOp[];
}

export async function uploadBlob(creds: ServerCredentials, content: Buffer): Promise<{ sha256: string; size: number }> {
  const sha = `sha256:${sha256Hex(content)}`;
  await apiCall(creds, 'POST', '/v1/blobs', content, { 'X-Sha256': sha });
  return { sha256: sha, size: content.length };
}

function opKey(o: ChangeOp): string {
  return [o.level, o.team_id ?? '', o.project_id ?? '', o.kind, o.name].join('|');
}

/** My open (draft / in_review) changeset that already touches one of these resources, if any. */
async function findOpenChangeset(creds: ServerCredentials, ops: ChangeOp[]): Promise<ChangesetResp | null> {
  const { data } = await apiCall<{ items: ChangesetResp[] }>(creds, 'GET', '/v1/change-sets?view=mine');
  const wanted = new Set(ops.map(opKey));
  for (const cs of data.items ?? []) {
    if (cs.state !== 'draft' && cs.state !== 'in_review') continue;
    if ((cs.ops ?? []).some((o) => wanted.has(opKey(o)))) {
      const full = await apiCall<ChangesetResp>(creds, 'GET', `/v1/change-sets/${cs.id}`);
      return full.data;
    }
  }
  return null;
}

/**
 * Create a change set and submit it for review — or fold the operations into
 * my open change set that already carries one of these resources, so editing a
 * resource under review updates that review instead of opening a second one
 * (what `teamai push` does with an existing MR).
 */
export async function submitChangeset(
  creds: ServerCredentials,
  input: { title: string; description?: string; ops: ChangeOp[]; fastTrack?: boolean },
): Promise<ChangesetResp> {
  const body: Record<string, unknown> = { title: input.title, description: input.description ?? '', ops: input.ops, fast_track: !!input.fastTrack };
  let cs: ChangesetResp;
  const existing = await findOpenChangeset(creds, input.ops);
  if (existing) {
    const replaced = new Set(input.ops.map(opKey));
    body.ops = [...(existing.ops ?? []).filter((o) => !replaced.has(opKey(o))), ...input.ops];
    body.title = existing.title || input.title;
    cs = (await apiCall<ChangesetResp>(creds, 'PATCH', `/v1/change-sets/${existing.id}`, body, { 'If-Match': `"${existing.etag}"` })).data;
    log.info(`Updated your open change set ${cs.id.slice(0, 8)}`);
  } else {
    cs = (await apiCall<ChangesetResp>(creds, 'POST', '/v1/change-sets', body)).data;
  }
  cs = (await apiCall<ChangesetResp>(creds, 'POST', `/v1/change-sets/${cs.id}/submit`)).data;
  if (input.fastTrack) {
    cs = (await apiCall<ChangesetResp>(creds, 'POST', `/v1/change-sets/${cs.id}/publish`)).data;
  }
  return cs;
}

export function changesetUrl(creds: ServerCredentials, id: string): string {
  return `${creds.server}/#/changesets/${id}`;
}

export async function contributeLearning(
  creds: ServerCredentials,
  input: { title: string; content: string; projectId?: string; tags?: string[] },
): Promise<ChangesetResp> {
  const { data } = await apiCall<ChangesetResp>(creds, 'POST', '/v1/learnings', {
    title: input.title, content: input.content, project_id: input.projectId, tags: input.tags,
  });
  return data;
}

export async function listTeams(creds: ServerCredentials): Promise<Array<{ id: string; slug: string }>> {
  const { data } = await apiCall<{ items: Array<{ id: string; slug: string }> }>(creds, 'GET', '/v1/teams');
  return data.items ?? [];
}

// ── reporting ────────────────────────────────────────────────

export interface ReportEvent {
  event_id: string;
  seq: number;
  type: 'vote_delta' | 'session_summary' | 'usage_daily' | 'skill_usage' | 'tool_use';
  occurred_at: string;
  payload: Record<string, unknown>;
}

function seqPath(): string {
  return path.join(getUserHome(), '.teamai', 'server-report-seq.json');
}

/** Monotonic per-machine sequence; the server dedupes on (machine, event_id). */
export async function nextSeq(count: number): Promise<number> {
  const cur = (await readJson<{ seq: number }>(seqPath()))?.seq ?? 0;
  await writeJsonAtomic(seqPath(), { seq: cur + count });
  return cur + 1;
}

export async function reportEvents(creds: ServerCredentials, events: ReportEvent[]): Promise<{ accepted: string[] }> {
  if (events.length === 0) return { accepted: [] };
  const { data } = await apiCall<{ accepted: string[] }>(creds, 'POST', '/v1/reports/events', { events });
  return data;
}
