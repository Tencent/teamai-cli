import { afterEach, describe, expect, it, vi } from 'vitest';
import { IWikiClient, type IWikiPage } from '../utils/iwiki-client.js';
import { log } from '../utils/logger.js';

/**
 * Resolve on a later macrotask, the way a real MCP request over HTTPS does. A
 * mock that resolves within the same microtask turn hides the ordering bug
 * this suite guards against: the traversal promise must not be able to reject
 * before the first response arrives, and with zero-latency mocks the first
 * response beats that rejection, so the bug never shows.
 */
function remote<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), 5));
}

/** A client whose `getSpacePageTree` answers from `tree`; one node may be an Error. */
function clientWithTree(tree: Record<string, IWikiPage[] | Error>): {
  client: IWikiClient;
  calls: string[];
} {
  const client = new IWikiClient('token');
  const calls: string[] = [];
  vi.spyOn(client, 'getSpacePageTree').mockImplementation((parentid: string) => {
    calls.push(parentid);
    const node = tree[parentid];
    if (node === undefined) return remote([]);
    return node instanceof Error ? Promise.reject(node) : remote(node);
  });
  return { client, calls };
}

describe('IWikiClient.fetchAllPages', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the pages of a single-node space', async () => {
    const { client, calls } = clientWithTree({
      root: [{ docid: 'root', title: 'Root' }],
    });

    const pages = await client.fetchAllPages('root');

    expect(pages).toEqual([{ docid: 'root', title: 'Root' }]);
    expect(calls).toEqual(['root']);
  });

  it('walks children breadth-first', async () => {
    const { client, calls } = clientWithTree({
      root: [
        { docid: 'a', title: 'A', has_children: true },
        { docid: 'b', title: 'B', has_children: true },
      ],
      a: [{ docid: 'c', title: 'C' }],
      b: [],
    });

    const pages = await client.fetchAllPages('root');

    expect(pages.map((page) => page.docid)).toEqual(['a', 'b', 'c']);
    expect(calls).toEqual(['root', 'a', 'b']);
  });

  it('keeps going when one node fails and warns about it', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const { client, calls } = clientWithTree({
      root: [
        { docid: 'a', title: 'A', has_children: true },
        { docid: 'b', title: 'B', has_children: true },
      ],
      a: new Error('boom'),
      b: [{ docid: 'c', title: 'C' }],
    });

    const pages = await client.fetchAllPages('root');

    expect(pages.map((page) => page.docid)).toEqual(['a', 'b', 'c']);
    expect(calls).toEqual(['root', 'a', 'b']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('parentid=a'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });

  it('stops at maxPages and warns in English', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const { client, calls } = clientWithTree({
      root: [
        { docid: '1', title: 'One' },
        { docid: '2', title: 'Two' },
        { docid: '3', title: 'Three' },
      ],
    });

    const pages = await client.fetchAllPages('root', { maxPages: 2 });

    expect(pages.map((page) => page.docid)).toEqual(['1', '2']);
    expect(calls).toEqual(['root']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('max page limit (2)'));
  });

  it('rejects for an empty rootId without any request', async () => {
    const { client, calls } = clientWithTree({});

    await expect(client.fetchAllPages('')).rejects.toThrow('fetchAllPages: rootId is empty');
    expect(calls).toEqual([]);
  });

  it('getSpacePageTree warns in English and returns [] when the request fails', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const client = new IWikiClient('token');
    vi.spyOn(client as unknown as { _callTool: () => Promise<unknown> }, '_callTool').mockImplementation(() =>
      Promise.reject(new Error('connect ETIMEDOUT')),
    );

    await expect(client.getSpacePageTree('root')).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('iWiki page tree request failed [parentid=root]'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('connect ETIMEDOUT'));
  });
});
