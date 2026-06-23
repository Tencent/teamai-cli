// -*- coding: utf-8 -*-
/**
 * 读取 MR/PR 上 reviewer 对知识建议的交互状态。
 *
 * - GitHub: 👎 reaction = reject，无 reaction = approve（默认写入）
 * - TGit: resolve_state=1 = approve，resolve_state=0 = reject（默认不写入）
 */

import { parseMrUrl } from './mr-comment.js';
import { gfGetOAuthToken } from '../providers/tgit/gf-cli.js';
import { log } from '../utils/logger.js';

const API_TIMEOUT_MS = 15_000;

// ─── 类型 ────────────────────────────────────────────────

export interface RejectionResult {
  /** 被 reject 的 marker id 集合 (如 "learning", "suggestion:1") */
  rejectedIds: Set<string>;
  /** 被 approve 的 marker id 集合 */
  approvedIds: Set<string>;
  /** 所有找到的 marker id */
  allIds: Set<string>;
}

// ─── Marker 解析 ─────────────────────────────────────────

const MARKER_REGEX = /<!-- teamai:ci-extract:(\S+) -->/;

/**
 * 从 comment body 中提取 marker id。
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
  if (!token) throw new Error('未设置 GITHUB_TOKEN');
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

  // 读取所有 comments
  const resp = await githubRequest(`/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`);
  if (!resp.ok) return result;
  const comments = (await resp.json()) as GitHubComment[];

  for (const comment of comments) {
    const markerId = extractMarkerId(comment.body);
    if (!markerId) continue;
    result.allIds.add(markerId);

    // 读取 reactions
    const reactResp = await githubRequest(
      `/repos/${owner}/${repo}/issues/comments/${comment.id}/reactions?per_page=100`,
    );
    if (!reactResp.ok) {
      result.approvedIds.add(markerId); // 读取失败默认 approve
      continue;
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

/** TGit emoji 编号 8 = ☝️（竖起食指），作为 reject 信号 */
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

function getTGitToken(): string {
  const envToken = process.env['TAI_PAT_TOKEN'];
  if (envToken) return envToken;
  const oauthToken = gfGetOAuthToken();
  if (oauthToken) return oauthToken;
  throw new Error('未设置 TAI_PAT_TOKEN 且无法获取 OAuth token');
}

async function tgitRequest(path: string): Promise<Response> {
  const token = getTGitToken();
  return fetch(`https://git.woa.com/api/v3${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
}

async function getMrGlobalId(projectId: string, mrIid: string): Promise<number> {
  const resp = await tgitRequest(`/projects/${projectId}/merge_requests?iid=${mrIid}`);
  if (!resp.ok) throw new Error(`TGit 查询 MR 失败 (${resp.status})`);
  const mrs = (await resp.json()) as Array<{ id: number; iid: number }>;
  const mr = mrs.find((m) => String(m.iid) === mrIid);
  if (!mr) throw new Error(`TGit MR !${mrIid} 不存在`);
  return mr.id;
}

async function readTGitRejections(owner: string, repo: string, mrIid: string): Promise<RejectionResult> {
  const result: RejectionResult = { rejectedIds: new Set(), approvedIds: new Set(), allIds: new Set() };

  const projectId = encodeURIComponent(`${owner}/${repo}`);
  const mrGlobalId = await getMrGlobalId(projectId, mrIid);

  // 读取所有 notes
  const resp = await tgitRequest(`/projects/${projectId}/merge_requests/${mrGlobalId}/notes?per_page=100`);
  if (!resp.ok) return result;
  const notes = (await resp.json()) as TGitNote[];

  for (const note of notes) {
    const markerId = extractMarkerId(note.body);
    if (!markerId) continue;
    result.allIds.add(markerId);

    // TGit: emoji 编号 8 (☝️) = reject，无 emoji = approve（默认写入）
    const hasRejectEmoji = (note.comments ?? []).some((c) => c.comment === TGIT_REJECT_EMOJI);
    if (hasRejectEmoji) {
      result.rejectedIds.add(markerId);
    } else {
      result.approvedIds.add(markerId);
    }
  }

  return result;
}

// ─── Public API ─────────────────────────────────────────

/**
 * 读取 MR/PR 上 reviewer 对知识建议的交互状态。
 *
 * 返回被 reject 和 approve 的 marker id 集合。
 * - GitHub: 默认写入，👎 = reject
 * - TGit: 默认不写入，点"解决" = approve
 */
export async function readRejections(mrUrl: string): Promise<RejectionResult> {
  const parsed = parseMrUrl(mrUrl);

  if (parsed.provider === 'github') {
    log.debug('读取 GitHub reactions...');
    return readGitHubRejections(parsed.owner, parsed.repo, parsed.number);
  }

  log.debug('读取 TGit emoji reactions...');
  return readTGitRejections(parsed.owner, parsed.repo, parsed.number);
}

/**
 * 根据 rejection 结果判断某条建议是否应该写入。
 *
 * 两个平台逻辑统一：默认写入，被 reject 的不写入。
 * - GitHub: 👎 reaction = reject
 * - TGit: ☝️ emoji (编号 8) = reject
 */
export function shouldWrite(markerId: string, rejections: RejectionResult, _provider: 'github' | 'tgit'): boolean {
  return !rejections.rejectedIds.has(markerId);
}
