/**
 * The default workflow `teamai-import-from-iwiki`, which `teamai import --from-iwiki` starts: the `teamai import`
 * verbs its steps call fetch the pages into the run's directory for teamai-import-learnings to classify, and publish
 * what it wrote, linked to the teamwiki's code knowledge.
 */

import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { z } from 'zod';

import { ImportLearnings, type Candidate, type LearningsImport } from './import-local.js';
import { buildDualContext } from './iwiki-dual.js';
import { RUN_DIR_ENV } from './launch-context.js';
import { IWikiClient } from './utils/iwiki-client.js';
import type { IWikiDocument, IWikiPage } from './utils/iwiki-client.js';
import { log, spinner } from './utils/logger.js';
import { pathExists } from './utils/fs.js';
import type { ShortcutEnd } from './workflow-commands.js';

const WORKFLOW = 'teamai-import-from-iwiki';

/** Said when the token every iWiki request carries is not set. */
const TOKEN_MISSING = 'Please set TAI_PAT_TOKEN environment variable (get it at: https://tai.it.woa.com/user/pat)';

/** What an iWiki input names: a whole space, or one page. */
interface IWikiTarget {
  type: 'space' | 'page';
  id: string;
}

/** A numeric space id, or a URL holding `/p/<id>` or `/pages/<id>`. */
function parseIWikiInput(input: string): IWikiTarget {
  const trimmed = input.trim();

  if (/^\d+$/.test(trimmed)) {
    return { type: 'space', id: trimmed };
  }

  const pageMatch = trimmed.match(/\/(?:p|pages)\/([^/?#]+)/);

  if (pageMatch) {
    return { type: 'page', id: pageMatch[1] };
  }

  throw new Error(
    `Unrecognized iWiki input format: "${trimmed}". ` +
      'Please enter a numeric Space ID or a page URL containing /p/.',
  );
}

/** How many documents are downloaded at once. */
const DOWNLOAD_BATCH_SIZE = 5;

/** The documents of `pages`, a batch at a time; a page that cannot be downloaded is said and skipped. */
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

const DocumentsSchema = z.array(z.object({ docid: z.string(), title: z.string(), content: z.string(), url: z.string() }));

/** What `fetch-iwiki` prints: where the documents are, each one to classify, and the text the dual sections are asked about. */
interface Fetched {
  source: string;
  /** The JSON file of every document, '' when none was downloaded. */
  documents: string;
  candidates: Candidate[];
  dual_context: string;
}

/**
 * `teamai import fetch-iwiki`: downloads the pages `source` names into `$TEAMAI_RUN_DIR/iwiki/`, one file per document to
 * classify and a JSON file of them all. Says why there is nothing to import when no page was found or downloaded.
 */
async function fetch({ source, dual }: { source: string; dual: string }): Promise<Fetched> {
  const token = process.env['TAI_PAT_TOKEN'];

  if (!token) throw new Error(TOKEN_MISSING);
  const runDir = process.env[RUN_DIR_ENV];

  if (!runDir) throw new Error(`teamai import fetch-iwiki is a step of a ${WORKFLOW} run, which sets ${RUN_DIR_ENV}. Run teamai import --from-iwiki instead.`);
  const isDual = ImportLearnings.parseBoolean('--dual', dual);
  const { type, id } = parseIWikiInput(source);
  const client = new IWikiClient(token);
  const none: Fetched = { source: `iwiki://${id}`, documents: '', candidates: [], dual_context: '' };
  let pages: IWikiPage[];

  if (type === 'page') {
    pages = [{ docid: id, title: id }];
  } else {
    const fetchSpinner = await spinner(`Fetching iWiki Space (${id}) page tree...`);

    try {
      pages = await client.fetchAllPages(id, { maxPages: 200 });
      fetchSpinner.succeed(`Page tree fetched: ${pages.length} pages`);
    } catch (err: unknown) {
      fetchSpinner.fail(`Page tree fetch failed: ${String(err)}`);
      throw err;
    }
  }

  if (pages.length === 0) {
    log.warn('no pages found, import aborted');

    return none;
  }

  const downloadSpin = await spinner(`Downloading iWiki documents (${pages.length} pages)...`);
  let documents: IWikiDocument[];

  try {
    documents = await downloadDocuments(client, pages);
    downloadSpin.succeed(`Documents downloaded: ${documents.length}/${pages.length} pages`);
  } catch (err: unknown) {
    downloadSpin.fail(`Document download error: ${String(err)}`);
    throw err;
  }

  if (documents.length === 0) {
    log.warn('all document downloads failed, import aborted');

    return none;
  }

  const dir = path.join(runDir, 'iwiki');
  await mkdir(dir, { recursive: true });
  const candidates: Candidate[] = [];

  for (const doc of documents) {
    const file = path.join(dir, `${doc.docid.replace(/[^\w.-]/g, '_')}.md`);
    await writeFile(file, doc.content, 'utf-8');
    candidates.push({ path: `iwiki://p/${doc.docid}`, file });
  }

  const documentsFile = path.join(dir, 'documents.json');
  await writeFile(documentsFile, JSON.stringify(documents), 'utf-8');

  return { ...none, documents: documentsFile, candidates, dual_context: isDual ? buildDualContext(documents) : '' };
}

/**
 * `teamai import publish-iwiki`: once teamai-import-learnings wrote the items into the team repo, links the documents to
 * the teamwiki's code knowledge, then commits and pushes. An import into another directory pushes nothing.
 */
async function publish(flags: { kept: string; written: string; target: string; byType: string; documents: string }): Promise<Record<string, never>> {
  if (Number(flags.kept) === 0) {
    log.warn('no valid entries after AI classification, import aborted');

    return {};
  }

  if (!ImportLearnings.parseBoolean('--by-type', flags.byType)) {
    log.success('iWiki import complete');

    return {};
  }

  const documents = ImportLearnings.parseFlag(DocumentsSchema, '--documents', await readFile(flags.documents, 'utf-8'), WORKFLOW);
  const teamwikiRoot = path.join(flags.target, 'teamwiki');

  if (await pathExists(path.join(teamwikiRoot, '.indices', 'graph-index.json'))) {
    try {
      const mapsToEdges = await reconcileIwikiWithCodebase(documents, teamwikiRoot);

      if (mapsToEdges.length > 0) {
        log.success(`Established ${mapsToEdges.length} iWiki↔code MAPS_TO relations`);
      } else {
        log.info('[reconcile] no matches found between iWiki docs and code knowledge');
      }
    } catch (err) {
      log.debug(`[reconcile] iWiki↔code relation failed (non-blocking): ${err instanceof Error ? err.message : err}`);
    }
  }

  const { autoPushTeamRepo } = await import('./utils/git.js');
  await autoPushTeamRepo(flags.target, `[teamai] Import from iWiki: ${documents.map(d => d.title).slice(0, 3).join(', ')}`);

  log.success('iWiki import complete');

  return {};
}

/**
 * `teamai import --from-iwiki`: imports the pages `source` names through a teamai-import-from-iwiki run, and with
 * `dual` the codebase sections into docs/team-codebase/ of this directory, or `output`.
 */
async function start(options: LearningsImport & { source: string; dual: boolean; requireReview: boolean }): Promise<ShortcutEnd | undefined> {
  const { getTeamCodebasePaths } = await import('./utils/team-codebase-paths.js');
  const cwd = process.cwd();

  return ImportLearnings.start(WORKFLOW, {
    source: options.source,
    dual: options.dual,
    sections_dir: path.resolve(getTeamCodebasePaths(cwd, options.output).root),
    review_dir: cwd,
    require_review: options.requireReview,
  }, options, () => {
    if (!process.env['TAI_PAT_TOKEN']) throw new Error(TOKEN_MISSING);
  });
}

export const ImportFromIwiki = { fetch, publish, start } as const;

// ─── iWiki↔Codebase Reconciliation ────────────────────────────

interface MapsToEdge {
  from: string;
  to: string;
  relation: 'MAPS_TO';
  term: string;
  confidence: number;
  /**
   * The matched code node's own origin, captured at match time (#974
   * review round 16 P1) — not re-derived later from whichever node
   * currently occupies that slug, which a later slug collision between two
   * codebases can silently reattribute. Absent when the matched node
   * itself had no origin yet (legacy data from before aggregation-time
   * tagging existed).
   */
  origin?: string;
}

/**
 * 将 iWiki 文档与 teamwiki 代码知识图谱进行对账，建立 MAPS_TO 关系。
 *
 * 基于 team-wiki reconciler 的核心逻辑（by @lurkacai）：
 * - 从文档中提取关键术语（API path、类名、模块名）
 * - 在代码事实页面中搜索匹配
 * - 匹配成功则建立 MAPS_TO 边
 */
export async function reconcileIwikiWithCodebase(
  documents: IWikiDocument[],
  teamwikiRoot: string,
): Promise<MapsToEdge[]> {
  const graphPath = path.join(teamwikiRoot, '.indices', 'graph-index.json');
  const graphRaw = await readFile(graphPath, 'utf-8');
  const graph = JSON.parse(graphRaw);

  // 收集代码节点的标签用于匹配 — 连同该节点此刻的 origin 一并记录：
  // 之后若另一个 codebase 碰撞出相同的无前缀 slug 并赢得 merge，这里捕获的
  // origin 不会跟着被覆盖（#974 review round 16 P1）。
  // `label`/`id` 为旧字段名的回退：当前 schema 写入的节点用的是
  // `title`/`slug`（本函数对 graph-index.json 做的是原始 JSON.parse，不经过
  // loadGraphIndex 的字段归一化）。
  const codeLabels = new Map<string, { id: string; origin?: string }>();

  for (const node of graph.nodes) {
    const label: string | undefined = node.label ?? node.title;
    const id: string | undefined = node.id ?? node.slug;

    if (!label || !id) continue;
    codeLabels.set(label.toLowerCase(), { id, origin: node.origin });
    // 也索引 PascalCase 拆分后的单词
    const words = label.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    codeLabels.set(words, { id, origin: node.origin });
  }

  // 加载代码事实页面内容用于全文匹配
  const evidenceDir = path.join(teamwikiRoot, 'evidence', 'code');
  const codePageContents = new Map<string, string>();

  if (await pathExists(evidenceDir)) {
    const { readdir } = await import('node:fs/promises');
    const projects = await readdir(evidenceDir);

    for (const project of projects) {
      const projectDir = path.join(evidenceDir, project);
      const files = await readdir(projectDir).catch(() => []);

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
        const key = `${docSlug}|${directMatch.id}`;

        if (!edgeSet.has(key)) {
          edgeSet.add(key);
          mapsToEdges.push({ from: docSlug, to: directMatch.id, relation: 'MAPS_TO', term, confidence: 0.8, origin: directMatch.origin });
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
