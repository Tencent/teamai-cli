/**
 * Team hooks for the tools whose hosts cannot run a Claude hook file
 * (OpenCode, OMP, Pi, Kiro, Hermes, OpenClaw).
 *
 * teamai keeps each such tool's team hooks in a Claude-shaped file of its own
 * (`~/.teamai/team-hooks/<tool>.json`), written by the same reconcile, records
 * and project gates as every settings file. The tool's bridge (teamai's
 * plugin, extension, or one native hook entry per event) runs
 * `teamai hook-dispatch <Event> --tool <tool> --team-hooks` with the host's
 * payload on stdin. This module runs the file's hooks for that event as Claude
 * Code would, then answers in the shape that host reads: a PreToolUse hook's
 * block, or the context a SessionStart or UserPromptSubmit hook adds.
 */

import path from 'node:path';
import { z } from 'zod';
import { runHookCommand, type HookRun } from './hook-command.js';
import { channelsOf, type HookAdapterId } from './tools.js';
import { areTeamHooksDisabled, getTeamaiHomeDir, TEAMAI_AGENT_HOOK_PREFIX } from './types.js';
import { readJsonObject } from './utils/fs.js';
import { log } from './utils/logger.js';

/** How a host reads a bridge's answer. */
type ReplyShape =
  /** teamai's own plugin or extension: `{"block": reason}` or `{"context": text}` on stdout. */
  | 'bridge'
  /** Kiro's hook contract: exit 2 with the reason on stderr blocks; stdout is context. */
  | 'kiro'
  /** Hermes's shell-hook contract: `{"decision":"block","reason"}` or `{"context": text}` on stdout. */
  | 'hermes';

interface Bridge {
  reply: ReplyShape;
  /** The host's tool names, as Claude names them, so a team's `matcher: Bash` selects the host's shell tool. */
  tools: Readonly<Record<string, string>>;
}

/** Which hook adapters run the team hooks through this bridge: DSH's host plugin runs its Claude file itself. */
const BRIDGES: Readonly<Record<HookAdapterId, Bridge | null>> = {
  'opencode-plugin': {
    reply: 'bridge',
    tools: {
      bash: 'Bash', shell: 'Bash', read: 'Read', edit: 'Edit', patch: 'Edit', write: 'Write', glob: 'Glob', grep: 'Grep',
      list: 'LS', webfetch: 'WebFetch', websearch: 'WebSearch', task: 'Task', subagent: 'Task', todowrite: 'TodoWrite',
    },
  },
  'omp-extension': {
    reply: 'bridge',
    tools: { bash: 'Bash', read: 'Read', edit: 'Edit', write: 'Write', grep: 'Grep', glob: 'Glob', find: 'Glob', task: 'Task' },
  },
  'pi-extension': {
    reply: 'bridge',
    tools: { bash: 'Bash', powershell: 'Bash', read: 'Read', edit: 'Edit', write: 'Write', grep: 'Grep', find: 'Glob', ls: 'LS' },
  },
  'openclaw-hook': {
    reply: 'bridge',
    tools: { exec: 'Bash', read: 'Read', write: 'Write', edit: 'Edit', apply_patch: 'Edit', ls: 'LS' },
  },
  'kiro-hooks': {
    reply: 'kiro',
    tools: {
      // CLI V3's tool IDs, then CLI 2.x's and the IDE's.
      shell: 'Bash', read: 'Read', write: 'Write', glob: 'Glob', grep: 'Grep',
      execute_bash: 'Bash', execute_cmd: 'Bash', execute_pwsh: 'Bash', fs_read: 'Read', read_file: 'Read', fs_write: 'Write', fs_append: 'Write',
      str_replace: 'Edit', grep_search: 'Grep',
    },
  },
  'hermes-plugin': {
    reply: 'hermes',
    tools: { terminal: 'Bash', read_file: 'Read', write_file: 'Write', patch: 'Edit', search_files: 'Grep' },
  },
  'dsh-hooks': null,
};

/** The Claude events a bridge runs team hooks on. A team hook on another event does not reach these tools. */
export const BRIDGED_TEAM_HOOK_EVENTS: ReadonlySet<string> = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']);

function bridgeOf(tool: string): Bridge | null {
  const channel = channelsOf(tool).hooks.user;
  return typeof channel === 'object' && channel.channel === 'adapter' ? BRIDGES[channel.adapter] : null;
}

/** Whether `tool`'s team hooks run through teamai's bridge. */
export function isBridgedTeamHookTool(tool: string): boolean {
  return bridgeOf(tool) !== null;
}

/** The directory of the bridged tools' team-hook files. */
export function bridgedTeamHookDir(): string {
  return path.join(getTeamaiHomeDir(), 'team-hooks');
}

/** The Claude-shaped file that holds `tool`'s team hooks for its bridge. */
export function bridgedTeamHookFile(tool: string): string {
  return path.join(bridgedTeamHookDir(), `${tool}.json`);
}

/** The part of a Claude hook file a bridge reads. */
const TeamHookFileSchema = z.object({
  hooks: z.record(z.string(), z.array(z.object({
    matcher: z.string().optional(),
    description: z.string().optional(),
    hooks: z.array(z.object({ command: z.string().optional(), timeout: z.number().positive().optional() })).default([]),
  }))).default({}),
});

type TeamHooks = z.infer<typeof TeamHookFileSchema>['hooks'];

/** The team hooks of `tool`'s file by event (none when it is missing), or why it is not a hook file. */
async function readTeamHooks(tool: string): Promise<{ kind: 'ok'; hooks: TeamHooks } | { kind: 'invalid'; error: string }> {
  const read = await readJsonObject(bridgedTeamHookFile(tool));
  if (read.kind === 'missing') return { kind: 'ok', hooks: {} };
  if (read.kind === 'invalid') return read;
  const parsed = TeamHookFileSchema.safeParse(read.value);
  return parsed.success
    ? { kind: 'ok', hooks: parsed.data.hooks }
    : { kind: 'invalid', error: parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ') };
}

/** What teamai says about a team-hook file that is not a hook file. */
function invalidFileMessage(tool: string, error: string): string {
  return `teamai: ${bridgedTeamHookFile(tool)} is not a hook file (${error}), so no team hook runs. Delete it, then run teamai pull to write it again.`;
}

/**
 * The events `tool`'s file has team hooks on, each with the longest of their
 * timeouts (60 s when one has none): a host that takes one native entry per
 * event (Kiro, Hermes) gets one for each, bounded by it.
 */
export async function bridgedTeamHookEvents(tool: string): Promise<Map<string, number>> {
  const read = await readTeamHooks(tool);
  const events = new Map<string, number>();
  if (read.kind === 'invalid') {
    log.warn(invalidFileMessage(tool, read.error));
    return events;
  }
  for (const [event, entries] of Object.entries(read.hooks)) {
    const timeouts = entries.flatMap((entry) => entry.hooks.map((hook) => hook.timeout ?? 60));
    if (timeouts.length > 0) events.set(event, Math.max(...timeouts));
  }
  return events;
}

/** Whether a Claude matcher selects the tool, by its Claude name or the host's own. */
function selects(matcher: string | undefined, names: readonly string[]): boolean {
  if (!matcher || matcher === '*') return true;
  let regex: RegExp | null = null;
  try {
    regex = new RegExp(`^(?:${matcher})$`);
  } catch {
    // Not a regex: compare literally.
  }
  return names.some((name) => (regex ? regex.test(name) : name === matcher));
}

type JsonObject = Record<string, unknown>;

const asObject = (value: unknown): JsonObject | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;

/** The text of a prompt a host gives as a string or a list of content parts. */
function promptText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  return value.map((part) => asObject(part)?.text).filter((text): text is string => typeof text === 'string').join('\n');
}

/** The host's payload as Claude Code sends it: Claude's tool names and `file_path`, and Hermes's prompt and session directory. */
function claudePayload(tool: string, event: string, host: JsonObject, bridge: Bridge): JsonObject {
  const payload: JsonObject = { ...host, hook_event_name: event };
  if (tool === 'hermes') {
    // Hermes passes its process directory; a session it moved to a worktree runs in TERMINAL_CWD.
    if (process.env.TERMINAL_CWD) payload.cwd = process.env.TERMINAL_CWD;
    const prompt = promptText(asObject(host.extra)?.user_message);
    if (prompt !== undefined) payload.prompt = prompt;
  }
  if (typeof host.tool_name === 'string') payload.tool_name = bridge.tools[host.tool_name] ?? host.tool_name;
  const input = asObject(host.tool_input);
  if (input && input.file_path === undefined) {
    const file = input.path ?? input.filePath;
    if (typeof file === 'string') payload.tool_input = { ...input, file_path: file };
  }
  return payload;
}

/** What the team hooks decided for the host. */
type Decision = { kind: 'block'; reason: string } | { kind: 'context'; text: string } | { kind: 'none' };

/** Events whose plain stdout Claude adds to the model's context. */
const CONTEXT_EVENTS: ReadonlySet<string> = new Set(['SessionStart', 'UserPromptSubmit']);

/** One hook's decision, read as Claude Code reads it: exit 2, a JSON decision, or context. */
function decisionOf(event: string, run: HookRun, id: string): Decision {
  if (run.code === 2) return { kind: 'block', reason: run.stderr.trim() || `Blocked by team hook ${id}` };
  if (run.code !== 0 || !run.stdout.trim()) return { kind: 'none' };
  let json: JsonObject | null = null;
  try {
    json = asObject(JSON.parse(run.stdout));
  } catch {
    // Plain text.
  }
  if (json) return jsonDecisionOf(json, id);
  return CONTEXT_EVENTS.has(event) ? { kind: 'context', text: run.stdout.trim() } : { kind: 'none' };
}

/** The decision in a hook's JSON output: a block or deny, or additional context. */
function jsonDecisionOf(json: JsonObject, id: string): Decision {
  const specific = asObject(json.hookSpecificOutput);
  if (json.decision === 'block' || specific?.permissionDecision === 'deny') {
    const reason = specific?.permissionDecisionReason ?? json.reason;
    return { kind: 'block', reason: typeof reason === 'string' && reason ? reason : `Blocked by team hook ${id}` };
  }
  const context = specific?.additionalContext;
  return typeof context === 'string' && context ? { kind: 'context', text: context } : { kind: 'none' };
}

/** The decisions merged for `event`: the first block of a PreToolUse, the contexts of a SessionStart or UserPromptSubmit. */
function merge(event: string, decisions: readonly Decision[]): Decision {
  if (event === 'PreToolUse') return decisions.find((d) => d.kind === 'block') ?? { kind: 'none' };
  if (!CONTEXT_EVENTS.has(event)) return { kind: 'none' };
  const texts = decisions.flatMap((d) => d.kind === 'context' ? [d.text] : []);
  return texts.length ? { kind: 'context', text: texts.join('\n\n') } : { kind: 'none' };
}

/** What the dispatcher prints and exits with. */
export interface BridgeReply {
  code: number;
  stdout: string;
  stderr: string;
}

function render(shape: ReplyShape, decision: Decision, stderr: string): BridgeReply {
  // Hermes shows a hook's stderr only for a nonzero exit. It still reads stdout
  // after exit 1, which blocks nothing on the fail-open entries teamai writes.
  const code = shape === 'hermes' && stderr.trim() ? 1 : 0;
  switch (decision.kind) {
    case 'none': return { code, stdout: '', stderr };
    case 'block':
      switch (shape) {
        case 'bridge': return { code: 0, stdout: JSON.stringify({ block: decision.reason }), stderr };
        case 'kiro': return { code: 2, stdout: '', stderr: `${stderr}${decision.reason}\n` };
        case 'hermes': return { code, stdout: JSON.stringify({ decision: 'block', reason: decision.reason }), stderr };
        default: {
          const unhandled: never = shape;
          return unhandled;
        }
      }
    case 'context':
      switch (shape) {
        case 'bridge': return { code: 0, stdout: JSON.stringify({ context: decision.text }), stderr };
        case 'kiro': return { code: 0, stdout: `${decision.text}\n`, stderr };
        case 'hermes': return { code, stdout: JSON.stringify({ context: decision.text }), stderr };
        default: {
          const unhandled: never = shape;
          return unhandled;
        }
      }
    default: {
      const unhandled: never = decision;
      return unhandled;
    }
  }
}

/** Run the hooks of `tool`'s file that select `event` and the host's tool, and merge what they decided. */
async function runEvent(tool: string, event: string, teamHooks: TeamHooks, host: JsonObject, bridge: Bridge): Promise<{ decision: Decision; stderr: string }> {
  const payload = claudePayload(tool, event, host, bridge);
  const names = [payload.tool_name, host.tool_name].filter((name): name is string => typeof name === 'string');
  const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : undefined;
  // The kill switch stops the team's hooks a pull applied; the local agent's are not the team's.
  const teamHooksOff = areTeamHooksDisabled();
  const hooks = (teamHooks[event] ?? [])
    .filter((entry) => !teamHooksOff || entry.description?.startsWith(TEAMAI_AGENT_HOOK_PREFIX))
    .filter((entry) => !event.endsWith('ToolUse') || selects(entry.matcher, names))
    .flatMap((entry) => entry.hooks.flatMap(({ command, timeout }) => typeof command === 'string'
      ? [{ id: /^\[teamai:(?:agent-)?hook:([^\]]+)\]/.exec(entry.description ?? '')?.[1] ?? 'team', command, timeout: timeout ?? 60 }]
      : []));
  const runs = await Promise.all(hooks.map(async (hook) => ({
    hook, run: await runHookCommand(hook.command, { cwd, timeout: hook.timeout, stdin: JSON.stringify(payload) }),
  })));
  const decided = runs.map(({ hook, run }) => ({ hook, run, decision: decisionOf(event, run, hook.id) }));
  const decision = merge(event, decided.map((d) => d.decision));
  let stderr = '';
  for (const d of decided) {
    if (d.run.timedOut) stderr += `teamai: team hook ${d.hook.id} timed out after ${d.hook.timeout}s\n`;
    // The block made of a hook's stderr reaches the host once, as the block's reason.
    if (!(d.decision === decision && d.run.code === 2)) stderr += d.run.stderr;
  }
  return { decision, stderr };
}

/**
 * `teamai hook-dispatch <event> --tool <tool> --team-hooks` for a bridged
 * tool: run the team hooks of `tool`'s file that select this event and tool,
 * all at once, each in the session's directory (where a project hook's gate
 * passes or skips) with the Claude payload on stdin, and answer in the shape
 * the host reads. A hook that times out or fails decides nothing.
 */
export async function runBridgedTeamHooks(tool: string, event: string, raw: string): Promise<BridgeReply> {
  const bridge = bridgeOf(tool);
  if (!bridge) throw new Error(`${tool} does not run team hooks through teamai's bridge`);
  const read = await readTeamHooks(tool);
  if (read.kind === 'invalid') return render(bridge.reply, { kind: 'none' }, `${invalidFileMessage(tool, read.error)}\n`);
  // Hermes runs SessionStart's context on the first turn's pre_llm_call: its on_session_start ignores output.
  let host: JsonObject = {};
  try {
    host = asObject(JSON.parse(raw)) ?? {};
  } catch {
    // No payload: the hooks get the event alone.
  }
  const events = tool === 'hermes' && event === 'UserPromptSubmit' && asObject(host.extra)?.is_first_turn === true
    ? ['SessionStart', 'UserPromptSubmit'] : [event];
  const decisions: Decision[] = [];
  let stderr = '';
  for (const current of events) {
    const ran = await runEvent(tool, current, read.hooks, host, bridge);
    decisions.push(ran.decision);
    stderr += ran.stderr;
  }
  return render(bridge.reply, merge(event, decisions), stderr);
}
