/**
 * Cursor's user-scope rules outside the home directory (#1197).
 *
 * Cursor (IDE and CLI) has no direct read of `~/.cursor/rules`. It walks up
 * from the workspace root and loads `<ancestor>/.cursor/rules` at each step
 * (`LocalCursorRulesService.loadRulesFromDirAndAncestors`), so the file a
 * user-scope pull writes reaches only a workspace under the home directory.
 * Anywhere else, teamai's sessionStart hook adds the same rules and
 * instruction blocks; under the home directory it adds nothing, since the
 * walk already loads the files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadLocalConfig, loadTeamConfig } from './config.js';
import { CURSOR_HOOK_CONTEXT_LIMIT } from './hook-dispatch.js';
import { instructionHookTextFor } from './instruction-targets.js';
import { teamRulesContext } from './resources/rules.js';
import { isAgentExcluded, resolveToolBaseDir, scopedToolPaths, type LocalConfig, type TeamaiConfig } from './types.js';
import { log } from './utils/logger.js';

async function canonicalPath(p: string): Promise<string> {
  const resolved = await fs.promises.realpath(p).catch(() => path.resolve(p));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Whether Cursor's walk up from `workspace` reaches `rulesDir`, directly or through a link on the way. */
async function cursorWalkReaches(workspace: string, rulesDir: string): Promise<boolean> {
  const target = await canonicalPath(rulesDir);
  let dir = path.resolve(workspace);
  for (;;) {
    if (await canonicalPath(path.join(dir, '.cursor', 'rules')) === target) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/** The user-scope rules directory a pull writes Cursor's rules to, or undefined when Cursor gets none. */
export function cursorUserRulesDir(teamConfig: TeamaiConfig, userConfig: LocalConfig): string | undefined {
  const rules = scopedToolPaths(teamConfig, userConfig).cursor?.rules;
  return rules === undefined ? undefined : path.join(resolveToolBaseDir('cursor', userConfig), rules);
}

/** The user-scope instruction blocks and team rules, as the hook adds them; null when there are none. */
export async function cursorUserRulesText(teamConfig: TeamaiConfig, userConfig: LocalConfig): Promise<string | null> {
  const parts = [await instructionHookTextFor(teamConfig, userConfig, 'cursor'), await teamRulesContext(teamConfig, userConfig)]
    .filter((part): part is string => !!part);
  return parts.length === 0 ? null : parts.join('\n\n');
}

/**
 * What the sessionStart hook adds for a Cursor session in `workspace`: the
 * user-scope rules when the walk does not reach their directory, else null.
 * `config` is the scope the hook resolved for the workspace; a project there
 * delivers its own rules into the workspace, so the user scope is loaded apart.
 */
export async function cursorUserRulesContext(workspace: string, config: LocalConfig): Promise<string | null> {
  const userConfig = config.scope === 'user' ? config : await loadLocalConfig();
  if (!userConfig || isAgentExcluded(userConfig, 'cursor')) return null;
  const teamConfig = await loadTeamConfig(userConfig.repo.localPath);
  if (!teamConfig) return null;
  const rulesDir = cursorUserRulesDir(teamConfig, userConfig);
  if (rulesDir === undefined || await cursorWalkReaches(workspace, rulesDir)) return null;
  const text = await cursorUserRulesText(teamConfig, userConfig);
  if (text !== null && text.length > CURSOR_HOOK_CONTEXT_LIMIT) {
    log.debug(`cursor-user-rules: ${text.length} characters, over Cursor's ${CURSOR_HOOK_CONTEXT_LIMIT}-character hook limit; not added`);
    return null;
  }
  return text;
}
