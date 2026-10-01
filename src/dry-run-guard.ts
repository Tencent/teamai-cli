import type { Command } from 'commander';

/**
 * `--dry-run` promises that nothing changes. A command that does not keep that
 * promise refuses the flag instead of running for real (#900). The guard reads
 * only this allowlist, so a new command is refused until it is listed here.
 *
 * Keyed by full command path: leaf names collide (`add`, `remove`, `init`).
 * A path belongs here when its action honors `--dry-run` (forwards it and
 * guards its writes) or only reads.
 */
export const DRY_RUN_PREVIEW: ReadonlySet<string> = new Set([
  'remove',
  'push',
  'pull',
  'status',
  'list',
  'skill',
  'skill list',
  'skill get',
  'skill path',
  'skill show',
  'skill exclude',
  'skill exclude list',
  'skill exclude add',
  'skill exclude remove',
  'members',
  'members list',
  'packages',
  'packages install',
  'doctor',
  'roles',
  'roles list',
  'roles init',
  'roles add',
  'roles remove',
  'roles update',
  'roles set',
  'projects',
  'projects list',
  'projects add',
  'projects update',
  'projects remove',
  'projects set',
  'projects members',
  'tags',
  'tags list',
  'tags subscribe',
  'tags unsubscribe',
  'tags add',
  'tags remove',
  'source',
  'source add',
  'source remove',
  'source add-http',
  'source remove-http',
  'source list',
  'source browse',
  'uninstall',
  'env',
  'env list',
  'env add',
  'env remove',
  'env set',
  'env unset',
  'env exec',
  'hooks list',
  'hooks inject',
  'mcp list',
  'mcp inject',
  'mcp remove',
  'webhook list',
  'webhook test',
  'models list',
  'models switch',
  'models restore',
  'session save',
  'contribute',
  'stats',
  'recall',
  'recall feedback',
  'recall disable',
  'recall enable',
  'recall status',
  'recall maintenance',
  'recall promote',
  'import', // source-specific refusals below
  'codebase', // `--extract` is refused below
  'review',
  'ci extract-mr', // `--output` is refused below
]);

/**
 * Commands that refuse `--dry-run`, with the reason. The guard refuses anything
 * not in DRY_RUN_PREVIEW; this list makes the choice explicit, and a test fails
 * on a command that is in neither.
 */
export const NO_DRY_RUN_PREVIEW: Readonly<Record<string, string>> = {
  digest: 'creates or refreshes the reports worktree; #900 C11',
  init: 'no preview; clones, saves config and injects hooks (single-repo: bootstraps the clone)',
  'models add': 'writes the personal profile and its key',
  'models configure': 'writes the key or the personal profile',
  'models remove': 'deletes the personal profile and its key',
  'bind-project': 'writes the local-agent binding',
  'hooks remove': 'edits every AI tool settings file',
  update: 'no preview until #951 lands',
  dashboard: 'a long-running server that creates its events file',
  'deep-enrich': 'hidden; writes the docs that `codebase --deep-enrich` previews',
  // Hidden commands that hooks run, never with --dry-run.
  'source reconcile-plugins': 'hook-only',
  track: 'hook-only',
  'track-slash': 'hook-only',
  'dashboard-report': 'hook-only',
  'hook-dispatch': 'hook-only',
  'contribute-check': 'hook-only',
  'todowrite-hint': 'hook-only',
  'mr-hint': 'hook-only',
};

/** The refusal printed when a command has no `--dry-run` preview. */
export function noDryRunPreview(command: string): string {
  return `teamai ${command} has no --dry-run preview, nothing was run`;
}

/** The refusal for running `command` with `--dry-run`, or undefined when its dry run may go ahead. */
export function dryRunRefusal(command: Command): string | undefined {
  const names: string[] = [];
  for (let current: Command | null = command; current?.parent; current = current.parent) names.unshift(current.name());
  const path = names.join(' ');
  if (path === 'codebase' && command.opts().extract !== undefined) return noDryRunPreview('codebase --extract');
  if (path === 'ci extract-mr' && command.opts().output !== undefined) return noDryRunPreview('ci extract-mr --output');
  if (path === 'import') {
    const opts = command.opts();
    // Match importCmd's source precedence. #960 made --from-org preview-safe.
    if (!opts.fromOrg && !opts.fromRepo && !opts.fromRepoList) {
      if (opts.fromIwiki) return noDryRunPreview('import --from-iwiki'); // persists the review session
      if (!opts.fromMr && !opts.dir && opts.fromClaude) return noDryRunPreview('import --from-claude'); // persists the review session
    }
  }
  return DRY_RUN_PREVIEW.has(path) ? undefined : noDryRunPreview(path);
}
