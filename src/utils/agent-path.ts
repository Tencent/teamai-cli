/**
 * Paths as agents write them and recall prints them (#884), compared the same
 * way on every OS. On Windows one file is `C:\kb\x.md`, `c:/kb/x.md` or Git
 * Bash's `/c/kb/x.md`, whatever platform runs the comparison. Nothing here
 * reads the disk or depends on the host's `path` flavour, and a path is
 * normalized only to compare it, never where it is recorded or shown.
 */
import path from 'node:path';

/** A drive-lettered path: `C:\…` or `C:/…`. */
const DRIVE = /^[A-Za-z]:[\\/]/;

/** Whether `p` is absolute on either platform: `/…`, `\…`, `C:\…` or `C:/…`. */
export function isAbsolutePath(p: string): boolean {
  return path.win32.isAbsolute(p);
}

/** The `path` flavour of `p`'s own platform: Windows for a drive-lettered or backslash-rooted path. */
function flavourOf(p: string): path.PlatformPath {
  return DRIVE.test(p) || p.startsWith('\\') ? path.win32 : path.posix;
}

/**
 * `file` resolved against `base`: an absolute path normalized in its own
 * platform's form (Git Bash's `/c/…` stays as written), a relative one
 * resolved against `base` in base's form, or left as written with no base.
 */
export function resolvePath(file: string, base?: string): string {
  if (isAbsolutePath(file)) return flavourOf(file).normalize(file);

  return base ? flavourOf(base).resolve(base, file) : file;
}

/**
 * `p` in one form, for comparison only: `/` separators, a Git Bash drive
 * (`/c/…`) as its letter (`c:/…`), `.` and `..` collapsed, and no trailing
 * separator. A drive-lettered path is lowercased whole, as Windows paths
 * ignore case.
 */
export function pathKey(p: string): string {
  const slashed = p.replace(/\\/g, '/').replace(/^\/([A-Za-z])(?:\/|$)/, '$1:/');
  const key = path.posix.normalize(/^[A-Za-z]:/.test(slashed) ? slashed.toLowerCase() : slashed);

  return key.length > 1 && key.endsWith('/') && !/^[a-z]:\/$/.test(key) ? key.slice(0, -1) : key;
}

/**
 * One OMP `read` selector: a line range list (`50`, `50-200`, `50-`, `50+150`,
 * `L50..60`, `5-16,960-973`), a tail (`-60`), or a view (`raw`, `conflicts`,
 * `img`). The grammar of OMP's own path splitter (`splitPathAndSel`).
 */
const RANGE = String.raw`L?\d+(?:(?:\.\.|[-+])L?\d*)?(?<=[\d.-])`;
const RANGES = `${RANGE}(?:,${RANGE})*`;
const SELECTOR = new RegExp(`^(?:${RANGES}|-\\d+|raw|conflicts|img)$`, 'i');
const RANGE_ONLY = new RegExp(`^(?:${RANGES}|-\\d+)$`, 'i');

/**
 * `p` without the selector an OMP `read` path can carry inline (`x.md:50-200`,
 * `x.md:raw`, `x.md:1-50:raw`, `x.md:raw:1-50`), as OMP splits it. A drive
 * letter's colon (`C:\kb\x.md`) is never a selector's.
 */
export function withoutReadSelector(p: string): string {
  const split = (s: string): [string, string] | undefined => {
    const colon = s.lastIndexOf(':');
    const floor = /^[A-Za-z]:/.test(s) ? 1 : 0;

    return colon > floor ? [s.slice(0, colon), s.slice(colon + 1)] : undefined;
  };

  const outer = split(p);

  if (!outer || !SELECTOR.test(outer[1])) return p;
  const inner = split(outer[0]);
  const raw = (chunk: string) => chunk.toLowerCase() === 'raw';

  if (inner && ((raw(inner[1]) && RANGE_ONLY.test(outer[1])) || (RANGE_ONLY.test(inner[1]) && raw(outer[1])))) return inner[0];

  return outer[0];
}

/** Whether `a` and `b` name the same file, each written on either platform. */
export function samePath(a: string, b: string): boolean {
  return isAbsolutePath(a) === isAbsolutePath(b) && pathKey(a) === pathKey(b);
}

/** Whether `file` is `dir` or lies under it; both absolute. */
export function isWithin(file: string, dir: string): boolean {
  const f = pathKey(file);
  const d = pathKey(dir);

  return f === d || f.startsWith(d.endsWith('/') ? d : `${d}/`);
}
