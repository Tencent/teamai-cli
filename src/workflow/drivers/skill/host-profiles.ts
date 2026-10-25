/** The host question the agent answers once per run with prompt steps, and what the skill driver declares on every `next`. */
import type { JudgeAccess } from '../../../scorers/label.js';
import { isJudgeTool, judgeAccess } from '../../../scorers/judge.js';
import type { DriverCan } from '../../requirements.js';

export const HOST_CHOICES = ['h1', 'h2', 'h3', 'h4'] as const;
export type HostChoice = typeof HOST_CHOICES[number];

export interface HostProfile {
  label: string;
  /** `parallel`: as many children at once as the run's `--parallel`. `serial`: one. */
  children: 'parallel' | 'serial';
  /** `teamai`: TeamAI makes the worktree a step works in. `host`: the host makes it, and TeamAI adopts it. */
  places: 'teamai' | 'host';
  /**
   * What the driver declares on every `next` of a run this host drives. Every `CanSchema` key is decided per profile, so
   * a new key fails to compile until each one is. A person answers gates through the agent or in their own terminal, and
   * works in an interactive step with the agent. No host meters a child's tokens or turns to the CLI, and teamai scopes
   * team env only in the processes it starts, so prompt steps get none.
   */
  can: Required<DriverCan>;
}

export const HOST_PROFILES: Record<HostChoice, HostProfile> = {
  h1: {
    label: 'Children that work in a directory TeamAI names, several at once', children: 'parallel', places: 'teamai',
    can: { hitl: true, workspace: ['read-only', 'new', 'continue'], network: false, isolation: 'none', env: 'commands', tokens: false, max_turns: false, setup: true },
  },
  h2: {
    label: 'Children that work in a directory TeamAI names, one at a time', children: 'serial', places: 'teamai',
    can: { hitl: true, workspace: ['read-only', 'new', 'continue'], network: false, isolation: 'none', env: 'commands', tokens: false, max_turns: false, setup: true },
  },
  h3: {
    label: 'Children that work in a worktree your host makes for them, several at once', children: 'parallel', places: 'host',
    can: { hitl: true, workspace: ['read-only', 'new', 'continue'], network: false, isolation: 'none', env: 'commands', tokens: false, max_turns: false, setup: true },
  },
  // The session works each step itself, beside its own checkout, so it takes no step in a worktree: those wait for the
  // person's terminal, where the local driver runs them.
  h4: {
    label: 'No child agent: you work each step yourself, one at a time', children: 'serial', places: 'teamai',
    can: { hitl: true, workspace: ['read-only'], network: false, isolation: 'none', env: 'commands', tokens: false, max_turns: false, setup: true },
  },
};

export const HOST_QUESTION = 'Pick how your host runs a child agent, the most specialized way it has: app orchestration tools, then team agents, then native subagents, else none, and you work each step yourself.';

/** What the skill driver declares on every `next` of a run whose host answered `host`; a run without prompt steps declares h1's. */
export function canFor(host: HostChoice | undefined): Required<DriverCan> {
  return HOST_PROFILES[host ?? 'h1'].can;
}

/**
 * What the skill driver declares on `score --next`: the confined judge of the session tool, which describe found
 * verified, and what that judge can do. A tool with no judge profile declares `full`, as a judge that does not say counts.
 */
export function judgeCan(tool: string): { isolation: 'verified'; access: JudgeAccess; tools: [string] } {
  return { isolation: 'verified', access: isJudgeTool(tool) ? judgeAccess(tool) : 'full', tools: [tool] };
}
