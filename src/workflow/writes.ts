/**
 * A command step's `writes`: the paths under which a change it makes in the checkout it runs in read-only is kept
 * rather than failing it `read_only_dirty`. Pull checks each path as written, relative to the checkout; the driver
 * checks it again once its template rendered, since an input may name any path, an absolute one included.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Whether `written` names a path inside the checkout: not empty, not absolute, and not leaving it with `..`. */
function isCheckoutPath(written: string): boolean {
  const slashed = written.replaceAll('\\', '/');
  const normalized = path.posix.normalize(slashed);

  return slashed.trim() !== '' && !path.posix.isAbsolute(slashed) && !/^[A-Za-z]:/.test(slashed) && normalized !== '..' && !normalized.startsWith('../');
}

/** Whether a rendered `writes` template gives a path a step may write: one inside the checkout, or an absolute one. */
function isRenderedPath(written: string): boolean {
  return isCheckoutPath(written) || path.isAbsolute(written);
}

/**
 * `writes` relative to the checkout `dir`, as git status names its changes: an absolute path inside it becomes
 * relative, and one outside it is dropped, since nothing written there can dirty the checkout.
 */
function inCheckout(writes: readonly string[], dir: string): string[] {
  const real = (place: string): string => {
    try {
      return fs.realpathSync(place);
    } catch {
      return place;
    }
  };

  const checkout = real(dir);

  return writes.flatMap((written) => {
    if (!path.isAbsolute(written)) return [written];
    const relative = path.relative(checkout, real(written));

    if (relative === '') return ['.'];

    return relative.startsWith('..') || path.isAbsolute(relative) ? [] : [relative.replaceAll('\\', '/')];
  });
}

/** Whether a repository path `changed`, as git status names it, is under one of `writes`. A path outside the checkout keeps nothing. */
function keeps(writes: readonly string[], changed: string): boolean {
  return writes.filter(isCheckoutPath).some((written) => {
    const under = path.posix.normalize(written.replaceAll('\\', '/')).replace(/\/+$/, '');

    return under === '.' || changed === under || changed.startsWith(`${under}/`);
  });
}

export const Writes = { isCheckoutPath, isRenderedPath, inCheckout, keeps } as const;
