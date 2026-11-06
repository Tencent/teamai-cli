import type { Command } from 'commander';

/**
 * `--dry-run` promises that nothing changes. A command that does not keep that
 * promise refuses the flag instead of running for real (#900). The guard reads
 * only this allowlist, so a new command is refused until it is listed here.
 * Caches in the temporary directory (Node's compile cache, the git answers of
 * src/utils/git-answers.ts) are not something a dry run changes.
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
  'update',
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
  'session platforms',
  'session migrate',
  'session push',
  'session pull',
  'session list',
  'session show',
  'session resume',
  'session search',
  'session rollback',
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
  'codebase',
  'review',
  'ci extract-mr', // `--output` is refused below
  'codebase enrich-plan', // a step of teamai-codebase-enrich; only reads
  'codebase enrich-summary', // a step of teamai-codebase-enrich; only reads its flags
]);

/**
 * Commands that refuse `--dry-run`, with the reason. The guard refuses anything
 * not in DRY_RUN_PREVIEW; this list makes the choice explicit, and a test fails
 * on a command that is in neither.
 */
export const NO_DRY_RUN_PREVIEW = {
  digest: 'creates or refreshes the reports worktree; #900 C11',
  init: 'no preview; clones, saves config and injects hooks (single-repo: bootstraps the clone)',
  'script run': 'runs the team script, which can write files and read the terminal',
  'models add': 'writes the personal profile and its key',
  'models configure': 'writes the key or the personal profile',
  'models remove': 'deletes the personal profile and its key',
  'bind-project': 'writes the local-agent binding',
  'hooks remove': 'edits every AI tool settings file',
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
  'workflow start': 'creates a run and, with --driver local, runs its commands',
  score: 'leases judge work, runs judges, writes labels and, with --push, publishes them',
  'score plan': 'opens the scoring marks of the groups it plans',
  'score evidence': 'writes the evidence directory of a group',
  'score stage': 'runs a check and writes the stage record in the evidence directory',
  'score label': 'writes the labels of a group in its evidence directory',
  'score write': 'writes labels to local storage and closes their marks',
  'score publish': 'stages pending labels in the teamai-reports checkout its step runs in',
  'score settle': 'closes the scoring marks of a group as failed',
  'score report': 'a step of a teamai-try-scorer run; reads the labels its teamai-score steps left',
  'score subjects': 'reads the marks, whose first read carries judge attempts over into them',
  'codebase deep-enrich-plan': 'a step of a teamai-codebase-deep-enrich run; drops the AI docs a newer extract made stale',
  'codebase deep-enrich-write': 'writes a component design doc or the architecture overview',
  'codebase deep-enrich-graph': 'writes the graph docs of a codebase',
  'codebase deep-enrich-finish': 'writes the scenarios doc, the teamwiki indexes and the quality reports',
  'codebase deep-enrich-publish': 'commits and pushes the deep-enrich docs to the team repo that holds the wiki',
  'codebase enrich-write': 'a step of a teamai-codebase-enrich run; writes _manifest.json and _domains.json',
  'import scan-rules': 'a step of a teamai-import-rules run',
  'import read-candidate': 'a step of a teamai-import-learnings run',
  'import classify-reply': 'a step of a teamai-import-learnings run',
  'import write-learnings': 'writes the accepted items into the team repo or an output directory',
  'import publish-rules': 'commits and pushes the imported items to the team repo',
  'import fetch-iwiki': 'writes the downloaded pages into the run directory',
  'import publish-iwiki': 'links the pages to the teamwiki, then commits and pushes the imported items to the team repo',
  'import write-sections': 'writes external-knowledge.md or .teamai/pending-review.jsonl',
  'import fetch-mr': 'a step of a teamai-import-from-mr run',
  'import draft-mr': 'writes the draft into the run directory',
  'import publish-mr': 'publishes the accepted learnings and pushes the teamwiki it updated',
  'import finish-mr': 'a step of a teamai-import-from-mr run',
  'ci comment': 'a step of a teamai-ci-extract-mr run; posts comments on the MR (its --preview says them instead)',
  'ci write': 'a step of a teamai-ci-extract-mr run; writes and pushes the team repo (its --preview writes nothing)',
  'ci artifacts': 'a step of a teamai-ci-extract-mr run; writes learning.md into a directory',
  'import stage': 'a step of a teamai-import-from-repo run; clones into the cache and writes the staging teamwiki',
  'import publish': 'a step of a teamai-import-from-repo run; writes the teamwiki',
  'import finish-item': 'a step of a teamai-import-from-repo run; records the commit a repository was imported at',
  'import finish': 'a step of a teamai-import-from-repo run; rebuilds the teamwiki indexes and publishes them',
  'recall maintenance stale': 'a step of a teamai-draft-learning-updates run; refreshes the team checkouts it reads',
  'recall maintenance draft-context': 'a step of a teamai-draft-learning-updates run',
  'recall maintenance write-draft': 'writes a draft beside a stale entry',
  'recall maintenance draft-report': 'a step of a teamai-draft-learning-updates run',
  'recall maintenance promote-candidate': 'a step of a teamai-promote-learning run; refreshes the team checkouts and review branches it reads',
  'recall maintenance promote-category': 'a step of a teamai-promote-learning run',
  'recall maintenance promote-publish': 'pushes the promoted entry on a review branch and opens a pull request',
  'recall maintenance promote-mark': 'marks the learning promoted and publishes the mark',
  'workflow next': 'leases a step and writes the run',
  'workflow report': 'writes the reported step outcome',
  'workflow respond': 'writes a HITL request answer',
  'workflow retry': 'reopens steps and writes a new revision',
  'workflow cancel': 'cancels steps or the run',
  'workflow resume': 'runs the local driver and writes the run',
  'workflow publish': 'writes the run to teamai-reports',
  'benchmark check': 'puts back the protected paths, writes the files check.add names and runs the check in its clone',
  'benchmark run': 'creates a benchmark run and runs its trials on the local driver',
  'benchmark try': 'runs a task\'s check in a scratch clone of its starting commit',
  'benchmark plan': 'fills the commit cache with the commits the suite\'s trials read',
  'benchmark report': 'writes the run\'s benchmark record and publishes it to teamai-reports',
  'self-improvement run': 'creates a self-improvement run, whose steps clone the team repo, edit it and open a pull request',
} satisfies Readonly<Record<string, string>>;

/** The refusal printed when a command has no `--dry-run` preview. */
export function noDryRunPreview(command: string): string {
  return `teamai ${command} has no --dry-run preview, nothing was run`;
}

/** The refusal for running `command` with `--dry-run`, or undefined when its dry run may go ahead. */
export function dryRunRefusal(command: Command): string | undefined {
  const names: string[] = [];

  for (let current: Command | null = command; current?.parent; current = current.parent) names.unshift(current.name());
  const path = names.join(' ');

  if (path === 'ci extract-mr' && command.opts().output !== undefined) return noDryRunPreview('ci extract-mr --output');

  if (path === 'import') {
    const opts = command.opts();

    // Match importCmd's source precedence. #960 made --from-org preview-safe.
    if (!opts.fromOrg && !opts.fromRepo && !opts.fromRepoList) {
      // Each classifies with the AI tool and asks a person about each item before anything could be previewed.
      if (opts.fromIwiki) return noDryRunPreview('import --from-iwiki');

      if (!opts.fromMr && !opts.dir && opts.fromTools) return noDryRunPreview('import --from-tools');

      if (!opts.fromMr && !opts.dir && opts.fromClaude) return noDryRunPreview('import --from-claude');
    }
  }

  return DRY_RUN_PREVIEW.has(path) ? undefined : noDryRunPreview(path);
}
