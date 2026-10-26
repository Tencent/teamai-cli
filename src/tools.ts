import type { McpFormat } from './resources/mcp-format.js';
import type { RuleFormatId } from './resources/rule-format.js';
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
  /** `%LOCALAPPDATA%\<child>` on Windows, whatever the env says. */
  | { readonly kind: 'win32-appdata'; readonly child: string; readonly evidence: Evidence }
  /** `~/<dir>-<value>` for a value other than `default`. */
  | { readonly kind: 'profile-suffix'; readonly name: string; readonly evidence: Evidence };

/**
 * `dir` is relative to `$HOME`. The first of `moves.by` that applies moves the
 * home; `moves.root` is the `$HOME`-relative directory a move replaces when it
 * is not `dir` (Pi's variable moves `.pi/agent`). `moves.settingsAtDefault`:
 * teamai still writes the tool's hooks (OpenCode's plugin, Pi's extension,
 * Muse's and CodeBuddy's settings.json hooks) and `models switch` settings under the default
 * home when the home moves, until B4 of #1221 moves them too.
 */
export type Home = {
  readonly dir: string;
  readonly moves?: { readonly root?: string; readonly by: readonly HomeMove[]; readonly settingsAtDefault?: true };
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
  },
  'claude-internal': {
    home: { dir: '.claude-internal' },
    skillLoad: { calls: [{ name: 'Skill', evidence: 'assumed' }] },
    skills: UNKNOWN_READS,
    rules: { user: { channel: 'dir', format: 'verbatim', reads: 'unknown' }, project: { channel: 'dir', format: 'verbatim', reads: 'unknown' } },
    blocks: { user: { channel: 'file', file: { in: 'claudemd' }, reads: 'unknown' }, project: { channel: 'file', file: { in: 'claudemd' }, reads: 'unknown' } },
    agents: { user: { reads: 'unknown' }, project: { reads: 'unknown' } },
    mcp: UNKNOWN,
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
    agents: UNKNOWN,
    mcp: {
      user: 'none',
      project: { format: 'claude', reads: [{ base: 'project', path: '.trae/mcp.json', when: 'workspaceUnder', evidence: 'docs' }] },
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
    agents: UNKNOWN,
    mcp: {
      user: 'none',
      project: { format: 'claude', reads: [{ base: 'project', path: '.trae/mcp.json', when: 'workspaceUnder', evidence: 'docs' }] },
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
  },
  // Extensions capture the installed Node/CLI launcher instead of depending on the host PATH.
  omp: {
    home: { dir: '.omp' },
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
  },
  pi: {
    home: { dir: '.pi', moves: { root: '.pi/agent', by: [{ kind: 'env', name: 'PI_CODING_AGENT_DIR', evidence: 'verified' }], settingsAtDefault: true } },
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
      user: { channel: 'file', file: { in: 'claudemd' }, reads: [{ base: 'home', path: '.pi/agent/AGENTS.md', evidence: 'verified' }] },
      project: { channel: 'extension', probe: 'pi-extension', evidence: 'verified' },
      retired: { project: ['AGENTS.md'] },
    },
    agents: NONE,
    mcp: {
      user: { format: 'pi', reads: [{ base: 'home', path: '.pi/agent/mcp.json', evidence: 'verified' }] },
      project: { format: 'pi', reads: [{ base: 'project', path: '.pi/mcp.json', when: 'cwdOnly', evidence: 'verified' }] },
    },
  },
  // Model switching follows the same recorded home for models.json.
  // The CodeBuddy IDE sends `skill` (src/utils/tool-names.ts). CODEBUDDY_CONFIG_DIR replaces ~/.codebuddy, and ~/.codebuddy.json moves into it.
  codebuddy: {
    home: { dir: '.codebuddy', moves: { by: [{ kind: 'env', name: 'CODEBUDDY_CONFIG_DIR', evidence: 'verified' }], settingsAtDefault: true } },
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
  },
  // Hermes (`skill_view`) and OpenClaw (`skills_read`) have skill tools, but teamai installs no post-tool-use hook for them yet.
  // OpenClaw's skills sit in its workspace.
  openclaw: {
    home: {
      dir: '.openclaw',
      moves: { by: [{ kind: 'env', name: 'OPENCLAW_STATE_DIR', evidence: 'source' }, { kind: 'profile-suffix', name: 'OPENCLAW_PROFILE', evidence: 'source' }] },
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
  },
  // hermes_constants.py: HERMES_HOME, else %LOCALAPPDATA%\hermes on Windows, else ~/.hermes. Hermes reads it in either scope.
  hermes: {
    home: {
      dir: '.hermes',
      moves: { by: [{ kind: 'env', name: 'HERMES_HOME', evidence: 'source' }, { kind: 'win32-appdata', child: 'hermes', evidence: 'source' }] },
    },
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
  },
  // opencode v2.1.1 Global.Path: OPENCODE_CONFIG_DIR, else (XDG_CONFIG_HOME || ~/.config)/opencode.
  opencode: {
    home: {
      dir: '.config/opencode',
      moves: { by: [{ kind: 'env', name: 'OPENCODE_CONFIG_DIR', evidence: 'source' }, { kind: 'xdg', child: 'opencode', evidence: 'source' }], settingsAtDefault: true },
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
  },
  // muse-bin 1.4.11: $XDG_CONFIG_HOME/muse, else ~/.config/muse; with XDG_CONFIG_HOME set, ~/.config/muse is never read.
  muse: {
    home: { dir: '.config/muse', moves: { by: [{ kind: 'xdg', child: 'muse', evidence: 'source' }], settingsAtDefault: true } },
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
  },
} as const satisfies Record<ToolId, ToolDescriptor>;

export function isToolId(value: string): value is ToolId {
  return Object.hasOwn(TOOLS, value);
}

/** Whether teamai still writes `tool`'s hooks and settings under its default home when the home moves (`Home.moves.settingsAtDefault`). */
export function settingsAtDefault(tool: ToolId): boolean {
  const { home }: ToolDescriptor = TOOLS[tool];
  return home.moves?.settingsAtDefault === true;
}

/** The env variables that move `tool`'s home (`Home.moves.by`): a tool's own, and `XDG_CONFIG_HOME` for an XDG home. */
export function homeVariables(tool: ToolId): readonly string[] {
  const { home }: ToolDescriptor = TOOLS[tool];
  return (home.moves?.by ?? []).flatMap((move): string[] => {
    switch (move.kind) {
      case 'env':
      case 'profile-suffix':
        return [move.name];
      case 'xdg':
        return ['XDG_CONFIG_HOME'];
      case 'win32-appdata':
        return [];
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

const CUSTOM_TOOL = {
  rules: { user: { channel: 'dir', format: 'verbatim', reads: 'unknown' }, project: { channel: 'dir', format: 'verbatim', reads: 'unknown' } },
  blocks: { user: { channel: 'file', file: { in: 'claudemd' }, reads: 'unknown' }, project: { channel: 'file', file: { in: 'claudemd' }, reads: 'unknown' } },
  agents: NONE,
  mcp: NONE,
} as const satisfies Pick<ToolDescriptor, 'rules' | 'blocks' | 'agents' | 'mcp'>;

/** The four channels of `tool`: its descriptor's, or `CUSTOM_TOOL`'s for a custom tool id. */
export function channelsOf(tool: string): Pick<ToolDescriptor, 'rules' | 'blocks' | 'agents' | 'mcp'> {
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

/** The format `tool`'s MCP servers take in either scope; null when it has an MCP channel in neither. */
export function mcpFormatOf(tool: string): McpFormat | null {
  const { mcp } = channelsOf(tool);
  for (const channel of [mcp.user, mcp.project]) if (typeof channel === 'object') return channel.format;
  return null;
}
