import type { PrCreateOptions } from '../types.js';
import { getGitHubToken, ghExec, isGhInstalled } from './gh-cli.js';

interface Pull {
  html_url: string;
  state: string;
  head: { ref: string; repo: { full_name: string } | null };
  base: { ref: string; repo: { full_name: string } };
}

async function request(path: string, opts: PrCreateOptions): Promise<unknown> {
  if (isGhInstalled()) {
    const result = ghExec(['api', path], { cwd: opts.cwd, timeoutMs: opts.spawnTimeoutMs ?? 30_000 });
    if (result.status !== 0) throw new Error('GitHub PR lookup failed. Check gh authentication and repository access.');
    try { return JSON.parse(result.stdout) as unknown; }
    catch { throw new Error('GitHub PR lookup returned invalid data. Inspect gh before retrying.'); }
  }
  const token = getGitHubToken();
  if (!token) throw new Error('GitHub authentication unavailable. Set GITHUB_TOKEN or authenticate gh before resuming.');
  const response = await fetch(`https://api.github.com/${path}`, {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
    redirect: 'manual',
    signal: AbortSignal.timeout(opts.spawnTimeoutMs ?? 30_000),
  });
  if (!response.ok) throw new Error(`GitHub PR lookup failed (${response.status}). Check token and repository access.`);
  return response.json().catch(() => { throw new Error('GitHub PR lookup returned invalid data.'); });
}

function matches(pull: Pull, opts: PrCreateOptions): boolean {
  return pull.state === 'open' && pull.head.ref === opts.source && pull.base.ref === opts.target
    && pull.head.repo?.full_name.toLowerCase() === opts.repo.toLowerCase()
    && pull.base.repo.full_name.toLowerCase() === opts.repo.toLowerCase();
}

export async function findGitHubPull(opts: PrCreateOptions): Promise<string | undefined> {
  const query = new URLSearchParams({ state: 'open', head: `${opts.repo.split('/')[0]}:${opts.source}`, base: opts.target, per_page: '100' });
  const pulls = await request(`repos/${opts.repo}/pulls?${query}`, opts) as Pull[];
  return pulls.find((pull) => matches(pull, opts))?.html_url;
}

export async function validateGitHubPull(value: string, opts: PrCreateOptions): Promise<boolean | undefined> {
  const url = new URL(value);
  // A remote driver may use a separate review service. Validate recognized provider URLs only.
  if (url.hostname !== 'github.com') return undefined;
  const match = /^\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/.exec(url.pathname);
  if (!match || match[1]!.toLowerCase() !== opts.repo.toLowerCase()) return false;
  return matches(await request(`repos/${opts.repo}/pulls/${match[2]}`, opts) as Pull, opts);
}
