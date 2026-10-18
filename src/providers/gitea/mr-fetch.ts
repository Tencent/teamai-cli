import type { MRData, MRFetchOptions, MRThread } from '../../types.js';
import { pruneThreads } from '../mr-threads.js';
import { log } from '../../utils/logger.js';
import { giteaJson, giteaList, giteaRequest } from './gitea-api.js';
import { giteaRepoPath, parseGiteaPrUrl } from './repo-url.js';

// Validated PR URL → metadata + paginated commits + bounded diff → MRData.

interface GiteaPull {
  title: string;
  body?: string | null;
  merged_at?: string | null;
  user?: { login?: string };
}

interface GiteaCommit { sha: string; commit?: { message?: string } }

/** Fail visibly when required evidence is unavailable instead of importing an empty diff. */
export async function fetchGiteaMR(url: string, opts: MRFetchOptions = {}): Promise<MRData> {
  const info = parseGiteaPrUrl(url);
  const route = `${giteaRepoPath(`${info.owner}/${info.repo}`)}/pulls/${info.number}`;
  const pull = await giteaJson<GiteaPull>(route);
  const commits = await giteaList<GiteaCommit>(`${route}/commits`);
  const patch = await giteaRequest(`${route}.diff`, { textLimit: 50 * 1024 });
  const marker = '\n[Diff truncated at 50 KiB; evidence is incomplete.]';
  let diff = patch.text;
  if (patch.truncated) {
    log.warn('Gitea PR diff truncated at 50 KiB; extracted knowledge has incomplete diff evidence.');
    // Keep the marker inside the same byte budget, including a UTF-8 boundary.
    const decoder = new TextDecoder();
    diff = decoder.decode(Buffer.from(diff).subarray(0, 50 * 1024 - Buffer.byteLength(marker)), { stream: true }) + marker;
  }
  const discussions = opts.discussions === false ? undefined : await fetchDiscussions(route, opts.commentMarker);
  return {
    discussions,
    title: pull.title, description: pull.body ?? '', author: pull.user?.login,
    mergedAt: pull.merged_at ?? undefined, url,
    commits: commits.map((commit) => ({ hash: commit.sha, message: commit.commit?.message ?? '' })), diff,
  };
}

/** Keep source provenance without changing the shared extraction contract. */
interface GiteaThread extends MRThread {
  sourceId: string;
  createdAt?: string;
}
interface GiteaComment {
  id: number;
  body?: string | null;
  user?: { login?: string };
  created_at?: string;
  path?: string;
  resolver?: { login?: string } | null;
}
interface GiteaReview {
  id: number;
  body?: string | null;
  user?: { login?: string };
  state?: string;
  submitted_at?: string;
}

/**
 * Gitea's public review comment contract has no reply/parent id. Preserve each
 * comment independently: path and diff position do not prove a reply relation,
 * and a diff position is not a source line number. Optional evidence failures
 * must not erase metadata, commits, the diff, or other successful discussions.
 */
async function fetchDiscussions(route: string, marker?: string): Promise<MRThread[]> {
  const threads: GiteaThread[] = [];
  const append = (comment: GiteaComment, source: string) => {
    threads.push({ sourceId: `${source}:${comment.id}`, createdAt: comment.created_at,
      file: comment.path,
      resolved: comment.resolver === undefined ? undefined : comment.resolver !== null,
      notes: [{ author: comment.user?.login, body: comment.body ?? '' }] });
  };
  // Swagger declares since/before for issue comments and no pagination for
  // review comments. Only the reviews collection accepts page/limit.
  try {
    const comments = await giteaJson<GiteaComment[]>(route.replace('/pulls/', '/issues/') + '/comments');
    for (const comment of comments) append(comment, 'issue');
  } catch { log.warn('Gitea issue comments unavailable; imported review evidence is incomplete.'); }
  try {
    const reviews = await giteaList<GiteaReview>(`${route}/reviews`);
    for (const review of reviews) {
      if (['PENDING', 'REQUEST_REVIEW'].includes(review.state ?? '')) continue;
      threads.push({ sourceId: `review:${review.id}`, createdAt: review.submitted_at,
        notes: [{ author: review.user?.login, body: review.body ?? '' }] });
      try {
        const comments = await giteaJson<GiteaComment[]>(`${route}/reviews/${review.id}/comments`);
        for (const comment of comments) append(comment, `review:${review.id}:comment`);
      } catch { log.warn(`Gitea review ${review.id} comments unavailable; imported review evidence is incomplete.`); }
    }
  } catch { log.warn('Gitea reviews unavailable; imported review evidence is incomplete.'); }
  // Stable date/id ordering retains provenance and avoids inventing reply links.
  threads.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.sourceId.localeCompare(b.sourceId));
  return pruneThreads(threads, marker);
}
