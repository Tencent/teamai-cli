import fs from 'node:fs';
import path from 'node:path';
import fse from 'fs-extra';
import { execCommand, type ExecResult } from './utils/exec.js';
import { pathExists, readFileIfExists, readFileSafe, symlinkTarget, writeFileAtomic } from './utils/fs.js';
import { withoutGitRepositoryEnv } from './utils/git-env.js';

// ─── Git exclude blocks ──────────────────────────────────────
//
//  teamai keeps what it writes in a project out of git through marked blocks in
//  the repository's own `info/exclude`: local to the clone, shared by its
//  worktrees, never committed (#886, #915). Each block has one owner. This
//  module owns the files: where a path's line goes, how a line is spelled, the
//  shared lock, and the four operations owners use: `sync` (replace), `ensure`
//  (add-only gate before a write), `remove` and `report`.

/**
 * One writer of git exclude blocks. `name` is `mcp-exclude`, `credentials`,
 * `delivered`, `delivered/<partition id>`, `local-agent` or
 * `providers/http/<encoded name>` (`[a-z0-9/_%-]`, see encodeOwnerSegment).
 * `record` keeps the exclude files that hold the owner's block, so `remove`
 * and `report` find them again; `mcp-exclude` has none (it discovers its
 * files from the checkouts, as #886 does).
 */
export interface GitExcludeOwner {
  name: string;
  record?: GitExcludeFileRecord;
}

/** Where an owner's exclude files are recorded: the caller's state (partition state, `<stateHome>/git-exclude.json`). */
export interface GitExcludeFileRecord {
  files(): Promise<string[]>;
  /** `add` now hold the owner's block, `drop` no longer do. */
  update(change: { add: string[]; drop: string[] }): Promise<void>;
}

export const MCP_EXCLUDE_OWNER = 'mcp-exclude';
export const MCP_EXCLUDE_START = '# [teamai:mcp-exclude:start] project MCP configs holding resolved ${VAR} values';
export const MCP_EXCLUDE_END = '# [teamai:mcp-exclude:end]';

const OWNER = /^[a-z0-9/_%-]+$/;
const MARKER = /^# \[teamai:([a-z0-9/_%-]+):(start|end)\]/;

/**
 * `name` (a provider's, say) as part of an owner: bytes outside `[a-z0-9/_-]`
 * as `%` and two lowercase hex digits, `/` included, so a name never adds a level.
 */
export function encodeOwnerSegment(name: string): string {
  return [...Buffer.from(name, 'utf8')]
    .map((byte) => {
      const char = String.fromCharCode(byte);
      return /[a-z0-9_-]/.test(char) ? char : `%${byte.toString(16).padStart(2, '0')}`;
    })
    .join('');
}

/** The owner's markers; `mcp-exclude` keeps #886's, byte for byte. */
function markersOf(owner: string): { start: string; end: string } {
  if (!OWNER.test(owner)) throw new TypeError(`Invalid git exclude owner "${owner}": use [a-z0-9/_%-] (encodeOwnerSegment)`);
  if (owner === MCP_EXCLUDE_OWNER) return { start: MCP_EXCLUDE_START, end: MCP_EXCLUDE_END };
  return { start: `# [teamai:${owner}:start]`, end: `# [teamai:${owner}:end]` };
}

/** #886's owner keeps its rules: trimmed lines, an already-ignored path adds none, `\n` line ends. */
const isLegacy = (owner: string): boolean => owner === MCP_EXCLUDE_OWNER;

// ─── Parsing and rewriting an exclude file ────────────────────

/** A marker teamai cannot pair: a start with no end (`unclosed`), an end with no start, or a second block. */
export interface DamagedMarker {
  owner: string;
  line: number;
  problem: 'unclosed' | 'unopened' | 'duplicate';
}

type Segment =
  | { kind: 'text'; raw: string }
  | { kind: 'block'; owner: string; raw: string; lines: string[] };

interface ParsedExclude {
  segments: Segment[];
  damaged: DamagedMarker[];
}

/** One line's value: the owner's parsing (only `\r` stripped; `mcp-exclude` trims). */
function lineValue(raw: string, owner: string): string {
  const body = raw.replace(/\n$/, '');
  return isLegacy(owner) ? body.trim() : body.replace(/\r$/, '');
}

/**
 * Split an exclude file into the member's text, kept byte for byte, and
 * teamai's blocks, found by the `# [teamai:` prefix. A start without its end
 * leaves its lines to the member: only lines between a start and its end are
 * ever teamai's to rewrite.
 */
function parseExclude(content: string): ParsedExclude {
  const segments: Segment[] = [];
  const damaged: DamagedMarker[] = [];
  const raws = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let open: { owner: string; line: number; raws: string[] } | null = null;
  const text = (raw: string): void => {
    const last = segments[segments.length - 1];
    if (last?.kind === 'text') last.raw += raw;
    else segments.push({ kind: 'text', raw });
  };
  const orphan = (): void => {
    if (!open) return;
    damaged.push({ owner: open.owner, line: open.line, problem: 'unclosed' });
    for (const raw of open.raws) text(raw);
    open = null;
  };
  raws.forEach((raw, i) => {
    const marker = MARKER.exec(raw.trim());
    if (marker?.[2] === 'start') {
      orphan();
      open = { owner: marker[1], line: i + 1, raws: [raw] };
    } else if (marker && open?.owner === marker[1]) {
      const { owner } = open;
      const lines = [...open.raws.slice(1), raw].slice(0, -1).map((r) => lineValue(r, owner)).filter((l) => l !== '' && !l.startsWith('#'));
      segments.push({ kind: 'block', owner, raw: [...open.raws, raw].join(''), lines });
      open = null;
    } else {
      if (marker) damaged.push({ owner: marker[1], line: i + 1, problem: 'unopened' });
      if (open) open.raws.push(raw);
      else text(raw);
    }
  });
  orphan();
  const seen = new Set<string>();
  let line = 1;
  for (const segment of segments) {
    if (segment.kind === 'block') {
      if (seen.has(segment.owner)) damaged.push({ owner: segment.owner, line, problem: 'duplicate' });
      seen.add(segment.owner);
    }
    line += (segment.raw.match(/\n/g) ?? []).length;
  }
  damaged.sort((a, b) => a.line - b.line);
  return { segments, damaged };
}

/** Every line of `owner`'s blocks, duplicates merged, in order. */
function ownerLines(parsed: ParsedExclude, owner: string): string[] | null {
  const blocks = parsed.segments.filter((s): s is Extract<Segment, { kind: 'block' }> => s.kind === 'block' && s.owner === owner);
  return blocks.length === 0 ? null : [...new Set(blocks.flatMap((b) => b.lines))];
}

/**
 * `content` with `owner`'s block holding `lines` (none: no block), in place of
 * its first block; a duplicate goes. Everything outside teamai's markers stays
 * byte for byte. Null when nothing changes.
 */
export function withOwnerLines(content: string, owner: string, lines: string[]): string | null {
  const parsed = parseExclude(content);
  const { start, end } = markersOf(owner);
  const eol = isLegacy(owner) ? '\n' : /\r?\n/.exec(content)?.[0] ?? '\n';
  const block = lines.length > 0 ? [start, ...lines, end].map((l) => `${l}${eol}`).join('') : '';
  let placed = false;
  let next = '';
  for (const segment of parsed.segments) {
    if (segment.kind === 'block' && segment.owner === owner) {
      if (!placed) next += block;
      placed = true;
    } else {
      next += segment.raw;
    }
  }
  if (!placed && block) next += `${next === '' || next.endsWith('\n') ? '' : eol}${block}`;
  return next === content ? null : next;
}

// ─── Git ──────────────────────────────────────────────────────

/** Git, run where `cwd` is, never where a hook's exported GIT_DIR points (#915). */
function runGit(args: string[], cwd: string): Promise<ExecResult> {
  return execCommand('git', args, { cwd, timeoutMs: 10_000, env: withoutGitRepositoryEnv() })
    .catch((e: unknown) => ({ code: -1, stdout: '', stderr: e instanceof Error ? e.message : String(e) }));
}

/**
 * The `info/exclude` git reads for `dir`'s checkout (worktrees and submodules
 * included), the checkout's root, and `dir`'s path from it; or git's error.
 */
async function locateExclude(dir: string): Promise<{ excludeFile: string; root: string; prefix: string } | { error: string }> {
  const result = await runGit(['rev-parse', '--show-toplevel', '--show-prefix', '--git-path', 'info/exclude'], dir);
  const [root = '', prefix = '', gitPath = ''] = result.code === 0 ? result.stdout.split(/\r?\n/) : [];
  if (!root || !gitPath) return { error: result.stderr.trim() || `git exited with ${result.code}` };
  // Real path, so one repository reached through a symlink (macOS /var) is one file.
  const base = await fse.realpath(dir).catch(() => dir);
  return { excludeFile: path.resolve(base, gitPath), root, prefix };
}

/** {@link locateExclude}, or null when git cannot say. */
export async function gitExcludeFile(dir: string): Promise<{ excludeFile: string; root: string; prefix: string } | null> {
  const location = await locateExclude(dir);
  return 'error' in location ? null : location;
}

/** Whether `dir` is inside a repository: some directory at or above it holds `.git`. */
async function insideRepository(dir: string): Promise<boolean> {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (await pathExists(path.join(d, '.git'))) return true;
    if (path.dirname(d) === d) return false;
  }
}

/** The closest directory above `file` that exists. */
export async function existingAncestor(file: string): Promise<string> {
  let dir = path.dirname(path.resolve(file));
  while (!await pathExists(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  return dir;
}

/**
 * `file` with the real path of its closest existing directory, the rest
 * appended: the entry itself, a symlink at `file` not followed.
 */
async function realEntryPath(file: string): Promise<string> {
  const dir = await existingAncestor(file);
  // Native realpath: the on-disk spelling on a case-insensitive filesystem (#915).
  const real = await fs.promises.realpath(dir).catch(() => dir);
  return path.join(real, path.relative(dir, file));
}

/**
 * Where a write to `file` lands: the file a symlink at `file` points to (a
 * member's dotfiles link stays, and the write goes to its target), then the
 * real path of its closest existing directory, the rest appended. Every check
 * of whether git would commit the file judges this path, in the repository
 * holding it (#886), and reads keep `file`.
 */
export async function realFilePath(file: string): Promise<string> {
  // A link loop or an unreadable path: judged as the file itself, as the write would fail.
  return realEntryPath(await symlinkTarget(file).catch(() => file));
}

/**
 * Whether git would put a file in a commit. `unknown` is a repository git could
 * not answer for (unsafe ownership, a bad config): never read it as safe.
 */
export type GitTracking =
  | { kind: 'ignored' }
  | { kind: 'would-commit' }
  | { kind: 'outside-repo' }
  | { kind: 'unknown'; error: string };

/**
 * `file` as a message names it, and the path to give git for it: the one a
 * write lands in, named with `file`, when `file` is a symlink or a directory
 * inside its checkout is one (#886), where git refuses `file` ("beyond a
 * symbolic link"). A symlink above the checkout (macOS /var) changes no path git uses.
 */
export async function gitPathOf(file: string): Promise<{ label: string; path: string }> {
  const landed = await realFilePath(file);
  if (landed === file) return { label: file, path: file };
  const linked = await symlinkTarget(file).catch(() => file) !== file;
  const location = linked ? null : await gitExcludeFile(await existingAncestor(landed));
  const inCheckout = location ? path.relative(location.root, landed) : '';
  if (inCheckout && !inCheckout.startsWith('..') && file.endsWith(`${path.sep}${inCheckout}`)) return { label: file, path: file };
  return { label: `${landed} (where ${file} is written)`, path: landed };
}

/**
 * Whether git would put `file` in a commit: tracked, or untracked without an
 * ignore rule. Judged where a write to it lands. Read-only.
 */
export async function gitTracking(file: string): Promise<GitTracking> {
  file = await realFilePath(file);
  const dir = await existingAncestor(file);
  const result = await runGit(['check-ignore', '-q', '--', path.relative(dir, file)], dir);
  if (result.code === 0) return { kind: 'ignored' };
  if (result.code === 1) return { kind: 'would-commit' };
  // Anything else is no repository at all, or git failing inside one.
  if (await insideRepository(dir)) return { kind: 'unknown', error: result.stderr.trim() || `git exited with ${result.code}` };
  return { kind: 'outside-repo' };
}

/**
 * Whether git tracks `file` (#879): the next `git commit -a` commits a change to
 * it, and no exclude rule stops that. Read-only. `unknown` is git failing to
 * answer: never read it as untracked. Judged where a write to it lands; with
 * `at: 'entry'`, a symlink at `file` is judged itself, as a deletion removes the link.
 */
export async function gitTracks(
  file: string,
  at: 'landed' | 'entry' = 'landed',
): Promise<{ kind: 'tracked' } | { kind: 'untracked' } | { kind: 'unknown'; error: string }> {
  file = at === 'entry' ? await realEntryPath(file) : await realFilePath(file);
  // The file, or even its directory, may be gone from disk and still be in the index.
  const dir = await existingAncestor(file);
  const result = await runGit(['--literal-pathspecs', 'ls-files', '--error-unmatch', '--', path.relative(dir, file)], dir);
  if (result.code === 0) return { kind: 'tracked' };
  if (result.code === 1) return { kind: 'untracked' };
  return { kind: 'unknown', error: result.stderr.trim() || `git exited with ${result.code}` };
}

/**
 * Whether no commit can take `file`, so teamai may delete it: git says it does
 * not track it, or no repository holds it. A repository git cannot answer for
 * is neither.
 */
export async function gitUntracked(file: string, at: 'landed' | 'entry' = 'landed'): Promise<boolean> {
  const tracks = await gitTracks(file, at);
  if (tracks.kind !== 'unknown') return tracks.kind === 'untracked';
  return (await gitTracking(file)).kind === 'outside-repo';
}

/** A rule of the member's that re-includes a path, as `git check-ignore -v` names it. */
export interface ReincludingRule {
  source: string;
  line: string;
  pattern: string;
}

/**
 * Whether the rule `git check-ignore -v` says ignores `file` is the member's:
 * not a line inside one of teamai's `# [teamai:<owner>:…]` blocks. False when
 * git names no rule or its source cannot be read: the caller then lists the
 * path itself, the safe direction.
 */
async function ignoredByMembersRule(file: string): Promise<boolean> {
  const landed = await realFilePath(file);
  const dir = await existingAncestor(landed);
  const result = await runGit(['check-ignore', '-v', '--', path.relative(dir, landed)], dir);
  const match = result.code === 0 ? /^(.*):(\d+):(.*)\t/.exec(result.stdout) : null;
  if (!match) return false;
  // git names the source from the toplevel, whatever the cwd.
  const location = await locateExclude(dir);
  const source = 'error' in location ? path.resolve(dir, match[1]) : path.resolve(location.root, match[1]);
  const content = await readFileSafe(source);
  if (content === null) return false;
  let inBlock = false;
  for (const line of content.split('\n').slice(0, Number(match[2]) - 1)) {
    const marker = MARKER.exec(line.trim());
    if (marker) inBlock = marker[2] === 'start';
  }
  return !inBlock;
}

/** The negated rule `git check-ignore -v` says decides `file` in the checkout at `root`, or null when it names none. */
async function reincludingRule(file: string, root: string): Promise<ReincludingRule | null> {
  const dir = await existingAncestor(file);
  const result = await runGit(['check-ignore', '-v', '--', path.relative(dir, file)], dir);
  // <source>:<line>:<pattern><TAB><path>: git names the source from the toplevel, whatever the cwd.
  const match = result.code === 0 ? /^(.*):(\d+):(!.*)\t/.exec(result.stdout) : null;
  return match ? { source: path.resolve(root, match[1]), line: match[2], pattern: match[3] } : null;
}

// ─── Writing: the shared lock ─────────────────────────────────

/** How `updateFileLocked` left the file: `locked` wrote nothing, another command held it past the wait. */
export type ExcludeUpdate = 'written' | 'unchanged' | 'locked';

/**
 * `updateFileLocked` could not create `file`'s directory, which also holds its
 * lock: `blocker`, the closest existing path above `file`, is not a directory
 * (`notDirectory`), or denies the write.
 */
export class NotWritableError extends Error {
  constructor(readonly file: string, readonly blocker: string, readonly notDirectory: boolean) {
    super(`${file} is not writable, as ${blocker} is not${notDirectory ? ' a directory' : ''}`);
    this.name = 'NotWritableError';
  }
}

/**
 * `file` exists but could not be read. Never taken for an empty file: a
 * rewrite from empty would drop every line the member wrote there.
 */
export class NotReadableError extends Error {
  constructor(readonly file: string, readonly error: string) {
    super(`${file} cannot be read (${error})`);
    this.name = 'NotReadableError';
  }
}

/**
 * `file`'s content, or null when it does not exist (ENOENT, or ENOTDIR: a
 * parent is a file). Throws `NotReadableError` for any other read failure.
 */
async function readExisting(file: string): Promise<string | null> {
  try {
    return await readFileIfExists(file);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOTDIR') return null;
    throw new NotReadableError(file, code ?? (e instanceof Error ? e.message : String(e)));
  }
}

/**
 * Rewrite `file` with `edit` (null: leave it as it is), holding a lock
 * across the read and an atomic write: the worktrees of a repository share
 * `.git/info/exclude`, so two commands adding different paths must not drop each other's.
 * A lock still held after the wait writes nothing: an unlocked write could drop
 * the holder's pattern, leaving that path unprotected. `mode` forces the file's
 * mode; without it the file keeps its own. Throws `NotWritableError`, without
 * waiting, when the file's directory cannot be created, and `NotReadableError`,
 * writing nothing, when the file exists but cannot be read. A missing file is
 * created.
 */
export async function updateFileLocked(
  file: string,
  edit: (content: string) => string | null,
  options: { mode?: number } = {},
): Promise<ExcludeUpdate> {
  const { acquireLock, releaseLock } = await import('./update.js');
  const lockPath = `${file}.teamai-lock`;
  // acquireLock reads a lock directory it cannot create as a held lock; no wait would change that (#993).
  await fse.ensureDir(path.dirname(file)).catch(async (e: NodeJS.ErrnoException) => {
    if (!['EEXIST', 'ENOTDIR', 'EACCES', 'EPERM', 'EROFS'].includes(e.code ?? '')) throw e;
    throw new NotWritableError(file, await existingAncestor(file), e.code === 'EEXIST' || e.code === 'ENOTDIR');
  });
  let held = false;
  for (let attempt = 0; attempt < 25 && !held; attempt++) {
    held = await acquireLock(lockPath);
    if (!held) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!held) return 'locked';
  try {
    const next = edit((await readExisting(file)) ?? '');
    if (next === null) return 'unchanged';
    await writeFileAtomic(file, next, options);
    return 'written';
  } finally {
    await releaseLock(lockPath);
  }
}

/**
 * What stops a write to `excludeFile`, read-only: a file where a directory
 * belongs (ENOTDIR), or a directory or the file itself denying the write
 * (EACCES, EPERM, EROFS). A missing `info/` is created by the write, so its
 * closest existing directory is checked (#993); when the file exists, both it
 * and its directory, as the write is a temp file plus a rename.
 */
async function writeBlocker(excludeFile: string): Promise<{ path: string; notDirectory: boolean } | null> {
  const ancestor = await existingAncestor(excludeFile);
  if (await fse.stat(ancestor).then((s) => !s.isDirectory(), () => false)) return { path: ancestor, notDirectory: true };
  for (const writable of [ancestor, ...(await pathExists(excludeFile) ? [excludeFile] : [])]) {
    const denied = await fse.access(writable, fse.constants.W_OK).then(
      () => false,
      (e: NodeJS.ErrnoException) => ['EACCES', 'EPERM', 'EROFS'].includes(e.code ?? ''),
    );
    if (denied) return { path: writable, notDirectory: false };
  }
  return null;
}

// ─── Lines ────────────────────────────────────────────────────

/**
 * A path no exclude line can name safely: refused rather than turned into a
 * rule that hides something else. A directory is one: its line would hide a
 * file the member adds there, so owners list the files they wrote.
 */
export interface RefusedPath {
  path: string;
  problem: 'newline' | 'trailingSpace' | 'directory';
  message: string;
}

/** A path's line and where it goes. `rel` is the path from `root` as git names it. */
interface Placed {
  path: string;
  excludeFile: string;
  root: string;
  rel: string;
  line: string;
}

type Placement = { kind: 'placed'; placed: Placed } | { kind: 'refused'; refused: RefusedPath } | { kind: 'outsideRepo' } | { kind: 'gitFailed'; error: string };

/** Glob characters escaped, as #886 writes them. */
const escapeLine = (rel: string): string => `/${rel}`.replace(/[\\*?[\]!#]/g, '\\$&');

function refusal(file: string): RefusedPath | null {
  if (/[\r\n]/.test(file)) {
    return { path: file, problem: 'newline', message: `${JSON.stringify(file)} holds a line break, which no git exclude line can name, so git can still see it` };
  }
  if (path.basename(file).endsWith(' ')) {
    return { path: file, problem: 'trailingSpace', message: `${JSON.stringify(file)} ends in a space, which teamai does not write in a git exclude line, so git can still see it` };
  }
  return null;
}

/** `file` with its last part spelled as on disk (a case-insensitive or normalization-insensitive filesystem). */
async function onDiskSpelling(file: string): Promise<string> {
  const stat = await fse.lstat(file).catch(() => null);
  if (!stat) return file;
  const dir = path.dirname(file);
  const base = path.basename(file);
  const names = await fse.readdir(dir).catch(() => [] as string[]);
  if (names.includes(base)) return file;
  const fold = (name: string): string => name.normalize('NFC').toLowerCase();
  for (const name of names.filter((n) => fold(n) === fold(base))) {
    const other = await fse.lstat(path.join(dir, name)).catch(() => null);
    if (other && other.ino === stat.ino && other.dev === stat.dev) return path.join(dir, name);
  }
  return file;
}

/** A per-run cache of what git says about directories and repositories. */
class GitContext {
  private readonly locations = new Map<string, ReturnType<typeof locateExclude>>();
  private readonly repositories = new Map<string, ReturnType<typeof locateExclude>>();
  private readonly precompose = new Map<string, Promise<boolean>>();

  locate(dir: string): ReturnType<typeof locateExclude> {
    let found = this.locations.get(dir);
    if (!found) this.locations.set(dir, found = this.locateOnce(dir));
    return found;
  }

  /**
   * {@link locateExclude}, asking git once per repository: from the closest
   * directory at or above `dir` that holds `.git`, `dir`'s prefix being its
   * path from that toplevel. Anything else (a `.git` git does not take for a
   * repository, a directory outside the toplevel git names) asks git from `dir`.
   */
  private async locateOnce(dir: string): Promise<Awaited<ReturnType<typeof locateExclude>>> {
    let holder: string | null = dir;
    while (holder !== null && !await pathExists(path.join(holder, '.git'))) holder = path.dirname(holder) === holder ? null : path.dirname(holder);
    if (holder === null || holder === dir) return locateExclude(dir);
    let repository = this.repositories.get(holder);
    if (!repository) this.repositories.set(holder, repository = locateExclude(holder));
    const location = await repository;
    const rel = 'error' in location || location.prefix !== '' ? null : path.relative(location.root, dir);
    if (rel === null || rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return locateExclude(dir);
    return { ...location, prefix: `${rel.split(path.sep).join('/')}/` };
  }

  /** Whether git there reads names in NFC: `core.precomposeunicode`, which only git for macOS honours. */
  precomposes(root: string): Promise<boolean> {
    let found = this.precompose.get(root);
    if (!found) {
      found = process.platform !== 'darwin'
        ? Promise.resolve(false)
        : runGit(['config', '--bool', '--get', 'core.precomposeunicode'], root).then((r) => r.stdout.trim() === 'true');
      this.precompose.set(root, found);
    }
    return found;
  }

  /**
   * Where `file`'s line goes and how it reads: anchored at the toplevel of the
   * repository it lands in (a submodule, a nested clone, or one a symlinked
   * directory leads into), spelled as on disk. A directory is refused.
   */
  async place(file: string): Promise<Placement> {
    const refused = refusal(file);
    if (refused) return { kind: 'refused', refused };
    const landed = await onDiskSpelling(await realFilePath(file));
    const dir = await existingAncestor(landed);
    const location = await this.locate(dir);
    if ('error' in location) return await insideRepository(dir) ? { kind: 'gitFailed', error: location.error } : { kind: 'outsideRepo' };
    let rel = `${location.prefix}${path.relative(dir, landed).split(path.sep).join('/')}`;
    if (await this.precomposes(location.root)) rel = rel.normalize('NFC');
    if (await fse.lstat(landed).then((s) => s.isDirectory(), () => false)) {
      const message = `${JSON.stringify(file)} is a directory, and teamai lists only the files it delivers in a git exclude block, so git can still see what it holds`;
      return { kind: 'refused', refused: { path: file, problem: 'directory', message } };
    }
    return { kind: 'placed', placed: { path: file, excludeFile: location.excludeFile, root: location.root, rel, line: escapeLine(rel) } };
  }
}

// ─── sync ─────────────────────────────────────────────────────

/** How a write to one exclude file went. */
export type GitExcludeWrite =
  | { kind: 'written' | 'unchanged' | 'locked' | 'pending' }
  | { kind: 'notWritable'; path: string; message: string }
  | { kind: 'notReadable'; path: string; message: string }
  | { kind: 'writeFailed'; error: string };

/** A checkout where git could not say what it tracks or ignores: its paths keep their lines (the safe direction). */
export interface GitCheckFailure {
  checkout: string;
  error: string;
}

/** A delivered file git tracks in `checkout`. */
export interface TrackedPath {
  path: string;
  checkout: string;
}

export interface GitExcludeFileSync {
  excludeFile: string;
  write: GitExcludeWrite;
  /** The owner's lines in the file after the sync (in a dry run, or when the write failed: the lines it would hold). */
  lines: string[];
  added: string[];
  dropped: string[];
  tracked: TrackedPath[];
  reincluded: Array<{ path: string; rule: ReincludingRule | null }>;
  damaged: DamagedMarker[];
  checkFailed: GitCheckFailure[];
}

export interface GitExcludeSync {
  files: GitExcludeFileSync[];
  refused: RefusedPath[];
  outsideRepo: string[];
  gitFailed: Array<{ path: string; error: string }>;
}

/**
 * Make `owner`'s blocks hold exactly `paths` (absolute, landed): each path's
 * line in the exclude file of the repository it lands in, and no block in a
 * recorded file that receives none. A tracked file gets no line and is
 * reported; a directory is refused (each file is a line). While git cannot
 * place a path (`gitFailed`), no one can say which exclude file holds its line,
 * so the run only adds: no block loses a line and every recorded file stays
 * recorded. `dryRun` writes nothing, not even `info/` or a lock file.
 */
export async function sync(owner: GitExcludeOwner, paths: Iterable<string>, options: { dryRun?: boolean } = {}): Promise<GitExcludeSync> {
  markersOf(owner.name);
  const context = new GitContext();
  const result: GitExcludeSync = { files: [], refused: [], outsideRepo: [], gitFailed: [] };
  const byFile = new Map<string, Placed[]>();
  for (const file of new Set(paths)) {
    const placement = await context.place(file);
    if (placement.kind === 'refused') result.refused.push(placement.refused);
    else if (placement.kind === 'outsideRepo') result.outsideRepo.push(file);
    else if (placement.kind === 'gitFailed') result.gitFailed.push({ path: file, error: placement.error });
    else byFile.set(placement.placed.excludeFile, [...byFile.get(placement.placed.excludeFile) ?? [], placement.placed]);
  }
  for (const recorded of await owner.record?.files() ?? []) if (!byFile.has(recorded)) byFile.set(recorded, []);
  const addOnly = result.gitFailed.length > 0;

  const add: string[] = [];
  const drop: string[] = [];
  for (const [excludeFile, placed] of byFile) {
    const checkFailed: GitCheckFailure[] = [];
    const tracked = await trackedPaths(placed, checkFailed);
    // A line stays while any path it names is untracked somewhere.
    const wanted = placed.filter((p) => !tracked.some((t) => t.path === p.path)).map((p) => p.line);
    const next = (current: string[]): string[] => [...new Set([...addOnly ? current : [], ...wanted])].sort();
    const { lines, ...outcome } = await writeOwnerLines(excludeFile, owner.name, next, options.dryRun);
    const reincluded = options.dryRun || outcome.write.kind !== 'written' && outcome.write.kind !== 'unchanged'
      ? []
      : await reincludedPaths(placed.filter((p) => lines.includes(p.line)), checkFailed);
    result.files.push({ excludeFile, ...outcome, lines, tracked, reincluded, checkFailed });
    if (outcome.write.kind === 'written' || outcome.write.kind === 'unchanged') (lines.length > 0 ? add : drop).push(excludeFile);
  }
  if (!options.dryRun && owner.record && (add.length > 0 || drop.length > 0)) await owner.record.update({ add, drop });
  return result;
}

/**
 * Set `owner`'s lines in `excludeFile` to `next(current lines)` under the
 * shared lock, after the read-only writability check, and say which lines the
 * block holds after it (when the write failed: would hold). A missing exclude
 * file that would get no block is left missing (a deleted repository, or nothing to write).
 */
async function writeOwnerLines(
  excludeFile: string,
  owner: string,
  next: (current: string[]) => string[],
  dryRun = false,
): Promise<{ write: GitExcludeWrite; lines: string[]; added: string[]; dropped: string[]; damaged: DamagedMarker[] }> {
  const diff = (current: string[], lines: string[]): { lines: string[]; added: string[]; dropped: string[] } => ({
    lines,
    added: lines.filter((l) => !current.includes(l)),
    dropped: current.filter((l) => !lines.includes(l)),
  });
  let before: string;
  try {
    before = (await readExisting(excludeFile)) ?? '';
  } catch (e) {
    if (!(e instanceof NotReadableError)) throw e;
    return { write: { kind: 'notReadable', path: excludeFile, message: e.message }, lines: next([]), added: [], dropped: [], damaged: [] };
  }
  const parsed = parseExclude(before);
  const damaged = parsed.damaged.filter((d) => d.owner === owner);
  const current = ownerLines(parsed, owner) ?? [];
  const planned = next(current);
  if (withOwnerLines(before, owner, planned) === null) return { write: { kind: 'unchanged' }, ...diff(current, planned), damaged };
  if (dryRun) return { write: { kind: 'pending' }, ...diff(current, planned), damaged };
  const blocker = await writeBlocker(excludeFile);
  if (blocker) {
    return {
      write: { kind: 'notWritable', path: blocker.path, message: new NotWritableError(excludeFile, blocker.path, blocker.notDirectory).message },
      ...diff(current, planned),
      damaged,
    };
  }
  let changes = diff(current, planned);
  try {
    const write = await updateFileLocked(excludeFile, (content) => {
      const lines = ownerLines(parseExclude(content), owner) ?? [];
      changes = diff(lines, next(lines));
      return withOwnerLines(content, owner, changes.lines);
    });
    return { write: { kind: write }, ...changes, damaged };
  } catch (e) {
    if (e instanceof NotWritableError) return { write: { kind: 'notWritable', path: e.blocker, message: e.message }, ...changes, damaged };
    if (e instanceof NotReadableError) return { write: { kind: 'notReadable', path: excludeFile, message: e.message }, ...changes, damaged };
    return { write: { kind: 'writeFailed', error: e instanceof Error ? e.message : String(e) }, ...changes, damaged };
  }
}

/** Paths among `placed` git tracks, per checkout: one `ls-files` per checkout. A checkout git fails in goes to `failed`. */
async function trackedPaths(placed: Placed[], failed: GitCheckFailure[]): Promise<TrackedPath[]> {
  const tracked: TrackedPath[] = [];
  for (const [root, group] of groupBy(placed, (p) => p.root)) {
    const listed = await runGit(['--literal-pathspecs', 'ls-files', '-z', '--', ...group.map((p) => p.rel)], root);
    if (listed.code !== 0) {
      failed.push({ checkout: root, error: listed.stderr.trim() || `git exited with ${listed.code}` });
      continue;
    }
    const files = listed.stdout.split('\0').filter(Boolean);
    for (const p of group) {
      if (files.includes(p.rel)) tracked.push({ path: p.path, checkout: root });
    }
  }
  return tracked;
}

/**
 * Paths among `placed` git would still offer for a commit, with the rule that
 * re-includes each when git names one: one `ls-files --others` per checkout,
 * then `check-ignore -v` only for those few.
 */
async function reincludedPaths(placed: Placed[], failed: GitCheckFailure[]): Promise<Array<{ path: string; rule: ReincludingRule | null }>> {
  return reincludingRules([...await offeredPaths(placed, failed)]);
}

/**
 * Paths among `placed` git would still offer for a commit (untracked and not
 * ignored), each with the file git offers: one
 * `ls-files --others` per checkout.
 */
async function offeredPaths(placed: Placed[], failed: GitCheckFailure[]): Promise<Map<Placed, string>> {
  const found = new Map<Placed, string>();
  for (const [root, group] of groupBy(placed, (p) => p.root)) {
    const listed = await runGit(['--literal-pathspecs', 'ls-files', '-z', '--others', '--exclude-standard', '--', ...group.map((p) => p.rel)], root);
    if (listed.code !== 0) {
      if (!failed.some((f) => f.checkout === root)) failed.push({ checkout: root, error: listed.stderr.trim() || `git exited with ${listed.code}` });
      continue;
    }
    const visible = listed.stdout.split('\0').filter(Boolean);
    for (const p of group) {
      const offered = visible.find((f) => f === p.rel);
      if (offered) found.set(p, path.join(root, offered));
    }
  }
  return found;
}

/** The rule `check-ignore -v` names for each offered path: one call per path, so only for the few git still offers. */
async function reincludingRules(offered: Array<[Placed, string]>): Promise<Array<{ path: string; rule: ReincludingRule | null }>> {
  const found: Array<{ path: string; rule: ReincludingRule | null }> = [];
  for (const [p, file] of offered) found.push({ path: p.path, rule: await reincludingRule(file, p.root) });
  return found;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...groups.get(key(item)) ?? [], item]);
  return groups;
}

// ─── ensure ───────────────────────────────────────────────────

/** What a failure tells the member: why the path is not kept out of git, and what to do about it. */
interface Explained {
  reason: string;
  fix: string;
}

/**
 * Whether a path is kept out of git before a write, or why not, each failure
 * with the text #886 shows. `added`: this call listed it. `pending`: a dry run
 * found nothing in the way. `outsideRepo`: no git would commit it.
 */
export type GitExcludeEnsure =
  | { kind: 'excluded'; added: boolean }
  | { kind: 'pending' }
  | { kind: 'outsideRepo' }
  | ({ kind: 'tracked' } & Explained)
  | ({ kind: 'reincluded'; rule: ReincludingRule | null } & Explained)
  | ({ kind: 'notWritable'; path: string } & Explained)
  | ({ kind: 'notReadable'; path: string; error: string } & Explained)
  | ({ kind: 'locked' } & Explained)
  | ({ kind: 'gitFailed'; error: string } & Explained)
  | ({ kind: 'writeFailed'; error: string } & Explained)
  | ({ kind: 'refused'; problem: RefusedPath['problem'] } & Explained);

/**
 * Add each of `paths` to `owner`'s block in its repository's exclude file,
 * never removing a line, and say per path whether git now leaves it out of a
 * commit: the gate a caller passes before writing a secret. A path git tracks,
 * or cannot say it does not track, fails before anything is written. The path
 * need not exist yet. `mcp-exclude` adds no line for a path git already
 * ignores. `dryRun` writes nothing, not even `info/` or a lock file. `rerun`
 * ends each fix: how the caller's write is tried again.
 */
export async function ensure(
  owner: GitExcludeOwner,
  paths: Iterable<string>,
  options: { dryRun?: boolean; rerun?: string } = {},
): Promise<Array<{ path: string; result: GitExcludeEnsure }>> {
  markersOf(owner.name);
  const context = new GitContext();
  const results: Array<{ path: string; result: GitExcludeEnsure }> = [];
  const add = new Set<string>();
  for (const file of new Set(paths)) {
    const { result, excludeFile } = await ensureOne(owner.name, file, context, options);
    results.push({ path: file, result });
    if (excludeFile && !options.dryRun) add.add(excludeFile);
  }
  if (owner.record && add.size > 0) await owner.record.update({ add: [...add], drop: [] });
  return results;
}

async function ensureOne(
  owner: string,
  file: string,
  context: GitContext,
  options: { dryRun?: boolean; rerun?: string },
): Promise<{ result: GitExcludeEnsure; excludeFile?: string }> {
  const { rerun = 'run `teamai pull` again' } = options;
  const repair = `Fix the repository, or add the file to its .git/info/exclude yourself, then ${rerun}.`;
  const refused = refusal(file);
  if (refused) return { result: { kind: 'refused', problem: refused.problem, reason: refused.message, fix: `Rename it, then ${rerun}.` } };
  const tracking = await gitTracking(file);
  if (tracking.kind === 'outside-repo') return { result: { kind: 'outsideRepo' } };
  // #886's rule, narrowed (#915): an ignore from teamai's own blocks does not count, as they change with the
  // option, the team's config and `uninstall --agent`; only a rule of the member's does.
  if (tracking.kind === 'ignored' && isLegacy(owner) && await ignoredByMembersRule(file)) return { result: { kind: 'excluded', added: false } };
  const inIndex = await gitTracks(file);
  if (inIndex.kind === 'tracked') {
    const named = await gitPathOf(file);
    return {
      result: {
        kind: 'tracked',
        reason: `git already tracks ${named.label}`,
        // After "Run `git rm …`", a second "run" is dropped: "then `teamai pull` again".
        fix: `Run \`git rm --cached ${named.path}\` (rotate any value a commit of it holds), then ${rerun.replace(/^run /, '')}.`,
      },
    };
  }
  if (inIndex.kind === 'unknown') return { result: { kind: 'gitFailed', error: inIndex.error, reason: inIndex.error, fix: repair } };
  // Where the write lands. It and its directory need not exist yet: git is asked from the nearest one that does.
  const placement = await context.place(file);
  if (placement.kind === 'refused') {
    return { result: { kind: 'refused', problem: placement.refused.problem, reason: placement.refused.message, fix: `Rename it, then ${rerun}.` } };
  }
  if (placement.kind !== 'placed') {
    const error = tracking.kind === 'unknown' ? tracking.error : 'git could not locate .git/info/exclude';
    return { result: { kind: 'gitFailed', error, reason: error, fix: repair } };
  }
  const { excludeFile, line } = placement.placed;
  const retry = `Make it writable, or add \`${line}\` to it yourself, then ${rerun}.`;
  const notWritable = (blocker: string, notDirectory: boolean): GitExcludeEnsure => ({
    kind: 'notWritable',
    path: blocker,
    reason: new NotWritableError(excludeFile, blocker, notDirectory).message,
    fix: notDirectory
      ? `Move ${blocker} aside, then ${rerun}.`
      : `Make ${blocker} writable, or add \`${line}\` to ${excludeFile} yourself, then ${rerun}.`,
  });
  // A read-only exclude file is the member's choice; the atomic write would replace it all the same.
  const blocker = await writeBlocker(excludeFile);
  if (blocker?.path === excludeFile) {
    return { result: { kind: 'notWritable', path: excludeFile, reason: `${excludeFile} is not writable`, fix: retry } };
  }
  if (blocker) return { result: notWritable(blocker.path, blocker.notDirectory) };
  const landed = await realFilePath(file);
  const addLine = (lines: string[]): string[] | null => lines.includes(line) ? null : [...lines, line];
  let write: ExcludeUpdate;
  try {
    if (options.dryRun) {
      if (addLine(ownerLines(parseExclude((await readExisting(excludeFile)) ?? ''), owner) ?? []) !== null) {
        // A negated rule in a .gitignore outranks .git/info/exclude: the line would change nothing.
        const rule = await reincludingRule(landed, placement.placed.root);
        return { result: rule && path.basename(rule.source) === '.gitignore' ? reincluded(await gitPathOf(file), rule, rerun) : { kind: 'pending' } };
      }
      write = 'unchanged';
    } else {
      write = await updateFileLocked(excludeFile, (content) => {
        const next = addLine(ownerLines(parseExclude(content), owner) ?? []);
        return next === null ? null : withOwnerLines(content, owner, next);
      });
    }
  } catch (e) {
    if (e instanceof NotWritableError) return { result: notWritable(e.blocker, e.notDirectory) };
    if (e instanceof NotReadableError) {
      return { result: { kind: 'notReadable', path: excludeFile, error: e.error, reason: e.message, fix: `Make ${excludeFile} readable, then ${rerun}.` } };
    }
    const error = e instanceof Error ? e.message : String(e);
    return { result: { kind: 'writeFailed', error, reason: `adding it to ${excludeFile} failed: ${error}`, fix: retry } };
  }
  if (write === 'locked') {
    return {
      result: {
        kind: 'locked',
        reason: `another teamai command held ${excludeFile} past the wait`,
        fix: `${rerun.charAt(0).toUpperCase()}${rerun.slice(1)}.`,
      },
    };
  }
  // Only git saying it ignores the file lets the caller write a secret into it.
  const after = await gitTracking(file);
  if (after.kind === 'ignored') return { result: { kind: 'excluded', added: write === 'written' }, excludeFile };
  const named = await gitPathOf(file);
  if (after.kind !== 'would-commit') {
    const error = after.kind === 'unknown' ? after.error : 'git says the file is outside any repository';
    return {
      result: {
        kind: 'gitFailed',
        error,
        reason: `git could not confirm that it ignores ${named.label}: ${JSON.stringify(error)}`,
        fix: `Check that \`git check-ignore -v ${named.path}\` works in that repository, then ${rerun}.`,
      },
      excludeFile,
    };
  }
  // Untracked, as checked above: a rule git reads after teamai's line, or before it, re-includes the file.
  return { result: reincluded(named, await reincludingRule(landed, placement.placed.root), rerun), excludeFile };
}

/** The failure for a file a rule of the member's re-includes, naming `rule` when git could. */
function reincluded(named: { label: string }, rule: ReincludingRule | null, rerun: string): GitExcludeEnsure {
  return rule
    ? {
      kind: 'reincluded',
      rule,
      reason: `a rule in your git ignore files re-includes ${named.label}: \`${rule.pattern}\` (${rule.source}:${rule.line})`,
      fix: `Remove \`${rule.pattern}\` from ${rule.source}, then ${rerun}.`,
    }
    : {
      kind: 'reincluded',
      rule: null,
      reason: `a rule in your git ignore files re-includes ${named.label}`,
      fix: `Remove the rule in .gitignore, .git/info/exclude or core.excludesFile that re-includes it (\`git check-ignore -v\` names it), then ${rerun}.`,
    };
}

// ─── remove ───────────────────────────────────────────────────

/** A line `remove` is about to drop, for its `keep` predicate. */
export interface GitExcludeLine {
  owner: string;
  line: string;
  excludeFile: string;
}

export interface GitExcludeFileRemoval {
  excludeFile: string;
  /** `missing`: no exclude file (a deleted repository); nothing was written. */
  write: GitExcludeWrite | { kind: 'missing' };
  /** Per owner, the lines removed (in a dry run, or when the write failed: the lines to remove). */
  removed: Array<{ owner: string; lines: string[] }>;
  kept: Array<{ owner: string; lines: string[] }>;
  /** Markers teamai cannot pair; they and the lines after them are left to the member. */
  damaged: DamagedMarker[];
}

/**
 * Remove `target`'s blocks (every teamai block for `'all'`) from each exclude
 * file: the owner's recorded files plus `files`. `keep` leaves a line in its
 * block (uninstall: a credential line whose file still holds one). A file
 * whose block is gone leaves the owner's record. `dryRun` writes nothing.
 */
export async function remove(
  target: GitExcludeOwner | 'all',
  options: { files?: Iterable<string>; keep?: (line: GitExcludeLine) => boolean | Promise<boolean>; dryRun?: boolean } = {},
): Promise<GitExcludeFileRemoval[]> {
  if (target !== 'all') markersOf(target.name);
  const files = new Set([...target !== 'all' ? await target.record?.files() ?? [] : [], ...options.files ?? []]);
  const results: GitExcludeFileRemoval[] = [];
  const drop: string[] = [];
  for (const excludeFile of files) {
    let content: string | null;
    try {
      content = await readExisting(excludeFile);
    } catch (e) {
      if (!(e instanceof NotReadableError)) throw e;
      results.push({ excludeFile, write: { kind: 'notReadable', path: excludeFile, message: e.message }, removed: [], kept: [], damaged: [] });
      continue;
    }
    if (content === null) {
      results.push({ excludeFile, write: { kind: 'missing' }, removed: [], kept: [], damaged: [] });
      drop.push(excludeFile);
      continue;
    }
    const parsed = parseExclude(content);
    const owners = target === 'all'
      ? [...new Set(parsed.segments.flatMap((s) => s.kind === 'block' ? [s.owner] : []))].filter((o) => OWNER.test(o))
      : [target.name];
    const removed: Array<{ owner: string; lines: string[] }> = [];
    const kept: Array<{ owner: string; lines: string[] }> = [];
    for (const owner of owners) {
      const lines = ownerLines(parsed, owner);
      if (lines === null) continue;
      const keepLines: string[] = [];
      for (const line of lines) if (await options.keep?.({ owner, line, excludeFile })) keepLines.push(line);
      removed.push({ owner, lines: lines.filter((l) => !keepLines.includes(l)) });
      if (keepLines.length > 0) kept.push({ owner, lines: keepLines });
    }
    const damaged = parsed.damaged.filter((d) => target === 'all' || d.owner === target.name);
    const removal = { excludeFile, removed, kept, damaged };
    // Only lines judged here go; one another command added meanwhile stays for its next run.
    const edit = (current: string): string | null => {
      let next = current;
      for (const { owner, lines } of removed) {
        const now = ownerLines(parseExclude(next), owner);
        if (now !== null) next = withOwnerLines(next, owner, now.filter((l) => !lines.includes(l))) ?? next;
      }
      return next === current ? null : next;
    };
    if (edit(content) === null) {
      results.push({ ...removal, write: { kind: 'unchanged' } });
    } else if (options.dryRun) {
      results.push({ ...removal, write: { kind: 'pending' } });
    } else {
      const blocker = await writeBlocker(excludeFile);
      results.push({
        ...removal,
        write: blocker
          ? { kind: 'notWritable', path: blocker.path, message: new NotWritableError(excludeFile, blocker.path, blocker.notDirectory).message }
          : await updateFileLocked(excludeFile, edit).then(
            (kind): GitExcludeWrite => ({ kind }),
            (e: unknown): GitExcludeWrite => e instanceof NotWritableError
              ? { kind: 'notWritable', path: e.blocker, message: e.message }
              : e instanceof NotReadableError
                ? { kind: 'notReadable', path: excludeFile, message: e.message }
                : { kind: 'writeFailed', error: e instanceof Error ? e.message : String(e) },
          ),
      });
    }
    const last = results[results.length - 1];
    if ((last.write.kind === 'written' || last.write.kind === 'unchanged') && target !== 'all' && !kept.some((k) => k.owner === target.name)) {
      drop.push(excludeFile);
    }
  }
  if (!options.dryRun && target !== 'all' && target.record && drop.length > 0) await target.record.update({ add: [], drop });
  return results;
}

// ─── report ───────────────────────────────────────────────────

export interface GitExcludeFileReport {
  excludeFile: string;
  /** Expected paths whose line is in the owner's block. */
  listed: string[];
  /** Expected paths with no line (a tracked file is reported as tracked instead). */
  missing: string[];
  tracked: TrackedPath[];
  /** Listed paths git still offers for a commit, and the rule that re-includes each when git names one. */
  reincluded: Array<{ path: string; rule: ReincludingRule | null }>;
  /** Lines in the owner's block no expected path accounts for. */
  stale: string[];
  damaged: DamagedMarker[];
  checkFailed: GitCheckFailure[];
  /** Expected paths git would offer for a commit: untracked and not ignored, listed or not. */
  visible: string[];
  /**
   * Set when the file exists but cannot be read (the read error): its lines
   * are unknown, so no path is `listed` or `missing` and no line `stale`.
   */
  notReadable?: string;
}

export interface GitExcludeReport {
  files: GitExcludeFileReport[];
  refused: RefusedPath[];
  outsideRepo: string[];
  gitFailed: Array<{ path: string; error: string }>;
}

/**
 * Read-only: how `owner`'s blocks stand against `expectedPaths`, per exclude
 * file (recorded ones and those the paths route to). Writes nothing and
 * creates no lock file. git is asked a fixed number of times per checkout:
 * where its exclude file is, what it tracks, which paths it still offers for
 * a commit (one `ls-files --others`), then `check-ignore -v` only for the
 * listed paths it offers.
 */
export async function report(owner: GitExcludeOwner, expectedPaths: Iterable<string>): Promise<GitExcludeReport> {
  markersOf(owner.name);
  const context = new GitContext();
  const result: GitExcludeReport = { files: [], refused: [], outsideRepo: [], gitFailed: [] };
  const byFile = new Map<string, Placed[]>();
  for (const file of new Set(expectedPaths)) {
    const placement = await context.place(file);
    if (placement.kind === 'refused') result.refused.push(placement.refused);
    else if (placement.kind === 'outsideRepo') result.outsideRepo.push(file);
    else if (placement.kind === 'gitFailed') result.gitFailed.push({ path: file, error: placement.error });
    else byFile.set(placement.placed.excludeFile, [...byFile.get(placement.placed.excludeFile) ?? [], placement.placed]);
  }
  for (const recorded of await owner.record?.files() ?? []) if (!byFile.has(recorded)) byFile.set(recorded, []);
  for (const [excludeFile, placed] of byFile) {
    let content: string;
    let notReadable: string | undefined;
    try {
      content = (await readExisting(excludeFile)) ?? '';
    } catch (e) {
      if (!(e instanceof NotReadableError)) throw e;
      content = '';
      notReadable = e.message;
    }
    const parsed = parseExclude(content);
    const lines = ownerLines(parsed, owner.name) ?? [];
    const checkFailed: GitCheckFailure[] = [];
    const tracked = await trackedPaths(placed, checkFailed);
    const listed = placed.filter((p) => lines.includes(p.line));
    const missing = notReadable ? [] : placed.filter((p) => !lines.includes(p.line) && !tracked.some((t) => t.path === p.path));
    const offered = await offeredPaths(placed, checkFailed);
    result.files.push({
      excludeFile,
      listed: listed.map((p) => p.path),
      missing: missing.map((p) => p.path),
      tracked,
      reincluded: await reincludingRules([...offered].filter(([p]) => listed.includes(p))),
      stale: lines.filter((l) => !placed.some((p) => p.line === l)),
      damaged: parsed.damaged.filter((d) => d.owner === owner.name),
      checkFailed,
      visible: placed.filter((p) => offered.has(p)).map((p) => p.path),
      ...notReadable ? { notReadable } : {},
    });
  }
  return result;
}

// ─── Records and readers ──────────────────────────────────────

/** The lines of `owner`'s block in an exclude file's `content`, or null when it has none. */
export function excludeLines(content: string, owner: string): string[] | null {
  markersOf(owner);
  return ownerLines(parseExclude(content), owner);
}

/**
 * Rewrite `owner`'s block in `excludeFile` under the shared lock, with no
 * writability check: `edit` gets its lines and returns the next ones (null:
 * leave the file). A file without the block is left as it is.
 */
export function updateExcludeLines(excludeFile: string, owner: string, edit: (lines: string[]) => string[] | null): Promise<ExcludeUpdate> {
  markersOf(owner);
  return updateFileLocked(excludeFile, (content) => {
    const lines = ownerLines(parseExclude(content), owner);
    const next = lines === null ? null : edit(lines);
    return next === null ? null : withOwnerLines(content, owner, next);
  });
}

/**
 * The record `<stateHome>/git-exclude.json` keeps for `owner` (local-agent
 * owners and `credentials`): exclude file paths keyed by owner, updated under
 * the shared lock so owners and processes never drop each other's.
 */
export function stateHomeRecord(stateHome: string, owner: string): GitExcludeFileRecord {
  markersOf(owner);
  const file = path.join(stateHome, 'git-exclude.json');
  const parse = (content: string | null): Record<string, unknown> => {
    if (content === null || content.trim() === '') return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      throw new Error(`${file} is not valid JSON (${e instanceof Error ? e.message : String(e)}): fix or delete it, then run the command again.`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${file} does not hold an object: fix or delete it, then run the command again.`);
    }
    return parsed as Record<string, unknown>;
  };
  const filesOf = (all: Record<string, unknown>): string[] => {
    const files = all[owner];
    return Array.isArray(files) ? files.filter((f): f is string => typeof f === 'string') : [];
  };
  return {
    files: async () => filesOf(parse(await readFileSafe(file))),
    update: async ({ add, drop }) => {
      const result = await updateFileLocked(file, (content) => {
        const all = parse(content);
        const before = filesOf(all);
        const files = [...new Set([...before, ...add])].filter((f) => !drop.includes(f)).sort();
        if (files.length === before.length && files.every((f) => before.includes(f))) return null;
        if (files.length > 0) all[owner] = files;
        else delete all[owner];
        return `${JSON.stringify(all, null, 2)}\n`;
      });
      if (result === 'locked') throw new Error(`Another teamai command held ${file} past the wait; run the command again.`);
    },
  };
}
