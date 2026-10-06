/**
 * The root program's own options, which come before any subcommand
 * (`teamai -v recall …`). index.ts registers them on the root program; recall
 * adoption skips them to find the subcommand a shell call ran (#884).
 */
export const GLOBAL_OPTIONS: ReadonlyArray<readonly [flags: string, description: string]> = [
  ['--dry-run', 'Preview mode, no changes made; a command with no preview exits 1 without running'],
  ['-v, --verbose', 'Verbose output'],
];
