import path from 'node:path';
import { fitReason, runsCommand, type InitHomeEnv, type InitInstance } from '@teamai/runtime-protocol';
import { DRIVER_NAMES, DRIVERS, driverOf, type Driver } from './sessions.js';
import type { Provider } from './t3.js';

// ─── The T3 provider instance that runs each tool instance ───
//
//  A team or personal tool instance (`extends: claude`, `command: acme-claude`) runs in T3 on a provider instance whose
//  Binary path is the instance's command. `instances` in the definition's options maps a name to a provider instance
//  by id; with no entry, the runtime finds the one whose Binary path in the member's T3 settings runs the command
//  (`runsCommand`), so a team definition needs no machine's ids.
//
//    init instances: [{ name: acme-claude, tool: claude, command: acme-claude }]
//    settings.json   providerInstances.acme-claude-t3.config.binaryPath = /opt/acme/bin/acme-claude
//    →               acme-claude runs on acme-claude-t3
//

/**
 * Whether a provider instance of `driver` with `binaryPath` runs the provider's own tool, such as `claude`: none set, or
 * that command by name or path. Any other is a wrapper or a team tool's command, which a base tool never runs on.
 */
export function runsOwnBinary(binaryPath: string | undefined, driver: Driver): boolean {
  return binaryPath === undefined || runsCommand({ executable: binaryPath, command: DRIVERS[driver].tool, expandsHome: true });
}

/** What T3 serves a tool by: a tool instance `init` gives, or a shipped tool the definition's `instances` maps. */
export type ServedTool = Pick<InitInstance, 'name' | 'tool' | 'command' | 'home'>;

/** What finds the provider instance of each tool instance: T3's instances, which of them can run now, and each one's Binary path. */
export interface InstanceLookup {
  providers: Provider[];
  /** Whether the provider instance can run now, for the checkout's project. */
  isUsable(provider: Provider): boolean;
  /** The Binary path the member set for the provider instance in T3, if any. */
  binaryPathOf(instanceId: string): string | undefined;
  /** The tool home T3 runs the provider instance in. */
  homeOf(provider: Provider, driver: Driver): string;
  /** The tool home teamai gives the instance. */
  homeFor(instance: ServedTool, driver: Driver): string;
  /** A home as the person writes it. */
  shown(home: string): string;
}

export interface ServedInstances {
  served: Map<string, Provider>;
  unavailable: Record<string, string>;
  /** What the person hears at the start: a misspelt `instances` key, which no step may ever name to show its reason. */
  notices: string[];
  /** The instances no provider instance runs, and `instances` does not map, which teamai may add, with the command each runs. */
  missing: Array<{ instance: ServedTool; driver: Driver; command: string }>;
}

/**
 * The provider instance that serves each of `instances` T3 can run: the one `mapped` names, checked, else the one whose
 * Binary path runs its command (with no command of its own: the tool's own binary, in the instance's home). One missing
 * is listed for teamai to add. One whose command two instances run, one the member turned off, or one whose mapping
 * cannot hold is not served, and `unavailable` says what to set. teamai passes every instance the member may run at init, so a problem
 * with one never fails the others.
 */
export function servedInstances({ instances, mapped, lookup, homeEnv }: { instances: ServedTool[]; mapped: Record<string, string> | undefined; lookup: InstanceLookup; homeEnv: InitHomeEnv }): ServedInstances {
  const served = new Map<string, Provider>();
  const unavailable: Record<string, string> = {};
  const notices: string[] = [];
  const missing: ServedInstances['missing'] = [];
  // A misspelt name maps nothing, so it is named; it may also be a team tool this machine has not accepted.

  for (const stray of Object.keys(mapped ?? {}).filter((name) => !instances.some((instance) => instance.name === name))) {
    const message = fitReason(`instances names ${stray}, which is neither claude, codex nor a tool instance teamai has here. Remove instances.${stray}, or name the instance as its tool definition does.`);
    unavailable[stray] = message;
    notices.push(message);
  }

  for (const instance of instances) {
    const driver = driverOf(instance.tool);

    // T3 runs only Claude and Codex here; another runtime of the definition serves the rest.
    if (!driver) continue;
    const { name, command } = instance;
    const label = DRIVERS[driver].label;
    const id = mapped?.[name];
    // T3 Code starts a provider instance with a Binary path and a Home path only, and sets no variable but the tool's own.
    const own = homeEnv[instance.tool] ?? [];
    const unset = (homeEnv[name] ?? []).filter((variable) => !own.includes(variable));

    if (unset.length > 0) {
      unavailable[name] = fitReason(`${name} reads its home from ${unset.join(' and ')}, which T3 Code cannot set: it starts a provider instance with a Binary path and a Home path only, so ${name} would read another home than the one teamai delivered to. Remove home.env from the ${name} tool definition, so teamai sets ${own.join(' and ')}, or run its steps on another runtime.`);
      continue;
    }

    if (id !== undefined) {
      const provider = lookup.providers.find((one) => one.providerInstanceId === id);

      if (!provider) {
        unavailable[name] = fitReason(`T3 Code has no provider instance "${id}", which instances maps ${name} to. Add or enable it in T3 Code under Settings → Providers, or remove instances.${name}`);
        continue;
      }

      if (provider.driverKind !== driver) {
        unavailable[name] = fitReason(`T3 Code provider instance "${id}" runs ${provider.driverKind}, and ${name} extends ${instance.tool}. Map ${name} to a ${label} instance in instances.${name}`);
        continue;
      }

      if (!lookup.isUsable(provider)) {
        unavailable[name] = fitReason(`T3 Code provider instance "${id}", which instances maps ${name} to, cannot run now: ${(provider.constraints ?? []).join(' ') || 'it is turned off for this project.'} Enable it in T3 Code under Settings → Providers, or change instances.${name}`);
        continue;
      }

      const binaryPath = lookup.binaryPathOf(id);

      if (command !== undefined && binaryPath !== undefined && !runsCommand({ executable: binaryPath, command, expandsHome: true })) {
        unavailable[name] = fitReason(`T3 Code provider instance "${id}" has the Binary path ${binaryPath}, which is not ${command}, the command ${name} runs. Set its Binary path in T3 Code under Settings → Providers to the absolute path of ${command} (command -v ${command}), or change instances.${name}`);
        continue;
      }

      served.set(name, provider);
      continue;
    }

    // One named like the tool it adjusts, with no command of its own, is that tool, on the instance T3 runs it on.
    if (command === undefined && name === instance.tool) continue;
    // One with a home of its own and no command runs its tool's own command in that home: both tell its instance apart.
    const runs = command ?? DRIVERS[driver].tool;
    const home = command === undefined ? lookup.homeFor(instance, driver) : undefined;

    const found = lookup.providers.filter((provider) => {
      const binaryPath = lookup.binaryPathOf(provider.providerInstanceId);

      if (provider.driverKind !== driver) return false;

      return home === undefined ? runsCommand({ executable: binaryPath, command: runs, expandsHome: true }) : runsOwnBinary(binaryPath, driver) && lookup.homeOf(provider, driver) === home;
    });

    const what = home === undefined ? runs : `${runs} in ${lookup.shown(home)}`;
    const usable = found.filter((provider) => lookup.isUsable(provider));

    if (usable.length > 1) {
      const names = usable.map((provider) => `"${provider.providerInstanceId}"`);
      unavailable[name] = fitReason(`T3 Code provider instances ${names.slice(0, -1).join(', ')} and ${names.at(-1)} both run ${what}. Pick one with instances: { ${name}: <its id> } in the definition's t3 options.`);
      continue;
    }

    const [provider] = usable;

    if (provider) {
      served.set(name, provider);
      continue;
    }

    // One the member has but turned off, or T3 cannot run now, is theirs to fix: teamai adds no second one.
    const [off] = found;

    if (off) {
      unavailable[name] = fitReason(`T3 Code provider instance "${off.providerInstanceId}" runs ${what}, but cannot run now: ${(off.constraints ?? []).join(' ') || 'it is turned off for this project.'} Enable it in T3 Code under Settings → Providers, or map another with instances: { ${name}: <its id> } in the definition's t3 options.`);
      continue;
    }

    missing.push({ instance, driver, command: runs });
  }

  return { served, unavailable, notices, missing };
}

/** The T3 driver of `provider`, when this runtime runs it. */
export function driverOfProvider(provider: Provider): Driver | undefined {
  return DRIVER_NAMES.find((driver) => driver === provider.driverKind);
}

/**
 * The tool home teamai gives `instance`: its own `home.dir`, which teamai resolved; else its base tool's, which a
 * variable of `homeEnv`, the ones teamai names for that tool in init, moves in `env` (`~` as `home`, relative to `cwd`,
 * where teamai runs), else under `home`, the member's home.
 */
export function teamaiToolHome({ instance, driver, home, homeEnv, env, cwd }: { instance: ServedTool; driver: Driver; home: string; homeEnv: readonly string[]; env: Readonly<Record<string, string | undefined>>; cwd: string }): string {
  if (instance.home) return path.resolve(home, instance.home.dir);

  const moved = homeEnv.map((variable) => env[variable]?.trim()).find((dir) => dir !== undefined && dir !== '');

  if (!moved) return path.join(home, DRIVERS[driver].home);

  // As teamai reads it: `~` is the member's home, and a relative path is under where teamai runs.
  return moved === '~' || moved.startsWith('~/') ? path.join(home, moved.slice(1)) : path.resolve(cwd, moved);
}

/** `file`, with `~` for `home` when it is under it, as the person writes it. */
export function tilde(file: string, home: string): string {
  return file === home ? '~' : file.startsWith(`${home}${path.sep}`) ? `~${file.slice(home.length)}` : file;
}
