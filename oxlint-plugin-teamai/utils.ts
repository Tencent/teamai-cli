import type { Context } from '@oxlint/plugins';

/** The linted file's path with `/` separators, so a rule can scope itself on any platform. */
export function lintedPath(context: Context): string {
  return context.filename.split('\\').join('/');
}

/** Whether the linted file is one of `files`, given relative to the repository root. */
export function isOneOf(context: Context, files: readonly string[]): boolean {
  const file = lintedPath(context);
  return files.some((relative) => file.endsWith(`/${relative}`));
}
