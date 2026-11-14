import path from 'node:path';
import { getUserHome } from '@teamai/shared/home';
import { findOnPath } from '@teamai/shared/lookpath';
import { runsCommand, type InitInstance, type OpId, type RuntimeFailure } from '@teamai/runtime-protocol';
import { paseoHome } from './daemon/address.js';
import type { Daemon } from './daemon/connect.js';
import type { ProcessState } from './process-state.js';
import { z } from 'zod';

// ─── Paseo's providers ───────────────────────────────────
//
//  The providers Paseo ships that teamai runs as its tools, where each keeps its home, and the custom providers of a
//  daemon's `agents.providers`: which one runs a team instance, or the one teamai adds for it.
//

/**
 * The Paseo mode a tool answers a confined prompt in: one that reads without asking and asks before it edits or runs
 * anything, which ends the prompt. Each mode Paseo lists for Codex writes the workspace without asking, and Paseo
 * refuses any other, so Codex answers in `auto`, which asks before anything its sandbox does not allow, with its
 * sandbox set read-only (`CONFINED_OPTIONS`).
 */
export const CONFINED_MODES: Readonly<Record<PaseoTool, string>> = { claude: 'default', codex: 'auto', opencode: 'plan' };

/** The launch options a confined prompt starts with: for Codex, a sandbox that writes nothing, over its mode's own. */
export const CONFINED_OPTIONS: Readonly<Record<PaseoTool, { sandbox_mode: 'read-only' } | undefined>> = { claude: undefined, codex: { sandbox_mode: 'read-only' }, opencode: undefined };

/** The tools this runtime runs as Paseo agents: Paseo's providers that are teamai tools of the same name. */
export type PaseoTool = 'claude' | 'codex' | 'opencode';

export function isPaseoTool(tool: string): tool is PaseoTool {
  return Object.hasOwn(CONFINED_MODES, tool);
}

/** The tools this runtime runs, in the order it offers them. */
export const PASEO_TOOLS: readonly PaseoTool[] = Object.keys(CONFINED_MODES).filter(isPaseoTool);

/**
 * The home teamai resolved for an instance and passed in `init.instances`: absolute, the member's value of its variable
 * when their environment sets it, else its directory under their home. The runtime takes it as given.
 */
export function instanceHomeOf(home: NonNullable<InitInstance['home']>): string {
  return path.resolve(getUserHome(), home.dir);
}

/** Each of `homeEnv`, the variables teamai names for a tool in init, set to `dir`, as teamai sets them on its command. */
export function homeEnvAt(homeEnv: readonly string[], dir: string): Record<string, string> {
  return Object.fromEntries(homeEnv.map((variable) => [variable, dir]));
}

/** `dir` as the member reads it: `~/…` under their home, else as it is. */
export function shownPath(dir: string): string {
  const under = path.relative(getUserHome(), dir);

  return under !== '' && !under.startsWith('..') && !path.isAbsolute(under) ? `~/${under}` : dir;
}

/** The directory under `$HOME` `tool`'s home is in when nothing moves it. */
export function homeDirOf(tool: PaseoTool): string {
  switch (tool) {
    case 'claude':
      return '.claude';
    case 'codex':
      return '.codex';
    case 'opencode':
      return path.join('.local', 'share');
    default: {
      const unhandled: never = tool;

      return unhandled;
    }
  }
}

/**
 * The custom providers of the daemon's `agents.providers`, as much of each as tells which tool it extends, what it runs,
 * and its env, of which only the home variables are kept: the rest may hold a secret.
 */
export const CustomProvidersSchema = z.record(z.string(), z.object({ extends: z.string().optional(), command: z.array(z.string()).optional(), env: z.record(z.string(), z.string()).optional() }));

export type CustomProviders = z.infer<typeof CustomProvidersSchema>;

/**
 * `providers` with only the variables of each env that move a tool's home, `variables`, which teamai names in init: the
 * rest may hold a secret, and none is kept.
 */
export function keptOf(providers: CustomProviders, variables: readonly string[]): CustomProviders {
  const kept = new Set(variables);

  return Object.fromEntries(Object.entries(providers).map(([id, entry]) => [id, {
    ...entry, ...(entry.env && { env: Object.fromEntries(Object.entries(entry.env).filter(([name]) => kept.has(name))) }),
  }]));
}

/** Why the custom provider the runtime's providers option names cannot run `tool`, or undefined when it extends it. */
export const namedProblem = (named: string, tool: PaseoTool, custom: CustomProviders): string | undefined => (custom[named]?.extends === tool
  ? undefined
  : `the runtime's providers option names ${named}, which the daemon's agents.providers does not hold as a provider that extends ${tool}`);

/**
 * A Paseo custom provider teamai adds for a team instance no provider runs: `id`, the instance's name; `entry`, what
 * `agents.providers` holds of it, which extends the instance's tool, runs its command from teamai's PATH (none for an
 * instance with only a home of its own: the tool's own), and sets the tool's home only for an instance with a home of
 * its own.
 */
export interface ProviderToAdd {
  id: string;
  entry: { extends: PaseoTool; label: string; command?: [string]; env?: Record<string, string> };
}

/**
 * Whether a provider whose command on the daemon is `executable` runs `command`, as Paseo starts it: Paseo does not
 * expand `~/`. Paseo's protocol does not say which platform the daemon's host runs, so `hostPlatform` is given only for
 * a daemon on this machine. Else the command tells: a drive letter, a backslash or a Windows extension (`.exe`, `.cmd`,
 * `.bat`) is a Windows host's.
 */
export function daemonRuns({ executable, command, hostPlatform }: { executable: string | undefined; command: string; hostPlatform: NodeJS.Platform | undefined }): boolean {
  const isWindows = executable !== undefined && /^[a-z]:[\\/]|\\|\.(?:exe|cmd|bat)$/i.test(executable);

  return runsCommand({ executable, command, expandsHome: false, platform: isWindows ? 'win32' : hostPlatform ?? 'linux' });
}

/** How Paseo names a custom provider: lowercase letters, digits and dashes, starting with a letter. */
const PROVIDER_ID = /^[a-z][a-z0-9-]*$/;

/** The provider that runs a team instance, why none can, or the one teamai adds for it. */
export type ProviderFound = { provider: string } | { cannot: string } | { add: ProviderToAdd };

/**
 * The Paseo provider that runs team instance `instance` of `tool`: the one `named` gives, which must extend `tool` and
 * run the instance's command, else the one custom provider that does, and, for an instance with only a home of its own,
 * the one that runs the tool's own command with that home. With none, the one teamai adds, when it can: on a daemon on
 * this machine, under the instance's name, with its command found on teamai's PATH. Or why it cannot, with how to set one
 * up. `home` is the absolute home of the instance's own, when it has one, which every variable of `homeEnv`, the ones
 * teamai names for the instance in init, is set to.
 */
export function providerOf(instance: InitInstance, tool: PaseoTool, { custom, named, home, homeEnv, onThisMachine }: {
  custom: CustomProviders; named: string | undefined; home: string | undefined; homeEnv: readonly string[]; onThisMachine: boolean;
}): ProviderFound {
  const { command, name } = instance;
  const hostPlatform = onThisMachine ? process.platform : undefined;

  if (named !== undefined) {
    const problem = namedProblem(named, tool, custom);
    const runs = custom[named]?.command?.[0];

    if (problem !== undefined) return { cannot: problem };

    return command === undefined || daemonRuns({ executable: runs, command, hostPlatform })
      ? { provider: named }
      : { cannot: `the runtime's providers option names ${named}, which runs ${runs ?? 'its tool\'s own command'} rather than its command ${command}; name a provider whose command is ${command}` };
  }

  // A provider with no command of its own runs the tool's.
  const runsOwn = (entry: CustomProviders[string]): boolean => (command === undefined
    ? (entry.command?.[0] === undefined || daemonRuns({ executable: entry.command[0], command: tool, hostPlatform })) && home !== undefined && homeEnv.length > 0 && homeEnv.every((variable) => entry.env?.[variable] === home)
    : daemonRuns({ executable: entry.command?.[0], command, hostPlatform }));

  if (command === undefined && home === undefined) {
    return { cannot: `the team instance names neither a command nor a home for Paseo to run ${tool} with; add a Paseo provider on the daemon's host that extends ${tool}, then name it in the runtime's providers option` };
  }

  const shownHome = instance.home ? shownPath(instanceHomeOf(instance.home)) : '';
  const subject = command === undefined ? `no Paseo provider runs ${tool} in its home ${shownHome}` : `no Paseo provider runs its command ${command}`;
  const setUp = command === undefined ? `with env ${JSON.stringify(homeEnvAt(homeEnv, shownHome))}` : `with command ${JSON.stringify([command])}`;
  const matches = Object.entries(custom).flatMap(([id, entry]) => (entry.extends === tool && runsOwn(entry) ? [id] : []));
  const [only, second] = matches;

  if (second !== undefined) {
    return { cannot: `Paseo providers ${matches.slice(0, -1).join(', ')} and ${matches.at(-1) ?? ''} both run ${command === undefined ? `${tool} in its home ${shownHome}` : `its command ${command}`}; name the one to use in the runtime's providers option, such as providers: { ${name}: ${only ?? ''} }` };
  }

  if (only !== undefined) return { provider: only };

  if (!onThisMachine) {
    return { cannot: `${subject}, and teamai adds one only on a daemon on this machine; add one on the daemon's host that extends ${tool} ${setUp} (\`paseo daemon config set agents.providers …\`, then \`paseo daemon reload\`), or name one in the runtime's providers option` };
  }

  if (!PROVIDER_ID.test(name)) {
    return { cannot: `${subject}, and teamai cannot add one named ${name}, since Paseo names a provider with lowercase letters, digits and dashes only, starting with a letter; add one on the daemon's host that extends ${tool} ${setUp}, and name it in the runtime's providers option` };
  }

  const taken = custom[name];

  if (taken !== undefined) {
    const runs = command === undefined ? `${tool} in ${homeEnv.map((variable) => taken.env?.[variable]).find((dir) => dir !== undefined) ?? `${tool}'s own home`}` : taken.command?.[0] ?? `${tool}'s own command`;
    const point = command === undefined ? `set ${homeEnv.join(' and ')} to ${shownHome} in its env` : `point that provider at ${command}`;

    return { cannot: `${subject}, and the Paseo provider ${name} runs ${runs} instead, so teamai adds none under that name; ${point}, or name the provider to use in the runtime's providers option` };
  }

  const found = command === undefined ? undefined : findOnPath(command);

  if (command !== undefined && found === null) {
    return { cannot: `${subject}, and teamai adds one only for a command on its PATH; install ${command} there, or name a Paseo provider that runs it in the runtime's providers option` };
  }

  return {
    add: {
      id: name,
      entry: { extends: tool, label: name, ...(found && { command: [found] }), ...(home !== undefined && { env: homeEnvAt(homeEnv, home) }) },
    },
  };
}

/**
 * What the person reads once teamai added a Paseo provider for instance `name`: what it holds, that it stays, and how to
 * remove it: in the Paseo app, or, as Paseo's CLI cannot unset one provider (0.14 refuses `config unset` on a dynamic
 * key), by editing the config of the Paseo home the member's Paseo uses and reloading the daemon.
 */
export function addedNotice(url: string, { id, entry }: ProviderToAdd, name: string): string {
  const runs = entry.command ? entry.command[0] : `${entry.extends}'s own command`;
  const home = Object.entries(entry.env ?? {}).map(([variable, dir]) => `, with ${variable}=${dir}`).join('');
  const paseoDir = paseoHome(process.env);
  const homeFlag = process.env.PASEO_HOME ? ` --home ${paseoDir}` : '';

  return `teamai added the Paseo provider ${id} to the daemon at ${url} for its ${name} steps: it extends ${entry.extends} and runs ${runs}${home}. It stays for later runs; to remove it, choose Remove provider on ${id} in the Paseo app's provider settings, or delete agents.providers.${id} from ${path.join(paseoDir, 'config.json')}, then run \`paseo daemon reload${homeFlag}\`. Paseo cannot show its agents' logs once it is gone, so read them first.`;
}

/** Adds the Paseo providers init offered team instances on before they existed, once across the runtimes on this journal. */
export function providerAdds(state: ProcessState) {
  const { journal, write, toAdd, targets, sessionHomes, providerHomes } = state;
  /** The adds this process runs, by instance name: two opens of one instance wait for the same add. */
  const adding = new Map<string, Promise<RuntimeFailure | undefined>>();

  /**
   * Adds the Paseo provider of instance `name` when init offered it before it existed, once across the runtimes on this
   * journal, and says so once on `op`; or why the instance cannot run, which fails `op`. Nothing for any other tool.
   */
  const ensureProvider = (live: Daemon, name: string, op: OpId): Promise<RuntimeFailure | undefined> => {
    const pending = toAdd.get(name);

    if (!pending) return Promise.resolve(undefined);
    const { planned, instance } = pending;
    const cannot = (why: string): RuntimeFailure => ({ code: 'tool_unavailable', message: `teamai-runtime-paseo cannot run ${name} on the Paseo daemon at ${live.url}: ${why}. Then run the step again.` });

    const running = adding.get(name) ?? (async (): Promise<RuntimeFailure | undefined> => {
      let release: () => void;

      try {
        release = await journal.holdProviders(live.url);
      } catch (error) {
        adding.delete(name);

        return cannot(`it could not hold the daemon's providers in ${journal.root} to add one for it (${error instanceof Error ? error.message : String(error)}); make that directory writable`);
      }

      try {
        const added = await live.addProvider(planned, instance, state.homeEnv[name] ?? []);

        // A provider it added stays, so the person is told how to remove it: one the instance runs on, or one Paseo
        // would not remove again when the instance cannot run on it.
        if (added.added) write({ event: 'notice', op, message: addedNotice(live.url, planned, name) });

        if ('cannot' in added) return cannot(added.cannot);
        toAdd.delete(name);
        const target = targets.get(name);

        if (target) targets.set(name, { ...target, provider: added.provider });

        if (added.home !== undefined) sessionHomes.set(name, added.home);

        if (added.providerHome !== undefined) providerHomes.set(name, added.providerHome);

        return undefined;
      } finally {
        adding.delete(name);
        release();
      }
    })();

    adding.set(name, running);

    return running;
  };

  return ensureProvider;
}

export type EnsureProvider = ReturnType<typeof providerAdds>;
