import type { ToolName } from '../resources/agent-format.js';

// -*- coding: utf-8 -*-
/**
 * Normalize IDE-style tool names (CodeBuddy Craft Agent) to CLI-style names.
 *
 * CodeBuddy IDE passes tool names like `execute_command`, `search_content` etc.
 * while teamai hooks expect CLI-style names like `Bash`, `Grep`.
 */

const IDE_TO_CLI: Record<string, string> = {
  execute_command: 'Bash',
  search_content: 'Grep',
  write_to_file: 'Write',
  replace_in_file: 'Edit',
  list_dir: 'Glob',
  web_search: 'WebSearch',
  web_fetch: 'WebFetch',
  read_file: 'Read',
  task: 'Task',
  skill: 'Skill',
};

export function normalizeToolName(name: string): string {
  return IDE_TO_CLI[name] ?? name;
}

const AGENT_TYPE_ALIASES: Record<string, string> = {
  tcodex: 'codex',
  'codex-internal': 'codex',
  tclaude: 'claude',
  'claude-internal': 'claude',
};

export function normalizeAgentType(name: string): string {
  return AGENT_TYPE_ALIASES[name] ?? name;
}

/**
 * Every id that runs Codex. Hook delivery, hook format and the Stop-stdout gate
 * all key off this one list, so a new variant is added once (#719).
 *
 * It lives here, not beside `ToolName` in `resources/agent-format.ts`: that
 * module pulls in yaml, gray-matter, smol-toml and builtin-hooks, and
 * `hook-handlers.ts` imports this file statically on every hook dispatch. The
 * `ToolName` import above is type-only, so it is erased and costs nothing.
 */
export const CODEX_TOOL_IDS = ['codex', 'codex-internal', 'tcodex'] as const satisfies readonly ToolName[];

/**
 * Tools whose Stop hook cannot deliver non-blocking model context.
 * CodeBuddy/WorkBuddy ignore stdout; Codex rejects Stop additionalContext.
 * For these tools the share-learnings hint is stashed as pending state at Stop
 * and injected on the next UserPromptSubmit instead (which they DO consume).
 *
 * Matched against the raw, lowercase tool literal passed through hook dispatch
 * (not run through normalizeAgentType), which is why every id of a family has
 * to be listed. `codex-internal` and `tcodex` run the same Codex and were
 * missing, so their users lost the hint twice over: Codex rejected the Stop
 * payload and the stash that would have recovered it never ran (#719).
 *
 * A future variant id (e.g. "codebuddy-internal") would miss this Set the same
 * way, so add such variants here explicitly.
 */
export const STOP_STDOUT_UNSUPPORTED_TOOLS = new Set<string>([
  'codebuddy',
  'workbuddy',
  ...CODEX_TOOL_IDS,
]);

/**
 * Membership test for the set above.
 *
 * Lowercases first: `--tool` reaches the handlers exactly as the installed hook
 * command spelled it (`src/builtin-hooks.ts`), and a capitalised id would
 * otherwise miss the set and take the Stop path its host rejects.
 */
export function stopStdoutUnsupported(tool: string | undefined): boolean {
  return STOP_STDOUT_UNSUPPORTED_TOOLS.has((tool ?? '').toLowerCase());
}
