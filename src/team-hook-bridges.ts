/**
 * The team hooks OpenCode's and OMP's user-wide bridges may run (#1492).
 *
 * Their bridge files are generated once per scope and are not a hook list, so
 * "what pull applied" has nowhere to live. Reconcile records the hooks it
 * applied here — after `resolveTeamHooks`' security gates (kill switch,
 * `requireTeamScripts`, `autoApply`, the resolved namespace set) — and the live
 * dispatcher runs only what this index holds. A hook on a branch checked out
 * after the last pull, or a hook a pull held back, therefore does not run until
 * a pull applies it, exactly like the settings-based tools.
 *
 * Keys: `user` for a user-scope install (its bridge runs in every project), and
 * the shared project anchor for a project-scope install (every checkout of that
 * project). A project install never falls back to the user record.
 */
import path from 'node:path';
import { realpathSync } from 'node:fs';
import {
  getTeamaiHomeDir,
  type HookDef,
  type LocalConfig,
  type Scope,
} from './types.js';
import { readJson, writeJson } from './utils/fs.js';
import { resolveAnchors } from './utils/git.js';
import { log } from './utils/logger.js';

/** One hook as the bridge dispatcher needs it (gates already applied). */
export interface BridgeTeamHook {
  id: string;
  event: string;
  matcher?: string;
  command: string;
  timeout?: number;
}

interface BridgeRecord {
  user?: BridgeTeamHook[];
  projects?: Record<string, BridgeTeamHook[]>;
}

type BridgeIndex = Record<string, BridgeRecord>;

/** `<home>/.teamai/team-hook-bridges.json`, evaluated at call time for tests. */
export function teamHookBridgeIndexPath(): string {
  return path.join(getTeamaiHomeDir(), 'team-hook-bridges.json');
}

async function readIndex(): Promise<BridgeIndex> {
  const raw = await readJson<BridgeIndex>(teamHookBridgeIndexPath());
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

/** The project key a config belongs to: the shared anchor, else the real path. */
async function projectKey(projectRoot: string): Promise<string> {
  const anchors = await resolveAnchors(projectRoot);
  if (anchors) return anchors.projectAnchor;
  try {
    return realpathSync.native(projectRoot);
  } catch {
    return path.resolve(projectRoot);
  }
}

function bridgeHooks(defs: readonly HookDef[], tool: string): BridgeTeamHook[] {
  return defs
    .filter((def) => def.source === 'team'
      && (!def.tools || def.tools.includes('*') || def.tools.includes(tool)))
    .map((def) => ({
      id: def.key,
      event: def.event,
      ...(def.matcher ? { matcher: def.matcher } : {}),
      command: def.command,
      ...(def.timeout !== undefined ? { timeout: def.timeout } : {}),
    }));
}

/**
 * Record (or clear) the team hooks a reconcile applied for `tool`. `removeAll`
 * and an empty set remove the entry, so a disabled, held-back or removed hook
 * stops running without waiting for another event.
 */
export async function recordAppliedTeamHooks(
  tool: string,
  defs: readonly HookDef[],
  options: { scope: Scope; projectRoot?: string; removeAll?: boolean },
): Promise<void> {
  const index = await readIndex();
  const record: BridgeRecord = index[tool] ?? {};
  const hooks = options.removeAll ? [] : bridgeHooks(defs, tool);
  if (options.scope === 'user') {
    if (hooks.length > 0) record.user = hooks;
    else delete record.user;
  } else {
    if (!options.projectRoot) return;
    const key = await projectKey(options.projectRoot);
    const projects = record.projects ?? {};
    if (hooks.length > 0) projects[key] = hooks;
    else delete projects[key];
    if (Object.keys(projects).length > 0) record.projects = projects;
    else delete record.projects;
  }
  if (record.user !== undefined || record.projects !== undefined) index[tool] = record;
  else delete index[tool];
  try {
    await writeJson(teamHookBridgeIndexPath(), index);
  } catch (e) {
    log.warn(`Could not record the team hooks ${tool} runs: ${(e as Error).message}`);
  }
}

/** The team hooks recorded for this config's scope and project. */
export async function appliedTeamHooksFor(tool: string, localConfig: LocalConfig): Promise<BridgeTeamHook[]> {
  const record = (await readIndex())[tool];
  if (!record) return [];
  if (localConfig.scope === 'user') return record.user ?? [];
  const root = localConfig.projectRoot ?? localConfig.repo.businessRepoRoot;
  if (!root) return [];
  return record.projects?.[await projectKey(root)] ?? [];
}
