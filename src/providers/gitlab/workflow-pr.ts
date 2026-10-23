import type { PrCreateOptions } from '../types.js';
import { getGitLabToken, gitlabApiBase, gitlabBaseUrl } from './gitlab-api.js';

interface MergeRequest {
  web_url: string;
  state: string;
  source_branch: string;
  target_branch: string;
  source_project_id: number;
  target_project_id: number;
}

function matches(mr: MergeRequest, opts: PrCreateOptions): boolean {
  return mr.state === 'opened' && mr.source_branch === opts.source && mr.target_branch === opts.target
    && mr.source_project_id === mr.target_project_id;
}

async function request(route: string, opts: PrCreateOptions): Promise<unknown> {
  const token = getGitLabToken();
  if (!token) throw new Error('GitLab authentication unavailable. Set GITLAB_TOKEN before resuming.');
  const response = await fetch(`${gitlabApiBase()}/projects/${encodeURIComponent(opts.repo)}/merge_requests${route}`, {
    headers: { 'PRIVATE-TOKEN': token, Accept: 'application/json' }, redirect: 'manual',
    signal: AbortSignal.timeout(opts.spawnTimeoutMs ?? 30_000),
  });
  if (!response.ok) throw new Error(`GitLab MR lookup failed (${response.status}). Check token and repository access.`);
  return response.json().catch(() => { throw new Error('gitlab review lookup returned invalid data.'); });
}

export async function findGitLabMergeRequest(opts: PrCreateOptions): Promise<string | undefined> {
  const query = new URLSearchParams({ state: 'opened', source_branch: opts.source, target_branch: opts.target, per_page: '100' });
  const requests = await request(`?${query}`, opts) as MergeRequest[];
  return requests.find((mr) => matches(mr, opts))?.web_url;
}

export async function validateGitLabMergeRequest(value: string, opts: PrCreateOptions): Promise<boolean | undefined> {
  const base = new URL(gitlabBaseUrl());
  const url = new URL(value);
  if (url.origin !== base.origin) return undefined;
  const prefix = `${base.pathname.replace(/\/$/, '')}/${opts.repo}/-/merge_requests/`;
  if (!url.pathname.startsWith(prefix) || !/^\d+\/?$/.test(url.pathname.slice(prefix.length))) return false;
  return matches(await request(`/${url.pathname.slice(prefix.length).replace(/\/$/, '')}`, opts) as MergeRequest, opts);
}
