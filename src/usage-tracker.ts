import fs from 'node:fs';
import path from 'node:path';
import { log } from './utils/logger.js';
import { normalizeToolName } from './utils/tool-names.js';
import {
  getCopilotHome,
  getDataHome,
  SKILL_NAME_REGEX,
  type LocalConfig,
  type UsageEvent,
} from './types.js';
import { ensureDir, readJson, writeJson, pathExists } from './utils/fs.js';
import { getUserHome } from './utils/home.js';
import { resolveHookCwd } from './utils/hook-cwd.js';
import { resolveConfigForDir } from './config.js';

/**
 * The usage JSONL of one scope: `<dataHome>/usage.jsonl`, so each scope reports
 * only the skills used where it is set up (#748). Evaluated at call time to
 * respect HOME changes in tests.
 */
function getUsagePath(config: LocalConfig): string {
  return path.join(getDataHome(config), 'usage.jsonl');
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
//               [resolveConfigForDir(cwd)] ─null─▶ skip (#748)
//                       │
//                       ▼
//               appendFile(<dataHome>/usage.jsonl, JSON line)
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
//  appendFile(<dataHome>/usage.jsonl) + updateKnownSkills()
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
export async function skillExistsOnDisk(skillName: string): Promise<boolean> {
  const home = getUserHome();
  const userSkillDirs = [
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
 * Append a usage event to the local JSONL file.
 * Silently fails on I/O errors (disk full, permission denied, etc.)
 * to avoid disrupting the AI coding session.
 */
export async function appendUsageEvent(event: UsageEvent, config: LocalConfig): Promise<void> {
  try {
    const usagePath = getUsagePath(config);
    await ensureDir(path.dirname(usagePath));
    const line = JSON.stringify(event) + '\n';
    await fs.promises.appendFile(usagePath, line, 'utf-8');
    log.debug(`Tracked skill: ${event.skill}`);
  } catch (e) {
    log.error(`Failed to write usage event: ${(e as Error).message}`);
  }
}

/**
 * Drop the user-scope usage file when a machine first gets a user scope. What
 * it holds was recorded while every scope shared that file, so nothing says
 * which project each event came from; the new user scope must not report it
 * to its team (#748).
 */
export async function discardUnattributedUsage(userConfig: LocalConfig): Promise<void> {
  const usagePath = getUsagePath(userConfig);
  if (!(await pathExists(usagePath))) return;
  await fs.promises.rm(usagePath, { force: true });
  log.debug(`Discarded ${usagePath}: its events predate this user scope and name no project (#748)`);
}

/**
 * Read all usage events from a scope's JSONL file.
 * Skips corrupted lines gracefully.
 */
export async function readUsageEvents(config: LocalConfig): Promise<UsageEvent[]> {
  try {
    const content = await fs.promises.readFile(getUsagePath(config), 'utf-8');
    const events: UsageEvent[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as UsageEvent;
        if (parsed.skill && parsed.timestamp) {
          events.push(parsed);
        }
      } catch {
        log.debug(`Skipping corrupted JSONL line: ${trimmed.slice(0, 50)}`);
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
    const usagePath = getUsagePath(config);
    const content = await fs.promises.readFile(usagePath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim());
    if (reportedCount >= lines.length) {
      // All lines were reported — clear file
      await fs.promises.writeFile(usagePath, '', 'utf-8');
    } else {
      // Keep unreported lines
      const remaining = lines.slice(reportedCount).join('\n') + '\n';
      await fs.promises.writeFile(usagePath, remaining, 'utf-8');
    }
    log.debug(`Truncated usage.jsonl: removed ${reportedCount} reported events`);
  } catch (e) {
    log.error(`Failed to truncate usage.jsonl: ${(e as Error).message}`);
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

  const config = await resolveConfigForDir(resolveHookCwd(hookData));
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
  const matches = [...prompt.matchAll(/\/([a-zA-Z0-9_\-:.]+)/g)];
  if (matches.length === 0) {
    log.debug('Could not extract skill name from slash command');
    return;
  }

  const config = await resolveConfigForDir(resolveHookCwd(hookData));
  if (!config) return;

  for (const match of matches) {
    const skillName = match[1];

    if (!isValidSkillName(skillName)) {
      log.debug(`Invalid slash skill name rejected: ${skillName.slice(0, 50)}`);
      continue;
    }

    // Verify the skill actually exists on disk to avoid tracking phantom skills
    // (e.g. user typing "/data" which is not a real skill)
    if (!await skillExistsOnDisk(skillName)) {
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
