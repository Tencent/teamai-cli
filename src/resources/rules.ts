import path from 'node:path';
import { isToolInstalledForConfig, ResourceHandler, type PlacementRecords } from './base.js';
import type { CopyOrigin, ResourceItem, ResourceItemStatus, DeliveryTarget, TeamaiConfig, LocalConfig } from '../types.js';
import { listFilesRecursive, pathExists, copyFile, ensureDir, remove, fileContentEqual, getFileMtime, listDirs, readFileSafe, writeFile, pruneEmptyDirs, fileHash } from '../utils/fs.js';
import { log } from '../utils/logger.js';
import { getUserHome } from '../utils/home.js';
import { warnOnce } from '../utils/warn-once.js';
import { TEAMAI_RULES_START, TEAMAI_RULES_END, TEAMAI_TEAM_RULES_START, TEAMAI_TEAM_RULES_END, resolveBaseDir, resolveToolBaseDir, resolveToolRootDir, isAgentExcluded, isGitExcludeEnabled, scopedToolPaths, SELF_KNOWLEDGE_SCAN_KEY, getUserConfigPath } from '../types.js';
import { EXCLUDED_RULE_NAMES, isDeployedRecallRule, TEAMAI_CONTEXT_RULE_NAME } from '../builtin-rules.js';
import { rulePaths, teamRuleBody, teamRuleData } from './team-rule.js';
import { joycodeQuotedGlobsWarning } from './joycode-rule.js';
import type { OpencodeRulesTarget } from './opencode-config.js';
import { assertWithinRoot } from '../utils/path-safety.js';
import { loadStateForScope } from '../config.js';
import { placedResourcePath } from '../push-namespaces.js';
import { recordedNamespace } from '../utils/pending-push.js';
import { deliversEveryNamespace } from '../resource-namespaces.js';
import { getFileContentAtRev, isPastVersionOf, listFilesAtRev } from '../utils/git.js';
import { historicalVersions } from '../utils/team-history.js';
import {
  adoptRecord, contentHash, describeMembersDirLeft, describeMembersLink, forgetDelivered, holdsNonRegular, isLink, isTeamaiCopy, keepsEditedCopy, openLedger, recordDelivered, recordedUnchanged,
  judgeRemoval, keepsTrackedCopy, reportKept,
  type DeliveredHashes, type DeliveryLedger,
} from './delivered-copies.js';
import {
  ruleFileExtensionForTool,
  ruleFormatForTool,
  renderRuleForTool,
  deliveredRenders,
  ruleStemFromFilename,
  ruleStemsForTool,
  flatStem,
  flatStemSharers,
  teamRuleNameForFile,
  sharesRulesDirWithMember,
  isLegacyCursorRuleFile,
  LEGACY_RULE_DIRS,
  keptLegacyCopiesWarning,
  type LegacyRuleDir,
  type RuleFormat,
} from './rule-format.js';
import { injectClaudeMdSection, removeClaudeMdSection } from '../utils/claudemd.js';

/** The copies earlier pulls left in one of `LEGACY_RULE_DIRS` (`RulesHandler.legacyRuleCopies`). */
export interface LegacyRuleCopies {
  entry: LegacyRuleDir;
  /** The directory, resolved for this scope. */
  dir: string;
  /** `entry.copiedFrom.dir`, resolved; undefined for a directory the tool does not read. */
  copiedFrom: string | undefined;
  /** The copies still teamai's. */
  owned: string[];
  /** The copies the member edited, or that teamai cannot prove it wrote. */
  edited: string[];
}

/** A tool's flat copy of a namespaced rule (`ownedFlatCopies`). */
interface FlatCopy {
  readonly tool: string;
  readonly file: string;
}

export class RulesHandler extends ResourceHandler {
  readonly type = 'rules' as const;

  /**
   * Scan for local rule .md files that are new or modified compared to the team repo.
   * Looks in ALL tool's configured rules/ directories and compares each against the
   * team repo version. When multiple tool dirs have a modified copy, picks the one
   * with the latest mtime.
   */
  async scanLocalForPush(teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<ResourceItem[]> {
    const teamRulesDir = path.join(localConfig.repo.localPath, 'rules');
    // Recursively list team repo rules to support subdirectories
    const teamRules = new Set(
      (await pathExists(teamRulesDir))
        ? (await listFilesRecursive(teamRulesDir)).filter((f) => f.endsWith('.md'))
        : [],
    );

    // Read tombstones to skip previously deleted resources
    const tombstones = await this.readTombstones(localConfig);

    // A rule placed under rules/<ns>/ on an earlier push is still authored at
    // the tool's rules root, so matching on the full path alone would read it
    // as brand new and send a second copy to the shared root — where it would
    // reach the whole team (issue #649). state.json records where this machine
    // placed each root-level rule, and that record — not the basename — maps
    // the local copy back to its team file. A namespaced team rule is pulled
    // into a namespaced local directory, so a root-level local rule that only
    // shares a basename with one, and has no record, is unrelated and stays new.
    const placedRules = (await loadStateForScope(localConfig)).placedRules;
    const delivered = await (await import('../pull.js')).deliveredHashes(localConfig);

    // Collect the best candidate for each rule name across all tool directories
    const candidates = new Map<string, {
      sourcePath: string; mtime: number; status: ResourceItemStatus; teamRelPath: string;
    }>();
    // One read per team rule, shared across every tool dir that compares against it.
    const teamContentCache = new Map<string, string>();
    const readTeamRule = async (filePath: string): Promise<string> => {
      const cached = teamContentCache.get(filePath);
      if (cached !== undefined) return cached;
      const content = (await readFileSafe(filePath)) ?? '';
      teamContentCache.set(filePath, content);
      return content;
    };

    // Scan each tool's rules/ directory (recursively)
    for (const [tool, toolPath] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
      const rulesPath = toolPath.rules;
      if (!rulesPath) continue;
      // Not written or cleaned by teamai, so not a source either: `removeItem`
      // leaves an excluded tool's copy behind, and read here it would republish
      // the rule just removed (#649 review). The single-repo scan source is not
      // a tool, and `enabledAgents` — which single-repo init always writes —
      // never lists it.
      if (tool !== SELF_KNOWLEDGE_SCAN_KEY && isAgentExcluded(localConfig, tool)) continue;
      const rulesDir = path.join(resolveToolBaseDir(tool, localConfig), rulesPath);
      if (!await pathExists(rulesDir)) continue;

      // A tool with its own rules format holds a render: its frontmatter is
      // derived on pull, so only the body is compared.
      const ext = ruleFileExtensionForTool(tool);
      const format = ruleFormatForTool(tool);

      const files = await listFilesRecursive(rulesDir);
      const stems = await this.receivedRuleStems(tool, teamConfig, localConfig);
      for (const file of files) {
        if (!file.endsWith(ext)) continue;
        // name includes subdirectory path, e.g. "common/coding-standards";
        // OMP's flat `fe.style` is the copy of `fe/style`, and it reads no
        // file below the top, so none there is a rule to push.
        const name = teamRuleNameForFile(tool, file.slice(0, -ext.length), stems);
        if (name === undefined) continue;
        if (tombstones.has(name)) continue;
        if (EXCLUDED_RULE_NAMES.has(name)) continue; // Skip CLI built-in and legacy rules

        const localFilePath = path.join(rulesDir, file);
        // A flat name teamai has no record of writing is the member's own
        // file, which pull keeps rather than overwrite (#946).
        if (name !== file.slice(0, -ext.length) && delivered?.[localFilePath] === undefined) continue;
        // Team repo always stores `.md`, keyed by rule name.
        let teamFileName = `${name}.md`;
        // The record comes first. A shared-root rule that appears later with
        // the same basename belongs to whoever added it, and mapping the
        // author's copy onto it would push their content over that rule. A
        // record whose team file is gone (rule removed, namespace renamed) no
        // longer proves anything, so the rule is new again.
        const placed = placedResourcePath(placedRules, 'rules', name);
        const placedName = placed?.slice('rules/'.length);
        if (placedName && teamRules.has(placedName)) teamFileName = placedName;

        const teamRelPath = `rules/${teamFileName}`;

        if (teamRules.has(teamFileName)) {
          // File exists in team repo — check if content differs
          const teamFilePath = path.join(teamRulesDir, teamFileName);
          // For native formats, compare markdown bodies only: frontmatter is
          // machine-derived on pull, so a clean round trip is not a change.
          const equal = format
            ? format.bodyEquals((await readFileSafe(localFilePath)) ?? '', await readTeamRule(teamFilePath))
            : await fileContentEqual(localFilePath, teamFilePath);
          if (equal) continue; // This tool dir's copy is identical, skip
          // Single-repo mode: nothing refreshes the active tree's
          // `.teamai/rules` — pull deploys to tool dirs and the pre-push sync
          // covers those — and a branch behind the default branch holds its
          // older copies. A copy equal to an OLDER version of the team file is
          // one nobody edited, and pushing it would revert whoever changed the
          // rule since (#649 review, #823).
          if (tool === SELF_KNOWLEDGE_SCAN_KEY
            && await isPastVersionOf(localConfig.repo.localPath, localFilePath, teamRelPath)) {
            log.warn(
              `[rules] Skipped ${name}: ${path.relative(resolveToolBaseDir(tool, localConfig), localFilePath)} is an `
              + `older version of ${teamRelPath}, which has changed on the team since. `
              + 'Copy the current file over it (or delete it) before editing.',
            );
            continue;
          }

          // Content differs — candidate for "modified"
          const mtime = await getFileMtime(localFilePath);
          const existing = candidates.get(name);
          if (!existing || mtime > existing.mtime) {
            candidates.set(name, { sourcePath: localFilePath, mtime, status: 'modified', teamRelPath });
          }
        } else {
          // File does not exist in team repo — candidate for "new".
          // Native rule directories can contain personal rules created by the
          // target tool, in its own format. Keep unknown files in a tool with a
          // rules format, and in Pi's rule directory, local.
          if (format || tool === 'pi') continue;
          const existing = candidates.get(name);
          if (!existing) {
            const mtime = await getFileMtime(localFilePath);
            candidates.set(name, { sourcePath: localFilePath, mtime, status: 'new', teamRelPath });
          } else if (existing.status === 'new') {
            // Multiple tool dirs have the same new file — pick latest mtime
            const mtime = await getFileMtime(localFilePath);
            if (mtime > existing.mtime) {
              candidates.set(name, { sourcePath: localFilePath, mtime, status: 'new', teamRelPath });
            }
          }
        }
      }
    }

    // Convert candidates map to items array
    const items: ResourceItem[] = [];
    for (const [name, candidate] of candidates) {
      // `rules/<ns>/<file>.md` is namespaced; `rules/<file>.md` is shared. State
      // it on the item so an open PR can reuse the destination, the way skills do.
      const segments = candidate.teamRelPath.split('/');
      const namespace = segments.length > 2 ? segments[1] : undefined;
      items.push({
        name,
        type: 'rules',
        sourcePath: candidate.sourcePath,
        relativePath: candidate.teamRelPath,
        status: candidate.status,
        ...(namespace ? { namespace } : {}),
      });
    }

    return items;
  }

  async scanTeamForPull(_teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<ResourceItem[]> {
    const rulesDir = path.join(localConfig.repo.localPath, 'rules');
    if (!await pathExists(rulesDir)) return [];

    const files = await listFilesRecursive(rulesDir);
    return files
      // teamai-context is the file pull writes the team instructions to; a team
      // rule of that name would land on it (#945). pullAllRules names it.
      .filter((f) => f.endsWith('.md') && f !== `${TEAMAI_CONTEXT_RULE_NAME}.md`)
      .map((f) => ({
        name: f.replace(/\.md$/, ''),
        type: 'rules' as const,
        sourcePath: path.join(rulesDir, f),
        relativePath: `rules/${f}`,
      }));
  }

  async pushItem(item: ResourceItem, teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<void> {
    const rulesRoot = path.join(localConfig.repo.localPath, 'rules');
    const dest = path.resolve(localConfig.repo.localPath, item.relativePath);
    assertWithinRoot(
      rulesRoot,
      dest,
      `Invalid rule destination outside team repo rules directory: ${item.relativePath}`,
    );
    if (item.sourcePath !== dest) {
      const format = this.ruleFormatOfSource(item.sourcePath, teamConfig, localConfig);
      if (format) {
        // Source is a tool's render. Only its markdown body is pushed: the
        // tool frontmatter is machine-derived, and the team file keeps its own
        // tool-neutral frontmatter (`paths:`, …) — dropping that would silently
        // un-scope the rule for the whole team on the next pull.
        const raw = await readFileSafe(item.sourcePath);
        if (raw === null) {
          // Never turn an unreadable source into an empty team rule.
          throw new Error(`Cannot read rule source ${item.sourcePath}`);
        }
        await writeFile(dest, format.mergeBodyIntoTeam(raw, await readFileSafe(dest)));
      } else {
        await copyFile(item.sourcePath, dest);
      }
    }
    log.debug(`Copied rule ${item.name} → team repo`);
  }

  /**
   * The rules format of the tool whose rules directory holds `sourcePath`, as
   * `scanLocalForPush` found it there; undefined for a verbatim copy. The
   * deepest directory wins, should one tool's sit inside another's.
   */
  private ruleFormatOfSource(sourcePath: string, teamConfig: TeamaiConfig, localConfig: LocalConfig): RuleFormat | undefined {
    let match: { dirLength: number; tool: string } | undefined;
    for (const [tool, toolPath] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
      if (!toolPath.rules) continue;
      const dir = path.join(resolveToolBaseDir(tool, localConfig), toolPath.rules);
      if (!sourcePath.startsWith(dir + path.sep)) continue;
      if (!match || dir.length > match.dirLength) match = { dirLength: dir.length, tool };
    }
    return match ? ruleFormatForTool(match.tool) : undefined;
  }

  /**
   * Where `item` lands for each tool that receives rules. The filename and
   * bytes are tool-dependent (`RULE_FORMATS`) — `.md` verbatim, Cursor's and
   * JoyCode's own `.mdc`, `.instructions.md` for Copilot, `.md` with its
   * own frontmatter for Kiro, Qoder and CodeBuddy — so a reader cannot derive
   * them from the rule's name alone. Tools that read the same file in the same
   * render get one target, naming the others in `sharedWith`.
   */
  async deliveryTargets(
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
    item: ResourceItem,
    receivedNames?: readonly string[],
  ): Promise<DeliveryTarget[]> {
    // The bytes as well as the path: a tool with its own rules format reads
    // frontmatter this derives from the team `.md`, so a copy whose scoping
    // fields no longer match the source is inert in exactly the way a
    // missing file is. Only a comparison against the render can see that, and
    // the render belongs here rather than in a second copy inside `doctor`.
    const source = await readFileSafe(item.sourcePath);
    const localName = await this.localNameFor(item.name, localConfig);
    // For a tool that writes namespaced rules flat: the caller's, or resolved
    // once on first need.
    let received: readonly string[] | undefined = receivedNames;
    const targets: DeliveryTarget[] = [];
    for (const [tool, toolPath] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
      if (isAgentExcluded(localConfig, tool)) continue;
      if (!toolPath.rules) continue;

      // Skip tools that are not installed
      if (!await isToolInstalledForConfig(tool, toolPath.rules, localConfig)) {
        log.debug(`Skipping rule sync for ${tool}: tool not installed`);
        continue;
      }

      const destDir = path.join(resolveToolBaseDir(tool, localConfig), toolPath.rules);
      const ext = ruleFileExtensionForTool(tool);
      let stem = localName;
      let supersededStem: string | undefined = localName !== item.name ? item.name : undefined;
      if (ruleFormatForTool(tool)?.flat && (localName.includes('/') || supersededStem !== undefined)) {
        received ??= await this.receivedRuleNames(teamConfig, localConfig);
        const names = [...received, item.name];
        const stems = ruleStemsForTool(tool, names);
        supersededStem = supersededStem === undefined ? undefined : stems.get(supersededStem);
        if (localName.includes('/')) {
          const flat = stems.get(localName);
          if (flat === undefined) {
            warnOnce(flatNameClash(tool, localName, flatStemSharers(tool, localName, names), ext));
            continue;
          }
          stem = flat;
        }
      }
      const dest = path.join(destDir, `${stem}${ext}`);
      const content = source === null ? undefined : renderRuleForTool(tool, source);
      // Tools that read one directory in one format share the copy (#946).
      const shared = targets.find((target) => target.dest === dest && target.content === content);
      if (shared) {
        (shared.sharedWith ??= []).push(tool);
        continue;
      }
      targets.push({
        tool,
        dest,
        content,
        origin: ruleOrigin(tool, localConfig.repo.localPath, item.relativePath),
        ...(supersededStem !== undefined ? { supersedes: path.join(destDir, `${supersededStem}${ext}`) } : {}),
        ...(stem !== localName ? { movedFrom: path.join(destDir, `${localName}${ext}`) } : {}),
      });
    }
    return targets;
  }

  /**
   * The team rules this member receives in this scope, as pull resolves them:
   * a tool that writes namespaced rules flat judges a clash of flat names
   * among these alone, so a rule the member does not get costs them nothing.
   */
  private async receivedRuleNames(teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<string[]> {
    const { buildRolePullContext, resolveDesiredRules } = await import('./desired.js');
    const { items } = await resolveDesiredRules(teamConfig, localConfig, await buildRolePullContext(localConfig));
    return items.map((rule) => rule.name);
  }

  /**
   * The stems of the rules this member receives in `tool`'s rules directory
   * (`ruleStemsForTool`), for reading a copy there back to its team rule.
   */
  async receivedRuleStems(tool: string, teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<Map<string, string>> {
    if (!ruleFormatForTool(tool)?.flat) return new Map();
    return ruleStemsForTool(tool, await this.receivedRuleNames(teamConfig, localConfig));
  }

  /**
   * The name a delivered rule has in a tool's rules directory. It is the
   * team name — `fe-know/my-rule` lands at `rules/fe-know/my-rule.*` — except
   * for a rule THIS machine placed: push left the author's copy at the rules
   * root under the bare name, and that copy is the one the scanner and the
   * pre-push sync read, so delivery updates it rather than writing a second
   * copy beside it that a tool loading rules recursively would apply as well
   * (#649 review).
   */
  private async localNameFor(teamName: string, localConfig: LocalConfig): Promise<string> {
    const bareName = path.basename(teamName);
    // teamai-context at the root is teamai's instruction file (#945), so a
    // placed rule of that name keeps its namespaced path.
    if (bareName === teamName || bareName === TEAMAI_CONTEXT_RULE_NAME) return teamName;
    const placed = placedResourcePath(
      (await loadStateForScope(localConfig)).placedRules, 'rules', bareName,
    );
    if (placed !== `rules/${teamName}.md`) return teamName;
    // In legacy mode a shared-root rule of the same name is delivered too, and
    // owns the root path in every tool dir; delivering both there would leave
    // whichever wrote last. The reconcile pass withdraws the record for this
    // case, but delivery must not depend on having run after it. With roles or
    // projects the placed rule replaces that root rule instead (#707).
    if (await pathExists(path.join(localConfig.repo.localPath, 'rules', `${bareName}.md`))
      && await deliversEveryNamespace(localConfig)) return teamName;
    return bareName;
  }

  /**
   * Pull a single rule file to all configured AI tool rules/ directories.
   */
  async pullItem(
    item: ResourceItem, teamConfig: TeamaiConfig, localConfig: LocalConfig, ledger?: DeliveryLedger, received?: readonly string[],
  ): Promise<void> {
    for (const target of await this.deliveryTargets(teamConfig, localConfig, item, received)) {
      const { tool, dest, content, supersedes } = target;
      const destDir = path.dirname(dest);
      try {
        if (content === undefined) {
          // Never write a stub always-on rule in place of an unreadable source.
          throw new Error(`Cannot read rule source ${item.sourcePath}`);
        }
        await ensureDir(destDir);
        if (target.movedFrom !== undefined && await isMembersOwnFile(dest, content, ledger)) {
          // The flat name of a namespaced rule may be a file the member wrote.
          warnOnce(`Kept ${dest}: teamai did not write it, and it is where ${tool} would read team rule ${item.name}. `
            + 'Rename your file, then run `teamai pull --force`.');
          continue;
        }
        // With no ledger (the local agent's install), nothing else judges a link of the member's there (#993).
        if (!ledger && await isLink(dest)) {
          warnOnce(describeMembersLink(dest, item.relativePath));
          continue;
        }
        if (!ledger || !await keepsEditedCopy(ledger, item, target)) {
          await writeFile(dest, content);
          if (ledger) await recordDelivered(ledger.hashes, dest);
          ledger?.recorder?.report('rules', dest);
        } else {
          await warnIfKeptCopyIsInert(target);
        }
        // Drop the `.md` copy left by an older layout; a tool that reads a
        // derived extension does not read it, and it would outlive the rule.
        const legacyCopy = path.join(destDir, `${path.basename(dest, path.extname(dest))}.md`);
        if (dest !== legacyCopy && await isLegacyLayoutCopy(legacyCopy, item.relativePath, ledger?.previous, localConfig.repo.localPath)
          && !await keepsTrackedCopy(legacyCopy, dest)) {
          await remove(legacyCopy);
          if (ledger) forgetDelivered(ledger.hashes, legacyCopy);
        }
        // The namespaced copy an earlier pull wrote beside the author's root
        // copy: the same rule twice, for a tool that loads rules recursively.
        // A flat name (OMP's, Kiro's `fe.style.md`) may be the member's own
        // file or an edited copy: only one holding what was recorded or the
        // render goes (#946).
        if (supersedes && ruleFormatForTool(tool)?.flat) {
          // A link there is the member's: never read through or deleted (#993).
          const disk = await isLink(supersedes) ? null : await fileHash(supersedes);
          const recorded = ledger?.previous?.[supersedes];
          if (disk !== null && (disk === recorded || disk === contentHash(content))) {
            if (!await keepsTrackedCopy(supersedes, dest)) {
              await remove(supersedes);
              if (ledger) forgetDelivered(ledger.hashes, supersedes);
            }
          } else if (disk !== null && recorded !== undefined) {
            warnOnce(`Kept ${supersedes}: you edited it after teamai delivered it, and ${tool} also reads ${dest}, the same rule. `
              + 'Delete it once you have saved what you need.');
          }
        } else if (supersedes && await pathExists(supersedes)) {
          // Teamai's only on record or proof, like any copy (#993).
          if (!await isLink(supersedes) && (ledger?.previous?.[supersedes] !== undefined
            || await isTeamaiCopy(supersedes, ruleOrigin(tool, localConfig.repo.localPath, item.relativePath)))) {
            if (!await keepsTrackedCopy(supersedes, dest)) {
              await remove(supersedes);
              if (ledger) forgetDelivered(ledger.hashes, supersedes);
            }
          } else {
            warnOnce(describeMembersDirLeft(supersedes, item.relativePath, 'pull'));
          }
        }
        log.debug(`Synced rule ${item.name} → ${tool}`);
      } catch (e) {
        ledger?.recorder?.failed('rules');
        log.warn(`Failed to sync rule ${item.name} to ${tool}: ${(e as Error).message}`);
        ledger?.failed.push({ name: item.name, tool });
      }
    }
  }

  /**
   * Rewrite each delivered copy of `rules` that still holds what teamai
   * recorded writing there but is no longer the render: what an older CLI
   * wrote before the tool got a rules format of its own (#946). With no
   * record, only a copy that is the team rule verbatim is rewritten. A copy
   * whose path changed (`movedFrom`, OMP's flat names) is written at the new
   * path while the old one is there. For the "Already synced" pull, which
   * does not run `pullItem`. A copy the member changed is kept, and queued on
   * `ledger.kept` to be named when teamai would now deliver other bytes there.
   * Returns the names of the rules rewritten.
   */
  async rerenderOutdatedCopies(
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
    rules: readonly ResourceItem[],
    ledger: DeliveryLedger,
  ): Promise<string[]> {
    const rewritten = new Set<string>();
    const received = rules.map((rule) => rule.name);
    for (const item of rules) {
      for (const target of await this.deliveryTargets(teamConfig, localConfig, item, received)) {
        const { dest, content, movedFrom } = target;
        // A link at the copy's path is the member's: never written through (#993).
        if (await isLink(dest)) continue;
        const recorded = ledger.previous?.[dest];
        const disk = await fileHash(dest);
        // A copy whose file name changed (OMP's flat names): the copy at the
        // old path says the rule was delivered here, so the new path is
        // written, and the old copy goes unless the member changed it.
        if (content !== undefined && disk === null && movedFrom !== undefined && await pathExists(movedFrom)) {
          await ensureDir(path.dirname(dest));
          await writeFile(dest, content);
          await recordDelivered(ledger.hashes, dest);
          ledger.recorder?.report('rules', dest);
          await reclaimMovedCopy({ ...target, movedFrom }, item, ledger, localConfig.repo.localPath);
          rewritten.add(item.name);
          continue;
        }
        if (content === undefined || disk === null || disk === contentHash(content)) continue;
        if (recorded === undefined) {
          // No record (a CLI from before #822 wrote none): a copy that is the
          // team rule verbatim is what an older CLI wrote before the tool got
          // a format of its own, and nobody edited it. Anything else is left.
          const source = await readFileSafe(item.sourcePath);
          if (source === null || disk !== contentHash(source)) continue;
        } else if (disk !== recorded) {
          // Named by the caller's reportKept; a render unchanged since
          // delivery is the member's plain edit, which needs no word.
          if (contentHash(content) !== recorded && await keepsEditedCopy(ledger, item, target)) {
            await warnIfKeptCopyIsInert(target);
          }
          continue;
        }
        await writeFile(dest, content);
        await recordDelivered(ledger.hashes, dest);
        ledger.recorder?.report('rules', dest);
        rewritten.add(item.name);
      }
    }
    return [...rewritten];
  }

  /**
   * `my-rule` when push placed it at `rules/fe-know/my-rule.md`: the author
   * types the name their local copy has, which is the bare one.
   */
  async publishedNameFor(name: string, localConfig: LocalConfig, records: PlacementRecords): Promise<string | null> {
    const placed = placedResourcePath(
      records.placedRules, 'rules', name,
    );
    if (!placed) return null;
    if (!await pathExists(path.join(localConfig.repo.localPath, placed))) return null;
    return placed.slice('rules/'.length, -'.md'.length);
  }

  /**
   * Remove a rule from the team repo and all local AI tool rules/ directories.
   *
   * `name` may be the published one (`fe-know/my-rule`) or the bare one the
   * author's own copy carries (`my-rule`) — `remove` resolves the first through
   * `publishedNameFor`, so both reach the same team file. The local sweep below
   * covers both spellings, because a rule placed in a namespace leaves the
   * author's copy at the rules root while every other member receives it at
   * `rules/<ns>/`.
   */
  async removeItem(name: string, teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<string[]> {
    const removed: string[] = [];

    // OMP's flat copies, judged against the team rule before it goes.
    const teamFile = path.join(localConfig.repo.localPath, 'rules', `${name}.md`);
    const { deliveredHashes } = await import('../pull.js');
    // What this checkout's pulls recorded writing: a file with no record is
    // teamai's only on proof, here as in pull (#993).
    const ledger = openLedger(await deliveredHashes(localConfig));
    const flatCopies = await this.ownedFlatCopies(
      teamConfig, localConfig, [{ name, type: 'rules', sourcePath: teamFile, relativePath: `rules/${name}.md` }],
      ledger.previous,
    );
    // What pull writes today from the team rule also proves a copy teamai's,
    // so it is read before the rule goes: a checkout without history, such as
    // the local agent's resource cache, has no other proof.
    const current = await readFileSafe(teamFile);

    // Remove from team repo (always `.md`)
    if (await pathExists(teamFile)) {
      await remove(teamFile);
      removed.push(teamFile);
    }
    for (const { file } of flatCopies.owned) {
      if (await keepsTrackedCopy(file)) continue;
      await remove(file);
      removed.push(file);
    }
    for (const { file } of flatCopies.edited) {
      log.warn(`Kept ${file}: you edited it after teamai delivered it. Delete it once you have saved what you need.`);
    }

    // The author's own copy is at the rules root under the bare name, whatever
    // namespace the team file ended up in. Leaving it behind re-publishes the
    // rule on the next push — but only THIS machine's placement record makes
    // that copy ours to delete. Without it, `remove rules fe/foo` would take an
    // unrelated personal .claude/rules/foo.md with it (#649 review).
    const localNames = new Set([name]);
    const bareName = path.basename(name);
    if (bareName !== name) {
      const placed = placedResourcePath(
        (await loadStateForScope(localConfig)).placedRules, 'rules', bareName,
      );
      if (placed === `rules/${name}.md`) localNames.add(bareName);
    }

    // Record a tombstone so the resource won't be re-pushed. Only the name
    // given: every member reads the tombstone, and a bare `<name>` would sweep
    // and suppress their own unrelated root rule of that name (#649 review).
    // Members hold a namespaced rule under `<ns>/`, which the published name
    // matches; the author's root copy is swept below, and a copy an excluded
    // tool keeps is not a push source (`scanLocalForPush`).
    await this.addTombstone(name, localConfig);

    // Remove from each tool's rules directory. `.mdc` tools may have an older
    // teamai layout wrote `.md` there, so both are removed — otherwise `remove`
    // would report success while leaving the rule on disk.
    for (const [tool, toolPath] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
      if (!toolPath.rules) continue;
      // Not ours to write to, so not ours to delete from. Same gate as the
      // tombstone pass in pull.
      if (isAgentExcluded(localConfig, tool)) continue;
      const baseDir = resolveToolBaseDir(tool, localConfig);
      const extensions = new Set<string>([ruleFileExtensionForTool(tool), '.md']);
      for (const localName of localNames) {
        for (const extension of extensions) {
          const filePath = path.join(baseDir, toolPath.rules, `${localName}${extension}`);
          // A link is the member's, on record or not: teamai never deletes one (#993).
          if (await isLink(filePath)) continue;
          // The team file is gone from the working tree only: its history still proves a copy teamai's.
          // The author's root copy is this rule's by the placement record, which proves it here.
          if (localName === name && await pathExists(filePath) && ledger.previous?.[filePath] === undefined
            && !await holdsCurrentRule(filePath, tool, current)
            && !await isTeamaiCopy(filePath, ruleOrigin(tool, localConfig.repo.localPath, `rules/${name}.md`))) {
            log.warn(describeMembersDirLeft(filePath, `rules/${name}.md`, 'remove'));
            continue;
          }
          if (await pathExists(filePath) && !await keepsTrackedCopy(filePath)) {
            await remove(filePath);
            removed.push(filePath);
            log.debug(`Removed rule ${localName} from ${tool}`);
          }
        }
      }
    }

    // Refresh with the rules this member's pull delivers, so the role, project
    // and tag selection still applies to the files the refresh writes.
    const { buildRolePullContext, resolveDesiredRules } = await import('./desired.js');
    const { items, replaced } = await resolveDesiredRules(teamConfig, localConfig, await buildRolePullContext(localConfig));
    await this.pullAllRules(teamConfig, localConfig, items, replaced, ledger);
    reportKept(ledger, localConfig.scope);

    return removed;
  }

  /**
   * Remove the copy of a team rule named teamai-context an earlier release
   * delivered to a rules directory (#945): that path is teamai's own
   * instruction file now. A copy goes only without teamai's blocks and when
   * the record shows it unchanged or it matches what pull rendered for the
   * team's rule; any other is kept, and the instruction sync names it.
   */
  async reclaimReservedRuleCopies(
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
    ledger: DeliveryLedger | undefined,
  ): Promise<void> {
    const { holdsInstructionBlocks, instructionTargetPath } = await import('../instruction-targets.js');
    const relativePath = `rules/${TEAMAI_CONTEXT_RULE_NAME}.md`;
    const rule: ResourceItem = {
      name: TEAMAI_CONTEXT_RULE_NAME, type: 'rules', relativePath, sourcePath: path.join(localConfig.repo.localPath, relativePath),
    };
    let deliveredRevs: readonly string[] | undefined;
    for (const [tool, toolPath] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
      if (!toolPath.rules || isAgentExcluded(localConfig, tool)) continue;
      const file = path.join(resolveToolBaseDir(tool, localConfig), toolPath.rules, `${TEAMAI_CONTEXT_RULE_NAME}${ruleFileExtensionForTool(tool)}`);
      if (await isLink(file) || !await pathExists(file) || await holdsInstructionBlocks(file)) continue;
      const recorded = ledger?.previous?.[file];
      deliveredRevs ??= (
        await (await import('../pull.js')).resolveCheckoutBases(localConfig, await loadStateForScope(localConfig))
      ).revs;
      const delivered = (recorded !== undefined && recorded === await fileHash(file))
        || await isDeliveredRender(deliveredRenders(tool), file, rule, localConfig.repo.localPath, deliveredRevs);
      if (!delivered) continue;
      // Where this path is the tool's instruction file (Claude, Cursor,
      // CodeBuddy, WorkBuddy), the instruction sync right after rewrites it,
      // so a tracked copy shows ` M`, as any update does, and keeping the old
      // file would block that sync. Elsewhere (OpenCode, Kiro) nothing
      // rewrites it: a tracked copy is kept, as every removal keeps one.
      const target = await instructionTargetPath(tool, toolPath, localConfig, isGitExcludeEnabled(localConfig, teamConfig));
      if (target !== file && await keepsTrackedCopy(file)) continue;
      await remove(file);
      if (ledger) forgetDelivered(ledger.hashes, file);
      log.info(`Removed ${file}, the copy of the team rule ${TEAMAI_CONTEXT_RULE_NAME} an earlier release delivered: the team instructions go there now`);
    }
  }

  /**
   * The flat copies of `rules` (OMP's `fe.style.md` for `fe/style`) that are
   * teamai's: holding what `previous` records teamai wrote, or the render.
   * One on record that holds neither is `edited`: the member changed it. A
   * file with no record and no render is the member's own, whose name only
   * happens to match. Read-only and public so `uninstall` removes what
   * `remove` would.
   */
  async ownedFlatCopies(
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
    rules: readonly ResourceItem[],
    previous: DeliveredHashes | undefined,
  ): Promise<{ owned: FlatCopy[]; edited: FlatCopy[] }> {
    const owned: FlatCopy[] = [];
    const edited: FlatCopy[] = [];
    for (const rule of rules) {
      for (const { tool, dest, content, movedFrom } of await this.deliveryTargets(teamConfig, localConfig, rule)) {
        if (movedFrom === undefined || await isLink(dest) || !await pathExists(dest)) continue;
        const hash = await fileHash(dest);
        if (previous?.[dest] === hash || (content !== undefined && hash === contentHash(content))) {
          owned.push({ tool, file: dest });
        } else if (previous?.[dest] !== undefined) {
          edited.push({ tool, file: dest });
        }
      }
    }
    return { owned, edited };
  }

  /**
   * Distribute rule files to each tool's rules/ directory, then update
   * CLAUDE.md with a lightweight reference list instead of inlining content.
   *
   * `replacedRoots` are root rules an active namespace rule replaces (#707).
   * The stale sweep removes their copies from the directories teamai owns;
   * in the ones it shares with the member's own rules, a copy is removed only
   * while it is byte-equal to what pull wrote for that root rule, now or at the
   * last pull. A copy kept there is named, since the tool loads it too.
   */
  async pullAllRules(
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
    filteredRules?: ResourceItem[],
    replacedRoots: readonly ResourceItem[] = [],
    ledger?: DeliveryLedger,
  ): Promise<void> {
    const rules = filteredRules ?? await this.scanTeamForPull(teamConfig, localConfig);
    if (await pathExists(path.join(localConfig.repo.localPath, 'rules', `${TEAMAI_CONTEXT_RULE_NAME}.md`))) {
      log.warn(`rules/${TEAMAI_CONTEXT_RULE_NAME}.md is not delivered: ${TEAMAI_CONTEXT_RULE_NAME} is the name of teamai's own instruction file `
        + 'in each rules directory. Rename the rule in the team repo, for example with `git mv`, and push the change.');
    }
    await this.reclaimReservedRuleCopies(teamConfig, localConfig, ledger);

    await this.syncUserRulesFiles(teamConfig, localConfig, rules);
    // Before the empty-set return: a copy outlives the rule that selected it.
    await this.reclaimLegacyRuleCopies(teamConfig, localConfig, rules, ledger);

    // OpenCode does not auto-scan a rules directory: the .md files are inert
    // until referenced from `instructions` in opencode.json. Activate (or, when
    // there are no team rules, deactivate) that glob. Runs before the empty-set
    // early return so removing the last rule also removes the glob.
    await this.activateOpencodeInstructions(teamConfig, localConfig, rules);

    // Empty set = no team rule reaches this directory right now: the copies of
    // team rules still in the repo go first. The stale sweep below still runs,
    // so the copies of a last rule the team deleted go too (#915). It deletes
    // only a copy the record or the team history proves teamai's (#993), so a
    // member's own rule file stays.
    if (rules.length === 0) {
      await this.reclaimUnselectedTeamRules(teamConfig, localConfig, ledger, filteredRules === undefined ? undefined : []);
    }

    // 1. Distribute rule files to each tool's rules/ directory
    // The rules this member receives, when the caller resolved them.
    const received = filteredRules?.map((rule) => rule.name);
    for (const rule of rules) {
      await this.pullItem(rule, teamConfig, localConfig, ledger, received);
    }

    // 1.5. Clean up stale local rule files not present in team repo
    const teamRuleNames = new Set(rules.map((r) => r.name));
    // A rule this machine published into a namespace keeps the author's copy at
    // the rules ROOT under its bare name. The desired set never contains that
    // name — it is `<ns>/<name>` there, or absent when the namespace is not
    // active here — so the sweep below would delete the author's own file,
    // local edits and all (#649 review). The record is what marks it as ours,
    // and only while the team file it points at still exists. Before the PR
    // merges there is no record yet — the placement is on the pending entry —
    // and the copy is just as much ours then.
    const state = await loadStateForScope(localConfig);
    const { placedRules, pendingPushes } = state;
    for (const name of Object.keys(placedRules ?? {})) {
      const placed = placedResourcePath(placedRules, 'rules', name);
      if (placed && await pathExists(path.join(localConfig.repo.localPath, placed))) {
        teamRuleNames.add(name);
      }
    }
    // Any pending entry that carries a root-authored rule at a namespaced path,
    // not only one still marked `placed`: reconcile spends the mark on a
    // placement it cannot prove, while the PR may still be open and the copy
    // is still the author's work (#649 review).
    for (const entry of pendingPushes ?? []) {
      for (const item of entry.items) {
        if (item.type === 'rules' && !item.name.includes('/') && recordedNamespace(item) !== undefined) {
          teamRuleNames.add(item.name);
        }
      }
    }
    const tombstones = await this.readTombstones(localConfig);
    const replacedByName = new Map(replacedRoots.map((rule) => [rule.name, rule]));
    // The revisions this checkout's copies can be at: the shared lastPullRev
    // may be another checkout's, and HOME's copy an inherited pull's (#823).
    let checkoutRevs: readonly string[] | undefined;
    const deliveredRevs = async (): Promise<readonly string[]> => checkoutRevs
      ??= (await (await import('../pull.js')).resolveCheckoutBases(localConfig, state)).revs;
    const rulesByName = new Map(rules.map((rule) => [rule.name, rule]));
    for (const [tool, toolPath] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
      if (!toolPath.rules) continue;
      // `pullItem` above skips excluded tools, so this pass must skip them too.
      // Without it the stale sweep deletes from a directory teamai never wrote.
      if (isAgentExcluded(localConfig, tool)) continue;
      if (!await isToolInstalledForConfig(tool, toolPath.rules, localConfig)) continue;

      const baseDir = resolveToolBaseDir(tool, localConfig);
      const destDir = path.join(baseDir, toolPath.rules);
      if (!await pathExists(destDir)) continue;

      const ext = ruleFileExtensionForTool(tool);
      // The stems this tool's copies of those rules have (flat for OMP).
      const stems = ruleStemsForTool(tool, teamRuleNames);
      const deliveredStems = new Set(stems.values());
      const localFiles = await listFilesRecursive(destDir);
      for (const localFile of localFiles) {
        const ruleName = ruleStemFromFilename(localFile);
        if (ruleName === null) continue;

        // These rule directories are shared with rules the member wrote in the
        // tool's own format (`sharesRulesDirWithMember`). Absence from the
        // current team set is not proof of TeamAI ownership (including legacy
        // .md files); only explicit team removals authorize cleanup, a copy the
        // delivery ledger shows unchanged since teamai wrote it, and a replaced
        // root rule's copy that is still exactly what pull wrote. Cursor is
        // deliberately absent — teamai owns .cursor/rules and sweeps it.
        if (sharesRulesDirWithMember(tool) && !tombstones.has(ruleName)) {
          if (deliveredStems.has(ruleName) || localFile !== `${ruleName}${ext}` || EXCLUDED_RULE_NAMES.has(ruleName)) continue;
          const replaced = replacedByName.get(ruleName);
          if (replaced === undefined) {
            const fullPath = path.join(destDir, localFile);
            // The nested copy an older teamai wrote of a rule OMP now gets
            // flat: verbatim then, so the team rule proves it with no record.
            const nestedOf = ruleFormatForTool(tool)?.flat ? rulesByName.get(ruleName) : undefined;
            const flatCopy = nestedOf && stems.has(ruleName) ? path.join(destDir, `${stems.get(ruleName)}${ext}`) : undefined;
            if (await recordedUnchanged(ledger?.previous, fullPath)
              || (nestedOf && await isUneditedNestedCopy(tool, fullPath, nestedOf, ledger?.previous, localConfig.repo.localPath, await deliveredRevs()))) {
              if (await keepsTrackedCopy(fullPath, flatCopy !== undefined && await pathExists(flatCopy) ? flatCopy : undefined)) continue;
              await remove(fullPath);
              if (ledger) forgetDelivered(ledger.hashes, fullPath);
              log.debug(`Removed stale rule ${localFile} from ${tool}`);
            } else if (nestedOf && flatCopy) {
              log.warn(keptNestedCopyMessage(tool, fullPath, ruleName, flatCopy));
            }
            continue;
          }
          const deployed = path.join(destDir, localFile);
          if (await isDeliveredRender(deliveredRenders(tool), deployed, replaced, localConfig.repo.localPath, await deliveredRevs())) {
            if (await keepsTrackedCopy(deployed)) continue;
            await remove(deployed);
            log.debug(`Removed ${localFile} from ${tool}: a namespace rule replaces it`);
          } else {
            log.warn(
              `Kept ${deployed}: it differs from what teamai delivered for ${replaced.relativePath}, which a namespace `
              + `rule replaces here, so ${tool} loads both. Delete it if you did not edit it; to keep your changes, `
              + 'rename it to a name of your own.',
            );
          }
          continue;
        }

        // `.mdc` tools only read `.mdc`, so any `.md` here is inert leftover from the
        // layout that predates it — removed whether or not the rule is still
        // active, and ahead of the built-in check, since built-ins now deploy to
        // target tool as `.mdc` too.
        if (isLegacyCursorRuleFile(tool, localFile)) {
          const legacyFile = path.join(destDir, localFile);
          const current = `${legacyFile.slice(0, -'.md'.length)}${ext}`;
          if (await isLegacyLayoutCopy(legacyFile, `rules/${ruleName}.md`, ledger?.previous, localConfig.repo.localPath)
            && !await keepsTrackedCopy(legacyFile, await pathExists(current) ? current : undefined)) {
            await remove(legacyFile);
            if (ledger) forgetDelivered(ledger.hashes, legacyFile);
            log.debug(`Removed legacy .md rule ${localFile} from ${tool}`);
          }
          continue;
        }

        if (!localFile.endsWith(ext)) continue;
        // Skip built-in and legacy rules (managed by CLI, not team repo)
        if (EXCLUDED_RULE_NAMES.has(ruleName)) continue;
        if (!deliveredStems.has(ruleName)) {
          const fullPath = path.join(destDir, localFile);
          // A copy the member changed since teamai delivered it stays (#822),
          // and so does one with no record that holds no team version of the
          // rule (#993); the tombstone cleanup names one of a rule the team
          // removed. A file of a name the team never had is the member's own
          // rule, which needs no word.
          const teamFile = `rules/${ruleName}.md`;
          const removal = await judgeRemoval(ledger?.previous, fullPath, ruleOrigin(tool, localConfig.repo.localPath, teamFile), ledger?.otherRecords);
          if (removal === 'edited') {
            if (!tombstones.has(ruleName)) {
              log.warn(`Kept ${fullPath}: teamai no longer delivers ${ruleName} here, but you changed this copy. Delete it when you no longer need it.`);
            }
            continue;
          }
          if (removal === 'notTeamais') {
            const wasTeamRule = ((await historicalVersions(localConfig.repo.localPath, teamFile))?.length ?? 0) > 0;
            if (wasTeamRule && !tombstones.has(ruleName)) log.warn(describeMembersDirLeft(fullPath, teamFile, 'pull'));
            continue;
          }
          if (await keepsTrackedCopy(fullPath)) continue;
          await remove(fullPath);
          if (ledger) forgetDelivered(ledger.hashes, fullPath);
          log.debug(`Removed stale rule ${localFile} from ${tool}`);
        }
      }

      // Clean up empty subdirectories
      await this.removeEmptyDirs(destDir);
    }

    // 2. Remove legacy rules section from CLAUDE.md (no longer injected)
    for (const [tool, toolPath] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
      if (!toolPath.claudemd) continue;
      const baseDir = resolveToolBaseDir(tool, localConfig);
      const claudeMdPath = path.join(baseDir, toolPath.claudemd);
      try {
        if (await removeClaudeMdSection(claudeMdPath, TEAMAI_RULES_START, TEAMAI_RULES_END, { deleteIfEmpty: true })) {
          log.debug(`Removed legacy rules section from ${claudeMdPath}`);
        }
      } catch {
        // Best-effort cleanup
      }
    }
  }

  /**
   * An older project pull wrote the project's rules into Hermes' global
   * SOUL.md (#946). On a machine with no user-scope install nothing else
   * refreshes or removes that block, so Hermes would keep applying rules the
   * team may have deleted: a project pull removes it there.
   */
  private async removeStaleProjectSoulRules(localConfig: LocalConfig): Promise<void> {
    if (isAgentExcluded(localConfig, 'hermes')) return;
    // An unreadable user config still represents an install whose rules we must keep.
    if (await pathExists(getUserConfigPath())) return;
    const { getHermesSoulPath, readSoulRules, removeSoulRules } = await import('../hermes-config.js');
    if (await readSoulRules() === null) return;
    try {
      await removeSoulRules();
      log.info(`Removed the team rules an older project pull wrote to ${getHermesSoulPath()}: Hermes gets no project rules`);
    } catch (e) {
      log.warn(`Could not remove the team rules an older project pull wrote to ${getHermesSoulPath()}: ${(e as Error).message}. `
        + 'Hermes keeps applying them until this succeeds; run `teamai pull` again once the cause above is fixed.');
    }
  }

  /**
   * The user-scope part of a rules sync for each tool with no rules format:
   * the team rules go into a file only that tool reads (`userRulesFile`: the
   * Codex family's AGENTS.md, ZCode, DeepSeek Harness, the OpenClaw
   * workspace, Pi, JoyCode's rules.txt). A project pull writes none of them;
   * there the session-start hook (the Codex family, ZCode, DeepSeek Harness)
   * or Pi's extension adds the rules (#938, #946).
   * Public so the "Already synced" pull can run it after a CLI upgrade.
   */
  async syncUserRulesFiles(
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
    rules: ResourceItem[],
  ): Promise<void> {
    if (localConfig.scope !== 'user') {
      await this.removeStaleProjectSoulRules(localConfig);
      return;
    }
    // Hermes: inline all team rules into a teamai-managed block in SOUL.md
    // (user-level standing instructions). Only when Hermes is actually
    // installed — never create ~/.hermes for users who don't use it. SOUL.md
    // is global, so only a user-scope pull writes it; Hermes gets no project
    // rules (see `ruleChannelNotes`, #946). Here, so the "Already synced" pull
    // repairs a block an older project pull overwrote.
    if (!isAgentExcluded(localConfig, 'hermes')) {
      const { getHermesHome } = await import('../hermes-home.js');
      if (await pathExists(getHermesHome())) {
        const { getHermesSoulPath, upsertSoulRules } = await import('../hermes-config.js');
        try {
          await upsertSoulRules(await inlinedRulesText(rules));
        } catch (e) {
          log.warn(`Could not write the team rules to ${getHermesSoulPath()}: ${(e as Error).message}. Hermes reads that `
            + 'file as it is until this succeeds; run `teamai pull` again once the cause above is fixed.');
        }
      }
    }
    const block = await teamRulesBlock(rules);
    for (const [tool, toolPath] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
      // One tool's failure leaves the others' files to be written.
      let file: string | undefined;
      let writing = false;
      try {
        const { userRulesFile } = await import('../instruction-targets.js');
        const target = await userRulesFile(tool, toolPath, localConfig);
        if (target?.unreadable && !isAgentExcluded(localConfig, tool)) {
          const { unreadableRulesFileMessage } = await import('../instruction-targets.js');
          log.warn(unreadableRulesFileMessage(tool, target.unreadable));
          continue;
        }
        file = target?.file;
        if (target === undefined || file === undefined) continue;
        const wanted = target.installed && !isAgentExcluded(localConfig, tool) ? block : null;
        writing = wanted !== null;
        if (wanted !== null) {
          await injectClaudeMdSection(file, TEAMAI_TEAM_RULES_START, TEAMAI_TEAM_RULES_END, wanted);
        } else {
          // A file teamai created for the block alone goes with it.
          await removeClaudeMdSection(file, TEAMAI_TEAM_RULES_START, TEAMAI_TEAM_RULES_END, { deleteIfEmpty: true });
        }
      } catch (e) {
        const action = writing ? 'write the team-rules block to' : 'remove the team-rules block from';
        log.warn(file === undefined
          ? `Could not find the file ${tool} reads the team rules from: ${(e as Error).message}. Run \`teamai pull\` to retry.`
          : `Could not ${action} ${file}: ${(e as Error).message}. ${tool} reads that file as it is until this succeeds; `
            + 'run `teamai pull` again once the cause above is fixed.');
      }
    }
  }

  /**
   * Reclaim the copies earlier pulls left in `LEGACY_RULE_DIRS` that are
   * still teamai's (`legacyRuleCopies`). One of a rule in `rules` (what this
   * sync delivers) is replaced by the rule's current delivery: rewritten in
   * place where the tool still reads that path, otherwise removed. Either
   * way, kept or not, the rule's current destination is written when it is
   * missing: that is what moves a rule on the "Already synced" pull, where
   * nothing else writes the new path (#946). Other unedited copies are
   * removed. The edited ones are named in one warning per directory, until
   * the member deletes them. One at a path pull delivers to is left to pull,
   * which keeps and names it as an edit (#822) once it carries the record of
   * the copy the tool copied it from. Public so the "Already synced" pull can
   * run it after a CLI upgrade (#938). Returns how many files it wrote or
   * removed, whose records changed in `ledger`.
   */
  async reclaimLegacyRuleCopies(
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
    rules: readonly ResourceItem[],
    ledger: DeliveryLedger | undefined,
  ): Promise<number> {
    let changed = 0;
    const write = async (dest: string, content: string): Promise<void> => {
      await ensureDir(path.dirname(dest));
      await writeFile(dest, content);
      if (ledger) await recordDelivered(ledger.hashes, dest);
      ledger?.recorder?.report('rules', dest);
      changed++;
    };
    for (const { entry, dir, copiedFrom, owned, edited } of await this.legacyRuleCopies(teamConfig, localConfig, ledger?.previous)) {
      // Where each copy's rule is delivered to this tool now.
      const delivery = new Map<string, DeliveryTarget>();
      for (const rule of rules) {
        // None of these tools writes its rules flat, so `rules` serves as the received names.
        const target = (await this.deliveryTargets(teamConfig, localConfig, rule, rules.map(({ name }) => name)))
          .find(({ tool, sharedWith }) => tool === entry.tool || sharedWith?.includes(entry.tool));
        if (!target) continue;
        for (const name of new Set([rule.name, await this.localNameFor(rule.name, localConfig)])) {
          delivery.set(path.join(dir, `${name}${entry.ext}`), target);
        }
      }
      let removed = 0;
      for (const file of owned) {
        const target = delivery.get(file);
        if (target?.dest === file) {
          if (target.content !== undefined && await readFileSafe(file) !== target.content) await write(file, target.content);
          continue;
        }
        if (await keepsTrackedCopy(file, target?.content === undefined ? undefined : target.dest)) continue;
        await remove(file);
        if (ledger) forgetDelivered(ledger.hashes, file);
        changed++;
        removed++;
        log.debug(`Removed ${file}: ${entry.why}`);
      }
      // The rule's current destination, when it moved and nothing wrote it yet:
      // kept or not, the old copy is not where the tool reads it.
      for (const file of [...owned, ...edited]) {
        const target = delivery.get(file);
        if (target === undefined || target.dest === file || target.content === undefined) continue;
        // A link there, dangling or not, is the member's: never written through (#993).
        if (!await isLink(target.dest) && !await pathExists(target.dest)) await write(target.dest, target.content);
      }
      const kept: string[] = [];
      for (const file of edited) {
        if (delivery.get(file)?.dest !== file) {
          kept.push(file);
          continue;
        }
        // A copy the tool made of one teamai recorded is that copy, edited:
        // with its record, pull keeps it rather than writing over it.
        const source = copiedFrom === undefined ? undefined : ledger?.previous?.[path.join(copiedFrom, path.relative(dir, file))];
        if (source !== undefined && ledger !== undefined && adoptRecord(ledger, file, source)) changed++;
      }
      if (kept.length > 0) log.warn(keptLegacyCopiesWarning(kept, entry));
      // Files of the tool's own (Codex's `*.rules`) keep the directory; only an
      // emptied one goes, and never one the tool reads.
      if (removed > 0 && entry.copiedFrom === undefined) await pruneEmptyDirs(dir);
    }
    return changed;
  }

  /**
   * The copies earlier pulls left in each of `LEGACY_RULE_DIRS` for this
   * scope, split into the ones still teamai's and the ones the member edited.
   * A copy is teamai's while it holds what teamai delivered there: the
   * entry's legacy render of the team rule (verbatim by default) or the
   * tool's current render, now or at a revision this checkout pulled; the
   * hash `previous` (the delivery ledger) recorded for it or, for an entry
   * with `copiedFrom`, for its namesake there; the built-in `teamai-recall.md`
   * as any teamai version deployed it. Every team rule counts, not just the
   * ones delivered here, since a copy outlives the role or tag that selected
   * it. A copy of a rule the team removed is teamai's only on a recorded
   * hash. Without that record, the copy stays because it may contain the
   * member's edits. A directory a team `toolPaths` delivers rules to is not
   * listed, unless the entry is for one the tool reads (`copiedFrom`), which
   * is listed only once the tool's marker says it copied into it and while the
   * tool is not excluded.
   *
   * Read-only and public so `uninstall` removes exactly what a pull reclaims.
   */
  async legacyRuleCopies(
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
    previous: DeliveredHashes | undefined,
  ): Promise<LegacyRuleCopies[]> {
    const teamRules = await this.scanTeamForPull(teamConfig, localConfig);
    const tombstoned = [...await this.readTombstones(localConfig)]
      .filter((name) => !teamRules.some((rule) => rule.name === name));
    let deliveredRevs: readonly string[] | undefined;
    const out: LegacyRuleCopies[] = [];
    // A team `toolPaths` that still names one of these dirs delivers there.
    const deliveredDirs = new Set(
      Object.entries(scopedToolPaths(teamConfig, localConfig))
        .filter(([, toolPath]) => toolPath.rules)
        .map(([tool, toolPath]) => path.join(resolveToolBaseDir(tool, localConfig), toolPath.rules!)),
    );
    for (const entry of LEGACY_RULE_DIRS) {
      const { tool, ext } = entry;
      if (!entry.scopes.includes(localConfig.scope)) continue;
      const dir = legacyRuleDirPath(entry, localConfig);
      const baseDir = resolveToolBaseDir(tool, localConfig);
      if (entry.copiedFrom === undefined
        ? deliveredDirs.has(dir)
        // A directory the tool reads is the tool's, until it has copied into
        // it, and not teamai's while the tool is excluded.
        : isAgentExcluded(localConfig, tool) || !await pathExists(path.join(baseDir, entry.copiedFrom.marker))) continue;
      if (!await pathExists(dir)) continue;
      const copiedFrom = entry.copiedFrom === undefined ? undefined : path.join(baseDir, entry.copiedFrom.dir);
      // The hash teamai recorded writing this copy, or the one the tool copied it from.
      const onRecord = async (file: string): Promise<boolean> => await recordedUnchanged(previous, file)
        || (copiedFrom !== undefined && await recordedUnchanged(previous, file, path.join(copiedFrom, path.relative(dir, file))));
      const renders = deliveredRenders(tool);
      const owned: string[] = [];
      const edited: string[] = [];
      for (const rule of teamRules) {
        // A publisher's copy uses its bare local name; older namespaced copies
        // can remain beside it, so check both against the same delivery proof.
        for (const name of new Set([rule.name, await this.localNameFor(rule.name, localConfig)])) {
          const file = path.join(dir, `${name}${ext}`);
          // A link is the member's, whatever its target holds (#993).
          if (await isLink(file) || !await pathExists(file)) continue;
          deliveredRevs ??= (
            await (await import('../pull.js')).resolveCheckoutBases(localConfig, await loadStateForScope(localConfig))
          ).revs;
          const delivered = await onRecord(file)
            || await isDeliveredRender(renders, file, rule, localConfig.repo.localPath, deliveredRevs);
          (delivered ? owned : edited).push(file);
        }
      }
      // The source is gone, so only a recorded hash proves a copy is unchanged.
      for (const name of tombstoned) {
        for (const localName of new Set([name, await this.localNameFor(name, localConfig)])) {
          const file = path.join(dir, `${localName}${ext}`);
          if (await isLink(file) || !await pathExists(file)) continue;
          (await onRecord(file) ? owned : edited).push(file);
        }
      }
      // A directory the tool reads gets teamai's built-in rules too.
      if (entry.copiedFrom === undefined) {
        const recall = path.join(dir, `teamai-recall${ext}`);
        const recallContent = await isLink(recall) ? null : await readFileSafe(recall);
        if (recallContent !== null) (isDeployedRecallRule(recallContent) ? owned : edited).push(recall);
      }
      out.push({ entry, dir, copiedFrom, owned: [...new Set(owned)], edited: [...new Set(edited)].filter((file) => !owned.includes(file)) });
    }
    return out;
  }

  /**
   * Make the teamai rules globs in OpenCode's opencode.json `instructions`
   * match the rules delivered, so copied rule files are actually loaded, and
   * remove them all when no rule is. No-op when opencode is disabled or not
   * installed (we never create an opencode.json for a user who doesn't use
   * OpenCode). Public so the "Already synced" pull can move the globs a CLI
   * upgrade relocates (#946).
   */
  async activateOpencodeInstructions(
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
    rules: readonly ResourceItem[],
  ): Promise<void> {
    const target = await this.opencodeInstructionsTarget(teamConfig, localConfig, rules);
    if (target === null) return;
    // OpenCode V2 ignores the globs, and teamai's plugin adds the rules (#915).
    const { opencodeDeliversThroughPlugin } = await import('../opencode-hooks.js');
    if (await opencodeDeliversThroughPlugin(teamConfig, localConfig)) return;

    const { readOpencodeInstructionList, reconcileOpencodeInstructionSet } = await import('./opencode-config.js');
    try {
      await reconcileOpencodeInstructionSet(target.configFile, rules.length > 0 ? target.globs : [], target.owns);
    } catch (e) {
      log.warn(`Failed to update OpenCode instructions in ${target.configFile}: ${(e as Error).message}. `
        + 'OpenCode loads the rules that file listed before this pull, so a new or moved team rule does not reach it. '
        + 'Fix the cause above, then run `teamai pull`.');
      return;
    }
    // The old glob goes only once the new one is listed (a config the pull
    // cannot parse is left alone), so the rules are never left unregistered.
    if (target.retired === null) return;
    if (rules.length > 0 && await readOpencodeInstructionList(target.configFile) === null) return;
    try {
      await reconcileOpencodeInstructionSet(target.retired.configFile, [], target.retired.owns);
    } catch (e) {
      log.warn(`Failed to update OpenCode instructions in ${target.retired.configFile}: ${(e as Error).message}. `
        + `The rules glob an earlier release listed there stays beside the one in ${target.configFile}. `
        + 'Remove teamai\'s rules entry from that file\'s `instructions`, or fix the cause above and run `teamai pull`.');
    }
  }

  /**
   * The opencode.json this scope activates rules through, the globs that load
   * `rules` from it, and which `instructions` entries teamai owns there. In a
   * project that is `.opencode/opencode.json`, and `retired` names the root
   * opencode.json glob earlier releases wrote. Null when OpenCode receives no
   * rules here: excluded, not installed, or configured without a rules or
   * config path.
   *
   * Read-only, and public for the same reason `deliveryTargets` is: OpenCode
   * does not auto-scan its rules directory, so a `.md` sitting there is inert
   * until a glob references it. A check that derived the path a second time
   * could look at a different file than the pull writes (#624).
   */
  async opencodeInstructionsTarget(
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
    rules: readonly ResourceItem[],
  ): Promise<OpencodeRulesTarget | null> {
    if (isAgentExcluded(localConfig, 'opencode')) return null;
    const paths = scopedToolPaths(teamConfig, localConfig)['opencode'];
    if (!paths?.rules) return null;

    const baseDir = resolveBaseDir(localConfig);
    // Only touch opencode.json when OpenCode is actually installed for this scope.
    if (!await ResourceHandler.isToolInstalled(paths.rules, baseDir)) return null;

    const rulesDir = path.join(baseDir, paths.rules);
    const { opencodeProjectRuleGlobs, opencodeRuleGlobs } = await import('./opencode-config.js');
    if (localConfig.scope === 'project') {
      return opencodeProjectRuleGlobs(baseDir, rulesDir, paths.mcpProject ? path.join(baseDir, paths.mcpProject) : null);
    }

    // The user config file mirrors the MCP field: ~/.config/opencode/opencode.json.
    if (!paths.mcp) return null;
    const configFile = path.join(baseDir, paths.mcp);
    // The directories pull writes the rules to, from the same seam it uses.
    const ruleDirs: string[] = [];
    // OpenCode does not write its rules flat, so `rules` serves as the received names.
    const received = rules.map((rule) => rule.name);
    for (const rule of rules) {
      for (const { tool, dest } of await this.deliveryTargets(teamConfig, localConfig, rule, received)) {
        if (tool === 'opencode') ruleDirs.push(path.dirname(dest));
      }
    }
    // Every directory a team rule can land in, so a namespace this member no
    // longer receives still has its glob reclaimed; and every one a rule landed
    // in at a revision this checkout pulled, so does a namespace the team deleted.
    const teamDirs = (await this.scanTeamForPull(teamConfig, localConfig))
      .map((rule) => path.dirname(path.join(rulesDir, `${rule.name}.md`)));
    const { revs } = await (await import('../pull.js')).resolveCheckoutBases(localConfig, await loadStateForScope(localConfig));
    for (const rev of revs) {
      for (const file of await listFilesAtRev(localConfig.repo.localPath, rev, 'rules')) {
        if (file.endsWith('.md')) teamDirs.push(path.dirname(path.join(rulesDir, path.posix.relative('rules', file))));
      }
    }
    return { configFile, ...opencodeRuleGlobs(configFile, rulesDir, ruleDirs, teamDirs), retired: null };
  }

  /**
   * Recursively remove empty subdirectories under a given directory.
   */
  /**
   * Remove the copies of team rules that no longer reach this directory when none
   * does — e.g. the last rule of a project the directory dropped, or of one an
   * admin removed. Only a file TeamAI provably wrote goes: it sits at a team rule's
   * delivery path and holds exactly what pull rendered for that tool, from the
   * rule as it is now or as it was at a revision this checkout last pulled (the
   * admin may have edited the rule before removing its project). That proof holds
   * in rule directories shared with user-authored rules too, so JoyCode, OMP, Pi
   * and Copilot are reclaimed like the rest. A personal rule, a locally edited
   * copy and the author's own copy of a rule they published stay.
   */
  private async reclaimUnselectedTeamRules(
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
    ledger: DeliveryLedger | undefined,
    received: readonly string[] | undefined,
  ): Promise<void> {
    const teamRules = await this.scanTeamForPull(teamConfig, localConfig);
    if (teamRules.length === 0) return;
    const deliveredRevs = (
      await (await import('../pull.js')).resolveCheckoutBases(localConfig, await loadStateForScope(localConfig))
    ).revs;
    const touchedDirs = new Set<string>();
    for (const item of teamRules) {
      for (const { tool, dest, supersedes } of await this.deliveryTargets(teamConfig, localConfig, item, received)) {
        // `supersedes` marks the author's own root copy, not a delivered one.
        if (supersedes) continue;
        if (!await isDeliveredRender(deliveredRenders(tool), dest, item, localConfig.repo.localPath, deliveredRevs)) continue;
        if (await keepsTrackedCopy(dest)) continue;
        await remove(dest);
        if (ledger) forgetDelivered(ledger.hashes, dest);
        touchedDirs.add(path.join(resolveToolBaseDir(tool, localConfig), scopedToolPaths(teamConfig, localConfig)[tool].rules!));
        log.debug(`Removed unselected team rule ${item.name} from ${tool}`);
      }
    }
    for (const dir of touchedDirs) await this.removeEmptyDirs(dir);
  }

  private async removeEmptyDirs(dir: string): Promise<void> {
    if (!await pathExists(dir)) return;
    const subdirs = await listDirs(dir);
    for (const sub of subdirs) {
      const subPath = path.join(dir, sub);
      await this.removeEmptyDirs(subPath);
      // After cleaning children, check if this dir is now empty
      const remaining = await listFilesRecursive(subPath);
      const remainingDirs = await listDirs(subPath);
      // A link the member put there is not listed, and keeps the directory (#993).
      if (remaining.length === 0 && remainingDirs.length === 0 && !await holdsNonRegular(subPath)) {
        await remove(subPath);
      }
    }
  }
}

/** Where one of `LEGACY_RULE_DIRS` is in the active scope (a `toolRoots` entry moves it in user scope). */
function legacyRuleDirPath(entry: LegacyRuleDir, localConfig: LocalConfig): string {
  return localConfig.scope === 'user'
    ? path.join(resolveToolRootDir(entry.tool, path.dirname(entry.dir), localConfig.toolRoots), path.basename(entry.dir))
    : path.join(resolveToolBaseDir(entry.tool, localConfig), entry.dir);
}

/**
 * The `LEGACY_RULE_DIRS` entry saying `tool` does not read `dir`, where its
 * rules land in this scope: a team `toolPaths` entry written before the tool's
 * rules moved still names it, and pull leaves the copies there on purpose.
 * Undefined when the tool reads `dir`. Doctor fails that delivery (#946).
 */
export function unreadRulesDir(tool: string, dir: string, localConfig: LocalConfig): LegacyRuleDir | undefined {
  return LEGACY_RULE_DIRS.find((entry) => entry.tool === tool && entry.copiedFrom === undefined
    && entry.scopes.includes(localConfig.scope) && legacyRuleDirPath(entry, localConfig) === dir);
}

/**
 * Why a namespaced rule was not written for a tool that reads only the top
 * of its rules directory: `sharers` have its flat file name. A root rule
 * keeps the name; two namespaced rules both lose it.
 */
function flatNameClash(tool: string, name: string, sharers: readonly string[], ext: string): string {
  const file = `${flatStem(name)}${ext}`;
  const root = sharers.find((other) => !other.includes('/'));
  const where = `${tool} reads only the top level of its rules directory, where`;
  if (root !== undefined) {
    return `Skipped rule ${name} for ${tool}: ${where} its file would be ${file}, which is the root rule ${root}. `
      + 'Rename one of them in the team repo.';
  }
  const names = [name, ...sharers].sort();
  return `Skipped rules ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} for ${tool}: ${where} `
    + `${names.length === 2 ? 'both' : 'all'} would be ${file}, so neither is written. Rename one of them in the team repo.`;
}

/**
 * Remove the nested copy `target.movedFrom` names, now that `dest` holds the
 * rule, while it is unedited (`isUneditedNestedCopy`); name one the member
 * changed, which the tool does not read.
 */
async function reclaimMovedCopy(
  target: DeliveryTarget & { movedFrom: string },
  rule: ResourceItem,
  ledger: DeliveryLedger,
  repoPath: string,
): Promise<void> {
  const { movedFrom } = target;
  if (!await isUneditedNestedCopy(target.tool, movedFrom, rule, ledger.previous, repoPath, [])) {
    log.warn(keptNestedCopyMessage(target.tool, movedFrom, rule.name, target.dest));
    return;
  }
  if (await keepsTrackedCopy(movedFrom, target.dest)) return;
  await remove(movedFrom);
  forgetDelivered(ledger.hashes, movedFrom);
  await pruneEmptyDirs(path.dirname(movedFrom));
  log.debug(`Removed ${movedFrom}: ${target.tool} now reads it at ${target.dest}`);
}

/**
 * Whether `file`, the nested copy an older teamai wrote of `rule` before the
 * tool's copies went flat (#946), is still what it delivered: what `previous`
 * records, or one of the tool's `deliveredRenders` of the team rule (the
 * verbatim copy it was written as is among them), as it is now or at one of
 * `revs`. Without a record the bytes are the only proof.
 */
async function isUneditedNestedCopy(
  tool: string,
  file: string,
  rule: ResourceItem,
  previous: DeliveredHashes | undefined,
  repoPath: string,
  revs: readonly string[],
): Promise<boolean> {
  if (await recordedUnchanged(previous, file)) return true;
  return isDeliveredRender(deliveredRenders(tool), file, rule, repoPath, revs);
}

/** A nested copy kept because the member changed it, which the tool never reads. */
function keptNestedCopyMessage(tool: string, file: string, name: string, flatCopy: string): string {
  return `Kept ${file}: ${tool} reads only the top level of its rules directory, so it does not read this copy of ${name}, `
    + `which teamai now delivers as ${flatCopy}. To keep your edit, copy it into that file and share it with \`teamai push\`; `
    + 'then delete this one.';
}

/**
 * How a file with no record in `tool`'s rules directory is proven teamai's
 * (#993): it holds a version of the team rule at `relativePath`, verbatim or
 * in one of the tool's `deliveredRenders`.
 */
export function ruleOrigin(tool: string, repoPath: string, relativePath: string): CopyOrigin {
  const renders = ruleFormatForTool(tool) ? deliveredRenders(tool) : [];
  return {
    repoPath,
    pathspec: relativePath,
    ...(renders.length > 0 ? { renders: renders.map((render) => (content: Buffer) => render(content.toString('utf-8'))) } : {}),
  };
}

/**
 * Whether `file` holds the team rule `raw` as pull writes it for `tool` today,
 * or verbatim, as an older layout's `.md` copy does.
 */
async function holdsCurrentRule(file: string, tool: string, raw: string | null): Promise<boolean> {
  if (raw === null) return false;
  const disk = await readFileSafe(file);
  return disk === raw || disk === renderRuleForTool(tool, raw);
}

/**
 * Whether `file`, a copy of the team rule at `relativePath` in `tool`'s rules
 * directory, is teamai's to delete in a command the member ran (`uninstall`;
 * #993): a built-in rule's name, on `previous`, the checkout's record, edited
 * since or not, or a version of that rule by the team history (`ruleOrigin`).
 * Read-only.
 */
export async function ownsRuleCopy(
  file: string, tool: string, relativePath: string, repoPath: string, previous: DeliveredHashes | undefined,
): Promise<boolean> {
  if (await isLink(file)) return false;
  if (previous?.[file] !== undefined) return true;
  if (EXCLUDED_RULE_NAMES.has(relativePath.replace(/^rules\//, '').replace(/\.md$/, ''))) return true;
  return isTeamaiCopy(file, ruleOrigin(tool, repoPath, relativePath));
}

/**
 * Whether `file`, a `.md` in the rules directory of a tool that reads only
 * its own extension (`.cursor/rules/`), is a copy an older teamai layout wrote
 * there, so pull, remove and uninstall may delete it: on record, or a version
 * of the team rule at `pathspec` verbatim, as that layout wrote it (#993). A
 * built-in rule's name is teamai's own. Any other file is the member's and is
 * kept silently: the tool never reads it, so there is nothing to resolve.
 */
export async function isLegacyLayoutCopy(
  file: string, pathspec: string, previous: DeliveredHashes | undefined, repoPath: string,
): Promise<boolean> {
  if (await isLink(file) || !await pathExists(file)) return false;
  if (previous?.[file] !== undefined) return true;
  if (EXCLUDED_RULE_NAMES.has(pathspec.replace(/^rules\//, '').replace(/\.md$/, ''))) return true;
  return isTeamaiCopy(file, { repoPath, pathspec });
}

/**
 * Whether `file` is there with other bytes than `content` and no record of
 * teamai writing it: a file of the member's own at a path teamai now writes.
 */
async function isMembersOwnFile(file: string, content: string, ledger: DeliveryLedger | undefined): Promise<boolean> {
  const disk = await fileHash(file);
  return disk !== null && disk !== contentHash(content) && ledger?.previous?.[file] === undefined;
}


/** Say so when a copy pull kept as the member edited it is one the tool cannot apply (JoyCode's quoted globs). */
async function warnIfKeptCopyIsInert(target: DeliveryTarget): Promise<void> {
  if (target.tool !== 'joycode') return;
  const copy = await readFileSafe(target.dest);
  const warning = copy === null ? null : joycodeQuotedGlobsWarning(target.dest, copy);
  if (warning) log.warn(warning);
}

/**
 * Whether `deployed` holds exactly one of `renders` of the team rule, as it is
 * now or as it was at one of `deliveredRevs`: a root rule edited in the same
 * push that adds its namespace override leaves the older render behind, which
 * nobody edited.
 */
async function isDeliveredRender(
  renders: ReadonlyArray<(rawTeamRule: string) => string>,
  deployed: string,
  rule: ResourceItem,
  repoPath: string,
  deliveredRevs: readonly string[],
): Promise<boolean> {
  // teamai writes files, never links: a link is the member's, whatever its target holds (#993).
  if (await isLink(deployed)) return false;
  const current = await readFileSafe(deployed);
  if (current === null) return false;
  const matches = (raw: string): boolean => renders.some((render) => current === render(raw));
  const team = await readFileSafe(rule.sourcePath);
  if (team !== null && matches(team)) return true;
  for (const rev of deliveredRevs) {
    const delivered = await getFileContentAtRev(repoPath, rev, `./${rule.relativePath}`);
    if (delivered !== null && matches(delivered.toString('utf-8'))) return true;
  }
  return false;
}

/**
 * The team rules as one text, for a tool with no rules directory: Hermes,
 * whose SOUL.md block pull writes and `doctor` compares, the tools with a
 * user-scope file of their own (`teamRulesBlock`), and in a project the
 * tools whose session-start hook or extension adds it (`teamRulesContext`).
 *
 * Frontmatter is dropped. Neither can scope a rule to paths, so a path-scoped
 * rule is always on, led by a line naming its globs.
 */
export async function inlinedRulesText(rules: ResourceItem[]): Promise<string> {
  const bodies: string[] = [];
  for (const rule of rules) {
    const content = await readFileSafe(rule.sourcePath);
    if (!content) continue;
    // The tolerant parse the native renders use, so `paths: **/*.ts` keeps its hint (#946).
    const body = teamRuleBody(content);
    if (body === '') continue;
    const paths = rulePaths(teamRuleData(content));
    const scope = paths.length > 0 ? `Applies to files matching: ${paths.join(', ')}\n` : '';
    bodies.push(`${scope}${body}`);
  }
  return bodies.join('\n\n');
}

/**
 * The team-rules block for the user-scope file a tool with no rules format
 * reads (`userRulesFile`: the Codex family, #938; ZCode, DeepSeek Harness,
 * OpenClaw, Pi, JoyCode, #946), markers included. Null when no rule has a body. The body is
 * the same render Hermes gets in SOUL.md.
 */
export async function teamRulesBlock(rules: ResourceItem[]): Promise<string | null> {
  // A marker anywhere in a rule body would cut the block short on the next
  // read, which finds the markers by substring. A line that held only one goes.
  const body = (await inlinedRulesText(rules))
    .split('\n')
    .flatMap((line) => {
      const cleaned = line.replaceAll(TEAMAI_TEAM_RULES_START, '').replaceAll(TEAMAI_TEAM_RULES_END, '');
      return cleaned !== line && cleaned.trim() === '' ? [] : [cleaned];
    })
    .join('\n')
    .trim();
  if (body === '') return null;
  return [
    TEAMAI_TEAM_RULES_START,
    '<!-- DO NOT EDIT: This section is auto-managed by teamai -->',
    '',
    body,
    '',
    TEAMAI_TEAM_RULES_END,
  ].join('\n');
}

/**
 * The team rules a tool with no rules format gets from its session-start hook
 * or extension in a project (the Codex family, #938; ZCode, DeepSeek Harness
 * and Pi, #946): the rules this member receives there,
 * as pull resolves them, in the same render as Hermes' SOUL.md. Null when no
 * rule has a body. User-scope rules reach it through its own instructions
 * file instead.
 */
export async function teamRulesContext(teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<string | null> {
  const { buildRolePullContext, resolveDesiredRules } = await import('./desired.js');
  const { items } = await resolveDesiredRules(teamConfig, localConfig, await buildRolePullContext(localConfig));
  const text = await inlinedRulesText(items);
  return text === '' ? null : `Team rules (from teamai):\n\n${text}`;
}

/**
 * Why an installed tool gets no rules in this scope, or what limits the
 * channel it gets them through, for init and doctor to print as notes rather
 * than failures (#946). Hermes reads its rules from the global SOUL.md and
 * OpenClaw from its workspace AGENTS.md, which only a user-scope pull writes;
 * ZCode and DeepSeek Harness lose their session-start hook's text when they
 * compact a session.
 */
export async function ruleChannelNotes(localConfig: LocalConfig): Promise<string[]> {
  const notes: string[] = [];
  if (localConfig.scope !== 'project') return notes;
  if (!isAgentExcluded(localConfig, 'hermes')) {
    const { getHermesHome } = await import('../hermes-home.js');
    if (await pathExists(getHermesHome())) {
      notes.push(
        'Hermes gets no project rules: it reads team rules only from the global SOUL.md, which a '
        + 'user-scope pull writes (`teamai init --scope user`). A project channel would cost more than '
        + 'it gives: .hermes.md would hide the project AGENTS.md, a pre_llm_call hook repeats the rules '
        + 'on every turn, and the plugin prompt section (at most 4,000 characters) already carries '
        + 'the team instructions.',
      );
    }
  }
  if (!isAgentExcluded(localConfig, 'openclaw')) {
    const { resolveOpenclawWorkspaceDir } = await import('../openclaw-hooks.js');
    if (await resolveOpenclawWorkspaceDir() !== null) {
      notes.push(
        'OpenClaw gets no project rules: its only project file is the AGENTS.md other tools read too, '
        + 'and it reads no rules directory. It reads the team rules from its workspace AGENTS.md, which a '
        + 'user-scope pull writes (`teamai init --scope user`).',
      );
    }
  }
  // Their session-start hook carries a project's rules (#946); doctor checks
  // that it is registered, but cannot see these limits.
  if (!isAgentExcluded(localConfig, 'zcode') && await pathExists(path.join(getUserHome(), '.zcode'))) {
    notes.push(
      'ZCode gets the project\'s team rules from teamai\'s SessionStart hook, and drops that text when it compacts '
      + 'a session: the rules come back in the next session.',
    );
  }
  const { isDshInstalled, resolveDshPatchPath } = await import('../dsh-hooks.js');
  if (!isAgentExcluded(localConfig, 'dsh') && await isDshInstalled()) {
    notes.push(
      'DeepSeek Harness gets the project\'s team rules from teamai\'s session-start hook only when dsh runs with '
      + `\`--patch "${resolveDshPatchPath()}"\`. It runs that hook detached, so the first request can miss the rules, `
      + 'and it drops them when it compacts a session: they come back in the next session.',
    );
  }
  return notes;
}
