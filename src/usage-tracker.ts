import fs from 'node:fs';
import path from 'node:path';
import { log } from './utils/logger.js';
import { normalizeToolName } from './utils/tool-names.js';
import {
  getCopilotHome,
  getDataHome,
  getTeamaiHomeDir,
  SKILL_NAME_REGEX,
  type LocalConfig,
  type UsageEvent,
  resolveToolRootDir,
  RELOCATABLE_TOOLS,
} from './types.js';
import { readJson, writeJson, writeFileAtomic, pathExists } from './utils/fs.js';
import { appendJsonl, readJsonl, rewriteJsonl, type JsonlStoreOptions } from './utils/jsonl-store.js';
import { getUserHome } from './utils/home.js';
import { resolveHookCwd } from './utils/hook-cwd.js';
import { resolveConfigForDir, resolveMemberToolRoots } from './config.js';

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
//  Claude Code / Claude Internal / CodeBuddy       Cursor
//  ─────────────────────────────────────────       ──────
//  PostToolUse hook (matcher: "Skill")             PostToolUse hook (matcher: "Read")
//      │                                               │
//      ▼                                               ▼
//  { tool_name: "Skill",                          { tool_name: "Read",
//    tool_input: { skill: "tdd" } }                 tool_input: { path: "…/SKILL.md" } }
//      │                                               │
//      └────────────────┬──────────────────────────────┘
//                       ▼
//         teamai track --stdin --tool <name>
//                       │
//                       ▼
//               [extract & validate skill name]
//               [toolArg → toolSource; Read+SKILL.md → 'cursor']
//                       │
//                       ▼
//               [resolveHookConfig(payload)] ─null─▶ skip (#748)
//                       │
//                       ▼
//               appendFile(<scope usage file>, JSON line)
//                       │
//                       ▼
//               updateKnownSkills(skill) → known-skills.json
//
//  ─── Slash command tracking (Claude Code only) ────────
//
//  UserPromptSubmit hook (matcher: "*")
//      │
//      ▼
//  { prompt: "/plan-eng-review args..." }
//      │
//      ▼
//  teamai track-slash --stdin --tool <name>
//      │
//      ▼
//  [starts with "/"?] ──No──▶ exit(0)
//      │Yes
//      ▼
//  [extract & validate skill name after "/"]
//      │
//      ▼
//  appendFile(<scope usage file>) + updateKnownSkills()
//

/**
 * Extract skill name from the Skill tool's input.
 * Accepts either a JSON string or a parsed object.
 *
 * Handles multiple field names that different AI tool providers may use:
 *   - skill, name (original)
 *   - skill_name (Claude Code variant)
 *   - command (some providers wrap skill invocation)
 *
 * If the value looks like a file path (e.g. "/root/.cursor/skills/tdd/SKILL.md"),
 * extracts the skill directory name as the skill identifier.
 */
export function extractSkillName(toolInput: string | Record<string, unknown>): string | null {
  try {
    const parsed = typeof toolInput === 'string' ? JSON.parse(toolInput) : toolInput;
    const raw: unknown = parsed?.skill ?? parsed?.name ?? parsed?.skill_name ?? parsed?.command ?? null;
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

/** A resolved, validated skill invocation from a PostToolUse payload. */
export interface ResolvedSkillUse {
  /** The validated skill name (passes {@link isValidSkillName}). */
  skillName: string;
  /** 'cursor' for a Read of a SKILL.md path, otherwise the caller's tool. */
  source: 'cursor' | null;
}

/**
 * Resolve a skill invocation from a PostToolUse hook payload — the single source
 * of truth shared by the usage tracker and the webhook handler so they can never
 * drift. Handles both shapes: Claude/CodeBuddy's `Skill` tool, and Cursor's
 * `Read` of a `.../SKILL.md` path. Returns null for anything else — including a
 * normal (non-SKILL.md) `Read`, so a plain file read never counts as skill use.
 * The returned name is already validated with {@link isValidSkillName}.
 */
export function resolveSkillUse(
  toolName: string,
  toolInput: Record<string, unknown>,
): ResolvedSkillUse | null {
  let skillName: string | null = null;
  let source: 'cursor' | null = null;

  if (toolName === 'Skill') {
    skillName = extractSkillName(toolInput);
  } else if (toolName === 'Read') {
    const filePath =
      (typeof toolInput.file_path === 'string' ? toolInput.file_path : null) ??
      (typeof toolInput.filePath === 'string' ? toolInput.filePath : null) ??
      (typeof toolInput.path === 'string' ? toolInput.path : null);
    // Only a Read of a SKILL.md file is skill use — a normal file read is not.
    if (filePath && /\/SKILL\.md$/i.test(filePath)) {
      skillName = extractSkillName({ skill: filePath });
      source = 'cursor';
    }
  } else {
    return null;
  }

  if (!skillName || !isValidSkillName(skillName)) return null;
  return { skillName, source };
}

/**
 * Well-known local skill directories to check for skill existence.
 * Ordered by likelihood of being present.
 */
const SKILL_DIRS = [
  '.claude/skills',
  '.claude-internal/skills',
  '.tclaude/skills',
  '.cursor/skills',
  '.codebuddy/skills',
  '.codex/skills',
  '.codex-internal/skills',
  '.tcodex/skills',
  '.openclaw/skills',
  '.hermes/skills',
];
const PROJECT_SKILL_DIRS = [...SKILL_DIRS, '.github/skills'];

/**
 * Check whether a skill actually exists on disk (has a SKILL.md in any tool's skills directory).
 * This prevents tracking phantom skills from typos or path inputs like "/data".
 *
 * Performance: Checks a bounded list of user and project directories with one stat() each.
 */
export async function skillExistsOnDisk(skillName: string, toolRoots?: Record<string, string>): Promise<boolean> {
  const home = getUserHome();
  // A relocated tool (Claude Code with CLAUDE_CONFIG_DIR, Codex with
  // CODEX_HOME) keeps its skills under the recorded root, which the static list
  // cannot know; the caller resolves it from the hook's directory
  // (resolveMemberToolRoots).
  const userSkillDirs = [
    ...Object.entries(RELOCATABLE_TOOLS).map(([tool, { defaultRoot }]) =>
      path.join(resolveToolRootDir(tool, defaultRoot, toolRoots), 'skills')),
    ...SKILL_DIRS.map((dir) => path.join(home, dir)),
    path.join(getCopilotHome(), 'skills'),
  ];
  // Check user-level directories
  for (const dir of userSkillDirs) {
    const skillMd = path.join(dir, skillName, 'SKILL.md');
    if (await pathExists(skillMd)) return true;
  }
  // Check project-level directories (cwd)
  const cwd = process.cwd();
  if (path.resolve(cwd) !== path.resolve(home)) {
    for (const dir of PROJECT_SKILL_DIRS) {
      const skillMd = path.join(cwd, dir, skillName, 'SKILL.md');
      if (await pathExists(skillMd)) return true;
    }
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

/**
 * Add a skill to the known-skills set (persisted across truncations).
 * Silently fails on I/O errors to avoid disrupting the AI coding session.
 */
export async function updateKnownSkills(skillName: string): Promise<void> {
  try {
    const knownPath = getKnownSkillsPath();
    const existing = await readJson<string[]>(knownPath);
    const skills = new Set(Array.isArray(existing) ? existing : []);
    if (skills.has(skillName)) return; // already known
    skills.add(skillName);
    await writeJson(knownPath, Array.from(skills).sort());
    log.debug(`Added ${skillName} to known-skills.json`);
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
 * Handle the `teamai track` CLI command.
 * Called by PostToolUse hook with CLI args (legacy) or STDIN JSON (current).
 */
export async function track(rawToolName: string, toolInput: string, tool?: string): Promise<void> {
  const toolName = normalizeToolName(rawToolName);
  // Only track Skill tool calls
  if (toolName !== 'Skill') {
    return;
  }

  const skillName = extractSkillName(toolInput);
  if (!skillName) {
    log.debug('Could not extract skill name from tool input');
    return;
  }

  if (!isValidSkillName(skillName)) {
    log.debug(`Invalid skill name rejected: ${skillName.slice(0, 50)}`);
    return;
  }

  const config = await resolveConfigForDir();
  if (!config) return;

  const event: UsageEvent = {
    skill: skillName,
    timestamp: new Date().toISOString(),
    tool: tool ?? 'claude',
  };

  await appendUsageEvent(event, config);
  await updateKnownSkills(skillName);
}

/**
 * Handle the `teamai track --stdin` mode.
 * Reads PostToolUse hook JSON from STDIN and extracts tool usage info.
 *
 * Supports two tool formats:
 *   - Claude Code "Skill" tool:  { tool_name: "Skill", tool_input: { skill: "tdd" } }
 *   - Cursor "Read" tool:        { tool_name: "Read",  tool_input: { path: "…/SKILL.md" } }
 *
 * @param toolArg - Optional tool identifier from --tool CLI flag.
 *                  When provided, used as the toolSource (e.g. 'claude-internal').
 *                  When absent, defaults to 'claude' for backward compatibility.
 *                  Exception: Read + SKILL.md always overrides to 'cursor'.
 */
export async function trackFromStdin(toolArg?: string): Promise<void> {
  const raw = await readStdin();
  if (!raw.trim()) {
    log.debug('No STDIN data received');
    return;
  }

  let hookData: { tool_name?: string; tool_input?: Record<string, unknown>; cwd?: unknown };
  try {
    hookData = JSON.parse(raw);
  } catch {
    log.error('Failed to parse STDIN JSON');
    return;
  }

  const rawName = hookData.tool_name;
  if (typeof rawName !== 'string') return;
  const toolName = normalizeToolName(rawName);

  const toolInput = hookData.tool_input;
  if (!toolInput || typeof toolInput !== 'object') {
    if (toolName === 'Skill' || toolName === 'Read') {
      log.debug('Missing or invalid tool_input in STDIN JSON');
    }
    return;
  }

  let skillName: string | null = null;
  let toolSource = toolArg ?? 'claude';

  if (toolName === 'Skill') {
    skillName = extractSkillName(toolInput);
  } else if (toolName === 'Read') {
    const filePath =
      (typeof toolInput.file_path === 'string' ? toolInput.file_path : null) ??
      (typeof toolInput.filePath === 'string' ? toolInput.filePath : null) ??
      (typeof toolInput.path === 'string' ? toolInput.path : null);
    if (filePath && /\/SKILL\.md$/i.test(filePath)) {
      skillName = extractSkillName({ skill: filePath });
      toolSource = 'cursor';
    }
  } else {
    return;
  }

  if (!skillName) {
    log.debug('Could not extract skill name from STDIN tool_input');
    return;
  }

  if (!isValidSkillName(skillName)) {
    log.debug(`Invalid skill name rejected: ${skillName.slice(0, 50)}`);
    return;
  }

  const { resolveHookConfig } = await import('./dashboard-collector.js');
  const config = await resolveHookConfig(hookData, toolArg ?? 'claude');
  if (!config) return;

  const event: UsageEvent = {
    skill: skillName,
    timestamp: new Date().toISOString(),
    tool: toolSource,
  };

  await appendUsageEvent(event, config);
  await updateKnownSkills(skillName);
}

/**
 * Handle the `teamai track-slash --stdin` mode.
 * Reads UserPromptSubmit hook JSON from STDIN and tracks slash commands.
 *
 * STDIN JSON format (Claude Code UserPromptSubmit):
 *   { prompt: "/plan-eng-review args...", session_id: "...", hook_event_name: "UserPromptSubmit" }
 *
 * Extracts the first word after "/" as the skill name.
 *
 * @param toolArg - Optional tool identifier from --tool CLI flag.
 *                  Defaults to 'claude' for backward compatibility.
 */
export async function trackSlashCommand(toolArg?: string): Promise<void> {
  const raw = await readStdin();
  if (!raw.trim()) {
    log.debug('No STDIN data for slash tracking');
    return;
  }

  let hookData: { prompt?: string; cwd?: unknown };
  try {
    hookData = JSON.parse(raw);
  } catch {
    log.error('Failed to parse slash command STDIN JSON');
    return;
  }

  const prompt = hookData.prompt;
  if (typeof prompt !== 'string' || !prompt.startsWith('/')) {
    return;
  }

  // Extract all skill names after "/" in the prompt
  // (e.g. "/plan-eng-review some args /tdd /code-review" → ["plan-eng-review", "tdd", "code-review"])
  // Match whole whitespace-delimited tokens, never segments of paths or URLs.
  const matches = [...prompt.matchAll(/(?:^|\s)\/([a-zA-Z0-9_\-:.]+)(?=\s|$)/g)];
  if (matches.length === 0) {
    log.debug('Could not extract skill name from slash command');
    return;
  }

  const hookCwd = resolveHookCwd(hookData);
  const { resolveHookConfig } = await import('./dashboard-collector.js');
  const config = await resolveHookConfig(hookData, toolArg ?? 'claude');
  if (!config) return;
  // The same root resolution import and the local agent use, from the hook's
  // directory: a project set up before a user-scope relocation has no record
  // of its own and follows user scope.
  // The scope's own record first: a removed worktree's cwd leads nowhere (#810).
  const toolRoots = config.toolRoots ?? await resolveMemberToolRoots(hookCwd);

  for (const match of matches) {
    const skillName = match[1];

    if (!isValidSkillName(skillName)) {
      log.debug(`Invalid slash skill name rejected: ${skillName.slice(0, 50)}`);
      continue;
    }

    // Verify the skill actually exists on disk to avoid tracking phantom skills
    // (e.g. user typing "/data" which is not a real skill)
    if (!await skillExistsOnDisk(skillName, toolRoots)) {
      log.debug(`Slash command "/${skillName}" is not a known skill — skipping tracking`);
      continue;
    }

    const event: UsageEvent = {
      skill: skillName,
      timestamp: new Date().toISOString(),
      tool: toolArg ?? 'claude',
    };

    await appendUsageEvent(event, config);
    await updateKnownSkills(skillName);
  }
}
