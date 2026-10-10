import fs from 'node:fs';
import path from 'node:path';
import { gitTracks, realFilePath } from './git-exclude.js';
import { judgeTeamaiOnlyCodexHooks } from './hooks.js';
import { instructionTargetPath } from './instruction-targets.js';
import { findMcpGitExcludes } from './mcp-git-exclude.js';
import { judgeTeamaiOnlyMcpConfigs, opencodeV1Servers } from './mcp-reconcile.js';
import { opencodeDeliversThroughPlugin } from './opencode-hooks.js';
import { opencodeContextReference, readOpencodeInstructionList, reconcileOpencodeInstructionSet } from './resources/opencode-config.js';
import { RulesHandler } from './resources/rules.js';
import { resolveToolBaseDir, scopedToolPaths, type LocalConfig, type TeamaiConfig } from './types.js';
import { readFileSafe } from './utils/fs.js';

// ─── teamai-only files (#915) ─────────────────────────────────
//
//  A shared config file teamai writes entries into, in a project, that holds
//  nothing but teamai's entries: no other top-level key, and every entry one
//  teamai owns. While git does not track it, pull lists it in teamai's
//  `delivered` git exclude block; once it holds anything else, it is the
//  member's too, and git sees it again. Files: the project MCP configs with no
//  per-member alternative (judgeTeamaiOnlyMcpConfigs), `.codex/hooks.json`
//  (judgeTeamaiOnlyCodexHooks) and OpenCode's `.opencode/opencode.json`.

/**
 * How a shared file teamai writes entries into stands:
 * - `teamai-only`: untracked, and holds only teamai's entries;
 * - `mixed`: untracked, and holds something teamai does not own, or does not parse;
 * - `tracked`: git tracks it, whatever it holds;
 * - `unknown`: git could not say whether it tracks it.
 */
export type TeamaiOnlyState = 'teamai-only' | 'mixed' | 'tracked' | 'unknown';

export interface SharedFileJudgement {
  /** Absolute, as teamai writes it. */
  file: string;
  state: TeamaiOnlyState;
  /** `unknown`: what git said. */
  error?: string;
}

/**
 * Every shared file of this project scope that teamai writes entries into and
 * that exists and holds anything, judged. Run after the MCP and hook
 * reconciles: their adoption of unrecorded entries equal to a team render
 * (#993) is what makes a file written before an upgrade, or before its record
 * was lost, teamai-only. Read-only.
 */
export async function judgeTeamaiOnlyFiles(teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<SharedFileJudgement[]> {
  if (localConfig.scope !== 'project') return [];
  const verdicts = [
    ...await judgeTeamaiOnlyMcpConfigs(teamConfig, localConfig),
    ...[await judgeTeamaiOnlyCodexHooks(teamConfig, localConfig), await judgeOpencodeInstructions(teamConfig, localConfig)]
      .filter((verdict) => verdict !== null),
  ];
  // One file judged twice (a team mapping two writers to it) is teamai-only only if both say so.
  const byFile = new Map<string, boolean>();
  for (const { file, teamaiOnly } of verdicts) byFile.set(file, (byFile.get(file) ?? true) && teamaiOnly);
  const judged: SharedFileJudgement[] = [];
  for (const [file, teamaiOnly] of byFile) {
    const tracking = await gitTracks(file);
    if (tracking.kind === 'unknown') judged.push({ file, state: 'unknown', error: tracking.error });
    else judged.push({ file, state: tracking.kind === 'tracked' ? 'tracked' : teamaiOnly ? 'teamai-only' : 'mixed' });
  }
  return judged;
}

/**
 * The real paths of those of `files` that teamai's `mcp-exclude` block keeps
 * out of git whatever they hold, as they hold a value teamai resolved (#882):
 * leaving the `delivered` block does not make them visible.
 */
export async function keptOutByMcpExclude(files: readonly string[]): Promise<Set<string>> {
  const blocks = await findMcpGitExcludes(files.map((file) => path.dirname(file)));
  const listed = [...blocks.values()].flat().flatMap(({ files: protectedFiles }) => protectedFiles);
  return new Set(await Promise.all(listed.map((file) => realFilePath(file))));
}

/** The notice of a listed teamai-only file that now holds something teamai does not own. */
export async function describeNoLongerTeamaiOnly(file: string, projectRoot: string): Promise<string> {
  return `${await shownPath(file, projectRoot)} now holds entries teamai does not own, so git can see it.`;
}

/**
 * The failure for a shared file git could not say it tracks (`unknown`):
 * `kept`, its line from the last pull stays; else it has none.
 */
export async function describeUnknownTracking(judgement: SharedFileJudgement, projectRoot: string, kept: boolean): Promise<string> {
  const shown = await shownPath(judgement.file, projectRoot);
  return `git could not say whether it tracks ${shown}: ${judgement.error ?? 'git failed'}. `
    + (kept ? 'teamai keeps its git exclude line as the last pull left it. ' : 'teamai cannot tell whether to keep it out of git. ')
    + 'Fix the repository, then run `teamai pull` again.';
}

/** `file` from the project root when it is inside it, else its real path. */
async function shownPath(file: string, projectRoot: string): Promise<string> {
  const [real, root] = await Promise.all([realFilePath(file), realFilePath(projectRoot)]);
  const rel = path.relative(root, real);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : real;
}

/**
 * OpenCode's `.opencode/opencode.json` in this project, and which of its
 * `instructions` entries are teamai's: equal to the ones teamai writes there
 * (the rules glob of `opencodeInstructionsTarget`, and the `teamai-context`
 * entry). There is no record of them; equality is the proof. Null when
 * OpenCode gets no rules here.
 */
async function opencodeInstructionEntries(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
): Promise<{ file: string; ours: (entry: unknown) => boolean } | null> {
  const target = await new RulesHandler().opencodeInstructionsTarget(teamConfig, localConfig, []);
  if (target === null) return null;
  const file = target.configFile;
  const paths = scopedToolPaths(teamConfig, localConfig).opencode;
  const contextFile = paths ? await instructionTargetPath('opencode', paths, localConfig) : undefined;
  const context = contextFile ? opencodeContextReference(contextFile, 'project', resolveToolBaseDir('opencode', localConfig)) : null;
  return {
    file,
    ours: (entry) => typeof entry === 'string' && (target.owns(entry) || (context?.config === file && entry === context.entry)),
  };
}

/**
 * On OpenCode V2 with teamai's plugin (#915): take teamai's `instructions`
 * entries, which V2 ignores, out of `.opencode/opencode.json` when git does
 * not track it, and delete the file when it held nothing else; the plugin adds
 * the team instructions and rules. The member's entries and keys stay. A file
 * git tracks is left (`opencodeV1Leftovers`). Run after the pull reconciled
 * the plugin. What it did or, with `dryRun`, would do; null for nothing.
 */
export async function retireOpencodeV1Instructions(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  dryRun: boolean,
): Promise<string | null> {
  if (!await opencodeDeliversThroughPlugin(teamConfig, localConfig)) return null;
  const verdict = await judgeOpencodeInstructions(teamConfig, localConfig);
  if (!verdict || (await gitTracks(verdict.file, 'entry')).kind !== 'untracked') return null;
  const outcome = 'which OpenCode V2 ignores; teamai\'s plugin adds the team instructions and rules.';
  if (verdict.teamaiOnly) {
    if (!dryRun) await fs.promises.rm(verdict.file, { force: true });
    return `${dryRun ? 'Would delete' : 'Deleted'} ${verdict.file}: it held only teamai's \`instructions\` entries, ${outcome}`;
  }
  const entries = await opencodeInstructionEntries(teamConfig, localConfig);
  const ours = ((await readOpencodeInstructionList(verdict.file)) ?? []).filter((entry): entry is string => entries?.ours(entry) === true);
  if (!entries || ours.length === 0) return null;
  if (!dryRun && !await reconcileOpencodeInstructionSet(verdict.file, [], entries.ours, 'team instructions')) return null;
  return `${dryRun ? 'Would take' : 'Took'} teamai's \`instructions\` entries (${ours.join(', ')}) out of ${verdict.file}, ${outcome}`;
}

/**
 * On OpenCode V2 with teamai's plugin (#915): the project's opencode.json
 * files that still hold the entries teamai wrote for OpenCode V1, as git
 * tracks them (or a pull cannot edit them), so a pull left them. Read-only,
 * for doctor.
 */
export async function opencodeV1Leftovers(teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<Array<{ file: string; entries: string[] }>> {
  if (!await opencodeDeliversThroughPlugin(teamConfig, localConfig)) return [];
  const left: Array<{ file: string; entries: string[] }> = [];
  const servers = await opencodeV1Servers(teamConfig, localConfig);
  if (servers) left.push({ file: servers.file, entries: servers.names });
  const instructions = await opencodeInstructionEntries(teamConfig, localConfig);
  const listed = instructions && await readOpencodeInstructionList(instructions.file);
  const ours = (listed ?? []).filter((entry): entry is string => instructions?.ours(entry) === true);
  if (instructions && ours.length > 0) left.push({ file: instructions.file, entries: ours });
  return left;
}

/**
 * OpenCode's `.opencode/opencode.json`, when it exists and holds anything,
 * and whether it holds only teamai's `instructions` (`opencodeInstructionEntries`),
 * at least one, and no other top-level key. A symlink is the member's.
 */
async function judgeOpencodeInstructions(teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<{ file: string; teamaiOnly: boolean } | null> {
  const entries = await opencodeInstructionEntries(teamConfig, localConfig);
  if (entries === null) return null;
  const { file, ours } = entries;
  if (!(await fs.promises.lstat(file).catch(() => null))?.isFile()) return null;
  const raw = await readFileSafe(file);
  if (raw === null || raw.trim() === '') return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { file, teamaiOnly: false };
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return { file, teamaiOnly: false };
  const { instructions, ...others } = data as { instructions?: unknown };
  if (Object.keys(others).length > 0) return { file, teamaiOnly: false };
  if (instructions === undefined) return null;
  return { file, teamaiOnly: Array.isArray(instructions) && instructions.length > 0 && instructions.every(ours) };
}
