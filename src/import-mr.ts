import matter from 'gray-matter';
import { z } from 'zod';

import { fetchGitHubPR } from './providers/github/mr-fetch.js';
import { fetchGitLabMR } from './providers/gitlab/mr-fetch.js';
import { fetchTGitMR } from './providers/tgit/mr-fetch.js';
import type { MRData, MRFetchOptions, MRThread } from './types.js';
import { log } from './utils/logger.js';

/**
 * Auto-detects the provider from the URL and fetches MR data.
 *
 * @param url   Full URL of the MR / PR
 * @param opts  What to read besides the MR, its commits and its diff
 * @returns     Normalized MRData object
 * @throws      Error when the URL does not belong to a known provider
 */
export async function fetchMR(url: string, opts: MRFetchOptions): Promise<MRData> {
  if (url.includes('github.com')) {
    return fetchGitHubPR(url, opts);
  }

  if (url.includes('git.woa.com')) {
    return fetchTGitMR(url, opts);
  }

  // GitLab (incl. self-hosted): the `/-/merge_requests/` route is unique to
  // GitLab, so it identifies the platform on any host.
  if (/\/-\/merge_requests\/\d+/.test(url)) {
    return fetchGitLabMR(url, opts);
  }

  throw new Error(`Unsupported MR URL: ${url}. Only GitHub, TGit and GitLab are supported`);
}

/** Characters of the prompt the review threads may take (#1187). */
const THREADS_BUDGET = 6000;

/** Characters one thread may take before it is shortened to its first and last notes. */
const THREAD_MAX = 1500;

/** Characters one note may take. */
const NOTE_MAX = 500;

function clip(text: string, max: number): string {
  const trimmed = text.trim();

  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

/**
 * Renders the review threads for the extraction prompt (#1187).
 *
 * Threads with a reply come first and single unanswered remarks last, so a
 * budget cut drops the remarks. Each thread names the file and line it is
 * anchored to and whether it is resolved, then its notes in order, each marked
 * as the MR author's or a reviewer's. A thread over {@link THREAD_MAX} keeps
 * its first and last notes; once the budget is reached the rest of the
 * threads are counted, not cut off mid-thread.
 *
 * @param threads   The MR's review threads
 * @param mrAuthor  The MR author's username, to mark their notes
 * @param budget    Characters the section may take
 */
export function formatMrThreads(threads: MRThread[], mrAuthor: string | undefined, budget = THREADS_BUDGET): string {
  const ordered = [...threads.filter((t) => t.notes.length > 1), ...threads.filter((t) => t.notes.length <= 1)];
  const sections: string[] = [];
  let used = 0;

  for (const [index, thread] of ordered.entries()) {
    const anchor = thread.file ? ` — ${thread.file}${thread.line !== undefined ? `:${thread.line}` : ''}` : '';
    const state = thread.resolved === undefined ? '' : thread.resolved ? ' (resolved)' : ' (unresolved)';
    const header = `### Thread ${index + 1}${anchor}${state}`;

    const line = (note: MRThread['notes'][number]): string => {
      const role = note.author !== undefined && note.author === mrAuthor ? 'author' : 'reviewer';
      const who = note.author ? `${role} ${note.author}` : role;

      return `- [${who}] ${clip(note.body, NOTE_MAX).replace(/\n+/g, '\n  ')}`;
    };

    let lines = thread.notes.map(line);

    if (lines.join('\n').length > THREAD_MAX && thread.notes.length > 2) {
      lines = [lines[0], `- (${thread.notes.length - 2} notes omitted)`, lines[lines.length - 1]];
    }

    const section = `${header}\n${lines.join('\n')}`;

    if (used + section.length + 2 > budget) {
      const left = ordered.length - index;
      sections.push(`(${left} more thread${left === 1 ? '' : 's'} omitted)`);
      break;
    }

    sections.push(section);
    used += section.length + 2;
  }

  return sections.join('\n\n');
}

/**
 * Parses the AI-generated learning draft, tolerating malformed frontmatter.
 *
 * The LLM output may wrap content in markdown code fences, prepend
 * conversational text, or contain markdown (e.g. '*italic*' lines) that
 * gray-matter/js-yaml would misread as YAML. This normalizes the content and
 * parses it defensively so a parse failure never crashes the caller.
 *
 * @param raw  Raw string returned by the AI
 * @returns    Normalized content plus parsed frontmatter data (empty object on parse failure)
 */
/** The frontmatter fields a learning draft is read for; one of the wrong type reads as absent, and other keys pass through. */
const DraftFrontmatterSchema = z.looseObject({
  title: z.string().optional().catch(undefined),
  tags: z.array(z.string().optional().catch(undefined)).optional().catch(undefined),
});

/** A learning draft's normalized content and its frontmatter. */
interface ParsedLearningDraft {
  content: string;
  data: z.infer<typeof DraftFrontmatterSchema>;
}

export function parseLearningDraft(raw: string): ParsedLearningDraft {
  let content = raw
    .replace(/^```(?:markdown|md|yaml)?\s*\n/m, '')
    .replace(/\n```\s*$/, '');

  // AI may emit conversational text before the frontmatter; start at the first `---`
  const frontmatterStart = content.indexOf('---');

  if (frontmatterStart > 0) {
    content = content.slice(frontmatterStart);
  }

  try {
    const parsed = matter(content);

    return { content, data: DraftFrontmatterSchema.safeParse(parsed.data).data ?? {} };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`⚠️  Failed to parse learning frontmatter, using fallback: ${message}`);

    return { content, data: {} };
  }
}

/**
 * Infers the repo URL from an MR URL.
 *
 * @param mrUrl  Full MR / PR URL
 * @returns      Inferred repo .git URL
 */
export function extractRepoUrlFromMrUrl(mrUrl: string): string {
  // GitHub: https://github.com/owner/repo/pull/123 → https://github.com/owner/repo.git
  const ghMatch = mrUrl.match(/^(https:\/\/github\.com\/[^/]+\/[^/]+)\/pull\//);

  if (ghMatch) return `${ghMatch[1]}.git`;
  // TGit: https://git.woa.com/group[/subgroup]/repo/merge_requests/123
  const tgitMatch = mrUrl.match(/^(https:\/\/git\.woa\.com\/.+\/[^/]+)\/merge_requests\//);

  if (tgitMatch) return `${tgitMatch[1]}.git`;
  // GitLab: https://<host>/group[/subgroup]/repo/-/merge_requests/123
  const gitlabMatch = mrUrl.match(/^(https?:\/\/.+?\/.+\/[^/]+)\/-\/merge_requests\//);

  if (gitlabMatch) return `${gitlabMatch[1]}.git`;

  // Cannot reliably extract; return empty string so caller skips incremental update
  return '';
}
