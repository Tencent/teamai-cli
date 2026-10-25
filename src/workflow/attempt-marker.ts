import { AGENT_SESSION_ENV } from '../utils/session-id.js';

/**
 * The variable a skill driver's runner is started with, and passes to the command it runs: `<run>/<attempt>`. A
 * `workflow report` call that carries the marker of the attempt it reports is that attempt's runner.
 */
export const ATTEMPT_ENV = 'TEAMAI_WORKFLOW_ATTEMPT';

export function attemptEnv(run: string, attempt: string): Record<typeof ATTEMPT_ENV, string> {
  return { [ATTEMPT_ENV]: `${run}/${attempt}` };
}

/** Whether `env` marks its process as the runner of `attempt` of `run`. */
export function isAttemptRunner(env: NodeJS.ProcessEnv, run: string, attempt: string): boolean {
  return env[ATTEMPT_ENV] === `${run}/${attempt}`;
}

/** Why a process counts as an agent's: it runs inside a workflow attempt, or inside an agent session. */
export type AgentEvidence =
  | { kind: 'none' }
  | { kind: 'attempt'; attempt: string }
  | { kind: 'session'; variable: typeof AGENT_SESSION_ENV[number] };

/** The evidence `env` holds that an agent runs its process: the attempt marker, else the first agent session variable set. */
export function agentEvidence(env: NodeJS.ProcessEnv): AgentEvidence {
  const attempt = env[ATTEMPT_ENV];
  if (attempt) return { kind: 'attempt', attempt };
  const variable = AGENT_SESSION_ENV.find((name) => env[name]);
  return variable ? { kind: 'session', variable } : { kind: 'none' };
}
