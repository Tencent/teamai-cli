import { execSync } from 'node:child_process';
import { type MRData } from '../../types.js';
import { log } from '../../utils/logger.js';
import { gfExec } from './gf-cli.js';

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
 * 通过 gf CLI 获取 TGit MR 的完整数据。
 *
 * 依次执行：
 *   1. `gf mr desc <mr_iid> --repo <group>/<project> --json` 获取元信息
 *   2. `gf mr diff <mr_iid> --repo <group>/<project>` 获取 diff（截断至 50KB）
 *
 * @param url - TGit MR 完整 web URL，例如 https://git.woa.com/group/repo/merge_requests/456
 * @returns 包含标题、描述、提交列表、diff 的 MRData 对象
 * @throws Error 当 URL 格式不合法或 gf CLI 调用失败时
 */
export async function fetchTGitMR(url: string): Promise<MRData> {
  const { group, project, mrIid } = parseTGitMRUrl(url);
  const repoArg = `${group}/${project}`;

  log.debug(`fetchTGitMR: ${repoArg}!${mrIid}`);

  // ── 1. 获取元信息 ─────────────────────────────────────────
  let mrDesc: GfMRDesc;
  try {
    const result = gfExec(['mr', 'desc', mrIid, '-R', repoArg, '--json']);
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout);
    }
    mrDesc = JSON.parse(result.stdout) as GfMRDesc;
  } catch (err) {
    throw new Error(`Failed to fetch TGit MR: ${(err as Error).message}`);
  }

  // ── 2. 获取 diff ─────────────────────────────────────────
  let diff: string;
  try {
    const rawDiff = execSync(
      `gf mr diff ${mrIid} -R ${repoArg}`,
      { maxBuffer: 50 * 1024 * 1024, encoding: 'utf8' },
    );
    // 截断至约 50KB（50000 字符）
    diff = rawDiff.slice(0, 50000);
  } catch (err) {
    throw new Error(`Failed to fetch TGit MR: ${(err as Error).message}`);
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
