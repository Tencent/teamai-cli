/**
 * A small glob matcher for the rule `paths:` → code page `source:` matching
 * (#1563 part 1). There is deliberately no dependency for this: the patterns
 * are gitignore-style and small — `*` within a segment, `?` for one
 * character, `**` as a whole segment crossing any depth, `{a,b}` alternation
 * expanded by the caller. Paths are posix; matching is case-sensitive, as
 * repository paths are on the systems members sync to.
 */

/** `segment` matches the single path segment `glob` (`*`, `?`, everything else literal). */
function matchSegment(glob: string, segment: string): boolean {
  const pattern = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${pattern}$`).test(segment);
}

/**
 * `path` matches `glob`. A leading `./` or `/` on the glob is ignored.
 * A trailing `/**` also matches the directory itself (zero segments after
 * `**`), mirroring how `src/ledger/**` covers every file under it.
 */
export function matchGlob(glob: string, path: string): boolean {
  const globSegments = glob.replace(/^\.?\//, '').split('/').filter((s) => s !== '');
  const pathSegments = path.replace(/^\.?\//, '').split('/').filter((s) => s !== '');
  const match = (gi: number, pi: number): boolean => {
    if (gi === globSegments.length) return pi === pathSegments.length;
    if (globSegments[gi] === '**') {
      // `**` crosses any number of segments, including zero; try every split
      // so backtracking finds a match however deep the rest of the pattern
      // needs to go.
      for (let skip = pi; skip <= pathSegments.length; skip++) {
        if (match(gi + 1, skip)) return true;
      }
      return false;
    }
    if (pi === pathSegments.length) return false;
    return matchSegment(globSegments[gi], pathSegments[pi]) && match(gi + 1, pi + 1);
  };
  return match(0, 0);
}
