/**
 * Open-PR bookkeeping for `teamai push`.
 *
 * push decides what to send by diffing local resources against the team repo's
 * default branch. A resource sitting in an unmerged PR is absent from that
 * branch, so it looks brand new on every run — re-running push used to open one
 * duplicate PR after another (each branch name carries a fresh timestamp, so
 * git-level deduplication never kicked in either).
 *
 * After a successful push we therefore remember the branch, its PR URL and the
 * resources it carries. Later runs cross-check the scan against those records
 * and force-push the recorded branch — updating the existing PR in place —
 * instead of opening a duplicate.
 */
import path from 'node:path';
import { pathExists } from './fs.js';
import { remoteBranchExists, hashObject, blobInHistory, pathAddedSince, pathDeletedSince, getHeadCommit, getFileContentAtRev } from './git.js';
import { placedResourcePath } from '../push-namespaces.js';
import { log } from './logger.js';
import type { PendingPush, PendingPushItem, ResourceItem, State } from '../types.js';

/** Type and name: the identity a record is kept by while anything of that name is still scanned. */
function itemKey(type: string, name: string): string {
  return `${type}:${name}`;
}

/**
 * Whether a recorded resource is this scanned item. A resource already on the
 * team repo is its destination: same-named skills in two namespaces are two
 * resources with two PRs. A new one has no destination until the PR's record
 * or placement gives it one, and the scan keeps one new item per name, so its
 * name identifies it. Every record carries `relativePath`, so records written
 * by earlier versions match the same way.
 */
export function isRecordedItem(recorded: PendingPushItem, item: ResourceItem): boolean {
  if (recorded.type !== item.type) return false;
  return item.status === 'new' ? recorded.name === item.name : recorded.relativePath === item.relativePath;
}

/**
 * The namespace a record's resource goes to, or undefined for the shared root.
 * Read from `relativePath`, which every record carries and which is what the
 * PR's branch holds, never from the `namespace` field alone: records written
 * by earlier versions lack it, and where the two disagree the path wins.
 */
export function recordedNamespace(recorded: PendingPushItem): string | undefined {
  const segments = recorded.relativePath.split('/');
  return segments.length > 2 ? segments[1] : undefined;
}

/**
 * The open-PR records that can decide where a new skill goes: for each
 * destination not on the team repo, the newest record carrying a skill of that
 * name, newest first. A same-named team skill elsewhere — a teammate's
 * shared-root one, say — does not change them: the copy was never delivered
 * from there, and the record says where it went. A record whose destination is
 * on the team repo is an edit, matched by path (`isRecordedItem`), and decides
 * nothing here. Several: the name awaits review at more than one destination,
 * and no record says which of them a copy belongs to.
 */
export async function openPrDestinations(input: {
  pending: readonly PendingPush[];
  name: string;
  repoPath: string;
}): Promise<{ branch: string; recorded: PendingPushItem }[]> {
  const newestFirst = [...input.pending].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const found: { branch: string; recorded: PendingPushItem }[] = [];
  for (const entry of newestFirst) {
    const recorded = entry.items.find((i) => i.type === 'skills' && i.name === input.name);
    if (!recorded || found.some((f) => f.recorded.relativePath === recorded.relativePath)) continue;
    if (!await pathExists(path.join(input.repoPath, recorded.relativePath))) found.push({ branch: entry.branch, recorded });
  }
  return found;
}

/**
 * Drop records whose branch is gone from origin, before the scan reads them
 * for destinations. `prunePendingPushes` applies the scan-presence rule after
 * the scan; the two together keep exactly what it keeps on its own.
 */
export async function dropClosedPendingPushes(repoPath: string, pending: PendingPush[]): Promise<PendingPush[]> {
  const kept: PendingPush[] = [];
  for (const entry of pending ?? []) {
    if (await remoteBranchExists(repoPath, entry.branch) === false) {
      log.debug(`Dropping pending push ${entry.branch}: branch gone from origin`);
      continue;
    }
    kept.push(entry);
  }
  return kept;
}

/**
 * Drop records that no longer describe an open PR:
 *   - the branch is gone from origin (PR merged or closed, branch deleted)
 *   - none of its resources show up in the current scan (PR merged with the
 *     branch retained, so the resources now live on the default branch)
 *
 * Records are kept when the remote cannot be reached, so a flaky network never
 * resurrects the duplicate-PR behaviour.
 */
export async function prunePendingPushes(
  repoPath: string,
  pending: PendingPush[],
  scanned: ResourceItem[],
): Promise<{ pending: PendingPush[]; changed: boolean }> {
  // Kept by name, a superset of destination matches: a record kept too long is
  // only ever used through `isRecordedItem`, while one dropped too early opens a
  // duplicate PR — e.g. a --role run that moves the scanned path away from it.
  const scannedKeys = new Set(scanned.map((i) => itemKey(i.type, i.name)));
  const kept: PendingPush[] = [];
  // State files written before this field existed parse to undefined.
  const entries = pending ?? [];

  for (const entry of entries) {
    const stillScanned = entry.items.some((i) => scannedKeys.has(itemKey(i.type, i.name)));
    if (!stillScanned) {
      log.debug(`Dropping pending push ${entry.branch}: resources no longer pending`);
      continue;
    }
    const exists = await remoteBranchExists(repoPath, entry.branch);
    if (exists === false) {
      log.debug(`Dropping pending push ${entry.branch}: branch gone from origin`);
      continue;
    }
    kept.push(entry);
  }

  return { pending: kept, changed: kept.length !== entries.length };
}

/** All open-PR records that already carry the given resource. */
export function findPendingForItem(pending: PendingPush[], item: ResourceItem): PendingPush[] {
  return (pending ?? []).filter((entry) => entry.items.some((i) => isRecordedItem(i, item)));
}

/** One branch + PR worth of resources. `reuse` set = update that open PR. */
export interface PushGroup {
  items: ResourceItem[];
  reuse?: PendingPush;
}

/**
 * Split a selection into one group per branch/PR.
 *
 * An open PR is updated by rebuilding its branch from the default branch and
 * force-pushing, which only holds up if every resource that PR carries is in
 * the group — the ones left out would otherwise vanish from the PR. So a record
 * is reused only when the selection covers all of its resources, and whatever
 * is left over goes into a new PR of its own rather than being absorbed into
 * someone else's review. Newest records claim their resources first, and reuse
 * groups run before the new-PR group.
 */
export function planPushGroups(
  selected: ResourceItem[],
  pending: PendingPush[],
): PushGroup[] {
  const claimed = new Set<ResourceItem>();
  const groups: PushGroup[] = [];

  const newestFirst = [...(pending ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const entry of newestFirst) {
    if (entry.items.length === 0) continue;
    const items = entry.items.map((recorded) => selected.find((i) => isRecordedItem(recorded, i)));
    if (!items.every((i): i is ResourceItem => i !== undefined && !claimed.has(i))) continue;
    for (const i of items) claimed.add(i);
    groups.push({ items, reuse: entry });
  }

  const rest = selected.filter((i) => !claimed.has(i));
  if (rest.length > 0) groups.push({ items: rest });

  return groups;
}

/**
 * Records the selection only partly covers. Those resources cannot update their
 * PR in place, so they end up in a second PR — worth warning about.
 */
export function partiallySelectedEntries(
  selected: ResourceItem[],
  pending: PendingPush[],
): PendingPush[] {
  return (pending ?? []).filter((entry) => {
    const hits = entry.items.filter((recorded) => selected.some((i) => isRecordedItem(recorded, i))).length;
    return hits > 0 && hits < entry.items.length;
  });
}

/**
 * Namespace recorded for a resource in an open PR, so updates keep its
 * destination; undefined for the shared root or when the PR does not carry it.
 */
export function pendingNamespaceFor(entry: PendingPush, item: ResourceItem): string | undefined {
  const recorded = entry.items.find((i) => isRecordedItem(i, item));
  return recorded && recordedNamespace(recorded);
}

/** Insert or replace the record for a branch. */
export function recordPendingPush(state: State, entry: PendingPush): void {
  state.pendingPushes = [
    ...(state.pendingPushes ?? []).filter((e) => e.branch !== entry.branch),
    entry,
  ];
}

/**
 * The pending-entry view of the pushed items. Called after `pushItem` and
 * before the branch is switched away, while `relativePath` is the file this
 * run wrote: a placed item records its blob so landing can later be proven.
 */
export async function toPendingItems(items: ResourceItem[], repoPath: string): Promise<PendingPush['items']> {
  const out: PendingPush['items'] = [];
  for (const i of items) {
    // A placement is marked only with the blob that can prove it landed:
    // without one, reconcile would have nothing but the path existing, which
    // another member's later file at that path also satisfies (#649 review).
    const blob = isPlacement(i) ? await hashObject(repoPath, i.relativePath) : null;
    if (isPlacement(i) && !blob) {
      log.warn(`[${i.type}] ${i.name}: could not hash ${i.relativePath}, so this machine will not treat it as its placement once merged.`);
    }
    out.push({
      type: i.type,
      name: i.name,
      relativePath: i.relativePath,
      namespace: i.namespace,
      ...(blob ? { placed: true, blob } : {}),
    });
  }
  return out;
}

/**
 * Whether pushing `item` PLACED it: a root-authored rule or agent that this
 * run wrote under `<root>/<ns>/`, which is what a placement record is for.
 * The author's copy stays at the tool's resource root, so the scanner needs
 * the record to recognise the two as one resource (`RulesHandler`), and
 * `AgentsHandler` needs it to accept a source whose namespace this directory
 * has not activated.
 *
 * Only a `new` item that ended up namespaced counts. A `modified` one was
 * found in its namespace by the scanner, which means that namespace is active
 * here and the scan will find it again; recording it would turn a temporary
 * activation into standing permission to keep editing an agent long after the
 * role or project that granted it was dropped. The one exception is an agent
 * the scan reached THROUGH its record and rewrote under another extension
 * (`supersedes`): the record has to follow it to the new path.
 */
export function isPlacement(item: ResourceItem): boolean {
  if (item.type === 'agents' && 'supersedes' in item && typeof item.supersedes === 'string') return true;
  if (item.status !== 'new' || !item.namespace) return false;
  // A rule the scanner already found in a subdirectory carries the namespace
  // in its name and matches by full path, so it needs no record.
  if (item.type === 'rules') return !item.name.includes('/');
  return item.type === 'agents';
}

/** The shared-root file(s) that, if present, mean `name` is not ours to redirect. */
function sharedRootPaths(root: 'rules' | 'agents', name: string): string[] {
  return root === 'rules' ? [`rules/${name}.md`] : [`agents/${name}.yaml`, `agents/${name}.md`];
}

/**
 * Bring the placement records (`placedRules`, `placedAgents`) in line with
 * the default branch as just pulled. Three moves, in this order:
 *
 *   1. A placement still listed on a pending push whose pushed blob entered
 *      the default branch's history for that path after the revision the
 *      push branch was built on has landed — the PR merged,
 *      however the platform merged it — and becomes a record. The path merely
 *      existing is not enough: another member may have created it after the
 *      PR was closed, and recording it then would hand their file to this
 *      author. Nothing is recorded before landing, so a PR closed unmerged
 *      leaves no record whether or not its branch was deleted, and no provider
 *      has to be asked whether a PR is open. While the PR is open the pending
 *      entry itself routes the author's edits back to it (`reuseRecordedDestinations`).
 *      Recording consumes the mark, so a placement is recorded exactly once,
 *      and a placement whose path was deleted after it landed is spent unrecorded.
 *   2. A record whose file is gone from the default branch is dropped: the
 *      team deleted the resource. Kept, it would come true again the day
 *      another member creates that path, and their unrelated resource would
 *      then read as this author's. For the same reason a record whose file
 *      was deleted since the last check (`placementsCheckedAt`) is dropped
 *      even when the path exists again.
 *   3. In legacy mode (no roles, no projects; asked of `deliversEveryNamespace`
 *      only when a shared-root file is there), a record whose
 *      bare name is now ALSO a shared-root file is dropped, with a warning: the
 *      author's root copy can no longer stand for the namespaced resource,
 *      because every namespace ships there and the shared-root rule of that
 *      name is what every tool dir holds at that path, so following the record
 *      would push that unrelated rule over the author's namespaced one. With
 *      roles or projects the recorded resource replaces the shared-root one of
 *      its name instead, as an active namespace's would (#707), and the record
 *      stays.
 *
 * Runs after the pull in `push` and after the refresh in `pull`, before
 * anything reads the records. Returns whether `state` changed.
 *
 * `tip` names the default branch as a git ref, for a checkout that is not the
 * default branch itself — a single-repo member's own working tree. Without
 * it, the working tree and HEAD are the default branch as just pulled.
 */
export async function reconcilePlacementRecords(
  repoPath: string,
  state: Pick<State, 'placedRules' | 'placedAgents' | 'pendingPushes' | 'placementsCheckedAt' | 'retiredPlacedAgents'>,
  tip?: string,
  deliversEveryNamespace: () => Promise<boolean> = async () => false,
): Promise<boolean> {
  // A ref that cannot be resolved says nothing about any file: reading every
  // record as "gone" against it would drop them all.
  if (tip && !await getHeadCommit(repoPath, tip)) {
    log.debug(`Placement records not reconciled: ${tip} cannot be resolved here`);
    return false;
  }
  const exists = tip
    ? async (rel: string) => await getFileContentAtRev(repoPath, tip, `./${rel}`) !== null
    : (rel: string) => pathExists(path.join(repoPath, rel));
  const history = tip ?? 'HEAD';
  let changed = false;
  const checkedAt = state.placementsCheckedAt;
  // Recorded in step 1 of this very run, against their own `base`: the
  // previous checkpoint predates them and says nothing about them.
  const recordedNow = new Set<string>();
  const fieldFor = (type: string): 'placedRules' | 'placedAgents' | null => (
    type === 'rules' ? 'placedRules' : type === 'agents' ? 'placedAgents' : null
  );

  // 1. Landed placements become records.
  for (const entry of state.pendingPushes ?? []) {
    for (const item of entry.items) {
      if (!item.placed) continue;
      const field = fieldFor(item.type);
      if (!field) continue;
      // Without the blob push wrote, landing cannot be told from another
      // member creating the same path after this PR closed unmerged, so the
      // mark is spent rather than recorded on the path existing (#649 review).
      if (!item.blob) {
        log.debug(`Not recording placement ${field}.${item.name}: no blob to prove it landed`);
        item.placed = false;
        changed = true;
        continue;
      }
      if (!await exists(item.relativePath)) continue;
      // Bounded by `base`: the same bytes may have sat at this path before the
      // push, and a PR closed unmerged must not borrow that history.
      if (await blobInHistory(repoPath, item.blob, item.relativePath, entry.base, history) !== true) {
        // The path arrived after this push, but never with what it pushed: a
        // reviewer changed the PR before a squash merge, or somebody else
        // created the path. The two cannot be told apart, so nothing is
        // recorded — but say so once, or the author's next push meets a
        // collision on what may well be their own file.
        if (entry.base && await pathAddedSince(repoPath, entry.base, item.relativePath, history) === true) {
          log.warn(
            `[${item.type}] ${item.name}: ${item.relativePath} reached the default branch after your push, but not `
            + 'with the content you pushed, so it is not treated as yours. If a reviewer changed your PR before it '
            + `merged, run \`teamai pull\` and edit ${item.relativePath} as the team file it now is; your root copy `
            + 'would otherwise be pushed as a new resource.',
          );
          item.placed = false;
          delete item.blob;
          changed = true;
        }
        continue;
      }
      // Placement refuses an occupied path, so a deletion since `base` came
      // after this placement landed: what is there now was recreated by
      // someone else, and the placement is spent without a record.
      if (entry.base && await pathDeletedSince(repoPath, entry.base, item.relativePath, history) === true) {
        log.debug(`Not recording placement ${field}.${item.name}: ${item.relativePath} was deleted after it landed`);
        item.placed = false;
        delete item.blob;
        changed = true;
        continue;
      }
      log.debug(`Recording placement ${field}.${item.name} → ${item.relativePath}: landed on the default branch`);
      state[field] = { ...state[field], [item.name]: item.relativePath };
      recordedNow.add(`${field}:${item.name}`);
      // Consumed: a placement is recorded once. Left marked, it would record
      // again after the team deleted the file and another member recreated
      // the path — the blob stays in history, so the check above would still
      // pass — and hand their file to this author.
      item.placed = false;
      delete item.blob;
      changed = true;
    }
  }

  // 2 and 3. Records the default branch no longer backs.
  for (const [field, root] of [['placedRules', 'rules'], ['placedAgents', 'agents']] as const) {
    const records = state[field];
    if (!records) continue;
    const kept: Record<string, string> = {};
    for (const [name, recorded] of Object.entries(records)) {
      const valid = placedResourcePath(records, root, name);
      if (valid && !await exists(valid)) {
        log.debug(`Dropping placement record ${field}.${name} → ${recorded}: gone from the default branch`);
        // The author's flattened copy stood for this agent; once the removal
        // is tombstoned, that is still what the copy is (`removedStems`).
        if (field === 'placedAgents') state.retiredPlacedAgents = { ...state.retiredPlacedAgents, [name]: valid };
        changed = true;
        continue;
      }
      // Deleted and recreated between two checks — a removal that merged, then
      // another member's resource at the same path — is not this author's.
      if (valid && checkedAt && !recordedNow.has(`${field}:${name}`)
        && await pathDeletedSince(repoPath, checkedAt, valid, history) === true) {
        log.debug(`Dropping placement record ${field}.${name} → ${recorded}: deleted from the default branch since the last check`);
        // The file this record named was deleted, exactly as in the branch
        // above; what is there now is somebody else's, but the author's copy
        // still stood for the removed agent (#649 review).
        if (field === 'placedAgents') state.retiredPlacedAgents = { ...state.retiredPlacedAgents, [name]: valid };
        changed = true;
        continue;
      }
      let shadowed: string | undefined;
      for (const candidate of sharedRootPaths(root, name)) {
        if (await exists(candidate)) { shadowed = candidate; break; }
      }
      if (shadowed && await deliversEveryNamespace()) {
        log.warn(
          `[${root}] ${name}: ${shadowed} now exists at the shared root, so your local ${name} follows that `
          + `file from here on and no longer stands for ${recorded}. Edit ${recorded} through its namespace.`,
        );
        changed = true;
        continue;
      }
      kept[name] = recorded;
    }
    state[field] = kept;
  }

  // The revision the surviving records were checked against, so the next run
  // sees a deletion that happened in between even if the path is back by then.
  // With no record left there is nothing it could vouch for, and kept it would
  // later read a deletion from before a new record existed as that record's.
  if (Object.keys(state.placedRules ?? {}).length + Object.keys(state.placedAgents ?? {}).length > 0) {
    const head = await getHeadCommit(repoPath, history);
    if (head && head !== state.placementsCheckedAt) {
      state.placementsCheckedAt = head;
      changed = true;
    }
  } else if (state.placementsCheckedAt !== undefined) {
    delete state.placementsCheckedAt;
    changed = true;
  }
  return changed;
}
