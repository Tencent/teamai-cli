import type { PrCreateOptions } from '../types.js';
import { getGitCodeToken, gitcodeApiBase } from './gitcode-api.js';
import { GITCODE_HOST } from './repo-url.js';

interface Pull { html_url: string; state: string; head: { ref: string; repo?: { full_name?: string } }; base: { ref: string; repo?: { full_name?: string } } }
function matches(pull: Pull, opts: PrCreateOptions): boolean {
  return pull.state === 'open' && pull.head.ref === opts.source && pull.base.ref === opts.target
    && (!pull.head.repo?.full_name || pull.head.repo.full_name === opts.repo)
    && (!pull.base.repo?.full_name || pull.base.repo.full_name === opts.repo);
}
async function request(route: string, opts: PrCreateOptions): Promise<unknown> {
  const token = getGitCodeToken();
  if (!token) throw new Error('GitCode authentication unavailable. Set GITCODE_TOKEN before resuming.');
  const response = await fetch(`${gitcodeApiBase()}/repos/${opts.repo}/pulls${route}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, redirect: 'manual',
    signal: AbortSignal.timeout(opts.spawnTimeoutMs ?? 30_000),
  });
  if (!response.ok) throw new Error(`GitCode PR lookup failed (${response.status}). Check token and repository access.`);
  return response.json().catch(() => { throw new Error('gitcode review lookup returned invalid data.'); });
}
export async function findGitCodePull(opts: PrCreateOptions): Promise<string | undefined> {
  for (let page = 1; page <= 20; page += 1) {
    const query = new URLSearchParams({ state: 'open', base: opts.target, per_page: '100', page: String(page) });
    const pulls = await request(`?${query}`, opts) as Pull[];
    const found = pulls.find((pull) => matches(pull, opts));
    if (found) return found.html_url;
    if (pulls.length < 100) return undefined;
  }
  throw new Error('Too many open GitCode requests to establish whether this branch already has one. Inspect it manually.');
}
export async function validateGitCodePull(value: string, opts: PrCreateOptions): Promise<boolean | undefined> {
  const url = new URL(value);
  if (url.hostname !== GITCODE_HOST) return undefined;
  const prefix = `/${opts.repo}/pull/`;
  if (!url.pathname.startsWith(prefix) || !/^\d+\/?$/.test(url.pathname.slice(prefix.length))) return false;
  return matches(await request(`/${url.pathname.slice(prefix.length).replace(/\/$/, '')}`, opts) as Pull, opts);
}
