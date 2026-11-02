/**
 * iWiki MCP HTTP 客户端。
 *
 * 封装 JSON-RPC 2.0 调用和页面树遍历逻辑，
 * 仅依赖 Node.js 内置 `https` 模块，零外部依赖。
 */

import https from 'node:https';
import { z } from 'zod';

import type { JsonValue } from '../types.js';
import { log } from './logger.js';

// ─── 常量 ──────────────────────────────────────────────────

/** iWiki MCP Server 端点 URL。 */
const MCP_URL = 'https://prod.mcp.it.woa.com/app_iwiki_mcp/mcp3';

/** HTTP 请求超时时间（毫秒）。 */
const REQUEST_TIMEOUT_MS = 30_000;

/** fetchAllPages 默认最大页数。 */
const DEFAULT_MAX_PAGES = 200;

/** fetchAllPages 默认并发数。 */
const DEFAULT_CONCURRENCY = 5;

// ─── 导出类型 ──────────────────────────────────────────────

/**
 * iWiki 页面基本信息（来自页面树接口）。
 */
export interface IWikiPage {
  /** 文档 ID（数字或字符串，统一转为 string） */
  docid: string;
  /** 文档标题 */
  title: string;
  /** 父文档 ID */
  parentid?: string;
  /** 是否有子文档 */
  has_children?: boolean;
}

/**
 * iWiki 文档完整内容（含 Markdown 正文）。
 */
export interface IWikiDocument {
  /** 文档 ID */
  docid: string;
  /** 文档标题 */
  title: string;
  /** Markdown 格式正文 */
  content: string;
  /** 原始 URL */
  url: string;
}

// ─── 内部类型 ──────────────────────────────────────────────

/** JSON-RPC 2.0 请求体。 */
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: { name: string; arguments: Record<string, string> };
}

const TextSchema = z.string();

/** The value of `key` when `value` is a JSON object; undefined for any other value. */
function fieldOf(value: JsonValue | undefined, key: string): JsonValue | undefined {
  return value instanceof Object && !Array.isArray(value) ? value[key] : undefined;
}

// ─── 客户端类 ──────────────────────────────────────────────

/**
 * iWiki MCP HTTP 客户端。
 *
 * 通过 JSON-RPC 2.0 协议与 iWiki MCP Server 通信，
 * 支持页面树遍历和文档内容下载。
 */
export class IWikiClient {
  private readonly token: string;
  private requestId: number;

  /**
   * 创建 IWikiClient 实例。
   *
   * @param token  TAI_PAT_TOKEN，用于 Bearer 认证
   */
  constructor(token: string) {
    this.token = token;
    this.requestId = 0;
  }

  /**
   * 发送单次 HTTPS POST 请求，返回响应 body 字符串。
   *
   * @param payload  序列化后的请求体字符串
   * @returns        响应 body 字符串
   * @throws         超时或请求失败时抛出 Error
   */
  private async _postRaw(payload: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const url = new URL(MCP_URL);

      const options: https.RequestOptions = {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`,
          'Accept': 'application/json, text/event-stream',
          'Content-Length': Buffer.byteLength(payload),
        },
      };

      const chunks: Buffer[] = [];

      const req = https.request(options, (res) => {
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        res.on('error', (err: Error) => reject(err));
      });

      // 超时控制
      const timer = setTimeout(() => {
        req.destroy();
        reject(new Error(`iWiki MCP request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`));
      }, REQUEST_TIMEOUT_MS);

      req.on('error', (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });

      req.on('close', () => clearTimeout(timer));

      req.write(payload);
      req.end();
    });
  }

  /**
   * 调用 iWiki MCP 工具，返回工具执行结果。
   *
   * 遵循 JSON-RPC 2.0 协议，解析 MCP 标准响应格式
   * `result.content[0].text` 或直接 `result`。
   *
   * @param toolName  MCP 工具名称
   * @param args      工具参数
   * @returns         工具返回值（已解析为 unknown）
   * @throws          API 返回 error 字段时抛出 Error
   */
  private async _callTool(toolName: string, args: Record<string, string>): Promise<JsonValue | undefined> {
    const rpcRequest: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: ++this.requestId,
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args,
      },
    };

    const payload = JSON.stringify(rpcRequest);
    const rawBody = await this._postRaw(payload);

    let response: JsonValue;

    try {
      // JSON.parse returns `any`; what it builds is a JsonValue by construction.
      response = JSON.parse(rawBody);
    } catch (parseErr: unknown) {
      throw new Error(`iWiki MCP response could not be parsed: ${String(parseErr)}; raw response: ${rawBody.slice(0, 200)}`, { cause: parseErr });
    }

    const error = fieldOf(response, 'error');

    if (error) {
      throw new Error(`iWiki API error: ${fieldOf(error, 'message')}`);
    }

    // MCP 标准响应格式：result.content[0].text 包含实际内容
    const result = fieldOf(response, 'result');
    const content = fieldOf(result, 'content');

    // Tool execution failures are successful JSON-RPC responses, but their
    // content is an error description, not a document to import.
    if (fieldOf(result, 'isError') === true) {
      const message = (Array.isArray(content) ? content : [])
        .flatMap((item) => TextSchema.safeParse(fieldOf(item, 'text')).data ?? [])
        .join('\n');

      throw new Error(`iWiki MCP tool "${toolName}" failed${message ? `: ${message}` : ''}`);
    }

    if (Array.isArray(content) && content.length > 0) {
      const text = TextSchema.safeParse(fieldOf(content[0], 'text'));

      if (text.success) {
        // text 可能是 JSON 字符串，尝试再次解析
        try {
          return JSON.parse(text.data);
        } catch {
          return text.data;
        }
      }
    }

    return result;
  }

  /**
   * 获取指定父节点下的页面树（一级子页面列表）。
   *
   * @param parentid  父节点文档 ID
   * @returns         子页面列表，失败时返回空数组
   */
  async getSpacePageTree(parentid: string): Promise<IWikiPage[]> {
    try {
      const result = await this._callTool('getSpacePageTree', { parentid });

      if (!Array.isArray(result)) {
        return [];
      }

      return result.map((item) => {
        const parent = fieldOf(item, 'parentid');

        return {
          docid: String(fieldOf(item, 'docid') ?? fieldOf(item, 'id') ?? ''),
          title: TextSchema.safeParse(fieldOf(item, 'title')).data ?? String(fieldOf(item, 'docid') ?? ''),
          parentid: parent !== undefined ? String(parent) : undefined,
          has_children: Boolean(fieldOf(item, 'has_children')),
        };
      });
    } catch (err: unknown) {
      log.warn(`iWiki page tree request failed [parentid=${parentid}]: ${String(err)}`);

      return [];
    }
  }

  /**
   * 下载单个文档的完整内容（Markdown 正文 + 元数据）。
   *
   * 并行调用 getDocument 和 metadata 两个工具。
   *
   * @param docid  文档 ID
   * @returns      IWikiDocument（含 Markdown 正文）
   * @throws       任一子调用失败时抛出 Error
   */
  async getDocument(docid: string): Promise<IWikiDocument> {
    const [contentResult, metaResult] = await Promise.all([
      this._callTool('getDocument', { docid }),
      this._callTool('metadata', { docid }),
    ]);

    // getDocument 返回 Markdown 字符串或含 content 字段的对象
    const contentText = TextSchema.safeParse(contentResult);
    const contentField = fieldOf(contentResult, 'content');
    let content = '';

    if (contentText.success) {
      content = contentText.data;
    } else if (contentField !== undefined) {
      content = String(contentField ?? '');
    }

    // metadata 返回含 title、id 等字段的对象
    const titleField = fieldOf(metaResult, 'title');
    let title = '';

    if (titleField !== undefined) {
      title = String(titleField ?? '');
    }

    return {
      docid,
      title: title || docid,
      content,
      url: `https://iwiki.woa.com/p/${docid}`,
    };
  }

  /**
   * 递归（BFS）遍历整个 Space，返回所有页面信息。
   *
   * 并发控制：同时最多 concurrency 个 getSpacePageTree 请求。
   * 超出 maxPages 时停止并输出 warn 日志。
   *
   * @param rootId  Space 根节点 ID
   * @param opts    可选配置：concurrency（默认 5）、maxPages（默认 200）
   * @returns       所有发现的 IWikiPage[]
   */
  async fetchAllPages(
    rootId: string,
    opts?: { concurrency?: number; maxPages?: number },
  ): Promise<IWikiPage[]> {
    const concurrency = opts?.concurrency ?? DEFAULT_CONCURRENCY;
    const maxPages = opts?.maxPages ?? DEFAULT_MAX_PAGES;

    const allPages: IWikiPage[] = [];
    // BFS 队列：待获取子树的 parentid 列表；rootId 为空则保持为空
    const queue: string[] = rootId ? [rootId] : [];
    let running = 0;
    let stopped = false;

    // 使用 Promise 包装的并发 BFS
    await new Promise<void>((resolve, reject) => {
      const tryDrain = (): void => {
        if (stopped || (queue.length === 0 && running === 0)) {
          resolve();

          return;
        }

        // 填满并发槽（tryDrain 入口已拦截 stopped，同步循环体内它不会变化）
        while (queue.length > 0 && running < concurrency) {
          const parentid = queue.shift()!;
          running++;

          this.getSpacePageTree(parentid)
            .then((pages) => {
              running--;

              for (const page of pages) {
                if (allPages.length >= maxPages) {
                  if (!stopped) {
                    stopped = true;
                    log.warn(
                      `Reached the max page limit (${maxPages}); stopped traversing. Collected ${allPages.length} page(s).`,
                    );
                  }

                  break;
                }

                allPages.push(page);

                // 有子文档则加入 BFS 队列
                if (page.has_children) {
                  queue.push(page.docid);
                }
              }

              tryDrain();
            })
            .catch((cause: unknown) => {
              running--;
              log.warn(`BFS traversal failed for node [parentid=${parentid}]: ${String(cause)}`);
              // 单节点失败不中断整体，继续处理其他节点
              tryDrain();
            });
        }

        // 队列为空且无运行中任务则完成
        if (queue.length === 0 && running === 0) {
          resolve();
        }
      };

      // rootId 为空时 BFS 无处可走：必须在 tryDrain 之前判断。tryDrain 会把
      // 队列里的 rootId 派发出去，此后队列必然为空——晚于此处的判断会让每
      // 次调用在遍历开始前就以 "rootId 队列为空" 拒绝。
      if (queue.length === 0) {
        reject(new Error('fetchAllPages: rootId is empty'));

        return;
      }

      tryDrain();
    }).catch((cause: unknown) => {
      // 仅 rootId 为空时抛出，其他错误已在 tryDrain 内处理
      if (allPages.length === 0) {
        throw cause;
      }
    });

    return allPages;
  }
}
