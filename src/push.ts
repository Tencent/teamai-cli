import path from 'node:path';
import YAML from 'yaml';
import { autoDetectInit, loadStateForScope, saveStateForScope } from './config.js';
import { assertNotReadOnly } from './read-only.js';
import {
  createGit, pullRepo, pushRepoBranch, checkoutMaster, generateBranchName,
  resetToCleanMaster, isDedicatedRepoRoot, getDefaultBranch, getFileContentAtRev, getHeadCommit,
} from './utils/git.js';
import { reconcilePlacementRecords,
  findPendingForItem, partiallySelectedEntries, pendingNamespaceFor, planPushGroups,
  prunePendingPushes, recordPendingPush, toPendingItems, type PushGroup,
} from './utils/pending-push.js';
import { syncTeamUpdatesToLocal } from './utils/pre-push-sync.js';
import { getProvider } from './providers/index.js';
import { log, spinner } from './utils/logger.js';
import { getHandler } from './resources/index.js';
import { scanTeamRepoNamespaces } from './resources/skills.js';
import type {
  GlobalOptions, ResourceItem, ResourceType, LocalConfig, TeamaiConfig, State,
} from './types.js';
import { getDataHome, SELF_KNOWLEDGE_SCAN_KEY, SYNC_LOCK_FILENAME } from './types.js';
import { acquireLock, releaseLock } from './update.js';
import { assertSafePath, assertSafeResourceName, defaultAllowedRoots } from './utils/path-safety.js';
import { loadRolesManifest, resolveRoleResourceNamespaces, RolesManifestNotFoundError } from './roles.js';
import type { ProjectsManifest } from './projects.js';
import { isSafeNamespaceSegment } from './projects.js';
import {
  isAtSharedRoot, isPlaceableType, NAMESPACE_AXIS, PLACEABLE_TYPES, resolveProjectNamespace,
  skillNamespacePath, withNamespace, type PlaceableType,
} from './push-namespaces.js';
import { askQuestion, askSelection, isInteractive } from './utils/prompt.js';
import { pathExists, pruneEmptyDirs, readFileSafe, writeFile } from './utils/fs.js';

/**
 * Filter a list of repo-root-relative paths (e.g. "rules/", "env/") down to
 * those that actually exist on disk. `git add` throws `pathspec did not match
 * any files` when any argument doesn't exist, so we guard against that when
 * passing "sweeper" directories that may or may not be present in a given
 * team repo (e.g. a pure-wiki team has no rules/ or env/).
 */
export async function filterExistingTopLevelPaths(
  repoPath: string,
  candidates: string[],
): Promise<string[]> {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const trimmed = candidate.replace(/\/+$/, '');
    // Empty string (e.g. from "/" only) is nonsense; skip.
    if (!trimmed) continue;
    if (await pathExists(path.join(repoPath, trimmed))) {
      result.push(candidate);
    }
  }
  return result;
}

/** Candidate namespaces, or why the question could not be answered. */
type CandidateResolution =
  | { ok: true; candidates: string[] }
  | { ok: false; message: string };

/**
 * The namespaces this user could push a new `type` into, on that type's own
 * axis: the deduplicated list from the roles manifest, or — for skills, which
 * are the only type with a detector — the namespace directories the team repo
 * already has.
 *
 * A manifest that EXISTS but cannot answer — unparseable, or missing the role
 * this directory is configured with — is a failure, not an empty list. Falling
 * back on it would place a new rule or agent at the shared root, which sends it
 * to the whole team: the exact widening #649 is about, and one the user never
 * asked for. A manifest that is ABSENT is the pre-manifest convention instead,
 * where the shared root is the team's actual layout, so it keeps the legacy
 * fallback and the loud warning that goes with it.
 */
async function namespaceCandidates(
  type: PlaceableType,
  localConfig: LocalConfig,
): Promise<CandidateResolution> {
  if (localConfig.primaryRole) {
    try {
      const manifest = await loadRolesManifest(localConfig.repo.localPath);
      const namespaces = resolveRoleResourceNamespaces({
        manifest,
        primaryRole: localConfig.primaryRole,
        additionalRoles: localConfig.additionalRoles ?? [],
      });
      const axis = NAMESPACE_AXIS[type];
      const candidates = namespaces[axis];
      // A namespace is ONE directory under the resource root. `--role` and the
      // projects manifest are both checked for that; the roles manifest was
      // not, so `foo/bar` went through and pushed an agent to a depth `pull`
      // never looks at, and a rule whose namespace then read back as `foo`.
      const unsafe = candidates.find((namespace) => !isSafeNamespaceSegment(namespace));
      if (unsafe !== undefined) {
        return {
          ok: false,
          message: `The roles manifest declares an unusable ${axis} namespace "${unsafe}": `
            + "it must be a single path segment (letters, digits, '.', '_', '-'; no '/', '\\', or '..'). "
            + 'Fix manifest/roles.yaml, or pass --role <ns> to name the namespace for this push.',
        };
      }
      return { ok: true, candidates };
    } catch (e) {
      if (!(e instanceof RolesManifestNotFoundError)) {
        return {
          ok: false,
          message: `Cannot resolve where new ${type} should go: ${(e as Error).message}. `
            + 'Fix manifest/roles.yaml, run `teamai roles set <role>`, or pass --role <ns> '
            + 'to name the namespace for this push.',
        };
      }
      // Legacy fallback: with no manifest at all a role id doubles as its
      // skills namespace. That convention only ever existed for skills.
      return { ok: true, candidates: type === 'skills' ? [localConfig.primaryRole] : [] };
    }
  }

  // No role configured. Skills can still be placed by detecting the team repo's
  // existing namespace directories; rules and agents have no such detector, so
  // a new one stays at the shared root.
  if (type !== 'skills') return { ok: true, candidates: [] };
  try {
    return { ok: true, candidates: await scanTeamRepoNamespaces(localConfig.repo.localPath) };
  } catch (e) {
    return {
      ok: false,
      message: `Cannot list the team repo's skills namespaces: ${(e as Error).message}. `
        + 'Pass --role <ns> to name the namespace for this push.',
    };
  }
}

/**
 * Where a new root-level resource should land, or why push must stop. The two
 * stop states are separate because they exit differently: a manifest that
 * cannot answer is a failure (exit 2), while a selection the user typed wrong
 * ends the run without an error code, as it did before.
 */
type NewResourceDestination =
  | { kind: 'namespace'; namespace: string }
  | { kind: 'shared-root' }
  | { kind: 'unresolvable'; message: string }
  | { kind: 'invalid-selection'; message: string };

/**
 * Decide the namespace for the new root-level resources of one type.
 *
 * Every axis answers this the same way — that consistency is the fix for #649 —
 * but each reads its own namespace list, so a project whose `knowledge` and
 * `skills` namespaces differ sends a rule and a skill to different directories.
 */
async function resolveNamespaceForNew(
  type: PlaceableType,
  options: { role?: string; project?: string; silent?: boolean },
  localConfig: LocalConfig,
  projectsManifest: ProjectsManifest | null,
): Promise<NewResourceDestination> {
  if (options.project && projectsManifest) {
    const resolved = resolveProjectNamespace(projectsManifest, options.project, type);
    return resolved.ok
      ? { kind: 'namespace', namespace: resolved.namespace }
      : { kind: 'unresolvable', message: resolved.message };
  }

  // An explicit --role is a literal namespace on every axis (already checked
  // for path traversal before selection).
  if (options.role) return { kind: 'namespace', namespace: options.role };

  const resolution = await namespaceCandidates(type, localConfig);
  if (!resolution.ok) return { kind: 'unresolvable', message: resolution.message };
  const { candidates } = resolution;
  if (candidates.length === 0) return { kind: 'shared-root' };
  if (candidates.length === 1) return { kind: 'namespace', namespace: candidates[0] };
  if (options.silent) {
    // Skills keep their historical silent default (the primary role id); no
    // other axis ever had that convention, so they take the first candidate.
    const skillsDefault = type === 'skills' ? localConfig.primaryRole : undefined;
    return { kind: 'namespace', namespace: skillsDefault ?? candidates[0] };
  }
  // No terminal to ask on (CI, a hook, TEAMAI_NONINTERACTIVE): say what the
  // choice is and how to make it, instead of failing inside the prompt.
  if (!isInteractive()) {
    return {
      kind: 'unresolvable',
      message: `Several ${NAMESPACE_AXIS[type]} namespaces could take new ${type} (${candidates.join(', ')}), `
        + 'and there is no terminal to ask on. Pass --role <ns> to name one.',
    };
  }

  console.log('');
  console.log(`Which namespace should new ${type} be pushed to?`);
  candidates.forEach((ns, index) => {
    console.log(`  ${index + 1}. ${ns}`);
  });
  console.log('');
  const answer = await askQuestion(
    `Choose namespace [1-${candidates.length}] (default: 1 = ${candidates[0]}): `,
  );
  const selection = answer ? Number.parseInt(answer, 10) : 1;
  if (Number.isNaN(selection) || selection < 1 || selection > candidates.length) {
    return {
      kind: 'invalid-selection',
      message: `Invalid selection. Choose a number between 1 and ${candidates.length}.`,
    };
  }
  return { kind: 'namespace', namespace: candidates[selection - 1] };
}

/**
 * Create a PR/MR via the configured provider with standard error handling.
 * Returns the PR URL on success, or null if creation failed (branch is still pushed).
 */
async function createPrWithFallback(
  teamConfig: { repo: string; provider?: string; reviewers?: string[] },
  localConfig: { repo: { remote: string; localPath: string } },
  branchName: string,
  title: string,
  description: string,
): Promise<string | null> {
  const provider = getProvider(teamConfig.provider);
  const mrSpin = spinner('Creating Pull Request...').start();
  let repoInput = teamConfig.repo;
  try {
    let repoInfo;
    try {
      repoInfo = provider.parseRepoInput(teamConfig.repo);
    } catch {
      repoInfo = provider.parseRepoInput(localConfig.repo.remote);
      repoInput = localConfig.repo.remote;
    }

    const targetBranch = await getDefaultBranch(localConfig.repo.localPath);
    const prUrl = await provider.createPullRequest({
      repo: `${repoInfo.owner}/${repoInfo.repo}`,
      source: branchName,
      target: targetBranch,
      title,
      description,
      reviewers: teamConfig.reviewers?.length ? teamConfig.reviewers : undefined,
      cwd: localConfig.repo.localPath,
    });
    mrSpin.succeed(`Pull Request created: ${prUrl}`);
    return prUrl;
  } catch (e) {
    mrSpin.fail(`Failed to create PR: ${(e as Error).message}`);
    log.info(`Branch ${branchName} has been pushed. You can create a PR manually.`);
    if (provider.name === 'git') {
      const { detectProvider } = await import('./providers/registry.js');
      const { probeSelfHostedGitLab } = await import('./providers/gitlab/probe.js');
      const repoUrl = repoInput || localConfig.repo.remote;
      const detected = detectProvider(repoUrl) === 'gitlab'
        ? { baseUrl: 'your GitLab instance base URL' }
        : await probeSelfHostedGitLab(repoUrl);
      if (detected) {
        log.info(
          'Detected GitLab, but teamai.yaml has provider: git. Change it to provider: gitlab, '
          + `set GITLAB_URL to ${detected.baseUrl}, and configure GITLAB_TOKEN with api scope.`,
        );
      }
    }
    return null;
  }
}

export { createPrWithFallback };

/**
 * Outcome of a single {@link pushGroup} call:
 *  - `pushed`    — a real push AND a PR obtained (created, or an existing PR reused).
 *  - `nochange`  — nothing to push (branch already up to date). No PR, no error.
 *  - `pr-failed` — the branch was pushed but PR creation failed (exit code set to 1).
 *  - `failed`    — pushItem/pushRepoBranch threw; the working tree was rolled back.
 *
 * The caller distinguishes these so the `push` webhook fires only after a real
 * completed push — never on a no-change or PR-creation-failed run (#702 follow-up).
 */
type PushGroupOutcome = 'pushed' | 'nochange' | 'pr-failed' | 'failed';

/**
 * The paths that would make `placedAt` a second copy of the same resource.
 * An agent is canonically `<stem>.yaml`, but `pull` reads a legacy `<stem>.md`
 * as the same agent, so a new `.md` landing beside an existing `.yaml` (or the
 * reverse) produces exactly the ambiguity pull reports and skips. Checking the
 * proposed path alone misses that.
 */
function collisionPaths(type: PlaceableType, placedAt: string): string[] {
  if (type !== 'agents') return [placedAt];
  const stem = placedAt.replace(/\.(yaml|md)$/, '');
  return [`${stem}.yaml`, `${stem}.md`];
}

/** The team-relative path `pushItem` retired while writing `item`, if any. */
function supersededPathOf(item: ResourceItem): string | undefined {
  return 'supersedes' in item && typeof item.supersedes === 'string' ? item.supersedes : undefined;
}

/**
 * Give every resource waiting in an open PR back the destination that PR
 * recorded, rather than asking again — a different answer would silently move
 * the resource, and the branch is force-pushed, so the old copy would not even
 * stay behind. Runs before placement, so a resource with a recorded namespace
 * is no longer at the shared root and placement leaves it alone.
 */
function reuseRecordedDestinations(groups: PushGroup[]): void {
  for (const group of groups) {
    if (!group.reuse) continue;
    log.info(
      `Updating existing PR instead of creating a new one: ${group.reuse.prUrl ?? group.reuse.branch}`,
    );
    for (const item of group.items) {
      if (item.status !== 'new' || !isPlaceableType(item.type)) continue;
      const ns = pendingNamespaceFor(group.reuse, item);
      if (!ns) continue;
      if (item.type === 'skills') {
        // A skill's path is derived from its name, so the recorded namespace
        // replaces whatever a --role/--project override wrote above.
        item.namespace = ns;
        item.relativePath = skillNamespacePath(ns, item.name);
      } else if (isAtSharedRoot(item)) {
        // A rule or agent carries its own path from the scanner, and that path
        // is authoritative when it already names a namespace (#654).
        item.namespace = ns;
        item.relativePath = withNamespace(item.relativePath, ns);
      }
    }
  }
}

/**
 * Place the NEW root-level resources of `items` in a namespace, printing where
 * each one goes. One decision per axis: skills from the `skills` namespaces,
 * rules from `knowledge`, agents from `agents`. Before #649 only skills were
 * placed, so a new rule or agent landed at the shared root and pull shipped it
 * to every member. Only items that would otherwise land at the root are
 * touched — anything the scanner already namespaced keeps the path it came with.
 *
 * Returns false when the push must stop; it has already reported why and set
 * `process.exitCode`. `--dry-run` runs this too, so it shows the destinations
 * and fails on the same unresolvable axis the real command would.
 */
async function placeNewResources(args: {
  items: ResourceItem[];
  options: { role?: string; project?: string; silent?: boolean };
  localConfig: LocalConfig;
  projectsManifest: ProjectsManifest | null;
  skillsDestinationError?: string;
  /** The clone could not be refreshed this run; its manifests may be stale. */
  teamRepoStale?: boolean;
}): Promise<boolean> {
  const { items, options, localConfig, projectsManifest, skillsDestinationError, teamRepoStale } = args;

  // A project that declares no skills namespace only blocks the push once a
  // skill is actually selected, so a rule can still go out from a scan that
  // happens to contain an unrelated skill.
  if (skillsDestinationError && items.some((i) => i.type === 'skills')) {
    log.error(skillsDestinationError);
    process.exitCode = 2;
    return false;
  }

  for (const type of PLACEABLE_TYPES) {
    const newAtRoot = items.filter(
      (i) => i.type === type && i.status === 'new' && !i.namespace && isAtSharedRoot(i),
    );
    if (newAtRoot.length === 0) continue;

    // Same reasoning as --project in pushCore: a namespace resolved from an
    // unrefreshed clone may name the wrong members. Every unflagged answer
    // reads that clone — the roles manifest, its ABSENCE (one added remotely
    // since the last pull would move new rules and agents off the shared
    // root), and the skills namespaces detected from its tree — so only an
    // explicit --role is safe here (#649 review).
    if (teamRepoStale && !options.role) {
      log.error(
        `Cannot place new ${type}: the team repo could not be refreshed, so where new ${type} belong `
        + '(manifest/roles.yaml, or the namespaces the repo already has) may be out of date. '
        + 'Fix the pull and retry, or name the namespace with --role <ns>.',
      );
      process.exitCode = 1;
      return false;
    }

    const destination = await resolveNamespaceForNew(type, options, localConfig, projectsManifest);
    switch (destination.kind) {
      case 'unresolvable':
        log.error(destination.message);
        process.exitCode = 2;
        return false;
      case 'invalid-selection':
        log.error(destination.message);
        return false;
      case 'shared-root':
        // The one destination that reaches the whole team is the one worth
        // saying out loud, so it is never the result of a silent fallback.
        for (const item of newAtRoot) {
          log.warn(`[${type}] ${item.name} → ${item.relativePath} (shared with everyone: no namespace resolved)`);
        }
        continue;
      case 'namespace':
        for (const item of newAtRoot) {
          const placedAt = withNamespace(item.relativePath, destination.namespace);
          // This resource is NEW here, so nothing of ours is at that path yet.
          // Anything already there is somebody else's, and `pushItem` writes
          // rather than merges: placing on top of it would replace their work
          // with ours, silently, in a run they never reviewed.
          let taken: string | undefined;
          for (const candidate of collisionPaths(type, placedAt)) {
            if (await pathExists(path.join(localConfig.repo.localPath, candidate))) {
              taken = candidate;
              break;
            }
          }
          if (taken) {
            log.error(
              `[${type}] ${item.name} cannot be placed: ${taken} already exists in the team repo, `
              + `and this is a new ${type.slice(0, -1)}, so pushing it there would `
              + (taken === placedAt ? 'overwrite that copy. ' : 'leave two copies of the same agent. ')
              + 'Pull and edit the existing one, rename yours, or pass --role <ns> to choose another namespace.',
            );
            process.exitCode = 2;
            return false;
          }
          item.namespace = destination.namespace;
          item.relativePath = placedAt;
          // The silent widening in #649 was the real damage: say where it went.
          log.info(`[${type}] ${item.name} → ${item.relativePath}`);
        }
        break;
      default: {
        const unhandled: never = destination;
        throw new Error(`Unhandled namespace destination: ${JSON.stringify(unhandled)}`);
      }
    }
  }

  return true;
}

/**
 * Push each selected resource into the team repo, commit it on a branch, and
 * open (or update) the matching PR. On a thrown failure it rolls back the copies
 * so the next scan sees a clean tree and returns `'failed'`.
 */
async function pushGroup(args: {
  group: PushGroup;
  teamConfig: TeamaiConfig;
  localConfig: LocalConfig;
  pushState: State;
  includeTeamConfig: boolean;
}): Promise<PushGroupOutcome> {
  const { group, teamConfig, localConfig, pushState, includeTeamConfig } = args;
  const { items, reuse } = group;

  // pushItem copies files into the team repo's working tree. If any later
  // step (refreshMarketplace, pushRepoBranch, createPullRequest) fails, we
  // must wipe those copies + any staging so the next `teamai push` scans
  // cleanly instead of reporting "No new resources" (BUG #2).
  const pushSpin = spinner('Pushing resources...').start();
  const pushedFiles: string[] = [];
  let workingTreeDirtied = false;

  try {
    for (const item of items) {
      const handler = getHandler(item.type);
      await handler.pushItem(item, teamConfig, localConfig);
      workingTreeDirtied = true;
      pushedFiles.push(item.relativePath);
      // A file this write retired (a canonical agent renamed .md ↔ .yaml) is
      // tracked on the default branch, so staging its path stages the removal.
      const supersedes = supersededPathOf(item);
      if (supersedes) pushedFiles.push(supersedes);
    }

    // Refresh marketplace.json if it exists and skills were pushed
    if (items.some((i) => i.type === 'skills')) {
      try {
        const { refreshMarketplace } = await import('./resources/marketplace.js');
        const updated = await refreshMarketplace(localConfig.repo.localPath);
        if (updated) {
          pushedFiles.push('.codebuddy-plugin/marketplace.json');
          log.debug('Refreshed marketplace.json');
        }
      } catch (e) {
        log.debug(`Marketplace refresh skipped: ${(e as Error).message}`);
      }
    }

    // Create branch, commit, and push.
    // Only include "sweeper" directories (rules/, env/) that actually
    // exist — otherwise `git add 'rules/'` throws `pathspec did not match
    // any files` and the whole push aborts (BUG #1). A team may not have
    // rules/ or env/ yet.
    const sweeperCandidates = ['rules/', 'env/', '.codebuddy-plugin/'];
    const existingSweepers = await filterExistingTopLevelPaths(
      localConfig.repo.localPath,
      sweeperCandidates,
    );
    // Include teamai.yaml when the user edited it (e.g. `teamai source add`), so
    // sources / publicSkills changes ride along in the same PR as the resources.
    const configFiles = includeTeamConfig ? ['teamai.yaml'] : [];
    const gitFiles = [...new Set([...pushedFiles, ...existingSweepers, ...configFiles])];
    const branchName = reuse?.branch ?? generateBranchName(localConfig.username);
    const commitMsg = `[teamai] Push ${items.length} resource(s) from ${localConfig.username}`;
    // The default-branch commit the branch is built on, which bounds the
    // history that can prove a placement landed (`reconcilePlacementRecords`).
    const base = await getHeadCommit(localConfig.repo.localPath) ?? undefined;

    const hasChanges = await pushRepoBranch(
      localConfig.repo.localPath,
      commitMsg,
      gitFiles,
      branchName,
      { reuseBranch: Boolean(reuse) },
    );
    // pushRepoBranch committed (or deleted the branch) — working tree is
    // clean either way from the branch's perspective.
    workingTreeDirtied = false;

    // A reuse branch whose earlier PR creation failed is recorded with
    // prUrl:null: the branch and its resources are already on the remote, only
    // the PR is missing. Re-running push then produces no tree change, so
    // `hasChanges` is false — but there IS outstanding work (the PR). Only such
    // an entry may proceed past the no-change gate to (re)create the PR for the
    // already-pushed branch; it must NOT re-push (nothing changed) (#702 follow-up).
    const needsPrRetry = Boolean(reuse) && !reuse?.prUrl;

    if (!hasChanges && !needsPrRetry) {
      // Genuinely nothing to do: a brand-new branch with no changes, or a reuse
      // entry whose PR already exists.
      pushSpin.succeed(
        reuse
          ? `No changes to push (PR already up to date: ${reuse.prUrl ?? branchName})`
          : 'No changes to push (files already up to date)',
      );
      return 'nochange';
    }

    pushSpin.succeed(
      hasChanges
        ? `Pushed branch ${branchName}`
        : `No new changes; retrying PR creation for ${branchName}`,
    );

    let prUrl: string | null;
    let prFailed = false;
    if (reuse?.prUrl) {
      // A PR already tracks this branch, so the force-push above updated it in
      // place — don't create a duplicate.
      prUrl = reuse.prUrl;
      log.success(`Existing PR updated: ${prUrl}`);
    } else {
      // No PR yet. Either a brand-new branch, OR a reuse branch whose earlier
      // PR creation failed (recorded with prUrl:null). In both cases the branch
      // is on the remote but has no PR, so create one now — otherwise the reuse
      // branch's resources would sit on a branch that never enters review. This
      // reaches here even when hasChanges is false (needsPrRetry): the branch is
      // already pushed, so we only create the PR, never re-push.
      prUrl = await createPrWithFallback(
        teamConfig,
        localConfig,
        branchName,
        commitMsg,
        `Pushed ${items.length} resource(s):\n${items.map((i) => `- [${i.type}] ${i.name}`).join('\n')}`,
      );
      if (!prUrl) {
        process.exitCode = 1;
        prFailed = true;
      }
    }

    // Remember the open PR so the next run updates it instead of opening a
    // duplicate. Recorded even when PR creation failed: the branch is on the
    // remote, so pushing again must reuse it. A PR retry pushed nothing, so
    // the branch — and the blobs and base that prove its placements — is the
    // one already recorded; this run has no branch checked out to hash.
    recordPendingPush(pushState, {
      branch: branchName,
      prUrl,
      createdAt: new Date().toISOString(),
      ...(hasChanges
        ? { base, items: await toPendingItems(items, localConfig.repo.localPath) }
        : { base: reuse?.base, items: reuse?.items ?? [] }),
    });

    // Switch back to the default branch so the next group starts clean
    await checkoutMaster(localConfig.repo.localPath);
    // git tracks files, not directories: any empty subdirectory a pushed
    // resource carried (e.g. an unused `assets/`) survives that checkout as an
    // untracked shell. A skill-shaped shell has no SKILL.md, so the next push
    // would read it as a namespace and nest every new skill inside it.
    for (const rel of pushedFiles) {
      await pruneEmptyDirs(path.resolve(localConfig.repo.localPath, rel));
    }
    // The branch is on the remote either way, but a run whose PR creation failed
    // is not a completed push — report it distinctly so the caller does not fire
    // the `push` webhook (#702 follow-up).
    return prFailed ? 'pr-failed' : 'pushed';
  } catch (e) {
    pushSpin.fail(`Push failed: ${(e as Error).message}`);
    if (workingTreeDirtied) {
      try {
        const git = createGit(localConfig.repo.localPath);
        await git.reset(['--hard', 'HEAD']);
        await git.clean('f', ['-d']);
        log.debug('Rolled back team repo working tree after failed push');
      } catch (cleanupErr) {
        log.warn(
          `Warning: team repo may be in a dirty state. Run \`git -C ${localConfig.repo.localPath} reset --hard && git clean -fd\` manually. (${(cleanupErr as Error).message})`,
        );
      }
    }
    return 'failed';
  }
}

export async function push(
  options: GlobalOptions & { all?: boolean; role?: string; project?: string },
  /**
   * Optional out-param: set to `{ completed: true }` only when a real push
   * actually happened (resources or config pushed) — never on dry-run, cancel,
   * no-change, or a handled failure. Lets the CLI gate the `push` webhook so it
   * does not fire a misleading "Push Complete" on those paths (#702 follow-up).
   */
  result?: { completed: boolean },
): Promise<void> {
  // Auto-detect scope: project scope if cwd has project config, else user scope
  const { localConfig, teamConfig } = await autoDetectInit();
  assertNotReadOnly(localConfig, 'teamai push');

  // --project is a destination override expressed as a logical project. Each
  // resource type then resolves from its OWN axis in manifest/projects.yaml —
  // skills from `skills`, rules from `knowledge`, agents from `agents` — because
  // a project may declare different namespaces for each (issue #649). A missing
  // namespace only blocks a push that actually selects that type: the skills
  // axis resolves against the scan, because it also relocates modified skills
  // and the listing has to show where they go, but a failure there is held
  // until the selection proves a skill is going out.
  // Deliberately manifest-resolved, not the raw project id, so it agrees with
  // what pull syncs (issue #375 P2 lesson).
  // The manifest itself is read in `pushCore`, AFTER the team clone is pulled:
  // read here it would be the previous pull's copy, and a project whose
  // namespaces changed on the remote would place this run's new rules and
  // agents by the stale mapping (#649 review).
  if (options.project && options.role) {
    log.error('Use either --role or --project, not both.');
    process.exitCode = 2;
    return;
  }
  try {
    const configContent = await readFileSafe(path.join(localConfig.repo.localPath, 'teamai.yaml'));
    const rawConfig = configContent === null ? null : YAML.parse(configContent);
    if (
      rawConfig
      && typeof rawConfig === 'object'
      && !Array.isArray(rawConfig)
      && Object.prototype.hasOwnProperty.call(rawConfig, 'packages')
    ) {
      const { loadPackageManifest } = await import('./pkg/manifest.js');
      await loadPackageManifest(localConfig.repo.localPath);
    }
  } catch (e) {
    log.error(`Cannot push invalid package declarations: ${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }

  // Single-repo mode: knowledge PRs must run in an isolated worktree so the
  // branch/commit/reset never touch the user's active tree. withKnowledgeWorktree
  // hands pushCore a config whose localPath is the worktree's .teamai.
  if (localConfig.repo.kind === 'self') {
    // Guard self machine-data writes against a concurrent P2 migration relocating
    // the same files. Contend on <getDataHome>/.sync-lock — the exact path
    // migrateSelfA1 takes (for a pre-migration self install that is
    // <repo>/.teamai/.sync-lock). Like git-mode push, error on contention rather
    // than silently skipping (that would drop the user's changes).
    const selfSyncLock = path.join(getDataHome(localConfig), SYNC_LOCK_FILENAME);
    if (!(await acquireLock(selfSyncLock))) {
      log.error('Another teamai pull/push/migration is in progress for this project. Re-run once it finishes.');
      process.exitCode = 1;
      return;
    }
    try {
      // Self-heal an older .teamai/.gitignore that still ignores `env` (pre-beta.5).
      // Run against the ACTIVE tree (original localConfig, projectRoot intact) BEFORE
      // swapping into the worktree, so the fixed .gitignore lets env changes surface.
      try {
        const { migrateSelfModeGitignore } = await import('./init.js');
        await migrateSelfModeGitignore(localConfig);
      } catch { /* best-effort */ }

      const { withKnowledgeWorktree, EmptyRepoError } = await import('./utils/reports-branch.js');
      try {
        const activeConfigPath = path.join(localConfig.repo.localPath, 'teamai.yaml');
        const activeConfig = await readFileSafe(activeConfigPath);
        const businessRoot = localConfig.repo.businessRepoRoot ?? localConfig.projectRoot;
        let pendingTeamConfig: string | null = null;
        if (activeConfig !== null && businessRoot) {
          const relativeConfigPath = path.relative(businessRoot, activeConfigPath).split(path.sep).join('/');
          const committed = await getFileContentAtRev(businessRoot, 'HEAD', relativeConfigPath);
          if (committed === null || committed.toString() !== activeConfig) {
            pendingTeamConfig = activeConfig;
          }
        }
        await withKnowledgeWorktree(localConfig, async (wtConfig) => {
          if (pendingTeamConfig !== null) {
            await writeFile(path.join(wtConfig.repo.localPath, 'teamai.yaml'), pendingTeamConfig);
          }
          await pushCore(wtConfig, teamConfig, options, pendingTeamConfig, result);
        });
      } catch (e) {
        if (e instanceof EmptyRepoError) {
          log.error(e.message);
        } else {
          log.error(`Push failed: ${(e as Error).message}`);
        }
        process.exitCode = 1;
      }
    } finally {
      await releaseLock(selfSyncLock);
    }
    return;
  }

  // Guard the shared team clone: push resets to clean master, pulls, then
  // branches/commits/pushes on one clone shared by all worktrees of this repo.
  // A concurrent pull/push would corrupt it. Unlike pull, push must NOT silently
  // skip (that would drop the user's changes), so on contention we error out.
  const syncLock = path.join(getDataHome(localConfig), SYNC_LOCK_FILENAME);
  const locked = await acquireLock(syncLock);
  if (!locked) {
    log.error('Another teamai pull/push is in progress for this project. Re-run once it finishes.');
    process.exitCode = 1;
    return;
  }
  try {
    await pushCore(localConfig, teamConfig, options, null, result);
  } finally {
    await releaseLock(syncLock);
  }
}

async function pushCore(
  localConfig: LocalConfig,
  teamConfig: TeamaiConfig,
  options: GlobalOptions & { all?: boolean; role?: string; project?: string },
  initialPendingTeamConfig: string | null = null,
  result?: { completed: boolean },
): Promise<void> {
  const selfMode = localConfig.repo.kind === 'self';
  const scopeLabel = localConfig.scope;

  // Pull latest default branch BEFORE scanning so detection runs against up-to-date repo.
  // The team repo may be in various broken states from previous failed pushes:
  //   - Unmerged (conflicted) files without MERGE_HEAD (incomplete merge)
  //   - Stuck on a stale push branch instead of master
  //   - Uncommitted changes (e.g. votes written by autoUpvote)
  // We recover from all of these before pulling.
  // In self mode the worktree is already a fresh detached checkout of
  // origin/<default>, so resetToCleanMaster/pullRepo (which assume a normal
  // clone on a branch) are neither needed nor safe — skip them.
  // Uncommitted teamai.yaml edits (e.g. from `teamai source add`, which writes the
  // file but does not commit) live in the team repo working tree. resetToCleanMaster
  // below does `git reset --hard`, which would silently destroy them. Capture the
  // working-tree content before the reset and restore it after pull, so config edits
  // survive and get committed alongside resources (see gitFiles construction below).
  let pendingTeamConfig: string | null = initialPendingTeamConfig;
  // Set when the pull below failed: everything read from the clone after this
  // point is the previous pull's, manifests included.
  let teamRepoStale = false;
  if (!selfMode) {
    const pullSpin = spinner('Pulling latest changes...').start();
    try {
      const repoPath = localConfig.repo.localPath;
      const git = createGit(repoPath);
      if (!(await isDedicatedRepoRoot(repoPath))) {
        // repoPath is not its own git root (e.g. a project-scope team repo dir with no
        // dedicated .git that resolves to the business repo). Every step below — reset
        // --hard, checkout, and pushRepoBranch — would act on the enclosing business
        // repo and wipe the user's working tree. Abort the whole push with a clear
        // message rather than silently doing nothing or damaging their repo.
        pullSpin.fail('Cannot push: team repo path is not a dedicated git root. '
          + 'Run `teamai init` to re-clone the team repo before pushing.');
        process.exitCode = 1;
        return;
      }
      const yamlPath = path.join(repoPath, 'teamai.yaml');
      const workingContent = await readFileSafe(yamlPath);
      if (workingContent !== null) {
        const committed = await getFileContentAtRev(repoPath, 'HEAD', 'teamai.yaml');
        if (committed === null || committed.toString() !== workingContent) {
          pendingTeamConfig = workingContent;
        }
      }
      await resetToCleanMaster(git, repoPath);
      await pullRepo(repoPath);
      if (pendingTeamConfig !== null) {
        // Re-apply the user's config edits on top of the freshly pulled default branch.
        await writeFile(yamlPath, pendingTeamConfig);
      }
      pullSpin.succeed('Up to date');
    } catch (e) {
      teamRepoStale = true;
      pullSpin.warn(`Pull failed: ${(e as Error).message}`);
    }
  }

  // --project is a destination override expressed as a logical project. Each
  // resource type then resolves from its OWN axis in manifest/projects.yaml —
  // skills from `skills`, rules from `knowledge`, agents from `agents` — because
  // a project may declare different namespaces for each (issue #649). A missing
  // namespace only blocks a push that actually selects that type: the skills
  // axis resolves against the scan, because it also relocates modified skills
  // and the listing has to show where they go, but a failure there is held
  // until the selection proves a skill is going out.
  // Deliberately manifest-resolved, not the raw project id, so it agrees with
  // what pull syncs (issue #375 P2 lesson). Read from the clone the pull above
  // just refreshed (or the fresh worktree, in self mode), never from an earlier
  // state of it.
  let projectsManifest: ProjectsManifest | null = null;
  if (options.project) {
    // A warning is not enough here: with the clone unrefreshed, a namespace
    // the remote has changed would send this run's new rules and agents to
    // the members of the OLD one, and nothing later in the run can tell.
    if (teamRepoStale) {
      log.error(
        'Cannot resolve --project destinations: the team repo could not be refreshed, so '
        + 'manifest/projects.yaml may be stale. Fix the pull and retry, or name the namespace with --role <ns>.',
      );
      process.exitCode = 1;
      return;
    }
    const { loadProjectsManifest, findProject, unknownProjectMessage } = await import('./projects.js');
    projectsManifest = await loadProjectsManifest(localConfig.repo.localPath);
    if (!projectsManifest) {
      log.error('This team repo defines no projects (no manifest/projects.yaml).');
      process.exitCode = 2;
      return;
    }
    // The id is checked here, not with the namespaces: a typo must fail even on
    // a push where nothing needs placing, instead of being silently ignored.
    if (!findProject(projectsManifest, options.project)) {
      log.error(unknownProjectMessage(projectsManifest, options.project));
      process.exitCode = 2;
      return;
    }
  }

  // Settle the placement records against the clone just pulled, BEFORE the
  // scan reads them: a placement whose PR has merged becomes a record, one
  // whose file the team deleted stops being one, and one shadowed by a new
  // shared-root file of the same name is withdrawn (#649 review). Not when the
  // clone is stale itself — a file missing from an unrefreshed tree proves nothing.
  // Not best-effort: the pre-push sync and the scan read the records back from
  // disk, so a record that could not be withdrawn (a shared-root file now
  // shadows it) would still redirect the author's root copy onto the
  // namespaced file and push that shared content over it (#649 review).
  if (!teamRepoStale) {
    try {
      const recordsState = await loadStateForScope(localConfig);
      if (await reconcilePlacementRecords(localConfig.repo.localPath, recordsState)) {
        await saveStateForScope(recordsState, localConfig);
      }
    } catch (e) {
      log.error(
        `Could not bring this machine's placement records up to date (${(e as Error).message}), `
        + 'so where your resources belong cannot be worked out safely. Nothing was pushed. '
        + 'Check that the teamai state file is writable, then retry.',
      );
      process.exitCode = 1;
      return;
    }
  }

  // Sync team repo updates to local tool directories before scanning.
  // This prevents files changed by teammates from being falsely flagged as "modified".
  try {
    const state = await loadStateForScope(localConfig);
    // placedRules redirects a root-authored rule to the rules/<ns>/ file push
    // put it in, so a teammate's newer version syncs down instead of being
    // overwritten by the stale root copy the scan would otherwise call modified.
    await syncTeamUpdatesToLocal(teamConfig, localConfig, state.lastPullRev, state.placedRules);
  } catch (e) {
    log.debug(`Pre-push sync skipped: ${(e as Error).message}`);
  }

  const spin = spinner('Scanning local resources...').start();

  // In single-repo mode the team knowledge dirs (.teamai/skills, .teamai/rules)
  // live inside the user's own repo, so people naturally add or edit skills there
  // directly (e.g. `cp my-skill .teamai/skills/`) instead of in an AI tool dir
  // like ~/.claude/skills. The default scanner only treats AI tool dirs as push
  // "sources", so a skill hand-placed under .teamai/skills would be invisible to
  // push ("No new or modified resources"). Add the ACTIVE tree's .teamai/{skills,
  // rules} as extra scan sources; they are diffed against the worktree checkout of
  // origin/<default> (localConfig.repo.localPath here), so already-committed
  // knowledge is skipped and only genuine additions/edits surface.
  //
  // Scan-only: we deliberately do NOT persist this into teamConfig.toolPaths — pull
  // and pre-push sync must never target .teamai/skills (that would copy knowledge
  // back onto itself). getHandler(type).scanLocalForPush reads toolPaths for the
  // source list only; pushItem writes via localConfig.repo.localPath, unaffected.
  const scanTeamConfig: TeamaiConfig = selfMode
    ? {
      ...teamConfig,
      toolPaths: {
        ...teamConfig.toolPaths,
        [SELF_KNOWLEDGE_SCAN_KEY]: { skills: '.teamai/skills', rules: '.teamai/rules' },
      },
    }
    : teamConfig;

  // Scan for pushable resources first, then resolve namespace for new skills only.
  // Modified skills already carry their namespace from scanLocalForPush.
  const pushableTypes: ResourceType[] = ['skills', 'rules', 'env', 'agents'];
  const fullScan: ResourceItem[] = [];

  // Agents are the one type whose SCAN needs the destination: it has to tell
  // "an edit of the team's copy" from "a new agent for this namespace", and an
  // explicit --role/--project is what answers that. Rules and skills are placed
  // after selection, so their scan needs nothing. An unsafe --role resolves to
  // no candidate here and is rejected with exit 2 before anything is pushed.
  let requestedAgentsNamespace: string | undefined;
  let agentsDestinationError: string | undefined;
  if (options.role) {
    requestedAgentsNamespace = options.role;
  } else if (options.project && projectsManifest) {
    const resolved = resolveProjectNamespace(projectsManifest, options.project, 'agents');
    if (resolved.ok) {
      requestedAgentsNamespace = resolved.namespace;
    } else {
      agentsDestinationError = resolved.message;
    }
  }

  for (const type of pushableTypes) {
    const handler = getHandler(type);
    const items = await handler.scanLocalForPush(
      scanTeamConfig,
      localConfig,
      type === 'agents' ? { namespace: requestedAgentsNamespace } : undefined,
    );
    fullScan.push(...items);
  }

  // A project that cannot answer for agents is reported below for an agent the
  // scan itself dropped — skipped as "no active source" with `needsDestination`
  // set. That one never reaches the listing, so deferring its error until the
  // selection proves it is going out means never raising it.
  //
  // A NEW agent is different: it is listed, so the user can deselect it, and
  // step 4 raises the same error if it stays selected. Failing for it here
  // blocked a rules-only push on an agent that was never going out (#649
  // review). An agent already in a namespace is modified in place and needs no
  // placement, so an empty agents axis is none of its business either.
  const skippedForWantOfDestination = (item: ResourceItem): boolean => item.type === 'agents'
    && 'needsDestination' in item && item.needsDestination === true;

  // Preserve blocked items in the full scan so their pending PR records survive.
  // Exclude them before selection and grouping: pushItem cannot write their paths.
  const allItems = fullScan.filter((item) => {
    if (item.type === 'agents' && 'skipReason' in item
      && typeof item.skipReason === 'string' && item.skipReason) {
      log.warn(`[agents] Skipped ${item.name}: ${item.skipReason}`);
      return false;
    }
    return true;
  });

  // Such an agent is skipped like any other, and a skipped agent does not
  // block the rest of the push: a stale copy of an agent from a dropped role
  // must not stop an unrelated rule going out (#649 review). The error is the
  // outcome only when nothing else is left, which is when the run would end
  // "No new or modified resources" on a flag it could not honour.
  if (agentsDestinationError && fullScan.some(skippedForWantOfDestination)) {
    if (allItems.length === 0) {
      log.error(agentsDestinationError);
      process.exitCode = 2;
      return;
    }
    log.warn(`${agentsDestinationError} The agents skipped above are left out; everything else in this push goes on.`);
  }

  // Keep the full scan before --skill/--role narrow allItems. prunePendingPushes
  // must see every pending resource that is still locally present, or narrowing to
  // one skill would drop the other skills' open-PR records and duplicate them next run.

  spin.stop();

  // ── Handle --skill parameter: filter to a single specific skill ──────
  if (options.skill) {
    // Validate the skill name: take the basename of the input path as the
    // resource name to defend against path traversal, URL-encoded bypasses,
    // and other illegal characters.
    const skillBasename = path.basename(
      options.skill.startsWith('~')
        ? options.skill.slice(1).replace(/^[/\\]+/, '')
        : options.skill,
    );
    try {
      assertSafeResourceName(skillBasename);
    } catch (e) {
      console.error(`[push] Invalid --skill argument: ${(e as Error).message}`);
      process.exitCode = 2;
      return;
    }

    // Normalize the input path (expand ~, resolve to absolute)
    const os = await import('node:os');
    const skillPath = options.skill.startsWith('~')
      ? path.join(os.homedir(), options.skill.slice(1))
      : path.resolve(options.skill);

    // Try to find matching skill from scan results first
    let matchedItem: ResourceItem | undefined;

    for (const item of allItems) {
      if (item.type !== 'skills') continue;

      // Match by sourcePath (absolute path)
      if (path.resolve(item.sourcePath) === skillPath) {
        matchedItem = item;
        break;
      }

      // Match by skill name
      if (item.name === path.basename(skillPath)) {
        matchedItem = item;
        break;
      }

      // Match by partial path (e.g., "skills/namespace/skillname" in sourcePath)
      const skillInput = options.skill.replace(/^~/, os.homedir());
      if (item.sourcePath.endsWith(skillInput) || item.sourcePath.includes(path.sep + skillInput)) {
        matchedItem = item;
        break;
      }
    }

    // If not found in scan results, force-construct a ResourceItem from the
    // specified path. This handles cases where:
    //   - The skill exists in both a subdirectory (with modifications) and
    //     at the top level (pulled copy identical to team repo), causing the
    //     scanner to see the top-level copy first and skip the modified one.
    //   - The skill content is identical to team repo (no diff detected) but
    //     the user explicitly wants to push it anyway.
    if (!matchedItem) {
      if (await pathExists(skillPath) && await pathExists(path.join(skillPath, 'SKILL.md'))) {
        const skillName = path.basename(skillPath);

        // Try to detect existing namespace from team repo
        let namespace: string | undefined;
        let status: 'new' | 'modified' = 'new';
        const teamSkillsDir = path.join(localConfig.repo.localPath, 'skills');
        if (await pathExists(teamSkillsDir)) {
          const { listDirs } = await import('./utils/fs.js');
          const topDirs = await listDirs(teamSkillsDir);
          for (const dir of topDirs) {
            const candidatePath = path.join(teamSkillsDir, dir, skillName);
            if (await pathExists(candidatePath)) {
              // Check if this is a namespace dir (not a direct skill)
              const isNamespace = !await pathExists(path.join(teamSkillsDir, dir, 'SKILL.md'));
              if (isNamespace) {
                namespace = dir;
              }
              status = 'modified';
              break;
            }
          }
          // Also check flat layout
          if (!namespace && await pathExists(path.join(teamSkillsDir, skillName))) {
            status = 'modified';
          }
        }

        const relPath = namespace
          ? `skills/${namespace}/${skillName}`
          : `skills/${skillName}`;

        matchedItem = {
          name: skillName,
          type: 'skills',
          sourcePath: skillPath,
          relativePath: relPath,
          status,
          namespace,
        };
        log.debug(`Force-pushing skill from explicit path: ${skillPath}`);
      } else {
        const skillNames = allItems
          .filter(i => i.type === 'skills')
          .map(i => `  - ${i.name} (from: ${i.sourcePath})`)
          .join('\n');
        log.error(`Skill not found at path: ${options.skill}`);
        if (skillNames) {
          console.log('');
          console.log('Available skills with changes:');
          console.log(skillNames);
        }
        process.exit(1);
      }
    }

    // Replace allItems with just this one skill
    allItems.length = 0;
    allItems.push(matchedItem);

    // A force-constructed matchedItem (scanner returned nothing for this skill
    // because its content matches the team repo) is absent from fullScan. Add it
    // so prunePendingPushes still sees this skill as locally present — otherwise
    // its own open-PR record is dropped and the next run opens a duplicate.
    if (!fullScan.some((i) => i.type === matchedItem!.type && i.name === matchedItem!.name)) {
      fullScan.push(matchedItem);
    }
  }

  // An explicit --role or --project is a destination override for every selected
  // skill, including modified ones. Keep relativePath aligned with pushItem's
  // destination so git stages the files that were actually copied (#331).
  // Rules and agents are deliberately NOT relocated here: pushItem writes rather
  // than moves, so moving one that already lives in a namespace would leave the
  // original behind (#654). They are placed in step 4, and only when new.
  let skillsDestination: string | undefined;
  // Held rather than reported: the skills axis resolves here so the listing can
  // show where a relocated skill goes, but a project that cannot answer for
  // skills must only stop the push if a skill is actually selected.
  let skillsDestinationError: string | undefined;
  if (options.role) {
    try {
      // --role now names a directory on every axis, so this message must not
      // claim the problem is with a skill.
      assertSafeResourceName(options.role);
    } catch (e) {
      log.error(`Invalid --role value "${options.role}": ${(e as Error).message}`);
      process.exitCode = 2;
      return;
    }
    skillsDestination = options.role;
  } else if (options.project && projectsManifest && allItems.some((i) => i.type === 'skills')) {
    const resolved = resolveProjectNamespace(projectsManifest, options.project, 'skills');
    if (resolved.ok) {
      skillsDestination = resolved.namespace;
    } else {
      skillsDestinationError = resolved.message;
    }
  }
  if (skillsDestination) {
    try {
      for (const item of allItems) {
        if (item.type === 'skills') {
          assertSafeResourceName(item.name);
        }
      }
    } catch (e) {
      log.error(`Invalid skill name: ${(e as Error).message}`);
      process.exitCode = 2;
      return;
    }
    for (const item of allItems) {
      if (item.type !== 'skills') continue;
      const placedAt = skillNamespacePath(skillsDestination, item.name);
      // Same rule as step 4: a MODIFIED skill is meant to land on its own
      // existing directory, a new one must never land on somebody else's.
      if (item.status === 'new' && await pathExists(path.join(localConfig.repo.localPath, placedAt))) {
        log.error(
          `[skills] ${item.name} cannot be placed: ${placedAt} already exists in the team repo, `
          + 'and this is a new skill, so pushing it there would overwrite that copy. '
          + 'Pull and edit the existing one, rename yours, or pass --role <ns> to choose another namespace.',
        );
        process.exitCode = 2;
        return;
      }
      item.namespace = skillsDestination;
      item.relativePath = placedAt;
    }
  }

  // ── Step 0: Cross-check against still-open push PRs ────────────────
  // Resources waiting in an unmerged PR are absent from the default branch, so
  // the scan above flags them as new every single time. Without this check each
  // run opens another duplicate PR.
  const pushState = await loadStateForScope(localConfig);
  const pruned = await prunePendingPushes(
    localConfig.repo.localPath,
    pushState.pendingPushes,
    fullScan,
  );
  pushState.pendingPushes = pruned.pending;
  if (pruned.changed) {
    await saveStateForScope(pushState, localConfig);
  }
  const pendingPushes = pushState.pendingPushes;

  // A rule or agent awaiting review in a namespace whose name a shared-root
  // file now takes: the scan maps the author's root copy onto that shared file
  // and calls it modified. Reusing the open PR — matched by type and name —
  // would rebuild it with the author's content over the shared file and drop
  // the namespaced change from review (#649 review). The shared root owns the
  // name in every tool dir, as reconcile already rules for a record, so this
  // copy is left out: the open PR stays as it is.
  for (let i = allItems.length - 1; i >= 0; i--) {
    const item = allItems[i];
    if (!item || (item.type !== 'rules' && item.type !== 'agents')) continue;
    if (item.status !== 'modified' || !isAtSharedRoot(item)) continue;
    const awaiting = pendingPushes.flatMap((entry) => entry.items.map((recorded) => ({ entry, recorded })))
      .find(({ recorded }) => recorded.type === item.type && recorded.name === item.name
        && recorded.relativePath.split('/').length === 3);
    if (!awaiting) continue;
    log.warn(
      `[${item.type}] ${item.name}: ${item.relativePath} now exists at the shared root, so your local ${item.name} `
      + `follows that file and is left out of this push. ${awaiting.recorded.relativePath} stays as it is in `
      + `${awaiting.entry.prUrl ?? `branch ${awaiting.entry.branch}`}.`,
    );
    allItems.splice(i, 1);
  }

  // The flag places new resources only. An edit of a shared-root rule or agent
  // stays at the shared root, which reaches every member — say so rather than
  // let the flag look as if it had scoped it.
  if (options.role || options.project) {
    for (const item of allItems) {
      if ((item.type === 'rules' || item.type === 'agents') && item.status === 'modified' && isAtSharedRoot(item)) {
        log.warn(
          `[${item.type}] ${item.name} is an edit of the shared-root ${item.relativePath}, which every member receives; `
          + `${options.role ? '--role' : '--project'} only places new resources, so it stays there.`,
        );
      }
    }
  }

  if (allItems.length === 0) {
    // No resource changes, but the user may have edited teamai.yaml (sources /
    // publicSkills) via `teamai source add`. Push that config change on its own
    // rather than reporting "nothing to push".
    if (pendingTeamConfig !== null) {
      await pushTeamConfigOnly(localConfig, teamConfig, options, result);
      return;
    }
    log.info('No new or modified resources to push');
    return;
  }

  // An open PR is matched by type and name alone. When the user has NAMED a
  // destination, a pending entry that put the same-named resource somewhere
  // else is a different resource: reusing its branch would force-push this
  // content into that PR and move it to the wrong namespace (#649 review).
  const requestedNamespaceFor = (type: PlaceableType): string | undefined => {
    if (options.role) return options.role;
    if (!options.project || !projectsManifest) return undefined;
    const resolved = resolveProjectNamespace(projectsManifest, options.project, type);
    return resolved.ok ? resolved.namespace : undefined;
  };
  // Only what the flag actually MOVES can conflict with it: every selected
  // skill (the override above), and a rule or agent only while it is new and at
  // the shared root (step 4). Anything else keeps the path it was scanned with,
  // so its open PR is still the right one to update, and treating it as a
  // conflict opened a second PR on the same file (#649 review).
  const scannedByKey = new Map(allItems.map((item) => [`${item.type}:${item.name}`, item]));
  const movedByFlag = (item: ResourceItem): boolean => item.type === 'skills'
    || (item.status === 'new' && !item.namespace && isAtSharedRoot(item));
  const conflictsWithRequest = (
    recorded: { type: string; name: string; namespace?: string; relativePath: string },
  ): boolean => {
    if (!isPlaceableType(recorded.type as ResourceType)) return false;
    const scanned = scannedByKey.get(`${recorded.type}:${recorded.name}`);
    if (!scanned || !movedByFlag(scanned)) return false;
    // The path, not the field: a scan can record an item whose destination is
    // namespaced while leaving `namespace` unset, and trusting the field let
    // those entries slip past the check and be force-pushed into (#649 review).
    const segments = recorded.relativePath.split('/');
    const recordedNamespace = recorded.namespace
      ?? (segments.length === 3 ? segments[1] : undefined);
    // A recorded path with no namespace is the shared root — as much a
    // destination as any namespace. Letting it through would reuse that PR's
    // branch and rebuild it with the namespaced path, moving a review the
    // user did not name from "everyone" to one namespace (#649 review).
    const requested = requestedNamespaceFor(recorded.type as PlaceableType);
    return requested !== undefined && requested !== recordedNamespace;
  };
  const reusablePending = pendingPushes.filter((entry) => {
    const conflicting = entry.items.filter(conflictsWithRequest);
    if (conflicting.length === 0) return true;
    // Neither silent answer is safe: honouring the PR ignores the flag the user
    // typed, and reusing the branch force-pushes this content into a review it
    // may have nothing to do with. Say what is happening and open a new PR.
    for (const recorded of conflicting) {
      log.warn(
        `[${recorded.type}] ${recorded.name} is awaiting review at ${recorded.relativePath} `
        + `(${entry.prUrl ?? entry.branch}). This push names a different namespace, so it goes to a `
        + 'separate PR and that one is left untouched.',
      );
    }
    return false;
  });

  // ── Step 1: Display ALL scanned items with numbers ─────────────────
  console.log('');
  console.log(`Found ${allItems.length} resource(s) to push:`);
  console.log('');
  const pendingIndices = new Set<number>();
  for (let i = 0; i < allItems.length; i++) {
    const item = allItems[i];
    const statusLabel = item.status === 'modified' ? ' (modified)' : ' (new)';
    const num = `${i + 1}.`.padStart(4);
    console.log(`  ${num} [${item.type}] ${item.name}${statusLabel}`);
    console.log(`       from: ${item.sourcePath}`);
    // Show the destination whenever it is already namespaced — which one it is
    // decides who receives the resource, so it is not obvious from the name.
    if (!isAtSharedRoot(item)) {
      console.log(`       to:   ${item.relativePath}`);
    }
    const openPrs = findPendingForItem(pendingPushes, item);
    if (openPrs.length > 0) {
      pendingIndices.add(i);
      for (const entry of openPrs) {
        console.log(`       awaiting review: ${entry.prUrl ?? `branch ${entry.branch}`}`);
      }
    }
  }
  console.log('');

  if (pendingIndices.size > 0) {
    log.info(
      `${pendingIndices.size} resource(s) already belong to an open PR. Keeping them selected updates `
      + 'that PR instead of opening a duplicate; deselect them to leave it untouched.',
    );
    console.log('');
  }

  // ── Step 2: Dry run resolves placement, then exits ──────────────
  // Everything is treated as selected, so the run reports the destination of
  // every new resource and fails on a project axis that cannot answer. Exiting
  // before this would let a dry run call a push viable that the real command
  // refuses — and say nothing about who the new resources reach.
  if (options.dryRun) {
    // Same two steps, same order as a real run: an open PR's recorded
    // destination first, then placement for whatever is still at the root.
    reuseRecordedDestinations(planPushGroups(allItems, reusablePending));
    const placed = await placeNewResources({
      items: allItems, options, localConfig, projectsManifest, skillsDestinationError, teamRepoStale,
    });
    if (!placed) return;
    log.info('Dry run — no changes made');
    return;
  }

  // ── Step 3: Item selection (replaces old Y/n confirmation) ─────────
  let selectedItems: ResourceItem[];
  if (options.all || options.silent) {
    selectedItems = [...allItems];
  } else {
    const selectionPrompt = allItems.length === 1
      ? 'Push this resource? [1/all/none] (default: all): '
      : `Select items to push [1-${allItems.length}, or "all"] (default: all): `;
    const indices = await askSelection(selectionPrompt, allItems.length, true);
    if (!indices || indices.length === 0) {
      log.info('Cancelled');
      return;
    }
    selectedItems = indices.map((i) => allItems[i]);
  }

  // ── Step 3b: Split the selection into per-PR groups ────────────────
  // Resources that belong to an open PR are pushed by force-pushing that PR's
  // branch, which updates it in place; everything else goes into a new PR. Both
  // can happen in one run, so editing a resource under review updates its PR
  // without dragging unrelated resources into that review.
  const groups = planPushGroups(selectedItems, reusablePending);
  reuseRecordedDestinations(groups);
  // The conflicting entries dropped above are deliberately not reused, so they
  // are not "partly selected" either — warning about them would contradict the
  // warning already given.
  for (const entry of partiallySelectedEntries(selectedItems, reusablePending)) {
    log.warn(
      `Only part of ${entry.prUrl ?? entry.branch} is selected, so the selected resources go into a `
      + 'new PR and will exist in both. Select all of its resources to update it in place instead.',
    );
  }

  // ── Step 4: Place NEW root-level resources in a namespace (after selection) ─
  if (!await placeNewResources({
    items: selectedItems, options, localConfig, projectsManifest, skillsDestinationError, teamRepoStale,
  })) return;

  // ── Step 5: Push each group — one branch/PR per group ──────────────
  // Config edits ride along with the first group so they land in a single PR.
  let configRider = pendingTeamConfig !== null;
  // Track the outcome across groups: a run counts as completed only if at least
  // one group actually pushed AND no group's PR creation failed (#702 follow-up).
  let anyPushed = false;
  let anyPrFailed = false;
  for (const group of groups) {
    const outcome = await pushGroup({
      group,
      teamConfig,
      localConfig,
      pushState,
      includeTeamConfig: configRider,
    });
    if (outcome === 'failed') {
      // The branch/PR for earlier groups is already on the remote, so their
      // records must survive this failure or the next run would duplicate them.
      await saveStateForScope(pushState, localConfig);
      process.exitCode = 1;
      return;
    }
    // Where this group's placed resources went travels on its pending entry
    // (`toPendingItems`), written by `pushGroup` when the branch reaches the
    // remote; it becomes a record once the file lands on the default branch
    // (`reconcilePlacementRecords`).
    if (outcome === 'pushed') anyPushed = true;
    if (outcome === 'pr-failed') anyPrFailed = true;
    configRider = false;
  }

  // Update state (pushState already carries the pendingPushes records above)
  const state = pushState;
  state.lastPush = new Date().toISOString();
  for (const item of selectedItems) {
    if (item.type === 'skills' && !state.pushedSkills.includes(item.name)) {
      state.pushedSkills.push(item.name);
    }
    if (item.type === 'rules' && !state.pushedRules.includes(item.name)) {
      state.pushedRules.push(item.name);
    }
    // A root-level local rule that landed under rules/<ns>/ is still authored
    // at the tool's rules root, so the scanner needs this record to recognise
    // it next time (RulesHandler.scanLocalForPush). A rule the scanner already
    // found in a subdirectory carries the namespace in its name and needs none.
    if (item.type === 'env' && !state.pushedEnvVars.includes(item.name)) {
      state.pushedEnvVars.push(item.name);
    }
  }
  await saveStateForScope(state, localConfig);
  // A real push completed only when a group actually pushed and no PR creation
  // failed. Not set on dry-run/cancel (return earlier), a no-change run (every
  // group 'nochange' → anyPushed stays false), or a PR-creation failure
  // (anyPrFailed) — so the caller does not fire a misleading webhook (#702 follow-up).
  if (result && anyPushed && !anyPrFailed) result.completed = true;
}

/**
 * Push a teamai.yaml-only change (e.g. from `teamai source add`) to the team repo
 * via a PR. Called when the user edited config but changed no resources, so the
 * normal resource-push path would exit with "No new or modified resources".
 *
 * Precondition: the working-tree teamai.yaml already carries the user's edits
 * (restored after pull in pushCore) and the repo is a dedicated git root.
 */
async function pushTeamConfigOnly(
  localConfig: LocalConfig,
  teamConfig: TeamaiConfig,
  options: GlobalOptions,
  result?: { completed: boolean },
): Promise<void> {
  console.log('');
  console.log('Found team config change to push:');
  console.log('  - teamai.yaml');
  console.log('');

  if (options.dryRun) {
    log.info('Dry run — no changes made');
    return;
  }

  const pushSpin = spinner('Pushing team config...').start();
  const branchName = generateBranchName(localConfig.username);
  const commitMsg = `[teamai] Update team config from ${localConfig.username}`;

  try {
    const hasChanges = await pushRepoBranch(
      localConfig.repo.localPath,
      commitMsg,
      ['teamai.yaml'],
      branchName,
    );
    if (!hasChanges) {
      pushSpin.succeed('No changes to push (config already up to date)');
      return;
    }
    pushSpin.succeed(`Pushed branch ${branchName}`);

    const prUrl = await createPrWithFallback(
      teamConfig,
      localConfig,
      branchName,
      commitMsg,
      'Updated team config (teamai.yaml)',
    );
    if (!prUrl) {
      process.exitCode = 1;
    } else if (result) {
      // A real config PR was pushed. Not set on dry-run or no-change (both
      // return earlier) or on PR-creation failure (#702 follow-up).
      result.completed = true;
    }

    await checkoutMaster(localConfig.repo.localPath);
  } catch (e) {
    pushSpin.fail(`Push failed: ${(e as Error).message}`);
    // pushRepoBranch may have left the repo on the push branch (e.g. it threw
    // mid-push after creating the local branch). Switch back to the default
    // branch so the next `teamai push` starts clean instead of stranded there.
    try {
      await checkoutMaster(localConfig.repo.localPath);
    } catch (cleanupErr) {
      log.debug(`Could not switch back to default branch: ${(cleanupErr as Error).message}`);
    }
    process.exitCode = 1;
    return;
  }
}
