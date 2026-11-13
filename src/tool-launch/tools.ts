import { resolveCliPath, resolvePathCommand } from '@teamai/shared/cli-path';
import { descriptorOf, toolOf, type DescriptorOf } from '../tool-registry.js';
import type { ResolvedToolInstance } from '../tool-instances.js';
import type { ToolId } from '../tools.js';
import { LAUNCH_ADAPTERS } from './adapters.js';
import type { ConfinedLaunch, LaunchAdapter, StepLaunch } from '@teamai/tool-core/launch';

/** The tools whose `launch` facet names an adapter. */
export type LaunchedToolId = { [T in ToolId]: DescriptorOf<T>['launch'] extends 'none' ? never : T }[ToolId];

/** The adapter teamai launches `tool` headless with (`LAUNCH_ADAPTERS`). */
export type LaunchAdapterOf<T extends LaunchedToolId> = (typeof LAUNCH_ADAPTERS)[DescriptorOf<T>['launch']];

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
export function launchAdapterIdOf<T extends LaunchedToolId>(tool: T): DescriptorOf<T>['launch'] {
  return descriptorOf(tool).launch;
}

export function launchAdapterOf<T extends LaunchedToolId>(tool: T): LaunchAdapterOf<T> {
  return LAUNCH_ADAPTERS[launchAdapterIdOf(tool)];
}

/** The command that starts `tool`: its adapter's executable, or the tool's id. */
export function executableOf(tool: LaunchOrderTool): string {
  const adapter: LaunchAdapter = launchAdapterOf(tool);

  return adapter.executable ?? tool;
}

/**
 * The executables of `tool` to try, in order: its command, then those a desktop app installs it as. A tool teamai
 * launches none of is its own command.
 */
export function executablesOf(tool: string): string[] {
  const launched = LAUNCH_ORDER.find((one) => one === tool);

  if (launched === undefined) return [tool];
  const adapter: LaunchAdapter = launchAdapterOf(launched);

  return [executableOf(launched), ...(adapter.installs?.() ?? [])];
}

type Profile = 'step' | 'confined';

/** The tools whose adapter builds `P`. */
export type ToolWith<P extends Profile> = { [T in LaunchOrderTool]: LaunchAdapterOf<T> extends { readonly [K in P]: StepLaunch | ConfinedLaunch } ? T : never }[LaunchOrderTool];

function toolsWith<P extends Profile>(profile: P): readonly ToolWith<P>[] {
  return LAUNCH_ORDER.filter((tool): tool is ToolWith<P> => profile in launchAdapterOf(tool));
}

/** The tools a workflow step runs, in `LAUNCH_ORDER`. */
export const LAUNCH_TOOLS = toolsWith('step');

export type LaunchTool = ToolWith<'step'>;

export function isLaunchTool(value: string): value is LaunchTool {
  return LAUNCH_TOOLS.some((tool) => tool === value);
}

/**
 * A tool a workflow step launches, by the name a step, `--tools` or a setting gives it: a shipped tool, or an instance
 * of one. `tool` is the shipped tool whose flags and formats it runs with; `name` is what its report and its sessions
 * are credited to.
 */
export interface LaunchTarget {
  readonly name: string;
  readonly tool: LaunchTool;
  readonly instance?: ResolvedToolInstance;
}

/** The launch `name` names, or undefined when it names no tool, or one that runs no workflow step. */
export function launchTargetOf(name: string): LaunchTarget | undefined {
  const resolved = toolOf(name);

  if (!resolved || !isLaunchTool(resolved.base)) return undefined;

  return resolved.instance ? { name, tool: resolved.base, instance: resolved.instance } : { name, tool: resolved.base };
}

/** Where the command that starts `target` is installed, or null. An instance's comes from a config file, so only PATH counts. */
export function launchExecutableOf(target: LaunchTarget): string | null {
  const command = target.instance?.command;

  return command === undefined ? resolveCliPath(executableOf(target.tool)) : resolvePathCommand(command);
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
