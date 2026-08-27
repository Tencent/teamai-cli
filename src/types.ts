import { z } from 'zod';
import path from 'node:path';
import { getUserHome } from './utils/home.js';

// ─── Tool path config ───────────────────────────────────

export const ToolPathsSchema = z.object({
  skills: z.string().optional(),
  rules: z.string().optional(),
  settings: z.string().optional(),
  claudemd: z.string().optional(),
  /** Per-tool agents directory (Phase 1: teamai-recall subagent target).
   * Optional — tools without subagent support omit this and agents sync skips them. */
  agents: z.string().optional(),
  /** User-scope MCP config file (relative to $HOME). Omitted = tool has no MCP support. */
  mcp: z.string().optional(),
  /** Project-scope MCP config file. Never defaults from `mcp` — omitting it means
   * the tool has no project-scope MCP support at all. Claude Code shows why the two
   * cannot share a value: user scope is ~/.claude.json but project scope is
   * <root>/.mcp.json, breaking the usual `.<tool>/<file>` convention. */
  mcpProject: z.string().optional(),
  /**
   * User-scope path overrides for skills/rules/agents. Most tools store their
   * user-scope resources at the same `.<tool>/<resource>` relative path as their
   * project-scope ones, so this is omitted. OpenCode is the exception: its
   * project-scope config lives at `<root>/.opencode/...` but its user-scope config
   * lives at `~/.config/opencode/...`, a different prefix entirely. When set and the
   * active scope is `user`, these values replace the base skills/rules/agents paths.
   */
  userScope: z
    .object({
      skills: z.string().optional(),
      rules: z.string().optional(),
      agents: z.string().optional(),
    })
    .optional(),
});

// ─── Scope ──────────────────────────────────────────────

export const ScopeEnum = z.enum(['user', 'project']);
export type Scope = z.infer<typeof ScopeEnum>;

// ─── Team config (teamai.yaml) ───────────────────────────

export const SharingConfigSchema = z.object({
  skills: z.object({}).default({}),
  rules: z.object({
    enforced: z.array(z.string()).default([]),
  }).default({}),
  docs: z.object({
    localDir: z.string().default('~/.teamai/docs'),
  }).default({}),
  env: z.object({
    injectShellProfile: z.boolean().default(true),
    shellProfilePath: z.string().optional(),
  }).default({}),
  // Optional (not .default) so existing TeamaiConfig literals stay valid; use
  // getHooksSharing() for the defaulted view.
  hooks: z.object({
    /** Auto-apply team hooks during `teamai pull`. When false, pull only hints;
     *  the user must run `teamai hooks inject` to apply (explicit consent). */
    autoApply: z.boolean().default(true),
    /** Restrict team hook commands to scripts under ~/.teamai/team-scripts/. */
    requireTeamScripts: z.boolean().default(false),
  }).optional(),
  recall: z.object({
    enabled: z.boolean().default(false),
  }).optional(),
  // Optional (not .default) so existing TeamaiConfig literals stay valid; use
  // getMcpSharing() for the defaulted view.
  mcp: z.object({
    /** Auto-apply team MCP servers during `teamai pull`. When false, pull only
     *  hints; the user must run `teamai mcp inject` to apply (explicit consent). */
    autoApply: z.boolean().default(true),
    /** Allowed stdio commands. Empty = no restriction. */
    allowedCommands: z.array(z.string()).default([]),
    /** Allowed http/sse hosts (supports a leading `*.` wildcard). Empty = no restriction. */
    allowedHosts: z.array(z.string()).default([]),
  }).optional(),
});

/** Defaulted view of the optional `sharing.hooks` config. */
export function getHooksSharing(config: { sharing?: { hooks?: { autoApply?: boolean; requireTeamScripts?: boolean } } }): {
  autoApply: boolean;
  requireTeamScripts: boolean;
} {
  const h = config.sharing?.hooks;
  return {
    autoApply: h?.autoApply ?? true,
    requireTeamScripts: h?.requireTeamScripts ?? false,
  };
}

/** Defaulted view of the optional `sharing.mcp` config. */
export function getMcpSharing(config: {
  sharing?: { mcp?: { autoApply?: boolean; allowedCommands?: string[]; allowedHosts?: string[] } };
}): { autoApply: boolean; allowedCommands: string[]; allowedHosts: string[] } {
  const m = config.sharing?.mcp;
  return {
    autoApply: m?.autoApply ?? true,
    allowedCommands: m?.allowedCommands ?? [],
    allowedHosts: m?.allowedHosts ?? [],
  };
}

/** Defaulted view of the optional `sharing.recall` config. */
export function getRecallSharing(config: { sharing?: { recall?: { enabled?: boolean } } }): {
  enabled: boolean;
} {
  return { enabled: config.sharing?.recall?.enabled ?? false };
}

/** Resolve whether recall is enabled: user override > team config > default (false). */
export function isRecallEnabled(
  localConfig: { recallEnabled?: boolean },
  teamConfig: { sharing?: { recall?: { enabled?: boolean } } },
): boolean {
  if (localConfig.recallEnabled !== undefined) return localConfig.recallEnabled;
  return getRecallSharing(teamConfig).enabled;
}

// ─── Source config (cross-team subscription) ─────────
//
//  Data flow:
//
//  teamai.yaml (source team)           teamai.yaml (consumer team)
//    publicSkills: [skill-a, skill-b]    sources:
//                                          - name: other-team
//                                            repo: git@git.woa.com:other/repo.git
//            │                                        │
//            │    teamai source browse <name>          │  teamai pull
//            │             │                           │
//            ▼             ▼                           ▼
//  ~/.teamai/sources/<name>/repo/  ← git clone
//  ~/.teamai/sources/<name>/installed.json ← manifest
//            │
//            ▼
//  ~/.claude/skills/<skill-name>/  ← copy (original name, local team wins on conflict)
//

export const SourceConfigSchema = z.object({
  /** Alias name for this source (e.g. "platform-team"). */
  name: z.string().min(1),
  /** Git remote URL (e.g. "git@git.woa.com:other/repo.git"). */
  repo: z.string().min(1),
});

export type SourceConfig = z.infer<typeof SourceConfigSchema>;

/** Installed skill manifest for a single source. Persisted to sources/<name>/installed.json. */
export interface SourceInstallManifest {
  /** ISO timestamp of last successful pull. */
  lastPull: string;
  /** Skill names currently deployed from this source. */
  installedSkills: string[];
}

/** TTL for source repo pull: don't re-pull within this duration (ms). */
export const SOURCE_PULL_TTL_MS = 24 * 60 * 60 * 1000;

export const TEAMAI_SOURCES_DIR = path.join(getUserHome(), '.teamai', 'sources');

export const TeamaiConfigSchema = z.object({
  team: z.string(),
  description: z.string().default(''),
  repo: z.string(),
  /** Git hosting provider. `git` is the transport-only fallback for arbitrary hosts. */
  provider: z.enum(['tgit', 'github', 'cnb', 'gitlab', 'git']).default('tgit'),
  /**
   * @deprecated Ignored by `teamai init` (issue #250). Local install scope is
   * decided only by CLI `--scope` / default. Kept optional for old teamai.yaml files.
   */
  scope: ScopeEnum.optional(),
  /**
   * Single-repo mode marker. Committed to main inside <repo>/.teamai/teamai.yaml
   * so it travels with `git clone`. When a teammate clones a repo carrying
   * `mode: self` but has no local config yet, teamai auto-bootstraps the machine
   * side (write local config, inject hooks, register member). undefined = a
   * standalone team repo (existing behavior). See detectProjectConfig / bootstrapSelfRepo.
   */
  mode: z.enum(['self']).optional(),
  reviewers: z.array(z.string()).default([]),
  /** Skills this team makes available to other teams via cross-team subscription. */
  publicSkills: z.array(z.string()).optional(),
  /** External team repos to pull skills from. Managed by team admin. */
  sources: z.array(SourceConfigSchema).optional(),
  sharing: SharingConfigSchema.default({}),
  /** Team-level default: whether `teamai update` auto-installs upgrades. Users
   * can override via `updatePolicy` in local config. Undefined = team has no
   * opinion (preserves legacy behavior). */
  autoUpdate: z.boolean().optional(),
  // MCP paths are only set for tools whose config location has been verified.
  // Tools left without `mcp` are skipped by MCP sync rather than guessed at, so a
  // wrong guess can never create a junk config file on a user's machine.
  toolPaths: z.record(z.string(), ToolPathsSchema).default({
    claude: { skills: '.claude/skills', rules: '.claude/rules', settings: '.claude/settings.json', claudemd: '.claude/CLAUDE.md', agents: '.claude/agents', mcp: '.claude.json', mcpProject: '.mcp.json' },
    codex: { skills: '.codex/skills', rules: '.codex/rules', settings: '.codex/hooks.json', agents: '.codex/agents', mcp: '.codex/config.toml' },
    'codex-internal': { skills: '.codex-internal/skills', rules: '.codex-internal/rules', settings: '.codex-internal/hooks.json', agents: '.codex-internal/agents' },
    'claude-internal': { skills: '.claude-internal/skills', rules: '.claude-internal/rules', settings: '.claude-internal/settings.json', claudemd: '.claude-internal/CLAUDE.md', agents: '.claude-internal/agents' },
    // tclaude ships Claude Code with `customUserDataDir: .tclaude`, which
    // relocates the whole user data dir — so its MCP file is
    // ~/.tclaude/.claude.json, not ~/.tclaude.json. No mcpProject: project scope
    // for the Claude family is <root>/.mcp.json, which the `claude` target
    // already writes and tclaude reads from the same location.
    tclaude: { skills: '.tclaude/skills', rules: '.tclaude/rules', settings: '.tclaude/settings.json', claudemd: '.tclaude/CLAUDE.md', agents: '.tclaude/agents', mcp: '.tclaude/.claude.json' },
    tcodex: { skills: '.tcodex/skills', rules: '.tcodex/rules', settings: '.tcodex/hooks.json', agents: '.tcodex/agents' },
    cursor: { skills: '.cursor/skills', rules: '.cursor/rules', settings: '.cursor/hooks.json', agents: '.cursor/agents', mcp: '.cursor/mcp.json', mcpProject: '.cursor/mcp.json' },
    codebuddy: { skills: '.codebuddy/skills', rules: '.codebuddy/rules', settings: '.codebuddy/settings.json', claudemd: '.codebuddy/CODEBUDDY.md', agents: '.codebuddy/agents', mcp: '.codebuddy/mcp.json', mcpProject: '.codebuddy/mcp.json' },
    openclaw: { skills: '.openclaw/skills', rules: '.openclaw/rules', claudemd: '.openclaw/workspace/AGENTS.md' },
    hermes: { skills: '.hermes/skills', claudemd: 'AGENTS.md' },
    // DeepSeek Harness: skills synced to ~/.dsh/skills, which its skill-filesystem
    // provider scans as user-dsh root (rank 400). dsh discovers both directory
    // bundles (<name>/SKILL.md) and flat Markdown files there natively.
    dsh: { skills: '.dsh/skills' },
    workbuddy: { skills: '.workbuddy/skills', rules: '.workbuddy/rules', settings: '.workbuddy/settings.json', claudemd: 'AGENTS.md', mcp: '.workbuddy/mcp.json', mcpProject: '.workbuddy/mcp.json' },
    // OpenCode reads project config from <root>/.opencode/ but user config from
    // ~/.config/opencode/ — a different prefix, hence userScope. Skills are also
    // read natively from .claude/skills, but we write .opencode/skills so an
    // OpenCode-only user (no Claude) still gets them. Rules land in .opencode/rules
    // but must be activated via the `instructions` glob in opencode.json (OpenCode
    // does not auto-scan a rules dir). MCP shares opencode.json under the `mcp` key.
    opencode: {
      skills: '.opencode/skills',
      rules: '.opencode/rules',
      agents: '.opencode/agents',
      mcp: '.config/opencode/opencode.json',
      mcpProject: 'opencode.json',
      userScope: { skills: '.config/opencode/skills', rules: '.config/opencode/rules', agents: '.config/opencode/agents' },
    },
  }),
});

export type TeamaiConfig = z.infer<typeof TeamaiConfigSchema>;

// ─── Member config (members/<user>.yaml) ────────────────

export const MemberConfigSchema = z.object({
  username: z.string(),
  displayName: z.string().default(''),
  registeredAt: z.string(),
  role: z.string().optional(),
});

export type MemberConfig = z.infer<typeof MemberConfigSchema>;

// ─── Local config (~/.teamai/config.yaml) ──────────────────

export const LocalConfigSchema = z.object({
  repo: z.object({
    localPath: z.string(),
    remote: z.string(),
    /**
     * Team repo backend. Defaults to 'git' for backward compatibility.
     * - 'git':  a standalone team repo cloned to <home>/team-repo.
     * - 'http': a git-free HTTP team repo (read-only consumer).
     * - 'self': single-repo mode — the business repo IS the team repo.
     *           Knowledge lives on main under <businessRepoRoot>/.teamai/;
     *           reports (members/sessions/votes/stats) live on the
     *           `teamai-reports` orphan branch. localPath = <businessRepoRoot>/.teamai.
     */
    kind: z.enum(['git', 'http', 'self']).optional(),
    /** Base URL of the HTTP team repo (only when kind === 'http'). */
    url: z.string().optional(),
    /**
     * Git root of the business repo (only when kind === 'self').
     * Equals the parent directory of localPath. All git write operations
     * (knowledge PRs, reports orphan branch) run in isolated worktrees under
     * this repo so the user's active working tree is never touched.
     */
    businessRepoRoot: z.string().optional(),
  }),
  username: z.string(),
  updatePolicy: z.enum(['auto', 'prompt', 'skip']).optional(),
  // Read-compat default for historical configs that omit `scope` (pre-project era).
  // NOT the write default for `teamai init` — init defaults to project (issue #250).
  scope: ScopeEnum.default('user'),
  primaryRole: z.string().min(1).optional(),
  additionalRoles: z.array(z.string()).default([]),
  resourceProfileVersion: z.number().int().positive().optional(),
  /** Absolute path to project root; required when scope is 'project'. */
  projectRoot: z.string().optional(),
  /** Opt-in: include safe user-scope resources and knowledge while in project scope. */
  inheritUserScope: z.boolean().optional(),
  /** Tags the user has subscribed to. If empty/undefined, pull all resources. */
  subscribedTags: z.array(z.string()).optional(),
  /** Skills to exclude from local sync (per-user, does not affect team repo). */
  excludedSkills: z.array(z.string()).optional(),
  /** User-level override for recall feature. When set, takes precedence over team config. */
  recallEnabled: z.boolean().optional(),
  /** When set, only inject hooks into these agents. Additive across multiple init --agent runs. */
  enabledAgents: z.array(z.string()).optional(),
  /** Tools explicitly excluded from all teamai sync (set by `uninstall --agent`). Removed again by `init --agent`. */
  disabledAgents: z.array(z.string()).optional(),
});

export type LocalConfig = z.infer<typeof LocalConfigSchema>;
export type LocalConfigInput = z.input<typeof LocalConfigSchema>;

// ─── Local state (~/.teamai/state.json) ────────────────────

export const StateSchema = z.object({
  lastPush: z.string().nullable().default(null),
  lastPull: z.string().nullable().default(null),
  /** Git commit hash (short) of the team repo at the time of last successful pull. */
  lastPullRev: z.string().nullable().default(null),
  /** Installed, enabled tool targets that completed the last full pull. */
  lastPullTargets: z.array(z.string()).optional(),
  /** Git commit hash synchronized through the safe user-resource inheritance channel. */
  lastInheritedPullRev: z.string().nullable().optional(),
  /** Tool targets that completed the last inherited user-resource pull. */
  lastInheritedPullTargets: z.array(z.string()).optional(),
  pushedRules: z.array(z.string()).default([]),
  pushedSkills: z.array(z.string()).default([]),
  pushedEnvVars: z.array(z.string()).default([]),
  lastUpdateCheck: z.string().nullable().default(null),
  availableUpdate: z.string().nullable().default(null),
});

export type State = z.infer<typeof StateSchema>;

// ─── Tags config (team repo: tags.yaml) ─────────────────
//
//  Centralized tag-to-resource mapping managed by team admin.
//  Users subscribe to tags in their local config; `teamai pull`
//  filters resources by matching tags.
//
//  Backward compat rules:
//    - No tags.yaml → pull everything
//    - No subscribedTags → pull everything
//    - Resource not in tags.yaml → always pulled (untagged = universal)
//

/** Parsed content of team-repo/tags.yaml. */
export interface TagsConfig {
  /** Skill name → list of tags. */
  skills: Record<string, string[]>;
  /** Rule name → list of tags. */
  rules: Record<string, string[]>;
}

// ─── Resource types ─────────────────────────────────────

export type ResourceType = 'skills' | 'rules' | 'docs' | 'env' | 'agents' | 'hooks' | 'mcp';

export type ResourceItemStatus = 'new' | 'modified';

export interface ResourceItem {
  name: string;
  type: ResourceType;
  sourcePath: string;
  relativePath: string;
  status?: ResourceItemStatus;
  namespace?: string;
}

export interface ResourceDiff {
  added: ResourceItem[];
  modified: ResourceItem[];
  removed: ResourceItem[];
}

// ─── Hook definitions (unified model, issue #19) ─────────
//
//  A single declarative model for both built-in operational hooks (source:
//  'builtin', the teamai pull/dispatch hooks shipped with the CLI) and
//  team-defined hooks (source: 'team', declared in the team repo's
//  hooks/hooks.yaml). One `reconcileHooks()` engine injects both.
//
//  `event` is always the Claude PascalCase name (the cross-tool lingua
//  franca); the engine maps it to Cursor's camelCase via CLAUDE_TO_CURSOR_EVENTS.

export interface HookDef {
  /** Distinguishes CLI built-in (A) from team-declared (B) hooks. */
  source: 'builtin' | 'team';
  /** Stable identity: builtin = description keyword, team = yaml `id`. */
  key: string;
  /** Claude PascalCase event name (SessionStart/Stop/PostToolUse/UserPromptSubmit). */
  event: string;
  /** Optional tool matcher (e.g. "Bash", "Skill"). "*" or undefined = all. */
  matcher?: string;
  /** Shell command to run. */
  command: string;
  /** Per-hook timeout in seconds (tool-specific; omitted = tool default). */
  timeout?: number;
  /** settings.json description. builtin: "[teamai] <key>"; team: "[teamai:hook:<id>] ...". */
  description: string;
  /** Team hooks only: restrict to these tools (default = all hook-capable tools). */
  tools?: string[];
}

// ─── MCP server definitions ──────────────────────────────
//
//  Team-declared MCP servers (mcp/mcp.yaml) are parsed into this tool-neutral
//  model, then rendered per tool by resources/mcp-format.ts — the same
//  "intermediate model → per-tool render" shape agents already uses.
//
//  Ownership is tracked out-of-band in ~/.teamai/managed-mcp.json, because an
//  MCP entry has no free-text field to stamp a marker into (hooks stamp
//  `[teamai:hook:<id>]` into `description`). This mirrors how hooks already
//  track Cursor/Codex entries, which have no description either.

export type McpTransport = 'stdio' | 'http' | 'sse';

export interface McpServerDef {
  /** Server key as written into each tool's config. */
  name: string;
  description?: string;
  transport: McpTransport;
  /** stdio only. */
  command?: string;
  args?: string[];
  /** http/sse only. */
  url?: string;
  /** http/sse only. Values may contain ${VAR} placeholders. */
  headers?: Record<string, string>;
  /** Env vars passed to the server process. Values may contain ${VAR} placeholders. */
  env?: Record<string, string>;
  /** Request timeout in milliseconds, passed through where the tool supports it. */
  timeout?: number;
  /** Executables that must be on PATH; missing ones cause a skip-with-hint. */
  requires?: string[];
  /** Restrict to these tools (default = every MCP-capable tool). */
  tools?: string[];
}

/** One injected MCP server recorded in the manifest. */
export interface ManagedMcpRecord {
  name: string;
  /** sha1 (first 16 hex) of the rendered entry; drives idempotent rewrites. */
  hash: string;
}

/** ~/.teamai/managed-mcp.json — team MCP servers injected per tool+scope key. */
export type ManagedMcpManifest = Record<string, ManagedMcpRecord[]>;

/** Path of the managed-MCP manifest for a scope. */
export function managedMcpManifestPath(scope: Scope, projectRoot?: string): string {
  return path.join(getTeamaiHome(scope, projectRoot), 'managed-mcp.json');
}

// ─── Global options ─────────────────────────────────────

export interface GlobalOptions {
  dryRun?: boolean;
  verbose?: boolean;
  silent?: boolean;
  /** Force full sync even when repo HEAD matches lastPullRev. */
  force?: boolean;
  /** Push a specific skill by path. */
  skill?: string;
  /** Target role namespace (overrides detected namespace). */
  role?: string;
  /** Push all detected skills without prompting. */
  all?: boolean;
}

// ─── Constants ──────────────────────────────────────────

export const TEAMAI_HOME = path.join(getUserHome(), '.teamai');
export const TEAMAI_CONFIG_PATH = path.join(TEAMAI_HOME, 'config.yaml');
export const TEAMAI_STATE_PATH = path.join(TEAMAI_HOME, 'state.json');
export const TEAMAI_TOKEN_PATH = path.join(TEAMAI_HOME, 'token');
export const TEAMAI_UPDATE_LOCK_PATH = path.join(TEAMAI_HOME, '.update-lock');

export const RESOURCE_TYPES: ResourceType[] = ['skills', 'rules', 'docs', 'env', 'agents', 'hooks', 'mcp'];

export const TEAMAI_RULES_START = '<!-- [teamai:rules:start] -->';
export const TEAMAI_RULES_END = '<!-- [teamai:rules:end] -->';

export const TEAMAI_HOOK_DESCRIPTION_PREFIX = '[teamai]';

/**
 * Description prefix for team-declared (B) hooks. Deliberately NOT starting with
 * a bare "[teamai]" token boundary so the two marker namespaces never collide:
 * built-in detection matches "[teamai] " / command markers, team detection
 * matches "[teamai:hook:". Format: "[teamai:hook:<id>] <description>".
 */
export const TEAMAI_CUSTOM_HOOK_PREFIX = '[teamai:hook:';

/**
 * Description prefix for HTTP-source agent hooks (issue #238) installed via the
 * `install_hook_rule` sync command. A third, isolated marker namespace: it does
 * NOT start with "[teamai] " (built-in) nor "[teamai:hook:" (team), so team-pull
 * full-reconcile treats agent hooks as untouched and never deletes them. Only
 * `install_hook_rule` / `uninstall_hook_rule` and teardown manage this namespace.
 * Format: "[teamai:agent-hook:<slug>]".
 */
export const TEAMAI_AGENT_HOOK_PREFIX = '[teamai:agent-hook:';

export const TEAMAI_ENV_START = '# [teamai:env:start]';
export const TEAMAI_ENV_END = '# [teamai:env:end]';

export const TEAMAI_CULTURE_START = '<!-- [teamai:culture:start] -->';
export const TEAMAI_CULTURE_END = '<!-- [teamai:culture:end] -->';

export const TEAMAI_CLAUDEMD_START = '<!-- [teamai:claudemd:start] -->';
export const TEAMAI_CLAUDEMD_END = '<!-- [teamai:claudemd:end] -->';

// Phase 1: marker section for the recall-subagent rules block injected by `teamai pull`.
export const TEAMAI_RECALL_RULES_START = '<!-- [teamai:recall-rules:start] -->';
export const TEAMAI_RECALL_RULES_END = '<!-- [teamai:recall-rules:end] -->';

// ─── Usage tracking ────────────────────────────────────

/** Regex for valid skill names: alphanumeric, hyphens, underscores, colons, dots. Max 200 chars. */
export const SKILL_NAME_REGEX = /^[a-zA-Z0-9_\-:.]{1,200}$/;

export const TEAMAI_USAGE_PATH = `${TEAMAI_HOME}/usage.jsonl`;
export const TEAMAI_KNOWN_SKILLS_PATH = `${TEAMAI_HOME}/known-skills.json`;
export const TEAMAI_PUSHIGNORE_PATH = `${TEAMAI_HOME}/pushignore`;
export const TEAMAI_SESSIONS_DIR = `${TEAMAI_HOME}/sessions`;
/**
 * Local monthly session logs (`teamai session save`). Kept in a dedicated dir —
 * not TEAMAI_SESSIONS_DIR, which holds per-session contribute-state `.json`.
 */
export const SESSION_LOGS_LOCAL_DIR = `${TEAMAI_HOME}/session-logs`;

export interface UsageEvent {
  skill: string;
  timestamp: string;
  tool: string;
}

export const UsageEventSchema = z.object({
  skill: z.string().regex(SKILL_NAME_REGEX),
  timestamp: z.string(),
  tool: z.string(),
});

// ─── Stats YAML (team repo: stats/<user>.yaml) ─────────

export interface UserStats {
  username: string;
  updatedAt: string;
  skills: Record<string, { count: number; lastUsed: string }>;
  /**
   * Aggregated Human Intervention metric for this user (Issue #34).
   * Cumulative across all reported sessions. Privacy: counts only, no prompt text.
   */
  interventions?: UserInterventionStats;
  /**
   * Cumulative count of human conversation turns (UserPromptSubmit events) across
   * all reported sessions. Privacy: count only, no prompt text.
   */
  prompts?: number;
  /**
   * Cumulative token usage across all reported sessions (Claude Code transcripts
   * only; tools without transcripts contribute nothing). Privacy: counts only.
   */
  tokens?: TokenUsage;
}

/** Per-user cumulative intervention totals, persisted to stats/<user>.yaml. */
export interface UserInterventionStats {
  /** Number of distinct sessions counted into these totals. */
  sessions: number;
  /** Total user interrupts (ESC) across all sessions. */
  interrupt: number;
  /** Total tool rejections (permission deny) across all sessions. */
  toolReject: number;
  /** Total corrections (re-prompt after stop) across all sessions. */
  correction: number;
}

// ─── Dashboard ──────────────────────────────────────
//
//  Data flow (hook-based, zero external dependencies):
//
//  Claude Code session
//      │ hooks: SessionStart / PostToolUse / UserPromptSubmit / Stop
//      ▼
//  teamai dashboard-report --stdin --tool <name>
//      │ parse STDIN JSON → DashboardEvent
//      ▼
//  ~/.teamai/dashboard/events.jsonl  (append-only)
//      │ fs.watch
//      ▼
//  dashboard server (localhost:3721)
//      │ rebuild DashboardSession[] from events
//      ▼
//  SSE → browser (session cards with status lights)
//

/**
 * Token usage breakdown for a session/user, summed from Claude Code transcript
 * `message.usage` records (deduplicated by message id). All fields are cumulative
 * token counts; tools without a transcript (e.g. Cursor) leave these at zero.
 */
export interface TokenUsage {
  /** Sum of usage.input_tokens. */
  input: number;
  /** Sum of usage.output_tokens. */
  output: number;
  /** Sum of usage.cache_read_input_tokens. */
  cacheRead: number;
  /** Sum of usage.cache_creation_input_tokens. */
  cacheCreation: number;
}

/** A fresh zeroed TokenUsage. */
export function emptyTokenUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
}

/** Grand total of all token buckets (input + output + cache read + cache creation). */
export function totalTokens(t: TokenUsage | undefined): number {
  if (!t) return 0;
  return t.input + t.output + t.cacheRead + t.cacheCreation;
}

/** Add two TokenUsage values field-by-field (does not mutate inputs). */
export function addTokenUsage(a: TokenUsage | undefined, b: TokenUsage | undefined): TokenUsage {
  return {
    input: (a?.input ?? 0) + (b?.input ?? 0),
    output: (a?.output ?? 0) + (b?.output ?? 0),
    cacheRead: (a?.cacheRead ?? 0) + (b?.cacheRead ?? 0),
    cacheCreation: (a?.cacheCreation ?? 0) + (b?.cacheCreation ?? 0),
  };
}

/**
 * Per-session rolled-up metrics, derived from the dashboard event log.
 * Used by both the live dashboard (rebuildSessions) and the team-stats reporter.
 */
export interface SessionMetrics {
  interrupt: number;
  toolReject: number;
  correction: number;
  /** Number of human conversation turns (UserPromptSubmit events). */
  prompts: number;
  /** Cumulative token usage (latest Stop snapshot). */
  tokens: TokenUsage;
}

export type DashboardSessionStatus = 'running' | 'waiting_for_input' | 'error' | 'idle' | 'stopped';

export type DashboardEventType = 'session_start' | 'tool_use' | 'prompt_submit' | 'stop' | 'process_exit';

export interface DashboardEvent {
  /** Event type mapped from hook event */
  type: DashboardEventType;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Unique session identifier (Claude Code session_id preferred, PID+cwd fallback) */
  sessionId: string;
  /** AI tool name: claude, claude-internal, cursor, codebuddy, etc. */
  tool: string;
  /** Working directory of the session */
  cwd?: string;
  /** First user prompt (captured from UserPromptSubmit) */
  promptSummary?: string;
  /** Tool name from PostToolUse (e.g. "Edit", "Bash", "Read") */
  toolName?: string;
  /** Inferred session status at event time */
  status?: DashboardSessionStatus;
  /** AI output captured from transcript at session stop (truncated to 500 chars) */
  stoppedOutput?: string;
  /** Path to Claude Code transcript file (from Stop hook STDIN) */
  transcriptPath?: string;
  /** Resolved PID of the AI tool main process (for liveness monitoring) */
  monitorPid?: number;
  /**
   * Cumulative human-intervention counts scanned from the transcript at Stop time.
   * Full snapshot (idempotent): each Stop event carries the running total for the
   * whole session, so a later Stop overrides an earlier one in rebuildSessions.
   * `correction` is NOT derived from the transcript — it is computed in
   * rebuildSessions from the stop→prompt_submit event pattern.
   *
   * `toolError` (optional; absent on pre-existing events) counts genuine tool
   * failures the AI had to retry — a friction signal for contribute scoring. It is
   * intentionally NOT rolled into SessionMetrics / team stats.
   */
  interventions?: { interrupt: number; toolReject: number; toolError?: number };
  /**
   * Cumulative token usage scanned from the transcript at Stop time. Full snapshot
   * (idempotent): each Stop carries the running total for the whole session, so a
   * later Stop overrides an earlier one in rebuildSessions. Absent for tools with
   * no transcript (e.g. Cursor) and for sessions with no recorded usage.
   */
  tokens?: TokenUsage;
  /**
   * Cumulative count of human prompt turns scanned from the transcript at Stop time.
   * Full snapshot (idempotent), sourced from the non-compactable transcript so the
   * reported baseline survives compaction + same-session resume. Absent for tools
   * with no transcript (e.g. Cursor); for those, prompt_submit events are counted.
   */
  prompts?: number;
}

export interface DashboardSession {
  /** Unique session identifier */
  sessionId: string;
  /** AI tool name */
  tool: string;
  /** Current session status */
  status: DashboardSessionStatus;
  /** Working directory */
  cwd: string;
  /** First user prompt summary */
  promptSummary: string;
  /** ISO 8601 timestamp of last activity */
  lastActivity: string;
  /** ISO 8601 timestamp of session start */
  startedAt: string;
  /** Last tool used (e.g. "Edit", "Bash") */
  lastTool: string;
  /** All user prompts collected during the session */
  prompts: string[];
  /** AI output captured from transcript at session stop */
  stoppedOutput: string;
  /** ISO 8601 timestamp of when the session was stopped */
  stoppedAt: string;
  /** Resolved PID of the AI tool main process (for liveness monitoring) */
  monitorPid?: number;
  /**
   * Per-session human-intervention breakdown (Human Intervention metric).
   * - interrupt: user interrupted the agent mid-turn (ESC)
   * - toolReject: user denied a tool call (permission deny)
   * - correction: user re-prompted to correct the agent right after a stop
   */
  interventions: { interrupt: number; toolReject: number; correction: number };
  /** Total intervention count (interrupt + toolReject + correction), for sorting/badges */
  interventionCount: number;
  /** Number of human conversation turns (UserPromptSubmit events) in this session. */
  promptCount: number;
  /** Cumulative token usage for this session (zero when no transcript usage). */
  tokens: TokenUsage;
}

export const DASHBOARD_EVENTS_DIR = `${TEAMAI_HOME}/dashboard`;
export const DASHBOARD_EVENTS_PATH = `${DASHBOARD_EVENTS_DIR}/events.jsonl`;
export const DASHBOARD_DEFAULT_PORT = 3721;
/** Sessions with no activity for this long (ms) are marked idle */
export const DASHBOARD_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
/** Sessions idle for this long (ms) are removed from the dashboard */
export const DASHBOARD_STALE_TIMEOUT_MS = 30 * 60 * 1000;
/** Compact JSONL when it exceeds this many lines */
export const DASHBOARD_COMPACTION_THRESHOLD = 5_000;
/** Stopped sessions are removed from the dashboard after this many ms */
export const DASHBOARD_STOPPED_DISPLAY_MS = 30 * 1000;
/** Interval (ms) between PID liveness checks in the dashboard server */
export const DASHBOARD_PID_CHECK_INTERVAL_MS = 15_000;

// ─── Human Intervention metric ───────────────────────
//
//  A `correction` is counted when the user submits a new prompt within
//  CORRECTION_WINDOW_MS after the agent stopped AND the prompt looks like a
//  course-correction (contains one of CORRECTION_KEYWORDS) rather than a new task.
//

/** Max time (ms) between a stop and the next prompt for it to count as a correction. */
export const CORRECTION_WINDOW_MS = 60 * 1000;
/** Substrings (lowercased) that mark a prompt as a course-correction, not a new task. */
export const CORRECTION_KEYWORDS = [
  '不对', '不是', '错了', '错误', '重来', '重新', '撤销', '回退', '别这样', '不要',
  'wrong', 'redo', 'undo', 'revert', 'mistake', 'instead', "don't", "that's not", 'not what',
];
/** Max bytes to scan from a transcript when counting interventions (guards huge files). */
export const INTERVENTION_SCAN_MAX_BYTES = 50 * 1024 * 1024;
/** Marker that prefixes a user-interrupt entry in the Claude Code transcript. */
export const TRANSCRIPT_INTERRUPT_PREFIX = '[Request interrupted by user';
/** Prefixes of system-injected user messages that are NOT genuine human prompts. */
export const TRANSCRIPT_SYSTEM_PREFIXES = [
  '<task-notification>',
];
/** Substrings that mark a tool_result as a user rejection (permission deny). */
export const TRANSCRIPT_REJECT_MARKERS = [
  'The tool use was rejected',
  "doesn't want to proceed with this tool use",
];

// ─── Contribute (session auto-contribute) ────────────
//
//  Friction-based threshold detection (a session is worth documenting when the
//  user had to fight the AI, not merely when it ran a lot of tools):
//
//  Layer 1 (fast): toolCount in contribute-state.json
//      │ < BASE_THRESHOLD → exit early (~1ms per PostToolUse)
//      ▼
//  Layer 2 (lazy): read events.jsonl, compute FRICTION score
//      │ score = f(interrupt, toolReject, correction, toolError) + tiny scale bonus
//      │ < SMART_THRESHOLD → exit
//      ▼
//  Hard gate: toolCount >= BASE_THRESHOLD (a friction-heavy but trivial session
//             — e.g. one rejected command — is not worth a knowledge-base entry)
//      ▼
//  STDOUT hint → AI suggests /contribute to user
//

/** Friction signals that explain why a session qualified for contribution. */
export interface SessionFriction {
  interrupt: number;
  toolReject: number;
  correction: number;
  toolError: number;
}

/** Per-session contribute state, persisted to ~/.teamai/sessions/{sessionId}.json */
export interface ContributeState {
  /** Tool count at last evaluation (used for Layer 1 fast-path check) */
  toolCount?: number;
  /** Unique tool names at last evaluation (retained for backward-compatible state) */
  uniqueTools?: number;
  /** Timestamp when score was last evaluated (ms since epoch) */
  lastEvaluated?: number;
  /** Smart score computed at evaluation time (undefined before evaluation) */
  smartScore?: number;
  /** Whether the user has already contributed this session (set by /contribute) */
  contributed: boolean;
  /**
   * Whether the contribute hint has already been emitted for this session.
   * Prevents repeated hints when Layer 2 cache is hit on subsequent Stop hooks.
   */
  hinted?: boolean;
  /** Phase 2: ISO timestamp of session start (for git commit detection in cache-hit path) */
  sessionStartIso?: string;
  /** Phase 2: whether git commit was detected during this session */
  hasGitCommit?: boolean;
  /** Phase 2: whether knowledge gap was detected (all recalls missed) */
  isKnowledgeGap?: boolean;
  /** Cached explanation context so Stop-hook cache hits can skip events.jsonl */
  friction?: SessionFriction;
  /** Sanitized, single-line summary of the session's first task */
  promptSummary?: string;
}

/**
 * Layer 1 (fast-path) threshold: if toolCount < this, skip reading events.jsonl.
 * Also doubles as a HARD GATE on hint emission — a session with fewer than this
 * many tool calls never triggers a hint no matter how much friction it shows
 * (a one-command session the user rejected is not knowledge-base material).
 */
export const CONTRIBUTE_BASE_THRESHOLD = 15;

/**
 * Friction score threshold: minimum score to show contribute hint.
 *
 * Calibrated so ONE clear primary friction signal (a single interrupt, rejection,
 * or correction — each worth CONTRIBUTE_*_WEIGHT = 20) crosses it, while the scale
 * nudge alone (diversity + skill, max ~10) never can. Combined with the toolCount
 * hard gate, this fires only on substantive sessions that actually hit friction.
 */
export const CONTRIBUTE_SMART_THRESHOLD = 20;

// ─── Friction score weights ──────────────────────────
//  A session earns points from signals that the user had to correct or the AI
//  had to fight — not from raw activity. Any single strong signal (one interrupt,
//  one rejection, one correction) lands near the threshold; scale (tool count /
//  duration) only nudges and can never trigger on its own.

/** Points per user interrupt (ESC mid-output — the user stopped a wrong direction). */
export const CONTRIBUTE_INTERRUPT_WEIGHT = 20;

/** Points per tool rejection (user denied a tool call — explicit course block). */
export const CONTRIBUTE_REJECT_WEIGHT = 20;

/** Points per correction (re-prompt with a correction keyword right after a stop). */
export const CONTRIBUTE_CORRECTION_WEIGHT = 20;

/**
 * Tool-error (retry) score gradient: genuine tool failures the AI had to work
 * around. Keyed by count thresholds → points; the highest matching tier wins.
 * Distinct from a single fluke error — it takes a few to signal a real struggle.
 */
export const CONTRIBUTE_TOOLERROR_TIERS: ReadonlyArray<{ min: number; points: number }> = [
  { min: 8, points: 25 },
  { min: 5, points: 18 },
  { min: 3, points: 10 },
];

/** Small scale bonus (diversity + skill use) — nudges, never triggers alone. Max ~10. */
export const CONTRIBUTE_SKILL_BONUS = 5;
export const CONTRIBUTE_DIVERSITY_BONUS_MAX = 5;

/**
 * Debounce TTL for contribute-check re-evaluation. Within this window the
 * last-known toolCount / smartScore snapshot is trusted; beyond it we always
 * re-read events.jsonl so a late burst of tool usage isn't missed by a stale
 * zero-score snapshot.
 */
export const CONTRIBUTE_FASTPATH_TTL_MS = 5 * 60 * 1000;

/** Phase 2: bonus when all recalls return zero results (knowledge gap) */
export const CONTRIBUTE_KNOWLEDGE_GAP_BONUS = 20;

/** Phase 2: bonus when recalls return results but top score is very low */
export const CONTRIBUTE_LOW_QUALITY_BONUS = 10;

/** Phase 2: threshold below which recall results are considered low quality */
export const CONTRIBUTE_LOW_QUALITY_THRESHOLD = 5.0;

/** Phase 2: git commit is neutral (no bonus, no penalty) */
export const CONTRIBUTE_GIT_COMMIT_DOWNWEIGHT = 0;

/** Directory for per-session contribute state files */
export const CONTRIBUTE_SESSIONS_DIR = `${TEAMAI_HOME}/sessions`;

// ─── Learnings / Recall (Git-Native Memory) ──────────
//
//  Data flow:
//
//  teamai contribute → learnings/<slug>.md (team repo, with frontmatter)
//                          │
//                     teamai pull
//                          │
//                          ▼
//  ~/.teamai/learnings/ (local copy) → search-index.json (built at pull)
//                          │
//                     teamai recall <query>
//                          │
//                          ▼
//  Ranked results → AI reads → auto-upvote → votes/<user>.yaml
//

/** Parsed frontmatter from a learning document. */
export interface LearningDocMeta {
  title?: string;
  author?: string;
  date?: string;
  tags?: string[];
}

/** Knowledge category for search index entries (Phase 1 expansion). */
export type KnowledgeType = 'learnings' | 'docs' | 'rules' | 'skills';

/**
 * Content domain of a knowledge entry (Phase 1.4).
 * Used to weight search results: technical > neutral > ops > support.
 *
 * - technical: code bugs, API design, architecture decisions, debugging
 * - ops:       deployment SOPs, cluster operations, monitoring, CI/CD
 * - support:   user FAQs, product guides, onboarding materials
 * - neutral:   unclassifiable — no matching tags/path/type signal
 */
export type KnowledgeDomain = 'technical' | 'ops' | 'support' | 'neutral';

/** One entry in the local search index (search-index.json). */
export interface SearchIndexEntry {
  /** Original filename (e.g. "api-timeout-修复-2026-03-20-abc123.md") */
  filename: string;
  /** Title from frontmatter, or derived from filename */
  title: string;
  /** Author from frontmatter */
  author: string;
  /** ISO date string */
  date: string;
  /** Tags from frontmatter */
  tags: string[];
  /** Tokenized terms for search matching (title + tags + body excerpt) */
  tokens: string[];
  /** Vote count (aggregated at index build time) */
  votes: number;
  /** Source category: which knowledge bucket this entry came from. */
  type: KnowledgeType;
  /** Content domain inferred from frontmatter / tags / path (Phase 1.4). */
  domain?: KnowledgeDomain;
  /** Absolute path to the source file (Phase 4.3 hot/cold path support). */
  path?: string;
  /** Optional hotness score reserved for Phase 4.3 hot/cold splitting. */
  hotness?: number;
  /** Computed confidence score (0.0–1.0) for maintenance/hot-cold. */
  confidence?: number;
  /** Snippet from codebase graph recall (depth-dependent content preview). */
  snippet?: string;
}

/** Schema version of the on-disk search-index.json (bump on breaking change). */
export const SEARCH_INDEX_VERSION = 6;

/** Shape of the search-index.json file. */
export interface SearchIndex {
  /** Schema version. Phase 1 introduces v2 (multi-category index). */
  version?: number;
  /** ISO timestamp of when the index was built */
  builtAt: string;
  /** Elapsed ms to build the index */
  elapsedMs: number;
  /** Index entries, one per learning document */
  entries: SearchIndexEntry[];
  /** Document-frequency map: token → number of entries containing that token.
   *  Used for IDF weighting in search(). Optional for backward compatibility
   *  with indexes built before this field was introduced. */
  df?: Record<string, number>;
}

/** Per-user vote file (votes/<user>.yaml). */
export interface UserVotes {
  votes: Record<string, { at: string }>;
}

/** Vote entry with dual counters (V2). */
export interface VoteEntryV2 {
  recalled_count: number;
  upvoted_count: number;
  last_recalled_at: string;
  last_upvoted_at?: string;
}

/** Unsynchronized delta for a single document (V2). */
export interface VoteDelta {
  recalled_delta: number;
  upvoted_delta: number;
}

/** Per-user vote file V2 format (votes/<user>.yaml). */
export interface UserVotesV2 {
  version: 2;
  votes: Record<string, VoteEntryV2>;
  deltas: Record<string, VoteDelta>;
}

export const LEARNINGS_LOCAL_DIR = `${TEAMAI_HOME}/learnings`;
export const SEARCH_INDEX_PATH = `${TEAMAI_HOME}/search-index.json`;
export const VOTES_LOCAL_DIR = `${TEAMAI_HOME}/votes`;

export const CultureCompanySchema = z.object({
  name: z.string(),
  mission: z.string().optional(),
  vision: z.string().optional(),
  values: z.array(z.string()).optional(),
});
export const CultureTeamSchema = z.object({
  name: z.string(),
  mission: z.string().optional(),
  goals: z.array(z.string()).optional(),
});
export const CultureFrontmatterSchema = z.object({
  company: CultureCompanySchema.optional(),
  team: CultureTeamSchema.optional(),
});
export type CultureFrontmatter = z.infer<typeof CultureFrontmatterSchema>;

// ─── Scope helpers ─────────────────────────────────────

/**
 * Resolve the base directory for resource installation based on scope.
 * - user scope  → the platform user home directory (e.g. /Users/xxx)
 * - project scope → localConfig.projectRoot (e.g. /Users/xxx/my-project)
 */
export function resolveBaseDir(localConfig: LocalConfig): string {
  if (localConfig.scope === 'project') {
    if (!localConfig.projectRoot) {
      throw new Error(
        'resolveBaseDir: localConfig.scope is "project" but projectRoot is missing — ' +
        'refusing to silently fall back to the user home directory. Re-run `teamai init` in this project.',
      );
    }
    return localConfig.projectRoot;
  }
  return getUserHome();
}

/** True when `tool` is in localConfig.disabledAgents (excluded from teamai sync). */
export function isAgentDisabled(localConfig: { disabledAgents?: string[] }, tool: string): boolean {
  return localConfig.disabledAgents?.includes(tool) ?? false;
}

/**
 * Return `teamConfig.toolPaths` with per-scope path overrides applied.
 *
 * Almost every tool keeps its user-scope and project-scope resources at the same
 * `.<tool>/<resource>` relative path, so this is the identity map for them. The
 * one exception is OpenCode, whose user-scope config lives under
 * `~/.config/opencode/` (a different prefix from its project `<root>/.opencode/`);
 * its `userScope` block carries those paths and is spliced in only when the active
 * scope is `user`. Callers that iterate `toolPaths` for skills/rules/agents should
 * iterate the result of this function instead, so the correct scope path is used.
 *
 * MCP is untouched here: its two scopes are already distinct fields
 * (`mcp` / `mcpProject`), resolved separately in the reconcile engine.
 */
export function scopedToolPaths(
  teamConfig: TeamaiConfig,
  localConfig: { scope?: Scope },
): Record<string, z.infer<typeof ToolPathsSchema>> {
  if (localConfig.scope !== 'user') return teamConfig.toolPaths;
  const out: Record<string, z.infer<typeof ToolPathsSchema>> = {};
  for (const [tool, paths] of Object.entries(teamConfig.toolPaths)) {
    const us = paths.userScope;
    if (!us) {
      out[tool] = paths;
      continue;
    }
    out[tool] = {
      ...paths,
      ...(us.skills !== undefined ? { skills: us.skills } : {}),
      ...(us.rules !== undefined ? { rules: us.rules } : {}),
      ...(us.agents !== undefined ? { agents: us.agents } : {}),
    };
  }
  return out;
}

/** True when the local config is single-repo mode (the business repo is the team repo). */
export function isSelfMode(localConfig: { repo: { kind?: string } }): boolean {
  return localConfig.repo.kind === 'self';
}

/** Orphan branch that carries reports (members/sessions/votes/stats) in single-repo mode. */
export const REPORTS_BRANCH = 'teamai-reports';
/** Worktree directory (under .teamai) that checks out the reports orphan branch. */
export const REPORTS_WORKTREE_DIRNAME = 'reports-wt';
/** Worktree directory (under .teamai) used to stage knowledge PRs off the active tree. */
export const KNOWLEDGE_WORKTREE_DIRNAME = 'knowledge-wt';
/** Lock filename (under <repo>/.teamai) guarding concurrent reports-branch writes. */
export const REPORTS_LOCK_FILENAME = '.reports-lock';
/** Lock filename (under <repo>/.teamai) guarding concurrent self-mode bootstrap. */
export const BOOTSTRAP_LOCK_FILENAME = '.bootstrap-lock';

/**
 * Directory holding team knowledge assets (skills/rules/docs/learnings/...).
 * All modes read/write knowledge under localConfig.repo.localPath:
 * - git/http: <home>/team-repo
 * - self:     <businessRepoRoot>/.teamai  (committed to main)
 * This is why the ~230 `path.join(localPath, 'skills'|...)` sites need no change.
 */
export function getKnowledgeDir(localConfig: LocalConfig): string {
  return localConfig.repo.localPath;
}

/**
 * Directory holding reports data (members/sessions/votes/stats).
 * - git/http: same as knowledge (localPath) — reports live alongside knowledge.
 * - self:     <localPath>/reports-wt — a git worktree checked out on the
 *             `teamai-reports` orphan branch, so reports never land on main.
 * Callers must ensure the worktree exists first (see ensureReportsWorktree)
 * when the returned path is the self-mode worktree.
 */
export function getReportsDir(localConfig: LocalConfig): string {
  if (isSelfMode(localConfig)) {
    return path.join(localConfig.repo.localPath, REPORTS_WORKTREE_DIRNAME);
  }
  return localConfig.repo.localPath;
}

/**
 * Get the .teamai home directory for a given scope.
 * - user scope  → ~/.teamai (evaluated at call time for test compatibility)
 * - project scope → <projectRoot>/.teamai
 */
export function getTeamaiHome(scope: Scope, projectRoot?: string): string {
  if (scope === 'project') {
    if (!projectRoot) {
      throw new Error(
        'getTeamaiHome: scope is "project" but projectRoot is missing — ' +
        'refusing to silently fall back to the user home directory.',
      );
    }
    return path.join(projectRoot, '.teamai');
  }
  return path.join(getUserHome(), '.teamai');
}

/**
 * Path of the machine-local KEY=value env backup file that the env channel writes
 * on pull and mcp-reconcile reads for ${VAR} resolution.
 *
 * Normally this is `<teamaiHome>/env`. But in single-repo mode `<teamaiHome>` is
 * `<repo>/.teamai`, where `env/` is a committed DIRECTORY holding the shared
 * `env.yaml` — writing a file at `<teamaiHome>/env` there would collide with that
 * directory (EISDIR). So self mode uses `env.local`, which is gitignored (see
 * buildSelfModeGitignore) and never committed. Readers and writers MUST both go
 * through this helper so they never disagree on the path.
 */
export function getEnvBackupPath(localConfig: LocalConfig): string {
  const home = getTeamaiHome(localConfig.scope, localConfig.projectRoot);
  return path.join(home, isSelfMode(localConfig) ? 'env.local' : 'env');
}

/**
 * Get the config.yaml path for a given scope.
 */
export function getConfigPath(scope: Scope, projectRoot?: string): string {
  return path.join(getTeamaiHome(scope, projectRoot), 'config.yaml');
}

/**
 * Get the state.json path for a given scope.
 */
export function getStatePath(scope: Scope, projectRoot?: string): string {
  return path.join(getTeamaiHome(scope, projectRoot), 'state.json');
}

/**
 * Get the managed-hooks manifest path for a given scope. This file indexes the
 * team (B) hooks injected into each tool, so reconcile can clean up hooks that
 * were removed from hooks.yaml (esp. for Cursor, whose entries carry no marker).
 */
export function getManagedHooksPath(scope: Scope, projectRoot?: string): string {
  return path.join(getTeamaiHome(scope, projectRoot), 'managed-hooks.json');
}

/**
 * Get the user-level pushignore path.
 */
export function getPushignorePath(): string {
  return path.join(getUserHome(), '.teamai', 'pushignore');
}

/**
 * Local kill-switch for team (B) hooks. Set TEAMAI_HOOKS_DISABLED=1 to veto
 * team-declared hooks on this machine (built-in operational hooks still apply).
 */
export function areTeamHooksDisabled(): boolean {
  return process.env.TEAMAI_HOOKS_DISABLED === '1' || process.env.TEAMAI_HOOKS_DISABLED === 'true';
}

// ============================================================
// Phase 0 + P4.4：Import 相关类型定义
// ============================================================

/**
 * Git MR/PR 的完整数据结构，由 provider.fetchMergeRequest() 返回。
 */
export interface MRData {
  /** MR 标题 */
  title: string;
  /** MR 描述正文（Markdown） */
  description: string;
  /** 关联的提交列表 */
  commits: Array<{ hash: string; message: string }>;
  /** git diff 全文，截断至 50KB */
  diff: string;
  /** 合并时间（ISO 8601），可选 */
  mergedAt?: string;
  /** MR 作者用户名，可选 */
  author?: string;
  /** MR 原始 URL */
  url: string;
}

/**
 * AI 对单个候选文件的分类结果。
 */
export interface ClassifiedItem {
  /** 源文件路径 */
  sourcePath: string;
  /** 原始文件内容（前 3000 字） */
  rawContent: string;
  /** 知识类型判断 */
  type: 'rule' | 'doc' | 'learning';
  /** AI 建议标题 */
  title: string;
  /** AI 生成的摘要 */
  summary: string;
  /** AI 建议的 tags */
  tags: string[];
  /** 分类置信度 0-1 */
  confidence: number;
  /** 是否为个人偏好/环境特定配置（true 则过滤，不导入团队库） */
  isPersonal: boolean;
}

/**
 * 待推送的 learning 草稿（含完整 Markdown + frontmatter）。
 */
export interface LearningDraft {
  /** 文档标题 */
  title: string;
  /** 完整 Markdown 内容（含 YAML frontmatter） */
  content: string;
  /** 被本 draft 取代的 session learning 文件名列表 */
  supersedes?: string[];
}

/**
 * codebase.md 的单条变更建议（由 MR 提炼产生）。
 */
export interface CodebaseSuggestion {
  /** 要更新的 codebase.md 段落名称 */
  section: string;
  /** 操作类型 */
  action: 'add' | 'update' | 'noop';
  /** 建议写入的 Markdown 内容 */
  content: string;
}

/**
 * codebase.md lint 检查的单条问题。
 */
export interface LintIssue {
  /** 问题严重程度 */
  severity: 'high' | 'medium' | 'low';
  /** 问题类型 */
  category: 'contradiction' | 'outdated' | 'orphan' | 'missing';
  /** 问题位置（章节名或行号区间） */
  location: string;
  /** 问题描述 */
  description: string;
  /** 修复建议 */
  suggestion: string;
}

/**
 * lintCodebaseMd 的返回结构，包含所有发现的问题与总体摘要。
 */
export interface LintReport {
  /** 所有 lint 问题列表 */
  issues: LintIssue[];
  /** 一句话总结 */
  summary: string;
}

/**
 * 单条 import 会话条目，记录每个候选项的处理状态。
 */
export interface ImportSessionItem {
  /** 条目唯一 ID */
  id: string;
  /** 来源文件路径（本地文件导入时） */
  sourcePath?: string;
  /** MR URL（MR 导入时） */
  mrUrl?: string;
  /** 处理状态 */
  status: 'pending' | 'accepted' | 'skipped' | 'edited';
  /** AI 生成的 learning 草稿 */
  learningDraft?: LearningDraft;
  /** AI 生成的 codebase 变更建议 */
  codebaseSuggestions?: CodebaseSuggestion[];
}

/**
 * import 会话的完整状态，持久化到 ~/.teamai/import-session.json 支持 --resume。
 */
export interface ImportSession {
  /** 会话唯一 ID */
  id: string;
  /** 创建时间（ISO 8601） */
  createdAt: string;
  /** 导入模式 */
  mode: 'local' | 'mr' | 'dir';
  /** 所有候选条目 */
  items: ImportSessionItem[];
  /** 已处理条目数（用于 --resume 进度恢复） */
  progress: number;
}
