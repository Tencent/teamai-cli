import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { LocalConfigSchema, type LocalConfig, type DashboardEvent } from '../types.js';
import { getUserHome } from '../utils/home.js';
import { resolveAnchors, listWorktrees } from '../utils/git.js';
import { readConfigFrom } from '../config.js';

export interface DashboardWorkspace {
  id: string;
  label: string;
  scope: 'user' | 'project' | 'unassigned';
  root: string;
  config: LocalConfig | null;
  roots: string[];
}
async function configAt(home: string): Promise<LocalConfig | null> {
  try { return LocalConfigSchema.parse(YAML.parse(await fs.readFile(path.join(home, 'config.yaml'), 'utf8'))); }
  catch { return null; }
}
const inside = (cwd: string, root: string) => cwd === root || cwd.startsWith(root + path.sep);
/** The project workspace that owns an event cwd (longest matching root wins), or null. */
function ownerOf(cwd: string, projects: DashboardWorkspace[]): string | null {
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
  async function add(root: string, dataHome: string) {
    if (seen.has(root)) return;
    if (!await fs.stat(root).then(stat => stat.isDirectory()).catch(() => false)) return;
    // readConfigFrom (no self-heal arg) parses + guards scope==='project' + re-anchors
    // projectRoot/dataHome + applies the self-mode repo rebind (config.ts). The manual
    // re-anchor here previously skipped that rebind, so a project first initialized from
    // a linked worktree read the wrong knowledge base (PR #604 review #1).
    const config = await readConfigFrom(dataHome, root);
    if (!config) return;
    seen.add(root);
    result.push({ id: createHash('sha256').update(root).digest('hex').slice(0, 24), label: path.basename(root), scope: 'project', root,
      config, roots: [...new Set([root, ...await listWorktrees(root).catch(() => [])])] });
  }
  const partitions = path.join(home, 'projects');
  for (const entry of await fs.readdir(partitions, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const dataHome = path.join(partitions, entry.name);
    const root = (await fs.readFile(path.join(dataHome, 'anchor'), 'utf8').catch(() => '')).trim();
    if (path.isAbsolute(root)) await add(root, dataHome);
  }
  for (const cwd of new Set([process.cwd(), ...events.map(event => event.cwd).filter(Boolean)])) {
    const anchors = await resolveAnchors(cwd).catch(() => null);
    if (anchors) {
      await add(anchors.projectAnchor, path.join(anchors.workspaceRoot, '.teamai'));
    } else if (cwd) await add(cwd, path.join(cwd, '.teamai'));
  }
  // Sessions whose cwd matches no installed project no longer fold into User scope
  // (that silently inflated it). Surface them in a dedicated "unassigned" bucket,
  // but only when such sessions actually exist (PR #604 review #3).
  const projects = result.filter(w => w.scope === 'project');
  if (events.some(event => event.cwd && !ownerOf(event.cwd, projects))) {
    result.push({ id: 'unassigned', label: 'Unassigned sessions', scope: 'unassigned', root: '', config: null, roots: [] });
  }
  return result;
}
export function workspaceEvents(events: DashboardEvent[], workspace: DashboardWorkspace, workspaces: DashboardWorkspace[]): DashboardEvent[] {
  const projects = workspaces.filter(w => w.scope === 'project');
  const owners = new Map<string, string>();
  for (const event of events) {
    const owner = event.cwd ? ownerOf(event.cwd, projects) : null;
    // First matching event fixes the whole session's owner; unmatched → 'unassigned'.
    if (!owners.has(event.sessionId)) owners.set(event.sessionId, owner ?? 'unassigned');
    else if (owner) owners.set(event.sessionId, owner);
  }
  return events.filter(event => owners.get(event.sessionId) === workspace.id);
}
