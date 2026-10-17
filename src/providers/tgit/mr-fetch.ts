import { type MRData, type MRFetchOptions, type MRThread } from '../../types.js';
import { log } from '../../utils/logger.js';
import { pruneThreads } from '../mr-threads.js';
import { tgitFetch } from './rest-auth.js';

/** TGit MR URL 解析结果 */
interface ParsedTGitMR {
  group: string;
  project: string;
  mrIid: string;
}

/**
 * 从 TGit MR URL 解析出 group / project / MR IID。
 *
 * 支持格式：https://git.woa.com/<group>/<project>/merge_requests/<id>
 * group 可以是多级路径（如 group/subgroup）。
 * 解析失败时抛出 Error。
 */
function parseTGitMRUrl(url: string): ParsedTGitMR {
  // 匹配 git.woa.com 后的路径，最后两段为 merge_requests/<id>
  const match = url.match(/git\.woa\.com\/(.+)\/([^/]+)\/merge_requests\/(\d+)/);
  if (!match) {
    throw new Error(`Invalid TGit MR URL: ${url}`);
  }
  return { group: match[1], project: match[2], mrIid: match[3] };
}

/** TGit REST API 返回的 MR 元信息（仅使用的字段） */
interface TGitMR {
  id: number;
  iid: number;
  title: string;
  description: string;
  author: { username: string };
  // 部分工蜂版本不返回 merged_at，回退到 resolved_at / updated_at
  merged_at?: string | null;
  resolved_at?: string | null;
  updated_at?: string | null;
}

/** /changes 接口的 diff 载荷：工蜂用 `files`，标准 GitLab 用 `changes` */
interface TGitChangesResponse {
  files?: Array<{ diff: string }>;
  changes?: Array<{ diff: string }>;
}

/** A note of the MR, as the notes endpoint `teamai ci` also uses returns it (the fields read). */
interface TGitNote {
  body: string;
  author?: { username: string };
  system?: boolean;
  /** Notes of one thread share it, where the instance reports threads. */
  discussion_id?: string | number | null;
}

/** Pages of 100 notes read at most. */
const MAX_NOTE_PAGES = 10;

/**
 * Reads the MR's notes and groups them into threads by `discussion_id`
 * (a note without one is a thread of its own), without system notes or
 * teamai's own CI comments (#1187).
 *
 * @throws Error on an API error; the caller keeps the extraction going without threads
 */
async function fetchTGitThreads(enc: string, mrGlobalId: number, commentMarker?: string): Promise<MRThread[]> {
  const notes: TGitNote[] = [];
  for (let page = 1; page <= MAX_NOTE_PAGES; page++) {
    const resp = await tgitFetch(`/projects/${enc}/merge_requests/${mrGlobalId}/notes?per_page=100&page=${page}`);
    if (!resp.ok) {
      throw new Error(`TGit API error ${resp.status}`);
    }
    const raw = (await resp.json()) as TGitNote[];
    if (!Array.isArray(raw)) {
      throw new Error('TGit API returned no note list');
    }
    notes.push(...raw);
    if (raw.length < 100) break;
  }
  const threads: MRThread[] = [];
  const byDiscussion = new Map<string, MRThread>();
  for (const n of notes) {
    if (n.system) continue;
    const note = { author: n.author?.username, body: n.body ?? '' };
    const key = n.discussion_id === undefined || n.discussion_id === null ? undefined : String(n.discussion_id);
    const thread = key === undefined ? undefined : byDiscussion.get(key);
    if (thread) {
      thread.notes.push(note);
      continue;
    }
    const fresh: MRThread = { notes: [note] };
    if (key !== undefined) byDiscussion.set(key, fresh);
    threads.push(fresh);
  }
  return pruneThreads(threads, commentMarker);
}

/**
 * 通过 TGit REST API（git.woa.com/api/v3）获取 MR 的完整数据。
 *
 * gf CLI 无法返回 MR diff，因此改为纯 REST 实现：
 *   1. GET /projects/{enc}/merge_requests?iid={iid} 获取元信息
 *   2. GET /projects/{enc}/merge_request/{globalId}/changes 获取 diff
 *      （读 files/changes 字段，截断至 50KB，失败非致命）
 *   3. GET /projects/{enc}/merge_requests/{globalId}/notes 获取评审 threads
 *      （opts.discussions !== false 时；失败非致命，#1187）
 * 鉴权与 auth scheme 由 tgitFetch 统一处理。
 *
 * @param url - TGit MR 完整 web URL，例如 https://git.woa.com/group/repo/merge_requests/456
 * @param opts - 是否读取评审 threads（默认读取）
 * @returns 包含标题、描述、提交列表、diff 的 MRData 对象
 * @throws Error 当 URL 格式不合法、MR 不存在或元信息 API 调用失败时
 */
export async function fetchTGitMR(url: string, opts: MRFetchOptions = {}): Promise<MRData> {
  const { group, project, mrIid } = parseTGitMRUrl(url);
  log.debug(`fetchTGitMR: ${group}/${project}!${mrIid}`);

  const enc = encodeURIComponent(`${group}/${project}`);

  // ── 1. 获取元信息（TGit 不支持 /merge_requests/{iid} 路径，需用 ?iid= 查询）──
  const resp = await tgitFetch(`/projects/${enc}/merge_requests?iid=${mrIid}`);
  if (!resp.ok) {
    throw new Error(`TGit API 返回错误 ${resp.status}：${await resp.text()}`);
  }
  const mrList = await resp.json() as TGitMR[];
  if (!Array.isArray(mrList)) {
    throw new Error(`TGit API 返回了非预期的响应（期望 MR 列表）：${JSON.stringify(mrList).slice(0, 200)}`);
  }
  const mr = mrList.find((m) => String(m.iid) === mrIid);
  if (!mr) {
    throw new Error(`TGit MR !${mrIid} 不存在`);
  }

  // ── 2. 获取 diff（使用全局 id，单数 merge_request 路径，截断至 50KB，失败不阻断）──
  let diff = '';
  try {
    const diffResp = await tgitFetch(`/projects/${enc}/merge_request/${mr.id}/changes`);
    if (diffResp.ok) {
      const diffData = await diffResp.json() as TGitChangesResponse;
      const fileDiffs = diffData.files ?? diffData.changes ?? [];
      diff = fileDiffs.map((c) => c.diff).join('\n').slice(0, 50000);
    } else {
      log.debug(`TGit MR diff 获取失败（${diffResp.status}），diff 将为空`);
    }
  } catch (err) {
    log.debug(`TGit MR diff 获取异常，diff 将为空：${(err as Error).message}`);
  }

  // ── 3. 获取评审 threads（失败非致命） ─────────────────────
  let discussions: MRThread[] | undefined;
  if (opts.discussions !== false) {
    try {
      discussions = await fetchTGitThreads(enc, mr.id, opts.commentMarker);
    } catch (err) {
      log.warn(`Review threads not read (${(err as Error).message}); the learning is extracted without them`);
    }
  }

  return {
    title: mr.title,
    description: mr.description ?? '',
    author: mr.author?.username,
    mergedAt: mr.merged_at ?? mr.resolved_at ?? mr.updated_at ?? undefined,
    commits: [],
    diff,
    url,
    ...(discussions ? { discussions } : {}),
  };
}
