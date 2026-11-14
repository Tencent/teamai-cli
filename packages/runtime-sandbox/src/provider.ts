import { z } from 'zod';
import type { Can, InitCredentials, InitInstance, PlaceView, RuntimeDisplay, RuntimeFailure, RuntimeMessage } from '@teamai/runtime-protocol';
import type { UnusedGateways } from './sign-in.js';

/** The tools a runtime holds but cannot run now, each with why, as `init` lists them. */
export type Unavailable = NonNullable<Extract<RuntimeMessage, { type: 'init'; ok: true }>['unavailable']>;

// ─── The provider seam ───────────────────────────────────
//
//  A provider is one sandbox technology. It only starts sandboxes, runs processes in them, stops and removes them, and
//  says what its technology isolates. Everything else is written once above it, in runtime.ts: the protocol, the
//  journal of operations and their retained outcomes, credentials and options.
//
//  Bind-mount providers (sbx, docker and podman today) mount the place view at its host paths, so collect copies nothing.
//  A copy provider (a hosted sandbox) will add copyIn and copyOut to this seam. On a provider that can confine one, a
//  judge (a confined prompt) gets a sandbox of its own that sees only its directory.
//

/**
 * The longest one provider command on a stop or close path runs (a lookup, a stop, a removal) before it is killed and
 * answers with how to clean up by hand. The runtime bounds a whole stop or close at 10 s on top of that (runtime.ts).
 */
export const COMMAND_MS = 9_000;

/** The attempt a sandbox belongs to, which names it and finds it again. */
export interface PlaceKey {
  run: string;
  attempt: string;
}

/** A run's id and an attempt's, as teamai makes them. */
export const RUN_ID = /^r[0-9a-f]{8}(?:[0-9a-f]{8})?$/;
export const ATTEMPT_ID = /^a[0-9a-f]{8}$/;

/** An attempt's handle, `teamai-<run>-<attempt>`, which also names its container (sbx and Vercel add the journal: `journalSandboxName`). */
export function handleOf({ run, attempt }: PlaceKey): string {
  return `teamai-${run}-${attempt}`;
}

/** The place `handleOf` named, or undefined for a name it did not make: another's, or a step's network or filter. */
export function placeKeyOfHandle(handle: string): PlaceKey | undefined {
  const [prefix, run = '', attempt = '', ...rest] = handle.split('-');

  return prefix === 'teamai' && rest.length === 0 && RUN_ID.test(run) && ATTEMPT_ID.test(attempt) ? { run, attempt } : undefined;
}

/**
 * What starts the name of every sandbox of journal `owner` on a provider whose names the member's whole account shares
 * (sbx, Vercel): an attempt's, and a warm template's scratch one (`<prefix>warm-<pid>-<random>`).
 */
export function journalPrefixOf(owner: string): string {
  return `teamai-${owner}-`;
}

/** An attempt's sandbox on such a provider: `teamai-<journal>-<run>-<attempt>`. */
export function journalSandboxName(owner: string, { run, attempt }: PlaceKey): string {
  return `${journalPrefixOf(owner)}${run}-${attempt}`;
}

/** The journal a sandbox name `journalPrefixOf` started belongs to, or undefined for a name teamai does not give. */
export function journalOfSandboxName(name: string): string | undefined {
  return /^teamai-([0-9a-f]{16})-/.exec(name)?.[1];
}

/** The journal and the place of the sandbox `journalSandboxName` named, or undefined for any other name, a warm one's too. */
export function placeOfJournalSandbox(name: string): { owner: string; key: PlaceKey } | undefined {
  const owner = journalOfSandboxName(name);
  const key = owner === undefined ? undefined : placeKeyOfHandle(`teamai-${name.slice(journalPrefixOf(owner).length)}`);

  return owner === undefined || key === undefined ? undefined : { owner, key };
}

/**
 * The provider of a runtime that could not start one: `init` failed, or never came. teamai still sends a restarted
 * runtime its cancel, reattach, collect and close, so each is answered: a lookup fails with `failure`, and a sandbox
 * is never taken as absent, so a place stays its attempt's until a runtime that reaches the engine closes it. A bind
 * provider's work is at its host paths, so its collect still answers; any other's fails, `family` unknown included.
 */
export function unreachable(failure: RuntimeFailure, family: Provider['family'] = 'copy'): Provider {
  const kept = (sandbox: string) => ({ ok: false as const, failure: { ...failure, message: `${failure.message} Sandbox ${sandbox}, if it exists, stays this attempt's until the sandbox runtime can reach it.` } });

  const sandboxing = {
    reachable: async () => ({ ok: false, failure }),
    offer: async () => ({ ok: false, failure }),
    find: async (key) => kept(handleOf(key)),
    create: async (key) => kept(handleOf(key)),
    exec: async (id) => ({ kind: 'failed', failure: kept(id).failure }),
    stop: async (id) => kept(id),
    destroy: async (id) => kept(id),
    display: (key) => ({ label: handleOf(key) }),
    name: handleOf,
    removal: (key) => `remove sandbox ${handleOf(key)} once the sandbox runtime reaches its engine`,
  } satisfies Sandboxing;

  return family === 'bind' ? { ...sandboxing, family } : { ...sandboxing, family, collect: async (id) => kept(id) };
}

export interface ExecSpec {
  argv: string[];
  /** Every name the process gets over the sandbox's own environment: the exec's names and the credentials. */
  env: Record<string, string>;
  /** Names the process must not inherit from the sandbox's own environment. */
  unset: string[];
  cwd: string;
}

export type ExecEnd = { kind: 'exited'; code: number } | { kind: 'failed'; failure: RuntimeFailure };

/** A provider's judges: each in a sandbox of its own that sees only its evidence and reaches only its model provider. */
export interface Judges {
  /**
   * Creates a judge's sandbox: only `dir`, read-only, at EVIDENCE_DIR (judge.ts), on a network whose one way out lets
   * through only `hosts` (`host:port`), and no credential. Returns its id; an existing one of `key` is that judge's.
   */
  create(key: PlaceKey, { dir, hosts }: { dir: string; hosts: string[] }): Promise<{ ok: true; id: string } | { ok: false; failure: RuntimeFailure }>;
}

/**
 * How a sandbox reaches this machine itself: the name it has there, to which a URL credential on localhost is pointed
 * (loopback.ts), or, as a whole sentence, why teamai knows none.
 */
export const HostRouteSchema = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), alias: z.string() }), z.object({ ok: z.literal(false), refusal: z.string() })]);

export type HostRoute = z.infer<typeof HostRouteSchema>;

/** The image `warm` made or found for one open, which that open's `create` starts from rather than working the key out again. */
export interface WarmedImage { image: string }

/** What an open gives the creation of its sandbox. */
export interface SandboxOpen {
  view: PlaceView;
  /** The attempt's prompt tool, as `open` names it (none for a command step), which picks sbx's template when no agent is set. */
  tool: string | undefined;
  /** The open's, the latest time the attempt's limits allow, which a hosted sandbox's lifetime must reach. */
  deadline?: string;
  /** What `warm` answered for this open, when it named the image the sandbox starts from. */
  warmed?: WarmedImage;
  /**
   * The ports of this machine the attempt's credentials name (a model gateway on localhost): on a provider that keeps
   * its sandbox from this machine, the only ones of it the sandbox reaches.
   */
  hostPorts: readonly number[];
}

/** What every provider does, whichever way its sandbox sees the place. */

interface Sandboxing {
  /**
   * Whether the technology answers on this machine, asking it only what reads its state, or `sandbox_unavailable` with
   * the fix: what a `check` init can tell without pulling an image or starting a sandbox.
   */
  reachable(): Promise<{ ok: true } | { ok: false; failure: RuntimeFailure }>;
  /**
   * Checks the technology is usable on this machine and says what it offers, or fails `sandbox_unavailable` with the
   * fix. It offers a tool only when it can sign in there with `credentials`, the names teamai gives, and lists each
   * other tool it holds in `unavailable` with how to sign it in (sign-in.ts), and each gateway of the member's that a
   * login it keeps replaces (`unusedGateways`). It offers each of `instances` whose tool it offers and whose command it
   * holds, and lists the others of a tool it holds in `unavailable`.
   */
  offer(credentials: InitCredentials | undefined, instances: readonly InitInstance[]): Promise<{ ok: true; can: Can; host: HostRoute; unavailable: Unavailable; ownLogins: string[]; unusedGateways: UnusedGateways } | { ok: false; failure: RuntimeFailure }>;
  /**
   * The sandbox of this attempt: its id, or undefined once the technology said there is none. A lookup it could not
   * make fails with what to do, so a sandbox is never taken as absent while its technology does not answer.
   */
  find(key: PlaceKey): Promise<{ ok: true; id: string | undefined } | { ok: false; failure: RuntimeFailure }>;
  /**
   * The sandboxes this runtime's journal owns (by their `teamai.owner` label, or on sbx by their name's prefix) that
   * name a run and an attempt (a judge's filter: the attempt it filters for), each with them, within COMMAND_MS. A
   * provider that cannot tell its journal's sandboxes from another's has none: nothing of it is ever swept. `leftWarm`:
   * the ids of the scratch sandboxes of warm builds whose process no longer runs (warm.ts), which `destroy` removes.
   * `released`: the attempts this journal owns a network of, which `release` removes, as one killed before its container
   * leaves it.
   */
  owned?(): Promise<{ ok: true; sandboxes: Array<PlaceKey & { id: string }>; leftWarm?: string[]; released?: PlaceKey[] } | { ok: false; failure: RuntimeFailure }>;
  /** Creates the attempt's sandbox with the view at its host paths and no credential, and returns its id. */
  create(key: PlaceKey, open: SandboxOpen): Promise<{ ok: true; id: string } | { ok: false; failure: RuntimeFailure }>;
  /**
   * On a provider with a warm image: makes the one an attempt with `view` and `tool` starts from, when it is not there
   * yet, before `create`, which then finds it, or starts from the image it names. It may take minutes, and nothing but
   * its open waits for it. `deadline` is `create`'s, for a provider that refuses a sandbox past its lifetime before it
   * makes anything.
   */
  warm?(view: PlaceView, tool: string | undefined, deadline: string | undefined): Promise<{ ok: true; warmed?: WarmedImage } | { ok: false; failure: RuntimeFailure }>;
  /**
   * On a provider whose own network policy decides what a sandbox reaches (sbx): whether it lets one reach `port` of
   * this machine, or how to allow it, naming the credential `variable` that needs it. The policy is never edited.
   */
  reachesHost?(port: number, variable: string): Promise<{ ok: true } | { ok: false; failure: RuntimeFailure }>;
  /** The sandboxes of judges, on a provider that can confine one; a provider without them offers no confined prompt. */
  judges?: Judges;
  /**
   * Removes what the sandbox of `key`, a step's or a judge's, needed besides itself: its network and the filter in front
   * of it, ok when it had none. Called once the sandbox is gone, at close and by a sweep.
   */
  release?(key: PlaceKey): Promise<{ ok: true } | { ok: false; failure: RuntimeFailure }>;
  /**
   * How a process outside this runtime, the sandbox wrapper, starts `spec.argv` in sandbox `id` with its stdin open:
   * the command line, and the whole environment to run it with, which holds every value; the argv names variables only.
   * A provider whose sandbox cannot be the outer of an app's runtime (#1718: the bind-mount ones only) has none.
   * `signal`, when the exec client does not pass a signal on to the process in the sandbox (`docker exec` does not):
   * the command line that sends one there, the signal's name last.
   */
  client?(id: string, spec: ExecSpec): { ok: true; argv: string[]; env: Record<string, string>; signal?: string[] } | { ok: false; failure: RuntimeFailure };
  /** Runs one process in the sandbox, streaming its output, until it ends. */
  exec(id: string, spec: ExecSpec, onOutput: (stream: 'stdout' | 'stderr', data: string) => void): Promise<ExecEnd>;
  /**
   * Stops every process running in the sandbox; the sandbox stays, ready for the next exec. Ok only once they are gone.
   * It answers within COMMAND_MS, failing with how to remove the sandbox when the technology does not answer by then.
   */
  stop(id: string): Promise<{ ok: true } | { ok: false; failure: RuntimeFailure }>;
  /** Removes the sandbox and every process in it; ok once it is gone. It answers within COMMAND_MS. */
  destroy(id: string): Promise<{ ok: true } | { ok: false; failure: RuntimeFailure }>;
  /**
   * What a person sees of the attempt's sandbox. `warmed`, what `warm` answered for this open, names the image it ran
   * from; a sandbox found again knows none, and shows none rather than one it may not have run.
   */
  display(key: PlaceKey, warmed?: WarmedImage): RuntimeDisplay;
  /** What the engine names the attempt's sandbox by: a close that leaves it names that in `kept`. */
  name(key: PlaceKey): string;
  /** How a person removes the place by hand, as the end of a sentence: "remove it with `…`". */
  removal(place: PlaceKey & { confined?: true }): string;
}

/**
 * A sandbox technology. `bind`: the sandbox mounts the place at its host paths, so its work is there already. `copy`:
 * the place is copied in, and `collect` copies the sandbox's work back to the host paths, ok once the host matches.
 */
export type Provider = Sandboxing & (
  | { family: 'bind'; collect?: never }
  | { family: 'copy'; collect(id: string): Promise<{ ok: true } | { ok: false; failure: RuntimeFailure }> }
);

/** The place's sandbox: the id the journal kept, or the one its labels find when a runtime died before keeping it. */
export async function sandboxOf(place: PlaceKey & { id?: string }, provider: Provider): ReturnType<Provider['find']> {
  return place.id === undefined ? provider.find(place) : { ok: true, id: place.id };
}
