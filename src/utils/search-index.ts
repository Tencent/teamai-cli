import path from 'node:path';
import matter from 'gray-matter';
import { readFileSafe, readJson, writeJson, listFiles, listFilesRecursive, listDirs, pathExists } from './fs.js';
import { log } from './logger.js';
import {
  SEARCH_INDEX_VERSION,
  type LearningDocMeta,
  type SearchIndex,
  type SearchIndexEntry,
  type UserVotes,
  type KnowledgeType,
} from '../types.js';

/** Resolve search index path dynamically (respects HOME changes in tests). */
function getSearchIndexPath(): string {
  return `${process.env.HOME ?? ''}/.teamai/search-index.json`;
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
//      ├─ boost: title match × 3, tag match × 2, vote bonus
//      └─ return sorted results
//

const CJK_RANGE = /[\u4e00-\u9fff]/;
const MAX_BODY_CHARS = 2000;
const MAX_DOC_BYTES = 50 * 1024; // 50KB

/**
 * Hybrid tokenizer: Intl.Segmenter for word boundaries + CJK bigrams.
 *
 * Intl.Segmenter splits Chinese characters individually ("超时" → ["超","时"]),
 * so we additionally generate bigrams for CJK runs to capture compound words
 * ("超时" bigram matches query "超时").
 */
export function tokenize(text: string): string[] {
  if (!text) return [];

  const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
  const segments = [...segmenter.segment(text)];
  const tokens: string[] = [];

  // Collect CJK characters in runs for bigram generation
  let cjkRun: string[] = [];

  const flushCjkRun = (): void => {
    if (cjkRun.length >= 2) {
      for (let i = 0; i < cjkRun.length - 1; i++) {
        tokens.push(cjkRun[i] + cjkRun[i + 1]);
      }
    }
    cjkRun = [];
  };

  for (const seg of segments) {
    if (!seg.isWordLike) {
      flushCjkRun();
      continue;
    }

    const word = seg.segment.toLowerCase();
    tokens.push(word);

    // Track CJK runs for bigram generation
    const chars = [...word];
    for (const ch of chars) {
      if (CJK_RANGE.test(ch)) {
        cjkRun.push(ch);
      } else {
        flushCjkRun();
      }
    }
  }
  flushCjkRun();

  return [...new Set(tokens)];
}

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

    const bodyExcerpt = body.slice(0, MAX_BODY_CHARS);
    return { meta, bodyExcerpt };
  } catch {
    // Fallback: treat entire content as body, derive title from filename
    log.error(`Failed to parse frontmatter for ${filename}, using fallback`);
    return {
      meta: {},
      bodyExcerpt: content.slice(0, MAX_BODY_CHARS),
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
async function aggregateVotes(votesDir: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const files = await listFiles(votesDir);

  for (const file of files) {
    if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
    const content = await readFileSafe(path.join(votesDir, file));
    if (!content) continue;

    try {
      const YAML = (await import('yaml')).default;
      const parsed = YAML.parse(content) as UserVotes | null;
      if (parsed?.votes) {
        for (const docId of Object.keys(parsed.votes)) {
          counts.set(docId, (counts.get(docId) ?? 0) + 1);
        }
      }
    } catch {
      log.error(`Failed to parse votes file: ${file}`);
    }
  }

  return counts;
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

/** Options for the multi-category build. */
export interface BuildIndexOptions {
  learningsDir?: string;
  docsDir?: string;
  rulesDir?: string;
  skillsDir?: string;
  votesDir?: string;
  indexPath?: string;
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

  // Aggregate votes once and reuse across all collectors.
  const voteCounts = opts.votesDir
    ? await aggregateVotes(opts.votesDir)
    : new Map<string, number>();

  const entries: SearchIndexEntry[] = [];

  if (opts.learningsDir) {
    entries.push(...await collectFlatMdEntries(opts.learningsDir, 'learnings', voteCounts));
  }
  if (opts.docsDir) {
    entries.push(...await collectRecursiveMdEntries(opts.docsDir, 'docs', voteCounts));
  }
  if (opts.rulesDir) {
    entries.push(...await collectRecursiveMdEntries(opts.rulesDir, 'rules', voteCounts));
  }
  if (opts.skillsDir) {
    entries.push(...await collectSkillEntries(opts.skillsDir, voteCounts));
  }

  const elapsed = Date.now() - start;
  const index: SearchIndex = {
    version: SEARCH_INDEX_VERSION,
    builtAt: new Date().toISOString(),
    elapsedMs: elapsed,
    entries,
  };

  await writeJson(opts.indexPath ?? getSearchIndexPath(), index);

  if (elapsed > 2000) {
    log.warn(`Search index build took ${elapsed}ms — consider incremental updates for large knowledge bases`);
  }

  return elapsed;
}

/**
 * Returns true when the on-disk index pre-dates Phase 1 (no version field,
 * version below current schema, or any entry missing the `type` field). The
 * caller should rebuild such an index using the multi-category collectors.
 */
export function isLegacyIndex(index: SearchIndex | null): boolean {
  if (!index) return false;
  if (typeof index.version !== 'number' || index.version < SEARCH_INDEX_VERSION) return true;
  return index.entries.some((e) => !e.type);
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
}

/**
 * Search the index with a query string.
 *
 * Scoring:
 * - Title token match: 3 points
 * - Tag token match: 2 points
 * - Body token match: 1 point
 * - Vote bonus: +0.5 per vote (caps at 5 points)
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

  const results: SearchResult[] = [];

  for (const entry of index.entries) {
    let score = 0;
    let hasTitleOrTagMatch = false;
    const entryTokens = new Set(entry.tokens);

    for (const qt of queryTokens) {
      if (entryTokens.has(`title:${qt}`)) {
        score += 3;
        hasTitleOrTagMatch = true;
      }
      if (entryTokens.has(`tag:${qt}`)) {
        score += 2;
        hasTitleOrTagMatch = true;
      }
      if (entryTokens.has(qt)) {
        score += 1;
      }
    }

    // Require at least one title or tag match to filter out body-only noise
    if (score > 0 && hasTitleOrTagMatch) {
      // Vote bonus: +0.5 per vote, max 5 points
      score += Math.min(entry.votes * 0.5, 5);
      results.push({ entry, score });
    }
  }

  // Sort by score descending, then by date descending for ties
  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.entry.date || '').localeCompare(a.entry.date || '');
  });

  return results.slice(0, limit);
}
