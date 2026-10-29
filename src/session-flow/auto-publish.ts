import { detectProjectConfig, loadLocalConfig, loadTeamConfig } from '../config.js';
import { getDataHome, type LocalConfig } from '../types.js';
import { readWorkspaceChildren } from '../workspace-children.js';
import { pathExists } from '../utils/fs.js';
import { log } from '../utils/logger.js';
import { SessionPolicy } from './session-policy.js';
import { SessionPublish } from './session-publish.js';


/**
 * The scopes `cwd` reaches: its project scope, with its workspace children, then the
 * user scope, each data home once. A directory that no longer exists reaches the user scope only.
 */
export async function reachedScopes(cwd?: string): Promise<LocalConfig[]> {
  const detected = cwd === undefined || await pathExists(cwd) ? await detectProjectConfig(cwd).catch(() => null) : null;
  const project = detected && await readWorkspaceChildren(detected);
  const user = await loadLocalConfig();
  const homes = new Set<string>();
  const scopes: LocalConfig[] = [];
  for (const config of [project, user]) {
    if (config === null || homes.has(getDataHome(config))) continue;
    homes.add(getDataHome(config));
    scopes.push(config);
  }
  return scopes;
}

export async function publishFinishedSessions(cwd: string): Promise<void> {
  for (const config of await reachedScopes(cwd)) {
    if (SessionPolicy.publish(config, await loadTeamConfig(config.repo.localPath)).policies.attended.policy !== 'auto') continue;
    const published = await SessionPublish.captured(config, 'attended', new Date().toISOString());
    for (const { sessions, reason } of published.unpublished) log.debug(`[sessions] ${sessions} session(s) were not archived: ${reason}`);
  }
}
