import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { LocalConfigSchema, getDataHome, type LocalConfig, type DashboardEvent } from '../types.js';
import { getUserHome } from '../utils/home.js';
import { checkoutForProjectAnchor, resolveAnchors } from '../utils/git.js';
import { readConfigFrom } from '../config.js';
import { projectCheckouts } from '../pull.js';
import { dataHomeKey } from '../dashboard-collector.js';

export interface DashboardWorkspace {
  id: string;
  label: string;
  scope: 'user' | 'project' | 'unassigned';
  root: string;
  config: LocalConfig | null;
  roots: string[];
  projectAnchor?: string;
  /** Key of this scope's data home — the identity Copilot events are attributed by (#1121). */
  dataHomeKey?: string;
}
async function configAt(home: string): Promise<LocalConfig | null> {
  try { return LocalConfigSchema.parse(YAML.parse(await fs.readFile(path.join(home, 'config.yaml'), 'utf8'))); }
  catch { return null; }
}
const inside = (cwd: string, root: string) => cwd === root || cwd.startsWith(root + path.sep);
/**
 * The project workspace that owns an event, or null: the project rooted at the
 * event's projectAnchor, which still names it after its worktree is removed
 * (#809), else the one whose roots hold its cwd (longest matching root wins).
 */
function ownerOf(event: DashboardEvent, projects: DashboardWorkspace[]): string | null {
  const anchored = event.projectAnchor && projects.find(w => (w.projectAnchor ?? w.root) === event.projectAnchor);
  if (anchored) return anchored.id;
  const cwd = event.cwd;
  if (!cwd) {
    // Copilot hook events carry neither cwd nor projectAnchor (parseHookEvent drops
    // the cwd by design; the monitor-sourced process_exit records an empty string,
    // #1121). The dataHomeKey the dispatcher wrote from the resolved scope is then
    // the only surviving project identity, so attribute by it.
    const keyed = event.dataHomeKey && projects.find(w => w.dataHomeKey === event.dataHomeKey);
    return keyed ? keyed.id : null;
  }
  const matches = projects.filter(w => w.roots.some(root => inside(cwd, root)));
  if (!matches.length) return null;
  return matches.sort((a, b) =>
    Math.max(...b.roots.filter(root => inside(cwd, root)).map(root => root.length)) -
    Math.max(...a.roots.filter(root => inside(cwd, root)).map(root => root.length)))[0].id;
}
/** Read installed scopes without bootstrapping or migrating other projects. */
export async function dashboardWorkspaces(events: DashboardEvent[]): Promise<DashboardWorkspace[]> {
  const home = path.join(getUserHome(), '.teamai');
  const user = await configAt(home);
  const result: DashboardWorkspace[] = [{ id: 'user', label: 'User scope', scope: 'user', root: getUserHome(), config: user, roots: [] }];
  const seen = new Set<string>();
  async function add(anchor: string, dataHome: string, recordedRoot?: string) {
    if (seen.has(anchor)) return;
    const persisted = await configAt(dataHome);
    const root = await checkoutForProjectAnchor(anchor, recordedRoot ?? persisted?.repo.businessRepoRoot ?? persisted?.projectRoot)
      ?? (persisted?.projectRoot === anchor ? anchor : null);
    if (!root) return;
    if (!await fs.stat(root).then(stat => stat.isDirectory()).catch(() => false)) return;
    // readConfigFrom (no self-heal arg) parses + guards scope==='project' + re-anchors
    // projectRoot/dataHome + applies the self-mode repo rebind (config.ts). The manual
    // re-anchor here previously skipped that rebind, so a project first initialized from
    // a linked worktree read the wrong knowledge base (PR #604 review #1).
    const config = await readConfigFrom(dataHome, root);
    if (!config) return;
    seen.add(anchor);
    // Key the data home the config names, not the path add() guessed by: the
    // dispatcher writes the event's dataHomeKey from getDataHome(config) (:2470),
    // and a migrated project's config points at the partitioned home while the
    // guess may be the in-repo `.teamai` it was found through.
    result.push({ id: createHash('sha256').update(anchor).digest('hex').slice(0, 24), label: path.basename(root), scope: 'project', root, projectAnchor: anchor,
      config, roots: [...new Set([root, ...await projectCheckouts(config)])], dataHomeKey: await dataHomeKey(getDataHome(config)) });
  }
  const partitions = path.join(home, 'projects');
  for (const entry of await fs.readdir(partitions, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const dataHome = path.join(partitions, entry.name);
    const root = (await fs.readFile(path.join(dataHome, 'anchor'), 'utf8').catch(() => '')).trim();
    if (path.isAbsolute(root)) await add(root, dataHome);
  }
  // An event that recorded its repo names the project, even after its worktree
  // is gone; git is asked only for the rest: older events, this process's cwd,
  // and an anchor with no config of its own (a legacy `.teamai/` in a worktree).
  for (const anchor of new Set(events.flatMap(event => event.projectAnchor ? [event.projectAnchor] : []))) {
    await add(anchor, path.join(anchor, '.teamai'));
  }
  const unnamed = events.filter(event => !event.projectAnchor || !seen.has(event.projectAnchor));
  for (const cwd of new Set([process.cwd(), ...unnamed.map(event => event.cwd).filter(Boolean)])) {
    const anchors = await resolveAnchors(cwd).catch(() => null);
    if (anchors) {
      await add(anchors.projectAnchor, path.join(anchors.workspaceRoot, '.teamai'), anchors.workspaceRoot);
    } else if (cwd) await add(cwd, path.join(cwd, '.teamai'));
  }
  // Sessions whose cwd matches no installed project no longer fold into User scope
  // (that silently inflated it). Surface them in a dedicated "unassigned" bucket,
  // but only when such sessions actually exist (PR #604 review #3).
  const projects = result.filter(w => w.scope === 'project');
  if (events.some(event => event.cwd && !ownerOf(event, projects))) {
    result.push({ id: 'unassigned', label: 'Unassigned sessions', scope: 'unassigned', root: '', config: null, roots: [] });
  }
  return result;
}
/** The project workspace each session belongs to by its first matching event, or `unassigned` when none owns it. */
function sessionOwners(events: DashboardEvent[], workspaces: DashboardWorkspace[]): Map<string, string> {
  const projects = workspaces.filter(w => w.scope === 'project');
  const owners = new Map<string, string>();
  for (const event of events) {
    const owner = ownerOf(event, projects);
    // First matching event fixes the whole session's owner; unmatched → 'unassigned'.
    if (!owners.has(event.sessionId)) owners.set(event.sessionId, owner ?? 'unassigned');
    else if (owner) owners.set(event.sessionId, owner);
  }
  return owners;
}

export function workspaceEvents(events: DashboardEvent[], workspace: DashboardWorkspace, workspaces: DashboardWorkspace[]): DashboardEvent[] {
  const owners = sessionOwners(events, workspaces);
  return events.filter(event => owners.get(event.sessionId) === workspace.id);
}

/**
 * The events of the sessions `workspace` counts as its own on this machine, for a view of machine-wide state such as the
 * friction reminder table (#1182): a user scope install owns every session no project workspace owns, which the session
 * views list as unassigned instead.
 */
export function ownSessionEvents(events: DashboardEvent[], workspace: DashboardWorkspace, workspaces: DashboardWorkspace[]): DashboardEvent[] {
  const owners = sessionOwners(events, workspaces);
  const owner = workspace.scope === 'user' ? 'unassigned' : workspace.id;
  return events.filter(event => owners.get(event.sessionId) === owner);
}
