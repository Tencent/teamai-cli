/** Checked by `tsc` only: Vitest runs `*.test.ts`. */
import type {
  AgentToolId, BlocksTarget, HomeRead, InlineRulesWithoutBlocksFile, RunTime, ToolDescriptor, ToolsWithTwoMcpFormats,
} from '../tools.js';

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

