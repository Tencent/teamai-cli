/**
 * The session host question the agent answers once per run with prompt steps, and what the skill driver declares on every
 * `next`. The session host is the coding session that drives a run on `--driver skill`, with the app it runs in; it is
 * not the host command slot.
 */
import { confinedAccess, confinedToolLevel, isConfinedTool } from '../../confined-launch.js';
import type { ConfinedLevel } from '@teamai/tool-core/launch';
import type { DecidedCan, DriverCan } from '../../requirements.js';
import type { SkillState } from './skill-state.js';

/** The ids of the session host question's options, as a stored skill state and `--choice` spell them. */
export const SESSION_HOST_CHOICES = ['h1', 'h2', 'h3', 'h4'] as const;

export type SessionHostChoice = typeof SESSION_HOST_CHOICES[number];

/** How a session host runs a run's steps: its children, who makes their places, and what the driver declares for it. */
export interface SessionHostProfile {
  label: string;
  /** `parallel`: as many children at once as the run's `--parallel`. `serial`: one. */
  children: 'parallel' | 'serial';
  /**
   * `teamai`: TeamAI makes the worktree a step works in. `host`: the session host makes it, and TeamAI adopts it. The value
   * `host` names the session host; a stored skill state keeps that spelling.
   */
  places: 'teamai' | 'host';
  /** Whether the session host starts a child agent: one that works a step, or judges the run in a fresh context. */
  startsChildAgent: boolean;
  /**
   * What the driver declares on every `next` of a run this session host drives. Every `CanSchema` key is decided per profile, so
   * a new key fails to compile until each one is. A person answers gates through the agent or in their own terminal, and
   * works in an interactive step with the agent. No session host meters a child's tokens or turns to the CLI, and teamai scopes
   * team env only in the processes it starts, so prompt steps get none. A coding session never bypasses its person's
   * permissions, so no profile runs a prompt unattended. No session host promises that the child it starts loads what teamai
   * delivered for a step's role rather than the member's own resources, so no profile takes a step with a role. A profile
   * that names the directory a step works in takes a step in the team workspace: its command runs in the runner, and
   * its prompt in a child TeamAI places in the team clone.
   */
  can: DecidedCan;
}

export const SESSION_HOST_PROFILES: Record<SessionHostChoice, SessionHostProfile> = {
  h1: {
    label: 'Children that work in a directory TeamAI names, several at once', children: 'parallel', places: 'teamai', startsChildAgent: true,
    can: { hitl: true, exec: true, workspace: ['read-only', 'new', 'continue', 'team'], network: false, isolation: 'none', env: 'commands', tokens: false, max_turns: false, setup: true, tools: [], end_turn: false, unattended: false, role: false, confined: [] },
  },
  h2: {
    label: 'Children that work in a directory TeamAI names, one at a time', children: 'serial', places: 'teamai', startsChildAgent: true,
    can: { hitl: true, exec: true, workspace: ['read-only', 'new', 'continue', 'team'], network: false, isolation: 'none', env: 'commands', tokens: false, max_turns: false, setup: true, tools: [], end_turn: false, unattended: false, role: false, confined: [] },
  },
  h3: {
    label: 'Children that work in a worktree your session host makes for them, several at once', children: 'parallel', places: 'host', startsChildAgent: true,
    can: { hitl: true, exec: true, workspace: ['read-only', 'new', 'continue', 'team'], network: false, isolation: 'none', env: 'commands', tokens: false, max_turns: false, setup: true, tools: [], end_turn: false, unattended: false, role: false, confined: [] },
  },
  // The session works each step itself, beside its own checkout, so it takes no step in a worktree: those wait for the
  // person's terminal, where the local driver runs them.
  h4: {
    label: 'No child agent: you work each step yourself, one at a time', children: 'serial', places: 'teamai', startsChildAgent: false,
    can: { hitl: true, exec: true, workspace: ['read-only'], network: false, isolation: 'none', env: 'commands', tokens: false, max_turns: false, setup: true, tools: [], end_turn: false, unattended: false, role: false, confined: [] },
  },
};

export const SESSION_HOST_QUESTION = 'Pick how your session host runs a child agent, the most specialized way it has: app orchestration tools, then team agents, then native subagents, else none, and you work each step yourself.';

/** What the skill driver declares on every `next` of a run whose agent answered the session host question with `sessionHost`; a run without prompt steps declares h1's. */
export function canFor(sessionHost: SessionHostChoice | undefined): DecidedCan {
  return SESSION_HOST_PROFILES[sessionHost ?? 'h1'].can;
}

/** The tool the session judges the run with, while it does: the one it was driven from last, else the one it started in. */
export function sessionJudgeTool(state: Pick<SkillState, 'sessionJudge' | 'orchestrator'>): string | undefined {
  return state.sessionJudge && (state.orchestrator.tool ?? state.sessionJudge.tool);
}

/**
 * The confined runs the skill driver offers on `next`: the session tool's own at the level this machine judges the run
 * with it, which the background runner starts; else a fresh child in the run's tool at `best-effort` while the session
 * judges the run; else none, as after `--no-judge`, or once judging is off. A child reads its directory and nothing more.
 */
export function confinedCan(state: Pick<SkillState, 'judging' | 'sessionJudge' | 'orchestrator'>): NonNullable<DriverCan['confined']> {
  if (state.judging) {
    const { tool, level } = state.judging;

    return [{ level, access: isConfinedTool(tool) ? confinedAccess(tool) : 'full', tools: [tool] }];
  }

  const tool = sessionJudgeTool(state);

  return tool === undefined ? [] : [{ level: 'best-effort', access: 'read', tools: [tool] }];
}

/** A tool this machine runs confined, and the level it reaches here. */
export interface ConfinedJudge {
  tool: string;
  level: ConfinedLevel;
}

/**
 * The confined runs this driver offers a run the session's `tool` drives, as describe and resume judge it: the
 * background runner's at `verified` when that tool's confined judge verifies here, else a fresh child's in that tool at
 * `best-effort`; none when the session names no tool.
 */
export async function sessionOffers(tool: string | undefined): Promise<NonNullable<DriverCan['confined']>> {
  if (tool === undefined) return [];
  const judge = await sessionToolJudge(tool);

  return judge?.level === 'verified' && isConfinedTool(judge.tool)
    ? [{ level: 'verified', access: confinedAccess(judge.tool), tools: [judge.tool] }]
    : [{ level: 'best-effort', access: 'read', tools: [tool] }];
}

/** The confined judge of the session's `tool` on this machine: a tool teamai runs confined whose executable is on PATH. */
export async function sessionToolJudge(tool: string | undefined): Promise<ConfinedJudge | undefined> {
  if (tool === undefined || !isConfinedTool(tool)) return undefined;
  const probed = await confinedToolLevel(tool);

  return probed && { tool, level: probed.isolation };
}
