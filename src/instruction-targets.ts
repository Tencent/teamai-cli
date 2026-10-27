import path from 'node:path';
import { hookSourceMatches } from './utils/hook-source.js';
import { getsRulesFromExtension } from './resources/rule-format.js';
import { pathExists, readFileSafe, readJsonObject, remove, writeFile } from './utils/fs.js';
import { getUserHome } from './utils/home.js';
import { CODEX_TOOL_IDS } from './utils/tool-names.js';
import { channelsOf, TOOLS, type BlocksHeader, type ChannelProbe, type RunTime } from './tools.js';
import { hookAdapterDir, installOf, locate, ownOf, writable, type FilePlace, type Gate, type Install } from './locate.js';
import {
  opencodeContextReference, opencodeV1ClaudeFile, readOpencodeInstructionList, reconcileOpencodeInstructions,
} from './resources/opencode-config.js';
import { gitUntracked } from './git-exclude.js';
import { TEAMAI_CONTEXT_RULE_NAME } from './builtin-rules.js';
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

/**
 * The frontmatter teamai writes above its blocks when it creates an owned
 * file. Cursor applies an `.mdc` rule in every session only with
 * `alwaysApply`, which CodeBuddy and WorkBuddy read too; Copilot inlines a
 * `.github/instructions` file in every request only for the `**` glob (#915).
 */
const HEADERS: { readonly [H in BlocksHeader]: string } = {
  'always-apply': '---\nalwaysApply: true\n---\n',
  'apply-to-all': '---\napplyTo: "**"\n---\n',
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

/**
 * Whether `tool` has the `teamai-recall` subagent in this scope, which decides
 * the recall block it gets: teamai writes it agents there, and every surface
 * of the tool reads them.
 */
async function hasRecallAgent(tool: string, install: Install): Promise<boolean> {
  const blocks = channelsOf(tool).blocks[install.scope];
  if (typeof blocks === 'object' && blocks.channel === 'file' && blocks.noRecallAgent === true) return false;
  return ownOf(await locate(tool, 'agents', install)) !== null;
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
  /** What says the hook, extension or plugin is installed (`channelReadiness`). */
  probe: ChannelProbe;
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
  /**
   * Claude's user file when OpenCode V1 reads the blocks from it, so OpenCode's
   * own file, written for V2's plugin, is not listed in its `instructions`.
   */
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

/** Whether `tool` gets this scope's blocks from teamai's session hook or extension rather than a file. */
export function deliversInstructionsByHook(tool: string, scope: Scope): boolean {
  return runTimeBlocksOf(tool, scope) !== null;
}

function runTimeBlocksOf(tool: string, scope: Scope): RunTime | null {
  const channel = channelsOf(tool).blocks[scope];
  return typeof channel === 'object' && channel.channel !== 'file' ? channel : null;
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
  return instructionHookText(blocks, await hasRecallAgent(tool, installOf(teamConfig, localConfig)));
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
 * Whether the hook, extension or plugin `probe` names is installed where
 * `tool` runs it, as this build writes it, and if not, what to do. The probe
 * comes from the tool's run-time channel (`locate`); every probe has its own
 * check, so a new one fails the type check until it has one.
 */
export async function channelReadiness(
  tool: string,
  probe: ChannelProbe,
  context?: { teamConfig: TeamaiConfig; localConfig: LocalConfig },
): Promise<{ ready: boolean; fix: string }> {
  const rerun = 'Run `teamai hooks inject` to reinstall it; `teamai hooks remove` takes it away.';
  switch (probe) {
    case 'omp-extension':
    case 'pi-extension': {
      const { buildOmpExtensionSource, OMP_HOOK_FILE } = await import('./omp-hooks.js');
      const { buildPiExtensionSource, PI_HOOK_FILE } = await import('./pi-hooks.js');
      const omp = probe === 'omp-extension';
      const file = omp ? path.join(hookAdapterDir('omp-extension'), OMP_HOOK_FILE) : path.join(hookAdapterDir('pi-extension'), PI_HOOK_FILE);
      const expected = omp ? buildOmpExtensionSource() : buildPiExtensionSource();
      return {
        ready: await hookSourceMatches(await readFileSafe(file), expected),
        // Pi's extension also carries a project's team rules (#946); OMP reads its own rules files.
        fix: `${file} is missing or out of date, so ${tool} sessions in this project get no team instructions`
          + `${getsRulesFromExtension(tool) ? ' or rules' : ''}. ${rerun}`,
      };
    }
    case 'hermes-plugin': {
      const {
        buildInstructionsPlugin, foreignInstructionsPlugin, getInstructionsPluginDir, HERMES_INSTRUCTIONS_PLUGIN, ownsInstructionsPlugin,
      } = await import('./hermes-hooks.js');
      const { getHermesConfigPath, isHermesPluginEnabled } = await import('./hermes-config.js');
      if (!await ownsInstructionsPlugin()) return { ready: false, fix: foreignInstructionsPlugin() };
      const dir = getInstructionsPluginDir();
      const plugin = buildInstructionsPlugin();
      const installed = await hookSourceMatches(await readFileSafe(path.join(dir, '__init__.py')), plugin.init)
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
    case 'codex-hooks': {
      const file = hooksFileOf(tool, context);
      return {
        ready: file !== undefined && await hooksInstalled(file, tool),
        fix: `${file ?? `${tool}'s hooks file`} is missing or out of date, so ${tool} sessions get no team instructions. ${rerun}`,
      };
    }
    case 'muse-session-start': {
      const file = hooksFileOf(tool, context);
      return {
        ready: file !== undefined && await hooksInstalled(file, tool),
        fix: `${file ?? `${tool}'s hooks file`} registers no current teamai SessionStart hook, so Muse Code sessions in this project `
          + `get none of the team rules or instructions. ${rerun}`,
      };
    }
    case 'zcode-session-start': {
      const file = hooksFileOf(tool, context);
      if (file === undefined || !await hooksInstalled(file, tool)) {
        return {
          ready: false,
          fix: `${file ?? `${tool}'s hooks file`} registers no current teamai SessionStart hook, so ZCode sessions in this project `
            + `get none of the team rules or instructions. ${rerun}`,
        };
      }
      const read = await readJsonObject(file);
      const hooks = read.kind === 'ok' ? read.value.hooks : undefined;
      return {
        ready: typeof hooks === 'object' && hooks !== null && 'enabled' in hooks && hooks.enabled === true,
        fix: `${file} sets hooks.enabled to something other than true, so ZCode runs none of the hooks it registers, and sessions `
          + 'in this project get none of the team rules or instructions. Run `teamai hooks inject`, which turns them on.',
      };
    }
    case 'dsh-session-start': {
      const { isDshHooksMounted, resolveDshHomePatchPath, resolveDshHookConfigPath } = await import('./dsh-hooks.js');
      const configPath = resolveDshHookConfigPath();
      const broken = [
        ...await isDshHooksMounted(configPath) ? [] : [resolveDshHomePatchPath()],
        ...await hooksInstalled(configPath, tool) ? [] : [configPath],
      ];
      return {
        ready: broken.length === 0,
        fix: `${broken.join(' and ')} ${broken.length === 1 ? 'is' : 'are'} missing or out of date, so DeepSeek Harness sessions in this `
          + `project get none of the team rules or instructions. ${rerun}`,
      };
    }
    default: {
      const unhandled: never = probe;
      return unhandled;
    }
  }
}

/** The hooks file teamai writes `tool`'s hooks to for this member, user-level for a project that is not the team repo. */
function hooksFileOf(tool: string, context: { teamConfig: TeamaiConfig; localConfig: LocalConfig } | undefined): string | undefined {
  if (context === undefined) return undefined;
  const hookScope = resolveHookScope(context.localConfig);
  const settings = scopedToolPaths(context.teamConfig, { ...context.localConfig, scope: hookScope.scope })[tool]?.settings;
  return settings === undefined ? undefined : path.resolve(hookScope.baseDir, settings);
}

async function hooksInstalled(file: string, tool: string): Promise<boolean> {
  const { getHookStatus } = await import('./hooks.js');
  return await getHookStatus(file, tool) === 'installed';
}

/**
 * Whether reconciling the hooks leaves `tool`'s channel ready. A dry run
 * writes nothing, so it previews the cleanup a real pull does once it has
 * installed the extension or plugin. A same-named file or plugin of the
 * member's, or a plugin the member disabled, keeps the channel closed.
 */
export async function instructionHookChannelInstallable(tool: string): Promise<boolean> {
  if (tool === 'omp' || tool === 'pi') {
    const { hasOmpHooks, OMP_HOOK_FILE } = await import('./omp-hooks.js');
    const { hasPiHooks, PI_HOOK_FILE } = await import('./pi-hooks.js');
    const file = tool === 'omp' ? path.join(hookAdapterDir('omp-extension'), OMP_HOOK_FILE) : path.join(hookAdapterDir('pi-extension'), PI_HOOK_FILE);
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
    const channel = await channelReadiness(hook.tool, hook.probe, { teamConfig, localConfig });
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

/**
 * What happened and what to do when `tool`'s config, which names its rules
 * file, cannot be read (OpenClaw's openclaw.json, the `readable-config` gate):
 * pull warns with it and doctor's fix says it.
 */
export async function unreadableRulesFileMessage(tool: string, gate: { readonly file: string }): Promise<string> {
  const read = await readJsonObject(gate.file);
  const why = read.kind === 'invalid' ? ` (${read.error})` : '';
  return `teamai cannot read ${gate.file} as plain JSON${why}, so it cannot tell which `
    + `workspace ${tool} reads: it writes no team-rules block, and ${tool} gets none of the team rules from teamai. `
    + 'Make that file plain JSON (no comments or trailing commas), then run `teamai pull`.';
}

/** The target teamai writes `place`'s blocks to, with the header and ownership `locate` gives it. */
export function instructionTargetOf(place: FilePlace, recall = false): InstructionTarget {
  return { path: place.path, tools: [], recall, header: place.header === null ? undefined : HEADERS[place.header], owned: place.owned || undefined };
}

/** Resolve where this scope's instruction blocks go, and which files to clean. */
export async function resolveInstructionTargets(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
): Promise<InstructionTargets> {
  const install = installOf(teamConfig, localConfig);
  const targets = new Map<string, InstructionTarget>();
  // Files an installed tool reads, excluded or not: an excluded tool's file is
  // left alone, not cleaned.
  const inUse = new Set<string>();
  const current = new Set<string>();
  const retired = new Map<string, InstructionTarget>();
  const hooks: InstructionHook[] = [];
  // A tool the team does not map still names the files earlier releases wrote its blocks to.
  for (const tool of new Set([...Object.keys(TOOLS), ...Object.keys(install.toolPaths)])) {
    const location = await locate(tool, 'blocks', install);
    // A retired file is cleaned as the member's: one git tracks stays, emptied.
    for (const { place } of location.retired) if (!retired.has(place.path)) retired.set(place.path, { path: place.path, tools: [], recall: false });
    if (install.toolPaths[tool] === undefined) continue;
    const own = ownOf(location);
    if (own !== null) current.add(own.path);
    if (isAgentExcluded(localConfig, tool)) {
      if (own !== null) inUse.add(own.path);
      for (const { place } of location.retired) inUse.add(place.path);
      continue;
    }
    if (!location.gates.every((gate) => gate.met)) continue;
    switch (location.channel) {
      case 'run-time':
        hooks.push({ tool, probe: location.probe, recall: await hasRecallAgent(tool, install), limit: location.limit ?? undefined });
        break;
      case 'files': {
        if (own === null) break;
        inUse.add(own.path);
        const target = targets.get(own.path) ?? instructionTargetOf(own);
        // The subagent block only where every tool reading the file has the subagent.
        target.recall = await hasRecallAgent(tool, install) && (target.tools.length === 0 || target.recall);
        target.tools.push(tool);
        targets.set(own.path, target);
        break;
      }
      case 'none':
      case 'unknown':
        break;
      default: {
        const unhandled: never = location;
        return unhandled;
      }
    }
  }
  const stale = [...retired.values()].filter((t) => !current.has(t.path) && !inUse.has(t.path));
  const opencode = [...targets.values()].find((target) => target.tools.includes('opencode'));
  if (install.scope !== 'user' || opencode === undefined) return { targets: [...targets.values()], hooks, stale, opencodeFallback: null, opencodeFallbackStale: false };
  // OpenCode V1 reads ~/.claude/CLAUDE.md while its own user AGENTS.md does
  // not exist; when Claude's blocks are there, listing OpenCode's file too
  // would duplicate them. That holds for blocks an excluded Claude left there
  // too: V1 reads them all the same. V2 reads neither CLAUDE.md nor
  // `instructions`, so OpenCode's file is still written for teamai's plugin.
  const claude = writable(await locate('claude', 'blocks', install));
  const claudeFile = opencodeV1ClaudeFile(getUserHome());
  const claudeDelivers = claude !== null && claude.path === claudeFile && targets.get(claudeFile)?.tools.includes('claude') === true;
  const claudeHolds = !claudeDelivers && await holdsInstructionBlocks(claudeFile);
  const opencodeFallback = (claudeDelivers || claudeHolds) && !await pathExists(path.join(path.dirname(opencode.path), 'AGENTS.md')) ? claudeFile : null;
  return { targets: [...targets.values()], hooks, stale, opencodeFallback, opencodeFallbackStale: opencodeFallback !== null && claudeHolds };
}

/** Retire a file only after every installed tool that wrote it has replacement delivery. */
export async function retiredFilesOfReached(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  reached: readonly string[],
): Promise<InstructionTarget[]> {
  const { stale } = await resolveInstructionTargets(teamConfig, localConfig);
  const install = installOf(teamConfig, localConfig);
  const writers = new Map<string, string[]>();
  for (const tool of Object.keys(install.toolPaths)) {
    const location = await locate(tool, 'blocks', install);
    // A tool installed where its hook runs, or in this checkout, excluded or
    // not, keeps the files it wrote until it is reached. Agents have no
    // run-time channel, so their location carries this scope's own gates.
    const installed = (gates: readonly Gate[]) => gates.every((gate) => gate.kind === 'selected' || gate.met);
    if (!installed(location.gates) && !installed((await locate(tool, 'agents', install)).gates)) continue;
    // A tool with no file and no hook channel here (OpenClaw in a project, #946)
    // has no replacement to wait for; a hook tool whose hook is not installed does.
    if (location.channel !== 'run-time' && ownOf(location) === null) continue;
    for (const { place } of location.retired) writers.set(place.path, [...writers.get(place.path) ?? [], tool]);
  }
  return stale.filter((target) => (writers.get(target.path) ?? []).every((tool) => reached.includes(tool)));
}

/**
 * List teamai's OpenCode instruction file in OpenCode's `instructions` while
 * it holds teamai's blocks, and drop the entry teamai recorded adding once the
 * file is gone: OpenCode reads no file it is not told about. A file without
 * teamai's blocks is the member's, and an entry teamai did not add stays. Beside
 * the Claude fallback the file is for V2 only and is not listed. Returns what
 * it did or, with `dryRun`, would do.
 */
export async function registerOpencodeContext(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  resolved: Pick<InstructionTargets, 'targets' | 'stale' | 'opencodeFallback'>,
  dryRun: boolean,
  files: readonly InstructionFileResult[],
): Promise<string | null> {
  if (teamConfig.toolPaths.opencode === undefined) return null;
  const location = await locate('opencode', 'blocks', installOf(teamConfig, localConfig));
  const contextFile = ownOf(location)?.path;
  if (contextFile === undefined || location.channel !== 'files') return null;
  // OpenCode V2 ignores the entry, and teamai's plugin reads the file (#915).
  const { opencodeDeliversThroughPlugin } = await import('./opencode-hooks.js');
  if (await opencodeDeliversThroughPlugin(teamConfig, localConfig)) return null;
  const targeted = resolved.targets.some((target) => target.path === contextFile);
  const wanted = targeted && !resolved.opencodeFallback;
  if (!targeted && !resolved.stale.some((target) => target.path === contextFile)) return null;
  const result = files.find((file) => file.path === contextFile);
  // An unsuccessful edit cannot activate a new entry or remove a working one.
  if (wanted && (!result || result.status === 'blocked' || result.status === 'failed')) return null;
  const ready = result?.status === 'current' || result?.status === 'written' || (dryRun && result?.status === 'would-write');
  const delivered = await holdsInstructionBlocks(contextFile) || (dryRun && result?.status === 'would-write');
  // A same-named file of the member's: its entry, if any, is theirs too.
  if (!delivered && await pathExists(contextFile)) return null;
  // Old or malformed blocks the plan could not replace are not this sync's.
  const present = wanted && delivered && ready;
  // Pull, doctor and uninstall read the entry from the config beside the file, whatever the team maps MCP to.
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

/** Whether a shared instruction file contains complete TeamAI blocks and no member text. */
export async function holdsOnlyInstructionBlocks(file: string): Promise<boolean> {
  let content = await readFileSafe(file);
  if (content === null || !hasTeamaiBlock(content)) return false;
  for (const pair of STALE_BLOCKS) {
    const edited = editBlock(content, pair, null);
    if ('malformed' in edited) return false;
    content = edited.content;
  }
  return content.trim() === '';
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
  return gitUntracked(file);
}

async function planFile(
  target: InstructionTarget,
  edits: ReadonlyArray<readonly [MarkerPair, string | null]>,
  kind: InstructionFileChange['kind'],
  warnings: string[],
): Promise<InstructionFileChange | null> {
  const existing = await readFileSafe(target.path);
  // A retired file teamai wrote with a header, such as its own Copilot file once sharing.gitExclude is off (#915).
  const header = target.header ?? (kind === 'cleanup' ? KNOWN_HEADERS.find((known) => existing?.startsWith(known)) : undefined);
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

  const remainder = withoutHeader(content, header).trim();
  if (remainder === '') {
    if (existing === null) return null;
    if (target.owned || (createdByTeamai(withoutHeader(existing, header)) && await mayDelete(target.path))) return { path: target.path, content: null, kind };
    return { path: target.path, content: '', kind };
  }
  return { path: target.path, content, kind };
}

/** Every header a target writes, so a file teamai created can be recognised later. */
const KNOWN_HEADERS = Object.values(HEADERS);

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
