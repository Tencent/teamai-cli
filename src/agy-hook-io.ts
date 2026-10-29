/**
 * Antigravity CLI (agy) hook payloads and replies, translated to and from the
 * Claude Code shape teamai's dispatcher and a team's hooks are written for.
 *
 *   agy stdin ── agyHookPayload ──> dispatcher + team hooks ── agyHookReply ──> agy stdout
 *
 * agy's contract (embedded in agy 1.4.8): stdin carries camelCase common fields
 * (`conversationId`, `workspacePaths`, `lastUserInput`) and `toolCall: {name, args}`;
 * SessionStart and PreInvocation reply with `injectSteps`, and PreToolUse with a
 * `decision`. The team's hooks run through teamai's bridge (bridged-team-hooks.ts).
 */

import { z } from 'zod';

/** teamai's dispatch events and the Claude Code event each one carries. */
const CLAUDE_EVENT: Record<string, string> = {
  'session-start': 'SessionStart',
  'prompt-submit': 'UserPromptSubmit',
  'pre-tool-use': 'PreToolUse',
  'post-tool-use': 'PostToolUse',
  stop: 'Stop',
};

/** agy's tool names, as Claude Code names the same tool. */
const CLAUDE_TOOL: Record<string, string> = {
  run_command: 'Bash',
  view_file: 'Read',
  read_file: 'Read',
  write_to_file: 'Write',
  replace_file_content: 'Edit',
  multi_replace_file_content: 'Edit',
  grep_search: 'Grep',
  find_by_name: 'Glob',
  list_dir: 'LS',
  read_url_content: 'WebFetch',
  search_web: 'WebSearch',
  invoke_subagent: 'Task',
};

/**
 * agy's names for the Claude Code tools an agent lists, each once, in order; a
 * tool agy has none for is left out. A list arrives as YAML wrote it: an array,
 * or one comma-separated string (`tools: Bash, Read`).
 */
export function agyToolsFor(claudeTools: unknown): string[] {
  const names = Array.isArray(claudeTools) ? claudeTools.map(String)
    : typeof claudeTools === 'string' ? claudeTools.split(',').map((tool) => tool.trim()) : [];
  const agy = names.flatMap((name) => Object.keys(CLAUDE_TOOL).filter((tool) => CLAUDE_TOOL[tool] === name));
  return [...new Set(agy)];
}

/** agy's argument names, as Claude Code's tool input names them. */
const CLAUDE_ARG: Record<string, string> = {
  CommandLine: 'command',
  AbsolutePath: 'file_path',
  Path: 'file_path',
  TargetFile: 'file_path',
  SearchPath: 'path',
  SearchDirectory: 'path',
  DirectoryPath: 'path',
  Query: 'pattern',
  Pattern: 'pattern',
  Url: 'url',
};

/** The agy fields teamai reads; a field of another shape counts as absent. */
const AgyPayload = z.object({
  invocationNum: z.number().optional().catch(undefined),
  conversationId: z.string().optional().catch(undefined),
  workspacePaths: z.array(z.string()).optional().catch(undefined),
  lastUserInput: z.string().optional().catch(undefined),
  transcriptPath: z.string().optional().catch(undefined),
  /** On PostToolUse: empty when the call ran, else why it did not. */
  error: z.string().optional().catch(undefined),
  toolCall: z.object({ name: z.string(), args: z.record(z.unknown()).catch({}).default({}) }).optional().catch(undefined),
});

/**
 * The agy payload with the Claude Code fields added beside agy's own, or null
 * when the event is not one teamai acts on: agy runs PreInvocation before every
 * model call of a turn, and only the first (`invocationNum` 0) is the prompt.
 */
export function agyHookPayload(event: string, payload: Record<string, unknown>): Record<string, unknown> | null {
  const agy = AgyPayload.parse(payload);
  if (event === 'prompt-submit' && agy.invocationNum !== undefined && agy.invocationNum > 0) return null;
  const shaped: Record<string, unknown> = { ...payload, hook_event_name: CLAUDE_EVENT[event] ?? event };
  if (agy.conversationId !== undefined) shaped.session_id = agy.conversationId;
  const workspace = agy.workspacePaths?.[0];
  if (workspace !== undefined) shaped.cwd = workspace;
  if (event === 'prompt-submit' && agy.lastUserInput !== undefined) shaped.prompt = agy.lastUserInput;
  if (agy.transcriptPath !== undefined) shaped.transcript_path = agy.transcriptPath;
  if (agy.toolCall) {
    shaped.tool_name = CLAUDE_TOOL[agy.toolCall.name] ?? agy.toolCall.name;
    shaped.tool_input = Object.fromEntries(Object.entries(agy.toolCall.args).map(([key, value]) => [CLAUDE_ARG[key] ?? key, value]));
  }
  // agy sends no tool output, so a call it reports an error for is the only one known to have failed.
  if (event === 'post-tool-use' && agy.error) shaped.tool_status = 'failure';
  return shaped;
}

/** What teamai's built-in pass and the team's hooks returned for one event. */
export interface AgyHookResult {
  /** The built-in pass's stdout: Claude Code hook JSON, or plain context text. */
  builtin: string;
  /** The team hooks' decision as teamai's bridge prints it: `{"block": reason}`, `{"context": text}`, or nothing. */
  team: string;
}

/** A Claude Code hook's JSON output, as far as it adds context. */
const ClaudeHookOutput = z.object({ hookSpecificOutput: z.object({ additionalContext: z.string() }) });
/** The team hooks' decision as teamai's bridge prints it. */
const BridgeDecision = z.object({ block: z.string().optional(), context: z.string().optional() });

/** `text` parsed as JSON, or undefined when it is not JSON. */
function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The context a Claude Code hook output carries: its `additionalContext`, or the text itself when it is not JSON. */
function contextOf(output: string): string {
  const json = jsonOf(output);
  if (json === undefined) return output;
  const parsed = ClaudeHookOutput.safeParse(json);
  return parsed.success ? parsed.data.hookSpecificOutput.additionalContext : '';
}

/** The stdout agy reads for `event`, or '' when there is nothing to say. */
export function agyHookReply(event: string, result: AgyHookResult): string {
  const parsed = BridgeDecision.safeParse(jsonOf(result.team));
  const decided = parsed.success ? parsed.data : {};
  if (event === 'pre-tool-use' && decided.block !== undefined) return JSON.stringify({ decision: 'deny', reason: decided.block });
  const context = [contextOf(result.builtin), decided.context ?? ''].map((text) => text.trim()).filter(Boolean).join('\n\n');
  if (!context) return '';
  // A session-start step persists across turns; a prompt's lasts only that turn.
  if (event === 'session-start') return JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: context } }] });
  if (event === 'prompt-submit') return JSON.stringify({ injectSteps: [{ ephemeralMessage: context }] });
  return '';
}
