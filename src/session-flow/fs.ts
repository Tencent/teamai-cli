/**
 * fs.ts — path resolution and JSONL read/write helpers.
 *
 * Resolves each platform's session storage path, encodes and decodes cwd
 * (each platform encodes the working directory differently), and reads and
 * writes JSONL as a stream.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import {
  CLAUDE_TOOL_ID,
  CODEX_TOOL_ID,
  CURSOR_DATA_TOOL_ID,
  DEFAULT_CLAUDE_ROOT,
  DEFAULT_CODEX_ROOT,
  DEFAULT_CURSOR_ROOT,
  resolveToolRootDir,
  type LocalConfig,
} from '../types.js';

// ---------------------------------------------------------------------------
// Default per-platform storage paths
// ---------------------------------------------------------------------------

/**
 * The root of a relocatable tool: the one the member recorded (`toolRoots`, written by `teamai
 * init` from CLAUDE_CONFIG_DIR, CODEX_HOME or CURSOR_DATA_DIR), else the default one in the home
 * directory.
 */
function toolRootDir(tool: string, defaultRoot: string, toolRoots: LocalConfig['toolRoots']): string {
  return toolRoots?.[tool] ? resolveToolRootDir(tool, defaultRoot, toolRoots) : path.join(homedir(), defaultRoot);
}

export function getClaudeCodeProjectsDir(toolRoots?: LocalConfig['toolRoots']): string {
  return path.join(toolRootDir(CLAUDE_TOOL_ID, DEFAULT_CLAUDE_ROOT, toolRoots), 'projects');
}

/** TeamAI variant: claude-internal */
export function getClaudeInternalProjectsDir(): string {
  return path.join(homedir(), '.claude-internal', 'projects');
}

/** TeamAI variant: tclaude */
export function getTClaudeProjectsDir(): string {
  return path.join(homedir(), '.tclaude', 'projects');
}

export function getCodexSessionsDir(toolRoots?: LocalConfig['toolRoots']): string {
  return path.join(toolRootDir(CODEX_TOOL_ID, DEFAULT_CODEX_ROOT, toolRoots), 'sessions');
}

/** TeamAI variant: codex-internal */
export function getCodexInternalSessionsDir(): string {
  return path.join(homedir(), '.codex-internal', 'sessions');
}

/** TeamAI variant: tcodex */
export function getTCodexSessionsDir(): string {
  return path.join(homedir(), '.tcodex', 'sessions');
}

export function getCodeBuddyProjectsDir(): string {
  return path.join(homedir(), '.codebuddy', 'projects');
}

/**
 * WorkBuddy session directory. Same layout as CodeBuddy (<encoded-cwd>/<uuid>.jsonl),
 * but it also provides <uuid>.meta.json with the real cwd — avoiding the lossy
 * problem of reversing the directory name.
 */
export function getWorkBuddyProjectsDir(): string {
  return path.join(homedir(), '.workbuddy', 'projects');
}

/**
 * Cursor CLI's transcript store: <data root>/projects, where the data root is `CURSOR_DATA_DIR`
 * when the member recorded one (cursor-agent 2026.09.28) and `~/.cursor` otherwise.
 */
export function getCursorProjectsDir(toolRoots?: LocalConfig['toolRoots']): string {
  return path.join(toolRootDir(CURSOR_DATA_TOOL_ID, DEFAULT_CURSOR_ROOT, toolRoots), 'projects');
}

// ---------------------------------------------------------------------------
// cwd encode/decode
// ---------------------------------------------------------------------------

/**
 * Resolve cwd to its real path before encoding.
 *
 * On macOS `/tmp` is a symlink to `/private/tmp`, so the same directory has two spellings.
 * AI tools persist `process.cwd()` — the **resolved** path — so writing with the unresolved
 * spelling (for example `--target-cwd /tmp/x`) lands in a directory nobody can read back:
 * the write succeeds, but listing is empty. This matches ide-history.hashWorkspace.
 * If the path does not exist (create-pending case), fall back to the original path.
 */
export function resolveRealCwd(cwd: string): string {
  const resolved = path.resolve(cwd);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Claude Code cwd encoding: every non-alphanumeric character → `-`, with a leading `-`.
 * Example: `/home/user/project` → `-home-user-project`
 *          `/Users/foo/my project` → `-Users-foo-my-project`
 */
export function encodeCwdClaude(cwd: string): string {
  return resolveRealCwd(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * CodeBuddy / Cursor cwd encoding: every non-alphanumeric character → `-`, no leading `-`.
 * Example: `/home/user/project` → `home-user-project`
 *          `/Users/foo/my project` → `Users-foo-my-project`
 */
export function encodeCwdGeneric(cwd: string): string {
  return resolveRealCwd(cwd).replace(/[^a-zA-Z0-9]/g, '-').replace(/^-+/, '');
}

/**
 * CodeBuddy CLI cwd → directory-name encoding: replace separators and drive colons with `-`.
 *
 * The generic version above cannot be used — it turns every non-alphanumeric character
 * into `-`, while CodeBuddy itself **keeps spaces**. In practice `.../Desktop/Code/teamai cli`
 * is stored as `Users-caiwenzhe-Desktop-Code-teamai cli`. The generic version would compute
 * `...-teamai-cli`, so these workspaces never match: listing is empty and reads report
 * "file not found". Project directories that contain spaces are common.
 */
export function encodeCwdCodeBuddy(cwd: string): string {
  const encoded = resolveRealCwd(cwd)
    .replace(/[/\\:]/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
  // CodeBuddy 2.173.0: compressWorkspacePathName keeps short names unchanged,
  // truncates by UTF-8 code point, then hashes every original byte with djb2.
  if (Buffer.byteLength(encoded, 'utf8') <= 255) return encoded;
  let prefix = '';
  let bytes = 0;
  for (const point of encoded) {
    const size = Buffer.byteLength(point, 'utf8');
    if (bytes + size > 180) break;
    bytes += size;
    prefix += point;
  }
  let hash = 5381;
  for (const byte of Buffer.from(encoded, 'utf8')) hash = (hash * 33) ^ byte;
  return `${prefix}-${(hash >>> 0).toString(36)}`;
}

/**
 * Claude Code cwd decoding: cannot be restored exactly (`-` may have come from `/`, a space, and so on),
 * but the directory name itself does not need to become a usable path — it is for display only.
 * Return the original encoded string as the display cwd.
 */
export function decodeCwdClaude(encoded: string): string {
  // Cannot be reversed exactly; return encoded itself (the caller should get the real cwd from session_meta and the like)
  return encoded;
}

/**
 * Best-effort reverse of a Claude Code project directory name → real workspace path.
 *
 * Some Claude Code versions write the encoded directory name (`-Users-foo-project`) straight
 * into the cwd field of the record, so migration cannot get the real workspace: the target cwd
 * can only fall back to "the directory the command is running in", and the session is moved
 * under the wrong project. Restore it by the encoding rule (leading `-` → `/`, remaining `-` → `/`)
 * and check that it exists on disk. If the path itself contains `-` or a space, the restored
 * result will not exist; give up (return undefined).
 */
export function bestEffortDecodeCwdClaude(encoded: string): string | undefined {
  if (!encoded.startsWith('-')) return undefined;
  const candidate = '/' + encoded.slice(1).replace(/-/g, '/');
  try {
    if (!fs.existsSync(candidate)) return undefined;
    if (!fs.statSync(candidate).isDirectory()) return undefined;
    return fs.realpathSync(candidate);
  } catch {
    return undefined;
  }
}

/**
 * CodeBuddy / Cursor cwd decoding: same as above, cannot be restored exactly.
 */
export function decodeCwdGeneric(encoded: string): string {
  return encoded;
}

// ---------------------------------------------------------------------------
// Streaming JSONL read/write
// ---------------------------------------------------------------------------

const JsonlRecord = z.record(z.unknown());

export function* readJsonl(filePath: string): Generator<Record<string, unknown>> {
  let pending: string | undefined;
  let count = 0;
  for (const line of jsonlLines(filePath)) {
    if (!line.trim()) continue;
    if (pending !== undefined) {
      yield JsonlRecord.parse(JSON.parse(pending));
      count++;
    }
    pending = line;
  }
  if (pending === undefined) return;
  let value: unknown;
  try {
    value = JSON.parse(pending);
  } catch (error) {
    if (count === 0) throw error;
    return;
  }
  yield JsonlRecord.parse(value);
}

export function* readJsonlHead(filePath: string, maxLines: number): Generator<Record<string, unknown>> {
  if (maxLines <= 0) return;
  let count = 0;
  for (const record of readJsonl(filePath)) {
    yield record;
    if (++count >= maxLines) return;
  }
}

function* jsonlLines(filePath: string): Generator<string> {
  const fd = fs.openSync(filePath, 'r');
  try {
    const decoder = new StringDecoder('utf8');
    const chunk = Buffer.alloc(64 * 1024);
    let partial = '';
    for (let read = fs.readSync(fd, chunk); read > 0; read = fs.readSync(fd, chunk)) {
      const parts = (partial + decoder.write(chunk.subarray(0, read))).split('\n');
      partial = parts.pop() ?? '';
      yield* parts;
    }
    yield partial + decoder.end();
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Write a JSONL file, one object per line. Parent directories are created automatically.
 *
 * The lines go to a temp file beside the target, renamed into place, so a crash or a full disk
 * never leaves a truncated transcript a tool would read as the session.
 */
export function writeJsonl(filePath: string, records: Iterable<Record<string, unknown>>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines: string[] = [];
  for (const record of records) {
    lines.push(JSON.stringify(record));
  }
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmpPath, lines.join('\n') + '\n', { encoding: 'utf-8', flag: 'wx' });
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    fs.rmSync(tmpPath, { force: true });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

/** When the file was last modified (ISO 8601), or now when it cannot be read. */
export function fileModifiedAt(p: string): string {
  try {
    return fs.statSync(p).mtime.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

export function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function dirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Recursively scan a directory for matching files, sorted by modification time descending.
 */
export function scanFiles(rootDir: string, pattern: RegExp): string[] {
  if (!dirExists(rootDir)) return [];
  const results: string[] = [];
  const walk = (dir: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && pattern.test(entry.name)) {
        results.push(fullPath);
      }
    }
  };
  walk(rootDir);
  results.sort((a, b) => {
    try {
      return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
    } catch {
      return 0;
    }
  });
  return results;
}

// ---------------------------------------------------------------------------
// Safety boundary for archived content (untrusted input)
// ---------------------------------------------------------------------------

/** Only these extensions can be real images worth reading as local files. */
const IMAGE_FILE_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

/**
 * Whether the local `filePath` inside an image block may be read.
 *
 * A `filePath` in a team archive is untrusted input written by someone else: a forged image
 * block pointing at `~/.ssh/id_rsa` (or any readable file) would, if the write side read it,
 * stuff the file contents as base64 into the restored session — one `session resume` would
 * carry a local file out. Therefore:
 *
 * - If the session came from an archive (`metadata.untrusted`), never read local files; use only in-block data.
 * - Otherwise also require an absolute path plus an image extension, so arbitrary files are not read.
 */
export function mayReadLocalImageFile(
  session: { metadata?: Record<string, unknown> | undefined } | undefined,
  filePath?: string,
): boolean {
  if (!filePath) return false;
  if (!path.isAbsolute(filePath)) return false;
  if (!IMAGE_FILE_RE.test(filePath)) return false;
  return session?.metadata?.untrusted !== true;
}

/**
 * Collapse an arbitrary archive string into a safe file name (for on-disk names under assets/, messages/, and so on).
 *
 * Labels and message ids in an archive are controlled by the pusher. Values such as `../../foo`
 * would become path segments and write through the assets directory. Force basename only, and
 * strip separators and control characters.
 */
export function safeFileName(raw: string, fallback = 'image.png'): string {
  const base = path
    .basename(String(raw ?? '').replace(/\\/g, '/'))
    // oxlint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f<>:"|?*]/g, '_')
    .replace(/^\.+/, '_')
    .trim();
  return base || fallback;
}

/**
 * Recursively delete a directory (used by delete_session to clean up subdirectories).
 */
export function removeDirRecursive(dirPath: string): void {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {
    // ignore
  }
}
