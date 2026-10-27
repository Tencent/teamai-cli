import type { McpFormat } from './resources/mcp-format.js';
import type { RuleFormatId } from './resources/rule-format.js';
import type { SessionPlatform, StoredSessionPlatform } from './session-flow/adapters/platform-facts.js';
import type { LaunchAdapterId } from './tool-launch/adapters.js';
import type { ToolId } from './types.js';

export type Evidence = 'verified' | 'source' | 'docs' | 'assumed';

/** The host's dedicated skill tool, by its raw name. */
export type SkillCall = { readonly name: string; readonly evidence: Evidence };

export type SkillLoad =
  | { readonly calls: readonly SkillCall[]; readonly promptForm?: '$name' | 'skill-block' }
  | 'unknown';

/** One way a machine moves a tool's home. */
export type HomeMove =
  | { readonly kind: 'env'; readonly name: string; readonly evidence: Evidence }
  /** `$XDG_CONFIG_HOME/<child>`. */
  | { readonly kind: 'xdg'; readonly child: string; readonly evidence: Evidence }
  /**
   * OpenClaw's state dir: `OPENCLAW_STATE_DIR`, else `.openclaw`, or
   * `.openclaw-<profile>` for an `OPENCLAW_PROFILE` other than `default`, in
   * `OPENCLAW_HOME`, else in `$HOME`. `OPENCLAW_HOME` replaces the OS home
   * OpenClaw's defaults use, `~` in `OPENCLAW_STATE_DIR` included.
   */
  | { readonly kind: 'openclaw-state'; readonly evidence: Evidence }
  /**
   * Oh My Pi's agent dir. The profile is `OMP_PROFILE` when defined, even
   * empty, else `PI_PROFILE`; a blank or `default` one is the default profile.
   * A named profile is `~/<PI_CONFIG_DIR or .omp>/profiles/<name>/agent`; the
   * default one is `~/<PI_CONFIG_DIR or .omp>/agent`.
   */
  | { readonly kind: 'omp-agent'; readonly evidence: Evidence }
  /**
   * Hermes's home: `HERMES_HOME`, else `~/.hermes<suffix>`, or
   * `%LOCALAPPDATA%\hermes<suffix>` on Windows, with `HERMES_DATA_DIR_SUFFIX`
   * appended as written. Unless `HERMES_HOME` is itself a `profiles/<name>`
   * dir, a profile `active_profile` names, other than `default`, is
   * `profiles/<name>` in that home while the directory exists; the
   * `active_profile` read is the platform one when `HERMES_HOME` is inside it.
   * The profile is applied on every run, inside a recorded home too, and never
   * recorded: Hermes rewrites `active_profile` outside any shell.
   */
  | { readonly kind: 'hermes-home'; readonly evidence: Evidence };

/**
 * `dir` is relative to `$HOME`. The first of `moves.by` that applies moves the
 * home; `moves.root` is the `$HOME`-relative directory a move replaces when it
 * is not `dir` (Pi's variable moves `.pi/agent`). `moves.defaultHomeLeftovers`:
 * releases before #1221 wrote the tool's hooks (OpenCode's plugin, Pi's
 * extension, Muse's and CodeBuddy's settings.json hooks) and MCP servers under
 * the default home when the home moved, so uninstall and MCP ownership look there too.
 */
export type Home = {
  readonly dir: string;
  readonly moves?: { readonly root?: string; readonly by: readonly HomeMove[]; readonly defaultHomeLeftovers?: true };
};

/**
 * A path under `$HOME` the tool reads, from any session; `workspaceUnderHome`:
 * only from a session under `$HOME` (Cursor finds `~/.cursor/rules` walking up
 * from the workspace, #1197).
 */
export type HomeRead = { readonly base: 'home'; readonly path: string; readonly when?: 'workspaceUnderHome'; readonly evidence: Evidence };
/** A path in a project the tool reads: from a session at or under its root, or only at it. */
export type ProjectRead = {
  readonly base: 'project';
  readonly path: string;
  readonly when: 'workspaceUnder' | 'cwdOnly';
  readonly evidence: Evidence;
};

/** CodeBuddy's moved home (`CODEBUDDY_CONFIG_DIR`) when it moves, else `$HOME`: where CodeBuddy's engine keeps `.codebuddy.json`. */
export type CodebuddyConfigFile = { readonly in: 'codebuddy-config-dir'; readonly path: '.codebuddy.json' };

/** Files the tool tries in order, reading only the first that exists, never merging them (#993). */
export type FirstExistingRead =
  | { readonly base: 'home'; readonly firstOf: readonly [string, string, ...(string | CodebuddyConfigFile)[]]; readonly evidence: Evidence }
  | { readonly base: 'project'; readonly firstOf: readonly [string, string, ...string[]]; readonly when: 'workspaceUnder' | 'cwdOnly'; readonly evidence: Evidence };

type Reads<R> = readonly R[] | 'unknown';

/**
 * Where the tool reads skills, per install scope: every directory a write of
 * that scope could land in. `'unknown'` is never judged.
 */
export type SkillReads = {
  readonly user: Reads<HomeRead>;
  readonly project: Reads<HomeRead | ProjectRead>;
};

/**
 * Each scope states its channel: the adapter, `'none'` (teamai builds nothing
 * there, by decision) or `'unknown'` (teamai builds nothing because where the
 * tool takes it is unknown; doctor says so for an installed tool).
 */
type Scoped<U, P> = { readonly user: U | 'none' | 'unknown'; readonly project: P | 'none' | 'unknown' };

/** The check that says a run-time channel is installed where the tool runs it. */
export type ChannelProbe = 'codex-hooks' | 'zcode-session-start' | 'dsh-session-start' | 'muse-session-start' | 'pi-extension' | 'omp-extension' | 'hermes-plugin';

/** How teamai adds a resource to each session of the tool instead of writing it to a file the tool reads. */
export type RunTimeVia = 'session-hook' | 'extension' | 'plugin';

export type ReadGateKind = 'codex-project-trust';

/** The frontmatter teamai writes above its blocks when it creates an owned blocks file a rules loader reads. */
export type BlocksHeader = 'always-apply' | 'apply-to-all';

/** `limit`: the size the channel takes before the tool drops the text whole. */
export type RunTime = { readonly channel: RunTimeVia; readonly probe: ChannelProbe; readonly limit?: number; readonly evidence: Evidence };

/**
 * A key teamai also writes so the tool loads the rules or blocks: OpenCode's
 * `instructions`. `mcp-file`: the file the tool's MCP channel writes in that
 * scope, resolved by the same function, so a home move cannot split them.
 */
export type Activation =
  | { readonly key: 'instructions'; readonly in: 'mcp-file' }
  | { readonly key: 'instructions'; readonly in: 'project'; readonly path: string };

/** One file per rule in the scope's configured rules directory, rendered by its rules format or copied verbatim. */
export type RulesDir<R> = { readonly channel: 'dir'; readonly format: RuleFormatId | 'verbatim'; readonly reads: Reads<R>; readonly activation?: Activation };
/** The team rules as one block in the tool's blocks file for the scope; `label` names that file in doctor. */
export type RulesInline = { readonly channel: 'inline'; readonly label: string };

export type RulesChannels = Scoped<RulesDir<HomeRead> | RulesInline, RulesDir<HomeRead | ProjectRead> | RunTime>;

/** Where a blocks file sits; `owned`: the whole file is teamai's. */
export type BlocksFile = { readonly owned?: true; readonly header?: BlocksHeader } & (
  | { readonly in: 'claudemd' }
  /**
   * teamai's own file in the scope's configured rules directory, or in `dir`
   * when the tool reads that one whatever the team maps; the configured
   * `claudemd` when the team maps no rules directory.
   */
  | { readonly in: 'rules-dir'; readonly name: string; readonly dir?: string }
  /** A fixed `$HOME`-relative file, re-rooted where the tool's home moves. */
  | { readonly in: 'home'; readonly path: string }
  | { readonly in: 'project'; readonly path: string }
  /** A file in OpenClaw's workspace, wherever its config puts it. */
  | { readonly in: 'openclaw-workspace'; readonly name: string }
);

export type BlocksTarget<R> = {
  readonly channel: 'file';
  readonly file: BlocksFile;
  /** With sharing.gitExclude on, the file teamai writes instead (Copilot, #915); the other one is retired. */
  readonly gitExcluded?: BlocksFile;
  readonly activation?: Activation;
  /** A surface of the tool reads no agents from the scope's agents directory, so the recall block tells it to run `teamai recall` itself. */
  readonly noRecallAgent?: true;
  readonly reads: Reads<R>;
};

export type BlocksChannels = Scoped<BlocksTarget<HomeRead>, BlocksTarget<HomeRead | ProjectRead> | RunTime> & {
  /** Files earlier releases wrote the blocks to, per scope: pull strips teamai's blocks from them once no tool targets them. */
  readonly retired?: { readonly user?: readonly string[]; readonly project?: readonly string[] };
};

/**
 * Agents written to the scope's configured agents directory, rendered by the
 * tool id itself (`renderForTool`), so no entry can point a tool at another
 * tool's renderer.
 */
export type AgentsTarget<R> = { readonly reads: Reads<R>; readonly readGates?: readonly ReadGateKind[] };
export type AgentsChannels = Scoped<AgentsTarget<HomeRead>, AgentsTarget<HomeRead | ProjectRead>>;

/**
 * Servers written to the scope's configured MCP file, rendered by `format`,
 * under `key` when the tool keeps them elsewhere than the format's server key
 * (ZCode's `mcp.servers`).
 */
type McpCommon<R> = {
  readonly format: McpFormat;
  readonly key?: readonly [string, ...string[]];
  readonly reads: Reads<R>;
  readonly readGates?: readonly ReadGateKind[];
};

export type McpUser = McpCommon<HomeRead | FirstExistingRead>;
export type McpProject = McpCommon<HomeRead | ProjectRead | FirstExistingRead> & {
  /**
   * #915: while sharing.gitExclude is on or the workspace has children, the
   * servers go to `projects[key]` of this file, keyed as the tool files a
   * checkout (`git-common-root`: Claude Code; `realpath`: CodeBuddy).
   */
  readonly localScope?: { readonly file: 'user-mcp-file' | CodebuddyConfigFile; readonly key: 'git-common-root' | 'realpath' };
  /** OpenCode V2 takes a project's servers from teamai's own file through its plugin (#915). */
  readonly alternate?: { readonly path: string; readonly when: 'opencode-v2-plugin' };
  /** The tool reads another tool's project file and has none of its own: Muse and tclaude read claude's `.mcp.json`. */
  readonly writtenBy?: ToolId;
};

export type McpChannels = Scoped<McpUser, McpProject> & {
  /** Files earlier releases wrote the servers to, per scope: pull moves teamai's servers out of them. */
  readonly retired?: { readonly user?: readonly string[]; readonly project?: readonly string[] };
};

/** The shape of the hook list in a tool's hook file (`reconcileHooks`). */
export type HookFormat = 'claude' | 'cursor' | 'codex' | 'copilot' | 'zcode';

/** teamai's entries in the hook list of the scope's configured hook file (`toolPaths.settings`, Copilot's `toolPaths.hooks`), in `format`. */
export type HookSettings<R> = { readonly channel: 'settings'; readonly format: HookFormat; readonly reads: Reads<R> };

/** A file or directory of teamai's own the tool loads from its home, written by the tool's own adapter. */
export type HookAdapterId = 'opencode-plugin' | 'pi-extension' | 'omp-extension' | 'hermes-plugin' | 'openclaw-hook' | 'dsh-hooks' | 'kiro-hooks';
export type HookAdapter = { readonly channel: 'adapter'; readonly adapter: HookAdapterId; readonly evidence: Evidence };

/**
 * Where teamai installs the tool's hooks. A workspace takes the user hooks
 * (`resolveHookScope`), so only self mode installs project hooks; `self:
 * 'user'` says the tool takes its user hooks there too.
 */
export type HooksChannels = {
  readonly user: HookSettings<HomeRead> | HookAdapter | 'none' | 'unknown';
  readonly self: HookSettings<HomeRead | ProjectRead> | 'user' | 'none' | 'unknown';
  /**
   * A workspace of a team repo also takes the team's hooks in this project
   * file, while the user hooks keep the built-ins (Copilot's
   * `.github/hooks/teamai.json`). Absent: the workspace takes the user hooks only.
   */
  readonly workspace?: HookSettings<ProjectRead>;
};

/**
 * What says the tool is installed when its configured paths do not:
 * - `home-edition`: its home under `$HOME`, or an `--agent` entry naming it,
 *   in every scope. Editions of one product share every project path (Trae
 *   and Trae CN `<root>/.trae/`), so the shared root says nothing about which
 *   one the member runs (#904).
 * - `home`: its home, in every scope. Muse has no project path of its own:
 *   Codex and Claude Code read its `.agents` and `.mcp.json` too.
 * - `own-root`: its home directory under the scope's base. WorkBuddy reads a
 *   project's rules from CodeBuddy's `.codebuddy/rules` (#946).
 */
export type InstallGate = 'home-edition' | 'home' | 'own-root';

/**
 * A cell of #1221's matrix: the state, then the evidence. `✓` works. `◐` works
 * by default, and a condition breaks it while doctor still reports it
 * delivered. `✗` broken in the default setup. `+` the tool supports it and
 * teamai does not build it. `—` the tool has no such feature. Evidence: `v` a
 * real tool run, or the tool's own loader run on teamai's output; `s` the
 * tool's source; `d` its docs; `t` teamai's code only. `?` unknown.
 */
export type SupportCell = `${'✓' | '◐' | '✗' | '+' | '—'}${'v' | 's' | 'd' | 't'}` | '?';

/** A cell, with what the mark alone does not say: a later fix not rerun, another surface of the tool. */
export type Support = SupportCell | { readonly cell: SupportCell; readonly note: string };

/** What reaches the tool at run time, and what teamai's own AI does with it, in user scope. */
export type ToolFeatures = {
  /** The team env in teamai's shell profile block reaches the tool's sessions. */
  readonly env: Support;
  /** The local driver (`teamai workflow start --driver local`) runs prompt steps on the tool. */
  readonly workflows: Support;
  /** The recall skill and its session-start reminder. */
  readonly recall: Support;
  /** The tool's skill calls are recorded for usage stats. */
  readonly stats: Support;
  /** teamai's own AI calls (enrich, codebase, import, maintenance) run on the tool's CLI (`tool-launch/call.ts`). */
  readonly aiBackend: Support;
  /** The votes judge reads the tool's session replies. */
  readonly votesJudge: Support;
  /** With the skill driver and no verified judge of the tool here, the tool's session judges the workflow run it drives (#1386). */
  readonly sessionJudge: Support;
  /** The HTTP local agent installs server-pushed hooks for the tool. */
  readonly agentHooks: Support;
};

export type ToolDescriptor = {
  readonly home: Home;
  readonly skillLoad: SkillLoad;
  readonly skills: SkillReads;
  readonly installedBy?: InstallGate;
  /**
   * Where teamai writes the tool's skills follows inputs of each session that
   * nothing records: OpenClaw's workspace follows `OPENCLAW_WORKSPACE_DIR`,
   * `OPENCLAW_CONFIG_PATH` and the directory a relative workspace resolves
   * against. A move there may be another session's, so pull never names the
   * old one as left and syncs in full only when the tool's home moves
   * (`sessionToolHomes`).
   */
  readonly skillsFollowSession?: true;
  readonly rules: RulesChannels;
  readonly blocks: BlocksChannels;
  readonly agents: AgentsChannels;
  readonly mcp: McpChannels;
  readonly hooks: HooksChannels;
  /**
   * The session platforms teamai reads for the tool, first the one its
   * launched sessions write. `'none'`: the tool keeps sessions teamai has no
   * adapter for. `'unknown'`: where it keeps them is unknown.
   */
  readonly sessions: readonly [StoredSessionPlatform, ...StoredSessionPlatform[]] | 'none' | 'unknown';
  /** The adapter teamai launches the tool headless with (`src/tool-launch/adapters.ts`), or `'none'` when teamai never launches it. */
  readonly launch: LaunchAdapterId | 'none';
  /** Data only: nothing reads it but the support page (`tool-support.ts`). */
  readonly features: ToolFeatures;
};

const UNKNOWN_READS = { user: 'unknown', project: 'unknown' } as const;
const NONE = { user: 'none', project: 'none' } as const;
const UNKNOWN = { user: 'unknown', project: 'unknown' } as const;

/**
 * What teamai knows about each built-in tool.
 *
 * `calls` lists only a dedicated skill tool; a read of a SKILL.md path is not
 * one. `promptForm` is how a prompt that loads a skill with no tool call reaches
 * the prompt-submit hook: Codex's `$name` as typed, or the leading
 * `<skill name location>` block Pi expands `/skill:name` into first.
 * `'unknown'` credits no tool call or read. Evidence per call:
 * - verified: a recorded run of the tool, or its own loader run on teamai's output
 * - source: the tool's source or shipped bundle
 * - docs: the tool's documentation
 * - assumed: teamai's own code or the issue matrix only
 */
export const TOOLS = {
  claude: {
    home: { dir: '.claude' },
    skillLoad: { calls: [{ name: 'Skill', evidence: 'verified' }] },
    skills: { user: [{ base: 'home', path: '.claude/skills', evidence: 'docs' }], project: 'unknown' },
    rules: {
      user: { channel: 'dir', format: 'verbatim', reads: [{ base: 'home', path: '.claude/rules', evidence: 'verified' }] },
      project: { channel: 'dir', format: 'verbatim', reads: [{ base: 'project', path: '.claude/rules', when: 'workspaceUnder', evidence: 'verified' }] },
    },
    blocks: {
      user: { channel: 'file', file: { in: 'claudemd' }, reads: [{ base: 'home', path: '.claude/CLAUDE.md', evidence: 'verified' }] },
      // CLAUDE.local.md would stop Claude's native AGENTS.md load (#945).
      project: {
        channel: 'file', file: { in: 'rules-dir', name: 'teamai-context.md', owned: true },
        reads: [{ base: 'project', path: '.claude/rules', when: 'workspaceUnder', evidence: 'verified' }],
      },
      retired: { project: ['.claude/CLAUDE.md'] },
    },
    agents: {
      user: { reads: [{ base: 'home', path: '.claude/agents', evidence: 'verified' }] },
      project: { reads: [{ base: 'project', path: '.claude/agents', when: 'workspaceUnder', evidence: 'verified' }] },
    },
    mcp: {
      user: { format: 'claude', reads: [{ base: 'home', path: '.claude.json', evidence: 'verified' }] },
      project: {
        format: 'claude', localScope: { file: 'user-mcp-file', key: 'git-common-root' },
        reads: [{ base: 'project', path: '.mcp.json', when: 'workspaceUnder', evidence: 'verified' }],
      },
    },
    hooks: { user: { channel: 'settings', format: 'claude', reads: [{ base: 'home', path: '.claude/settings.json', evidence: 'verified' }] }, self: { channel: 'settings', format: 'claude', reads: [{ base: 'project', path: '.claude/settings.json', when: 'workspaceUnder', evidence: 'verified' }, { base: 'project', path: '.claude/settings.local.json', when: 'workspaceUnder', evidence: 'verified' }] } },
    sessions: ['claude-code'],
    launch: 'claude',
    features: {
      env: '✓t',
      workflows: '✓v',
      recall: '✓v',
      stats: '✓v',
      aiBackend: '✓v',
      votesJudge: '✓v',
      sessionJudge: { cell: '✓t', note: '#1386 the session judges its skill-driven run; not rerun' },
      agentHooks: '✓v',
    },
  },
  codex: {
    home: { dir: '.codex' },
    skillLoad: { calls: [], promptForm: '$name' },
    // Codex 0.163.0 runs read $CODEX_HOME/skills and ~/.agents/skills.
    skills: {
      user: [{ base: 'home', path: '.codex/skills', evidence: 'verified' }, { base: 'home', path: '.agents/skills', evidence: 'verified' }],
      project: 'unknown',
    },
    rules: {
      user: { channel: 'inline', label: 'Codex AGENTS.md' },
      project: { channel: 'session-hook', probe: 'codex-hooks', evidence: 'verified' },
    },
    blocks: {
      user: { channel: 'file', file: { in: 'claudemd' }, reads: [{ base: 'home', path: '.codex/AGENTS.md', evidence: 'verified' }] },
      project: { channel: 'session-hook', probe: 'codex-hooks', evidence: 'verified' },
      retired: { project: ['AGENTS.md'] },
    },
    agents: {
      user: { reads: [{ base: 'home', path: '.codex/agents', evidence: 'verified' }] },
      project: { reads: [{ base: 'project', path: '.codex/agents', when: 'workspaceUnder', evidence: 'verified' }], readGates: ['codex-project-trust'] },
    },
    mcp: {
      user: { format: 'codex', reads: [{ base: 'home', path: '.codex/config.toml', evidence: 'verified' }] },
      project: { format: 'codex', reads: [{ base: 'project', path: '.codex/config.toml', when: 'workspaceUnder', evidence: 'verified' }], readGates: ['codex-project-trust'] },
    },
    hooks: { user: { channel: 'settings', format: 'codex', reads: [{ base: 'home', path: '.codex/hooks.json', evidence: 'verified' }] }, self: { channel: 'settings', format: 'codex', reads: [{ base: 'project', path: '.codex/hooks.json', when: 'workspaceUnder', evidence: 'verified' }] } },
    sessions: ['codex'],
    launch: 'codex',
    features: {
      env: '✓t',
      workflows: '✓t',
      recall: '✓v',
      stats: { cell: '✓t', note: 'A1 (#1245) records its skill loads; not rerun' },
      aiBackend: '✓v',
      votesJudge: { cell: '✓t', note: '#1374 judges the reply in its Stop payload; not rerun' },
      sessionJudge: { cell: '✓t', note: '#1386 the session judges its skill-driven run; not rerun' },
      agentHooks: { cell: '✓t', note: '#1224 runs the Codex trust pass; not rerun' },
    },
  },
  'codex-internal': {
    home: { dir: '.codex-internal' },
    skillLoad: { calls: [], promptForm: '$name' },
    skills: UNKNOWN_READS,
    rules: { user: { channel: 'inline', label: 'Codex AGENTS.md' }, project: { channel: 'session-hook', probe: 'codex-hooks', evidence: 'assumed' } },
    blocks: {
      user: { channel: 'file', file: { in: 'claudemd' }, reads: 'unknown' },
      project: { channel: 'session-hook', probe: 'codex-hooks', evidence: 'assumed' },
      retired: { project: ['AGENTS.md'] },
    },
    agents: { user: { reads: 'unknown' }, project: { reads: 'unknown' } },
    mcp: UNKNOWN,
    hooks: { user: { channel: 'settings', format: 'codex', reads: [{ base: 'home', path: '.codex-internal/hooks.json', evidence: 'assumed' }] }, self: { channel: 'settings', format: 'codex', reads: 'unknown' } },
    sessions: ['codex-internal'],
    launch: 'codex',
    features: {
      env: '?',
      workflows: '✓t',
      recall: '?',
      stats: '?',
      aiBackend: '✓t',
      votesJudge: '?',
      sessionJudge: '?',
      agentHooks: '?',
    },
  },
  'claude-internal': {
    home: { dir: '.claude-internal' },
    skillLoad: { calls: [{ name: 'Skill', evidence: 'assumed' }] },
    skills: UNKNOWN_READS,
    rules: { user: { channel: 'dir', format: 'verbatim', reads: 'unknown' }, project: { channel: 'dir', format: 'verbatim', reads: 'unknown' } },
    blocks: { user: { channel: 'file', file: { in: 'claudemd' }, reads: 'unknown' }, project: { channel: 'file', file: { in: 'claudemd' }, reads: 'unknown' } },
    agents: { user: { reads: 'unknown' }, project: { reads: 'unknown' } },
    mcp: UNKNOWN,
    hooks: { user: { channel: 'settings', format: 'claude', reads: [{ base: 'home', path: '.claude-internal/settings.json', evidence: 'assumed' }] }, self: { channel: 'settings', format: 'claude', reads: 'unknown' } },
    sessions: ['claude-internal'],
    launch: 'claude',
    features: {
      env: '?',
      workflows: '✓t',
      recall: '?',
      stats: '?',
      aiBackend: '✓t',
      votesJudge: '?',
      sessionJudge: '?',
      agentHooks: '?',
    },
  },
  tclaude: {
    home: { dir: '.tclaude' },
    skillLoad: { calls: [{ name: 'Skill', evidence: 'assumed' }] },
    skills: UNKNOWN_READS,
    rules: { user: { channel: 'dir', format: 'verbatim', reads: 'unknown' }, project: { channel: 'dir', format: 'verbatim', reads: 'unknown' } },
    blocks: { user: { channel: 'file', file: { in: 'claudemd' }, reads: 'unknown' }, project: { channel: 'file', file: { in: 'claudemd' }, reads: 'unknown' } },
    agents: { user: { reads: 'unknown' }, project: { reads: 'unknown' } },
    mcp: {
      user: { format: 'claude', reads: 'unknown' },
      project: { format: 'claude', writtenBy: 'claude', reads: [{ base: 'project', path: '.mcp.json', when: 'workspaceUnder', evidence: 'assumed' }] },
    },
    hooks: { user: { channel: 'settings', format: 'claude', reads: [{ base: 'home', path: '.tclaude/settings.json', evidence: 'assumed' }] }, self: { channel: 'settings', format: 'claude', reads: 'unknown' } },
    sessions: ['tclaude'],
    launch: 'claude',
    features: {
      env: '?',
      workflows: '✓t',
      recall: '?',
      stats: '?',
      aiBackend: '✓t',
      votesJudge: '?',
      sessionJudge: '?',
      agentHooks: '?',
    },
  },
  tcodex: {
    home: { dir: '.tcodex' },
    skillLoad: { calls: [], promptForm: '$name' },
    skills: UNKNOWN_READS,
    rules: { user: { channel: 'inline', label: 'Codex AGENTS.md' }, project: { channel: 'session-hook', probe: 'codex-hooks', evidence: 'assumed' } },
    blocks: {
      user: { channel: 'file', file: { in: 'claudemd' }, reads: 'unknown' },
      project: { channel: 'session-hook', probe: 'codex-hooks', evidence: 'assumed' },
      retired: { project: ['AGENTS.md'] },
    },
    agents: { user: { reads: 'unknown' }, project: { reads: 'unknown' } },
    mcp: UNKNOWN,
    hooks: { user: { channel: 'settings', format: 'codex', reads: [{ base: 'home', path: '.tcodex/hooks.json', evidence: 'assumed' }] }, self: { channel: 'settings', format: 'codex', reads: 'unknown' } },
    sessions: ['tcodex'],
    launch: 'codex',
    features: {
      env: '?',
      workflows: '✓t',
      recall: '?',
      stats: '?',
      aiBackend: '✓t',
      votesJudge: '?',
      sessionJudge: '?',
      agentHooks: '?',
    },
  },
  // Cursor reads `<ancestor>/.cursor/rules` walking up from the workspace (cursor-user-rules.ts).
  cursor: {
    home: { dir: '.cursor' },
    skillLoad: { calls: [] },
    skills: UNKNOWN_READS,
    rules: {
      user: { channel: 'dir', format: 'cursor-mdc', reads: [{ base: 'home', path: '.cursor/rules', when: 'workspaceUnderHome', evidence: 'verified' }] },
      project: { channel: 'dir', format: 'cursor-mdc', reads: [{ base: 'project', path: '.cursor/rules', when: 'workspaceUnder', evidence: 'verified' }] },
    },
    blocks: {
      user: {
        channel: 'file', file: { in: 'rules-dir', name: 'teamai-context.mdc', owned: true, header: 'always-apply' },
        // The Cursor CLI reads no ~/.cursor/agents (#1218).
        noRecallAgent: true,
        reads: [{ base: 'home', path: '.cursor/rules', when: 'workspaceUnderHome', evidence: 'verified' }],
      },
      project: {
        channel: 'file', file: { in: 'rules-dir', name: 'teamai-context.mdc', owned: true, header: 'always-apply' },
        reads: [{ base: 'project', path: '.cursor/rules', when: 'workspaceUnder', evidence: 'verified' }],
      },
    },
    agents: {
      // The IDE reads it; the CLI does not (#1218), which doctor's wording names.
      user: { reads: [{ base: 'home', path: '.cursor/agents', evidence: 'source' }] },
      project: { reads: [{ base: 'project', path: '.cursor/agents', when: 'workspaceUnder', evidence: 'verified' }] },
    },
    mcp: {
      user: { format: 'cursor', reads: [{ base: 'home', path: '.cursor/mcp.json', evidence: 'source' }] },
      project: { format: 'cursor', reads: [{ base: 'project', path: '.cursor/mcp.json', when: 'workspaceUnder', evidence: 'source' }] },
    },
    hooks: { user: { channel: 'settings', format: 'cursor', reads: [{ base: 'home', path: '.cursor/hooks.json', evidence: 'source' }] }, self: { channel: 'settings', format: 'cursor', reads: [{ base: 'project', path: '.cursor/hooks.json', when: 'workspaceUnder', evidence: 'source' }] } },
    sessions: ['cursor'],
    launch: 'cursor',
    features: {
      env: '?',
      workflows: { cell: '+s', note: 'Cursor IDE: —' },
      recall: { cell: '✗v', note: 'Cursor IDE: ✓v' },
      stats: { cell: '✓v', note: 'Cursor IDE: ✓t' },
      aiBackend: '✓d',
      votesJudge: '+s',
      sessionJudge: { cell: '✓t', note: '#1386 the session judges its skill-driven run; not rerun' },
      agentHooks: { cell: '+t', note: 'teamai refuses agent hooks in the Cursor hook format' },
    },
  },
  copilot: {
    home: { dir: '.copilot', moves: { by: [{ kind: 'env', name: 'COPILOT_HOME', evidence: 'verified' }] } },
    skillLoad: { calls: [{ name: 'skill', evidence: 'verified' }] },
    skills: {
      user: [{ base: 'home', path: '.copilot/skills', evidence: 'verified' }],
      project: [{ base: 'project', path: '.github/skills', when: 'workspaceUnder', evidence: 'verified' }],
    },
    rules: {
      user: { channel: 'dir', format: 'copilot-instructions', reads: [{ base: 'home', path: '.copilot/instructions', evidence: 'verified' }] },
      project: { channel: 'dir', format: 'copilot-instructions', reads: [{ base: 'project', path: '.github/instructions', when: 'workspaceUnder', evidence: 'verified' }] },
    },
    blocks: {
      user: { channel: 'file', file: { in: 'claudemd' }, reads: [{ base: 'home', path: '.copilot/copilot-instructions.md', evidence: 'verified' }] },
      // Copilot inlines a `.github/instructions` file in every request only for the `applyTo: "**"` glob (#915).
      project: {
        channel: 'file', file: { in: 'claudemd' },
        gitExcluded: { in: 'rules-dir', name: 'teamai-context.instructions.md', owned: true, header: 'apply-to-all' },
        reads: [
          { base: 'project', path: '.github/copilot-instructions.md', when: 'workspaceUnder', evidence: 'verified' },
          { base: 'project', path: '.github/instructions', when: 'workspaceUnder', evidence: 'verified' },
        ],
      },
    },
    agents: {
      user: { reads: [{ base: 'home', path: '.copilot/agents', evidence: 'source' }] },
      project: { reads: [{ base: 'project', path: '.github/agents', when: 'workspaceUnder', evidence: 'source' }] },
    },
    mcp: {
      user: { format: 'copilot', reads: [{ base: 'home', path: '.copilot/mcp-config.json', evidence: 'verified' }] },
      project: { format: 'copilot', reads: [{ base: 'project', path: '.github/mcp.json', when: 'workspaceUnder', evidence: 'verified' }] },
    },
    hooks: {
      user: { channel: 'settings', format: 'copilot', reads: [{ base: 'home', path: '.copilot/hooks/teamai.json', evidence: 'source' }] },
      self: { channel: 'settings', format: 'copilot', reads: [{ base: 'project', path: '.github/hooks/teamai.json', when: 'workspaceUnder', evidence: 'source' }] },
      workspace: { channel: 'settings', format: 'copilot', reads: [{ base: 'project', path: '.github/hooks/teamai.json', when: 'workspaceUnder', evidence: 'source' }] },
    },
    sessions: 'none',
    launch: 'copilot',
    features: {
      env: '?',
      workflows: '+s',
      recall: '✓v',
      stats: { cell: '✓t', note: 'A1 (#1245) records its skill loads; not rerun' },
      aiBackend: '✓d',
      votesJudge: '?',
      sessionJudge: { cell: '✓t', note: '#1386 the session judges its skill-driven run; not rerun' },
      agentHooks: '—t',
    },
  },
  joycode: {
    home: { dir: '.joycode' },
    skillLoad: 'unknown',
    skills: UNKNOWN_READS,
    rules: {
      user: { channel: 'inline', label: 'JoyCode rules.txt' },
      project: { channel: 'dir', format: 'joycode', reads: [{ base: 'project', path: '.joycode/rules', when: 'workspaceUnder', evidence: 'verified' }] },
    },
    blocks: {
      user: { channel: 'file', file: { in: 'home', path: '.joycode/rules.txt' }, reads: [{ base: 'home', path: '.joycode/rules.txt', evidence: 'source' }] },
      project: 'none',
    },
    // JoyCode loads an agent only through its `.joycode/agent.json` index, which teamai does not write.
    agents: { user: { reads: 'unknown' }, project: { reads: 'unknown' } },
    mcp: NONE,
    hooks: { user: 'none', self: 'none' },
    sessions: 'unknown',
    launch: 'none',
    features: {
      env: '?',
      workflows: '?',
      recall: '◐s',
      stats: '?',
      aiBackend: '?',
      votesJudge: '?',
      sessionJudge: '?',
      agentHooks: '?',
    },
  },
  qoder: {
    home: { dir: '.qoder' },
    skillLoad: { calls: [{ name: 'Skill', evidence: 'source' }] },
    skills: UNKNOWN_READS,
    installedBy: 'home-edition',
    rules: {
      user: { channel: 'dir', format: 'qoder', reads: [{ base: 'home', path: '.qoder/rules', evidence: 'verified' }] },
      project: { channel: 'dir', format: 'qoder', reads: [{ base: 'project', path: '.qoder/rules', when: 'workspaceUnder', evidence: 'verified' }] },
    },
    blocks: NONE,
    agents: {
      user: { reads: [{ base: 'home', path: '.qoder/agents', evidence: 'source' }] },
      project: { reads: [{ base: 'project', path: '.qoder/agents', when: 'workspaceUnder', evidence: 'source' }] },
    },
    mcp: {
      user: { format: 'claude', reads: [{ base: 'home', path: '.qoder/settings.json', evidence: 'source' }] },
      project: { format: 'claude', reads: [{ base: 'project', path: '.qoder/settings.json', when: 'workspaceUnder', evidence: 'source' }] },
    },
    hooks: { user: { channel: 'settings', format: 'claude', reads: [{ base: 'home', path: '.qoder/settings.json', evidence: 'source' }] }, self: { channel: 'settings', format: 'claude', reads: [{ base: 'project', path: '.qoder/settings.json', when: 'cwdOnly', evidence: 'source' }] } },
    // Qoder CLI 1.1.78: <id>.jsonl under ~/.qoder/projects/<cwd>, moved by QODER_CONFIG_DIR.
    sessions: 'none',
    launch: 'qoder',
    features: {
      env: '?',
      workflows: '?',
      recall: '◐s',
      stats: '✓s',
      aiBackend: '✓d',
      votesJudge: '?',
      sessionJudge: { cell: '✓s', note: 'Claude Code-style subagents, transcripts under <id>/subagents/ (qodercli 1.1.78); not run' },
      agentHooks: '✓s',
    },
  },
  'qoder-cn': {
    home: { dir: '.qoder-cn' },
    skillLoad: { calls: [{ name: 'Skill', evidence: 'source' }] },
    skills: UNKNOWN_READS,
    installedBy: 'home-edition',
    rules: {
      user: { channel: 'dir', format: 'qoder', reads: [{ base: 'home', path: '.qoder-cn/rules', evidence: 'verified' }] },
      project: { channel: 'dir', format: 'qoder', reads: [{ base: 'project', path: '.qoder/rules', when: 'workspaceUnder', evidence: 'verified' }] },
    },
    blocks: NONE,
    agents: {
      user: { reads: [{ base: 'home', path: '.qoder-cn/agents', evidence: 'source' }] },
      project: { reads: [{ base: 'project', path: '.qoder/agents', when: 'workspaceUnder', evidence: 'assumed' }] },
    },
    mcp: {
      user: { format: 'claude', reads: [{ base: 'home', path: '.qoder-cn/settings.json', evidence: 'source' }] },
      project: { format: 'claude', reads: [{ base: 'project', path: '.qoder/settings.json', when: 'workspaceUnder', evidence: 'assumed' }] },
    },
    hooks: { user: { channel: 'settings', format: 'claude', reads: [{ base: 'home', path: '.qoder-cn/settings.json', evidence: 'source' }] }, self: { channel: 'settings', format: 'claude', reads: [{ base: 'project', path: '.qoder/settings.json', when: 'cwdOnly', evidence: 'source' }] } },
    // Qoder CN: the same layout under ~/.qoder-cn, moved by the QODERCN_ variables.
    sessions: 'none',
    launch: 'none',
    features: {
      env: '?',
      workflows: '?',
      recall: '◐s',
      stats: '✓s',
      aiBackend: '?',
      votesJudge: '?',
      sessionJudge: { cell: '✓s', note: 'Claude Code-style subagents, transcripts under <id>/subagents/ (qodercli 1.1.78); not run' },
      agentHooks: { cell: '✓t', note: '#1224 writes ~/.qoder-cn/settings.json; not rerun' },
    },
  },
  kiro: {
    home: { dir: '.kiro' },
    skillLoad: 'unknown',
    skills: UNKNOWN_READS,
    rules: {
      user: { channel: 'dir', format: 'kiro-steering', reads: [{ base: 'home', path: '.kiro/steering', evidence: 'docs' }] },
      project: { channel: 'dir', format: 'kiro-steering', reads: [{ base: 'project', path: '.kiro/steering', when: 'workspaceUnder', evidence: 'docs' }] },
    },
    blocks: NONE,
    agents: {
      user: { reads: [{ base: 'home', path: '.kiro/agents', evidence: 'docs' }] },
      project: { reads: [{ base: 'project', path: '.kiro/agents', when: 'workspaceUnder', evidence: 'docs' }] },
    },
    mcp: {
      user: { format: 'claude', reads: [{ base: 'home', path: '.kiro/settings/mcp.json', evidence: 'docs' }] },
      project: { format: 'claude', reads: [{ base: 'project', path: '.kiro/settings/mcp.json', when: 'workspaceUnder', evidence: 'docs' }] },
    },
    // Kiro CLI V3 loads every hook file in ~/.kiro/hooks, whatever agent runs (#1341).
    hooks: { user: { channel: 'adapter', adapter: 'kiro-hooks', evidence: 'docs' }, self: 'user' },
    // Kiro CLI docs: sessions under ~/.kiro, moved by KIRO_HOME.
    sessions: 'none',
    launch: 'kiro',
    features: {
      env: '?',
      workflows: '?',
      recall: '◐d',
      stats: '?',
      aiBackend: '✓d',
      votesJudge: '?',
      sessionJudge: { cell: '✓d', note: 'a subagent works in its own context window, without the conversation; not run' },
      agentHooks: '?',
    },
  },
  // Trae keeps user MCP servers in its app-support directory, which teamai does not write.
  trae: {
    home: { dir: '.trae' },
    skillLoad: 'unknown',
    skills: UNKNOWN_READS,
    installedBy: 'home-edition',
    rules: {
      user: { channel: 'dir', format: 'trae', reads: 'unknown' },
      project: { channel: 'dir', format: 'trae', reads: [{ base: 'project', path: '.trae/rules', when: 'workspaceUnder', evidence: 'assumed' }] },
    },
    blocks: NONE,
    // Trae loads `.trae/agents` only while its Beta "Enable Subagents Directory" switch is on, a setting teamai cannot read.
    agents: {
      // Its docs give ~/.trae-cn/agents, a copy of Trae CN's page; nothing shows ~/.trae/agents.
      user: 'unknown',
      project: { reads: [{ base: 'project', path: '.trae/agents', when: 'cwdOnly', evidence: 'source' }] },
    },
    mcp: {
      user: 'none',
      project: { format: 'claude', reads: [{ base: 'project', path: '.trae/mcp.json', when: 'workspaceUnder', evidence: 'docs' }] },
    },
    hooks: { user: 'unknown', self: 'unknown' },
    // Trae docs: chat history in the IDE's ModularData database, which no variable moves.
    sessions: 'none',
    launch: 'none',
    features: {
      env: '?',
      workflows: '?',
      recall: '?',
      stats: '?',
      aiBackend: '?',
      votesJudge: '?',
      sessionJudge: { cell: '✓s', note: 'the Task tool starts a fresh subagent; no session variable, so the session names its tool with --tools; not run' },
      agentHooks: '?',
    },
  },
  'trae-cn': {
    home: { dir: '.trae-cn' },
    skillLoad: 'unknown',
    skills: UNKNOWN_READS,
    installedBy: 'home-edition',
    rules: {
      user: { channel: 'dir', format: 'trae', reads: 'unknown' },
      project: { channel: 'dir', format: 'trae', reads: [{ base: 'project', path: '.trae/rules', when: 'workspaceUnder', evidence: 'assumed' }] },
    },
    blocks: NONE,
    // Trae CN loads them only while its Beta "Enable Subagents Directory" switch is on (on by default, its docs say).
    agents: {
      user: { reads: [{ base: 'home', path: '.trae-cn/agents', evidence: 'docs' }] },
      project: { reads: [{ base: 'project', path: '.trae/agents', when: 'cwdOnly', evidence: 'source' }] },
    },
    mcp: {
      user: 'none',
      project: { format: 'claude', reads: [{ base: 'project', path: '.trae/mcp.json', when: 'workspaceUnder', evidence: 'docs' }] },
    },
    hooks: { user: 'unknown', self: 'unknown' },
    // Trae CN docs: the same database under Trae CN's application data.
    sessions: 'none',
    launch: 'none',
    features: {
      env: '?',
      workflows: '?',
      recall: '?',
      stats: '?',
      aiBackend: '?',
      votesJudge: '?',
      sessionJudge: { cell: '✓s', note: 'the Task tool starts a fresh subagent; no session variable, so the session names its tool with --tools; not run' },
      agentHooks: '?',
    },
  },
  // ZCode 3.16.2 source; 3.15.1 not certified. Its CLI runs only user-level hooks, and reads servers under `mcp.servers` of its own config files.
  zcode: {
    home: { dir: '.zcode' },
    skillLoad: { calls: [{ name: 'Skill', evidence: 'source' }] },
    skills: UNKNOWN_READS,
    rules: {
      user: { channel: 'inline', label: 'ZCode AGENTS.md' },
      project: { channel: 'session-hook', probe: 'zcode-session-start', evidence: 'source' },
    },
    blocks: {
      user: { channel: 'file', file: { in: 'home', path: '.zcode/AGENTS.md' }, reads: [{ base: 'home', path: '.zcode/AGENTS.md', evidence: 'source' }] },
      // hooks.maxOutputBytes defaults to 32768 (zcode.z.ai docs); ZCode drops a longer hook output whole.
      project: { channel: 'session-hook', probe: 'zcode-session-start', limit: 32768, evidence: 'source' },
    },
    agents: {
      user: { reads: [{ base: 'home', path: '.zcode/agents', evidence: 'source' }] },
      project: { reads: [{ base: 'project', path: '.zcode/agents', when: 'cwdOnly', evidence: 'source' }] },
    },
    mcp: {
      user: { format: 'claude', key: ['mcp', 'servers'], reads: [{ base: 'home', path: '.zcode/cli/config.json', evidence: 'source' }] },
      project: { format: 'claude', key: ['mcp', 'servers'], reads: [{ base: 'project', path: '.zcode/config.json', when: 'workspaceUnder', evidence: 'source' }] },
      retired: { user: ['.agents/mcp.json'] },
    },
    hooks: { user: { channel: 'settings', format: 'zcode', reads: [{ base: 'home', path: '.zcode/cli/config.json', evidence: 'source' }] }, self: 'user' },
    sessions: 'none',
    launch: 'none',
    features: {
      env: '✓t',
      workflows: '+s',
      recall: '✓s',
      stats: '✓s',
      aiBackend: '+s',
      votesJudge: { cell: '✓t', note: '#1374 judges the reply in its Stop payload; not rerun' },
      sessionJudge: { cell: '✓d', note: 'the built-in general-purpose subagent works in its own context; not run' },
      agentHooks: { cell: '+t', note: 'refused until teamai writes the hooks.events shape (#1224)' },
    },
  },
  // Extensions capture the installed Node/CLI launcher instead of depending on the host PATH.
  // utils/src/dirs.ts at a70f001c. A `--profile` flag another process starts with is out of teamai's sight: init records the home for it.
  // OMP also reads PI_CODING_AGENT_DIR for its default profile. teamai does not follow it: Pi owns that directory, and both
  // tools' files there, the hook extension's one name included, would overwrite each other.
  // No `defaultHomeLeftovers`: members run profiles side by side, so ~/.omp/agent is the live default profile.
  omp: {
    home: { dir: '.omp', moves: { root: '.omp/agent', by: [{ kind: 'omp-agent', evidence: 'source' }] } },
    skillLoad: { calls: [] },
    skills: { user: [{ base: 'home', path: '.omp/agent/skills', evidence: 'verified' }], project: 'unknown' },
    rules: {
      user: { channel: 'dir', format: 'omp', reads: [{ base: 'home', path: '.omp/agent/rules', evidence: 'verified' }] },
      project: { channel: 'dir', format: 'omp', reads: [{ base: 'project', path: '.omp/rules', when: 'cwdOnly', evidence: 'verified' }] },
    },
    blocks: {
      // An always-applied rule beside OMP's single user context file, which ~/.agents/AGENTS.md would take.
      user: { channel: 'file', file: { in: 'home', path: '.omp/agent/RULES.md' }, reads: [{ base: 'home', path: '.omp/agent/RULES.md', evidence: 'verified' }] },
      // OMP keeps one context file per level, so .omp/AGENTS.md would hide the project's AGENTS.md.
      project: { channel: 'extension', probe: 'omp-extension', evidence: 'verified' },
      retired: { user: ['.omp/agent/AGENTS.md'], project: ['.omp/AGENTS.md'] },
    },
    agents: {
      user: { reads: [{ base: 'home', path: '.omp/agent/agents', evidence: 'verified' }] },
      project: { reads: [{ base: 'project', path: '.omp/agents', when: 'workspaceUnder', evidence: 'verified' }] },
    },
    mcp: {
      user: { format: 'claude', reads: [{ base: 'home', path: '.omp/agent/mcp.json', evidence: 'verified' }] },
      project: { format: 'claude', reads: [{ base: 'project', path: '.omp/mcp.json', when: 'cwdOnly', evidence: 'verified' }] },
    },
    hooks: { user: { channel: 'adapter', adapter: 'omp-extension', evidence: 'verified' }, self: 'user' },
    sessions: 'none',
    launch: 'omp',
    features: {
      env: '✓s',
      workflows: '+s',
      recall: '✓v',
      stats: { cell: '✓t', note: 'A1 (#1245) records its skill loads; not rerun' },
      aiBackend: '✓d',
      votesJudge: '?',
      sessionJudge: { cell: '✓s', note: 'the task tool starts each child as a new agent session (omp 18.12.6); not run' },
      agentHooks: '—t',
    },
  },
  pi: {
    home: { dir: '.pi', moves: { root: '.pi/agent', by: [{ kind: 'env', name: 'PI_CODING_AGENT_DIR', evidence: 'verified' }], defaultHomeLeftovers: true } },
    skillLoad: { calls: [], promptForm: 'skill-block' },
    skills: {
      user: [{ base: 'home', path: '.pi/agent/skills', evidence: 'verified' }],
      project: [{ base: 'project', path: '.pi/skills', when: 'cwdOnly', evidence: 'verified' }],
    },
    rules: {
      user: { channel: 'inline', label: 'Pi AGENTS.md' },
      project: { channel: 'extension', probe: 'pi-extension', evidence: 'verified' },
    },
    blocks: {
      user: { channel: 'file', file: { in: 'claudemd' }, reads: [{ base: 'home', path: '.pi/agent/AGENTS.override.md', evidence: 'verified' }, { base: 'home', path: '.pi/agent/AGENTS.md', evidence: 'verified' }] },
      project: { channel: 'extension', probe: 'pi-extension', evidence: 'verified' },
      retired: { project: ['AGENTS.md'] },
    },
    agents: NONE,
    mcp: {
      user: { format: 'pi', reads: [{ base: 'home', path: '.pi/agent/mcp.json', evidence: 'verified' }] },
      project: { format: 'pi', reads: [{ base: 'project', path: '.pi/mcp.json', when: 'cwdOnly', evidence: 'verified' }] },
    },
    hooks: { user: { channel: 'adapter', adapter: 'pi-extension', evidence: 'verified' }, self: 'user' },
    // Pi 0.99: <ts>_<uuid>.jsonl under ~/.pi/agent/sessions/<cwd>, moved by PI_CODING_AGENT_SESSION_DIR or PI_CODING_AGENT_DIR.
    sessions: 'none',
    launch: 'pi',
    features: {
      env: '✓s',
      workflows: '+v',
      recall: '✓v',
      stats: { cell: '✓t', note: 'A1 (#1245) records its skill loads; not rerun' },
      aiBackend: '✓s',
      votesJudge: '?',
      sessionJudge: { cell: '◐s', note: 'bare Pi starts no subagent, so its session answers h4 and does not judge; the subagent example extension adds one (since 0.24.0); not run' },
      agentHooks: '?',
    },
  },
  // Model switching follows the same recorded home for models.json.
  // The CodeBuddy IDE sends `skill` (src/utils/tool-names.ts). CODEBUDDY_CONFIG_DIR replaces ~/.codebuddy, and ~/.codebuddy.json moves into it.
  codebuddy: {
    home: { dir: '.codebuddy', moves: { by: [{ kind: 'env', name: 'CODEBUDDY_CONFIG_DIR', evidence: 'verified' }], defaultHomeLeftovers: true } },
    skillLoad: { calls: [{ name: 'Skill', evidence: 'verified' }, { name: 'skill', evidence: 'assumed' }] },
    skills: { user: [{ base: 'home', path: '.codebuddy/skills', evidence: 'verified' }], project: 'unknown' },
    rules: {
      user: { channel: 'dir', format: 'codebuddy', reads: [{ base: 'home', path: '.codebuddy/rules', evidence: 'verified' }] },
      project: { channel: 'dir', format: 'codebuddy', reads: [{ base: 'project', path: '.codebuddy/rules', when: 'cwdOnly', evidence: 'source' }] },
    },
    blocks: {
      user: { channel: 'file', file: { in: 'claudemd' }, reads: [{ base: 'home', path: '.codebuddy/CODEBUDDY.md', evidence: 'source' }] },
      // WorkBuddy's project entry names the same file: one copy.
      project: {
        channel: 'file', file: { in: 'rules-dir', name: 'teamai-context.md', dir: '.codebuddy/rules', owned: true, header: 'always-apply' },
        reads: [{ base: 'project', path: '.codebuddy/rules', when: 'cwdOnly', evidence: 'source' }],
      },
      retired: { project: ['.codebuddy/CODEBUDDY.md'] },
    },
    agents: {
      user: { reads: [{ base: 'home', path: '.codebuddy/agents', evidence: 'source' }] },
      project: { reads: [{ base: 'project', path: '.codebuddy/agents', when: 'cwdOnly', evidence: 'source' }] },
    },
    mcp: {
      user: {
        format: 'buddy',
        reads: [{ base: 'home', firstOf: ['.codebuddy/.mcp.json', '.codebuddy/mcp.json', { in: 'codebuddy-config-dir', path: '.codebuddy.json' }], evidence: 'source' }],
      },
      project: {
        format: 'buddy',
        localScope: { file: { in: 'codebuddy-config-dir', path: '.codebuddy.json' }, key: 'realpath' },
        reads: [{ base: 'project', firstOf: ['.mcp.json', 'mcp.json'], when: 'cwdOnly', evidence: 'source' }],
      },
    },
    hooks: { user: { channel: 'settings', format: 'claude', reads: [{ base: 'home', path: '.codebuddy/settings.json', evidence: 'source' }] }, self: { channel: 'settings', format: 'claude', reads: [{ base: 'project', path: '.codebuddy/settings.json', when: 'cwdOnly', evidence: 'source' }] } },
    sessions: ['codebuddy'],
    launch: 'codebuddy',
    features: {
      env: '?',
      workflows: '✓d',
      recall: '✓s',
      stats: '✓v',
      aiBackend: '✓d',
      votesJudge: '+v',
      sessionJudge: { cell: '✓t', note: '#1386 the session judges its skill-driven run; not rerun' },
      agentHooks: '✓s',
    },
  },
  // Hermes (`skill_view`) and OpenClaw (`skills_read`) have skill tools, but teamai installs no post-tool-use hook for them yet.
  // OpenClaw's skills sit in its workspace.
  openclaw: {
    home: {
      dir: '.openclaw',
      // docs.openclaw.ai/help/environment; OPENCLAW_STATE_DIR and OPENCLAW_PROFILE also in src/config/paths.ts at 884a96d1.
      moves: { by: [{ kind: 'openclaw-state', evidence: 'docs' }] },
    },
    skillLoad: 'unknown',
    skills: UNKNOWN_READS,
    skillsFollowSession: true,
    rules: { user: { channel: 'inline', label: 'OpenClaw workspace AGENTS.md' }, project: 'none' },
    blocks: {
      user: { channel: 'file', file: { in: 'openclaw-workspace', name: 'AGENTS.md' }, reads: 'unknown' },
      // OpenClaw's only project file is the shared AGENTS.md; it reads no project .openclaw/workspace (#946).
      project: 'none',
      retired: { project: ['.openclaw/workspace/AGENTS.md'] },
    },
    agents: NONE,
    mcp: NONE,
    hooks: { user: { channel: 'adapter', adapter: 'openclaw-hook', evidence: 'verified' }, self: 'user' },
    // OpenClaw 2026.10: rows in ~/.openclaw/agents/<id>/agent/openclaw-agent.sqlite, moved by OPENCLAW_STATE_DIR.
    sessions: 'none',
    launch: 'openclaw',
    features: {
      env: '◐d',
      workflows: '+d',
      recall: '✓s',
      stats: '+s',
      aiBackend: '✓d',
      votesJudge: '—t',
      sessionJudge: { cell: '◐s', note: 'sessions_spawn with isolated context, in the coding and messaging tool profiles; a tool policy can remove it; not run' },
      agentHooks: '◐s',
    },
  },
  // hermes_constants.py and hermes_cli/main.py at 68134629 (the same rules at 7e9eb8d9). Hermes reads its home in either scope.
  // Out of teamai's sight: another process's -p/--profile flag, and the supervised, desktop SSH and s6 gateway starts that skip active_profile.
  hermes: {
    home: { dir: '.hermes', moves: { by: [{ kind: 'hermes-home', evidence: 'source' }] } },
    skillLoad: 'unknown',
    skills: {
      user: [{ base: 'home', path: '.hermes/skills', evidence: 'source' }],
      project: [{ base: 'home', path: '.hermes/skills', evidence: 'source' }],
    },
    rules: { user: { channel: 'inline', label: 'Hermes SOUL.md' }, project: 'none' },
    blocks: {
      user: { channel: 'file', file: { in: 'home', path: '.hermes/SOUL.md' }, reads: [{ base: 'home', path: '.hermes/SOUL.md', evidence: 'source' }] },
      // Hermes reads the project's AGENTS.md itself; teamai's plugin adds the blocks as a system prompt section.
      project: { channel: 'plugin', probe: 'hermes-plugin', limit: 4000, evidence: 'source' },
      retired: { user: ['AGENTS.md'], project: ['AGENTS.md'] },
    },
    agents: NONE,
    mcp: NONE,
    hooks: { user: { channel: 'adapter', adapter: 'hermes-plugin', evidence: 'verified' }, self: 'user' },
    sessions: 'none',
    launch: 'hermes',
    features: {
      env: '◐s',
      workflows: '+s',
      recall: '✓v',
      stats: '+s',
      aiBackend: '✓s',
      votesJudge: '—t',
      sessionJudge: { cell: '✓s', note: 'delegate_task starts a child agent with a fresh conversation; not run' },
      agentHooks: { cell: '✓t', note: '#1224 maps the events to Hermes\'s; not rerun' },
    },
  },
  dsh: {
    home: { dir: '.dsh', moves: { by: [{ kind: 'env', name: 'DSH_HOME', evidence: 'source' }] } },
    skillLoad: { calls: [{ name: 'skill', evidence: 'verified' }] },
    skills: { user: [{ base: 'home', path: '.dsh/skills', evidence: 'verified' }], project: 'unknown' },
    rules: {
      user: { channel: 'inline', label: 'DeepSeek Harness AGENTS.md' },
      project: { channel: 'session-hook', probe: 'dsh-session-start', evidence: 'source' },
    },
    blocks: {
      user: { channel: 'file', file: { in: 'home', path: '.dsh/AGENTS.md' }, reads: [{ base: 'home', path: '.dsh/AGENTS.md', evidence: 'source' }] },
      project: { channel: 'session-hook', probe: 'dsh-session-start', evidence: 'source' },
    },
    agents: NONE,
    mcp: NONE,
    hooks: { user: { channel: 'adapter', adapter: 'dsh-hooks', evidence: 'source' }, self: 'user' },
    sessions: 'none',
    launch: 'none',
    features: {
      env: '✗s',
      workflows: '+s',
      recall: '✓s',
      stats: { cell: '✓t', note: 'A1 (#1245) records its skill loads; not rerun' },
      aiBackend: '+s',
      votesJudge: '?',
      sessionJudge: { cell: '◐s', note: 'the subagent tool with the fresh spawn backend, not fork; the minimal preset leaves it out; not run' },
      agentHooks: '—t',
    },
  },
  // CodeBuddy engine 2.168.0; the WorkBuddy launcher's binding of ~/.workbuddy is not certified.
  workbuddy: {
    home: { dir: '.workbuddy' },
    installedBy: 'own-root',
    skillLoad: { calls: [{ name: 'Skill', evidence: 'source' }, { name: 'skill', evidence: 'assumed' }] },
    skills: UNKNOWN_READS,
    rules: {
      user: { channel: 'dir', format: 'codebuddy', reads: [{ base: 'home', path: '.workbuddy/rules', evidence: 'assumed' }] },
      project: { channel: 'dir', format: 'codebuddy', reads: 'unknown' },
    },
    blocks: {
      user: {
        channel: 'file', file: { in: 'rules-dir', name: 'teamai-context.md', owned: true, header: 'always-apply' },
        reads: [{ base: 'home', path: '.workbuddy/rules', evidence: 'assumed' }],
      },
      // CodeBuddy's engine reads the project's .codebuddy/rules, so WorkBuddy shares CodeBuddy's copy there.
      project: { channel: 'file', file: { in: 'rules-dir', name: 'teamai-context.md', dir: '.codebuddy/rules', owned: true, header: 'always-apply' }, reads: 'unknown' },
      retired: { user: ['AGENTS.md'], project: ['AGENTS.md'] },
    },
    agents: {
      user: { reads: [{ base: 'home', path: '.workbuddy/agents', evidence: 'assumed' }] },
      project: { reads: [{ base: 'project', path: '.workbuddy/agents', when: 'cwdOnly', evidence: 'assumed' }] },
    },
    mcp: {
      user: {
        format: 'buddy',
        reads: [{ base: 'home', firstOf: ['.workbuddy/.mcp.json', '.workbuddy/mcp.json', { in: 'codebuddy-config-dir', path: '.codebuddy.json' }], evidence: 'source' }],
      },
      project: {
        format: 'buddy',
        localScope: { file: { in: 'codebuddy-config-dir', path: '.codebuddy.json' }, key: 'realpath' },
        reads: [{ base: 'project', firstOf: ['.mcp.json', 'mcp.json'], when: 'cwdOnly', evidence: 'source' }],
      },
      retired: { project: ['.workbuddy/mcp.json'] },
    },
    hooks: { user: { channel: 'settings', format: 'claude', reads: [{ base: 'home', path: '.workbuddy/settings.json', evidence: 'assumed' }] }, self: { channel: 'settings', format: 'claude', reads: 'unknown' } },
    sessions: ['workbuddy'],
    launch: 'codebuddy',
    features: {
      env: '?',
      workflows: '✓t',
      recall: '✓t',
      stats: '?',
      aiBackend: '✓t',
      votesJudge: '?',
      sessionJudge: { cell: '✓t', note: 'CodeBuddy\'s engine, whose session judges its skill-driven run; not run' },
      agentHooks: '?',
    },
  },
  // opencode v2.1.1 Global.Path: OPENCODE_CONFIG_DIR, else (XDG_CONFIG_HOME || ~/.config)/opencode.
  opencode: {
    home: {
      dir: '.config/opencode',
      moves: { by: [{ kind: 'env', name: 'OPENCODE_CONFIG_DIR', evidence: 'source' }, { kind: 'xdg', child: 'opencode', evidence: 'source' }], defaultHomeLeftovers: true },
    },
    skillLoad: { calls: [{ name: 'skill', evidence: 'verified' }] },
    skills: {
      user: [{ base: 'home', path: '.config/opencode/skills', evidence: 'verified' }, { base: 'home', path: '.claude/skills', evidence: 'verified' }],
      project: [
        { base: 'project', path: '.opencode/skills', when: 'workspaceUnder', evidence: 'verified' },
        { base: 'project', path: '.claude/skills', when: 'workspaceUnder', evidence: 'verified' },
      ],
    },
    // OpenCode scans no rules directory: the `instructions` glob in its config file loads it.
    rules: {
      user: {
        channel: 'dir', format: 'verbatim', activation: { key: 'instructions', in: 'mcp-file' },
        reads: [{ base: 'home', path: '.config/opencode/rules', evidence: 'verified' }],
      },
      project: {
        channel: 'dir', format: 'verbatim', activation: { key: 'instructions', in: 'project', path: '.opencode/opencode.json' },
        reads: [{ base: 'project', path: '.opencode/rules', when: 'workspaceUnder', evidence: 'verified' }],
      },
    },
    blocks: {
      user: {
        channel: 'file', file: { in: 'home', path: '.config/opencode/teamai-context.md', owned: true }, activation: { key: 'instructions', in: 'mcp-file' },
        reads: [{ base: 'home', path: '.config/opencode/teamai-context.md', evidence: 'verified' }],
      },
      project: {
        channel: 'file', file: { in: 'project', path: '.opencode/teamai-context.md', owned: true },
        activation: { key: 'instructions', in: 'project', path: '.opencode/opencode.json' },
        reads: [{ base: 'project', path: '.opencode/teamai-context.md', when: 'workspaceUnder', evidence: 'verified' }],
      },
    },
    agents: {
      user: { reads: [{ base: 'home', path: '.config/opencode/agents', evidence: 'verified' }] },
      project: { reads: [{ base: 'project', path: '.opencode/agents', when: 'workspaceUnder', evidence: 'verified' }] },
    },
    mcp: {
      user: { format: 'opencode', reads: [{ base: 'home', path: '.config/opencode/opencode.json', evidence: 'verified' }] },
      project: {
        format: 'opencode', alternate: { path: '.opencode/teamai-mcp.json', when: 'opencode-v2-plugin' },
        reads: [
          { base: 'project', path: 'opencode.json', when: 'workspaceUnder', evidence: 'verified' },
          { base: 'project', path: '.opencode/teamai-mcp.json', when: 'workspaceUnder', evidence: 'verified' },
        ],
      },
    },
    hooks: { user: { channel: 'adapter', adapter: 'opencode-plugin', evidence: 'source' }, self: 'user' },
    sessions: ['opencode'],
    launch: 'opencode',
    features: {
      env: '?',
      workflows: '✓t',
      recall: '✓v',
      stats: { cell: '✓t', note: 'A1 (#1245) records its skill loads; not rerun' },
      aiBackend: '✓v',
      votesJudge: '?',
      sessionJudge: { cell: '✓t', note: '#1386 the session judges its skill-driven run; not rerun' },
      agentHooks: '◐t',
    },
  },
  // muse-bin 1.4.11: $XDG_CONFIG_HOME/muse, else ~/.config/muse; with XDG_CONFIG_HOME set, ~/.config/muse is never read.
  muse: {
    home: { dir: '.config/muse', moves: { by: [{ kind: 'xdg', child: 'muse', evidence: 'source' }], defaultHomeLeftovers: true } },
    installedBy: 'home',
    skillLoad: { calls: [{ name: 'read_skill', evidence: 'verified' }] },
    skills: {
      user: [
        { base: 'home', path: '.config/muse/skills', evidence: 'verified' },
        { base: 'home', path: '.agents/skills', evidence: 'verified' },
        { base: 'home', path: '.claude/skills', evidence: 'verified' },
      ],
      project: [{ base: 'project', path: '.agents/skills', when: 'workspaceUnder', evidence: 'verified' }],
    },
    rules: {
      user: { channel: 'inline', label: 'Muse Code AGENTS.md' },
      project: { channel: 'session-hook', probe: 'muse-session-start', evidence: 'verified' },
    },
    blocks: {
      user: { channel: 'file', file: { in: 'home', path: '.config/muse/AGENTS.md' }, reads: [{ base: 'home', path: '.config/muse/AGENTS.md', evidence: 'verified' }] },
      project: { channel: 'session-hook', probe: 'muse-session-start', evidence: 'verified' },
    },
    agents: {
      user: { reads: [{ base: 'home', path: '.config/muse/agents', evidence: 'source' }] },
      project: { reads: 'unknown' },
    },
    mcp: {
      user: { format: 'muse', reads: [{ base: 'home', path: '.config/muse/settings.json', evidence: 'source' }] },
      project: { format: 'muse', writtenBy: 'claude', reads: [{ base: 'project', path: '.mcp.json', when: 'workspaceUnder', evidence: 'source' }] },
    },
    // Muse takes Codex's hook shape: it drops a group carrying any key but `matcher` and `hooks`, so Claude's described groups never reach it.
    hooks: { user: { channel: 'settings', format: 'codex', reads: [{ base: 'home', path: '.config/muse/settings.json', evidence: 'verified' }] }, self: { channel: 'settings', format: 'codex', reads: [{ base: 'project', path: '.muse/hooks.json', when: 'workspaceUnder', evidence: 'verified' }] } },
    sessions: 'none',
    launch: 'muse',
    features: {
      env: '✓t',
      workflows: '+v',
      recall: '✓t',
      stats: '✓v',
      aiBackend: '✓v',
      votesJudge: { cell: '✓t', note: '#1374 judges the reply in its Stop payload; not rerun' },
      sessionJudge: { cell: '✓t', note: '#1386 the session judges its skill-driven run; not rerun' },
      agentHooks: { cell: '✓t', note: '#1224 writes them to settings.json; not rerun' },
    },
  },
} as const satisfies Record<ToolId, ToolDescriptor>;

export function isToolId(value: string): value is ToolId {
  return Object.hasOwn(TOOLS, value);
}

/** Whether releases before #1221 wrote `tool`'s hooks and MCP servers under its default home when the home moved (`Home.moves.defaultHomeLeftovers`). */
export function hasDefaultHomeLeftovers(tool: ToolId): boolean {
  const { home }: ToolDescriptor = TOOLS[tool];
  return home.moves?.defaultHomeLeftovers === true;
}

/** The env variables that move `tool`'s home (`Home.moves.by`): a tool's own, and `XDG_CONFIG_HOME` for an XDG home. `LOCALAPPDATA` is not one: it is where Windows keeps a home that did not move. */
export function homeVariables(tool: ToolId): readonly string[] {
  const { home }: ToolDescriptor = TOOLS[tool];
  return (home.moves?.by ?? []).flatMap((move): string[] => {
    switch (move.kind) {
      case 'env':
        return [move.name];
      case 'xdg':
        return ['XDG_CONFIG_HOME'];
      case 'openclaw-state':
        return ['OPENCLAW_STATE_DIR', 'OPENCLAW_HOME', 'OPENCLAW_PROFILE'];
      case 'omp-agent':
        return ['OMP_PROFILE', 'PI_PROFILE', 'PI_CONFIG_DIR'];
      case 'hermes-home':
        return ['HERMES_HOME', 'HERMES_DATA_DIR_SUFFIX'];
      default: {
        const unhandled: never = move;
        return unhandled;
      }
    }
  });
}

/** Whether where `tool` takes skills follows each session's inputs (`ToolDescriptor.skillsFollowSession`). */
export function skillsFollowSession(tool: string): boolean {
  if (!isToolId(tool)) return false;
  const descriptor: ToolDescriptor = TOOLS[tool];
  return descriptor.skillsFollowSession === true;
}

/** What says `tool` is installed beyond its configured paths, if anything (`InstallGate`). */
export function installGateOf(tool: ToolId): InstallGate | undefined {
  const descriptor: ToolDescriptor = TOOLS[tool];
  return descriptor.installedBy;
}

type Entry<T extends ToolId> = (typeof TOOLS)[T];

/** A tool whose user rules are `inline` and that has no user blocks file to hold them. `never` while every tool has one. */
export type InlineRulesWithoutBlocksFile = {
  [T in ToolId]: Entry<T>['rules']['user'] extends { readonly channel: 'inline' }
    ? (Entry<T>['blocks']['user'] extends { readonly channel: 'file' } ? never : T) : never
}[ToolId];

/** A tool whose two scopes name different MCP formats. `never` while each tool has one (`mcpFormatOf`). */
export type ToolsWithTwoMcpFormats = {
  [T in ToolId]: Entry<T>['mcp']['user'] extends { readonly format: infer U }
    ? (Entry<T>['mcp']['project'] extends { readonly format: infer P } ? ([U] extends [P] ? ([P] extends [U] ? never : T) : T) : never)
    : never
}[ToolId];

/** Tools teamai renders agents for in either scope: what `renderForTool` takes. */
export type AgentToolId = {
  [T in ToolId]: Entry<T>['agents'] extends { readonly user: 'none' | 'unknown'; readonly project: 'none' | 'unknown' } ? never : T
}[ToolId];

/** The session platforms teamai reads for `tool`, first the one its launched sessions write; none for a custom tool id. */
export function sessionPlatformsOf(tool: string): readonly SessionPlatform[] {
  if (!isToolId(tool)) return [];
  const { sessions }: ToolDescriptor = TOOLS[tool];
  return typeof sessions === 'string' ? [] : sessions;
}

/** The tool whose `sessions` lists `platform`, if one does. */
export function sessionPlatformOwner(platform: string): ToolId | undefined {
  return Object.keys(TOOLS).filter(isToolId).find((tool) => sessionPlatformsOf(tool).some((listed) => listed === platform));
}

const CUSTOM_TOOL = {
  rules: { user: { channel: 'dir', format: 'verbatim', reads: 'unknown' }, project: { channel: 'dir', format: 'verbatim', reads: 'unknown' } },
  blocks: { user: { channel: 'file', file: { in: 'claudemd' }, reads: 'unknown' }, project: { channel: 'file', file: { in: 'claudemd' }, reads: 'unknown' } },
  agents: NONE,
  mcp: NONE,
  // A custom tool with a configured `settings` file takes Claude-shaped hooks there, as it always has.
  hooks: { user: { channel: 'settings', format: 'claude', reads: 'unknown' }, self: { channel: 'settings', format: 'claude', reads: 'unknown' } },
} as const satisfies Pick<ToolDescriptor, 'rules' | 'blocks' | 'agents' | 'mcp' | 'hooks'>;

/** The channels of `tool`: its descriptor's, or `CUSTOM_TOOL`'s for a custom tool id. */
export function channelsOf(tool: string): Pick<ToolDescriptor, 'rules' | 'blocks' | 'agents' | 'mcp' | 'hooks'> {
  return isToolId(tool) ? TOOLS[tool] : CUSTOM_TOOL;
}

/** Whether teamai renders agents for `tool` in either scope (`AgentToolId`). */
export function isAgentToolId(tool: string): tool is AgentToolId {
  if (!isToolId(tool)) return false;
  const { agents }: ToolDescriptor = TOOLS[tool];
  return [agents.user, agents.project].some((channel) => channel !== 'none' && channel !== 'unknown');
}

/** Every tool teamai renders agents for, in `TOOLS` order. */
export const AGENT_TOOLS: readonly AgentToolId[] = Object.keys(TOOLS).filter(isAgentToolId);

/** The format `tool`'s rule files take in either scope: its rules format, or the team `.md` verbatim. */
export function ruleFormatIdOf(tool: string): RuleFormatId | 'verbatim' {
  const { rules } = channelsOf(tool);
  for (const channel of [rules.user, rules.project]) {
    if (typeof channel === 'object' && channel.channel === 'dir') return channel.format;
  }
  return 'verbatim';
}

/** How a project's team rules reach `tool` at run time, if they do. */
export function runTimeRulesOf(tool: string): RunTimeVia | null {
  const { project } = channelsOf(tool).rules;
  if (typeof project !== 'object') return null;
  switch (project.channel) {
    case 'dir':
      return null;
    case 'session-hook':
    case 'extension':
    case 'plugin':
      return project.channel;
    default: {
      const unhandled: never = project;
      return unhandled;
    }
  }
}

/** The format of `tool`'s hook settings file in either scope; null when it reads none (an adapter, `none` or `unknown`). A custom tool reads Claude's. */
export function hookSettingsFormatOf(tool: string): HookFormat | null {
  const { hooks } = channelsOf(tool);
  for (const channel of [hooks.user, hooks.self]) if (typeof channel === 'object' && channel.channel === 'settings') return channel.format;
  return null;
}

/** The shape teamai reads and writes `tool`'s hook file in: its settings format, else Claude's, which the DeepSeek Harness adapter writes and an earlier release wrote for a tool that reads none. */
export function hookFormatOf(tool: string): HookFormat {
  return hookSettingsFormatOf(tool) ?? 'claude';
}

/** The format `tool`'s MCP servers take in either scope; null when it has an MCP channel in neither. */
export function mcpFormatOf(tool: string): McpFormat | null {
  const { mcp } = channelsOf(tool);
  for (const channel of [mcp.user, mcp.project]) if (typeof channel === 'object') return channel.format;
  return null;
}
