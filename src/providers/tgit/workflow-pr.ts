import type { PrCreateOptions } from '../types.js';
import { tgitFetch } from './rest-auth.js';

interface MergeRequest { web_url: string; state: string; source_branch: string; target_branch: string; source_project_id: number; target_project_id: number }
function matches(mr: MergeRequest, opts: PrCreateOptions): boolean {
  return mr.state === 'opened' && mr.source_branch === opts.source && mr.target_branch === opts.target
    && mr.source_project_id === mr.target_project_id;
}
async function list(opts: PrCreateOptions, query: URLSearchParams): Promise<MergeRequest[]> {
  const response = await tgitFetch(`/projects/${encodeURIComponent(opts.repo)}/merge_requests?${query}`, {
    redirect: 'manual', signal: AbortSignal.timeout(opts.spawnTimeoutMs ?? 30_000),
  });
  if (!response.ok) throw new Error(`TGit MR lookup failed (${response.status}). Check TGIT_TOKEN or gf authentication.`);
  return response.json().catch(() => { throw new Error('TGit MR lookup returned invalid data.'); }) as Promise<MergeRequest[]>;
}
export async function findTGitMergeRequest(opts: PrCreateOptions): Promise<string | undefined> {
  for (let page = 1; page <= 20; page += 1) {
    const requests = await list(opts, new URLSearchParams({ state: 'opened', source_branch: opts.source, target_branch: opts.target, per_page: '100', page: String(page) }));
    const found = requests.find((mr) => matches(mr, opts));
    if (found) return found.web_url;
    if (requests.length < 100) return undefined;
  }
  throw new Error('Too many open TGit requests to establish whether this branch already has one. Inspect it manually.');
}
export async function validateTGitMergeRequest(value: string, opts: PrCreateOptions): Promise<boolean | undefined> {
  const url = new URL(value);
  if (url.hostname !== 'git.woa.com') return undefined;
  const match = /^\/(.+?)\/(?:-\/)?merge_requests\/(\d+)\/?$/.exec(url.pathname);
  if (!match || match[1] !== opts.repo) return false;
  const requests = await list(opts, new URLSearchParams({ iid: match[2]! }));
  return requests.length === 1 && matches(requests[0]!, opts);
}
