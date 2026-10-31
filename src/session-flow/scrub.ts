/**
 * scrub.ts -- redact a session before migration.
 *
 * `session migrate --scrub` passes the whole IR through `utils/redact`:
 * text, thinking, tool-call arguments and tool results are all covered.
 * Secret-shaped values -- and values matching secrets found in the current
 * environment -- are replaced with `<REDACTED:...>` placeholders.
 *
 * Why this lives in the migration path: the target of a migration is another
 * agent's local store, whose content may later be archived into a
 * team-readable repo via `session push`. Redacting at migration time keeps
 * sensitive values from travelling with the session.
 *
 * `utils/redact` is reused (the same engine `session save` uses) so the rules
 * stay consistent instead of forking a second set of patterns.
 *
 * Note: redact() is best-effort (pattern matching, not a guarantee). Review
 * the result before archiving; this matches the caveat on `session save`.
 */

import type { Session, Message, ContentBlock, MessageMetadata } from './ir.js';
import { collectEnvSecrets, redact, redactJson } from '../utils/redact.js';
import { imagePlaceholderText } from './ir.js';
import { maskCutSecret } from './title.js';

export interface ScrubResult {
  session: Session;
  /** Number of replaced secret-looking values (counted per replacement). */
  redactedCount: number;
}

const REDACTED_MARKER = '<REDACTED:';

/**
 * This machine's directories a session published to the team archive must not name, each in every spelling it may
 * appear in (as typed, resolved). `repo` is the root the archived `cwd` is relative to, `tmp` the per-user temp roots.
 */
export interface LocalPathRoots {
  repo: readonly string[];
  home: readonly string[];
  tmp: readonly string[];
  /**
   * The directory the session ran in, as written through a link that places it elsewhere than under a spelling of
   * `repo` (`/opt/api` → `/srv/app/packages/api`), and its archived `cwd` (`packages/api`). A session outside any
   * repository archives `cwd` as `""`, and its directory is rewritten to `<cwd>`.
   */
  workdir?: { spellings: readonly string[]; archived: string };
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A directory below a filesystem root: `/`, `C:\` and the like would rewrite every path. */
const isBelowFilesystemRoot = (dir: string): boolean => !/^(?:[A-Za-z]:)?[\\/]*$/.test(dir);

/** A character of a file or directory name: a root never runs into one after it. */
const NAME_CHAR = '[\\p{L}\\p{N}_@%+~#$-]';

/** Before a root only an ASCII name character counts: Chinese or Japanese prose runs straight into a path (`看一下/Users/…`). */
const ASCII_NAME_CHAR = '[A-Za-z0-9_@%+~#$-]';

/**
 * A root matches only as whole path segments: `/Users/alice/app` is not in `/Users/alice/app2`, `/Users/alice/app@2`,
 * `/Users/alice/app.old` or `/mnt/Users/alice/app`, but is in `ls /Users/alice/app.`, Markdown emphasis around it,
 * `--cwd=/Users/alice/app`, `file:///Users/alice/app` and `看一下/Users/alice/app`. `_` and `__` next to it are
 * Markdown emphasis when no other name character is beyond them.
 */
const SEGMENT_START = `(?:(?<!${ASCII_NAME_CHAR})|(?<=(?:^|(?!${ASCII_NAME_CHAR}).)__?))`;
const SEGMENT_END = `(?:(?!${NAME_CHAR}|\\.${NAME_CHAR})|(?=__?(?!${NAME_CHAR}|\\.${NAME_CHAR})))`;

/** The directory name Claude Code encodes a path as (`/Users/alice/app` → `-Users-alice-app`). */
const encodedDir = (dir: string): string => dir.replace(/[^a-zA-Z0-9]/g, '-');

/**
 * Each spelling `root` may appear in, and whether it is matched ignoring case. A POSIX root as written and as a file URL
 * percent-encodes it (`/Users/José` → `/Users/Jos%C3%A9`). A Windows root, whose paths are case-insensitive, also with
 * forward slashes, escaped in JSON a tool returned (`C:\\Users`), as Git Bash prints it (`/c/Users`) and percent-encoded.
 */
function spellingsOf(root: string): Array<{ spelling: string; ignoresCase: boolean }> {
  const trimmed = root.replace(/[\\/]+$/, '');
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(trimmed);
  if (!drive) return [...new Set([trimmed, encodeURI(trimmed)])].map((spelling) => ({ spelling, ignoresCase: false }));
  const forward = trimmed.replaceAll('\\', '/');
  const rest = drive[2].replaceAll('\\', '/');
  return [...new Set([trimmed, forward, trimmed.replaceAll('\\', '\\\\'), `/${drive[1]}/${rest}`, encodeURI(forward)])].map((spelling) => ({ spelling, ignoresCase: true }));
}

/**
 * Rewrites the paths under `roots` in a text: the repository to `<repo>`, the temp roots to `<tmp>`, the rest of the
 * home directory to `~`, the longest root first. The directory name a tool encodes the workspace as
 * (`-Users-alice-app`) becomes `<project>`, and another one under the home directory starts with `~`
 * (`~-other-project`). `title` also rewrites a path the title was cut inside at its end (`… and /Users/alice/ap`), as
 * the shortest root it starts.
 */
function pathRewriter({ repo, home, tmp, workdir }: LocalPathRoots, cwd: string): { text: (text: string) => string; title: (title: string) => string } {
  const workdirName = workdir && (workdir.archived === '' ? '<cwd>' : workdir.archived === '.' ? '<repo>' : `<repo>/${workdir.archived}`);
  // Keyed as matched: a spelling matched ignoring case by its lower case.
  const named = new Map<string, string>();
  const ignoringCase = new Set<string>();
  for (const [roots, name] of [[home, '~'], [tmp, '<tmp>'], [repo, '<repo>'], ...(workdir && workdirName ? [[workdir.spellings, workdirName] as const] : [])] as const) {
    for (const { spelling, ignoresCase } of roots.flatMap(spellingsOf)) {
      if (!isBelowFilesystemRoot(spelling)) continue;
      const key = ignoresCase ? spelling.toLowerCase() : spelling;
      named.set(key, name);
      if (ignoresCase) ignoringCase.add(key);
    }
  }
  if (named.size === 0) return { text: (text) => text, title: (title) => title };
  const byLength = (left: string, right: string): number => right.length - left.length;
  const roots = [...named.keys()].sort(byLength);
  const matcher = (some: string[], flags: string): RegExp | undefined =>
    some.length > 0 ? new RegExp(`${SEGMENT_START}(?:${some.map(escapeRegExp).join('|')})${SEGMENT_END}`, flags) : undefined;
  const rooted = [matcher(roots.filter((root) => ignoringCase.has(root)), 'giu'), matcher(roots.filter((root) => !ignoringCase.has(root)), 'gu')];
  const nameOf = (root: string): string | undefined => named.get(root) ?? named.get(root.toLowerCase());
  const encoded = (dirs: readonly string[]): string[] => [...new Set(dirs.filter((dir) => isBelowFilesystemRoot(dir) && /^(?:\/|[A-Za-z]:[\\/])/.test(dir)).map(encodedDir))].sort(byLength);
  const slug = (dirs: string[], after: string): RegExp | undefined =>
    dirs.length > 0 ? new RegExp(`(?<=[\\\\/])(?:${dirs.map(escapeRegExp).join('|')})(?=${after})`, 'g') : undefined;
  const project = slug(encoded([cwd, ...repo]), '$|[\\\\/]');
  const homeSlug = slug(encoded(home), '$|[\\\\/-]');
  const text = (value: string): string => {
    const next = rooted.reduce((current, pattern) => (pattern ? current.replace(pattern, (root) => nameOf(root) ?? root) : current), value);
    const projected = project ? next.replace(project, '<project>') : next;
    return homeSlug ? projected.replace(homeSlug, '~') : projected;
  };
  const title = (value: string): string => {
    const cut = /(?:[A-Za-z]:)?[\\/][^\s<]{2,}$/.exec(value);
    if (!cut || nameOf(cut[0]) !== undefined) return text(value);
    const starts = (candidate: string): boolean => candidate.startsWith(ignoringCase.has(candidate) ? cut[0].toLowerCase() : cut[0]);
    const root = roots.findLast((candidate) => candidate.length > cut[0].length && starts(candidate));
    return root ? text(value.slice(0, cut.index)) + (named.get(root) ?? '') : text(value);
  };
  return { text, title };
}

/** `metadata` with `rewrite` applied to its string values, or `metadata` itself when that changes none. */
function rewriteMetadata(metadata: MessageMetadata, rewrite: (text: string) => string): MessageMetadata {
  const changed = Object.entries(metadata).flatMap(([key, value]) => (typeof value === 'string' && rewrite(value) !== value ? [[key, rewrite(value)]] : []));
  return changed.length === 0 ? metadata : { ...metadata, ...Object.fromEntries(changed) };
}

/** `value` with `rewrite` applied to each string it holds, keys left as they are. */
function mapStrings(value: unknown, rewrite: (text: string) => string): unknown {
  if (typeof value === 'string') return rewrite(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, rewrite));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, rewrite)]));
  return value;
}

/** Count how many replacements happened between before/after strings. */
function countRedactions(before: string, after: string): number {
  if (before === after) return 0;
  let count = 0;
  let idx = after.indexOf(REDACTED_MARKER);
  while (idx >= 0) {
    count++;
    idx = after.indexOf(REDACTED_MARKER, idx + REDACTED_MARKER.length);
  }
  return count;
}

function scrubBlock(
  block: ContentBlock,
  { dropImagePaths, mask, rewrite, envSecrets }: { dropImagePaths: boolean; mask: (text: string) => string; rewrite: (text: string) => string; envSecrets: Record<string, string> },
): { block: ContentBlock; count: number } {
  switch (block.type) {
    case 'text': {
      const next = rewrite(mask(block.text));
      return {
        block: next === block.text ? block : { type: 'text', text: next },
        count: countRedactions(block.text, next),
      };
    }
    case 'thinking': {
      const next = rewrite(mask(block.text));
      return {
        block: next === block.text ? block : { ...block, text: next },
        count: countRedactions(block.text, next),
      };
    }
    case 'tool_call': {
      // Arguments are structured: serialize, redact as a whole, then parse
      // back so string fields are covered too, not just top-level strings.
      // Known secrets are masked in each string first: one with a quote or
      // backslash is escaped in the serialized form and would not match there. Paths are rewritten in each string for
      // the same reason: a Windows path is escaped once serialized.
      const raw = JSON.stringify(block.arguments ?? {});
      const next = mask(JSON.stringify(mapStrings(redactJson(block.arguments ?? {}, envSecrets), rewrite)));
      if (next === raw) return { block, count: 0 };
      const count = countRedactions(raw, next);
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(next) as Record<string, unknown>;
      } catch {
        // A placeholder that replaced a number or a key left no JSON to
        // parse: keep the masked text whole, never the original arguments.
        parsed = { redacted: next };
      }
      return { block: { ...block, arguments: parsed }, count };
    }
    case 'tool_result': {
      const next = rewrite(mask(block.content));
      return {
        block: next === block.content ? block : { ...block, content: next },
        count: countRedactions(block.content, next),
      };
    }
    case 'image': {
      // Image payloads do not participate in text redaction, but their
      // `filePath` is an absolute local path (`/Users/alice/...`) and lands in
      // the archive verbatim -- scrub has to drop it, otherwise redacting the
      // transcript still publishes the user's home directory layout.
      // A local -> local migration keeps it: the target can still read the
      // file, and dropping it would silently replace the image with a
      // placeholder on a machine that never leaves.
      if (!block.filePath || !dropImagePaths) return { block, count: 0 };
      if (block.data) {
        return { block: { type: 'image', mimeType: block.mimeType, data: block.data, label: block.label }, count: 1 };
      }
      // No inline data: keeping the block would mean keeping the path.
      return {
        block: { type: 'text', text: imagePlaceholderText(block) },
        count: 1,
      };
    }
  }
}

/** Whether `title` spells one of `roots` as the scrubber matches it (any spelling, a Windows root in any case, cut at the end). */
export function titleSpellsLocalPath(title: string, roots: LocalPathRoots, cwd: string): boolean {
  return pathRewriter(roots, cwd).title(title) !== title;
}

/**
 * Redact a session (pure function; the input is not mutated).
 *
 * The title is scrubbed too: the first prompt often carries a token, and the
 * title is what shows up in the target client's session list. A title cut
 * inside one of `secrets` is masked from where that secret starts.
 *
 * `dropImagePaths` (default true) removes the absolute local path of image
 * blocks -- required before archiving to a team repo, unwanted for a local
 * migration where the target can still read the file.
 *
 * `secrets` are values masked besides those the environment shows to be secret,
 * such as the team's declared secrets (`knownSecrets`), keyed by name.
 *
 * `localPaths`, given only when the session is published to the team archive, rewrites this machine's paths in the
 * title, text, thinking, tool call arguments, tool results and string message metadata. A read for scoring leaves
 * them out: it matches tool call paths against the files teamai delivered.
 */
export function scrubSession(
  session: Session,
  opts: { dropImagePaths?: boolean; secrets?: Record<string, string>; localPaths?: LocalPathRoots } = {},
): ScrubResult {
  const dropImagePaths = opts.dropImagePaths !== false;
  const envSecrets = { ...collectEnvSecrets(), ...opts.secrets };
  const mask = (text: string): string => redact(text, { envSecrets });
  const paths = opts.localPaths ? pathRewriter(opts.localPaths, session.cwd) : undefined;
  const rewrite = paths?.text ?? ((text: string): string => text);
  let redactedCount = 0;

  const messages: Message[] = session.messages.map((msg) => {
    let contentChanged = false;
    const content = msg.content.map((block) => {
      const { block: next, count } = scrubBlock(block, { dropImagePaths, mask, rewrite, envSecrets });
      redactedCount += count;
      if (next !== block) contentChanged = true;
      return next;
    });
    const metadata = msg.metadata && paths ? rewriteMetadata(msg.metadata, paths.text) : msg.metadata;
    return contentChanged || metadata !== msg.metadata ? { ...msg, content, ...(metadata ? { metadata } : {}) } : msg;
  });

  // Masking a whole value changes the title's length, so the cut is checked first.
  const masked = mask(maskCutSecret(session.title, opts.secrets ?? {}));
  const title = paths ? paths.title(masked) : masked;

  return {
    session: { ...session, title, messages },
    redactedCount,
  };
}
