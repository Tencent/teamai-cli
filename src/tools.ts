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
 * is not `dir` (Pi's variable moves `.pi/agent`). `moves.partial`: teamai
 * writes only some of the tool's files to a moved home; the rest still go to
 * the default home (#1221).
 */
export type Home = {
  readonly dir: string;
  readonly moves?: { readonly root?: string; readonly by: readonly HomeMove[]; readonly partial?: true };
};

/** A skills directory the tool reads under `$HOME`, from any session. */
export type HomeSkillRead = { readonly base: 'home'; readonly path: string; readonly evidence: Evidence };
/** A skills directory the tool reads in a project: from a session at or under its root, or only at it. */
export type ProjectSkillRead = {
  readonly base: 'project';
  readonly path: string;
  readonly when: 'workspaceUnder' | 'cwdOnly';
  readonly evidence: Evidence;
};

/**
 * Where the tool reads skills, per install scope: every directory a write of
 * that scope could land in. `'unknown'` is never judged.
 */
export type SkillReads = {
  readonly user: readonly HomeSkillRead[] | 'unknown';
  readonly project: readonly (HomeSkillRead | ProjectSkillRead)[] | 'unknown';
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
};

const UNKNOWN_READS = { user: 'unknown', project: 'unknown' } as const;

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
  },
  codex: {
    home: { dir: '.codex' },
    skillLoad: { calls: [], promptForm: '$name' },
    // Codex 0.163.0 runs read $CODEX_HOME/skills and ~/.agents/skills.
    skills: {
      user: [{ base: 'home', path: '.codex/skills', evidence: 'verified' }, { base: 'home', path: '.agents/skills', evidence: 'verified' }],
      project: 'unknown',
    },
  },
  'codex-internal': { home: { dir: '.codex-internal' }, skillLoad: { calls: [], promptForm: '$name' }, skills: UNKNOWN_READS },
  'claude-internal': { home: { dir: '.claude-internal' }, skillLoad: { calls: [{ name: 'Skill', evidence: 'assumed' }] }, skills: UNKNOWN_READS },
  tclaude: { home: { dir: '.tclaude' }, skillLoad: { calls: [{ name: 'Skill', evidence: 'assumed' }] }, skills: UNKNOWN_READS },
  tcodex: { home: { dir: '.tcodex' }, skillLoad: { calls: [], promptForm: '$name' }, skills: UNKNOWN_READS },
  cursor: { home: { dir: '.cursor' }, skillLoad: { calls: [] }, skills: UNKNOWN_READS },
  copilot: {
    home: { dir: '.copilot', moves: { by: [{ kind: 'env', name: 'COPILOT_HOME', evidence: 'verified' }] } },
    skillLoad: { calls: [{ name: 'skill', evidence: 'verified' }] },
    skills: {
      user: [{ base: 'home', path: '.copilot/skills', evidence: 'verified' }],
      project: [{ base: 'project', path: '.github/skills', when: 'workspaceUnder', evidence: 'verified' }],
    },
  },
  joycode: { home: { dir: '.joycode' }, skillLoad: 'unknown', skills: UNKNOWN_READS },
  qoder: { home: { dir: '.qoder' }, skillLoad: { calls: [{ name: 'Skill', evidence: 'source' }] }, skills: UNKNOWN_READS, installedBy: 'home-edition' },
  'qoder-cn': { home: { dir: '.qoder-cn' }, skillLoad: { calls: [{ name: 'Skill', evidence: 'source' }] }, skills: UNKNOWN_READS, installedBy: 'home-edition' },
  kiro: { home: { dir: '.kiro' }, skillLoad: 'unknown', skills: UNKNOWN_READS },
  trae: { home: { dir: '.trae' }, skillLoad: 'unknown', skills: UNKNOWN_READS, installedBy: 'home-edition' },
  'trae-cn': { home: { dir: '.trae-cn' }, skillLoad: 'unknown', skills: UNKNOWN_READS, installedBy: 'home-edition' },
  zcode: { home: { dir: '.zcode' }, skillLoad: { calls: [{ name: 'Skill', evidence: 'source' }] }, skills: UNKNOWN_READS },
  omp: {
    home: { dir: '.omp' },
    skillLoad: { calls: [] },
    skills: { user: [{ base: 'home', path: '.omp/agent/skills', evidence: 'verified' }], project: 'unknown' },
  },
  pi: {
    home: { dir: '.pi', moves: { root: '.pi/agent', by: [{ kind: 'env', name: 'PI_CODING_AGENT_DIR', evidence: 'verified' }], partial: true } },
    skillLoad: { calls: [], promptForm: 'skill-block' },
    skills: {
      user: [{ base: 'home', path: '.pi/agent/skills', evidence: 'verified' }],
      project: [{ base: 'project', path: '.pi/skills', when: 'cwdOnly', evidence: 'verified' }],
    },
  },
  // The CodeBuddy IDE sends `skill` (src/utils/tool-names.ts).
  codebuddy: {
    home: { dir: '.codebuddy' },
    skillLoad: { calls: [{ name: 'Skill', evidence: 'verified' }, { name: 'skill', evidence: 'assumed' }] },
    skills: { user: [{ base: 'home', path: '.codebuddy/skills', evidence: 'verified' }], project: 'unknown' },
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
  },
  dsh: {
    home: { dir: '.dsh', moves: { by: [{ kind: 'env', name: 'DSH_HOME', evidence: 'source' }] } },
    skillLoad: { calls: [{ name: 'skill', evidence: 'verified' }] },
    skills: { user: [{ base: 'home', path: '.dsh/skills', evidence: 'verified' }], project: 'unknown' },
  },
  workbuddy: {
    home: { dir: '.workbuddy' },
    installedBy: 'own-root',
    skillLoad: { calls: [{ name: 'Skill', evidence: 'source' }, { name: 'skill', evidence: 'assumed' }] },
    skills: UNKNOWN_READS,
  },
  // opencode v2.1.1 Global.Path: OPENCODE_CONFIG_DIR, else (XDG_CONFIG_HOME || ~/.config)/opencode.
  opencode: {
    home: {
      dir: '.config/opencode',
      moves: { by: [{ kind: 'env', name: 'OPENCODE_CONFIG_DIR', evidence: 'source' }, { kind: 'xdg', child: 'opencode', evidence: 'source' }], partial: true },
    },
    skillLoad: { calls: [{ name: 'skill', evidence: 'verified' }] },
    skills: {
      user: [{ base: 'home', path: '.config/opencode/skills', evidence: 'verified' }, { base: 'home', path: '.claude/skills', evidence: 'verified' }],
      project: [
        { base: 'project', path: '.opencode/skills', when: 'workspaceUnder', evidence: 'verified' },
        { base: 'project', path: '.claude/skills', when: 'workspaceUnder', evidence: 'verified' },
      ],
    },
  },
  // muse-bin 1.4.11: $XDG_CONFIG_HOME/muse, else ~/.config/muse; with XDG_CONFIG_HOME set, ~/.config/muse is never read.
  muse: {
    home: { dir: '.config/muse', moves: { by: [{ kind: 'xdg', child: 'muse', evidence: 'source' }], partial: true } },
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
  },
} as const satisfies Record<ToolId, ToolDescriptor>;

export function isToolId(value: string): value is ToolId {
  return Object.hasOwn(TOOLS, value);
}

/** Whether teamai writes only some of `tool`'s files to a moved home (`Home.moves.partial`). */
export function movesPartly(tool: ToolId): boolean {
  const { home }: ToolDescriptor = TOOLS[tool];
  return home.moves?.partial === true;
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
