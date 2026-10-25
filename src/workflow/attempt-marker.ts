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
