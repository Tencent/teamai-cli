/**
 * iWiki 导入入口。
 *
 * 负责从 iWiki 拉取页面并转换为候选列表，
 * 分类、审查、推送均复用 import-local.ts 的现有函数。
 */

import path from 'node:path';
import { readFile, mkdir, writeFile } from 'node:fs/promises';

import { classifyWithAI, interactiveReview, pushAccepted } from './import-local.js';
import { IWikiClient } from './utils/iwiki-client.js';
import type { IWikiDocument, IWikiPage } from './utils/iwiki-client.js';
import { log, spinner } from './utils/logger.js';
import { pathExists } from './utils/fs.js';

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
        log.warn(`download failed, skipped: ${String(result.reason)}`);
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
    log.warn('no pages found, import aborted');
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
    log.warn('all document downloads failed, import aborted');
    return;
  }

  // 6. 转换为候选格式
  const candidates = documents.map(docToCandidate);

  // 7. AI 分类
  const classified = await classifyWithAI(candidates);

  if (classified.length === 0) {
    log.warn('no valid entries after AI classification, import aborted');
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

  // 10. 与 teamwiki 代码知识建立 MAPS_TO 关系（在 push 之前，确保结果被推送）
  const teamwikiRoot = path.join(repoPath, 'teamwiki');
  if (await pathExists(path.join(teamwikiRoot, '.indices', 'graph-index.json'))) {
    try {
      const mapsToEdges = await reconcileIwikiWithCodebase(documents, teamwikiRoot);
      if (mapsToEdges.length > 0) {
        log.success(`建立 ${mapsToEdges.length} 条 iWiki↔代码 MAPS_TO 关系`);
      } else {
        log.info('[reconcile] no matches found between iWiki docs and code knowledge');
      }
    } catch (err) {
      log.debug(`[reconcile] iWiki↔code relation failed (non-blocking): ${err instanceof Error ? err.message : err}`);
    }
  }

  // 11. 自动推送所有产物到团队仓库
  if (!opts.dryRun) {
    const { autoPushTeamRepo } = await import('./utils/git.js');
    await autoPushTeamRepo(repoPath, `[teamai] Import from iWiki: ${documents.map(d => d.title).slice(0, 3).join(', ')}`);
  }

  log.success('iWiki 导入完成');
}

// ─── iWiki↔Codebase Reconciliation ────────────────────────────

interface MapsToEdge {
  from: string;
  to: string;
  relation: 'MAPS_TO';
  term: string;
  confidence: number;
}

/**
 * 将 iWiki 文档与 teamwiki 代码知识图谱进行对账，建立 MAPS_TO 关系。
 *
 * 基于 team-wiki reconciler 的核心逻辑（by @lurkacai）：
 * - 从文档中提取关键术语（API path、类名、模块名）
 * - 在代码事实页面中搜索匹配
 * - 匹配成功则建立 MAPS_TO 边
 */
async function reconcileIwikiWithCodebase(
  documents: IWikiDocument[],
  teamwikiRoot: string,
): Promise<MapsToEdge[]> {
  const graphPath = path.join(teamwikiRoot, '.indices', 'graph-index.json');
  const graphRaw = await readFile(graphPath, 'utf-8');
  const graph = JSON.parse(graphRaw);

  // 收集代码节点的标签用于匹配
  const codeLabels = new Map<string, string>();
  for (const node of graph.nodes) {
    codeLabels.set(node.label.toLowerCase(), node.id);
    // 也索引 PascalCase 拆分后的单词
    const words = node.label.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    codeLabels.set(words, node.id);
  }

  // 加载代码事实页面内容用于全文匹配
  const evidenceDir = path.join(teamwikiRoot, 'evidence', 'code');
  const codePageContents = new Map<string, string>();
  if (await pathExists(evidenceDir)) {
    const { readdir } = await import('node:fs/promises');
    const projects = await readdir(evidenceDir);
    for (const project of projects) {
      const projectDir = path.join(evidenceDir, project);
      const files = await readdir(projectDir).catch(() => [] as string[]);
      for (const file of files) {
        if (!file.endsWith('.md')) continue;
        const content = await readFile(path.join(projectDir, file), 'utf-8').catch(() => '');
        codePageContents.set(`evidence/code/${project}/${file}`, content);
      }
    }
  }

  const mapsToEdges: MapsToEdge[] = [];
  const edgeSet = new Set<string>();

  for (const doc of documents) {
    const docSlug = `iwiki/p/${doc.docid}`;
    const terms = extractKeyTermsFromDoc(doc.content);

    for (const term of terms) {
      // 方式 1：术语直接匹配代码节点标签
      const directMatch = codeLabels.get(term.toLowerCase());
      if (directMatch) {
        const key = `${docSlug}|${directMatch}`;
        if (!edgeSet.has(key)) {
          edgeSet.add(key);
          mapsToEdges.push({ from: docSlug, to: directMatch, relation: 'MAPS_TO', term, confidence: 0.8 });
        }
        continue;
      }

      // 方式 2：术语在代码事实页面全文中出现
      for (const [pagePath, content] of codePageContents) {
        if (content.toLowerCase().includes(term.toLowerCase()) && term.length > 3) {
          const key = `${docSlug}|${pagePath}`;
          if (!edgeSet.has(key)) {
            edgeSet.add(key);
            mapsToEdges.push({ from: docSlug, to: pagePath, relation: 'MAPS_TO', term, confidence: 0.6 });
          }
          break; // 每个术语最多匹配一个 code page
        }
      }
    }
  }

  // 写入 graph-index.json（去重：按 from+to+relation 三元组）
  if (mapsToEdges.length > 0) {
    const existingKeys = new Set(
      graph.edges.map((e: { from: string; to: string; relation: string }) => `${e.from}|${e.to}|${e.relation}`),
    );
    for (const edge of mapsToEdges) {
      const key = `${edge.from}|${edge.to}|${edge.relation}`;
      if (!existingKeys.has(key)) {
        existingKeys.add(key);
        graph.edges.push(edge);
      }
    }
    await writeFile(graphPath, JSON.stringify(graph, null, 2), 'utf-8');
  }

  return mapsToEdges;
}

/**
 * 从文档内容中提取关键术语，用于与代码知识匹配。
 *
 * 提取规则：
 * - API 路径：/api/v1/xxx 形式
 * - 代码标识符：PascalCase 或 camelCase 标识符
 * - 反引号包裹的代码片段
 */
function extractKeyTermsFromDoc(content: string): string[] {
  const terms = new Set<string>();

  // API 路径
  const apiPaths = content.match(/\/api\/[a-z0-9/_-]+/gi);
  if (apiPaths) {
    for (const p of apiPaths) terms.add(p);
  }

  // 反引号内的代码标识符（任意格式：PascalCase、camelCase、snake_case）
  const codeRefs = content.matchAll(/`([a-zA-Z_][a-zA-Z0-9_]{2,})`/g);
  for (const m of codeRefs) {
    if (m[1]) terms.add(m[1]);
  }

  // PascalCase 标识符（独立出现）
  const pascalMatches = content.matchAll(/(?:^|[\s(,])([A-Z][a-z]+(?:[A-Z][a-z]+)+)/gm);
  for (const m of pascalMatches) {
    if (m[1]) terms.add(m[1]);
  }

  // snake_case 标识符（2+ 段，如 user_token、create_session）
  const snakeMatches = content.matchAll(/\b([a-z][a-z0-9]+(?:_[a-z0-9]+){1,})\b/g);
  for (const m of snakeMatches) {
    if (m[1] && m[1].length > 4) terms.add(m[1]);
  }

  return [...terms];
}
