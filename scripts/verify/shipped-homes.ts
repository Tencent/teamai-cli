/**
 * The homes a world's commands found a shipped tool moved to under its HOME: the root `init` recorded in `toolRoots`,
 * the home recorded in ~/.teamai/tool-homes.json, or the one the command's own variable named. The ledger judges each as
 * the tool's own home; `teamai uninstall` removes the records that name them, so each command records them as it ran.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { absoluteOn, movedToolHome, parseToolHomes, realHost } from '../../src/tool-home.js';
import { descriptorOf, TOOL_ORDER } from '../../src/tool-registry.js';
import { TOOL_IDS, type ToolId } from '../../src/tools.js';
import { LocalConfigSchema, recordedToolRootDir, RELOCATABLE_TOOLS } from '../../src/types.js';
import { installConfigs } from './instances.js';
import { rewriteLocked, type World } from './world.js';

/** A shipped tool and a home of it a command found, relative to the install's HOME. */
export interface ShippedHome {
  readonly tool: ToolId;
  readonly home: string;
}

/** The part of an install's config.yaml that records the roots `init` found moved. */
const InstallRoots = z.object({ toolRoots: LocalConfigSchema.shape.toolRoots });

/** Where the command's own variable moves the root of `tool` (`RELOCATABLE_TOOLS`), which the tool it starts writes in. */
function variableRoot(tool: ToolId, host: Parameters<typeof absoluteOn>[1]): string | null {
  const value = Object.hasOwn(RELOCATABLE_TOOLS, tool) ? host.env[RELOCATABLE_TOOLS[tool]?.envVar ?? '']?.trim() : undefined;

  return value ? absoluteOn(value, host) : null;
}

/**
 * Every home under `home` a command run with `env` from `cwd` finds a shipped tool moved to, through teamai's own resolvers: the
 * root each config of the install records (`recordedToolRootDir`), the root the command's variable names, and the
 * recorded or variable home (`movedToolHome`).
 */
export function movedShippedHomes(home: string, { env, cwd }: { env: Readonly<Record<string, string>>; cwd: string }): ShippedHome[] {
  const host = { ...realHost({ env, home }), toolHomes: parseToolHomes(path.join(home, '.teamai', 'tool-homes.json')), cwd: () => cwd };

  const roots = installConfigs(home).flatMap((config) => {
    const recorded = InstallRoots.safeParse(config).data?.toolRoots;

    return recorded === undefined ? [] : [recorded];
  });

  const found = TOOL_ORDER.flatMap((tool) => [...roots.map((recorded) => recordedToolRootDir(tool, recorded, { home, path })), variableRoot(tool, host), movedToolHome(tool, host)].flatMap((dir) => {
    const relative = dir === null ? '' : path.relative(home, dir);
    const inside = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
    const moved = relative.split(path.sep).join('/');

    return inside && moved !== descriptorOf(tool).home.dir ? [{ tool, home: moved }] : [];
  }));

  return [...new Map(found.map((one) => [keyOf(one), one])).values()];
}

const keyOf = ({ tool, home }: ShippedHome): string => `${tool}\0${home}`;

/** For each HOME of the world, every moved home its commands found a shipped tool at. */
const RecordSchema = z.record(z.string(), z.array(z.object({ tool: z.enum(TOOL_IDS), home: z.string() })));

function recordFile(world: Pick<World, 'dir'>): string {
  return path.join(world.dir, 'shipped-homes.json');
}

/** Adds `seen`, what a command found under `home`, to the world's record. */
export function recordShippedHomes(world: Pick<World, 'dir'>, home: string, seen: readonly ShippedHome[]): void {
  if (seen.length === 0) return;

  rewriteLocked(recordFile(world), (text) => {
    const record = text === undefined ? {} : RecordSchema.parse(JSON.parse(text));
    record[home] = [...new Map([...record[home] ?? [], ...seen].map((one) => [keyOf(one), one])).values()];

    return { value: undefined, text: `${JSON.stringify(record, null, 2)}\n` };
  });
}

/** Every moved home the world's commands found a shipped tool at in the install under `home`. */
export function recordedShippedHomes(world: Pick<World, 'dir'>, home: string): ShippedHome[] {
  const file = recordFile(world);

  return fs.existsSync(file) ? RecordSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')))[home] ?? [] : [];
}
