/**
 * One cell per tool × scope × platform × env × session cwd. The expected writes
 * and reads are a hand-written table taken from each tool's source, docs or a
 * recorded run, never from a run of `locate`. Each row is written once in
 * platform-neutral spots and expanded per platform by `at()`, a fixed string
 * join with that platform's `path`, so a wrong table and a wrong `locate` both
 * fail, and a write the tool does not read cannot pass without its issue.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { installOf, locate, unreadWrites, writesOf } from '../locate.js';
import type { Host } from '../tool-home.js';
import { DEFAULT_TOOL_PATHS } from '../types.js';

type Platform = 'darwin' | 'linux' | 'win32';
/** The session's directory: a project root in $HOME, a subdirectory of it, or a root outside $HOME (#1197). */
type Cwd = 'project-root' | 'project-subdir' | 'root-outside-home';

type UnderHome = `~/${string}`;
type UnderProjectRoot = `<root>/${string}`;
type UnderSessionDir = `<cwd>/${string}`;
type UnderEnvValue = `$${string}`;
type OutsideHome = `/${string}`;
type Spot = UnderHome | UnderProjectRoot | UnderSessionDir | UnderEnvValue | OutsideHome;
type When = 'always' | 'workspaceUnder' | 'cwdOnly';

type Row = {
  readonly tool: string;
  readonly scope: 'user' | 'project';
  readonly env?: Readonly<Record<string, Spot>>;
  readonly envLiterals?: Readonly<Record<string, string>>;
  readonly json?: readonly { readonly at: Spot; readonly value: Record<string, unknown> }[];
  readonly existingDirs: readonly Spot[];
  readonly toolHomes?: Readonly<Record<string, Spot>>;
  readonly toolRoots?: Readonly<Record<string, Spot>>;
  readonly platforms?: readonly Platform[];
  readonly writes: readonly Spot[];
  readonly installed: { readonly probe: Spot; readonly met: boolean };
  readonly reads: readonly { readonly at: Spot; readonly when: When }[] | 'unknown';
  /** Cells whose write the tool does not read from some cwd, with the issue that tracks it. */
  readonly broken?: Partial<Record<Cwd, { readonly reason: 'not-read' | 'cwd-only' | 'outside-workspace'; readonly issue: `#${number}` }>>;
  readonly source: string;
};

const OPENCODE_SOURCE = 'opencode v2.1.1 bundle, Global.Path: config = OPENCODE_CONFIG_DIR ?? (XDG_CONFIG_HOME || ~/.config)/opencode';
const MUSE_SOURCE = 'muse-bin 1.4.11 strings: $XDG_CONFIG_HOME/muse, else $HOME/.config/muse; with XDG_CONFIG_HOME set, $HOME/.config/muse is never read';
const HERMES_SOURCE = 'hermes-agent hermes_constants.py:51-58: HERMES_HOME, else %LOCALAPPDATA%\\hermes on Windows, else ~/.hermes';
const OPENCLAW_SOURCE = 'OpenClaw agents/agent-scope-config.ts and agents/workspace-default-path.ts, as src/openclaw-home.ts records them: state dir OPENCLAW_STATE_DIR, else ~/.openclaw-<profile>, else ~/.openclaw; workspace agents.defaults.workspace in OPENCLAW_CONFIG_PATH or <state>/openclaw.json, resolved against the cwd, else OPENCLAW_WORKSPACE_DIR, else <state>/workspace';

const ROWS: readonly Row[] = [
  {
    tool: 'opencode', scope: 'user',
    writes: ['~/.config/opencode/skills'],
    existingDirs: ['~/.config/opencode'], installed: { probe: '~/.config/opencode', met: true },
    reads: [{ at: '~/.config/opencode/skills', when: 'always' }, { at: '~/.claude/skills', when: 'always' }],
    source: OPENCODE_SOURCE,
  },
  {
    tool: 'opencode', scope: 'user', env: { XDG_CONFIG_HOME: '/xdg' },
    writes: ['/xdg/opencode/skills'],
    existingDirs: ['/xdg/opencode'], installed: { probe: '/xdg/opencode', met: true },
    reads: [{ at: '/xdg/opencode/skills', when: 'always' }, { at: '~/.claude/skills', when: 'always' }],
    source: `${OPENCODE_SOURCE}; issue #1221 Conditions: XDG_CONFIG_HOME set`,
  },
  {
    tool: 'opencode', scope: 'user', env: { XDG_CONFIG_HOME: '/xdg' },
    writes: ['/xdg/opencode/skills'],
    existingDirs: ['~/.config/opencode'], installed: { probe: '/xdg/opencode', met: false },
    reads: [{ at: '/xdg/opencode/skills', when: 'always' }, { at: '~/.claude/skills', when: 'always' }],
    source: `${OPENCODE_SOURCE}: the default directory says nothing about the moved home`,
  },
  {
    tool: 'opencode', scope: 'user', env: { XDG_CONFIG_HOME: '/xdg', OPENCODE_CONFIG_DIR: '/ocd' },
    writes: ['/ocd/skills'],
    existingDirs: ['/ocd'], installed: { probe: '/ocd', met: true },
    reads: [{ at: '/ocd/skills', when: 'always' }, { at: '~/.claude/skills', when: 'always' }],
    source: OPENCODE_SOURCE,
  },
  {
    tool: 'opencode', scope: 'user', toolHomes: { opencode: '/recorded/opencode' },
    writes: ['/recorded/opencode/skills'],
    existingDirs: ['/recorded/opencode'], installed: { probe: '/recorded/opencode', met: true },
    reads: [{ at: '/recorded/opencode/skills', when: 'always' }, { at: '~/.claude/skills', when: 'always' }],
    source: 'a home init or a pull recorded wins over a shell without XDG_CONFIG_HOME (src/types.ts detectToolRoot contract)',
  },
  {
    tool: 'opencode', scope: 'user', env: { XDG_CONFIG_HOME: '/xdg' }, toolHomes: { opencode: '/recorded/opencode' },
    writes: ['/recorded/opencode/skills'],
    existingDirs: ['/recorded/opencode'], installed: { probe: '/recorded/opencode', met: true },
    reads: [{ at: '/recorded/opencode/skills', when: 'always' }, { at: '~/.claude/skills', when: 'always' }],
    source: 'a recorded home wins over the shell env; doctor reports the mismatch',
  },
  {
    tool: 'opencode', scope: 'project',
    writes: ['<root>/.opencode/skills'],
    existingDirs: ['<root>/.opencode'], installed: { probe: '<root>/.opencode', met: true },
    reads: [{ at: '<root>/.opencode/skills', when: 'workspaceUnder' }, { at: '<root>/.claude/skills', when: 'workspaceUnder' }],
    source: OPENCODE_SOURCE,
  },
  {
    tool: 'muse', scope: 'user',
    writes: ['~/.config/muse/skills'],
    existingDirs: ['~/.config/muse'], installed: { probe: '~/.config/muse', met: true },
    reads: [{ at: '~/.config/muse/skills', when: 'always' }, { at: '~/.agents/skills', when: 'always' }, { at: '~/.claude/skills', when: 'always' }],
    source: MUSE_SOURCE,
  },
  {
    tool: 'muse', scope: 'user', env: { XDG_CONFIG_HOME: '/xdg' },
    writes: ['/xdg/muse/skills'],
    existingDirs: ['/xdg/muse'], installed: { probe: '/xdg/muse', met: true },
    reads: [{ at: '/xdg/muse/skills', when: 'always' }, { at: '~/.agents/skills', when: 'always' }, { at: '~/.claude/skills', when: 'always' }],
    source: `${MUSE_SOURCE}; launcher ~/.local/bin/muse:20-24`,
  },
  {
    tool: 'muse', scope: 'project', env: { XDG_CONFIG_HOME: '/xdg' },
    writes: ['<root>/.agents/skills'],
    existingDirs: ['/xdg/muse'], installed: { probe: '/xdg/muse', met: true },
    reads: [{ at: '<root>/.agents/skills', when: 'workspaceUnder' }],
    source: MUSE_SOURCE,
  },
  {
    tool: 'hermes', scope: 'user', platforms: ['darwin', 'linux'],
    writes: ['~/.hermes/skills'],
    existingDirs: ['~/.hermes'], installed: { probe: '~/.hermes', met: true },
    reads: [{ at: '~/.hermes/skills', when: 'always' }],
    source: HERMES_SOURCE,
  },
  {
    tool: 'hermes', scope: 'user', platforms: ['win32'],
    writes: ['$LOCALAPPDATA/hermes/skills'],
    existingDirs: ['$LOCALAPPDATA/hermes'], installed: { probe: '$LOCALAPPDATA/hermes', met: true },
    reads: [{ at: '$LOCALAPPDATA/hermes/skills', when: 'always' }],
    source: HERMES_SOURCE,
  },
  {
    tool: 'hermes', scope: 'user', env: { HERMES_HOME: '/hermes' },
    writes: ['/hermes/skills'],
    existingDirs: ['/hermes'], installed: { probe: '/hermes', met: true },
    reads: [{ at: '/hermes/skills', when: 'always' }],
    source: HERMES_SOURCE,
  },
  {
    tool: 'hermes', scope: 'project', env: { HERMES_HOME: '/hermes' },
    writes: ['/hermes/skills'],
    existingDirs: ['/hermes'], installed: { probe: '/hermes', met: true },
    reads: [{ at: '/hermes/skills', when: 'always' }],
    source: `${HERMES_SOURCE}; teamai writes Hermes skills to its home in either scope`,
  },
  {
    tool: 'hermes', scope: 'user', platforms: ['win32'], toolHomes: { hermes: '/recorded/hermes' },
    writes: ['/recorded/hermes/skills'],
    existingDirs: ['/recorded/hermes'], installed: { probe: '/recorded/hermes', met: true },
    reads: [{ at: '/recorded/hermes/skills', when: 'always' }],
    source: 'a recorded home wins over the Windows default',
  },
  {
    tool: 'pi', scope: 'user',
    writes: ['~/.pi/agent/skills'],
    existingDirs: ['~/.pi'], installed: { probe: '~/.pi', met: true },
    reads: [{ at: '~/.pi/agent/skills', when: 'always' }],
    source: 'issue #1221 matrix, Pi user skills (v, Pi 0.99.2)',
  },
  {
    tool: 'pi', scope: 'user', env: { PI_CODING_AGENT_DIR: '/pi-agent' },
    writes: ['/pi-agent/skills'],
    existingDirs: ['/pi-agent'], installed: { probe: '/pi-agent', met: true },
    reads: [{ at: '/pi-agent/skills', when: 'always' }],
    source: 'issue #1221 matrix, PI_CODING_AGENT_DIR row (v); src/models/switch.ts reads it the same way',
  },
  {
    tool: 'pi', scope: 'user', env: { PI_CODING_AGENT_DIR: '/pi-agent' },
    writes: ['/pi-agent/skills'],
    existingDirs: ['~/.pi'], installed: { probe: '/pi-agent', met: false },
    reads: [{ at: '/pi-agent/skills', when: 'always' }],
    source: 'issue #1221 matrix, PI_CODING_AGENT_DIR row (v): Pi reads the moved directory, so ~/.pi says nothing about it',
  },
  {
    tool: 'pi', scope: 'project',
    writes: ['<root>/.pi/skills'],
    existingDirs: ['<root>/.pi'], installed: { probe: '<root>/.pi', met: true },
    reads: [{ at: '<root>/.pi/skills', when: 'cwdOnly' }],
    broken: { 'project-subdir': { reason: 'cwd-only', issue: '#1221' } },
    source: 'issue #1221 Conditions: session started in a project subdirectory, Pi skills (v, Pi 0.99.2)',
  },
  {
    tool: 'copilot', scope: 'user',
    writes: ['~/.copilot/skills'],
    existingDirs: ['~/.copilot'], installed: { probe: '~/.copilot', met: true },
    reads: [{ at: '~/.copilot/skills', when: 'always' }],
    source: 'issue #1221 scan: Copilot reads $COPILOT_HOME/skills (v)',
  },
  {
    tool: 'copilot', scope: 'user', env: { COPILOT_HOME: '/copilot' },
    writes: ['/copilot/skills'],
    existingDirs: ['/copilot'], installed: { probe: '/copilot', met: true },
    reads: [{ at: '/copilot/skills', when: 'always' }],
    source: 'issue #1221 scan: Copilot reads $COPILOT_HOME/skills (v)',
  },
  {
    tool: 'copilot', scope: 'project',
    writes: ['<root>/.github/skills'],
    existingDirs: ['~/.copilot'], installed: { probe: '~/.copilot', met: true },
    reads: [{ at: '<root>/.github/skills', when: 'workspaceUnder' }],
    source: 'issue #1221 matrix, Copilot project skills (v)',
  },
  {
    tool: 'dsh', scope: 'user', env: { DSH_HOME: '/dsh' },
    writes: ['/dsh/skills'],
    existingDirs: ['/dsh'], installed: { probe: '/dsh', met: true },
    reads: [{ at: '/dsh/skills', when: 'always' }],
    source: 'issue #1221 scan: dsh reads $DSH_HOME/skills; matrix "DSH_HOME (skills)"',
  },
  {
    tool: 'omp', scope: 'user',
    writes: ['~/.omp/agent/skills'],
    existingDirs: ['~/.omp'], installed: { probe: '~/.omp', met: true },
    reads: [{ at: '~/.omp/agent/skills', when: 'always' }],
    source: 'issue #1221 scan: OMP reads ~/.omp/agent/skills',
  },
  {
    tool: 'codebuddy', scope: 'user',
    writes: ['~/.codebuddy/skills'],
    existingDirs: ['~/.codebuddy'], installed: { probe: '~/.codebuddy', met: true },
    reads: [{ at: '~/.codebuddy/skills', when: 'always' }],
    source: 'issue #1221 scan: CodeBuddy reads ~/.codebuddy/skills',
  },
  {
    tool: 'codex', scope: 'user',
    writes: ['~/.codex/skills', '~/.agents/skills'],
    existingDirs: ['~/.codex'], installed: { probe: '~/.codex', met: true },
    reads: [{ at: '~/.codex/skills', when: 'always' }, { at: '~/.agents/skills', when: 'always' }],
    source: 'issue #1221 scan, Codex 0.163.0 real run: $CODEX_HOME/skills and ~/.agents/skills',
  },
  {
    tool: 'claude', scope: 'user', toolRoots: { claude: '~/.claude-work' },
    writes: ['~/.claude-work/skills'],
    existingDirs: ['~/.claude-work'], installed: { probe: '~/.claude-work', met: true },
    reads: [{ at: '~/.claude-work/skills', when: 'always' }],
    source: 'Claude Code docs: personal skills in $CLAUDE_CONFIG_DIR/skills; teamai init records the variable in toolRoots',
  },
  {
    tool: 'cursor', scope: 'user',
    writes: ['~/.cursor/skills'],
    existingDirs: ['~/.cursor'], installed: { probe: '~/.cursor', met: true },
    reads: 'unknown',
    source: 'no recorded run of Cursor user skills: unknown cells are never judged',
  },
  {
    tool: 'openclaw', scope: 'user',
    writes: ['~/.openclaw/workspace/skills'],
    existingDirs: ['~/.openclaw/workspace'], installed: { probe: '~/.openclaw/workspace', met: true },
    reads: 'unknown',
    source: OPENCLAW_SOURCE,
  },
  {
    tool: 'openclaw', scope: 'project',
    writes: ['~/.openclaw/workspace/skills'],
    existingDirs: ['~/.openclaw/workspace'], installed: { probe: '~/.openclaw/workspace', met: true },
    reads: 'unknown',
    source: `${OPENCLAW_SOURCE}; the workspace is the same in either scope`,
  },
  {
    tool: 'openclaw', scope: 'user',
    writes: [],
    existingDirs: ['~/.openclaw'], installed: { probe: '~/.openclaw/workspace', met: false },
    reads: 'unknown',
    source: `${OPENCLAW_SOURCE}; no workspace, nothing to write into`,
  },
  {
    tool: 'openclaw', scope: 'user', env: { OPENCLAW_STATE_DIR: '/oc-state' },
    writes: ['/oc-state/workspace/skills'],
    existingDirs: ['/oc-state/workspace'], installed: { probe: '/oc-state/workspace', met: true },
    reads: 'unknown',
    source: OPENCLAW_SOURCE,
  },
  {
    tool: 'openclaw', scope: 'user', envLiterals: { OPENCLAW_PROFILE: 'work' },
    writes: ['~/.openclaw-work/workspace/skills'],
    existingDirs: ['~/.openclaw-work/workspace'], installed: { probe: '~/.openclaw-work/workspace', met: true },
    reads: 'unknown',
    source: OPENCLAW_SOURCE,
  },
  {
    tool: 'openclaw', scope: 'user', envLiterals: { OPENCLAW_PROFILE: 'default' },
    writes: ['~/.openclaw/workspace/skills'],
    existingDirs: ['~/.openclaw/workspace'], installed: { probe: '~/.openclaw/workspace', met: true },
    reads: 'unknown',
    source: `${OPENCLAW_SOURCE}; the default profile is ~/.openclaw`,
  },
  {
    tool: 'openclaw', scope: 'user', env: { OPENCLAW_WORKSPACE_DIR: '/oc-ws' },
    writes: ['/oc-ws/skills'],
    existingDirs: ['/oc-ws'], installed: { probe: '/oc-ws', met: true },
    reads: 'unknown',
    source: OPENCLAW_SOURCE,
  },
  {
    tool: 'openclaw', scope: 'user', json: [{ at: '~/.openclaw/openclaw.json', value: { agents: { defaults: { workspace: 'ws' } } } }],
    writes: ['<cwd>/ws/skills'],
    existingDirs: ['<cwd>/ws'], installed: { probe: '<cwd>/ws', met: true },
    reads: 'unknown',
    source: `${OPENCLAW_SOURCE}; a relative workspace names another directory from each cwd`,
  },
  {
    tool: 'openclaw', scope: 'user', env: { OPENCLAW_CONFIG_PATH: '/oc-cfg/openclaw.json', OPENCLAW_WORKSPACE_DIR: '/oc-ws' },
    json: [{ at: '/oc-cfg/openclaw.json', value: { agents: { defaults: { workspace: '~/oc-cfg-ws' } } } }],
    writes: ['~/oc-cfg-ws/skills'],
    existingDirs: ['~/oc-cfg-ws', '/oc-ws'], installed: { probe: '~/oc-cfg-ws', met: true },
    reads: 'unknown',
    source: `${OPENCLAW_SOURCE}; openclaw.json wins over OPENCLAW_WORKSPACE_DIR`,
  },
  {
    tool: 'openclaw', scope: 'user', env: { OPENCLAW_STATE_DIR: '/oc-state' }, toolHomes: { openclaw: '/recorded/openclaw' },
    writes: ['/recorded/openclaw/workspace/skills'],
    existingDirs: ['/recorded/openclaw/workspace', '/oc-state/workspace'], installed: { probe: '/recorded/openclaw/workspace', met: true },
    reads: 'unknown',
    source: 'a recorded state dir wins over the shell env',
  },
];

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

function at(spot: Spot, platform: Platform, cwd: Cwd, env: Readonly<Record<string, string>>): string {
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

function envFor(row: Row, platform: Platform, cwd: Cwd): Record<string, string> {
  const env: Record<string, string> = platform === 'win32' ? { LOCALAPPDATA: 'C:\\Users\\m\\AppData\\Local' } : {};
  for (const [name, spot] of Object.entries(row.env ?? {})) env[name] = at(spot, platform, cwd, env);
  return { ...env, ...row.envLiterals };
}

function hostFor(row: Row, platform: Platform, cwd: Cwd, env: Readonly<Record<string, string>>): Host {
  const existing = new Set(row.existingDirs.map((spot) => at(spot, platform, cwd, env)));
  const files = new Map((row.json ?? []).map((file) => [at(file.at, platform, cwd, env), file.value]));
  return {
    platform,
    path: flavorOf(platform),
    home: HOMES[platform],
    env,
    toolHomes: { kind: 'ok', homes: expand(row.toolHomes, platform, cwd, env) },
    cwd: () => cwdOf(platform, cwd),
    exists: async (dir) => existing.has(dir),
    readJson: async (file) => {
      const value = files.get(file);
      return value === undefined ? { kind: 'missing' } : { kind: 'ok', value };
    },
  };
}

function expand(record: Readonly<Record<string, Spot>> | undefined, platform: Platform, cwd: Cwd, env: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(record ?? {}).map(([tool, spot]) => [tool, at(spot, platform, cwd, env)]));
}

describe('locate: skills matrix', () => {
  for (const row of ROWS) {
    for (const platform of row.platforms ?? (['darwin', 'linux', 'win32'] as const)) {
      for (const cwd of ['project-root', 'project-subdir', 'root-outside-home'] as const) {
        const conditions = [
          ...Object.keys(row.env ?? {}), ...Object.entries(row.envLiterals ?? {}).map(([name, value]) => `${name}=${value}`),
          ...(row.json ?? []).map((file) => file.at), ...Object.keys(row.toolHomes ?? {}).map((tool) => `recorded ${tool}`),
          ...(row.installed.met ? [] : ['not installed']),
        ];
        it(`${row.tool} ${row.scope} ${platform} ${conditions.join('+') || 'default env'} cwd=${cwd}`, async () => {
          const env = envFor(row, platform, cwd);
          const host = hostFor(row, platform, cwd, env);
          const install = installOf({ toolPaths: DEFAULT_TOOL_PATHS }, {
            scope: row.scope,
            projectRoot: row.scope === 'project' ? rootFor(platform, cwd) : undefined,
            toolRoots: expand(row.toolRoots, platform, cwd, env),
          });
          const where = await locate(row.tool, 'skills', install, host);
          expect(writesOf(where)).toEqual(row.writes.map((write) => at(write, platform, cwd, env)));
          expect(where.gates).toEqual([{ kind: 'selected', met: true }, { kind: 'installed', probe: at(row.installed.probe, platform, cwd, env), met: row.installed.met }]);
          expect(where.reads).toEqual(row.reads === 'unknown' ? 'unknown' : row.reads.map((read) => read.when === 'always'
            ? { path: at(read.at, platform, cwd, env), when: read.when }
            : { path: at(read.at, platform, cwd, env), when: read.when, root: rootFor(platform, cwd) }));
          const broken = row.broken?.[cwd];
          expect(unreadWrites(where, host).map((unread) => unread.reason)).toEqual(broken ? [broken.reason] : []);
        });
      }
    }
  }

  it('every row write is among its reads, or the row names its issue', () => {
    const unsupported = ROWS.filter((row) => row.reads !== 'unknown' && row.broken === undefined
      && !row.writes.every((write) => row.reads !== 'unknown' && row.reads.some((read) => read.at === write)));
    expect(unsupported.map((row) => `${row.tool} ${row.scope}`)).toEqual([]);
  });
});
