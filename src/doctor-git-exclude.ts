import path from 'node:path';
import { loadStateForScope } from './config.js';
import type { Check, DoctorContext } from './doctor.js';
import type { DamagedMarker, GitExcludeReport } from './git-exclude.js';
import {
  describeForeign, describeUnreadableGitExcludeSetting, deliveredUnion, reportDeliveredGitExclude, type DeliveredUnion,
} from './git-exclude-delivered.js';
import { localAgentGitExcludeNotices, readGitExcludeNotices, type GitExcludeNotices } from './git-exclude-notices.js';
import { getDataHome, isUnmigratedDataHome, resolveGitExclude } from './types.js';
import { execCommand } from './utils/exec.js';
import { withoutGitRepositoryEnv } from './utils/git-env.js';

// ─── doctor: teamai's delivered git exclude blocks (#915) ──────
//
//  Whether what pull delivered into the project is kept out of git as the
//  resolved `sharing.gitExclude` says, read-only: no lock file, no `info/`.
//  Failing checks (also after an interactive pull) for what a pull should
//  have fixed; information lines (`doctor` only) for what no pull changes.

/** What doctor learns about the blocks, once per run (checks and notes share it). */
interface Inspection {
  projectRoot: string;
  /** `undefined`: the team's teamai.yaml could not be read, and no override decides (resolveGitExclude). */
  enabled: boolean | undefined;
  /** Where the resolved setting comes from, as a member reads it. */
  source: string;
  /** The partition config holding the member's override. */
  configPath: string;
  /** The un-migrated data home, when this checkout still uses one. */
  unmigrated: string | null;
  union: DeliveredUnion;
  reports: GitExcludeReport[];
  notices: GitExcludeNotices;
  /** Copies a removal pass keeps because the repository tracks them. */
  keptTracked: string[];
}

const inspections = new WeakMap<DoctorContext, Promise<Inspection | null>>();

function inspect(ctx: DoctorContext): Promise<Inspection | null> {
  let found = inspections.get(ctx);
  if (!found) inspections.set(ctx, found = inspectOnce(ctx));
  return found;
}

async function inspectOnce(ctx: DoctorContext): Promise<Inspection | null> {
  const { localConfig, teamConfig } = ctx;
  const projectRoot = localConfig.projectRoot;
  if (localConfig.scope !== 'project' || !projectRoot) return null;
  const dataHome = getDataHome(localConfig);
  const configPath = path.join(dataHome, 'config.yaml');
  const unmigrated = isUnmigratedDataHome(localConfig);
  // Not read on that layout (isGitExcludeEnabled).
  const member = unmigrated ? undefined : localConfig.gitExcludeEnabled;
  const team = teamConfig?.sharing?.gitExclude?.enabled;
  const enabled = resolveGitExclude(localConfig, teamConfig);
  const source = member !== undefined ? `gitExcludeEnabled: ${member} in ${configPath}`
    : team !== undefined ? `sharing.gitExclude.enabled: ${team} in the team's teamai.yaml`
    : enabled === undefined ? 'team config unreadable'
    : 'the default';
  const state = await loadStateForScope(localConfig);
  const records = state.lastPullByWorkspace ?? {};
  // No list anywhere yet (no pull since an upgrade): nothing is delivered on record.
  const listed = Object.values(records).some((record) => record.gitExcludePaths !== undefined);
  const { checkoutKey, liveDeliveredLists } = await import('./pull.js');
  const union = listed
    ? await deliveredUnion(await liveDeliveredLists(projectRoot, records))
    : { paths: [], foreign: [] };
  const own = records[await checkoutKey(projectRoot)];
  return {
    projectRoot,
    enabled,
    source,
    configPath,
    unmigrated: unmigrated ? dataHome : null,
    union,
    reports: await reportDeliveredGitExclude(localConfig, union.paths),
    notices: await readGitExcludeNotices(localConfig),
    keptTracked: own?.gitExcludePaths ? await keptTrackedCopies(projectRoot, own.delivered ?? {}, Object.values(own.gitExcludePaths).flat()) : [],
  };
}

/**
 * Files on this checkout's record that it no longer lists as delivered,
 * unchanged since teamai wrote them and tracked by git: the copies a removal
 * pass keeps, because deleting them would change the repository. One
 * `ls-files` for all of them.
 */
async function keptTrackedCopies(projectRoot: string, delivered: Record<string, string>, listed: string[]): Promise<string[]> {
  const { recordedUnchanged } = await import('./resources/delivered-copies.js');
  const covered = (file: string): boolean => listed.some((p) => file === p || file.startsWith(`${p}${path.sep}`));
  const candidates: string[] = [];
  for (const file of Object.keys(delivered)) {
    if (!covered(file) && await recordedUnchanged(delivered, file)) candidates.push(file);
  }
  const inside = candidates.filter((file) => !path.relative(projectRoot, file).startsWith('..'));
  if (inside.length === 0) return [];
  const result = await execCommand('git', ['--literal-pathspecs', 'ls-files', '-z', '--', ...inside.map((file) => path.relative(projectRoot, file))], {
    cwd: projectRoot, timeoutMs: 10_000, env: withoutGitRepositoryEnv(),
  }).catch(() => null);
  if (result?.code !== 0) return [];
  const tracked = new Set(result.stdout.split('\0').filter(Boolean));
  // A skill is kept, and named, as its directory (`<tool>/skills/<name>`), as pull names it.
  const named = (file: string): string => {
    for (let dir = path.dirname(file); dir.startsWith(`${projectRoot}${path.sep}`); dir = path.dirname(dir)) {
      if (path.basename(path.dirname(dir)) === 'skills') return dir;
    }
    return file;
  };
  return [...new Set(inside.filter((file) => tracked.has(path.relative(projectRoot, file).split(path.sep).join('/'))).map(named))].sort();
}

const FIRST = 5;

function nameList(items: string[]): string {
  return items.length > FIRST ? `${items.slice(0, FIRST).join(', ')} (first ${FIRST} of ${items.length})` : items.join(', ');
}

function damagedLine(file: string, { line, problem }: DamagedMarker): string {
  switch (problem) {
    case 'unclosed':
      return `${file} line ${line} starts teamai's block with no end marker, so teamai leaves that line and the ones after it to you: delete it, then run \`teamai pull\`.`;
    case 'unopened':
      return `${file} line ${line} ends teamai's block with no start marker: delete it, then run \`teamai pull\`.`;
    case 'duplicate':
      return `${file} holds teamai's block twice, from line ${line}: \`teamai pull\` merges them.`;
  }
}

/**
 * Doctor's checks of the blocks: while `sharing.gitExclude` is on, that every
 * delivered path is listed and ignored and that no other checkout's own file
 * holds a line back; whatever the setting, the last failure a background pull
 * kept. Run after interactive pulls too.
 */
export async function buildDeliveredGitExcludeChecks(ctx: DoctorContext): Promise<Check[]> {
  let found: Inspection | null;
  try {
    found = await inspect(ctx);
  } catch (e) {
    return [{
      name: 'Delivered team resources are kept out of git',
      source: 'local',
      check: async () => false,
      fix: `teamai could not check its git exclude blocks: ${e instanceof Error ? e.message : String(e)}. Fix the cause, then run \`teamai doctor\` again.`,
    }];
  }
  if (!found) return [];
  const { projectRoot, enabled, union, reports, notices } = found;
  const checks: Check[] = [];
  const rel = (file: string): string => {
    const relative = path.relative(projectRoot, file);
    return relative.startsWith('..') || path.isAbsolute(relative) ? file : relative.split(path.sep).join('/');
  };
  if (enabled === undefined) {
    checks.push({
      name: 'Delivered team resources are kept out of git',
      source: 'local',
      reportedByPull: 'git-exclude-sync',
      check: async () => false,
      fix: describeUnreadableGitExcludeSetting(ctx.localConfig),
    });
  }
  if (enabled) {
    const problems: string[] = [];
    for (const r of reports) {
      for (const { path: file, error } of r.gitFailed) problems.push(`git could not place ${rel(file)}: ${error}.`);
      for (const file of r.files) {
        if (file.notReadable) problems.push(`${file.notReadable}: teamai cannot check or update its block there. Make it readable, then run \`teamai pull\`.`);
        if (file.missing.length > 0) problems.push(`Not listed in ${file.excludeFile}: ${nameList(file.missing.map(rel))}. Run \`teamai pull\` to list them.`);
        for (const { path: file2, rule } of file.reincluded) {
          problems.push(rule
            ? `git still sees ${rel(file2)}: \`${rule.pattern}\` (${rule.source}:${rule.line}) re-includes it. Remove that rule.`
            : `git still sees ${rel(file2)}: a rule in your git ignore files re-includes it (\`git check-ignore -v\` names it). Remove that rule.`);
        }
        for (const damaged of file.damaged) problems.push(damagedLine(file.excludeFile, damaged));
        for (const { checkout, error } of file.checkFailed) problems.push(`git could not say what ${checkout} tracks or ignores: ${error}.`);
      }
    }
    checks.push({
      name: 'Delivered team resources are kept out of git',
      source: 'local',
      reportedByPull: 'git-exclude-sync',
      check: async () => problems.length === 0,
      fix: problems.join(' '),
    });
    const foreign = describeForeign(union.foreign);
    checks.push({
      name: 'No other checkout\'s own file leaves a delivered path visible to git',
      source: 'local',
      reportedByPull: 'git-exclude-foreign',
      check: async () => foreign.length === 0,
      fix: foreign.join(' ') + (union.foreign.some((path) => !path.unlisted)
        ? ' Rename or delete that file if it is a leftover; then the next `teamai pull` lists the path.' : ''),
    });
  }
  if (notices.lastFailure) {
    checks.push({
      name: 'Last background pull could not keep teamai\'s git exclude blocks up to date',
      source: 'local',
      reportedByPull: 'git-exclude-failure',
      check: async () => false,
      fix: `${notices.lastFailure.message} (${notices.lastFailure.at})`,
    });
  }
  return checks;
}

/**
 * The last failure the local agent's sessions kept for their `local-agent`
 * block, in its state home whatever the scope: one file read, no git.
 */
export async function buildLocalAgentGitExcludeChecks(): Promise<Check[]> {
  const { lastFailure } = await readGitExcludeNotices(localAgentGitExcludeNotices());
  return lastFailure ? [{
    name: 'Last local agent sync could not keep its git exclude block up to date',
    source: 'local',
    reportedByPull: 'local-agent-git-exclude-failure',
    check: async () => false,
    fix: `${lastFailure.message} (${lastFailure.at})`,
  }] : [];
}

/** What the local agent's sessions had to say about its `local-agent` block, for `doctor` only. */
export async function localAgentGitExcludeNotes(): Promise<string[]> {
  const { notices } = await readGitExcludeNotices(localAgentGitExcludeNotices());
  return notices.map(({ at, message }) => `From a local agent sync (${at}): ${message}`);
}

/**
 * Information lines for `doctor` only: where the setting comes from, an
 * un-migrated layout, what git would see while the setting is off, and what
 * no pull changes (tracked delivered paths, stale lines, copies kept because
 * the repository tracks them, what background pulls had to say).
 */
export async function deliveredGitExcludeNotes(ctx: DoctorContext): Promise<string[]> {
  const found = await inspect(ctx).catch(() => null);
  if (!found) return [];
  const { projectRoot, enabled, source, configPath, unmigrated, reports, notices, keptTracked } = found;
  const rel = (file: string): string => {
    const relative = path.relative(projectRoot, file);
    return relative.startsWith('..') || path.isAbsolute(relative) ? file : relative.split(path.sep).join('/');
  };
  const notes = [`Git exclude for delivered team resources: ${enabled === undefined ? 'unknown' : enabled ? 'on' : 'off'}, from ${source}.`];
  if (unmigrated) {
    notes.push(`This checkout keeps teamai's data in ${unmigrated}, an un-migrated layout, so its \`gitExcludeEnabled\` is not read: `
      + 'the setting comes from the team\'s teamai.yaml or the default until a pull migrates the data.');
  }
  const files = reports.flatMap((r) => r.files);
  if (enabled === false) {
    const visible = [...new Set(files.flatMap((f) => f.visible))].map(rel);
    if (visible.length > 0) {
      notes.push(`Delivered team resources are visible to git: ${visible.length} untracked (first ${FIRST}: ${visible.slice(0, FIRST).join(', ')}). `
        + `To keep them out of git, set \`sharing.gitExclude.enabled: true\` in teamai.yaml (the whole team)${unmigrated ? '' : ` or \`gitExcludeEnabled: true\` in ${configPath} (only you)`}, then run \`teamai pull\`.`);
    }
  } else if (enabled) {
    for (const file of files) {
      for (const { path: tracked, checkout } of file.tracked) {
        notes.push(`${rel(tracked)} is delivered by teamai, but git tracks it in ${checkout}, so teamai lists no line for it. `
          + `Run \`git rm --cached ${path.relative(checkout, tracked).split(path.sep).join('/')}\` there and commit if the repository should not hold it.`);
      }
      if (file.stale.length > 0) notes.push(`Stale lines in teamai's delivered git exclude block in ${file.excludeFile}: ${nameList(file.stale)}. The next \`teamai pull\` drops them.`);
    }
  }
  for (const kept of keptTracked) {
    notes.push(`Kept ${kept}: this repository tracks it, so teamai does not delete it. Run \`git rm -r ${kept}\` and commit if the repository no longer needs it.`);
  }
  for (const { at, message } of notices.notices) notes.push(`From a background pull (${at}): ${message}`);
  return notes;
}
