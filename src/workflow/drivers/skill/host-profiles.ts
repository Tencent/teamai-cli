/** The host question the agent answers once per run with prompt steps, and what the skill driver declares on every `next`. */
import type { DriverCan } from '../../requirements.js';

export const HOST_CHOICES = ['h1', 'h2'] as const;
export type HostChoice = typeof HOST_CHOICES[number];

export interface HostProfile {
  label: string;
  /** `parallel`: as many children at once as the run's `--parallel`. `serial`: one. */
  children: 'parallel' | 'serial';
}

export const HOST_PROFILES: Record<HostChoice, HostProfile> = {
  h1: { label: 'Children that work in a directory TeamAI names, several at once', children: 'parallel' },
  h2: { label: 'Children that work in a directory TeamAI names, one at a time', children: 'serial' },
};

export const HOST_QUESTION = 'Pick how your host runs a child agent, the most specialized way it has: app orchestration tools, then team agents, then native subagents.';

/** What the skill driver declares on `score --next`: the confined judge of the session tool, which describe found verified. */
export function judgeCan(tool: string): { isolation: 'verified'; tools: [string] } {
  return { isolation: 'verified', tools: [tool] };
}

/**
 * What the skill driver declares on every `next`, whichever host answered. Every `CanSchema` key is decided here, so a
 * new key fails to compile until it is. A person answers gates through the agent or in their own terminal; a run with
 * an interactive step never starts on this driver (R8). No host meters a child's tokens or turns to the CLI, and teamai
 * scopes team env only in the processes it starts, so prompt steps get none.
 */
export const SKILL_CAN: Required<DriverCan> = {
  hitl: true, workspace: ['read-only', 'new', 'continue'], network: false, isolation: 'none', env: 'commands', tokens: false, max_turns: false, setup: true,
};
