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
 * The linted file's path from its package root, so a checkout cloned under some `src/` directory keeps `scripts/` out.
 * @param {Context} context
 * @returns {string}
 */
export function sourcePath(context) {
  const file = lintedPath(context);
  const root = packageRoot(path.posix.dirname(file));
  return root === undefined ? file : path.posix.relative(root, file);
}

/**
 * Whether the linted file is production source: under `src/` of its package, outside `src/__tests__/`.
 * @param {Context} context
 * @returns {boolean}
 */
export function inProductionSource(context) {
  const relative = sourcePath(context);
  return relative.startsWith('src/') && !relative.startsWith('src/__tests__/');
}

/**
 * The repository files a rule is scoped to. A rename throws when lint loads the rule, instead of leaving it guarding nothing.
 * @param {readonly string[]} files relative to the repository root
 * @returns {readonly string[]}
 */
export function scopedFiles(files) {
  const missing = files.filter((file) => !fs.existsSync(new URL(`../${file}`, import.meta.url)));
  if (missing.length > 0) throw new Error(`Lint rule scope file missing: ${missing.join(', ')}. Point the rule at the file's new path.`);
  return files;
}
