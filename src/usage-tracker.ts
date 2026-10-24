import fs from 'node:fs';
import path from 'node:path';
import { log } from './utils/logger.js';
import {
  DEFAULT_TOOL_PATHS,
  getDataHome,
  getTeamaiHomeDir,
  SKILL_NAME_REGEX,
  type LocalConfig,
  type UsageEvent,
} from './types.js';
import { readJson, writeJson, writeFileAtomic, pathExists } from './utils/fs.js';
import { appendJsonl, readJsonl, rewriteJsonl, type JsonlStoreOptions } from './utils/jsonl-store.js';
import { getUserHome } from './utils/home.js';
import { withFileLock } from './update.js';
import { loadTeamConfig, resolveConfigForDir } from './config.js';
import { samePath } from './utils/agent-path.js';

/**
 * The usage JSONL of one scope: `<dataHome>/usage.jsonl`, so each scope reports
 * only the skills used where it is set up (#748). Evaluated at call time to
 * respect HOME changes in tests.
 *
 * The user scope records in `~/.teamai/user-usage.jsonl` instead: every scope
 * used to record in `~/.teamai/usage.jsonl`, and an earlier release still does
 * after a rollback, so what that file holds names no project. It is never
 * read, so the user scope cannot report it to its team.
 */
function getUsagePath(config: LocalConfig): string {
  const dataHome = getDataHome(config);
  const sharedDir = getTeamaiHomeDir();
  if (path.resolve(dataHome) !== path.resolve(sharedDir)) return path.join(dataHome, 'usage.jsonl');
  return path.join(sharedDir, 'user-usage.jsonl');
}

/** Get the known-skills.json path (evaluated at call time to respect HOME changes in tests). */
function getKnownSkillsPath(): string {
  return path.join(getUserHome(), '.teamai', 'known-skills.json');
}

// ─── Data flow ─────────────────────────────────────────
//
//  post-tool-use '*' (skill-use)          prompt-submit '*' (skill-mention)
//  a skill tool call or a SKILL.md read   /name, Codex $name, Pi /skill:name
//                  │                                 │
//                  └──────────── skill-use.ts ───────┘
//                                     │
//                     [skill installed under a skill root?]
//                     [first credit this session turn?]
//                                     │
//                                     ▼
//               appendUsageEvent → <scope usage file>
//               updateKnownSkills → known-skills.json
//

/**
 * Extract skill name from the Skill tool's input.
 * Accepts either a JSON string or a parsed object.
 *
 * Handles multiple field names that different AI tool providers may use:
 *   - skill, name (original)
 *   - id (OpenCode 2.x)
 *   - skill_name (Claude Code variant)
 *   - command (some providers wrap skill invocation)
 *
 * If the value looks like a file path (e.g. "/root/.cursor/skills/tdd/SKILL.md"),
 * extracts the skill directory name as the skill identifier.
 */
export function extractSkillName(toolInput: string | Record<string, unknown>): string | null {
  try {
    const parsed = typeof toolInput === 'string' ? JSON.parse(toolInput) : toolInput;
    const raw: unknown = parsed?.skill ?? parsed?.name ?? parsed?.id ?? parsed?.skill_name ?? parsed?.command ?? null;
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;

    // If value looks like a path to SKILL.md, extract the parent directory name
    const skillMdMatch = trimmed.match(/\/([^/]+)\/SKILL\.md$/i);
    if (skillMdMatch) return skillMdMatch[1];

    // If value looks like a filesystem path, extract the last segment
    if (trimmed.startsWith('/') || trimmed.startsWith('~')) {
      const segments = trimmed.split('/').filter(Boolean);
      return segments[segments.length - 1] || null;
    }

    return trimmed;
  } catch {
    return null;
  }
}

/**
 * Validate a skill name against allowed characters.
 * Prevents path traversal and overly long names.
 */
export function isValidSkillName(name: string): boolean {
  return SKILL_NAME_REGEX.test(name);
}

/** What decides where skills are installed for one hook event. */
export type SkillRootsInput = {
  readonly config: LocalConfig;
  /** The member's relocated tool roots (resolveMemberToolRoots). */
  readonly toolRoots?: Record<string, string>;
  /** The directory the hook ran in, the project when the scope names none. */
  readonly hookCwd?: string;
  /** Restrict name-based loads to this tool; file reads may use every root. */
  readonly tool?: string;
};

/**
 * Every directory a skill can be installed in: where each tool of the team's
 * `toolPaths`, custom tools included, takes skills (`locate`: its writes and
 * the directories it reads) in user scope and in the project, whether or not
 * it is selected or installed, plus the shared `.agents/skills` of both. With
 * `tool`, keep only its roots and the shared ones. The project is the scope's
 * `projectRoot`, else the hook's directory; the home `.github` belongs to no project.
 */
export async function skillRoots({ config, toolRoots, hookCwd, tool: callingTool }: SkillRootsInput): Promise<string[]> {
  const { installOf, locate, SHARED_AGENT_SKILLS_PATH, writesOf } = await import('./locate.js');
  const team = { toolPaths: (await loadTeamConfig(config.repo.localPath))?.toolPaths ?? DEFAULT_TOOL_PATHS };
  const home = getUserHome();
  const roots = new Set([path.join(home, SHARED_AGENT_SKILLS_PATH)]);
  const installs = [installOf(team, { ...config, scope: 'user', toolRoots })];
  const project = config.scope === 'project' && config.projectRoot ? config.projectRoot : hookCwd;
  if (project !== undefined && path.resolve(project) !== path.resolve(home)) {
    roots.add(path.join(project, SHARED_AGENT_SKILLS_PATH));
    installs.push(installOf(team, { ...config, scope: 'project', projectRoot: project, toolRoots }));
  }
  for (const install of installs) {
    for (const tool of Object.keys(team.toolPaths)) {
      if (callingTool !== undefined && callingTool !== tool) continue;
      const where = await locate(tool, 'skills', install);
      for (const place of writesOf(where)) roots.add(place.path);
      if (where.reads !== 'unknown') for (const read of where.reads) roots.add(read.path);
    }
  }
  return [...roots];
}

/**
 * Whether a skill exists on disk: a SKILL.md under one of `roots` (skillRoots).
 * This prevents tracking phantom skills from typos or inputs like "/data" or "$HOME".
 */
export async function skillExistsOnDisk(skillName: string, roots: readonly string[]): Promise<boolean> {
  for (const root of roots) {
    if (await pathExists(path.join(root, skillName, 'SKILL.md'))) return true;
  }
  return false;
}

/** Whether `file` is the SKILL.md of `skillName` under one of `roots`, however either path is spelled. */
export async function isInstalledSkillFile(skillName: string, file: string, roots: readonly string[]): Promise<boolean> {
  const real = await fs.promises.realpath(file).catch(() => null);
  if (real === null) return false;
  for (const root of roots) {
    const installed = await fs.promises.realpath(path.join(root, skillName, 'SKILL.md')).catch(() => null);
    if (installed !== null && samePath(installed, real)) return true;
  }
  return false;
}

/**
 * The usage file keeps the mode an unconfigured append gives it, as before the
 * store existed (Node's default, narrowed by the umask).
 */
const USAGE_FILE_MODE = 0o666;

/** Store options every writer of a scope's usage file passes. */
function usageStoreOptions(config: LocalConfig, usagePath: string): JsonlStoreOptions {
  return { mode: USAGE_FILE_MODE, beforeSideFile: () => ignoreUsageSideFiles(config, usagePath) };
}

/**
 * Append a usage event to the local JSONL file.
 * Silently fails on I/O errors (disk full, permission denied, etc.)
 * to avoid disrupting the AI coding session.
 */
export async function appendUsageEvent(event: UsageEvent, config: LocalConfig): Promise<void> {
  try {
    const usagePath = getUsagePath(config);
    const pendingPath = await appendJsonl(usagePath, event, usageStoreOptions(config, usagePath));
    log.debug(pendingPath ? `Tracked skill: ${event.skill} (in ${pendingPath}; ${usagePath}.lock is held)` : `Tracked skill: ${event.skill}`);
  } catch (e) {
    log.error(`Failed to write usage event: ${(e as Error).message}`);
  }
}

/**
 * Read all usage events from a scope's JSONL file.
 * Skips corrupted lines gracefully.
 */
export async function readUsageEvents(config: LocalConfig): Promise<UsageEvent[]> {
  try {
    const events: UsageEvent[] = [];
    // Side records count once a lock holder folds them in, as before the store.
    for (const parsed of (await readJsonl(getUsagePath(config), { includePending: false })) as Partial<UsageEvent>[]) {
      if (parsed.skill && parsed.timestamp) {
        events.push({ skill: parsed.skill, timestamp: parsed.timestamp, tool: parsed.tool } as UsageEvent);
      }
    }
    return events;
  } catch {
    return [];
  }
}

/**
 * Truncate the usage JSONL file, keeping only events after `afterTimestamp`.
 * Used after successful auto-report to keep the file small.
 */
export async function truncateUsageAfterReport(reportedCount: number, config: LocalConfig): Promise<void> {
  try {
    // All lines reported → an empty file; otherwise keep the unreported lines.
    await rewriteUsageFile(config, (lines) => lines.slice(reportedCount));
    log.debug(`Truncated usage.jsonl: removed ${reportedCount} reported events`);
  } catch (e) {
    log.error(`Failed to truncate usage.jsonl: ${(e as Error).message}`);
  }
}

/** Most events a scope's usage file keeps; `pull` drops the oldest beyond it (#788). */
export const USAGE_EVENT_CAP = 5_000;

/**
 * Keep only the newest {@link USAGE_EVENT_CAP} events of a scope's usage file,
 * so a scope that never reports (http, `usageReport: false`, a rejecting
 * remote) stops growing without emptying `teamai stats`. The report truncates
 * the first N lines it read, so this must run after that truncate, never
 * between the report's read and its truncate. Counts non-empty lines, as the
 * truncate does. A file at or below the cap is not rewritten.
 */
export async function capUsageEvents(config: LocalConfig): Promise<void> {
  let dropped = 0;
  try {
    await rewriteUsageFile(config, (lines) => {
      if (lines.length <= USAGE_EVENT_CAP) return null;
      dropped = lines.length - USAGE_EVENT_CAP;
      return lines.slice(-USAGE_EVENT_CAP);
    });
    if (dropped) log.debug(`Capped usage.jsonl: dropped ${dropped} oldest events`);
  } catch (e) {
    if (typeof e === 'object' && e !== null && 'code' in e && e.code === 'ENOENT') return;
    log.error(`Could not cap ${getUsagePath(config)} to ${USAGE_EVENT_CAP} events: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Replace a scope's usage file with the non-empty lines `keep` returns, or
 * leave it untouched when `keep` returns null, under the lock every writer of
 * the file takes (#788).
 */
async function rewriteUsageFile(config: LocalConfig, keep: (lines: string[]) => string[] | null): Promise<void> {
  const usagePath = getUsagePath(config);
  await rewriteJsonl(usagePath, keep, usageStoreOptions(config, usagePath));
}

/** The lock, a rewrite's temp copy and the events a hook records while the lock is held. */
const USAGE_SIDE_FILE_PATTERNS = ['usage.jsonl.*', 'usage.pending-*.jsonl'];

/**
 * Add {@link USAGE_SIDE_FILE_PATTERNS} to the `.gitignore` beside a project
 * scope's usage file when it predates them. `teamai init` writes that file only
 * once, so a legacy in-workspace `.teamai/` still ignores `usage.jsonl` alone
 * and the side files would show in the business repo's git status. Single-repo
 * mode heals its own file (migrateSelfModeGitignore). Best-effort: a missing
 * `.gitignore` stays missing, and a failure never costs the event.
 */
async function ignoreUsageSideFiles(config: LocalConfig, usagePath: string): Promise<void> {
  if (config.scope !== 'project' || config.repo.kind === 'self') return;
  const gitignorePath = path.join(path.dirname(usagePath), '.gitignore');
  try {
    const lines = (await fs.promises.readFile(gitignorePath, 'utf-8')).split('\n');
    const missing = USAGE_SIDE_FILE_PATTERNS.filter((p) => !lines.some((l) => l.trim() === p));
    if (!missing.length) return;
    const anchor = lines.findIndex((l) => l.trim() === 'usage.jsonl');
    const at = anchor >= 0 ? anchor + 1 : lines.length - (lines[lines.length - 1] === '' ? 1 : 0);
    lines.splice(at, 0, ...missing);
    // A full disk or a kill mid-write must not leave it empty: it also ignores `token` and `env`.
    await writeFileAtomic(gitignorePath, lines.join('\n'));
  } catch (e) {
    if (typeof e === 'object' && e !== null && 'code' in e && e.code === 'ENOENT') return;
    log.debug(`Could not add the usage side files to ${gitignorePath}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** A hook waits at most ~1 s for the known-skills lock; detached hooks of one session update it at once. */
const KNOWN_SKILLS_LOCK_WAIT = { attempts: 20, delayMs: 50 };

/**
 * Add a skill to the known-skills set (persisted across truncations), under
 * the file's lock so concurrent hooks do not drop each other's skill.
 * Silently fails on I/O errors to avoid disrupting the AI coding session.
 */
export async function updateKnownSkills(skillName: string): Promise<void> {
  const knownPath = getKnownSkillsPath();
  const lockPath = `${knownPath}.lock`;
  try {
    const updated = await withFileLock(lockPath, KNOWN_SKILLS_LOCK_WAIT, async () => {
      const existing = await readJson<string[]>(knownPath);
      const skills = new Set(Array.isArray(existing) ? existing : []);
      if (skills.has(skillName)) return;
      skills.add(skillName);
      await writeJson(knownPath, Array.from(skills).sort());
      log.debug(`Added ${skillName} to known-skills.json`);
    });
    if (updated.held) return;
    log.debug(`${lockPath} is still held, so ${skillName} was not added to known-skills.json; its usage event is recorded`);
  } catch (e) {
    log.error(`Failed to update known-skills: ${(e as Error).message}`);
  }
}

/**
 * Read the set of skills the current user has ever used.
 * Merges local usage.jsonl (unreported events) with known-skills.json (persisted history).
 */
export async function readKnownSkills(): Promise<Set<string>> {
  const skills = new Set<string>();

  // Source 1: unreported events in the usage.jsonl of the scope governing the cwd
  // (Source 2 below stays machine-wide; neither leaves the machine)
  const config = await resolveConfigForDir();
  const events = config ? await readUsageEvents(config) : [];
  for (const event of events) {
    skills.add(event.skill);
  }

  // Source 2: known-skills.json (survives truncation)
  try {
    const known = await readJson<string[]>(getKnownSkillsPath());
    if (Array.isArray(known)) {
      for (const name of known) {
        if (typeof name === 'string') skills.add(name);
      }
    }
  } catch {
    // known-skills.json missing or corrupted — use only JSONL data
  }

  return skills;
}

/**
 * Read STDIN fully and return its content as a string.
 * Returns empty string if STDIN is not a pipe or is empty.
 */
async function readStdin(): Promise<string> {
  // If STDIN is a TTY (interactive), don't block waiting for input
  if (process.stdin.isTTY) return '';

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Handle the hidden `teamai track <toolName> <toolInput>` command, which hooks
 * written before hook-dispatch call until a pull replaces them.
 */
export async function track(rawToolName: string, toolInput: string, tool?: string): Promise<void> {
  let input: unknown;
  try {
    input = JSON.parse(toolInput);
  } catch {
    log.debug('Could not parse the tool input of a track call');
    return;
  }
  const config = await resolveConfigForDir();
  if (!config) return;
  const { creditToolCall } = await import('./skill-use.js');
  await creditToolCall({ tool_name: rawToolName, tool_input: input }, tool ?? 'claude', config);
}

/** A hook payload from STDIN, or null when there is none or it is not a JSON object. */
async function readHookStdin(): Promise<Record<string, unknown> | null> {
  const raw = await readStdin();
  if (!raw.trim()) {
    log.debug('No STDIN data received');
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return { ...parsed };
  log.error('Failed to parse STDIN JSON');
  return null;
}

/** Handle the hidden `teamai track --stdin` command (a pre-hook-dispatch PostToolUse hook). */
export async function trackFromStdin(toolArg?: string): Promise<void> {
  const hookData = await readHookStdin();
  if (!hookData) return;
  const tool = toolArg ?? 'claude';
  const { resolveHookConfig } = await import('./dashboard-collector.js');
  const config = await resolveHookConfig(hookData, tool);
  if (!config) return;
  const { creditToolCall } = await import('./skill-use.js');
  await creditToolCall(hookData, tool, config);
}

/** Handle the hidden `teamai track-slash --stdin` command (a pre-hook-dispatch UserPromptSubmit hook). */
export async function trackSlashCommand(toolArg?: string): Promise<void> {
  const hookData = await readHookStdin();
  if (!hookData) return;
  const tool = toolArg ?? 'claude';
  const { resolveHookConfig } = await import('./dashboard-collector.js');
  const config = await resolveHookConfig(hookData, tool);
  if (!config) return;
  const { creditPromptMentions } = await import('./skill-use.js');
  await creditPromptMentions(hookData, tool, config);
}
