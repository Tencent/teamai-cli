import crypto from 'node:crypto';
import path from 'node:path';
import fse from 'fs-extra';
import type { TeamaiConfig, LocalConfig } from '../types.js';
import { isAgentExcluded, resolveBaseDir, resolveToolBaseDir, scopedToolPaths } from '../types.js';
import {
  listFilesRecursive,
  listDirs,
  pathExists,
  fileContentEqual,
  fileContentEqualToBuffer,
  copyFile,
  copyDir,
  dirTeamSubsetEqual,
  readFileSafe,
  writeFile,
} from './fs.js';
import { getFileContentAtRev, getFileContentWhenAdded } from './git.js';
import { isToolInstalledForConfig, ResourceHandler } from '../resources/base.js';
import { ruleFileExtensionForTool, usesCopilotInstructions, usesCursorMdcRules } from '../resources/rule-format.js';
import { teamRuleToCursorMdc, cursorMdcBodyEqualsTeamMd } from '../resources/cursor-mdc.js';
import { teamRuleToCopilotInstructions, copilotInstructionsBodyEqualsTeamMd } from '../resources/copilot-instructions.js';
import { EXCLUDED_RULE_NAMES } from '../builtin-rules.js';
import { log } from './logger.js';
import { placedResourcePath } from '../push-namespaces.js';
import { recordDelivered, type DeliveredHashes } from '../resources/delivered-copies.js';

const CONTRIBUTORS_FILE = 'CONTRIBUTORS';

/**
 * Sync team repo updates to local tool directories BEFORE scanning for push.
 *
 * Problem: `pullRepo()` updates ~/.teamai/team-repo/ but NOT the local tool
 * directories (~/.claude/rules/, ~/.workbuddy/rules/, etc.). Files changed by
 * teammates appear as locally "modified" because the local copy still has
 * the version from the user's last `teamai pull`.
 *
 * Solution: For each local file that differs from the current team repo HEAD,
 * check if the local copy matches a PREVIOUS team repo version (at one of
 * `baseRevs`). If yes, the user never edited it — the diff came from a
 * teammate's push — so sync the new version to local. If no, the user made
 * genuine edits — leave it alone for scanLocalForPush to pick up.
 *
 * `baseRevs` are the revisions an unedited copy can be at: the checkout's last
 * push base and its last pull revision (#812). A copy push left alone as edited
 * is still at the pull revision once the member undoes the edit.
 *
 * This is a no-op when there is no base revision (first run or after re-init).
 *
 * `placedRules` is `state.placedRules`: where push put each root-level local
 * rule inside the team repo. A rule authored at the tool's rules root and
 * placed under `rules/<ns>/` has no `rules/<name>.md` to compare against, so
 * without this map the three-way check below would skip it and the scanner —
 * which DOES follow the map — would then read the stale root copy as a local
 * modification and push it over a teammate's newer version.
 *
 * `delivered` is the checkout record's map of what teamai wrote (#822). Each
 * copy the sync writes is recorded there, or the next pull after a further
 * team change would read it as the member's edit and keep it.
 */
export async function syncTeamUpdatesToLocal(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  baseRevs: string | readonly string[] | null,
  placedRules?: Record<string, string>,
  delivered?: DeliveredHashes,
): Promise<void> {
  const bases = (typeof baseRevs === 'string' ? [baseRevs] : baseRevs ?? []).filter((rev) => rev !== '');
  if (bases.length === 0) {
    log.debug('No base revision — skipping pre-push sync');
    return;
  }

  const repoPath = localConfig.repo.localPath;
  const baseDir = resolveBaseDir(localConfig);

  await syncRulesToLocal(teamConfig, localConfig, repoPath, bases, placedRules, delivered);
  await syncSkillsToLocal(teamConfig, localConfig, repoPath, baseDir, bases, delivered);
}

/**
 * Sync rules: for each tool's rules/ directory, find rule files that differ
 * from the team repo and check whether the diff is from a team update.
 */
async function syncRulesToLocal(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  repoPath: string,
  bases: readonly string[],
  placedRules: Record<string, string> | undefined,
  delivered: DeliveredHashes | undefined,
): Promise<void> {
  const teamRulesDir = path.join(repoPath, 'rules');
  if (!await pathExists(teamRulesDir)) return;

  for (const [tool, toolPath] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
    if (!toolPath.rules) continue;
    if (isAgentExcluded(localConfig, tool)) continue;
    if (!await isToolInstalledForConfig(tool, toolPath.rules, localConfig)) continue;

    const rulesDir = path.join(resolveToolBaseDir(tool, localConfig), toolPath.rules);
    if (!await pathExists(rulesDir)) continue;

    // Cursor and Copilot copies have native extensions and derived frontmatter.
    // Compare their bodies with the team Markdown so stale copies are refreshed
    // rather than offered as edits that revert a teammate's update.
    const ext = ruleFileExtensionForTool(tool);
    const isMdcTool = usesCursorMdcRules(tool);
    const isCopilotTool = usesCopilotInstructions(tool);

    const files = await listFilesRecursive(rulesDir);
    for (const file of files) {
      if (!file.endsWith(ext)) continue;
      const name = file.slice(0, -ext.length);
      if (EXCLUDED_RULE_NAMES.has(name)) continue;

      const localFilePath = path.join(rulesDir, file);
      // The team repo always stores the tool-neutral `.md`.
      let teamRelPath = `rules/${name}.md`;
      let teamFilePath = path.join(teamRulesDir, `${name}.md`);

      // Same redirect as RulesHandler.scanLocalForPush, through the same
      // resolver: a root-level rule this machine pushed lives under rules/<ns>/
      // in the team repo, and both sides must compare against that file or the
      // scan reverts a teammate's update.
      const placed = placedResourcePath(placedRules, 'rules', name);
      let viaRecord = false;
      if (placed && await pathExists(path.join(repoPath, placed))) {
        teamRelPath = placed;
        teamFilePath = path.join(repoPath, placed);
        viaRecord = true;
      }
      // A placement that landed after the last pull did not exist at any
      // base, yet the author's root copy is exactly what landed. Its base is
      // the version the file was added with; without it a teammate's edit
      // before the author's next pull was skipped here, and the stale copy
      // went back over it (#649 review).
      const baseVersions = async (): Promise<Buffer[]> => {
        const atBases: Buffer[] = [];
        for (const rev of bases) {
          const content = await getFileContentAtRev(repoPath, rev, `./${teamRelPath}`);
          if (content !== null) atBases.push(content);
        }
        if (atBases.length > 0 || !viaRecord) return atBases;
        const added = await getFileContentWhenAdded(repoPath, teamRelPath);
        return added === null ? [] : [added];
      };

      // Only process files that exist in both places but differ
      if (!await pathExists(teamFilePath)) continue;
      if (isMdcTool || isCopilotTool) {
        const bodyEquals = isCopilotTool ? copilotInstructionsBodyEqualsTeamMd : cursorMdcBodyEqualsTeamMd;
        const render = isCopilotTool ? teamRuleToCopilotInstructions : teamRuleToCursorMdc;
        const localRaw = await readFileSafe(localFilePath);
        const teamRaw = await readFileSafe(teamFilePath);
        if (localRaw === null || teamRaw === null) continue;
        const sameBody = bodyEquals(localRaw, teamRaw);
        if (sameBody && (!isCopilotTool || localRaw === render(teamRaw))) continue;

        const oldContents = await baseVersions();
        if (oldContents.length === 0) continue; // Didn't exist at any base — ambiguous, skip

        // With only a scope change, require the whole old render to match so
        // a locally edited header is preserved. Body updates keep the existing
        // body comparison, since the team file has different frontmatter.
        if (oldContents.some((old) => sameBody
          ? localRaw === render(old.toString('utf-8'))
          : bodyEquals(localRaw, old.toString('utf-8')))) {
          await writeFile(localFilePath, render(teamRaw));
          if (delivered) await recordDelivered(delivered, localFilePath);
          log.debug(`Pre-push sync: updated ${tool} rule ${name} to match team repo`);
        }
        continue;
      }

      if (await fileContentEqual(localFilePath, teamFilePath)) continue;

      // They differ — check if local matches an old team repo version
      const oldContents = await baseVersions();
      if (oldContents.length === 0) continue; // File didn't exist at any base — ambiguous, skip

      let matchesBase = false;
      for (const oldContent of oldContents) {
        if (await fileContentEqualToBuffer(localFilePath, oldContent)) {
          matchesBase = true;
          break;
        }
      }
      if (matchesBase) {
        // Local matches old team version → team updated, user didn't → sync
        await copyFile(teamFilePath, localFilePath);
        if (delivered) await recordDelivered(delivered, localFilePath);
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
  localConfig: LocalConfig,
  repoPath: string,
  baseDir: string,
  bases: readonly string[],
  delivered: DeliveredHashes | undefined,
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

  for (const [tool, toolPath] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
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

      // Differs — the whole skill must be at ONE base: a skill whose files
      // come from different revisions was edited.
      const teamFiles = await listFilesRecursive(teamSkillDir);
      for (const base of bases) {
        if (await skillAtBase(repoPath, localSkillDir, teamSkillDir, teamFiles, base)) {
          // All differing files match that base → team updated, user didn't → sync
          await replaceSkillDir(teamSkillDir, localSkillDir);
          if (delivered) await recordDelivered(delivered, localSkillDir, teamSkillDir);
          log.debug(`Pre-push sync: updated ${tool} skill ${skillName} to match team repo`);
          break;
        }
      }
    }
  }
}

/**
 * Bring a local skill to the team version, or leave it as it was. A copy that
 * failed partway mixed files from two revisions, matched no base, and the next
 * push listed the skill as modified (#823). The update is built in a hidden
 * sibling, starting from the local copy so files only the member has survive
 * as they would a copy over it, and renamed into place.
 */
async function replaceSkillDir(teamSkillDir: string, localSkillDir: string): Promise<void> {
  const parent = path.dirname(localSkillDir);
  const tag = `${path.basename(localSkillDir)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
  const staged = path.join(parent, `.${tag}.teamai-sync`);
  const previous = path.join(parent, `.${tag}.teamai-prev`);
  try {
    await fse.copy(localSkillDir, staged);
    await copyDir(teamSkillDir, staged);
    await fse.rename(localSkillDir, previous);
  } catch (error) {
    await removeLeftover(staged);
    throw error;
  }
  try {
    await fse.rename(staged, localSkillDir);
  } catch (error) {
    const restored = await fse.rename(previous, localSkillDir).then(() => true, () => false);
    await removeLeftover(staged);
    if (!restored) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}; the previous version of the skill `
        + `could not be put back and is at ${previous}. Move it back to ${localSkillDir}.`);
    }
    throw error;
  }
  await removeLeftover(previous);
}

/**
 * Remove a directory replaceSkillDir left beside the skill. It carries the
 * local skill's modes, so a read-only one is made writable first; a symlink is
 * removed without touching its target. Tools may read a leftover as a skill,
 * so one that cannot be removed is reported.
 */
async function removeLeftover(dir: string): Promise<void> {
  try {
    const stat = await fse.lstat(dir).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat === null) return;
    if (stat.isDirectory()) await fse.chmod(dir, 0o700);
    await fse.remove(dir);
  } catch (error) {
    log.warn(`Could not remove ${dir} (${error instanceof Error ? error.message : String(error)}). Delete it by hand.`);
  }
}

/**
 * Whether every file of a local skill that differs from the team repo is the
 * version at `base` (and some file differs), so the difference is a teammate's
 * update rather than the member's edit.
 */
async function skillAtBase(
  repoPath: string,
  localSkillDir: string,
  teamSkillDir: string,
  teamFiles: readonly string[],
  base: string,
): Promise<boolean> {
  let anyDiffers = false;

  for (const file of teamFiles) {
    if (file === CONTRIBUTORS_FILE) continue;

    const localFile = path.join(localSkillDir, file);
    const teamFile = path.join(teamSkillDir, file);
    const relFromRepo = path.relative(repoPath, teamFile);

    if (!await pathExists(localFile)) {
      // File is new in team repo — check if it existed at base
      const oldContent = await getFileContentAtRev(repoPath, base, `./${relFromRepo}`);
      // Existed at base but is missing locally — ambiguous, skip sync
      if (oldContent !== null) return false;
      // New file added by teammate since base → safe to sync
      anyDiffers = true;
      continue;
    }

    if (await fileContentEqual(localFile, teamFile)) continue;

    anyDiffers = true;

    const oldContent = await getFileContentAtRev(repoPath, base, `./${relFromRepo}`);
    // Can't determine old version — ambiguous, don't sync
    if (oldContent === null) return false;
    // Local differs from old version → user edited this file
    if (!await fileContentEqualToBuffer(localFile, oldContent)) return false;
  }

  return anyDiffers;
}
