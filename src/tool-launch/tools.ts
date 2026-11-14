import { resolveCliPath, resolvePathCommand } from '@teamai/shared/cli-path';
import { descriptorOf, toolOf, type DescriptorOf } from '../tool-registry.js';
import type { DeclaredTool } from '../tool-instances.js';
import type { ToolInstanceHome } from '@teamai/tool-core/instance';
import type { ShippedDescriptor, ToolId } from '../tools.js';
import { movedToolHome, realHost, recordedHomes, toolHomeOf, type Host } from '../tool-home.js';
import { RELOCATABLE_TOOLS, recordedToolRootDir, type LocalConfig } from '../types.js';
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
  readonly instance?: DeclaredTool;
}

/** The launch `name` names, or undefined when it names no tool, or one that runs no workflow step. */
export function launchTargetOf(name: string): LaunchTarget | undefined {
  const resolved = toolOf(name);

  if (!resolved || !isLaunchTool(resolved.base)) return undefined;

  return resolved.instance ? { name, tool: resolved.base, instance: resolved.instance } : { name, tool: resolved.base };
}

/**
 * The variable `tool`'s command reads its home from, or undefined: a tool an instance may extend names it in
 * `RELOCATABLE_TOOLS`, which also refuses it as an instance's `home.env`; any other in its launch profile (`ConfinedLaunch.homeEnv`).
 */
export function homeVariableOf(tool: string): string | undefined {
  if (Object.hasOwn(RELOCATABLE_TOOLS, tool)) return RELOCATABLE_TOOLS[tool]?.envVar;
  const launched = LAUNCH_ORDER.find((one) => one === tool);

  if (launched === undefined) return undefined;
  const adapter: LaunchAdapter = launchAdapterOf(launched);

  return adapter.confined?.homeEnv;
}

/**
 * The variable a command of `tool` starts with at the home teamai delivered it to when that home moved: its launch
 * variable (`homeVariableOf`) when `toolRoots` records its root or `Home.moves` moves its home; else undefined, and its
 * command keeps the shell's variables. The tool support page lists these tools.
 */
export function deliveredHomeVariableOf(tool: ToolId): string | undefined {
  const { home }: ShippedDescriptor = descriptorOf(tool);

  return Object.hasOwn(RELOCATABLE_TOOLS, tool) || home.moves !== undefined ? homeVariableOf(tool) : undefined;
}

/** The home variables teamai sets on a tool's command, by name. */
export type ToolCommandEnv = Readonly<Record<string, string>>;

/**
 * The home a tool's command starts in: `delivered`, the one teamai delivers the tool to, resolved as delivery resolves
 * it, from the member's environment `inherited` and the `toolRoots` their config records; `at`, one home teamai chose
 * for this run, such as an app-server's, a session store's or a throwaway one.
 */
export type ToolCommandHome =
  | { readonly kind: 'delivered'; readonly inherited: Readonly<Record<string, string | undefined>>; readonly toolRoots: LocalConfig['toolRoots'] }
  | { readonly kind: 'at'; readonly dir: string };

/**
 * The home variables teamai sets when it starts the command of the tool `name`, the one place that decides them. At a
 * chosen home: every variable the command reads its home from, the tool's and an instance's own (`home.env`). At the
 * delivered home, the command reads where delivery wrote, so a home delivery resolved wins over the shell's variable:
 * for an instance with a home of its own, the variable of the tool it extends and its own, if it names one, at the home
 * its record or variable gives (`toolHomeOf`), as at a chosen home; for a shipped tool, an
 * adjustment or an instance that keeps the home of the tool it extends, its variable at the root `toolRoots` records,
 * else at its moved home (`movedToolHome`). With none of those, the shell's variable stays as it is. A home a record
 * names wins even once its directory is gone, as delivery's does, and delivery then skips the tool: the command is not
 * started there, and `home_gone` says how to fix the record.
 */
export function toolCommandEnv(name: string, home: Extract<ToolCommandHome, { kind: 'at' }>): ToolCommandEnv;
export function toolCommandEnv(name: string, home: Extract<ToolCommandHome, { kind: 'delivered' }>): DeliveredToolCommandEnv;
export function toolCommandEnv(name: string, home: ToolCommandHome): ToolCommandEnv | DeliveredToolCommandEnv {
  const resolved = toolOf(name);
  const instance = resolved?.instance;
  const variable = resolved === undefined ? undefined : homeVariableOf(resolved.base);

  switch (home.kind) {
    case 'at':
      return Object.fromEntries([variable, instance?.home?.env].flatMap((one) => one === undefined ? [] : [[one, home.dir]]));
    case 'delivered': {
      if (resolved === undefined) return { kind: 'ready', env: {} };
      const own = instance?.home;
      const host = realHost({ env: home.inherited });

      const at = instance === undefined || own === undefined
        ? deliveredHomeOf({ name, tool: resolved.base, home, host })
        : instanceHomeOf({ instance, own, variable, host });

      if (at === null) return { kind: 'ready', env: {} };

      if (at.recorded && !host.existsNow(at.dir)) {
        return {
          kind: 'home_gone',
          message: `The ${name} home recorded on this machine, ${at.dir}, does not exist, so teamai did not start ${name} there. `
            + `Point ${at.variable} at the home ${name} uses and re-run \`teamai init\`, or clear the record with \`${at.variable}= teamai init\`.`,
        };
      }

      return { kind: 'ready', env: Object.fromEntries([at.variable, ...at.also].map((one) => [one, at.dir])) };
    }

    default: {
      const unhandled: never = home;

      return unhandled;
    }
  }
}

/** The home variables of a command at the home teamai delivered its tool to, or the recorded home that is gone. */
export type DeliveredToolCommandEnv =
  | { readonly kind: 'ready'; readonly env: ToolCommandEnv }
  | { readonly kind: 'home_gone'; readonly message: string };

/**
 * The variable a delivered command starts with, the one a record or the member sets, the directory it names, whether a
 * record named it, and the other variables set to that directory.
 */
type DeliveredHome = { readonly variable: string; readonly also: readonly string[]; readonly dir: string; readonly recorded: boolean };

// Claude Code reads `.claude.json` inside CLAUDE_CONFIG_DIR whenever it is set, so the variable is set only to a home delivery moved.
function deliveredHomeOf(input: { name: string; tool: ToolId; home: Extract<ToolCommandHome, { kind: 'delivered' }>; host: Host }): DeliveredHome | null {
  const { name, tool, home, host } = input;
  const variable = deliveredHomeVariableOf(tool);

  if (variable === undefined) return null;
  const root = recordedToolRootDir(name, home.toolRoots);
  const dir = root ?? movedToolHome(tool, host);

  return dir === null ? null : { variable, also: [], dir, recorded: root !== null || dir === recordedHomes(host)[tool] };
}

function instanceHomeOf(input: { instance: DeclaredTool; own: ToolInstanceHome; variable: string | undefined; host: Host }): DeliveredHome | null {
  const { instance, own, variable, host } = input;
  const dir = toolHomeOf(instance.name, host)?.dir;

  if (dir === undefined) return null;

  // The tool it extends reads only its own variable, and runs whenever the instance names no command teamai accepted.
  if (own.env !== undefined) return { variable: own.env, also: variable === undefined ? [] : [variable], dir, recorded: dir === recordedHomes(host)[instance.name] };

  return variable === undefined ? null : { variable, also: [], dir, recorded: false };
}

/** Where the command that starts `target` is installed, or null. An instance's comes from a config file, so only PATH counts. */
export function launchExecutableOf(target: Pick<LaunchTarget, 'instance'> & { readonly tool: LaunchOrderTool }): string | null {
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
