/**
 * Error signature extraction and matching utilities.
 *
 * Provides a precise-match bypass for recall: error strings are normalised into
 * stable signatures so that the same failure reported with different concrete
 * values (addresses, sizes, line numbers) collapses to one signature.
 *
 * This index is intentionally kept completely separate from the BM25 token
 * corpus so it never feeds df/IDF calculations.
 */

/**
 * Maximum number of distinct signatures kept per document.
 * Prevents a log-dump document from flooding the index with low-quality entries.
 */
const EXTRACT_LIMIT = 8;

/** Maximum character length of a normalised signature before truncation. */
const MAX_SIGNATURE_LENGTH = 200;

/**
 * Regex that recognises conventional exception/warning lines.
 *
 * Matches `SomethingError: message`, `RuntimeException: message`, etc.
 * Requires the class name to start with an uppercase letter so mid-prose
 * occurrences like `parseError` are not captured. The message part is
 * captured (5–200 chars) to avoid empty or pathologically long lines.
 * Note: MAX_SIGNATURE_LENGTH truncation is applied after normalisation,
 * so the effective upper limit may differ from the 200 in this regex.
 * Warning is included because it often appears in stack traces that share
 * root cause with an Error line.
 */
const ERROR_LINE_RE = /\b([A-Z]\w*(?:Error|Exception|Warning))\s*:\s*(.{5,200})/g;

/**
 * Normalise an error string into a stable signature.
 *
 * Replaces volatile parts — hex literals, hashes, paths, versions, numbers —
 * with placeholders so that the same failure reported with different concrete
 * values collapses to one signature. Quoted identifiers are deliberately kept:
 * `KeyError: 'glm_moe_dsa'` and `KeyError: 'glm_moe_v2'` are distinct root
 * causes and must not merge.
 *
 * Normalisation order (matters):
 *  1. Hex literals (0x…)          → <HEX>
 *  2. Hex hashes (7–40 hex chars containing at least one letter) → <HASH>
 *  3a. URLs (http/https scheme)                                   → <URL>
 *  3b. Paths (≥ 3 slash-separated segments, boundary-anchored)   → <PATH>
 *  4. Version strings (N.N.N…)                                   → <VER>
 *  5. Numbers (integers and simple decimals)                     → <N>
 *  6. Collapse whitespace, lowercase
 *
 * @param raw Raw error line.
 * @returns Lowercased signature, or empty string when raw has no usable content.
 */
export function normalizeErrorSignature(raw: string): string {
  if (!raw || !raw.trim()) return '';

  let s = raw;

  // 1. Hex literals: 0x[0-9a-fA-F]+
  s = s.replace(/0x[0-9a-fA-F]+/g, '<HEX>');

  // 2. Commit hashes / long hex strings: must be 7–40 hex chars AND contain
  //    at least one letter (a–f). Two-step to keep the regex readable:
  //    first find candidate tokens, then discard pure-decimal strings.
  s = s.replace(/\b[0-9a-fA-F]{7,40}\b/g, (candidate) => {
    // Require at least one letter — pure decimal numbers go to rule 5 (<N>).
    return /[a-fA-F]/.test(candidate) ? '<HASH>' : candidate;
  });

  // 3a. URLs: replace entire URL before path rule so scheme residue is not left behind.
  s = s.replace(/https?:\/\/\S+/g, '<URL>');

  // 3b. Paths: three or more slash-separated segments, anchored to a word
  //     boundary / whitespace / punctuation so we don't slice a token in half
  //     (e.g. "a/b" in "ratio a/b" is NOT a path). An optional leading segment
  //     lets relative paths match too — `csrc/apis/../jit/handle.hpp` is a path
  //     even though it does not begin with a slash.
  //     Uses capture-and-preserve for the leading boundary character rather
  //     than lookbehind, so it works on all Node LTS versions.
  s = s.replace(
    /(^|[\s(['"=,:])([\w.\-+]*(?:\/[\w.\-+]+){3,})/g,
    (_, pre: string) => pre + '<PATH>',
  );

  // 4. Version strings: must come before plain number rule to avoid
  //    "12.9.1" becoming "<N>.<N>.<N>".
  s = s.replace(/\b\d+\.\d+\.\d+\S*/g, '<VER>');

  // 5. Numbers (integers and simple decimals).
  s = s.replace(/\b\d+(?:\.\d+)?\b/g, '<N>');

  // 6. Normalise whitespace and lowercase.
  s = s.replace(/\s+/g, ' ').trim().toLowerCase();

  return s.slice(0, MAX_SIGNATURE_LENGTH);
}

/**
 * Extract candidate error lines from markdown body text.
 *
 * Recognises conventional `SomeError: message` forms for common exception
 * suffixes. Only the first EXTRACT_LIMIT distinct signatures are kept per
 * document, so a log dump cannot flood the index.
 *
 * @param body Document body (markdown).
 * @returns Distinct normalised signatures, in first-seen order.
 */
export function extractErrorSignatures(body: string): string[] {
  if (!body) return [];

  const seen = new Set<string>();
  const results: string[] = [];

  // Reset lastIndex before iterating (global regex is stateful).
  ERROR_LINE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = ERROR_LINE_RE.exec(body)) !== null) {
    // Re-construct the full matched text so the normaliser handles the whole line.
    const fullMatch = match[0];
    const sig = normalizeErrorSignature(fullMatch);
    if (sig && !seen.has(sig)) {
      seen.add(sig);
      results.push(sig);
      if (results.length >= EXTRACT_LIMIT) break;
    }
  }

  return results;
}

/**
 * Look up documents whose recorded signatures match those found in a query.
 *
 * Returns entries in index order; an empty result means no exact match and the
 * caller should fall back to scoring-based search.
 *
 * @param query Raw user query, possibly containing a pasted error.
 * @param sigIndex Signature → filenames map from the search index.
 * @returns Matching filenames, deduplicated.
 */
export function matchErrorSignatures(
  query: string,
  sigIndex: Record<string, string[]>,
): string[] {
  if (!query || Object.keys(sigIndex).length === 0) return [];

  const querySigs = extractErrorSignatures(query);
  if (querySigs.length === 0) return [];

  const seen = new Set<string>();
  const results: string[] = [];

  for (const sig of querySigs) {
    const files = sigIndex[sig];
    if (!files) continue;
    for (const f of files) {
      if (!seen.has(f)) {
        seen.add(f);
        results.push(f);
      }
    }
  }

  return results;
}
