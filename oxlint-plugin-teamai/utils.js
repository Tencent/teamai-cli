/** @import { Context } from '@oxlint/plugins' */

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
