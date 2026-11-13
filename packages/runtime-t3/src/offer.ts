import path from 'node:path';
import type { RuntimeFailure, RuntimeRequest } from '@teamai/runtime-protocol';
import { type InstanceAdder } from './instances.js';
import { JUDGE_KEPT } from './judge.js';
import { parseOptions } from './options.js';
import { projectAt } from './place.js';
import type { Serving, Session } from './runtime.js';
import { canListStore, DRIVER_NAMES, DRIVERS, driverOf, toolOf, type Driver, type ToolId } from './sessions.js';
import { instanceToolHome, projectSettings, readSettings, type ModelSelection, type ProjectSettings } from './settings.js';
import { driverOfProvider, runsOwnBinary, servedInstances, teamaiToolHome, tilde, type ServedTool } from './tool-instances.js';
import { canWake } from './wake.js';
import { T3Error, tooOld, type Provider, type T3 } from './t3.js';
import { within } from './within.js';

// ─── What the runtime offers ───
//
//  init connects to the environment, signing in when attended, and offers the tools its provider instances run, and to
//  judge with them best effort. In recover mode it connects to nothing until a cancel or a close needs T3.
//

/**
 * How long T3 gets to answer init's connection and what it runs: teamai gives init 15 s. An attended sign-in waits for
 * the person instead, and this bound starts once they approved.
 */
const INIT_WAIT_MS = 10_000;

/**
 * The usable instance of each tool: the one `instance` names; else the instance of `defaultModel`, the member's default
 * or the started-from thread's, when it runs that tool's own binary, then the one whose id is the provider's name, then the first of that provider that runs
 * its own binary. An instance the member turned off for the project is never used, and another instance that runs a
 * wrapper or a team tool's command never runs the base tool unless `instance` names it.
 */
function instancesOf({ providers, instance, project, defaultModel, binaryPathOf }: { providers: Provider[]; instance: string | undefined; project: ProjectSettings; defaultModel: ModelSelection | undefined; binaryPathOf(instanceId: string): string | undefined }): { ok: true; instances: Map<ToolId, Provider> } | { ok: false; failure: RuntimeFailure } {
  const usable = providers.filter((provider) => (provider.constraints ?? []).length === 0 && project.instanceEnabled(provider.providerInstanceId) !== false);
  const tools = new Map<ToolId, Provider>();

  if (instance !== undefined) {
    const named = providers.find((provider) => provider.providerInstanceId === instance);
    const tool = named && toolOf(named.driverKind);

    if (!named) return { ok: false, failure: { code: 'bad_option', key: 'instance', message: `T3 Code has no provider instance "${instance}". Add it in T3 Code under Settings → Providers, or remove \`instance\` to use the tool's default one. Instances here: ${providers.map((provider) => provider.providerInstanceId).join(', ') || 'none'}` } };

    if (!tool) return { ok: false, failure: { code: 'bad_option', key: 'instance', message: `T3 Code provider instance "${instance}" runs ${named.driverKind}, which this runtime does not run. It runs Claude and Codex instances` } };

    if ((named.constraints ?? []).length > 0) return { ok: false, failure: { code: 'bad_option', key: 'instance', message: `T3 Code provider instance "${instance}" cannot run now: ${(named.constraints ?? []).join(' ')} Enable it in T3 Code under Settings → Providers` } };
    tools.set(tool, named);

    return { ok: true, instances: tools };
  }

  for (const driver of DRIVER_NAMES) {
    const own = usable.filter((provider) => provider.driverKind === driver && runsOwnBinary(binaryPathOf(provider.providerInstanceId), driver));

    // The instance named after the provider runs it whatever its Binary path, such as a Claude version file.
    const found = own.find((provider) => provider.providerInstanceId === defaultModel?.instanceId)
      ?? usable.find((provider) => provider.driverKind === driver && provider.providerInstanceId === driver) ?? own[0];

    if (found) tools.set(DRIVERS[driver].tool, found);
  }

  return { ok: true, instances: tools };
}

/**
 * The instance and model of the T3 thread `threadId`, the one the run was started from: none when the run was not, or
 * when the thread names none; a failure says why T3 could not read it. Its options stay T3's: T3 reports none of them.
 */
async function readThreadModel(t3: T3, threadId: string | undefined): Promise<{ ok: true; selection: ModelSelection | undefined } | { ok: false; threadId: string; why: string } | undefined> {
  if (threadId === undefined) return undefined;

  try {
    const { providerInstanceId, model } = await t3.thread(threadId);

    return { ok: true, selection: providerInstanceId && model ? { instanceId: providerInstanceId, model } : undefined };
  } catch (error) {
    // T3's own message, not the refusal's JSON, such as "Thread … is no longer available".
    const why = error instanceof T3Error ? error.refusal?.message ?? error.message : error instanceof Error ? error.message : String(error);

    return { ok: false, threadId, why: why.replace(/\.$/, '') };
  }
}

/**
 * Answers init: `start` keeps the session a mode for new work opens, and `recover` says the runtime only stops and
 * closes what its journal holds.
 */
export function offer({ serving, adder, start, recover }: { serving: Serving; adder: InstanceAdder; start(session: Session): void; recover(): void }): (request: Extract<RuntimeRequest, { type: 'init' }>) => Promise<void> {
  const { options, write, notice } = serving;
  // In a T3 thread, T3 sets CLAUDE_CONFIG_DIR or CODEX_HOME to the home of that thread's instance: a fact of the
  // thread, not a home teamai gives a tool.
  const toolHomeEnv = options.startedFrom === undefined ? options.env : {};

  // teamai quotes a keyed option failure (`key` set) inside a sentence of its own and ends it, so it brings no full stop.
  const init = async (request: Extract<RuntimeRequest, { type: 'init' }>): Promise<void> => {
    if (request.mode === 'recover') {
      recover();
      write({ type: 'init', ok: true, can: {} });

      return;
    }

    const parsed = parseOptions(request.options);

    if (!parsed.ok) {
      write({ type: 'init', ok: false, error: parsed.failure });

      return;
    }

    const homeEnv = request.homeEnv ?? {};
    const toolHomeOf = (instance: ServedTool, driver: Driver): string => teamaiToolHome({ instance, driver, home: options.home, homeEnv: homeEnv[instance.tool] ?? [], env: toolHomeEnv, cwd: options.cwd });

    // A check connects to nothing: it runs no step, so it adds no project or provider instance and starts no sign-in.
    if (request.mode === 'check') {
      const can = await options.canStart({ access: parsed.options.runtime_mode === 'full-access' ? 'full-access' : 'auto' });

      write(can.ok ? { type: 'init', ok: true, prompt: true, conversations: true, can: { exec: false, env: false } } : { type: 'init', ok: false, error: can.error });

      return;
    }

    // The checkout whose project's settings the offer follows.
    const checkout = request.checkout ?? options.cwd;
    const unanswered = (): void => write({ type: 'init', ok: false, error: { code: 't3_unavailable', message: `T3 Code did not answer what it runs within ${INIT_WAIT_MS / 1_000} s. Check that T3 Code is open and responding, then start the workflow again.` } });
    const answerBy = Date.now() + INIT_WAIT_MS;
    const connecting = options.connect({ mode: request.mode, access: parsed.options.runtime_mode === 'full-access' ? 'full-access' : 'auto' });
    const reaching = request.mode === 'attended' ? { answered: true as const, value: await connecting } : await within(connecting, INIT_WAIT_MS);

    if (!reaching.answered) {
      // A connection that comes after init failed is closed, not kept.
      void connecting.then((late) => (late.ok ? late.t3.close() : undefined)).catch(() => {});

      return unanswered();
    }

    const connected = reaching.value;

    if (!connected.ok) {
      write({ type: 'init', ok: false, error: connected.error });

      return;
    }

    try {
      const asking = await within(Promise.all([connected.t3.environment(), connected.t3.providers(), projectAt(connected.t3, checkout), readThreadModel(connected.t3, options.startedFrom), canWake(connected.t3)]), Math.max((request.mode === 'attended' ? Date.now() + INIT_WAIT_MS : answerBy) - Date.now(), 0));

      if (!asking.answered) {
        void connected.t3.close().catch(() => {});

        return unanswered();
      }

      const [environment, providers, here, fromThread, wakes] = asking.value;
      const old = tooOld(environment);

      if (old !== undefined) {
        void connected.t3.close().catch(() => {});
        write({ type: 'init', ok: false, error: { code: 't3_version', message: old } });

        return;
      }

      const settings = readSettings(options.t3Home);
      const project = projectSettings(settings, here);

      if (fromThread?.ok === false) notice(`teamai could not read the T3 thread ${fromThread.threadId} this run was started from (${fromThread.why}), so a step that names no tool or model runs on your T3 Code default instead.`, {});
      const read = fromThread?.ok ? fromThread.selection : undefined;
      // The member's own default stays T3's to apply, with its options and the member's fallback.
      const fromThreadModel = read?.instanceId === project.defaultModel?.instanceId && read?.model === project.defaultModel?.model ? undefined : read;
      const binaryPathOf = (instanceId: string): string | undefined => settings.providerInstances?.[instanceId]?.config?.binaryPath?.trim() || undefined;

      // The tool instances teamai gave, and each tool `instances` maps to a provider instance of its own.
      const mapped = parsed.options.instances;
      const named = [...request.instances ?? [], ...Object.keys(mapped ?? {}).filter((name) => driverOf(name) !== undefined).map((tool) => ({ name: tool, tool }))];
      const homeOf = (provider: Provider, driver: Driver): string => instanceToolHome(settings, { instanceId: provider.providerInstanceId, driver, userHome: options.t3UserHome });

      const served = servedInstances({
        instances: named, mapped, homeEnv,
        lookup: {
          providers, binaryPathOf, homeOf,
          isUsable: (provider) => (provider.constraints ?? []).length === 0 && project.instanceEnabled(provider.providerInstanceId) !== false,
          homeFor: toolHomeOf,
          shown: (home) => tilde(home, options.home),
        },
      });

      const instancesFor = (defaultModel: ModelSelection | undefined) => instancesOf({ providers, instance: parsed.options.instance, project, defaultModel, binaryPathOf });
      const viaThread = fromThreadModel && instancesFor(fromThreadModel);
      // A run started from a thread runs as that thread does, when the thread's instance is one that runs a step here;
      // else as the member's own new threads in this project.
      const runsThread = viaThread?.ok === true && [...viaThread.instances.values(), ...served.served.values()].some((provider) => provider.providerInstanceId === fromThreadModel?.instanceId);
      const threadModel = runsThread ? fromThreadModel : undefined;
      const defaultModel = threadModel ?? project.defaultModel;
      const instances = runsThread && viaThread ? viaThread : instancesFor(defaultModel);

      if (!instances.ok) {
        write({ type: 'init', ok: false, error: instances.failure });

        return;
      }

      const toAdd = adder.toBeAdded({ missing: served.missing, settings });
      const unavailable = { ...Object.fromEntries(Object.entries(served.unavailable)), ...toAdd.reasons };

      // A step that never names a misspelt key would never show its reason.
      for (const message of served.notices) notice(message, {});

      // T3 runs an instance in its provider instance's home, where it signs in and keeps its sessions.
      for (const instance of request.instances ?? []) {
        const provider = served.served.get(instance.name);
        const driver = provider && driverOfProvider(provider);

        if (!provider || !driver) continue;
        const theirs = homeOf(provider, driver);
        const ours = toolHomeOf(instance, driver);

        if (theirs !== ours) {
          // `~` names one home only when T3 Code's user and teamai share it; else "~/.claude" would read the same twice.
          const shown = (home: string, user: string): string => (options.t3UserHome === options.home ? tilde(home, user) : home);
          notice(`T3 Code provider instance "${provider.providerInstanceId}" runs ${instance.name} in ${shown(theirs, options.t3UserHome)}, while teamai gives ${instance.name} the home ${shown(ours, options.home)}: on T3 it signs in and keeps its sessions there. To use the same home, set the instance's Home path in T3 Code under Settings → Providers to ${shown(ours, options.home)}.`, {});
        }
      }

      // A tool `instances` maps to an instance that cannot run it is not offered on its default instance instead.
      const runs = new Map<string, Provider>([...instances.instances, ...served.served].filter(([tool]) => unavailable[tool] === undefined));

      // Every tool it runs is Claude or Codex, whose transcript on this machine (T3 runs only in environment: local)
      // records the tokens each step billed, in a folder of the home T3 runs it in. One teamai cannot list, as the store of
      // a T3 Code that runs as another user, would leave a step without its tokens.
      const sessionHomes = [
        ...[...runs.values()].flatMap((provider) => {
          const driver = driverOfProvider(provider);

          return driver ? [{ driver, home: homeOf(provider, driver) }] : [];
        }),
        ...[...toAdd.pending.values()].map(({ driver, homePath }) => ({ driver, home: homePath ?? path.join(options.t3UserHome, DRIVERS[driver].home) })),
      ];

      const offersTokens = sessionHomes.every(({ driver, home }) => canListStore(driver, home));
      start({ t3: connected.t3, mode: request.mode, environment, instances: runs, pending: toAdd.pending, runtimeMode: parsed.options.runtime_mode, signIn: connected.signIn, checkout, threadModel, offersTokens, homeEnv });
      // An instance teamai adds on its first open is offered as well: the open adds it, or fails saying why.
      const tools = [...runs.keys(), ...toAdd.pending.keys()];
      // A step that names no tool runs on the member's effective T3 default, or the started-from thread's, when its instance is the one offered.
      // When that instance runs a wrapper no tool instance here runs, its provider's own tool, which runs on its own instance.
      const defaultProvider = providers.find((provider) => provider.providerInstanceId === defaultModel?.instanceId && (provider.constraints ?? []).length === 0);
      const defaultDriver = defaultProvider && driverOfProvider(defaultProvider);
      const onWrapper = defaultProvider !== undefined && defaultDriver !== undefined && !runsOwnBinary(binaryPathOf(defaultProvider.providerInstanceId), defaultDriver);
      const defaultTool = [...runs].find(([, provider]) => provider === defaultProvider)?.[0] ?? (onWrapper && runs.has(DRIVERS[defaultDriver].tool) ? DRIVERS[defaultDriver].tool : undefined);
      write({
        type: 'init', ok: true, prompt: true, conversations: true, confinedPrompt: true,
        // A fleet member it launches on a machine linked to this T3 Code.
        ...(wakes && { wake: true }),
        // Full access is the member's opt-in, and teamai records the isolation of these steps as none.
        ...(parsed.options.runtime_mode === 'full-access' && tools.length > 0 && { permissions: Object.fromEntries(tools.map((tool) => [tool, 'full-access' as const])) }),
        ...(Object.keys(unavailable).length > 0 && { unavailable }),
        can: {
          exec: false, setup: false, env: false, hitl: request.mode === 'attended', tokens: offersTokens, unattended: false, max_turns: false,
          // No role: a T3 thread runs its tool in the provider instance's own home, with the member's own resources, and
          // this runtime cannot point it at the tool home teamai delivers a role into.
          workspace: ['read-only', 'new', 'continue', 'clone', 'team'], tools, ...(defaultTool && { default_tool: defaultTool }),
          ...(tools.length > 0 && { confined: [{ ...JUDGE_KEPT, tools }] }),
        },
      });
    } catch (error) {
      write({ type: 'init', ok: false, error: { code: 't3_unavailable', message: `T3 Code did not answer what it runs: ${error instanceof Error ? error.message : String(error)}` } });
    }
  };

  return init;
}
