/**
 * Where teamai writes a tool's resource, where that tool reads it, and what
 * must hold for the write, on one machine. The answer depends on the tool, the
 * member's config (`Install`) and the machine (`Host`) and nothing else: no
 * `process.env`, home or filesystem read is reachable from `locate` except
 * through `host`, and paths are joined in the host's flavor, so a Linux test
 * can resolve a Windows member's paths.
 */
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { MCP_SERVER_KEY } from './resources/mcp-format.js';
import { SESSION_PLATFORM_FACTS, type SessionPlatform, type StoredSessionPlatform } from './session-flow/adapters/platform-facts.js';
import {
  channelsOf, installGateOf, isToolId, hasDefaultHomeLeftovers, TOOLS,
  type Activation, type BlocksFile, type BlocksHeader, type ChannelProbe, type FirstExistingRead, type HomeRead, type HookAdapter,
  type HookAdapterId, type HookFormat, type HookSettings, type McpProject, type McpUser, type ProjectRead, type ReadGateKind, type RunTime,
  type RunTimeVia,
} from './tools.js';
import {
  DEFAULT_TOOL_PATHS, isAgentExcluded, isGitExcludeEnabled, isSelfMode, recordedToolRootDir, resolveBaseDir, scopedToolPaths, toolGateRoot,
  WORKBUDDY_NEW_GENERATION_ROOT, WORKBUDDY_TOOL_ID, WORKBUDDY_TOOL_ROOT,
  type HomePaths, type LocalConfig, type Scope, type TeamaiConfig, type ToolId,
} from './types.js';
import { defaultToolHome, homeRoot, movedToolHome, realHost, toolHome, type Host } from './tool-home.js';
import { resolveOpenclawConfigPath, resolveOpenclawWorkspace, type OpenclawWorkspace } from './openclaw-home.js';
import { hasWorkspaceChildren } from './workspace-children.js';

/**
 * What the member's config decides. `toolRoots` re-root user-scope paths only,
 * as they always have. A tool's home is the machine's (`Host`), not the config's.
 * `gitExclude` is `sharing.gitExclude` as the member's config resolves it.
 */
export type Install = {
  readonly toolPaths: TeamaiConfig['toolPaths'];
  readonly agents: Pick<LocalConfig, 'enabledAgents' | 'disabledAgents'>;
  readonly toolRoots: Readonly<Record<string, string>>;
  readonly gitExclude: boolean;
} & (
  | { readonly scope: 'user' }
  | {
    readonly scope: 'project';
    readonly projectRoot: string;
    /** `self`: the business repo is the team repo. */
    readonly repo: 'team' | 'self';
    readonly workspaceChildren: boolean;
  }
);

/** The one parse of the config shapes into an `Install`; a project config without its root throws `resolveBaseDir`'s error. */
export function installOf(
  team: Pick<TeamaiConfig, 'toolPaths'> & Parameters<typeof isGitExcludeEnabled>[1],
  local: Pick<LocalConfig, 'scope' | 'projectRoot' | 'toolRoots' | 'enabledAgents' | 'disabledAgents' | 'gitExcludeEnabled' | 'dataHome' | 'children'>
    & Parameters<typeof isSelfMode>[0],
): Install {
  const shared = {
    toolPaths: team.toolPaths,
    agents: { enabledAgents: local.enabledAgents, disabledAgents: local.disabledAgents },
    toolRoots: local.toolRoots ?? {},
    gitExclude: isGitExcludeEnabled(local, team),
  };
  switch (local.scope) {
    case 'user':
      return { ...shared, scope: 'user' };
    case 'project':
      return {
        ...shared,
        scope: 'project',
        projectRoot: resolveBaseDir(local),
        repo: isSelfMode(local) ? 'self' : 'team',
        workspaceChildren: hasWorkspaceChildren(local),
      };
    default: {
      const unhandled: never = local.scope;
      return unhandled;
    }
  }
}

/** Resources `locate` answers for. */
export type Resource = 'skills' | 'rules' | 'blocks' | 'agents' | 'mcp' | 'hooks' | 'sessions';

/** A directory teamai writes one file or folder per item into: skills, agents, rule files. */
export type DirPlace = { readonly kind: 'dir'; readonly path: string };

/**
 * A file teamai keeps marked blocks in: the instruction blocks, or the
 * team-rules block of a tool that reads no rules directory. `owned`: the
 * whole file is teamai's, deleted once its blocks are gone; otherwise it is
 * the member's or the tool's.
 */
export type FilePlace = { readonly kind: 'file'; readonly path: string; readonly owned: boolean; readonly header: BlocksHeader | null };

/**
 * A map under `key` of a JSON or TOML file teamai shares with the tool, under
 * `projects[projectKey]` of that file for a local scope (#915).
 */
export type EntryPlace = { readonly kind: 'entry'; readonly path: string; readonly key: readonly [string, ...string[]]; readonly projectKey?: string };

export type Place = DirPlace | FilePlace | EntryPlace;

/** What each resource writes: a rules location is a directory, or the team-rules block in the blocks file. */
export type PlaceOf = {
  readonly skills: DirPlace;
  readonly rules: DirPlace | FilePlace;
  readonly blocks: FilePlace;
  readonly agents: DirPlace;
  readonly mcp: EntryPlace;
  readonly hooks: EntryPlace | DirPlace;
  readonly sessions: DirPlace;
};

/**
 * Where the tool reads. `always`: from any session. `workspaceUnder`: from a
 * session at or under `root`. `cwdOnly`: from a session at `root` only. A file
 * read names the map it takes (`key`, and `projectKey` for a local scope).
 * `shadowedBy`: the tool reads only the first of several files that exists
 * (#993), and that is this other file, so this one is not read now.
 */
export type Read = {
  readonly path: string;
  readonly key?: readonly string[];
  readonly projectKey?: string;
  readonly shadowedBy?: string;
} & (
  | { readonly when: 'always' }
  | { readonly when: 'workspaceUnder' | 'cwdOnly'; readonly root: string }
);

/** A condition on teamai's write: pull skips a tool whose gates are not all met. */
export type Gate =
  | { readonly kind: 'selected'; readonly met: boolean }
  | { readonly kind: 'installed'; readonly probe: string; readonly met: boolean }
  /** OpenClaw's instruction files: an openclaw.json teamai cannot parse may name another workspace (#946). */
  | { readonly kind: 'readable-config'; readonly file: string; readonly met: boolean };

/**
 * A condition outside teamai's write that decides whether the tool reads it.
 * Declared, not evaluated: doctor evaluates it, and pull writes regardless,
 * so a trust a later step of the same pull grants never holds a write back.
 */
export type ReadGate = {
  readonly kind: ReadGateKind;
  /** The tool config that holds the verdict. */
  readonly config: string;
  readonly checkout: string;
};

/**
 * A place teamai wrote this resource to before and no longer writes, and why.
 * Pull strips or moves teamai's content out of it, never the member's, and
 * uninstall clears it. A place a tool left because its home moved is not one:
 * pull keeps that and names it once (`places.ts`).
 */
export type Retired<P extends Place> = {
  readonly place: P;
  readonly was:
    /** An earlier release's default. */
    | 'default'
    /** The built-in path of a tool the team maps elsewhere or not at all: what a pull wrote there outlives the mapping. */
    | 'builtin'
    /** The team's configured path, where teamai no longer writes. */
    | 'configured'
    /** The target the other value of `sharing.gitExclude` selects (#915). */
    | 'git-exclude'
    /** Another file of a first-existing lookup (#993). */
    | 'lookup'
    /** A tool's project file or its local scope, whichever is not in use (#915). */
    | 'other-scope';
};

type Common<P extends Place> = { readonly retired: readonly Retired<P>[]; readonly gates: readonly Gate[] };

/**
 * teamai writes `own`: null when the tool has no place in the scope (no
 * configured path, no OpenClaw workspace). Present whether or not the gates
 * are met, so uninstall and push look where teamai may have written.
 */
export type FilesChannel<P extends Place> = Common<P> & {
  readonly channel: 'files';
  readonly own: P | null;
  readonly reads: readonly Read[] | 'unknown';
  readonly readGates: readonly ReadGate[];
};

/** teamai's session hook, extension or plugin adds the resource to each session; `probe` names the check that says it is installed there. */
export type RunTimeChannel<P extends Place> = Common<P> & {
  readonly channel: 'run-time';
  readonly via: RunTimeVia;
  readonly probe: ChannelProbe;
  /** Characters the channel takes before the tool drops the text whole. */
  readonly limit: number | null;
};

/** `none`: teamai builds nothing here, by decision. `unknown`: teamai builds nothing because where the tool takes it is unknown. */
export type SilentChannel<P extends Place> = Common<P> & { readonly channel: 'none' | 'unknown' };

export type Located<P extends Place> = FilesChannel<P> | RunTimeChannel<P> | SilentChannel<P>;

/** `activation`: the key teamai also writes so the tool loads the files (OpenCode's `instructions`); null for every other tool. */
type Activated = { readonly activation: EntryPlace | null };

type LocationOf = {
  /** `shared`: Codex's `.agents/skills`, chosen per skill by its writer; null for every other tool. */
  readonly skills: FilesChannel<DirPlace> & { readonly shared: DirPlace | null };
  readonly rules: (FilesChannel<PlaceOf['rules']> & Activated & {
    /** OpenCode's project MCP file, where an earlier release wrote the rules glob. Unset elsewhere, and not a `retired` rules place. */
    readonly retiredActivation?: EntryPlace | null;
  }) | RunTimeChannel<PlaceOf['rules']> | SilentChannel<PlaceOf['rules']>;
  readonly blocks: (FilesChannel<FilePlace> & Activated) | RunTimeChannel<FilePlace> | SilentChannel<FilePlace>;
  readonly agents: FilesChannel<DirPlace> | SilentChannel<DirPlace>;
  readonly mcp: (FilesChannel<EntryPlace> & {
    /** Where teamai writes instead of `own` when OpenCode V2's plugin delivers; that choice needs a version probe `locate` does not run. */
    readonly alternate: EntryPlace | null;
    /** The tool reads another tool's project file (Muse and tclaude: claude's `.mcp.json`): `own` is that tool's place, and that tool writes it. */
    readonly writtenBy: ToolId | null;
    /** `own` is the first of `files` that exists (#993); `mapped` is the one the team's mapping names, where teamai wrote before #993. */
    readonly lookup: McpLookup | null;
  }) | SilentChannel<EntryPlace>;
  /**
   * `own`: the hook list of the tool's hook file, in `format`, or the
   * directory its `adapter` writes teamai's file into. A workspace takes the
   * user hooks, and self mode the project's unless the tool takes its user
   * hooks there too (`HooksChannels.self`). `retired`: the default home's,
   * where earlier releases wrote before the home moved. `workspace`: the
   * project file a team repo's workspace takes the team's hooks in, beside
   * the user hooks in `own` (`HooksChannels.workspace`); null elsewhere.
   */
  readonly hooks:
    | (FilesChannel<EntryPlace> & { readonly format: HookFormat; readonly workspace: EntryPlace | null })
    | (FilesChannel<DirPlace> & { readonly adapter: HookAdapterId })
    | SilentChannel<EntryPlace | DirPlace>;
  /**
   * `own`: the store of the first of the tool's `sessions`, `platform`, where its launched sessions
   * go and a copy to it is written. `none` and `unknown` as the tool's `sessions` say.
   */
  readonly sessions: (FilesChannel<DirPlace> & { readonly platform: SessionPlatform }) | SilentChannel<DirPlace>;
};

/** Files a tool tries in order, reading only the first that exists. */
export type McpLookup = { readonly files: readonly string[]; readonly mapped: string };

/** Where `locate` says a tool takes `R`: one type per resource, so a caller never narrows a place kind it asked for. */
export type Location<R extends Resource = Resource> = LocationOf[R];

/** `.agents/skills`: Codex reads it, and Muse writes it in a project. */
export const SHARED_AGENT_SKILLS_PATH = '.agents/skills';

type Locator<R extends Resource> = (tool: string, install: Install, host: Host) => Promise<Location<R>>;

const LOCATORS: { readonly [R in Resource]: Locator<R> } = {
  skills: locateSkills,
  rules: locateRules,
  blocks: locateBlocks,
  agents: locateAgents,
  mcp: locateMcp,
  hooks: locateHooks,
  sessions: locateSessions,
};

/** Where `tool` takes `resource` on `host` under `install`. */
export async function locate<R extends Resource>(tool: string, resource: R, install: Install, host: Host = realHost()): Promise<Location<R>> {
  return LOCATORS[resource](tool, install, host);
}

type Beside<P extends Place> = { readonly shared?: P | null; readonly activation?: EntryPlace | null; readonly alternate?: EntryPlace | null };

/** `own` when the channel writes files and every gate is met, else null: the one rule a writer applies. */
export function writable<P extends Place>(location: Located<P>): P | null {
  return location.channel === 'files' && location.gates.every((gate) => gate.met) ? location.own : null;
}

/** `own` whatever the gates say: what push and the scans read, where pull would write. */
export function ownOf<P extends Place>(location: Located<P>): P | null {
  return location.channel === 'files' ? location.own : null;
}

/** The project file a team repo's workspace takes the tool's team hooks in, beside its user hooks; null for every other install and tool. */
export function workspaceHooksOf(location: Location<'hooks'>): EntryPlace | null {
  return location.channel === 'files' && 'workspace' in location ? location.workspace : null;
}

/** Whether the tool counts as installed for this resource: its `installed` gate, when it has one, is met. Selection is the caller's question. */
export function isInstalledFor(location: { readonly gates: readonly Gate[] }): boolean {
  return location.gates.every((gate) => gate.kind !== 'installed' || gate.met);
}

/** Every place teamai writes the tool's resource to: its own, then the shared one. */
export function writesOf<P extends Place>(location: Located<P> & Beside<P>): P[] {
  if (location.channel !== 'files') return [];
  return [location.own, location.shared ?? null].filter((place) => place !== null);
}

/** Every place teamai may hold the tool's resource in: its writes, the activation, the alternate and the places it retired. Uninstall clears these. */
export function cleanupOf<P extends Place>(location: Located<P> & Beside<P>): Place[] {
  const beside = [location.activation ?? null, location.alternate ?? null].filter((place) => place !== null);
  return [...writesOf(location), ...beside, ...location.retired.map((retired) => retired.place)];
}

/** A write the tool does not read from a session at the host's cwd, and why. */
export type Unread =
  | { readonly write: string; readonly reason: 'not-read' }
  | { readonly write: string; readonly reason: 'shadowed'; readonly by: string }
  | { readonly write: string; readonly reason: 'cwd-only' | 'outside-workspace'; readonly readFrom: string };

/**
 * Where the sessions a read is judged for start: in one directory, anywhere at
 * or under a project root, or anywhere at all.
 */
export type Session =
  | { readonly kind: 'at'; readonly dir: string }
  | { readonly kind: 'within'; readonly root: string }
  | { readonly kind: 'anywhere' };

/**
 * The writes of `location` the tool would not read from every session
 * `session` covers (a session in `host.cwd()` by default); none when it writes
 * no files or its reads are unknown.
 */
export function unreadWrites<P extends Place>(
  location: Located<P> & Beside<P>,
  host: Host = realHost(),
  session: Session = { kind: 'at', dir: host.cwd() },
): readonly Unread[] {
  if (location.channel !== 'files' || location.reads === 'unknown') return [];
  const { reads } = location;
  const p = host.path;
  const unread: Unread[] = [];
  for (const write of writesOf(location)) {
    const read = reads.find((candidate) => readsPlace(p, candidate, write));
    if (!read) {
      unread.push({ write: write.path, reason: 'not-read' });
      continue;
    }
    if (read.shadowedBy !== undefined) {
      unread.push({ write: write.path, reason: 'shadowed', by: read.shadowedBy });
      continue;
    }
    switch (read.when) {
      case 'always':
        break;
      case 'cwdOnly':
        if (!(session.kind === 'at' && samePathOn(p, session.dir, read.root))) unread.push({ write: write.path, reason: 'cwd-only', readFrom: read.root });
        break;
      case 'workspaceUnder':
        if (!readsUnderFor(p, session, read.root)) unread.push({ write: write.path, reason: 'outside-workspace', readFrom: read.root });
        break;
      default: {
        const unhandled: never = read;
        return unhandled;
      }
    }
  }
  return unread;
}

/** Whether every session `session` covers starts at or under `root`. */
function readsUnderFor(p: path.PlatformPath, session: Session, root: string): boolean {
  switch (session.kind) {
    case 'at':
      return isAtOrUnder(p, session.dir, root);
    case 'within':
      return isAtOrUnder(p, session.root, root);
    case 'anywhere':
      return false;
    default: {
      const unhandled: never = session;
      return unhandled;
    }
  }
}

function readsPlace(p: path.PlatformPath, read: Read, write: Place): boolean {
  switch (write.kind) {
    case 'dir':
      return read.key === undefined && samePathOn(p, write.path, read.path);
    case 'file':
      return read.key === undefined && isAtOrUnder(p, write.path, read.path);
    case 'entry':
      return samePathOn(p, write.path, read.path) && write.projectKey === read.projectKey
        && read.key !== undefined && read.key.length === write.key.length && read.key.every((part, i) => part === write.key[i]);
    default: {
      const unhandled: never = write;
      return unhandled;
    }
  }
}

function samePathOn(p: path.PlatformPath, a: string, b: string): boolean {
  return isAtOrUnder(p, a, b) && isAtOrUnder(p, b, a);
}

function isAtOrUnder(p: path.PlatformPath, dir: string, root: string): boolean {
  const relative = p.relative(root, dir);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${p.sep}`) && !p.isAbsolute(relative));
}

type ToolPaths = TeamaiConfig['toolPaths'][string];

type PathField = 'skills' | 'rules' | 'agents' | 'claudemd' | 'mcp' | 'mcpProject' | 'settings' | 'hooks';

/**
 * Where a configured or declared path of one tool becomes absolute. Two
 * resources or two tools that name one file (`opencode.json`,
 * `<root>/.mcp.json`, Codex's `AGENTS.md`) resolve it here, so a home move
 * moves them together.
 */
type Roots = {
  readonly base: string;
  readonly home: { readonly root: string; readonly dir: string } | undefined;
  readonly paths: ToolPaths | undefined;
  readonly configured: (field: PathField) => string | null;
  readonly declared: (from: 'home' | 'project', relative: string) => string;
  readonly codebuddyConfigDir: string;
  readonly join: (root: string, relative: string) => string;
  readonly underHome: (relative: string) => string;
};

/** `relative`, a `$HOME`-relative path, re-rooted in `tool`'s home where it falls under the home's root, which a recorded or env move relocates. */
function underToolHome(tool: string, relative: string, host: Host): string {
  const p = host.path;
  if (isToolId(tool)) {
    const root = homeRoot(tool);
    if (relative === root || relative.startsWith(`${root}/`)) return p.join(toolHome(tool, host), ...relative.slice(root.length + 1).split('/'));
  }
  return p.join(host.home, ...relative.split('/'));
}

function rootsOf(tool: string, install: Install, host: Host): Roots {
  const p = host.path;
  const at: HomePaths = { home: host.home, path: p };
  const known = isToolId(tool) ? tool : undefined;
  const base = install.scope === 'user' ? host.home : install.projectRoot;
  const paths = install.scope === 'user'
    ? scopedToolPaths(install, { scope: 'user', toolRoots: install.toolRoots }, at)[tool]
    : install.toolPaths[tool];
  const join = (root: string, relative: string): string => p.join(root, ...relative.split('/'));
  const home = known === undefined ? undefined : { root: homeRoot(known), dir: toolHome(known, host) };
  const underHome = (relative: string): string => underToolHome(tool, relative, host);
  const relocated = (relative: string): string =>
    scopedToolPaths({ toolPaths: { [tool]: { skills: relative } } }, { scope: 'user', toolRoots: install.toolRoots }, at)[tool]?.skills ?? relative;
  return {
    base,
    home,
    paths,
    configured: (field) => {
      const relative = paths?.[field];
      if (relative === undefined) return null;
      if (install.scope !== 'user') return join(base, relative);
      // User-scope Copilot paths are relative to its home.
      return tool === 'copilot' && home ? join(home.dir, relative) : underHome(relative);
    },
    declared: (from, relative) => {
      if (from === 'project') return join(base, relative);
      return underHome(install.scope === 'user' ? relocated(relative) : relative);
    },
    codebuddyConfigDir: movedToolHome('codebuddy', host) ?? host.home,
    join,
    underHome,
  };
}

/**
 * `install` seen from its user scope: a run-time channel and a local MCP scope run from the tool's user config,
 * and a project pull cleans what an earlier one left in a user file (Hermes' SOUL.md).
 * A project config that records no `toolRoots` takes the user config's: a root is the machine's, and a
 * user-scope init may have recorded it after the project was set up.
 */
export async function userViewOf(install: Install, host: Host = realHost()): Promise<Install> {
  const toolRoots = install.scope === 'project' && Object.keys(install.toolRoots).length === 0
    ? await host.userToolRoots() ?? {}
    : install.toolRoots;
  return { toolPaths: install.toolPaths, agents: install.agents, toolRoots, gitExclude: install.gitExclude, scope: 'user' };
}

async function gatesOf(tool: string, install: Install, host: Host, roots: Roots = rootsOf(tool, install, host), resource?: Resource): Promise<Gate[]> {
  const selected: Gate = { kind: 'selected', met: !isAgentExcluded(install.agents, tool) };
  const installed = await installedGateOf(tool, install, host, roots, resource);
  return installed === null ? [selected] : [selected, installed];
}

async function installedGateOf(tool: string, install: Install, host: Host, roots: Roots, resource?: Resource): Promise<Gate | null> {
  const { home, join } = roots;
  const enabled = install.agents.enabledAgents?.includes(tool) === true;
  const probe = async (dir: string, met?: boolean): Promise<Gate> => ({ kind: 'installed', probe: dir, met: met ?? await host.exists(dir) });
  if (tool === 'openclaw') {
    const workspace = await openclawWorkspaceOf(roots, host);
    switch (workspace.kind) {
      case 'found':
        return probe(workspace.dir, true);
      case 'unreadable-config':
        return probe(workspace.fallback ?? workspace.file, workspace.fallback !== null);
      case 'none':
        return probe(workspace.candidate, false);
      default: {
        const unhandled: never = workspace;
        return unhandled;
      }
    }
  }
  if (tool === 'hermes' && home) return probe(home.dir);
  // Copilot's home says it is installed in either scope.
  if (tool === 'copilot' && home) return probe(home.dir, enabled || undefined);
  const installedBy = isToolId(tool) ? installGateOf(tool) : undefined;
  if (home && installedBy !== undefined) {
    switch (installedBy) {
      case 'home-edition':
        return probe(join(host.home, home.root), enabled || undefined);
      case 'home':
        return probe(home.dir);
      case 'own-root':
        // WorkBuddy 5.7+ moved its runtime to `.workbuddy-ai/` and stops
        // reading `.workbuddy/` (#1273): the new root present means 5.7+ is
        // the live generation (an upgrade leaves the old root behind as an
        // unread leftover), so it is the install proof even when both exist —
        // but only for skills, the one surface with verified 5.7+ delivery
        // evidence (the 13-skill `/` menu check in #1273). Every other
        // surface keeps requiring the old root and fails closed on a
        // 5.7-only member until its real 5.7+ path is confirmed (#1290).
        if (resource === 'skills' && tool === WORKBUDDY_TOOL_ID
          && await host.exists(join(roots.base, WORKBUDDY_NEW_GENERATION_ROOT))) {
          return probe(join(roots.base, WORKBUDDY_NEW_GENERATION_ROOT));
        }
        return probe(join(roots.base, home.root));
      default: {
        const unhandled: never = installedBy;
        return unhandled;
      }
    }
  }
  const { paths } = roots;
  // A bare `claudemd` such as `AGENTS.md` is shared by several tools and says nothing about any one of them.
  const nestedClaudemd = paths?.claudemd?.includes('/') ? paths.claudemd : undefined;
  const relative = paths?.skills ?? paths?.agents ?? paths?.rules ?? paths?.settings ?? nestedClaudemd;
  if (relative === undefined) return null;
  const gateRoot = toolGateRoot(tool, relative, install.toolRoots, { home: host.home, path: host.path });
  const gateRootLeftByMovedHome = home !== undefined && home.root.startsWith(`${gateRoot}/`) && home.dir !== join(host.home, home.root);
  return probe(install.scope !== 'user' ? join(roots.base, gateRoot) : gateRootLeftByMovedHome ? home.dir : roots.underHome(gateRoot));
}

async function openclawWorkspaceOf(roots: Roots, host: Host): Promise<OpenclawWorkspace> {
  return resolveOpenclawWorkspace(undefined, { host, stateDir: openclawStateDir(roots, host) });
}

/** The workspace OpenClaw's skills and hooks go to: the one it reads, else the one an unreadable openclaw.json leaves (`fallback`). */
function openclawWritesTo(workspace: OpenclawWorkspace): string | null {
  return workspace.kind === 'found' ? workspace.dir : workspace.kind === 'unreadable-config' ? workspace.fallback : null;
}

/** OpenClaw's workspace on `host`, where its skills and hooks go; null when there is none. Its hooks need no `Install`. */
export async function openclawWorkspaceDir(host: Host = realHost()): Promise<string | null> {
  return openclawWritesTo(await resolveOpenclawWorkspace(undefined, { host, stateDir: toolHome('openclaw', host) }));
}

function openclawStateDir(roots: Roots, host: Host): string {
  return roots.home?.dir ?? roots.join(host.home, '.openclaw');
}

async function lookupOf(read: FirstExistingRead, roots: Roots, host: Host): Promise<{ readonly files: readonly string[]; readonly first: string }> {
  const files = read.base === 'home'
    ? read.firstOf.map((file) => typeof file === 'string' ? roots.declared('home', file) : host.path.join(roots.codebuddyConfigDir, file.path))
    : read.firstOf.map((file) => roots.declared('project', file));
  const index = (await Promise.all(files.map((file) => host.exists(file)))).indexOf(true);
  return { files, first: files[index === -1 ? 0 : index] };
}

async function readsOf(
  declared: readonly (HomeRead | ProjectRead | FirstExistingRead)[] | 'unknown',
  roots: Roots,
  host: Host,
  key?: readonly string[],
): Promise<readonly Read[] | 'unknown'> {
  if (declared === 'unknown') return 'unknown';
  const keyed = key === undefined ? {} : { key };
  const reads: Read[] = [];
  for (const read of declared) {
    if ('firstOf' in read) {
      const { files, first } = await lookupOf(read, roots, host);
      for (const file of files) {
        const shadowed = file === first ? {} : { shadowedBy: first };
        reads.push(read.base === 'home'
          ? { path: file, ...keyed, ...shadowed, when: 'always' }
          : { path: file, ...keyed, ...shadowed, when: read.when, root: roots.base });
      }
      continue;
    }
    switch (read.base) {
      case 'home':
        reads.push(read.when === 'workspaceUnderHome'
          ? { path: roots.declared('home', read.path), ...keyed, when: 'workspaceUnder', root: host.home }
          : { path: roots.declared('home', read.path), ...keyed, when: 'always' });
        break;
      case 'project':
        reads.push({ path: roots.declared('project', read.path), ...keyed, when: read.when, root: roots.base });
        break;
      default: {
        const unhandled: never = read;
        return unhandled;
      }
    }
  }
  return reads;
}

async function readGatesOf(kinds: readonly ReadGateKind[] | undefined, install: Install, host: Host): Promise<ReadGate[]> {
  if (kinds === undefined || install.scope !== 'project') return [];
  const user = await userViewOf(install, host);
  return kinds.map((kind): ReadGate => {
    switch (kind) {
      case 'codex-project-trust':
        return { kind, config: rootsOf('codex', user, host).declared('home', '.codex/config.toml'), checkout: install.projectRoot };
      default: {
        const unhandled: never = kind;
        return unhandled;
      }
    }
  });
}

function runTimeOf<P extends Place>(channel: RunTime, retired: readonly Retired<P>[], gates: readonly Gate[]): RunTimeChannel<P> {
  return { channel: 'run-time', via: channel.channel, probe: channel.probe, limit: channel.limit ?? null, retired, gates };
}

function settled<P extends Place>(own: Place | null, candidates: readonly (Retired<P> | null)[], p: path.PlatformPath): Retired<P>[] {
  const kept: Retired<P>[] = [];
  for (const candidate of candidates) {
    if (candidate === null || (own !== null && samePlaceOn(p, own, candidate.place))) continue;
    if (!kept.some((other) => samePlaceOn(p, other.place, candidate.place))) kept.push(candidate);
  }
  return kept;
}

/** One place: one file, and for an entry one key in it and one project under that key (ZCode's `mcpServers` and `mcp.servers` in one file are two). */
function samePlaceOn(p: path.PlatformPath, a: Place, b: Place): boolean {
  const entry = (place: Place): readonly [readonly string[] | undefined, string | undefined] =>
    place.kind === 'entry' ? [place.key, place.projectKey] : [undefined, undefined];
  return samePathOn(p, a.path, b.path) && isDeepStrictEqual(entry(a), entry(b));
}

async function locateSkills(tool: string, install: Install, host: Host): Promise<Location<'skills'>> {
  const roots = rootsOf(tool, install, host);
  const configured = roots.configured('skills');
  if (configured === null) return { channel: 'files', own: null, shared: null, reads: 'unknown', readGates: [], retired: [], gates: [] };

  let own: string | null = configured;
  // WorkBuddy 5.7+ scans skills from `.workbuddy-ai/skills` and stops reading
  // `.workbuddy/` (#1273), so on an install whose live generation is the new
  // root, skills land where the app scans. Only the default path swaps —
  // a team that redirected skills on purpose keeps its own. User scope may
  // already carry the swapped default (`scopedToolPaths`), so both spellings
  // count (#1290: the new root wins even when an upgrade left both behind).
  if (tool === WORKBUDDY_TOOL_ID) {
    const relative = roots.paths?.skills;
    if ((relative === `${WORKBUDDY_TOOL_ROOT}/skills` || relative === `${WORKBUDDY_NEW_GENERATION_ROOT}/skills`)
      && await host.exists(roots.join(roots.base, WORKBUDDY_NEW_GENERATION_ROOT))) {
      own = roots.join(roots.base, `${WORKBUDDY_NEW_GENERATION_ROOT}/skills`);
    }
  }
  let shared: string | null = null;
  if (tool === 'openclaw') {
    const dir = openclawWritesTo(await openclawWorkspaceOf(roots, host));
    own = dir === null ? null : host.path.join(dir, 'skills');
  } else if (tool === 'hermes' && roots.home) {
    own = host.path.join(roots.home.dir, 'skills');
  } else if (tool === 'codex') {
    shared = roots.join(roots.base, SHARED_AGENT_SKILLS_PATH);
  }

  return {
    channel: 'files',
    own: own === null ? null : { kind: 'dir', path: own },
    shared: shared === null ? null : { kind: 'dir', path: shared },
    reads: await readsOf(isToolId(tool) ? TOOLS[tool].skills[install.scope] : 'unknown', roots, host),
    readGates: [],
    retired: [],
    gates: await gatesOf(tool, install, host, roots, 'skills'),
  };
}

async function locateRules(tool: string, install: Install, host: Host): Promise<Location<'rules'>> {
  const channel = channelsOf(tool).rules[install.scope];
  const roots = rootsOf(tool, install, host);
  const dir = roots.configured('rules');
  // An earlier release copied team rules verbatim into any configured rules directory (#993).
  if (channel === 'none' || channel === 'unknown') {
    return { channel, retired: dir === null ? [] : [{ place: { kind: 'dir', path: dir }, was: 'configured' }], gates: await gatesOf(tool, install, host, roots) };
  }
  // A team entry written before the tool's rules moved (#938, #946) still names a directory the tool never reads: teamai writes there as the entry says, and doctor fails it.
  if (dir !== null && channel.channel !== 'dir') {
    return { channel: 'files', own: { kind: 'dir', path: dir }, activation: null, reads: [], readGates: [], retired: [], gates: await gatesOf(tool, install, host, roots) };
  }
  switch (channel.channel) {
    case 'dir': {
      const retiredActivation = await retiredRulesActivation(tool, install, host, roots);
      return {
        channel: 'files',
        own: dir === null ? null : { kind: 'dir', path: dir },
        activation: await activationOf(channel.activation, tool, install, host, roots),
        reads: await readsOf(channel.reads, roots, host),
        readGates: [],
        retired: [],
        ...(retiredActivation === undefined ? {} : { retiredActivation }),
        gates: await gatesOf(tool, install, host, roots),
      };
    }
    case 'inline': {
      const blocks = await locateBlocks(tool, install, host);
      return blocks.channel === 'files' ? { ...blocks, retired: [] } : { channel: 'unknown', retired: [], gates: blocks.gates };
    }
    case 'session-hook':
    case 'extension':
    case 'plugin':
      return runTimeOf(channel, [], await gatesOf(tool, await userViewOf(install, host), host));
    default: {
      const unhandled: never = channel;
      return unhandled;
    }
  }
}

async function locateBlocks(tool: string, install: Install, host: Host): Promise<Location<'blocks'>> {
  const { blocks } = channelsOf(tool);
  const channel = blocks[install.scope];
  const roots = rootsOf(tool, install, host);
  const p = host.path;
  const memberFile = (file: string): FilePlace => ({ kind: 'file', path: file, owned: false, header: null });
  const earlier = (blocks.retired?.[install.scope] ?? [])
    .map((file): Retired<FilePlace> => ({ place: memberFile(roots.declared(install.scope === 'user' ? 'home' : 'project', file)), was: 'default' }));
  // OpenClaw's default workspace stays read by its default profile (#946).
  const claudemd = tool === 'openclaw' ? null : roots.configured('claudemd');
  // An earlier release wrote the blocks into any claudemd the team mapped.
  const configured: Retired<FilePlace> | null = claudemd === null ? null : { place: memberFile(claudemd), was: 'configured' };
  if (channel === 'none' || channel === 'unknown') return { channel, retired: settled(null, [...earlier, configured], p), gates: await gatesOf(tool, install, host, roots) };
  if (channel.channel !== 'file') return runTimeOf(channel, settled(null, [...earlier, configured], p), await gatesOf(tool, await userViewOf(install, host), host));

  const [file, other] = install.gitExclude && channel.gitExcluded !== undefined
    ? [channel.gitExcluded, channel.file] : [channel.file, channel.gitExcluded];
  let { place: own, gates } = await blocksFileOf(file, roots, host);
  // Pi reads the first context file in a directory; its override shadows AGENTS.md.
  if (tool === 'pi' && install.scope === 'user' && own !== null) {
    const override = p.join(p.dirname(own.path), 'AGENTS.override.md');
    if (await host.exists(override)) own = { ...own, path: override };
  }
  const otherPlace = other === undefined ? null : (await blocksFileOf(other, roots, host)).place;
  return {
    channel: 'files',
    own,
    activation: await activationOf(channel.activation, tool, install, host, roots),
    reads: await readsOf(channel.reads, roots, host),
    readGates: [],
    retired: settled(own, [...earlier, otherPlace === null ? null : { place: otherPlace, was: 'git-exclude' }, configured], p),
    gates: [...await gatesOf(tool, install, host, roots), ...gates],
  };
}

async function blocksFileOf(file: BlocksFile, roots: Roots, host: Host): Promise<{ readonly place: FilePlace | null; readonly gates: readonly Gate[] }> {
  const placed = (where: string | null): FilePlace | null =>
    where === null ? null : { kind: 'file', path: where, owned: file.owned === true, header: file.header ?? null };
  switch (file.in) {
    case 'claudemd':
      return { place: placed(roots.configured('claudemd')), gates: [] };
    case 'rules-dir': {
      const dir = roots.configured('rules');
      if (dir !== null) return { place: placed(file.dir === undefined ? host.path.join(dir, file.name) : roots.join(roots.base, `${file.dir}/${file.name}`)), gates: [] };
      const claudemd = roots.configured('claudemd');
      return { place: claudemd === null ? null : { kind: 'file', path: claudemd, owned: false, header: null }, gates: [] };
    }
    case 'home':
      return { place: placed(roots.declared('home', file.path)), gates: [] };
    case 'project':
      return { place: placed(roots.declared('project', file.path)), gates: [] };
    case 'openclaw-workspace': {
      const workspace = await openclawWorkspaceOf(roots, host);
      switch (workspace.kind) {
        case 'found':
          return {
            place: placed(host.path.join(workspace.dir, file.name)),
            gates: [{ kind: 'readable-config', file: resolveOpenclawConfigPath(host, openclawStateDir(roots, host)), met: true }],
          };
        case 'unreadable-config':
          return { place: null, gates: [{ kind: 'readable-config', file: workspace.file, met: false }] };
        case 'none':
          return { place: null, gates: [{ kind: 'readable-config', file: resolveOpenclawConfigPath(host, openclawStateDir(roots, host)), met: true }] };
        default: {
          const unhandled: never = workspace;
          return unhandled;
        }
      }
    }
    default: {
      const unhandled: never = file;
      return unhandled;
    }
  }
}

/** OpenCode project rules only. `mcpFileOf` returns the tree file, not the V2 alternate. */
async function retiredRulesActivation(tool: string, install: Install, host: Host, roots: Roots): Promise<EntryPlace | null | undefined> {
  if (tool !== 'opencode' || install.scope !== 'project') return undefined;
  const channel = channelsOf(tool).mcp[install.scope];
  if (channel === 'none' || channel === 'unknown') return null;
  const { file } = await mcpFileOf(channel, install.scope, roots, host);
  return file === null ? null : { kind: 'entry', path: file, key: ['instructions'] };
}

async function activationOf(activation: Activation | undefined, tool: string, install: Install, host: Host, roots: Roots): Promise<EntryPlace | null> {
  if (activation === undefined) return null;
  switch (activation.in) {
    case 'mcp-file': {
      const channel = channelsOf(tool).mcp[install.scope];
      if (channel === 'none' || channel === 'unknown') return null;
      const { file } = await mcpFileOf(channel, install.scope, roots, host);
      return file === null ? null : { kind: 'entry', path: file, key: [activation.key] };
    }
    case 'project':
      return { kind: 'entry', path: roots.declared('project', activation.path), key: [activation.key] };
    default: {
      const unhandled: never = activation;
      return unhandled;
    }
  }
}

async function locateAgents(tool: string, install: Install, host: Host): Promise<Location<'agents'>> {
  const channel = channelsOf(tool).agents[install.scope];
  const roots = rootsOf(tool, install, host);
  const gates = await gatesOf(tool, install, host, roots);
  const dir = roots.configured('agents');
  const own: DirPlace | null = dir === null ? null : { kind: 'dir', path: dir };
  // An earlier release copied team agents verbatim into any configured agents directory.
  if (channel === 'none' || channel === 'unknown') return { channel, retired: own === null ? [] : [{ place: own, was: 'configured' }], gates };
  return {
    channel: 'files',
    own,
    reads: await readsOf(channel.reads, roots, host),
    readGates: await readGatesOf(channel.readGates, install, host),
    retired: [],
    gates,
  };
}

function mcpKeyOf(channel: Pick<McpUser, 'format' | 'key'>): readonly [string, ...string[]] {
  if (channel.key !== undefined) return channel.key;
  return channel.format === 'codex' ? ['mcp_servers'] : [MCP_SERVER_KEY[channel.format]];
}

async function mcpFileOf(
  channel: McpUser | McpProject, scope: Scope, roots: Roots, host: Host,
): Promise<{ readonly file: string | null; readonly lookup: McpLookup | null }> {
  const configured = roots.configured(scope === 'user' ? 'mcp' : 'mcpProject');
  if (configured === null || channel.reads === 'unknown') return { file: configured, lookup: null };
  for (const read of channel.reads) {
    if (!('firstOf' in read)) continue;
    const { files, first } = await lookupOf(read, roots, host);
    if (files.some((file) => samePathOn(host.path, file, configured))) return { file: first, lookup: { files, mapped: configured } };
  }
  return { file: configured, lookup: null };
}

/**
 * Where a project's servers go instead of the project's file (#915), and
 * whether they go there now: while sharing.gitExclude is on or the workspace
 * has children. A tool keyed by the git common root files every worktree
 * under one key, so not in a single-repo (self) team, where each worktree's
 * branch has its own servers; and not while a selected, installed tool reads
 * the project's file (`writtenBy`).
 */
async function localScopeOf(
  tool: string,
  install: Extract<Install, { scope: 'project' }>,
  host: Host,
  roots: Roots,
  scope: NonNullable<McpProject['localScope']>,
  tree: EntryPlace,
): Promise<{ readonly place: EntryPlace; readonly inUse: boolean } | null> {
  const file = scope.file === 'user-mcp-file'
    ? rootsOf(tool, await userViewOf(install, host), host).configured('mcp')
    : host.path.join(roots.codebuddyConfigDir, scope.file.path);
  if (file === null) return null;
  const projectKey = scope.key === 'git-common-root' ? await claudeProjectKey(install.projectRoot, host) : await host.realpath(install.projectRoot);
  const place: EntryPlace = { kind: 'entry', path: file, key: tree.key, projectKey };
  if (!(install.gitExclude || install.workspaceChildren) || (scope.key === 'git-common-root' && install.repo === 'self')) return { place, inUse: false };
  return { place, inUse: !await readByAnotherTool(tool, install, host, tree) };
}

async function readByAnotherTool(writer: string, install: Install, host: Host, tree: EntryPlace): Promise<boolean> {
  for (const reader of Object.keys(TOOLS)) {
    const channel = channelsOf(reader).mcp.project;
    if (typeof channel !== 'object' || channel.writtenBy !== writer || install.toolPaths[reader] === undefined) continue;
    const roots = rootsOf(reader, install, host);
    const reads = await readsOf(channel.reads, roots, host);
    if (reads === 'unknown' || !reads.some((read) => samePathOn(host.path, read.path, tree.path))) continue;
    if ((await gatesOf(reader, install, host, roots)).every((gate) => gate.met)) return true;
  }
  return false;
}

/**
 * The key Claude Code files a checkout under (#915): the checkout's real
 * path, or for a linked worktree its common git dir without the trailing
 * `.git`, NFC as Claude Code normalizes it.
 */
async function claudeProjectKey(checkout: string, host: Host): Promise<string> {
  const p = host.path;
  const root = await host.realpath(checkout);
  const dotGit = (await host.readText(p.join(root, '.git')))?.trim();
  if (dotGit === undefined || !dotGit.startsWith('gitdir:')) return root.normalize('NFC');
  const gitDir = p.resolve(root, dotGit.slice('gitdir:'.length).trim());
  const commondir = await host.readText(p.join(gitDir, 'commondir'));
  const common = commondir === null ? null : p.resolve(gitDir, commondir.trim());
  // A `.git` file of a checkout that is not a linked worktree has no `commondir`.
  if (common === null || !await host.exists(common)) return root.normalize('NFC');
  const real = await host.realpath(common);
  return (p.basename(real) === '.git' ? p.dirname(real) : real).normalize('NFC');
}

async function locateMcp(tool: string, install: Install, host: Host): Promise<Location<'mcp'>> {
  const { mcp } = channelsOf(tool);
  const roots = rootsOf(tool, install, host);
  const p = host.path;
  const gates = await gatesOf(tool, install, host, roots);
  if (install.scope === 'user') {
    const channel = mcp.user;
    if (channel === 'none' || channel === 'unknown') return { channel, retired: [], gates };
    const { tree, lookup, earlier, reads } = await mcpFilesOf(channel, mcp.retired?.user, 'user', roots, host);
    return {
      channel: 'files', own: tree, alternate: null, writtenBy: null, lookup, reads, readGates: [], retired: settled(tree, earlier, p),
      gates: await mcpGatesOf(tool, gates, tree, host),
    };
  }

  const channel = mcp.project;
  if (channel === 'none' || channel === 'unknown') return { channel, retired: [], gates };
  const readGates = await readGatesOf(channel.readGates, install, host);
  if (channel.writtenBy !== undefined) {
    const own = ownOf(await locateMcp(channel.writtenBy, install, host));
    const reads = await readsOf(channel.reads, roots, host, own?.key ?? mcpKeyOf(channel));
    return { channel: 'files', own, alternate: null, writtenBy: channel.writtenBy, lookup: null, reads, readGates, retired: [], gates };
  }

  const { key, tree, lookup, earlier, reads } = await mcpFilesOf(channel, mcp.retired?.project, 'project', roots, host);
  let own = tree;
  const retired = [...earlier];
  const localReads: Read[] = [];
  if (tree !== null && channel.localScope !== undefined) {
    const local = await localScopeOf(tool, install, host, roots, channel.localScope, tree);
    if (local !== null) {
      own = local.inUse ? local.place : tree;
      retired.push({ place: local.inUse ? tree : local.place, was: 'other-scope' });
      localReads.push({
        path: local.place.path, key, projectKey: local.place.projectKey,
        when: channel.localScope.key === 'realpath' ? 'cwdOnly' : 'workspaceUnder', root: install.projectRoot,
      });
    }
  }
  const builtin: Readonly<Record<string, ToolPaths>> = DEFAULT_TOOL_PATHS;
  const builtinFile = mcp.retired?.project?.[0] ?? (Object.hasOwn(builtin, tool) ? builtin[tool].mcpProject : undefined);
  if (builtinFile !== undefined && builtinFile !== install.toolPaths[tool]?.mcpProject) {
    retired.push({ place: { kind: 'entry', path: roots.declared('project', builtinFile), key }, was: 'builtin' });
  }
  return {
    channel: 'files',
    own,
    alternate: channel.alternate === undefined ? null : { kind: 'entry', path: roots.declared('project', channel.alternate.path), key },
    writtenBy: null,
    lookup,
    reads: reads === 'unknown' ? reads : [...reads, ...localReads],
    readGates,
    retired: settled(own, retired, p),
    gates: await mcpGatesOf(tool, gates, own, host),
  };
}

/** Copilot is installed, for its servers, also where its MCP file exists (#628). */
async function mcpGatesOf(tool: string, gates: readonly Gate[], own: EntryPlace | null, host: Host): Promise<readonly Gate[]> {
  if (tool !== 'copilot' || own === null || !await host.exists(own.path)) return gates;
  return gates.map((gate) => gate.kind === 'installed' ? { ...gate, met: true } : gate);
}

async function mcpFilesOf(
  channel: McpUser | McpProject, earlierFiles: readonly string[] | undefined, scope: Scope, roots: Roots, host: Host,
): Promise<{
  readonly key: readonly [string, ...string[]];
  readonly tree: EntryPlace | null;
  readonly lookup: McpLookup | null;
  readonly earlier: readonly Retired<EntryPlace>[];
  readonly reads: readonly Read[] | 'unknown';
}> {
  const key = mcpKeyOf(channel);
  const entry = (file: string): EntryPlace => ({ kind: 'entry', path: file, key });
  // An earlier release wrote the format's own key: ZCode's servers sat under `mcpServers` in ~/.agents/mcp.json.
  const earlierKey = mcpKeyOf({ format: channel.format });
  const { file, lookup } = await mcpFileOf(channel, scope, roots, host);
  return {
    key,
    tree: file === null ? null : entry(file),
    lookup,
    earlier: [
      ...(earlierFiles ?? []).map((earlierFile): Retired<EntryPlace> => ({
        place: { kind: 'entry', path: roots.declared(scope === 'user' ? 'home' : 'project', earlierFile), key: earlierKey }, was: 'default',
      })),
      ...(lookup?.files ?? []).filter((other) => other !== file).map((other): Retired<EntryPlace> => ({ place: entry(other), was: 'lookup' })),
    ],
    reads: await readsOf(channel.reads, roots, host, key),
  };
}

/** The map each hook format keeps its hook list under. */
const HOOK_LIST_KEY = ['hooks'] as const;

/**
 * The hook file a hook pass at `baseDir` (`resolveHookScope`) edits for
 * `tool`: `relative` under `baseDir` for a project's own hooks, else in the
 * tool's user scope, in its home where `relative` falls under the home's root,
 * which a recorded or env move relocates. A tool that takes its user hooks in
 * self mode too (ZCode's CLI) gets them there whatever `baseDir` says.
 */
export function hookSettingsFile(tool: string, baseDir: string, relative: string, host: Host = realHost()): string {
  const p = host.path;
  if (channelsOf(tool).hooks.self !== 'user' && !samePathOn(p, baseDir, host.home)) return p.join(baseDir, ...relative.split('/'));
  return underToolHome(tool, relative, host);
}

/** The directory `adapter` writes teamai's hook file into: in its tool's home, which a recorded or env move relocates, on `host`. */
export function hookAdapterDir(adapter: Exclude<HookAdapterId, 'openclaw-hook'>, host: Host = realHost()): string {
  return adapterDirIn(adapter, (tool) => toolHome(tool, host), host);
}

/** The directory `adapter` writes teamai's hook file into when its tool's home is `home`: one of the homes uninstall cleans. */
export function hookAdapterDirIn(adapter: Exclude<HookAdapterId, 'openclaw-hook' | 'dsh-hooks'>, home: string, host: Host = realHost()): string {
  return adapterDirIn(adapter, () => home, host);
}

/**
 * Where earlier releases wrote `adapter`'s hook file, under its tool's default home, when the home
 * has moved since; else null. A default home linked to the moved one is the same directory.
 */
export async function earlierHookAdapterDir(adapter: Exclude<HookAdapterId, 'openclaw-hook'>, host: Host = realHost()): Promise<string | null> {
  const dir = adapterDirIn(adapter, (tool) => defaultToolHome(tool, host), host);
  const current = hookAdapterDir(adapter, host);
  if (samePathOn(host.path, dir, current)) return null;
  return samePathOn(host.path, await host.realpath(dir), await host.realpath(current)) ? null : dir;
}

function adapterDirIn(adapter: Exclude<HookAdapterId, 'openclaw-hook'>, homeOf: (tool: ToolId) => string, host: Host): string {
  const p = host.path;
  switch (adapter) {
    case 'opencode-plugin':
      return p.join(homeOf('opencode'), 'plugin');
    case 'pi-extension':
      return p.join(homeOf('pi'), 'extensions');
    case 'omp-extension':
      return p.join(homeOf('omp'), 'extensions');
    case 'hermes-plugin':
      return p.join(homeOf('hermes'), 'hooks');
    case 'kiro-hooks':
      return p.join(homeOf('kiro'), 'hooks');
    // The bridge config lives with teamai; dsh loads it through the row teamai keeps in `$DSH_HOME/cordis.patch.yml`.
    case 'dsh-hooks':
      return p.join(host.home, '.teamai', 'dsh');
    default: {
      const unhandled: never = adapter;
      return unhandled;
    }
  }
}

async function locateHooks(tool: string, install: Install, host: Host): Promise<Location<'hooks'>> {
  const { hooks } = channelsOf(tool);
  if (install.scope === 'project' && install.repo === 'self' && hooks.self !== 'user') return settingsHooksOf(tool, hooks.self, install, host);
  const user = await userViewOf(install, host);
  const channel = hooks.user;
  if (channel === 'none' || channel === 'unknown') return settingsHooksOf(tool, channel, user, host);
  if (channel.channel === 'adapter') return adapterHooksOf(tool, channel, user, host);
  const located = await settingsHooksOf(tool, channel, user, host);
  if (install.scope !== 'project' || hooks.workspace === undefined || located.channel !== 'files') return located;
  const roots = rootsOf(tool, install, host);
  const file = roots.configured(roots.paths?.hooks === undefined ? 'settings' : 'hooks');
  if (file === null) return located;
  const reads = await readsOf(hooks.workspace.reads, roots, host, HOOK_LIST_KEY);
  return {
    ...located,
    workspace: { kind: 'entry', path: file, key: HOOK_LIST_KEY },
    reads: located.reads === 'unknown' || reads === 'unknown' ? located.reads : [...located.reads, ...reads],
  };
}

/** Whether `tool`'s home moved, while every release before #1221 wrote its hooks under the default one (`Home.moves.defaultHomeLeftovers`). */
function leftDefaultHome(tool: string, host: Host): boolean {
  return isToolId(tool) && hasDefaultHomeLeftovers(tool) && movedToolHome(tool, host) !== null;
}

async function settingsHooksOf(
  tool: string,
  channel: HookSettings<HomeRead | ProjectRead> | 'none' | 'unknown',
  install: Install,
  host: Host,
): Promise<Location<'hooks'>> {
  const roots = rootsOf(tool, install, host);
  const gates = await gatesOf(tool, install, host, roots);
  if (channel === 'none' || channel === 'unknown') return { channel, retired: [], gates };
  const field = roots.paths?.hooks === undefined ? 'settings' : 'hooks';
  const file = roots.configured(field);
  const own: EntryPlace | null = file === null ? null : { kind: 'entry', path: file, key: HOOK_LIST_KEY };
  const relative = roots.paths?.[field];
  const unmoved: Retired<EntryPlace> | null = install.scope === 'user' && relative !== undefined && leftDefaultHome(tool, host)
    ? { place: { kind: 'entry', path: roots.join(host.home, relative), key: HOOK_LIST_KEY }, was: 'default' }
    : null;
  return {
    channel: 'files',
    own,
    format: channel.format,
    workspace: null,
    reads: await readsOf(channel.reads, roots, host, HOOK_LIST_KEY),
    readGates: [],
    retired: settled(own, [unmoved], host.path),
    gates,
  };
}

async function adapterHooksOf(tool: string, channel: HookAdapter, install: Install, host: Host): Promise<Location<'hooks'>> {
  const roots = rootsOf(tool, install, host);
  const gates = await gatesOf(tool, install, host, roots);
  const { adapter } = channel;
  let dir: string | null;
  if (adapter === 'openclaw-hook') {
    const found = openclawWritesTo(await openclawWorkspaceOf(roots, host));
    dir = found === null ? null : host.path.join(found, 'hooks');
  } else {
    dir = adapterDirIn(adapter, (id) => toolHome(id, host), host);
  }
  const own: DirPlace | null = dir === null ? null : { kind: 'dir', path: dir };
  const unmoved: Retired<DirPlace> | null = adapter !== 'openclaw-hook' && leftDefaultHome(tool, host)
    ? { place: { kind: 'dir', path: adapterDirIn(adapter, (id) => defaultToolHome(id, host), host) }, was: 'default' }
    : null;
  return {
    channel: 'files',
    own,
    adapter,
    reads: own === null ? [] : [{ path: own.path, when: 'always' }],
    readGates: [],
    retired: settled(own, [unmoved], host.path),
    gates,
  };
}

/**
 * Where `platform`'s sessions sit on `host`. A `tool-home` store follows the member's recorded
 * root first, then its tool's home, as that tool's other files do. A recorded root is checked
 * against `host.home`, the home `teamai init` accepted it under. A default store sits under
 * `host.profileHome`, where the tools write it.
 */
export function sessionStoreDir(
  platform: StoredSessionPlatform,
  toolRoots: Readonly<Record<string, string>> | undefined,
  host: Host = realHost(),
): string {
  const { store } = SESSION_PLATFORM_FACTS[platform];
  const p = host.path;
  switch (store.in) {
    case 'tool-home': {
      const dir = recordedToolRootDir('root' in store ? store.root : store.home, toolRoots, host)
        ?? toolHome(store.home, { ...host, home: host.profileHome });
      return p.join(dir, store.dir);
    }
    case 'xdg-data':
      return p.join(host.env.XDG_DATA_HOME || p.join(host.profileHome, '.local', 'share'), store.child);
    default: {
      const unhandled: never = store;
      return unhandled;
    }
  }
}

async function locateSessions(tool: string, install: Install, host: Host): Promise<Location<'sessions'>> {
  if (!isToolId(tool)) return { channel: 'unknown', retired: [], gates: [] };
  const { sessions } = TOOLS[tool];
  if (typeof sessions === 'string') return { channel: sessions, retired: [], gates: [] };
  const [platform] = sessions;
  const { toolRoots } = install.scope === 'user' ? install : await userViewOf(install, host);
  const own: DirPlace = { kind: 'dir', path: sessionStoreDir(platform, toolRoots, host) };
  return { channel: 'files', own, platform, reads: [{ path: own.path, when: 'always' }], readGates: [], retired: [], gates: [] };
}
