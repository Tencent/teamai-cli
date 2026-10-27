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
    userToolRoots: async () => (await (await import('./config.js')).loadLocalConfig())?.toolRoots,
  };
}

export type EnvToolHome = { readonly dir: string; readonly variable: string; readonly kind: HomeMove['kind'] };

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
  const p = host.path;
  for (const move of home.moves.by) {
    switch (move.kind) {
      case 'env': {
        const value = host.env[move.name]?.trim();
        if (value) return { dir: absoluteOn(value, host), variable: move.name, kind: move.kind };
        break;
      }
      case 'xdg': {
        const dir = absoluteEnv(host, 'XDG_CONFIG_HOME');
        if (dir !== null) return { dir: p.join(dir, move.child), variable: 'XDG_CONFIG_HOME', kind: move.kind };
        break;
      }
      case 'win32-appdata':
        if (host.platform === 'win32') {
          return { dir: p.join(absoluteEnv(host, 'LOCALAPPDATA') ?? p.join(host.home, 'AppData', 'Local'), move.child), variable: 'LOCALAPPDATA', kind: move.kind };
        }
        break;
      case 'profile-suffix': {
        const value = host.env[move.name]?.trim();
        if (value) return { dir: p.join(host.home, value.toLowerCase() === 'default' ? home.dir : `${home.dir}-${value}`), variable: move.name, kind: move.kind };
        break;
      }
      default: {
        const unhandled: never = move;
        return unhandled;
      }
    }
  }
  return null;
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
