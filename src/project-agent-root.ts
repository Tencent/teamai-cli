import { stat } from 'node:fs/promises';
import path from 'node:path';

import { detectProjectConfig, loadTeamConfig } from './config.js';
import { KNOWN_AGENTS } from './known-agents.js';
import { isAgentDisabled, resolveBaseDir, scopedToolPaths, toolInstallRoot } from './types.js';
import { ensureDir, pathExists } from './utils/fs.js';
import { checkoutForProjectAnchor, resolveAnchors } from './utils/git.js';
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
 * Project scope: create the install roots of a set of tools under the current
 * checkout (e.g. `<checkout>/.claude`, `<checkout>/.codex`) so a subsequent
 * `teamai pull` has somewhere to write. Bare `teamai pull` does not create
 * agent roots, except the first pull of an inherited submodule clone
 * (seedInheritedCheckoutRoots); only callers that know which tools the member uses do.
 *
 * `tools` defaults to `enabledAgents`; when that is empty too, to the tools
 * whose root the main checkout already has (a linked worktree then looks like
 * the checkout it came from). A tool is skipped when it is disabled, outside a
 * non-empty `enabledAgents`, unknown, or its resolved root would escape the
 * checkout. No-op outside project scope.
 */
export async function createProjectToolRoots(options: {
  cwd?: string;
  tools?: readonly string[];
} = {}): Promise<void> {
  const requested = options.tools && normalizeIds(options.tools);
  if (requested?.length === 0) return;

  const projectConfig = await detectProjectConfig(options.cwd);
  if (!projectConfig) return;

  const enabled = projectConfig.enabledAgents ?? [];
  const teamConfig = await loadTeamConfig(projectConfig.repo.localPath);
  const baseDir = resolveBaseDir(projectConfig);

  const rootOf = (id: string): string | undefined => {
    if (isAgentDisabled(projectConfig, id)) return undefined;
    if (enabled.length > 0 && !enabled.includes(id)) return undefined;
    const skillsPath = resolveSkillsPath(id, teamConfig, projectConfig);
    if (!skillsPath) return undefined;
    const root = toolInstallRoot(skillsPath);
    return isSafeRelativeRoot(root) ? root : undefined;
  };

  const ids = requested
    ?? (enabled.length > 0 ? normalizeIds(enabled) : await toolsInMainCheckout(baseDir, teamConfig, rootOf));

  for (const id of ids) {
    const root = rootOf(id);
    if (!root) continue;
    const dest = path.join(baseDir, root);
    // A checkout removed meanwhile is not created again (#1424).
    if (!await pathExists(baseDir)) return;
    await ensureDir(dest);
    log.debug(`Seeded project agent root for ${id}: ${dest}`);
  }
}

function normalizeIds(tools: readonly string[]): string[] {
  return [...new Set(tools.map((tool) => tool.trim()).filter(Boolean))];
}

/** Tools (known or named in teamai.yaml toolPaths) whose root exists in the main checkout of `checkout`. */
async function toolsInMainCheckout(
  checkout: string,
  teamConfig: Awaited<ReturnType<typeof loadTeamConfig>>,
  rootOf: (id: string) => string | undefined,
): Promise<string[]> {
  const anchors = await resolveAnchors(checkout);
  let mainCheckout = anchors?.mainCheckout;
  // An inherited submodule clone is its own main checkout; it came from the original submodule (#1041).
  if (anchors && mainCheckout === checkout) mainCheckout = await checkoutForProjectAnchor(anchors.projectAnchor);
  if (!mainCheckout || mainCheckout === checkout) return [];
  const candidates = normalizeIds([
    ...KNOWN_AGENTS.map((agent) => agent.id),
    ...Object.keys(teamConfig?.toolPaths ?? {}),
  ]);
  const present: string[] = [];
  for (const id of candidates) {
    const root = rootOf(id);
    if (root && (await isDirectory(path.join(mainCheckout, root)))) present.push(id);
  }
  return present;
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A submodule clone in a superproject worktree inherits its identity, but no
 * teamai post-checkout ran for it: the superproject created it. Its first pull
 * seeds the roots a new linked worktree gets (#1041). `source-missing` means
 * the original checkout is gone; leave the marker unset so a later pull retries.
 */
export async function seedInheritedCheckoutRoots(cwd: string): Promise<'seeded' | 'not-needed' | 'source-missing'> {
  const anchors = await resolveAnchors(cwd);
  if (!anchors || anchors.mainCheckout !== anchors.workspaceRoot) return 'not-needed';
  const original = await checkoutForProjectAnchor(anchors.projectAnchor);
  if (original === anchors.workspaceRoot) return 'not-needed';
  if (!original) return 'source-missing';
  await createProjectToolRoots({ cwd });
  return 'seeded';
}

/**
 * Project-scope SessionStart: create the *current* agent's install root, the
 * one tool that just opened. See {@link createProjectToolRoots}.
 */
export async function seedProjectAgentRoot(tool: string, cwd?: string): Promise<void> {
  await createProjectToolRoots({ cwd, tools: [tool] });
}
