/** @import { Context } from '@oxlint/plugins' */
import fs from 'node:fs';
import path from 'node:path';

/**
 * The linted file's path with `/` separators, so a rule can scope itself on any platform.
 * @param {Context} context
 * @returns {string}
 */
export function lintedPath(context) {
  return context.filename.split('\\').join('/');
}

/**
 * Whether the linted file is one of `files`, given relative to the repository root.
 * @param {Context} context
 * @param {readonly string[]} files
 * @returns {boolean}
 */
export function isOneOf(context, files) {
  const file = lintedPath(context);
  return files.some((relative) => file.endsWith(`/${relative}`));
}

/** @type {Map<string, string | undefined>} */
const packageRoots = new Map();

/**
 * The nearest directory at or above `dir` holding a `package.json`.
 * @param {string} dir
 * @returns {string | undefined}
 */
function packageRoot(dir) {
  if (packageRoots.has(dir)) return packageRoots.get(dir);
  const parent = path.posix.dirname(dir);
  const root = fs.existsSync(`${dir}/package.json`) ? dir : parent === dir ? undefined : packageRoot(parent);
  packageRoots.set(dir, root);
  return root;
}

/**
 * Whether the linted file is production source: under `src/` of its package, outside `src/__tests__/`.
 * Measured from the package root, so a checkout cloned under some `src/` directory keeps `scripts/` out.
 * @param {Context} context
 * @returns {boolean}
 */
export function inProductionSource(context) {
  const file = lintedPath(context);
  const root = packageRoot(path.posix.dirname(file));
  const relative = root === undefined ? file : path.posix.relative(root, file);
  return relative.startsWith('src/') && !relative.startsWith('src/__tests__/');
}
