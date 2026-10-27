import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getUserHome, expandHome } from './utils/home.js';
import { log } from './utils/logger.js';
import { realHost, toolHome } from './tool-home.js';
import { channelsOf } from './tools.js';
import type { WorkspaceChildren } from './workspace-children.js';
import type { HeadState } from './utils/git.js';
import type { RunMode } from './launch-context.js';
import { AllowSchema } from './workflow/requirements.js';

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
   *
   * `rules: null` says the tool reads no rules directory in user scope, while
   * its project scope keeps one (JoyCode, Pi): its user rules come from a file
   * of its own (`userRulesFile`, #946).
   */
  userScope: z
    .object({
      skills: z.string().optional(),
      rules: z.string().nullable().optional(),
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

/**
 * The install scope a member names in `--scope` and in config.yaml (#1099).
 * `workspace` is the current name of the scope rooted at a directory; `project`
 * is its older name and stays accepted. Both parse to the internal `project`,
 * so code compares against one value; the serializer writes `workspace`.
 */
export const InstallScopeSchema = z
  .enum(['user', 'workspace', 'project'])
  .transform((scope): Scope => (scope === 'workspace' ? 'project' : scope));

/** The value of a `--scope` option. Every command that takes one reads it here. */
export function parseInstallScope(value: string): Scope {
  const parsed = InstallScopeSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid scope "${value}". Use "workspace" or "user".`);
  return parsed.data;
}

/** The name a member sees and config.yaml stores for an install scope. */
export function installScopeName(scope: Scope): 'user' | 'workspace' {
  return scope === 'project' ? 'workspace' : scope;
}

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
  // isGitExcludeEnabled() for the resolved view.
  gitExclude: z.object({
    /** Keep what teamai delivers into a project out of git, through teamai's
     *  `delivered` block in the clone's `.git/info/exclude` (#915). `init`
     *  writes true into a new team's teamai.yaml; absent means off. */
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
  // Optional (not .default) so existing TeamaiConfig literals stay valid; use
  // isMrHintEnabled() for the resolved view.
  mrHint: z.object({
    /** Team default: whether the SessionStart hook tells members about MRs the
     *  team merged recently. Kept separate from `contributeHint` (#988): a team
     *  that routes knowledge sharing through its own review flow can drop the
     *  MR summary while keeping the Stop hook's nudge, or the other way round. */
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
  // Optional: absent = no opinion, and teamai leaves every tool's own
  // auto-compact setting alone. See resolveAutoCompactTokens().
  autoCompact: z.object({
    /** Context size, in tokens, at which members' AI tools compact the
     *  conversation. Each tool expresses it its own way (window, limit or
     *  ratio); see autocompact-reconcile.ts. Members can override per machine
     *  via `autoCompactTokens` in local config. */
    tokens: z.number().int().positive(),
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

/**
 * Resolve whether pull keeps what it delivers into a project out of git
 * (#915): the member's `gitExcludeEnabled` in the partition config > the
 * team's `sharing.gitExclude.enabled` > default (false). A checkout still on
 * the un-migrated layout reads its own config from `<projectRoot>/.teamai/`,
 * and its worktrees each have one: that member value is not read, so no single
 * checkout decides for the exclude file they share.
 */
export function isGitExcludeEnabled(
  localConfig: { gitExcludeEnabled?: boolean; scope?: string; projectRoot?: string; dataHome?: string },
  teamConfig: { sharing?: { gitExclude?: { enabled?: boolean } } },
): boolean {
  const member = isUnmigratedDataHome(localConfig) ? undefined : localConfig.gitExcludeEnabled;
  return member ?? teamConfig.sharing?.gitExclude?.enabled ?? false;
}

/**
 * isGitExcludeEnabled with the team config as `loadTeamConfig` returns it.
 * `undefined` when nothing can decide: git mode, no member override, and the
 * team's teamai.yaml could not be read or validated. That is not "off": a
 * caller leaves what the setting governs as it is. HTTP mode has no team
 * setting, so the member's override or the default decides there.
 */
export function resolveGitExclude(
  localConfig: Parameters<typeof isGitExcludeEnabled>[0] & { repo: { kind?: string } },
  teamConfig: Parameters<typeof isGitExcludeEnabled>[1] | null,
): boolean | undefined {
  if (teamConfig || localConfig.repo.kind === 'http') return isGitExcludeEnabled(localConfig, teamConfig ?? {});
  return isUnmigratedDataHome(localConfig) ? undefined : localConfig.gitExcludeEnabled;
}

/** Whether a project config was read from the checkout's own `.teamai/` rather than its partition. */
export function isUnmigratedDataHome(localConfig: { scope?: string; projectRoot?: string; dataHome?: string }): boolean {
  const { scope, projectRoot, dataHome } = localConfig;
  return scope === 'project' && !!projectRoot && !!dataHome && path.resolve(dataHome) === path.resolve(projectRoot, '.teamai');
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
 * Resolve whether the SessionStart MR hint is enabled: env kill switch >
 * user override > team config > default (true).
 *
 * Deliberately not folded into isContributeHintEnabled: #988 keeps the MR hint
 * separate from the share workflow, so neither switch may turn the other off.
 */
export function isMrHintEnabled(
  localConfig: { mrHintEnabled?: boolean },
  teamConfig: { sharing?: { mrHint?: { enabled?: boolean } } },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.TEAMAI_MR_HINT_DISABLED === '1') return false;
  if (localConfig.mrHintEnabled !== undefined) return localConfig.mrHintEnabled;
  return teamConfig.sharing?.mrHint?.enabled ?? true;
}

/** Resolve whether pull reports usage stats: user override > team config > default (true). */
export function isUsageReportEnabled(
  localConfig: { usageReportEnabled?: boolean },
  teamConfig: { usageReport?: boolean },
): boolean {
  return localConfig.usageReportEnabled ?? teamConfig.usageReport ?? true;
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

/**
 * Resolve the auto-compact threshold in tokens. The member's per-machine
 * `autoCompactTokens` wins (0 = opt out); else the team's
 * `sharing.autoCompact.tokens`. Undefined means teamai sets nothing, and takes
 * back what it set before.
 */
export function resolveAutoCompactTokens(
  localConfig: { autoCompactTokens?: number },
  teamConfig: { sharing?: { autoCompact?: { tokens?: number } } },
): number | undefined {
  if (localConfig.autoCompactTokens !== undefined) {
    return localConfig.autoCompactTokens > 0 ? localConfig.autoCompactTokens : undefined;
  }
  return teamConfig.sharing?.autoCompact?.tokens;
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
//  ~/.teamai/source-repos/<repo-url-sha256>/repo/ ← git clone
//  ~/.teamai/source-repos/<repo-url-sha256>/last-pull.json ← repo pull TTL
//  ~/.teamai/sources/<name>/installations/<installation-id>.json ← per-team, per-destination manifest
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

/** Source installation manifest, keyed by team checkout and resource destination. */
export interface SourceInstallManifest {
  /** Absolute destination root, allowing other installations to protect shared paths. */
  destinationRoot?: string;
  /** Consumer checkout, retained for manual review even if it is moved or deleted. */
  teamCheckout?: string;
  /** Hash of the configured repository URL, used to reject conflicting writers. */
  repositoryId?: string;
  /** ISO timestamp of last successful pull. */
  lastPull: string;
  /** Skill names currently deployed from this source. */
  installedSkills: string[];
  /** Per-skill deployment paths, relative to the configured scope root. */
  installedPaths?: Record<string, string[]>;
  /** Original physical destination for each recorded relative deployment path. */
  installedPhysicalPaths?: Record<string, string>;
  /** For each absolute destination, the tool home it lay in when recorded (#993): a home that moved since leaves the copy unmanaged. */
  installedHomes?: Record<string, string>;
}

/** TTL for source repo pull: don't re-pull within this duration (ms). */
export const SOURCE_PULL_TTL_MS = 24 * 60 * 60 * 1000;

export const TEAMAI_SOURCES_DIR = path.join(getUserHome(), '.teamai', 'sources');

/** Git hosting provider. `git` is the transport-only fallback for arbitrary hosts. */
export const ProviderNameSchema = z.enum(['tgit', 'github', 'cnb', 'gitlab', 'gitcode', 'git']);
export type ProviderName = z.infer<typeof ProviderNameSchema>;

/** One team-owned Node entrypoint. `path` is relative to the team repo root. */
const TeamScriptSchema = z.object({
  path: z.string().min(1),
});

/**
 * Default tool paths for built-in tools.
 * MCP paths are only set for tools whose config location has been verified.
 * Tools left without `mcp` are skipped by MCP sync rather than guessed at, so a
 * wrong guess can never create a junk config file on a user's machine.
 */
export const DEFAULT_TOOL_PATHS = {
  claude: { skills: '.claude/skills', rules: '.claude/rules', settings: '.claude/settings.json', claudemd: '.claude/CLAUDE.md', agents: '.claude/agents', mcp: '.claude.json', mcpProject: '.mcp.json' },
  // Codex reads no rules directory: `.codex/rules` holds its exec-policy
  // `*.rules` files. In user scope teamai's blocks go to ~/.codex/AGENTS.md,
  // which only Codex reads. In project scope they come from the session-start
  // hook, since the project AGENTS.md is the owners' file and other tools
  // read it too (#938, #945); so the entry has no project `claudemd`.
  // Codex reads the project MCP config only in a trusted project (#954).
  codex: {
    skills: '.codex/skills',
    settings: '.codex/hooks.json',
    agents: '.codex/agents',
    mcp: '.codex/config.toml',
    mcpProject: '.codex/config.toml',
    userScope: { claudemd: '.codex/AGENTS.md' },
  },
  // codex-internal and tcodex run the same Codex from their own home root, so
  // they take the codex shape. Their user-scope AGENTS.md locations
  // (~/.codex-internal/AGENTS.md, ~/.tcodex/AGENTS.md) are assumed from that,
  // not verified against either build.
  'codex-internal': {
    skills: '.codex-internal/skills',
    settings: '.codex-internal/hooks.json',
    agents: '.codex-internal/agents',
    userScope: { claudemd: '.codex-internal/AGENTS.md' },
  },
  'claude-internal': { skills: '.claude-internal/skills', rules: '.claude-internal/rules', settings: '.claude-internal/settings.json', claudemd: '.claude-internal/CLAUDE.md', agents: '.claude-internal/agents' },
  // tclaude ships Claude Code with `customUserDataDir: .tclaude`, which
  // relocates the whole user data dir — so its MCP file is
  // ~/.tclaude/.claude.json, not ~/.tclaude.json. No mcpProject: project scope
  // for the Claude family is <root>/.mcp.json, which the `claude` target
  // already writes and tclaude reads from the same location.
  tclaude: { skills: '.tclaude/skills', rules: '.tclaude/rules', settings: '.tclaude/settings.json', claudemd: '.tclaude/CLAUDE.md', agents: '.tclaude/agents', mcp: '.tclaude/.claude.json' },
  // Same shape as codex; see codex-internal above.
  tcodex: {
    skills: '.tcodex/skills',
    settings: '.tcodex/hooks.json',
    agents: '.tcodex/agents',
    userScope: { claudemd: '.tcodex/AGENTS.md' },
  },
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
  // manually via `teamai pull`. In user scope it reads no rules directory:
  // its team rules are a block in ~/.joycode/rules.txt (#946).
  joycode: { skills: '.joycode/skills', rules: '.joycode/rules', agents: '.joycode/agents', userScope: { rules: null } },
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
  // V3 reads the standalone .kiro/hooks/teamai.json lifecycle hook. Legacy
  // TeamAI agentSpawn entries are migrated out of agent files; Kiro 2.x
  // does not support this standalone lifecycle integration.
  // MCP uses the dedicated, mcpServers-only .kiro/settings/mcp.json:
  // https://kiro.dev/docs/mcp/configuration/
  kiro: {
    skills: '.kiro/skills',
    rules: '.kiro/steering',
    agents: '.kiro/agents',
    mcp: '.kiro/settings/mcp.json',
    mcpProject: '.kiro/settings/mcp.json',
  },
  // Trae (trae.ai) is a VS Code-family IDE. Per its docs and its bundled
  // code (verified against the installed app): project skills live in
  // <root>/.trae/skills/<name>/SKILL.md, project rules in .trae/rules/*.md
  // (frontmatter `alwaysApply` / `globs`, globs comma-separated, parsed by
  // lines — see trae-rule.ts), and project MCP in .trae/mcp.json holding a
  // Claude-shaped `mcpServers` object map. User rules are NOT ~/.trae/rules
  // but ~/.trae/user_rules (the default file is user_rules.md), so
  // userScope.rules carries that name. User-level MCP has no
  // teamai-writable cross-platform file: the IDE keeps it next to its
  // user settings (~/Library/Application Support/Trae/User/mcp.json on
  // macOS, %APPDATA%/… on Windows), so only `mcpProject` is set. Trae has
  // no settings-based hook surface and no subagents directory, so those
  // keys stay absent (like JoyCode, users sync via `teamai pull`).
  trae: {
    skills: '.trae/skills',
    rules: '.trae/rules',
    mcpProject: '.trae/mcp.json',
    userScope: { rules: '.trae/user_rules' },
  },
  // Trae CN (domestic.trae.cn) shares every project path with the
  // international build (verified on installed apps: only the user
  // directory differs, ~/.trae-cn). Both map the same .trae/mcp.json, and
  // one shared ownership record covers the pair
  // (MCP_MANIFEST_KEY_ALIAS), so whichever build a member runs, its
  // target writes, updates and cleans the file.
  'trae-cn': {
    skills: '.trae/skills',
    rules: '.trae/rules',
    mcpProject: '.trae/mcp.json',
    userScope: {
      skills: '.trae-cn/skills',
      rules: '.trae-cn/user_rules',
    },
  },
  // ZCode: user-level config lives at ~/.zcode/cli/config.json (a shared file
  // that also carries plugin state — reconcile must merge, never replace).
  // Hooks are Claude-shaped but nested under `hooks.events` and gated by
  // `hooks.enabled` (config-file hooks are disabled by default; the writer
  // must force it on). Subagents deploy to ~/.zcode/agents/ as Claude-style
  // Markdown (the CLI also reads <project>/.zcode/agents/ per workspace).
  // MCP servers go under `mcp.servers` in that config.json, and in a
  // project's .zcode/config.json (#1221). ZCode has no user-level rules dir convention.
  zcode: {
    skills: '.zcode/skills', agents: '.zcode/agents', settings: '.zcode/cli/config.json', mcp: '.zcode/cli/config.json', mcpProject: '.zcode/config.json',
  },
  // Oh My Pi (OMP): the config root is ~/.omp on every platform (no %APPDATA%
  // on Windows); user-scope resources live in the agent dir ~/.omp/agent/, a
  // different prefix from the project <root>/.omp/, hence userScope. Rules are
  // plain .md, instructions land in AGENTS.md, and MCP uses the Claude-shaped
  // {"mcpServers": …} mcp.json. OMP runs lifecycle hooks as in-process TS
  // extensions rather than a settings hook list, so there is no `settings`
  // path — the adapter in omp-hooks.ts writes the single user-root extension
  // (~/.omp/agent/extensions/teamai-hooks.ts). Profiles (OMP_PROFILE /
  // PI_CODING_AGENT_DIR / PI_CONFIG_DIR) move the agent dir and are not
  // supported for hooks.
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
  // MCP, model profiles and the extension follow PI_CODING_AGENT_DIR. Pi reads no rules
  // directory: its user team rules are a block in ~/.pi/agent/AGENTS.md, and
  // in a project teamai's extension adds them to the system prompt (#946).
  pi: {
    mcp: '.pi/agent/mcp.json',
    mcpProject: '.pi/mcp.json',
    skills: '.pi/skills',
    claudemd: 'AGENTS.md',
    userScope: {
      skills: '.pi/agent/skills',
      claudemd: '.pi/agent/AGENTS.md',
    },
  },
  codebuddy: { skills: '.codebuddy/skills', rules: '.codebuddy/rules', settings: '.codebuddy/settings.json', claudemd: '.codebuddy/CODEBUDDY.md', agents: '.codebuddy/agents', mcp: '.codebuddy/mcp.json', mcpProject: '.mcp.json' },
  // OpenClaw reads no rules directory: in user scope its team rules are a
  // block in the workspace AGENTS.md, and a project gets none (#946).
  openclaw: { skills: '.openclaw/skills', claudemd: '.openclaw/workspace/AGENTS.md' },
  hermes: { skills: '.hermes/skills', claudemd: 'AGENTS.md' },
  // DeepSeek Harness: skills synced to ~/.dsh/skills, which its skill-filesystem
  // provider scans as user-dsh root (rank 400). dsh discovers both directory
  // bundles (<name>/SKILL.md) and flat Markdown files there natively.
  dsh: { skills: '.dsh/skills' },
  // WorkBuddy runs CodeBuddy's engine: in a project it reads CodeBuddy's
  // .codebuddy/rules, which the two share (one copy), and in user scope its
  // own ~/.workbuddy/rules (#946). Its install probe stays .workbuddy
  // (`isToolInstalledForConfig`), whatever directory its rules land in.
  workbuddy: {
    skills: '.workbuddy/skills',
    rules: '.codebuddy/rules',
    settings: '.workbuddy/settings.json',
    claudemd: 'AGENTS.md',
    agents: '.workbuddy/agents',
    mcp: '.workbuddy/mcp.json',
    mcpProject: '.mcp.json',
    userScope: { rules: '.workbuddy/rules' },
  },
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
  // Muse Code (Meta, binary `muse`) keeps its user config in ~/.config/muse
  // and reads user skills from ~/.config/muse/skills, ahead of the
  // ~/.claude/skills and ~/.agents/skills it also scans. Hooks take Codex's
  // shape: user hooks in the `hooks` block of ~/.config/muse/settings.json,
  // which runs in every workspace, project hooks in <root>/.muse/hooks.json,
  // which runs only in a trusted one.
  muse: {
    skills: '.agents/skills',
    settings: '.muse/hooks.json',
    // User MCP servers sit in the same settings.json. A project's come from
    // the <root>/.mcp.json the claude target writes, as for tclaude.
    mcp: '.config/muse/settings.json',
    agents: '.agents/agents',
    userScope: { skills: '.config/muse/skills', settings: '.config/muse/settings.json', agents: '.config/muse/agents' },
  },
} satisfies Record<string, z.infer<typeof ToolPathsSchema>>;

/** A built-in tool. Custom tools in a team's `toolPaths` stay plain strings. */
export type ToolId = keyof typeof DEFAULT_TOOL_PATHS;

export const TeamaiConfigBaseSchema = z.object({
  team: z.string(),
  description: z.string().default(''),
  repo: z.string(),
  provider: ProviderNameSchema.default('tgit'),
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
  /**
   * Language of the agent-facing texts teamai injects: the built-in
   * teamai-recall rule, the todowrite-hint, and the mr-hint.
   * `en` is English only. `zh` or omitted keeps the historical bilingual
   * text, byte for byte (#1014).
   */
  language: z.enum(['en', 'zh']).optional(),
  /** Team-owned Node scripts. Distinct from `sharing.hooks.requireTeamScripts`
   * (the `~/.teamai/team-scripts/` trust boundary for hook commands). Every
   * entry is optional. An older CLI that only knows `postPull` strips the
   * other keys instead of rejecting the file, so a team can add one before
   * every member upgrades. Each `path` is relative to the team repo root and
   * must stay inside it, symlinks included. */
  scripts: z.object({
    /** During `teamai init`, after local config is saved and before hooks. */
    preInit: TeamScriptSchema.optional(),
    /** During `teamai init`, after hooks are installed. Init then syncs MCP. */
    postInit: TeamScriptSchema.optional(),
    /** At the start of a full pull, before that scope is synced. Not on an inline pull. */
    prePull: TeamScriptSchema.optional(),
    /** At the end of a full pull, after resources, hooks, MCP and reports. Not on an inline pull. */
    postPull: TeamScriptSchema.optional(),
    /**
     * After the inline delivery that prepares a new checkout (a linked
     * worktree, or a submodule's first checkout that already runs teamai's
     * git hook), before that git command returns. Init does not run there.
     */
    postDeploy: TeamScriptSchema.optional(),
  }).optional(),
  // MCP paths are only set for tools whose config location has been verified.
  // A team's `toolPaths` section merges over the built-in defaults tool by tool (#1185):
  // each tool named in the team config overrides that tool's default entry whole,
  // while built-in tools not named by the team retain their defaults.
  toolPaths: z.record(z.string(), ToolPathsSchema)
    .default({})
    .transform((custom): Record<string, z.infer<typeof ToolPathsSchema>> => ({
      ...DEFAULT_TOOL_PATHS,
      ...custom,
    })),
});

export const TeamaiConfigSchema = TeamaiConfigBaseSchema.superRefine((config, ctx) => {
  // The Trae builds claim their MCP files under one shared ownership record
  // (MCP_MANIFEST_KEY_ALIAS); that contract holds only while they map the
  // same file. A team that maps them apart would see one reconcile clear the
  // other's record, so reject the split instead (#904).
  const trae = config.toolPaths.trae;
  const traeCn = config.toolPaths['trae-cn'];
  for (const field of ['mcp', 'mcpProject'] as const) {
    const a = trae?.[field];
    const b = traeCn?.[field];
    if (a !== undefined && b !== undefined && a !== b) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toolPaths', 'trae-cn', field],
        message: `trae and trae-cn must map the same ${field} path: they claim their MCP servers under one shared ownership record`,
      });
    }
  }
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
    /** Ref this workspace follows, exactly as passed to pull --team-ref. */
    ref: z.string().optional(),
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
  /**
   * The provider this member uses for the team repo, set by `init --provider`
   * (#789). It overrides teamai.yaml `provider` on this machine only, e.g. `git`
   * so a member of a GitLab team needs no GITLAB_TOKEN. Absent = the team's.
   */
  provider: ProviderNameSchema.optional(),
  updatePolicy: z.enum(['auto', 'prompt', 'skip']).optional(),
  // Read-compat default for historical configs that omit `scope` (pre-project era).
  // NOT the write default for `teamai init` — init defaults to workspace (issue #250).
  scope: InstallScopeSchema.default('user'),
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
  /** Per-machine override of the team's `sharing.gitExclude.enabled` (#915),
   *  hand-edited in the partition config. Undefined defers to the team. */
  gitExcludeEnabled: z.boolean().optional(),
  /** User-level override for the share-learnings hint. When set, takes precedence over team config. */
  contributeHintEnabled: z.boolean().optional(),
  /** User-level override for the SessionStart MR hint. When set, takes precedence over team config. */
  mrHintEnabled: z.boolean().optional(),
  /** Per-machine override of the team's `usageReport`. When set, takes
   *  precedence over the team config. Undefined defers to the team. */
  usageReportEnabled: z.boolean().optional(),
  /** Per-machine override for the co-author trailer in AI-tool commits. When set,
   *  takes precedence over the team `sharing.coAuthor` default. Undefined means
   *  "defer to the team" (see resolveCoAuthor). */
  coAuthorEnabled: z.boolean().optional(),
  /** Per-machine override of the team's `sharing.autoCompact.tokens`. 0 opts
   *  out; undefined defers to the team (see resolveAutoCompactTokens). */
  autoCompactTokens: z.number().int().min(0).optional(),
  /** Per-machine opt-out of trusting in Codex what teamai writes for it: the
   *  hooks (`hooks.state`) and, for project hooks, the project (#955).
   *  Undefined means on. */
  codexTrustEnabled: z.boolean().optional(),
  /** When set, only inject hooks into these agents. Additive across multiple init --agent runs. */
  enabledAgents: z.array(z.string()).optional(),
  /**
   * Per-machine relocation of a tool's user-scope root. A tool that can be told
   * to keep its configuration elsewhere — Claude Code's `CLAUDE_CONFIG_DIR`,
   * Codex's `CODEX_HOME`, Cursor CLI's `CURSOR_DATA_DIR` / `CURSOR_CONFIG_DIR` —
   * reads nothing teamai writes to the team-wide default, and `teamai init`
   * records that variable here so every later run targets the right root.
   * The key is the tool id in `toolPaths` for a tool whose whole layout moves
   * with its root (`claude: ~/.claude-work`); a tool with more than one root
   * records each of them under a name of its own (see `RELOCATABLE_TOOLS`).
   * The value must resolve inside HOME; `~/` is expanded.
   */
  toolRoots: z.record(z.string(), z.string()).optional(),
  /** Tools explicitly excluded from all teamai sync (set by `uninstall --agent`). Removed again by `init --agent`. */
  disabledAgents: z.array(z.string()).optional(),
  /** Per-machine tool selection for locally executed workflow prompt steps. */
  workflows: z.object({
    tools: z.record(z.string(), z.string().min(1)).default({}),
    /** How many command steps the local driver runs at once. Unset means 1. */
    max_parallel: z.number().int().positive().optional(),
    /** Whether a driver without HITL automatically answers optional approve requests and uses choose defaults. Unset means false. */
    auto_approve: z.boolean().optional(),
    /** This host contains what it runs, such as a CI VM or a container, so the local driver declares `sandbox` isolation. */
    sandbox: z.boolean().optional(),
    /** What a workflow step may use on this machine, whatever driver runs it. An unset key allows. */
    allow: AllowSchema.optional(),
  }).optional(),
  /**
   * Per-machine map from a gateway/proxy model alias to a known Claude model
   * name, so cost/cache estimation works when the transcript records an opaque
   * alias (e.g. `gateway-model-42`) instead of `claude-opus-...`. The value must
   * contain a token the price table matches (opus / sonnet / haiku / fable /
   * mythos + version). Unset means "match the raw model name only".
   */
  modelAliases: z.record(z.string(), z.string()).optional(),
  scoring: z.object({
    /** The least isolation a judge of this scope needs, raising the team's and the scorer's. A value teamai does not know counts as `verified`. */
    isolation: z.string().optional().catch(({ input }) => JSON.stringify(input)),
    /** Judge this scope's finished agent sessions in the background. A value that is not true or false is kept as its text, which turns nothing on. */
    sessions: z.union([z.boolean(), z.string()]).optional().catch(({ input }) => JSON.stringify(input)),
    /** How many sessions a local day may lease for judging; 0 turns session scoring off. Another value is kept as its text, which sets nothing. */
    daily_limit: z.union([z.number().int().nonnegative(), z.string()]).optional().catch(({ input }) => JSON.stringify(input)),
  }).optional(),
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
 *
 * `children` is runtime-only too: the children a workspace read this run
 * (`readWorkspaceChildren`, #913). It is never written, so a workspace's
 * config keeps its own selection only.
 */
export type LocalConfig = z.infer<typeof LocalConfigSchema> & {
  dataHome?: string;
  roleUnresolved?: true;
  children?: WorkspaceChildren;
  roleAssignment?: RoleAssignment;
};

/**
 * Runtime-only, set when `manifest/members.yaml` governs this member's roles
 * (#1186): `primaryRole` and `additionalRoles` then hold the team's assignment,
 * read fresh on every load, and `local` keeps what the config file says so a
 * save by any other command writes that back instead of freezing a copy of the
 * assignment into the file.
 */
export interface RoleAssignment {
  /** `assigned` — the file lists this member; `default` — it does not. */
  source: 'assigned' | 'default';
  /** The selection on disk, which `roles set` no longer changes. */
  local: { primaryRole?: string; additionalRoles: string[] };
}
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
   * For a placement, the path the author still edits — the shared-root form
   * `relativePath` was derived from, e.g. "docs/guide.md" for a destination of
   * "docs/ops/guide.md". A self-mode scan compares that file against its placed
   * counterpart once the record lands (`state.placements`).
   */
  sourcePath: z.string().optional(),
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

/**
 * The model and effort one tool's copy of an agent received, and the
 * resolution step that produced them (`ResolutionStep` in models/aliases.ts).
 * `step` is a plain string so a record a newer CLI wrote still parses.
 * `source` is the aliases file that decided it (`ModelResolution.source`).
 * `alias` is the spec's `model` an alias step resolved, so a removed alias is
 * told apart even where it gave the tool no model; records written before it
 * existed lack it.
 */
const RecordedAgentModelSchema = z.object({
  step: z.string(),
  model: z.string().optional(),
  effort: z.string().optional(),
  source: z.string().optional(),
  alias: z.string().optional(),
});
export type RecordedAgentModel = z.infer<typeof RecordedAgentModelSchema>;
/** `RecordedAgentModel` by agent stem, then tool. */
export type AgentModelRecords = Record<string, Record<string, RecordedAgentModel>>;

/** One Codex binary teamai found, and the version its `--version` printed (null when it did not parse). */
const CodexBuildSchema = z.object({ path: z.string(), version: z.string().nullable() });
export type CodexBuild = z.infer<typeof CodexBuildSchema>;

/**
 * Builds that hash a teamai hook differently: teamai trusts with `chosen`, the
 * newest, and each of `others` hashes at least one of those hooks another way.
 */
const CodexBuildSkewSchema = z.object({ chosen: CodexBuildSchema, others: z.array(CodexBuildSchema) });
export type CodexBuildSkew = z.infer<typeof CodexBuildSkewSchema>;

/** A repo-backed placement that landed: the placed path and the blob push delivered there. */
const PlacementRecordSchema = z.object({ path: z.string(), blob: z.string() });
export type PlacementRecord = z.infer<typeof PlacementRecordSchema>;

/**
 * The member's choices that decide which team assets a pull delivers (#1178), as that pull read them from
 * `LocalConfig`. The lists are sorted, so the same choices compare equal however they were entered.
 */
export const DeliverySelectionSchema = z.object({
  scope: InstallScopeSchema,
  primaryRole: z.string().optional(),
  additionalRoles: z.array(z.string()),
  /** The roles came from manifest/members.yaml (#1186): holding none then filters, where a bare config does not. */
  rolesAssigned: z.boolean().optional(),
  projects: z.array(z.string()).optional(),
  subscribedTags: z.array(z.string()).optional(),
  excludedSkills: z.array(z.string()).optional(),
  inheritUserScope: z.boolean().optional(),
});
export type DeliverySelection = z.infer<typeof DeliverySelectionSchema>;

export const StateSchema = z.object({
  lastPush: z.string().nullable().default(null),
  lastPull: z.string().nullable().default(null),
  /**
   * When the last auto-report push went unconfirmed (#1453): the usage events
   * this scope recorded are still waiting to reach the reports branch. Set by
   * the first unconfirmed push, cleared by the next confirmed one. Absent means
   * nothing is pending.
   */
  pendingReportSince: z.string().optional(),
  /** Git commit hash (short) of the team repo at the time of last successful pull. */
  lastPullRev: z.string().nullable().default(null),
  /** Installed, enabled tool targets that completed the last full pull. */
  lastPullTargets: z.array(z.string()).optional(),
  /**
   * `lastPullRev` and `lastPullTargets` as each checkout of a project scope
   * last synced them, by checkout (see `checkoutKey` in pull.ts). state.json is
   * shared by every worktree of the project, but a pull writes skills, rules,
   * agents and docs into the checkout it runs in: a worktree added after the
   * last pull has not received that revision, and two checkouts with different
   * tool directories must not compare against each other's targets (#807).
   * `teamRef` is the ref this checkout's delivery followed, absent for the
   * default branch. It keeps revision removals pending after another checkout
   * unpins the workspace. An older CLI that saves state drops it.
   * `pushBaseRevs` are the team revisions push synced this checkout's
   * unedited rules and skills to since its last pull, newest first, the bases
   * its next push compares with; a pull's record drops them, since the pull
   * delivers `rev` (#812). A forced full sync elsewhere leaves `rev` empty
   * (`FORCED_FULL_SYNC_REV` in pull.ts). The user scope's entry is HOME's. An
   * inherited pull, and a pull whose docs mirror or submodule update fails, add
   * the revision they delivered to these bases and keep `rev` (#823).
   * `delivered` is the sha256 of the bytes teamai last wrote at each skill,
   * rule and agent file path of the checkout, which pull and the pre-push sync
   * update. Pull keeps a copy that no longer matches it; without it, pull
   * overwrites as before (#822). An older CLI that saves state drops it.
   * `agentModels` is what each YAML team agent's model resolved to in each
   * tool when teamai last wrote that copy, by agent stem (copies deploy
   * flattened, one file per stem) and tool (#830). An older CLI drops it too,
   * which the next pull reads as agents it has to redeploy.
   * `root` is the project checkout the record belongs to, the path its key
   * was computed from, written by that checkout's full pulls. A full pull in
   * another checkout drops the record once that root is no longer a checkout
   * of the repository under the same key; a record without one, from an older
   * CLI, is kept (#993).
   * `gitExcludePaths` is what each writer of the pull delivered into the
   * checkout, by writer id (`WriterId` in git-exclude-delivered.ts), as
   * absolute landed paths: what teamai's `delivered` git exclude block lists
   * (#915). It is kept whatever `sharing.gitExclude` says. A record without
   * it, saved by an older CLI, misses the fast path, so the next pull is a
   * full sync that writes it. A writer id this CLI does not know is kept.
   * `rootsSeeded` marks that pull's root-seeding step completed or did not
   * apply (#1041), so a root its member removes afterwards is not recreated.
   * An unavailable original checkout leaves it absent for a later retry. A
   * record without it, saved before seeding existed, reads as never seeded.
   */
  lastPullByWorkspace: z.record(z.string(), z.object({
    rev: z.string(),
    teamRef: z.string().optional(),
    root: z.string().optional(),
    targets: z.array(z.string()),
    pushBaseRevs: z.array(z.string()).optional(),
    delivered: z.record(z.string(), z.string()).optional(),
    agentModels: z.record(z.string(), z.record(z.string(), RecordedAgentModelSchema)).optional(),
    gitExcludePaths: z.record(z.string(), z.array(z.string())).optional(),
    /**
     * Per resource, each tool's places (`writesOf(locate(...))`) the last full
     * pull of this checkout delivered into, write gates met only, and for a
     * tool that missed an item there, the places it took the resource from
     * before (`settlePlaces`). A tool whose skills follow the session is left
     * out. A record without a resource, from an older CLI, misses the fast
     * path once.
     */
    places: z.object({
      skills: z.record(z.string(), z.array(z.string())).optional(),
      rules: z.record(z.string(), z.array(z.string())).optional(),
      blocks: z.record(z.string(), z.array(z.string())).optional(),
      agents: z.record(z.string(), z.array(z.string())).optional(),
    }).optional(),
    /** An earlier release's `places.skills`: read as that when `places` is missing (`placesRecordOf`), never written. */
    skillDirs: z.record(z.string(), z.array(z.string())).optional(),
    /** The home (`toolHome`) of each tool whose skills follow the session, at the last full pull that delivered it every skill. */
    sessionToolHomes: z.record(z.string(), z.string()).optional(),
    rootsSeeded: z.boolean().optional(),
    /** The children a workspace was last delivered with (`WorkspaceChildren.fingerprint`, #913). */
    children: z.string().optional(),
    /** The selection the last pull that delivered into this checkout read. Absent in a record an older CLI wrote. */
    selection: DeliverySelectionSchema.optional(),
    /**
     * The `claudeMdExcludes` entries teamai wrote into this checkout's
     * `.claude/settings.local.json` for the workspaces above it (#913).
     */
    claudeMdExcludes: z.array(z.string()).optional(),
  })).optional(),
  /**
   * The exclude files holding each git exclude owner's block that this
   * partition writes (`delivered`), by owner name (#915). Read by the next
   * sync, by flag off and by uninstall, to visit every file that may still
   * hold one.
   */
  gitExcludeFiles: z.record(z.string(), z.array(z.string())).optional(),
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
  /** The blob that proved each agent placement landed; never inferred from the current tip. */
  placedAgentSources: z.record(z.string(), PlacementRecordSchema).optional(),
  /**
   * Where push placed a repo-backed resource (docs, wiki, prompts, workflows,
   * scorers, models, env, hooks, claudemd, learnings) that the author still edits at
   * its shared-root path, keyed `<type>:<path the author edits>`, e.g.
   * `{ "docs:docs/guide.md": { "path": "docs/ops/guide.md", "blob": "<git blob id>" } }`.
   * `blob` is what that push delivered. A self-mode scan compares the author's
   * copy with it, not with the placed file: equal means already delivered,
   * whatever the team did to the placed file since, and different is the
   * author's edit. Recorded only after the placement landed, in
   * `reconcilePlacementRecords`, on the same blob-in-history proof as
   * `placedRules`, so a PR closed unmerged leaves no record behind. An entry
   * holding only the path, as earlier builds wrote, is dropped: without the
   * blob nothing tells an unchanged copy from an edit.
   */
  placements: z.record(z.string(), z.unknown())
    .transform((records) => Object.fromEntries(Object.entries(records).flatMap(([key, record]) => {
      const parsed = PlacementRecordSchema.safeParse(record);
      return parsed.success ? [[key, parsed.data] as const] : [];
    })))
    .optional(),
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
  /**
   * Fingerprint of what the last Codex trust pass that ended `trusted` saw:
   * the hooks teamai wrote for Codex, the Codex project MCP record, and the
   * bytes of those hook files and of Codex's `config.toml` (#955). A pull whose
   * inputs still match skips spawning `codex app-server`. Absent = run it.
   */
  codexTrustFingerprint: z.string().optional(),
  /** The Codex builds that disagreed in that pass (#1244), so a pull that skips it still warns. Absent = none. */
  codexBuildSkew: CodexBuildSkewSchema.optional(),
  /** The Codex builds that could not list the hooks in the last uncached pass; the same set failing again is cached. Absent = none. */
  codexBuildUncompared: z.array(CodexBuildSchema).optional(),
  /** Project grants this installation actually created; pre-existing user choices are never recorded. */
  codexProjectTrust: z.array(z.object({ home: z.string(), project: z.string() })).optional(),
  /**
   * OpenCode configs whose `instructions` entry for teamai's context file
   * teamai added, as `{ config, entry }`, so uninstall removes the entry even
   * after the member stripped the markers from that file (#945).
   */
  opencodeContextEntries: z.array(z.object({ config: z.string(), entry: z.string() })).optional(),
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

export type ResourceType =
  | 'skills'
  | 'rules'
  | 'docs'
  | 'env'
  | 'agents'
  | 'hooks'
  | 'mcp'
  | 'models'
  | 'claudemd'
  | 'learnings'
  | 'wiki'
  | 'workflows'
  | 'prompts'
  | 'scorers';

export type ResourceItemStatus = 'new' | 'modified';

export interface ResourceItem {
  name: string;
  type: ResourceType;
  sourcePath: string;
  relativePath: string;
  status?: ResourceItemStatus;
  namespace?: string;
  /** A kept skill with a recorded origin: `--role`/`--project` never relocate it (#1020). */
  fromInactiveNamespace?: true;
  /** When placed into a namespace, the original relative path superseded by this item. */
  supersedes?: string;
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
   * The other tools that read this same `dest`, served by the one copy: in a
   * project CodeBuddy and WorkBuddy both read `.codebuddy/rules` (#946).
   */
  sharedWith?: string[];
  /**
   * Where an older teamai delivered this copy for the same tool, before the
   * tool's file name changed: OMP's `<ns>/<name>.md`, now `<ns>.<name>.md`.
   * `dest` has no record yet, so the "Already synced" pull writes it while
   * the old copy is there, and reclaims that copy while it is unedited: on
   * record, or the team rule verbatim (a full sync's stale sweep does too).
   */
  movedFrom?: string;
  /**
   * The exact bytes `pullItem` writes at `dest`, for a handler that renders
   * its destination rather than copying a tree there. It is what tells a copy
   * rendered from an older spec from the current one; absent means the handler
   * cannot say, and only the destination's existence can be judged.
   */
  content?: string;
  /**
   * The team file `dest` is rendered from, for proving that a file already
   * at `dest` with no delivery record is teamai's (#993). Absent: the handler
   * offers no proof, and such a file is written over as before.
   */
  origin?: CopyOrigin;
}

/**
 * A resource's file in the repo it comes from, and how teamai renders one
 * version of it (`DeliveryTarget.origin`). A file is teamai's when its bytes
 * equal a version `pathspec` held in `repoPath`'s history, or one of
 * `renders` of such a version. For a skill, `pathspec` names the skill
 * directory, and `renders` apply to its SKILL.md (`isTeamaiSkillCopy`).
 */
export interface CopyOrigin {
  /** The team clone (`repo.localPath`), or a source repo. */
  repoPath: string;
  /** Repo-relative, `/`-separated. */
  pathspec: string;
  /** teamai's renders of one version; null when that version renders nothing here. */
  renders?: ReadonlyArray<(content: Buffer, version: { path: string; blob: string }) => string | Uint8Array | null>;
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
  /**
   * Codex only: the token count past which Codex keeps just the start and end
   * of the hook's additionalContext. 0 turns that off. Omitted = Codex's 2,500.
   */
  additionalContextLimit?: number;
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
  /** Muse only: content fingerprint ignoring object key order and an inferred stdio type. */
  valueHash?: string;
  /**
   * Project scope: whether the entry holds a `${VAR}` value teamai resolved
   * (#882). Absent in records an older teamai wrote.
   */
  resolved?: boolean;
  /** Completed Copilot project write: true for bare, false for keyed; absent means unproven. */
  bare?: boolean;
  /**
   * Project scope: this record was rebuilt after it was lost, or written by a
   * pull that found no managed-mcp.json, and the other servers in its file
   * could not be noted in managed-mcp-files.json yet (#882). Until a pull
   * notes them, the file counts as having no record.
   */
  unnoted?: true;
  /**
   * The file holding this server, which every MCP writer notes (#1221).
   * Absent in records an older teamai wrote (`recordedFileOf`).
   */
  file?: string;
  /**
   * The key the server sits under in `file` when it is not the tool's current
   * one: a retired place's, as ZCode's `mcpServers` (#1221). Absent: the current key.
   */
  key?: readonly [string, ...string[]];
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
 *
 * `MCP_MANIFEST_KEY_ALIAS` maps a tool onto another's key: builds that write
 * one shared project MCP file claim it under one record, so either build's
 * target can update and clean what the other's pull wrote, instead of a
 * per-tool claim the sibling's reconcile would skip as foreign.
 */
const MCP_MANIFEST_KEY_ALIAS: Readonly<Record<string, string>> = {
  // Trae and Trae CN map the same <root>/.trae/mcp.json (#904).
  'trae-cn': 'trae',
};

export function managedMcpManifestKey(tool: string, projectScope: boolean): string {
  const owner = MCP_MANIFEST_KEY_ALIAS[tool] ?? tool;
  return projectScope ? `${owner}:project` : owner;
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
  /** Pin this workspace to a team ref; the default branch unpins it. */
  teamRef?: string;
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
  /**
   * Internal (git hooks and checkout preparation, `pull` only): deliver what
   * the next session reads, without network when the team clone was fetched within
   * SOURCE_PULL_TTL_MS; sources come from their cached clones. Learnings,
   * reports, usage reporting and post-pull scripts are left to a full pull.
   * `scripts.postDeploy` still runs as `prepareCheckout` says.
   */
  inline?: boolean;
  /**
   * Internal (`pull` only): deliver as into a new checkout, which does not run
   * init, so `postInit` never runs for it, and wait for `scripts.postDeploy`.
   * - `always`: a workflow worktree whose agent files were just put back to a
   *   base commit. postDeploy runs on every such pull.
   * - `once`: a linked worktree, a submodule's first checkout when that repo
   *   already has teamai's git hooks (and the pull that hook hands over to,
   *   through TEAMAI_PREPARE_CHECKOUT), or a worktree an agent tool created
   *   without git hooks. Only the pull that writes the checkout's first record
   *   runs postDeploy; an inline one finding a record under the sync lock
   *   delivers nothing. A pass whose checkout is removed under it stops
   *   before its next write phase.
   */
  prepareCheckout?: 'always' | 'once';
  /**
   * Internal (checkout preparation from a tool use, with `inline`): deliver
   * from the team clone as last fetched, however long ago. A tool use then
   * never holds the sync lock through a fetch, nor retries one on every call
   * while the team repo is unreachable; the session's full pull fetches.
   */
  localOnly?: boolean;
  /**
   * Internal (post-merge/post-rewrite git hooks, with `inline`): fetch the team repo
   * whatever its fetch stamp says, and give up after this many ms; the scope
   * is then not delivered and the detached pull after the hook does it.
   */
  fetchTimeoutMs?: number;
  /**
   * Internal (`pull` only): the git hook event that started this pull, inline
   * or detached (`TEAMAI_GIT_HOOK` in the environment). Its failures are
   * recorded for `doctor` and the next interactive pull; its success clears them.
   */
  gitHook?: 'post-checkout' | 'post-merge' | 'post-rewrite';
  /**
   * Internal (`pull` only): detect the project from this directory instead of
   * the process cwd. A workflow worktree is delivered without changing cwd,
   * so parallel steps do not switch the process between checkouts.
   */
  cwd?: string;
  /**
   * Internal (`init --scope user`, `pull` only): pull the user scope even when
   * the current directory is a project-scoped checkout.
   */
  userScopeOnly?: boolean;
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

export const RESOURCE_TYPES: ResourceType[] = [
  'skills',
  'rules',
  'docs',
  'env',
  'agents',
  'hooks',
  'mcp',
  'models',
  'claudemd',
  'learnings',
  'wiki',
  'workflows',
  'prompts',
  'scorers',
];

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

/**
 * The team rules inlined into the user-scope instructions file of a tool with
 * no rules format (the Codex family, #938). Not `[teamai:rules]`: pull strips
 * that legacy marker from every `claudemd` file.
 */
export const TEAMAI_TEAM_RULES_START = '<!-- [teamai:team-rules:start] -->';
export const TEAMAI_TEAM_RULES_END = '<!-- [teamai:team-rules:end] -->';
export const TEAMAI_CULTURE_START = '<!-- [teamai:culture:start] -->';
export const TEAMAI_CULTURE_END = '<!-- [teamai:culture:end] -->';

export const TEAMAI_CLAUDEMD_START = '<!-- [teamai:claudemd:start] -->';
export const TEAMAI_CLAUDEMD_END = '<!-- [teamai:claudemd:end] -->';

// Phase 1: marker section for the recall-subagent rules block injected by `teamai pull`.
export const TEAMAI_RECALL_RULES_START = '<!-- [teamai:recall-rules:start] -->';
export const TEAMAI_RECALL_RULES_END = '<!-- [teamai:recall-rules:end] -->';

// ─── Usage tracking ────────────────────────────────────

/** The characters a skill name may hold: alphanumeric, hyphens, underscores, colons, dots. */
export const SKILL_NAME_CHARS = '[a-zA-Z0-9_\\-:.]';

/** Regex for valid skill names: {@link SKILL_NAME_CHARS}, at most 200 of them. */
export const SKILL_NAME_REGEX = new RegExp(`^${SKILL_NAME_CHARS}{1,200}$`);

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
  /**
   * Cumulative workflow run totals for this user (#1083): end-phase records
   * folded at publication time. Privacy: counts and durations only — the
   * record files under workflows/runs/ carry the per-run allowlist.
   */
  workflows?: { runs: number; succeeded: number; failed: number; totalDurationMs: number };
  /**
   * The part of `interventions`, `prompts`, `tokens` and `daily` recorded in each run mode. Those top-level counters
   * keep every count of the member's own sessions, so what neither holds was not recorded with a mode: counts from
   * before modes were recorded, and events without one. Sessions teamai launched count in none of them.
   */
  attended?: UserModeStats;
  unattended?: UserModeStats;
}

/** The counters of {@link UserStats} one run mode holds. */
export type UserModeStats = Pick<UserStats, 'interventions' | 'prompts' | 'tokens' | 'daily'>;

/** A count split by the run mode it was recorded in; `notRecorded` is the rest, recorded without one. */
export type RunModeSplit = Record<RunMode | 'notRecorded', number>;

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
  /**
   * Each rollout's own totals for a transcript-scoped session (Codex), keyed by
   * its transcript path: a rollout's counters restart, so the session sums them.
   * `since` is the rollout's first event.
   */
  /** Its tokens come from one counter that spans its rollouts (Codex's thread-level counter). */
  tokensSpanRollouts?: true;
  segments?: Record<string, {
    prompts: number; tokens: TokenUsage; interrupt: number; toolReject: number; correction: number;
    durationMs: number; requestDaily: Record<string, RequestCostMetrics>; since: string;
    /** An event of the rollout ended in an error. */
    error: boolean;
  }>;
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
  /**
   * `dataHomeKey()` of the data home of the scope that recorded the event, the
   * key its report filters on (#785). Absent on events written before this
   * field existed; the report then attributes them by `cwd`.
   */
  dataHomeKey?: string;
  /**
   * The data home itself, as a path, which unreleased builds of #795 wrote in
   * place of `dataHomeKey`. Read only: the report keys it with `dataHomeKey()`.
   */
  dataHome?: string;
  /**
   * Stable identity of the git repo holding `cwd` (`resolveAnchors().projectAnchor`),
   * shared by all of its worktrees, so a session is attributed to its repo even
   * after its worktree is removed (#809). An event whose `cwd` no longer exists
   * carries the session's last anchor (#810). Absent outside git, on events that
   * record no `cwd` (Copilot), and on events written before this field existed;
   * attribution then uses the session's last anchor, else `cwd`.
   */
  projectAnchor?: string;
  /**
   * The run mode the session's hook resolved. Absent on events written before it was recorded, which count in neither
   * mode. See `SessionRun` in launch-context.ts.
   */
  runMode?: RunMode;
  /**
   * Who launched the session when teamai did, such as `workflow` for a step. Such an event never counts as the member's:
   * not in sessions, interventions, prompts or tokens.
   */
  launchedBy?: string;
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
  /** The session's transcript (from the Stop, UserPromptSubmit and SessionEnd hook STDIN; never Copilot's) */
  transcriptPath?: string;
  /** Resolved PID of the AI tool main process (for liveness monitoring) */
  monitorPid?: number;
  /**
   * On `session_start` only: the commit checked out at `cwd` when the session
   * (or its resume or compaction) started, and whether tracked files were
   * modified or staged then (untracked files are not counted). Absent outside
   * git, in a repo with no commits, on events that record no `cwd` (Copilot),
   * when git failed or timed out, and on events written before this field
   * existed.
   */
  gitAtStart?: HeadState;
  /** Last event timestamp the PID monitor observed, so a delayed exit targets that run. */
  processExitAfter?: string;
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
  /** Repo the session belongs to (`repoKeys`), shared by all worktrees of a repo. */
  repoKey: string;
  /** Display name of `repoKey` (`repoLabel`), distinct across the sessions rebuilt with it. */
  repoLabel: string;
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
// A2 machine-level singleton keyed by sessionId, not per-project; each event
// carries the key of the data home of the scope that recorded it, which is what
// a scope's report filters on.
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
   * (used only for tools whose Stop hook cannot take the payload — see
   * stopStdoutUnsupported). Cleared once injected. Absent for tools
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
export const SEARCH_INDEX_VERSION = 7;

/** Per-file derivation only; votes and selection are recomputed on every build. */
export interface SearchIndexFileCache {
  derivation: string;
  files: Array<{
    key: string;
    fingerprint: string;
    hash: string;
    /** Selected entries refer to `SearchIndex.entries` instead of duplicating tokens. */
    entry: number | SearchIndexEntry | null;
  }>;
}

/** Shape of the search-index.json file. */
export interface SearchIndex {
  fileCache?: SearchIndexFileCache;
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
  /** Per-domain document-frequency maps, so unrelated knowledge domains do not
   *  change the IDF score of an entry. Missing on indexes that need rebuilding. */
  dfByDomain?: Partial<Record<KnowledgeDomain, Record<string, number>>>;
  /** The workspace children this index was built for (#913), absent outside a workspace with children. */
  children?: string;
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
/**
 * User-scope votes dir, `~/.teamai/user-votes`. Evaluated at call time. Not
 * `~/.teamai/votes`: every scope used to record there, and an earlier release
 * still does after a rollback, so what it holds names no project. It is never
 * read, so no scope can push it to its team (#787).
 */
export function getUserVotesDir(): string {
  return path.join(getTeamaiHomeDir(), 'user-votes');
}
/**
 * The local votes dir of one scope: `<dataHome>/votes`, so each scope pushes
 * only the votes cast where it is set up (#787); the user scope's is
 * getUserVotesDir(). A historical project-scoped `~/.teamai/config.yaml` with
 * no projectRoot lives in ~/.teamai, as recall and viz treat it, so its votes
 * are the user scope's.
 */
export function getVotesDir(config: LocalConfig): string {
  if (!config.dataHome && config.scope === 'project' && !config.projectRoot) return getUserVotesDir();
  const dataHome = getDataHome(config);
  if (path.resolve(dataHome) !== path.resolve(getTeamaiHomeDir())) return path.join(dataHome, 'votes');
  return getUserVotesDir();
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
 * phase (P1) keys machine-local data by the shared `projectAnchor` (the repository identity) under `~/.teamai/projects/<slug>/`, while resources continue to land
 * at the workspace root returned here. This function only ever governs resource
 * landing, never machine-data location.
 */
export function resolveBaseDir(localConfig: Pick<LocalConfig, 'scope' | 'projectRoot'>): string {
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

/** GitHub Copilot CLI's user configuration root: the recorded one (`toolHome`), else COPILOT_HOME, else `~/.copilot`. */
export function getCopilotHome(env: NodeJS.ProcessEnv = process.env): string {
  return toolHome(COPILOT_TOOL_ID, realHost({ env }));
}

export const CLAUDE_TOOL_ID = 'claude';

/** The `toolPaths.claude` root segment Claude Code uses when it is not relocated. */
export const DEFAULT_CLAUDE_ROOT = '.claude';

export const CODEX_TOOL_ID = 'codex';

/** WorkBuddy's toolPaths id and pre-5.7 root segment (#946). */
export const WORKBUDDY_TOOL_ID = 'workbuddy';
export const WORKBUDDY_TOOL_ROOT = '.workbuddy';

/** WorkBuddy 5.7+'s runtime root (#1273). */
export const WORKBUDDY_NEW_GENERATION_ROOT = '.workbuddy-ai';

/** Muse Code (Meta), whose CLI binary is `muse`. */
export const MUSE_TOOL_ID = 'muse';

/** The `toolPaths.codex` root segment Codex uses when `CODEX_HOME` is unset. */
export const DEFAULT_CODEX_ROOT = '.codex';

/**
 * Cursor CLI is the one tool with two relocatable roots, and neither is the
 * root its `toolPaths` entry hangs off, so they are recorded under these two
 * keys instead of under `cursor` — see `RELOCATABLE_TOOLS`. The names say which
 * directory each one moves; `CURSOR_DATA_TOOL_ID` is the data root
 * (`CURSOR_DATA_DIR`), `CURSOR_CONFIG_TOOL_ID` the config root
 * (`CURSOR_CONFIG_DIR`).
 */
export const CURSOR_DATA_TOOL_ID = 'cursor-data';
export const CURSOR_CONFIG_TOOL_ID = 'cursor-config';

/** The root segment both Cursor CLI roots fall back to when their variable is unset. */
export const DEFAULT_CURSOR_ROOT = '.cursor';

/** A tool whose user root can be moved, and the variable that moves it. */
export interface RelocatableTool {
  /** Display name in init output and doctor checks. */
  label: string;
  /** The environment variable the tool reads its root from. */
  envVar: string;
  /** The root segment in HOME when the variable is unset. */
  defaultRoot: string;
}

/**
 * The home and path flavor a tool root resolves against: this process's by
 * default, or a member's machine described by `locate`'s host, so a Linux test
 * can resolve a Windows member's recorded roots.
 */
export type HomePaths = { readonly home: string; readonly path: path.PlatformPath };

function processHomePaths(): HomePaths {
  return { home: getUserHome(), path };
}

function expandHomeAt(p: string, at: HomePaths): string {
  if (p.startsWith('~/') || p === '~' || (at.path === path.win32 && p.startsWith('~\\'))) {
    return at.path.join(at.home, p.slice(1));
  }
  return p;
}

/** True when `dir` resolves to something inside the user's home directory. */
function isUnderUserHome(dir: string, at: HomePaths): boolean {
  const rel = at.path.relative(at.home, at.path.resolve(dir));
  return rel !== '' && !rel.startsWith('..') && !at.path.isAbsolute(rel);
}

/**
 * Root shapes a member may record: a single directory in HOME
 * (`.claude-work`), or a directory under `.config/` at any depth
 * (`~/.config/cloak/profiles/work/claude`).
 *
 * `configs/claude` is still refused: not being under `.config`, the recorded
 * value alone does not say how deep the tool's own root sits, so nothing
 * distinguishes it from an unrelated directory of the same name — an
 * unrelated `~/configs` would report the tool as installed and teamai would
 * write into a directory that does not exist. `.config` gives the gate a
 * bounded namespace to look in; `toolGateRoot` finds the exact root within it.
 */
function isAddressableRootSegment(segment: string): boolean {
  const segments = segment.split('/');
  // `.config` alone is not one of them: `toolInstallRoot('.config/settings.json')`
  // reads it as the two-segment OpenCode-style root, so the gate would look for
  // the settings FILE as the tool's directory and never find it.
  if (segments.length === 1) return segments[0] !== '.config';
  return segments[0] === '.config';
}

/**
 * Roots a member may relocate, keyed by the name the recorded root is filed
 * under. An allowlist, not a list of known offenders: a root is only honest for
 * a tool whose every user-scope write follows it, and most tools keep at least
 * one path teamai resolves elsewhere (OMP's extension dir, Copilot's
 * `$COPILOT_HOME`, OpenCode's plugin dir), which a partial move would split in
 * half.
 *
 * Claude Code qualifies — hooks, skills, rules, agents, CLAUDE.md, MCP, model
 * sync and co-author all resolve through `toolPaths`, and the one remaining
 * fixed `.claude` path is `legacyHooksNeedReinject`, a read-only probe for a
 * pre-dispatch migration. Codex qualifies — hooks, skills, rules, agents and
 * MCP resolve through `toolPaths`, co-author through `resolveToolRootDir`, and
 * model switching reads `CODEX_HOME` when the shell sets it, else the recorded root. `toolRoots` stays a generic
 * record, so a tool joins this table as soon as its writes have been audited.
 *
 * Cursor CLI is in this table as its two roots rather than as `cursor`. It
 * moves two directories — the transcripts under `CURSOR_DATA_DIR`, the config
 * `cli-config.json` lives in under `CURSOR_CONFIG_DIR` — while the rest of
 * `~/.cursor` (the user `mcp.json`, `rules/`, `commands/`) stays there whatever
 * the variables say. `toolPaths.cursor` therefore has to stay put, and a key
 * named `cursor` would move it: `applyToolRoots` re-roots the `toolPaths` entry
 * of every key it finds. So the two names below stand for roots, not tools, and
 * only the two writers that address those roots read them (`sessionStoreDir`
 * in `locate.ts` and `cursorConfigDir` below).
 *
 * Those two keys carry no `toolPaths` entry, which is also why `doctor`'s
 * `buildToolRootChecks` skips them: the check compares where teamai would write
 * a tool's paths against where the tool reads them, and there are no such paths
 * here for `applyToolRoots` to move. A stale record of either root is not caught
 * by that check.
 */
export const RELOCATABLE_TOOLS: Readonly<Record<string, RelocatableTool>> = {
  [CLAUDE_TOOL_ID]: { label: 'Claude Code', envVar: 'CLAUDE_CONFIG_DIR', defaultRoot: DEFAULT_CLAUDE_ROOT },
  [CODEX_TOOL_ID]: { label: 'Codex', envVar: 'CODEX_HOME', defaultRoot: DEFAULT_CODEX_ROOT },
  [CURSOR_DATA_TOOL_ID]: { label: 'Cursor transcripts', envVar: 'CURSOR_DATA_DIR', defaultRoot: DEFAULT_CURSOR_ROOT },
  [CURSOR_CONFIG_TOOL_ID]: { label: 'Cursor config', envVar: 'CURSOR_CONFIG_DIR', defaultRoot: DEFAULT_CURSOR_ROOT },
};

/**
 * Why `dir` cannot serve as a tool root, as a sentence fragment for a warning —
 * or null when it can. One place decides, so `teamai init` refuses to record
 * exactly the roots `applyToolRoots` would refuse to apply.
 */
export function toolRootRejection(dir: string, at: HomePaths = processHomePaths()): string | null {
  const resolved = at.path.resolve(expandHomeAt(dir, at));
  if (!isUnderUserHome(resolved, at)) {
    return `it is outside the home directory ${at.home}, and every tool path is resolved relative to it`;
  }
  const segment = at.path.relative(at.home, resolved).split(at.path.sep).join('/');
  if (!isAddressableRootSegment(segment)) {
    return 'a tool root has to be a directory in the home directory other than '
      + '~/.config itself (~/.claude-work), or a directory under a ~/.config/<name> one, '
      + 'so the "is this tool installed?" check can tell it apart from an unrelated directory';
  }
  return null;
}

/**
 * The root a relocatable tool's variable asks for (the `envVar` in
 * `RELOCATABLE_TOOLS`), or null when the variable is unset or blank, or the
 * tool is not relocatable.
 *
 * A value equal to the default root is still an answer, not an absence:
 * Claude Code reads `.claude.json` from INSIDE the configured directory
 * whenever the variable is set, so `~/.claude/.claude.json` rather than
 * `~/.claude.json` — a different file from the one an unset variable means.
 *
 * Read in exactly two commands: `teamai init` records the answer into
 * `toolRoots.<tool>`, and `teamai doctor` reports a recorded value that no
 * longer matches. Everything else reads the recorded value, so a teamai run
 * from a shell that happens not to export the variable (a hook, a cron, a
 * different terminal) still writes where that tool reads.
 */
export function detectToolRoot(tool: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const spec = RELOCATABLE_TOOLS[tool];
  const configured = spec ? env[spec.envVar]?.trim() : undefined;
  if (!configured) return null;
  return path.resolve(expandHome(configured));
}

/**
 * Cursor CLI's config directory, the one that holds `cli-config.json`.
 *
 * Resolution order read off the cursor-agent 2026.09.28 bundle:
 * `CURSOR_CONFIG_DIR`, else `$XDG_CONFIG_HOME/cursor`, else `~/.cursor`. Only
 * the variable can be recorded in `toolRoots` — `XDG_CONFIG_HOME` names a parent
 * directory, and `~/.config` itself is refused as a root — so the fallback is
 * read here, where the write happens, exactly as `session-flow/ide-history.ts`
 * reads it for the Cursor IDE.
 */
export function cursorConfigDir(toolRoots?: Record<string, string>): string {
  if (toolRoots?.[CURSOR_CONFIG_TOOL_ID]) {
    return resolveToolRootDir(CURSOR_CONFIG_TOOL_ID, DEFAULT_CURSOR_ROOT, toolRoots);
  }
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  if (xdg) return path.join(expandHome(xdg), 'cursor');
  return path.join(getUserHome(), DEFAULT_CURSOR_ROOT);
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
 * The root a set of tool paths hangs off, derived from the path's shape: the
 * first segment (`.claude/skills` → `.claude`, `.openclaw/workspace/AGENTS.md`
 * → `.openclaw`), except under `.config/`, where `.config` alone is a directory
 * nearly every user has, and the root is therefore the first two segments
 * (`.config/opencode`).
 *
 * This is the shape a relocation keys on and rewrites (`relocateToolPaths`
 * matches against it, `applyToolRoots` re-roots at it), so it must stay
 * independent of any recorded root. The installed-tool gate needs the tool's
 * real directory instead — that is `toolGateRoot`.
 */
export function toolInstallRoot(toolPath: string): string {
  const segments = toolPath.split('/');
  if (segments[0] === '.config' && segments.length > 1) {
    return `${segments[0]}/${segments[1]}`;
  }
  return segments[0] ?? toolPath;
}

/**
 * The directory the installed-tool gate reads for `tool`: the recorded root
 * when one is in play, and the path-derived one otherwise.
 *
 * `toolInstallRoot` answers from the path's shape, which is what relocation
 * needs. The gate needs the directory the tool actually keeps its config in,
 * and those stop agreeing once a member records a root nested below
 * `~/.config/<name>` (`~/.config/cloak/profiles/work/claude`): the two-segment
 * prefix (`.config/cloak`) is a directory that may exist for an unrelated
 * reason while the recorded root itself does not. Probing the prefix would
 * call the tool installed and the write below it would recreate a root the
 * user had deleted — the very thing the gate exists to prevent.
 *
 * The record is consulted only when `toolPath` really does hang off it: the
 * same `toolPaths` are used unrelocated in project scope, where a HOME-relative
 * member root says nothing, and a root that cannot be used is ignored there
 * too (see `toolRootSegment`).
 */
export function toolGateRoot(
  tool: string,
  toolPath: string,
  toolRoots?: Readonly<Record<string, string>>,
  at?: HomePaths,
): string {
  const recorded = toolRoots?.[tool];
  if (recorded) {
    const segment = toolRootSegment(tool, recorded, at);
    if (segment && (toolPath === segment || toolPath.startsWith(`${segment}/`))) return segment;
  }
  return toolInstallRoot(toolPath);
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
function toolRootSegment(tool: string, configured: string, at: HomePaths = processHomePaths()): string | null {
  if (!(tool in RELOCATABLE_TOOLS)) {
    if (!warnedToolRoots.has(tool)) {
      warnedToolRoots.add(tool);
      log.warn(
        `Ignoring toolRoots.${tool}: toolRoots currently supports ${Object.keys(RELOCATABLE_TOOLS).join(', ')} only — `
        + `${tool} has writes teamai does not resolve through toolPaths.`
        + (tool === COPILOT_TOOL_ID ? ' Copilot CLI is relocated with COPILOT_HOME instead.' : ''),
      );
    }
    return null;
  }
  const resolved = at.path.resolve(expandHomeAt(configured, at));
  const rejection = toolRootRejection(resolved, at);
  if (rejection) {
    const key = `${tool}:${resolved}`;
    if (!warnedToolRoots.has(key)) {
      warnedToolRoots.add(key);
      log.warn(`Ignoring toolRoots.${tool} (${resolved}): ${rejection}.`);
    }
    return null;
  }
  return at.path.relative(at.home, resolved).split(at.path.sep).join('/');
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
      if (value === null) userScope.rules = null;
      else if (value !== undefined) userScope[field] = moved(value);
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
  toolRoots?: Readonly<Record<string, string>>,
  at?: HomePaths,
): Record<string, z.infer<typeof ToolPathsSchema>> {
  if (!toolRoots || Object.keys(toolRoots).length === 0) return toolPaths;
  let out: Record<string, z.infer<typeof ToolPathsSchema>> | undefined;
  for (const [tool, configured] of Object.entries(toolRoots)) {
    const paths = toolPaths[tool];
    if (!paths) continue;
    const newRoot = toolRootSegment(tool, configured, at);
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
 * WorkBuddy 5.7+ moved its runtime to `.workbuddy-ai/` and stops reading
 * `.workbuddy/` (#1273), so skills go to the directory the app actually scans
 * — live-verified in the issue (13 team skills showed in the live `/` menu).
 * The new root wins whenever it exists, because an upgrade leaves the old one
 * behind as an unread leftover. Only the default skills path swaps, so a team
 * that redirected on purpose keeps its own. Every other surface keeps its
 * `.workbuddy/` path: written there while that root exists, held by `locate`
 * once it is gone. Returns the same object when no swap fires.
 */
function applyWorkBuddyGeneration(
  toolPaths: Record<string, z.infer<typeof ToolPathsSchema>>,
  localConfig: { scope?: Scope; projectRoot?: string },
): Record<string, z.infer<typeof ToolPathsSchema>> {
  const workbuddy = toolPaths[WORKBUDDY_TOOL_ID];
  if (!workbuddy || workbuddy.skills !== '.workbuddy/skills') return toolPaths;
  const baseDir = localConfig.scope === 'project' && localConfig.projectRoot !== undefined
    ? localConfig.projectRoot
    : getUserHome();
  // The new root present means 5.7+ is the live generation (an upgrade leaves
  // `.workbuddy/` behind as a leftover the app no longer reads), so it wins
  // even when both roots exist (#1290).
  if (fs.existsSync(path.join(baseDir, WORKBUDDY_NEW_GENERATION_ROOT))) {
    return { ...toolPaths, [WORKBUDDY_TOOL_ID]: { ...workbuddy, skills: `${WORKBUDDY_NEW_GENERATION_ROOT}/skills` } };
  }
  return toolPaths;
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
  teamConfig: Pick<TeamaiConfig, 'toolPaths'>,
  localConfig: { scope?: Scope; toolRoots?: Readonly<Record<string, string>> },
  at?: HomePaths,
): Record<string, z.infer<typeof ToolPathsSchema>> {
  const generationAdjusted = applyWorkBuddyGeneration(teamConfig.toolPaths, localConfig);
  if (localConfig.scope !== 'user') return generationAdjusted;
  const rooted = applyToolRoots(generationAdjusted, localConfig.toolRoots, at);
  const out: Record<string, z.infer<typeof ToolPathsSchema>> = {};
  for (const [tool, paths] of Object.entries(rooted)) {
    const us = paths.userScope;
    if (!us) {
      out[tool] = paths;
      continue;
    }
    const scoped = {
      ...paths,
      ...(us.skills !== undefined ? { skills: us.skills } : {}),
      ...(typeof us.rules === 'string' ? { rules: us.rules } : {}),
      ...(us.settings !== undefined ? { settings: us.settings } : {}),
      ...(us.agents !== undefined ? { agents: us.agents } : {}),
      ...(us.hooks !== undefined ? { hooks: us.hooks } : {}),
      ...(us.claudemd !== undefined ? { claudemd: us.claudemd } : {}),
    };
    // `rules: null`: no rules directory in user scope.
    if (us.rules === null) delete scoped.rules;
    out[tool] = scoped;
  }
  // Copilot loads user hooks only from files directly in `$COPILOT_HOME/hooks/`.
  const copilot = out[COPILOT_TOOL_ID];
  if (copilot?.hooks) out[COPILOT_TOOL_ID] = { ...copilot, hooks: `hooks/${path.basename(copilot.hooks)}` };
  // Re-apply the WorkBuddy generation swap after the user-scope merge: a
  // `userScope.skills` carrying the default `.workbuddy/skills` restores the
  // unread old path over the adjusted one (#1290).
  return applyWorkBuddyGeneration(out, localConfig);
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
/** Lock filename (beside the reports-wt checkout) guarding concurrent reports-branch writes. */
export const REPORTS_LOCK_FILENAME = '.reports-lock';
/** Lock filename (beside the learnings-wt checkout) guarding concurrent learnings-branch writes. */
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
 * The project-scope search index. Every checkout of a repo shares one data
 * home, but in self mode each checkout indexes its own branch's docs, rules
 * and skills, so the index is kept per checkout, the way managed MCP is
 * (#808). Elsewhere the knowledge is one clone, and so is the index.
 */
export function getProjectSearchIndexPath(localConfig: LocalConfig): string {
  const dataHome = getDataHome(localConfig);
  if (isSelfMode(localConfig)) {
    return path.join(dataHome, 'workspaces', managedMcpWorkspaceId(getBusinessRoot(localConfig)), 'search-index.json');
  }
  return path.join(dataHome, 'search-index.json');
}

/**
 * Directory holding reports data (members/sessions/votes/stats).
 * - http: same as knowledge (localPath) — HTTP does not use the git reports branch.
 * - self: <dataHome>/reports-wt — in the partition, shared by every checkout.
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
 * - self: <dataHome>/<dirname> — in the partition, not in the checkout's
 *   `.teamai/`: git checks a branch out in one worktree only, so every
 *   checkout of the business repo shares this one (#808).
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
    return path.join(getDataHome(localConfig), dirname);
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
 * Path of the machine-local record of what this CLI's pull wrote to env.sh,
 * which mcp-reconcile reads for ${VAR} resolution. env.sh cannot replace this
 * backup: an older version may have left a secret there that the failed pull
 * must not apply.
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
  // while leaving the env backup (which carries plaintext values) behind
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
 * The managed-hooks manifest: the team (B) hooks teamai injected into each
 * tool, so reconcile can clean up hooks removed from hooks.yaml (esp. for
 * Cursor and Copilot, whose entries carry no marker).
 *
 * User scope keeps one file in `~/.teamai`. A project scope's hook files are
 * per checkout (Copilot's `.github/hooks/`, self mode's tool dirs), so its
 * manifest is too, in the data home beside `managed-mcp.json`
 * (`workspaces/<id>/`), never in the working tree (#993).
 */
export function getManagedHooksPath(localConfig: LocalConfig): string {
  if (localConfig.scope !== 'project') return getUserManagedHooksPath();
  if (!localConfig.projectRoot) {
    throw new Error('getManagedHooksPath: scope is "project" but projectRoot is missing.');
  }
  return path.join(
    getDataHome(localConfig), 'workspaces', managedMcpWorkspaceId(localConfig.projectRoot), 'managed-hooks.json',
  );
}

/** `~/.teamai/managed-hooks.json`: user scope, and a non-self project scope's HOME hooks (#370). */
export function getUserManagedHooksPath(): string {
  return path.join(getTeamaiHome('user'), 'managed-hooks.json');
}

/**
 * Where releases before #993 kept a project's managed-hooks manifest, in the
 * working tree. Read by the pre-#370 Codex import, the legacy hook scope and
 * uninstall; the first pull moves the Copilot records (every record in self
 * mode) out of it (`migrateLegacyManagedHooks`).
 */
export function legacyManagedHooksPath(projectRoot: string): string {
  return path.join(projectRoot, '.teamai', 'managed-hooks.json');
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
    return { baseDir: getUserHome(), manifestPath: getUserManagedHooksPath(), scope: 'user' };
  }
  return {
    baseDir: resolveBaseDir(localConfig),
    manifestPath: getManagedHooksPath(localConfig),
    scope: localConfig.scope,
  };
}

/** Hook paths follow their delivery scope; a tool that takes its user hooks in self mode too (`HooksChannels.self`, ZCode's CLI) keeps its user ones. */
export function hookToolPathsForConfig(teamConfig: TeamaiConfig, localConfig: LocalConfig): TeamaiConfig['toolPaths'] {
  const paths = scopedToolPaths(teamConfig, { ...localConfig, scope: resolveHookScope(localConfig).scope });
  const user = scopedToolPaths(teamConfig, { ...localConfig, scope: 'user' });
  return Object.fromEntries(Object.entries(paths).map(([tool, scoped]) => [tool, channelsOf(tool).hooks.self === 'user' ? user[tool] ?? scoped : scoped]));
}

/**
 * Absolute user-scope root directory of a tool (`.claude` → `~/.claude`),
 * honoring a member's `toolRoots`. For the few writers that address a tool's
 * root directly instead of through a `toolPaths` entry.
 */
export function resolveToolRootDir(
  tool: string,
  defaultRoot: string,
  toolRoots?: Readonly<Record<string, string>>,
  at: HomePaths = processHomePaths(),
): string {
  return recordedToolRootDir(tool, toolRoots, at) ?? at.path.join(at.home, ...defaultRoot.split('/'));
}

/** The member's recorded root of `tool` under `at.home`, or null when none is recorded or it is ignored (and warned). */
export function recordedToolRootDir(
  tool: string,
  toolRoots: Readonly<Record<string, string>> | undefined,
  at: HomePaths = processHomePaths(),
): string | null {
  const configured = toolRoots?.[tool];
  const segment = configured ? toolRootSegment(tool, configured, at) : null;
  return segment === null ? null : at.path.join(at.home, ...segment.split('/'));
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
    manifestPath: legacyManagedHooksPath(localConfig.projectRoot),
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
  /**
   * The MR's review threads, in the order the platform returns them, without
   * system notes or teamai's own CI comments. Absent when the fetch left them
   * out (`--no-discussions`) or the platform has none (#1187).
   */
  discussions?: MRThread[];
}

/** One note of an MR review thread. */
export interface MRThreadNote {
  /** Username; the extraction prompt marks it as the MR author or a reviewer. */
  author?: string;
  body: string;
}

/** An MR review thread, with the diff position it is anchored to when it has one. */
export interface MRThread {
  /** Path of the file the thread is anchored to, for a diff comment. */
  file?: string;
  line?: number;
  /** Whether the platform marks the thread resolved; undefined when it does not say. */
  resolved?: boolean;
  /** The notes in order; the first opens the thread. */
  notes: MRThreadNote[];
}

/** What `fetchMergeRequest` reads besides the MR, its commits and its diff. */
export interface MRFetchOptions {
  /** Read the review threads too (default true). */
  discussions?: boolean;
  /**
   * The marker `teamai ci extract-mr --comment-marker` posts its comments
   * with; those are left out of the threads, as comments with the default
   * `<!-- teamai:` prefix always are.
   */
  commentMarker?: string;
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
