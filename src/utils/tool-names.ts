import { channelsOf, TOOL_IDS, TOOLS, type ToolId } from '../tools.js';

// -*- coding: utf-8 -*-
/**
 * Normalize IDE-style tool names (CodeBuddy Craft Agent) to CLI-style names.
 *
 * CodeBuddy IDE passes tool names like `execute_command`, `search_content` etc.
 * while teamai hooks expect CLI-style names like `Bash`, `Grep`.
 */

/** A tool name as one source writes it → the name teamai uses. A `Map`, so a name
 *  such as `constructor` is not looked up on `Object.prototype`. */
const IDE_TO_CLI = new Map(Object.entries({
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
}));

export function normalizeToolName(name: string): string {
  return IDE_TO_CLI.get(name) ?? name;
}

// A tool left out is its own agent type, the right default for a new tool.
const AGENT_TYPE_ALIASES = new Map(Object.entries({
  tcodex: 'codex',
  'codex-internal': 'codex',
  tclaude: 'claude',
  'claude-internal': 'claude',
} satisfies Partial<Record<ToolId, ToolId>>));

export function normalizeAgentType(name: string): string {
  return AGENT_TYPE_ALIASES.get(name) ?? name;
}

/**
 * Every id that runs Codex: the tools whose `launch` adapter is Codex's. Hook
 * delivery and hook format key off this one list, so a new variant is added
 * once, in `TOOLS` (#719).
 *
 * It lives here, not beside `ToolName` in `resources/agent-format.ts`: that
 * module pulls in yaml, gray-matter, smol-toml and builtin-hooks, and
 * `hook-handlers.ts` imports this file statically on every hook dispatch.
 * `src/tools.ts` holds data and type-only imports, so loading it costs little.
 */
export type CodexToolId = { [T in ToolId]: (typeof TOOLS)[T]['launch'] extends 'codex' ? T : never }[ToolId];

export const CODEX_TOOL_IDS: readonly CodexToolId[] = TOOL_IDS.filter((tool): tool is CodexToolId => TOOLS[tool].launch === 'codex');

/** Whether `tool` runs Codex (`CODEX_TOOL_IDS`). */
export function isCodexTool(tool: string): boolean {
  return CODEX_TOOL_IDS.some((id) => id === tool);
}

/**
 * Whether `tool`'s Stop hook cannot take the Stop payload (its descriptor's
 * `hooks.stopReply`). A missing tool is Claude Code, which the legacy
 * `contribute-check` command assumes too.
 *
 * Lowercases first: `--tool` reaches the handlers exactly as the installed hook
 * command spelled it (`src/builtin-hooks.ts`).
 */
export function stopStdoutUnsupported(tool: string | undefined): boolean {
  return !channelsOf((tool ?? 'claude').toLowerCase()).hooks.stopReply;
}
