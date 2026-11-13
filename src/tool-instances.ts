import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { isBareCommandName } from '@teamai/shared/cli-path';
import { INSTANCE_KEYS, type ToolInstance, type ToolInstanceHome } from '@teamai/tool-core/instance';
import { FOLDER_MARKERS } from './folder-markers.js';
import { isSymlink, RESOURCE_LAYOUTS, Resources, type TeamTree } from './resources/resolver.js';
import { isSessionPlatform } from './session-flow/adapters/platform-facts.js';
import { instanceHomeAfterInit, instanceHomeDir, isSameDirOn, realHost, toolHome, type Host } from './tool-home.js';
import { INSTANCE_BASES, isInstanceBase, isToolId, TOOL_ORDER, toolInstancesFor, toolOf, useToolInstances } from './tool-registry.js';
import type { ToolId } from './tools.js';
import { DEFAULT_TOOL_PATHS, TOOL_ROOT_FIELDS, getTeamaiHomeDir, getTrustDir, recordedToolRootDir, RELOCATABLE_TOOLS, rerootToolPaths, toolInstallRoot, toolPathRoots, ToolPathsSchema, type Scope, type TeamaiConfig } from './types.js';
import { writeJsonAtomic } from './utils/fs.js';
import { log } from '@teamai/shared/log';
import { errorOnce, warnOnce } from './utils/warn-once.js';
import { parseYaml } from '@teamai/shared/yaml';
import { readRegularFile, readRegularFileSync } from '@teamai/shared/regular-file';

// ─── Tool instances ──────────────────────────────────────
//
//  A team adds a tool as an instance of a shipped one, in tools/<name>.yaml of the team repo (or tools/<namespace>/),
//  and a member in ~/.teamai/tools/<name>.yaml, which teamai reads and never writes. Either may keep it as a folder
//  tools/<name>/TOOL.yaml instead, read the same way. An instance sets another command,
//  home and paths, and no code: it keeps the formats of the tool it extends. A member's own instance replaces the
//  team's of the same name. An instance named like a shipped tool adjusts it, and sets only paths.
//

/** Where an instance was read: the team repo, which a teammate pushes to, or the member's own directory. */
export type InstanceSource = 'team' | 'personal';

/** What every tools/ file declares, with where it came from and the hash of that file. */
interface DeclaredToolFile {
  readonly name: string;
  readonly extends: ToolId;
  /** The tool paths it sets, which replace the paths of the tool it extends whole, as a `toolPaths` entry does. */
  readonly paths?: z.infer<typeof ToolPathsSchema>;
  readonly source: InstanceSource;
  /** The file it was read from, for messages and acceptance. */
  readonly file: string;
  /** Where a note names it: its path in the team repo, such as tools/acme-claude.yaml, or a member's file. */
  readonly location: string;
  /** The sha256 of that file: a person accepts a team instance's command at this content. */
  readonly revision: string;
}

/** The marker of an instance kept as a folder, `tools/<name>/TOOL.yaml`, which takes the folder's name. */
const TOOL_MARKER = FOLDER_MARKERS.tools.marker;

/** A tool of its own over a shipped one, under a name of its own, with its own command, home or paths. */
export interface ResolvedToolInstance extends DeclaredToolFile, ToolInstance<ToolId> {
  readonly kind: 'instance';
}

/** A file named like the shipped tool it extends: it replaces that tool's paths, and runs or lives nowhere else. */
export interface ResolvedToolAdjustment extends DeclaredToolFile {
  readonly kind: 'adjustment';
  readonly command?: never;
  readonly home?: never;
}

/** What a tools/ file declares: an instance, or an adjustment of the shipped tool it is named after. */
export type DeclaredTool = ResolvedToolInstance | ResolvedToolAdjustment;

const NAME = /^[a-z0-9][a-z0-9._-]*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A `$HOME`-relative directory under `$HOME`, never `$HOME` itself. */
const HomeDir = z.string().min(1).refine((dir) => {
  const segments = dir.split(/[\\/]/);

  return !path.isAbsolute(dir) && !segments.includes('..') && segments.some((segment) => segment !== '' && segment !== '.');
}, 'home.dir is a directory under your home, such as .acme-claude, not your home itself, with no ..');

const InstanceFileSchema = z.object({
  schemaVersion: z.literal('v1alpha1'),
  name: z.string().regex(NAME, 'A tool name starts with a lowercase letter or digit and holds only lowercase letters, digits, dots, dashes and underscores'),
  extends: z.string()
    .refine(isToolId, { error: (issue) => `${String(issue.input)} is not a tool teamai ships. Extend one of: ${INSTANCE_BASES.join(', ')}` }),
  // A path is refused: what runs there, maybe in the step's own checkout, is not the file a person accepted.
  command: z.string().refine(isBareCommandName, 'command is the name of one executable on PATH, with no path, spaces or arguments, such as acme-claude').optional(),
  home: z.object({ dir: HomeDir, env: z.string().regex(ENV_NAME, 'home.env is the name of an environment variable').optional() }).strict().optional(),
  paths: ToolPathsSchema.optional(),
});

/** An instance file teamai does not use, and why. */
export interface RefusedInstance {
  readonly ok: false;
  readonly problem: string;
}

/** Why `file` is not an instance teamai can use. */
function refused(file: string, reason: string): RefusedInstance {
  return { ok: false, problem: `Tool instance ${file} is not valid: ${reason}. Fix the file; until then teamai does not use it.` };
}

/** The first user-scope path of `paths` outside `dir`, a `$HOME`-relative directory, by the key that sets it. */
function userPathOutside(paths: z.infer<typeof ToolPathsSchema>, dir: string): { key: string; value: string } | undefined {
  const posix = (value: string): string => path.posix.normalize(value.replaceAll('\\', '/')).replace(/\/+$/, '');
  const home = posix(dir);

  for (const field of TOOL_ROOT_FIELDS) {
    const own = field === 'mcp' ? undefined : paths.userScope?.[field];
    const value = own === undefined ? paths[field] : own;

    if (value !== undefined && value !== null && posix(value) !== home && !posix(value).startsWith(`${home}/`)) {
      return { key: own === undefined ? `paths.${field}` : `paths.userScope.${field}`, value };
    }
  }

  return undefined;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Parses the instance `text` of `file`, which is named after it, or says why teamai does not use it. */
function parseToolInstance({ file, text, source, location }: { file: string; text: string; source: InstanceSource; location: string }): { ok: true; instance: DeclaredTool } | RefusedInstance {
  let raw: unknown;

  try {
    raw = parseYaml(text);
  } catch (error) {
    return refused(file, `it is not YAML (${error instanceof Error ? error.message : String(error)})`);
  }

  if (raw instanceof Object && !Array.isArray(raw)) {
    const extra = Object.keys(raw).find((key) => !INSTANCE_KEYS.some((allowed) => allowed === key));

    if (extra !== undefined) {
      return refused(file, `it sets ${extra}, and an instance sets only command, home and paths. It keeps the formats of the tool it extends, so its sessions, tokens and launch flags read as that tool's`);
    }
  }

  const parsed = InstanceFileSchema.safeParse(raw);

  if (!parsed.success) {
    const issue = parsed.error.issues[0];

    return refused(file, `${issue?.path.join('.') || '(root)'}: ${issue?.message ?? 'unknown problem'}`);
  }

  const { schemaVersion: _version, extends: base, ...fields } = parsed.data;

  if (!isInstanceBase(base)) {
    return refused(file, fields.name === base
      ? `extends: teamai does not adjust ${base} with a tools/ file yet; move its paths with a toolPaths.${base} entry in teamai.yaml`
      : `extends: an instance extends ${INSTANCE_BASES.join(' or ')}; teamai does not support an instance of ${base} or any other tool yet`);
  }

  const stem = path.basename(file) === TOOL_MARKER ? path.basename(path.dirname(file)) : path.basename(file, '.yaml');

  if (fields.name !== stem) return refused(file, `its name is "${fields.name}", and an instance is named after its file or its folder, "${stem}"`);
  const adjusts = fields.name === base ? (['command', 'home'] as const).find((key) => fields[key] !== undefined) : undefined;

  if (adjusts !== undefined) {
    return refused(file, `it sets ${adjusts}, and a file named like the tool it adjusts sets only paths; `
      + `to run another command or keep another home, write an instance of ${base} instead, such as name: acme-${base}, extends: ${base} in tools/acme-${base}.yaml`);
  }

  if (isToolId(fields.name) && fields.name !== base) {
    return refused(file, `"${fields.name}" is a tool teamai ships, and an instance named like one adjusts it, so it extends ${fields.name}`);
  }

  const homeVariable = RELOCATABLE_TOOLS[base]?.envVar;

  // Windows reads a variable's name in any case, and a team file reaches every member's platform.
  if (homeVariable !== undefined && fields.home?.env?.toUpperCase() === homeVariable.toUpperCase()) {
    return refused(file, `home.env: ${fields.home.env} names ${homeVariable}, the variable ${base} reads its home from in any letter case, and teamai sets it to this instance's home when it starts it; leave env out`);
  }

  if (!isToolId(fields.name) && isSessionPlatform(fields.name)) return refused(file, `"${fields.name}" is the name of a session platform teamai ships`);
  const shippedAt = fields.command === undefined ? fields.home : undefined;
  const outside = shippedAt && fields.paths && userPathOutside(fields.paths, shippedAt.dir);

  // teamai starts the shipped command at the instance's home, the only place it reads user files from.
  if (shippedAt && outside) {
    return refused(file, `${outside.key}: ${outside.value} is outside its home, and with no command it runs ${base} at that home, which reads none of it there. `
      + `Leave home out to keep the home of ${base}, or point every user-scope path inside ${shippedAt.dir}`);
  }

  const declared = { source, file, location, revision: sha256(text) };

  return {
    ok: true,
    instance: fields.name === base
      ? { kind: 'adjustment', name: fields.name, extends: base, paths: fields.paths, ...declared }
      : { kind: 'instance', ...fields, extends: base, ...declared },
  };
}

async function readText(file: string): Promise<string | undefined> {
  try {
    const stat = await fs.lstat(file);

    return stat.isFile() ? await readRegularFile(file, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The instance files in `dir`: each `<name>.yaml`, and each `<name>/TOOL.yaml`. A name kept both ways is logged and
 * neither is read.
 */
async function instanceFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = new Map(entries.filter((entry) => entry.isFile() && entry.name.endsWith('.yaml')).map((entry) => [entry.name.slice(0, -'.yaml'.length), path.join(dir, entry.name)]));
  const folders = entries.filter((entry) => entry.isDirectory()).map((entry) => [entry.name, path.join(dir, entry.name, TOOL_MARKER)] as const);
  const marked = await Promise.all(folders.map(async ([, marker]) => (await fs.lstat(marker).catch(() => undefined))?.isFile() === true));

  for (const [index, [name, marker]] of folders.entries()) {
    if (!marked[index]) continue;
    const file = files.get(name);

    if (file === undefined) {
      files.set(name, marker);
      continue;
    }

    errorOnce(`Tool instance "${name}" is defined twice in your own tools (${file} and ${marker}), so teamai uses neither. Keep one.`);
    files.delete(name);
  }

  return [...files.values()].sort();
}

/** Each instance in `files`, parsed; one that does not parse is logged and left out. */
async function readInstances(files: readonly string[], source: InstanceSource): Promise<DeclaredTool[]> {
  const read = await Promise.all(files.map(async (file) => {
    const text = await readText(file);

    return text === undefined ? undefined : parseToolInstance({ file, text, source, location: file });
  }));

  return read.flatMap(usable);
}

/** The instance `parsed` gives, or none after logging why it is not used. */
function usable(parsed: ReturnType<typeof parseToolInstance> | undefined): DeclaredTool[] {
  if (parsed === undefined) return [];

  if (!parsed.ok) {
    errorOnce(parsed.problem);

    return [];
  }

  return [parsed.instance];
}

/** The team's layers a scope reads its instances from, and which scope that is: a workspace's instance replaces the user scope's. */
export interface TeamToolTree extends TeamTree {
  readonly scope: Scope | undefined;
  /** Whether it is read for a member, whose namespaces and scope it has, rather than for a field of teamai.yaml alone. */
  readonly isForMember: boolean;
}

/**
 * The instances of the team tree `team`: `tools/<name>.yaml`, and `tools/<namespace>/<name>.yaml` for each namespace
 * active for the member, which replaces the root one. Two of one name in two active namespaces are a conflict, and
 * neither is used; an instance an active namespace replaces is not used even when the namespace's does not parse. A
 * `tools` folder that is a link gives none: what it names is not the team repo's.
 */
export async function teamToolInstances(team: TeamTree): Promise<DeclaredTool[]> {
  if (await isSymlink(path.join(team.root, RESOURCE_LAYOUTS.tools.dir))) {
    errorOnce('tools in the team repo is a link, and teamai reads the team\'s tool instances only from a folder the team repo holds, so it uses none of them. Replace the link with the folder, push it, and run teamai pull.');

    return [];
  }

  const { resolutions, diagnostics } = await Resources.survey(RESOURCE_LAYOUTS.tools, { team });

  for (const diagnostic of diagnostics) if (diagnostic.kind === 'invalid') errorOnce(diagnostic.message);

  const read = await Promise.all(resolutions.map(async (resolution) => {
    if (resolution.kind === 'conflict') {
      log.error(`Tool instance "${resolution.name}" is defined twice in the team repo (${resolution.first.source.path} and ${resolution.second.source.path}), so teamai uses neither. Keep one, push it, and run teamai pull.`);

      return undefined;
    }

    const { source } = resolution.item;
    const [file, location] = source.kind === 'folder' ? [path.join(source.full, TOOL_MARKER), `${source.path}${TOOL_MARKER}`] : [source.full, source.path];
    const text = await readText(file);

    return text === undefined ? undefined : parseToolInstance({ file, text, source: 'team', location });
  }));

  return read.flatMap(usable);
}

/** The name of the member's own instance directory in `~/.teamai/`. */
export const PERSONAL_TOOLS_DIR = 'tools';

/** The member's own instance directory, `~/.teamai/tools/`: teamai reads it and never writes it. */
export function personalToolsDir(): string {
  return path.join(getTeamaiHomeDir(), PERSONAL_TOOLS_DIR);
}

/** The member's own instances, from `personalToolsDir()`. */
export async function personalToolInstances(): Promise<DeclaredTool[]> {
  const dir = personalToolsDir();

  return readInstances(await instanceFiles(dir), 'personal');
}

// ─── The instances this process sees ─────────────────────

/** The instances read from each team repo this process loaded, by the repo's real path, with the scope that repo serves. */
const teamByRepo = new Map<string, { readonly scope: Scope | undefined; readonly instances: readonly DeclaredTool[]; readonly isForMember: boolean }>();
let personal: readonly DeclaredTool[] = [];
let readsPersonal = true;

/** The roots the member recorded for the shipped tools (`toolRoots`), read with the instances, for `homeSharedWith`. */
let memberToolRoots: Readonly<Record<string, string>> | undefined;

/** Where each instance's home is judged: where it is now, or, in `teamai init`, where init is about to record it. */
let homeOf: typeof instanceHomeDir = instanceHomeDir;

/**
 * Leaves the member's own instances out of every lookup from now on, for a run handed over from another member
 * (`resume --next`), whose tools are the team's.
 */
export function ignorePersonalToolInstances(): void {
  readsPersonal = false;
  publish();
}

/** Forgets every team repo and member's directory this process loaded, for a test that loads another. */
export function resetToolInstancesForTests(): void {
  teamByRepo.clear();
  personal = [];
  memberToolRoots = undefined;
  readsPersonal = true;
  homeOf = instanceHomeDir;
  publish();
}

/**
 * From the next load on, judges each instance's home where `teamai init` is about to record it, so init names no
 * refusal for a record it replaces and names one for a value it would record.
 */
export function judgeInstanceHomesAsInit(): void {
  homeOf = instanceHomeAfterInit;
}

/**
 * The instances the files declare, before any is refused for its home: the member's own over the team's, and a
 * workspace's team instance over the user scope's of the same name, as its driver definitions do. One name two team
 * repos of one scope define apart is left out.
 */
function declaredTable(): Map<string, DeclaredTool> {
  const table = new Map<string, DeclaredTool>();
  const repos = [...teamByRepo.values()];

  for (const scope of ['user', 'project'] as const) {
    const ofScope = repos.filter((repo) => (repo.scope ?? 'user') === scope).flatMap((repo) => repo.instances);
    const conflicted = new Set<string>();
    const own = new Map<string, DeclaredTool>();

    for (const instance of ofScope) {
      const known = own.get(instance.name);

      if (known === undefined) own.set(instance.name, instance);
      else if (known.revision !== instance.revision) conflicted.add(instance.name);
    }

    for (const name of conflicted) {
      const files = ofScope.flatMap((instance) => (instance.name === name ? [instance.file] : []));

      warnOnce(`Tool instance "${name}" is defined apart in two team repos (${files.join(' and ')}), so teamai uses neither. Make them the same, or rename one.`);
      own.delete(name);
    }

    for (const [name, instance] of own) table.set(name, instance);
  }

  if (readsPersonal) for (const instance of personal) table.set(instance.name, instance);

  return table;
}

/**
 * The tool other than `name` whose home `home` resolves to on `host`: a shipped tool's (`toolHome`, or the root the
 * member recorded for it in `toolRoots`) or that of another of `instances`; undefined for none. The check of a file
 * and the check of where it resolves both ask this, on a host with no variable or record and on the real one.
 */
function homeSharedWith({ name, home, instances, host, toolRoots }: {
  name: string; home: ToolInstanceHome; instances: readonly DeclaredTool[]; host: Host; toolRoots?: Readonly<Record<string, string>>;
}): string | undefined {
  return toolHomedAt({ name, dir: homeOf({ name, home }, host), instances, host, toolRoots });
}

/** The tool other than `name` whose home resolves to `dir`: a shipped tool's, a root `toolRoots` records, or another instance's. */
function toolHomedAt({ name, dir: own, instances, host, toolRoots }: {
  name: string; dir: string; instances: readonly DeclaredTool[]; host: Host; toolRoots?: Readonly<Record<string, string>>;
}): string | undefined {
  const at = { home: host.home, path: host.path, readTextNow: (file: string) => host.readTextNow(file), existsNow: (file: string) => host.existsNow(file) };
  const same = (dir: string | null): boolean => dir !== null && isSameDirOn(host, own, dir);

  return TOOL_ORDER.find((tool) => same(toolHome(tool, host)) || same(recordedToolRootDir(tool, toolRoots, at)))
    ?? instances.find((other) => other.name !== name && other.home !== undefined && same(homeOf({ name: other.name, home: other.home }, host)))?.name;
}

/**
 * `table` without an instance whose home is another tool's: two tools on one home write over each other's skills,
 * hooks and sessions, and credit one's sessions to the other. A `home.dir` that names one is a fault of the file; a
 * home that only resolves to one, through its variable or the member's `toolRoots`, is named with both tools.
 */
function withoutSharedHomes(table: Map<string, DeclaredTool>): Map<string, DeclaredTool> {
  const instances = [...table.values()];
  const host = realHost();
  const unmoved: Host = { ...host, env: {}, toolHomes: { kind: 'missing' } };

  for (const instance of instances) {
    const { name, home } = instance;

    if (home === undefined) continue;
    const declared = homeSharedWith({ name, home, instances, host: unmoved });

    if (declared !== undefined) {
      errorOnce(refused(instance.file, `home.dir: ${home.dir} is the home of ${declared} too, and two tools on one home write over each other's skills, hooks and sessions; give it a directory of its own`).problem);
      table.delete(name);
      continue;
    }

    const own = homeOf({ name, home }, host);

    // home.dir cannot name the home itself; only the instance's variable, or the record init made of it, can.
    if (home.env !== undefined && isSameDirOn(host, own, host.home)) {
      errorOnce(`Tool instance ${name} (${instance.location}) is not used: its home resolves to your home directory itself, ${own}, `
        + `where it would read and write every file in your home as its own. Point ${home.env} at a directory of its own and re-run \`teamai init\`.`);
      table.delete(name);
      continue;
    }

    const resolved = homeSharedWith({ name, home, instances, host, toolRoots: memberToolRoots });

    if (resolved !== undefined) {
      const shared = `Tool instance ${name} (${instance.location}) is not used: its home resolves to ${own}, which is also the home of ${resolved}, `
        + 'and two tools on one home write over each other\'s skills, hooks and sessions.';

      // Only a blank variable at init clears a record, and nothing else would say so. One text whether or not a record
      // exists yet, since init judges before and after it writes one.
      errorOnce(home.env === undefined
        ? `${shared} Move one of the two homes, then re-run \`teamai init\`: a pull keeps the home it recorded.`
        : `${shared} Move one of the two homes, then re-run \`teamai init\`, or clear the record with \`${home.env}= teamai init\`: a pull keeps the home it recorded.`);
      table.delete(name);
    }
  }

  return table;
}

function publish(): void {
  const declared = declaredTable();

  useToolInstances(withoutSharedHomes(new Map(declared)), declared);
}

/**
 * The hook files teamai may have left for the declared instance `name`, a refused one included, in `homes` it no longer
 * delivers to. `current` is the home it delivers to now, null for none, or `default` for the directory `home.dir` names.
 * Left out: `current`, your home directory, where nothing is recorded, a home
 * another tool resolves to now, whose hooks are that tool's, and every home of an instance with no home or with paths
 * of its own.
 */
export function leftInstanceHookFiles({ name, homes, current, toolRoots }: {
  name: string; homes: readonly string[]; current: string | null | 'default'; toolRoots?: Readonly<Record<string, string>>;
}): Array<{ readonly home: string; readonly file: string }> {
  const instances = toolInstancesFor('guard');
  const instance = instances.find((one) => one.name === name);

  if (instance?.home === undefined || instance.paths !== undefined) return [];
  const { dir } = instance.home;
  const moved = defaultPathsOf(instance);
  const settings = moved.userScope?.settings ?? moved.settings;

  if (settings === undefined) return [];
  const host = realHost();
  const now = current === 'default' ? path.join(host.home, ...dir.split('/')) : current;

  return [...new Set(homes)].flatMap((home) => (now !== null && isSameDirOn(host, home, now)) || isSameDirOn(host, home, host.home)
    || toolHomedAt({ name, dir: home, instances, host, toolRoots }) !== undefined ? [] : [{ home, file: path.join(home, path.relative(dir, settings)) }]);
}

/** Whether `instance` reads a project under its home's folder: only its own build may; the shipped command reads a project where the tool it extends does. */
function movesProjectPaths(instance: DeclaredTool): boolean {
  return instance.command !== undefined;
}

/**
 * `paths`, those of the tool `instance` extends, moved to its home: every one for an instance with its own build, the
 * user-scope ones alone (`userScope`) for one on the shipped command, whose project paths stay the tool's.
 */
function movedToHome(instance: DeclaredTool, paths: z.infer<typeof ToolPathsSchema>): z.infer<typeof ToolPathsSchema> {
  if (!instance.home) return paths;
  const moved = rerootToolPaths(paths, instance.home.dir);

  if (movesProjectPaths(instance)) return moved;

  const userScope = Object.fromEntries(ToolPathsSchema.shape.userScope.unwrap().keyof().options.flatMap((field) => {
    const value = moved.userScope?.[field] === undefined ? moved[field] : moved.userScope[field];

    return value === undefined ? [] : [[field, value]];
  }));

  return { ...paths, mcp: moved.mcp, userScope };
}

/**
 * The tool whose model aliases render `tool`'s agent files in `scope`. In a project an instance on the shipped command
 * writes the agents directory of the tool it extends, so that one file renders as that tool's from either pass.
 */
export function agentModelToolOf(tool: string, scope: Scope): string {
  const instance = toolOf(tool)?.instance;

  if (instance?.kind !== 'instance' || scope === 'user' || movesProjectPaths(instance)) return tool;

  const shipped: z.infer<typeof ToolPathsSchema> = DEFAULT_TOOL_PATHS[instance.extends];

  return instance.paths === undefined || instance.paths.agents === shipped.agents ? instance.extends : tool;
}

/** The tool paths `instance` gives its tool: its own `paths`, else the paths of the tool it extends, moved to its home. */
function instancePaths(instance: DeclaredTool, toolPaths: TeamaiConfig['toolPaths']): z.infer<typeof ToolPathsSchema> | undefined {
  return instance.paths ?? movedToHome(instance, toolPaths[instance.extends] ?? DEFAULT_TOOL_PATHS[instance.extends]);
}

/** The paths `instance` replaces with its own: those of the tool it adjusts, or of the tool it extends, moved to its home. */
export function defaultPathsOf(instance: DeclaredTool): z.infer<typeof ToolPathsSchema> {
  return movedToHome(instance, DEFAULT_TOOL_PATHS[instance.extends]);
}

/**
 * Where `instance` reads a file the tool it extends reads at `relative`, under the home or the project (`from`): under
 * its own home when it has one, moved as its tool paths are (`instancePaths`), so what teamai writes there is judged
 * read. A path outside that tool's roots, a file at the project's root, and a project path of an instance on the
 * shipped command stay as they are, and so does every path of an instance that sets its own paths, which teamai
 * writes to as they are.
 */
export function instanceReadPath(instance: DeclaredTool, { from, relative }: { from: 'home' | 'project'; relative: string }): string {
  if (!instance.home || instance.paths || (from === 'project' && !movesProjectPaths(instance))) return relative;

  // A bare file beside the tool's home (Claude Code's .claude.json) is inside a home that moved, as the instance's is.
  if (!relative.includes('/')) return from === 'home' ? `${instance.home.dir}/${relative}` : relative;
  const root = toolInstallRoot(relative);

  return toolPathRoots(DEFAULT_TOOL_PATHS[instance.extends]).has(root) ? instance.home.dir + relative.slice(root.length) : relative;
}

/**
 * `config`, the team config of the tree `tree`, with the instances of that tree and the member's own read,
 * every lookup of a tool name seeing them, and their tool paths in `toolPaths`. A member's instance replaces the team's.
 */
export async function withToolInstances(tree: TeamToolTree, config: TeamaiConfig): Promise<TeamaiConfig> {
  const [team, own, repo] = await Promise.all([
    teamToolInstances(tree),
    readsPersonal ? personalToolInstances() : [],
    // Two spellings of one repo, through a link or /tmp against /private/tmp, are one repo.
    fs.realpath(tree.root).catch(() => path.resolve(tree.root)),
  ]);

  // A read for no member never replaces the member's instances, which another loader of this process published.
  if (tree.isForMember || teamByRepo.get(repo)?.isForMember !== true) teamByRepo.set(repo, { scope: tree.scope, instances: team, isForMember: tree.isForMember });

  personal = own;

  if ([...team, ...own].some((instance) => instance.home !== undefined)) memberToolRoots = await realHost().userToolRoots();
  publish();

  const byName = new Map(team.map((instance) => [instance.name, instance]));

  for (const instance of own) byName.set(instance.name, instance);

  if (byName.size === 0) return config;
  const toolPaths = { ...config.toolPaths };

  for (const instance of byName.values()) {
    // One the table leaves out, refused or defined apart, gets no paths either, or it would be delivered to as a tool of its own.
    if (toolOf(instance.name)?.instance === undefined) continue;
    const paths = instancePaths(instance, config.toolPaths);

    if (paths) toolPaths[instance.name] = paths;
  }

  return { ...config, toolPaths };
}

// ─── Accepting a team file's command ─────────────────────
//
//  A team file that names a command, a tool instance's `command` or a step runtime's `entry: { command }`, runs a
//  program a teammate named on the member's machine. Before its first run with a given file content, a person accepts
//  that content: an attended run asks, and an unattended one refuses. A member's own file, and an instance that sets
//  only home or paths, need no acceptance.
//

const TrustFileSchema = z.object({
  accepted: z.array(z.object({ kind: z.literal('runtime').optional(), name: z.string(), revision: z.string(), acceptedAt: z.string() })),
});

function trustFile(): string {
  return path.join(getTrustDir(), 'tools.json');
}

type TrustFile = z.infer<typeof TrustFileSchema>;

/** The acceptances `text`, the trust file's content, records; none for a file that is missing or does not parse. */
function trustOf(text: string | undefined): TrustFile {
  try {
    return TrustFileSchema.parse(JSON.parse(text ?? ''));
  } catch {
    return { accepted: [] };
  }
}

const TRUST_LOCK_WAIT = { attempts: 50, delayMs: 100 };

/**
 * A command a file of the team repo names, accepted at that file's content (`revision`, its sha256): a tool instance's,
 * which runs in place of the tool it extends, or a step runtime's. One name of each kind is accepted at one content.
 */
export type TeamCommand =
  | { readonly kind: 'tool'; readonly name: string; readonly command: string; readonly file: string; readonly revision: string; readonly extends: string }
  | { readonly kind: 'runtime'; readonly name: string; readonly command: string; readonly file: string; readonly revision: string };

/** Why a team file's command did not run: the person said no, closed the question unanswered, or was not there to ask. */
export interface UnacceptedTeamCommand {
  readonly ok: false;
  readonly reason: 'declined' | 'unanswered' | 'unattended';
  readonly message: string;
}

function labelOf(subject: TeamCommand): string {
  switch (subject.kind) {
    case 'tool':
      return `Tool "${subject.name}"`;
    case 'runtime':
      return `Step runtime "${subject.name}"`;
    default: {
      const unhandled: never = subject;

      return unhandled;
    }
  }
}

/** Whether `entry` of the trust file accepts `subject` at its content. */
function accepts(entry: z.infer<typeof TrustFileSchema>['accepted'][number], subject: TeamCommand): boolean {
  return (entry.kind ?? 'tool') === subject.kind && entry.name === subject.name;
}

/**
 * Whether the command of `subject` may run here: a person must have accepted its file's content on this machine. `ask`,
 * given when a person at a terminal answers, puts the question to them and returns the line they typed, or nothing once
 * the run stopped asking; a yes is recorded, and anything else declines. With no one to ask, an unaccepted content is
 * refused, naming what to run.
 */
export async function acceptTeamCommand(
  subject: TeamCommand,
  { ask }: { ask: ((question: string) => Promise<string | undefined>) | undefined },
): Promise<{ ok: true } | UnacceptedTeamCommand> {
  const trust = await readTrust();

  if (trust.accepted.some((entry) => accepts(entry, subject) && entry.revision === subject.revision)) return { ok: true };
  const short = subject.revision.slice(0, 12);
  const label = labelOf(subject);

  if (ask) {
    const inPlaceOf = subject.kind === 'tool' ? `, in place of ${subject.extends}` : '';

    const question = `${label} comes from the team repo (${subject.file}, content ${short}), which you have not accepted on this machine. `
      + `It runs ${subject.command} as you, with your files${inPlaceOf}. Review the file before you accept it.\nRun it? [y/N] `;

    const answer = await ask(question);

    if (/^y(es)?$/i.test(answer?.trim() ?? '')) {
      const entry = { ...(subject.kind === 'runtime' && { kind: subject.kind }), name: subject.name, revision: subject.revision, acceptedAt: new Date().toISOString() };
      // Read again under the lock: another step may have accepted another command while this one asked. Loaded here,
      // since update.js reaches config.js, which loads this module on every hook.
      const { withFileLock } = await import('./update.js');

      const recorded = await withFileLock(`${trustFile()}.lock`, TRUST_LOCK_WAIT, async () => {
        const current = await readTrust();

        await writeJsonAtomic(trustFile(), { accepted: [...current.accepted.filter((kept) => !accepts(kept, subject)), entry] });
      });

      if (!recorded.held) log.warn(`${label} runs as you accepted it, but ${trustFile()} stayed locked by another teamai process, so the next run asks again.`);

      return { ok: true };
    }

    return { ok: false, reason: answer === undefined ? 'unanswered' : 'declined', message: `${label} (content ${short}) was not accepted, so ${subject.command} did not run.` };
  }

  return {
    ok: false,
    reason: 'unattended',
    message: `${label} comes from the team repo (${subject.file}, content ${short}) and runs ${subject.command}, which no one has accepted on this machine, and an unattended run does not ask. `
      + 'Run the same command once in a terminal, attended, to review and accept it, then run it unattended again.',
  };
}

async function readTrust(): Promise<TrustFile> {
  return trustOf(await readRegularFile(trustFile(), 'utf8').catch(() => undefined));
}

/** The `tool` subject of `instance`'s command, which acceptance records by its name and file content. */
function toolCommandOf(instance: ResolvedToolInstance & { readonly command: string }): TeamCommand {
  return { kind: 'tool', name: instance.name, command: instance.command, file: instance.file, revision: instance.revision, extends: instance.extends };
}

/**
 * The command `instance` sets when it may run here with no one to ask: a member's own instance's, or a team instance's
 * whose file content a person accepted (`acceptToolCommand`). Undefined for any other, and for one that sets none. Read
 * where nothing can ask, such as the session adapters, which then run the command of the tool it extends.
 */
export function acceptedCommandOf(instance: DeclaredTool): string | undefined {
  if (instance.source !== 'team' || instance.command === undefined) return instance.command;
  let text: string | undefined;

  try {
    text = readRegularFileSync(trustFile(), 'utf8');
  } catch {
    text = undefined;
  }

  const subject = toolCommandOf({ ...instance, command: instance.command });

  return trustOf(text).accepted.some((entry) => accepts(entry, subject) && entry.revision === instance.revision) ? instance.command : undefined;
}

/** Why a team instance's command did not run. */
export interface UnacceptedCommand {
  readonly ok: false;
  readonly code: 'tool_not_accepted';
  readonly message: string;
}

/** `ask`, answering a question it put before with that first answer: a pull that passes several scopes asks once. */
export function askingOnce(ask: (question: string) => Promise<string | undefined>): (question: string) => Promise<string | undefined> {
  const answers = new Map<string, Promise<string | undefined>>();

  return async (question) => {
    const answer = answers.get(question) ?? ask(question);
    answers.set(question, answer);

    return answer;
  };
}

/**
 * Whether `instance`'s command may run here (`acceptTeamCommand`). Only a team instance that sets one needs it.
 */
export async function acceptToolCommand(
  instance: DeclaredTool,
  { ask }: { ask: ((question: string) => Promise<string | undefined>) | undefined },
): Promise<{ ok: true } | UnacceptedCommand> {
  if (instance.source !== 'team' || instance.command === undefined) return { ok: true };
  const accepted = await acceptTeamCommand(toolCommandOf({ ...instance, command: instance.command }), { ask });

  return accepted.ok ? accepted : { ok: false, code: 'tool_not_accepted', message: accepted.message };
}
