import { z } from 'zod';

/** Page through GitHub/TGit lists without following server-supplied URLs. */
export async function paginate<T>(
  fetchPage: (page: number) => Promise<Response>,
  label: string,
  item: z.ZodType<T>,
  stopWhen?: (item: T) => boolean,
): Promise<T[]> {
  const all: T[] = [];

  for (let page = 1; page <= 20; page++) {
    const resp = await fetchPage(page);

    if (!resp.ok) throw new Error(`${label} request failed (${resp.status})`);
    const items = z.array(item).parse(await resp.json());
    all.push(...items);

    if (stopWhen && items.some(stopWhen)) return all;

    // TGit can omit pagination headers; a full page still needs a probe.
    const hasNext = /rel="?next"?/.test(resp.headers.get('link') ?? '')
      || Boolean(resp.headers.get('x-next-page'));

    if (!hasNext && items.length < 100) return all;
  }

  throw new Error(`${label} has more than 20 pages; refusing to truncate`);
}
