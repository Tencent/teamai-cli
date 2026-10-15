import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createGit } from './git.js';
import { log } from './logger.js';

// ─── History proof (#993) ────────────────────────────────────
//
//  A destination teamai has no record of is teamai's only on proof: its
//  content equals what teamai renders for that resource at some revision in
//  the history of the repo the resource comes from (the team repo, or a source
//  repo). These are the primitives of that proof. They read the history of the
//  branch the checkout has (HEAD), as far as the clone has it: a shallow clone
//  proves less, never more.
//
//  Whole files compare by git blob id, without reading a historical blob. A
//  resource whose render is not its source bytes (an MCP server, a hook entry,
//  a rendered rule) reads each historical version once and renders it.

/** One version a file under a pathspec held in the history. */
export interface HistoricalVersion {
  /** Repo-relative, `/`-separated. */
  path: string;
  blob: string;
  /** git's file mode for it, `120000` for a link. */
  mode?: string;
  /** How this version entered the first-parent history. */
  status?: string;
}

/**
 * Every distinct version each file under `pathspec` (a file or a directory,
 * repo-relative, `/`-separated) held in the history of HEAD in `repoPath`,
 * newest first, merges included and renames not followed. Empty when the path
 * never existed; null when git cannot read the history (not a repository, no
 * commits, a git error).
 */
export async function historicalVersions(
  repoPath: string, pathspec: string, options: { currentLifetime?: boolean } = {},
): Promise<HistoricalVersion[] | null> {
  let out: string;
  try {
    out = await createGit(repoPath).raw([
      'log', ...(options.currentLifetime ? ['--first-parent'] : ['-m']),
      '-z', '--raw', '--no-renames', '--no-abbrev', '--format=', 'HEAD', '--', pathspec,
    ]);
  } catch (e) {
    log.debug(`Could not read the history of ${pathspec} in ${repoPath}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  const versions: HistoricalVersion[] = [];
  const seen = new Set<string>();
  const tokens = out.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const header = /^\n*:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([A-Z]\d*)$/.exec(tokens[i]);
    if (!header) continue;
    const file = tokens[++i];
    if (options.currentLifetime && header[5] === 'D') break;
    for (const [blob, mode] of [[header[4], header[2]], [header[3], header[1]]] as const) {
      if (/^0+$/.test(blob) || seen.has(`${file}\0${blob}\0${mode}`)) continue;
      seen.add(`${file}\0${blob}\0${mode}`);
      versions.push({ path: file, blob, mode, status: header[5] });
    }
  }
  return versions;
}

/** The bytes of one blob of `repoPath`, or null when git cannot read it. */
export async function readBlob(repoPath: string, blob: string): Promise<Buffer | null> {
  try {
    return Buffer.from(await createGit(repoPath).binaryCatFile(['blob', blob]) as Uint8Array);
  } catch {
    return null;
  }
}

const objectFormats = new Map<string, Promise<string>>();

/** The id git gives `content` as a blob of `repoPath` (sha1, or sha256 in a sha256 repository). */
export async function blobIdOf(repoPath: string, content: string | Uint8Array): Promise<string> {
  let format = objectFormats.get(repoPath);
  if (!format) {
    format = createGit(repoPath).raw(['rev-parse', '--show-object-format']).then((f) => f.trim() || 'sha1', () => 'sha1');
    objectFormats.set(repoPath, format);
  }
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  return createHash(await format).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/** The content teamai would write for one historical version, or null for none. */
export type HistoryRender = (content: Buffer, version: HistoricalVersion) => string | Uint8Array | null;

/**
 * Whether `candidate` equals the file at `pathspec` at some revision of HEAD
 * in `repoPath` (without `render`), or teamai's render of it (with). Compared
 * by blob id. Null when git cannot read the history; a version git cannot
 * read is skipped.
 */
export async function matchesHistory(
  repoPath: string,
  pathspec: string,
  candidate: string | Uint8Array,
  render?: HistoryRender,
): Promise<boolean | null> {
  const all = await historicalVersions(repoPath, pathspec);
  if (all === null) return null;
  // A file is proven only by a file the team had: a link's blob is its target text, not content.
  const versions = all.filter((version) => version.mode !== '120000');
  const id = await blobIdOf(repoPath, candidate);
  if (!render) return versions.some((v) => v.blob === id);
  for (const version of versions) {
    const content = await readBlob(repoPath, version.blob);
    const rendered = content === null ? null : render(content, version);
    if (rendered !== null && await blobIdOf(repoPath, rendered) === id) return true;
  }
  return false;
}

/**
 * The content of every historical version under `pathspec`, newest first, for
 * a caller that renders entries out of them (MCP servers, hook entries). Null
 * when git cannot read the history.
 */
export async function historicalContents(
  repoPath: string,
  pathspec: string,
): Promise<Array<HistoricalVersion & { content: Buffer }> | null> {
  const versions = await historicalVersions(repoPath, pathspec);
  if (versions === null) return null;
  const blobs = await readBlobs(repoPath, [...new Set(versions.map((version) => version.blob))]);
  const contents: Array<HistoricalVersion & { content: Buffer }> = [];
  for (const version of versions) {
    const content = blobs.get(version.blob);
    if (content !== undefined) contents.push({ ...version, content });
  }
  return contents;
}

/**
 * The bytes of each of `blobs` in `repoPath`, read by one `git cat-file --batch`
 * rather than a git process per blob. A blob git does not have is left out.
 */
async function readBlobs(repoPath: string, blobs: readonly string[]): Promise<Map<string, Buffer>> {
  const found = new Map<string, Buffer>();
  if (blobs.length === 0) return found;
  const out = await new Promise<Buffer | null>((resolve) => {
    const child = execFile('git', ['-C', repoPath, 'cat-file', '--batch'], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 },
      (error, stdout) => resolve(error ? null : stdout));
    child.stdin?.end(`${blobs.join('\n')}\n`);
  });
  if (out === null) {
    log.debug(`Could not read ${blobs.length} historical blob(s) in ${repoPath}`);
    return found;
  }
  // Each answer: `<id> <type> <size>\n<bytes>\n`, or `<id> missing\n`.
  let at = 0;
  while (at < out.length) {
    const eol = out.indexOf(0x0a, at);
    if (eol === -1) break;
    const [id, type, size] = out.subarray(at, eol).toString('utf8').split(' ');
    at = eol + 1;
    if (type === 'missing' || size === undefined) continue;
    const length = Number(size);
    if (type === 'blob') found.set(id, Buffer.from(out.subarray(at, at + length)));
    at += length + 1;
  }
  return found;
}
