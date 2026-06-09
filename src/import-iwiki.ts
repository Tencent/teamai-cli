/**
 * iWiki 导入入口。
 *
 * 负责从 iWiki 拉取页面并转换为候选列表，
 * 分类、审查、推送均复用 import-local.ts 的现有函数。
 */

import { classifyWithAI, interactiveReview, pushAccepted } from './import-local.js';
import { IWikiClient } from './utils/iwiki-client.js';
import type { IWikiDocument, IWikiPage } from './utils/iwiki-client.js';
import { log, spinner } from './utils/logger.js';

// ─── 内部辅助函数 ──────────────────────────────────────────────

/**
 * 解析用户输入，识别 Space ID 或页面 ID。
 *
 * - 纯数字 → space id
 * - 含 `/p/` 或 `/pages/` 的 URL → page id
 * - 其他格式 → 抛出 Error
 *
 * @param input  用户输入的 Space ID 或页面 URL
 * @returns      解析结果 `{ type, id }`
 * @throws       无法识别格式时抛出 Error
 */
function parseIWikiInput(input: string): { type: 'space' | 'page'; id: string } {
  const trimmed = input.trim();

  // 纯数字视为 space id
  if (/^\d+$/.test(trimmed)) {
    return { type: 'space', id: trimmed };
  }

  // URL 中含 /p/<id> 或 /pages/<id>
  const pageMatch = trimmed.match(/\/(?:p|pages)\/([^/?#]+)/);
  if (pageMatch) {
    return { type: 'page', id: pageMatch[1] };
  }

  throw new Error(
    `无法识别 iWiki 输入格式："${trimmed}"。` +
      '请输入纯数字 Space ID 或含 /p/ 的页面 URL。',
  );
}

/**
 * 将 IWikiDocument 转换为 classifyWithAI 期望的候选格式。
 *
 * path 使用虚拟路径 `iwiki://p/<docid>`，rawContent 取前 3000 字符。
 *
 * @param doc  iWiki 文档对象
 * @returns    候选格式对象
 */
function docToCandidate(doc: IWikiDocument): { path: string; rawContent: string } {
  return {
    path: `iwiki://p/${doc.docid}`,
    rawContent: doc.content.slice(0, 3000),
  };
}

// ─── 并发下载辅助 ──────────────────────────────────────────────

/** 每批并发下载的默认文档数量。 */
const DOWNLOAD_BATCH_SIZE = 5;

/**
 * 按批次并发下载文档，每批最多 DOWNLOAD_BATCH_SIZE 个并发请求。
 *
 * 使用 Promise.allSettled 保证单页失败不中断整体。
 *
 * @param client  IWikiClient 实例
 * @param pages   待下载的页面信息列表
 * @returns       成功下载的 IWikiDocument[]
 */
async function downloadDocuments(
  client: IWikiClient,
  pages: IWikiPage[],
): Promise<IWikiDocument[]> {
  const documents: IWikiDocument[] = [];

  for (let i = 0; i < pages.length; i += DOWNLOAD_BATCH_SIZE) {
    const batch = pages.slice(i, i + DOWNLOAD_BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((page) => client.getDocument(page.docid)),
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        documents.push(result.value);
      } else {
        log.warn(`下载文档失败，已跳过: ${String(result.reason)}`);
      }
    }
  }

  return documents;
}

// ─── 导出函数 ──────────────────────────────────────────────────

/**
 * 从 iWiki 导入文档到团队仓库。
 *
 * 步骤：获取页面列表 → 下载内容 → AI 分类 → 交互审查 → 推送。
 *
 * @param opts              导入选项
 * @param opts.input        Space ID 或页面 URL
 * @param opts.token        PAT Token，优先用此值，否则读 process.env['TAI_PAT_TOKEN']
 * @param opts.all          true 时跳过交互，全部接受
 * @param opts.outputDir    指定输出目录，覆盖自动路由
 * @param opts.repoPath     团队仓库本地路径
 * @param opts.dryRun       true 时仅预览，不写入文件
 * @param opts.maxPages     最大抓取页数，默认 200
 */
export async function importFromIWiki(opts: {
  input: string;
  token?: string;
  all?: boolean;
  outputDir?: string;
  repoPath?: string;
  dryRun?: boolean;
  maxPages?: number;
}): Promise<void> {
  // 1. 读取 token
  const token = opts.token ?? process.env['TAI_PAT_TOKEN'];
  if (!token) {
    throw new Error(
      '请设置 TAI_PAT_TOKEN 环境变量（获取地址：https://tai.it.woa.com/user/pat）',
    );
  }

  // 2. 解析输入
  const { type, id } = parseIWikiInput(opts.input);

  // 3. 创建客户端
  const client = new IWikiClient(token);

  // 4. 获取页面列表
  let pages: IWikiPage[];
  if (type === 'page') {
    // 单页模式：用占位符，后续直接下载该页
    pages = [{ docid: id, title: id }];
  } else {
    const fetchSpinner = spinner(`获取 iWiki Space（${id}）页面树...`);
    try {
      pages = await client.fetchAllPages(id, { maxPages: opts.maxPages ?? 200 });
      fetchSpinner.succeed(`获取页面树完成，共 ${pages.length} 页`);
    } catch (err: unknown) {
      fetchSpinner.fail(`获取页面树失败: ${String(err)}`);
      throw err;
    }
  }

  if (pages.length === 0) {
    log.warn('未找到任何页面，导入终止');
    return;
  }

  // 5. 并发下载文档内容
  const downloadSpin = spinner(`下载 iWiki 文档内容（共 ${pages.length} 页）...`);
  let documents: IWikiDocument[];
  try {
    documents = await downloadDocuments(client, pages);
    downloadSpin.succeed(`文档下载完成，成功 ${documents.length}/${pages.length} 页`);
  } catch (err: unknown) {
    downloadSpin.fail(`文档下载出错: ${String(err)}`);
    throw err;
  }

  if (documents.length === 0) {
    log.warn('所有文档下载失败，导入终止');
    return;
  }

  // 6. 转换为候选格式
  const candidates = documents.map(docToCandidate);

  // 7. AI 分类
  const classified = await classifyWithAI(candidates);

  if (classified.length === 0) {
    log.warn('AI 分类后无有效条目，导入终止');
    return;
  }

  // 8. 交互式审查
  const session = await interactiveReview(classified, { all: opts.all });

  // 9. 推送
  const repoPath = opts.repoPath ?? `${process.env['HOME']}/.teamai/team-repo`;
  await pushAccepted(session, repoPath, {
    dryRun: opts.dryRun,
    outputDir: opts.outputDir,
  });

  log.success('iWiki 导入完成');
}
