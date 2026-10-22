/**
 * Where teamai writes a tool's resource, where that tool reads it, and what
 * must hold for the write, on one machine. The answer depends on the tool, the
 * member's config (`Install`) and the machine (`Host`) and nothing else: no
 * `process.env`, home or filesystem read is reachable from `locate` except
 * through `host`, and paths are joined in the host's flavor, so a Linux test
 * can resolve a Windows member's paths.
 */
import path from 'node:path';
import { installGateOf, isToolId, TOOLS, type HomeSkillRead, type ProjectSkillRead } from './tools.js';
import {
  isAgentExcluded, resolveBaseDir, scopedToolPaths, toolGateRoot,
  type HomePaths, type LocalConfig, type TeamaiConfig,
} from './types.js';
import { homeRoot, realHost, toolHome, type Host } from './tool-home.js';
import { resolveOpenclawWorkspace } from './openclaw-home.js';

/**
 * What the member's config decides. `toolRoots` re-root user-scope paths only,
 * as they always have. A tool's home is the machine's (`Host`), not the config's.
 */
export type Install = {
  readonly toolPaths: TeamaiConfig['toolPaths'];
  readonly agents: Pick<LocalConfig, 'enabledAgents' | 'disabledAgents'>;
  readonly toolRoots: Readonly<Record<string, string>>;
} & ({ readonly scope: 'user' } | { readonly scope: 'project'; readonly projectRoot: string });

/** The one parse of the config shapes into an `Install`; a project config without its root throws `resolveBaseDir`'s error. */
export function installOf(
  team: Pick<TeamaiConfig, 'toolPaths'>,
  local: Pick<LocalConfig, 'scope' | 'projectRoot' | 'toolRoots' | 'enabledAgents' | 'disabledAgents'>,
): Install {
  const shared = {
    toolPaths: team.toolPaths,
    agents: { enabledAgents: local.enabledAgents, disabledAgents: local.disabledAgents },
    toolRoots: local.toolRoots ?? {},
  };
  switch (local.scope) {
    case 'user':
      return { ...shared, scope: 'user' };
    case 'project':
      return { ...shared, scope: 'project', projectRoot: resolveBaseDir(local) };
    default: {
      const unhandled: never = local.scope;
      return unhandled;
    }
  }
}

/** Resources `locate` answers for. */
export type Resource = 'skills';

/**
 * A directory the tool reads. `always`: from any session. `workspaceUnder`:
 * from a session at or under `root`. `cwdOnly`: from a session at `root` only.
 */
export type Read =
  | { readonly path: string; readonly when: 'always' }
  | { readonly path: string; readonly when: 'workspaceUnder' | 'cwdOnly'; readonly root: string };

/** A condition on teamai's write: pull skips a tool whose gates are not all met. */
export type Gate =
  | { readonly kind: 'selected'; readonly met: boolean }
  | { readonly kind: 'installed'; readonly probe: string; readonly met: boolean };

/**
 * The directories teamai writes into are present whether or not the gates are
 * met, so uninstall looks wherever teamai may have written.
 */
export type Location = {
  /** The tool's own directory; null when it has none (no configured path, no OpenClaw workspace). */
  readonly own: string | null;
  /** Codex's shared `.agents/skills`, chosen per skill by its writer; null for every other tool. */
  readonly shared: string | null;
  readonly reads: readonly Read[] | 'unknown';
  readonly gates: readonly Gate[];
};

/** `.agents/skills`: Codex reads it, and Muse writes it in a project. */
export const SHARED_AGENT_SKILLS_PATH = '.agents/skills';

/** Where `tool` takes `resource` on `host` under `install`. */
export async function locate(tool: string, resource: Resource, install: Install, host: Host = realHost()): Promise<Location> {
  switch (resource) {
    case 'skills':
      return locateSkills(tool, install, host);
    default: {
      const unhandled: never = resource;
      return unhandled;
    }
  }
}

/** The tool's own directory when it has one and every gate is met, else null: the one rule a writer applies. */
export function writableDir(location: Location): string | null {
  return location.own !== null && location.gates.every((gate) => gate.met) ? location.own : null;
}

/** Every directory teamai may write the tool's resource into: its own, then the shared one. */
export function writesOf(location: Location): string[] {
  return [location.own, location.shared].filter((dir): dir is string => dir !== null);
}

/** A write the tool does not read from a session at the host's cwd, and why. */
export type Unread =
  | { readonly write: string; readonly reason: 'not-read' }
  | { readonly write: string; readonly reason: 'cwd-only' | 'outside-workspace'; readonly readFrom: string };

/** The writes of `location` the tool would not read from a session in `host.cwd()`; none when its reads are unknown. */
export function unreadWrites(location: Location, host: Host = realHost()): readonly Unread[] {
  const { reads } = location;
  if (reads === 'unknown') return [];
  const p = host.path;
  const cwd = host.cwd();
  const unread: Unread[] = [];
  for (const write of writesOf(location)) {
    const read = reads.find((candidate) => isAtOrUnder(p, write, candidate.path) && isAtOrUnder(p, candidate.path, write));
    if (!read) {
      unread.push({ write, reason: 'not-read' });
      continue;
    }
    switch (read.when) {
      case 'always':
        break;
      case 'cwdOnly':
        if (!(isAtOrUnder(p, cwd, read.root) && isAtOrUnder(p, read.root, cwd))) unread.push({ write, reason: 'cwd-only', readFrom: read.root });
        break;
      case 'workspaceUnder':
        if (!isAtOrUnder(p, cwd, read.root)) unread.push({ write, reason: 'outside-workspace', readFrom: read.root });
        break;
      default: {
        const unhandled: never = read;
        return unhandled;
      }
    }
  }
  return unread;
}

function isAtOrUnder(p: path.PlatformPath, dir: string, root: string): boolean {
  const relative = p.relative(root, dir);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${p.sep}`) && !p.isAbsolute(relative));
}

async function locateSkills(tool: string, install: Install, host: Host): Promise<Location> {
  const p = host.path;
  const at: HomePaths = { home: host.home, path: p };
  const configured = install.scope === 'user'
    ? scopedToolPaths(install, { scope: 'user', toolRoots: install.toolRoots }, at)[tool]?.skills
    : install.toolPaths[tool]?.skills;
  if (configured === undefined) return { own: null, shared: null, reads: 'unknown', gates: [] };

  const known = isToolId(tool) ? tool : undefined;
  const base = install.scope === 'user' ? host.home : install.projectRoot;
  const join = (root: string, relative: string): string => p.join(root, ...relative.split('/'));
  const home = known === undefined ? undefined : { root: homeRoot(known), dir: toolHome(known, host), installedBy: installGateOf(known) };
  // A `$HOME`-relative path, re-rooted at the tool's home when it hangs off the home's root.
  const underHome = (relative: string): string => {
    if (home && (relative === home.root || relative.startsWith(`${home.root}/`))) return join(home.dir, relative.slice(home.root.length + 1));
    return join(host.home, relative);
  };
  const enabled = install.agents.enabledAgents?.includes(tool) === true;
  const probe = async (dir: string, met?: boolean): Promise<Gate> => ({ kind: 'installed', probe: dir, met: met ?? await host.exists(dir) });

  let own: string | null;
  let shared: string | null = null;
  let installed: Gate;
  if (tool === 'openclaw') {
    const workspace = await resolveOpenclawWorkspace(undefined, { host, stateDir: home?.dir ?? join(host.home, '.openclaw') });
    let dir: string | null;
    let tried: string;
    switch (workspace.kind) {
      case 'found':
        dir = workspace.dir;
        tried = workspace.dir;
        break;
      case 'unreadable-config':
        dir = workspace.fallback;
        tried = workspace.fallback ?? workspace.file;
        break;
      case 'none':
        dir = null;
        tried = workspace.candidate;
        break;
      default: {
        const unhandled: never = workspace;
        return unhandled;
      }
    }
    own = dir === null ? null : p.join(dir, 'skills');
    installed = await probe(tried, dir !== null);
  } else if (tool === 'hermes' && home) {
    own = p.join(home.dir, 'skills');
    installed = await probe(home.dir);
  } else if (tool === 'copilot' && home) {
    // User-scope Copilot paths are relative to its home, and its home says it is installed in either scope.
    own = join(install.scope === 'user' ? home.dir : base, configured);
    installed = await probe(home.dir, enabled || undefined);
  } else {
    own = install.scope === 'user' ? underHome(configured) : join(base, configured);
    if (tool === 'codex') shared = join(base, SHARED_AGENT_SKILLS_PATH);
    if (home?.installedBy !== undefined) {
      switch (home.installedBy) {
        case 'home-edition':
          installed = await probe(join(host.home, home.root), enabled || undefined);
          break;
        case 'home':
          installed = await probe(home.dir);
          break;
        case 'own-root':
          installed = await probe(join(base, home.root));
          break;
        default: {
          const unhandled: never = home.installedBy;
          return unhandled;
        }
      }
    } else {
      const gateRoot = toolGateRoot(tool, configured, install.toolRoots, at);
      const gateRootLeftByMovedHome = home !== undefined && home.root.startsWith(`${gateRoot}/`) && home.dir !== join(host.home, home.root);
      installed = await probe(install.scope !== 'user' ? join(base, gateRoot) : gateRootLeftByMovedHome ? home.dir : underHome(gateRoot));
    }
  }

  const declared: readonly (HomeSkillRead | ProjectSkillRead)[] | 'unknown' = known === undefined ? 'unknown' : TOOLS[known].skills[install.scope];
  const reads = declared === 'unknown' ? 'unknown' : declared.map((read): Read => {
    switch (read.base) {
      case 'home': {
        const relocated = install.scope === 'user'
          ? scopedToolPaths({ toolPaths: { [tool]: { skills: read.path } } }, { scope: 'user', toolRoots: install.toolRoots }, at)[tool]?.skills ?? read.path
          : read.path;
        return { path: underHome(relocated), when: 'always' };
      }
      case 'project':
        return { path: join(base, read.path), when: read.when, root: base };
      default: {
        const unhandled: never = read;
        return unhandled;
      }
    }
  });

  return { own, shared, reads, gates: [{ kind: 'selected', met: !isAgentExcluded(install.agents, tool) }, installed] };
}
