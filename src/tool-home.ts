import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { type ToolId, type ShippedDescriptor } from './tools.js';
import { type HomeMove } from '@teamai/tool-core/definition';
import type { ToolInstanceHome } from '@teamai/tool-core/instance';
import { homeVariables, descriptorOf, TOOL_ORDER, toolInstancesFor, toolOf } from './tool-registry.js';
import { RELOCATABLE_TOOLS } from './types.js';
import { pathExists, readFileSafe, readJsonObject, writeJsonAtomic, type JsonObjectRead } from './utils/fs.js';
import { getUserHome, normalizeHomePath, usesInstallHome } from './utils/home.js';

export type Host = {
  readonly platform: NodeJS.Platform;
  /** The path flavor the machine's paths take: the process's own module on the real host. */
  readonly path: path.PlatformPath;
  /** The member's home, normalized (`getUserHome()` on the real host). */
  readonly home: string;
  /** The home the OS reports, which the tools write their session stores under (`os.homedir()`): on Windows %USERPROFILE%, whatever HOME says. */
  readonly profileHome: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The tool-homes record on this machine (`~/.teamai/tool-homes.json`) as read: its homes win over `env`. */
  readonly toolHomes: ToolHomesRead;
  /** The session's directory, read only when a relative path needs it: a removed one throws (#810). */
  cwd(): string;
  exists(file: string): Promise<boolean>;
  /** OpenClaw's openclaw.json, read as OpenClaw reads it (`json5`). */
  readOpenclawConfig(file: string): Promise<JsonObjectRead>;
  /** `file` through its links; `file` itself when it cannot be resolved (missing, a loop, unreadable). */
  realpath(file: string): Promise<string>;
  /** A small text file, or null when it is missing or unreadable: a linked worktree's `.git` and its `commondir`. */
  readText(file: string): Promise<string | null>;
  /** `exists` and `readText` for a home move, which resolves synchronously: Hermes's `active_profile` and its profile dir. */
  existsNow(file: string): boolean;
  readTextNow(file: string): string | null;
  /** The `toolRoots` the member's user config records: a project config that records none follows them (`resolveMemberToolRoots`). */
  userToolRoots(): Promise<Readonly<Record<string, string>> | undefined>;
};

/**
 * Every variable that moves a tool's home: a shipped tool's (`homeVariables`, its `Home.rootVariable` and the roots
 * `RELOCATABLE_TOOLS` records) and each declared instance's own (`home.env`), a refused one's too: a child with another `HOME` cannot judge the refusal again, so the variable must not reach it. `teamai/tool-home-env` keeps a copy of
 * the shipped ones, pinned to this.
 */
export function toolHomeVariableNames(): ReadonlySet<string> {
  return new Set([
    ...TOOL_ORDER.flatMap((tool) => {
      const { home }: ShippedDescriptor = descriptorOf(tool);

      return home.rootVariable === undefined ? homeVariables(tool) : [...homeVariables(tool), home.rootVariable];
    }),
    ...Object.values(RELOCATABLE_TOOLS).map(({ envVar }) => envVar),
    ...toolInstancesFor('guard').flatMap(({ home }) => home?.env ?? []),
  ]);
}

/** `env` without any variable that moves a tool's home: under an install's home, each tool's home is the install's. */
function withoutToolHomeVariables(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const names = toolHomeVariableNames();

  return Object.fromEntries(Object.entries(env).filter(([name]) => !names.has(name)));
}

/** The machine teamai runs on, the default host of every function that takes one. */
export function realHost(overrides: Partial<Pick<Host, 'env' | 'home'>> = {}): Host {
  return {
    platform: process.platform,
    path,
    home: overrides.home ?? getUserHome(),
    profileHome: normalizeHomePath(os.homedir()),
    env: overrides.env ?? (usesInstallHome() ? withoutToolHomeVariables(process.env) : process.env),
    toolHomes: cachedToolHomesRead(),
    cwd: () => process.cwd(),
    exists: pathExists,
    readOpenclawConfig: async (file) => readJsonObject(file, 'json5'),
    realpath: (file) => fs.promises.realpath(file).catch(() => file),
    readText: readFileSafe,
    existsNow: (file) => fs.existsSync(file),
    readTextNow: (file) => {
      try {
        return fs.readFileSync(file, 'utf8');
      } catch {
        return null;
      }
    },
    userToolRoots: async () => (await (await import('./config.js')).loadLocalConfig())?.toolRoots,
  };
}

/**
 * A home the host env moves, and how init records it (`INIT_RECORDS`): `own`,
 * the tool's own setting; `xdg`, `XDG_CONFIG_HOME`, which moves every XDG
 * tool at once; `platform-default`, the Windows home, which is not a move.
 * `variable` names the setting.
 */
export type EnvToolHome = { readonly dir: string; readonly variable: string; readonly kind: 'own' | 'xdg' | 'platform-default' };

/**
 * Where the host env moves `tool`'s home (the first of
 * `descriptorOf(tool).home.moves` that applies), or null when none does. Blank
 * values count as unset. A tool's own variable resolves as the tool resolves
 * it: `~` expanded, a relative value against the session's directory.
 * `XDG_CONFIG_HOME` and `LOCALAPPDATA` count only when absolute, as the XDG
 * spec has it. An explicit default profile moves the home to the default one.
 */
export function envToolHome(tool: ToolId, host: Host = realHost()): EnvToolHome | null {
  const { home } = descriptorOf(tool);

  if (!('moves' in home)) return null;

  for (const move of home.moves.by) {
    const moved = moveOf(move, host);

    if (moved !== null) return moved;
  }

  return null;
}

function moveOf(move: HomeMove, host: Host): EnvToolHome | null {
  switch (move.kind) {
    case 'env': {
      const value = host.env[move.name]?.trim();

      return value ? { dir: absoluteOn(value, host), variable: move.name, kind: 'own' } : null;
    }

    case 'qoder-home':
      return qoderHome(host);
    case 'qoder-cn-home':
      return qoderCnHome(host);
    case 'xdg': {
      const dir = absoluteEnv(host, 'XDG_CONFIG_HOME');

      return dir === null ? null : { dir: host.path.join(dir, move.child), variable: 'XDG_CONFIG_HOME', kind: 'xdg' };
    }

    case 'openclaw-state':
      return openclawState(host);
    case 'omp-agent':
      return ompAgentDir(host);
    case 'hermes-home':
      return hermesHome(host);
    default: {
      const unhandled: never = move;

      return unhandled;
    }
  }
}

/** Qoder gives QODER_CONFIG_DIR precedence; QODER_CLI_HOME holds its `.qoder` store otherwise. */
function qoderHome(host: Host): EnvToolHome | null {
  const config = host.env.QODER_CONFIG_DIR?.trim();

  if (config) return { dir: absoluteOn(config, host), variable: 'QODER_CONFIG_DIR', kind: 'own' };
  const cliHome = host.env.QODER_CLI_HOME?.trim();

  return cliHome ? { dir: host.path.join(absoluteOn(cliHome, host), '.qoder'), variable: 'QODER_CLI_HOME', kind: 'own' } : null;
}

/** Qoder CN gives QODERCN_CONFIG_DIR precedence; QODERCN_CLI_HOME holds its `.qoder-cn` store otherwise. */
function qoderCnHome(host: Host): EnvToolHome | null {
  const config = host.env.QODERCN_CONFIG_DIR?.trim();

  if (config) return { dir: absoluteOn(config, host), variable: 'QODERCN_CONFIG_DIR', kind: 'own' };
  const cliHome = host.env.QODERCN_CLI_HOME?.trim();

  return cliHome ? { dir: host.path.join(absoluteOn(cliHome, host), '.qoder-cn'), variable: 'QODERCN_CLI_HOME', kind: 'own' } : null;
}

function openclawState(host: Host): EnvToolHome | null {
  const raw = host.env.OPENCLAW_HOME?.trim();
  // OpenClaw counts a blank value and the literals `undefined` and `null` as unset.
  const openclawHome = raw && raw !== 'undefined' && raw !== 'null' ? absoluteOn(raw, host) : null;
  const effective: Host = openclawHome === null ? host : { ...host, home: openclawHome };
  const state = host.env.OPENCLAW_STATE_DIR?.trim();

  if (state) return { dir: absoluteOn(state, effective), variable: 'OPENCLAW_STATE_DIR', kind: 'own' };
  const profile = host.env.OPENCLAW_PROFILE?.trim();
  const dir = !profile || profile.toLowerCase() === 'default' ? '.openclaw' : `.openclaw-${profile}`;

  if (openclawHome !== null) return { dir: host.path.join(openclawHome, dir), variable: profile ? 'OPENCLAW_HOME and OPENCLAW_PROFILE' : 'OPENCLAW_HOME', kind: 'own' };

  return profile ? { dir: host.path.join(host.home, dir), variable: 'OPENCLAW_PROFILE', kind: 'own' } : null;
}

/** The variable that selects an OMP profile, and the profile it names; both null when neither is set. */
export interface OmpProfile {
  readonly variable: 'OMP_PROFILE' | 'PI_PROFILE' | null;
  readonly name: string | null;
}

/** OMP_PROFILE wins whenever it is defined, even blank; a named profile does not use Pi's default agent directory. */
export function ompProfile(env: Readonly<Record<string, string | undefined>>): OmpProfile {
  const variable = env.OMP_PROFILE !== undefined ? 'OMP_PROFILE' : env.PI_PROFILE !== undefined ? 'PI_PROFILE' : null;

  return { variable, name: variable === null ? null : env[variable]?.trim() || null };
}

function ompAgentDir(host: Host): EnvToolHome | null {
  const p = host.path;
  const { env } = host;
  const base = p.join(host.home, env.PI_CONFIG_DIR || '.omp');
  const { variable: selector, name: profile } = ompProfile(env);

  if (selector !== null && profile && profile !== 'default') return { dir: p.join(base, 'profiles', profile, 'agent'), variable: selector, kind: 'own' };

  if (env.PI_CONFIG_DIR) return { dir: p.join(base, 'agent'), variable: 'PI_CONFIG_DIR', kind: 'own' };

  return selector !== null && profile ? { dir: p.join(base, 'agent'), variable: selector, kind: 'own' } : null;
}

function hermesHome(host: Host): EnvToolHome | null {
  const raw = host.env.HERMES_HOME?.trim();

  if (raw) return { dir: absoluteOn(raw, host), variable: 'HERMES_HOME', kind: 'own' };
  const { native, appData } = hermesNative(host);

  if (host.env.HERMES_DATA_DIR_SUFFIX) return { dir: native, variable: 'HERMES_DATA_DIR_SUFFIX', kind: 'own' };

  return appData ? { dir: native, variable: 'LOCALAPPDATA', kind: 'platform-default' } : null;
}

function hermesNative(host: Host) {
  const p = host.path;
  const suffix = host.env.HERMES_DATA_DIR_SUFFIX ?? '';

  if (host.platform !== 'win32') return { native: p.join(host.home, `.hermes${suffix}`), appData: false };

  return { native: p.join(absoluteEnv(host, 'LOCALAPPDATA') ?? p.join(host.home, 'AppData', 'Local'), `hermes${suffix}`), appData: true };
}

/**
 * The profile Hermes's `active_profile` makes active in `home`, read on every
 * run because Hermes rewrites it, so no record pins it: `home` itself when it
 * is a `profiles/<name>` dir, when the profile is `default`, or when its
 * directory is missing. The file sits in the native home unless `home` lies
 * outside it.
 */
function hermesProfile(home: string, host: Host): string {
  const p = host.path;

  if (p.basename(p.dirname(home)) === 'profiles') return home;
  const { native } = hermesNative(host);
  const fromNative = p.relative(native, home);
  const outsideNative = fromNative.startsWith('..') || p.isAbsolute(fromNative);
  const name = host.readTextNow(p.join(outsideNative ? home : native, 'active_profile'))?.trim();

  if (!name || name === 'default') return home;
  const dir = p.join(home, 'profiles', name);

  return host.existsNow(dir) ? dir : home;
}

function absoluteEnv(host: Host, name: string): string | null {
  const value = host.env[name]?.trim();

  if (!value) return null;
  const expanded = expandHomeOn(value, host);

  return host.path.isAbsolute(expanded) ? host.path.resolve(expanded) : null;
}

/** Where `tool`'s home sits on `host`: the recorded home, else the env's, else under `$HOME`. */
export function toolHome(tool: ToolId, host: Host = realHost()): string {
  return movedToolHome(tool, host) ?? defaultToolHome(tool, host);
}

/** Where an instance's own variable moves its home on `host`, read as a shipped tool's own variable is (`envToolHome`); null when it names none, or it is unset or blank. */
export function envInstanceHome(home: ToolInstanceHome, host: Host = realHost()): EnvToolHome | null {
  const value = home.env === undefined ? undefined : host.env[home.env]?.trim();

  return home.env !== undefined && value ? { dir: absoluteOn(value, host), variable: home.env, kind: 'own' } : null;
}

/**
 * Where the instance `name`'s own home sits on `host`: for one its variable moves, the recorded home, else the
 * variable's (`envInstanceHome`), as `movedToolHome` reads a shipped tool's; else its directory under `$HOME`. Delivery
 * and its sessions both read it, so the two never part.
 */
export function instanceHomeDir({ name, home }: { readonly name: string; readonly home: ToolInstanceHome }, host: Host = realHost()): string {
  const moved = home.env === undefined ? undefined : recordedHomes(host)[name] ?? envInstanceHome(home, host)?.dir;

  return moved ?? host.path.join(host.home, ...home.dir.split('/'));
}

/**
 * Where the instance `name`'s home sits once `teamai init` has read `host`'s env: init records the instance's own
 * variable over any record, and a blank one clears it (`INIT_RECORDS.own` in tool-home-record.ts); it never records
 * your home directory itself. Else `instanceHomeDir`.
 */
export function instanceHomeAfterInit({ name, home }: { readonly name: string; readonly home: ToolInstanceHome }, host: Host = realHost()): string {
  const unmoved = host.path.join(host.home, ...home.dir.split('/'));

  if (home.env !== undefined && host.env[home.env]?.trim() === '') return unmoved;
  const moved = envInstanceHome(home, host)?.dir;

  return moved !== undefined && !isSameDirOn(host, moved, host.home) ? moved : instanceHomeDir({ name, home }, host);
}

/**
 * The home of the tool `name` runs as on `host`, and the `$HOME`-relative directory it replaces: a shipped tool's
 * (`toolHome`), an instance's own (`instanceHomeDir`), or for an instance that sets no home the home of the tool it
 * extends. Undefined for a custom tool id.
 */
export function toolHomeOf(name: string, host: Host = realHost()): { readonly root: string; readonly dir: string } | undefined {
  const resolved = toolOf(name);

  if (resolved === undefined) return undefined;
  const home = resolved.instance?.home;

  if (home !== undefined) return { root: home.dir, dir: instanceHomeDir({ name, home }, host) };

  return { root: homeRoot(resolved.base), dir: toolHome(resolved.base, host) };
}

/** The recorded home, else the env's, or null when nothing moves `tool`'s home. */
export function movedToolHome(tool: ToolId, host: Host = realHost()): string | null {
  const moved = recordedHomes(host)[tool] ?? envToolHome(tool, host)?.dir ?? null;

  if (!followsActiveProfile(tool)) return moved;
  const unmoved = defaultToolHome(tool, host);
  const home = hermesProfile(moved ?? unmoved, host);

  return moved === null && home === unmoved ? null : home;
}

function followsActiveProfile(tool: ToolId): boolean {
  const { home }: ShippedDescriptor = descriptorOf(tool);

  return home.moves?.by.some((move) => move.kind === 'hermes-home') ?? false;
}

/**
 * Every home of `tool` teamai may have written on this machine: the default, recorded and env homes,
 * the one it uses now, and each profile under them, as Hermes and Oh My Pi run profiles side by side
 * and a pull before a move or a profile switch wrote another. OpenCode has no profiles, but its
 * recorded history still names old XDG/config homes. Only the ones on disk; uninstall cleans them all.
 */
export async function toolHomesAcrossProfiles(tool: 'hermes' | 'omp' | 'opencode', host: Host = realHost()): Promise<string[]> {
  const p = host.path;
  const history = reloadToolHomesHistory()[tool] ?? [];
  const moves = [recordedHomes(host)[tool], envToolHome(tool, host)?.dir, ...history].filter((home): home is string => home !== undefined);
  const homes = [toolHome(tool, host), ...history];

  switch (tool) {
    case 'hermes':
      // A `profiles/<name>` home sits in a root that holds the default and the other profiles.
      for (const base of new Set([defaultToolHome(tool, host), ...moves.flatMap((home) =>
        p.basename(p.dirname(home)) === 'profiles' ? [home, p.dirname(p.dirname(home))] : [home])])) {
        homes.push(base, ...(await subdirs(p.join(base, 'profiles'))).map((name) => p.join(base, 'profiles', name)));
      }

      break;
    case 'omp':
      homes.push(...moves);

      // A moved home is `<root>/agent` or `<root>/profiles/<name>/agent`; its root holds the other profiles.
      const roots = moves.map((home) => {
        const profiles = p.dirname(p.dirname(home));

        return p.basename(profiles) === 'profiles' ? p.dirname(profiles) : p.dirname(home);
      });

      for (const base of new Set([p.dirname(defaultToolHome(tool, host)), p.join(host.home, host.env.PI_CONFIG_DIR || '.omp'), ...roots])) {
        homes.push(p.join(base, 'agent'), ...(await subdirs(p.join(base, 'profiles'))).map((name) => p.join(base, 'profiles', name, 'agent')));
      }

      break;
    case 'opencode':
      homes.push(defaultToolHome(tool, host), ...moves);
      break;
    default: {
      const unhandled: never = tool;

      return unhandled;
    }
  }

  const seen = new Set<string>();
  const found: string[] = [];

  for (const home of homes) {
    const real = await host.realpath(home);

    if (seen.has(real) || !await host.exists(home)) continue;
    seen.add(real);
    found.push(home);
  }

  return found;
}

async function subdirs(dir: string): Promise<string[]> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);

  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

/** The homes `host` records: none while the record is missing or invalid. */
export function recordedHomes(host: Pick<Host, 'toolHomes'>): Readonly<Record<string, string>> {
  return host.toolHomes.kind === 'ok' ? host.toolHomes.homes : {};
}

/** `tool`'s home when nothing moves it. */
export function defaultToolHome(tool: ToolId, host: Pick<Host, 'home' | 'path'>): string {
  return host.path.join(host.home, ...homeRoot(tool).split('/'));
}

/** The `$HOME`-relative directory a home move replaces: `moves.root`, else `home.dir`. */
export function homeRoot(tool: ToolId): string {
  const { home } = descriptorOf(tool);

  return 'moves' in home && 'root' in home.moves ? home.moves.root : home.dir;
}

/** Whether `one` and `other` name one directory on `host`. */
export function isSameDirOn(host: Pick<Host, 'platform' | 'path'>, one: string, other: string): boolean {
  // macOS's default volume ignores letter case, and so does Windows: `.Claude` is Claude Code's `.claude` there.
  const folded = (dir: string): string => host.platform === 'darwin' || host.platform === 'win32' ? dir.toLowerCase() : dir;

  return host.path.relative(folded(one), folded(other)) === '';
}

/** `value`, `~` expanded, as an absolute path: a relative one resolves against the session's directory. */
export function absoluteOn(value: string, host: Host): string {
  const expanded = expandHomeOn(value, host);

  return host.path.isAbsolute(expanded) ? host.path.resolve(expanded) : host.path.resolve(host.cwd(), expanded);
}

/** `~` and `~/x` against the host's home. */
export function expandHomeOn(value: string, host: Pick<Host, 'home' | 'platform' | 'path'>): string {
  const p = host.path;

  if (value === '~' || value.startsWith('~/') || (host.platform === 'win32' && value.startsWith('~\\'))) {
    return p.join(host.home, value.slice(1));
  }

  return value;
}

/** The tool homes init and pull recorded on this machine: one file for every scope, as the homes are the machine's. */
export function toolHomesPath(): string {
  return path.join(getUserHome(), '.teamai', 'tool-homes.json');
}

/** Homes replaced by a later `init`, retained so uninstall can clean every location teamai wrote. */
export function toolHomesHistoryPath(): string {
  return path.join(getUserHome(), '.teamai', 'tool-homes-history.json');
}

export type ToolHomesHistory = Readonly<Record<string, readonly string[]>>;

const ToolHomesHistorySchema = z.record(
  z.string(),
  z.array(z.string().refine((dir) => path.isAbsolute(dir), 'must be an absolute directory')),
);

/** Read the old homes retained across re-init, treating a missing file as an empty history. */
export function reloadToolHomesHistory(): ToolHomesHistory {
  let raw: string;

  try {
    raw = fs.readFileSync(toolHomesHistoryPath(), 'utf8');
  } catch (e) {
    if (e instanceof Error && 'code' in e && e.code === 'ENOENT') return {};

    return {};
  }

  try {
    const parsed = ToolHomesHistorySchema.safeParse(JSON.parse(raw));

    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/** Retain a replaced home once; the caller holds the tool-homes lock. */
export async function rememberToolHome(tool: string, home: string): Promise<void> {
  const history: Record<string, string[]> = Object.fromEntries(
    Object.entries(reloadToolHomesHistory()).map(([key, homes]) => [key, [...homes]]),
  );

  const homes = history[tool] ?? [];

  if (homes.includes(home)) return;
  history[tool] = [...homes, home];
  await writeJsonAtomic(toolHomesHistoryPath(), history);
}

export function describeInvalidToolHomes(error: string): string {
  return `${toolHomesPath()} is not a tool-homes record (${error}): pull syncs nothing until it is, and other commands ignore every home in it. Fix it, or delete it and re-run \`teamai init\`.`;
}

const ToolHomesSchema = z.record(z.string(), z.string().refine((dir) => path.isAbsolute(dir), 'must be an absolute directory'));

export type ToolHomesRead =
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid'; readonly error: string }
  | { readonly kind: 'ok'; readonly homes: Readonly<Record<string, string>> };

let toolHomesReadCache: { readonly file: string; readonly stamp: string | null; readonly read: ToolHomesRead } | undefined;

function stampOf(file: string): string | null {
  try {
    const stat = fs.statSync(file, { throwIfNoEntry: false });

    return stat === undefined ? null : `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

/** The record as it is on disk now; the real host resolves homes with it until the file changes. */
export function reloadToolHomes(): ToolHomesRead {
  const file = toolHomesPath();
  const stamp = stampOf(file);
  const read = parseToolHomes(file);
  toolHomesReadCache = { file, stamp, read };

  return read;
}

function parseToolHomes(file: string): ToolHomesRead {
  let raw: string;

  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e instanceof Error && 'code' in e && e.code === 'ENOENT') return { kind: 'missing' };

    return { kind: 'invalid', error: e instanceof Error ? e.message : String(e) };
  }

  let value: unknown;

  try {
    value = JSON.parse(raw);
  } catch (e) {
    return { kind: 'invalid', error: e instanceof Error ? e.message : String(e) };
  }

  const parsed = ToolHomesSchema.safeParse(value);

  return parsed.success ? { kind: 'ok', homes: parsed.data } : { kind: 'invalid', error: describeIssues(parsed.error) };
}

function describeIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

function cachedToolHomesRead(): ToolHomesRead {
  const cached = toolHomesReadCache;

  return cached !== undefined && cached.file === toolHomesPath() && cached.stamp === stampOf(cached.file) ? cached.read : reloadToolHomes();
}

/** Replace the record; the caller holds its lock (`recordToolHomes`). */
export async function saveToolHomes(homes: Readonly<Record<string, string>>): Promise<void> {
  const file = toolHomesPath();
  await writeJsonAtomic(file, homes);
  toolHomesReadCache = { file, stamp: stampOf(file), read: { kind: 'ok', homes } };
}
