/**
 * A command step's `writes`: the paths, relative to the checkout it runs in read-only, under which a change it makes is
 * kept rather than failing it `read_only_dirty`. Pull checks each path as written; the driver checks it again once its
 * template rendered, since an input may name any path.
 */
import path from 'node:path';

/** Whether `written` names a path inside the checkout: not empty, not absolute, and not leaving it with `..`. */
function isCheckoutPath(written: string): boolean {
  const slashed = written.replaceAll('\\', '/');
  const normalized = path.posix.normalize(slashed);

  return slashed.trim() !== '' && !path.posix.isAbsolute(slashed) && !/^[A-Za-z]:/.test(slashed) && normalized !== '..' && !normalized.startsWith('../');
}

/** Whether a repository path `changed`, as git status names it, is under one of `writes`. A path outside the checkout keeps nothing. */
function keeps(writes: readonly string[], changed: string): boolean {
  return writes.filter(isCheckoutPath).some((written) => {
    const under = path.posix.normalize(written.replaceAll('\\', '/')).replace(/\/+$/, '');

    return under === '.' || changed === under || changed.startsWith(`${under}/`);
  });
}

export const Writes = { isCheckoutPath, keeps } as const;
