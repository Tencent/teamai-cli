import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { getUserHome, legacyUserHome } from '../../utils/home.js';
import path from 'node:path';
import type { PrCreateOptions } from '../types.js';
import { RepoCreatePermissionError } from '../types.js';
import { sanitizeGitUrl } from '../../utils/redact.js';
import { log } from '../../utils/logger.js';
import { giteaApiBase, giteaBaseUrl, giteaRepoPath, parseGiteaRepoInput, parseGiteaPrUrl } from './repo-url.js';

// env / netrc → verified login → REST requests / persistent Git credentials.
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const logins = new Map<string, string>();

export class GiteaApiError extends Error {
  constructor(readonly status: number) {
    super(status === 401 ? 'Gitea token rejected: update GITEA_TOKEN or ~/.netrc.'
      : status === 403 ? 'Gitea permission denied: check token scopes and repository access.'
      : status === 404 ? 'Gitea resource not found or not accessible.'
      : `Gitea API HTTP ${status}.`);
    this.name = 'GiteaApiError';
  }
}

function netrcFile(): string { return path.join(getUserHome(), '.netrc'); }

/** Read a host-scoped netrc entry, including entries spread over several lines. */
function netrcToken(): string | null {
  if (!process.env.GITEA_URL?.trim()) return null;
  const host = new URL(giteaBaseUrl()).hostname;
  const legacy = legacyUserHome();
  for (const file of [netrcFile(), ...(legacy ? [path.join(legacy, '.netrc')] : [])]) {
    try {
      const tokens = fs.readFileSync(file, 'utf8').replace(/#[^\n]*/g, '').match(/\S+/g) ?? [];
      let machine = '';
      for (let i = 0; i < tokens.length; i++) {
        if (tokens[i] === 'machine') machine = tokens[++i]?.toLowerCase() ?? '';
        else if (tokens[i] === 'default' || tokens[i] === 'macdef') machine = '';
        else if (tokens[i] === 'password') {
          const password = tokens[++i];
          if (machine === host && password) return password;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return null;
}

export function getGiteaToken(): string | null {
  return process.env.GITEA_TOKEN?.trim() || netrcToken();
}

export function giteaIsAuthenticated(): boolean { return getGiteaToken() !== null; }

export function writeGiteaNetrcToken(token: string, login: string): void {
  if (!token || /\s/.test(token) || !login || /\s/.test(login)) throw new Error('Invalid Gitea credential.');
  const host = new URL(giteaBaseUrl()).hostname;
  const file = netrcFile();
  let previous = '';
  try { previous = fs.readFileSync(file, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const retained = previous.replace(/\bmachine\s+(\S+)[\s\S]*?(?=\bmachine\s+|\bdefault\b|\bmacdef\b|$)/g,
    (entry, name: string) => name.toLowerCase() === host ? '' : entry).trimEnd();
  const entry = `machine ${host} login ${login} password ${token}\n`;
  fs.writeFileSync(file, retained ? `${retained}\n${entry}` : entry, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/** Strip both URL credentials and headers from Git failures, including timeouts. */
export function redactGiteaOutput(text: string): string {
  let result = sanitizeGitUrl(text).replace(/(Authorization:\s*(?:Basic|token)\s+)\S+/gi, '$1***');
  let token = process.env.GITEA_TOKEN?.trim();
  try { token ||= getGiteaToken() ?? undefined; } catch { /* Invalid config must not break error redaction. */ }
  if (token) {
    for (const secret of [token, encodeURIComponent(token)]) result = result.split(secret).join('***');
  }
  return result;
}

/** Cancel at the byte limit rather than buffering an unbounded response first. */
export async function readGiteaText(response: Response, limit: number, truncate = false): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { text: '', truncated: false };
  const chunks: Uint8Array[] = [];
  let remaining = limit;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > remaining) {
        if (!truncate) throw new Error('Gitea API response exceeds the configured size limit.');
        chunks.push(value.subarray(0, remaining));
        truncated = true;
        break;
      }
      chunks.push(value);
      remaining -= value.byteLength;
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  // A streaming decoder holds an incomplete final UTF-8 sequence instead of emitting U+FFFD.
  const decoder = new TextDecoder();
  const buffer = Buffer.concat(chunks);
  const text = decoder.decode(buffer, { stream: truncated });
  return { text, truncated };
}

export async function giteaRequest(
  route: string,
  options: { method?: string; body?: unknown; token?: string; textLimit?: number } = {},
): Promise<{ text: string; headers: Headers; truncated: boolean }> {
  const api = `${giteaApiBase()}/`;
  const url = new URL(route.replace(/^\//, ''), api);
  if (!url.href.startsWith(api)) throw new Error('Invalid Gitea API route.');
  const token = options.token ?? getGiteaToken();
  if (!token) throw new Error('Gitea authentication unavailable. Set GITEA_TOKEN or run teamai init interactively.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET', redirect: 'manual', signal: controller.signal,
      headers: { Authorization: `token ${token}`, Accept: options.textLimit ? 'text/plain' : 'application/json', 'Content-Type': 'application/json' },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new GiteaApiError(response.status); }
    return { ...await readGiteaText(response, options.textLimit ?? MAX_JSON_BYTES, options.textLimit !== undefined), headers: response.headers };
  } catch (error) {
    if (error instanceof GiteaApiError) throw error;
    throw new Error(`Gitea request failed: ${redactGiteaOutput((error as Error).message)}`);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export async function giteaJson<T>(route: string, options?: Parameters<typeof giteaRequest>[1]): Promise<T> {
  const { text } = await giteaRequest(route, options);
  if (!text.trim()) return undefined as T;
  try { return JSON.parse(text) as T; } catch { throw new Error('Gitea API returned invalid JSON.'); }
}

/** Follow pages even when the server clamps limit below the requested value. */
export async function giteaList<T>(route: string, maxItems?: number): Promise<T[]> {
  if (maxItems !== undefined && (!Number.isSafeInteger(maxItems) || maxItems < 0)) throw new Error('Invalid maxRepos: expected a non-negative integer.');
  const items: T[] = [];
  let page = 1;
  while (maxItems === undefined || items.length < maxItems) {
    const url = new URL(route.replace(/^\//, ''), `${giteaApiBase()}/`);
    url.searchParams.set('page', String(page));
    url.searchParams.set('limit', '50');
    const { text, headers } = await giteaRequest(url.href.slice(giteaApiBase().length));
    const batch: unknown = JSON.parse(text);
    if (!Array.isArray(batch)) throw new Error('Gitea API returned an invalid list.');
    if (!batch.length) return items;
    items.push(...batch as T[]);
    if (maxItems !== undefined && items.length >= maxItems) {
      log.warn(`Gitea repository list reached maxRepos=${maxItems}; additional results may be omitted.`);
      return items.slice(0, maxItems);
    }
    // Gitea issue comments may ignore page while returning all results with a
    // total count. Do not append that same complete list up to the page budget.
    const totalHeader = headers.get('x-total-count');
    const total = totalHeader && /^\d+$/.test(totalHeader) ? Number(totalHeader) : undefined;
    if (total !== undefined && Number.isSafeInteger(total) && items.length >= total) return items;
    const link = headers.get('link');
    const next = link?.match(/<([^>]+)>;\s*rel="?next"?/i)?.[1];
    if (link && !next) return items;
    if (next) {
      const nextUrl = new URL(next, url);
      const nextPage = Number(nextUrl.searchParams.get('page'));
      if (nextUrl.origin !== url.origin || nextUrl.pathname !== url.pathname || !Number.isSafeInteger(nextPage) || nextPage <= page) {
        throw new Error('Gitea returned an invalid next-page link.');
      }
      page = nextPage;
    } else page++;
    if (page > 1000) throw new Error('Gitea pagination budget exceeded; results are incomplete.');
  }
  return items;
}

export async function giteaWhoami(token = getGiteaToken()): Promise<string> {
  if (!token) throw new Error('Gitea authentication unavailable. Set GITEA_TOKEN.');
  const key = `${giteaBaseUrl()}\n${token}`;
  const cached = logins.get(key);
  if (cached) return cached;
  const user = await giteaJson<{ login?: string }>('/user', { token });
  if (!user?.login) throw new Error('Gitea /user response did not include a login.');
  logins.set(key, user.login);
  return user.login;
}

// The provider's clone/org-existence interface is synchronous. A Node child keeps
// that contract without introducing a curl dependency or putting PATs in argv.
const SYNC_GET = `
import fs from 'node:fs';
const { url, token } = JSON.parse(fs.readFileSync(0, 'utf8'));
const r = await fetch(url, { headers: { Authorization: 'token ' + token }, redirect: 'manual', signal: AbortSignal.timeout(10000) });
let size = 0;
const chunks = [];
if (r.body) for await (const chunk of r.body) {
  size += chunk.length;
  if (size > 1048576) throw new Error('Response too large');
  chunks.push(chunk);
}
process.stdout.write(JSON.stringify({ status: r.status, text: Buffer.concat(chunks).toString('utf8') }));
`;

export function giteaGetSync<T>(route: string): T {
  const token = getGiteaToken();
  if (!token) throw new Error('Gitea authentication unavailable. Set GITEA_TOKEN.');
  const url = `${giteaApiBase()}${route}`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', SYNC_GET], {
    input: JSON.stringify({ url, token }), encoding: 'utf8', timeout: 12_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
  });
  if (result.status !== 0) throw new Error('Gitea lookup failed or timed out. Check the instance URL and network.');
  const response = JSON.parse(result.stdout) as { status: number; text: string };
  if (response.status !== 200) throw new GiteaApiError(response.status);
  return JSON.parse(response.text) as T;
}

/** One-off HTTP authentication used by both shallow clone and incremental fetch. */
export async function giteaGitHeader(): Promise<string | null> {
  const token = getGiteaToken();
  if (!token) return null;
  const login = await giteaWhoami(token);
  return `Authorization: Basic ${Buffer.from(`${login}:${token}`).toString('base64')}`;
}

export function giteaRepoClone(repo: string, localPath: string): void {
  const info = parseGiteaRepoInput(repo);
  const url = new URL(info.httpsUrl);
  const token = getGiteaToken();
  if (url.protocol !== 'ssh:' && token) {
    const key = `${giteaBaseUrl()}\n${token}`;
    const login = logins.get(key) ?? giteaGetSync<{ login: string }>('/user').login;
    if (!login) throw new Error('Gitea /user response did not include a login.');
    url.username = login;
    url.password = token;
  }
  const result = spawnSync('git', ['clone', url.href, localPath], {
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 120_000, windowsHide: true,
  });
  // Gitea deliberately hides inaccessible private repos behind 404. Do not turn
  // that ambiguous failure into init's automatic create-repository prompt.
  if (result.status !== 0) throw new Error(`Gitea git clone failed: ${redactGiteaOutput(`${result.stderr ?? ''} ${result.error?.message ?? ''}`).trim()}`);
}

export async function giteaCreateRepo(owner: string, repo: string): Promise<void> {
  const info = parseGiteaRepoInput(`${owner}/${repo}`);
  const login = await giteaWhoami();
  const personal = login.toLowerCase() === info.owner.toLowerCase();
  try {
    await giteaJson(personal ? '/user/repos' : `/orgs/${encodeURIComponent(info.owner)}/repos`, {
      method: 'POST', body: { name: info.repo, private: true, auto_init: false },
    });
  } catch (error) {
    if (error instanceof GiteaApiError && error.status === 403) throw new RepoCreatePermissionError(`${owner}/${repo}`, `${giteaBaseUrl()}/repo/create`);
    throw error;
  }
}

interface PullRequest {
  number: number;
  html_url: string;
  head: { ref: string; repo?: { id?: number; full_name?: string } };
  base: { ref: string; repo?: { id?: number; full_name?: string } };
  requested_reviewers?: Array<{ login: string }>;
}

export async function giteaPullCreate(options: PrCreateOptions): Promise<string> {
  const repo = parseGiteaRepoInput(options.repo);
  const route = giteaRepoPath(options.repo);
  let pull: PullRequest;
  try {
    pull = await giteaJson<PullRequest>(`${route}/pulls`, {
      method: 'POST', body: { head: options.source, base: options.target, title: options.title, body: options.description ?? '' },
    });
  } catch (error) {
    // Only ambiguous transport failures and duplicate PR conflicts are recoverable.
    if (error instanceof GiteaApiError && error.status !== 409) throw error;
    const expected = `${repo.owner}/${repo.repo}`.toLowerCase();
    const matches = (await giteaList<PullRequest>(`${route}/pulls?state=open`)).filter((pr) =>
      pr.head.ref === options.source && pr.base.ref === options.target
      && pr.head.repo?.full_name?.toLowerCase() === expected && pr.base.repo?.full_name?.toLowerCase() === expected);
    if (matches.length !== 1) throw error;
    pull = matches[0];
  }
  if (!Number.isSafeInteger(pull?.number) || pull.number <= 0 || !pull.html_url) throw new Error('Gitea PR response did not include a number and web URL.');
  const parsed = parseGiteaPrUrl(pull.html_url);
  if (parsed.owner.toLowerCase() !== repo.owner.toLowerCase() || parsed.repo.toLowerCase() !== repo.repo.toLowerCase() || parsed.number !== pull.number) {
    throw new Error('Gitea returned a PR URL for a different repository.');
  }
  // Submit individually so one misspelled login cannot discard valid reviewers.
  for (const reviewer of new Set(options.reviewers ?? [])) {
    const alreadyRequested = (pr: PullRequest): boolean => pr.requested_reviewers?.some((user) => user.login.toLowerCase() === reviewer.toLowerCase()) ?? false;
    if (alreadyRequested(pull)) continue;
    try {
      await giteaJson(`${route}/pulls/${pull.number}/requested_reviewers`, { method: 'POST', body: { reviewers: [reviewer] } });
    } catch (error) {
      if (error instanceof GiteaApiError && [409, 422].includes(error.status)) {
        try {
          if (alreadyRequested(await giteaJson<PullRequest>(`${route}/pulls/${pull.number}`))) continue;
        } catch { /* Keep the original reviewer failure visible if verification fails. */ }
      }
      log.warn(`Gitea PR created at ${pull.html_url}, but reviewer ${reviewer} could not be requested: ${redactGiteaOutput((error as Error).message)}`);
    }
  }
  return pull.html_url;
}
