/** Checked by `tsc` only: Vitest runs `*.test.ts`. */
import type {
  AgentToolId, BlocksTarget, HomeRead, InlineRulesWithoutBlocksFile, RunTime, ToolDescriptor, ToolsWithTwoMcpFormats,
} from '../tools.js';
import type { LaunchedToolId, LaunchOrderTool } from '../tool-launch/tools.js';

declare const full: ToolDescriptor;
declare const withoutMcp: Omit<ToolDescriptor, 'mcp'>;

// @ts-expect-error every tool states its MCP channel
export const noMcp: ToolDescriptor = withoutMcp;

// @ts-expect-error both scopes are stated, 'none' or 'unknown' included
export const oneScope: ToolDescriptor = { ...full, agents: { user: 'none' } };

// @ts-expect-error a run-time channel names the probe that says it is installed
export const unprobed: RunTime = { channel: 'session-hook', evidence: 'source' };

// @ts-expect-error an MCP channel names its format
export const unformatted: ToolDescriptor = { ...full, mcp: { user: { reads: 'unknown' }, project: 'none' } };

// @ts-expect-error agents carry no format: the tool id is the renderer
export const borrowed: ToolDescriptor = { ...full, agents: { user: { format: 'claude', reads: 'unknown' }, project: 'none' } };

export const projectReadInUserScope: BlocksTarget<HomeRead> = {
  channel: 'file',
  file: { in: 'claudemd' },
  // @ts-expect-error a user-scope blocks file is read under $HOME only
  reads: [{ base: 'project', path: 'x', when: 'cwdOnly', evidence: 'docs' }],
};

/** Every tool with inline user rules has a user blocks file to hold them, and each tool has one MCP format. */
export const invariants: [InlineRulesWithoutBlocksFile, ToolsWithTwoMcpFormats] extends [never, never] ? true : false = true;

// @ts-expect-error Pi has no agents channel in either scope, so renderForTool never takes it
export const pi: AgentToolId = 'pi';

declare const withoutSessions: Omit<ToolDescriptor, 'sessions'>;

// @ts-expect-error every tool states the session platforms teamai reads, 'none' or 'unknown'
export const noSessions: ToolDescriptor = withoutSessions;

// @ts-expect-error a listed platform has a store teamai resolves; the CodeBuddy IDE's is found by its adapter
export const ideStore: ToolDescriptor = { ...full, sessions: ['codebuddy-ide'] };

// @ts-expect-error a tool with no session platform says 'none' or 'unknown'
export const emptySessions: ToolDescriptor = { ...full, sessions: [] };

declare const withoutHooks: Omit<ToolDescriptor, 'hooks'>;

// @ts-expect-error every tool states its hook channel, so none falls back to Claude-shaped hooks
export const noHooks: ToolDescriptor = withoutHooks;

// @ts-expect-error a settings channel names the shape of its hook list
export const shapeless: ToolDescriptor = { ...full, hooks: { user: { channel: 'settings', reads: 'unknown' }, self: 'user' } };

// @ts-expect-error an adapter writes in the tool's home: self mode takes it from the user scope ('user')
export const projectAdapter: ToolDescriptor = { ...full, hooks: { user: 'none', self: { channel: 'adapter', adapter: 'pi-extension', evidence: 'verified' } } };

export const projectHookReadInUserScope: ToolDescriptor = {
  ...full,
  hooks: {
    // @ts-expect-error a user-scope hook file is read under $HOME only
    user: { channel: 'settings', format: 'claude', reads: [{ base: 'project', path: 'x', when: 'cwdOnly', evidence: 'docs' }] },
    self: 'user',
  },
};

declare const withoutFeatures: Omit<ToolDescriptor, 'features'>;

// @ts-expect-error every tool states its run-time and AI rows, '?' included
export const noFeatures: ToolDescriptor = withoutFeatures;

// @ts-expect-error a cell carries its evidence after the mark
export const bareMark: ToolDescriptor = { ...full, features: { ...full.features, env: '✓' } };

declare const withoutLaunch: Omit<ToolDescriptor, 'launch'>;

// @ts-expect-error every tool states the adapter teamai launches it with, or 'none'
export const noLaunch: ToolDescriptor = withoutLaunch;

// @ts-expect-error a tool launches through an adapter teamai has
export const unknownAdapter: ToolDescriptor = { ...full, launch: 'gemini' };

/** LAUNCH_ORDER lists every tool whose `launch` names an adapter, so none is left out of the call order. */
export const launchOrderCoversLaunchedTools: [Exclude<LaunchedToolId, LaunchOrderTool>] extends [never] ? true : false = true;
