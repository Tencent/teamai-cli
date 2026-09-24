/**
 * DeepSeek Harness hook bridge.
 *
 * DSH ships the Claude Code hook bridge as a loadable plugin, but it does not
 * read Claude's settings files itself. Keep the generated Claude-compatible
 * hook config under TeamAI's data directory and provide a small Cordis patch
 * that users can add to their dsh invocation.
 */

import path from 'node:path';
import { reconcileHooks } from './hooks.js';
import type { BuiltinHookOverride } from './builtin-hooks.js';
import type { HookDef } from './types.js';
import { getUserHome } from './utils/home.js';
import { pathExists, remove, writeIfChanged } from './utils/fs.js';
import { log } from './utils/logger.js';

export const DSH_HOOK_CONFIG_FILE = 'hooks.json';
export const DSH_PATCH_FILE = 'cordis.patch.yml';
export const DSH_HOOK_PLUGIN_ID = 'teamai-hooks-claude-code';
export const DSH_HOOK_PLUGIN_PACKAGE = '@deepseek-ai/dsh-hooks-claude-code';

/** The TeamAI-managed DSH bridge directory under the resolved user home. */
export function resolveDshHooksDir(): string {
  return path.join(getUserHome(), '.teamai', 'dsh');
}

export function resolveDshHookConfigPath(): string {
  return path.join(resolveDshHooksDir(), DSH_HOOK_CONFIG_FILE);
}

export function resolveDshPatchPath(): string {
  return path.join(resolveDshHooksDir(), DSH_PATCH_FILE);
}

/**
 * Build the user patch overlay consumed by `dsh --patch <path>`.
 * JSON-quoting the absolute path is valid YAML and preserves Windows
 * backslashes without relying on YAML escape rules.
 */
export function buildDshPatch(configPath: string): string {
  return [
    '- insert:',
    `    - id: ${DSH_HOOK_PLUGIN_ID}`,
    `      name: ${JSON.stringify(DSH_HOOK_PLUGIN_PACKAGE)}`,
    '      config:',
    `        configPath: ${JSON.stringify(configPath)}`,
    '',
  ].join('\n');
}

export interface DshHookReconcileOptions {
  manifestPath: string;
  removeAll?: boolean;
  builtinOverride?: BuiltinHookOverride;
}

/**
 * Reconcile TeamAI's normal Claude-shaped hook set into DSH's bridge config.
 * The adapter is intentionally user-scoped: DSH's skill provider and the
 * `--patch` launcher both resolve from the user's DSH installation, even when
 * TeamAI is reconciling a project-scoped team config.
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
  });

  if (opts.removeAll) {
    if (await pathExists(patchPath)) {
      await remove(patchPath);
      log.success(`Removed DeepSeek Harness hook patch from ${patchPath}`);
    }
    return;
  }

  const changed = await writeIfChanged(patchPath, buildDshPatch(configPath));
  if (changed) {
    log.info(`DeepSeek Harness hooks prepared. Add --patch "${patchPath}" to your dsh command to enable them.`);
  }
}
