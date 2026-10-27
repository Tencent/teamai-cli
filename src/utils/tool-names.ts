import type { ToolName } from '../resources/agent-format.js';
import type { ToolId } from '../types.js';

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
  read_skill: 'Skill', // Muse Code
};

export function normalizeToolName(name: string): string {
  return IDE_TO_CLI[name] ?? name;
}

const AGENT_TYPE_ALIASES: Record<string, string> = {
  tcodex: 'codex',
  'codex-internal': 'codex',
  tclaude: 'claude',
  'claude-internal': 'claude',
} satisfies Partial<Record<ToolId, ToolId>>;

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

/** Whether `tool` runs Codex (`CODEX_TOOL_IDS`). */
export function isCodexTool(tool: string): boolean {
  return (CODEX_TOOL_IDS as readonly string[]).includes(tool);
}

/**
 * Tools whose Stop hook takes the Stop payload `formatStopHookOutput` writes.
 *
 * Every other tool has the share-learnings hint stashed as pending state at
 * Stop and injected on the next UserPromptSubmit instead. CodeBuddy/WorkBuddy
 * ignore Stop stdout, and Codex and Muse Code reject Stop additionalContext.
 * A tool missing from this list loses nothing worse than a hint delivered one
 * prompt late, while a tool wrongly on it loses the hint outright: Codex ids
 * missing from the old deny-list lost it twice over (#719). So the list holds
 * only tools whose Stop handling has been confirmed, and a new tool starts out
 * stashing.
 *
 * Matched against the raw, lowercase tool literal passed through hook dispatch
 * (not run through normalizeAgentType), which is why every id of a family has
 * to be listed.
 */
const STOP_STDOUT_TOOLS = new Set<string>([
  'claude',
  'claude-internal',
  'tclaude',
  'cursor',
  'copilot',
  'qoder',
  'qoder-cn',
  'zcode',
  'omp',
  'pi',
  'opencode',
  'dsh',
] satisfies ToolId[]);

/**
 * Whether `tool`'s Stop hook cannot take the Stop payload (see
 * `STOP_STDOUT_TOOLS`). A missing tool is Claude Code, which the legacy
 * `contribute-check` command assumes too.
 *
 * Lowercases first: `--tool` reaches the handlers exactly as the installed hook
 * command spelled it (`src/builtin-hooks.ts`).
 */
export function stopStdoutUnsupported(tool: string | undefined): boolean {
  return !STOP_STDOUT_TOOLS.has((tool ?? 'claude').toLowerCase());
}
