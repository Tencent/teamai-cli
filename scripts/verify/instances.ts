/**
 * The tool instances an install of a world declares, and where under its HOME the world's commands found each one's
 * home. The ledger judges an instance's home as its tool's own; a home its `home.env` moves is where the commands' own
 * environment put it, which the ledger's process does not have, and `teamai uninstall` removes the records that declare
 * them. So each command of the world records what its install declares as it ran, and the ledger reads that record.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { parseYaml } from '@teamai/shared/yaml';
import { instanceHomeDir, parseToolHomes, realHost } from '../../src/tool-home.js';
import { declaredTable, teamToolInstances, type DeclaredTool } from '../../src/tool-instances.js';
import { TOOL_IDS } from '../../src/tools.js';
import { LocalConfigSchema, ToolPathsSchema } from '../../src/types.js';
import { projectsRootDir } from '../../src/utils/partition.js';
import { rewriteLocked, type World } from './world.js';

/** The part of an install's config.yaml that names its team repo, and the scope that repo serves. */
const InstallRepo = z.object({ repo: LocalConfigSchema.shape.repo, scope: LocalConfigSchema.shape.scope });

/**
 * Each tool instance an install under `home` declares: those of the team repo each data home's config names, every
 * namespace's, and the member's own in ~/.teamai/tools, with its home as teamai joins it to HOME. Read before
 * `teamai uninstall`, which removes those records. An instance it cannot read is judged as no tool's: what it left is a LEAK.
 */
export async function toolInstancesIn(home: string): Promise<DeclaredTool[]> {
  const teamRepos = new Map(installConfigs(home).flatMap((text) => {
    const config = InstallRepo.safeParse(text);

    return config.success ? [[config.data.repo.localPath, config.data.scope] as const] : [];
  }));

  const [repos, own] = await Promise.all([
    Promise.all([...teamRepos].map(async ([root, scope]) => ({ scope, instances: await teamToolInstances({ root, namespaces: async () => 'legacy' }) }))),
    // The member's own folder has the team root's layout, with no namespaces.
    teamToolInstances({ root: path.join(home, '.teamai'), namespaces: async () => [] }),
  ]);

  const instances = [...declaredTable({ repos, own }).values()];

  // `.acme/`, `./.acme` and `.acme` name one folder.
  return instances.map((instance) => (instance.home === undefined ? instance : { ...instance, home: { ...instance.home, dir: path.posix.normalize(instance.home.dir).replace(/\/+$/, '') } }));
}

/** The config.yaml of each data home of the install under `home`, the user's and each project's, as YAML values: one it cannot read is left out. */
export function installConfigs(home: string): unknown[] {
  const projects = projectsRootDir(home);
  const dataHomes = [path.join(home, '.teamai'), ...(fs.existsSync(projects) ? fs.readdirSync(projects).map((slug) => path.join(projects, slug)) : [])];

  return dataHomes.flatMap((dataHome) => {
    try {
      return [parseYaml(fs.readFileSync(path.join(dataHome, 'config.yaml'), 'utf8'))];
    } catch {
      return [];
    }
  });
}

/** An instance an install declares, and its home as a command of the world found it. */
export interface InstallInstance {
  readonly declared: DeclaredTool;
  /** That home relative to the install's HOME; undefined when it has none of its own, or it lies outside HOME. */
  readonly home?: string | undefined;
}

const DeclaredFile = z.object({
  name: z.string(),
  extends: z.enum(TOOL_IDS),
  paths: ToolPathsSchema.optional(),
  source: z.enum(['team', 'personal']),
  file: z.string(),
  location: z.string(),
  revision: z.string(),
});

const RecordedInstance = z.object({
  declared: z.discriminatedUnion('kind', [
    DeclaredFile.extend({
      kind: z.literal('instance'),
      command: z.string().optional(),
      home: z.object({ dir: z.string(), env: z.string().optional() }).optional(),
    }),
    DeclaredFile.extend({ kind: z.literal('adjustment') }),
  ]),
  home: z.string().optional(),
});

/** For each HOME of the world, every instance its install declared and each home a command of the world found it at. */
const RecordSchema = z.record(z.string(), z.array(RecordedInstance));

function recordFile(world: Pick<World, 'dir'>): string {
  return path.join(world.dir, 'instances.json');
}

/**
 * What the install under `home` declares, each home where a command run with `env` from `cwd` finds it: through
 * `instanceHomeDir`, as teamai and the tool it launches resolve it, so a home is the one the install recorded for its
 * `home.env` (its ~/.teamai/tool-homes.json, never the harness's own), else where that variable says.
 */
export async function installInstances(home: string, { env, cwd }: { env: Readonly<Record<string, string>>; cwd: string }): Promise<InstallInstance[]> {
  const host = { ...realHost({ env, home }), toolHomes: parseToolHomes(path.join(home, '.teamai', 'tool-homes.json')), cwd: () => cwd };

  return (await toolInstancesIn(home)).map((declared) => {
    if (declared.home === undefined) return { declared, home: undefined };
    const relative = path.relative(home, instanceHomeDir({ name: declared.name, home: declared.home }, host));
    const inside = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);

    return { declared, home: inside ? relative.split(path.sep).join('/') : undefined };
  });
}

const keyOf = ({ declared, home }: InstallInstance): string => `${declared.name}\0${home ?? ''}`;

/** Adds `seen`, what the install under `home` declares as a command found it, to the world's record; a later sighting replaces an earlier one at the same home. */
export function recordInstallInstances(world: Pick<World, 'dir'>, home: string, seen: readonly InstallInstance[]): void {
  if (seen.length === 0) return;

  rewriteLocked(recordFile(world), (text) => {
    const record = text === undefined ? {} : RecordSchema.parse(JSON.parse(text));
    record[home] = [...new Map([...record[home] ?? [], ...seen].map((instance) => [keyOf(instance), instance])).values()];

    return { value: undefined, text: `${JSON.stringify(record, null, 2)}\n` };
  });
}

/** Every instance the world's commands found the install under `home` declares, at each home they found it. */
export function recordedInstallInstances(world: Pick<World, 'dir'>, home: string): InstallInstance[] {
  const file = recordFile(world);

  return fs.existsSync(file) ? RecordSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')))[home] ?? [] : [];
}

/**
 * The instances as the ledger judges what is under HOME: one for each home an instance was found at, its home that one
 * (so `instanceView` places its tool's reads and teamai's deliveries there), and none for one found outside HOME.
 */
export function judgedInstances(seen: readonly InstallInstance[]): DeclaredTool[] {
  const unique = new Map(seen.map((instance) => [keyOf(instance), instance]));

  return [...unique.values()].flatMap(({ declared, home }) => (declared.home === undefined ? [declared] : home === undefined ? [] : [{ ...declared, home: { dir: home } }]));
}
