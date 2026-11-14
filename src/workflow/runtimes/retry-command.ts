// What a step's failure tells the person to run next: retry the step, or resume or publish the run.

/** Step path `step` as one shell word: as it is when it holds no character a shell reads, else single-quoted. */
export function stepArgument(step: string): string {
  return /^[A-Za-z0-9_.-]+$/.test(step) ? step : `'${step.replaceAll("'", "'\\''")}'`;
}

/** The command that runs step `step` of run `run` again, which a shell runs as written. */
export function retryCommand({ run, step }: { run: string; step: string }): string {
  return `teamai workflow retry ${run} ${stepArgument(step)}`;
}

/** The two ways on for a run this machine stops driving: resume it here, or publish it for another machine to take. */
export function resumeOrPublish(run: string): string {
  return `here with: teamai workflow resume ${run}, or hand it to another machine with: teamai workflow publish ${run}`;
}

/** The failure codes of a step that a retry fixes as it is: the usage limit reset, or the runtime's daemon is back. */
const RETRIED_CODES: ReadonlySet<string> = new Set(['usage_limited', 'daemon_restarted']);

/**
 * The message of a step's failure, ending with `Then run:` and the retry command when a retry fixes its code, which is
 * the runtime's own. A runtime never spells the run or the step itself.
 */
export function withRetry({ code, message }: { code: string; message: string }, retry: { run: string; step: string }): string {
  return RETRIED_CODES.has(code) ? `${message.replace(/\.?\s*$/, '.')} Then run: ${retryCommand(retry)}` : message;
}
