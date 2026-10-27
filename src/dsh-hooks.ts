/**
 * DeepSeek Harness hook bridge.
 *
 * DSH ships the Claude Code hook bridge as a loadable plugin, but it does not
 * read Claude's settings files itself. Keep the generated Claude-compatible
 * hook config under TeamAI's data directory, and mount the plugin from the
 * member's `$DSH_HOME/cordis.patch.yml`, which dsh applies on every boot (#1219).
 */

import path from 'node:path';
import YAML from 'yaml';
import { reconcileHooks } from './hooks.js';
import type { BuiltinHookOverride } from './builtin-hooks.js';
import { isAgentExcluded, type HookDef, type LocalConfig } from './types.js';
import { hookAdapterDir } from './locate.js';
import { toolHome } from './tool-home.js';
import { pathExists, readFileSafe, remove, writeIfChanged } from './utils/fs.js';
import { log } from './utils/logger.js';

export const DSH_HOOK_CONFIG_FILE = 'hooks.json';
export const DSH_PATCH_FILE = 'cordis.patch.yml';
export const DSH_HOOK_PLUGIN_ID = 'teamai-hooks-claude-code';
export const DSH_HOOK_PLUGIN_PACKAGE = '@deepseek-ai/dsh-hooks-claude-code';

/**
 * Whether DeepSeek Harness is installed: its home (`toolHome('dsh')`) exists.
 * The hook bridge, the user-scope rules file, doctor and init all ask here.
 */
export async function isDshInstalled(): Promise<boolean> {
  return pathExists(toolHome('dsh'));
}

export function resolveDshHookConfigPath(): string {
  return path.join(hookAdapterDir('dsh-hooks'), DSH_HOOK_CONFIG_FILE);
}

/**
 * The `dsh --patch` overlay teamai asked members to pass before #1219. It is
 * kept as an empty patch list: dsh fails to boot on a missing overlay, and the
 * home patch already mounts the hooks, so inserting them again would load them twice.
 */
export function resolveDshPatchPath(): string {
  return path.join(hookAdapterDir('dsh-hooks'), DSH_PATCH_FILE);
}

const DSH_LEGACY_PATCH = '# teamai mounts its hooks from $DSH_HOME/cordis.patch.yml. Passing this file to dsh --patch is no longer needed.\n[]\n';

/** The patch list dsh applies on every boot: the member's file, in which teamai owns one row. */
export function resolveDshHomePatchPath(): string {
  return path.join(toolHome('dsh'), DSH_PATCH_FILE);
}

const isTeamaiRow = (entry: unknown): boolean => YAML.isMap(entry) && entry.get('id') === DSH_HOOK_PLUGIN_ID;

/**
 * Set teamai's row in `$DSH_HOME/cordis.patch.yml` to mount `configPath`, or
 * drop it when `configPath` is null, keeping the member's rows and comments.
 * A file left with no rows is removed. Returns whether the file changed, or
 * null when it does not parse as a patch list, in which case it is left alone.
 */
async function mountDshHooks(configPath: string | null): Promise<boolean | null> {
  const file = resolveDshHomePatchPath();
  const content = await readFileSafe(file);
  const doc: YAML.Document = YAML.parseDocument(content ?? '');
  if (doc.errors.length > 0) return null;
  if (doc.contents === null) doc.contents = doc.createNode([]);
  const rows = doc.contents;
  if (!YAML.isSeq(rows)) return null;
  let removedAny = false;
  rows.items = rows.items.filter((row) => {
    const insert = YAML.isMap(row) ? row.get('insert') : undefined;
    if (!YAML.isSeq(insert) || !insert.items.some(isTeamaiRow)) return true;
    removedAny = true;
    insert.items = insert.items.filter((entry) => !isTeamaiRow(entry));
    return insert.items.length > 0;
  });
  if (configPath !== null) {
    rows.items.push(doc.createNode({
      insert: [{ id: DSH_HOOK_PLUGIN_ID, name: DSH_HOOK_PLUGIN_PACKAGE, config: { configPath } }],
    }));
  } else if (!removedAny) {
    return false;
  }
  if (rows.items.length === 0) {
    if (content === null) return false;
    const hasComments = Boolean(
      doc.commentBefore || doc.comment || doc.contents?.commentBefore || doc.contents?.comment,
    ) || /#/.test(doc.toString());
    if (hasComments) {
      return writeIfChanged(file, doc.toString());
    }
    await remove(file);
    return true;
  }
  return writeIfChanged(file, doc.toString());
}

/** Whether `$DSH_HOME/cordis.patch.yml` mounts teamai's hooks from `configPath`. */
export async function isDshHooksMounted(configPath: string): Promise<boolean> {
  const content = await readFileSafe(resolveDshHomePatchPath());
  const doc = YAML.parseDocument(content ?? '');
  const rows: unknown = doc.errors.length > 0 ? null : doc.toJS();
  return Array.isArray(rows) && rows.some((row: { insert?: unknown }) => Array.isArray(row?.insert)
    && row.insert.some((entry: { id?: unknown; name?: unknown; config?: { configPath?: unknown } }) =>
      entry?.id === DSH_HOOK_PLUGIN_ID && entry.name === DSH_HOOK_PLUGIN_PACKAGE && entry.config?.configPath === configPath));
}

/**
 * dsh runs hook commands in its sandbox, `DSH_PERMISSION_MODE` (default
 * `workspace-write`) rooted where dsh starts, so the hooks that write
 * teamai's state cannot unless that is $HOME (#1219). Null when dsh is not
 * installed or excluded, or the sandbox is off.
 */
export async function dshSandboxNote(localConfig: Pick<LocalConfig, 'disabledAgents' | 'enabledAgents'>): Promise<string | null> {
  if (isAgentExcluded(localConfig, 'dsh') || !(await isDshInstalled())) return null;
  if (process.env.DSH_PERMISSION_MODE === 'danger-full-access') return null;
  return 'DeepSeek Harness runs teamai\'s hooks in its sandbox, which lets them write only under the directory dsh '
    + 'starts in. Unless that is your home directory, or DSH_PERMISSION_MODE=danger-full-access is set, the '
    + 'session-start sync and usage tracking cannot write teamai\'s state: run `teamai pull` yourself.';
}

export interface DshHookReconcileOptions {
  /** Omitted to reconcile the built-in hooks alone (see ReconcileHooksOptions.manifestPath). */
  manifestPath?: string;
  removeAll?: boolean;
  builtinOverride?: BuiltinHookOverride;
  /** The team hook ids a workspace holds back (#913), kept as installed. */
  heldTeamHookIds?: readonly string[];
}

/**
 * Reconcile TeamAI's normal Claude-shaped hook set into DSH's bridge config,
 * and mount it from `$DSH_HOME/cordis.patch.yml`. The adapter is intentionally
 * user-scoped: DSH's skill provider and its home patch both resolve from the
 * user's DSH installation, even when TeamAI is reconciling a project-scoped
 * team config.
 */
export async function reconcileDshHooks(
  teamDefs: HookDef[],
  opts: DshHookReconcileOptions,
): Promise<void> {
  const configPath = resolveDshHookConfigPath();
  const patchPath = resolveDshPatchPath();

  await reconcileHooks(configPath, 'dsh', teamDefs, {
    manifestPath: opts.manifestPath,
    removeAll: opts.removeAll,
    builtinOverride: opts.builtinOverride,
    heldTeamHookIds: opts.heldTeamHookIds,
  });

  const homePatchPath = resolveDshHomePatchPath();
  if (opts.removeAll) {
    const mounted = await mountDshHooks(null);
    if (mounted === null) {
      log.warn(`${homePatchPath} is not a YAML patch list, so teamai left it as it is and could not remove `
        + "teamai's DeepSeek Harness hooks. Fix the file, then run `teamai hooks remove`.");
    } else if (mounted) {
      log.success(`Removed teamai's DeepSeek Harness hooks from ${homePatchPath}`);
    }
    if (await pathExists(patchPath)) await remove(patchPath);
    return;
  }

  await writeIfChanged(patchPath, DSH_LEGACY_PATCH);
  const mounted = await mountDshHooks(configPath);
  if (mounted === null) {
    log.warn(`${homePatchPath} is not a YAML patch list, so teamai left it as it is and DeepSeek Harness `
      + 'does not load teamai\'s hooks. Fix the file, then run `teamai hooks inject`.');
  } else if (mounted) {
    log.success(`DeepSeek Harness loads teamai's hooks from ${homePatchPath}`);
  }
}
