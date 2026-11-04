import { TOOLS } from '../tools.js';
import type { ToolId } from '../tools.js';
import { LAUNCH_ADAPTERS, type ConfinedLaunch, type LaunchAdapter, type LaunchAdapterId, type StepLaunch } from './adapters.js';

/** The tools whose `launch` facet names an adapter. */
export type LaunchedToolId = { [T in ToolId]: (typeof TOOLS)[T]['launch'] extends 'none' ? never : T }[ToolId];

/**
 * Every tool teamai launches, in the order an AI call takes the first one on PATH. Each list of tools that can run a
 * profile keeps this order, so a tool added at the end changes no member's default. OpenCode is the exception: AI calls
 * did not run it before #1389, and it sits before CodeBuddy, WorkBuddy and OpenClaw, so a member with OpenCode and one
 * of those, and no Claude or Codex, now gets OpenCode. Moving OpenCode last instead would change the default judge.
 */
// oxlint-disable-next-line teamai/tool-facts -- priority order; tools.type-test.ts checks it holds every tool TOOLS.launch names
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

type Profile = 'step' | 'confined';

/** The tools whose adapter builds `P`. */
export type ToolWith<P extends Profile> = { [T in LaunchOrderTool]: (typeof LAUNCH_ADAPTERS)[(typeof TOOLS)[T]['launch']] extends { readonly [K in P]: StepLaunch | ConfinedLaunch } ? T : never }[LaunchOrderTool];

function toolsWith<P extends Profile>(profile: P): readonly ToolWith<P>[] {
  return LAUNCH_ORDER.filter((tool): tool is ToolWith<P> => profile in launchAdapterOf(tool));
}

/** The tools a workflow step runs, in `LAUNCH_ORDER`. */
export const LAUNCH_TOOLS = toolsWith('step');

export type LaunchTool = ToolWith<'step'>;

export function isLaunchTool(value: string): value is LaunchTool {
  return LAUNCH_TOOLS.some((tool) => tool === value);
}

/** The tools that run confined to one directory, in `LAUNCH_ORDER`. */
export const CONFINED_TOOLS = toolsWith('confined');

export type ConfinedTool = ToolWith<'confined'>;

/** OpenCode's model arguments: OpenCode 2 has no `--variant` and reads the effort from `--model provider/model#variant`. */
export function opencodeModelArgs(model: { name: string; effort?: string } | undefined, major: number): string[] {
  if (!model) return [];

  if (model.effort === undefined) return ['--model', model.name];

  return major >= 2 ? ['--model', `${model.name}#${model.effort}`] : ['--model', model.name, '--variant', model.effort];
}
