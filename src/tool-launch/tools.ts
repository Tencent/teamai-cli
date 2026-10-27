import { TOOLS } from '../tools.js';
import type { ToolId } from '../types.js';
import { LAUNCH_ADAPTERS, type LaunchAdapter, type LaunchAdapterId } from './adapters.js';

/** The tools whose `launch` facet names an adapter. */
export type LaunchedToolId = { [T in ToolId]: (typeof TOOLS)[T]['launch'] extends 'none' ? never : T }[ToolId];

/**
 * Every tool teamai launches, in the order an AI call takes the first one on PATH. Each list of tools that can run a
 * profile keeps this order, so a tool added at the end changes no member's default. OpenCode is the exception: AI calls
 * did not run it before #1389, and it sits before CodeBuddy, WorkBuddy and OpenClaw, so a member with OpenCode and one
 * of those, and no Claude or Codex, now gets OpenCode. Moving OpenCode last instead would change the default judge.
 */
export const LAUNCH_ORDER = ['claude', 'claude-internal', 'tclaude', 'codex', 'codex-internal', 'tcodex', 'opencode', 'codebuddy', 'workbuddy', 'openclaw', 'cursor', 'copilot', 'qoder', 'kiro', 'pi', 'omp', 'muse', 'hermes'] as const satisfies readonly LaunchedToolId[];

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

type Profile = 'step' | 'judge';

/** The tools whose adapter builds `P`. */
export type ToolWith<P extends Profile> = { [T in LaunchOrderTool]: (typeof LAUNCH_ADAPTERS)[(typeof TOOLS)[T]['launch']] extends Record<P, unknown> ? T : never }[LaunchOrderTool];

function toolsWith<P extends Profile>(profile: P): readonly ToolWith<P>[] {
  return LAUNCH_ORDER.filter((tool): tool is ToolWith<P> => profile in launchAdapterOf(tool));
}

/** The tools a workflow step runs, in `LAUNCH_ORDER`. */
export const LAUNCH_TOOLS = toolsWith('step');

export type LaunchTool = ToolWith<'step'>;

export function isLaunchTool(value: string): value is LaunchTool {
  return (LAUNCH_TOOLS as readonly string[]).includes(value);
}

/** The tools the local judge runs, in `LAUNCH_ORDER`. */
export const JUDGE_TOOLS = toolsWith('judge');

export type JudgeTool = ToolWith<'judge'>;

/** OpenCode's model arguments: OpenCode 2 has no `--variant` and reads the effort from `--model provider/model#variant`. */
export function opencodeModelArgs(model: { name: string; effort?: string } | undefined, major: number): string[] {
  if (!model) return [];
  if (model.effort === undefined) return ['--model', model.name];
  return major >= 2 ? ['--model', `${model.name}#${model.effort}`] : ['--model', model.name, '--variant', model.effort];
}
