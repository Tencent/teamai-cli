import type { InstancePlatform } from '@teamai/tool-core/instance';
import type { ResolvedToolInstance } from './tool-instances.js';
import { makeToolRegistry, type ResolvedTool } from '@teamai/tool-core/registry';
import type { McpFormat } from '@teamai/tool-core/definition';
import type { RuleFormatId } from '@teamai/tool-core/definition';
import type { SessionPlatformFacts } from '@teamai/tool-core/sessions/platform';
import { isSessionPlatform, SESSION_PLATFORM_FACTS, sessionPlatformFacts, type SessionPlatform } from './session-flow/adapters/platform-facts.js';
import type { JsonSyntax } from '@teamai/shared/json';
import { STEP_LAUNCH_ADAPTERS, TOOLS, type AgentToolId, type ToolId, type ShippedDescriptor } from './tools.js';
import { type FolderReach, type HookFormat, type InstallGate, type RunTimeVia } from '@teamai/tool-core/definition';

/**
 * The one reader of the tool tables (`TOOLS`): every lookup of a tool id goes through here, so a new kind of
 * tool reaches every reader by changing what the registry is built from (teamai/tool-registry).
 */
const REGISTRY = makeToolRegistry(TOOLS, () => instanceTable, hostsInstances);

/**
 * Whether `instance`, of a tool whose sessions `platform` holds, keeps its own there: the format carries another platform
 * id, in a store its home moves. A store in an XDG data home (OpenCode) moves only with a home that moves `XDG_DATA_HOME`;
 * otherwise the instance writes the tool's own store, and its sessions are credited to the tool it extends.
 */
function hostsInstances(platform: SessionPlatform, instance: ResolvedToolInstance): boolean {
  const facts: SessionPlatformFacts = SESSION_PLATFORM_FACTS[platform];

  if (!facts.instanceSessions) return false;

  return facts.store.in === 'tool-home' || instance.home?.env === 'XDG_DATA_HOME';
}

/** The instances of every team repo and member's directory loaded in this process, by name. */
let instanceTable: ReadonlyMap<string, ResolvedToolInstance> = new Map();

/**
 * Makes `instances` the instances every lookup of a tool name sees: the ones this process resolved from the team
 * repos and the member's directory it loaded (`tool-instances.ts`, the one writer).
 */
export function useToolInstances(instances: ReadonlyMap<string, ResolvedToolInstance>): void {
  instanceTable = instances;
}

/** The names of the instances this process knows, a member's own included. */
export function instanceNames(): string[] {
  return [...instanceTable.keys()];
}

/** The tool `name` names here: an instance, with the shipped tool it extends, or a shipped tool; undefined for neither. */
export const toolOf: (name: string) => ResolvedTool<ToolId, ResolvedToolInstance> | undefined = REGISTRY.toolOf;

/**
 * The shipped tool `name` runs as: the tool an instance extends, else `name` itself. A step's `tool` on the runtime
 * protocol and in its session may be an instance's name, while its tool home, sign-ins and logins are the shipped
 * tool's, so code that joins the two compares them through this.
 */
export function baseToolOf(name: string): string {
  return toolOf(name)?.base ?? name;
}

/** Whether `name` names a tool a workflow step runs, or an instance of one: its `launch` names a STEP_LAUNCH_ADAPTERS adapter. */
export function runsSteps(name: string): boolean {
  const base = toolOf(name)?.base;

  return base !== undefined && STEP_LAUNCH_ADAPTERS.some((adapter) => adapter === descriptorOf(base).launch);
}

/** The instance whose own session platform `platform` is, and the shipped platform its sessions keep the format of. */
export const instancePlatform: (platform: string) => { instance: ResolvedToolInstance; platform: SessionPlatform } | undefined = REGISTRY.instancePlatform;

/** Every built-in tool, in `TOOLS` order. */
export const TOOL_ORDER: readonly ToolId[] = REGISTRY.ids;

/** What teamai knows about `tool` (`TOOLS`), with each tool's literal facts. */
export type DescriptorOf<T extends ToolId> = (typeof TOOLS)[T];

export const descriptorOf: <T extends ToolId>(tool: T) => DescriptorOf<T> = REGISTRY.definitionOf;

export const isToolId: (value: string) => value is ToolId = REGISTRY.isToolId;

/** Whether releases before #1221 wrote `tool`'s hooks and MCP servers under its default home when the home moved (`Home.moves.defaultHomeLeftovers`). */
export function hasDefaultHomeLeftovers(tool: ToolId): boolean {
  const { home }: ShippedDescriptor = descriptorOf(tool);

  return home.moves?.defaultHomeLeftovers === true;
}

/** The env variables that move `tool`'s home (`Home.moves.by`): a tool's own, and `XDG_CONFIG_HOME` for an XDG home. `LOCALAPPDATA` is not one: it is where Windows keeps a home that did not move. */
export function homeVariables(tool: ToolId): readonly string[] {
  const { home }: ShippedDescriptor = descriptorOf(tool);

  return (home.moves?.by ?? []).flatMap((move): string[] => {
    switch (move.kind) {
      case 'env':
        return [move.name];
      case 'qoder-home':
        return ['QODER_CONFIG_DIR', 'QODER_CLI_HOME'];
      case 'qoder-cn-home':
        return ['QODERCN_CONFIG_DIR', 'QODERCN_CLI_HOME'];
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

/** Whether where `tool` takes skills follows each session's inputs (`ShippedDescriptor.skillsFollowSession`). */
export function skillsFollowSession(tool: string): boolean {
  if (!isToolId(tool)) return false;
  const descriptor: ShippedDescriptor = descriptorOf(tool);

  return descriptor.skillsFollowSession === true;
}

/** What says `tool` is installed beyond its configured paths, if anything (`InstallGate`). */
export function installGateOf(tool: ToolId): InstallGate | undefined {
  const descriptor: ShippedDescriptor = descriptorOf(tool);

  return descriptor.installedBy;
}

/** The session platforms teamai reads for `tool`, first the one its launched sessions write; an instance's own; none for a custom tool id. */
export const sessionPlatformsOf: (tool: string) => readonly (SessionPlatform | InstancePlatform)[] = REGISTRY.sessionPlatformsOf;

/** The tool whose `sessions` lists `platform`, or the instance whose own platform it is, if one does. */
export const sessionPlatformOwner: (platform: string) => string | undefined = REGISTRY.sessionPlatformOwner;

/** The session platform that holds `tool`'s sessions: the first its `sessions` lists, else `tool` when it names one; undefined for a tool teamai reads no sessions of. */
export function platformForTool(tool: string): string | undefined {
  return sessionPlatformsOf(tool)[0] ?? (isSessionPlatform(tool) ? tool : undefined);
}

/** The tools of `tools` teamai reads no sessions from, in their order: their sessions are never captured, published or judged. */
export function toolsWithoutSessions(tools: readonly string[]): string[] {
  return tools.filter((tool) => platformForTool(tool) === undefined);
}

/** The facts of `platform`: a shipped platform's, or for an instance's own, those of the platform whose format it keeps. */
export function platformFactsOf(platform: string): SessionPlatformFacts | undefined {
  const hosted = instancePlatform(platform);

  return sessionPlatformFacts(platform) ?? (hosted ? sessionPlatformFacts(hosted.platform) : undefined);
}

/** The tool whose sessions `platform` holds, the reverse of `platformForTool`. */
export function toolForPlatform(platform: string): string {
  return sessionPlatformOwner(platform) ?? platformFactsOf(platform)?.tool ?? platform;
}

const CUSTOM_TOOL = {
  rules: { user: { channel: 'dir', format: 'verbatim', reads: 'unknown' }, project: { channel: 'dir', format: 'verbatim', reads: 'unknown' } },
  blocks: { user: { channel: 'file', file: { in: 'claudemd' }, reads: 'unknown' }, project: { channel: 'file', file: { in: 'claudemd' }, reads: 'unknown' } },
  agents: { user: 'none', project: 'none' },
  mcp: { user: 'none', project: 'none' },
  // A custom tool with a configured `settings` file takes Claude-shaped hooks there, as it always has.
  hooks: {
    user: { channel: 'settings', format: 'claude', reads: 'unknown' },
    self: { channel: 'settings', format: 'claude', reads: 'unknown' },
    subagentStop: false,
    stopReply: false,
    shell: 'system',
    teamHooks: 'home',
    needsBundle: false,
  },
} as const satisfies Pick<ShippedDescriptor, 'rules' | 'blocks' | 'agents' | 'mcp' | 'hooks'>;

/** How `tool` reads a rule or agent folder's files (`FolderReach`): a custom tool, or one with no cell, gets `copy`. */
export function folderReachOf(tool: string): FolderReach {
  const descriptor: ShippedDescriptor | undefined = isToolId(tool) ? descriptorOf(tool) : undefined;

  return descriptor?.folderReach ?? { reach: 'copy' };
}

/** The channels of `tool`: its descriptor's, the descriptor of the tool an instance extends, or `CUSTOM_TOOL`'s for a custom tool id. */
export function channelsOf(tool: string): Pick<ShippedDescriptor, 'rules' | 'blocks' | 'agents' | 'mcp' | 'hooks'> {
  const resolved = toolOf(tool);

  return resolved ? descriptorOf(resolved.base) : CUSTOM_TOOL;
}

/**
 * The `settings.local.json` beside a tool's project hook settings, from the project root, when the tool
 * merges its hooks with theirs (Claude Code, CodeBuddy, Qoder): the member's own file in each checkout.
 */
export function selfLocalSettingsOf(tool: string): string | null {
  const self = channelsOf(tool).hooks.self;

  if (self === 'user' || self === 'none' || self === 'unknown' || self.reads === 'unknown') return null;

  return self.reads.find((read) => read.base === 'project' && read.path.endsWith('/settings.local.json'))?.path ?? null;
}

/** Whether teamai renders agents for `tool` in either scope (`AgentToolId`). */
export function isAgentToolId(tool: string): tool is AgentToolId {
  if (!isToolId(tool)) return false;
  const { agents }: ShippedDescriptor = descriptorOf(tool);

  return [agents.user, agents.project].some((channel) => channel !== 'none' && channel !== 'unknown');
}

/** The tool whose agent format `tool` takes: itself, or the tool an instance extends; undefined when teamai renders it no agents. */
export function agentFormatOf(tool: string): AgentToolId | undefined {
  const base = toolOf(tool)?.base;

  return base !== undefined && isAgentToolId(base) ? base : undefined;
}

/** Every tool teamai renders agents for, in `TOOLS` order. */
export const AGENT_TOOLS: readonly AgentToolId[] = TOOL_ORDER.filter(isAgentToolId);

/** The format `tool`'s rule files take in either scope: its rules format, or the team `.md` verbatim. */
export function ruleFormatIdOf(tool: string): RuleFormatId | 'verbatim' {
  const { rules } = channelsOf(tool);

  for (const channel of [rules.user, rules.project]) {
    if (channel instanceof Object && channel.channel === 'dir') return channel.format;
  }

  return 'verbatim';
}

/** How a project's team rules reach `tool` at run time, if they do. */
export function runTimeRulesOf(tool: string): RunTimeVia | null {
  const { project } = channelsOf(tool).rules;

  if (!(project instanceof Object)) return null;

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

  for (const channel of [hooks.user, hooks.self]) if (channel instanceof Object && channel.channel === 'settings') return channel.format;

  return null;
}

/** How `tool` parses its hook settings file: the syntax of its settings channel, else strict JSON. */
export function hookSyntaxOf(tool: string): JsonSyntax {
  const { hooks } = channelsOf(tool);

  for (const channel of [hooks.user, hooks.self]) if (channel instanceof Object && channel.channel === 'settings') return channel.syntax ?? 'json';

  return 'json';
}

/** How `tool` parses its MCP file in `scope`: that channel's syntax, else strict JSON. */
export function mcpSyntaxOf(tool: string, scope: 'user' | 'project'): JsonSyntax {
  const channel = channelsOf(tool).mcp[scope];

  return channel instanceof Object ? channel.syntax ?? 'json' : 'json';
}

/** The shape teamai reads and writes `tool`'s hook file in: its settings format, else Claude's, which the DeepSeek Harness adapter writes and an earlier release wrote for a tool that reads none. */
export function hookFormatOf(tool: string): HookFormat {
  return hookSettingsFormatOf(tool) ?? 'claude';
}

/** The format `tool`'s MCP servers take in either scope; null when it has an MCP channel in neither. */
export function mcpFormatOf(tool: string): McpFormat | null {
  const { mcp } = channelsOf(tool);

  for (const channel of [mcp.user, mcp.project]) if (channel instanceof Object) return channel.format;

  return null;
}

/** Tools whose own model settings teamai adds delivered models to (`receivesDeliveredModels`). */
export type DeliveredModelTool = { [T in ToolId]: DescriptorOf<T> extends { readonly receivesDeliveredModels: true } ? T : never }[ToolId];

function receivesDeliveredModels(tool: ToolId): tool is DeliveredModelTool {
  return 'receivesDeliveredModels' in descriptorOf(tool);
}

export const DELIVERED_MODEL_TOOLS: readonly DeliveredModelTool[] = TOOL_ORDER.filter(receivesDeliveredModels);

/**
 * The scope `tool` takes an MCP server in when the install is `scope`. A tool
 * whose descriptor names no project MCP file writes its user config instead of
 * skipping the server, as its skills already land in the one place it reads
 * (OpenClaw's workspace, Hermes' and DSH's home). A tool with neither channel
 * keeps `scope`: it is skipped either way.
 */
export function mcpScopeFor(tool: string, scope: 'user' | 'project'): 'user' | 'project' {
  const { mcp } = channelsOf(tool);

  if (scope === 'project' && (mcp.project === 'none' || mcp.project === 'unknown') && mcp.user instanceof Object) return 'user';

  return scope;
}
