import { PromptResultSchema, type PromptRequestSchema } from '@teamai/runtime-protocol';
import { redact, redactJson } from '@teamai/shared/redact';
import { ASSUMED_OPENCODE_MAJOR, type StepLaunch } from '@teamai/tool-core/launch';
import { stepLaunchOf } from '@teamai/tool-definitions';
import { runStepLaunch, toolLauncher, type StepFamily, type StepLaunchHost, type StepLaunchInput, type StepLaunchResult, type StepStop, type ToolClosed } from '@teamai/tool-launch/run-step-launch';
import type { z } from 'zod';
import { boundedTail, STDERR_CHARS } from './bounded-tail.js';
import type { Outcome } from './journal.js';
import type { Provider } from './provider.js';
import type { LAUNCHABLE } from './providers/cli.js';

// ─── A prompt step's tool in the attempt's sandbox ──────
//
//  The runtime launches a prompt lease's tool itself, as teamai's own launch does, through @teamai/tool-launch: the
//  family builds the argv, and the launch meters the budget, keeps the timeout and the idle limit, and reads the result
//  file. Only the process port is this runtime's: the provider's exec in the attempt's sandbox. The library assumes it
//  runs where the tool runs, so this port gives it nothing of this machine:
//
//    env       the launch always gets the whole environment the lease gives, never this runtime's own
//    files     a bind provider mounts the place at its host paths; a copy provider copies the sandbox's work back
//              before the tool counts as ended, so the result file the launch reads is at its host path
//    platform  the sandbox runs on POSIX only (main.ts refuses Windows), where the argv is the same on either side
//    stdin     a step's tool gets none; an answer, the one launch that needs stdin, runs in teamai's process
//

type PromptRequest = z.infer<typeof PromptRequestSchema>;

/**
 * The family whose step the sandbox launches for each tool it ships, by its executable, or none: OpenCode's argv depends
 * on a version this runtime cannot read before the step, and teamai reads none of its sessions in a tool home.
 */
const STEP_FAMILY = { claude: 'claude', codex: 'codex', codebuddy: 'codebuddy', opencode: undefined } as const satisfies Record<(typeof LAUNCHABLE)[number], StepFamily | undefined>;

/**
 * The family and step profile of `tool`, a tool the sandbox ships (or one an instance extends); undefined for one whose
 * step it does not launch.
 */
export function stepToolOf(tool: string): { family: StepFamily; step: StepLaunch } | undefined {
  const family = Object.entries(STEP_FAMILY).find(([shipped]) => shipped === tool)?.[1];
  const step = family === undefined ? undefined : stepLaunchOf(family);

  return family === undefined || step === undefined ? undefined : { family, step };
}

/**
 * What the launch would read from this machine, which a step in a sandbox does not have: no OpenCode or agy step runs
 * here (STEP_FAMILY), and teamai writes the result the prompt finishes with (runtimePrompter), so the runtime writes none.
 */
const IN_SANDBOX: StepLaunchHost = {
  opencodeMajor: async () => ASSUMED_OPENCODE_MAJOR,
  agyGatewayEnv: () => ({}),
  writeResult: async () => {},
};

/**
 * The process port of a step's tool in sandbox `id`: the provider's exec, with the environment the launch gives and the
 * names `unset` withholds. Its stop stops every process in the sandbox, as a cancel's does, and the sandbox stays. It
 * calls `onStdout` only once `start` returned, so a budget stop finds its process. A stop the provider could not make
 * ends the tool's run failed with why, though it may still run there. `stderr` gives the end of what the tool printed
 * there, from its first whole line.
 */
export function sandboxProcess(provider: Provider, id: string, unset: string[]) {
  const stderr = boundedTail(STDERR_CHARS);
  let printed = 0;

  const start = toolLauncher(({ executable, args, cwd, env, onStart, onStdout }) => {
    let started = false;
    /** Settles with a stop that failed: the tool then still runs, and the launch ends on that rather than waiting for it. */
    let unstoppable: (closed: ToolClosed) => void = () => {};
    const stopFailed = new Promise<ToolClosed>((resolve) => { unstoppable = resolve; });

    const ran = (async (): Promise<ToolClosed> => {
      // After `start` returned: the launch holds the process before its first output.
      await Promise.resolve();
      started = true;
      onStart();
      let stdout = '';
      const given = Object.fromEntries(Object.entries(env).flatMap(([name, value]) => (value === undefined ? [] : [[name, value]])));

      const ended = await provider.exec(id, { argv: [executable, ...args], env: given, unset, cwd }, (stream, data) => {
        if (stream === 'stderr') {
          stderr.push(data);
          printed += data.length;

          return;
        }

        stdout += data;
        onStdout(data);
      });

      if (ended.kind === 'failed') return { failure: ended.failure };

      // A copy provider's work, the result file and the session among it, reaches its host paths only once copied back.
      if (provider.family === 'copy') {
        const collected = await provider.collect(id);

        if (!collected.ok) return { failure: collected.failure };
      }

      return { exitCode: ended.code, stdout };
    })();

    return {
      closed: Promise.race([ran, stopFailed]),
      started: () => started,
      // The launch stops the tool only at a limit of its step (its budget, timeout or idle limit). The port's stop never
      // rejects, so a stop the provider could not make ends the tool's run with why, naming what still runs.
      stop: async () => {
        const stopped = await provider.stop(id);

        if (!stopped.ok) unstoppable({ failure: { code: stopped.failure.code, message: `${executable} reached a limit of its step and could not be stopped: ${stopped.failure.message}` } });
      },
    };
  });

  // A tail that cut what the tool printed starts inside a line, maybe inside a credential no mask then matches: its
  // first line goes.
  const whole = (): string => {
    const tail = stderr.text();

    if (printed <= STDERR_CHARS) return tail;
    const newline = tail.indexOf('\n');

    return newline === -1 ? '' : tail.slice(newline + 1);
  };

  return { start, stderr: whole };
}

/**
 * The launch a headless prompt lease asks for: its whole prompt as the lease carries it, the result instruction in it,
 * with `env` as the tool's whole environment.
 */
function leaseInput(request: PromptRequest, env: Record<string, string>): StepLaunchInput {
  const { lease } = request;

  return {
    prompt: lease.prompt, expected: undefined, cwd: request.cwd, resultPath: lease.result, secrets: {}, env,
    ...(lease.model && { model: lease.model }),
    ...(lease.resume !== undefined && { resume: lease.resume }),
    ...(lease.maxTurns !== undefined && { maxTurns: lease.maxTurns }),
    ...(lease.permissions === 'unattended' && { unattended: true }),
  };
}

/**
 * A launch's result as the prompt's end, every text in it masked with `masks`: a tool that exited on its own with a
 * status that is not 0 failed, with what it said and the end of its stderr; one that exited 0, or that a limit stopped,
 * and named its session, finished, with whatever result it wrote, and resumed when that is the session `resume` named.
 */
/**
 * The limit of the lease a stop answers as `stopped`: a turn cap is the tool's own end, which the lease does not name.
 */
function stoppedAt(stop: StepStop | undefined): 'budget' | 'timeout' | undefined {
  switch (stop) {
    case 'budget':
    case 'timeout':
      return stop;
    case 'max_turns':
    case undefined:
      return undefined;
    default: {
      const unhandled: never = stop;

      return unhandled;
    }
  }
}

function outcomeOf({ tool, resume, ran, stderr, masks }: { tool: string; resume: string | undefined; ran: StepLaunchResult; stderr: string; masks: Record<string, string> }): Outcome {
  const masked = (text: string): string => redact(text, { envSecrets: masks, patterns: false });
  const failed = (failure: { code: string; message: string }): Outcome => ({ state: 'failed', failure: { code: failure.code, message: masked(failure.message) } });

  if (!ran.started) return failed(ran.failure);

  if (ran.exitCode !== 0 && ran.stoppedBy === undefined) {
    const failure = ran.failure ?? { code: 'tool_failed', message: `${tool} exited with status ${ran.exitCode}` };
    const lastStderr = stderr.trim().split('\n').at(-1);

    // What the tool said on stderr is often the only why, as a sign-in it was refused.
    return failed(failure.code === 'tool_failed' && lastStderr ? { ...failure, message: `${failure.message.replace(/\.$/, '')}. Its stderr in the sandbox ends: ${lastStderr}` } : failure);
  }

  if (ran.session === undefined) return failed(ran.failure ?? { code: 'tool_failed', message: `${tool} named no session` });
  const stopped = stoppedAt(ran.stoppedBy);
  const result = PromptResultSchema.parse(redactJson({ ...('output' in ran && { output: ran.output }), ...(ran.failure && { failure: ran.failure }) }, masks));

  // A tool that continued the session the lease names states that session again.
  const resumed = resume !== undefined && ran.session === resume && ran.startedFresh !== true;

  return {
    state: 'finished', session: { tool, id: ran.session }, result, ...(ran.tokens && { usage: ran.tokens }), ...(ran.model && { model: ran.model }), ...(ran.cost && { cost: ran.cost }),
    ...(resumed && { resumed }), ...(stopped && { stopped }),
  };
}

/**
 * Runs the headless prompt `request` on `tool` (an instance's name, or the tool's), whose executable is `command`, in
 * sandbox `id` on `provider`, with `env` as its whole environment, and stops it at the lease's limits. Its end is masked
 * with `masks`.
 */
export async function runStep({ request, tool, command, provider, id, env, masks }: {
  request: PromptRequest;
  tool: { name: string; profile: { family: StepFamily; step: StepLaunch } };
  command: string;
  provider: Provider;
  id: string;
  env: Record<string, string>;
  masks: Record<string, string>;
}): Promise<Outcome> {
  const { start, stderr } = sandboxProcess(provider, id, request.unset);
  const limits = request.lease.limits;

  const ran = await runStepLaunch({
    tool: { name: tool.name, ...tool.profile, executable: command },
    input: leaseInput(request, env),
    start,
    limits: { budget: limits?.budget?.tokens, timeoutMs: limits?.timeoutMs, idleTimeoutMs: limits?.idleMs },
    interactive: false,
    host: IN_SANDBOX,
  });

  return outcomeOf({ tool: tool.name, resume: request.lease.resume, ran, stderr: stderr(), masks });
}
