/**
 * Skill use (#1221): which skill a hook event shows the agent loaded, credited
 * to the calling tool once per session turn.
 *
 *   post-tool-use  the tool's skill tool (descriptorOf(tool).skillLoad.calls) by name,
 *                  or a read of a SKILL.md under a skill root (classifyToolCall),
 *                  also by any reader a longer shell command names (namedReads)
 *                  when the output shows that skill (showsSkill),
 *                  or OMP's `read skill://<name>`
 *   prompt-submit  a mention: `/name` at the start, Codex `$name`, the
 *                  `<skill>` block Pi expands `/skill:name` into, or the
 *                  `@command://name` the CodeBuddy plugin sends (#1516)
 *
 * Each candidate must be an installed skill, then claims its (session, turn)
 * slot in `~/.teamai/sessions/<sid>-skills.json`; only a first claim is
 * recorded.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { sanitizeSessionId } from './contribute-check.js';
import { resolveMemberToolRoots } from './config.js';
import { isRecordedFromTeamSkill, recordedUnchanged, type DeliveredHashes } from './resources/delivered-copies.js';
import type { SubagentsRead } from '@teamai/tool-core/sessions/base';
import type { ContentBlock, Message, Session } from '@teamai/tool-core/sessions/ir';
import { typedText } from '@teamai/tool-core/sessions/title';
import { type PromptForm, type SkillLoad } from '@teamai/tool-core/definition';
import { baseDescriptorOf } from './tool-registry.js';
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
import { resolvePath } from './utils/agent-path.js';
import { GitAnswers } from './utils/git-answers.js';
import { repositoryStamp } from './utils/git-discovery.js';
import { listFilesAtRev } from './utils/git.js';
import { pathExists, readFileSafe, readJson, writeJson } from './utils/fs.js';
import { splitFrontmatter } from './utils/frontmatter.js';
import { getUserHome } from './utils/home.js';
import { resolveHookCwd } from './utils/hook-cwd.js';
import { log } from './utils/logger.js';
import { deriveSessionId } from './utils/session-id.js';
import { namedReads } from './utils/shell-command.js';
import { classifyToolCall } from './utils/tool-call.js';
import { normalizeToolName } from './utils/tool-names.js';

/** A skill a hook event or a recorded session shows loaded, by name, and the SKILL.md it read when it read one. */
export type SkillCandidate = { readonly skill: string; readonly file?: string };

/** The built-in that carried skill tracking before #1221: a team that disables it keeps tool calls uncounted. */
const RETIRED_SKILL_HOOK_KEY = 'Hook dispatch post-tool-use Skill';

/**
 * The OpenCode plugin before #1221 renamed `skill` to `Skill`, and a running
 * OpenCode keeps the loaded plugin until it restarts. Drop after one release.
 */
const LEGACY_PLUGIN_SKILL_CALL = new Map([['opencode', 'Skill']]);

const NAME = `${SKILL_NAME_CHARS}+`;
const SKILL_MD = /[\\/]([^\\/]+)[\\/]SKILL\.md$/i;
const SKILL_URI = /^skill:\/\/([^/]+)\/?$/;

/** The block Pi's `_expandSkillCommand` puts first in the prompt: `<skill name="X" location="FILE">`. */
const PI_SKILL_BLOCK = new RegExp(`^<skill name="(${NAME})" location="([^"\n]+)">`);

/** A hook event as the host sends it on stdin, typed as the hook-input helpers that read it take it. */
type HookEvent = Parameters<typeof classifyToolCall>[0];

/** A string field of an event, absent when it holds anything else. */
const TextFieldSchema = z.string().optional().catch(undefined);

/** The PostToolUse fields skill use reads itself: a name that is not a string reads as '', an input that is not an object as null. */
const ToolEventSchema = z.object({
  tool_name: z.string().catch(''),
  tool_input: z.record(z.string(), z.unknown()).nullable().catch(null),
});

/** A read call's `path`, the form OMP's `read skill://<name>` takes. */
const ReadPathSchema = z.object({ path: z.string() });

function skillLoadOf(tool: string): SkillLoad | undefined {
  return baseDescriptorOf(tool)?.skillLoad;
}

function isSkillCall(tool: string, hostName: string): boolean {
  const load = skillLoadOf(tool);

  if (load === undefined) return normalizeToolName(hostName) === 'Skill';

  if (load === 'unknown') return false;

  return load.calls.some((call) => call.name === hostName) || LEGACY_PLUGIN_SKILL_CALL.get(tool) === hostName;
}

/**
 * The skills one PostToolUse payload shows: `loaded`, the ones it surely loaded, and `named`, the SKILL.md reads a
 * longer shell command names that may not have run (`false && cat …/SKILL.md; true`), with the call's `output`.
 */
type ToolCallSkills = { readonly loaded: SkillCandidate[]; readonly named: SkillCandidate[]; readonly output?: string };

const NO_SKILLS: ToolCallSkills = { loaded: [], named: [] };

function toolCallSkills(stdin: HookEvent, tool: string): ToolCallSkills {
  const { tool_name: hostName, tool_input: input } = ToolEventSchema.parse(stdin);

  if (!hostName || !input) return NO_SKILLS;

  if (isSkillCall(tool, hostName)) {
    const skill = extractSkillName(input);

    return { loaded: skill ? [{ skill }] : [], named: [] };
  }

  const load = skillLoadOf(tool);

  if (load === undefined || load === 'unknown') return NO_SKILLS;
  const call = classifyToolCall(stdin, tool);

  if (call.status === 'failure') return NO_SKILLS;
  const read = call.category === 'read' ? ReadPathSchema.safeParse(input) : undefined;
  const uri = read?.success ? SKILL_URI.exec(read.data.path.trim()) : null;

  if (uri) return { loaded: [{ skill: uri[1] }], named: [] };

  if (call.category === 'read') return { loaded: skillReads(call.paths), named: [] };

  if (call.command === undefined) return NO_SKILLS;
  const cwd = resolveHookCwd(stdin);
  const named = namedReads(call.command, { powershell: normalizeToolName(hostName).toLowerCase() === 'powershell', home: getUserHome() });

  return { loaded: [], named: skillReads(named.map((file) => resolvePath(file, cwd))), output: call.output };
}

/** The skills one PostToolUse payload shows loaded, before the existence gate: a named read counts when its output shows it. */
function toolCallCandidates(stdin: HookEvent, tool: string): SkillCandidate[] {
  const { loaded, named, output } = toolCallSkills(stdin, tool);

  return [...loaded, ...named.filter((candidate) => showsSkill(output, candidate.skill))];
}

/** The skills whose SKILL.md is among `files`. */
function skillReads(files: readonly string[]): SkillCandidate[] {
  return files.flatMap((file) => {
    const match = SKILL_MD.exec(file);

    return match ? [{ skill: match[1], file }] : [];
  });
}

/**
 * A SKILL.md frontmatter `name:` line, a whole line however the output prints lines: `cat -n` numbers them, and a Codex
 * code-mode script that prints a command's result as JSON escapes its newlines and tabs as `\n` and `\t`.
 */
const NAME_LINE = new RegExp(`(?:^|\\\\n)(?:[ \\t]*\\d+(?:\\t|\\\\t))?name:(?:[ \\t]|\\\\t)*(?:\\\\?["'])?(${SKILL_NAME_CHARS}+)(?:\\\\?["'])?(?:[ \\t]|\\\\t)*(?:$|\\r|\\\\[rn])`, 'gm');

/** Whether a call's output shows the SKILL.md of `skill`, by its `name:` line. */
function showsSkill(output: string | undefined, skill: string): boolean {
  return output !== undefined && [...output.matchAll(NAME_LINE)].some((match) => match[1] === skill);
}

function promptFormsOf(tool: string): readonly PromptForm[] {
  const load = skillLoadOf(tool);

  if (load === undefined || load === 'unknown') return ['/name'];
  const form = load.promptForm ?? '/name';

  return [form].flat();
}

/** The skills a prompt mentions, before the existence gate. */
function promptCandidates(prompt: string, tool: string): SkillCandidate[] {
  const candidates: SkillCandidate[] = [];

  for (const form of promptFormsOf(tool)) {
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

      case 'command-uri':
        // The CodeBuddy plugin lands a manual slash command as `@command://name`
        // (#1516). Anchored at the start, so a command URI quoted in the
        // conversation is not a skill use.
        pattern = new RegExp(`^@command://(${NAME})(?=\\s|$)`, 'g');
        break;
      case '/name':
        // A whole token at the start, so a prompt beginning with an absolute path is not a skill use.
        pattern = new RegExp(`^/(${NAME})(?=\\s|$)`, 'g');
        break;
      default: {
        const unhandled: never = form;

        return unhandled;
      }
    }

    candidates.push(...[...prompt.matchAll(pattern)].map((match) => ({ skill: match[1] })));
  }

  return candidates;
}

/** What the member typed in a block of a session message, or '' when the block holds none. */
export function typedIn(message: Message, block: ContentBlock): string {
  return block.type === 'text' && message.role === 'user' && !message.metadata?.isMeta ? typedText(block.text) : '';
}

/** A string literal in a Codex code-mode script. */
const STRING_LITERAL = '"(?:[^"\\\\\\n]|\\\\.)*"';

/** The object literal a Codex code-mode script passes to `tools.exec_command`, with objects nested one level. */
const CODE_MODE_CALL = new RegExp(`\\btools\\.exec_command\\(\\s*\\{((?:[^{}"]|${STRING_LITERAL}|\\{(?:[^{}"]|${STRING_LITERAL})*\\})*)\\}`, 'g');

/** A property of that object whose value is a string literal. */
const STRING_PROPERTY = new RegExp(`(\\w+)\\s*:\\s*(${STRING_LITERAL})`, 'g');

/** The string a script literal stands for, or undefined when it is not one. */
function stringOf(literal: string | undefined): string | undefined {
  if (literal === undefined) return undefined;

  try {
    return TextFieldSchema.parse(JSON.parse(literal));
  } catch {
    return undefined;
  }
}

/** The commands a Codex code-mode script passes as string literals, each as its hook sends it, as `Bash`. */
function codeModeEvents(script: string, cwd: string): HookEvent[] {
  return [...script.matchAll(CODE_MODE_CALL)].flatMap((call) => {
    const properties = new Map([...call[1].matchAll(STRING_PROPERTY)].map((property) => [property[1], property[2]]));
    const command = stringOf(properties.get('cmd'));

    return command === undefined ? [] : [{ tool_name: 'Bash', tool_input: { command }, cwd: inWorkdir(cwd, stringOf(properties.get('workdir'))) }];
  });
}

/** Where a Codex command runs: its `workdir`, relative to the session's cwd, or that cwd. */
function inWorkdir(cwd: string, workdir: string | undefined): string {
  return workdir?.trim() ? path.resolve(cwd, workdir) : cwd;
}

/**
 * The skills a block of a session message shows loaded, by the rules the skill-use hooks apply to the events it stands
 * for: a tool call as PostToolUse sends it with its `output`, or a prompt the member typed as UserPromptSubmit sends it.
 * Codex records a command as `cmd`, and its hook sends `command`; the command runs in its `workdir`. A Codex code-mode
 * `exec` is recorded as one script, and its hook sends each command the script runs. The script holds commands it may
 * never have run (`if (false) { … }`), and its output is all of theirs, so a skill one of them reads counts when that
 * output shows it, and no command's diagnostics are judged from another's.
 */
function blockCandidates(message: Message, block: ContentBlock, cwd: string, output: string | undefined, tool: string): SkillCandidate[] {
  if (block.type === 'tool_call') {
    const input = block.arguments;
    const script = TextFieldSchema.parse(input.input);

    if (block.toolName === 'exec' && script !== undefined) {
      return codeModeEvents(script, cwd).flatMap((event) => {
        const { loaded, named } = toolCallSkills(event, tool);

        return [...loaded, ...named];
      }).filter((candidate) => showsSkill(output, candidate.skill));
    }

    const cmd = TextFieldSchema.parse(input.cmd);
    const toolInput = cmd !== undefined && input.command === undefined ? { ...input, command: cmd } : input;
    const event: HookEvent = { tool_name: block.toolName, tool_input: toolInput, cwd: inWorkdir(cwd, TextFieldSchema.parse(input.workdir)) };

    if (output !== undefined) event.tool_response = output;

    return skillCandidates(event, tool);
  }

  const prompt = typedIn(message, block);

  return prompt ? skillCandidates({ prompt, cwd }, tool) : [];
}

/** The candidates that name an installed skill, each once. */
async function installedSkills(candidates: SkillCandidate[], stdin: HookEvent, tool: string, config: LocalConfig, source: 'prompt' | 'tool-call'): Promise<string[]> {
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

/**
 * The skills one hook event shows loaded, before any check that they exist: a tool call as PostToolUse sends it, or a
 * prompt as UserPromptSubmit sends it.
 */
export function skillCandidates(event: HookEvent, tool: string): SkillCandidate[] {
  const prompt = TextFieldSchema.parse(event.prompt);

  return prompt !== undefined ? promptCandidates(prompt, tool) : toolCallCandidates(event, tool);
}

/**
 * What a session records of a delivered team skill (#1469): the skills namespace the team repo kept it under (none for a
 * root skill, `namespaceUnknown` when the delivery record cannot tell which of several), and the description its
 * frontmatter then carried (none when there is no frontmatter description that parses).
 */
export const DeliveredSkillInfoSchema = z.object({
  namespace: z.string().optional(),
  namespaceUnknown: z.literal(true).optional(),
  description: z.string().optional(),
});

export type DeliveredSkillInfo = z.infer<typeof DeliveredSkillInfoSchema>;

/**
 * The team skills a checkout holds as teamai delivered them, by name: each SKILL.md under a skill root seen from `cwd`
 * whose bytes are the ones `delivered` records, of a skill the team repo had at the delivered revision `rev`, so one
 * the team deleted since still counts. `teamSkills` holds each name's files, `teamSkillInfo` what a session records of
 * it. A name that also has a copy teamai did not deliver, or one changed since, is left out, since which copy a tool
 * loads is not known.
 */
export async function deliveredTeamSkills(config: LocalConfig, cwd: string, delivered: DeliveredHashes, rev: string): Promise<{
  teamSkills: Record<string, string[]>;
  teamSkillInfo: Record<string, DeliveredSkillInfo>;
}> {
  const repo = config.repo.localPath;
  const sources = await teamSkillDirsAt(repo, rev);
  const toolRoots = config.toolRoots ?? await resolveMemberToolRoots(cwd);
  const copies = new Map<string, string[]>();
  const others = new Set<string>();

  for (const root of await skillRoots({ config, toolRoots, hookCwd: cwd })) {
    for (const name of await fs.readdir(root).catch(() => [])) {
      const file = path.join(root, name, 'SKILL.md');

      if (!sources.has(name) || !await pathExists(file)) continue;

      if (await recordedUnchanged(delivered, file)) copies.set(name, [...copies.get(name) ?? [], file]);
      else others.add(name);
    }
  }

  const kept = [...copies].filter(([name]) => !others.has(name));

  const teamSkillInfo = await Promise.all(kept.map(async ([name, [file]]): Promise<[string, DeliveredSkillInfo]> => {
    const { data, valid } = splitFrontmatter(await readFileSafe(file) ?? '');

    const info = await deliveredNamespace({ repo, rev, delivered, dest: path.dirname(file), dirs: sources.get(name) ?? [] });
    const description = valid ? TextFieldSchema.parse(data.description) : undefined;

    if (description !== undefined) info.description = description.trim();

    return [name, info];
  }));

  return { teamSkills: Object.fromEntries(kept), teamSkillInfo: Object.fromEntries(teamSkillInfo) };
}

/** The team skill directories a delivered revision lists, by name. A delivered revision names one tree, so the answer stays. */
const skillDirsAtRev = GitAnswers.of('teamSkillDirs', z.record(z.string(), z.array(z.string())));

/** {@link teamSkillDirs} at `rev` in the team clone, from one listing. A revision git cannot read lists nothing, so the clone's own `HEAD` is listed instead. */
async function teamSkillDirsAt(repo: string, rev: string): Promise<Map<string, string[]>> {
  const [real, stamp] = await Promise.all([fs.realpath(repo).catch(() => null), repositoryStamp(repo)]);

  const read = async (): Promise<Record<string, string[]> | null> => {
    const listed = await listFilesAtRev(repo, rev, 'skills');

    return listed.length > 0 ? Object.fromEntries(teamSkillDirs(listed)) : null;
  };

  const atRev = real && stamp ? await skillDirsAtRev.answer(JSON.stringify([real, rev]), stamp.stamp, read) : await read();

  return atRev ? new Map(Object.entries(atRev)) : teamSkillDirs(await listFilesAtRev(repo, 'HEAD', 'skills'));
}

/**
 * Each team skill name's directories in a listing of the team repo's `skills/`: `skills/<name>` for a root skill and
 * `skills/<namespace>/<name>` otherwise, as `collectTeamRepoSkills` reads the tree.
 */
function teamSkillDirs(files: readonly string[]): Map<string, string[]> {
  const dirs = new Set(files.flatMap((file) => (path.posix.basename(file) === 'SKILL.md' ? [path.posix.dirname(file)] : [])));
  const byName = new Map<string, string[]>();

  for (const dir of dirs) {
    const depth = dir.split('/').length;

    if (depth !== 2 && (depth !== 3 || dirs.has(path.posix.dirname(dir)))) continue;
    const name = path.posix.basename(dir);
    byName.set(name, [...byName.get(name) ?? [], dir]);
  }

  return byName;
}

/**
 * The skills namespace the copy at `dest` came from, of the team directories `dirs` holding its name at `rev`. A name
 * in one directory needs no read. For several, the one whose history up to `rev` renders to the recorded bytes, as
 * pull tells them apart; identical copies cannot be told apart, so their namespace is unknown.
 */
async function deliveredNamespace({ repo, rev, delivered, dest, dirs }: {
  repo: string; rev: string; delivered: DeliveredHashes; dest: string; dirs: readonly string[];
}): Promise<DeliveredSkillInfo> {
  const matched = dirs.length === 1 ? dirs : (await Promise.all(dirs.map(async (dir) =>
    await isRecordedFromTeamSkill(delivered, dest, repo, dir, { rev }) ? [dir] : []))).flat();

  if (matched.length !== 1) return { namespaceUnknown: true };
  const parent = path.posix.dirname(matched[0]);

  return parent === 'skills' ? {} : { namespace: path.posix.basename(parent) };
}

/**
 * The skills of `candidates` that a session's record of the team skills its checkout delivered holds: by name, and for
 * a read, only one of the recorded files. Today's files and team repo play no part, so a later pull changes nothing.
 */
export function recordedTeamSkills(candidates: readonly SkillCandidate[], teamSkills: Readonly<Record<string, readonly string[]>>, cwd: string): string[] {
  const credited = new Set<string>();

  for (const { skill, file } of candidates) {
    const files = Object.hasOwn(teamSkills, skill) ? teamSkills[skill] : undefined;

    if (files && (file === undefined || files.some((recorded) => path.resolve(recorded) === path.resolve(cwd, file)))) credited.add(skill);
  }

  return [...credited];
}

/**
 * The team skills a session or its subagents loaded, found in their messages by the rules the skill-use hooks apply to
 * their events, and credited only by `teamSkillsAt` the message's time, the record of what its checkout delivered then
 * (`deliveredTeamSkills`).
 */
export function usedSkills(
  tool: string,
  found: { session: Session; subagents?: SubagentsRead },
  teamSkillsAt: (timestamp: string | undefined) => Readonly<Record<string, readonly string[]>>,
): string[] {
  const subagents = found.subagents?.status === 'read' ? found.subagents.agents.map((agent) => agent.session) : [];
  const used = new Set<string>();

  for (const session of [found.session, ...subagents]) {
    const results = new Map(session.messages.flatMap((message) => message.content.flatMap((block) => block.type === 'tool_result' ? [[block.callId, block] as const] : [])));
    const cwd = session.cwd || found.session.cwd;

    for (const message of session.messages) {
      for (const block of message.content) {
        const result = block.type === 'tool_call' ? results.get(block.callId) : undefined;

        if (result?.isError) continue;

        for (const skill of recordedTeamSkills(blockCandidates(message, block, cwd, result?.content, tool), teamSkillsAt(message.timestamp), cwd)) used.add(skill);
      }
    }
  }

  return [...used].sort();
}

// ─── Once per session turn ──────────────────────────────

/**
 * The host's own turn id, read the same way on both events: Codex and Muse
 * send `turn_id`, Claude Code `prompt_id`, Cursor and CodeBuddy `generation_id`.
 */
function hostTurnKey(stdin: HookEvent): string | undefined {
  for (const field of ['turn_id', 'prompt_id', 'generation_id']) {
    const turnId = TextFieldSchema.parse(stdin[field]);

    if (turnId) return turnId;
  }

  return undefined;
}

/**
 * The session a claim belongs to, or undefined when the host sent none: a
 * `pid-` id is deriveSessionId's fallback, which differs between hook runs.
 */
function claimSessionId(stdin: HookEvent): string | undefined {
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

async function claimTurnSlots(stdin: HookEvent, skills: string[], source: 'prompt' | 'tool-call'): Promise<{ usage: string[]; webhooks: string[] }> {
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
export async function creditToolCall(stdin: HookEvent, tool: string, config: LocalConfig): Promise<string[]> {
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
export async function creditPromptMentions(stdin: HookEvent, tool: string, config: LocalConfig): Promise<void> {
  const prompt = TextFieldSchema.parse(stdin.prompt) ?? '';
  const skills = await installedSkills(promptCandidates(prompt, tool), stdin, tool, config, 'prompt');

  if (!skills.length && hostTurnKey(stdin) !== undefined) return;
  const claims = await claimTurnSlots(stdin, skills, 'prompt');
  await record(claims.usage, tool, config);
}
