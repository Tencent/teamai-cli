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

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * The agy payload with the Claude Code fields added beside agy's own, or null
 * when the event is not one teamai acts on: agy runs PreInvocation before every
 * model call of a turn, and only the first (`invocationNum` 0) is the prompt.
 */
export function agyHookPayload(event: string, payload: Record<string, unknown>): Record<string, unknown> | null {
  if (event === 'prompt-submit' && typeof payload.invocationNum === 'number' && payload.invocationNum > 0) return null;
  const shaped: Record<string, unknown> = { ...payload, hook_event_name: CLAUDE_EVENT[event] ?? event };
  if (typeof payload.conversationId === 'string') shaped.session_id = payload.conversationId;
  const workspace = Array.isArray(payload.workspacePaths) ? payload.workspacePaths[0] : undefined;
  if (typeof workspace === 'string') shaped.cwd = workspace;
  if (event === 'prompt-submit' && typeof payload.lastUserInput === 'string') shaped.prompt = payload.lastUserInput;
  const call = objectOf(payload.toolCall);
  if (call && typeof call.name === 'string') {
    shaped.tool_name = CLAUDE_TOOL[call.name] ?? call.name;
    const args = objectOf(call.args) ?? {};
    shaped.tool_input = Object.fromEntries(Object.entries(args).map(([key, value]) => [CLAUDE_ARG[key] ?? key, value]));
  }
  return shaped;
}

/** What teamai's built-in pass and the team's hooks returned for one event. */
export interface AgyHookResult {
  /** The built-in pass's stdout: Claude Code hook JSON, or plain context text. */
  builtin: string;
  /** The team hooks' decision as teamai's bridge prints it: `{"block": reason}`, `{"context": text}`, or nothing. */
  team: string;
}

/** The context a Claude Code hook output carries: its `additionalContext`, or the text itself. */
function contextOf(output: string): string {
  try {
    const context = objectOf(objectOf(JSON.parse(output))?.hookSpecificOutput)?.additionalContext;
    return typeof context === 'string' ? context : '';
  } catch {
    return output;
  }
}

/** The stdout agy reads for `event`, or '' when there is nothing to say. */
export function agyHookReply(event: string, result: AgyHookResult): string {
  let decided: Record<string, unknown> = {};
  try {
    decided = objectOf(JSON.parse(result.team)) ?? {};
  } catch {
    // The team hooks decided nothing.
  }
  if (event === 'pre-tool-use' && typeof decided.block === 'string') return JSON.stringify({ decision: 'deny', reason: decided.block });
  const team = typeof decided.context === 'string' ? decided.context : '';
  const context = [contextOf(result.builtin), team].map((text) => text.trim()).filter(Boolean).join('\n\n');
  if (!context) return '';
  // A session-start step persists across turns; a prompt's lasts only that turn.
  if (event === 'session-start') return JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: context } }] });
  if (event === 'prompt-submit') return JSON.stringify({ injectSteps: [{ ephemeralMessage: context }] });
  return '';
}
