/**
 * The Markdown link parser, shared between `teamai review --branch` (which
 * warns about links that leave a skill) and asset relations (#1552), where a
 * local link from a rule, doc or learning to another team asset becomes a
 * `REFERENCES` relation. There is deliberately only one parser, so the two
 * readers never disagree about what a link is.
 *
 * Moved verbatim from review-branch.ts.
 */

function byKey<K, V>(map: Map<K, V[]>, key: K): V[] {
  const existing = map.get(key);
  if (existing) return existing;
  const created: V[] = [];
  map.set(key, created);
  return created;
}

/** The inside of `[text]` with up to `depth` levels of brackets, as Markdown link text allows. */
function bracketContent(depth: number): string {
  const nested = depth === 0 ? '' : String.raw`|\[${bracketContent(depth - 1)}\]`;
  return String.raw`(?:[^\[\]\\]|\\.${nested})*`;
}
// A bracket escaped by an odd run of backslashes is literal text, not a link.
// The check follows the bracket so it only runs where a bracket is.
const UNESCAPED_OPEN_BRACKET = String.raw`\[(?<=(?:^|[^\\])(?:\\\\)*\[)`;
const LINK_DESTINATION = String.raw`(<[^<>\n]*>|(?:[^\s()\\]|\\.|\((?:[^\s()\\]|\\.)*\))+)`;
const LINK_TITLE = String.raw`(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^()\\]|\\.)*\))`;
/** Inline links and images `[text](target "title")`, and reference definitions `[id]: target`. */
const INLINE_LINK = new RegExp(String.raw`${UNESCAPED_OPEN_BRACKET}${bracketContent(3)}\]\(\s*${LINK_DESTINATION}(?:\s+${LINK_TITLE})?\s*\)`, 'g');
const REFERENCE_DEFINITION = new RegExp(
  String.raw`^[ \t]*\[(?!\^)(?:[^\[\]\\]|\\.)+\]:[ \t]*${LINK_DESTINATION}(?:[ \t]+${LINK_TITLE})?[ \t]*$`,
  'gm',
);
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
const LIST_MARKER = /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+/;
/** A line that starts a block of its own, so a code span cannot continue into it; a blockquote starts one only after a line outside it. */
const BLOCK_START = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$))/;
const BLOCKQUOTE = /^ {0,3}>/;

/** The indentation of a line in columns, a tab counting as four. */
function indentOf(line: string): number {
  let columns = 0;
  for (const char of /^[ \t]*/.exec(line)?.[0] ?? '') columns += char === '\t' ? 4 - (columns % 4) : 1;
  return columns;
}

/**
 * Markdown with fenced and indented code blocks, inline code and HTML comments
 * blanked, so links shown as code are not read as links. Inside a list item an
 * indented line continues the item unless it is indented four columns past the
 * item's content, and a fence may sit at the item's indentation.
 */
function withoutCode(markdown: string): string {
  let fence: string | null = null;
  let previousBlank = true;
  let inCode = false;
  let inList = false;
  // Where the current list item's content starts, and that of the item holding the open fence.
  let listIndent = 0;
  let fenceListIndent: number | null = null;
  let previousQuoted = false;
  let inCommentBlock = false;
  const blocks: string[][] = [[]];
  const startBlock = (): void => {
    if ((blocks[blocks.length - 1] ?? []).length > 0) blocks.push([]);
  };
  const keep = (line: string): void => {
    blocks[blocks.length - 1]?.push(line);
  };
  for (const line of markdown.split(/\r?\n/)) {
    // A line that starts with `<!--` opens an HTML block that runs to its `-->`;
    // what it holds, a fence included, is comment text the final pass removes.
    if (fence === null && (inCommentBlock || /^ {0,3}<!--/.test(line))) {
      inCommentBlock = !line.includes('-->', inCommentBlock ? 0 : line.indexOf('<!--') + 4);
      keep(line);
      continue;
    }
    if (fence !== null) {
      // A fence inside a list item also ends where a line outdents past the item.
      if (fenceListIndent !== null && line.trim() !== '' && indentOf(line) < fenceListIndent) {
        fence = null;
        inList = false;
      } else {
        const closing = (inList ? /^\s*(`{3,}|~{3,})[ \t]*$/ : /^ {0,3}(`{3,}|~{3,})[ \t]*$/).exec(line)?.[1];
        if (closing?.[0] === fence[0] && closing.length >= fence.length) fence = null;
        continue;
      }
    }
    const isListItem = LIST_ITEM.test(line);
    if (isListItem) listIndent = LIST_MARKER.exec(line)?.[0].length ?? line.trimEnd().length + 1;
    const fenceLine = isListItem ? line.replace(LIST_MARKER, '') : line;
    const fenceMarker = (inList || isListItem ? /^\s*(`{3,}|~{3,})/ : /^ {0,3}(`{3,}|~{3,})/).exec(fenceLine)?.[1];
    if (fenceMarker) {
      fence = fenceMarker;
      if (isListItem) inList = true;
      fenceListIndent = inList ? listIndent : null;
      startBlock();
      previousBlank = false;
      continue;
    }
    const isBlank = line.trim() === '';
    if (isBlank) {
      startBlock();
      previousQuoted = false;
    } else {
      if (isListItem) inList = true;
      else if (previousBlank && !/^\s/.test(line)) inList = false;
      // Indented code starts four columns past the content of the list item it sits in.
      if (!isListItem && (inCode || previousBlank) && indentOf(line) >= (inList ? listIndent : 0) + 4) {
        inCode = true;
        previousBlank = false;
        continue;
      }
      inCode = false;
      const isQuoted = BLOCKQUOTE.test(line);
      // Inside a blockquote, a blank quoted line or a quoted heading or list item starts a block too.
      const quoted = isQuoted ? line.replace(/^(?: {0,3}> ?)+/, '') : line;
      if (BLOCK_START.test(quoted) || quoted.trim() === '' || (isQuoted && !previousQuoted)) startBlock();
      previousQuoted = isQuoted;
      keep(line);
      if (/^ {0,3}#{1,6}(?:[ \t]|$)/.test(line)) startBlock();
    }
    previousBlank = isBlank;
  }
  return withoutSpansAndComments(blocks.map((block) => block.join('\n')).join('\n\n'));
}

/**
 * `text` without code spans and HTML comments, read left to right as Markdown
 * does, so `<!--` shown as code opens no comment and a backtick inside a comment
 * opens no code span. A code span ends within its block (blocks are joined by a
 * blank line); a comment runs to its `-->`, or to the end when it never closes.
 */
function withoutSpansAndComments(text: string): string {
  // Backtick runs by length, each list in text order; the scan only moves forward,
  // so one pointer per length finds every closing run in linear time.
  const runsByLength = new Map<number, number[]>();
  for (const run of text.matchAll(/`+/g)) byKey(runsByLength, run[0].length).push(run.index);
  const nextRun = new Map<number, number>();
  const closingRun = (length: number, from: number, before: number): number => {
    const starts = runsByLength.get(length) ?? [];
    let next = nextRun.get(length) ?? 0;
    while ((starts[next] ?? Infinity) < from) next++;
    nextRun.set(length, next);
    const start = starts[next] ?? Infinity;
    return start < before ? start : -1;
  };

  const opener = /`+|<!--/g;
  let kept = '';
  let at = 0;
  let blockEnd = -1;
  for (let match = opener.exec(text); match !== null; match = opener.exec(text)) {
    // A backslash escapes the first backtick of a run; the rest may still open a span.
    let escapedBackslashes = 0;
    while (text.charAt(match.index - 1 - escapedBackslashes) === '\\') escapedBackslashes++;
    const escaped = match[0] !== '<!--' && escapedBackslashes % 2 === 1;
    if (match[0] === '<!--') {
      const close = text.indexOf('-->', match.index + 4);
      kept += text.slice(at, match.index);
      at = close < 0 ? text.length : close + 3;
    } else {
      if (match.index > blockEnd) {
        blockEnd = text.indexOf('\n\n', match.index);
        if (blockEnd < 0) blockEnd = text.length;
      }
      const start = match.index + (escaped ? 1 : 0);
      const run = match[0].length - (escaped ? 1 : 0);
      const close = run === 0 ? -1 : closingRun(run, start + run, blockEnd);
      if (close < 0) continue;
      kept += text.slice(at, start);
      at = close + run;
    }
    opener.lastIndex = at;
  }
  return kept + text.slice(at);
}

const NAMED_CHARACTER_REFERENCES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

/** `text` with numeric character references and the common named ones (`&amp;`, `&lt;`, …) decoded, as Markdown reads a destination. */
function decodeCharacterReferences(text: string): string {
  return text.replace(/&(?:#(\d{1,7})|#[xX]([\da-fA-F]{1,6})|([a-zA-Z]+));/g, (reference, decimal?: string, hex?: string, name?: string) => {
    const codePoint = decimal !== undefined ? Number(decimal) : hex !== undefined ? Number.parseInt(hex, 16) : undefined;
    if (codePoint !== undefined) return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '\ufffd';
    return (name !== undefined ? NAMED_CHARACTER_REFERENCES[name] : undefined) ?? reference;
  });
}

/** The local link targets of a Markdown file, without `#anchor` or `?query`; links with a scheme or a leading `/` are left out. */
export function localLinkTargets(markdown: string): string[] {
  const text = withoutCode(markdown);
  const targets = new Set<string>();
  for (const match of [...text.matchAll(INLINE_LINK), ...text.matchAll(REFERENCE_DEFINITION)]) {
    const written = decodeCharacterReferences((match[1] ?? '').replace(/^<(.*)>$/, '$1').replace(/\\([!-/:-@[-`{-~])/g, '$1'));
    if (/^[a-z][a-z0-9+.-]*:/i.test(written) || written.startsWith('/')) continue;
    const target = written.replace(/[#?].*$/, '');
    if (target === '') continue;
    try {
      targets.add(decodeURIComponent(target));
    } catch {
      targets.add(target);
    }
  }
  return [...targets];
}
