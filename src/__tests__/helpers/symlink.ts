import fs from 'node:fs';

/**
 * Create a symlink, reporting false instead of failing where the platform
 * forbids it (creating symlinks needs privileges on Windows; a test that
 * needs one has nothing to assert there).
 */
export function trySymlink(target: string, linkPath: string): boolean {
  try {
    fs.symlinkSync(target, linkPath);
    return true;
  } catch {
    return false;
  }
}
