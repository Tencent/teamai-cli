import path from 'node:path';
import { isToolInstalledForConfig } from './resources/base.js';
import { getsRulesFromExtension } from './resources/rule-format.js';
import { pathExists, readFileSafe, remove, writeFile } from './utils/fs.js';
import { getUserHome } from './utils/home.js';
import { CODEX_TOOL_IDS } from './utils/tool-names.js';
import {
  opencodeClaudeFallback, opencodeContextReference, readOpencodeInstructionList, reconcileOpencodeInstructions,
} from './resources/opencode-config.js';
import { gitTracking, gitTracks } from './mcp-git-exclude.js';
import { TEAMAI_CONTEXT_RULE_NAME } from './builtin-rules.js';
import { getHermesHome } from './hermes-home.js';
import { getHermesSoulPath } from './hermes-config.js';
import { HERMES_SECTION_LIMIT } from './hermes-hooks.js';
import {
  isAgentExcluded,
  resolveToolBaseDir,
  resolveHookScope,
  scopedToolPaths,
  TEAMAI_CLAUDEMD_END,
  TEAMAI_CLAUDEMD_START,
  TEAMAI_CULTURE_END,
  TEAMAI_CULTURE_START,
  TEAMAI_RECALL_RULES_END,
  TEAMAI_RECALL_RULES_START,
  TEAMAI_RULES_END,
  TEAMAI_RULES_START,
  TEAMAI_TEAM_RULES_END,
  TEAMAI_TEAM_RULES_START,
  type LocalConfig,
  type Scope,
  type TeamaiConfig,
} from './types.js';

/**
 * Where teamai's instruction blocks (culture, claudemd, recall) go: one target
 * per tool and scope, written only for tools that are installed, and never a
 * file the project or another tool shares (#945).
 */

type ToolPaths = TeamaiConfig['toolPaths'][string];

/**
 * A file of a tool, relative to the tool's base dir for the scope
 * (`resolveToolBaseDir`) or absolute; undefined when it has none.
 */
type ToolFile = (paths: ToolPaths) => string | undefined | Promise<string | undefined>;

interface TargetEntry {
  /** The file this tool reads the blocks from in this scope. */
  readonly file: ToolFile;
  /**
   * For a tool with no rules format, in user scope: the file it reads the
   * team rules from (#938, #946), the blocks' `file` unless `file` is given,
   * and how doctor names it.
   */
  readonly teamRules?: { readonly label: string; readonly file?: ToolFile };
  /** The tool gets this scope's blocks from teamai's session hook or extension instead of a file. */
  readonly hook?: boolean;
  /** The most characters the hook channel takes; the tool drops a larger text whole. */
  readonly hookLimit?: number;
  /** Text teamai writes above the blocks when it creates the file, e.g. the frontmatter a rules loader needs. */
  readonly header?: string;
  /** teamai owns the whole file: one it did not write is left alone, and it is deleted once its blocks are gone. */
  readonly owned?: boolean;
  /**
   * Files an earlier release wrote this tool's blocks to by default, relative
   * to the same base dir. A pull strips teamai blocks from them once no
   * installed tool targets them. A tool whose target is not its `claudemd`
   * retires the team's configured `claudemd` too (`retiredInstructionFiles`).
   */
  readonly retired: readonly string[];
}

/** The tool's `claudemd` path from the team's `toolPaths` (honors `toolRoots`). */
const configured = (paths: ToolPaths): string | undefined => paths.claudemd;

/**
 * OpenClaw's workspace AGENTS.md, in the workspace its hooks resolve
 * (`resolveOpenclawWorkspaceDir`); none when no workspace resolves, which is
 * also what says OpenClaw is not installed here (`isInstructionToolInstalled`).
 */
const openclawWorkspace = async (): Promise<string | undefined> => {
  const { resolveOpenclawWorkspace } = await import('./openclaw-hooks.js');
  const workspace = await resolveOpenclawWorkspace();
  // An openclaw.json teamai cannot read may name another workspace: guess none (#946).
  return workspace.kind === 'found' ? path.join(workspace.dir, 'AGENTS.md') : undefined;
};

/** DeepSeek Harness reads `$DSH_HOME/AGENTS.md` (`~/.dsh` by default) in its first request. */
const dshAgentsMd = async (): Promise<string> => {
  const { resolveDshHome } = await import('./dsh-hooks.js');
  return path.join(resolveDshHome(), 'AGENTS.md');
};

const codexUser: TargetEntry = { file: configured, teamRules: { label: 'Codex AGENTS.md' }, retired: [] };

/**
 * teamai's own always-applied file in the tool's rules directory. A team's
 * `toolPaths` entry without `rules` keeps its configured `claudemd`, which is
 * the member's file there, not teamai's.
 */
const contextRule = (extension: string) => (paths: ToolPaths): string | undefined =>
  paths.rules === undefined ? paths.claudemd : path.posix.join(paths.rules, `${TEAMAI_CONTEXT_RULE_NAME}${extension}`);

/**
 * Cursor applies an `.mdc` rule in every session only with this frontmatter;
 * CodeBuddy and WorkBuddy read the same key.
 */
const ALWAYS_APPLY = '---\nalwaysApply: true\n---\n';
const cursor: TargetEntry = { file: contextRule('.mdc'), header: ALWAYS_APPLY, owned: true, retired: [] };

// A team override or an earlier build could have pointed Codex at the project AGENTS.md.
const codexHook: TargetEntry = { file: () => undefined, hook: true, retired: ['AGENTS.md'] };

/**
 * CodeBuddy and WorkBuddy both read the project's .codebuddy/rules, so they
 * share one copy there; uninstalling one keeps it while the other remains.
 * An entry without `rules` keeps its configured `claudemd`, as `contextRule`.
 */
const codebuddyProjectRule = (paths: ToolPaths): string | undefined =>
  paths.rules === undefined ? paths.claudemd : `.codebuddy/rules/${TEAMAI_CONTEXT_RULE_NAME}.md`;

// One line per tool, so a change to one tool's target edits one line.
const USER_TARGETS: Readonly<Record<string, TargetEntry>> = {
  claude: { file: configured, retired: [] },
  // Cursor CLI reads ~/.cursor/rules when the session starts under $HOME.
  cursor,
  'claude-internal': { file: configured, retired: [] },
  tclaude: { file: configured, retired: [] },
  // Hermes loads SOUL.md in every session; teamai's rules block is already there.
  hermes: { file: () => getHermesSoulPath(), retired: ['AGENTS.md'] },
  copilot: { file: configured, retired: [] },
  // RULES.md is an always-applied rule beside OMP's single user context file,
  // which ~/.omp/agent/AGENTS.md would take from ~/.agents/AGENTS.md.
  omp: { file: () => '.omp/agent/RULES.md', retired: ['.omp/agent/AGENTS.md'] },
  // Pi reads no user rules directory: the team rules sit beside the blocks.
  pi: { file: configured, teamRules: { label: 'Pi AGENTS.md' }, retired: [] },
  // $CODEX_HOME/AGENTS.md (a `toolRoots` entry moves the claudemd path).
  codex: codexUser,
  'codex-internal': codexUser,
  tcodex: codexUser,
  // ZCode reads ~/.zcode/AGENTS.md as its user context; teamai writes it only the team rules.
  zcode: { file: () => undefined, teamRules: { label: 'ZCode AGENTS.md', file: () => '.zcode/AGENTS.md' }, retired: [] },
  dsh: { file: () => undefined, teamRules: { label: 'DeepSeek Harness AGENTS.md', file: dshAgentsMd }, retired: [] },
  // JoyCode reads its user rules from one plain text file.
  joycode: { file: () => undefined, teamRules: { label: 'JoyCode rules.txt', file: () => '.joycode/rules.txt' }, retired: [] },
  // WorkBuddy reads user rules from ~/.workbuddy/rules; nothing else reads them.
  workbuddy: { file: contextRule('.md'), header: ALWAYS_APPLY, owned: true, retired: ['AGENTS.md'] },
  codebuddy: { file: configured, retired: [] },
  // A profile or OPENCLAW_WORKSPACE_DIR moves the workspace off the default
  // path. The default workspace is not retired: OpenClaw's default profile
  // still reads it.
  openclaw: { file: openclawWorkspace, teamRules: { label: 'OpenClaw workspace AGENTS.md' }, retired: [] },
  // Registered in the user opencode.json `instructions`; AGENTS.md beside it stays the member's.
  opencode: { file: () => '.config/opencode/teamai-context.md', owned: true, retired: [] },
};

const PROJECT_TARGETS: Readonly<Record<string, TargetEntry>> = {
  // Claude loads every unscoped .claude/rules file from the root and any
  // subdirectory, and still reads AGENTS.md and an authored CLAUDE.md as it
  // chose to. CLAUDE.local.md would stop the native AGENTS.md load (#945).
  claude: { file: contextRule('.md'), owned: true, retired: ['.claude/CLAUDE.md'] },
  cursor,
  'claude-internal': { file: configured, retired: [] },
  tclaude: { file: configured, retired: [] },
  // Hermes reads the project's AGENTS.md itself; teamai's Hermes plugin adds
  // the blocks as a system prompt section, which holds 4,000 characters.
  hermes: { file: () => undefined, hook: true, hookLimit: HERMES_SECTION_LIMIT, retired: ['AGENTS.md'] },
  copilot: { file: configured, retired: [] },
  // OMP reads project rules only from the root and keeps one context file per
  // level, so .omp/AGENTS.md would hide the project's AGENTS.md: teamai's OMP
  // extension adds the blocks to each turn's system prompt instead.
  omp: { file: () => undefined, hook: true, retired: ['.omp/AGENTS.md'] },
  // Pi reads the project's AGENTS.md itself; teamai's Pi extension adds the
  // blocks to each run's system prompt.
  pi: { file: () => undefined, hook: true, retired: ['AGENTS.md'] },
  workbuddy: { file: codebuddyProjectRule, header: ALWAYS_APPLY, owned: true, retired: ['AGENTS.md'] },
  codebuddy: { file: codebuddyProjectRule, header: ALWAYS_APPLY, owned: true, retired: ['.codebuddy/CODEBUDDY.md'] },
  // OpenClaw's only project file is the shared AGENTS.md; it reads no
  // project .openclaw/workspace (#946).
  openclaw: { file: () => undefined, retired: ['.openclaw/workspace/AGENTS.md'] },
  // Codex reads no project file only it reads; its session-start and
  // subagent-start hooks add the blocks (#938, #940).
  codex: codexHook,
  'codex-internal': codexHook,
  tcodex: codexHook,
  // Registered in .opencode/opencode.json `instructions`; the root opencode.json stays the project's.
  opencode: { file: () => '.opencode/teamai-context.md', owned: true, retired: [] },
};

type MarkerPair = readonly [start: string, end: string, name: string];

const CULTURE: MarkerPair = [TEAMAI_CULTURE_START, TEAMAI_CULTURE_END, 'culture'];
const CLAUDEMD: MarkerPair = [TEAMAI_CLAUDEMD_START, TEAMAI_CLAUDEMD_END, 'claudemd'];
const RECALL: MarkerPair = [TEAMAI_RECALL_RULES_START, TEAMAI_RECALL_RULES_END, 'recall'];
/**
 * The rules block releases before per-file rules wrote into instruction files.
 * Hermes still writes it live in SOUL.md, which is only ever a target here,
 * never a retired file, so cleanup never reaches that copy.
 */
const LEGACY_RULES: MarkerPair = [TEAMAI_RULES_START, TEAMAI_RULES_END, 'rules'];
/** The team rules a Codex-family tool reads from its own AGENTS.md in user scope. */
const TEAM_RULES: MarkerPair = [TEAMAI_TEAM_RULES_START, TEAMAI_TEAM_RULES_END, 'team-rules'];

/** Every teamai block a stale target can hold. */
const STALE_BLOCKS: readonly MarkerPair[] = [CULTURE, CLAUDEMD, RECALL, LEGACY_RULES, TEAM_RULES];

function entryFor(tool: string, scope: Scope): TargetEntry | undefined {
  return (scope === 'user' ? USER_TARGETS : PROJECT_TARGETS)[tool];
}

/** One instruction file and the tools that read it. */
export interface InstructionTarget {
  /** Absolute path. */
  path: string;
  tools: string[];
  /** Whether every tool reading this file has the `teamai-recall` subagent, which decides the recall block it gets. */
  recall: boolean;
  header?: string;
  owned?: boolean;
}

/** An installed, non-excluded tool that gets this scope's blocks from its session hook or extension. */
export interface InstructionHook {
  tool: string;
  recall: boolean;
  /** The most characters its channel takes, when it has a limit. */
  limit?: number;
}

export interface InstructionTargets {
  /** Targets of installed, non-excluded tools, one per file. */
  targets: InstructionTarget[];
  hooks: InstructionHook[];
  /** Files earlier releases wrote blocks to that no installed tool reads now: a pull strips teamai blocks from them. */
  stale: InstructionTarget[];
  /** Claude's user file when OpenCode reads the blocks from it, so OpenCode gets no file of its own. */
  opencodeFallback?: string | null;
  /** The fallback holds blocks no installed, enabled Claude Code keeps current. */
  opencodeFallbackStale?: boolean;
}

/**
 * The block texts to deliver, each with its markers. `null` removes the block;
 * an absent field leaves it as it is.
 */
export interface InstructionBlocks {
  culture?: string | null;
  claudemd?: string | null;
  /** For a tool with the `teamai-recall` subagent. */
  recall?: string | null;
  /** For a tool without it: the agent runs `teamai recall` itself. Same markers. */
  directRecall?: string | null;
}

/**
 * The instruction file `tool` reads in the active scope, relative to its base
 * dir or absolute (see `TargetEntry.file`). Tools absent from the table keep
 * their configured `claudemd` path.
 */
export async function instructionTargetFile(tool: string, paths: ToolPaths, scope: Scope): Promise<string | undefined> {
  return (entryFor(tool, scope)?.file ?? configured)(paths);
}

/**
 * Files, relative to the tool's base dir or absolute, an earlier release wrote
 * `tool`'s blocks to in `scope`: the defaults, and the `claudemd` the team's
 * `toolPaths` gives a tool whose target moved off it.
 */
export async function retiredInstructionFiles(tool: string, paths: ToolPaths, scope: Scope): Promise<readonly string[]> {
  const entry = entryFor(tool, scope);
  if (!entry) return [];
  // OpenClaw's default workspace stays read by its default profile (#946).
  if (tool === 'openclaw') return entry.retired;
  const previous = paths.claudemd === await instructionTargetFile(tool, paths, scope) ? undefined : paths.claudemd;
  return previous === undefined || entry.retired.includes(previous) ? entry.retired : [...entry.retired, previous];
}

/** Whether `tool` gets this scope's blocks from teamai's session hook or extension rather than a file. */
export function deliversInstructionsByHook(tool: string, scope: Scope): boolean {
  return entryFor(tool, scope)?.hook === true;
}

/**
 * The text a session hook adds to the prompt: the same blocks a file target
 * holds, with the recall block that matches whether the tool has the
 * `teamai-recall` subagent.
 */
export function instructionHookText(blocks: InstructionBlocks, recall: boolean): string {
  return [blocks.culture, blocks.claudemd, recall ? blocks.recall : blocks.directRecall]
    .filter((block): block is string => typeof block === 'string')
    .map(managedBlockBody)
    .filter((body) => body !== '')
    .join('\n\n');
}

/** The native project context, including legacy blocks that migration could not yet retire. */
export async function nativeProjectInstructions(tool: string, projectRoot: string): Promise<string> {
  const preferred = CODEX_TOOL_IDS.some((id) => id === tool) ? 'AGENTS.override.md'
    : tool === 'omp' ? '.omp/AGENTS.md' : undefined;
  return (preferred ? await readFileSafe(path.join(projectRoot, preferred)) : null)
    ?? await readFileSafe(path.join(projectRoot, 'AGENTS.md')) ?? '';
}

/** The text a session hook adds for `tool`, resolved for the member, project and scope in `localConfig`. */
export async function instructionHookTextFor(teamConfig: TeamaiConfig, localConfig: LocalConfig, tool: string): Promise<string> {
  const { buildRolePullContext } = await import('./resources/desired.js');
  const { resolveInstructionBlocks } = await import('./pull.js');
  const { blocks } = await resolveInstructionBlocks(teamConfig, localConfig, await buildRolePullContext(localConfig));
  if (localConfig.scope === 'project' && localConfig.projectRoot) {
    const native = await nativeProjectInstructions(tool, localConfig.projectRoot);
    // Native context still supplies each retained block. Do not add a second
    // member selection while another writer's replacement holds cleanup back.
    if (native.includes(CULTURE[0]) || native.includes(CULTURE[1])) blocks.culture = null;
    if (native.includes(CLAUDEMD[0]) || native.includes(CLAUDEMD[1])) blocks.claudemd = null;
    if (native.includes(RECALL[0]) || native.includes(RECALL[1])) blocks.recall = blocks.directRecall = null;
  }
  return instructionHookText(blocks, Boolean(scopedToolPaths(teamConfig, localConfig)[tool]?.agents));
}

/** The message for hook text over its channel's limit, or null when it fits. */
export function hookLimitProblem(hook: InstructionHook, text: string): string | null {
  if (hook.limit === undefined || text.length <= hook.limit) return null;
  return `${hook.tool} cannot load this project's team instructions: they are ${text.length} characters, over the `
    + `${hook.limit}-character limit of its prompt section, so ${hook.tool} skips them. Shorten culture.md or the `
    + 'claudemd/ files for this scope, or run `teamai recall disable`, which drops the recall block from them. '
    + 'teamai does not cut them or write them to AGENTS.md.';
}

/**
 * Whether the extension or plugin that adds a hook tool's team instructions is
 * installed as this build writes it, and if not, what to do.
 */
export async function instructionHookChannel(
  tool: string,
  context?: { teamConfig: TeamaiConfig; localConfig: LocalConfig },
): Promise<{ ready: boolean; fix: string }> {
  const rerun = 'Run `teamai hooks inject` to reinstall it; `teamai hooks remove` takes it away.';
  if (tool === 'omp' || tool === 'pi') {
    const { buildOmpExtensionSource, resolveOmpExtensionsDir, OMP_HOOK_FILE } = await import('./omp-hooks.js');
    const { buildPiExtensionSource, resolvePiExtensionsDir, PI_HOOK_FILE } = await import('./pi-hooks.js');
    const file = tool === 'omp' ? path.join(resolveOmpExtensionsDir(), OMP_HOOK_FILE) : path.join(resolvePiExtensionsDir(), PI_HOOK_FILE);
    const expected = tool === 'omp' ? buildOmpExtensionSource() : buildPiExtensionSource();
    return {
      ready: await readFileSafe(file) === expected,
      // Pi's extension also carries a project's team rules (#946); OMP reads its own rules files.
      fix: `${file} is missing or out of date, so ${tool} sessions in this project get no team instructions`
        + `${getsRulesFromExtension(tool) ? ' or rules' : ''}. ${rerun}`,
    };
  }
  if (tool === 'hermes') {
    const {
      buildInstructionsPlugin, foreignInstructionsPlugin, getInstructionsPluginDir, HERMES_INSTRUCTIONS_PLUGIN, ownsInstructionsPlugin,
    } = await import('./hermes-hooks.js');
    const { getHermesConfigPath, isHermesPluginEnabled } = await import('./hermes-config.js');
    if (!await ownsInstructionsPlugin()) return { ready: false, fix: foreignInstructionsPlugin() };
    const dir = getInstructionsPluginDir();
    const plugin = buildInstructionsPlugin();
    const installed = await readFileSafe(path.join(dir, '__init__.py')) === plugin.init
      && await readFileSafe(path.join(dir, 'plugin.yaml')) === plugin.manifest;
    if (!installed) {
      return { ready: false, fix: `The Hermes plugin ${dir} is missing or out of date, so Hermes sessions in this project get no team instructions. ${rerun}` };
    }
    return {
      ready: await isHermesPluginEnabled(HERMES_INSTRUCTIONS_PLUGIN),
      fix: `${HERMES_INSTRUCTIONS_PLUGIN} is not in plugins.enabled of ${getHermesConfigPath()}, and Hermes loads no user plugin that is not listed there. `
        + 'Add it there (or remove it from plugins.disabled), then start a new Hermes session.',
    };
  }
  if (CODEX_TOOL_IDS.some((id) => id === tool)) {
    const { getHookStatus } = await import('./hooks.js');
    const hookScope = context && resolveHookScope(context.localConfig);
    const settings = context && hookScope && scopedToolPaths(context.teamConfig, { ...context.localConfig, scope: hookScope.scope })[tool]?.settings;
    const file = settings && hookScope ? path.resolve(hookScope.baseDir, settings) : undefined;
    return {
      ready: file !== undefined && await getHookStatus(file, tool) === 'installed',
      fix: `${file ?? `${tool}'s hooks file`} is missing or out of date, so ${tool} sessions get no team instructions. ${rerun}`,
    };
  }
  return { ready: true, fix: '' };
}

/**
 * Whether reconciling the hooks leaves `tool`'s channel ready. A dry run
 * writes nothing, so it previews the cleanup a real pull does once it has
 * installed the extension or plugin. A same-named file or plugin of the
 * member's, or a plugin the member disabled, keeps the channel closed.
 */
export async function instructionHookChannelInstallable(tool: string): Promise<boolean> {
  if (tool === 'omp' || tool === 'pi') {
    const { hasOmpHooks, resolveOmpExtensionsDir, OMP_HOOK_FILE } = await import('./omp-hooks.js');
    const { hasPiHooks, resolvePiExtensionsDir, PI_HOOK_FILE } = await import('./pi-hooks.js');
    const file = tool === 'omp' ? path.join(resolveOmpExtensionsDir(), OMP_HOOK_FILE) : path.join(resolvePiExtensionsDir(), PI_HOOK_FILE);
    return !await pathExists(file) || (tool === 'omp' ? await hasOmpHooks() : await hasPiHooks());
  }
  if (tool === 'hermes') {
    const { HERMES_INSTRUCTIONS_PLUGIN, ownsInstructionsPlugin } = await import('./hermes-hooks.js');
    const { isHermesPluginDisabled } = await import('./hermes-config.js');
    return await ownsInstructionsPlugin() && !await isHermesPluginDisabled(HERMES_INSTRUCTIONS_PLUGIN);
  }
  return true;
}

/**
 * What keeps an installed hook tool from getting this member's team
 * instructions in the scope: its extension or plugin, or the size of the text.
 * pull and init print these after installing the hooks; doctor checks them.
 */
export async function instructionChannelProblems(teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<string[]> {
  const { hooks } = await resolveInstructionTargets(teamConfig, localConfig);
  const problems: string[] = [];
  for (const hook of hooks) {
    const text = await instructionHookTextFor(teamConfig, localConfig, hook.tool);
    if (!text) continue;
    const channel = await instructionHookChannel(hook.tool, { teamConfig, localConfig });
    if (!channel.ready) {
      problems.push(channel.fix);
      continue;
    }
    const overLimit = hookLimitProblem(hook, text);
    if (overLimit) problems.push(overLimit);
  }
  return problems;
}

/** A block's text without its markers and DO NOT EDIT line, which only a file needs. */
function managedBlockBody(block: string): string {
  return block
    .split('\n')
    .filter((line) => !/^<!-- (\[teamai:[a-z-]+:(start|end)\]|DO NOT EDIT\b).*-->$/.test(line.trim()))
    .join('\n')
    .trim();
}

/** Absolute instruction file of `tool` in the active scope, or undefined when it takes none. */
export async function instructionTargetPath(
  tool: string,
  paths: ToolPaths,
  localConfig: LocalConfig,
): Promise<string | undefined> {
  const file = await instructionTargetFile(tool, paths, localConfig.scope);
  return file === undefined ? undefined : path.resolve(resolveToolBaseDir(tool, localConfig), file);
}

/** The file a tool with no rules format reads the team rules from in user scope (`userRulesFile`). */
export interface UserRulesFile {
  /** Absolute; undefined when the tool has none here (the team's `toolPaths` gives it no `claudemd`, or no OpenClaw workspace resolves). */
  readonly file: string | undefined;
  /** Whether the tool is installed, probed the way its instruction blocks are, so pull writes the block. */
  readonly installed: boolean;
  /** How doctor names the file: "Team rules are inlined in <label>". */
  readonly label: string;
  /** The tool's config, which names the file, could not be read: pull writes no block and doctor fails (OpenClaw's openclaw.json). */
  readonly unreadable?: { readonly config: string; readonly error: string };
}

/**
 * What happened and what to do when `tool`'s config, which names its rules
 * file, cannot be read (`UserRulesFile.unreadable`): pull warns with it and
 * doctor's fix says it.
 */
export function unreadableRulesFileMessage(tool: string, unreadable: NonNullable<UserRulesFile['unreadable']>): string {
  return `teamai cannot read ${unreadable.config} as plain JSON (${unreadable.error}), so it cannot tell which `
    + `workspace ${tool} reads: it writes no team-rules block, and ${tool} gets none of the team rules from teamai. `
    + 'Make that file plain JSON (no comments or trailing commas), then run `teamai pull`.';
}

/** Whether `tool` reads the team rules from a file of its own in user scope. */
export function readsTeamRulesFromFile(tool: string): boolean {
  return entryFor(tool, 'user')?.teamRules !== undefined;
}

/**
 * The file `tool` reads the team rules from in this scope: one only it reads,
 * in its home, for a tool with no rules format in user scope (#938, #946);
 * undefined for every other tool and scope. The rules writer, doctor and
 * uninstall all ask here.
 */
export async function userRulesFile(tool: string, paths: ToolPaths, localConfig: LocalConfig): Promise<UserRulesFile | undefined> {
  if (localConfig.scope !== 'user') return undefined;
  const entry = entryFor(tool, 'user');
  if (entry?.teamRules === undefined) return undefined;
  const { label } = entry.teamRules;
  if (tool === 'openclaw') {
    // Installed where its workspace resolves, or where openclaw.json says
    // where it is in a form teamai cannot read.
    const { resolveOpenclawWorkspace } = await import('./openclaw-hooks.js');
    const workspace = await resolveOpenclawWorkspace();
    if (workspace.kind === 'unreadable-config') {
      return { file: undefined, installed: true, label, unreadable: { config: workspace.file, error: workspace.error } };
    }
    return { file: workspace.kind === 'found' ? path.join(workspace.dir, 'AGENTS.md') : undefined, installed: workspace.kind === 'found', label };
  }
  const relative = await (entry.teamRules.file ?? entry.file)(paths);
  const file = relative === undefined ? undefined : path.resolve(resolveToolBaseDir(tool, localConfig), relative);
  return { file, installed: await isInstructionToolInstalled(tool, paths, localConfig), label };
}

/**
 * The target `tool` reads from `file` in `scope`, with the header and
 * ownership its entry declares. Only teamai's `teamai-context` file takes
 * them; a configured file is the member's.
 */
export async function instructionTargetAt(tool: string, file: string, scope: Scope, paths: ToolPaths): Promise<InstructionTarget> {
  const entry = entryFor(tool, scope);
  // teamai's file is the one its entry generates; the team's configured
  // `claudemd` (the fallback without `rules`) is the member's, whatever its name.
  const own = path.basename(file).startsWith(`${TEAMAI_CONTEXT_RULE_NAME}.`)
    && await instructionTargetFile(tool, paths, scope) !== paths.claudemd;
  return { path: file, tools: [], recall: false, header: own ? entry?.header : undefined, owned: own ? entry?.owned : undefined };
}

/**
 * The files earlier releases wrote instruction blocks to in the active scope.
 * A tool's current target is not among them: a tool that is not installed
 * here may still be installed by a teammate who shares the file (#945).
 */
async function retiredTargets(toolPaths: Record<string, ToolPaths>, localConfig: LocalConfig): Promise<Map<string, InstructionTarget>> {
  const current = new Set(await Promise.all(Object.entries(toolPaths).map(([tool, paths]) => instructionTargetPath(tool, paths, localConfig))));
  const known = new Map<string, InstructionTarget>();
  const table = localConfig.scope === 'user' ? USER_TARGETS : PROJECT_TARGETS;
  for (const tool of Object.keys(table)) {
    const baseDir = resolveToolBaseDir(tool, localConfig);
    for (const retired of await retiredInstructionFiles(tool, toolPaths[tool] ?? {}, localConfig.scope)) {
      const file = path.resolve(baseDir, retired);
      if (!current.has(file) && !known.has(file)) known.set(file, { path: file, tools: [], recall: false });
    }
  }
  return known;
}

/**
 * Whether `tool` is installed, probed through a path under its own root. The
 * instruction file is the probe only when the entry has no other path, and
 * then only through its directory: a bare `AGENTS.md` is shared by several
 * tools and says nothing about any one of them, so such an entry counts as
 * installed, as it did before #945.
 */
export async function isInstructionToolInstalled(tool: string, paths: ToolPaths, localConfig: LocalConfig): Promise<boolean> {
  // Hermes lives in $HERMES_HOME, which ~/.hermes need not be.
  if (tool === 'hermes') return pathExists(getHermesHome());
  // teamai installs the OMP extension only where ~/.omp exists; a project's
  // own .omp/ says nothing about this member using OMP.
  if (tool === 'omp') return pathExists(path.join(getUserHome(), '.omp'));
  // OpenClaw is installed where its workspace resolves, whatever ~/.openclaw
  // holds; its target file is there only then (`openclawWorkspace`).
  if (tool === 'openclaw') return true;
  // DeepSeek Harness runs from $DSH_HOME (`~/.dsh` by default), whatever ~/.dsh holds.
  if (tool === 'dsh') {
    const { isDshInstalled } = await import('./dsh-hooks.js');
    return isDshInstalled();
  }
  // teamai installs the Pi extension in ~/.pi/agent/extensions when ~/.pi
  // exists, so a project needs no .pi/ of its own.
  if (tool === 'pi' && await pathExists(path.join(getUserHome(), '.pi'))) return true;
  const nestedClaudemd = paths.claudemd !== undefined && paths.claudemd.includes('/') ? paths.claudemd : undefined;
  const probe = paths.skills ?? paths.rules ?? paths.agents ?? paths.settings ?? nestedClaudemd;
  if (probe === undefined) return paths.claudemd !== undefined;
  return isToolInstalledForConfig(tool, probe, localConfig);
}

/** Resolve where this scope's instruction blocks go, and which files to clean. */
export async function resolveInstructionTargets(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
): Promise<InstructionTargets> {
  const targets = new Map<string, InstructionTarget>();
  // Files an installed tool reads, excluded or not: an excluded tool's file is
  // left alone, not cleaned.
  const inUse = new Set<string>();
  const hooks: InstructionHook[] = [];
  const toolPaths = scopedToolPaths(teamConfig, localConfig);
  for (const [tool, paths] of Object.entries(toolPaths)) {
    const entry = entryFor(tool, localConfig.scope);
    const file = await instructionTargetPath(tool, paths, localConfig);
    if (isAgentExcluded(localConfig, tool)) {
      if (file) inUse.add(file);
      for (const retired of await retiredInstructionFiles(tool, paths, localConfig.scope)) {
        inUse.add(path.resolve(resolveToolBaseDir(tool, localConfig), retired));
      }
      continue;
    }
    if (entry?.hook) {
      // Codex's hooks are user-level, so a project without its own `.codex/`
      // still reaches an installed Codex.
      // Probe at the member's recorded root (toolRoots), as hook install does.
      let probeConfig = localConfig;
      let probePaths = paths;
      if (entry === codexHook) {
        // A project config records no tool roots; the member's are in the
        // user config, which a user-scope init may have written later.
        const { loadLocalConfig } = await import('./config.js');
        const toolRoots = localConfig.toolRoots ?? (await loadLocalConfig())?.toolRoots;
        probeConfig = { ...localConfig, scope: 'user', toolRoots };
        probePaths = scopedToolPaths(teamConfig, probeConfig)[tool] ?? paths;
      }
      if (await isInstructionToolInstalled(tool, probePaths, probeConfig)) {
        hooks.push({ tool, recall: Boolean(paths.agents), limit: entry.hookLimit });
      }
      continue;
    }
    if (!file || !await isInstructionToolInstalled(tool, paths, localConfig)) continue;
    inUse.add(file);
    const target = targets.get(file) ?? await instructionTargetAt(tool, file, localConfig.scope, paths);
    // The subagent block only where every tool reading the file has the subagent.
    target.recall = Boolean(paths.agents) && (target.tools.length === 0 || target.recall);
    target.tools.push(tool);
    targets.set(file, target);
  }
  const stale = [...(await retiredTargets(toolPaths, localConfig)).values()].filter((t) => !inUse.has(t.path));
  // OpenCode reads ~/.claude/CLAUDE.md while its own user AGENTS.md does not
  // exist; when Claude's blocks are there, a second copy would duplicate them.
  // That holds for blocks an excluded Claude left there too: OpenCode reads
  // them all the same.
  const opencode = [...targets.values()].find((target) => target.tools.includes('opencode'));
  const claudeFile = path.join(getUserHome(), '.claude', 'CLAUDE.md');
  const claudeHolds = !targets.has(claudeFile) && await holdsInstructionBlocks(claudeFile);
  const opencodeFallback = localConfig.scope === 'user' && opencode !== undefined
    ? await opencodeClaudeFallback(getUserHome(), [...targets.keys(), ...claudeHolds ? [claudeFile] : []])
    : null;
  if (opencode && opencodeFallback) {
    targets.delete(opencode.path);
    stale.push(opencode);
  }
  return { targets: [...targets.values()], hooks, stale, opencodeFallback, opencodeFallbackStale: Boolean(opencodeFallback) && claudeHolds };
}

/** Retire a file only after every installed tool that wrote it has replacement delivery. */
export async function retiredFilesOfReached(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  reached: readonly string[],
): Promise<InstructionTarget[]> {
  const { stale, hooks } = await resolveInstructionTargets(teamConfig, localConfig);
  const writers = new Map<string, string[]>();
  for (const [tool, paths] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
    if (!hooks.some((hook) => hook.tool === tool) && !await isInstructionToolInstalled(tool, paths, localConfig)) continue;
    // A tool with no file and no hook channel here (OpenClaw in a project, #946)
    // has no replacement to wait for; a hook tool whose hook is not installed does.
    if (!entryFor(tool, localConfig.scope)?.hook && await instructionTargetPath(tool, paths, localConfig) === undefined) continue;
    for (const file of await retiredInstructionFiles(tool, paths, localConfig.scope)) {
      const absolute = path.resolve(resolveToolBaseDir(tool, localConfig), file);
      writers.set(absolute, [...writers.get(absolute) ?? [], tool]);
    }
  }
  return stale.filter((target) => (writers.get(target.path) ?? []).every((tool) => reached.includes(tool)));
}

/**
 * List teamai's OpenCode instruction file in OpenCode's `instructions` while
 * it holds teamai's blocks, and drop the entry teamai recorded adding once the
 * file is gone: OpenCode reads no file it is not told about. A file without
 * teamai's blocks is the member's, and an entry teamai did not add stays. Returns what it did or, with
 * `dryRun`, would do.
 */
export async function registerOpencodeContext(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  resolved: Pick<InstructionTargets, 'targets' | 'stale'>,
  dryRun: boolean,
  files: readonly InstructionFileResult[],
): Promise<string | null> {
  const paths = scopedToolPaths(teamConfig, localConfig).opencode;
  const contextFile = paths && await instructionTargetPath('opencode', paths, localConfig);
  if (!contextFile) return null;
  const wanted = resolved.targets.some((target) => target.path === contextFile);
  if (!wanted && !resolved.stale.some((target) => target.path === contextFile)) return null;
  const result = files.find((file) => file.path === contextFile);
  // An unsuccessful edit cannot activate a new entry or remove a working one.
  if (wanted && (!result || result.status === 'blocked' || result.status === 'failed')) return null;
  const ready = result?.status === 'current' || result?.status === 'written' || (dryRun && result?.status === 'would-write');
  const delivered = await holdsInstructionBlocks(contextFile) || (dryRun && result?.status === 'would-write');
  // A same-named file of the member's: its entry, if any, is theirs too.
  if (!delivered && await pathExists(contextFile)) return null;
  // Old or malformed blocks the plan could not replace are not this sync's.
  const present = wanted && delivered && ready;
  const { config, entry } = opencodeContextReference(contextFile, localConfig.scope, resolveToolBaseDir('opencode', localConfig));
  // An entry goes only if teamai recorded adding it: one the member listed
  // before teamai wrote the file is theirs.
  if (!present) {
    const { loadStateForScope } = await import('./config.js');
    const recorded = (await loadStateForScope(localConfig)).opencodeContextEntries ?? [];
    if (!recorded.some((ref) => ref.config === config && ref.entry === entry)) return null;
  }
  if (dryRun) {
    const listed = (await readOpencodeInstructionList(config))?.includes(entry) ?? false;
    if (listed === present) return null;
    return `Would ${present ? 'add' : 'remove'} "${entry}" ${present ? 'to' : 'from'} the instructions of ${config}`;
  }
  const listed = await readOpencodeInstructionList(config);
  if (present && !listed?.includes(entry) && (listed !== null || !await pathExists(config))) {
    // Persist ownership before activation. If either write fails, retry can
    // safely finish without claiming an entry the member already listed.
    await recordOpencodeContextEntry(localConfig, { config, entry }, true);
  }
  const changed = await reconcileOpencodeInstructions(config, entry, present, 'team instructions');
  if (!present && ((await readOpencodeInstructionList(config))?.includes(entry) === false || !await pathExists(config))) {
    await recordOpencodeContextEntry(localConfig, { config, entry }, false);
  }
  return changed ? `${present ? 'Added' : 'Removed'} "${entry}" ${present ? 'to' : 'from'} the instructions of ${config}` : null;
}

/** Remember (`added`) or forget the OpenCode entry teamai wrote, for uninstall. */
async function recordOpencodeContextEntry(localConfig: LocalConfig, ref: { config: string; entry: string }, added: boolean): Promise<void> {
  const { loadStateForScope, saveStateForScope } = await import('./config.js');
  const state = await loadStateForScope(localConfig);
  const others = (state.opencodeContextEntries ?? []).filter((e) => e.config !== ref.config || e.entry !== ref.entry);
  state.opencodeContextEntries = added ? [...others, ref] : others;
  await saveStateForScope(state, localConfig);
}

// ─── Planning file contents ────────────────────────────

/** A file whose content a plan changes; `content: null` deletes it. */
export interface InstructionFileChange {
  path: string;
  content: string | null;
  /** `write` delivers blocks to a target; `cleanup` removes them from a file no tool loads them from. */
  kind: 'write' | 'cleanup';
}

export interface InstructionPlan {
  changes: InstructionFileChange[];
  warnings: string[];
  files: Array<{ path: string; status: 'current' | 'planned' | 'blocked' }>;
}

export interface InstructionFileResult {
  path: string;
  status: 'current' | 'written' | 'removed' | 'would-write' | 'would-remove' | 'blocked' | 'failed';
}

type BlockEdit = { content: string } | { malformed: true };

/**
 * Set (`block` a string) or remove (`block` null) one marker-delimited block.
 * A block whose markers are not exactly one start followed by one end is
 * malformed and left alone, so teamai never deletes text it cannot delimit.
 */
function editBlock(content: string, [start, end]: MarkerPair, block: string | null): BlockEdit {
  const starts = content.split(start).length - 1;
  const ends = content.split(end).length - 1;
  if (starts === 0 && ends === 0) {
    if (block === null) return { content };
    const kept = content.trimEnd();
    return { content: kept ? `${kept}\n\n${block}\n` : `${block}\n` };
  }
  const startIdx = content.indexOf(start);
  const endIdx = content.indexOf(end);
  if (starts !== 1 || ends !== 1 || endIdx < startIdx) return { malformed: true };
  const after = content.substring(endIdx + end.length);
  if (block !== null) return { content: content.substring(0, startIdx) + block + after };
  const before = content.substring(0, startIdx).replace(/\n+$/, '\n');
  // A block that opened the file leaves no blank line above what follows it.
  const rest = (before + after.replace(/^\n+/, before ? '\n' : '')).trimEnd();
  return { content: rest ? `${rest}\n` : '' };
}

function hasTeamaiBlock(content: string): boolean {
  return STALE_BLOCKS.some(([start, end]) => content.includes(start) || content.includes(end));
}

/**
 * Whether `file` holds teamai's blocks. A same-named file teamai did not write
 * is left as it is, so no tool should be told to load it.
 */
export async function holdsInstructionBlocks(file: string): Promise<boolean> {
  const content = await readFileSafe(file);
  return content !== null && hasTeamaiBlock(content);
}

function withoutHeader(content: string, header: string | undefined): string {
  return header && content.startsWith(header) ? content.substring(header.length) : content;
}

/**
 * Whether teamai created the file: it writes a new file starting with a block
 * (an older release with blank lines first), while a member's file starts
 * with their own text.
 */
function createdByTeamai(content: string): boolean {
  return content.trimStart().startsWith('<!-- [teamai:');
}

/**
 * Whether a file left with nothing but teamai's blocks may go. A file git
 * tracks stays, emptied, so the cleanup never deletes a project file; a file
 * whose state git cannot report stays too.
 */
async function mayDelete(file: string): Promise<boolean> {
  const tracked = await gitTracks(file);
  if (tracked.kind !== 'unknown') return tracked.kind === 'untracked';
  return (await gitTracking(file)).kind === 'outside-repo';
}

async function planFile(
  target: InstructionTarget,
  edits: ReadonlyArray<readonly [MarkerPair, string | null]>,
  kind: InstructionFileChange['kind'],
  warnings: string[],
): Promise<InstructionFileChange | null> {
  const existing = await readFileSafe(target.path);
  if (existing !== null && target.owned && !hasTeamaiBlock(existing) && existing !== (target.header ?? '')) {
    warnings.push(`${target.path} was not written by teamai, so teamai left it unchanged. Move or rename it so teamai can deliver the team instructions there.`);
    return null;
  }
  let content = existing ?? target.header ?? '';
  for (const [pair, block] of edits) {
    const edited = editBlock(content, pair, block);
    if ('malformed' in edited) {
      warnings.push(`${target.path} has an incomplete teamai ${pair[2]} block, so teamai left it unchanged. Fix or remove its ${pair[2]} markers by hand.`);
      return null;
    }
    content = edited.content;
  }
  // teamai's own rule file needs its header to be loaded at all: put it back
  // if it was lost or edited, replacing any other frontmatter.
  if (target.owned && target.header && hasTeamaiBlock(content) && !content.startsWith(target.header)) {
    content = target.header + content.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/^\n*/, '\n');
  }
  if (content === (existing ?? target.header ?? '')) return null;

  const remainder = withoutHeader(content, target.header).trim();
  if (remainder === '') {
    if (existing === null) return null;
    if (target.owned || (createdByTeamai(existing) && await mayDelete(target.path))) return { path: target.path, content: null, kind };
    return { path: target.path, content: '', kind };
  }
  return { path: target.path, content, kind };
}

/** Every header a target writes, so a file teamai created can be recognised later. */
const KNOWN_HEADERS = [ALWAYS_APPLY];

/**
 * Remove teamai instruction blocks from `file` (those whose start marker is in
 * `starts`, or all of them), as uninstall does. A
 * `teamai-context` file is teamai's own and goes once its blocks are gone;
 * another file goes only if nothing else was in it and git does not track it.
 * Returns warnings about blocks it could not delimit.
 */
export async function clearInstructionFile(
  file: string,
  starts?: readonly string[],
  /** Whether the file is teamai's generated one; by default, judged by its name. */
  owned = path.basename(file).startsWith(`${TEAMAI_CONTEXT_RULE_NAME}.`),
): Promise<{ changed: boolean; warnings: string[] }> {
  const existing = await readFileSafe(file);
  if (existing === null) return { changed: false, warnings: [] };
  const target: InstructionTarget = {
    path: file,
    tools: [],
    recall: false,
    header: KNOWN_HEADERS.find((header) => existing.startsWith(header)),
    owned,
  };
  const blocks = starts === undefined ? STALE_BLOCKS : STALE_BLOCKS.filter(([start]) => starts.includes(start));
  const warnings: string[] = [];
  const change = await planFile(target, blocks.map((pair) => [pair, null] as const), 'cleanup', warnings);
  const plan: InstructionPlan = {
    changes: change ? [change] : [], warnings,
    files: [{ path: file, status: warnings.length > 0 ? 'blocked' : change ? 'planned' : 'current' }],
  };
  const { failures } = await applyInstructionPlan(plan, { dryRun: false });
  if (failures.length > 0) throw new Error(failures.join(' '));
  return { changed: plan.changes.length > 0, warnings: plan.warnings };
}

/**
 * Work out every change that delivers `blocks` to `targets` and strips teamai
 * blocks from `stale` files, without writing anything.
 */
export async function planInstructionFiles(
  targets: readonly InstructionTarget[],
  blocks: InstructionBlocks,
  stale: readonly InstructionTarget[] = [],
  /** Only retire block types whose replacements were resolved and delivered. */
  retiredBlocks?: InstructionBlocks,
): Promise<InstructionPlan> {
  const warnings: string[] = [];
  const changes: InstructionFileChange[] = [];
  const files: InstructionPlan['files'] = [];
  for (const target of targets) {
    const edits: Array<readonly [MarkerPair, string | null]> = [];
    if (blocks.culture !== undefined) edits.push([CULTURE, blocks.culture]);
    if (blocks.claudemd !== undefined) edits.push([CLAUDEMD, blocks.claudemd]);
    const recall = target.recall ? blocks.recall : blocks.directRecall;
    if (recall !== undefined) edits.push([RECALL, recall]);
    const before = warnings.length;
    const change = await planFile(target, edits, 'write', warnings);
    if (change) changes.push(change);
    files.push({ path: target.path, status: warnings.length > before ? 'blocked' : change ? 'planned' : 'current' });
  }
  const cleanupBlocks = retiredBlocks === undefined ? STALE_BLOCKS : [
    ...retiredBlocks.culture !== undefined ? [CULTURE] : [],
    ...retiredBlocks.claudemd !== undefined ? [CLAUDEMD] : [],
    ...retiredBlocks.recall !== undefined && retiredBlocks.directRecall !== undefined ? [RECALL] : [],
    // Old combined rule blocks have no independently resolved replacement.
    ...retiredBlocks.culture !== undefined && retiredBlocks.claudemd !== undefined
      && retiredBlocks.recall !== undefined && retiredBlocks.directRecall !== undefined ? [LEGACY_RULES, TEAM_RULES] : [],
  ];
  for (const file of stale) {
    const before = warnings.length;
    const change = await planFile(file, cleanupBlocks.map((pair) => [pair, null] as const), 'cleanup', warnings);
    if (change) changes.push(change);
    files.push({ path: file.path, status: warnings.length > before ? 'blocked' : change ? 'planned' : 'current' });
  }
  return { changes, warnings, files };
}

/**
 * Write a plan, or with `dryRun` only describe it. Returns one line per file
 * changed (or that would change), and one actionable line per file that could
 * not be written; a failure leaves that file as it was and the others go on.
 */
export async function applyInstructionPlan(
  plan: InstructionPlan,
  options: { dryRun: boolean },
): Promise<{ report: string[]; failures: string[]; files: InstructionFileResult[] }> {
  const report: string[] = [];
  const failures: string[] = [];
  const files = new Map<string, InstructionFileResult>();
  for (const file of plan.files) {
    if (file.status !== 'planned') files.set(file.path, { ...file, status: file.status });
  }
  for (const { path: file, content, kind } of plan.changes) {
    if (!options.dryRun) {
      try {
        if (content === null) await remove(file);
        else await writeFile(file, content);
      } catch (e) {
        failures.push(`Could not update ${file}: ${(e as Error).message}. Check that it is a writable file, then run teamai pull again.`);
        files.set(file, { path: file, status: 'failed' });
        continue;
      }
    }
    files.set(file, { path: file, status: options.dryRun
      ? content === null ? 'would-remove' : 'would-write'
      : content === null ? 'removed' : 'written' });
    report.push(kind === 'write'
      ? `${options.dryRun ? 'Would write' : 'Wrote'} teamai instruction blocks to ${file}`
      : `${options.dryRun ? 'Would remove' : 'Removed'} teamai instruction blocks from ${file}`);
  }
  return { report, failures, files: plan.files.map((file) => files.get(file.path)!) };
}
