import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { TOOLS, type HomeMove } from './tools.js';
import type { ToolId } from './types.js';
import { pathExists, readFileSafe, readJsonObject, writeJsonAtomic, type JsonObjectRead } from './utils/fs.js';
import { getUserHome, normalizeHomePath } from './utils/home.js';

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
  /** A JSON object file, as `readJsonObject` reads it: OpenClaw's openclaw.json. */
  readJson(file: string): Promise<JsonObjectRead>;
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

/** The machine teamai runs on, the default host of every function that takes one. */
export function realHost(overrides: Partial<Pick<Host, 'env' | 'home'>> = {}): Host {
  return {
    platform: process.platform,
    path,
    home: overrides.home ?? getUserHome(),
    profileHome: normalizeHomePath(os.homedir()),
    env: overrides.env ?? process.env,
    toolHomes: cachedToolHomesRead(),
    cwd: () => process.cwd(),
    exists: pathExists,
    readJson: readJsonObject,
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
 * `variable` names the setting, or the file (Hermes's `active_profile`).
 */
export type EnvToolHome = { readonly dir: string; readonly variable: string; readonly kind: 'own' | 'xdg' | 'platform-default' };

/**
 * Where the host env moves `tool`'s home (the first of
 * `TOOLS[tool].home.moves` that applies), or null when none does. Blank
 * values count as unset. A tool's own variable resolves as the tool resolves
 * it: `~` expanded, a relative value against the session's directory.
 * `XDG_CONFIG_HOME` and `LOCALAPPDATA` count only when absolute, as the XDG
 * spec has it. An explicit default profile moves the home to the default one.
 */
export function envToolHome(tool: ToolId, host: Host = realHost()): EnvToolHome | null {
  const { home } = TOOLS[tool];
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

function openclawState(host: Host): EnvToolHome | null {
  const raw = host.env.OPENCLAW_HOME?.trim();
  const openclawHome = raw && raw !== 'undefined' && raw !== 'null' ? absoluteOn(raw, host) : null;
  const effective: Host = openclawHome === null ? host : { ...host, home: openclawHome };
  const state = host.env.OPENCLAW_STATE_DIR?.trim();
  if (state) return { dir: absoluteOn(state, effective), variable: 'OPENCLAW_STATE_DIR', kind: 'own' };
  const profile = host.env.OPENCLAW_PROFILE?.trim();
  const dir = !profile || profile.toLowerCase() === 'default' ? '.openclaw' : `.openclaw-${profile}`;
  if (openclawHome !== null) return { dir: host.path.join(openclawHome, dir), variable: profile ? 'OPENCLAW_HOME and OPENCLAW_PROFILE' : 'OPENCLAW_HOME', kind: 'own' };
  return profile ? { dir: host.path.join(host.home, dir), variable: 'OPENCLAW_PROFILE', kind: 'own' } : null;
}

function ompAgentDir(host: Host): EnvToolHome | null {
  const p = host.path;
  const { env } = host;
  const base = p.join(host.home, env.PI_CONFIG_DIR || '.omp');
  const selector = env.OMP_PROFILE !== undefined ? 'OMP_PROFILE' : env.PI_PROFILE !== undefined ? 'PI_PROFILE' : null;
  const profileDir = (name: string | undefined): string | null => {
    const profile = name?.trim();
    return !profile || profile === 'default' ? null : p.join(base, 'profiles', profile, 'agent');
  };
  const named = selector === null ? null : profileDir(env[selector]);
  if (selector !== null && named !== null) return { dir: named, variable: selector, kind: 'own' };
  const override = env.PI_CODING_AGENT_DIR?.trim();
  // A PI_CODING_AGENT_DIR that is the bypassed PI_PROFILE's agent dir came from that profile, not from the member.
  const inherited = override && selector === 'OMP_PROFILE' && profileDir(env.PI_PROFILE) === p.resolve(override);
  if (override && !inherited) return { dir: absoluteOn(override, host), variable: 'PI_CODING_AGENT_DIR', kind: 'own' };
  if (env.PI_CONFIG_DIR) return { dir: p.join(base, 'agent'), variable: 'PI_CONFIG_DIR', kind: 'own' };
  return selector !== null && env[selector]?.trim() ? { dir: p.join(base, 'agent'), variable: selector, kind: 'own' } : null;
}

/**
 * OMP's agent dir as its task-agent loader reads it, which no
 * `PI_CODING_AGENT_DIR` moves: a recorded home counts when it has the shape a
 * profile or `PI_CONFIG_DIR` gives (`~/<dir>/agent`, `~/<dir>/profiles/<name>/agent`).
 */
export function ompTaskAgentHost(host: Host): Host {
  const p = host.path;
  const { omp: recorded, ...others } = recordedHomes(host);
  const parts = recorded === undefined ? [] : p.relative(host.home, recorded).split(p.sep);
  const profileShaped = parts.at(-1) === 'agent' && !parts[0]?.startsWith('..') && (parts.length === 2 || (parts.length === 4 && parts[1] === 'profiles'));
  return {
    ...host,
    env: { ...host.env, PI_CODING_AGENT_DIR: undefined },
    toolHomes: { kind: 'ok', homes: profileShaped && recorded !== undefined ? { ...others, omp: recorded } : others },
  };
}

function hermesHome(host: Host): EnvToolHome | null {
  const p = host.path;
  const suffix = host.env.HERMES_DATA_DIR_SUFFIX ?? '';
  const appData = host.platform === 'win32' ? absoluteEnv(host, 'LOCALAPPDATA') ?? p.join(host.home, 'AppData', 'Local') : null;
  const native = appData === null ? p.join(host.home, `.hermes${suffix}`) : p.join(appData, `hermes${suffix}`);
  const raw = host.env.HERMES_HOME?.trim();
  const explicit = raw ? absoluteOn(raw, host) : null;
  const processHome: EnvToolHome | null = explicit !== null ? { dir: explicit, variable: 'HERMES_HOME', kind: 'own' }
    : suffix ? { dir: native, variable: 'HERMES_DATA_DIR_SUFFIX', kind: 'own' }
      : appData !== null ? { dir: native, variable: 'LOCALAPPDATA', kind: 'platform-default' } : null;
  if (explicit !== null && p.basename(p.dirname(explicit)) === 'profiles') return processHome;
  const inNative = explicit === null || !p.relative(native, explicit).startsWith('..') && !p.isAbsolute(p.relative(native, explicit));
  const activeProfile = p.join(inNative ? native : explicit, 'active_profile');
  const name = host.readTextNow(activeProfile)?.trim();
  if (!name || name === 'default') return processHome;
  const dir = p.join(explicit ?? native, 'profiles', name);
  return host.existsNow(dir) ? { dir, variable: activeProfile, kind: 'own' } : processHome;
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

/** The recorded home, else the env's, or null when nothing moves `tool`'s home. */
export function movedToolHome(tool: ToolId, host: Host = realHost()): string | null {
  return recordedHomes(host)[tool] ?? envToolHome(tool, host)?.dir ?? null;
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
  const { home } = TOOLS[tool];
  return 'moves' in home && 'root' in home.moves ? home.moves.root : home.dir;
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
