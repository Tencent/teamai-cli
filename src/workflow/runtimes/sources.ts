import path from 'node:path';
import { z } from 'zod';
import type { RunMode } from '../../launch-context.js';
import { type LocalConfig } from '../../types.js';
import type { DriverCan } from '../requirements.js';
import type { WorkflowFailure } from '../types.js';
import { resolveDriver, SANDBOX_RUNTIME, type DriverDefinition, type ResolvedDriver } from './definitions.js';
import { acceptRuntime, fixOf, isRuntimeAccepted, locateRuntime, pinRuntime } from './locate.js';
import { DEFAULT_PROFILE, locateSandboxProfile, pinSandboxProfile, sandboxOptions, type SandboxProfile } from './sandbox-profiles.js';
import { LOCAL_DRIVER } from '../driver-name.js';
import { fleetStepRuntime, shadowedFleetEntries, type OpenWake } from '../fleet/owner.js';
import { log } from '@teamai/shared/log';
import { warnOnce } from '../../utils/warn-once.js';
import { stdioStepRuntime } from './stdio.js';
import { type InitHomeEnv, type InitInstance, type RuntimeFailure, type RuntimeOptions } from '@teamai/runtime-protocol';
import { acceptToolCommand } from '../../tool-instances.js';
import { instanceHomeDir } from '../../tool-home.js';
import { baseToolOf, toolInstancesFor } from '../../tool-registry.js';
import { type StepRuntime } from '@teamai/runtime-protocol/step-runtime';
import { composedName, composedOffer, composedStepRuntime, nestedOptions } from './composed.js';
import { credentialSecrets, isExecRuntimeTool, type ExecRuntimeTool, type RuntimeOrigin } from './attempt.js';
import { LOGIN_TOOLS, type LoginTool } from './login.js';
import type { SignInVariables } from '@teamai/tool-core/launch';
import { executableOf, isLaunchTool, LAUNCH_ORDER, launchAdapterIdOf, launchAdapterOf, toolCommandEnv } from '../../launch-registry.js';
import type { StepLaunchDeps } from '@teamai/runtime-tools';
import { opencodeMajorVersion } from '../../opencode-version.js';
import { agyGatewayEnv } from '../../models/agy-gateway.js';
import { AttemptResult } from '../attempt-result.js';

// ─── Opening a driver's runtimes ─────────────────────────
//
//  Each runtime of a definition is found (`locate.ts`), accepted when it is the team's, started, and given its options.
//

/**
 * What the `tools` runtime's launch reads from teamai, which its package cannot import: the OpenCode version, the agy
 * gateway, the masked result write, and each tool's step profile with the command that starts it.
 */
const TOOLS_LAUNCH: StepLaunchDeps = {
  host: { opencodeMajor: opencodeMajorVersion, agyGatewayEnv, writeResult: AttemptResult.write },
  stepTool: (tool) => (isLaunchTool(tool) ? { family: launchAdapterIdOf(tool), step: launchAdapterOf(tool).step, command: executableOf(tool) } : undefined),
};

/** What every launch of the `tools` runtime reads from teamai. */
export function toolsLaunchDeps(): StepLaunchDeps {
  return TOOLS_LAUNCH;
}

/** An environment variable's name, as a credential's name and the variable it is read from are written. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** How a credential's value is given: `env:<VARIABLE>`, read from the member's environment at start. */
const FROM_ENV = z.templateLiteral(['env:', z.string().regex(ENV_NAME)]);

const CREDENTIALS_TAKE = `credentials take ${LOGIN_TOOLS.map((known) => `${known}: login`).join(', ')}, the login teamai keeps for that tool, or NAME: env:VARIABLE, a value read from your environment`;

/** One credential entry: a login teamai keeps for a tool, or a value the member's environment gives under a name. */
const CredentialSchema = z.union([
  z.tuple([z.enum(LOGIN_TOOLS), z.literal('login')]).transform(([tool]) => ({ kind: 'login' as const, tool })),
  z.tuple([z.string().regex(ENV_NAME), FROM_ENV]).transform(([name, from]) => ({ kind: 'env' as const, name, variable: from.slice('env:'.length) })),
]);

/**
 * What teamai itself reads of a runtime entry's options; every other key goes to the runtime at `init`, which
 * validates it. `max_parallel` caps the runtime's own open attempts; `credentials` names the logins and the values it brings.
 */
const EngineOptionsSchema = z.object({
  max_parallel: z.number().int().min(1, 'max_parallel is a whole number of attempts, 1 or more').optional(),
  credentials: z.record(z.string(), z.string()).optional(),
});

export interface EngineOptions {
  maxParallel?: number;
  logins: LoginTool[];
}

/** A credential a runtime entry declares from the member's environment: the name its processes get, and the variable it is read from. */
export interface EnvCredential {
  name: string;
  variable: string;
}

/**
 * Splits `options` into what teamai reads and what the runtime gets, or names the first key teamai refuses. Engine
 * keys never reach the runtime: they are stripped before `init`.
 */
export function engineOptions(options: RuntimeOptions): { ok: true; engine: EngineOptions; credentials: EnvCredential[]; runtime: RuntimeOptions } | { ok: false; key: string; message: string } {
  const parsed = EngineOptionsSchema.safeParse(options);

  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    const key = issue?.path.join('.') || 'credentials';

    return { ok: false, key, message: key.startsWith('credentials') ? CREDENTIALS_TAKE : issue?.message ?? 'not valid' };
  }

  const { max_parallel: maxParallel, credentials, ...runtime } = { ...options, ...parsed.data };
  const entries: Array<z.output<typeof CredentialSchema>> = [];

  for (const entry of Object.entries(credentials ?? {})) {
    const credential = CredentialSchema.safeParse(entry);

    if (!credential.success) return { ok: false, key: `credentials.${entry[0]}`, message: CREDENTIALS_TAKE };
    entries.push(credential.data);
  }

  const engine: EngineOptions = { logins: entries.flatMap((entry) => (entry.kind === 'login' ? [entry.tool] : [])) };

  if (maxParallel !== undefined) engine.maxParallel = maxParallel;

  return { ok: true, engine, credentials: entries.flatMap((entry) => (entry.kind === 'env' ? [{ name: entry.name, variable: entry.variable }] : [])), runtime };
}

/**
 * The values of `credentials`, read from `env` once, at start, and held in memory only: never written to a record, a
 * log or runtime.json. Fails naming the first variable that is unset.
 */
function credentialValues(driver: ResolvedDriver, use: string, credentials: EnvCredential[], env: NodeJS.ProcessEnv): { ok: true; values: Record<string, string> } | { ok: false; failure: WorkflowFailure } {
  const values: Record<string, string> = {};

  for (const { name, variable } of credentials) {
    const value = env[variable];

    if (value === undefined || value === '') {
      return {
        ok: false,
        failure: { code: 'credential_missing', message: `Runtime "${use}" of driver definition ${driver.location} declares credential ${name}: env:${variable}, and ${variable} is not set in your environment. Set ${variable}, then start again.` },
      };
    }

    values[name] = value;
  }

  return { ok: true, values };
}

/** The values of `credentials` that `env` sets, by name, skipping those it does not: for masking only. */
function valuesSet(credentials: EnvCredential[], env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(credentials.flatMap(({ name, variable }) => (env[variable] ? [[name, env[variable]]] : [])));
}

/** The sign-in variables of each tool an exec runtime launches: its launch must name every one. */
const SIGN_INS: Readonly<Record<ExecRuntimeTool, SignInVariables>> = {
  claude: launchAdapterOf('claude').signIn,
  codex: launchAdapterOf('codex').signIn,
  codebuddy: launchAdapterOf('codebuddy').signIn,
};

/** A tool's sign-in variables and those that go with them. */
function variablesOf({ variables, alongside = [] }: SignInVariables): string[] {
  return [...variables, ...alongside];
}

/**
 * `credentials` as the process of `tool` gets them: a sign-in variable teamai found by name (`found`) goes only to the
 * tool it signs in, so a Claude exec never gets the member's OpenAI key. Declared credentials go to every tool.
 */
export function credentialsForTool(credentials: Record<string, string>, found: readonly string[], tool: string): Record<string, string> {
  // An instance signs in as the tool it extends.
  const base = baseToolOf(tool);
  const own = new Set(isExecRuntimeTool(base) ? variablesOf(SIGN_INS[base]) : []);

  return Object.fromEntries(Object.entries(credentials).filter(([name]) => !found.includes(name) || own.has(name)));
}

/** The values of the tools' sign-in variables set in `env`, by name, with those that go with a sign-in found. */
function signInsFound(env: NodeJS.ProcessEnv): Record<string, string> {
  const isSet = (name: string): boolean => (env[name] ?? '') !== '';
  const names = Object.values(SIGN_INS).flatMap((signIn) => (signIn.variables.some(isSet) ? variablesOf(signIn) : []));

  return Object.fromEntries(names.filter(isSet).sort().map((name) => [name, env[name] ?? '']));
}

/**
 * One runtime of an opened definition: `kind: 'tools'`, the tools runtime in teamai's process, which the loop builds itself with
 * the tools it found for the run, by the name the definition gives it (`local` is `tools` too); or an external one
 * that took its options.
 */
export type OpenedRuntime =
  | { kind: 'tools'; use: 'tools' | 'local'; engine: EngineOptions }
  /**
   * `launchesAgents`: prompt steps reach it as `prompt`, and it gives each tool its own home. `credentials`: the values
   * of the credentials it declares from the member's environment, by name, in memory only. `masks`: the values its
   * notices are masked with, by label: those credentials', and each team secret the drive adds once it resolves it.
   * `found`: the names among `credentials` teamai found in the member's environment rather than the definition declared,
   * which go only to the tool each signs in (`credentialsForTool`). `unavailable`: the tools it cannot run now, with why.
   * `optionsFrom`: where its options were set, for the person: the definition's file, and the member's config when it sets them too.
   * `wakes`: its init offered to wake fleet members, which a fleet entry's `wake` names it for.
   * `keepsConversations`: its init said a prompt's conversation outlives the prompt in its place, so teamai may hold the place for a later step.
   * `runsOnToolHome`: its init said it runs each prompt's tool in the attempt's tool home, which teamai seeds, copies a login into and reads sessions in.
   * `sources`: where the runtimes it runs on came from, which each attempt on it records; none for the built-in `fleet`.
   */
  | { kind: 'external'; use: string; runtime: StepRuntime<DriverCan>; can: DriverCan; launchesAgents: boolean; engine: EngineOptions; credentials: Record<string, string>; found: string[]; masks: Record<string, string>; optionsFrom: string; unavailable?: Record<string, string>; isThrough?: true; wakes?: true; keepsConversations?: true; runsOnToolHome?: true; sources?: RuntimeOrigin[] }
;

/**
 * A driver definition ready to drive: each of its runtimes, in definition order, none for the built-in `host`. The
 * caller disposes them once the drive ends.
 */
export interface OpenedDriver {
  driver: ResolvedDriver;
  /** The name the definition was asked for, such as `t3` for the shipped `teamai-t3`: what a person types again. */
  asked: string;
  runtimes: OpenedRuntime[];
}

/** Ends the connection to each external runtime of `opened`. */
export async function disposeDriver(opened: OpenedDriver): Promise<void> {
  await Promise.all(opened.runtimes.map((entry) => (entry.kind === 'external' ? entry.runtime.dispose() : undefined)));
}

/**
 * The options the definition gives runtime `use`, with the member's `workflows.drivers.<driver>.runtimes.<use>` from
 * user and workspace config over them, key by key.
 */
function entryOptions(driver: ResolvedDriver, use: string, given: RuntimeOptions | undefined): RuntimeOptions {
  return { ...given, ...driver.config.workflows?.drivers?.[driver.name]?.runtimes?.[use] };
}

/** Where runtime `use` of `driver` got its options: the definition's file, and the member's config when it sets them too. */
function optionsSource(driver: ResolvedDriver, use: string): string {
  return driver.config.workflows?.drivers?.[driver.name]?.runtimes?.[use] === undefined ? driver.location : `${driver.location} or your workflows.drivers.${driver.name}.runtimes.${use}`;
}

/** Whether the options of `driver`'s `use` entry come only from a definition the member or the team keeps. */
function isEntryEditable(driver: ResolvedDriver, use: string): boolean {
  return (driver.source === 'team' || driver.source === 'personal') && driver.config.workflows?.drivers?.[driver.name]?.runtimes?.[use] === undefined;
}

/** What the sandbox runtime refused of the profile its options came from, naming the profile's file. */
function profileRefused(profile: SandboxProfile, key: string, message: string): WorkflowFailure {
  // teamai's own profiles are examples to name or copy, so the fix is the member's or the team's profile, not teamai.
  const fix = profile.layer === 'teamai'
    ? `teamai ships it as an example: add sandboxes/${profile.asked}.yaml to the team repo with ${key} set and run teamai pull, or add ~/.teamai/sandboxes/${profile.asked}.yaml for yourself, and start again.`
    : fixOf(profile.layer);

  return { code: 'bad_option', message: `Sandbox profile ${profile.location} refused option "${key}": ${message}. ${fix}` };
}

/** What an attempt's record says of the sandbox profile its sandbox runtime ran, and what its init said it enforces. */
function sandboxRecord(profile: SandboxProfile, can: DriverCan): NonNullable<RuntimeOrigin['sandbox']> {
  const { isolation, network, tokens, max_turns: maxTurns } = can;
  const enforces = { ...(isolation !== undefined && { isolation }), ...(network !== undefined && { network }), ...(tokens !== undefined && { tokens }), ...(maxTurns !== undefined && { max_turns: maxTurns }) };

  return { profile: profile.resource, layer: profile.layer, location: profile.location, revision: profile.revision, provider: String(profile.options['provider']), enforces };
}

function badOption(driver: ResolvedDriver, use: string, key: string, message: string): WorkflowFailure {
  return { code: 'bad_option', message: `Runtime "${use}" of driver definition ${driver.location} refused option "${key}": ${message}. Fix the option and start again.` };
}

/**
 * Why a definition is opened: `run` runs steps, so the values of its `env:` credentials are read and fail it when unset;
 * `stop` only stops and closes attempts, which bring no credential, so a cancel works in a shell without them. A runtime
 * opened to stop is opened in `recover` mode, which runs no sign-in or tool check and answers only for the handles it
 * recorded, so a provider that is down or stalls cannot hold the stop; only one that refuses that mode is opened for new
 * work instead. `check` only asks whether a run could start on it now: each runtime gets `init` in `check` mode and
 * nothing more, so it signs in nothing, writes nothing and launches nothing; one that refuses the mode, as an older one
 * does, fails the check. A credential variable left unset fails it as it would the run, and a team runtime no one
 * accepted here is not asked about.
 */
export type DriverPurpose = 'run' | 'stop' | 'check';

/**
 * The tool instances the member may run, as `init` gives them: their own, and the team's whose command needs no
 * acceptance or was accepted on this machine. A file that only adjusts a shipped tool's paths is no instance: a step
 * names that tool, which the runtime already serves. A runtime lists in `can.tools` the ones it can serve.
 */
async function runnableInstances(): Promise<InitInstance[]> {
  const instances = toolInstancesFor('use').filter((declared) => declared.kind === 'instance');
  const accepted = await Promise.all(instances.map(async (instance) => (await acceptToolCommand(instance, { ask: undefined })).ok));

  return instances.filter((_, index) => accepted[index]).map((instance) => {
    // Resolved once, here, and absolute, a relative value from where teamai runs: a runtime uses this home and never resolves one of its own.
    const home = instance.home && path.resolve(instanceHomeDir({ name: instance.name, home: instance.home }));

    return {
      name: instance.name, tool: instance.extends,
      ...(instance.command !== undefined && { command: instance.command }),
      ...(home !== undefined && { home: { dir: home } }),
      ...(instance.paths && { paths: instance.paths }),
    };
  });
}

/**
 * Every variable each tool's command reads its home from, for every tool teamai launches and every instance `init` gives:
 * what teamai sets on that command started in a home (`toolCommandEnv`), the one decision a runtime applies as given.
 */
export function homeEnvOf(instances: readonly InitInstance[]): InitHomeEnv {
  return Object.fromEntries([...LAUNCH_ORDER, ...instances.map(({ name }) => name)].map((name) => [name, Object.keys(toolCommandEnv(name, { kind: 'at', dir: '' }))]));
}

/**
 * The built-in `fleet` runtime of `driver`: each command or prompt step it takes is offered to the members of its pool on
 * teamai-reports, and one of them runs it with its own driver (`fleet/owner.ts`). Its `can` is what the definition
 * promises the members' drivers give: nothing checks it here. The runtime its `wake` option names is opened on its own,
 * never through another, with that entry's options under the member's config for it, as a runtime of the definition is.
 */
async function fleetRuntime(driver: ResolvedDriver, split: Extract<ReturnType<typeof engineOptions>, { ok: true }>, how: { mode: RunMode; canAsk: boolean; purpose: DriverPurpose; checkout: string }): Promise<{ ok: true; opened: OpenedRuntime } | { ok: false; failure: WorkflowFailure }> {
  if (split.credentials.length > 0 || split.engine.logins.length > 0) return { ok: false, failure: badOption(driver, 'fleet', 'credentials', 'each member runs a step with its own driver, so fleet brings no credential') };
  const masks: Record<string, string> = {};

  const openWake: OpenWake = async ({ use, options }) => {
    const opened = await openRuntime(driver, { use, options: entryOptions(driver, use, options) }, how);

    if (!opened.ok) return opened;

    if (opened.opened.kind !== 'external') return { ok: false, failure: { code: 'bad_option', message: `${use} runs in teamai's own process and wakes no fleet member: name a runtime that does, such as t3` } };

    return { ok: true, runtime: opened.opened.runtime, wakes: opened.opened.wakes === true };
  };

  const runtime = fleetStepRuntime({ config: driver.config, masks, openWake });
  const mode = how.purpose === 'stop' ? 'recover' : how.purpose === 'check' ? 'check' : how.mode;
  const ready = await runtime.init({ options: split.runtime, mode, homeEnv: homeEnvOf([]), checkout: how.checkout });

  if (!ready.ok) return { ok: false, failure: badOption(driver, 'fleet', ready.failure.key ?? 'pool', ready.failure.message) };

  return { ok: true, opened: { kind: 'external', use: 'fleet', runtime, can: ready.can, launchesAgents: ready.launchesAgents, engine: split.engine, credentials: {}, found: [], masks, optionsFrom: optionsSource(driver, 'fleet') } };
}

/** What a runtime answers a check it cannot settle without starting something, as the sandbox runtime does once its provider answers. */
const CANNOT_TELL = 'check_unsupported';

/** Opens one runtime of `driver`: finds it, refuses a team runtime no one accepted here, starts it and passes its options. */
async function openRuntime(driver: ResolvedDriver, { use, options, sandbox }: { use: string; options: RuntimeOptions; sandbox?: string }, { mode, canAsk, purpose, checkout }: { mode: RunMode; canAsk: boolean; purpose: DriverPurpose; checkout: string }): Promise<{ ok: true; opened: OpenedRuntime } | { ok: false; failure: WorkflowFailure }> {
  const split = engineOptions(options);

  if (!split.ok) return { ok: false, failure: badOption(driver, use, split.key, split.message) };

  if (use === 'fleet') return fleetRuntime(driver, split, { mode, canAsk, purpose, checkout });
  // The sandbox runtime takes its provider's options from the sandbox profile the entry names, checked before its
  // program is found: a misplaced option is the member's to fix wherever the program is. A stop of what an attempt
  // started on options given inline, by a teamai that took them, reaches its sandbox on those options. A stop needs no
  // profile: the runtime keeps the options each place was opened with, so one gone or broken since stops nothing.
  const isStoppingInline = purpose === 'stop' && Object.keys(split.runtime).length > 0;
  const profiled = use === SANDBOX_RUNTIME && !isStoppingInline ? await sandboxOptions({ driver, named: sandbox, given: split.runtime, from: optionsSource(driver, use), isEntryEditable: isEntryEditable(driver, use) }) : undefined;

  if (profiled?.ok === false && purpose !== 'stop') return profiled;
  const located = await locateRuntime(driver, use);

  if (!located.ok) return located;
  const { source } = located;

  if (source.kind === 'builtin') {
    const [key] = Object.keys(split.runtime);

    if (key !== undefined) return { ok: false, failure: badOption(driver, use, key, `The ${use} runtime takes no options, and was given "${key}".`) };

    if (split.engine.logins.length > 0) return { ok: false, failure: badOption(driver, use, 'credentials', `${use} runs each tool in the member's own home, so it brings no login`) };

    if (split.credentials.length > 0) return { ok: false, failure: badOption(driver, use, 'credentials', `${use} runs each step in the member's own environment, so it brings no credential`) };

    return { ok: true, opened: { kind: 'tools', use: use === 'local' ? 'local' : 'tools', engine: split.engine } };
  }

  // A check fails as the run would for an unset variable, and sends no value.
  const values = purpose === 'stop' ? { ok: true as const, values: {} } : credentialValues(driver, use, split.credentials, process.env);

  if (!values.ok) return values;
  // What is accepted is the copy it runs from, which no pull changes while it runs.
  const pinned = await pinRuntime(source, { config: driver.config });

  if (!pinned.ok) return pinned;
  const runs = pinned.source;
  const accepted = await acceptRuntime(runs, purpose === 'check' ? { mode: 'unattended', canAsk: false } : { mode, canAsk });

  if (!accepted.ok) {
    await pinned.remove();

    return accepted;
  }

  // What the sandbox builds from is the copy whose revision the record names, which no pull changes while it runs. A
  // stop builds nothing.
  const built = profiled?.ok === true && purpose !== 'stop' ? await pinSandboxProfile(driver, profiled.profile) : undefined;

  if (built?.ok === false) {
    await pinned.remove();

    return built;
  }

  const initOptions = built?.options ?? (profiled?.ok === true ? profiled.options : split.runtime);
  const profile = built?.profile ?? (profiled?.ok === true ? profiled.profile : undefined);
  const origin: RuntimeOrigin = { runtime: source.resource, layer: source.layer, location: source.location, revision: runs.revision };

  // A runtime of the member or the team in place of teamai's own is never taken silently.
  if (purpose === 'run' && source.replaces !== undefined) {
    const whose = source.layer === 'team' ? `Runtime "${use}" of the team` : `Your runtime "${use}"`;
    warnOnce(`${whose} (${source.location}, revision ${runs.revision.slice(0, 12)}) replaces teamai's.`);
  }

  if (purpose === 'run' && profile?.replaces !== undefined) {
    const whose = profile.layer === 'team' ? `Sandbox profile "${profile.asked}" of the team` : `Your sandbox profile "${profile.asked}"`;
    warnOnce(`${whose} (${profile.location}, revision ${profile.revision.slice(0, 12)}) replaces teamai's.`);
  }

  const isDeclaring = split.credentials.length > 0 || split.engine.logins.length > 0;
  const found = purpose === 'run' && !isDeclaring ? signInsFound(process.env) : {};

  // What the runtime tells the person is shown with the values of the credentials it gets masked, and with the team's
  // secrets, which the drive adds here as it resolves them (`masks`). A stop sends no credential, but still masks with
  // the values the member's environment holds for them, which what the attempt left may echo.
  const masks = credentialSecrets(source.name, { ...values.values, ...found, ...(purpose === 'stop' && valuesSet(split.credentials, process.env)) });

  const spawned = (): StepRuntime<DriverCan> => (runs.launch.kind === 'node'
    ? stdioStepRuntime({ name: source.name, command: process.execPath, args: [runs.launch.file], cwd: checkout, secrets: masks })
    : stdioStepRuntime({ name: source.name, command: runs.launch.executable, cwd: checkout, secrets: masks }));

  // Whoever disposes the runtime this returns, or that fails here, removes the copy it ran from.
  const removingCopy = (runtime: StepRuntime<DriverCan>): StepRuntime<DriverCan> => ({
    ...runtime,
    dispose: async () => {
      try {
        await runtime.dispose();
      } finally {
        await Promise.all([pinned.remove(), built?.remove()]);
      }
    },
  });

  let notRecovered: RuntimeFailure | undefined;

  if (purpose === 'stop') {
    const recovering = spawned();
    const recovered = await recovering.init({ options: initOptions, mode: 'recover', homeEnv: homeEnvOf([]), checkout });

    // It offers nothing in this mode: it is asked only to stop, collect and close what it ran.
    if (recovered.ok) return { ok: true, opened: { kind: 'external', use, runtime: removingCopy(recovering), can: recovered.can, launchesAgents: recovered.launchesAgents, ...(recovered.keepsConversations && { keepsConversations: true }), ...(recovered.runsOnToolHome && { runsOnToolHome: true }), engine: split.engine, credentials: {}, found: [], masks, optionsFrom: optionsSource(driver, use), sources: [origin] } };
    await recovering.dispose();
    notRecovered = recovered.failure;
  }

  const runtime = removingCopy(spawned());
  const credentials = { env: [...split.credentials.map((credential) => credential.name), ...Object.keys(found)], logins: split.engine.logins };

  const instances = await runnableInstances();

  const ready = await runtime.init({
    options: initOptions, mode: purpose === 'check' ? 'check' : mode, credentials, instances, homeEnv: homeEnvOf(instances), checkout,
  });

  // A runtime that runs each tool on the attempt's tool home gets the login there, as an exec runtime does.
  if (ready.ok && ready.launchesAgents && ready.runsOnToolHome !== true && split.engine.logins.length > 0) {
    await runtime.dispose();

    return { ok: false, failure: badOption(driver, use, 'credentials', `${use} launches agents its own way, in each tool's own home, so it brings no login`) };
  }

  // A credential is a value of the environment: only a runtime that controls its processes' environment keeps it to them.
  if (ready.ok && split.credentials.length > 0 && ready.can.env !== true) {
    await runtime.dispose();

    return { ok: false, failure: badOption(driver, use, 'credentials', `${use} does not offer can.env, so it cannot keep a credential to the processes it is for`) };
  }

  // A run that needs no AI tool skips a runtime by this declaration, so one its init contradicts is never trusted.
  if (ready.ok && source.exec === false && ready.can.exec !== false) {
    await runtime.dispose();

    return {
      ok: false,
      failure: { code: 'runtime_failed', message: `Runtime "${source.name}" of driver "${driver.name}" declares exec: false in ${source.marker}, but its init does not offer can.exec: false, so it runs commands. A run that needs no AI tool would skip it and run its commands on the host. Make the two agree.` },
    };
  }

  if (ready.ok && !ready.launchesAgents && ready.can.exec === false) {
    await runtime.dispose();

    return {
      ok: false,
      failure: { code: 'runtime_failed', message: `Runtime "${source.name}" of driver "${driver.name}" runs no command and takes no prompt (its init offers can.exec: false without prompt: true), so it can run no step. Fix the runtime's offer, or remove it from the definition.` },
    };
  }

  if (ready.ok) {
    // A runtime may name an instance in ownLogins: its login is the tool's it extends, as its sign-in is.
    const ownLogins = new Set((ready.ownLogins ?? []).map(baseToolOf));
    // A login the runtime's provider keeps itself is not copied into an attempt's tool home over it.
    const engine = { ...split.engine, logins: split.engine.logins.filter((tool) => !ownLogins.has(tool)) };

    // A sign-in found by name reaches only a runtime that runs the tool on teamai's environment and keeps a value to it:
    // one that execs it, or runs it on the attempt's tool home. One that launches agents its own way signs them in where
    // it runs them, so it gets none, rather than the start failing over it.
    const isKeepingFound = (!ready.launchesAgents || ready.runsOnToolHome === true) && ready.can.env === true;
    // A tool whose login the runtime's provider keeps signs in on that login, before the member's own route: the
    // credentials their config declares, then what their environment holds. The definition's own credential still goes.
    const ownLoginVariables = new Set(Object.entries(SIGN_INS).flatMap(([tool, signIn]) => (ownLogins.has(tool) ? variablesOf(signIn) : [])));
    const notOwnLogin = (given: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(given).filter(([name]) => !ownLoginVariables.has(name)));
    const foundHere = notOwnLogin(found);
    const isMemberRoute = driver.config.workflows?.drivers?.[driver.name]?.runtimes?.[use]?.credentials !== undefined;
    const declared = isMemberRoute ? notOwnLogin(values.values) : values.values;
    const given = isKeepingFound ? { ...declared, ...foundHere } : declared;

    return { ok: true, opened: { kind: 'external', use, runtime, can: ready.can, launchesAgents: ready.launchesAgents, engine, credentials: given, found: isKeepingFound ? Object.keys(foundHere) : [], masks, optionsFrom: optionsSource(driver, use), sources: [profile ? { ...origin, sandbox: sandboxRecord(profile, ready.can) } : origin], ...(ready.unavailable && { unavailable: ready.unavailable }), ...(ready.wakes && { wakes: true }), ...(ready.keepsConversations && { keepsConversations: true }), ...(ready.runsOnToolHome && { runsOnToolHome: true }) } };
  }

  await runtime.dispose();
  const { failure } = ready;

  const notStarted = failure.code === 'bad_option'
    ? (profile ? profileRefused(profile, failure.key ?? '?', failure.message) : badOption(driver, use, failure.key ?? '?', failure.message))
    // A check says apart a runtime that could not tell from one that said why a run could not start.
    : { code: purpose === 'check' && failure.code === CANNOT_TELL ? CANNOT_TELL : 'runtime_failed', message: `Runtime "${source.name}" of driver "${driver.name}" did not start (${failure.code}): ${failure.message}` };

  if (notRecovered === undefined) return { ok: false, failure: notStarted };

  return { ok: false, failure: { code: notStarted.code, message: `${notStarted.message} It does not open in recover mode either, to stop what it ran (${notRecovered.code}): ${notRecovered.message}` } };
}

/**
 * Opens runtime `names.inner` through `names.outer`, each with the options `options` nests under its name, as one
 * runtime: each is found, accepted and started as a runtime of its own, then the engine reaches both through
 * `composedStepRuntime` with the offer `composedOffer` merges. The prompt's credentials are the outer's, which runs the
 * tool; the inner keeps its own.
 */
async function openComposed(driver: ResolvedDriver, { names, options, sandbox }: { names: { inner: string; outer: string }; options: RuntimeOptions; sandbox?: string }, how: Parameters<typeof openRuntime>[2]): Promise<{ ok: true; opened: OpenedRuntime } | { ok: false; failure: WorkflowFailure }> {
  const name = composedName(names.inner, names.outer);
  const nested = nestedOptions(options, names);

  if (!nested.ok) return { ok: false, failure: badOption(driver, name, nested.key, nested.message) };
  const outer = await openRuntime(driver, { use: names.outer, options: entryOptions(driver, names.outer, nested.outer), ...(names.outer === SANDBOX_RUNTIME && sandbox !== undefined && { sandbox }) }, how);

  if (!outer.ok) return outer;
  const inner = await openRuntime(driver, { use: names.inner, options: entryOptions(driver, names.inner, nested.inner), ...(names.inner === SANDBOX_RUNTIME && sandbox !== undefined && { sandbox }) }, how);

  if (!inner.ok) {
    if (outer.opened.kind === 'external') await outer.opened.runtime.dispose();

    return inner;
  }

  if (outer.opened.kind !== 'external' || inner.opened.kind !== 'external') {
    await Promise.all([outer.opened, inner.opened].map((part) => (part.kind === 'external' ? part.runtime.dispose() : undefined)));

    const builtin = outer.opened.kind === 'external' ? names.inner : names.outer;

    return { ok: false, failure: { code: 'driver_invalid', message: `Driver definition ${driver.location} runs ${names.inner} through ${names.outer}, and ${builtin} runs in teamai's own process: it runs neither through another runtime nor another through it. Fix the file and start again.` } };
  }

  const [outerOpened, innerOpened] = [outer.opened, inner.opened];

  // Only a runtime that launches agents its own way has tools to run through another; one that execs them would run
  // nothing on the inner side, and its steps would run on the outer alone. A stop offers nothing: a runtime in recover
  // mode says it launches nothing, and the entry is opened only to stop and close what it ran.
  if (!innerOpened.launchesAgents && how.purpose !== 'stop') {
    await Promise.all([outerOpened.runtime.dispose(), innerOpened.runtime.dispose()]);

    return { ok: false, failure: { code: 'driver_invalid', message: `Driver definition ${driver.location} runs ${names.inner} through ${names.outer}, and ${names.inner} launches no agents of its own: only a runtime that launches agents, such as an app's, runs its tools through another. Use ${names.outer} on its own, or fix the file, and start again.` } };
  }

  // One that runs each tool itself on the attempt's tool home, as a sandbox does, runs it in its own place, never the outer's.
  if (innerOpened.runsOnToolHome === true && how.purpose !== 'stop') {
    await Promise.all([outerOpened.runtime.dispose(), innerOpened.runtime.dispose()]);

    return { ok: false, failure: { code: 'driver_invalid', message: `Driver definition ${driver.location} runs ${names.inner} through ${names.outer}, and ${names.inner} runs each tool itself, in its own place, on the attempt's tool home: only a runtime that launches agents its own way, such as an app's, runs its tools through another. Use ${names.inner} and ${names.outer} as runtimes of their own, or fix the file, and start again.` } };
  }

  const offer = composedOffer({ ok: true, can: outerOpened.can, launchesAgents: outerOpened.launchesAgents }, { ok: true, can: innerOpened.can, launchesAgents: innerOpened.launchesAgents, ...(innerOpened.unavailable && { unavailable: innerOpened.unavailable }) });
  const caps = [outerOpened.engine.maxParallel, innerOpened.engine.maxParallel].filter((cap) => cap !== undefined);
  const engine: EngineOptions = { ...outerOpened.engine, ...(caps.length > 0 && { maxParallel: Math.min(...caps) }) };

  return {
    ok: true,
    opened: {
      kind: 'external', use: name, runtime: composedStepRuntime({ outer: outerOpened.runtime, inner: innerOpened.runtime, innerCredentials: innerOpened.credentials }),
      can: offer.can, launchesAgents: offer.launchesAgents, engine, credentials: outerOpened.credentials, found: outerOpened.found, masks: { ...outerOpened.masks, ...innerOpened.masks }, optionsFrom: innerOpened.optionsFrom,
      isThrough: true, sources: [...innerOpened.sources ?? [], ...outerOpened.sources ?? []], ...(offer.unavailable && { unavailable: offer.unavailable }),
    },
  };
}

/**
 * Whether a run that needs no AI tool skips `entry` of `driver`: a runtime whose manifest declares it runs no command
 * (`exec: false`, as t3 and paseo do, their offer tests pinning it to their `init`). Such a run gives it no step, so it
 * is never opened, and the commands run on the host slot. A runtime that declares nothing is opened, and so is a team
 * runtime at a revision no one accepted here, since what that revision declares must not decide where commands run.
 */
async function isSkippedWithoutAi(driver: ResolvedDriver, entry: DriverDefinition['runtimes'][number]): Promise<boolean> {
  if (entry.through !== undefined) return false;
  const located = await locateRuntime(driver, entry.use);

  if (!located.ok || located.source.kind === 'builtin' || located.source.exec !== false) return false;

  return isRuntimeAccepted(located.source);
}

/**
 * Opens the definition `--driver <name>` names in `config`: resolves it (`personal: false` skips the member's own),
 * then opens each of its runtimes in order, so a bad option of any fails before a step runs. Each starts in `checkout`,
 * the run's, which its `init` names too. A drive of a run that `needsAiTool: false` says needs none leaves out the
 * runtimes whose manifest declares they run no command, such as t3, which it would only sign in to and ask what it runs.
 */
export async function openDriver(
  config: LocalConfig,
  name: string,
  { personal, mode, canAsk, purpose, checkout, needsAiTool = true }: { personal: boolean; mode: RunMode; canAsk: boolean; purpose: DriverPurpose; checkout: string; needsAiTool?: boolean },
): Promise<{ ok: true; opened: OpenedDriver } | { ok: false; failure: WorkflowFailure }> {
  const resolved = await resolveDriver(config, name, { personal });

  if (!resolved.ok) return resolved;
  const { driver } = resolved;
  const opened: OpenedRuntime[] = [];
  const how = { mode, canAsk, purpose, checkout };

  if (purpose === 'run') for (const warning of shadowedFleetEntries(driver.definition.runtimes)) log.warn(`Driver definition ${driver.location}: ${warning}`);

  if (purpose === 'run') {
    for (const location of driver.unread ?? []) {
      log.warn(`Driver definition ${location} is not read: host is teamai's built-in driver, which runs only commands, gates and workflows whose steps need no AI tool, and no file replaces it. Rename the file and the name in it.`);
    }
  }

  // A member's or the team's teamai-local replaces every run's default driver, which a run never does silently.
  if (purpose === 'run' && name === LOCAL_DRIVER && driver.source !== 'shipped') {
    log.info(`Driver local runs ${driver.location}, ${driver.source === 'personal' ? 'your own' : 'the team\'s'} teamai-local, in place of teamai's.`);
  }

  for (const entry of driver.definition.runtimes) {
    if (purpose === 'run' && !needsAiTool && await isSkippedWithoutAi(driver, entry)) continue;

    const one = entry.through === undefined
      ? await openRuntime(driver, { use: entry.use, options: entryOptions(driver, entry.use, entry.options), ...(entry.sandbox !== undefined && { sandbox: entry.sandbox }) }, how)
      : await openComposed(driver, { names: { inner: entry.use, outer: entry.through }, options: entry.options ?? {}, ...(entry.sandbox !== undefined && { sandbox: entry.sandbox }) }, how);

    if (!one.ok) {
      await Promise.all(opened.map((done) => (done.kind === 'external' ? done.runtime.dispose() : undefined)));

      return one;
    }

    opened.push(one.opened);
  }

  return { ok: true, opened: { driver, asked: name, runtimes: opened } };
}


/** One sandbox entry of a driver: the profile it names, found or why not, and whether this machine can start it. */
export interface SandboxEntryCheck {
  driver: string;
  /** The profile the entry names, `default` when it names none. */
  asked: string;
  located: Awaited<ReturnType<typeof locateSandboxProfile>>;
  canStart: () => Promise<{ ok: true } | { ok: false; failure: WorkflowFailure }>;
}

/**
 * Each entry of driver `name` in `config` that runs the sandbox runtime, the member's own definition first. Whether one
 * can start opens only its sandbox runtime in `check` mode, which asks its provider whether it answers and starts nothing.
 */
export async function sandboxEntryChecks(config: LocalConfig, name: string, checkout: string): Promise<SandboxEntryCheck[]> {
  const resolved = await resolveDriver(config, name, { personal: true });

  if (!resolved.ok) return [];
  const { driver } = resolved;
  const entries = driver.definition.runtimes.filter((entry) => entry.use === SANDBOX_RUNTIME || entry.through === SANDBOX_RUNTIME);

  return Promise.all(entries.map(async (entry) => ({
    driver: driver.name,
    asked: entry.sandbox ?? DEFAULT_PROFILE,
    located: await locateSandboxProfile(driver, entry.sandbox),
    canStart: async () => {
      const nested = entry.through === undefined ? { ok: true as const, outer: entry.options ?? {} } : nestedOptions(entry.options ?? {}, { inner: entry.use, outer: entry.through });

      if (!nested.ok) return { ok: false, failure: badOption(driver, composedName(entry.use, SANDBOX_RUNTIME), nested.key, nested.message) };
      const sandbox = { use: SANDBOX_RUNTIME, options: entryOptions(driver, SANDBOX_RUNTIME, nested.outer), ...(entry.sandbox !== undefined && { sandbox: entry.sandbox }) };
      const opened = await openRuntime(driver, sandbox, { mode: 'attended', canAsk: false, purpose: 'check', checkout });

      if (opened.ok) {
        if (opened.opened.kind === 'external') await opened.opened.runtime.dispose();

        return { ok: true };
      }

      return opened.failure.code === CANNOT_TELL ? { ok: true } : opened;
    },
  })));
}

/**
 * Whether a run could start now, from `checkout`, on the definition `--driver <name>` names in `config`, the member's
 * own first, or why not: each of its runtimes gets `init` in `check` mode, so none signs in, writes or launches
 * anything, and is closed at once.
 */
export async function checkDriver(config: LocalConfig, name: string, checkout: string): Promise<{ ok: true } | { ok: false; failure: WorkflowFailure }> {
  const opened = await openDriver(config, name, { personal: true, mode: 'attended', canAsk: false, purpose: 'check', checkout });

  if (!opened.ok) return opened;
  await disposeDriver(opened.opened);

  return { ok: true };
}
