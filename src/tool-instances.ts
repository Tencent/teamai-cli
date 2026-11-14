import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { isBareCommandName } from '@teamai/shared/cli-path';
import { INSTANCE_KEYS, type ToolInstance, type ToolInstanceHome } from '@teamai/tool-core/instance';
import { isSafeNamespaceSegment } from './manifest-schema.js';
import { resolveNamespacedItems, type NamespaceCandidate } from './namespace-resolver.js';
import { isSessionPlatform } from './session-flow/adapters/platform-facts.js';
import { instanceHomeDir, isSameDirOn, realHost, toolHome, type Host } from './tool-home.js';
import { INSTANCE_BASES, isInstanceBase, isToolId, TOOL_ORDER, toolOf, useToolInstances } from './tool-registry.js';
import type { ToolId } from './tools.js';
import { DEFAULT_TOOL_PATHS, getTeamaiHomeDir, getTrustDir, recordedToolRootDir, RELOCATABLE_TOOLS, rerootToolPaths, toolInstallRoot, toolPathRoots, ToolPathsSchema, type TeamaiConfig } from './types.js';
import { writeJsonAtomic } from './utils/fs.js';
import { log } from './utils/logger.js';
import { errorOnce, warnOnce } from './utils/warn-once.js';
import { parseYaml } from './utils/yaml.js';

// ─── Tool instances ──────────────────────────────────────
//
//  A team adds a tool as an instance of a shipped one, in tools/<name>.yaml of the team repo (or tools/<namespace>/),
//  and a member in ~/.teamai/tools/<name>.yaml, which teamai reads and never writes. An instance sets another command,
//  home and paths, and no code: it keeps the formats of the tool it extends. A member's own instance replaces the
//  team's of the same name. An instance named like a shipped tool adjusts it.
//

/** Where an instance was read: the team repo, which a teammate pushes to, or the member's own directory. */
export type InstanceSource = 'team' | 'personal';

/** An instance as a file defines it, with where it came from and the hash of that file. */
export interface ResolvedToolInstance extends ToolInstance<ToolId> {
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

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Parses the instance `text` of `file`, which is named after it, or says why teamai does not use it. */
function parseToolInstance({ file, text, source, location }: { file: string; text: string; source: InstanceSource; location: string }): { ok: true; instance: ResolvedToolInstance } | RefusedInstance {
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

  const stem = path.basename(file, '.yaml');

  if (fields.name !== stem) return refused(file, `its name is "${fields.name}", and an instance is named after its file, "${stem}"`);

  if (isToolId(fields.name) && fields.name !== base) {
    return refused(file, `"${fields.name}" is a tool teamai ships, and an instance named like one adjusts it, so it extends ${fields.name}`);
  }

  const homeVariable = RELOCATABLE_TOOLS[base]?.envVar;

  // Windows reads a variable's name in any case, and a team file reaches every member's platform.
  if (fields.name !== base && homeVariable !== undefined && fields.home?.env?.toUpperCase() === homeVariable.toUpperCase()) {
    return refused(file, `home.env: ${fields.home.env} names ${homeVariable}, the variable ${base} reads its home from in any letter case, and teamai sets it to this instance's home when it starts it; leave env out`);
  }

  if (!isToolId(fields.name) && isSessionPlatform(fields.name)) return refused(file, `"${fields.name}" is the name of a session platform teamai ships`);

  return { ok: true, instance: { ...fields, extends: base, source, file, location, revision: sha256(text) } };
}

async function readText(file: string): Promise<string | undefined> {
  try {
    const stat = await fs.lstat(file);

    return stat.isFile() ? await fs.readFile(file, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}

async function yamlFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);

  return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.yaml')).map((entry) => entry.name).sort();
}

async function namespaceDirs(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);

  return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && isSafeNamespaceSegment(entry.name)).map((entry) => entry.name).sort();
}

/** Each instance in `files`, parsed; one that does not parse is logged and left out. */
async function readInstances(files: readonly string[], source: InstanceSource, locationOf: (file: string) => string = (file) => file): Promise<ResolvedToolInstance[]> {
  const read = await Promise.all(files.map(async (file) => {
    const text = await readText(file);

    return text === undefined ? undefined : parseToolInstance({ file, text, source, location: locationOf(file) });
  }));

  return read.flatMap((parsed) => {
    if (parsed === undefined) return [];

    if (!parsed.ok) {
      errorOnce(parsed.problem);

      return [];
    }

    return [parsed.instance];
  });
}

/**
 * The instances of the team repo at `repoPath`: `tools/<name>.yaml`, and `tools/<namespace>/<name>.yaml`, which
 * replaces the root one. Two of one name in two namespaces are a conflict, and neither is used.
 */
export async function teamToolInstances(repoPath: string): Promise<ResolvedToolInstance[]> {
  const root = path.join(repoPath, 'tools');
  const namespaces = await namespaceDirs(root);
  const places: Array<{ namespace: string | null; dir: string }> = [{ namespace: null, dir: root }, ...namespaces.map((namespace) => ({ namespace, dir: path.join(root, namespace) }))];

  const candidates = (await Promise.all(places.map(async ({ namespace, dir }) => {
    const instances = await readInstances((await yamlFiles(dir)).map((name) => path.join(dir, name)), 'team', (file) => path.relative(repoPath, file).split(path.sep).join('/'));

    return instances.map((instance): NamespaceCandidate<ResolvedToolInstance> => ({ name: instance.name, source: path.relative(repoPath, instance.file), namespace, value: instance }));
  }))).flat();

  return resolveWithoutConflicts(candidates, namespaces);
}

/** The items `candidates` resolve to; a name two of them conflict on is logged and left out, and the rest resolve. */
function resolveWithoutConflicts(candidates: readonly NamespaceCandidate<ResolvedToolInstance>[], namespaces: readonly string[]): ResolvedToolInstance[] {
  const resolution = resolveNamespacedItems(candidates, namespaces);

  if (resolution.kind === 'resolved') return resolution.items.map((item) => item.value);
  log.error(`Tool instance "${resolution.name}" is defined twice in the team repo (${resolution.first.source} and ${resolution.second.source}), so teamai uses neither. Keep one, push it, and run teamai pull.`);

  return resolveWithoutConflicts(candidates.filter((candidate) => candidate.name !== resolution.name), namespaces);
}

/** The member's own instance directory, `~/.teamai/tools/`: teamai reads it and never writes it. */
export function personalToolsDir(): string {
  return path.join(getTeamaiHomeDir(), 'tools');
}

/** The member's own instances, from `personalToolsDir()`. */
export async function personalToolInstances(): Promise<ResolvedToolInstance[]> {
  const dir = personalToolsDir();

  return readInstances((await yamlFiles(dir)).map((name) => path.join(dir, name)), 'personal');
}

// ─── The instances this process sees ─────────────────────

/** The instances read from each team repo this process loaded, by repo path. */
const teamByRepo = new Map<string, readonly ResolvedToolInstance[]>();
let personal: readonly ResolvedToolInstance[] = [];
let readsPersonal = true;

/** The roots the member recorded for the shipped tools (`toolRoots`), read with the instances, for `homeSharedWith`. */
let memberToolRoots: Readonly<Record<string, string>> | undefined;

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
  publish();
}

/**
 * The instances the files declare, the member's own over the team's, before any is refused for its home. One name two
 * team repos define apart is left out.
 */
function declaredTable(): Map<string, ResolvedToolInstance> {
  const table = new Map<string, ResolvedToolInstance>();
  const conflicted = new Set<string>();

  for (const instance of [...teamByRepo.values()].flat()) {
    const known = table.get(instance.name);

    if (known === undefined) table.set(instance.name, instance);
    else if (known.revision !== instance.revision) conflicted.add(instance.name);
  }

  for (const name of conflicted) {
    const files = [...teamByRepo.values()].flat().filter((instance) => instance.name === name).map((instance) => instance.file);

    warnOnce(`Tool instance "${name}" is defined apart in two team repos (${files.join(' and ')}), so teamai uses neither. Make them the same, or rename one.`);
    table.delete(name);
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
  name: string; home: ToolInstanceHome; instances: readonly ResolvedToolInstance[]; host: Host; toolRoots?: Readonly<Record<string, string>>;
}): string | undefined {
  const own = instanceHomeDir({ name, home }, host);
  const at = { home: host.home, path: host.path, readTextNow: (file: string) => host.readTextNow(file), existsNow: (file: string) => host.existsNow(file) };
  const same = (dir: string | null): boolean => dir !== null && isSameDirOn(host, own, dir);

  return TOOL_ORDER.find((tool) => same(toolHome(tool, host)) || same(recordedToolRootDir(tool, toolRoots, at)))
    ?? instances.find((other) => other.name !== name && other.name !== other.extends && other.home !== undefined && same(instanceHomeDir({ name: other.name, home: other.home }, host)))?.name;
}

/**
 * `table` without an instance whose home is another tool's: two tools on one home write over each other's skills,
 * hooks and sessions, and credit one's sessions to the other. A `home.dir` that names one is a fault of the file; a
 * home that only resolves to one, through its variable or the member's `toolRoots`, is named with both tools.
 */
function withoutSharedHomes(table: Map<string, ResolvedToolInstance>): Map<string, ResolvedToolInstance> {
  const instances = [...table.values()];
  const host = realHost();
  const unmoved: Host = { ...host, env: {}, toolHomes: { kind: 'missing' } };

  for (const instance of instances) {
    const { name, home } = instance;

    if (home === undefined || name === instance.extends) continue;
    const declared = homeSharedWith({ name, home, instances, host: unmoved });

    if (declared !== undefined) {
      errorOnce(refused(instance.file, `home.dir: ${home.dir} is the home of ${declared} too, and two tools on one home write over each other's skills, hooks and sessions; give it a directory of its own`).problem);
      table.delete(name);
      continue;
    }

    const own = instanceHomeDir({ name, home }, host);

    // home.dir cannot name the home itself; only the instance's variable, or the record init made of it, can.
    if (home.env !== undefined && isSameDirOn(host, own, host.home)) {
      errorOnce(`Tool instance ${name} (${instance.location}) is not used: its home resolves to your home directory itself, ${own}, `
        + `where it would read and write every file in your home as its own. Point ${home.env} at a directory of its own and re-run \`teamai init\`.`);
      table.delete(name);
      continue;
    }

    const resolved = homeSharedWith({ name, home, instances, host, toolRoots: memberToolRoots });

    if (resolved !== undefined) {
      errorOnce(`Tool instance ${name} (${instance.location}) is not used: its home resolves to ${own}, which is also the home of ${resolved}, `
        + 'and two tools on one home write over each other\'s skills, hooks and sessions. Move one of the two homes, then re-run `teamai init`: a pull keeps the home it recorded.');
      table.delete(name);
    }
  }

  return table;
}

function publish(): void {
  const declared = declaredTable();

  useToolInstances(withoutSharedHomes(new Map(declared)), declared);
}

/** The tool paths `instance` gives its tool: its own `paths`, else the paths of the tool it extends, moved to its home. */
function instancePaths(instance: ResolvedToolInstance, toolPaths: TeamaiConfig['toolPaths']): z.infer<typeof ToolPathsSchema> | undefined {
  if (instance.paths) return instance.paths;
  const extended = toolPaths[instance.extends] ?? DEFAULT_TOOL_PATHS[instance.extends];

  return instance.home ? rerootToolPaths(extended, instance.home.dir) : extended;
}

/** The paths `instance` replaces with its own: those of the tool it adjusts, or of the tool it extends, moved to its home. */
export function defaultPathsOf(instance: ResolvedToolInstance): z.infer<typeof ToolPathsSchema> {
  const shipped = DEFAULT_TOOL_PATHS[instance.extends];

  return instance.home && instance.name !== instance.extends ? rerootToolPaths(shipped, instance.home.dir) : shipped;
}

/**
 * Where `instance` reads a file the tool it extends reads at `relative`, under the home or the project (`from`): under
 * its own home when it has one, moved as its tool paths are (`instancePaths`), so what teamai writes there is judged
 * read. A path outside that tool's roots, and a file at the project's root, stay as they are, and so does every path
 * of an instance that sets its own paths, which teamai writes to as they are.
 */
export function instanceReadPath(instance: ResolvedToolInstance, { from, relative }: { from: 'home' | 'project'; relative: string }): string {
  if (!instance.home || instance.paths || instance.name === instance.extends) return relative;

  // A bare file beside the tool's home (Claude Code's .claude.json) is inside a home that moved, as the instance's is.
  if (!relative.includes('/')) return from === 'home' ? `${instance.home.dir}/${relative}` : relative;
  const root = toolInstallRoot(relative);

  return toolPathRoots(DEFAULT_TOOL_PATHS[instance.extends]).has(root) ? instance.home.dir + relative.slice(root.length) : relative;
}

/**
 * `config`, the team config of the repo at `repoPath`, with the instances of that repo and the member's own read,
 * every lookup of a tool name seeing them, and their tool paths in `toolPaths`. A member's instance replaces the team's.
 */
export async function withToolInstances(repoPath: string, config: TeamaiConfig): Promise<TeamaiConfig> {
  const [team, own] = await Promise.all([teamToolInstances(repoPath), readsPersonal ? personalToolInstances() : []]);
  teamByRepo.set(repoPath, team);
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

// ─── Accepting a team instance's command ─────────────────
//
//  A team instance that sets `command` runs a program a teammate named on the member's machine. Before its first run
//  with a given file content, a person accepts that content: an attended run asks, and an unattended one refuses.
//  A member's own instance, and one that sets only home or paths, need no acceptance.
//

const TrustFileSchema = z.object({ accepted: z.array(z.object({ name: z.string(), revision: z.string(), acceptedAt: z.string() })) });

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

async function readTrust(): Promise<TrustFile> {
  return trustOf(await fs.readFile(trustFile(), 'utf8').catch(() => undefined));
}

function isAccepted(trust: TrustFile, instance: ResolvedToolInstance): boolean {
  return trust.accepted.some((entry) => entry.name === instance.name && entry.revision === instance.revision);
}

/**
 * The command `instance` sets when it may run here with no one to ask: a member's own instance's, or a team instance's
 * whose file content a person accepted (`acceptToolCommand`). Undefined for any other, and for one that sets none. Read
 * where nothing can ask, such as the session adapters, which then run the command of the tool it extends.
 */
export function acceptedCommandOf(instance: ResolvedToolInstance): string | undefined {
  if (instance.source !== 'team' || instance.command === undefined) return instance.command;
  let text: string | undefined;

  try {
    text = readFileSync(trustFile(), 'utf8');
  } catch {
    text = undefined;
  }

  return isAccepted(trustOf(text), instance) ? instance.command : undefined;
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
 * Whether `instance`'s command may run here. Only a team instance that sets one needs it: a person must have accepted
 * its file's content on this machine. `ask`, given when a person at a terminal answers, puts the question to them and
 * returns the line they typed, or nothing once the run stopped asking; a yes is recorded, and anything else declines.
 * With no one to ask, an unaccepted content is refused, naming what to run.
 */
export async function acceptToolCommand(
  instance: ResolvedToolInstance,
  { ask }: { ask: ((question: string) => Promise<string | undefined>) | undefined },
): Promise<{ ok: true } | UnacceptedCommand> {
  if (instance.source !== 'team' || instance.command === undefined) return { ok: true };
  const trust = await readTrust();

  if (isAccepted(trust, instance)) return { ok: true };
  const short = instance.revision.slice(0, 12);

  if (ask) {
    const question = `Tool "${instance.name}" comes from the team repo (${instance.file}, content ${short}), which you have not accepted on this machine. `
      + `It runs ${instance.command} as you, with your files, in place of ${instance.extends}. Review the file before you accept it.\nRun it? [y/N] `;

    if (/^y(es)?$/i.test((await ask(question))?.trim() ?? '')) {
      // Read again under the lock: another step may have accepted another instance while this one asked. Loaded here,
      // since update.js reaches config.js, which loads this module on every hook.
      const { withFileLock } = await import('./update.js');

      const recorded = await withFileLock(`${trustFile()}.lock`, TRUST_LOCK_WAIT, async () => {
        const current = await readTrust();

        await writeJsonAtomic(trustFile(), { accepted: [...current.accepted.filter((entry) => entry.name !== instance.name), { name: instance.name, revision: instance.revision, acceptedAt: new Date().toISOString() }] });
      });

      if (!recorded.held) log.warn(`Tool "${instance.name}" runs as you accepted it, but ${trustFile()} stayed locked by another teamai process, so the next run asks again.`);

      return { ok: true };
    }

    return { ok: false, code: 'tool_not_accepted', message: `Tool "${instance.name}" (content ${short}) was not accepted, so ${instance.command} did not run.` };
  }

  return {
    ok: false,
    code: 'tool_not_accepted',
    message: `Tool "${instance.name}" comes from the team repo (${instance.file}, content ${short}) and runs ${instance.command}, which no one has accepted on this machine, and an unattended run does not ask. `
      + 'Run the same command once in a terminal, attended, to review and accept it, then run it unattended again.',
  };
}
