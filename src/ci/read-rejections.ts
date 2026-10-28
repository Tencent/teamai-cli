// -*- coding: utf-8 -*-
/**
 * Reads how reviewers responded to the knowledge suggestions on an MR/PR.
 *
 * - GitHub: 👎 reaction = reject, no reaction = approve (written by default)
 * - GitLab: 👎 (thumbsdown) award emoji = reject, no emoji = approve (written by default)
 * - TGit: emoji 8 (☝️) on the note = reject, no emoji = approve (written by default)
 */

import { parseMrUrl } from './mr-comment.js';
import { tgitFetch } from '../providers/tgit/rest-auth.js';
import { getGitLabToken } from '../providers/gitlab/gitlab-api.js';
import { parseGitLabMRUrl } from '../providers/gitlab/mr-fetch.js';
import { paginateGitLab } from './gitlab-paginate.js';
import { log } from '../utils/logger.js';

const API_TIMEOUT_MS = 15_000;
// GitLab caps note pages at 100; same guard as fetchGitLabDiscussions (mr-fetch.ts).
const MAX_NOTE_PAGES = 20;

/**
 * GitLab names a skin-toned emoji `thumbsdown_tone1` … `thumbsdown_tone5`.
 * Any of those still means the reviewer rejected the suggestion.
 */
function isThumbsdownAward(name: string): boolean {
  return name === 'thumbsdown' || name.startsWith('thumbsdown_tone');
}

// ─── Types ────────────────────────────────────────────────

export interface RejectionResult {
  /** Rejected marker ids (e.g. "learning", "suggestion:1") */
  rejectedIds: Set<string>;
  /** Approved marker ids */
  approvedIds: Set<string>;
  /** Every marker id found */
  allIds: Set<string>;
}

// ─── Marker parsing ─────────────────────────────────────────

const MARKER_REGEX = /<!-- teamai:ci-extract:(\S+) -->/;

/**
 * Extracts the marker id from a comment body.
 */
export function extractMarkerId(body: string): string | null {
  const match = body.match(MARKER_REGEX);
  return match ? match[1] : null;
}

// ─── GitHub ─────────────────────────────────────────────

interface GitHubComment {
  id: number;
  body: string;
}

interface GitHubReaction {
  content: string; // "+1", "-1", "laugh", etc.
}

async function githubRequest(path: string): Promise<Response> {
  const token = process.env['GITHUB_TOKEN'];
  if (!token) throw new Error('GITHUB_TOKEN is not set');
  return fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'teamai-cli',
    },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
}

async function readGitHubRejections(owner: string, repo: string, prNumber: string): Promise<RejectionResult> {
  const result: RejectionResult = { rejectedIds: new Set(), approvedIds: new Set(), allIds: new Set() };

  // Read all comments
  const resp = await githubRequest(`/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`);
  if (!resp.ok) throw new Error(`GitHub comments request failed (${resp.status})`);
  const comments = (await resp.json()) as GitHubComment[];

  for (const comment of comments) {
    const markerId = extractMarkerId(comment.body);
    if (!markerId) continue;
    result.allIds.add(markerId);

    // Read the reactions
    const reactResp = await githubRequest(
      `/repos/${owner}/${repo}/issues/comments/${comment.id}/reactions?per_page=100`,
    );
    if (!reactResp.ok) {
      throw new Error(`GitHub reactions request failed for comment ${comment.id} (${reactResp.status})`);
    }
    const reactions = (await reactResp.json()) as GitHubReaction[];
    const hasThumbsDown = reactions.some((r) => r.content === '-1');

    if (hasThumbsDown) {
      result.rejectedIds.add(markerId);
    } else {
      result.approvedIds.add(markerId);
    }
  }

  return result;
}

// ─── TGit ───────────────────────────────────────────────

/** TGit emoji number 8 = ☝️ (raised index finger), the reject signal */
const TGIT_REJECT_EMOJI = 8;

interface TGitNoteComment {
  comment: number;
  author: { username: string };
}

interface TGitNote {
  id: number;
  body: string;
  resolve_state: number;
  file_path: string | null;
  comments: TGitNoteComment[];
}

async function tgitRequest(path: string): Promise<Response> {
  return tgitFetch(path);
}

async function getMrGlobalId(projectId: string, mrIid: string): Promise<number> {
  const resp = await tgitRequest(`/projects/${projectId}/merge_requests?iid=${mrIid}`);
  if (!resp.ok) throw new Error(`TGit MR lookup failed (${resp.status})`);
  const mrs = (await resp.json()) as Array<{ id: number; iid: number }>;
  const mr = mrs.find((m) => String(m.iid) === mrIid);
  if (!mr) throw new Error(`TGit MR !${mrIid} not found`);
  return mr.id;
}

async function readTGitRejections(owner: string, repo: string, mrIid: string): Promise<RejectionResult> {
  const result: RejectionResult = { rejectedIds: new Set(), approvedIds: new Set(), allIds: new Set() };

  const projectId = encodeURIComponent(`${owner}/${repo}`);
  const mrGlobalId = await getMrGlobalId(projectId, mrIid);

  // Read all notes
  const resp = await tgitRequest(`/projects/${projectId}/merge_requests/${mrGlobalId}/notes?per_page=100`);
  if (!resp.ok) throw new Error(`TGit notes request failed (${resp.status})`);
  const notes = (await resp.json()) as TGitNote[];

  for (const note of notes) {
    const markerId = extractMarkerId(note.body);
    if (!markerId) continue;
    result.allIds.add(markerId);

    // TGit: emoji number 8 (☝️) = reject, no emoji = approve (written by default)
    const hasRejectEmoji = (note.comments ?? []).some((c) => c.comment === TGIT_REJECT_EMOJI);
    if (hasRejectEmoji) {
      result.rejectedIds.add(markerId);
    } else {
      result.approvedIds.add(markerId);
    }
  }

  return result;
}

// ─── GitLab ─────────────────────────────────────────────

interface GitLabNote {
  id: number;
  body: string;
}

interface GitLabAward {
  name: string; // 'thumbsdown', 'thumbsup', ...
}

async function readGitLabRejections(mrUrl: string): Promise<RejectionResult> {
  const result: RejectionResult = { rejectedIds: new Set(), approvedIds: new Set(), allIds: new Set() };

  const { apiBase, projectPath, mrIid } = parseGitLabMRUrl(mrUrl);
  const token = getGitLabToken();
  if (!token) {
    throw new Error(
      'GitLab authentication unavailable. Set the GITLAB_TOKEN environment variable '
      + '(a GitLab Personal Access Token with `api` scope).',
    );
  }
  const enc = encodeURIComponent(projectPath);
  const headers = { 'PRIVATE-TOKEN': token };
  const doFetch = (path: string) => fetch(`${apiBase}${path}`, {
    headers,
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
    // Never follow redirects: the PRIVATE-TOKEN header would be forwarded to
    // whatever origin the 3xx points at. The host check in parseGitLabMRUrl
    // only covers the first URL.
    redirect: 'manual',
  });

  // GitLab returns notes newest-first, capped at 100 per page. Page through
  // all of them: a 👎 on an older note (pushed past page 1 by newer discussion)
  // must still reject the learning, same as fetchGitLabDiscussions paging.
  const notes = await paginateGitLab<GitLabNote>(
    (page) => doFetch(`/projects/${enc}/merge_requests/${mrIid}/notes?per_page=100&page=${page}`),
    MAX_NOTE_PAGES,
    'GitLab notes',
  );

  for (const note of notes) {
    const markerId = extractMarkerId(note.body);
    if (!markerId) continue;
    result.allIds.add(markerId);

    // A note can carry more than 100 awards; a thumbsdown past the first page
    // still means the suggestion is rejected.
    const awards = await paginateGitLab<GitLabAward>(
      (page) => doFetch(
        `/projects/${enc}/merge_requests/${mrIid}/notes/${note.id}/award_emoji?per_page=100&page=${page}`,
      ),
      MAX_NOTE_PAGES,
      `GitLab award_emoji for note ${note.id}`,
    );

    // GitLab: 👎 (thumbsdown) = reject, no emoji = approve (written by default, same as GitHub)
    if (awards.some((a) => isThumbsdownAward(a.name))) {
      result.rejectedIds.add(markerId);
    } else {
      result.approvedIds.add(markerId);
    }
  }

  return result;
}

// ─── Public API ─────────────────────────────────────────

/**
 * Reads how reviewers responded to the knowledge suggestions on an MR/PR.
 *
 * Returns the rejected and approved marker ids.
 * - GitHub: written by default, 👎 = reject
 * - GitLab: written by default, 👎 (thumbsdown award emoji) = reject
 * - TGit: not written by default, "Resolve" = approve
 */
export async function readRejections(mrUrl: string): Promise<RejectionResult> {
  const parsed = parseMrUrl(mrUrl);

  if (parsed.provider === 'github') {
    log.debug('Reading GitHub reactions...');
    return readGitHubRejections(parsed.owner, parsed.repo, parsed.number);
  }

  if (parsed.provider === 'gitlab') {
    log.debug('Reading GitLab award emoji...');
    return readGitLabRejections(mrUrl);
  }

  log.debug('Reading TGit emoji reactions...');
  return readTGitRejections(parsed.owner, parsed.repo, parsed.number);
}

/**
 * Decides from the rejection result whether a suggestion should be written.
 *
 * Same rule on all three platforms: written by default, skipped when rejected.
 * - GitHub / GitLab: 👎 = reject
 * - TGit: ☝️ emoji (number 8) = reject
 */
export function shouldWrite(markerId: string, rejections: RejectionResult, _provider: 'github' | 'tgit' | 'gitlab'): boolean {
  return !rejections.rejectedIds.has(markerId);
}
