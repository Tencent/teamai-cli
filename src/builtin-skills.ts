import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, pathExists } from './utils/fs.js';
import { log } from './utils/logger.js';
import type { TeamaiConfig } from './types.js';

// ─── Built-in skills deployment ──────────────────────────
//
//  CLI ships with built-in skills (e.g. teamai-contribute).
//  These are bundled in the npm package under skills/.
//  On each `teamai pull`, we copy them to local AI tool
//  skill directories so they're always available and
//  stay in sync with the CLI version.
//
//  npm package
//    skills/teamai-contribute/SKILL.md
//      │
//      ▼  (teamai pull / teamai init)
//    ~/.claude/skills/teamai-contribute/SKILL.md
//    ~/.claude-internal/skills/teamai-contribute/SKILL.md
//    ~/.cursor/skills/teamai-contribute/SKILL.md
//    ...
//

/**
 * Get the path to the built-in skills directory bundled with the CLI.
 * Resolves relative to the dist/ directory where the compiled CLI lives.
 */
function getBuiltinSkillsDir(): string {
  // __dirname equivalent for ESM: import.meta.url → file path → parent
  const distDir = path.dirname(new URL(import.meta.url).pathname);
  // skills/ is at package root, dist/ is one level down
  return path.join(distDir, '..', 'skills');
}

/** Names of CLI built-in skills. Used by push to exclude them from team repo push. */
export const BUILTIN_SKILL_NAMES = new Set(['teamai-share-learnings']);

/**
 * Deploy CLI built-in skills to all configured AI tool skill directories.
 *
 * Copies each skill directory from the npm package's skills/ folder
 * to every tool's skills path defined in teamai.yaml.
 *
 * Silently skips if:
 * - Built-in skills directory doesn't exist (dev environment without build)
 * - A tool's skills directory is not configured
 */
export async function deployBuiltinSkills(teamConfig: TeamaiConfig): Promise<number> {
  const builtinDir = getBuiltinSkillsDir();

  if (!await pathExists(builtinDir)) {
    log.debug('No built-in skills directory found, skipping deployment');
    return 0;
  }

  let entries: string[];
  try {
    entries = await fs.promises.readdir(builtinDir);
  } catch {
    return 0;
  }

  // Filter to directories that contain SKILL.md
  const skillNames: string[] = [];
  for (const entry of entries) {
    const skillMd = path.join(builtinDir, entry, 'SKILL.md');
    if (await pathExists(skillMd)) {
      skillNames.push(entry);
    }
  }

  if (skillNames.length === 0) return 0;

  const home = process.env.HOME ?? '';
  let deployed = 0;

  for (const [_tool, toolPath] of Object.entries(teamConfig.toolPaths)) {
    if (!toolPath.skills) continue;

    const targetSkillsDir = path.join(home, toolPath.skills);

    for (const skillName of skillNames) {
      const srcDir = path.join(builtinDir, skillName);
      const destDir = path.join(targetSkillsDir, skillName);

      try {
        await ensureDir(destDir);

        // Copy all files in the skill directory
        const files = await fs.promises.readdir(srcDir);
        for (const file of files) {
          const srcFile = path.join(srcDir, file);
          const destFile = path.join(destDir, file);

          const stat = await fs.promises.stat(srcFile);
          if (stat.isFile()) {
            await fs.promises.copyFile(srcFile, destFile);
          }
        }

        deployed++;
      } catch (e) {
        log.debug(`Failed to deploy built-in skill ${skillName} to ${toolPath.skills}: ${(e as Error).message}`);
      }
    }
  }

  return deployed;
}
