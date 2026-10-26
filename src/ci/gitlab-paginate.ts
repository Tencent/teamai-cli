/**
 * GitLab REST 分页读取助手（供 CI 评论/拒绝标记路径共用）。
 *
 * 两个要点：
 *
 * 1. **不跟随重定向**：所有带 PRIVATE-TOKEN 的请求必须用 `redirect: 'manual'`，
 *    否则 fetch 会跟随 3xx 并把 token 带到另一个 origin。收到 3xx 时这里直接报错。
 * 2. **不静默截断**：超过 maxPages 仍有下一页时显式抛错。截断会让 marker
 *    查找漏掉旧评论（重复发评论），也会漏判 👎（把被拒绝的学习写进知识库）。
 */

/** 单页响应里取出 items 的解析函数（默认按数组解析）。 */
export type GitLabPageParser<T> = (json: unknown) => T[];

/**
 * 逐页拉取 GitLab 列表接口，直到 `x-next-page` 消失。
 *
 * @param fetchPage - 拉取某一页的函数（需自行设置 `redirect: 'manual'`）
 * @param maxPages - 最大页数（GitLab 每页 100 条）
 * @param label - 错误信息里的接口名
 * @param parse - 响应体解析（默认当作数组）
 */
export async function paginateGitLab<T>(
  fetchPage: (page: number) => Promise<Response>,
  maxPages: number,
  label: string,
  parse: GitLabPageParser<T> = (json) => json as T[],
): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const resp = await fetchPage(page);
    if (resp.status >= 300 && resp.status < 400) {
      throw new Error(
        `${label} request returned a redirect (${resp.status}); refusing to follow it `
        + 'so the access token is not forwarded to another origin',
      );
    }
    if (!resp.ok) {
      throw new Error(`${label} request failed (${resp.status})`);
    }
    all.push(...parse(await resp.json()));
    if (!resp.headers.get('x-next-page')) return all;
  }
  throw new Error(
    `${label} has more than ${maxPages} pages; refusing to truncate `
    + '(a marker comment or a thumbsdown past the limit would be missed)',
  );
}
