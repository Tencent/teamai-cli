/**
 * The runner of every `locate` matrix: one cell per row × platform × session
 * cwd. The expected writes and reads are a hand-written table taken from each
 * tool's source, docs or a recorded run, never from a run of `locate`. Each
 * row is written once in platform-neutral spots and expanded per platform by
 * `at()`, a fixed string join with that platform's `path`, so a wrong table
 * and a wrong `locate` both fail, and a write the tool does not read cannot
 * pass without its issue.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { locate, unreadWrites, writesOf, type Install, type Location, type Place, type Resource, type Retired } from '../../locate.js';
import { isToolId, TOOLS, type BlocksHeader, type ChannelProbe, type HomeMove, type ReadGateKind, type RunTimeVia, type ToolDescriptor } from '../../tools.js';
import type { Host } from '../../tool-home.js';
import { DEFAULT_TOOL_PATHS, type TeamaiConfig, type ToolId } from '../../types.js';

type Platform = 'darwin' | 'linux' | 'win32';
/** The session's directory: a project root in $HOME, a subdirectory of it, or a root outside $HOME (#1197). */
type Cwd = 'project-root' | 'project-subdir' | 'root-outside-home';

type UnderHome = `~/${string}`;
type UnderProjectRoot = `<root>/${string}`;
type UnderSessionDir = `<cwd>/${string}`;
type UnderEnvValue = `$${string}`;
type OutsideHome = `/${string}`;
export type Spot = UnderHome | UnderProjectRoot | UnderSessionDir | UnderEnvValue | OutsideHome | '~' | '<root>';
type When = 'always' | 'workspaceUnder' | 'cwdOnly';

/** A place a row expects: a bare spot checks the path alone; the other fields, when given, check the place's. */
export type PlaceSpec = Spot | {
  readonly at: Spot;
  readonly owned?: boolean;
  readonly header?: BlocksHeader | null;
  readonly key?: readonly [string, ...string[]];
  readonly projectKey?: Spot;
};

type RowCommon = {
  readonly tool: string;
  readonly scope: 'user' | 'project';
  readonly env?: Readonly<Record<string, Spot>>;
  readonly envLiterals?: Readonly<Record<string, string>>;
  readonly json?: readonly { readonly at: Spot; readonly value: Record<string, unknown> }[];
  /** JSON files `host.readJson` cannot parse: an openclaw.json with comments. */
  readonly invalidJson?: readonly Spot[];
  /** Small text files `host.readText` finds: a linked worktree's `.git` and `commondir`. */
  readonly texts?: readonly { readonly at: Spot; readonly text: string }[];
  /** Paths `host.exists` finds: directories, and the files a first-existing lookup tries. */
  readonly existingDirs: readonly Spot[];
  readonly toolHomes?: Readonly<Record<string, Spot>>;
  readonly toolRoots?: Readonly<Record<string, Spot>>;
  /** The `toolRoots` the member's user config records, which a project config recording none follows. */
  readonly userToolRoots?: Readonly<Record<string, Spot>>;
  /** The `Install` fields a row sets; the rest are the defaults: built-in `toolPaths`, no gitExclude, a team repo, no children. */
  readonly install?: {
    readonly toolPaths?: TeamaiConfig['toolPaths'];
    readonly gitExclude?: true;
    readonly self?: true;
    readonly workspaceChildren?: true;
    readonly enabledAgents?: readonly string[];
    readonly disabledAgents?: readonly string[];
  };
  readonly platforms?: readonly Platform[];
  /** null: nothing says whether the tool is installed, so the location has no `installed` gate. */
  readonly installed: { readonly probe: Spot; readonly met: boolean } | null;
  /** `none`: the resource puts no gate on teamai's write, not even `selected` (sessions). */
  readonly gates?: 'none';
  readonly readableConfig?: { readonly file: Spot; readonly met: boolean };
  readonly retired?: readonly { readonly at: Spot; readonly was: Retired<Place>['was'] }[];
  readonly source: string;
};

export type FilesRow = RowCommon & {
  readonly channel?: 'files';
  readonly writes: readonly PlaceSpec[];
  readonly reads: readonly {
    readonly at: Spot;
    readonly when: When;
    readonly key?: readonly string[];
    readonly projectKey?: Spot;
    readonly shadowedBy?: Spot;
    /** The root of a `workspaceUnder` or `cwdOnly` read: the project root unless the row says otherwise. */
    readonly root?: Spot;
  }[] | 'unknown';
  readonly readGates?: readonly { readonly kind: ReadGateKind; readonly config: Spot; readonly checkout: Spot }[];
  /** OpenCode's `instructions` key (rules, blocks); null when the row omits it and the location has the field. */
  readonly activation?: PlaceSpec;
  readonly alternate?: PlaceSpec;
  /** The project file a team repo's workspace takes the team's hooks in (Copilot); null when the row omits it and the location has the field. */
  readonly workspace?: PlaceSpec;
  readonly writtenBy?: string;
  /** Cells whose write the tool does not read from some cwd, with the issue that tracks it. */
  readonly broken?: Partial<Record<Cwd, { readonly reason: 'not-read' | 'shadowed' | 'cwd-only' | 'outside-workspace'; readonly issue: `#${number}` }>>;
};

export type OtherRow = RowCommon & {
  readonly channel: { readonly via: RunTimeVia; readonly probe: ChannelProbe; readonly limit: number | null } | 'none' | 'unknown';
};

export type MatrixRow = FilesRow | OtherRow;

const HOMES: Readonly<Record<Platform, string>> = { darwin: '/Users/m', linux: '/home/m', win32: 'C:\\Users\\m' };
const ROOTS: Readonly<Record<Platform, string>> = { darwin: '/Users/m/work/proj', linux: '/home/m/work/proj', win32: 'C:\\Users\\m\\work\\proj' };
const OUTSIDE_ROOTS: Readonly<Record<Platform, string>> = { darwin: '/Volumes/work/proj', linux: '/srv/work/proj', win32: 'D:\\work\\proj' };
/** Where an absolute spot (`/x`) lives on each platform: outside the home. */
const OUTSIDE: Readonly<Record<Platform, string>> = { darwin: '/', linux: '/', win32: 'E:\\' };

function flavorOf(platform: Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

function rootFor(platform: Platform, cwd: Cwd): string {
  return cwd === 'root-outside-home' ? OUTSIDE_ROOTS[platform] : ROOTS[platform];
}

function cwdOf(platform: Platform, cwd: Cwd): string {
  return cwd === 'project-subdir' ? flavorOf(platform).join(rootFor(platform, cwd), 'src') : rootFor(platform, cwd);
}

type Cell = { readonly platform: Platform; readonly cwd: Cwd; readonly env: Readonly<Record<string, string>> };

function at(spot: Spot, cell: Cell): string {
  const { platform, cwd, env } = cell;
  const p = flavorOf(platform);
  const [head, ...rest] = spot.split('/');
  if (head === '~') return p.join(HOMES[platform], ...rest);
  if (head === '<root>') return p.join(rootFor(platform, cwd), ...rest);
  if (head === '<cwd>') return p.join(cwdOf(platform, cwd), ...rest);
  if (head === '') return p.join(OUTSIDE[platform], ...rest);
  const value = env[head.slice(1)];
  if (value === undefined) throw new Error(`the row names ${head}, which the cell's env does not set`);
  return p.join(value, ...rest);
}

function envFor(row: MatrixRow, platform: Platform, cwd: Cwd): Record<string, string> {
  const env: Record<string, string> = platform === 'win32' ? { LOCALAPPDATA: 'C:\\Users\\m\\AppData\\Local' } : {};
  for (const [name, spot] of Object.entries(row.env ?? {})) env[name] = at(spot, { platform, cwd, env });
  return { ...env, ...row.envLiterals };
}

function hostFor(row: MatrixRow, cell: Cell): Host {
  const existing = new Set(row.existingDirs.map((spot) => at(spot, cell)));
  const files = new Map((row.json ?? []).map((file) => [at(file.at, cell), file.value]));
  const invalid = new Set((row.invalidJson ?? []).map((spot) => at(spot, cell)));
  const texts = new Map((row.texts ?? []).map((file) => [at(file.at, cell), file.text]));
  return {
    platform: cell.platform,
    path: flavorOf(cell.platform),
    home: HOMES[cell.platform],
    profileHome: HOMES[cell.platform],
    env: cell.env,
    toolHomes: { kind: 'ok', homes: expand(row.toolHomes, cell) },
    cwd: () => cwdOf(cell.platform, cell.cwd),
    exists: async (dir) => existing.has(dir),
    readJson: async (file) => {
      if (invalid.has(file)) return { kind: 'invalid', error: 'Unexpected token' };
      const value = files.get(file);
      return value === undefined ? { kind: 'missing' } : { kind: 'ok', value };
    },
    realpath: async (file) => file,
    readText: async (file) => texts.get(file) ?? null,
    existsNow: (file) => existing.has(file),
    readTextNow: (file) => texts.get(file) ?? null,
    userToolRoots: async () => row.userToolRoots && expand(row.userToolRoots, cell),
  };
}

function expand(record: Readonly<Record<string, Spot>> | undefined, cell: Cell): Record<string, string> {
  return Object.fromEntries(Object.entries(record ?? {}).map(([tool, spot]) => [tool, at(spot, cell)]));
}

function installFor(row: MatrixRow, cell: Cell): Install {
  const shared = {
    toolPaths: row.install?.toolPaths ?? DEFAULT_TOOL_PATHS,
    agents: { enabledAgents: row.install?.enabledAgents?.slice(), disabledAgents: row.install?.disabledAgents?.slice() },
    toolRoots: expand(row.toolRoots, cell),
    gitExclude: row.install?.gitExclude === true,
  };
  return row.scope === 'user' ? { ...shared, scope: 'user' } : {
    ...shared,
    scope: 'project',
    projectRoot: rootFor(cell.platform, cell.cwd),
    repo: row.install?.self ? 'self' : 'team',
    workspaceChildren: row.install?.workspaceChildren === true,
  };
}

function placeOf(spec: PlaceSpec, cell: Cell): Record<string, unknown> {
  if (typeof spec === 'string') return { path: at(spec, cell) };
  const { at: spot, projectKey, ...fields } = spec;
  return { path: at(spot, cell), ...fields, ...(projectKey === undefined ? {} : { projectKey: at(projectKey, cell) }) };
}

function isFilesRow(row: MatrixRow): row is FilesRow {
  return row.channel === undefined || row.channel === 'files';
}

function conditionsOf(row: MatrixRow): string {
  const conditions = [
    ...Object.keys(row.env ?? {}), ...Object.entries(row.envLiterals ?? {}).map(([name, value]) => `${name}=${value}`),
    ...(row.json ?? []).map((file) => file.at), ...(row.invalidJson ?? []).map((spot) => `unreadable ${spot}`), ...(row.texts ?? []).map((file) => file.at), ...Object.keys(row.toolHomes ?? {}).map((tool) => `recorded ${tool}`),
    ...Object.keys(row.userToolRoots ?? {}).map((tool) => `user toolRoots.${tool}`),
    ...(row.install?.gitExclude ? ['gitExclude'] : []), ...(row.install?.self ? ['self'] : []),
    ...(row.install?.workspaceChildren ? ['children'] : []), ...(row.installed === null || row.installed.met ? [] : ['not installed']),
  ];
  return conditions.join('+') || 'default env';
}

function expectFiles(row: FilesRow, where: Location, cell: Cell, host: Host): void {
  if (where.channel !== 'files') throw new Error(`${row.tool} ${row.scope}: expected a files channel, got ${where.channel}`);
  expect(writesOf<Place>(where)).toMatchObject(row.writes.map((write) => placeOf(write, cell)));
  expect(where.reads).toEqual(row.reads === 'unknown' ? 'unknown' : row.reads.map((read) => ({
    path: at(read.at, cell),
    ...(read.key === undefined ? {} : { key: read.key }),
    ...(read.projectKey === undefined ? {} : { projectKey: at(read.projectKey, cell) }),
    ...(read.shadowedBy === undefined ? {} : { shadowedBy: at(read.shadowedBy, cell) }),
    ...(read.when === 'always' ? { when: read.when } : { when: read.when, root: at(read.root ?? '<root>', cell) }),
  })));
  expect(where.readGates).toEqual((row.readGates ?? []).map((gate) => ({ kind: gate.kind, config: at(gate.config, cell), checkout: at(gate.checkout, cell) })));
  if ('activation' in where) expect(where.activation).toEqual(row.activation === undefined ? null : expect.objectContaining(placeOf(row.activation, cell)));
  if ('alternate' in where) expect(where.alternate).toEqual(row.alternate === undefined ? null : expect.objectContaining(placeOf(row.alternate, cell)));
  if ('writtenBy' in where) expect(where.writtenBy).toEqual(row.writtenBy ?? null);
  if ('workspace' in where) expect(where.workspace).toEqual(row.workspace === undefined ? null : expect.objectContaining(placeOf(row.workspace, cell)));
  const broken = row.broken?.[cell.cwd];
  expect(unreadWrites<Place>(where, host).map((unread) => unread.reason)).toEqual(broken ? [broken.reason] : []);
}

/**
 * A setting that moves a tool's home (`Home.moves`), as a row sets it: env
 * values, a text file (Hermes's `active_profile`), or a Windows cell for `%LOCALAPPDATA%`.
 */
type MoveSetting = {
  readonly tool: ToolId;
  readonly name: string;
  readonly env: Readonly<Record<string, string>>;
  readonly text?: { readonly at: Spot; readonly text: string };
  readonly win32: boolean;
};

function moveSettingsOf(tool: ToolId, move: HomeMove): MoveSetting[] {
  const setting = (name: string, value: string): MoveSetting => ({ tool, name, env: { [name]: value }, win32: false });
  switch (move.kind) {
    case 'env':
      return [setting(move.name, '/moved')];
    case 'xdg':
      return [setting('XDG_CONFIG_HOME', '/moved')];
    case 'openclaw-state':
      return [setting('OPENCLAW_STATE_DIR', '/moved'), setting('OPENCLAW_HOME', '/moved'), setting('OPENCLAW_PROFILE', 'moved')];
    case 'omp-agent':
      return [setting('OMP_PROFILE', 'moved'), setting('PI_PROFILE', 'moved'), setting('PI_CONFIG_DIR', '.moved')];
    case 'hermes-home':
      return [
        setting('HERMES_HOME', '/moved'), setting('HERMES_DATA_DIR_SUFFIX', '-moved'),
        { tool, name: 'LOCALAPPDATA', env: { LOCALAPPDATA: 'D:\\moved' }, win32: true },
        { tool, name: 'active_profile', env: {}, text: { at: '~/.hermes/active_profile', text: 'moved' }, win32: false },
      ];
    default: {
      const unhandled: never = move;
      return unhandled;
    }
  }
}

function moveSettings(): MoveSetting[] {
  return Object.keys(TOOLS).filter(isToolId).flatMap((tool) => {
    const { home }: ToolDescriptor = TOOLS[tool];
    return (home.moves?.by ?? []).flatMap((move) => moveSettingsOf(tool, move));
  });
}

/** The paths `tool` writes `resource` to on a host where every path exists, with `env` set. */
async function writesWith(resource: Resource, tool: ToolId, scope: 'user' | 'project', platform: Platform, env: Readonly<Record<string, string>>, texts: RowCommon['texts'] = []): Promise<string[]> {
  const row: MatrixRow = { tool, scope, existingDirs: [], texts, installed: null, channel: 'none', source: '' };
  const cell: Cell = { platform, cwd: 'project-root', env };
  const host: Host = { ...hostFor(row, cell), exists: async () => true };
  return writesOf<Place>(await locate(tool, resource, installFor(row, cell), host)).map((place) => place.path);
}

/**
 * The home moves that move a write of `resource` and no row sets: each one a
 * cell the matrix lacks (issue #1221: "each env override").
 */
async function uncoveredMoves(resource: Resource, rows: readonly MatrixRow[]): Promise<string[]> {
  const uncovered: string[] = [];
  for (const move of moveSettings()) {
    for (const scope of ['user', 'project'] as const) {
      const platform: Platform = move.win32 ? 'win32' : 'darwin';
      const base = envFor({ tool: move.tool, scope, existingDirs: [], installed: null, channel: 'none', source: '' }, platform, 'project-root');
      const moved = { ...base, ...move.env };
      const texts = move.text === undefined ? [] : [move.text];
      const [before, after] = await Promise.all([writesWith(resource, move.tool, scope, platform, base), writesWith(resource, move.tool, scope, platform, moved, texts)]);
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      const { text } = move;
      const covered = rows.some((row) => row.tool === move.tool && row.scope === scope && (move.win32
        ? (row.platforms ?? ['win32']).includes('win32')
        : text !== undefined ? (row.texts ?? []).some((file) => file.at === text.at)
          : Object.hasOwn(row.env ?? {}, move.name) || Object.hasOwn(row.envLiterals ?? {}, move.name)));
      if (!covered) uncovered.push(`${move.tool} ${scope} ${move.name}`);
    }
  }
  return uncovered;
}

export function describeLocateMatrix(resource: Resource, rows: readonly MatrixRow[]): void {
  describe(`locate: ${resource} matrix`, () => {
    for (const row of rows) {
      for (const platform of row.platforms ?? (['darwin', 'linux', 'win32'] as const)) {
        for (const cwd of ['project-root', 'project-subdir', 'root-outside-home'] as const) {
          it(`${row.tool} ${row.scope} ${platform} ${conditionsOf(row)} cwd=${cwd}`, async () => {
            const env = envFor(row, platform, cwd);
            const cell: Cell = { platform, cwd, env };
            const host = hostFor(row, cell);
            const where: Location = await locate(row.tool, resource, installFor(row, cell), host);
            const installed = row.installed === null ? [] : [{ kind: 'installed', probe: at(row.installed.probe, cell), met: row.installed.met }];
            const readable = row.readableConfig === undefined ? [] : [{ kind: 'readable-config', file: at(row.readableConfig.file, cell), met: row.readableConfig.met }];
            const selected = { kind: 'selected', met: !(row.install?.disabledAgents ?? []).includes(row.tool) };
            expect(where.gates).toEqual(row.gates === 'none' ? [] : [selected, ...installed, ...readable]);
            expect(where.retired.map((retired) => ({ path: retired.place.path, was: retired.was })))
              .toEqual((row.retired ?? []).map((retired) => ({ path: at(retired.at, cell), was: retired.was })));
            if (isFilesRow(row)) {
              expectFiles(row, where, cell, host);
            } else if (typeof row.channel === 'object') {
              expect(where).toMatchObject({ channel: 'run-time', ...row.channel });
            } else {
              expect(where.channel).toBe(row.channel);
            }
          });
        }
      }
    }

    it('every home move that moves a write has a row that sets it', async () => {
      expect(await uncoveredMoves(resource, rows)).toEqual([]);
    });

    it('every row write is among its reads, or the row names its issue', () => {
      const spotOf = (write: PlaceSpec): Spot => typeof write === 'string' ? write : write.at;
      const unsupported = rows.filter(isFilesRow).filter((row) => row.reads !== 'unknown' && row.broken === undefined
        && !row.writes.every((write) => row.reads !== 'unknown'
          && row.reads.some((read) => spotOf(write) === read.at || spotOf(write).startsWith(`${read.at}/`))));
      expect(unsupported.map((row) => `${row.tool} ${row.scope}`)).toEqual([]);
    });
  });
}
