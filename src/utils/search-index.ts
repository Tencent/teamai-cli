import path from 'node:path';
import { readdir, rm } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import matter from 'gray-matter';
import { readFileSafe, readJson, writeJsonAtomic, listFiles, listFilesRecursive, listDirs, pathExists } from './fs.js';
import { tokenize, wordSegments, MAX_TOKENIZE_CHARS } from './tokenizer.js';
import { log } from './logger.js';
import {
  SEARCH_INDEX_VERSION,
  getDataHome,
  getProjectSearchIndexPath,
  isSelfMode,
  type LocalConfig,
  type KnowledgeDomain,
  type LearningDocMeta,
  type SearchIndex,
  type SearchIndexEntry,
  type UserVotes,
  type VoteEntryV2,
  type KnowledgeType,
} from '../types.js';
import { getUserHome } from './home.js';
import { isSafeNamespaceSegment } from '../manifest-schema.js';

/**
 * Self mode keeps one index per checkout, but every checkout shares the
 * learnings checkout and the queue, so a rebuild in one leaves the others'
 * indexes without what it just published or pulled (#808). Drop the other
 * checkouts' indexes in this partition; recall rebuilds a missing one from
 * that checkout's own roots. Only `search-index.json` files are touched.
 */
export async function dropOtherCheckoutIndexes(localConfig: LocalConfig): Promise<void> {
  if (!isSelfMode(localConfig)) return;
  await dropCheckoutIndexes(getDataHome(localConfig), getProjectSearchIndexPath(localConfig));
}

/**
 * Drop every per-checkout index under a self-mode data home, except `keep`.
 * Also used when the migration moves queued learnings into the shared queue.
 */
export async function dropCheckoutIndexes(dataHome: string, keep?: string): Promise<void> {
  const workspaces = path.join(dataHome, 'workspaces');
  let entries: Dirent[];
  try {
    entries = await readdir(workspaces, { withFileTypes: true });
  } catch (e) {
    if (e instanceof Error && 'code' in e && e.code === 'ENOENT') return;
    throw e;
  }
  await Promise.all(
    entries
      // One directory per checkout; a stray file (`.DS_Store`) has no index.
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(workspaces, entry.name, 'search-index.json'))
      .filter((indexPath) => indexPath !== keep)
      .map((indexPath) => rm(indexPath, { force: true })),
  );
}

/**
 * Drop every project search index in a data home: the shared one and each
 * checkout's. For a re-init that changes the install's kind, which keeps the
 * data home but not the repository its indexes were built from (#808).
 */
export async function dropAllSearchIndexes(dataHome: string): Promise<void> {
  await rm(path.join(dataHome, 'search-index.json'), { force: true });
  await dropCheckoutIndexes(dataHome);
}

/** Resolve search index path dynamically (respects HOME changes in tests). */
function getSearchIndexPath(): string {
  return path.join(getUserHome(), '.teamai', 'search-index.json');
}

// ─── Search index data flow ──────────────────────────
//
//  buildIndex(learningsDir, votesDir?)
//      │
//      ├─ listFiles(learningsDir) → *.md files
//      │
//      ├─ for each .md file:
//      │   ├─ read content
//      │   ├─ parse frontmatter (gray-matter)
//      │   ├─ tokenize(title + tags + body excerpt)
//      │   └─ → SearchIndexEntry
//      │
//      ├─ aggregate votes from votesDir
//      │
//      └─ write search-index.json
//
//  search(query, index)
//      │
//      ├─ tokenize(query)
//      ├─ for each entry: count matching tokens
//      ├─ boost: title match × 3, tag match × 2 (IDF-weighted)
//      ├─ normalize by sqrt(query token count), then add vote bonus
//      ├─ record which query words the entry covers (matched/missing)
//      └─ return sorted results
//

const MAX_DOC_BYTES = 50 * 1024; // 50KB

// \u2500\u2500\u2500 P1.4 Domain inference \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
//
// Tags that signal each domain category. Built from real-world learnings tags.
// Ties resolved by: technical > ops > support.

const TECHNICAL_TAGS = new Set([
  'api', 'sdk', 'typescript', 'python', 'golang', 'rust', 'javascript',
  'bug', 'debug', 'error', 'exception', 'fix', 'patch', 'refactor',
  'architecture', 'framework', 'database', 'db', 'cache', 'redis',
  'async', 'concurrent', 'thread', 'performance', 'latency', 'timeout',
  'http', 'grpc', 'proto', 'json', 'schema', 'migration', 'index',
  'test', 'unittest', 'e2e', 'mock', 'lint', 'typecheck',
  'docker', 'build', 'package', 'dependency', 'import', 'module',
  // CJK terms: the tokenizer emits 2-char bigrams for Chinese text, so only
  // 2-char entries can ever match — single chars are too ambiguous to include,
  // and 3+ char words are unreachable by construction.
  // Note: this table is also reused by inferDomain() to match frontmatter tags;
  // a Chinese tag that appears in learnings frontmatter hits here the same way
  // an English tag does — this is intentional and expected behaviour.
  '接口', '代码', '函数', '类型', '重构', '报错', '异常', '调试', '修复', '补丁',
  '性能', '延迟', '超时', '重试', '并发', '异步', '线程', '缓存',
  '架构', '框架', '依赖', '模块', '编译', '构建', '测试', '单测', '断言',
  '算法', '协议',
]);

const OPS_TAGS = new Set([
  'k8s', 'kubernetes', 'deploy', 'deployment', 'cluster', 'node', 'pod',
  'sop', 'upgrade', 'rollout', 'rollback', 'restart', 'scale',
  'monitor', 'alert', 'metrics', 'grafana', 'prometheus', 'log',
  'pipeline', 'ci', 'cd', 'cicd', 'release', 'publish',
  'nginx', 'lb', 'ingress', 'service', 'network', 'firewall',
  'backup', 'restore', 'disaster', 'incident', 'oncall',
  'gpu', 'resource', 'quota', 'tke', 'tcr', 'cos',
  // CJK terms: see TECHNICAL_TAGS comment above for rationale. Also reused by
  // inferDomain() to match frontmatter tags — Chinese tag behaviour is the same
  // as English tag behaviour, which is intentional.
  '部署', '发布', '上线', '回滚', '扩容', '缩容', '重启', '集群', '节点',
  '监控', '告警', '指标', '日志', '排查', '故障', '值班', '预案',
  '容器', '镜像', '网关', '负载', '流量', '带宽', '磁盘', '内存', '显存',
  '备份', '恢复', '容灾', '资源', '配额', '权限', '证书',
]);

const SUPPORT_TAGS = new Set([
  'faq', 'support', 'user', 'customer', 'guide', 'tutorial',
  'onboard', 'onboarding', 'help', 'howto', 'usage', 'example',
  'feedback', 'issue', 'complaint', 'request', 'ticket',
  // CJK terms: see TECHNICAL_TAGS comment above for rationale. Also reused by
  // inferDomain() to match frontmatter tags — Chinese tag behaviour is the same
  // as English tag behaviour, which is intentional.
  '教程', '指南', '示例', '用法', '入门', '新手', '帮助',
  '反馈', '咨询', '问题', '工单', '需求', '客户', '用户',
]);

// Directory path sub-strings that signal a domain.
// Checked in priority order: technical > ops > support.
const TECHNICAL_PATH_PATTERNS = ['docs/architecture/', 'docs/design/', 'docs/api/', 'docs/adr/'];
const OPS_PATH_PATTERNS = ['learnings/ops/', 'docs/ops/', 'docs/deploy/', 'docs/sre/'];
const SUPPORT_PATH_PATTERNS = ['docs/support/', 'docs/faq/', 'docs/guide/', 'learnings/support/'];

// Query-aware domain weights.
//
// Rows = inferred domain of the *query*; columns = domain of the *entry*.
// When the query looks like an ops question (contains k8s/deploy/... tokens),
// ops entries are no longer penalised. When the query is neutral/unknown, a
// mild penalty is kept so technical entries still rank slightly higher.
const DOMAIN_WEIGHT: Record<KnowledgeDomain, Record<KnowledgeDomain, number>> = {
  //               entry domain \u2192
  // query domain \u2193  technical  neutral  ops   support
  technical:       { technical: 1.0, neutral: 0.85, ops: 0.5,  support: 0.3 },
  ops:             { technical: 0.7, neutral: 0.85, ops: 1.0,  support: 0.3 },
  neutral:         { technical: 1.0, neutral: 0.85, ops: 0.75, support: 0.3 },
  support:         { technical: 0.8, neutral: 0.85, ops: 0.5,  support: 1.0 },
};

/**
 * Infer the dominant domain of a search query from its tokens.
 *
 * Matches tokens against the same tag vocabularies used by `inferDomain`, which
 * now include CJK word entries — the tokenizer emits 2-char words for Chinese
 * text, so Chinese queries resolve to a real domain instead of always falling
 * back to 'neutral'. Ties break technical > ops > support, mirroring inferDomain.
 */
function inferQueryDomain(queryTokens: string[]): KnowledgeDomain {
  let techScore = 0;
  let opsScore = 0;
  let supportScore = 0;
  for (const t of queryTokens) {
    if (TECHNICAL_TAGS.has(t)) techScore++;
    if (OPS_TAGS.has(t)) opsScore++;
    if (SUPPORT_TAGS.has(t)) supportScore++;
  }
  const maxScore = Math.max(techScore, opsScore, supportScore);
  if (maxScore === 0) return 'neutral';
  // Tie-breaking mirrors inferDomain: technical > ops > support.
  if (techScore === maxScore) return 'technical';
  if (opsScore === maxScore) return 'ops';
  return 'support';
}

// Type bonuses: skills/rules already represent curated, high-confidence knowledge.
const TYPE_BONUS: Record<KnowledgeType, number> = {
  skills: 1.1,
  rules: 1.1,
  learnings: 1.0,
  docs: 1.0,
};

/**
 * codebase 索引文件名（高权重代理，取代全量 codebase.md）。
 * 同目录下若存在同名全量文档，将被自动跳过收录。
 */
const CODEBASE_INDEX_FILENAME = 'codebase-index.md';

/**
 * codebase 全量文档文件名，有索引文件存在时跳过收录。
 */
const CODEBASE_FULL_FILENAME = 'codebase.md';

/**
 * codebase-index.md 相对于普通 docs 类型的额外权重倍数。
 */
const CODEBASE_INDEX_WEIGHT_BOOST = 1.5;

/**
 * Infer the content domain of a knowledge entry from four signals (priority order):
 * 1. Explicit `domain:` frontmatter field
 * 2. Tag keyword matching (TECHNICAL_TAGS / OPS_TAGS / SUPPORT_TAGS)
 * 3. Directory path patterns (e.g. docs/architecture/ \u2192 technical)
 * 4. Knowledge type fallback (skills/rules \u2192 technical; everything else \u2192 neutral)
 *
 * In case of a score tie between domains, technical beats ops beats support.
 */
export function inferDomain(
  frontmatterDomain: string | undefined,
  tags: string[],
  filePath: string,
  type: KnowledgeType,
): KnowledgeDomain {
  // 1. Explicit frontmatter override
  if (
    frontmatterDomain === 'technical' ||
    frontmatterDomain === 'ops' ||
    frontmatterDomain === 'support' ||
    frontmatterDomain === 'neutral'
  ) {
    return frontmatterDomain;
  }

  // 2. Tags keyword matching
  const normalizedTags = tags.map((t) => t.toLowerCase());
  let techScore = 0;
  let opsScore = 0;
  let supportScore = 0;
  for (const tag of normalizedTags) {
    if (TECHNICAL_TAGS.has(tag)) techScore++;
    if (OPS_TAGS.has(tag)) opsScore++;
    if (SUPPORT_TAGS.has(tag)) supportScore++;
  }
  const maxScore = Math.max(techScore, opsScore, supportScore);
  if (maxScore > 0) {
    // Tie-breaking: technical > ops > support
    if (techScore === maxScore) return 'technical';
    if (opsScore === maxScore) return 'ops';
    return 'support';
  }

  // 3. Directory path matching
  const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();
  for (const pattern of TECHNICAL_PATH_PATTERNS) {
    if (normalizedPath.includes(pattern)) return 'technical';
  }
  for (const pattern of OPS_PATH_PATTERNS) {
    if (normalizedPath.includes(pattern)) return 'ops';
  }
  for (const pattern of SUPPORT_PATH_PATTERNS) {
    if (normalizedPath.includes(pattern)) return 'support';
  }

  // 4. Type fallback
  if (type === 'skills' || type === 'rules') return 'technical';
  return 'neutral';
}

// Re-export tokenizer for external callers
export { tokenize, wordSegments, MAX_TOKENIZE_CHARS };

/**
 * Parse a learning document's frontmatter and body.
 * Returns null if the file is empty or unreadable.
 */
export function parseLearningDoc(
  content: string,
  filename: string,
): { meta: LearningDocMeta; bodyExcerpt: string } | null {
  if (!content.trim()) return null;

  try {
    const { data, content: body } = matter(content);
    const meta: LearningDocMeta = {
      title: typeof data.title === 'string' ? data.title : undefined,
      author: typeof data.author === 'string' ? data.author : undefined,
      date: typeof data.date === 'string'
        ? data.date
        : data.date instanceof Date
          ? data.date.toISOString().slice(0, 10)
          : undefined,
      tags: Array.isArray(data.tags)
        ? data.tags.filter((t: unknown) => typeof t === 'string')
        : typeof data.Tags === 'string'
          ? data.Tags.split(/[,，]\s*/).map((t: string) => t.trim()).filter(Boolean)
          : undefined,
    };

    const bodyExcerpt = body;
    return { meta, bodyExcerpt };
  } catch {
    // Fallback: treat entire content as body, derive title from filename
    log.error(`Failed to parse frontmatter for ${filename}, using fallback`);
    return {
      meta: {},
      bodyExcerpt: content,
    };
  }
}

/**
 * Derive a human-readable title from a filename.
 * "api-timeout-修复-2026-03-20-abc123.md" → "api timeout 修复"
 */
export function titleFromFilename(filename: string): string {
  return filename
    .replace(/\.md$/i, '')
    .replace(/-\d{4}-\d{2}-\d{2}.*$/, '') // Remove date suffix and random
    .replace(/[-_]/g, ' ')
    .trim();
}

/**
 * Aggregate vote counts from per-user vote files.
 * Returns a map of filename → total vote count.
 */
interface VoteAggregation {
  scores: Map<string, number>;
  confidenceMap: Map<string, number>;
}

async function aggregateVotes(votesDir: string): Promise<VoteAggregation> {
  const scores = new Map<string, number>();
  const agg = new Map<string, { recalled: number; upvoted: number; lastRecalled: string }>();
  const files = await listFiles(votesDir);

  for (const file of files) {
    if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
    const content = await readFileSafe(path.join(votesDir, file));
    if (!content) continue;

    try {
      const YAML = (await import('yaml')).default;
      const parsed = YAML.parse(content) as Record<string, unknown> | null;
      if (!parsed?.votes) continue;

      if (parsed.version === 2) {
        const votes = parsed.votes as Record<string, VoteEntryV2>;
        for (const [docId, entry] of Object.entries(votes)) {
          const recalled = entry.recalled_count ?? 0;
          const upvoted = entry.upvoted_count ?? 0;
          scores.set(docId, (scores.get(docId) ?? 0) + recalled * 0.3 + upvoted * 1.0);

          const existing = agg.get(docId) ?? { recalled: 0, upvoted: 0, lastRecalled: '' };
          existing.recalled += recalled;
          existing.upvoted += upvoted;
          if (entry.last_recalled_at > existing.lastRecalled) {
            existing.lastRecalled = entry.last_recalled_at;
          }
          agg.set(docId, existing);
        }
      } else {
        const votes = (parsed as unknown as UserVotes).votes;
        for (const [docId, entry] of Object.entries(votes)) {
          scores.set(docId, (scores.get(docId) ?? 0) + 1);

          const existing = agg.get(docId) ?? { recalled: 0, upvoted: 0, lastRecalled: '' };
          existing.recalled += 1;
          if (entry.at > existing.lastRecalled) existing.lastRecalled = entry.at;
          agg.set(docId, existing);
        }
      }
    } catch {
      log.error(`Failed to parse votes file: ${file}`);
    }
  }

  const { computeConfidence } = await import('../maintenance/confidence.js');
  const confidenceMap = new Map<string, number>();
  for (const [docId, data] of agg) {
    confidenceMap.set(docId, computeConfidence({
      recalledCount: data.recalled,
      upvotedCount: data.upvoted,
      lastRecalledAt: data.lastRecalled,
    }));
  }

  return { scores, confidenceMap };
}

/**
 * Read a markdown file, truncate oversized content, and convert it to a
 * SearchIndexEntry of the given category. Used by all four collectors.
 * Returns null when the file is empty/unreadable.
 */
async function entryFromMdFile(
  absPath: string,
  filenameForId: string,
  type: KnowledgeType,
  voteCounts: Map<string, number>,
): Promise<SearchIndexEntry | null> {
  // 若当前文件是全量 codebase.md，且同目录存在 codebase-index.md，则跳过以避免重复命中。
  const basename = path.basename(absPath);
  if (basename === CODEBASE_FULL_FILENAME) {
    const dir = path.dirname(absPath);
    const indexPath = path.join(dir, CODEBASE_INDEX_FILENAME);
    if (await pathExists(indexPath)) {
      log.debug(`Skipping ${absPath}: codebase-index.md exists in same directory`);
      return null;
    }
  }

  let content = await readFileSafe(absPath);
  if (!content) return null;

  if (Buffer.byteLength(content, 'utf-8') > MAX_DOC_BYTES) {
    content = content.slice(0, MAX_DOC_BYTES);
    log.debug(`Truncated oversized ${type} doc: ${filenameForId}`);
  }

  const parsed = parseLearningDoc(content, filenameForId);
  if (!parsed) return null;

  const { meta, bodyExcerpt } = parsed;
  const title = meta.title ?? titleFromFilename(filenameForId);
  const tags = meta.tags ?? [];

  // Infer domain for P1.4 search weighting.
  // parseLearningDoc only populates the LearningDocMeta fields; read the raw
  // `domain` frontmatter field directly from the raw gray-matter parse.
  const rawFrontmatterDomain = (() => {
    try {
      return (matter(content).data['domain'] as string | undefined);
    } catch {
      return undefined;
    }
  })();
  const domain = inferDomain(rawFrontmatterDomain, tags, absPath, type);

  const titleTokens = tokenize(title);
  const tagTokens = tags.flatMap((tag) => tokenize(tag));
  const bodyTokens = tokenize(bodyExcerpt);

  const tokens = [
    ...titleTokens.map((t) => `title:${t}`),
    ...titleTokens,
    ...tagTokens.map((t) => `tag:${t}`),
    ...tagTokens,
    ...bodyTokens,
    // Type-prefixed token enables future filtered searches (e.g. type:skills).
    `type:${type}`,
  ];

  const docId = filenameForId.replace(/\.md$/i, '');

  return {
    filename: filenameForId,
    title,
    author: meta.author ?? '',
    date: meta.date ?? '',
    tags,
    tokens: [...new Set(tokens)],
    votes: voteCounts.get(docId) ?? 0,
    type,
    domain,
    path: absPath,
  };
}

/** Collect entries from a flat *.md directory (used for `learnings`). */
async function collectFlatMdEntries(
  dir: string,
  type: KnowledgeType,
  voteCounts: Map<string, number>,
): Promise<SearchIndexEntry[]> {
  if (!await pathExists(dir)) return [];
  const files = await listFiles(dir);
  const out: SearchIndexEntry[] = [];
  for (const filename of files) {
    if (!filename.endsWith('.md')) continue;
    const e = await entryFromMdFile(path.join(dir, filename), filename, type, voteCounts);
    if (e) out.push(e);
  }
  return out;
}

/**
 * Namespace-aware learnings collector. Always indexes the flat `.md` files at the
 * `learnings/` root (shared with the whole team — the zero-migration invariant),
 * and additionally indexes `.md` files under each active-project subdirectory.
 * Any subdirectory NOT in `namespaces` is skipped, so a member never sees another
 * project's private learnings in recall.
 *
 * When `namespaces` is undefined the collector degrades to root-only, matching the
 * historical flat behavior for teams without a projects manifest.
 */
async function collectLearningsEntries(
  dirs: readonly string[],
  namespaces: string[] | undefined,
  voteCounts: Map<string, number>,
): Promise<SearchIndexEntry[]> {
  // Roots are ordered by precedence. The relative path doubles as the entry id
  // that votes are counted by, so the same path in two roots must yield ONE
  // entry: the first root's. Deduplicating here rather than downstream is what
  // keeps votes from being counted twice and keeps recall from silently
  // dropping whichever copy it happened to see second (#485).
  const out: SearchIndexEntry[] = [];
  const claimed = new Set<string>();
  for (const dir of dirs) {
    for (const entry of await collectLearningsEntriesFromDir(dir, namespaces, voteCounts)) {
      if (claimed.has(entry.filename)) continue;
      claimed.add(entry.filename);
      out.push(entry);
    }
  }
  return out;
}

async function collectLearningsEntriesFromDir(
  dir: string,
  namespaces: string[] | undefined,
  voteCounts: Map<string, number>,
): Promise<SearchIndexEntry[]> {
  if (!await pathExists(dir)) return [];
  // Root-level .md = always shared.
  const out: SearchIndexEntry[] = await collectFlatMdEntries(dir, 'learnings', voteCounts);

  for (const ns of namespaces ?? []) {
    // Defense-in-depth: a namespace is a path segment (learnings/<ns>/). Skip
    // anything that isn't a safe single segment so a hand-edited config can't
    // make the index scan outside the learnings directory. The rule must be the
    // one `contribute` writes with, or a learning filed under a valid non-ASCII
    // namespace would never be indexed.
    if (!isSafeNamespaceSegment(ns)) continue;
    const nsDir = path.join(dir, ns);
    if (!await pathExists(nsDir)) continue;
    const files = await listFilesRecursive(nsDir);
    for (const rel of files) {
      if (!rel.endsWith('.md')) continue;
      // Prefix the id with the namespace so it stays unique against the root and
      // other namespaces (e.g. `hai-inference/deploy-note.md`).
      const e = await entryFromMdFile(path.join(nsDir, rel), path.join(ns, rel), 'learnings', voteCounts);
      if (e) out.push(e);
    }
  }
  return out;
}

/**
 * Collect entries from a recursive *.md directory (used for `docs` and
 * `rules`, which may have subdirectories like `rules/common/`).
 */
async function collectRecursiveMdEntries(
  dir: string,
  type: KnowledgeType,
  voteCounts: Map<string, number>,
): Promise<SearchIndexEntry[]> {
  if (!await pathExists(dir)) return [];
  const files = await listFilesRecursive(dir);
  const out: SearchIndexEntry[] = [];
  for (const rel of files) {
    if (!rel.endsWith('.md')) continue;
    // Use the relative path as the filename so the entry id is unique
    // across subdirectories, e.g. `common/coding-style.md`.
    const e = await entryFromMdFile(path.join(dir, rel), rel, type, voteCounts);
    if (e) out.push(e);
  }
  return out;
}

/** `collectRecursiveMdEntries` over an explicit list of paths relative to `dir`. */
async function collectListedMdEntries(
  dir: string,
  files: readonly string[],
  type: KnowledgeType,
  voteCounts: Map<string, number>,
): Promise<SearchIndexEntry[]> {
  const out: SearchIndexEntry[] = [];
  for (const rel of files) {
    if (!rel.endsWith('.md')) continue;
    const e = await entryFromMdFile(path.join(dir, rel), rel, type, voteCounts);
    if (e) out.push(e);
  }
  return out;
}

/**
 * Collect entries from a skills directory whose layout is
 *   skills/<name>/SKILL.md            (flat)
 *   skills/<namespace>/<name>/SKILL.md (namespaced)
 *
 * Each entry's `filename` is `<skill-name>.md` (so doc_id = skill name).
 */
async function collectSkillEntries(
  dir: string,
  voteCounts: Map<string, number>,
): Promise<SearchIndexEntry[]> {
  if (!await pathExists(dir)) return [];
  const out: SearchIndexEntry[] = [];

  async function walk(current: string): Promise<void> {
    const subdirs = await listDirs(current);
    for (const sub of subdirs) {
      if (sub.startsWith('.')) continue;
      const subPath = path.join(current, sub);
      const skillMd = path.join(subPath, 'SKILL.md');
      if (await pathExists(skillMd)) {
        const e = await entryFromMdFile(skillMd, `${sub}.md`, 'skills', voteCounts);
        if (e) out.push(e);
      } else {
        // Treat as a namespace directory and recurse one level.
        await walk(subPath);
      }
    }
  }

  await walk(dir);
  return out;
}

/**
 * The skills to index in place of walking `skillsDir`: the directories `pull`
 * delivers to this member (#707), or, when that set cannot be resolved this
 * run and pull keeps the installed skills, the skills the index already holds.
 */
export type IndexedSkills =
  | { readonly kind: 'dirs'; readonly dirs: readonly string[] }
  | {
    readonly kind: 'keep-indexed';
    /** Why the set cannot be resolved, for a build with no index to keep them from. */
    readonly reason: string;
  };

/**
 * Entries for an explicit list of skill directories, each `<dir>/SKILL.md`,
 * named after the directory (doc_id = skill name) as `collectSkillEntries` does.
 */
async function collectSkillDirEntries(
  dirs: readonly string[],
  voteCounts: Map<string, number>,
): Promise<SearchIndexEntry[]> {
  const out: SearchIndexEntry[] = [];
  for (const dir of dirs) {
    const skillMd = path.join(dir, 'SKILL.md');
    if (!await pathExists(skillMd)) continue;
    const e = await entryFromMdFile(skillMd, `${path.basename(dir)}.md`, 'skills', voteCounts);
    if (e) out.push(e);
  }
  return out;
}

/** Options for the multi-category build. */
export interface BuildIndexOptions {
  /** One learnings root. Equivalent to `learningsDirs: [dir]`. */
  learningsDir?: string;
  /**
   * Learnings roots, highest precedence first. For the same relative path in
   * two roots the first one wins and the rest are skipped. Takes precedence
   * over `learningsDir` when both are given.
   */
  learningsDirs?: readonly string[];
  /**
   * Active learnings namespaces (project ids). When provided, the learnings
   * collector indexes the flat root `.md` files (always shared) PLUS the `.md`
   * files under each named subdirectory, and skips every other subdirectory —
   * so project-private learnings only surface for members of that project.
   * When undefined, only the flat root is indexed (legacy behavior).
   */
  learningsNamespaces?: string[];
  docsDir?: string;
  /**
   * The docs to index, relative to `docsDir`, in place of walking all of it:
   * the set `pull` delivers to this member (#707), so recall does not return
   * docs of a namespace the member does not have.
   */
  docFiles?: readonly string[];
  rulesDir?: string;
  /**
   * The rules to index, relative to `rulesDir`, in place of walking all of it:
   * the set `pull` delivers to this member (#707), so recall returns neither a
   * root rule a namespace replaces nor a rule of an inactive namespace.
   */
  ruleFiles?: readonly string[];
  /**
   * Every skill under this directory. A member's index passes `skills`
   * instead; `viz` indexes a whole knowledge repo, not one member's view.
   */
  skillsDir?: string;
  /** In place of `skillsDir`: the skills this member receives, so recall does not return others. */
  skills?: IndexedSkills;
  codebaseDir?: string;
  votesDir?: string;
  indexPath?: string;
  /**
   * The caller left sources out on purpose (a team manifest it cannot read):
   * write the index even when it is far smaller than the one on disk, which
   * would otherwise stay and serve what was left out (#823).
   */
  partial?: boolean;
}

/**
 * Build the search index from local learning documents.
 *
 * @param learningsDir - Path to ~/.teamai/learnings/
 * @param votesDir - Path to votes directory (team repo votes/ or local)
 * @returns elapsed ms
 */
export async function buildIndex(
  optionsOrLearningsDir: BuildIndexOptions | string,
  votesDir?: string,
  indexPath?: string,
): Promise<number> {
  const start = Date.now();

  // Backward compatibility: original signature was
  //   buildIndex(learningsDir: string, votesDir?: string, indexPath?: string)
  // The Phase 1 multi-category form takes a single options object instead.
  const opts: BuildIndexOptions = typeof optionsOrLearningsDir === 'string'
    ? { learningsDir: optionsOrLearningsDir, votesDir, indexPath }
    : optionsOrLearningsDir;
  const index = await indexInMemory(opts);
  const elapsed = Date.now() - start;

  // Guard: don't overwrite a healthy index with a significantly smaller one
  const targetPath = opts.indexPath ?? getSearchIndexPath();
  const existingIndex = await loadIndex(targetPath);
  const { entries } = index;
  if (!opts.partial && existingIndex && existingIndex.entries.length > 5 && entries.length < existingIndex.entries.length * 0.2) {
    log.warn(`Index rebuild skipped: new index (${entries.length}) is <20% of existing (${existingIndex.entries.length}), likely partial failure`);
    return elapsed;
  }

  // A torn in-place write parses as null on the next loadIndex, which silently
  // wipes recall until the next rebuild — same shape as the votes file (#854).
  await writeJsonAtomic(targetPath, index);

  if (elapsed > 2000) {
    log.warn(`Search index build took ${elapsed}ms — consider incremental updates for large knowledge bases`);
  }

  return elapsed;
}

/**
 * The index {@link buildIndex} would write, built in memory and not saved: for
 * a dry run, which must search what a real run would without writing it.
 */
export async function indexInMemory(opts: BuildIndexOptions): Promise<SearchIndex> {
  const start = Date.now();

  // Aggregate votes once and reuse across all collectors.
  const voteAgg = opts.votesDir
    ? await aggregateVotes(opts.votesDir)
    : { scores: new Map<string, number>(), confidenceMap: new Map<string, number>() };
  const voteCounts = voteAgg.scores;

  const entries: SearchIndexEntry[] = [];

  const learningsDirs = opts.learningsDirs ?? (opts.learningsDir ? [opts.learningsDir] : []);
  if (learningsDirs.length > 0) {
    entries.push(...await collectLearningsEntries(learningsDirs, opts.learningsNamespaces, voteCounts));
  }
  if (opts.docsDir && opts.docFiles) {
    entries.push(...await collectListedMdEntries(opts.docsDir, opts.docFiles, 'docs', voteCounts));
  } else if (opts.docsDir) {
    entries.push(...await collectRecursiveMdEntries(opts.docsDir, 'docs', voteCounts));
  }
  if (opts.rulesDir && opts.ruleFiles) {
    entries.push(...await collectListedMdEntries(opts.rulesDir, opts.ruleFiles, 'rules', voteCounts));
  } else if (opts.rulesDir) {
    entries.push(...await collectRecursiveMdEntries(opts.rulesDir, 'rules', voteCounts));
  }
  if (opts.skills?.kind === 'dirs') {
    entries.push(...await collectSkillDirEntries(opts.skills.dirs, voteCounts));
  } else if (opts.skills?.kind === 'keep-indexed') {
    const previous = await loadIndex(opts.indexPath ?? getSearchIndexPath());
    entries.push(...(previous?.entries ?? []).filter((entry) => entry.type === 'skills'));
  } else if (opts.skillsDir) {
    entries.push(...await collectSkillEntries(opts.skillsDir, voteCounts));
  }
  if (opts.codebaseDir) {
    entries.push(...await collectRecursiveMdEntries(opts.codebaseDir, 'docs', voteCounts));
  }

  // Annotate entries with confidence/hotness for hot/cold scoring.
  if (voteAgg.confidenceMap.size > 0) {
    try {
      const { annotateHotness } = await import('../maintenance/hot-cold.js');
      annotateHotness(entries, voteAgg.confidenceMap);
    } catch {
      // Non-critical: hot/cold annotation is best-effort
    }
  }

  // Build document-frequency map for IDF weighting.
  // Count how many *entries* contain each token (not raw term frequency).
  const df: Record<string, number> = {};
  const dfByDomain: NonNullable<SearchIndex['dfByDomain']> = {};
  for (const entry of entries) {
    const domain = entry.domain ?? 'neutral';
    const domainDf = dfByDomain[domain] ??= {};
    for (const token of new Set(entry.tokens)) {
      df[token] = (df[token] ?? 0) + 1;
      domainDf[token] = (domainDf[token] ?? 0) + 1;
    }
  }

  return {
    version: SEARCH_INDEX_VERSION,
    builtAt: new Date().toISOString(),
    elapsedMs: Date.now() - start,
    entries,
    df,
    dfByDomain,
  };
}

/**
 * Returns true when the on-disk index predates the current schema version or
 * lacks the per-domain IDF statistics added in v7.
 * The caller should rebuild such an index using the multi-category collectors.
 */
export function isLegacyIndex(index: SearchIndex | null): boolean {
  if (!index) return false;
  if (typeof index.version !== 'number' || index.version < SEARCH_INDEX_VERSION) return true;
  return index.entries.some((e) => !e.type || e.domain === undefined)
    || !index.df
    || !index.dfByDomain
    || index.entries.some((e) => index.dfByDomain?.[e.domain ?? 'neutral'] === undefined);
}

/**
 * Load the search index from disk. Returns null if missing or corrupt.
 */
export async function loadIndex(indexPath?: string): Promise<SearchIndex | null> {
  const raw = await readJson<SearchIndex>(indexPath ?? getSearchIndexPath());
  if (!raw || !Array.isArray(raw.entries)) {
    return null;
  }
  return raw;
}

/** A single search result with relevance score. */
export interface SearchResult {
  entry: SearchIndexEntry;
  score: number;
  /** Query words matching this entry's title or tags. Absent for codebase-graph
   *  hits, which are scored by BM25 over pages rather than per-term coverage. */
  matchedTerms?: string[];
  /** Query words matching neither its title nor its tags. */
  missingTerms?: string[];
}

/**
 * Identity key for collapsing duplicate search results: only fields a re-share
 * copies verbatim, so two copies of one document match however each scored.
 *
 * `score` is excluded because it is per-query and carries the vote bonus, so
 * copies drift apart as they collect votes independently. Token *content* is
 * compared rather than `tokens.length`, which distinct entries routinely share.
 *
 * `tokens` is the entry's deduplicated token set (title + tags + body excerpt),
 * so tags and body reach the key already normalized, and comparison is by
 * vocabulary rather than prose. It is sorted because tag order follows
 * hand-authored frontmatter, which a re-share may reorder. `domain` is listed
 * separately: it comes from frontmatter, never reaches the token set, and until
 * now was kept apart only by the domain multiplier inside `score`.
 */
function dedupKey(r: SearchResult): string {
  return JSON.stringify([
    r.entry.type,
    r.entry.domain,
    r.entry.title,
    r.entry.date,
    r.entry.author,
    [...r.entry.tokens].sort(),
  ]);
}

/**
 * Search the index with a query string.
 *
 * Scoring (P1.4 domain-weighted):
 * - Title token match: 3 points
 * - Tag token match: 2 points
 * - Body token match: 1 point
 * - Vote bonus: +0.5 per vote (caps at 5 points)
 * - Domain multiplier: technical ×1.0, neutral ×0.85, ops ×0.5, support ×0.3
 * - Type bonus: skills/rules ×1.1 (curated high-confidence knowledge)
 *
 * @returns Results sorted by score descending, limited to top N.
 */
export function search(
  query: string,
  index: SearchIndex,
  limit: number = 5,
): SearchResult[] {
  if (!query.trim()) return [];

  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  // Infer query domain for adaptive weighting (改动 A).
  const queryDomain = inferQueryDomain(queryTokens);
  const domainWeightRow = DOMAIN_WEIGHT[queryDomain];

  // IDF uses each entry's domain so adding unrelated knowledge cannot change
  // the score of an existing entry. Older in-memory indexes keep their global
  // df behavior until the caller rebuilds the persisted index.
  const domainSizes: Partial<Record<KnowledgeDomain, number>> = {};
  for (const entry of index.entries) {
    const domain = entry.domain ?? 'neutral';
    domainSizes[domain] = (domainSizes[domain] ?? 0) + 1;
  }
  const df = index.df ?? {};

  /**
   * IDF score for a token within its entry's domain. Falls back to the global
   * v6 map for older indexes and to 1.0 when no df map is available.
   */
  const idf = (token: string, domain: KnowledgeDomain): number => {
    const domainDf = index.dfByDomain?.[domain];
    if (domainDf) {
      const n = domainSizes[domain] ?? 0;
      const docFreq = domainDf[token] ?? 0;
      return Math.log((n + 1) / (docFreq + 1)) + 1;
    }
    if (!index.df) return 1.0;
    const docFreq = df[token] ?? 0;
    return Math.log((index.entries.length + 1) / (docFreq + 1)) + 1;
  };

  // Query-length normalization: raw match sums grow with query length, so a
  // 15-token question outscores a 4-token one on generic words alone. That makes
  // any absolute relevance threshold meaningless across queries. Dividing by
  // sqrt(len) keeps scores comparable while still rewarding queries that match
  // on more terms. Within a single query this is a constant factor, so relative
  // ranking is unaffected.
  const lengthNorm = Math.sqrt(queryTokens.length);

  // Report coverage per query word, not per internal token, so callers see the
  // terms they typed ("AppID") rather than tokenizer fragments ("app", "id").
  // Words come from the segmenter rather than a whitespace split: languages that
  // do not delimit words with spaces would otherwise collapse into a single
  // "word" that counts as matched whenever any fragment of it hits, reporting
  // full coverage for an entry that missed every distinctive term.
  // Relevance is the caller's judgement; search only states what it covers.
  const wordTokens = wordSegments(query).map((w) => ({ word: w, tokens: tokenize(w) }));

  const results: SearchResult[] = [];

  for (const entry of index.entries) {
    let score = 0;
    let hasTitleOrTagMatch = false;
    const entryDomain = entry.domain ?? 'neutral';
    const entryTokens = new Set(entry.tokens);

    for (const qt of queryTokens) {
      const titleToken = `title:${qt}`;
      const tagToken = `tag:${qt}`;

      if (entryTokens.has(titleToken)) {
        score += 3 * idf(titleToken, entryDomain);
        hasTitleOrTagMatch = true;
      }
      if (entryTokens.has(tagToken)) {
        score += 2 * idf(tagToken, entryDomain);
        hasTitleOrTagMatch = true;
      }
      if (entryTokens.has(qt)) {
        score += 1 * idf(qt, entryDomain);
      }
    }

    // Require at least one title or tag match to filter out body-only noise.
    // Docs (type === 'docs') often lack tags and have generic titles, so allow body-only
    // matches for them — the IDF weighting naturally demotes low-relevance hits.
    const isDocsEntry = entry.type === 'docs';
    if (score > 0 && (hasTitleOrTagMatch || isDocsEntry)) {
      // Normalize the token-match sum by query length before adding absolute
      // bonuses, so cross-query scores share a scale (see lengthNorm above).
      score /= lengthNorm;
      // Vote bonus: +0.5 per vote, max 5 points (unchanged).
      score += Math.min(entry.votes * 0.5, 5);

      // Query-aware domain weight (改动 A) × type bonus (unchanged).
      // Missing domain degrades gracefully to 'neutral'.
      const domainMultiplier = domainWeightRow[entry.domain ?? 'neutral'];
      const typeMultiplier = TYPE_BONUS[entry.type];
      score *= domainMultiplier * typeMultiplier;

      // codebase-index.md 额外权重 boost，确保章节摘要优先于普通 docs 返回。
      if (path.basename(entry.path ?? '') === CODEBASE_INDEX_FILENAME) {
        score *= CODEBASE_INDEX_WEIGHT_BOOST;
      }

      // Hot/cold penalty: entries with low confidence get demoted.
      if (entry.hotness !== undefined && entry.hotness < 1.0) {
        score *= entry.hotness;
      }

      // Coverage per query word: matched when any of its tokens hits title/tag.
      // Skipped for entries admitted only by the codebase exemption — those are
      // scored on body text, so every term would read as missing and the caller
      // would discard a legitimate hit as uncovered.
      if (!hasTitleOrTagMatch) {
        results.push({ entry, score });
        continue;
      }

      const matchedTerms: string[] = [];
      const missingTerms: string[] = [];
      for (const { word, tokens: wt } of wordTokens) {
        const hit = wt.some((t) => entryTokens.has(`title:${t}`) || entryTokens.has(`tag:${t}`));
        (hit ? matchedTerms : missingTerms).push(word);
      }

      results.push({ entry, score, matchedTerms, missingTerms });
    }
  }

  // Sort by score descending, then by date descending for ties.
  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.entry.date || '').localeCompare(a.entry.date || '');
  });

  // Collapse duplicates before truncating. The same learning can be shared
  // twice, landing in the corpus as two files whose only difference is the
  // random filename suffix; both would otherwise consume two of the `limit`
  // slots, silently narrowing the result set.
  //
  // Results are already sorted by score descending, so the surviving copy of a
  // duplicate is its highest-scoring one. See dedupKey for what counts as the
  // same content.
  const seen = new Set<string>();
  const deduped: SearchResult[] = [];
  for (const r of results) {
    const key = dedupKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(r);
    if (deduped.length === limit) break;
  }

  return deduped;
}
