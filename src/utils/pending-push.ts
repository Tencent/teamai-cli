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
import { remoteBranchExists } from './git.js';
import { log } from './logger.js';
import type { PendingPush, ResourceItem, State } from '../types.js';

/** Identity used to match a recorded resource against a fresh scan result. */
function itemKey(type: string, name: string): string {
  return `${type}:${name}`;
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
  const key = itemKey(item.type, item.name);
  return (pending ?? []).filter(
    (entry) => entry.items.some((i) => itemKey(i.type, i.name) === key),
  );
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
  const byKey = new Map(selected.map((i) => [itemKey(i.type, i.name), i]));
  const claimed = new Set<string>();
  const groups: PushGroup[] = [];

  const newestFirst = [...(pending ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const entry of newestFirst) {
    const keys = entry.items.map((i) => itemKey(i.type, i.name));
    if (keys.length === 0) continue;
    if (!keys.every((k) => byKey.has(k) && !claimed.has(k))) continue;
    for (const k of keys) claimed.add(k);
    groups.push({ items: keys.map((k) => byKey.get(k)!), reuse: entry });
  }

  const rest = selected.filter((i) => !claimed.has(itemKey(i.type, i.name)));
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
  const selectedKeys = new Set(selected.map((i) => itemKey(i.type, i.name)));
  return (pending ?? []).filter((entry) => {
    const keys = entry.items.map((i) => itemKey(i.type, i.name));
    const hits = keys.filter((k) => selectedKeys.has(k)).length;
    return hits > 0 && hits < keys.length;
  });
}

/** Namespace recorded for a skill in an open PR, so updates keep its destination. */
export function pendingNamespaceFor(entry: PendingPush, item: ResourceItem): string | undefined {
  const key = itemKey(item.type, item.name);
  return entry.items.find((i) => itemKey(i.type, i.name) === key)?.namespace;
}

/** Insert or replace the record for a branch. */
export function recordPendingPush(state: State, entry: PendingPush): void {
  state.pendingPushes = [
    ...(state.pendingPushes ?? []).filter((e) => e.branch !== entry.branch),
    entry,
  ];
}

export function toPendingItems(items: ResourceItem[]): PendingPush['items'] {
  return items.map((i) => ({
    type: i.type,
    name: i.name,
    relativePath: i.relativePath,
    namespace: i.namespace,
  }));
}
