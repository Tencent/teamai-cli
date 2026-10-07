import { afterEach, describe, expect, it, vi } from 'vitest';
import { IWikiClient, type IWikiPage } from '../utils/iwiki-client.js';
import { log } from '../utils/logger.js';
import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import { EventEmitter } from 'node:events';

/** Exercise the public client through serialized JSON-RPC responses. */
function mockMcpResponses(responses: Record<string, { result?: unknown; error?: { code: number; message: string } }>): void {
  const request = (_options: https.RequestOptions, callback?: (res: IncomingMessage) => void) => {
    let payload = '';
    const req = Object.assign(new EventEmitter(), {
      write(chunk: string) { payload += chunk; },
      destroy: vi.fn(),
      end() {
        const request = JSON.parse(payload) as { id: number; params: { name: string } };
        queueMicrotask(() => {
          const res = new EventEmitter();
          if (typeof callback === 'function') callback(res as IncomingMessage);
          res.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...responses[request.params.name] })));
          res.emit('end');
          req.emit('close');
        });
      },
    });
    return req as unknown as ReturnType<typeof https.request>;
  };
  vi.spyOn(https, 'request').mockImplementation(request as typeof https.request);
}

describe('IWikiClient MCP tool errors', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it.each(['getDocument', 'metadata'])('rejects when %s returns isError, before treating its content as document data', async (tool) => {
    mockMcpResponses({
      getDocument: { result: { content: [{ type: 'text', text: '# Real document' }] } },
      metadata: { result: { content: [{ type: 'text', text: '{"title":"Real title"}' }] } },
      [tool]: { result: { isError: true, content: [{ type: 'text', text: 'Permission denied' }] } },
    });

    await expect(new IWikiClient('fixture-token').getDocument('123'))
      .rejects.toThrow(`iWiki MCP tool "${tool}" failed: Permission denied`);
  });

  it('rejects a tool error even when its text is valid document-shaped JSON', async () => {
    mockMcpResponses({
      getDocument: { result: { isError: true, content: [{ type: 'text', text: '{"content":"Not a document"}' }] } },
      metadata: { result: { title: 'Page' } },
    });
    await expect(new IWikiClient('fixture-token').getDocument('123'))
      .rejects.toThrow('iWiki MCP tool "getDocument" failed');
  });

  it.each([
    { content: [] },
    { content: [{ type: 'image', data: 'fixture', mimeType: 'image/png' }] },
  ])('rejects a tool error without text content ($content)', async ({ content }) => {
    mockMcpResponses({
      getDocument: { result: { isError: true, content } },
      metadata: { result: { title: 'Page' } },
    });
    await expect(new IWikiClient('fixture-token').getDocument('123'))
      .rejects.toThrow('iWiki MCP tool "getDocument" failed');
  });

  it('warns on a page-tree tool error and keeps the existing empty-tree fallback', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    mockMcpResponses({
      getSpacePageTree: { result: { isError: true, content: [{ type: 'text', text: 'Space unavailable' }] } },
    });
    await expect(new IWikiClient('fixture-token').getSpacePageTree('root')).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('iWiki MCP tool "getSpacePageTree" failed: Space unavailable'));
  });

  it.each([false, undefined])('preserves successful text and metadata responses with isError=%s', async (isError) => {
    mockMcpResponses({
      getDocument: { result: { isError, content: [{ type: 'text', text: '# Real document' }] } },
      metadata: { result: { isError, content: [{ type: 'text', text: '{"title":"Real title"}' }] } },
    });
    await expect(new IWikiClient('fixture-token').getDocument('123')).resolves.toEqual({
      docid: '123', title: 'Real title', content: '# Real document', url: 'https://iwiki.woa.com/p/123',
    });
  });

  it('still propagates JSON-RPC protocol errors', async () => {
    mockMcpResponses({
      getDocument: { error: { code: -32602, message: 'Unknown tool' } },
      metadata: { result: { title: 'Page' } },
    });
    await expect(new IWikiClient('fixture-token').getDocument('123')).rejects.toThrow('iWiki API error: Unknown tool');
  });
});

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
