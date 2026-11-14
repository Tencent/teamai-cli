import { z } from 'zod';
import { RuntimeOptionsSchema, type OpId, type RuntimeFailure, type RuntimeOptions } from '@teamai/runtime-protocol';
import type { DriverCan } from '../requirements.js';
import { toolHomeVariable } from './attempt.js';
import { isUnansweredFailure, type Initialized, type OpenRequest, type Reattached, type StepRuntime } from '@teamai/runtime-protocol/step-runtime';

// ─── A runtime through another ───────────────────────────
//
//  A definition entry `use: <inner>, through: <outer>` runs a step's tool, launched by the inner runtime (T3, Paseo),
//  inside the place the outer one makes (a sandbox). The engine sees one step runtime: this one. It opens the outer on
//  the place view, then, for a place whose prompt runs a tool, the inner with `outer` set to the outer's handle, which
//  it passes unchanged and never reads.
//  An exec runs on the outer, a prompt on the inner. It reattaches the outer first, with the prompt's credentials
//  again, since the outer keeps them only in memory, and collects and closes the inner first: the outer is not closed
//  while the inner has not confirmed its stop. No runtime calls the other.
//

/** The workspace modes the outer prepares itself, which the entry offers whatever the inner says. */
const PREPARED_MODES = ['clone', 'team'] as const;

type Offer = Extract<Initialized<DriverCan>, { ok: true }>;

/** Both values when both declare the key, as the weaker; the one declared otherwise. */
function weaker(outer: boolean | undefined, inner: boolean | undefined): boolean | undefined {
  return outer === undefined ? inner : inner === undefined ? outer : outer && inner;
}

/**
 * The offer of `inner` through `outer`. Where the step's tool is launched decides: `tools`, `default_tool`,
 * `workspace`, `hitl`, `end_turn`, `role`, `prompt` (`launchesAgents`) and `unavailable` are the inner's, and so is
 * `fullAccess`; where it runs decides `isolation`, `env`, `setup`, `exec` (setup and command steps run on the outer) and
 * `ownLogins`. `workspace` also holds the modes the outer prepares (`clone`, `team`). `unattended` is the outer's, for
 * the tools the inner runs in full access, and for none when it reports none, only when the inner offers unattended
 * itself: one that refuses it, as T3 and Paseo do, or says nothing of it, runs none wherever its tool runs. `network`, `tokens` and `max_turns` are
 * the weaker of both. A composed entry answers no confined prompt: `confined` is dropped.
 */
export function composedOffer(outer: Offer, inner: Offer): Offer {
  const prepared = (outer.can.workspace ?? []).filter((mode) => PREPARED_MODES.some((known) => known === mode));
  const workspace = [...new Set([...(inner.can.workspace ?? []), ...prepared])];
  const isolation = outer.can.isolation;

  const can: DriverCan = {
    ...(inner.can.tools !== undefined && { tools: inner.can.tools }),
    ...(inner.can.default_tool !== undefined && { default_tool: inner.can.default_tool }),
    ...((inner.can.workspace !== undefined || prepared.length > 0) && { workspace }),
    ...(inner.can.hitl !== undefined && { hitl: inner.can.hitl }),
    ...(inner.can.end_turn !== undefined && { end_turn: inner.can.end_turn }),
    ...(inner.can.role !== undefined && { role: inner.can.role }),
    ...(isolation !== undefined && { isolation }),
    ...(outer.can.env !== undefined && { env: outer.can.env }),
    ...(outer.can.setup !== undefined && { setup: outer.can.setup }),
    ...(outer.can.exec !== undefined && { exec: outer.can.exec }),
    ...(outer.can.unattended !== undefined && { unattended: outer.can.unattended && inner.can.unattended === true, fullAccess: [] }),
    // Kept whether or not the outer offers unattended prompts: a tool in full access is warned of either way.
    ...(inner.can.fullAccess !== undefined && { fullAccess: inner.can.fullAccess }),
  };

  for (const key of ['network', 'tokens', 'max_turns'] as const) {
    const both = weaker(outer.can[key], inner.can[key]);

    if (both !== undefined) can[key] = both;
  }

  return {
    ok: true, can, launchesAgents: inner.launchesAgents,
    ...(inner.unavailable && { unavailable: inner.unavailable }),
    ...(outer.ownLogins && { ownLogins: outer.ownLogins }),
  };
}

/**
 * The handle of a composed place: the outer's, then the inner's once the inner accepted its open. `innerOpening` says
 * the inner was asked to open a place this handle does not name yet, as a teamai stopped in between leaves it.
 */
const ComposedHandleSchema = z.union([
  z.object({ outer: z.string().min(1), inner: z.string().min(1).optional() }).strict(),
  z.object({ outer: z.string().min(1), innerOpening: z.literal(true) }).strict(),
]);

type ComposedHandle = z.infer<typeof ComposedHandleSchema>;

/** The inner's handle a composed handle names, if any. */
function innerOf(handle: ComposedHandle | undefined): string | undefined {
  return handle !== undefined && 'inner' in handle ? handle.inner : undefined;
}

function handleOf(handle: string): ComposedHandle | undefined {
  try {
    const parsed = ComposedHandleSchema.safeParse(JSON.parse(handle));

    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The options of a composed entry, nested under each runtime's name, split by runtime, or the key that is neither
 * runtime's or holds no options.
 */
export function nestedOptions(options: RuntimeOptions, names: { outer: string; inner: string }): { ok: true; outer: RuntimeOptions; inner: RuntimeOptions } | { ok: false; key: string; message: string } {
  const stray = Object.keys(options).find((key) => key !== names.outer && key !== names.inner);

  if (stray !== undefined) return { ok: false, key: stray, message: `a runtime through another takes its options under ${names.inner} and ${names.outer}, each runtime's own` };
  const split: Record<'outer' | 'inner', RuntimeOptions> = { outer: {}, inner: {} };

  for (const part of ['outer', 'inner'] as const) {
    const given = RuntimeOptionsSchema.safeParse(options[names[part]] ?? {});

    if (!given.success) return { ok: false, key: names[part], message: `the options of ${names[part]} are a mapping of option names to values` };
    split[part] = given.data;
  }

  return { ok: true, ...split };
}

/** The name the engine gives `inner` through `outer`, in its records and messages. */
export function composedName(inner: string, outer: string): string {
  return `${inner} through ${outer}`;
}

/**
 * `inner` through `outer`, as one step runtime. `innerCredentials` are the inner's own, the only ones it gets: the
 * credentials the engine sends with an open, an exec or a reattach are the prompt's, for the outer, which hands them to
 * the tool it runs. Each `init` option is nested under the runtime it is for, by name.
 */
export function composedStepRuntime({ outer, inner, innerCredentials }: { outer: StepRuntime<DriverCan>; inner: StepRuntime<DriverCan>; innerCredentials: Record<string, string> }): StepRuntime<DriverCan> {
  const name = composedName(inner.name, outer.name);
  // Which runtime runs each operation, so a cancel reaches it: an exec the outer, a prompt the inner.
  const ranBy = new Map<OpId, StepRuntime<DriverCan>>();
  // The prompt's credentials each place was opened with, none too, and the names it goes without, by the outer's handle,
  // in memory only, which the outer's reattach of that place carries again. One composed runtime serves every attempt.
  const openedWith = new Map<string, Pick<OpenRequest, 'credentials' | 'unset'>>();
  // The attempt's tool home each place was opened with, by the outer's handle: the tool runs in the outer's place on it,
  // so a finished prompt's session is there, whatever home the inner names.
  const toolHomeOf = new Map<string, string>();

  const unknownHandle = (handle: string): RuntimeFailure => ({ code: 'runtime_protocol', message: `Step runtime "${name}" was given handle ${handle}, which is not one it made.` });

  return {
    name,

    async init({ options, ...request }) {
      const nested = nestedOptions(options, { outer: outer.name, inner: inner.name });

      if (!nested.ok) return { ok: false, failure: { code: 'bad_option', key: nested.key, message: nested.message } };
      const outerReady = await outer.init({ ...request, options: nested.outer });

      if (!outerReady.ok) return outerReady;
      const innerReady = await inner.init({ ...request, options: nested.inner, credentials: { env: Object.keys(innerCredentials), logins: [] } });

      return innerReady.ok ? composedOffer(outerReady, innerReady) : innerReady;
    },

    async open(request, onAccepted) {
      // A place whose prompt runs a tool opens the inner next: the handle says so until the inner's is known.
      let outerAccepted: string | undefined;

      const outerOpened = await outer.open(request, async (handle) => {
        outerAccepted = handle;
        await onAccepted(JSON.stringify((request.tool === undefined ? { outer: handle } : { outer: handle, innerOpening: true }) satisfies ComposedHandle));
      });

      // The handle stops saying the inner opens once the inner answered that it made no place, or was never asked.
      const outerOnly = async (handle: string | undefined): Promise<void> => {
        if (handle !== undefined && request.tool !== undefined) await onAccepted(JSON.stringify({ outer: handle } satisfies ComposedHandle));
      };

      if (outerOpened.kind !== 'ready') {
        await outerOnly(outerAccepted);

        return outerOpened;
      }

      openedWith.set(outerOpened.handle, { credentials: request.credentials, ...(request.unset && { unset: request.unset }) });
      const variable = request.tool === undefined ? undefined : toolHomeVariable(request.tool);
      const toolHome = variable === undefined ? undefined : request.view?.toolHome[variable];

      if (toolHome !== undefined) toolHomeOf.set(outerOpened.handle, toolHome);

      // A command step's place runs no tool, so the inner, which launches tools, has no place to make for it.
      if (request.tool === undefined) return { kind: 'ready', handle: JSON.stringify({ outer: outerOpened.handle } satisfies ComposedHandle), ...(outerOpened.display && { display: outerOpened.display }) };
      let innerAccepted = false;
      // The names the prompt goes without are the outer's to keep from the tool it starts; the inner gets none.
      const { unset: _outerOnly, ...forInner } = request;

      const innerOpened = await inner.open({ ...forInner, credentials: innerCredentials, outer: outerOpened.handle }, async (handle) => {
        innerAccepted = true;
        await onAccepted(JSON.stringify({ outer: outerOpened.handle, inner: handle } satisfies ComposedHandle));
      });

      if (innerOpened.kind !== 'ready') {
        // An inner that did not answer may hold a place it never named, so the handle keeps saying it opens one.
        if (!innerAccepted && !isUnansweredFailure(innerOpened.failure)) await outerOnly(outerOpened.handle);

        return innerOpened;
      }

      const display = innerOpened.display ?? outerOpened.display;

      return { kind: 'ready', handle: JSON.stringify({ outer: outerOpened.handle, inner: innerOpened.handle } satisfies ComposedHandle), ...(display && { display }) };
    },

    async exec(request, events, kind) {
      const handle = handleOf(request.handle);

      if (!handle) return { kind: 'failed', failure: unknownHandle(request.handle) };
      ranBy.set(request.op, outer);

      return outer.exec({ ...request, handle: handle.outer }, events, kind);
    },

    async prompt(request, events) {
      const handle = handleOf(request.handle);

      const innerHandle = innerOf(handle);

      if (innerHandle === undefined) return { kind: 'failed', failure: unknownHandle(request.handle) };
      ranBy.set(request.op, inner);

      const end = await inner.prompt({ ...request, handle: innerHandle, credentials: innerCredentials }, events);
      const toolHome = handle && toolHomeOf.get(handle.outer);

      return end.kind === 'finished' && toolHome ? { ...end, session: { ...end.session, home: toolHome } } : end;
    },

    async cancel(op) {
      const runtime = ranBy.get(op);

      if (runtime) return runtime.cancel(op);
      await inner.cancel(op);
      await outer.cancel(op);
    },

    async collect(handle) {
      const parsed = handleOf(handle);

      if (!parsed) return { ok: false, failure: unknownHandle(handle) };

      const innerHandle = innerOf(parsed);

      if (innerHandle !== undefined) {
        const collected = await inner.collect(innerHandle);

        if (!collected.ok) return collected;
      }

      return outer.collect(parsed.outer);
    },

    async reattach(handle) {
      const parsed = handleOf(handle);

      // A handle it never made has no place, as a runtime's journal without it says.
      if (!parsed) return { kind: 'gone' };
      const outerSeen = await outer.reattach(parsed.outer, openedWith.get(parsed.outer));

      if (outerSeen.kind === 'failed') return outerSeen;
      const innerHandle = innerOf(parsed);
      const innerSeen: Reattached = innerHandle === undefined ? { kind: 'gone' } : await inner.reattach(innerHandle);

      if (innerSeen.kind === 'failed') return innerSeen;

      if (outerSeen.kind === 'gone' && innerSeen.kind === 'gone') return { kind: 'gone' };

      // A prompt that finished while teamai was stopped kept its session where a live one does: the attempt's tool home.
      const toolHome = toolHomeOf.get(parsed.outer);

      const innerOps = innerSeen.kind === 'alive' && toolHome !== undefined
        ? innerSeen.ops.map((state) => (state.state === 'finished' ? { ...state, session: { ...state.session, home: toolHome } } : state))
        : undefined;

      const seen = [outerSeen.kind === 'alive' ? { runtime: outer, ...outerSeen } : undefined, innerSeen.kind === 'alive' ? { runtime: inner, ...innerSeen, ...(innerOps && { ops: innerOps }) } : undefined];

      for (const one of seen) for (const state of one?.ops ?? []) if (one) ranBy.set(state.op, one.runtime);
      const display = (innerSeen.kind === 'alive' ? innerSeen.display : undefined) ?? (outerSeen.kind === 'alive' ? outerSeen.display : undefined);

      return { kind: 'alive', ops: seen.flatMap((one) => one?.ops ?? []), ...(display && { display }) };
    },

    async close(handle, how) {
      const parsed = handleOf(handle);

      if (!parsed) return { ok: true };
      // Only the inner knows a place it made before teamai recorded it, and no request of teamai names that place.
      const unrecorded: RuntimeFailure = { code: 'runtime_lost', message: `${inner.name} may hold a place for this attempt that teamai never recorded, since teamai or ${inner.name} stopped while ${inner.name} opened it, so teamai cannot ask ${inner.name} to close it. Close it in ${inner.name} yourself if it is there.` };
      const innerHandle = innerOf(parsed);
      const innerClosed = 'innerOpening' in parsed ? { ok: false as const, failure: unrecorded } : innerHandle === undefined ? { ok: true as const } : await inner.close(innerHandle, how);

      // The outer's place stays while the inner has not confirmed its stop, unless the person let the attempt go.
      if (!innerClosed.ok && how?.release !== true) return innerClosed;
      const outerClosed = await outer.close(parsed.outer, how);

      if (outerClosed.ok) {
        openedWith.delete(parsed.outer);
        toolHomeOf.delete(parsed.outer);
      }

      return innerClosed.ok ? outerClosed : innerClosed;
    },

    async dispose() {
      await Promise.all([inner.dispose(), outer.dispose()]);
    },
  };
}
