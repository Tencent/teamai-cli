import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, pathExists, copyFile } from './utils/fs.js';
import { log } from './utils/logger.js';
import type { TeamaiConfig, LocalConfig } from './types.js';
import { resolveBaseDir } from './types.js';
import { ResourceHandler } from './resources/base.js';

// ─── Built-in agents deployment ──────────────────────────
//
//  CLI ships with built-in subagent definitions (e.g. teamai-recall).
//  These are bundled in the npm package under agents/.
//  On each `teamai pull`, we copy them to local AI tool
//  agents directories so they're always available and
//  stay in sync with the CLI version.
//
//  npm package
//    agents/teamai-recall.md
//      │
//      ▼  (teamai pull)
//    ~/.claude/agents/teamai-recall.md
//    ~/.claude-internal/agents/teamai-recall.md
//    ~/.codebuddy/agents/teamai-recall.md
//

/**
 * Names of CLI built-in agents. Used by `AgentsHandler.scanLocalForPush`
 * to exclude them from team repo push (they are CLI-managed, not team-managed).
 */
export const BUILTIN_AGENT_NAMES = new Set<string>(['teamai-recall']);

/**
 * Resolve the path to the built-in agents directory bundled with the CLI.
 * Mirrors getBuiltinSkillsDir() — `dist/` lives one level below the
 * package root, so we walk up to find `agents/`.
 */
function getBuiltinAgentsDir(): string {
  const distDir = path.dirname(new URL(import.meta.url).pathname);
  return path.join(distDir, '..', 'agents');
}

/**
 * Deploy CLI built-in agent .md files to every installed tool's agents
 * directory.
 *
 * Silently skips:
 * - Built-in directory missing (dev environment without build step)
 * - Tool whose toolPaths.<tool>.agents is unset (Tier-2/3/4 tools)
 * - Tool not yet installed on the user's machine
 *
 * Per-tool failures only log a warning and do not abort other tools.
 *
 * @returns Total number of (agent × tool) deployments performed
 */
export async function deployBuiltinAgents(
  teamConfig: TeamaiConfig,
  localConfig?: LocalConfig,
  options?: { skipRecall?: boolean },
): Promise<number> {
  const builtinDir = getBuiltinAgentsDir();
  if (!await pathExists(builtinDir)) {
    log.debug('No built-in agents directory found, skipping deployment');
    return 0;
  }

  let entries: string[];
  try {
    entries = await fs.promises.readdir(builtinDir);
  } catch {
    return 0;
  }

  const agentFiles = entries
    .filter((f) => f.endsWith('.md') && !f.startsWith('.'))
    .filter((f) => !(options?.skipRecall && f === 'teamai-recall.md'));
  if (agentFiles.length === 0) return 0;

  const baseDir = localConfig ? resolveBaseDir(localConfig) : (process.env.HOME ?? '');
  let deployed = 0;

  for (const [tool, toolPath] of Object.entries(teamConfig.toolPaths)) {
    if (!toolPath.agents) {
      log.debug(`Skipping built-in agent deployment for ${tool}: no agents path`);
      continue;
    }
    if (!await ResourceHandler.isToolInstalled(toolPath.agents, baseDir)) {
      log.debug(`Skipping built-in agent deployment for ${tool}: tool not installed`);
      continue;
    }

    const targetAgentsDir = path.join(baseDir, toolPath.agents);
    try {
      await ensureDir(targetAgentsDir);
    } catch (e) {
      log.warn(`Failed to create agents dir for ${tool}: ${(e as Error).message}`);
      continue;
    }

    for (const file of agentFiles) {
      const src = path.join(builtinDir, file);
      const dest = path.join(targetAgentsDir, file);
      try {
        await copyFile(src, dest);
        deployed++;
      } catch (e) {
        log.warn(`Failed to deploy built-in agent ${file} to ${tool}: ${(e as Error).message}`);
      }
    }
  }

  return deployed;
}
