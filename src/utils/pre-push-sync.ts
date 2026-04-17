import path from 'node:path';
import type { TeamaiConfig, LocalConfig } from '../types.js';
import { resolveBaseDir } from '../types.js';
import {
  listFilesRecursive,
  listDirs,
  pathExists,
  fileContentEqual,
  fileContentEqualToBuffer,
  copyFile,
  copyDir,
  dirTeamSubsetEqual,
} from './fs.js';
import { getFileContentAtRev } from './git.js';
import { ResourceHandler } from '../resources/base.js';
import { EXCLUDED_RULE_NAMES } from '../builtin-rules.js';
import { log } from './logger.js';

/**
 * Sync team repo updates to local tool directories BEFORE scanning for push.
 *
 * Problem: `pullRepo()` updates ~/.teamai/team-repo/ but NOT the local tool
 * directories (~/.claude/rules/, ~/.workbuddy/rules/, etc.). Files changed by
 * teammates appear as locally "modified" because the local copy still has
 * the version from the user's last `teamai pull`.
 *
 * Solution: For each local file that differs from the current team repo HEAD,
 * check if the local copy matches the PREVIOUS team repo version (at
 * `lastPullRev`). If yes, the user never edited it — the diff came from a
 * teammate's push — so sync the new version to local. If no, the user made
 * genuine edits — leave it alone for scanLocalForPush to pick up.
 *
 * This is a no-op when `lastPullRev` is null (first run or after re-init).
 */
export async function syncTeamUpdatesToLocal(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  lastPullRev: string | null,
): Promise<void> {
  if (!lastPullRev) {
    log.debug('No lastPullRev — skipping pre-push sync');
    return;
  }

  const repoPath = localConfig.repo.localPath;
  const baseDir = resolveBaseDir(localConfig);

  await syncRulesToLocal(teamConfig, localConfig, repoPath, baseDir, lastPullRev);
  await syncSkillsToLocal(teamConfig, localConfig, repoPath, baseDir, lastPullRev);
}

/**
 * Sync rules: for each tool's rules/ directory, find rule files that differ
 * from the team repo and check whether the diff is from a team update.
 */
async function syncRulesToLocal(
  teamConfig: TeamaiConfig,
  _localConfig: LocalConfig,
  repoPath: string,
  baseDir: string,
  lastPullRev: string,
): Promise<void> {
  const teamRulesDir = path.join(repoPath, 'rules');
  if (!await pathExists(teamRulesDir)) return;

  for (const [tool, toolPath] of Object.entries(teamConfig.toolPaths)) {
    if (!toolPath.rules) continue;
    if (!await ResourceHandler.isToolInstalled(toolPath.rules, baseDir)) continue;

    const rulesDir = path.join(baseDir, toolPath.rules);
    if (!await pathExists(rulesDir)) continue;

    const files = await listFilesRecursive(rulesDir);
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const name = file.replace(/\.md$/, '');
      if (EXCLUDED_RULE_NAMES.has(name)) continue;

      const localFilePath = path.join(rulesDir, file);
      const teamFilePath = path.join(teamRulesDir, file);

      // Only process files that exist in both places but differ
      if (!await pathExists(teamFilePath)) continue;
      if (await fileContentEqual(localFilePath, teamFilePath)) continue;

      // They differ — check if local matches the old team repo version
      const oldContent = await getFileContentAtRev(repoPath, lastPullRev, `rules/${file}`);
      if (oldContent === null) continue; // File didn't exist at lastPullRev — ambiguous, skip

      if (await fileContentEqualToBuffer(localFilePath, oldContent)) {
        // Local matches old team version → team updated, user didn't → sync
        await copyFile(teamFilePath, localFilePath);
        log.debug(`Pre-push sync: updated ${tool} rule ${name} to match team repo`);
      }
      // else: local differs from old version too → user edited → leave alone
    }
  }
}

/**
 * Sync skills: for each tool's skills/ directory, find skill dirs that differ
 * from the team repo and check whether the diff is from a team update.
 */
async function syncSkillsToLocal(
  teamConfig: TeamaiConfig,
  _localConfig: LocalConfig,
  repoPath: string,
  baseDir: string,
  lastPullRev: string,
): Promise<void> {
  const teamSkillsDir = path.join(repoPath, 'skills');
  if (!await pathExists(teamSkillsDir)) return;

  // Build map of team repo skill dirs (handling both flat and namespaced layout)
  const teamSkillPaths = new Map<string, string>(); // skillName → absolute path in team repo
  const topDirs = await listDirs(teamSkillsDir);
  for (const dir of topDirs) {
    const dirPath = path.join(teamSkillsDir, dir);
    if (await pathExists(path.join(dirPath, 'SKILL.md'))) {
      // Flat skill at top level
      teamSkillPaths.set(dir, dirPath);
    } else {
      // Namespace directory — scan subdirectories
      const subDirs = await listDirs(dirPath);
      for (const subDir of subDirs) {
        if (!teamSkillPaths.has(subDir)) {
          teamSkillPaths.set(subDir, path.join(dirPath, subDir));
        }
      }
    }
  }

  const CONTRIBUTORS_FILE = 'CONTRIBUTORS';

  for (const [tool, toolPath] of Object.entries(teamConfig.toolPaths)) {
    if (!toolPath.skills) continue;
    if (!await ResourceHandler.isToolInstalled(toolPath.skills, baseDir)) continue;

    const skillsDir = path.join(baseDir, toolPath.skills);
    if (!await pathExists(skillsDir)) continue;

    const localSkillNames = await listDirs(skillsDir);
    for (const skillName of localSkillNames) {
      if (!teamSkillPaths.has(skillName)) continue;

      const localSkillDir = path.join(skillsDir, skillName);
      const teamSkillDir = teamSkillPaths.get(skillName)!;

      // Quick check: if already equal, skip
      if (await dirTeamSubsetEqual(localSkillDir, teamSkillDir, [CONTRIBUTORS_FILE])) continue;

      // Differs — check each file in the team skill dir against the old version
      const teamFiles = await listFilesRecursive(teamSkillDir);
      let allMatchOld = true;
      let anyDiffers = false;

      for (const file of teamFiles) {
        if (file === CONTRIBUTORS_FILE) continue;

        const localFile = path.join(localSkillDir, file);
        const teamFile = path.join(teamSkillDir, file);

        if (!await pathExists(localFile)) {
          // File is new in team repo — check if it existed at lastPullRev
          const relFromRepo = path.relative(repoPath, teamFile);
          const oldContent = await getFileContentAtRev(repoPath, lastPullRev, relFromRepo);
          if (oldContent === null) {
            // New file added by teammate since lastPullRev → safe to sync
            anyDiffers = true;
            continue;
          }
          // File existed at old rev but is missing locally — ambiguous, skip sync
          allMatchOld = false;
          break;
        }

        if (await fileContentEqual(localFile, teamFile)) continue;

        anyDiffers = true;

        // Determine the git path for this file relative to repo root
        const relFromRepo = path.relative(repoPath, teamFile);
        const oldContent = await getFileContentAtRev(repoPath, lastPullRev, relFromRepo);
        if (oldContent === null) {
          // Can't determine old version — ambiguous, don't sync
          allMatchOld = false;
          break;
        }
        if (!await fileContentEqualToBuffer(localFile, oldContent)) {
          // Local differs from old version → user edited this file
          allMatchOld = false;
          break;
        }
      }

      if (anyDiffers && allMatchOld) {
        // All differing files match old version → team updated, user didn't → sync
        await copyDir(teamSkillDir, localSkillDir);
        log.debug(`Pre-push sync: updated ${tool} skill ${skillName} to match team repo`);
      }
    }
  }
}
