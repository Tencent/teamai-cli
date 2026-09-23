import { z } from 'zod';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getUserHome, expandHome } from './utils/home.js';
import { log } from './utils/logger.js';

const DEFAULT_COPILOT_HOME = '.copilot';
const COPILOT_USER_MCP_CONFIG = 'mcp-config.json';
const COPILOT_PROJECT_MCP_CONFIG = '.github/mcp.json';

// ─── Tool path config ───────────────────────────────────

export const ToolPathsSchema = z.object({
  skills: z.string().optional(),
  rules: z.string().optional(),
  settings: z.string().optional(),
  /** Standalone hooks file for tools that do not store hooks in settings. */
  hooks: z.string().optional(),
  claudemd: z.string().optional(),
  /** Per-tool agents directory (Phase 1: teamai-recall subagent target).
   * Optional — tools without subagent support omit this and agents sync skips them. */
  agents: z.string().optional(),
  /** User-scope MCP config file (relative to the tool's user root). Omitted = no MCP support. */
  mcp: z.string().optional(),
  /** Project-scope MCP config file. Never defaults from `mcp` — omitting it means
   * the tool has no project-scope MCP support at all. Claude Code shows why the two
   * cannot share a value: user scope is ~/.claude.json but project scope is
   * <root>/.mcp.json, breaking the usual `.<tool>/<file>` convention. */
  mcpProject: z.string().optional(),
  /**
   * User-scope path overrides for tool resources. Most tools store their
   * user-scope resources at the same `.<tool>/<resource>` relative path as their
   * project-scope ones, so this is omitted. OpenCode is the exception: its
   * project-scope config lives at `<root>/.opencode/...` but its user-scope config
   * lives at `~/.config/opencode/...`, a different prefix entirely. When set and the
   * active scope is `user`, these values replace the corresponding base paths.
   *
   * `settings` is overridable here for the same reason: it is the base-path form of
   * the hooks/MCP config file, so a tool whose user config lives under a different
   * prefix than its project config needs it too (Qoder CN: user `~/.qoder-cn/`,
   * project `<root>/.qoder/`). Tools whose two scopes share a prefix omit it.
   */
  userScope: z
    .object({
      skills: z.string().optional(),
      rules: z.string().optional(),
      settings: z.string().optional(),
      agents: z.string().optional(),
      hooks: z.string().optional(),
      claudemd: z.string().optional(),
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
  // isContributeHintEnabled() for the resolved view.
  contributeHint: z.object({
    /** Team default: whether the Stop hook nudges members towards the
     *  share workflow after a high-friction session. Teams that route
     *  knowledge sharing through their own review flow can turn the nudge off
     *  without disabling the rest of the Stop hook (update check, votes sync,
     *  dashboard reporting). */
    enabled: z.boolean().default(true),
  }).optional(),
  // Optional (not .default) so existing TeamaiConfig literals stay valid, AND so
  // "team has no opinion" (block absent) stays distinct from "team says off"
  // (enabled: false). Only the former is a no-op; see resolveCoAuthor().
  coAuthor: z.object({
    /** Team default: whether members' AI-tool commits carry a Co-Authored-By /
     *  attribution trailer. false = strip it (clean history). Users can override
     *  per-machine via `coAuthorEnabled` in local config. */
    enabled: z.boolean().default(true),
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
  // Optional (not .default) so existing TeamaiConfig literals stay valid; use
  // getInterventionSharing() for the defaulted view.
  intervention: z.object({
    /** Extra course-correction keywords, merged with the built-in list
     *  (CORRECTION_KEYWORDS). Teams add the words their members actually type,
     *  e.g. Spanish "rehazlo" or "no era eso". Matched case-insensitively; a
     *  keyword in a space-separated script must appear as a whole word. */
    correctionKeywords: z.array(z.string()).default([]),
  }).optional(),
  // Optional (not .default) so existing TeamaiConfig literals stay valid; use
  // getWebhookSharing() for the defaulted view.
  webhooks: z.object({
    /** Enable webhook notifications for team events. */
    enabled: z.boolean().default(false),
    /** List of webhook endpoints to notify. */
    endpoints: z.array(z.object({
      /** Target URL for the webhook. */
      url: z.string().url(),
      /** Webhook type: feishu (Lark), wecom (WeChat Work), or json (generic). */
      type: z.enum(['feishu', 'wecom', 'json']),
      /** Optional HMAC-SHA256 secret for signature verification. */
      secret: z.string().optional(),
      /** Events to send: push, pull, skill-use, session-start, session-stop. */
      events: z.array(z.string()).default(['push', 'pull', 'skill-use', 'session-start', 'session-stop']),
      /** Request timeout in milliseconds. */
      timeout: z.number().default(5000),
      /** Number of retries on failure with exponential backoff. */
      retries: z.number().default(3),
    })).default([]),
  }).optional(),
});

/** Defaulted view of the optional `sharing.intervention` config. */
export function getInterventionSharing(config: {
  sharing?: { intervention?: { correctionKeywords?: string[] } };
}): { correctionKeywords: string[] } {
  return { correctionKeywords: config.sharing?.intervention?.correctionKeywords ?? [] };
}

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

/**
 * Resolve whether the share-learnings hint is enabled: env kill switch >
 * user override > team config > default (true).
 */
export function isContributeHintEnabled(
  localConfig: { contributeHintEnabled?: boolean },
  teamConfig: { sharing?: { contributeHint?: { enabled?: boolean } } },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.TEAMAI_CONTRIBUTE_HINT_DISABLED === '1') return false;
  if (localConfig.contributeHintEnabled !== undefined) return localConfig.contributeHintEnabled;
  return teamConfig.sharing?.contributeHint?.enabled ?? true;
}

/**
 * Resolve the effective co-author intent: user override > team config > no-op.
 *
 * Returns `undefined` when neither the user nor the team has an opinion — the
 * caller must then leave every tool's config untouched (write-only, never
 * delete). A boolean means "make the trailer on/off"; only then do we write.
 */
export function resolveCoAuthor(
  localConfig: { coAuthorEnabled?: boolean },
  teamConfig: { sharing?: { coAuthor?: { enabled?: boolean } } },
): boolean | undefined {
  if (localConfig.coAuthorEnabled !== undefined) return localConfig.coAuthorEnabled;
  return teamConfig.sharing?.coAuthor?.enabled;
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
  /** Per-skill deployment paths, relative to the configured scope root. */
  installedPaths?: Record<string, string[]>;
}

/** TTL for source repo pull: don't re-pull within this duration (ms). */
export const SOURCE_PULL_TTL_MS = 24 * 60 * 60 * 1000;

export const TEAMAI_SOURCES_DIR = path.join(getUserHome(), '.teamai', 'sources');

export const TeamaiConfigSchema = z.object({
  team: z.string(),
  description: z.string().default(''),
  repo: z.string(),
  /** Git hosting provider. `git` is the transport-only fallback for arbitrary hosts. */
  provider: z.enum(['tgit', 'github', 'cnb', 'gitlab', 'gitcode', 'git']).default('tgit'),
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
  /** Report session/usage stats back into the team repo on pull. Off = the
   * team repo never receives stat commits (e.g. read-only pull setups).
   * Default: on. */
  usageReport: z.boolean().optional(),
  /** Run `git submodule update --init` on pull so skills distributed as git
   * submodules are populated and kept current. Off by default. */
  submodules: z.boolean().optional(),
  /** Team-owned scripts the CLI runs at defined points of a pull — repo-committed
   * entrypoints, distinct from `sharing.hooks.requireTeamScripts` (the
   * `~/.teamai/team-scripts/` trust boundary for hook commands). Every entry is
   * optional, and older CLIs strip the unknown section instead of rejecting the
   * file — so a team repo can adopt one before its members upgrade. */
  scripts: z.object({
    /** Run at the end of a pull, after every sync step (resources,
     * hooks, MCP, reports) has finished. `path` is a Node entrypoint (`.mjs`,
     * `.js`, `.cjs`) relative to the team repo root, and must resolve inside it:
     * a symlink leaving the clone is rejected, since this script runs on every
     * member's machine. */
    postPull: z.object({
      path: z.string().min(1),
    }).optional(),
  }).optional(),
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
    // GitHub Copilot CLI keeps project customizations under .github and moves
    // the complete user customization root when COPILOT_HOME is set. Agents use
    // the official .agent.md format. Hooks and MCP use standalone files;
    // settings.json is deliberately never managed.
    copilot: {
      skills: '.github/skills',
      rules: '.github/instructions',
      agents: '.github/agents',
      hooks: '.github/hooks/teamai.json',
      claudemd: '.github/copilot-instructions.md',
      mcp: COPILOT_USER_MCP_CONFIG,
      mcpProject: COPILOT_PROJECT_MCP_CONFIG,
      userScope: {
        skills: 'skills',
        rules: 'instructions',
        agents: 'agents',
        hooks: 'hooks/teamai.json',
        claudemd: 'copilot-instructions.md',
      },
    },
    // JoyCode: skills, rules (.mdc), and subagents are synced to .joycode/.
    // JoyCode currently does not provide a lifecycle hooks system or startup
    // adapter, so it intentionally has no `settings` path. Hook reconciliation
    // skips JoyCode cleanly without generating ghost files; users must sync
    // manually via `teamai pull`.
    joycode: { skills: '.joycode/skills', rules: '.joycode/rules', agents: '.joycode/agents' },
    qoder: {
      skills: '.qoder/skills',
      rules: '.qoder/rules',
      settings: '.qoder/settings.json',
      agents: '.qoder/agents',
      mcp: '.qoder/settings.json',
      mcpProject: '.qoder/settings.json',
    },
    // Qoder CN is a separate distribution whose *user*-scope directory is
    // ~/.qoder-cn instead of ~/.qoder, so it needs its own entry rather than
    // sharing `qoder`. It reads the same Claude-compatible resource formats.
    //
    // Only the user scope differs. Top-level fields are PROJECT-scope paths and
    // the `userScope` block below carries the user-scope overrides, so the
    // top-level entries stay identical to `qoder`:
    //   ASSUMPTION: Qoder CN's project-scope layout is assumed shared with Qoder
    //   (`<root>/.qoder/`), i.e. the CN build differs from the international
    //   build only in its user directory, not in its per-repo directory. This
    //   could not be verified from this repository — it is a third-party product
    //   layout. If a CN project actually keeps its resources in `<root>/.qoder-cn/`,
    //   the top-level fields below are wrong and must move to `.qoder-cn/`.
    // MCP stays two distinct fields: `mcp` is the user-scope file, `mcpProject`
    // the project-scope one.
    'qoder-cn': {
      skills: '.qoder/skills',
      rules: '.qoder/rules',
      settings: '.qoder/settings.json',
      agents: '.qoder/agents',
      mcp: '.qoder-cn/settings.json',
      mcpProject: '.qoder/settings.json',
      userScope: {
        skills: '.qoder-cn/skills',
        rules: '.qoder-cn/rules',
        settings: '.qoder-cn/settings.json',
        agents: '.qoder-cn/agents',
      },
    },
    // Kiro: skills, steering (rules), and custom agents sync to .kiro/. Kiro CLI
    // 2.x stores lifecycle hooks inside each .kiro/agents/*.json config. The
    // Kiro agent renderer therefore embeds TeamAI's session-start dispatch as
    // `hooks.agentSpawn`; there is no standalone `settings` hook surface.
    // MCP uses the dedicated, mcpServers-only .kiro/settings/mcp.json:
    // https://kiro.dev/docs/mcp/configuration/
    kiro: {
      skills: '.kiro/skills',
      rules: '.kiro/steering',
      agents: '.kiro/agents',
      mcp: '.kiro/settings/mcp.json',
      mcpProject: '.kiro/settings/mcp.json',
    },
    // ZCode: user-level config lives at ~/.zcode/cli/config.json (a shared file
    // that also carries plugin state — reconcile must merge, never replace).
    // Hooks are Claude-shaped but nested under `hooks.events` and gated by
    // `hooks.enabled` (config-file hooks are disabled by default; the writer
    // must force it on). Subagents deploy to ~/.zcode/agents/ as Claude-style
    // Markdown (the CLI also reads <project>/.zcode/agents/ per workspace).
    // User-scope MCP mirrors Claude's shape (`mcpServers` key) in
    // ~/.agents/mcp.json; project scope writes `mcp.servers` inside
    // .zcode/config.json (a different key), which the Claude writer cannot
    // emit — so no mcpProject. ZCode has no user-level rules dir convention.
    zcode: { skills: '.zcode/skills', agents: '.zcode/agents', settings: '.zcode/cli/config.json', mcp: '.agents/mcp.json' },
    // Oh My Pi (OMP): the config root is ~/.omp on every platform (no %APPDATA%
    // on Windows); user-scope resources live in the agent dir ~/.omp/agent/, a
    // different prefix from the project <root>/.omp/, hence userScope. Rules are
    // plain .md, instructions land in AGENTS.md, and MCP uses the Claude-shaped
    // {"mcpServers": …} mcp.json. OMP runs lifecycle hooks as in-process TS
    // extensions rather than a settings hook list, so there is no `settings`
    // path — the adapter in omp-hooks.ts writes the single user-root extension
    // (~/.omp/agent/extensions/teamai-hooks.ts). Profiles (OMP_PROFILE /
    // PI_CODING_AGENT_DIR / PI_CONFIG_DIR) move the agent dir and are not
    // supported.
    omp: {
      skills: '.omp/skills',
      rules: '.omp/rules',
      claudemd: '.omp/AGENTS.md',
      agents: '.omp/agents',
      mcp: '.omp/agent/mcp.json',
      mcpProject: '.omp/mcp.json',
      userScope: {
        skills: '.omp/agent/skills',
        rules: '.omp/agent/rules',
        claudemd: '.omp/agent/AGENTS.md',
        agents: '.omp/agent/agents',
      },
    },
    // Pi Coding Agent: skills/rules/extensions live under the agent root. Pi
    // discovers global context from ~/.pi/agent/AGENTS.md and project context
    // from AGENTS.md/CLAUDE.md walking up the workspace tree. Hooks are
    // TypeScript extensions rather than a settings hook list, so the adapter
    // keeps one user extension and forwards the active cwd to hook-dispatch.
    // Profile overrides (PI_CODING_AGENT_DIR / PI_CONFIG_DIR) that relocate
    // the agent dir are not supported, same as the OMP adapter.
    pi: {
      skills: '.pi/skills',
      rules: '.pi/rules',
      claudemd: 'AGENTS.md',
      userScope: {
        skills: '.pi/agent/skills',
        rules: '.pi/agent/rules',
        claudemd: '.pi/agent/AGENTS.md',
      },
    },
    codebuddy: { skills: '.codebuddy/skills', rules: '.codebuddy/rules', settings: '.codebuddy/settings.json', claudemd: '.codebuddy/CODEBUDDY.md', agents: '.codebuddy/agents', mcp: '.codebuddy/mcp.json', mcpProject: '.mcp.json' },
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
  /**
   * Every logical project this member has participated in, across all their
   * working directories. Append + dedupe semantics (contrast LocalConfig.projects,
   * which is overwrite per-directory): running `init --project` in two directories
   * lists both here while each directory syncs only its own. Optional for
   * backward compatibility with member files written before this field existed.
   */
  projects: z.array(z.string()).optional(),
});

export type MemberConfig = z.infer<typeof MemberConfigSchema>;

// ─── Local config (~/.teamai/config.yaml) ──────────────────

export const LocalConfigSchema = z.object({
  repo: z.object({
    // Expanded at the boundary: the path feeds simple-git, the manifest readers
    // and every resource path, none of which understand `~`.
    localPath: z.string().transform(expandHome),
    remote: z.string(),
    /**
     * Team repo backend. Defaults to 'git' for backward compatibility.
     * - 'git':  a standalone team repo cloned to <home>/team-repo.
     * - 'http': a git-free HTTP team repo (read-only consumer).
     * - 'self': single-repo mode — the business repo IS the team repo.
     *           Knowledge lives on main under <businessRepoRoot>/.teamai/;
     *           reports (members/sessions/votes/stats) live on the
     *           `teamai-reports` orphan branch. localPath = <businessRepoRoot>/.teamai.
     * Independent git clones (`kind: 'git'` or omitted) use the same reports
     * branch; the worktree sits beside the clone, not inside it.
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
  /**
   * Logical projects (manifest ids from projects.yaml) active in THIS directory.
   * Overwrite semantics: the directory syncs exactly these projects' resources.
   * Distinct from #374's path-slug "project" (which decides where data lives).
   * Empty/absent means no project partitioning — role namespaces + shared
   * learnings root only. Optional (not defaulted) so existing configs and test
   * fixtures without the field remain valid; consumers treat absent as [].
   */
  projects: z.array(z.string()).optional(),
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
  /** User-level override for the share-learnings hint. When set, takes precedence over team config. */
  contributeHintEnabled: z.boolean().optional(),
  /** Per-machine override for the co-author trailer in AI-tool commits. When set,
   *  takes precedence over the team `sharing.coAuthor` default. Undefined means
   *  "defer to the team" (see resolveCoAuthor). */
  coAuthorEnabled: z.boolean().optional(),
  /** When set, only inject hooks into these agents. Additive across multiple init --agent runs. */
  enabledAgents: z.array(z.string()).optional(),
  /**
   * Per-machine relocation of a tool's user-scope root, keyed by the same tool
   * id as `toolPaths` (`claude: ~/.claude-work`). A tool that can be told to
   * keep its configuration elsewhere — Claude Code's `CLAUDE_CONFIG_DIR` —
   * reads nothing teamai writes to the team-wide default, and `teamai init`
   * records that variable here so every later run targets the right root.
   * The value must resolve inside HOME; `~/` is expanded.
   */
  toolRoots: z.record(z.string(), z.string()).optional(),
  /** Tools explicitly excluded from all teamai sync (set by `uninstall --agent`). Removed again by `init --agent`. */
  disabledAgents: z.array(z.string()).optional(),
  /**
   * Per-machine map from a gateway/proxy model alias to a known Claude model
   * name, so cost/cache estimation works when the transcript records an opaque
   * alias (e.g. `ep-qxst1hw4`) instead of `claude-opus-...`. The value must
   * contain a token the price table matches (opus / sonnet / haiku / fable /
   * mythos + version). Unset means "match the raw model name only".
   */
  modelAliases: z.record(z.string(), z.string()).optional(),
});

/**
 * In-memory config: the persisted schema plus a runtime-only `dataHome`.
 *
 * `dataHome` is the resolved machine-data home (`~/.teamai/projects/<slug>/` in
 * the P1 partition layout), attached in memory by `detectProjectConfig`/init
 * when the git anchor is resolvable, and consumed by `getDataHome`. It is
 * deliberately NOT part of `LocalConfigSchema`, so:
 *  - on LOAD, Zod strips it from disk (default object parsing drops unknown
 *    keys) — a config.yaml can never inject a `dataHome` that `getDataHome`
 *    would then trust (which would let an attacker point teamai's data home,
 *    and `uninstall`'s recursive remove, at an arbitrary directory);
 *  - on SAVE, `serializeLocalConfig` also drops it (belt-and-braces) — the
 *    value is anchor-derived at runtime and the config file lives INSIDE it, so
 *    persisting an absolute path would be both redundant and machine-specific.
 *
 * `roleUnresolved` is runtime-only the same way. It is set when the legacy role
 * migration could not read the roles manifest, so whether this role-less config
 * holds a role is unknown for this run; `activeRoleIds` then matches no
 * role-scoped entry instead of every one. The next load re-decides it.
 */
export type LocalConfig = z.infer<typeof LocalConfigSchema> & { dataHome?: string; roleUnresolved?: true };
export type LocalConfigInput = z.input<typeof LocalConfigSchema>;

// ─── Local state (~/.teamai/state.json) ────────────────────

/**
 * A resource that was included in a still-open push PR.
 * Matched against fresh scan results by `type` + `name`.
 */
export const PendingPushItemSchema = z.object({
  type: z.string(),
  name: z.string(),
  /** Destination path inside the team repo, e.g. "skills/js/hello-skill". */
  relativePath: z.string(),
  /** Skill namespace chosen at push time, reapplied when the PR is updated. */
  namespace: z.string().optional(),
  /**
   * True when this push PLACED the resource: a root-authored rule or agent
   * written under `<root>/<ns>/`. Once `relativePath` is on the default
   * branch — the PR merged — it becomes a `placedRules`/`placedAgents` record
   * (`reconcilePlacementRecords`). Until then nothing records it, so a PR
   * closed unmerged leaves no record behind, branch deleted or not.
   */
  placed: z.boolean().optional(),
  /**
   * Git blob id of the file this push wrote at `relativePath`, for a placed
   * item. Landing is proven by that blob appearing in the default branch's
   * history for the path after the entry's `base` — not by the path merely
   * existing, which another
   * member's unrelated file would also satisfy.
   */
  blob: z.string().optional(),
});

/**
 * A push branch that has been sent to the remote but whose PR is not merged yet.
 *
 * `teamai push` detects changes by diffing against the team repo's default
 * branch, so resources sitting in an unmerged PR look "new" on every run and
 * used to produce an endless stream of duplicate PRs. Recording them here lets
 * push skip them by default and offer to update the existing PR instead.
 */
export const PendingPushSchema = z.object({
  branch: z.string(),
  prUrl: z.string().nullable().default(null),
  createdAt: z.string(),
  /**
   * Default-branch commit the branch was built on. A placed item's `blob`
   * proves landing only in commits after it: the same content may have sat
   * at that path before this push, and that history proves nothing about it.
   */
  base: z.string().optional(),
  items: z.array(PendingPushItemSchema).default([]),
});

export type PendingPushItem = z.infer<typeof PendingPushItemSchema>;
export type PendingPush = z.infer<typeof PendingPushSchema>;

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
  /**
   * Where push placed each root-level local rule inside the team repo, by rule
   * name, e.g. `{ "my-rule": "rules/fe-know/my-rule.md" }`. The author's copy
   * stays at the tool's rules root after push, so without this record the next
   * scan would read it as a brand-new rule. Only a rule this machine pushed is
   * recorded: an unrelated local rule that merely shares a basename with a
   * namespaced team rule has no entry and is never matched to it. Optional
   * for the same reason as `coAuthorManaged`; absent reads as an empty map.
   */
  placedRules: z.record(z.string(), z.string()).optional(),
  /**
   * Where push placed each new agent inside the team repo, by agent name, e.g.
   * `{ "vr": "agents/fe-agents/vr.yaml" }`. `AgentsHandler.scanLocalForPush`
   * only accepts a team source whose namespace this directory has ACTIVE, so
   * without this record an author who published an agent with `--role`/
   * `--project` could never edit it again: the file they created reads as
   * inactive and the push is skipped. Same shape and same caveats as
   * `placedRules`.
   */
  placedAgents: z.record(z.string(), z.string()).optional(),
  /**
   * Default-branch commit the placement records were last checked against. A
   * record whose file was deleted after it is dropped even if something is at
   * that path again: whatever is there now is somebody else's.
   */
  placementsCheckedAt: z.string().optional(),
  /**
   * `placedAgents` records dropped because the team deleted their file, by
   * agent name. The author's flattened copy stood for that namespaced agent, so
   * once it is tombstoned the copy is the removed agent's, even though no
   * record or active namespace says so any longer (`AgentsHandler.removedStems`).
   */
  retiredPlacedAgents: z.record(z.string(), z.string()).optional(),
  pushedSkills: z.array(z.string()).default([]),
  pushedEnvVars: z.array(z.string()).default([]),
  /** Push branches whose PR is still open — see PendingPushSchema. */
  pendingPushes: z.array(PendingPushSchema).default([]),
  /**
   * Last co-author intent teamai actually wrote to tool configs, per tool file.
   * Key = absolute config path, value = the boolean we last applied. Lets the
   * reconciler stay idempotent (skip a no-op write) while honoring write-only
   * semantics: we never remove a trailer field, we only stop touching it when
   * neither user nor team has an opinion. Absent key = never managed by teamai.
   * Optional (like lastPullTargets) so historical state.json and hand-built State
   * literals stay valid; the reconciler treats absent as an empty map.
   */
  coAuthorManaged: z.record(z.string(), z.boolean()).optional(),
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

/** Where one item lands for one tool. See `ResourceHandler.deliveryTargets`. */
export interface DeliveryTarget {
  tool: string;
  dest: string;
  /**
   * A path this delivery makes redundant, removed once `dest` is written: a
   * rule this machine placed in a namespace is delivered onto the author's
   * root copy, and the `<ns>/<name>` copy an earlier pull wrote is the same
   * rule twice.
   */
  supersedes?: string;
  /**
   * The exact bytes `pullItem` writes at `dest`, for a handler that renders
   * its destination rather than copying a tree there. It is what tells a copy
   * rendered from an older spec from the current one; absent means the handler
   * cannot say, and only the destination's existence can be judged.
   */
  content?: string;
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
  /**
   * Team hooks only: ship only to members whose primaryRole/additionalRoles
   * include one of these ids. Omitted = every member; [] = nobody, like tools.
   */
  roles?: string[];
  /**
   * Team hooks only: ship only to directories bound to one of these logical
   * project ids. Omitted = every directory; [] = nobody. ANDs with `roles`.
   */
  projects?: string[];
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
  /** Restrict to members holding one of these role ids (default = every member; [] = nobody). */
  roles?: string[];
  /**
   * Restrict to directories bound to one of these logical project ids (default =
   * every directory; [] = nobody). ANDs with `roles`: a server scoping both
   * reaches members who match both.
   */
  projects?: string[];
}

/** One injected MCP server recorded in the manifest. */
export interface ManagedMcpRecord {
  name: string;
  /** sha1 (first 16 hex) of the rendered entry; drives idempotent rewrites. */
  hash: string;
}

/** ~/.teamai/managed-mcp.json — team MCP servers injected per tool+scope key. */
export type ManagedMcpManifest = Record<string, ManagedMcpRecord[]>;

/**
 * Ownership key for the managed-MCP manifest, per tool and scope.
 *
 * The P1 partition (issue #374) keys the data home by the shared `projectAnchor`,
 * so the main checkout and every linked worktree share ONE managed-mcp.json.
 * But a project MCP file (`<workspace>/.mcp.json`, `.codex/config.toml`, …) is
 * per-worktree. If the manifest key were just `<tool>:project`, one worktree's
 * reconcile/uninstall would claim ownership of — and overwrite or remove — the
 * MCP entries another worktree wrote into ITS own workspace file. So a
 * project-scope key must carry the CURRENT workspace identity (the per-worktree
 * `workspaceRoot`, not the shared anchor). Both the CLI reconcile/uninstall paths
 * and the local-agent install/uninstall/report paths must build the key here so
 * they agree. user scope has a single global file, so no workspace segment.
 */
/**
 * Ownership key for the managed-MCP manifest, per tool and scope.
 *
 * Each project WORKTREE now has its OWN manifest file (see managedMcpManifestPath),
 * so the file already isolates ownership by worktree — the key needs no workspace
 * segment. It is `<tool>:project` for project scope and `<tool>` for user scope.
 */
export function managedMcpManifestKey(tool: string, projectScope: boolean): string {
  return projectScope ? `${tool}:project` : tool;
}

/** Stable per-worktree identity segment; names the worktree's manifest subdirectory (#374). */
export function managedMcpWorkspaceId(workspaceRoot: string): string {
  return createHash('sha1').update(workspaceRoot).digest('hex').slice(0, 12);
}

/**
 * Path of the managed-MCP manifest.
 *
 * user scope keeps ONE global file at `<dataHome>/managed-mcp.json`.
 *
 * project scope gets a PER-WORKTREE file at
 * `<dataHome>/workspaces/<workspaceId>/managed-mcp.json` (#374). The partition data
 * home is shared by every linked worktree, so a single shared manifest suffered
 * both cross-worktree ownership bleed AND lost updates under concurrent
 * read-modify-write. A file per worktree removes both: each reconcile/install
 * reads and rewrites only its own file, and the key needs no workspace segment.
 */
export function managedMcpManifestPath(dataHome: string, workspaceRoot?: string): string {
  if (workspaceRoot) {
    return path.join(dataHome, 'workspaces', managedMcpWorkspaceId(workspaceRoot), 'managed-mcp.json');
  }
  return path.join(dataHome, 'managed-mcp.json');
}

/**
 * Legacy shared manifest path (pre-#374-per-worktree). Older installs wrote all
 * project ownership into `<dataHome>/managed-mcp.json` (possibly under a bare
 * `<tool>:project` key, or the interim `<tool>:project:<id>` keys). The migration
 * on first project reconcile lifts THIS worktree's records out of that file into
 * its per-worktree file. Same path as the user-scope file, read for compat only.
 */
export function legacyManagedMcpManifestPath(dataHome: string): string {
  return path.join(dataHome, 'managed-mcp.json');
}

// ─── Global options ─────────────────────────────────────

export interface GlobalOptions {
  dryRun?: boolean;
  global?: boolean;
  registry?: string;
  npm?: boolean;
  claude?: boolean;
  verbose?: boolean;
  silent?: boolean;
  /**
   * A human ran the command (the CLI sets it from !--silent): background work
   * may attach to the user's terminal and run on unawaited. Absent = headless
   * (hook) caller: everything must be waited out and captured instead.
   */
  interactive?: boolean;
  /**
   * Force full sync even when repo HEAD matches lastPullRev (`pull`), or skip
   * the confirmation prompt (`remove`).
   */
  force?: boolean;
  /** Push a specific skill by path. */
  skill?: string;
  /** Target role namespace (overrides detected namespace). */
  role?: string;
  /** Push all detected skills without prompting. */
  all?: boolean;
}

// ─── Constants ──────────────────────────────────────────

// Machine-level (class A2) paths under ~/.teamai. These are getters, NOT
// top-level `const`s: a `const path.join(getUserHome(), …)` is evaluated ONCE at
// module import, so a test that later swaps the HOME env var never sees the new
// value. Evaluating at call time (issue #374 P3) makes HOME isolation actually
// work, and keeps a single source of truth for the user home. A2 means they stay
// under ~/.teamai (functionizing is NOT project-scoping — the landing is
// unchanged); the project-scoped equivalents already route through getDataHome().

/** The machine-level teamai home, `~/.teamai` (class A2). Evaluated at call time. */
export function getTeamaiHomeDir(): string {
  return path.join(getUserHome(), '.teamai');
}
/** User-scope global config path, `~/.teamai/config.yaml`. Evaluated at call time. */
export function getUserConfigPath(): string {
  return path.join(getTeamaiHomeDir(), 'config.yaml');
}
/** User-scope global state path, `~/.teamai/state.json`. Evaluated at call time. */
export function getUserStatePath(): string {
  return path.join(getTeamaiHomeDir(), 'state.json');
}
/** API token path, `~/.teamai/token` (machine-level). Evaluated at call time. */
export function getTokenPath(): string {
  return path.join(getTeamaiHomeDir(), 'token');
}
/** Self-update lock path, `~/.teamai/.update-lock`. Evaluated at call time. */
export function getUpdateLockPath(): string {
  return path.join(getTeamaiHomeDir(), '.update-lock');
}

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

// TEAMAI_USAGE_PATH / TEAMAI_KNOWN_SKILLS_PATH / TEAMAI_PUSHIGNORE_PATH were
// module-load consts with no live consumers — the code uses runtime getters
// (usage-tracker.ts getUsagePath/getKnownSkillsPath, getPushignorePath below), so
// they are removed here (issue #374 P3).

/**
 * Local monthly session logs (`teamai session save`). Kept in a dedicated dir —
 * not the sessions directory, which holds per-session contribute-state `.json`.
 * Evaluated at call time so HOME isolation works in tests (issue #374 P3).
 */
export function getSessionLogsDir(): string {
  return path.join(getTeamaiHomeDir(), 'session-logs');
}

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
   * Cumulative token usage across all reported sessions (Claude Code, CodeBuddy,
   * and Codex transcripts; tools without token records contribute nothing).
   * Privacy: counts only.
   */
  tokens?: TokenUsage;
  /** UTC-day buckets used by digest trends. Existing cumulative fields remain for compatibility. */
  daily?: Record<string, DailyUserStats>;
}

/** Aggregated, privacy-preserving activity for one UTC day. */
export interface DailyUserStats {
  sessionsEnded: number;
  sessionsSucceeded: number;
  promptTurns: number;
  durationMs: number;
  sessionsCorrected: number;
  pricedRequests: number;
  /** Estimated API-equivalent cost in integer micro-US-dollars. */
  costMicros: number;
  cacheReadTokens: number;
  cacheEligibleInputTokens: number;
  /** Version of the price table used for new request deltas. */
  priceVersion?: string;
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
 * Token usage breakdown for a session/user. Claude Code and CodeBuddy usage is
 * summed per request. Codex uses a thread-level cumulative snapshot when available;
 * legacy rollout-scoped snapshots are summed once per transcript. All fields are
 * cumulative token counts; tools without token records leave these at zero.
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

/** Scope of a cumulative token snapshot captured from an agent transcript. */
export type TokenSnapshotScope = 'session' | 'transcript';

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
  /** Cumulative token usage across the logical session. */
  tokens: TokenUsage;
}

export type DashboardSessionStatus = 'running' | 'waiting_for_input' | 'error' | 'idle' | 'stopped';

export type DashboardEventType = 'session_start' | 'session_end' | 'tool_use' | 'prompt_submit' | 'stop' | 'process_exit';

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
  /**
   * Whether the full prompt matched a course-correction keyword (built-in list plus
   * the team's `sharing.intervention.correctionKeywords`) when the prompt_submit
   * hook captured it. Absent on events written before this field existed;
   * rebuildSessions then falls back to matching `promptSummary` against the
   * built-in list only.
   */
  correction?: boolean;
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
  /** Byte boundary captured at Copilot SessionStart; private log path is never stored. */
  copilotRunStartOffset?: number;
  /** Opaque marker metadata retained for events written by older collector versions. */
  copilotRunMarkerId?: string;
  copilotRunMarkerOffset?: number;
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
   * Cumulative token usage scanned from the transcript at Stop time. Absent for
   * tools with no transcript (e.g. Cursor) and for sessions with no recorded usage.
   */
  tokens?: TokenUsage;
  /**
   * Scope of `tokens` when the producer exposes it. Codex `token_usage_record`
   * snapshots cover the logical session, while legacy `event_msg.token_count`
   * snapshots cover one rollout/transcript file. Older events and other agents omit
   * this field and retain the historical latest-Stop behavior.
   */
  tokenScope?: TokenSnapshotScope;
  /**
   * Cumulative count of human prompt turns scanned from the transcript at Stop time.
   * Full snapshot (idempotent), sourced from the non-compactable transcript so the
   * reported baseline survives compaction + same-session resume. Absent for tools
   * with no transcript (e.g. Cursor); for those, prompt_submit events are counted.
   */
  prompts?: number;
  /** Cumulative priced-request snapshot collected from a supported transcript. */
  requestMetrics?: RequestCostMetrics;
  /** Cumulative priced-request snapshots grouped by each request's own UTC day. */
  requestDaily?: Record<string, RequestCostMetrics>;
}

export interface RequestCostMetrics {
  pricedRequests: number;
  costMicros: number;
  cacheReadTokens: number;
  cacheEligibleInputTokens: number;
  priceVersion: string;
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

// DASHBOARD_EVENTS_DIR / DASHBOARD_EVENTS_PATH were module-load consts that no
// code consumed — dashboard read/write go through runtime helpers that inline
// getUserHome() (dashboard-collector.ts getEventsPath, dashboard.ts), so HOME
// isolation already works there. Removed (issue #374 P3). The dashboard is an
// A2 machine-level singleton keyed by event cwd/sessionId, not per-project.
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
//  course-correction (contains one of CORRECTION_KEYWORDS or a team keyword from
//  `sharing.intervention.correctionKeywords`) rather than a new task.
//
//  Keywords in a space-separated script (Latin, Cyrillic, ...) must match a whole
//  word: `undo` must not fire on Spanish "segundo" (issue #564). Keywords that
//  contain Han, Hiragana, Katakana or Hangul stay substring matches because those
//  scripts do not separate words with spaces.
//

/** Max time (ms) between a stop and the next prompt for it to count as a correction. */
export const CORRECTION_WINDOW_MS = 60 * 1000;
/** Built-in keywords (lowercased) that mark a prompt as a course-correction, not a new task. */
export const CORRECTION_KEYWORDS = [
  '不对', '不是', '错了', '错误', '重来', '重新', '撤销', '回退', '别这样', '不要',
  'wrong', 'redo', 'undo', 'revert', 'mistake', 'instead', "don't", "that's not", 'not what',
  // Japanese: "that's wrong" / "not that" / "redo" / "you got it wrong" / "on your own" / "put it back".
  '違う', 'ちがう', 'そうじゃな', 'そうではな', 'やり直', 'やりなおし', '間違って', '間違え', '勝手に', '戻して',
];
/** Max bytes to scan from a transcript when counting interventions (guards huge files). */
export const INTERVENTION_SCAN_MAX_BYTES = 50 * 1024 * 1024;
/** Marker that prefixes a user-interrupt entry in the Claude Code transcript. */
export const TRANSCRIPT_INTERRUPT_PREFIX = '[Request interrupted by user';
/** Prefixes of system-injected user messages that are NOT genuine human prompts.
 *  These arrive as user-role transcript entries / UserPromptSubmit payloads but
 *  are harness or hook injections (background-task completions, system reminders,
 *  interrupt markers), so they must not be counted as human turns or shown as prompts. */
export const TRANSCRIPT_SYSTEM_PREFIXES = [
  '<task-notification>',
  '<system-reminder>',
  TRANSCRIPT_INTERRUPT_PREFIX,
];

/**
 * Return the genuine human text from a raw prompt/user-entry, stripping any
 * trailing system-injected block (a real prompt sometimes has a task-notification
 * or system-reminder appended when the user typed mid-turn). Returns '' when the
 * whole message is injected content (no human text before the first marker).
 */
export function stripInjectedPrompt(raw: string): string {
  const trimmed = raw.trimStart();
  // Pure injection: the message itself starts with a marker → no human text.
  if (TRANSCRIPT_SYSTEM_PREFIXES.some((p) => trimmed.startsWith(p))) return '';
  // Mixed: cut at the earliest injected-block marker that appears later.
  let cut = raw.length;
  for (const marker of TRANSCRIPT_SYSTEM_PREFIXES) {
    const i = raw.indexOf(marker);
    if (i >= 0 && i < cut) cut = i;
  }
  return raw.slice(0, cut).trim();
}
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
  /**
   * A generated share-learnings hint awaiting delivery via UserPromptSubmit
   * (used only for tools whose Stop hook ignores stdout — see
   * STOP_STDOUT_UNSUPPORTED_TOOLS). Cleared once injected. Absent for tools
   * that deliver the hint directly through the Stop hook.
   */
  pendingHint?: string;
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

// CONTRIBUTE_SESSIONS_DIR was a module-load const with no live consumers — the
// code uses contribute-check.ts getSessionPath() (inlines getUserHome()), so it
// is removed here (issue #374 P3).

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

// User-scope (A2) learnings mirror / search index / votes. Getters, not consts,
// so HOME isolation works in tests (issue #374 P3). The project-scope equivalents
// route through getDataHome(); these remain the user-scope global landing.
/** User-scope learnings mirror dir, `~/.teamai/learnings`. Evaluated at call time. */
export function getUserLearningsDir(): string {
  return path.join(getTeamaiHomeDir(), 'learnings');
}
/** User-scope search index, `~/.teamai/search-index.json`. Evaluated at call time. */
export function getUserSearchIndexPath(): string {
  return path.join(getTeamaiHomeDir(), 'search-index.json');
}
/** User-scope votes dir, `~/.teamai/votes`. Evaluated at call time. */
export function getUserVotesDir(): string {
  return path.join(getTeamaiHomeDir(), 'votes');
}

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
 * Resolve the base directory into which teamai installs AI-tool resources
 * (skills/rules/agents, tool config files, CLAUDE.md, ...).
 * - user scope    → the platform user home directory (e.g. /Users/xxx)
 * - project scope → the project **workspace root** (localConfig.projectRoot)
 *
 * "workspace root" is the CURRENT git checkout (issue #374): for a git worktree,
 * this is the worktree's own top level, NOT the main checkout, because every AI
 * tool discovers project resources by scanning up from the launch directory to
 * the current repository root. `detectProjectConfig` resolves projectRoot to that
 * workspace root (subdirectory/worktree aware via `resolveAnchors`).
 *
 * This is deliberately separate from the per-project machine-data home: a later
 * phase (P1) keys machine-local data by the shared `projectAnchor` (the main
 * checkout) under `~/.teamai/projects/<slug>/`, while resources continue to land
 * at the workspace root returned here. This function only ever governs resource
 * landing, never machine-data location.
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

export const COPILOT_TOOL_ID = 'copilot';

/** GitHub Copilot CLI's user configuration root, honoring COPILOT_HOME. */
export function getCopilotHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.COPILOT_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(getUserHome(), DEFAULT_COPILOT_HOME);
}

export const CLAUDE_TOOL_ID = 'claude';

/** The `toolPaths.claude` root segment Claude Code uses when it is not relocated. */
export const DEFAULT_CLAUDE_ROOT = '.claude';

/** True when `dir` resolves to something inside the user's home directory. */
function isUnderUserHome(dir: string): boolean {
  const rel = path.relative(getUserHome(), path.resolve(dir));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Root shapes the installed-tool gate can express: a single directory in HOME
 * (`.claude-work`), or `.config/<name>` — the two forms `toolInstallRoot`
 * recognises. Anything deeper (`configs/claude`) would leave every gate keying
 * on the first segment alone, so an unrelated `~/configs` would report the tool
 * as installed and teamai would write into a directory that does not exist.
 */
function isAddressableRootSegment(segment: string): boolean {
  const segments = segment.split('/');
  // `.config` alone is not one of them: `toolInstallRoot('.config/settings.json')`
  // reads it as the two-segment OpenCode-style root, so the gate would look for
  // the settings FILE as the tool's directory and never find it.
  if (segments.length === 1) return segments[0] !== '.config';
  return segments.length === 2 && segments[0] === '.config';
}

/**
 * Tools a member may relocate. An allowlist, not a list of known offenders: a
 * root is only honest for a tool whose every user-scope write goes through
 * `toolPaths`, and most tools keep at least one path teamai resolves elsewhere
 * (OMP's extension dir, Codex and Cursor co-author files, Copilot's
 * `$COPILOT_HOME`, OpenCode's plugin dir), which a partial move would split in
 * half. Claude Code qualifies today — hooks, skills, rules, agents, CLAUDE.md,
 * MCP, model sync and co-author all resolve through `toolPaths`, and the one
 * remaining fixed `.claude` path is `legacyHooksNeedReinject`, a read-only
 * probe for a pre-dispatch migration. `toolRoots` itself stays a generic record,
 * so a tool joins this set as soon as its writes have been audited.
 */
const TOOL_ROOTS_SUPPORTED: ReadonlySet<string> = new Set([CLAUDE_TOOL_ID]);

/**
 * Why `dir` cannot serve as a tool root, as a sentence fragment for a warning —
 * or null when it can. One place decides, so `teamai init` refuses to record
 * exactly the roots `applyToolRoots` would refuse to apply.
 */
export function toolRootRejection(dir: string): string | null {
  const resolved = path.resolve(expandHome(dir));
  if (!isUnderUserHome(resolved)) {
    return `it is outside the home directory ${getUserHome()}, and every tool path is resolved relative to it`;
  }
  const segment = path.relative(getUserHome(), resolved).split(path.sep).join('/');
  if (!isAddressableRootSegment(segment)) {
    return 'a tool root has to be a directory in the home directory other than '
      + '~/.config itself (~/.claude-work), or a ~/.config/<name> directory, '
      + 'because that is what the "is this tool installed?" check can look for';
  }
  return null;
}

/**
 * The Claude Code configuration root `CLAUDE_CONFIG_DIR` asks for, or null when
 * the variable is unset or blank.
 *
 * A value equal to the default `~/.claude` is still an answer, not an absence:
 * Claude Code reads `.claude.json` from INSIDE the configured directory
 * whenever the variable is set, so `~/.claude/.claude.json` rather than
 * `~/.claude.json` — a different file from the one an unset variable means.
 *
 * Read in exactly two commands: `teamai init` records the answer into
 * `toolRoots.claude`, and `teamai doctor` reports a recorded value that no
 * longer matches. Everything else reads the recorded value, so a teamai run
 * from a shell that happens not to export the variable (a hook, a cron, a
 * different terminal) still writes where that Claude Code reads.
 */
export function detectClaudeConfigRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  if (!configured) return null;
  return path.resolve(expandHome(configured));
}

/** Base directory for one tool's resources in the active scope. */
export function resolveToolBaseDir(tool: string, localConfig: LocalConfig): string {
  if (tool === COPILOT_TOOL_ID && localConfig.scope === 'user') return getCopilotHome();
  return resolveBaseDir(localConfig);
}

/** True when `tool` is in localConfig.disabledAgents (excluded from teamai sync). */
export function isAgentDisabled(localConfig: { disabledAgents?: string[] }, tool: string): boolean {
  return localConfig.disabledAgents?.includes(tool) ?? false;
}

/**
 * True when `tool` should be skipped during resource sync: explicitly
 * disabled via disabledAgents, or outside the enabledAgents whitelist when
 * the team scoped its opt-in with `--agent` (undefined whitelist = all
 * installed tools).
 */
/**
 * Synthetic toolPaths key used only to make `teamai push` scan the active tree's
 * .teamai/{skills,rules} in single-repo mode (see pushCore). It is never written
 * to disk and never used by pull — the leading marker keeps it from colliding
 * with any real agent id. It is not a tool, so tool exclusions never apply to it.
 */
export const SELF_KNOWLEDGE_SCAN_KEY = '__teamai_self_knowledge__';

export function isAgentExcluded(
  localConfig: { disabledAgents?: string[]; enabledAgents?: string[] },
  tool: string,
): boolean {
  if (isAgentDisabled(localConfig, tool)) return true;
  return localConfig.enabledAgents ? !localConfig.enabledAgents.includes(tool) : false;
}

/**
 * The directory whose existence marks a tool as "installed" for a given
 * resource path. The tool root is normally the first path segment
 * (`.claude/skills` → `.claude`, `.openclaw/workspace/AGENTS.md` → `.openclaw`).
 *
 * The one exception is OpenCode's user scope, whose paths live under
 * `.config/opencode/...`: there the first segment (`.config`) is a directory
 * nearly every user has, so it would wrongly report OpenCode as installed.
 * For a `.config/<tool>/...` path the root is the first two segments
 * (`.config/opencode`) instead.
 */
export function toolInstallRoot(toolPath: string): string {
  const segments = toolPath.split('/');
  if (segments[0] === '.config' && segments.length > 1) {
    return `${segments[0]}/${segments[1]}`;
  }
  return segments[0] ?? toolPath;
}

/** Path fields of ToolPathsSchema that live under the tool's own user root. */
const TOOL_ROOT_FIELDS = ['skills', 'rules', 'settings', 'hooks', 'claudemd', 'agents', 'mcp'] as const;

/** `userScope` path fields, which carry the same resources at a user-scope root. */
const USER_SCOPE_ROOT_FIELDS = ['skills', 'rules', 'agents', 'hooks', 'claudemd'] as const;

/** Warned roots, so one bad entry does not repeat on every scoped lookup of a pull. */
const warnedToolRoots = new Set<string>();

/**
 * A configured root as a HOME-relative segment, or null when it cannot be used.
 *
 * An unusable entry is warned about and dropped rather than thrown on: the rest
 * of the sync is still correct, and failing a whole pull over one member's typo
 * would be worse than telling them about it.
 */
function toolRootSegment(tool: string, configured: string): string | null {
  if (!TOOL_ROOTS_SUPPORTED.has(tool)) {
    if (!warnedToolRoots.has(tool)) {
      warnedToolRoots.add(tool);
      log.warn(
        `Ignoring toolRoots.${tool}: toolRoots currently supports ${CLAUDE_TOOL_ID} only — `
        + `${tool} has writes teamai does not resolve through toolPaths.`
        + (tool === COPILOT_TOOL_ID ? ' Copilot CLI is relocated with COPILOT_HOME instead.' : ''),
      );
    }
    return null;
  }
  const resolved = path.resolve(expandHome(configured));
  const rejection = toolRootRejection(resolved);
  if (rejection) {
    const key = `${tool}:${resolved}`;
    if (!warnedToolRoots.has(key)) {
      warnedToolRoots.add(key);
      log.warn(`Ignoring toolRoots.${tool} (${resolved}): ${rejection}.`);
    }
    return null;
  }
  return path.relative(getUserHome(), resolved).split(path.sep).join('/');
}

/**
 * Move one tool's paths to `newRoot`. `oldRoots` holds every root the tool's
 * paths hang off, user-scope ones included (OpenCode keeps its user resources
 * under `.config/opencode`, and its user MCP file with them). A field is moved
 * when it hangs off one of those roots, so relocating the tool takes its whole
 * layout along.
 */
function relocateToolPaths(
  paths: z.infer<typeof ToolPathsSchema>,
  oldRoots: ReadonlySet<string>,
  newRoot: string,
): z.infer<typeof ToolPathsSchema> {
  // A bare file name (`.claude.json` beside `.claude`) has no root to match:
  // it travels INSIDE the new one. Claude Code reads .claude.json from within
  // CLAUDE_CONFIG_DIR whenever that variable is set, which is also how it lays
  // itself out under tclaude's customUserDataDir (`.tclaude/.claude.json`), and
  // the same holds for any other file the team declares beside the root. This
  // is why a root EQUAL to the default still changes something and is worth
  // recording.
  const moved = (value: string | undefined): string | undefined => {
    if (value === undefined) return value;
    if (!value.includes('/')) return `${newRoot}/${value}`;
    const root = toolInstallRoot(value);
    return oldRoots.has(root) ? newRoot + value.slice(root.length) : value;
  };

  // `mcpProject` is absent on purpose: it is only ever read in project scope,
  // where paths resolve against the project root and a member's HOME-relative
  // root says nothing.
  const out: z.infer<typeof ToolPathsSchema> = { ...paths };
  for (const field of TOOL_ROOT_FIELDS) {
    if (paths[field] !== undefined) out[field] = moved(paths[field]);
  }
  if (paths.userScope) {
    // Rebuilt field by field, copying only what was there: a consumer that asks
    // which user-scope paths a tool declares reads the keys, and an explicit
    // `undefined` would answer "it declares one" for a path that does not exist.
    const userScope: NonNullable<z.infer<typeof ToolPathsSchema>['userScope']> = {};
    for (const field of USER_SCOPE_ROOT_FIELDS) {
      const value = paths.userScope[field];
      if (value !== undefined) userScope[field] = moved(value);
    }
    out.userScope = userScope;
  }
  return out;
}

/**
 * Apply a member's `toolRoots` to a `toolPaths` map: for each listed tool, every
 * path under that tool's declared root is re-rooted at the configured one.
 *
 * The team's `toolPaths` cannot answer this: it is shared by everyone, while a
 * relocated root (Claude Code's `CLAUDE_CONFIG_DIR`) is a property of one
 * machine. Tools the member did not list, and paths outside the tool's own root,
 * are returned untouched.
 */
export function applyToolRoots(
  toolPaths: Record<string, z.infer<typeof ToolPathsSchema>>,
  toolRoots?: Record<string, string>,
): Record<string, z.infer<typeof ToolPathsSchema>> {
  if (!toolRoots || Object.keys(toolRoots).length === 0) return toolPaths;
  let out: Record<string, z.infer<typeof ToolPathsSchema>> | undefined;
  for (const [tool, configured] of Object.entries(toolRoots)) {
    const paths = toolPaths[tool];
    if (!paths) continue;
    const newRoot = toolRootSegment(tool, configured);
    if (!newRoot) continue;
    // Every root the tool's paths hang off, not just the first one: a team that
    // customized `toolPaths.claude` field by field may have spread them over
    // several. A bare file name (`.claude.json`) is not under a root.
    const oldRoots = new Set<string>();
    for (const field of TOOL_ROOT_FIELDS) {
      const value = paths[field];
      if (value?.includes('/')) oldRoots.add(toolInstallRoot(value));
    }
    for (const field of USER_SCOPE_ROOT_FIELDS) {
      const value = paths.userScope?.[field];
      if (value?.includes('/')) oldRoots.add(toolInstallRoot(value));
    }
    // Not skipped when the root is unchanged: a bare file name (the MCP
    // companion) still moves inside it (see relocateToolPaths).
    out ??= { ...toolPaths };
    out[tool] = relocateToolPaths(paths, oldRoots, newRoot);
  }
  return out ?? toolPaths;
}

/**
 * Return `teamConfig.toolPaths` with per-scope path overrides applied.
 *
 * Almost every tool keeps its user-scope and project-scope resources at the same
 * `.<tool>/<resource>` relative path, so this is the identity map for them. The
 * exception is a tool whose user-scope config lives under a different prefix from
 * its project-scope config; its `userScope` block carries those paths and is
 * spliced in only when the active scope is `user`. OpenCode is such a tool
 * (`~/.config/opencode/` vs `<root>/.opencode/`), and so is Qoder CN
 * (`~/.qoder-cn/` vs `<root>/.qoder/`). Callers that iterate `toolPaths` for
 * scoped resources should iterate the result of this function instead, so the
 * correct path is used.
 *
 * MCP is untouched here: its two scopes are already distinct fields
 * (`mcp` / `mcpProject`), resolved separately in the reconcile engine.
 *
 * User scope also applies the member's `toolRoots` (applyToolRoots). Project
 * scope must not: there the paths hang off the project root, which a
 * HOME-relative member root has nothing to say about.
 */
export function scopedToolPaths(
  teamConfig: TeamaiConfig,
  localConfig: { scope?: Scope; toolRoots?: Record<string, string> },
): Record<string, z.infer<typeof ToolPathsSchema>> {
  if (localConfig.scope !== 'user') return teamConfig.toolPaths;
  const rooted = applyToolRoots(teamConfig.toolPaths, localConfig.toolRoots);
  const out: Record<string, z.infer<typeof ToolPathsSchema>> = {};
  for (const [tool, paths] of Object.entries(rooted)) {
    const us = paths.userScope;
    if (!us) {
      out[tool] = paths;
      continue;
    }
    out[tool] = {
      ...paths,
      ...(us.skills !== undefined ? { skills: us.skills } : {}),
      ...(us.rules !== undefined ? { rules: us.rules } : {}),
      ...(us.settings !== undefined ? { settings: us.settings } : {}),
      ...(us.agents !== undefined ? { agents: us.agents } : {}),
      ...(us.hooks !== undefined ? { hooks: us.hooks } : {}),
      ...(us.claudemd !== undefined ? { claudemd: us.claudemd } : {}),
    };
  }
  return out;
}

/** True when the local config is single-repo mode (the business repo is the team repo). */
export function isSelfMode(localConfig: { repo: { kind?: string } }): boolean {
  return localConfig.repo.kind === 'self';
}

/**
 * True when report dirs (`members/` `sessions/` `votes/` `stats/`) live on the
 * `teamai-reports` orphan branch instead of the default branch. HTTP backends
 * keep their API write path; every other kind (self, git, and legacy configs
 * that omit `kind`) uses the reports branch.
 */
/**
 * True when this repo keeps side data on a teamai orphan branch rather than on
 * the default branch. HTTP backends keep their API write path; every other kind
 * (self, git, and legacy configs that omit `kind`) uses the side branches.
 */
export function usesBranchWorktree(localConfig: { repo: { kind?: string } }): boolean {
  return localConfig.repo.kind !== 'http';
}

/** Orphan branch that carries reports (members/sessions/votes/stats) for non-HTTP repos. */
export const REPORTS_BRANCH = 'teamai-reports';
/** Worktree directory name that checks out the reports orphan branch. */
export const REPORTS_WORKTREE_DIRNAME = 'reports-wt';
/** Orphan branch that carries `learnings/` for non-HTTP repos. */
export const LEARNINGS_BRANCH = 'teamai-learnings';
/** Worktree directory name that checks out the learnings orphan branch. */
export const LEARNINGS_WORKTREE_DIRNAME = 'learnings-wt';
/** Worktree directory (under .teamai) used to stage knowledge PRs off the active tree. */
export const KNOWLEDGE_WORKTREE_DIRNAME = 'knowledge-wt';
/**
 * Every worktree directory teamai creates. A side branch's `.gitignore` lists
 * all of them, so no worktree can ever nest-track another.
 */
export const WORKTREE_DIRNAMES: readonly string[] = [
  REPORTS_WORKTREE_DIRNAME,
  LEARNINGS_WORKTREE_DIRNAME,
  KNOWLEDGE_WORKTREE_DIRNAME,
];
/** Lock filename (under <repo>/.teamai) guarding concurrent reports-branch writes. */
export const REPORTS_LOCK_FILENAME = '.reports-lock';
/** Lock filename (under <repo>/.teamai) guarding concurrent learnings-branch writes. */
export const LEARNINGS_LOCK_FILENAME = '.learnings-lock';
/** Lock filename (under <repo>/.teamai) guarding concurrent self-mode bootstrap. */
export const BOOTSTRAP_LOCK_FILENAME = '.bootstrap-lock';
/**
 * Lock filename (in the project data home) serializing writes to the SHARED team
 * clone during pull/push. All worktrees of a repo resolve to the same partition
 * (keyed on projectAnchor), so this lock coordinates a `git pull`/`git push` that
 * could otherwise run concurrently from the main checkout and a worktree and
 * corrupt the shared clone.
 */
export const SYNC_LOCK_FILENAME = '.sync-lock';

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
 * Directory holding this project's machine-local teamai data (search index,
 * env backup, managed manifests, local-agent resource cache, and — in a later
 * phase — config.yaml/state.json and the team-repo clone).
 *
 * This is the single source of truth for the machine-data home, sitting beside
 * `getKnowledgeDir` (team knowledge assets) and `resolveBaseDir` (AI-tool
 * resource landing = the workspace root). The three are orthogonal:
 * knowledge / resource-landing / machine-data.
 *
 * Today it returns `getTeamaiHome(scope, projectRoot)` — i.e. `<projectRoot>/.teamai`
 * for project scope, `~/.teamai` for user scope. A later phase (P1) redirects the
 * project-scope case to a per-project partition under `~/.teamai/projects/<slug>/`
 * keyed by the shared `projectAnchor`; every consumer already routes through this
 * function, so that redirect happens in one place.
 */
export function getDataHome(localConfig: LocalConfig): string {
  // A resolved partition dataHome (attached at detection/init) wins. Otherwise
  // fall back to the legacy in-workspace location. In the P1-2A refactor no
  // caller attaches dataHome yet, so this is still exactly getTeamaiHome — the
  // partition redirect is switched on in P1-2B by making detection attach it.
  if (localConfig.dataHome) return localConfig.dataHome;
  return getTeamaiHome(localConfig.scope, localConfig.projectRoot);
}

/**
 * Directory holding reports data (members/sessions/votes/stats).
 * - http: same as knowledge (localPath) — HTTP does not use the git reports branch.
 * - self: <localPath>/reports-wt — nested under the knowledge dir (`.teamai/`).
 * - git (and legacy configs with no kind): sibling of the clone
 *   (`<dirname(localPath)>/reports-wt`) so clone `reset --hard` cannot nest-destroy it.
 * Callers must ensure the worktree exists first (see ensureReportsWorktree)
 * when the returned path is a reports-branch worktree.
 */
export function getReportsDir(localConfig: LocalConfig): string {
  return getWorktreeDir(localConfig, REPORTS_WORKTREE_DIRNAME);
}

/**
 * Where a side-branch worktree lives for this repo.
 * - http: the knowledge dir itself — HTTP has no git branch to check out.
 * - self: <localPath>/<dirname> — nested under the knowledge dir (`.teamai/`).
 * - git (and legacy configs with no kind): sibling of the clone
 *   (`<dirname(localPath)>/<dirname>`) so clone `reset --hard` cannot
 *   nest-destroy it.
 * Callers must ensure the worktree exists first (see the branch-worktree
 * module) when the returned path is a side-branch checkout.
 */
export function getWorktreeDir(localConfig: LocalConfig, dirname: string): string {
  if (!usesBranchWorktree(localConfig)) {
    return localConfig.repo.localPath;
  }
  if (isSelfMode(localConfig)) {
    return path.join(localConfig.repo.localPath, dirname);
  }
  return path.join(path.dirname(localConfig.repo.localPath), dirname);
}

/**
 * The business repo root for a self-mode config: knowledge lives in `.teamai/`
 * inside it. Falls back to the parent of the knowledge dir for configs written
 * before `businessRepoRoot` was recorded.
 */
export function getBusinessRoot(localConfig: LocalConfig): string {
  return localConfig.repo.businessRepoRoot ?? path.dirname(localConfig.repo.localPath);
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
  // Route through getDataHome (not getTeamaiHome directly) so the plaintext
  // env backup follows the machine-data home together with env.sh. Otherwise
  // P1-2's partition redirect would move env.sh into ~/.teamai/projects/<slug>/
  // while leaving the KEY=value backup (which carries plaintext values) behind
  // in <projectRoot>/.teamai — breaking "zero workspace residue" and leaking
  // sensitive values into the business repo directory.
  const home = getDataHome(localConfig);
  return path.join(home, isSelfMode(localConfig) ? 'env.local' : 'env');
}

/**
 * Get the config.yaml path for a given scope.
 */
export function getConfigPath(scope: Scope, projectRoot?: string): string {
  return path.join(getTeamaiHome(scope, projectRoot), 'config.yaml');
}

/**
 * Get the state.json path for a config. state.json is per-project machine data
 * that lives beside config.yaml in the data home, so it routes through
 * getDataHome (partition-aware in P1-2B).
 */
export function getStatePath(localConfig: LocalConfig): string {
  return path.join(getDataHome(localConfig), 'state.json');
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
 * Resolve where hooks are injected on disk for a config: the (baseDir,
 * manifestPath) pair every hook injection path must share.
 *
 * The rule is load-bearing and was previously duplicated (and drifted) across
 * `init`/`pull`/`bootstrap` (which used resolveBaseDir → projectRoot) and the
 * `hooks inject` command (which used HOME, per #264). The divergence meant a
 * project-scope `teamai init` tried to write the SessionStart hook into
 * `<projectRoot>/.claude`, which does not exist yet on a fresh init, so the
 * "only inject into installed tools" gate skipped every tool — leaving the
 * project with no session-start hook and therefore no auto-pull.
 *
 * Canonical rule:
 * - Non-self project scope → HOME + user manifest. `~/.claude` always exists,
 *   so the gate passes; the dispatch runtime identifies the active project via
 *   detectProjectConfig(stdin.cwd), so a projectRoot copy is unnecessary (#264).
 * - Self single-repo mode → projectRoot (its resolveBaseDir). Hooks live in the
 *   business repo's tool dirs and are committed to main so a teammate's clone
 *   carries the session-start hook that self-heals ("clone = initialized").
 * - User scope → HOME (its resolveBaseDir).
 *
 * Degrades gracefully: only self mode reaches the projectRoot branch, and a
 * self config missing `projectRoot` (optional in the schema) falls back to HOME
 * rather than throwing — so read-only callers like `doctor` never crash on a
 * partially-broken config.
 */
export function resolveHookScope(
  localConfig: LocalConfig,
): { baseDir: string; manifestPath: string; scope: Scope } {
  const selfWithRoot = isSelfMode(localConfig) && !!localConfig.projectRoot;
  if (localConfig.scope === 'project' && !selfWithRoot) {
    // Hooks resolve to HOME here, so the tool paths must be resolved at *user*
    // scope too: a tool whose user-scope prefix differs from its project-scope
    // one (OpenCode, Qoder CN) would otherwise be written under the project
    // prefix, inside HOME. `scope` is returned so callers resolve paths and
    // base dir from one decision instead of re-deriving it (#370, #667).
    return { baseDir: getUserHome(), manifestPath: getManagedHooksPath('user'), scope: 'user' };
  }
  return {
    baseDir: resolveBaseDir(localConfig),
    manifestPath: getManagedHooksPath(localConfig.scope, localConfig.projectRoot),
    scope: localConfig.scope,
  };
}

/**
 * Absolute user-scope root directory of a tool (`.claude` → `~/.claude`),
 * honoring a member's `toolRoots`. For the few writers that address a tool's
 * root directly instead of through a `toolPaths` entry.
 */
export function resolveToolRootDir(
  tool: string,
  defaultRoot: string,
  toolRoots?: Record<string, string>,
): string {
  const configured = toolRoots?.[tool];
  const segment = configured ? toolRootSegment(tool, configured) : null;
  return path.join(getUserHome(), segment ?? defaultRoot);
}

/**
 * The legacy `<projectRoot>` hook location a pre-#370 CLI wrote to for a
 * non-self project scope, whose hooks now live in HOME (`resolveHookScope`).
 * Older `init`/`pull` runs wrote the SessionStart hook into
 * `<projectRoot>/.claude` as well; left behind after upgrade it double-fires
 * (two `hook-dispatch session-start` → two concurrent background pulls) and
 * duplicates every team hook. Callers on the inject path (`init`/`pull`) and
 * `hooks remove`/`uninstall` sweep it clean.
 *
 * Returns null when there is nothing project-owned to sweep:
 * - user scope (only ever HOME),
 * - project scope without a projectRoot,
 * - self single-repo mode. Self mode's alternate location is HOME, which is
 *   shared with any user-scope install and its user manifest — a blind
 *   removeAll there would clobber genuine user-scope hooks, so we never sweep
 *   it. (The cross-scope collision itself is tracked separately.)
 * - projectRoot that IS the home dir (`teamai init .` run in `~`, e.g. a
 *   dotfiles repo). Then the "legacy" location and the live HOME target are the
 *   same file, and sweeping it would delete the hooks the primary pass just
 *   wrote. This is what makes the "never returns HOME" invariant callers rely
 *   on actually hold.
 */
export function resolveLegacyProjectHookScope(
  localConfig: LocalConfig,
): { baseDir: string; manifestPath: string; scope: Scope } | null {
  if (localConfig.scope !== 'project' || !localConfig.projectRoot) return null;
  if (isSelfMode(localConfig)) return null;
  if (path.resolve(localConfig.projectRoot) === path.resolve(getUserHome())) return null;
  return {
    baseDir: localConfig.projectRoot,
    manifestPath: getManagedHooksPath('project', localConfig.projectRoot),
    scope: 'project',
  };
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

// ─── Webhook types ──────────────────────────────────────

export const WebhookEndpointSchema = z.object({
  url: z.string().url(),
  type: z.enum(['feishu', 'wecom', 'json']),
  secret: z.string().optional(),
  events: z.array(z.string()).default(['push', 'pull', 'skill-use', 'session-start', 'session-stop']),
  timeout: z.number().default(5000),
  retries: z.number().default(3),
});

export const WebhookConfigSchema = z.object({
  enabled: z.boolean().default(false),
  endpoints: z.array(WebhookEndpointSchema).default([]),
});

export type WebhookEndpoint = z.infer<typeof WebhookEndpointSchema>;
export type WebhookConfig = z.infer<typeof WebhookConfigSchema>;

export interface WebhookPayload {
  event: string;
  timestamp: string;
  tool: string;
  sessionId?: string;
  cwd?: string;
  team?: string;
  username?: string;
  data: Record<string, unknown>;
}

/** Defaulted view of the optional `sharing.webhooks` config. */
export function getWebhookSharing(config: {
  sharing?: {
    webhooks?: {
      enabled?: boolean;
      endpoints?: Array<{
        url: string;
        type: string;
        secret?: string;
        events?: string[];
        timeout?: number;
        retries?: number;
      }>;
    };
  };
}): WebhookConfig {
  const w = config.sharing?.webhooks;
  return {
    enabled: w?.enabled ?? false,
    // Preserve every schema-accepted field. Previously `secret` was dropped and
    // `timeout`/`retries` were force-overridden, so a configured signing secret
    // never reached the request and receivers with signature verification
    // rejected the (unsigned) webhook (#703).
    endpoints: (w?.endpoints ?? []).map((ep) => ({
      url: ep.url,
      type: ep.type as 'feishu' | 'wecom' | 'json',
      secret: ep.secret,
      events: ep.events ?? ['push', 'pull', 'skill-use', 'session-start', 'session-stop'],
      timeout: ep.timeout ?? 5000,
      retries: ep.retries ?? 3,
    })),
  };
}
