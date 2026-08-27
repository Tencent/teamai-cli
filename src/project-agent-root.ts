import path from 'node:path';

import { detectProjectConfig, loadTeamConfig } from './config.js';
import { KNOWN_AGENTS } from './known-agents.js';
import { toolInstallRoot } from './resources/base.js';
import { isAgentDisabled, resolveBaseDir, scopedToolPaths } from './types.js';
import { ensureDir } from './utils/fs.js';
import { log } from './utils/logger.js';

/**
 * Relative agent-root paths we are willing to mkdir under projectRoot.
 * Must stay relative, dotted (`.claude`, `.config/opencode`), and free of `..`.
 */
function isSafeRelativeRoot(root: string): boolean {
  if (!root) return false;
  const posix = root.replaceAll('\\', '/');
  if (path.isAbsolute(root) || path.isAbsolute(posix)) return false;
  if (posix === '~' || posix.startsWith('~/')) return false;
  const segments = posix.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return false;
  return segments[0].startsWith('.');
}

function resolveSkillsPath(
  tool: string,
  teamConfig: Awaited<ReturnType<typeof loadTeamConfig>>,
  localConfig: { scope?: 'project' | 'user' },
): string | undefined {
  if (teamConfig) {
    const fromTeam = scopedToolPaths(teamConfig, localConfig)[tool]?.skills;
    if (fromTeam) return fromTeam;
  }
  return KNOWN_AGENTS.find((agent) => agent.id === tool)?.skillsPath;
}

/**
 * Project-scope SessionStart: create the *current* agent's install root under
 * the project (e.g. `<project>/.claude`) so a subsequent `teamai pull` has
 * somewhere to write. Bare `teamai pull` / `teamai init` still do not create
 * agent roots — only the hook that knows which tool just opened does.
 *
 * No-ops when: not project scope, the tool is disabled / not in enabledAgents,
 * the tool is unknown, or the resolved root would escape the project.
 */
export async function seedProjectAgentRoot(tool: string, cwd?: string): Promise<void> {
  const id = tool.trim();
  if (!id) return;

  const projectConfig = await detectProjectConfig(cwd);
  if (!projectConfig) return;

  if (isAgentDisabled(projectConfig, id)) return;
  const enabled = projectConfig.enabledAgents;
  if (enabled && enabled.length > 0 && !enabled.includes(id)) return;

  const teamConfig = await loadTeamConfig(projectConfig.repo.localPath);
  const skillsPath = resolveSkillsPath(id, teamConfig, projectConfig);
  if (!skillsPath) return;

  const root = toolInstallRoot(skillsPath);
  if (!isSafeRelativeRoot(root)) return;

  const dest = path.join(resolveBaseDir(projectConfig), root);
  await ensureDir(dest);
  log.debug(`Seeded project agent root for ${id}: ${dest}`);
}
