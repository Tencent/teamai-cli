import { z } from 'zod';
import path from 'node:path';

// ─── Tool path config ───────────────────────────────────

export const ToolPathsSchema = z.object({
  skills: z.string().optional(),
  rules: z.string().optional(),
  settings: z.string().optional(),
  claudemd: z.string().optional(),
  wiki: z.string().optional(),
  /** Per-tool agents directory (Phase 1: teamai-recall subagent target).
   * Optional — tools without subagent support omit this and agents sync skips them. */
  agents: z.string().optional(),
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
});

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

export const TEAMAI_SOURCES_DIR = `${process.env.HOME}/.teamai/sources`;

export const TeamaiConfigSchema = z.object({
  team: z.string(),
  description: z.string().default(''),
  repo: z.string(),
  /** Git hosting provider: 'tgit' | 'github'. Defaults to 'tgit' for backward compatibility. */
  provider: z.enum(['tgit', 'github']).default('tgit'),
  /** Repo scope set at creation time; undefined = legacy repo (no restriction). */
  scope: ScopeEnum.optional(),
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
  toolPaths: z.record(z.string(), ToolPathsSchema).default({
    claude: { skills: '.claude/skills', rules: '.claude/rules', settings: '.claude/settings.json', claudemd: '.claude/CLAUDE.md', wiki: '.claude/wiki', agents: '.claude/agents' },
    codex: { skills: '.codex/skills', rules: '.codex/rules', agents: '.codex/agents' },
    'codex-internal': { skills: '.codex-internal/skills', rules: '.codex-internal/rules', agents: '.codex-internal/agents' },
    'claude-internal': { skills: '.claude-internal/skills', rules: '.claude-internal/rules', settings: '.claude-internal/settings.json', claudemd: '.claude-internal/CLAUDE.md', wiki: '.claude-internal/wiki', agents: '.claude-internal/agents' },
    cursor: { skills: '.cursor/skills', rules: '.cursor/rules', settings: '.cursor/hooks.json', agents: '.cursor/agents' },
    codebuddy: { skills: '.codebuddy/skills', rules: '.codebuddy/rules', settings: '.codebuddy/settings.json', claudemd: '.codebuddy/CODEBUDDY.md', agents: '.codebuddy/agents' },
    openclaw: { skills: '.openclaw/skills', rules: '.openclaw/rules' },
    workbuddy: { skills: '.workbuddy/skills', rules: '.workbuddy/rules' },
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
  }),
  username: z.string(),
  updatePolicy: z.enum(['auto', 'prompt', 'skip']).optional(),
  scope: ScopeEnum.default('user'),
  primaryRole: z.string().min(1).optional(),
  additionalRoles: z.array(z.string()).default([]),
  resourceProfileVersion: z.number().int().positive().optional(),
  /** Absolute path to project root; required when scope is 'project'. */
  projectRoot: z.string().optional(),
  /** Tags the user has subscribed to. If empty/undefined, pull all resources. */
  subscribedTags: z.array(z.string()).optional(),
});

export type LocalConfig = z.infer<typeof LocalConfigSchema>;
export type LocalConfigInput = z.input<typeof LocalConfigSchema>;

// ─── Local state (~/.teamai/state.json) ────────────────────

export const StateSchema = z.object({
  lastPush: z.string().nullable().default(null),
  lastPull: z.string().nullable().default(null),
  /** Git commit hash (short) of the team repo at the time of last successful pull. */
  lastPullRev: z.string().nullable().default(null),
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

export type ResourceType = 'skills' | 'rules' | 'docs' | 'env' | 'wiki' | 'agents';

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

export const TEAMAI_HOME = `${process.env.HOME}/.teamai`;
export const TEAMAI_CONFIG_PATH = `${TEAMAI_HOME}/config.yaml`;
export const TEAMAI_STATE_PATH = `${TEAMAI_HOME}/state.json`;
export const TEAMAI_TOKEN_PATH = `${TEAMAI_HOME}/token`;
export const TEAMAI_UPDATE_LOCK_PATH = `${TEAMAI_HOME}/.update-lock`;

export const RESOURCE_TYPES: ResourceType[] = ['skills', 'rules', 'docs', 'env', 'wiki', 'agents'];

export const TEAMAI_RULES_START = '<!-- [teamai:rules:start] -->';
export const TEAMAI_RULES_END = '<!-- [teamai:rules:end] -->';

export const TEAMAI_HOOK_DESCRIPTION_PREFIX = '[teamai]';

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
}

// ─── Session records ───────────────────────────────────

export interface SessionRecord {
  date: string;
  summary: string;
  toolsUsed: string[];
  hasValue: boolean;
  errors?: string[];
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

// ─── Contribute (session auto-contribute) ────────────
//
//  Two-layer threshold detection:
//
//  Layer 1 (fast): toolCount in contribute-state.json
//      │ < BASE_THRESHOLD → exit early (~1ms per PostToolUse)
//      ▼
//  Layer 2 (lazy): read events.jsonl, compute smart score
//      │ score = f(uniqueTools, hasSkills, hasErrors, duration)
//      │ < SMART_THRESHOLD → exit
//      ▼
//  STDOUT hint → AI suggests /contribute to user
//

/** Per-session contribute state, persisted to ~/.teamai/sessions/{sessionId}.json */
export interface ContributeState {
  /** Tool count at last evaluation (used for Layer 1 fast-path check) */
  toolCount?: number;
  /** Unique tool names at last evaluation (cached so cache-hit hint emission can skip readEvents) */
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
}

/** Layer 1 (fast-path) threshold: if toolCount < this, skip reading events.jsonl */
export const CONTRIBUTE_BASE_THRESHOLD = 20;

/** Smart score threshold: minimum score to show contribute hint */
export const CONTRIBUTE_SMART_THRESHOLD = 35;

/** Cache smart score for this many ms (6 hours) */
export const CONTRIBUTE_SCORE_CACHE_MS = 6 * 60 * 60 * 1000;

/** Phase 2: bonus when all recalls return zero results (knowledge gap) */
export const CONTRIBUTE_KNOWLEDGE_GAP_BONUS = 20;

/** Phase 2: bonus when recalls return results but top score is very low */
export const CONTRIBUTE_LOW_QUALITY_BONUS = 10;

/** Phase 2: threshold below which recall results are considered low quality */
export const CONTRIBUTE_LOW_QUALITY_THRESHOLD = 5.0;

/** Phase 2: score deduction when session has git commits and recall had hits */
export const CONTRIBUTE_GIT_COMMIT_DOWNWEIGHT = 15;

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
}

/** Schema version of the on-disk search-index.json (bump on breaking change). */
export const SEARCH_INDEX_VERSION = 4;

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
 * - user scope  → process.env.HOME (e.g. /Users/xxx)
 * - project scope → localConfig.projectRoot (e.g. /Users/xxx/my-project)
 */
export function resolveBaseDir(localConfig: LocalConfig): string {
  if (localConfig.scope === 'project' && localConfig.projectRoot) {
    return localConfig.projectRoot;
  }
  return process.env.HOME!;
}

/**
 * Get the .teamai home directory for a given scope.
 * - user scope  → ~/.teamai (evaluated at call time for test compatibility)
 * - project scope → <projectRoot>/.teamai
 */
export function getTeamaiHome(scope: Scope, projectRoot?: string): string {
  if (scope === 'project' && projectRoot) {
    return path.join(projectRoot, '.teamai');
  }
  return path.join(process.env.HOME ?? '', '.teamai');
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
 * Get the user-level pushignore path.
 */
export function getPushignorePath(): string {
  return path.join(process.env.HOME ?? '', '.teamai', 'pushignore');
}

/**
 * Check if wiki feature is enabled.
 * Disable by setting TEAMAI_WIKI_DISABLED=1 or TEAMAI_WIKI_ENABLED=false.
 * Defaults to enabled for backward compatibility.
 */
export function isWikiEnabled(): boolean {
  if (process.env.TEAMAI_WIKI_DISABLED === '1' || process.env.TEAMAI_WIKI_DISABLED === 'true') return false;
  if (process.env.TEAMAI_WIKI_ENABLED === '0' || process.env.TEAMAI_WIKI_ENABLED === 'false') return false;
  return true;
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
  mode: 'local' | 'mr' | 'workspace';
  /** 所有候选条目 */
  items: ImportSessionItem[];
  /** 已处理条目数（用于 --resume 进度恢复） */
  progress: number;
}
