import fs from 'node:fs';
import path from 'node:path';
import { log } from './utils/logger.js';
import {
  SKILL_NAME_REGEX,
  type UsageEvent,
} from './types.js';
import { ensureDir, readJson, writeJson, pathExists } from './utils/fs.js';

/** Get the usage JSONL path (evaluated at call time to respect HOME changes in tests). */
function getUsagePath(): string {
  return path.join(process.env.HOME ?? '', '.teamai', 'usage.jsonl');
}

/** Get the known-skills.json path (evaluated at call time to respect HOME changes in tests). */
function getKnownSkillsPath(): string {
  return path.join(process.env.HOME ?? '', '.teamai', 'known-skills.json');
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
//               appendFile(usage.jsonl, JSON line)
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
//  appendFile(usage.jsonl) + updateKnownSkills()
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
];

/**
 * Check whether a skill actually exists on disk (has a SKILL.md in any tool's skills directory).
 * This prevents tracking phantom skills from typos or path inputs like "/data".
 *
 * Performance: Checks at most 12 directories (6 user + 6 project) with a single stat() each — sub-millisecond.
 */
export async function skillExistsOnDisk(skillName: string): Promise<boolean> {
  const home = process.env.HOME ?? '';
  // Check user-level directories
  for (const dir of SKILL_DIRS) {
    const skillMd = path.join(home, dir, skillName, 'SKILL.md');
    if (await pathExists(skillMd)) return true;
  }
  // Check project-level directories (cwd)
  const cwd = process.cwd();
  if (path.resolve(cwd) !== path.resolve(home)) {
    for (const dir of SKILL_DIRS) {
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
export async function appendUsageEvent(event: UsageEvent): Promise<void> {
  try {
    await ensureDir(path.dirname(getUsagePath()));
    const line = JSON.stringify(event) + '\n';
    await fs.promises.appendFile(getUsagePath(), line, 'utf-8');
    log.debug(`Tracked skill: ${event.skill}`);
  } catch (e) {
    log.error(`Failed to write usage event: ${(e as Error).message}`);
  }
}

/**
 * Read all usage events from the JSONL file.
 * Skips corrupted lines gracefully.
 */
export async function readUsageEvents(): Promise<UsageEvent[]> {
  try {
    const content = await fs.promises.readFile(getUsagePath(), 'utf-8');
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
export async function truncateUsageAfterReport(reportedCount: number): Promise<void> {
  try {
    const content = await fs.promises.readFile(getUsagePath(), 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim());
    if (reportedCount >= lines.length) {
      // All lines were reported — clear file
      await fs.promises.writeFile(getUsagePath(), '', 'utf-8');
    } else {
      // Keep unreported lines
      const remaining = lines.slice(reportedCount).join('\n') + '\n';
      await fs.promises.writeFile(getUsagePath(), remaining, 'utf-8');
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

  // Source 1: local usage.jsonl (unreported events since last truncation)
  const events = await readUsageEvents();
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
export async function track(toolName: string, toolInput: string, tool?: string): Promise<void> {
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

  const event: UsageEvent = {
    skill: skillName,
    timestamp: new Date().toISOString(),
    tool: tool ?? 'claude',
  };

  await appendUsageEvent(event);
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

  let hookData: { tool_name?: string; tool_input?: Record<string, unknown> };
  try {
    hookData = JSON.parse(raw);
  } catch {
    log.error('Failed to parse STDIN JSON');
    return;
  }

  const toolName = hookData.tool_name;
  if (typeof toolName !== 'string') return;

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

  const event: UsageEvent = {
    skill: skillName,
    timestamp: new Date().toISOString(),
    tool: toolSource,
  };

  await appendUsageEvent(event);
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

  let hookData: { prompt?: string };
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

    await appendUsageEvent(event);
    await updateKnownSkills(skillName);
  }
}