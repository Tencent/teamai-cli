/**
 * Skill use (#1221): which skill a hook event shows the agent loaded, credited
 * to the calling tool once per session turn.
 *
 *   post-tool-use  the tool's skill tool (TOOLS[tool].skillLoad.calls) by name,
 *                  or a read of a SKILL.md under a skill root (classifyToolCall),
 *                  or OMP's `read skill://<name>`
 *   prompt-submit  a mention: `/name` at the start, Codex `$name`, or the
 *                  `<skill>` block Pi expands `/skill:name` into
 *
 * Each candidate must be an installed skill, then claims its (session, turn)
 * slot in `~/.teamai/sessions/<sid>-skills.json`; only a first claim is
 * recorded.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { sanitizeSessionId } from './contribute-check.js';
import { resolveMemberToolRoots } from './config.js';
import { isToolId, TOOLS, type SkillLoad } from './tools.js';
import { SKILL_NAME_CHARS, type LocalConfig } from './types.js';
import { withFileLock } from './update.js';
import {
  appendUsageEvent,
  extractSkillName,
  isInstalledSkillFile,
  isValidSkillName,
  skillExistsOnDisk,
  skillRoots,
  updateKnownSkills,
} from './usage-tracker.js';
import { readJson, writeJson } from './utils/fs.js';
import { getUserHome } from './utils/home.js';
import { resolveHookCwd } from './utils/hook-cwd.js';
import { log } from './utils/logger.js';
import { deriveSessionId } from './utils/session-id.js';
import { classifyToolCall } from './utils/tool-call.js';
import { normalizeToolName } from './utils/tool-names.js';

type Candidate = { readonly skill: string; readonly file?: string };

/** The built-in that carried skill tracking before #1221: a team that disables it keeps tool calls uncounted. */
const RETIRED_SKILL_HOOK_KEY = 'Hook dispatch post-tool-use Skill';

/**
 * The OpenCode plugin before #1221 renamed `skill` to `Skill`, and a running
 * OpenCode keeps the loaded plugin until it restarts. Drop after one release.
 */
const LEGACY_PLUGIN_SKILL_CALL: Readonly<Record<string, string>> = { opencode: 'Skill' };

const NAME = `${SKILL_NAME_CHARS}+`;
const SKILL_MD = /[\\/]([^\\/]+)[\\/]SKILL\.md$/i;
const SKILL_URI = /^skill:\/\/([^/]+)\/?$/;
/** The block Pi's `_expandSkillCommand` puts first in the prompt: `<skill name="X" location="FILE">`. */
const PI_SKILL_BLOCK = new RegExp(`^<skill name="(${NAME})" location="([^"\n]+)">`);

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? { ...value } : null;
}

function skillLoadOf(tool: string): SkillLoad | undefined {
  return isToolId(tool) ? TOOLS[tool].skillLoad : undefined;
}

function isSkillCall(tool: string, hostName: string): boolean {
  const load = skillLoadOf(tool);
  if (load === undefined) return normalizeToolName(hostName) === 'Skill';
  if (load === 'unknown') return false;
  return load.calls.some((call) => call.name === hostName) || LEGACY_PLUGIN_SKILL_CALL[tool] === hostName;
}

/** The skills one PostToolUse payload shows loaded, before the existence gate. */
function toolCallCandidates(stdin: Record<string, unknown>, tool: string): Candidate[] {
  const hostName = typeof stdin.tool_name === 'string' ? stdin.tool_name : '';
  const input = asObject(stdin.tool_input);
  if (!hostName || !input) return [];
  if (isSkillCall(tool, hostName)) {
    const skill = extractSkillName(input);
    return skill ? [{ skill }] : [];
  }
  const load = skillLoadOf(tool);
  if (load === undefined || load === 'unknown') return [];
  const call = classifyToolCall(stdin, tool);
  if (call.category !== 'read' || call.status === 'failure') return [];
  const uri = typeof input.path === 'string' ? SKILL_URI.exec(input.path.trim()) : null;
  if (uri) return [{ skill: uri[1] }];
  return call.paths.flatMap((file) => {
    const match = SKILL_MD.exec(file);
    return match ? [{ skill: match[1], file }] : [];
  });
}

function promptFormOf(tool: string): '$name' | 'skill-block' | '/name' {
  const load = skillLoadOf(tool);
  return load === undefined || load === 'unknown' ? '/name' : load.promptForm ?? '/name';
}

/** The skills a prompt mentions, before the existence gate. */
function promptCandidates(prompt: string, tool: string): Candidate[] {
  const form = promptFormOf(tool);
  let pattern: RegExp;
  switch (form) {
    case '$name':
      // Codex resolves a `$name` anywhere in the prompt.
      pattern = new RegExp(`(?:^|\\s)\\$(${NAME})`, 'g');
      break;
    case 'skill-block': {
      const block = PI_SKILL_BLOCK.exec(prompt);
      return block ? [{ skill: block[1], file: block[2] }] : [];
    }
    case '/name':
      // A whole token at the start, so a prompt beginning with an absolute path is not a skill use.
      pattern = new RegExp(`^/(${NAME})(?=\\s|$)`, 'g');
      break;
    default: {
      const unhandled: never = form;
      return unhandled;
    }
  }
  return [...prompt.matchAll(pattern)].map((match) => ({ skill: match[1] }));
}

/** The candidates that name an installed skill, each once. */
async function installedSkills(candidates: Candidate[], stdin: Record<string, unknown>, tool: string, config: LocalConfig, source: 'prompt' | 'tool-call'): Promise<string[]> {
  const named = candidates.filter((c) => isValidSkillName(c.skill));
  if (!named.length) return [];
  const hookCwd = resolveHookCwd(stdin);
  // The same root resolution import and the local agent use: the scope's own
  // record first, since a removed worktree's cwd leads nowhere (#810).
  const toolRoots = config.toolRoots ?? await resolveMemberToolRoots(hookCwd);
  const roots = await skillRoots({ config, toolRoots, hookCwd, tool });
  const readRoots = source === 'tool-call' && named.some((c) => c.file !== undefined)
    ? await skillRoots({ config, toolRoots, hookCwd }) : roots;
  const skills = new Set<string>();
  for (const { skill, file } of named) {
    if (skills.has(skill)) continue;
    const installed = file !== undefined
      ? await isInstalledSkillFile(skill, file, readRoots)
      : await skillExistsOnDisk(skill, roots);
    if (installed) skills.add(skill);
    else log.debug(`"${skill}" is not an installed skill, so its use is not tracked`);
  }
  return [...skills];
}

// ─── Once per session turn ──────────────────────────────

/**
 * The host's own turn id, read the same way on both events: Codex and Muse
 * send `turn_id`, Claude Code `prompt_id`, Cursor and CodeBuddy `generation_id`.
 */
function hostTurnKey(stdin: Record<string, unknown>): string | undefined {
  for (const field of ['turn_id', 'prompt_id', 'generation_id']) {
    const value = stdin[field];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

/**
 * The session a claim belongs to, or undefined when the host sent none: a
 * `pid-` id is deriveSessionId's fallback, which differs between hook runs.
 */
function claimSessionId(stdin: Record<string, unknown>): string | undefined {
  const sessionId = deriveSessionId(stdin);
  return sessionId.startsWith('pid-') ? undefined : sessionId;
}

/** Turns a claims file keeps; a detached hook of an earlier turn can still arrive late. */
const KEPT_TURNS = 16;

const SkillClaimsSchema = z.object({
  /** The turn the last prompt-submit opened, for hosts that send no turn id. */
  stamp: z.string().optional(),
  /** Skills credited per turn key, oldest turn first. */
  turns: z.record(z.string(), z.array(z.string())),
  webhooks: z.record(z.string(), z.array(z.string())).default({}),
});
type SkillClaims = z.infer<typeof SkillClaimsSchema>;

function claimsPath(sessionId: string): string {
  // Ends in `.json`, so cleanupStaleSessions sweeps it with the session's other files.
  return path.join(getUserHome(), '.teamai', 'sessions', `${sanitizeSessionId(sessionId)}-skills.json`);
}

/** A prompt-submit and the detached post-tool-use hooks of its turn can claim at once. */
const CLAIMS_LOCK_WAIT = { attempts: 20, delayMs: 50 };

async function claimTurnSlots(stdin: Record<string, unknown>, skills: string[], source: 'prompt' | 'tool-call'): Promise<{ usage: string[]; webhooks: string[] }> {
  const opensTurn = source === 'prompt';
  const unchecked = { usage: skills, webhooks: opensTurn ? [] : skills };
  const sessionId = claimSessionId(stdin);
  if (sessionId === undefined) return unchecked;
  const file = claimsPath(sessionId);
  const lockPath = `${file}.lock`;
  const claimed = await withFileLock(lockPath, CLAIMS_LOCK_WAIT, async () => {
    const parsed = SkillClaimsSchema.safeParse(await readJson<unknown>(file));
    const claims: SkillClaims = parsed.success ? parsed.data : { turns: {}, webhooks: {} };
    if (opensTurn && hostTurnKey(stdin) === undefined) claims.stamp = randomUUID();
    const turn = hostTurnKey(stdin) ?? claims.stamp;
    if (turn === undefined) return unchecked;
    const credited = claims.turns[turn] ?? [];
    const won = skills.filter((skill) => !credited.includes(skill));
    const notified = claims.webhooks[turn] ?? [];
    const webhooks = opensTurn ? [] : skills.filter((skill) => !notified.includes(skill));
    if (won.length || webhooks.length || opensTurn) {
      delete claims.turns[turn];
      claims.turns[turn] = [...credited, ...won];
      if (webhooks.length) {
        delete claims.webhooks[turn];
        claims.webhooks[turn] = [...notified, ...webhooks];
      }
      for (const slots of [claims.turns, claims.webhooks]) {
        for (const old of Object.keys(slots).slice(0, -KEPT_TURNS)) delete slots[old];
      }
      await writeJson(file, claims);
    }
    return { usage: won, webhooks };
  });
  if (claimed.held) return claimed.value;
  log.debug(`${lockPath} is still held, so ${skills.join(', ') || 'this turn'} is recorded without the once-per-turn check`);
  return unchecked;
}

async function record(skills: string[], tool: string, config: LocalConfig): Promise<void> {
  for (const skill of skills) {
    await appendUsageEvent({ skill, timestamp: new Date().toISOString(), tool }, config);
    await updateKnownSkills(skill);
  }
}

async function toolCallTrackingDisabled(config: LocalConfig): Promise<boolean> {
  const { readBuiltinDisabledListing } = await import('./resources/hooks.js');
  const listing = await readBuiltinDisabledListing(config, RETIRED_SKILL_HOOK_KEY);
  if (listing === 'unreadable') {
    log.debug('hooks/hooks.yaml cannot be read, so skill use from tool calls is not tracked');
  }
  return listing !== 'not-listed';
}

/** Record tool-call usage and separately claim the skills to notify in the background. */
export async function creditToolCall(stdin: Record<string, unknown>, tool: string, config: LocalConfig): Promise<string[]> {
  const candidates = toolCallCandidates(stdin, tool);
  if (!candidates.length || await toolCallTrackingDisabled(config)) return [];
  const claims = await claimTurnSlots(stdin, await installedSkills(candidates, stdin, tool, config, 'tool-call'), 'tool-call');
  await record(claims.usage, tool, config);
  return claims.webhooks;
}

/**
 * Open the session turn and record the skills a UserPromptSubmit prompt
 * mentions. A host that sends its own turn id needs no stamp, so a prompt
 * that names no installed skill there touches no file.
 */
export async function creditPromptMentions(stdin: Record<string, unknown>, tool: string, config: LocalConfig): Promise<void> {
  const prompt = typeof stdin.prompt === 'string' ? stdin.prompt : '';
  const skills = await installedSkills(promptCandidates(prompt, tool), stdin, tool, config, 'prompt');
  if (!skills.length && hostTurnKey(stdin) !== undefined) return;
  const claims = await claimTurnSlots(stdin, skills, 'prompt');
  await record(claims.usage, tool, config);
}
