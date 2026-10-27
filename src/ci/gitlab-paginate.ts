/**
 * GitLab REST pagination helper (shared by the CI comment and rejection paths).
 *
 * Two rules:
 *
 * 1. **Never follow redirects**: every request carrying PRIVATE-TOKEN must use
 *    `redirect: 'manual'`, or fetch follows a 3xx and forwards the token to
 *    another origin. A 3xx is an error here.
 * 2. **Never truncate silently**: throw when pages remain past maxPages unless
 *    the caller's lookup has already found its item.
 *    Truncation would make the marker lookup miss an earlier comment (posting a
 *    duplicate) and miss a 👎 (writing a rejected learning to the knowledge repo).
 */

/** Parses the items out of one page's response (an array by default). */
export type GitLabPageParser<T> = (json: unknown) => T[];

/**
 * Fetches a GitLab list endpoint until `x-next-page` is gone or a lookup matches.
 *
 * @param fetchPage - fetches one page (must set `redirect: 'manual'` itself)
 * @param maxPages - page limit (GitLab returns up to 100 items per page)
 * @param label - endpoint name used in error messages
 * @param options - custom page parser and a stop condition for item lookups; omit when all items are needed
 */
export async function paginateGitLab<T>(
  fetchPage: (page: number) => Promise<Response>,
  maxPages: number,
  label: string,
  options: { parse?: GitLabPageParser<T>; stopWhen?: (item: T) => boolean } = {},
): Promise<T[]> {
  const { parse = (json: unknown) => json as T[], stopWhen } = options;
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
    const items = parse(await resp.json());
    all.push(...items);
    if (stopWhen && items.some(stopWhen)) return all;
    if (!resp.headers.get('x-next-page')) return all;
  }
  throw new Error(
    `${label} has more than ${maxPages} pages; refusing to truncate `
    + '(a marker comment or a thumbsdown past the limit would be missed)',
  );
}
