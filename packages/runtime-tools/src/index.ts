import type { Can, OpId, OpState } from '@teamai/runtime-protocol';
import type { PromptEnd, PromptRequest, StepRuntime } from '@teamai/runtime-protocol/step-runtime';
import { stepLauncher, type StepLaunchDeps, type StepLauncher, type StepRun, type StepRunResult } from './step.js';

export { hostProcess, stepLauncher, type StepLaunchDeps, type StepLauncher, type StepRun, type StepRunResult, type ToolResolve, type ToolSpawn } from './step.js';

/**
 * What the `tools` runtime takes from teamai, which builds it once: what its `init` offers (`can`, the tools the engine
 * found for the run among them), what a step's launch reads from teamai (`launch`), and the launcher that runs each
 * step's tool, which a test may replace.
 */
export interface ToolsRuntimeDeps<TCan = Can> {
  can: TCan;
  launch: StepLaunchDeps;
  launcher?: StepLauncher;
}

/**
 * The `tools` runtime, in teamai's process: it launches the member's tools on this machine, each in the member's own
 * home. `launcher` runs a prompt step's tool with everything teamai's launch knows of the step, which the engine calls
 * in teamai's process; `prompt` runs a prompt lease through it, as any runtime that takes prompts is sent one.
 */
export interface ToolsStepRuntime<TCan = Can> extends StepRuntime<TCan> {
  readonly launcher: StepLauncher;
}

/** How a prompt of this runtime ended: never lost, since it runs in teamai's own process. */
type ToolsEnd = Exclude<PromptEnd, { kind: 'lost' }>;

/** What `reattach` says of a prompt this runtime ended. */
function endedState(op: OpId, end: ToolsEnd): OpState {
  switch (end.kind) {
    case 'finished': {
      const { kind: _kind, ...finished } = end;

      return { op, state: 'finished', ...finished };
    }

    case 'cancelled':
      return { op, state: 'cancelled' };
    case 'failed':
      return { op, state: 'failed', failure: end.failure };
    default: {
      const unhandled: never = end;

      return unhandled;
    }
  }
}

/** The launch a prompt lease asks for: its whole prompt, as the lease carries it, and the limits it names. */
function leaseRun(request: PromptRequest): StepRun {
  const { lease } = request;
  const env: NodeJS.ProcessEnv = { ...process.env, ...request.env, ...request.credentials };

  for (const name of request.unset) delete env[name];

  return {
    prompt: lease.prompt, expected: undefined, cwd: request.cwd, resultPath: lease.result, secrets: request.credentials, env,
    ...(lease.model && { model: lease.model }),
    ...(lease.resume !== undefined && { resume: lease.resume }),
    ...(lease.maxTurns !== undefined && { maxTurns: lease.maxTurns }),
    ...(lease.permissions === 'unattended' && { unattended: true }),
    ...(lease.limits?.budget && { budget: lease.limits.budget.tokens }),
    ...(lease.limits?.timeoutMs !== undefined && { timeoutMs: lease.limits.timeoutMs }),
    ...(lease.limits?.idleMs !== undefined && { idleTimeoutMs: lease.limits.idleMs }),
  };
}

/**
 * A launch's result as a prompt's end: a tool that exited on its own with a status that is not 0 could not finish the
 * step, and failed; one that exited 0 or that a limit stopped, and named its session, finished, whatever it wrote.
 */
function promptEnd(tool: string, ran: StepRunResult, aborted: boolean): ToolsEnd {
  if (aborted) return { kind: 'cancelled' };

  if (!ran.started) return { kind: 'failed', failure: ran.failure };

  if (ran.exitCode !== 0 && ran.stoppedBy === undefined) return { kind: 'failed', failure: ran.failure ?? { code: 'tool_failed', message: `${tool} exited with status ${ran.exitCode}` } };

  if (ran.session === undefined) return { kind: 'failed', failure: ran.failure ?? { code: 'tool_failed', message: `${tool} named no session` } };
  const stopped = ran.stoppedBy === 'budget' || ran.stoppedBy === 'timeout' ? ran.stoppedBy : undefined;

  return {
    kind: 'finished',
    session: { tool, id: ran.session },
    result: { ...('output' in ran && { output: ran.output }), ...(ran.failure && { failure: ran.failure }) },
    ...(ran.tokens && { usage: ran.tokens }),
    ...(ran.model && { model: ran.model }),
    ...(ran.cost && { cost: ran.cost }),
    ...(stopped && { stopped }),
  };
}

/**
 * The `tools` step runtime: it takes prompt steps and runs no command, which the host command slot of every
 * definition runs. Each prompt runs its tool on this machine through the launch library, in the member's own home, so it
 * neither gives a tool home nor keeps a conversation in a place. It retains outcomes for as long as this process lives,
 * so a teamai started again finds every handle `gone`. It takes no options.
 */
export function toolsStepRuntime<TCan = Can>(deps: ToolsRuntimeDeps<TCan>): ToolsStepRuntime<TCan> {
  const launcher = deps.launcher ?? stepLauncher(deps.launch);
  const handles = new Map<string, string>();
  const ended = new Map<OpId, { handle: string; end: ToolsEnd }>();
  const running = new Map<OpId, { handle: string; end: Promise<ToolsEnd>; controller: AbortController }>();

  const opsOf = (handle: string): OpState[] => [
    ...[...running].flatMap(([op, live]): OpState[] => (live.handle === handle ? [{ op, state: 'running' }] : [])),
    ...[...ended].flatMap(([op, { handle: of, end }]): OpState[] => (of === handle ? [endedState(op, end)] : [])),
  ];

  return {
    name: 'tools',
    launcher,

    async init({ options }) {
      const [key] = Object.keys(options);

      return key === undefined ? { ok: true, can: deps.can, launchesAgents: true } : { ok: false, failure: { code: 'bad_option', key, message: `The tools runtime takes no options, and was given "${key}".` } };
    },

    async open(request, onAccepted) {
      const key = `${request.run}/${request.attempt}`;
      const handle = handles.get(key) ?? `tools-${request.run}-${request.attempt}`;
      handles.set(key, handle);
      await onAccepted(handle);

      return { kind: 'ready', handle };
    },

    async exec() {
      return { kind: 'failed', failure: { code: 'exec_unsupported', message: 'The tools runtime runs no command: the host command slot of the definition runs it.' } };
    },

    async prompt(request, events) {
      const retained = ended.get(request.op) ?? running.get(request.op);

      if (retained) {
        events.onAccepted?.({});

        return retained.end;
      }

      if (request.lease.answer) {
        return { kind: 'failed', failure: { code: 'runtime_protocol', message: 'The tools runtime takes no answer lease: the host command slot answers it.' } };
      }

      const controller = new AbortController();
      const { tool, interactive } = request.lease;
      const run = leaseRun(request);
      const launched = interactive ? launcher.runInteractive(tool, run, controller.signal) : launcher.run(tool, run, controller.signal);

      const entry = {
        handle: request.handle,
        controller,
        // A launch that throws, such as a result folder it cannot make, fails the prompt rather than leaving it running.
        end: (async (): Promise<ToolsEnd> => {
          try {
            return promptEnd(tool, await launched, controller.signal.aborted);
          } catch (error) {
            return controller.signal.aborted
              ? { kind: 'cancelled' }
              : { kind: 'failed', failure: { code: 'tool_failed', message: `The tools runtime could not launch ${tool}: ${error instanceof Error ? error.message : String(error)}` } };
          }
        })().then((end) => {
          running.delete(request.op);
          ended.set(request.op, { handle: request.handle, end });

          return end;
        }),
      };

      running.set(request.op, entry);
      events.onAccepted?.({});

      return entry.end;
    },

    async cancel(op) {
      const live = running.get(op);

      if (!live) return;
      live.controller.abort();
      await live.end;
    },

    async collect() {
      return { ok: true };
    },

    async reattach(handle) {
      return [...handles.values()].includes(handle) ? { kind: 'alive', ops: opsOf(handle) } : { kind: 'gone' };
    },

    async close(handle) {
      for (const [key, open] of handles) if (open === handle) handles.delete(key);

      for (const [op, done] of ended) if (done.handle === handle) ended.delete(op);

      return { ok: true };
    },

    async dispose() {},
  };
}
