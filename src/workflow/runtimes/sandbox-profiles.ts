import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import type { RuntimeOptions } from '@teamai/runtime-protocol';
import { JsonValueSchema } from '@teamai/shared/json';
import { readRegularFileNoLink } from '@teamai/shared/regular-file';
import { parseYaml } from '@teamai/shared/yaml';
import { isSymlink, RESOURCE_LAYOUTS } from '../../resources/resolver.js';
import type { WorkflowFailure } from '../types.js';
import type { ResolvedDriver } from './definitions.js';
import { findInLayers, namesOf, type LayerFind, type LayerItem } from './layers.js';
import { fixOf, pinFolder, type PinProblem, type RuntimeLayer } from './locate.js';
import { folderRevision } from './resource-folder.js';

// ─── Sandbox profiles ────────────────────────────────────
//
//  What the sandbox runtime runs a place in: a provider and its options, as `sandboxes/<name>.yaml` or a folder
//  `sandboxes/<name>/` with its `SANDBOX.yaml` and the files it builds from, such as a Containerfile. A driver's entry
//  names one with `sandbox: <name>`, `default` when it names none. It is found as a runtime is: the member's own
//  ~/.teamai/sandboxes/, the team repo's sandboxes/ (and sandboxes/<namespace>/), then teamai's own; first by the exact
//  name in every layer, then as teamai-<name>. The driver's entry keeps `max_parallel` and `credentials`.
//

/** The marker of a sandbox profile kept as a folder. */
export const SANDBOX_MARKER = RESOURCE_LAYOUTS.sandboxes.marker;

/** The profile an entry runs when it names none. */
export const DEFAULT_PROFILE = 'default';

/** What a driver's entry sets for the sandbox runtime, which a profile never does. */
const ENTRY_KEYS = ['max_parallel', 'credentials'] as const;

/** The option teamai gives the sandbox runtime itself: the profile's name, revision and folder. */
export const PROFILE_OPTION = 'profile';

/** A sandbox profile as found, with the options it gives the sandbox runtime. */
export interface SandboxProfile {
  /** The name the entry asked for, `default` when it named none. */
  readonly asked: string;
  /** The name of the resource found for it: `asked` itself, or `teamai-<asked>`. */
  readonly resource: string;
  readonly layer: RuntimeLayer;
  /** Where a message names it: its path in the team repo (`sandboxes/gpu/`), the member's file, or teamai's. */
  readonly location: string;
  /** The folder of a profile kept as one, which its paths are inside. */
  readonly folder?: string;
  /** The sha256 of a file's content, or the folder's revision (`folderRevision`). */
  readonly revision: string;
  readonly options: Readonly<Record<string, z.infer<typeof JsonValueSchema>>>;
  /** The provider its options name, which the sandbox runtime checks; unset when they name none. */
  readonly provider?: string;
  /** The profile of teamai's own this one of the member or the team stands in for. */
  readonly replaces?: string;
}

/** The profile a definition holds, or why it cannot be used, which fails the run. */
type ProfileRead = { readonly kind: 'found'; readonly profile: SandboxProfile } | { readonly kind: 'refused'; readonly failure: WorkflowFailure };

const ProfileOptionsSchema = z.record(z.string(), JsonValueSchema);
const ProviderSchema = z.object({ provider: z.string() });

function invalid({ driver, asked, location, layer }: { driver: ResolvedDriver; asked: string; location: string; layer: RuntimeLayer }, reason: string): Extract<ProfileRead, { kind: 'refused' }> {
  return { kind: 'refused', failure: { code: 'sandbox_profile_invalid', message: `Driver "${driver.name}" runs its sandbox with profile "${asked}", and ${location} cannot be used: ${reason}. ${fixOf(layer)}` } };
}

/** The profile `definition` holds, or why it cannot be used. */
async function readProfile(driver: ResolvedDriver, asked: string, definition: LayerItem): Promise<ProfileRead> {
  // What the marker itself says wrong names the marker; what the folder holds names the folder.
  const markerLocation = definition.form === 'folder' && /[\\/]$/.test(definition.location) ? `${definition.location}${SANDBOX_MARKER}` : definition.location;
  const refuse = (reason: string): ProfileRead => invalid({ driver, asked, location: definition.location, layer: definition.layer }, reason);
  const badMarker = (reason: string): ProfileRead => invalid({ driver, asked, location: markerLocation, layer: definition.layer }, reason);
  const file = definition.form === 'folder' ? path.join(definition.at, SANDBOX_MARKER) : definition.at;

  if (definition.form === 'file' && definition.layer === 'team' && await isSymlink(file)) return refuse('it is a link, and teamai reads a profile only from a file the team repo holds');
  let text = definition.layer === 'teamai' ? definition.text : undefined;

  if (text === undefined) {
    try {
      text = await readRegularFileNoLink(file, 'utf8');
    } catch (error) {
      return badMarker(`it cannot be read (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  let raw: unknown;

  try {
    raw = parseYaml(text);
  } catch (error) {
    return badMarker(`it is not YAML (${error instanceof Error ? error.message : String(error)})`);
  }

  const parsed = ProfileOptionsSchema.safeParse(raw);

  if (!parsed.success) return badMarker('it sets no options, and a profile is a mapping such as provider: docker');
  const options = parsed.data;
  const entryKey = ENTRY_KEYS.find((key) => key in options);

  if (entryKey !== undefined) return badMarker(`it sets ${entryKey}, which the driver definition's entry sets, as its options: { ${entryKey}: ${JSON.stringify(options[entryKey])} }`);

  if (PROFILE_OPTION in options) return badMarker(`it sets ${PROFILE_OPTION}, which teamai gives the sandbox runtime itself`);
  let revision: string;

  try {
    revision = definition.form === 'folder' ? await folderRevision(definition.at) : createHash('sha256').update(text).digest('hex');
  } catch (error) {
    return refuse(`its folder cannot be read (${error instanceof Error ? error.message : String(error)})`);
  }

  const named = ProviderSchema.safeParse(options);

  return {
    kind: 'found',
    profile: {
      asked, resource: definition.resource, layer: definition.layer, location: definition.location, ...(definition.form === 'folder' && { folder: definition.at }), revision, options,
      ...(named.success && { provider: named.data.provider }),
    },
  };
}

/** The failure of a lookup the first layer holding the profile `asked` names refused. */
function refusalOf(driver: ResolvedDriver, asked: string, found: Extract<LayerFind, { kind: 'refused' }>): WorkflowFailure {
  const { refusal, layer, location, resource } = found;
  const opening = `Driver "${driver.name}" runs its sandbox with profile "${asked}", and`;
  const refused = (message: string): WorkflowFailure => ({ code: 'sandbox_profile_invalid', message });
  const unusable = (reason: string): WorkflowFailure => invalid({ driver, asked, location, layer }, reason).failure;

  switch (refusal.kind) {
    case 'duplicate':
      return refused(layer === 'personal'
        ? `Sandbox profile "${resource}" is defined twice in your own sandboxes (${refusal.first} and ${refusal.second}). Keep one, and start again.`
        : `Sandbox profile "${resource}" is defined twice in one place (${refusal.first} and ${refusal.second}). Keep one, push it, run teamai pull, and start again.`);
    case 'two-namespaces':
      return refused(`Sandbox profile "${resource}" is defined in two active namespaces (${refusal.first} and ${refusal.second}). Keep one, push it, run teamai pull, and start again.`);
    case 'linked-dir':
      return refused(`${opening} ${refusal.dir} in the team repo is a link, and teamai reads a team sandbox profile only from a folder the team repo holds. Replace the link with the folder, push it, run teamai pull, and start again.`);
    case 'linked-folder':
      return refused(`${opening} its folder ${refusal.folder} in the team repo is a link, and teamai reads a team sandbox profile only from a folder the team repo holds. Replace the link with the folder, push it, run teamai pull, and start again.`);
    case 'holds-link':
      return unusable(`it holds the link ${refusal.link}, and teamai builds a sandbox only from what the folder itself holds`);
    case 'unreadable':
      return unusable(refusal.reason);
    case 'no-marker':
      return unusable(`it holds no ${refusal.marker}, the file that names a profile's provider and options, such as provider: docker`);
    default: {
      const unhandled: never = refusal;

      return unhandled;
    }
  }
}

/** The sandbox profile a runtime entry of `driver` names with `sandbox:` (`named`), or why there is none it can use. */
export async function locateSandboxProfile(driver: ResolvedDriver, named: string | undefined): Promise<{ ok: true; profile: SandboxProfile } | { ok: false; failure: WorkflowFailure }> {
  const asked = named ?? DEFAULT_PROFILE;
  const found = await findInLayers('sandboxes', namesOf(asked), { personal: true, teams: [driver.config] });

  switch (found.kind) {
    case 'found': {
      // A profile that cannot be used fails the run: another layer's never stands in for the one the member was given.
      const read = await readProfile(driver, asked, found.item);

      if (read.kind !== 'found') return { ok: false, failure: read.failure };

      return { ok: true, profile: found.replaces === undefined ? read.profile : { ...read.profile, replaces: found.replaces } };
    }

    case 'refused':
      return { ok: false, failure: refusalOf(driver, asked, found) };
    case 'missing':
      return {
        ok: false,
        failure: {
          code: 'sandbox_profile_not_found',
          message: `Driver "${driver.name}" runs its sandbox with profile "${asked}", and none is declared: add sandboxes/${asked}.yaml (or sandboxes/${asked}/${SANDBOX_MARKER} with what it builds from) to the team repo and run teamai pull, or add ~/.teamai/sandboxes/${asked}.yaml for yourself.`,
        },
      };
    default: {
      const unhandled: never = found;

      return unhandled;
    }
  }
}

/**
 * The options the sandbox runtime of `driver` starts with: those of the profile its entry names (`named`), and the
 * `profile` option naming it. `given` is what the entry and the member's config pass it besides `max_parallel` and
 * `credentials`, which must be nothing now that a profile holds the provider's options; `from` names where they were set.
 */
export async function sandboxOptions({ driver, named, given, from, isEntryEditable }: { driver: ResolvedDriver; named: string | undefined; given: RuntimeOptions; from: string; isEntryEditable: boolean }): Promise<{ ok: true; options: RuntimeOptions; profile: SandboxProfile } | { ok: false; failure: WorkflowFailure }> {
  const [inline] = Object.keys(given);

  if (inline !== undefined) {
    // A profile can be named only on an entry the member or the team can edit; otherwise the fix is the one the entry runs.
    const fix = named !== undefined
      ? `move them to sandboxes/${named}.yaml in the team repo (or ~/.teamai/sandboxes/${named}.yaml for yourself), the profile the entry names`
      : isEntryEditable
        ? `move them to sandboxes/${driver.name}.yaml in the team repo (or ~/.teamai/sandboxes/${driver.name}.yaml for yourself), name it on the entry with sandbox: ${driver.name}`
        : `move them to sandboxes/${DEFAULT_PROFILE}.yaml in the team repo (or ~/.teamai/sandboxes/${DEFAULT_PROFILE}.yaml for yourself), the profile an entry that names none runs`;

    return {
      ok: false,
      failure: { code: 'bad_option', message: `Driver definition ${from} gives runtime "sandbox" the option "${inline}", and a sandbox's options live in a sandbox profile: ${fix}, and start again.` },
    };
  }

  const located = await locateSandboxProfile(driver, named);

  if (!located.ok) return located;

  return { ok: true, options: optionsOf(located.profile), profile: located.profile };
}

/** What the sandbox runtime starts with for `profile`: its options, and the `profile` option naming it. */
function optionsOf(profile: SandboxProfile): RuntimeOptions {
  const profileOption = { name: profile.resource, revision: profile.revision, ...(profile.folder !== undefined && { folder: profile.folder }) };

  return { ...profile.options, [PROFILE_OPTION]: profileOption };
}

/**
 * `profile` of `driver` as the sandbox runtime builds from it: a profile kept as a folder is copied where no pull
 * reaches it, with the revision of that copy, so the revision its record names is what it builds, for as long as the
 * runtime runs. `remove` removes the copy.
 */
export async function pinSandboxProfile(driver: ResolvedDriver, profile: SandboxProfile): Promise<{ ok: true; options: RuntimeOptions; profile: SandboxProfile; remove: () => Promise<void> } | { ok: false; failure: WorkflowFailure }> {
  if (profile.folder === undefined) return { ok: true, options: optionsOf(profile), profile, remove: async () => undefined };
  const pinned = await pinFolder(profile.folder, { config: driver.config });

  if (!pinned.ok) return { ok: false, failure: invalid({ driver, asked: profile.asked, location: profile.location, layer: profile.layer }, profilePinReason(pinned.problem)).failure };
  let revision: string;

  try {
    revision = await folderRevision(pinned.copy);
  } catch (error) {
    await pinned.remove();

    return { ok: false, failure: invalid({ driver, asked: profile.asked, location: profile.location, layer: profile.layer }, `its copy cannot be read (${error instanceof Error ? error.message : String(error)})`).failure };
  }

  const built = { ...profile, folder: pinned.copy, revision };

  return { ok: true, options: optionsOf(built), profile: built, remove: pinned.remove };
}

/** Why a profile's folder has no copy to build from, as its failure says it. */
function profilePinReason(problem: PinProblem): string {
  switch (problem.kind) {
    case 'uncopied':
      return `its folder could not be copied to build from (${problem.why})`;
    case 'link':
      return `it now holds the link ${problem.link}, and teamai builds a sandbox only from what the folder itself holds`;
    case 'unreadable':
      return problem.why;
    default: {
      const unhandled: never = problem;

      return unhandled;
    }
  }
}
