import { execFileSync } from 'node:child_process';
import { type MRData } from '../../types.js';
import { log } from '../../utils/logger.js';
import { gfExec, gfGetOAuthToken } from './gf-cli.js';

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

/** gf mr desc 返回的 JSON 结构（仅使用的字段） */
interface GfMRDesc {
  title: string;
  description: string;
  author: { username: string };
  merged_at: string | null;
}

/**
 * 通过 TGit REST API 获取 MR 数据（gf CLI 不可用时的 fallback）。
 *
 * 使用 ~/.netrc 中存储的 OAuth token 调用 git.woa.com API。
 *
 * @param group   - 项目所属 group（可含子 group，如 group/subgroup）
 * @param project - 项目名称
 * @param mrIid   - MR 内部编号（字符串数字）
 * @returns 包含标题、描述、提交列表、diff 的 MRData 对象
 * @throws Error 当 token 不可用或 API 调用失败时
 */
async function fetchTGitMRViaApi(group: string, project: string, mrIid: string): Promise<MRData> {
  const token = gfGetOAuthToken();
  if (!token) {
    throw new Error('TGit REST API fallback 不可用：无法从 ~/.netrc 获取 OAuth token，请先运行 `gf auth login`');
  }

  const encodedPath = encodeURIComponent(`${group}/${project}`);
  const baseUrl = `https://git.woa.com/api/v3/projects/${encodedPath}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // 获取 MR 元信息（TGit 不支持 /merge_requests/{iid} 路径，需用 ?iid= 查询）
  const listResp = await fetch(`${baseUrl}/merge_requests?iid=${mrIid}`, { headers });
  if (!listResp.ok) {
    throw new Error(`TGit API 返回错误 ${listResp.status}：${await listResp.text()}`);
  }
  const mrList = await listResp.json() as Array<{ id: number; title: string; description: string; author: { username: string }; merged_at: string | null }>;
  const mr = mrList.find((m) => String(m.id) !== undefined);
  if (!mr) {
    throw new Error(`TGit MR !${mrIid} 不存在`);
  }

  // 获取 MR diff（使用全局 id，截断至 50KB）
  const diffResp = await fetch(`${baseUrl}/merge_requests/${mr.id}/changes`, { headers });
  let diff = '';
  if (diffResp.ok) {
    const diffData = await diffResp.json() as { changes: Array<{ diff: string }> };
    diff = (diffData.changes ?? []).map((c) => c.diff).join('\n').slice(0, 50000);
  }

  return {
    title: mr.title,
    description: mr.description ?? '',
    author: mr.author?.username,
    mergedAt: mr.merged_at ?? undefined,
    commits: [],
    diff,
    url: `https://git.woa.com/${group}/${project}/merge_requests/${mrIid}`,
  };
}

/**
 * 通过 gf CLI 获取 TGit MR 的完整数据，gf CLI 不可用时自动 fallback 到 REST API。
 *
 * 依次执行：
 *   1. `gf mr desc <mr_iid> --repo <group>/<project> --json` 获取元信息
 *   2. `gf mr diff <mr_iid> --repo <group>/<project>` 获取 diff（截断至 50KB）
 *   若 gf CLI 失败，则尝试通过 TGit REST API 获取数据。
 *
 * @param url - TGit MR 完整 web URL，例如 https://git.woa.com/group/repo/merge_requests/456
 * @returns 包含标题、描述、提交列表、diff 的 MRData 对象
 * @throws Error 当 URL 格式不合法或 gf CLI 与 REST API 均调用失败时
 */
export async function fetchTGitMR(url: string): Promise<MRData> {
  const { group, project, mrIid } = parseTGitMRUrl(url);
  const repoArg = `${group}/${project}`;

  log.debug(`fetchTGitMR: ${repoArg}!${mrIid}`);

  // ── 1. 获取元信息（优先 gf CLI，不可用时 fallback 到 REST API）─────────────────
  let mrDesc: GfMRDesc;
  try {
    const result = gfExec(['mr', 'desc', mrIid, '-R', repoArg, '--json']);
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout);
    }
    mrDesc = JSON.parse(result.stdout) as GfMRDesc;
  } catch (gfErr) {
    log.debug(`gf CLI 不可用（${(gfErr as Error).message}），尝试 REST API fallback`);
    try {
      return await fetchTGitMRViaApi(group, project, mrIid);
    } catch (apiErr) {
      throw new Error(
        `Failed to fetch TGit MR via gf CLI (${(gfErr as Error).message}) ` +
        `and REST API fallback (${(apiErr as Error).message})`,
      );
    }
  }

  // ── 2. 获取 diff ─────────────────────────────────────────
  let diff: string;
  try {
    const rawDiff = execFileSync('gf', ['mr', 'diff', String(mrIid), '-R', repoArg], {
      maxBuffer: 50 * 1024 * 1024,
      encoding: 'utf8',
    });
    // 截断至约 50KB（50000 字符）
    diff = rawDiff.slice(0, 50000);
  } catch (err) {
    // diff 获取失败不阻断流程，记录警告并置空
    log.debug(`gf mr diff 失败，diff 将为空：${(err as Error).message}`);
    diff = '';
  }

  // ── 3. 组装结果（gf mr desc 不含 commits 字段，设为空数组） ──
  return {
    title: mrDesc.title,
    description: mrDesc.description ?? '',
    author: mrDesc.author?.username,
    mergedAt: mrDesc.merged_at ?? undefined,
    commits: [],
    diff,
    url,
  };
}
