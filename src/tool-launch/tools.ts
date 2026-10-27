import { TOOLS } from '../tools.js';
import type { ToolId } from '../types.js';
import { LAUNCH_ADAPTERS, type LaunchAdapterId } from './adapters.js';

/** The tools whose `launch` facet names an adapter. */
export type LaunchedToolId = { [T in ToolId]: (typeof TOOLS)[T]['launch'] extends 'none' ? never : T }[ToolId];

/**
 * Every tool teamai launches, in the order an AI call takes the first one on PATH. Each list of tools that can run a
 * profile keeps this order, so a tool added at the end changes no member's default.
 */
export const LAUNCH_ORDER = ['claude', 'claude-internal', 'tclaude', 'codex', 'codex-internal', 'tcodex', 'opencode', 'codebuddy', 'workbuddy', 'openclaw'] as const satisfies readonly LaunchedToolId[];

export type LaunchOrderTool = (typeof LAUNCH_ORDER)[number];

export function launchAdapterOf(tool: LaunchOrderTool): (typeof LAUNCH_ADAPTERS)[LaunchAdapterId] {
  return LAUNCH_ADAPTERS[TOOLS[tool].launch];
}

/** The AI coding tools TeamAI launches headless, and the family whose flags and output each one shares. */
export const LAUNCH_TOOLS = ['claude', 'claude-internal', 'tclaude', 'codex', 'codex-internal', 'tcodex', 'opencode'] as const satisfies readonly ToolId[];

export type LaunchTool = (typeof LAUNCH_TOOLS)[number];

export function isLaunchTool(value: string): value is LaunchTool {
  return (LAUNCH_TOOLS as readonly string[]).includes(value);
}

export function localToolFamily(tool: LaunchTool): 'claude' | 'codex' | 'opencode' {
  if (tool === 'codex' || tool === 'codex-internal' || tool === 'tcodex') return 'codex';
  if (tool === 'opencode') return 'opencode';
  return 'claude';
}

/** OpenCode's model arguments: OpenCode 2 has no `--variant` and reads the effort from `--model provider/model#variant`. */
export function opencodeModelArgs(model: { name: string; effort?: string } | undefined, major: number): string[] {
  if (!model) return [];
  if (model.effort === undefined) return ['--model', model.name];
  return major >= 2 ? ['--model', `${model.name}#${model.effort}`] : ['--model', model.name, '--variant', model.effort];
}
