import { TOOLS } from '../tools.js';
import type { ToolId } from '../types.js';
import { LAUNCH_ADAPTERS, type LaunchAdapter, type LaunchAdapterId } from './adapters.js';

/** The tools whose `launch` facet names an adapter. */
export type LaunchedToolId = { [T in ToolId]: (typeof TOOLS)[T]['launch'] extends 'none' ? never : T }[ToolId];

/**
 * Every tool teamai launches, in the order an AI call takes the first one on PATH. Each list of tools that can run a
 * profile keeps this order, so a tool added at the end changes no member's default. OpenCode is the exception: AI calls
 * did not run it before #1389, and it sits before CodeBuddy, WorkBuddy and OpenClaw, so a member with OpenCode and one
 * of those, and no Claude or Codex, now gets OpenCode. This ordering remains stable for existing callers.
 */
export const LAUNCH_ORDER = ['claude', 'claude-internal', 'tclaude', 'codex', 'codex-internal', 'tcodex', 'opencode', 'codebuddy', 'workbuddy', 'openclaw', 'cursor', 'copilot', 'qoder', 'kiro', 'pi', 'omp', 'muse', 'hermes', 'agy'] as const satisfies readonly LaunchedToolId[];

export type LaunchOrderTool = (typeof LAUNCH_ORDER)[number];

/** The adapter whose flags and output `tool` shares, from its `launch` facet. */
export function launchAdapterIdOf<T extends LaunchOrderTool>(tool: T): (typeof TOOLS)[T]['launch'] {
  return TOOLS[tool].launch;
}

export function launchAdapterOf(tool: LaunchOrderTool): (typeof LAUNCH_ADAPTERS)[LaunchAdapterId] {
  return LAUNCH_ADAPTERS[launchAdapterIdOf(tool)];
}

/** The command that starts `tool`: its adapter's executable, or the tool's id. */
export function executableOf(tool: LaunchOrderTool): string {
  const adapter: LaunchAdapter = launchAdapterOf(tool);
  return adapter.executable ?? tool;
}
