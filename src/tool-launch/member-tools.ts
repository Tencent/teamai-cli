import path from 'node:path';
import { loadMemberSettings, ownMemberSettings } from '../config.js';
import { getDataHome, getUserConfigPath, installScopeName, type LocalConfig } from '../types.js';
import { expandHome } from '../utils/fs.js';

/** Where the member names the tool for teamai's AI work, the most specific first. */
export type MemberToolSource = 'TEAMAI_AI_TOOL' | 'ai.tool (project)' | 'ai.tool (machine)';

/** A tool the member names: where, and the setting a message tells them to change. */
export interface MemberTool {
  source: MemberToolSource;
  tool: string;
  setting: string;
}

/**
 * The tools the member names for `scope`, the most specific first: TEAMAI_AI_TOOL, then `ai.tool` in the scope's own
 * config, then in ~/.teamai/config.yaml. AI calls take the first; a workflow step puts its own settings between them.
 * Each names the level that sets it, so a message sends the member to the file that does.
 */
export async function memberTools(scope: LocalConfig | undefined): Promise<MemberTool[]> {
  const env = process.env.TEAMAI_AI_TOOL;
  // In user scope the scope's own config is this machine's, read as an install.
  const own = scope && scope.scope !== 'user' ? ownMemberSettings(scope).ai?.tool : undefined;
  const machine = scope?.scope === 'user' ? scope.ai?.tool : (await loadMemberSettings()).ai?.tool;

  return [
    ...(env ? [{ source: 'TEAMAI_AI_TOOL' as const, tool: env, setting: 'TEAMAI_AI_TOOL' }] : []),
    ...(scope && own ? [{ source: 'ai.tool (project)' as const, tool: own, setting: `ai.tool in the ${installScopeName(scope.scope)} config ${path.join(getDataHome(scope), 'config.yaml')}` }] : []),
    ...(machine ? [{ source: 'ai.tool (machine)' as const, tool: machine, setting: `ai.tool in the ${scope?.scope === 'user' ? 'user' : 'machine'} config ${expandHome(getUserConfigPath())}` }] : []),
  ];
}

/**
 * Why a call did not answer: no tool to run it, an override that names a tool teamai cannot run or sits in a scope
 * config here that cannot be read, a team instance's command no one accepted here, a recorded home of the tool that is
 * gone, or the tool failed.
 */
export type CallErrorKind = 'no_tool' | 'override_invalid' | 'tool_not_accepted' | 'home_gone' | 'call_failed';

export class CallError extends Error {
  constructor(readonly kind: CallErrorKind, message: string) {
    super(message);
    this.name = 'CallError';
  }
}

/**
 * Whether a call failed on the member's choice of tool: one teamai cannot run, or a scope config that cannot be read
 * to find it. A caller's fallback must not hide either.
 */
export function isOverrideInvalid(error: unknown): error is CallError & { kind: 'override_invalid' } {
  return error instanceof CallError && error.kind === 'override_invalid';
}
