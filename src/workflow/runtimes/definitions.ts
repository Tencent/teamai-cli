import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { loadLocalConfigForScope } from '../../config.js';
import { FOLDER_MARKERS } from '../../folder-markers.js';
import type { LocalConfig } from '../../types.js';
import { JsonValueSchema } from '@teamai/shared/json';
import { parseYaml } from '@teamai/shared/yaml';
import { HOST_DRIVER, LOCAL_DRIVER, parseDriver, type DriverName } from '../driver-name.js';
import { isReservedDriver } from '../reserved-drivers.js';
import type { WorkflowFailure } from '../types.js';
import { readRegularFileNoLink } from '@teamai/shared/regular-file';
import { findInLayers, namesOf, personalDir, SHIPPED_PREFIX, type Layer, type LayerFind, type LayerItem } from './layers.js';

// ─── Driver definitions ──────────────────────────────────
//
//  A driver definition is a YAML resource `--driver <name>` selects: the runtimes a run's steps go to, their options, and
//  an optional default tool. It is found, first match wins, in the member's own ~/.teamai/drivers/<name>.yaml, in the
//  team repo's drivers/ (and drivers/<namespace>/ for each active namespace), in the user scope's team repo when the
//  start is in a project, and in the definitions teamai ships (drivers/ in the package, every name prefixed teamai-).
//  `--driver x` and `--driver teamai-x` both run the shipped teamai-x when no definition is named x. `--driver host` runs
//  the definition teamai builds in, with no runtime, and reads no file.
//

const RUNTIME_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Name `name` as a definition takes it, or why it cannot: any driver name but one in `RESERVED_DRIVERS`, `host`
 * included, which teamai builds in.
 */
function definitionName(name: string): { ok: true; name: DriverName } | { ok: false; reason: string } {
  const kept = { ok: false, reason: `"${name}" is a name teamai keeps for its own driver` } as const;

  if (isReservedDriver(name)) return kept;
  const parsed = parseDriver(name);

  if (!parsed.ok) return parsed;

  switch (parsed.driver) {
    // parseDriver names a driver of teamai's own only for a name isReservedDriver keeps.
    case 'local':
    case 'skill':
    case 'none':
      return kept;
    default:
      return { ok: true, name: parsed.driver.external };
  }
}

const RuntimeNameSchema = z.string().regex(RUNTIME_NAME, 'A runtime name starts with a letter or digit and holds only letters, digits, dots, dashes and underscores');

/** The runtime whose place a sandbox profile sets up. */
export const SANDBOX_RUNTIME = 'sandbox';

/**
 * One runtime of a definition: the runtime it uses and the options it passes at `init`. With `through`, the runtime it
 * uses runs its tools inside the place that other runtime makes (`use: t3, through: sandbox`), and `options` holds
 * each one's options under its name. `sandbox` names the sandbox profile the sandbox runtime of the entry runs.
 */
const RuntimeEntrySchema = z.object({
  use: RuntimeNameSchema,
  through: RuntimeNameSchema.optional(),
  sandbox: RuntimeNameSchema.optional(),
  options: z.record(z.string(), JsonValueSchema).optional(),
}).strict()
  .refine((entry) => entry.through !== entry.use, { path: ['through'], message: 'A runtime runs through another runtime, not through itself' })
  // A member runs each step it takes on its own driver, so no place another runtime makes holds what the fleet runs.
  .refine((entry) => entry.through === undefined || (entry.use !== 'fleet' && entry.through !== 'fleet'), { path: ['through'], message: 'fleet runs no step through another runtime, and no runtime runs through fleet: a fleet entry composes without through, since each member runs the step on its own driver' })
  .refine((entry) => entry.sandbox === undefined || entry.use === SANDBOX_RUNTIME || entry.through === SANDBOX_RUNTIME, { path: ['sandbox'], message: 'sandbox names a sandbox profile, which only an entry with use: sandbox or through: sandbox runs' });

export const DriverDefinitionSchema = z.object({
  schemaVersion: z.literal('v1alpha1'),
  name: z.string(),
  description: z.string().optional(),
  /** The tool a prompt step runs on when neither it nor `--tools` names one. */
  tool: z.string().min(1).optional(),
  /** The runtimes the run's steps go to, offered in this order: a step goes to the first that can take it. */
  runtimes: z.array(RuntimeEntrySchema).min(1, 'A driver definition lists at least one runtime'),
}).strict();

export type DriverDefinition = z.infer<typeof DriverDefinitionSchema>;

/** Where a definition came from, which decides whether its runtimes need a person's acceptance. `builtin`: `host`, which no file holds. */
export type DefinitionSource = 'personal' | 'team' | 'shipped' | 'builtin';

export interface ResolvedDriver {
  /** The definition's canonical name: the stored name, `teamai-x` for a shipped `x`. */
  name: string;
  definition: DriverDefinition;
  source: DefinitionSource;
  /** Where a message names it: its file's path in the team repo, the member's file, or teamai's; for `host`, what it is. */
  location: string;
  /** The config whose team repo holds the definition's team runtimes. */
  config: LocalConfig;
  /** For `host`: where the definitions named host are that teamai did not read, which a run's open says once. */
  unread?: string[];
}

/** The marker of a driver definition kept as a folder, `drivers/<name>/DRIVER.yaml`, which takes the folder's name. */
const DRIVER_MARKER = FOLDER_MARKERS.drivers.marker;

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readRegularFileNoLink(file, 'utf8');
  } catch {
    return undefined;
  }
}

type Refused = { ok: false; failure: WorkflowFailure };

function invalid(location: string, reason: string): Refused {
  return { ok: false, failure: { code: 'driver_invalid', message: `Driver definition ${location} is not valid: ${reason}. Fix the file and start again.` } };
}

/** Parses the definition in `file`, which must be named after it, or says why it cannot run, naming it by `location`. */
export function parseDriverDefinition(file: string, text: string, location = file): { ok: true; definition: DriverDefinition } | { ok: false; failure: WorkflowFailure } {
  let raw: unknown;

  try {
    raw = parseYaml(text);
  } catch (error) {
    return invalid(location, `it is not YAML (${error instanceof Error ? error.message : String(error)})`);
  }

  const parsed = DriverDefinitionSchema.safeParse(raw);

  if (!parsed.success) {
    const issue = parsed.error.issues[0];

    return invalid(location, `${issue?.path.join('.') || '(root)'}: ${issue?.message ?? 'unknown problem'}`);
  }

  const definition = parsed.data;
  const stem = path.basename(file) === DRIVER_MARKER ? path.basename(path.dirname(file)) : path.basename(file, '.yaml');

  if (definition.name !== stem) return invalid(location, `its name is "${definition.name}", and a definition is named after its file or its folder, "${stem}"`);
  const named = definitionName(definition.name);

  if (!named.ok) return invalid(location, named.reason);

  return { ok: true, definition };
}

/** The definition `item` holds, read for `config`, or why it cannot run. */
async function readDefinition(item: LayerItem, config: LocalConfig): Promise<{ ok: true; driver: ResolvedDriver } | { ok: false; failure: WorkflowFailure }> {
  const file = definitionFile(item);
  const location = definitionLocation(item);
  const text = await readText(file);

  if (text === undefined) return invalid(location, 'it cannot be read as a file of its own');
  const parsed = parseDriverDefinition(file, text, location);

  return parsed.ok ? { ok: true, driver: { name: parsed.definition.name, definition: parsed.definition, source: SOURCE_OF[item.layer], location, config: item.layer === 'team' ? item.config : config } } : parsed;
}

const SOURCE_OF = { personal: 'personal', team: 'team', teamai: 'shipped' } as const satisfies Record<Layer, DefinitionSource>;

/** The definition file of `item`: the file form itself, or the folder's `DRIVER.yaml`. */
function definitionFile(item: LayerItem): string {
  return item.form === 'folder' ? path.join(item.at, DRIVER_MARKER) : item.at;
}

/** Where a message names `location` of `layer`: a path in the team repo says so, the member's and teamai's say it themselves. */
function inLayer(layer: Layer, location: string): string {
  return layer === 'team' ? `${location} in the team repo` : location;
}

/** Where a message names the definition file of `item`, never by its path in the team clone. */
function definitionLocation(item: LayerItem): string {
  return inLayer(item.layer, item.form === 'folder' && /[\\/]$/.test(item.location) ? `${item.location}${DRIVER_MARKER}` : item.location);
}

/** The failure of a lookup of driver `name` that the first layer holding it refused. */
function refusalOf(name: string, { refusal, layer, location: at }: Extract<LayerFind, { kind: 'refused' }>): WorkflowFailure {
  const location = inLayer(layer, at);
  const fix = layer === 'personal' ? 'Fix it, and start again.' : 'Fix it, push it, run teamai pull, and start again.';

  switch (refusal.kind) {
    case 'duplicate':
      return {
        code: 'driver_namespace_conflict',
        message: layer === 'personal'
          ? `Driver "${name}" is defined twice in your own drivers (${refusal.first} and ${refusal.second}). Keep one, and start again.`
          : `Driver "${name}" is defined twice in one place (${refusal.first} and ${refusal.second}). Keep one, push it, run teamai pull, and start again.`,
      };
    case 'two-namespaces':
      return { code: 'driver_namespace_conflict', message: `Driver "${name}" is defined in two active namespaces (${refusal.first} and ${refusal.second}). Keep it in one namespace, push it, run teamai pull, and start again.` };
    case 'linked-dir':
      return { code: 'driver_invalid', message: `${refusal.dir} in the team repo is a link, and teamai reads the team's driver definitions only from a folder the team repo holds, so it reads none of them. Replace the link with the folder, push it, run teamai pull, and start again.` };
    case 'linked-folder':
      return { code: 'driver_invalid', message: `Driver "${name}": its folder ${refusal.folder} in the team repo is a link, and teamai reads a team driver definition only from a folder the team repo holds. Replace the link with the folder, push it, run teamai pull, and start again.` };
    case 'holds-link':
      return { code: 'driver_invalid', message: `Driver definition ${location} is not valid: it holds the link ${refusal.link}, and teamai reads a driver only from what its folder itself holds. ${fix}` };
    case 'unreadable':
      return { code: 'driver_invalid', message: `Driver definition ${location} is not valid: ${refusal.reason}. ${fix}` };
    case 'no-marker':
      return { code: 'driver_invalid', message: `Driver definition ${location} is not valid: it holds no ${refusal.marker}, the file that defines a driver kept as a folder. ${fix}` };
    default: {
      const unhandled: never = refusal;

      return unhandled;
    }
  }
}

/** `host`: the definition teamai builds in, with no runtime, so only the host slot runs. */
const HOST_DEFINITION: DriverDefinition = {
  schemaVersion: 'v1alpha1',
  name: HOST_DRIVER,
  description: 'Run commands, gates and workflows whose steps need no AI tool, on this machine, and refuse a step that needs one.',
  runtimes: [],
};

/**
 * The built-in `host`, after saying of each member's or team's `host.yaml` that it is not read, so no team repoints it
 * and no file keeps it from running.
 */
async function hostDriver(config: LocalConfig, { personal, user }: { personal: boolean; user: LocalConfig | null }): Promise<ResolvedDriver> {
  const mine = [path.join(personalDir('drivers'), `${HOST_DRIVER}.yaml`), path.join(personalDir('drivers'), HOST_DRIVER, DRIVER_MARKER)];
  const present = await Promise.all(mine.map(async (file) => fs.lstat(file).then(() => true, () => false)));
  const own = personal ? mine.filter((_, index) => present[index]) : [];

  const teams = await Promise.all([config, ...(user ? [user] : [])].map(async (scope) => {
    const found = await findInLayers('drivers', [HOST_DRIVER], { personal: false, teams: [scope], teamai: false });

    if (found.kind === 'found') return [definitionLocation(found.item)];

    return found.kind === 'refused' && (found.refusal.kind === 'duplicate' || found.refusal.kind === 'two-namespaces') ? [found.refusal.first, found.refusal.second].map((at) => inLayer('team', at)) : [];
  }));

  return { name: HOST_DRIVER, definition: HOST_DEFINITION, source: 'builtin', location: 'teamai\'s built-in host driver', config, unread: [...own, ...teams.flat()] };
}

/**
 * The definition `--driver <name>` runs from `config`, or why none runs. `personal: false` skips the member's own
 * definitions, for a run handed over from another member.
 */
export async function resolveDriver(config: LocalConfig, name: string, { personal }: { personal: boolean }): Promise<{ ok: true; driver: ResolvedDriver } | { ok: false; failure: WorkflowFailure }> {
  const user = config.scope === 'project' ? await loadLocalConfigForScope('user', undefined, { dryRun: true }) : null;

  if (name === HOST_DRIVER) return { ok: true, driver: await hostDriver(config, { personal, user }) };
  const named = name === LOCAL_DRIVER ? { ok: true as const } : definitionName(name);

  if (!named.ok) return { ok: false, failure: { code: 'driver_not_found', message: `No driver definition can be named "${name}": ${named.reason}.` } };
  // `local` is no definition's name: it runs `teamai-local`, the member's, then the team's, then teamai's.
  const found = await findInLayers('drivers', name === LOCAL_DRIVER ? [`${SHIPPED_PREFIX}${LOCAL_DRIVER}`] : namesOf(name), { personal, teams: [config, ...(user ? [user] : [])] });

  switch (found.kind) {
    case 'found':
      return await readDefinition(found.item, config);

    case 'refused':
      return { ok: false, failure: refusalOf(name, found) };
    case 'missing':
      break;
    default: {
      const unhandled: never = found;

      return unhandled;
    }
  }

  return {
    ok: false,
    failure: {
      code: 'driver_not_found',
      message: personal
        ? `No driver definition is named "${name}". Add drivers/${name}.yaml to the team repo and run teamai pull, add ~/.teamai/drivers/${name}.yaml for yourself, or use --driver local.`
        : `No driver definition of the team or teamai is named "${name}", and a definition in ~/.teamai/drivers/ does not count here. Add drivers/${name}.yaml to the team repo and run teamai pull, or use --driver local.`,
    },
  };
}
