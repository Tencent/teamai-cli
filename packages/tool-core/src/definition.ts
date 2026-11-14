import type { JsonSyntax } from '@teamai/shared/json';

/** The MCP config formats teamai writes (`src/resources/mcp-format.ts`); a tool's MCP channel names one. */
export type McpFormat = 'claude' | 'cursor' | 'buddy' | 'codex' | 'opencode' | 'copilot' | 'pi' | 'muse' | 'agy' | 'openclaw' | 'hermes' | 'dsh';

/** The rule file formats teamai renders a team rule in (`src/resources/rule-format.ts`); a tool's rules directory names one, or takes the team `.md` verbatim. */
export type RuleFormatId = 'cursor-mdc' | 'joycode' | 'copilot-instructions' | 'kiro-steering' | 'qoder' | 'trae' | 'codebuddy' | 'omp' | 'agy';

/**
 * The ids a descriptor names in tables a family or the app owns: other tools, its launch profile, its session
 * platforms and its token format. A family's own descriptors leave them `string`; the app's table of every tool narrows them to the
 * ids those tables declare, so a descriptor that names a missing row fails to compile.
 */
export interface DescriptorIds {
  /** A tool another tool's channel names, such as the tool whose MCP file a tool reads. */
  readonly tool: string;
  readonly launch: string;
  readonly platform: string;
  readonly tokens: string;
}

export type Evidence = 'verified' | 'source' | 'docs' | 'assumed';

/** The host's dedicated skill tool, by its raw name. */
export type SkillCall = { readonly name: string; readonly evidence: Evidence };

/**
 * How a prompt that loads a skill with no tool call reaches teamai: a `$name`
 * Codex resolves, the `<skill>` block Pi expands `/skill:name` into, the
 * `@command://name` the CodeBuddy plugin sends, or the `/name` most tools take.
 */
export type PromptForm = '$name' | 'skill-block' | 'command-uri' | '/name';

export type SkillLoad =
  | { readonly calls: readonly SkillCall[]; readonly promptForm?: PromptForm | readonly PromptForm[] }
  | 'unknown';

/** One way a machine moves a tool's home. */
export type HomeMove =
  | { readonly kind: 'env'; readonly name: string; readonly evidence: Evidence }
  /** Qoder: `QODER_CONFIG_DIR`, or `.qoder` inside `QODER_CLI_HOME`. */
  | { readonly kind: 'qoder-home'; readonly evidence: Evidence }
  /** Qoder CN: `QODERCN_CONFIG_DIR`, or `.qoder-cn` inside `QODERCN_CLI_HOME`. */
  | { readonly kind: 'qoder-cn-home'; readonly evidence: Evidence }
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
 * `stateFiles`: files beside `dir`, relative to `$HOME`, the tool writes its own state into, which stay after
 * `teamai uninstall` once teamai's part is out of them. `rootVariable`: the variable that moves the tool's whole root,
 * which `teamai init` records as `toolRoots` instead of following it live, and which teamai sets to start the tool in
 * a home (its launch profile's `homeEnv`).
 */
export type Home = {
  readonly dir: string;
  readonly rootVariable?: string;
  readonly stateFiles?: readonly string[];
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
  /** What the project reads wait on. */
  readonly readGates?: readonly ReadGateKind[];
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

/**
 * The tool's own verdict on a project that decides whether it reads what
 * teamai wrote there: its trust in the project, or its approval of the
 * project's MCP servers. `read-gates.ts` evaluates each one.
 */
export type ReadGateKind = 'codex-project-trust' | 'pi-project-trust' | 'muse-workspace-trust' | 'copilot-folder-trust' | 'qoder-folder-trust'
  | 'qoder-mcp-approval' | 'claude-mcp-approval' | 'codebuddy-mcp-approval' | 'cursor-mcp-approval' | 'claude-hooks-enabled'
  | 'openclaw-hooks-enabled' | 'openclaw-plugins-enabled';

/** The frontmatter teamai writes above its blocks when it creates an owned blocks file a rules loader reads. */
export type BlocksHeader = 'always-apply' | 'apply-to-all' | 'trigger-always-on' | 'inclusion-always';

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
  /** How the tool parses the file, when it takes more than strict JSON (`parseJsonAs`). */
  readonly syntax?: JsonSyntax;
  readonly reads: Reads<R>;
  readonly readGates?: readonly ReadGateKind[];
};

export type McpUser = McpCommon<HomeRead | FirstExistingRead>;

export type McpProject<TTool extends string = string> = McpCommon<HomeRead | ProjectRead | FirstExistingRead> & {
  /**
   * #915: while sharing.gitExclude is on or the workspace has children, the
   * servers go to `projects[key]` of this file, keyed as the tool files a
   * checkout (`git-common-root`: Claude Code; `realpath`: CodeBuddy).
   */
  readonly localScope?: { readonly file: 'user-mcp-file' | CodebuddyConfigFile; readonly key: 'git-common-root' | 'realpath' };
  /** OpenCode V2 takes a project's servers from teamai's own file through its plugin (#915). */
  readonly alternate?: { readonly path: string; readonly when: 'opencode-v2-plugin' };
  /** The tool reads another tool's project file and has none of its own: Muse and tclaude read claude's `.mcp.json`. */
  readonly writtenBy?: TTool;
  /**
   * Whether a project file holding only teamai's servers is judged teamai's (#915). Not for
   * Claude's and CodeBuddy's `.mcp.json`, whose servers have a per-member place outside the
   * project, or Qoder's `settings.json`, which also holds its settings.
   */
  readonly judgedTeamaiOnly: boolean;
};

export type McpChannels<TTool extends string = string> = Scoped<McpUser, McpProject<TTool>> & {
  /** Files earlier releases wrote the servers to, per scope: pull moves teamai's servers out of them. */
  readonly retired?: { readonly user?: readonly string[]; readonly project?: readonly string[] };
};

/** The shape of the hook list in a tool's hook file (`reconcileHooks`). */
export type HookFormat = 'claude' | 'cursor' | 'codex' | 'copilot' | 'zcode';

/** teamai's entries in the hook list of the scope's configured hook file (`toolPaths.settings`, Copilot's `toolPaths.hooks`), in `format`. */
export type HookSettings<R> = {
  readonly channel: 'settings';
  readonly format: HookFormat;
  readonly reads: Reads<R>;
  readonly readGates?: readonly ReadGateKind[];
  /** How the tool parses the file, when it takes more than strict JSON (`parseJsonAs`). */
  readonly syntax?: JsonSyntax;
};

/** A file or directory of teamai's own the tool loads from its home, written by the tool's own adapter. */
export type HookAdapterId = 'opencode-plugin' | 'pi-extension' | 'omp-extension' | 'hermes-plugin' | 'openclaw-hook' | 'dsh-hooks' | 'kiro-hooks' | 'agy-hooks';

export type HookAdapter = { readonly channel: 'adapter'; readonly adapter: HookAdapterId; readonly evidence: Evidence; readonly readGates?: readonly ReadGateKind[] };

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
  /**
   * Whether teamai's built-in SubagentStop hook goes in: the tool fires SubagentStop with the
   * parent's session id, so the recall reducer can credit a read a subagent made after the
   * session's last Stop (#884). Claude Code, Codex, CodeBuddy and Qoder document it, and their
   * internal builds share the format. The installed Codex 0.159 knows `SubagentStop`, and Codex
   * main's `HookEventsToml` (codex-rs/config/src/hook_config.rs) has no `deny_unknown_fields`, so
   * it skips an event key it does not know; how older hook-capable builds treat one is unverified
   * (a hooks.json Codex cannot parse is dropped whole). Not WorkBuddy, whose shipped engine version
   * is unverified; not Cursor or Copilot, whose subagents run in sessions of their own that no hook
   * links to the parent; not ZCode, which has no such event and rejects the whole hooks block on an
   * unknown key.
   */
  readonly subagentStop: boolean;
  /**
   * Whether the Stop hook takes the reply `formatStopHookOutput` writes. Otherwise the
   * share-learnings hint is stashed as pending state at Stop and injected on the next
   * UserPromptSubmit. CodeBuddy and WorkBuddy ignore Stop stdout, and Codex and Muse Code reject
   * Stop additionalContext. `false` costs a hint delivered one prompt late; a wrong `true` loses
   * it outright, as Codex ids missing from the old deny-list did (#719). So `true` only once the
   * tool's Stop handling is confirmed, for each id of a family: hook dispatch matches the raw
   * lowercase `--tool` literal, not its `normalizeAgentType`.
   */
  readonly stopReply: boolean;
  /** The shell hook commands run through: the tool's own bundled one (`src/bundled-runtime.ts`), or the system's `/bin/sh`. */
  readonly shell: 'bundled' | 'system';
  /**
   * Where a non-self project scope keeps the team's hooks: in the main checkout,
   * which every linked worktree reads (#955), or in HOME behind a `$PWD` gate.
   */
  readonly teamHooks: 'main-checkout' | 'home';
  /**
   * The environment variable the tool sets to the project's root when it runs a hook from a project file, if it has
   * one. A self-mode hook folder's command names the folder through it, so a project file the repository may
   * commit holds the same command in every worktree (#1787, common rule 10). Without one, the absolute path is written.
   */
  readonly projectDirVariable?: string;
  /**
   * Whether hook-dispatch needs the CLI bundle in the foreground before the
   * background child can take this tool's hook: it translates Antigravity CLI's
   * payload there, and claims each Copilot CLI event among the copies installed.
   * Every other tool's hook with nothing to print exits before the bundle loads
   * (#1788). src/hook-fast-path.ts keeps a copy of this list, which
   * hook-fast-path.test.ts checks against this field.
   */
  readonly needsBundle: boolean;
  /**
   * The first version of the tool whose command hooks take `"async": true` and are then not waited for, with no
   * side effect on a hook that prints nothing. Once the installed version reaches it, teamai writes its PostToolUse
   * built-in that way into the member's own hook file, on macOS and Linux only (`builtinHookForm`). Set on a run of
   * the real tool, or on its documentation together with its source read at the floor and at a later release; the
   * comment beside it says which. Absent: the tool has no such option, or neither shows it.
   */
  readonly unwaitedSince?: string;
  /**
   * Where the version compared with `unwaitedSince` comes from, and means nothing without it. Absent: the tool's
   * version detector. `codex-builds`: the oldest of the Codex builds that read the member's hook file, a build on PATH
   * and each desktop app's (`oldestCodexBuildVersion`), since one hook file serves them all.
   */
  readonly unwaitedVersionOf?: 'codex-builds';
  /**
   * Set when, on POSIX, the tool runs a hook's command string with a POSIX-compatible shell and `-c`, not a login
   * shell, so a built-in hook in the member's own hook file may start teamai without one and leave the login
   * environment to the background pass (`builtinHookForm`). Set on a run of the executor for a tool of its own, or,
   * for a variant, the original it is assumed to behave as, which shows the shell and its flags; source that picks
   * the shell may extend it to the platforms and versions the run did not cover. The comment beside it says which.
   * Absent: no run shows it.
   */
  readonly loginDeferrable?: true;
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
  /** The local driver runs a prompt step with `permissions: unattended` in the tool's own mode for editing and running commands without asking. */
  readonly unattended: Support;
  /** The recall skill and its session-start reminder. */
  readonly recall: Support;
  /** The tool's skill calls are recorded for usage stats. */
  readonly stats: Support;
  /** The dashboard reads the tokens and model of each of the tool's requests (`tokens`), and prices them. */
  readonly tokens: Support;
  /** teamai's own AI calls (enrich, codebase, import, maintenance) run on the tool's CLI (`src/workflow/runtimes/tool-caller.ts`). */
  readonly aiBackend: Support;
  /** With the skill driver and no verified judge of the tool here, the tool's session judges the workflow run it drives (#1386). */
  readonly sessionJudge: Support;
  /** The HTTP local agent installs server-pushed hooks for the tool. */
  readonly agentHooks: Support;
};

/**
 * How the tool reads the support files a user-scope rule or agent folder names through `${TEAMAI_RULE_DIR}` or
 * `${TEAMAI_AGENT_DIR}` (#1787), in the data home: `none`, without a prompt; `grant`, once teamai adds that directory to
 * `setting` in the tool's user settings; `copy`, not without a prompt, so pull warns once. In a project every tool reads
 * the folder in the worktree, `.teamai/delivered/<type>/`, a `copy` tool by its path from the project root. A tool with
 * no cell has no evidence, and gets `copy`.
 */
export type FolderReach =
  | { readonly reach: 'none'; readonly evidence: Evidence }
  | { readonly reach: 'grant'; readonly setting: 'permissions.additionalDirectories'; readonly evidence: Evidence }
  | { readonly reach: 'copy'; readonly evidence?: Evidence };

export type ToolDescriptor<TIds extends DescriptorIds = DescriptorIds> = {
  readonly home: Home;
  readonly skillLoad: SkillLoad;
  readonly skills: SkillReads;
  readonly installedBy?: InstallGate;
  /** HTTP delivery adds models to this tool's own model settings; it reads them like any member entry. */
  readonly receivesDeliveredModels?: true;
  /**
   * A team or member may add an instance of the tool (`tools/<name>.yaml` with `extends:` naming it): every path
   * teamai takes for the tool reaches an instance of it too. Any other tool is refused as `extends:`.
   */
  readonly instances?: true;
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
  /** How the tool reads a user-scope rule or agent folder's files; absent: `copy`, with no evidence. */
  readonly folderReach?: FolderReach;
  readonly blocks: BlocksChannels;
  readonly agents: AgentsChannels;
  readonly mcp: McpChannels<TIds['tool']>;
  readonly hooks: HooksChannels;
  /**
   * The session platforms teamai reads for the tool, first the one its
   * launched sessions write. `'none'`: the tool keeps sessions teamai has no
   * adapter for. `'unknown'`: where it keeps them is unknown.
   */
  readonly sessions: readonly [TIds['platform'], ...TIds['platform'][]] | 'none' | 'unknown';
  /** The adapter teamai launches the tool headless with (`LAUNCH_ADAPTERS` in `src/launch-registry.ts`), or `'none'` when teamai never launches it. */
  readonly launch: TIds['launch'] | 'none';
  /**
   * Where the dashboard reads the tool's token usage: a format of
   * `src/token-usage/`, or `copilot-shutdown`, the totals Copilot writes when
   * a session ends. `'none'`: teamai reads no usage of the tool. `'unknown'`:
   * where the tool keeps it is unknown.
   */
  readonly tokens: TIds['tokens'] | 'copilot-shutdown' | 'none' | 'unknown';
  /** The settings format teamai writes the team's auto-compact threshold in (`src/autocompact-reconcile.ts`), or `'none'`. */
  readonly autoCompact: 'claude' | 'buddy' | 'codex' | 'dsh' | 'none';
  /** Whether the tool's skills take `allowed-tools`, so a workflow skill with `invoke: allow` starts without a permission prompt. */
  readonly skillAllowedTools: boolean;
  /**
   * Whether a line rule reads the output of the tool's search tool as evidence of a read. Not
   * OMP, whose grep prints a markdown tree, or Cursor, whose Grep format is unverified. Shell
   * searches count either way.
   */
  readonly searchEvidence: boolean;
  /**
   * Whether the tool takes a project's team instructions through a channel in its home
   * (an extension, a plugin, HOME hooks), so uninstalling it from one project only
   * excludes it there and keeps that channel.
   */
  readonly projectFromHome: boolean;
  /** Whether a team's legacy `agents/<name>.md` reaches the tool copied verbatim: its agents read Claude Code's Markdown. */
  readonly legacyAgentMd: boolean;
  /** Data only: nothing reads it but the support page (`scripts/tool-support.ts`). */
  readonly features: ToolFeatures;
};

/** A skills channel whose reads are unknown in both scopes. */
export const UNKNOWN_READS = { user: 'unknown', project: 'unknown' } as const;

/** A channel the tool has in neither scope. */
export const NONE = { user: 'none', project: 'none' } as const;

/** A channel whose existence is unknown in both scopes. */
export const UNKNOWN = { user: 'unknown', project: 'unknown' } as const;
