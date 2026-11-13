/** Checked by `tsc` only: Vitest runs `*.test.ts`. */
import type { AgentToolId, InlineRulesWithoutBlocksFile, ToolsWithTwoMcpFormats, ShippedDescriptor, STEP_LAUNCH_ADAPTERS } from '../tools.js';
import type { BlocksTarget, HomeRead, RunTime } from '@teamai/tool-core/definition';
import type { LaunchedToolId, LaunchOrderTool } from '../tool-launch/tools.js';
import type { LAUNCH_ADAPTERS, LaunchAdapterId } from '../tool-launch/adapters.js';
import type { StepLaunch } from '@teamai/tool-core/launch';

declare const full: ShippedDescriptor;
declare const withoutMcp: Omit<ShippedDescriptor, 'mcp'>;

// @ts-expect-error every tool states its MCP channel
export const noMcp: ShippedDescriptor = withoutMcp;

// @ts-expect-error both scopes are stated, 'none' or 'unknown' included
export const oneScope: ShippedDescriptor = { ...full, agents: { user: 'none' } };

// @ts-expect-error a run-time channel names the probe that says it is installed
export const unprobed: RunTime = { channel: 'session-hook', evidence: 'source' };

// @ts-expect-error an MCP channel names its format
export const unformatted: ShippedDescriptor = { ...full, mcp: { user: { reads: 'unknown' }, project: 'none' } };

// @ts-expect-error agents carry no format: the tool id is the renderer
export const borrowed: ShippedDescriptor = { ...full, agents: { user: { format: 'claude', reads: 'unknown' }, project: 'none' } };

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

declare const withoutSessions: Omit<ShippedDescriptor, 'sessions'>;

// @ts-expect-error every tool states the session platforms teamai reads, 'none' or 'unknown'
export const noSessions: ShippedDescriptor = withoutSessions;

// @ts-expect-error a listed platform has a store teamai resolves; the CodeBuddy IDE's is found by its adapter
export const ideStore: ShippedDescriptor = { ...full, sessions: ['codebuddy-ide'] };

// @ts-expect-error a tool with no session platform says 'none' or 'unknown'
export const emptySessions: ShippedDescriptor = { ...full, sessions: [] };

declare const withoutHooks: Omit<ShippedDescriptor, 'hooks'>;

// @ts-expect-error every tool states its hook channel, so none falls back to Claude-shaped hooks
export const noHooks: ShippedDescriptor = withoutHooks;

// @ts-expect-error a settings channel names the shape of its hook list
export const shapeless: ShippedDescriptor = { ...full, hooks: { ...full.hooks, user: { channel: 'settings', reads: 'unknown' }, self: 'user' } };

// @ts-expect-error an adapter writes in the tool's home: self mode takes it from the user scope ('user')
export const projectAdapter: ShippedDescriptor = { ...full, hooks: { ...full.hooks, user: 'none', self: { channel: 'adapter', adapter: 'pi-extension', evidence: 'verified' } } };

export const projectHookReadInUserScope: ShippedDescriptor = {
  ...full,
  hooks: {
    ...full.hooks,
    // @ts-expect-error a user-scope hook file is read under $HOME only
    user: { channel: 'settings', format: 'claude', reads: [{ base: 'project', path: 'x', when: 'cwdOnly', evidence: 'docs' }] },
    self: 'user',
  },
};

declare const hooksWithoutStopReply: Omit<ShippedDescriptor['hooks'], 'stopReply'>;

// @ts-expect-error every tool states whether its Stop hook takes the reply, so a new one is decided, not left out of a list
export const noStopReply: ShippedDescriptor = { ...full, hooks: hooksWithoutStopReply };

declare const withoutAutoCompact: Omit<ShippedDescriptor, 'autoCompact'>;

// @ts-expect-error every tool states the format teamai writes its auto-compact threshold in, or 'none'
export const noAutoCompact: ShippedDescriptor = withoutAutoCompact;

declare const withoutFeatures: Omit<ShippedDescriptor, 'features'>;

// @ts-expect-error every tool states its run-time and AI rows, '?' included
export const noFeatures: ShippedDescriptor = withoutFeatures;

// @ts-expect-error a cell carries its evidence after the mark
export const bareMark: ShippedDescriptor = { ...full, features: { ...full.features, env: '✓' } };

declare const withoutLaunch: Omit<ShippedDescriptor, 'launch'>;

// @ts-expect-error every tool states the adapter teamai launches it with, or 'none'
export const noLaunch: ShippedDescriptor = withoutLaunch;

// @ts-expect-error a tool launches through an adapter teamai has
export const unknownAdapter: ShippedDescriptor = { ...full, launch: 'gemini' };

/** LAUNCH_ORDER lists every tool whose `launch` names an adapter, so none is left out of the call order. */
export const launchOrderCoversLaunchedTools: [Exclude<LaunchedToolId, LaunchOrderTool>] extends [never] ? true : false = true;

type StepAdapter = { [K in LaunchAdapterId]: (typeof LAUNCH_ADAPTERS)[K] extends { readonly step: StepLaunch } ? K : never }[LaunchAdapterId];
type ListedStepAdapter = (typeof STEP_LAUNCH_ADAPTERS)[number];

/** STEP_LAUNCH_ADAPTERS names exactly the adapters that build a step, so a record's tool is one a step runs. */
export const stepAdaptersListed: [Exclude<StepAdapter, ListedStepAdapter>, Exclude<ListedStepAdapter, StepAdapter>] extends [never, never] ? true : false = true;
